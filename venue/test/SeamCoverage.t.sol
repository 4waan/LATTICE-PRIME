// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SeamMap} from "../src/observatory/SeamMap.sol";

/// @title SeamCoverageTest
/// @notice The callstack census, as assertions.
///
/// `docs/CALLSTACK.md` is a document and a reviewer can skim it. This is the
/// same measurement with the findings pinned, so that an ATS upgrade which
/// closes a rail, opens a new one, or reorders a modifier list breaks a build
/// instead of quietly changing what the privacy layer can see.
///
/// Every assertion below is a claim about **ATS**, not about our code. That is
/// unusual for a test suite and it is deliberate: the venue's security argument
/// rests on which ATS entry points consult which seam, and a claim that load
/// bearing should not live only in prose.
contract SeamCoverageTest is Test {
    // The two rails the ordinary and the privileged transfer take. Named here
    // once because four tests contrast them.
    string constant ORDINARY = "TransferByPartition.transferByPartition";
    string constant CONTROLLER = "ControllerByPartition.controllerTransferByPartition";
    string constant FORCED = "Controller.forcedTransfer";

    // ------------------------------------------------------ table integrity

    function test_tableIsWellFormed() public pure {
        assertEq(SeamMap.TABLE.length, SeamMap.COUNT * SeamMap.STRIDE, "stride");
        // The last record must decode. `recordAt` reads a full word from an offset
        // eleven bytes before the end, which is in bounds only because Solidity
        // pads `bytes memory` up to a word. Asserting the last row proves the
        // padding assumption rather than resting on it.
        (bytes8 op, uint8 seams,,, uint8 depth) = SeamMap.recordAt(SeamMap.COUNT - 1);
        assertTrue(op != bytes8(0), "last op id");
        assertTrue(seams != 0 || depth != 0, "last row decoded");
    }

    function test_everyRowHasAnIdentity() public pure {
        for (uint256 i = 0; i < SeamMap.COUNT; ++i) {
            (bytes8 op,,,,) = SeamMap.recordAt(i);
            assertTrue(op != bytes8(0), "zero id");
        }
    }

    // ------------------------------------------------- the ordinary rail

    /// The control. Everything below is a contrast against this row, so if this
    /// one is wrong every other reading is meaningless.
    function test_ordinaryTransferReachesEveryPreStateSeam() public pure {
        uint8 s = SeamMap.seamsOf(ORDINARY);
        assertTrue(SeamMap.has(s, SeamMap.A), "A pause");
        assertTrue(SeamMap.has(s, SeamMap.B), "B control list");
        assertTrue(SeamMap.has(s, SeamMap.C), "C compliance, pre");
        assertTrue(SeamMap.has(s, SeamMap.D), "D kyc");
        assertTrue(SeamMap.has(s, SeamMap.E), "E identity");
        assertTrue(SeamMap.has(s, SeamMap.CW), "C' compliance, post");
        assertTrue(
            SeamMap.has(SeamMap.writesOf(ORDINARY), SeamMap.W_TRANSFER), "moves balance"
        );
    }

    // ------------------------------------------------- finding: controller

    /// The finding that made this whole census worth running.
    ///
    /// `controllerTransferByPartition` carries `onlyOperational onlyActivated
    /// onlyUnpaused onlyDefaultPartitionWithSinglePartition onlyControllable
    /// onlyAnyRole`. It does **not** carry `onlyCanTransferFromByPartition`,
    /// which is the modifier that reaches seams B, C, D and E on the ordinary
    /// rail. Both then call the same `TokenCoreOps.transferByPartition`.
    ///
    /// So a `ROLE_CONTROLLER` or `ROLE_AGENT` moves collateral to an address
    /// that has proved nothing, and the zero knowledge eligibility gate is never
    /// asked. The only thing the venue ever learns is the post-state C-prime
    /// notification, after the balance has already moved.
    function test_theControllerRailSkipsTheEligibilityGate() public pure {
        for (uint256 i = 0; i < 2; ++i) {
            string memory rail = i == 0 ? CONTROLLER : FORCED;
            uint8 s = SeamMap.seamsOf(rail);
            assertTrue(SeamMap.has(SeamMap.writesOf(rail), SeamMap.W_TRANSFER), "moves");
            assertFalse(SeamMap.has(s, SeamMap.D), "must not consult seam D");
            assertFalse(SeamMap.has(s, SeamMap.C), "must not consult seam C");
            assertFalse(SeamMap.has(s, SeamMap.E), "must not consult seam E");
            // And the one thing we do get, which is what `SeamJournal` reads.
            assertTrue(SeamMap.has(s, SeamMap.CW), "post-state notification");
        }
    }

    /// Redemption on the same rail, same conclusion. Listed separately because a
    /// forced redemption destroys collateral rather than moving it, and the repo
    /// vault's default path has to survive one happening under it.
    function test_theControllerRedemptionRailIsAlsoUngated() public pure {
        uint8 s = SeamMap.seamsOf("ControllerByPartition.controllerRedeemByPartition");
        assertTrue(SeamMap.has(SeamMap.writesOf(
            "ControllerByPartition.controllerRedeemByPartition"), SeamMap.W_REDEEM));
        assertFalse(SeamMap.has(s, SeamMap.D), "no eligibility gate");
        assertTrue(SeamMap.has(s, SeamMap.CW), "post-state only");
    }

    // --------------------------------------------------- finding: maturity

    /// Maturity redemption consults the eligibility gate and the control list
    /// and never consults the one seam that receives the amount. A size
    /// dependent policy is blind exactly where a bond pays out, which for a repo
    /// venue is the moment the collateral leg unwinds.
    function test_maturityRedemptionIsBlindToSize() public pure {
        uint8 s = SeamMap.seamsOf("MaturityByPartition.redeemAtMaturityByPartition");
        assertTrue(SeamMap.has(s, SeamMap.D), "seam D runs");
        assertTrue(SeamMap.has(s, SeamMap.B), "seam B runs");
        assertFalse(SeamMap.has(s, SeamMap.C), "seam C does not");
        assertTrue(SeamMap.has(s, SeamMap.CW), "told afterwards");
    }

    // ------------------------------------------------------- finding: hold

    /// Corroborates `mesh/transfer-path.md` F-05 from a second instrument. The
    /// first was an execution probe against a hardhat harness; this is static
    /// reachability over the source. Two methods, one answer: hold creation runs
    /// the pause check and nothing else.
    function test_holdCreationRunsNoEligibilityCheck() public pure {
        string memory create = "HoldByPartition.createHoldByPartition";
        uint8 s = SeamMap.seamsOf(create);
        assertTrue(SeamMap.has(s, SeamMap.A), "pause only");
        assertFalse(SeamMap.has(s, SeamMap.B), "no control list");
        assertFalse(SeamMap.has(s, SeamMap.C), "no compliance");
        assertFalse(SeamMap.has(s, SeamMap.D), "no kyc");
        assertFalse(SeamMap.has(s, SeamMap.E), "no identity");

        // Execution is a different matter, and is fully gated. The asymmetry is
        // the whole of F-05: the check is at the end of the rail, not the start.
        uint8 x = SeamMap.seamsOf("HoldByPartition.executeHoldByPartition");
        assertTrue(SeamMap.has(x, SeamMap.C), "execution consults C");
        assertTrue(SeamMap.has(x, SeamMap.D), "execution consults D");
    }

    // --------------------------------------------------- finding: clearing

    /// Clearing is two phase and the two phases are gated differently. Submit
    /// runs the pause check only; approve runs everything. For the venue this
    /// decides where an order can be refused: not when it is placed.
    function test_clearingSubmitIsUngatedAndApprovalIsNot() public pure {
        uint8 submit = SeamMap.seamsOf("ClearingByPartition.clearingTransferByPartition");
        assertFalse(SeamMap.has(submit, SeamMap.D), "submit skips D");
        assertFalse(SeamMap.has(submit, SeamMap.C), "submit skips C");

        uint8 approve =
            SeamMap.seamsOf("ClearingByPartition.approveClearingOperationByPartition");
        assertTrue(SeamMap.has(approve, SeamMap.D), "approve consults D");
        assertTrue(SeamMap.has(approve, SeamMap.C), "approve consults C");
        assertTrue(SeamMap.has(approve, SeamMap.E), "approve consults E");
    }

    // ------------------------------------------------- the coverage claim

    /// The reason `SeamJournal` exists.
    ///
    /// Seam D is the eligibility gate and the venue's zero knowledge proof
    /// terminates there. Count the balance-moving entry points it never sees.
    /// If this number were zero the journal would be dead weight.
    function test_seamDAloneDoesNotCoverTheBalanceMovingSurface() public pure {
        (uint256 moves, uint256 unseenByD,,) = _survey();
        assertGt(moves, 10, "the moving surface is not tiny");
        assertGt(unseenByD, 3, "seam D misses a real part of it");
    }

    /// The coverage property, stated as narrowly as the measurement supports.
    ///
    /// **Every operation that moves value between holders is observed by a seam
    /// the venue implements.** Transfer, issue, redeem and hold execution: all
    /// of them reach seam C before the fact or seam C-prime after it, so
    /// `SeamJournal` is told. That is the claim, and it is the one worth
    /// checking.
    function test_everyValueMoveIsObservedBySomeVenueSeam() public pure {
        for (uint256 i = 0; i < SeamMap.COUNT; ++i) {
            (bytes8 op, uint8 seams, uint8 writes,,) = SeamMap.recordAt(i);
            if (writes & SeamMap.W_MOVES == 0) continue;
            assertTrue(
                seams & SeamMap.VENUE_OBSERVED != 0,
                string.concat("unobserved value move: ", vm.toString(op))
            );
        }
    }

    /// And the half that is not true, asserted so it cannot be quietly dropped
    /// from the pitch.
    ///
    /// **Encumbrance is not a transfer, and ATS gates transfers.** Creating a
    /// hold or a lock immobilises a holder's tokens without consulting any seam
    /// but the pause check. No eligibility gate runs, no compliance module is
    /// called, and nothing is told afterwards either.
    ///
    /// This is not an abstract gap for this venue. **The repo open leg is two
    /// ATS holds with the vault as escrow**, which is the design `the design notes`
    /// section 2(c) settled on precisely to avoid writing custom escrow. So the
    /// venue's own settlement rail is on the unobserved path, and the vault has
    /// to carry the check itself rather than inherit it.
    function test_encumbranceRunsNoEligibilityCheckAndTellsNoOne() public pure {
        string[6] memory encumber = [
            "HoldByPartition.createHoldByPartition",
            "HoldByPartition.createHoldFromByPartition",
            "OperatorHoldByPartition.operatorCreateHoldByPartition",
            "ProtectedHoldByPartition.protectedCreateHoldByPartition",
            "ControllerHoldByPartition.controllerCreateHoldByPartition",
            "LockByPartition.lockByPartition"
        ];
        for (uint256 i = 0; i < encumber.length; ++i) {
            uint8 seams = SeamMap.seamsOf(encumber[i]);
            uint8 writes = SeamMap.writesOf(encumber[i]);
            assertTrue(writes & SeamMap.W_ENCUMBERS != 0, encumber[i]);
            assertEq(writes & SeamMap.W_MOVES, 0, "encumbers, does not move");
            assertEq(seams, SeamMap.A, "pause check and nothing else");
            assertEq(seams & SeamMap.VENUE_OBSERVED, 0, "no venue seam is told");
        }
    }

    /// The honest split: how much of the coverage above is only after the fact.
    /// A venue that says "every move is observed" and means "we get told
    /// afterwards" is overclaiming, so the split is asserted rather than argued.
    function test_theAfterTheFactShareIsWhatItIs() public pure {
        (uint256 moves,, uint256 postOnly,) = _survey();
        assertGt(postOnly, 0, "some rails are post-state only");
        assertLt(postOnly, moves, "and some are not");
    }

    /// ATS dispatches due scheduled tasks lazily, from inside whatever call
    /// happens to arrive next. So a freeze, a snapshot or a clearing submit can
    /// apply a pending supply factor change on its way past, and the caller who
    /// paid for that gas did not ask for it.
    ///
    /// For the disclosure model this is the awkward one: the *timing* of a
    /// balance adjustment is set by unrelated third party traffic, so the time
    /// axis of that row is not a property the issuer controls.
    function test_scheduledAdjustmentsRideAlongOnUnrelatedCalls() public pure {
        (,,, uint256 incidentalCount) = _survey();
        assertGt(incidentalCount, 20, "the ride-along surface is wide");

        // Three that have nothing to do with supply.
        string[3] memory unrelated = [
            "Snapshots.takeSnapshot",
            "Freeze.freezePartialTokens",
            "ClearingByPartition.clearingTransferByPartition"
        ];
        for (uint256 i = 0; i < unrelated.length; ++i) {
            assertTrue(
                SeamMap.has(SeamMap.incidentalOf(unrelated[i]), SeamMap.W_ADJUST),
                unrelated[i]
            );
            assertEq(
                SeamMap.writesOf(unrelated[i]) & SeamMap.W_ADJUST, 0,
                "and does not adjust on its own account"
            );
        }
    }

    function _survey()
        internal
        pure
        returns (uint256 moves, uint256 unseenByD, uint256 postOnly, uint256 incidentalCount)
    {
        for (uint256 i = 0; i < SeamMap.COUNT; ++i) {
            (, uint8 seams, uint8 writes, uint8 inc,) = SeamMap.recordAt(i);
            if (inc != 0) incidentalCount += 1;
            if (writes & SeamMap.W_MOVES == 0) continue;
            moves += 1;
            if (!SeamMap.has(seams, SeamMap.D)) unseenByD += 1;
            if (seams & (SeamMap.C | SeamMap.D) == 0 && SeamMap.has(seams, SeamMap.CW)) {
                postOnly += 1;
            }
        }
    }

    // ------------------------------------------------------ terms vs rails

    /// Setting a coupon rate is not a balance event. It reaches the pause check
    /// and stops. That matters for the disclosure matrix: a terms change and a
    /// payment are different rows with different observers and different times,
    /// and the census is where that distinction stops being an assertion.
    function test_debtTermChangesTouchNoBalanceRail() public pure {
        string[4] memory terms = [
            "Coupon.setCoupon",
            "Dividend.setDividend",
            "FixedRate.setRate",
            "Maturity.updateMaturityDate"
        ];
        for (uint256 i = 0; i < terms.length; ++i) {
            assertEq(SeamMap.writesOf(terms[i]), 0, terms[i]);
            assertEq(SeamMap.seamsOf(terms[i]), SeamMap.A, terms[i]);
        }
    }

    function test_lookupOfAnUnmeasuredOpReverts() public {
        vm.expectRevert();
        this.probe("NoSuchContract.noSuchFunction");
    }

    function probe(string memory n) external pure returns (uint8) {
        return SeamMap.seamsOf(n);
    }
}
