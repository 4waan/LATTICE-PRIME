// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TransferPause} from "../src/policy/TransferPause.sol";
import {EpochClockMock} from "./PolicyFixture.sol";

/// @dev Drives the pause from the seat that may reach it and from one that may
///      not, and moves the clock underneath. Everything is try/caught, for
///      `HaltHandler`'s reason: a bound that only holds on the calls that
///      succeeded is not a bound.
///
///      The accounting is the part worth reading. `doWarp` is the only thing
///      that moves time, so every second the token spends paused is a second
///      inside some warp, and the overlap of the warped interval with the live
///      deadline is exactly the paused time. Measuring it here rather than
///      deriving it from the events is deliberate: the events are what the
///      contract says about itself.
contract PauseHandler is Test {
    TransferPause public p;
    EpochClockMock public clock;
    address public guardian;

    uint64 public lowestEpoch;
    uint64 public highestEpoch;

    uint256 public pausedSeconds;
    uint256 public elapsedSeconds;

    uint256 public pauses;
    uint256 public refusedPauses;
    uint256 public overlongPauses;
    uint256 public resumes;

    /// @dev Pauses that were armed while a cooling-off was still running. Bound
    ///      4 says this stays at zero.
    uint256 public armedInsideCooling;
    /// @dev Pauses that were armed while the token was already paused. Bound 1
    ///      says this stays at zero.
    uint256 public armedWhilePaused;

    constructor(TransferPause p_, EpochClockMock c, address g) {
        p = p_;
        clock = c;
        guardian = g;
        lowestEpoch = c.currentEpoch();
        highestEpoch = lowestEpoch;
    }

    /// @dev The guardian three calls in four, and the length drawn from half the
    ///      cap to twice it, on `HaltHandler.doHalt`'s reasoning: a handler that
    ///      cannot reach a bound does not test it.
    function doPause(uint32 seconds_, uint256 caller) external {
        address who = caller % 4 != 0 ? guardian : address(uint160(caller | 1));
        // Read both before the prank. An external call in the argument list
        // consumes it.
        uint32 max = p.maxPauseSeconds();
        uint64 cool = p.coolingOffUntil();
        bool wasPaused = p.pausedNow();
        uint32 want = uint32(bound(seconds_, max / 2, uint256(max) * 2));
        if (want > max) overlongPauses++;

        vm.prank(who);
        try p.pause(want, bytes32(caller)) {
            pauses++;
            if (block.timestamp < cool) armedInsideCooling++;
            if (wasPaused) armedWhilePaused++;
        } catch {
            refusedPauses++;
        }
    }

    /// @dev **The adversary.** `doPause` draws its caller and its length at
    ///      random, which leaves so much dead time between pauses that the
    ///      half-time invariant passed even with the cooling-off deleted. This
    ///      one is the guardian trying to keep the bond shut: it asks for the
    ///      full cap the moment the previous pause has lapsed. Without bound 4
    ///      that is a token paused essentially all of the time, which is what
    ///      makes the aggregate invariant a claim about the cooling-off rather
    ///      than a claim about the budget.
    function doPauseMaximally() external {
        uint32 max = p.maxPauseSeconds();
        uint64 cool = p.coolingOffUntil();
        bool wasPaused = p.pausedNow();
        vm.prank(guardian);
        try p.pause(max, "maximal") {
            pauses++;
            if (block.timestamp < cool) armedInsideCooling++;
            if (wasPaused) armedWhilePaused++;
        } catch {
            refusedPauses++;
        }
    }

    function doResume(uint256 caller) external {
        address who = caller % 3 == 0 ? guardian : address(uint160(caller | 1));
        vm.prank(who);
        try p.resume(bytes32(caller)) {
            resumes++;
        } catch {}
    }

    /// @dev Steps of at most half the cap, so a single warp cannot jump a whole
    ///      pause and its cooling-off and leave the accounting reading zero.
    function doWarp(uint32 by) external {
        uint256 step = bound(by, 1, 30 minutes);
        uint256 from = block.timestamp;
        uint256 to = from + step;

        uint256 runFrom = p.runStartedAt();
        uint256 runTo = p.pausedUntil();
        uint256 lo = from > runFrom ? from : runFrom;
        uint256 hi = to < runTo ? to : runTo;
        if (hi > lo) pausedSeconds += hi - lo;

        elapsedSeconds += step;
        vm.warp(to);
    }

    function doTick() external {
        clock.tick();
        if (clock.currentEpoch() > highestEpoch) highestEpoch = clock.currentEpoch();
    }
}

