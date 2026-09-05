// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Regime} from "./Regime.sol";
import {IEpochClock} from "../interfaces/IEpochClock.sol";

/// @title TradingHalt
/// @notice Deadline, not a pause flag. Gates `MatchingEngine.crossRound` only.
/// @dev Halt is the leaky direction: capped (`maxHaltSeconds` immutable), budgeted
///      per epoch, self-expiring. Resume is immediate. Breaker cannot stop the
///      round that breached it — a sealed book has no indicative price.
///      `docs/RULEBOOK.md` §7.
contract TradingHalt {
    Regime public immutable regime;
    IEpochClock public immutable clock;

    /// @notice The only address that may report a price. See `observe`.
    address public immutable venue;

    /// @notice The longest single halt. Immutable, per bound 2.
    uint32 public immutable maxHaltSeconds;

    /// @notice Halt seconds a supervisor may grant per epoch, per bound 3.
    uint32 public immutable budgetSeconds;

    /// @notice Move from the last clearing price, in bps, that arms the breaker.
    uint16 public immutable bandBps;

    /// @notice How long a breaker halt lasts. Not budgeted: nobody chooses it.
    uint32 public immutable breakerSeconds;

    uint64 public haltedUntil;
    uint256 public lastPriceTwice;

    /// @dev Halt seconds granted per epoch. Charged in full at grant and never
    ///      refunded on an early `resume`, because the budget bounds the
    ///      authority to halt rather than the seconds realised. Refunding would
    ///      let a supervisor halt, resume, and halt again at no cost.
    mapping(uint64 => uint32) private _granted;

    event Halted(uint64 indexed until, uint32 seconds_, bytes32 rationale);
    event Resumed(uint64 indexed at, bytes32 rationale);
    event Breaker(uint64 indexed until, uint256 from, uint256 to, uint256 moveBps);
    event Observed(uint256 priceTwice);

    error NotSupervisor();
    error NotVenue();
    error ZeroHalt();
    error HaltTooLong(uint32 want, uint32 max);
    error BudgetExhausted(uint64 epoch, uint32 want, uint32 left);
    error NotHalted();

    /// @notice A budget below the single-halt cap makes the cap unreachable, so
    ///         the deployment would carry two bounds of which one is dead.
    ///         Caught once, here, rather than at the moment it was needed.
    error BudgetBelowCap(uint32 budget, uint32 max);
    error BandNotBinding(uint16 bandBps);

    constructor(
        Regime regime_,
        address venue_,
        uint32 maxHaltSeconds_,
        uint32 budgetSeconds_,
        uint16 bandBps_,
        uint32 breakerSeconds_
    ) {
        if (maxHaltSeconds_ == 0 || breakerSeconds_ == 0) {
            revert ZeroHalt();
        }
        if (budgetSeconds_ < maxHaltSeconds_) {
            revert BudgetBelowCap(budgetSeconds_, maxHaltSeconds_);
        }
        if (breakerSeconds_ > maxHaltSeconds_) {
            revert HaltTooLong(breakerSeconds_, maxHaltSeconds_);
        }
        if (bandBps_ == 0 || bandBps_ >= 10_000) revert BandNotBinding(bandBps_);
        regime = regime_;
        clock = regime_.clock();
        venue = venue_;
        maxHaltSeconds = maxHaltSeconds_;
        budgetSeconds = budgetSeconds_;
        bandBps = bandBps_;
        breakerSeconds = breakerSeconds_;
    }

    // ------------------------------------------------------------ the state

    /// @notice True while trading is stopped. A deadline, so it clears itself.
    function haltedNow() public view returns (bool) {
        return block.timestamp < haltedUntil;
    }

    /// @notice Halt seconds a supervisor may still grant this epoch.
    function remainingBudget() public view returns (uint32) {
        uint32 used = _granted[clock.currentEpoch()];
        return used >= budgetSeconds ? 0 : budgetSeconds - used;
    }

    function grantedIn(uint64 epoch) external view returns (uint32) {
        return _granted[epoch];
    }

    // ------------------------------------------------------- the discretion

    /// @notice Stop trading for `seconds_`. Supervisor only, capped, budgeted.
    /// @dev The rationale is committed for the reason `Regime.propose` commits
    ///      one: the supervisor cannot later claim a reason other than the one
    ///      it gave at the time.
    function halt(uint32 seconds_, bytes32 rationale) external returns (uint64 until) {
        if (msg.sender != regime.supervisor()) revert NotSupervisor();
        if (seconds_ == 0) revert ZeroHalt();
        if (seconds_ > maxHaltSeconds) revert HaltTooLong(seconds_, maxHaltSeconds);

        uint64 e = clock.currentEpoch();
        uint32 left = remainingBudget();
        if (seconds_ > left) revert BudgetExhausted(e, seconds_, left);
        _granted[e] += seconds_;

        until = uint64(block.timestamp) + seconds_;
        _arm(until);
        emit Halted(until, seconds_, rationale);
    }

    /// @notice End a halt early. Supervisor only, immediate, no bound.
    /// @dev The safe direction, so it carries none of the three bounds above.
    function resume(bytes32 rationale) external {
        if (msg.sender != regime.supervisor()) revert NotSupervisor();
        if (!haltedNow()) revert NotHalted();
        haltedUntil = uint64(block.timestamp);
        emit Resumed(uint64(block.timestamp), rationale);
    }

    // -------------------------------------------------------- the arithmetic

    /// @notice Report a clearing price. Arms the breaker on a band breach.
    /// @dev Venue only, for `VolumeCap.record`'s reason: an open reporter is a
    ///      reporter an adversary feeds a fake price to halt a rival.
    function observe(uint256 priceTwice) external returns (bool armed) {
        if (msg.sender != venue) revert NotVenue();
        uint256 last = lastPriceTwice;
        lastPriceTwice = priceTwice;
        emit Observed(priceTwice);
        if (last == 0 || priceTwice == 0) return false;

        uint256 delta = priceTwice > last ? priceTwice - last : last - priceTwice;
        uint256 moveBps = (delta * 10_000) / last;
        if (moveBps <= bandBps) return false;

        uint64 until = uint64(block.timestamp) + breakerSeconds;
        _arm(until);
        emit Breaker(until, last, priceTwice, moveBps);
        return true;
    }

    /// @dev Extends, never shortens. Two halts in force are one halt ending at
    ///      the later deadline, and the cap still binds each grant separately.
    function _arm(uint64 until) private {
        if (until > haltedUntil) haltedUntil = until;
    }
}
