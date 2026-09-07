// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TransferPause} from "../src/policy/TransferPause.sol";
import {IExternalPause} from "../src/interfaces/IExternalPause.sol";
import {EpochClockMock} from "./PolicyFixture.sol";

/// @title TransferPauseTest
/// @notice The four bounds on the one control in this venue that can stop a
///         holder leaving.
///
/// `TradingHaltTest` establishes three bounds on a halt that reaches one
/// function. This contract reaches 101 of the 102 entry points the census
/// measures, so it carries those three and a fourth, and the fourth is the one
/// worth reading: a pause is followed by a cooling-off at least as long as the
/// pause itself, so the window to leave is never shorter than the window someone
/// was held in.
contract TransferPauseTest is Test {
    TransferPause internal p;
    EpochClockMock internal clock;

    address internal constant GUARDIAN = address(0x6A4D);
    address internal constant PASSERBY = address(0xF00D);

    uint32 internal constant MAX = 1 hours;
    uint32 internal constant BUDGET = 3 hours;

    function setUp() public {
        clock = new EpochClockMock();
        p = new TransferPause(clock, GUARDIAN, MAX, BUDGET);
        vm.warp(1_000_000);
    }

    function _pause(uint32 s) internal returns (uint64) {
        vm.prank(GUARDIAN);
        return p.pause(s, keccak256("because"));
    }

    // ------------------------------------------------- bound 1: a deadline

    /// @notice A pause ends by itself, and nothing has to be called to end it.
    /// @dev The bound that separates this from a pause key. ATS's own
    ///      `removeExternalPause` exists because a permanently paused external
    ///      contract is a deadlock (FIND-016); this contract cannot be one.
    function test_aPauseEndsWithoutAnyoneEndingIt() public {
        uint64 until = _pause(MAX);
        assertTrue(p.pausedNow());
        assertEq(until, uint64(block.timestamp) + MAX);

        vm.warp(until - 1);
        assertTrue(p.pausedNow(), "still paused one second early");

        vm.warp(until);
        assertFalse(p.pausedNow(), "and it lifted on its own");
    }

    /// @notice There is no state a pause can be left in, over any inputs.
    function testFuzz_everyPauseLiftsWithoutACall(uint32 s, uint32 wait) public {
        s = uint32(bound(s, 1, MAX));
        wait = uint32(bound(wait, 0, 10 days));
        uint64 until = _pause(s);
        vm.warp(uint256(block.timestamp) + wait);
        assertEq(p.pausedNow(), wait < s);
        assertEq(p.pausedUntil(), until);
    }

    /// @notice The seam call is the deadline and nothing else.
    /// @dev `isPaused` is read on 101 ATS entry points. It agrees with the
    ///      contract's own view of itself at every point, including before the
    ///      first pause, which is the state the token is registered in.
    function testFuzz_theSeamCallIsExactlyTheDeadline(uint32 s, uint32 wait) public {
        assertFalse(IExternalPause(address(p)).isPaused(), "unpaused before the first pause");
        s = uint32(bound(s, 1, MAX));
        wait = uint32(bound(wait, 0, 10 days));
        _pause(s);
        vm.warp(uint256(block.timestamp) + wait);
        assertEq(IExternalPause(address(p)).isPaused(), p.pausedNow());
        assertEq(IExternalPause(address(p)).isPaused(), block.timestamp < p.pausedUntil());
    }

    // ------------------------------------------------------ bound 2: the cap

    function test_aPauseLongerThanTheCapIsRefused() public {
        vm.prank(GUARDIAN);
        vm.expectRevert(
            abi.encodeWithSelector(TransferPause.PauseTooLong.selector, MAX + 1, MAX)
        );
        p.pause(MAX + 1, "too long");
    }

    /// @notice No sequence reaches further into the future than one grant.
    /// @dev `TradingHalt._arm` extends, so two halts in force are one halt
    ///      ending later. Here extension is refused outright, which is strictly
    ///      stronger: the deadline is always exactly one grant from the moment it
    ///      was armed.
    function test_theDeadlineNeverReachesPastOneGrant() public {
        uint64 until = _pause(MAX);
        assertLe(until, block.timestamp + MAX);

        vm.warp(block.timestamp + MAX / 2);
        vm.prank(GUARDIAN);
        vm.expectRevert(abi.encodeWithSelector(TransferPause.AlreadyPaused.selector, until));
        p.pause(MAX, "again");
        assertEq(p.pausedUntil(), until, "the deadline did not move");
    }

    // --------------------------------------------------- bound 3: the budget

    /// @notice The budget is charged at grant and an early resume buys none back.
    /// @dev `TradingHalt`'s rule, kept for its reason: refunding would let a
    ///      guardian pause, resume and pause again at no cost, and the budget
    ///      bounds the authority rather than the seconds realised.
    function test_anEarlyResumeBuysBackNoBudget() public {
        _pause(MAX);
        uint64 e = clock.currentEpoch();
        assertEq(p.grantedIn(e), MAX);

        vm.warp(block.timestamp + 1);
        vm.prank(GUARDIAN);
        p.resume("sorry");
        assertEq(p.grantedIn(e), MAX, "still charged in full");
        assertEq(p.remainingBudget(), BUDGET - MAX);
    }

    /// @notice The budget binds across an epoch and resets with the clock.
    function test_theBudgetBindsAndThenResets() public {
        // Three full pauses exhaust a three hour budget, each separated by its
        // own cooling-off, which is what the warps below are.
        for (uint256 i; i < 3; ++i) {
            _pause(MAX);
            vm.warp(block.timestamp + MAX); // the pause runs out
            vm.warp(block.timestamp + MAX); // and then its cooling-off
        }
        assertEq(p.remainingBudget(), 0);

        // Read the epoch before the prank. An external call in the argument list
        // consumes it and the pause then arrives from this contract instead,
        // which fails on the seat rather than on the budget. `PolicyFixture`
        // carries the same warning; it cost a cycle here too.
        uint64 e = clock.currentEpoch();
        vm.prank(GUARDIAN);
        vm.expectRevert(
            abi.encodeWithSelector(
                TransferPause.BudgetExhausted.selector, e, uint32(1), uint32(0)
            )
        );
        p.pause(1, "no budget left");

        clock.tick();
        assertEq(p.remainingBudget(), BUDGET, "a new epoch is a new budget");
    }

    // ------------------------------------------- bound 4: the cooling-off

    /// @notice **The bound that makes the trap survivable.** The window to leave
    ///         is never shorter than the window someone was held in.
    function testFuzz_theExitWindowIsNeverShorterThanTheTrap(uint32 s) public {
        s = uint32(bound(s, 1, MAX));
        uint64 armed = uint64(block.timestamp);
        uint64 until = _pause(s);

        vm.warp(until);
        assertFalse(p.pausedNow(), "the pause is over");

        uint64 cool = p.coolingOffUntil();
        assertEq(cool - until, until - armed, "cooling-off equals the pause it followed");
        assertGe(cool - uint64(block.timestamp), s, "and the exit window is at least that long");

        // Nothing can pause the token again inside it, at any point.
        vm.prank(GUARDIAN);
        vm.expectRevert(abi.encodeWithSelector(TransferPause.CoolingOff.selector, cool));
        p.pause(1, "too soon");

        vm.warp(cool);
        assertEq(_pause(1), uint64(block.timestamp) + 1, "and it opens exactly on the deadline");
    }

    /// @notice Resuming early shortens the cooling-off, because it shortened the
    ///         pause. Both halves point at ending a pause early.
    function testFuzz_anEarlyResumeShortensTheCoolingOff(uint32 s, uint32 after_) public {
        s = uint32(bound(s, 2, MAX));
        uint32 ran = uint32(bound(after_, 1, s - 1));

        uint64 armed = uint64(block.timestamp);
        _pause(s);
        vm.warp(uint256(armed) + ran);
        vm.prank(GUARDIAN);
        p.resume("early");

        assertFalse(p.pausedNow());
        assertEq(p.coolingOffUntil() - uint64(block.timestamp), ran, "realised, not granted");
        assertLt(p.coolingOffUntil(), armed + uint64(s) * 2, "shorter than it would have been");
    }

    /// @notice Before the first pause there is no cooling-off to serve.
    /// @dev The zero state, checked because `coolingOffUntil` is arithmetic over
    ///      two stored deadlines and the obvious implementation returns a date in
    ///      1970 that is nonetheless in the past, which passes by accident.
    function test_theFirstPauseServesNoCoolingOff() public {
        assertEq(p.coolingOffUntil(), 0);
        assertFalse(p.coolingOffNow());
        assertEq(p.runEndedAt(), 0);
        _pause(1);
        assertTrue(p.pausedNow());
    }

    // ---------------------------------------------------------- the seat

    function test_onlyTheGuardianCanPauseOrResume() public {
        vm.prank(PASSERBY);
        vm.expectRevert(TransferPause.NotGuardian.selector);
        p.pause(60, "not mine");

        _pause(60);

        vm.prank(PASSERBY);
        vm.expectRevert(TransferPause.NotGuardian.selector);
        p.resume("not mine");
    }

    /// @notice The guardian seat is not the regime supervisor's.
    /// @dev §7 of the rulebook is proud that nobody can call the discretionary
    ///      halt, because the supervisor seat is held by `VolumeCap`. That
    ///      argument does not transfer to a compliance control: one nobody can
    ///      call is not a control. The seat is separate so that the two claims
    ///      can both be true at once.
    function test_theGuardianSeatIsItsOwn() public view {
        assertEq(p.guardian(), GUARDIAN);
    }

    function test_resumingWhenNotPausedIsRefused() public {
        vm.prank(GUARDIAN);
        vm.expectRevert(TransferPause.NotPaused.selector);
        p.resume("nothing to end");
    }

    function test_aZeroLengthPauseIsRefused() public {
        vm.prank(GUARDIAN);
        vm.expectRevert(TransferPause.ZeroPause.selector);
        p.pause(0, "nothing");
    }

    // ------------------------------------------------------ the deployment

    /// @notice A budget under the cap would make the cap unreachable.
    function test_aDeploymentCannotCarryADeadBound() public {
        vm.expectRevert(
            abi.encodeWithSelector(TransferPause.BudgetBelowCap.selector, MAX - 1, MAX)
        );
        new TransferPause(clock, GUARDIAN, MAX, MAX - 1);
    }

    /// @notice **The registration window always reopens.**
    /// @dev ATS puts `onlyUnpaused` on `addExternalPause` and that check consults
    ///      the already-registered external pauses, so a token can only be
    ///      pointed at this contract while it is unarmed. Because the deadline
    ///      expires with no call from anyone, that window recurs whatever the
    ///      guardian does, which is what makes the wiring recoverable from any
    ///      state rather than only from the one the deploy script starts in.
    function testFuzz_theRegistrationWindowAlwaysReopens(uint32 s, uint32 wait) public {
        s = uint32(bound(s, 1, MAX));
        _pause(s);
        assertFalse(p.registrable(), "shut while armed");

        vm.warp(uint256(block.timestamp) + s + bound(wait, 0, 10 days));
        assertTrue(p.registrable(), "and open again after");
    }
}
