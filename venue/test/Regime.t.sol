// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Regime} from "../src/policy/Regime.sol";
import {IEpochClock} from "../src/interfaces/IEpochClock.sol";
import {VolumeCap} from "../src/policy/VolumeCap.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";

contract Clock is IEpochClock {
    uint64 public e;

    function currentEpoch() external view returns (uint64) {
        return e;
    }

    function tick() external {
        e += 1;
    }
}

contract RegimeTest is Test {
    Clock clock;
    Regime regime;

    address constant SUPERVISOR = address(0x5E4);
    address constant OPERATOR = address(0x09E);

    /// The waiver as granted: sizes may be published banded, and not before end
    /// of day. The same ideal `RepoVault` and `OrderBook` hardcode today.
    uint32 IDEAL;
    /// A configuration strictly inside it: coarser and later.
    uint32 INSIDE;
    /// Outside it: exact, immediately. Nothing a bond desk may do.
    uint32 OUTSIDE;
    /// The obligation as granted: a predicate, by end of epoch. Inside both the
    /// grant and the initial configuration, which the constructor requires.
    uint32 MANDATE;

    function setUp() public {
        IDEAL = L.point(L.G_BUCKET, L.T_EOD);
        INSIDE = L.point(L.G_AGG, L.T_EPOCH);
        OUTSIDE = L.point(L.G_EXACT, L.T_IMM);
        MANDATE = L.point(L.G_PRED, L.T_EPOCH);
        clock = new Clock();
        regime = new Regime(IDEAL, MANDATE, INSIDE, SUPERVISOR, OPERATOR, clock);
    }

    // ------------------------------------------------- the sentence, enforced

    /// `the study plan` D11c: "a venue cannot grant itself a waiver." Previously
    /// `[DOC]`. This is the test that makes it a property of the deployment.
    function test_theOperatorCannotLeaveTheIdeal() public {
        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                Regime.OutsideIdeal.selector, OUTSIDE, L.excess(IDEAL, OUTSIDE)
            )
        );
        regime.propose(OUTSIDE, 1, "");
    }

    /// And the supervisor cannot either, which is what makes it a *ceiling*
    /// rather than a role with more privileges.
    function test_theSupervisorCannotWidenPastTheIdeal() public {
        vm.prank(SUPERVISOR);
        vm.expectRevert();
        regime.proposeRelax(L.TOP, ""); // TOP exceeds a (bucket, EOD) grant
    }

    /// The one invariant the whole construction rests on, over arbitrary
    /// sequences: nothing reachable ever exceeds the grant.
    function testFuzz_nothingReachableEverExceedsTheGrant(uint32 a, uint32 b, uint32 c) public {
        uint32[3] memory tries = [L.close(a), L.close(b), L.close(c)];
        for (uint256 i; i < 3; ++i) {
            vm.prank(OPERATOR);
            try regime.propose(tries[i], 0, "") {} catch {}
            vm.prank(SUPERVISOR);
            try regime.narrow(tries[i], "") {} catch {}
            vm.prank(SUPERVISOR);
            try regime.proposeRelax(tries[i], "") {} catch {}
            clock.tick();
            try regime.adopt() {} catch {}
            try regime.adoptRelax() {} catch {}

            assertTrue(L.permits(regime.ideal(), regime.ceiling()), "ceiling escaped the grant");
            assertTrue(
                L.permits(regime.ceiling(), regime.current()), "current escaped the ceiling"
            );
        }
    }

    /// The other half of the same sentence, and the one a design decision says was missing:
    /// nothing reachable ever falls **below** the obligation. Same shape as the
    /// fuzz above, same arbitrary sequences, opposite direction, and it exercises
    /// the floor calls alongside the ceiling ones so the two can contradict each
    /// other if the reconciliation is wrong.
    function testFuzz_nothingReachableEverFallsBelowTheObligation(uint32 a, uint32 b, uint32 c)
        public
    {
        uint32[3] memory tries = [L.close(a), L.close(b), L.close(c)];
        for (uint256 i; i < 3; ++i) {
            vm.prank(OPERATOR);
            try regime.propose(tries[i], 0, "") {} catch {}
            vm.prank(SUPERVISOR);
            try regime.narrow(tries[i], "") {} catch {}
            vm.prank(SUPERVISOR);
            try regime.raiseFloor(tries[i], "") {} catch {}
            vm.prank(SUPERVISOR);
            try regime.proposeRelax(tries[i], "") {} catch {}
            vm.prank(SUPERVISOR);
            try regime.proposeLowerFloor(tries[i], "") {} catch {}
            clock.tick();
            try regime.adopt() {} catch {}
            try regime.adoptRelax() {} catch {}
            try regime.adoptLowerFloor() {} catch {}

            // an invariant, whole: `mandate <= floor <= current <= ceiling <= ideal`.
            assertTrue(
                L.permits(regime.floor(), regime.mandate()), "floor fell below the grant"
            );
            assertTrue(
                L.permits(regime.current(), regime.floor()), "current fell below the floor"
            );
            assertTrue(
                L.permits(regime.ceiling(), regime.current()), "current escaped the ceiling"
            );
            assertTrue(L.permits(regime.ideal(), regime.ceiling()), "ceiling escaped the grant");
        }
    }

    // -------------------------------------------------------- a design decision, the floor

    /// The finding, as a test. A narrowing moves the ceiling down and the live
    /// configuration does not have to move; a floor raise moves it **up** and it
    /// does. Run on one regime in one block, so the difference is not a claim
    /// about two deployments.
    function test_theCeilingCannotCompelAndTheFloorDoes() public {
        uint32 dark = L.point(L.G_AGG, L.T_EPOCH); // where the venue is trading
        assertEq(regime.current(), dark, "precondition");

        // The ceiling half. Narrow to something that still contains `dark`.
        vm.prank(SUPERVISOR);
        regime.narrow(IDEAL, "art5.ceiling"); // still contains `dark`
        assertEq(regime.ceiling(), IDEAL, "the ceiling moved");
        assertEq(regime.current(), dark, "and the venue did not have to move at all");

        // The floor half, on the same configuration.
        uint32 obliged = L.point(L.G_BUCKET, L.T_EOD);
        vm.prank(SUPERVISOR);
        regime.raiseFloor(obliged, "art5");
        assertTrue(L.permits(regime.current(), obliged), "the venue can still trade dark");
        assertTrue(regime.current() != dark, "the live configuration did not move");
    }

    /// A configuration that forbids what the venue must publish is un-adoptable,
    /// at the operator's end.
    function test_theOperatorCannotProposeBelowTheFloor() public {
        uint32 tooQuiet = L.point(L.G_NONE, L.T_NEVER);
        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                Regime.Unsatisfiable.selector, tooQuiet, MANDATE, L.excess(tooQuiet, MANDATE)
            )
        );
        regime.propose(tooQuiet, 0, "");
    }

    /// And at the supervisor's. A restriction that would put the ceiling under
    /// the obligation is refused rather than half applied, which is the whole
    /// content of "un-adoptable": the two instructions contradict, and the
    /// contract does not get to choose which one was meant.
    function test_aNarrowingThatWouldForbidTheObligationIsRefused() public {
        vm.prank(SUPERVISOR);
        regime.raiseFloor(L.point(L.G_AGG, L.T_EPOCH), "art5");

        uint32 tooTight = L.point(L.G_PRED, L.T_NEVER);
        uint32 wouldBe = L.meet(regime.ideal(), tooTight);
        vm.prank(SUPERVISOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                Regime.Unsatisfiable.selector,
                wouldBe,
                L.point(L.G_AGG, L.T_EPOCH),
                L.excess(wouldBe, L.point(L.G_AGG, L.T_EPOCH))
            )
        );
        regime.narrow(tooTight, "");

        assertEq(regime.narrowed(), L.TOP, "the refused narrowing was partly applied");
    }

    /// Raising is immediate for the reason narrowing is: an obligation that
    /// waits for an epoch boundary is not an obligation.
    function test_raisingIsImmediateAndLoweringWaits() public {
        uint32 obliged = L.point(L.G_AGG, L.T_EPOCH);
        vm.prank(SUPERVISOR);
        regime.raiseFloor(obliged, "art5");
        assertEq(regime.floor(), obliged, "the floor did not move in the same block");

        vm.prank(SUPERVISOR);
        regime.proposeLowerFloor(MANDATE, "art5.lift");
        assertEq(regime.floor(), obliged, "the lowering took effect in the same block");

        vm.expectRevert();
        regime.adoptLowerFloor();

        clock.tick();
        regime.adoptLowerFloor();
        assertEq(regime.floor(), MANDATE, "the lowering did not land at the boundary");

        // And lowering the floor does not lower `current`. Two visible
        // governance actions, never one silent one. `adoptRelax`'s rule.
        assertTrue(
            L.permits(regime.current(), obliged), "the restoration moved the live policy"
        );
    }

    /// The supervisor cannot waive an obligation the grant fixed, which is the
    /// mirror of `test_theSupervisorCannotWidenPastTheIdeal`.
    function test_theSupervisorCannotLowerPastTheMandate() public {
        uint32 below = L.point(L.G_NONE, L.T_NEVER);
        vm.prank(SUPERVISOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                Regime.BelowMandate.selector, below, L.excess(below, MANDATE)
            )
        );
        regime.proposeLowerFloor(below, "");
    }

    /// A raise retires a scheduled lowering. Without this, a restoration
    /// proposed before a breach lands at the boundary after it, and the
    /// suspension it overtook is silently undone.
    function test_aRaiseRetiresAScheduledLowering() public {
        vm.prank(SUPERVISOR);
        regime.raiseFloor(L.point(L.G_AGG, L.T_EPOCH), "art5");
        vm.prank(SUPERVISOR);
        regime.proposeLowerFloor(MANDATE, "art5.lift");

        // The cap fires again before the restoration lands.
        vm.prank(SUPERVISOR);
        regime.raiseFloor(L.point(L.G_BUCKET, L.T_EOD), "art5.again");

        clock.tick();
        vm.expectRevert(Regime.NothingPending.selector);
        regime.adoptLowerFloor();
        assertEq(
            regime.floor(), L.point(L.G_BUCKET, L.T_EOD), "the second suspension was undone"
        );
    }

    /// A scheduled relax that the floor has since overtaken must not wedge
    /// `adoptRelax`, which is permissionless. It lifts rather than reverts, and
    /// the join is the smallest restriction that admits the obligation.
    function test_aScheduledRelaxTheFloorOvertookLiftsRatherThanWedging() public {
        vm.prank(SUPERVISOR);
        regime.proposeRelax(L.point(L.G_PRED, L.T_NEVER), "tighter than live");

        vm.prank(SUPERVISOR);
        regime.raiseFloor(L.point(L.G_AGG, L.T_EPOCH), "art5.between");

        clock.tick();
        regime.adoptRelax(); // does not revert
        assertTrue(
            L.permits(regime.ceiling(), regime.floor()), "the ceiling landed under the floor"
        );
        assertEq(
            regime.narrowed(),
            L.join(L.point(L.G_PRED, L.T_NEVER), L.point(L.G_AGG, L.T_EPOCH)),
            "did not lift to the join"
        );
    }

    // ------------------------------------------------------- the direction

    /// Narrowing is immediate because the safe set is downward closed, and a
    /// suspension that waits for a boundary is not a suspension.
    function test_narrowingIsImmediateAndClampsTheLiveConfiguration() public {
        uint32 tight = L.point(L.G_PRED, L.T_EPOCH);
        vm.prank(SUPERVISOR);
        regime.narrow(tight, "art5");
        assertEq(
            regime.ceiling(), L.meet(IDEAL, tight), "ceiling did not move in the same block"
        );
        assertTrue(L.permits(regime.ceiling(), regime.current()), "live config was not clamped");
    }

    /// Widening waits, because widening is the direction that leaks. Rule 2.
    function test_wideningWaitsForTheBoundary() public {
        vm.prank(SUPERVISOR);
        regime.narrow(L.point(L.G_PRED, L.T_EPOCH), "art5");
        uint32 narrowedCeiling = regime.ceiling();

        vm.prank(SUPERVISOR);
        regime.proposeRelax(IDEAL, "art5.lift");
        assertEq(regime.ceiling(), narrowedCeiling, "relax took effect in the same block");

        vm.expectRevert();
        regime.adoptRelax();

        clock.tick();
        regime.adoptRelax();
        assertEq(regime.ceiling(), IDEAL, "relax did not land at the boundary");
    }

    /// A narrowing that overtakes a pending proposal must not wedge governance.
    function test_aNarrowingThatOvertakesAProposalClampsRatherThanReverts() public {
        vm.prank(OPERATOR);
        regime.propose(IDEAL, 3, "widest permitted");

        uint32 tight = L.point(L.G_PRED, L.T_EPOCH);
        vm.prank(SUPERVISOR);
        regime.narrow(tight, "art5");

        clock.tick();
        regime.adopt(); // does not revert
        assertEq(regime.current(), L.meet(IDEAL, tight), "did not clamp to the meet");
        assertEq(regime.liquidityClass(), 3, "the rest of the proposal still landed");
    }

    // ------------------------------------------------------ the DOGE framing

    /// Hedera's public-spending post and this venue are the same dial at two
    /// ends, and the far end is a named constant in `DisclosureLattice`.
    function test_theTransparencyEndOfTheDialIsTOP() public {
        assertEq(L.point(L.G_EXACT, L.T_PRE), L.TOP, "full disclosure is exactly TOP");

        // A venue granted the transparency waiver can occupy it.
        Regime spending = new Regime(L.TOP, L.BOTTOM, L.TOP, SUPERVISOR, OPERATOR, clock);
        vm.prank(OPERATOR);
        spending.propose(L.point(L.G_EXACT, L.T_IMM), 0, "public spending");
        clock.tick();
        spending.adopt();
        assertEq(spending.current(), L.point(L.G_EXACT, L.T_IMM));

        // The bond desk, on the same code, cannot. One engine, two grants.
        vm.prank(OPERATOR);
        vm.expectRevert();
        regime.propose(L.point(L.G_EXACT, L.T_IMM), 0, "");
    }
}

