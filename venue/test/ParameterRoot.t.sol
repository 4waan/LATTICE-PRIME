// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {ParameterRoot} from "../src/policy/ParameterRoot.sol";
import {RootWindow} from "../src/policy/RootWindow.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {PolicyFixture} from "./PolicyFixture.sol";

/// @dev The revocation setting of the same mechanism, at `DEPTH_CURRENT_ONLY`.
///      `the design notes` a design decision says share the mechanism and not the setting,
///      and this harness is what makes that a compiled claim rather than a table:
///      identical library, one different argument, opposite behaviour.
contract RevocationWindowHarness {
    using RootWindow for RootWindow.Window;

    RootWindow.Window private w;

    function publish(bytes32 r) external {
        w.advance(r);
    }

    function accepts(bytes32 r) external view returns (bool) {
        return w.accepts(r, RootWindow.DEPTH_CURRENT_ONLY, RootWindow.GRACE);
    }
}

contract ParameterRootTest is Test, PolicyFixture {
    function setUp() public {
        _deployPolicy(asDeployed());
    }

    // ------------------------------------------------- the root is derived

    /// @notice `adopt` does not take the publisher's word for the tree.
    /// @dev The whole reason storage and the circuit's public input cannot
    ///      disagree. If the root were merely declared, whoever built the tree
    ///      could commit to one parameter set and write another, and the circuit
    ///      would prove membership in a set the contract never applied.
    function test_theRootIsDerivedFromTheSetAndNeverDeclared() public {
        ParameterRoot.Param[] memory honest = asDeployed();
        ParameterRoot.Param[] memory swapped = asDeployed();
        swapped[_rowAt(swapped, 14)].value = L.point(L.G_EXACT, L.T_IMM); // widened

        bytes32 r = params.rootOf(honest);
        vm.prank(OPERATOR);
        params.propose(r, "");
        clock.tick();

        vm.expectRevert(
            abi.encodeWithSelector(
                ParameterRoot.RootMismatch.selector,
                params.rootOf(swapped),
                params.rootOf(honest)
            )
        );
        params.adopt(swapped);
    }

    /// @notice The commitment is a commitment to a *set*, not to an ordering.
    function test_keysMustAscend() public {
        ParameterRoot.Param[] memory bad = new ParameterRoot.Param[](2);
        bad[0] = ParameterRoot.Param(bytes32(uint256(7)), 1);
        bad[1] = ParameterRoot.Param(bytes32(uint256(3)), 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParameterRoot.KeysNotAscending.selector,
                bytes32(uint256(7)),
                bytes32(uint256(3))
            )
        );
        params.rootOf(bad);
    }

    /// @notice A duplicate key is rejected by the same comparison.
    function test_aDuplicateKeyIsRefused() public {
        ParameterRoot.Param[] memory bad = new ParameterRoot.Param[](2);
        bad[0] = ParameterRoot.Param(bytes32(uint256(7)), 1);
        bad[1] = ParameterRoot.Param(bytes32(uint256(7)), 2);
        vm.expectRevert();
        params.rootOf(bad);
    }

    /// @notice A row parameter that is not an order ideal is refused.
    /// @dev D11c's coherence condition, at the governance boundary rather than at
    ///      the disclosure boundary. A non-ideal claims an observer may know an
    ///      exact value but not the bucket containing it.
    function test_aRowValueThatIsNotAnIdealIsRefused() public {
        ParameterRoot.Param[] memory bad = asDeployed();
        bad[_rowAt(bad, 14)].value = 1 << 24; // one bit at (exact, pre), no closure
        bytes32 r = params.rootOf(bad);
        vm.prank(OPERATOR);
        params.propose(r, "");
        clock.tick();
        vm.expectRevert(
            abi.encodeWithSelector(
                ParameterRoot.RowValueIsNotAnIdeal.selector, 14, uint256(1 << 24)
            )
        );
        params.adopt(bad);
    }

    // ------------------------------------------ governance as a disclosure

    /// @notice D11d.1: governance is itself a disclosure channel, and the
    ///         dangerous case it names is the per-asset parameter change.
    /// @dev A proposal in the clear announces which threshold is about to move,
    ///      one epoch before it moves, to everyone. So the proposal carries a
    ///      root and the set is opened only when it lands. Row 10 gives
    ///      governance actions `(exact, {pub}, epoch)`; this pairs that with a
    ///      predicate at `imm`.
    function test_theProposalDisclosesThatAChangeIsComingAndNothingElse() public {
        ParameterRoot.Param[] memory next = asDeployed();
        next[_rowAt(next, 14)].value = L.point(L.G_PRED, L.T_EOD);

        bytes32 r = params.rootOf(next);
        vm.recordLogs();
        vm.prank(OPERATOR);
        params.propose(r, keccak256("rationale"));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 target = uint256(L.point(L.G_PRED, L.T_EOD));
        for (uint256 i = 0; i < logs.length; ++i) {
            for (uint256 j = 0; j < logs[i].topics.length; ++j) {
                assertTrue(
                    uint256(logs[i].topics[j]) != target, "the new value leaked in a topic"
                );
            }
            assertTrue(logs[i].data.length <= 96, "the proposal carried a payload");
        }

        // And it does land, exactly, at the boundary.
        clock.tick();
        params.adopt(next);
        assertEq(params.valueOf(bytes32(uint256(14))), target);
    }

    /// @notice Adoption is permissionless, but only someone holding the set can
    ///         do it, which is what makes the commitment a commitment.
    function test_adoptionIsPermissionlessAndStillNeedsTheSet() public {
        ParameterRoot.Param[] memory next = asDeployed();
        next[_rowAt(next, 14)].value = L.point(L.G_PRED, L.T_EOD);
        bytes32 r = params.rootOf(next);
        vm.prank(OPERATOR);
        params.propose(r, "");
        clock.tick();
        vm.prank(address(0xDEAD)); // not the operator
        params.adopt(next);
        assertEq(params.valueOf(bytes32(uint256(14))), uint256(L.point(L.G_PRED, L.T_EOD)));
    }

    function test_theSetCannotLandEarly() public {
        vm.prank(OPERATOR);
        params.propose(bytes32(uint256(1)), "");
        vm.expectRevert(
            abi.encodeWithSelector(ParameterRoot.NotYetEffective.selector, uint64(2), uint64(1))
        );
        params.adopt(asDeployed());
    }

    // --------------------------------------------------------- fail closed

    /// @dev **Stated over the complement rather than a named row, and the third
    ///      rewrite is why.** Row 12 stood here until the engine published it,
    ///      then row 15 until `OrderBook.cancel` published that. Each time the
    ///      assertion failed for a reason unrelated to the property under test,
    ///      which is that an *unpublished* row reads `BOTTOM`. Quantifying over
    ///      the rows the deployed set omits is not hostage to the next feature,
    ///      and is the stronger claim.
    function test_anUnpublishedRowDisclosesNothing() public view {
        ParameterRoot.Param[] memory set = asDeployed();
        uint256 checked;
        for (uint16 row = 1; row < params.ROW_CARD(); ++row) {
            bool published;
            for (uint256 i = 0; i < set.length; ++i) {
                if (set[i].key == bytes32(uint256(row))) published = true;
            }
            if (published) continue;
            assertEq(params.ceilingFor(row), L.BOTTOM, "an unpublished row is un-granted");
            assertEq(params.floorFor(row), L.BOTTOM, "and un-obliged");
            checked++;
        }
        assertTrue(checked > 0, "the deployed set does not cover every row");
    }

    /// @notice A key dropped from the new set stops answering.
    /// @dev Without the clear-then-write in `adopt`, a row could be silently
    ///      un-governed by omission and would keep answering with a value no
    ///      committed root covers, which is the precise failure the root exists
    ///      to prevent.
    function test_aDroppedKeyStopsAnswering() public {
        assertTrue(params.ceilingFor(16) != L.BOTTOM, "row 16 starts published");

        ParameterRoot.Param[] memory shorter = new ParameterRoot.Param[](2);
        shorter[0] = ParameterRoot.Param(bytes32(uint256(7)), L.point(L.G_EXACT, L.T_IMM));
        shorter[1] = ParameterRoot.Param(params.KEY_WAIVED_ROWS(), WAIVED);
        _publish(shorter);

        assertEq(params.ceilingFor(16), L.BOTTOM, "row 16 was dropped and fell closed");
        assertEq(params.keyCount(), 2, "and the key list shrank with it");
    }

    // ------------------------------------------------- the waiver's extent

    /// @notice `Regime` bounds the rows the waiver covers and no others.
    /// @dev Meeting the regime into every row was the first version. Under it a
    ///      supervisory narrowing would also stop the venue publishing a maturity
    ///      date, and a suspension that halts the venue is not the suspension the
    ///      regulation describes.
    function test_theRegimeBoundsOnlyTheWaivedRows() public {
        vm.prank(SUPERVISOR);
        regime.narrow(L.point(L.G_PRED, L.T_EOD), "");

        assertEq(params.ceilingFor(14), L.point(L.G_PRED, L.T_EOD), "row 14 is waived");
        assertEq(params.ceilingFor(7), L.point(L.G_EXACT, L.T_IMM), "row 7 is not");
        assertTrue(params.isWaived(4) && !params.isWaived(16), "the mask says which");
    }

    // ----------------------------------------------------- a design decision, the floor

    /// @notice A row has two bounds and the set must order them.
    /// @dev `the design notes` a design decision's word for this case is **un-adoptable**:
    ///      a parameter set whose row ceiling forbids what the same set's row
    ///      floor requires is not a policy the venue gets to operate under while
    ///      somebody works out which half was meant.
    function test_aRowFloorOutsideItsRowCeilingIsUnadoptable() public {
        ParameterRoot.Param[] memory bad = new ParameterRoot.Param[](3);
        bad[0] = ParameterRoot.Param(bytes32(uint256(14)), L.point(L.G_PRED, L.T_IMM));
        bad[1] = ParameterRoot.Param(bytes32(uint256(18 + 14)), L.point(L.G_EXACT, L.T_IMM));
        bad[2] = ParameterRoot.Param(params.KEY_WAIVED_ROWS(), WAIVED);

        bytes32 r = params.rootOf(bad);
        vm.prank(OPERATOR);
        params.propose(r, "");
        clock.tick();
        vm.expectRevert(
            abi.encodeWithSelector(
                ParameterRoot.RowFloorAboveCeiling.selector,
                uint16(14),
                L.point(L.G_PRED, L.T_IMM),
                L.point(L.G_EXACT, L.T_IMM)
            )
        );
        params.adopt(bad);
    }

    /// @notice An obligation on a row with no ceiling is refused by the same
    ///         comparison, because an unpublished row's ceiling is `BOTTOM`.
    /// @dev Fail closed in both directions. A venue that has not published what
    ///      it may disclose on a row cannot be held to publishing something on
    ///      it, and the alternative is a row that is obliged and forbidden at
    ///      once from the moment it lands.
    function test_aFloorOnAnUnpublishedRowIsUnadoptable() public {
        ParameterRoot.Param[] memory bad = new ParameterRoot.Param[](2);
        bad[0] = ParameterRoot.Param(bytes32(uint256(18 + 9)), L.point(L.G_PRED, L.T_EPOCH));
        bad[1] = ParameterRoot.Param(params.KEY_WAIVED_ROWS(), WAIVED);

        bytes32 r = params.rootOf(bad);
        vm.prank(OPERATOR);
        params.propose(r, "");
        clock.tick();
        vm.expectRevert(
            abi.encodeWithSelector(
                ParameterRoot.RowFloorAboveCeiling.selector,
                uint16(9),
                L.BOTTOM,
                L.point(L.G_PRED, L.T_EPOCH)
            )
        );
        params.adopt(bad);
    }

    /// @notice A floor is validated as an ideal for the reason a ceiling is.
    function test_aRowFloorThatIsNotAnIdealIsRefused() public {
        ParameterRoot.Param[] memory bad = new ParameterRoot.Param[](3);
        bad[0] = ParameterRoot.Param(bytes32(uint256(14)), L.TOP);
        bad[1] = ParameterRoot.Param(bytes32(uint256(18 + 14)), 1 << 29); // one bare cell
        bad[2] = ParameterRoot.Param(params.KEY_WAIVED_ROWS(), WAIVED);

        bytes32 r = params.rootOf(bad);
        vm.prank(OPERATOR);
        params.propose(r, "");
        clock.tick();
        vm.expectRevert(
            abi.encodeWithSelector(
                ParameterRoot.RowValueIsNotAnIdeal.selector, uint16(14), uint256(1 << 29)
            )
        );
        params.adopt(bad);
    }

    /// @notice The published set carries both bounds and both read back.
    function test_bothBoundsAreGovernedByTheOneRoot() public {
        _publish(withFloors());
        assertEq(params.floorFor(3), L.point(L.G_AGG, L.T_EOD), "row 3's obligation");
        assertEq(params.floorFor(5), L.point(L.G_AGG, L.T_EOD), "row 5's obligation");
        assertEq(params.floorFor(4), L.BOTTOM, "row 4 carries no obligation");
        assertTrue(
            L.permits(params.ceilingFor(3), params.floorFor(3)), "row 3 is unsatisfiable"
        );
    }

    /// @notice **A supervisory obligation lifts a row ceiling the operator
    ///         published, and only on the rows the waiver covers.**
    /// @dev This is the half of a design decision that makes the floor a mechanism rather
    ///      than a decoration. The lattice check `_emitUnder` runs is against
    ///      `ceilingFor`, so an obligation that did not reach that value would
    ///      leave the venue configured to be unable to publish what it must.
    ///      Scoped by `isWaived` for the same reason the meet is: a waiver is
    ///      granted over named rows, and a suspension of it has the same extent.
    function test_anObligationLiftsAWaivedRowCeilingAndNoOther() public {
        uint32 tight = L.point(L.G_PRED, L.T_IMM);
        ParameterRoot.Param[] memory set = new ParameterRoot.Param[](3);
        set[0] = ParameterRoot.Param(bytes32(uint256(7)), tight); // not waived
        set[1] = ParameterRoot.Param(bytes32(uint256(14)), tight); // waived
        set[2] = ParameterRoot.Param(params.KEY_WAIVED_ROWS(), uint256(1) << 14);
        _publish(set);

        uint32 obliged = L.point(L.G_AGG, L.T_EPOCH);
        assertFalse(L.permits(tight, obliged), "precondition: the row forbids the obligation");

        vm.prank(SUPERVISOR);
        regime.raiseFloor(obliged, "art5");

        assertEq(params.ceilingFor(14), L.join(tight, obliged), "the waived row did not lift");
        assertEq(params.floorFor(14), obliged, "the obligation did not reach the row");
        assertEq(params.ceilingFor(7), tight, "an unwaived row was lifted");
        assertEq(params.floorFor(7), L.BOTTOM, "an unwaived row was obliged");
    }

    /// @notice an invariant at the row level, over arbitrary supervisory states.
    /// @dev The property `_effective` claims by construction, checked rather than
    ///      argued: whatever the regime does, no row is ever both obliged to
    ///      publish a cell and forbidden from publishing it.
    function testFuzz_noRowIsEverObligedAndForbiddenAtOnce(uint32 a, uint32 b) public {
        _publish(withFloors());
        uint32[2] memory tries = [L.close(a), L.close(b)];
        for (uint256 i; i < 2; ++i) {
            vm.prank(SUPERVISOR);
            try regime.narrow(tries[i], "") {} catch {}
            vm.prank(SUPERVISOR);
            try regime.raiseFloor(tries[i], "") {} catch {}
            vm.prank(OPERATOR);
            try regime.propose(tries[i], 0, "") {} catch {}
            clock.tick();
            try regime.adopt() {} catch {}

            for (uint16 row = 0; row < params.ROW_CARD(); ++row) {
                assertTrue(
                    L.permits(params.ceilingFor(row), params.floorFor(row)),
                    "a row was obliged to publish what it was forbidden to publish"
                );
            }
        }
    }

    // ------------------------------------------------- the freshness window

    /// @notice D11d.2 and F5b, at the parameter setting: current or one behind,
    ///         and one behind only for the grace.
    function test_theSupersededRootIsAcceptedUntilTheGraceExpires() public {
        bytes32 first = params.root();

        ParameterRoot.Param[] memory next = asDeployed();
        next[_rowAt(next, 14)].value = L.point(L.G_PRED, L.T_EOD);
        _publish(next);

        bytes32 second = params.root();
        assertTrue(second != first, "the root moved");
        assertTrue(params.accepts(second), "the current root is accepted");
        assertTrue(params.accepts(first), "a proof in flight still lands");

        vm.warp(block.timestamp + RootWindow.GRACE);
        assertTrue(params.accepts(first), "on the boundary is inside");

        vm.warp(block.timestamp + 1);
        assertFalse(params.accepts(first), "one second past it is not");
        assertTrue(params.accepts(second), "and the current root is unaffected");
    }

    /// @notice "The last N roots" is not a window on its own.
    /// @dev If acceptance were count-only, a root that never moves again leaves
    ///      its predecessor live forever, which is a second policy in force with
    ///      no end date. The time bound is what closes it.
    function test_theWindowClosesEvenIfTheRootNeverMovesAgain() public {
        bytes32 first = params.root();
        ParameterRoot.Param[] memory next = asDeployed();
        next[_rowAt(next, 14)].value = L.point(L.G_PRED, L.T_EOD);
        _publish(next);

        assertEq(params.windowClosesAt(), uint64(block.timestamp) + RootWindow.GRACE);
        vm.warp(block.timestamp + 365 days);
        assertFalse(params.accepts(first), "no second live policy a year later");
    }

    /// @notice Share the mechanism, not the setting. a design decision's table, compiled.
    function test_revocationTakesTheCurrentRootOnly() public {
        RevocationWindowHarness rev = new RevocationWindowHarness();
        rev.publish(keccak256("rev-1"));
        rev.publish(keccak256("rev-2"));

        // Same library, same grace, same block. Only `depth` differs.
        assertTrue(rev.accepts(keccak256("rev-2")), "current");
        assertFalse(rev.accepts(keccak256("rev-1")), "and nothing behind it, at once");
        assertTrue(params.accepts(params.previousRoot()) || params.previousRoot() == bytes32(0));
    }

    /// @notice Fail closed before the first publication.
    function test_theZeroRootIsNeverAccepted() public {
        RevocationWindowHarness rev = new RevocationWindowHarness();
        assertFalse(rev.accepts(bytes32(0)), "an unpublished root verifies nothing");
        assertFalse(params.accepts(bytes32(0)));
    }

    function test_republishingTheSameRootIsRefused() public {
        ParameterRoot.Param[] memory same = asDeployed();
        bytes32 r = params.rootOf(same);
        vm.prank(OPERATOR);
        params.propose(r, "");
        clock.tick();
        vm.expectRevert(
            abi.encodeWithSelector(RootWindow.RootUnchanged.selector, params.root())
        );
        params.adopt(same);
    }

    // ---------------------------------------------------------------- cost

    /// @notice What a row lookup costs, because the claim is that this is a
    ///         mechanism rather than a document and a mechanism has a price.
    function test_theCostOfAskingTheMatrix() public {
        // Warm first. A cold cross-contract call measures the EVM's access list
        // rules and not this design; the venue reads a row on every emit.
        params.ceilingFor(14);
        params.ceilingFor(7);

        uint256 g0 = gasleft();
        params.ceilingFor(14);
        uint256 waived = g0 - gasleft();

        g0 = gasleft();
        params.ceilingFor(7);
        uint256 unwaived = g0 - gasleft();

        emit log_named_uint("ceilingFor, waived row (external call)", waived);
        emit log_named_uint("ceilingFor, unwaived row (external call)", unwaived);
        assertLt(waived, 30_000, "a row lookup is not a governance vote");
    }
}
