// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IExternalPause} from "../interfaces/IExternalPause.sol";
import {IEpochClock} from "../interfaces/IEpochClock.sol";

/// @title TransferPause
/// @notice Seam A. ATS calls `isPaused` on nearly every mutating entry point.
/// @dev A deadline, not a pause flag. Capped, budgeted per epoch, self-expiring,
///      and followed by a cooling-off at least as long as the pause it followed.
///      `docs/RULEBOOK.md` §7a.
///
/// ## Why this is not `TradingHalt`
///
/// `TradingHalt` gates `crossRound` and nothing else, so §7 of the rulebook can
/// say that a halted venue cannot trade and cannot stop anyone leaving. This
/// contract is the other kind. Registered as an external pause on the bond it
/// reaches 101 of the 102 entry points the census measures, which includes every
/// rail a holder would use to get out: transfer, redeem, the controller rail, the
/// clearing rail, and hold creation. It does stop people leaving. That is what a
/// securities pause is for, and it is why the bounds below are strictly tighter
/// than the halt's rather than merely copied from it.
///
/// | | `TradingHalt` | `TransferPause` |
/// |---|---|---|
/// | reaches | `crossRound` | 101 entry points |
/// | stops an exit | no | yes |
/// | extension while armed | allowed, deadline moves later | refused |
/// | after it ends | nothing | cooling-off equal to the realised pause |
/// | armed by | `regime.supervisor()`, which is `VolumeCap`, which has no path | `guardian`, which is a live seat |
///
/// The last row is deliberate and is the one that cost an argument. §7 is proud
/// that nobody can call the discretionary halt. A compliance control nobody can
/// call is not a compliance control, so this one has a holder, and every other
/// line of the table is what pays for that.
contract TransferPause is IExternalPause {
    // -------------------------------------------------------------- wiring

    IEpochClock public immutable clock;

    /// @notice The only address that may arm a pause.
    /// @dev Not `regime.supervisor()`. See the table above.
    address public immutable guardian;

    /// @notice The longest single pause. Immutable, per bound 2.
    uint32 public immutable maxPauseSeconds;

    /// @notice Pause seconds the guardian may grant per epoch, per bound 3.
    uint32 public immutable budgetSeconds;

    // ------------------------------------------------------------- storage

    /// @notice The deadline. `isPaused` is this and a comparison, and nothing else.
    /// @dev Read on 101 ATS entry points, so it is one warm SLOAD by construction.
    ///      Anything that needed a second slot here would be paid for on every
    ///      transfer of the bond forever.
    uint64 public pausedUntil;

    /// @notice When the run that ends at `pausedUntil` was armed.
    uint64 public runStartedAt;

    /// @notice When the run was cut short, or zero when it ran to its deadline.
    /// @dev Cleared on every `pause`, so it only ever describes the current run.
    uint64 public resumedAt;

    /// @dev Pause seconds granted per epoch. Charged in full at grant and never
    ///      refunded on an early `resume`, for `TradingHalt._granted`'s reason:
    ///      the budget bounds the authority to pause rather than the seconds
    ///      realised. The cooling-off is the half that runs on the realised
    ///      figure, and the two are different questions.
    mapping(uint64 => uint32) private _granted;

    // -------------------------------------------------------------- events

    event Paused(uint64 indexed until, uint32 seconds_, bytes32 rationale);
    /// @dev **Not `at`.** `tools/gen-app.mjs` refuses an ABI carrying a member
    ///      named after an `Array.prototype` method, because `ethers` v6 decodes
    ///      a log's arguments into an array-like `Result` and `result.at`
    ///      resolves to the array method rather than the timestamp. That check
    ///      was written against `PrimeOracle.latest`, and this event was drafted
    ///      before it existed and would have been its second catch.
    event Resumed(uint64 indexed resumedAt, uint64 coolingOffUntil, bytes32 rationale);

    // -------------------------------------------------------------- errors

    error NotGuardian();
    error ZeroPause();
    error PauseTooLong(uint32 want, uint32 max);
    error BudgetExhausted(uint64 epoch, uint32 want, uint32 left);
    error AlreadyPaused(uint64 until);
    error CoolingOff(uint64 until);
    error NotPaused();
    error BudgetBelowCap(uint32 budget, uint32 max);

    // --------------------------------------------------------- constructor

    constructor(
        IEpochClock clock_,
        address guardian_,
        uint32 maxPauseSeconds_,
        uint32 budgetSeconds_
    ) {
        if (maxPauseSeconds_ == 0) revert ZeroPause();
        // `TradingHalt.BudgetBelowCap`'s check, for its reason: a budget under
        // the single-grant cap makes the cap unreachable and the deployment
        // carries two bounds of which one is dead.
        if (budgetSeconds_ < maxPauseSeconds_) {
            revert BudgetBelowCap(budgetSeconds_, maxPauseSeconds_);
        }
        clock = clock_;
        guardian = guardian_;
        maxPauseSeconds = maxPauseSeconds_;
        budgetSeconds = budgetSeconds_;
    }

    // ------------------------------------------------------- the seam call

    /// @inheritdoc IExternalPause
    /// @dev Never reverts, one SLOAD. The OR composition in
    ///      `PauseStorageWrapper.isExternallyPaused` means a revert here is not
    ///      a pause, it is a token whose every guarded entry point reverts, and
    ///      no `unpause` on the token clears it. Seam D carries the same warning
    ///      for the same reason; this one is worse because the seam is wider.
    function isPaused() external view returns (bool) {
        return block.timestamp < pausedUntil;
    }

    // ------------------------------------------------------------ the state

    /// @notice True while the token is paused by this contract. A deadline, so it
    ///         clears itself.
    function pausedNow() public view returns (bool) {
        return block.timestamp < pausedUntil;
    }

    /// @notice When the last run actually ended. The deadline, or the resume.
    /// @dev Zero before the first pause, which is what makes `coolingOffUntil`
    ///      zero rather than a date in 1970 plus a duration.
    function runEndedAt() public view returns (uint64) {
        if (pausedUntil == 0) return 0;
        return resumedAt != 0 ? resumedAt : pausedUntil;
    }

    /// @notice No pause may be armed before this. Bound 4.
    /// @dev **The bound that makes the trap survivable.** A run of `s` realised
    ///      seconds is followed by `s` seconds in which this contract cannot
    ///      pause anything, so the window a holder has to leave is never shorter
    ///      than the window they were held in, and over any interval the token
    ///      spends at most half its time paused by this contract.
    ///
    ///      Realised and not granted: the guardian who resumes early has bought
    ///      a shorter cooling-off and has not bought back any budget. Both halves
    ///      point the same way, which is that ending a pause early is the
    ///      unambiguously good act and nothing here should discourage it.
    function coolingOffUntil() public view returns (uint64) {
        uint64 ended = runEndedAt();
        if (ended == 0) return 0;
        return ended + (ended - runStartedAt);
    }

    function coolingOffNow() public view returns (bool) {
        return block.timestamp < coolingOffUntil();
    }

    /// @notice Pause seconds the guardian may still grant this epoch.
    function remainingBudget() public view returns (uint32) {
        uint32 used = _granted[clock.currentEpoch()];
        return used >= budgetSeconds ? 0 : budgetSeconds - used;
    }

    function grantedIn(uint64 epoch) external view returns (uint32) {
        return _granted[epoch];
    }

    /// @notice Whether `addExternalPause` would be accepted by the token now.
    /// @dev **Registration is only possible through this window.** ATS puts
    ///      `onlyUnpaused` on `addExternalPause`, and that check consults every
    ///      already-registered external pause, so a token cannot be pointed at a
    ///      pause contract that is armed. `removeExternalPause` deliberately does
    ///      not consult them (FIND-016 in the ATS audit), so the exit is always
    ///      open and only the entrance is gated. The self-expiring deadline is
    ///      what guarantees this window recurs without anyone acting.
    function registrable() external view returns (bool) {
        return !pausedNow();
    }

    // -------------------------------------------------------- the discretion

    /// @notice Pause the token for `seconds_`. Guardian only, capped, budgeted,
    ///         refused while paused and refused while cooling off.
    /// @dev The rationale is committed for `TradingHalt.halt`'s reason: the
    ///      guardian cannot later claim a reason other than the one it gave.
    function pause(uint32 seconds_, bytes32 rationale) external returns (uint64 until) {
        if (msg.sender != guardian) revert NotGuardian();
        if (seconds_ == 0) revert ZeroPause();
        if (seconds_ > maxPauseSeconds) revert PauseTooLong(seconds_, maxPauseSeconds);

        // Bound 1: no extension. `TradingHalt` lets a second halt push the
        // deadline later; here that would be a way to hold the exit shut for
        // longer than `maxPauseSeconds` while the cooling-off never starts.
        if (pausedNow()) revert AlreadyPaused(pausedUntil);

        uint64 cool = coolingOffUntil();
        if (block.timestamp < cool) revert CoolingOff(cool);

        uint64 e = clock.currentEpoch();
        uint32 left = remainingBudget();
        if (seconds_ > left) revert BudgetExhausted(e, seconds_, left);
        _granted[e] += seconds_;

        runStartedAt = uint64(block.timestamp);
        resumedAt = 0;
        until = uint64(block.timestamp) + seconds_;
        pausedUntil = until;
        emit Paused(until, seconds_, rationale);
    }

    /// @notice End a pause early. Guardian only, immediate, no bound.
    /// @dev The safe direction, so it carries none of the four bounds above. It
    ///      shortens the cooling-off because it shortened the pause, and the
    ///      event carries the new cooling-off deadline so that the one call a
    ///      holder is watching tells them when the token can be shut again.
    function resume(bytes32 rationale) external {
        if (msg.sender != guardian) revert NotGuardian();
        if (!pausedNow()) revert NotPaused();
        resumedAt = uint64(block.timestamp);
        pausedUntil = uint64(block.timestamp);
        emit Resumed(uint64(block.timestamp), coolingOffUntil(), rationale);
    }
}