/// @title TransferPauseInvariantTest
/// @notice The four bounds, over arbitrary sequences rather than chosen ones.
///
/// This is the control that can stop a holder leaving, so the bounds on it are
/// the security argument and not a nicety. The headline is
/// `invariant_theTokenIsUnpausedAtLeastHalfTheTime`: whatever the guardian does,
/// over any run, the bond spends more time movable than frozen.
///
/// forge-config: default.invariant.runs = 96
/// forge-config: default.invariant.depth = 400
contract TransferPauseInvariantTest is Test {
    TransferPause internal p;
    EpochClockMock internal clock;
    PauseHandler internal handler;

    address internal constant GUARDIAN = address(0x6A4D);

    uint32 internal constant MAX = 1 hours;
    /// @dev **Deliberately far above what any run reaches.** The budget and the
    ///      cooling-off both limit how long the bond can be shut, so a suite
    ///      where the budget binds cannot say which of them bought the
    ///      half-time property. It was set to 90 minutes here first, on
    ///      `TradingHaltInvariantTest`'s pattern, and deleting the cooling-off
    ///      check from the contract still left every invariant green. A budget
    ///      no run exhausts isolates bound 4, and `test_theBudgetBindsAndThenResets`
    ///      in the unit suite is where the budget is asked to bind.
    uint32 internal constant BUDGET = 30 days;

    function setUp() public {
        clock = new EpochClockMock();
        vm.warp(1_000_000);
        p = new TransferPause(clock, GUARDIAN, MAX, BUDGET);
        handler = new PauseHandler(p, clock, GUARDIAN);
        targetContract(address(handler));
    }

    /// @notice **The property the cooling-off exists to buy.** Over any sequence,
    ///         the bond is unpaused for at least as long as it was paused.
    /// @dev The slack is one grant and not a fudge factor. A pause that has just
    ///      ended has not yet served its cooling-off, and the unserved part is at
    ///      most `MAX`, so the strict statement is `2·paused ≤ elapsed + MAX` and
    ///      the asymptotic one is the half. Dropping the slack fails on the first
    ///      run that ends inside a pause, which is a fact about when the run
    ///      stopped and not about the contract.
    function invariant_theTokenIsUnpausedAtLeastHalfTheTime() public view {
        assertLe(2 * handler.pausedSeconds(), handler.elapsedSeconds() + MAX);
    }

    /// @notice Bound 4. No pause was ever armed inside a cooling-off.
    /// @dev Watched per call in the handler, because it is a property of the
    ///      transition and the state it would have to be read from is gone by
    ///      the time the invariant runs.
    function invariant_noPauseIsArmedInsideACoolingOff() public view {
        assertEq(handler.armedInsideCooling(), 0);
    }

    /// @notice Bound 1. A pause is never extended, only replaced after it ends.
    function invariant_noPauseIsEverExtended() public view {
        assertEq(handler.armedWhilePaused(), 0);
    }

    /// @notice Bound 2. The deadline is never further ahead than one grant.
    function invariant_theDeadlineNeverReachesPastTheCap() public view {
        assertLe(p.pausedUntil(), block.timestamp + MAX);
    }

    /// @notice Bound 3. Granted seconds never exceed the budget, in any epoch.
    function invariant_theEpochBudgetIsNeverExceeded() public view {
        uint64 top = clock.currentEpoch();
        if (handler.highestEpoch() > top) top = handler.highestEpoch();
        for (uint64 e = handler.lowestEpoch(); e <= top; ++e) {
            assertLe(p.grantedIn(e), BUDGET);
        }
    }

    /// @notice The seam call is a comparison and never a latch a missed call
    ///         could leave set.
    function invariant_theSeamCallIsExactlyTheDeadline() public view {
        assertEq(p.isPaused(), block.timestamp < p.pausedUntil());
        assertEq(p.isPaused(), p.pausedNow());
    }

    /// @notice The token can always be pointed at this contract again.
    /// @dev `registrable` is the window ATS's `onlyUnpaused` on `addExternalPause`
    ///      leaves open, and it is the negation of the seam call, so a state in
    ///      which the wiring could never be repaired would be a state in which
    ///      the pause never lifts.
    function invariant_registrabilityIsTheNegationOfTheSeamCall() public view {
        assertEq(p.registrable(), !p.isPaused());
    }

    function afterInvariant() public {
        assertGt(handler.pauses(), 0, "no pause ever succeeded");
        assertGt(handler.refusedPauses(), 0, "no pause was ever refused");
        assertGt(handler.overlongPauses(), 0, "the cap was never asked to bind");
        assertGt(handler.resumes(), 0, "no pause was ever ended early");
        assertGt(handler.pausedSeconds(), 0, "the token was never actually paused");

        vm.warp(uint256(p.pausedUntil()) + 1);
        assertFalse(p.pausedNow(), "a pause outlived its own deadline");
        assertTrue(p.registrable(), "and the registration window reopened");
    }
}
