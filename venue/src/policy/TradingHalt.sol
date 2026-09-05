// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Regime, IEpochClock} from "./Regime.sol";

/// @title TradingHalt
/// @notice The halt the venue did not have, built as the mirror of the ceiling
///         rather than as a pause key.
///
/// ## Why a pause key is the wrong construction, and why renaming the owner does not fix it
///
/// D-19's rule is that no machine gets authority. A `bool paused` flipped by an
/// owner breaks it, and calling that owner `supervisor` does not repair
/// anything: the principal is not what makes `Regime` safe, the **asymmetry**
/// is. Narrowing is immediate because it is the safe direction. Widening waits
/// for a boundary because it is the direction that leaks.
///
/// A halt inverts the sign. Taking away the ability to trade is the deprivation,
/// so halting is the leaky direction and resuming is the safe one:
///
/// | instrument | safe, immediate | leaky, bounded |
/// |---|---|---|
/// | ceiling | `narrow` | `relax`, at a boundary |
/// | floor | `raiseFloor` | `lowerFloor`, at a boundary |
/// | halt | `resume` | `halt`, capped, budgeted, self-expiring |
///
/// Three bounds carry it, and each is one of `Regime`'s read in the mirror.
///
/// 1. **A halt is a deadline and never a flag.** There is no state a halt can be
///    left in and no call is needed to end one. A halt that must be lifted is a
///    halt whose lifting can be declined.
/// 2. **`maxHaltSeconds` is immutable.** A supervisor cannot grant itself a
///    longer halt, for the reason an operator cannot grant itself a wider
///    waiver. A longer halt is a deployment, which is the correct shape.
/// 3. **Halted time is budgeted per epoch.** An unlimited number of
///    maximum-length halts is an unlimited halt. This is the fourth sighting of
///    the mechanism `DisclosureBudget`, `SeamJournal._spent` and `VolumeCap` are
///    the other three of: count consumption against a ceiling, reset per window.
///
/// ## What a halt may stop, which is exactly one function
///
/// It gates `MatchingEngine.crossRound`. `commit`, `reveal`, `cancel`, `expire`,
/// `forfeit` and `withdraw` stay open, and `RepoVault` does not import this
/// contract at all, so a halted venue cannot trade and cannot stop anyone
/// leaving. `OrderBook.expire` already states the principle in its own comment:
/// a venue that alone could return a bond would have a lever over every open
/// order. A halt that reached the exits would be that lever.
///
/// ## The breaker, and the one thing a sealed book cannot do
///
/// MiFID II Article 48(5) asks a venue to be able to halt on significant price
/// movement. `observe` is that, and it is arithmetic rather than a person: the
/// venue reports each clearing price and the band decides. Recording is
/// permissioned and the decision is not, which is `VolumeCap`'s asymmetry
/// unchanged, so the venue can misreport but cannot decline to act on what it
/// reported.
///
/// **The breaker cannot stop the round that breached it.** A sealed book has no
/// indicative price to collar, because the price does not exist until the round
/// clears. So the breaching round prints and the next one is halted, which is a
/// limit-move halt rather than an auction collar. Stated, not hidden.
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