contract VolumeCapTest is Test {
    Clock clock;
    Regime regime;
    VolumeCap cap;

    address constant SUPERVISOR = address(0x5E4);
    address constant OPERATOR = address(0x09E);
    address constant VENUE = address(0x0EE);

    /// Where the venue is trading: banded sizes, end of day. This is the value
    /// the whole entry turns on. a design decision's suspension moved the ceiling from `TOP`
    /// to `(exact, imm)` and **this point is inside `(exact, imm)`**, so the cap
    /// fired, the ceiling moved, and this never had to change.
    uint32 DARK;

    /// What Article 5 holds the venue to while the cap is breached.
    uint32 OBLIGED;

    function setUp() public {
        clock = new Clock();
        DARK = L.point(L.G_BUCKET, L.T_EOD);
        OBLIGED = L.point(L.G_EXACT, L.T_IMM);
        // The cap holds the supervisor role: suspension is arithmetic, not a person.
        regime = new Regime(L.TOP, L.BOTTOM, DARK, address(0), OPERATOR, clock);
        cap = new VolumeCap(regime, VENUE, 4000, OBLIGED);
    }

    function _deployed() private returns (Regime r, VolumeCap c) {
        // The real deployment order, and the reason `bootstrapSupervisor` exists:
        // the regime goes up with the role vacant, the cap takes the regime, then
        // the role is filled once. The cap contract *is* the supervisor.
        r = new Regime(L.TOP, L.BOTTOM, DARK, address(0), OPERATOR, clock);
        c = new VolumeCap(r, VENUE, 4000, OBLIGED);
        r.bootstrapSupervisor(address(c));
    }

    function _breach(VolumeCap c) private {
        vm.prank(VENUE);
        c.record(100, 30); // 30 percent deferred, under the 40 percent cap
        assertEq(c.shareBps(), 3000);
        assertFalse(c.enforce(), "nothing to do under the cap");

        vm.prank(VENUE);
        c.record(100, 90); // now 60 percent of 200
        assertEq(c.shareBps(), 6000);
    }

    function test_theCapIsHeldByArithmeticAndTriggeredByAnyone() public {
        (Regime r2, VolumeCap c) = _deployed();
        _breach(c);

        // Anyone. Not the venue, not a supervisor, not a vote.
        vm.prank(address(0xBEEF));
        assertTrue(c.enforce(), "the cap did not bind");
        assertTrue(c.suspendedNow());

        // **The assertion this test used to make was `r2.ceiling()` moved, and
        // that was true and was not the property.** `the design notes` a design decision:
        // the lattice enforces a maximum and MiFID imposes a minimum, so a lower
        // ceiling forbids disclosure and cannot compel it. The property is the
        // obligation, and the thing that has to have moved is the live policy.
        assertEq(r2.floor(), OBLIGED, "the obligation did not rise");
        assertTrue(
            L.permits(r2.current(), OBLIGED), "the venue may still hide what it must publish"
        );
    }

    /// The finding, stated as the test that would have caught it. This is the
    /// assertion a design decision could not make, and it is the one sentence of this whole
    /// entry: after the cap fires, the venue cannot keep trading dark.
    function test_theCapMovesTheVenueAndNotOnlyTheCeiling() public {
        (Regime r2, VolumeCap c) = _deployed();
        assertEq(r2.current(), DARK, "precondition: the venue is trading dark");

        _breach(c);
        c.enforce();

        assertTrue(r2.current() != DARK, "the cap fired and the venue kept trading dark");
        assertEq(r2.current(), L.join(DARK, OBLIGED), "did not clamp up to the join");
    }

    /// Restoration is two governance actions and a boundary, never one call.
    function test_theWaiverComesBackAtABoundaryAndTheOperatorHasToAskForIt() public {
        (Regime r2, VolumeCap c) = _deployed();
        _breach(c);
        c.enforce();
        uint32 lifted = r2.current();

        // The window rolls and the share falls back under the cap.
        clock.tick();
        assertEq(c.shareBps(), 0, "a fresh window");
        assertTrue(c.enforce(), "the lift was not proposed");
        assertFalse(c.suspendedNow());
        assertEq(r2.floor(), OBLIGED, "the obligation lifted in the same block");

        clock.tick();
        r2.adoptLowerFloor();
        assertEq(r2.floor(), r2.mandate(), "the obligation did not return to the grant");

        // And the venue is still publishing. Lowering the floor does not lower
        // the live policy: the operator proposes back into the reclaimed space
        // like any other configuration change, so the restoration is visible.
        assertEq(r2.current(), lifted, "the restoration silently moved the live policy");
    }

    /// A cap whose suspension floor does not contain the mandate is a cap that
    /// could never fire, and it is refused at deployment rather than at the
    /// moment it was needed.
    function test_aSuspensionThatCannotRaiseIsRefusedAtDeployment() public {
        uint32 m = L.point(L.G_AGG, L.T_EOD);
        Regime r = new Regime(L.TOP, m, L.TOP, address(0), OPERATOR, clock);
        uint32 tooLow = L.point(L.G_PRED, L.T_NEVER);
        vm.expectRevert(
            abi.encodeWithSelector(VolumeCap.SuspensionDoesNotRaise.selector, tooLow, m)
        );
        new VolumeCap(r, VENUE, 4000, tooLow);
    }

    function test_recordingIsPermissionedSoTheCapCannotBeWeaponised() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(VolumeCap.NotVenue.selector);
        cap.record(1_000_000, 1_000_000);
    }
}
