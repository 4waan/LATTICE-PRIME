// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {DisclosureLattice as L} from "../lattice/DisclosureLattice.sol";
import {Regime, IEpochClock} from "./Regime.sol";

/// @title VolumeCap
/// @notice The quota the marketplace study says the coordinate system cannot express, built as
///         the layer above it rather than as a coordinate.
///
/// ## Why a quota is not a cell, and what to do about it
///
/// `marketplace/EVIDENCE.md` the marketplace study is exact about the shape of the problem.
/// MiFIR Article 5 caps the *fraction of volume* that may use a hiding
/// mechanism, market-wide, enforced by withdrawal of the mechanism. Nothing in
/// `G x O x T` can say that: a cap is not a coordinate on a cell, it is a quota
/// on how much volume may be assigned to a cell. the disclosure matrix answers "what do you hide"
/// completely and has no representation for "what fraction of the market may
/// hide at all".
///
/// Worth naming, because it is the regulator's revealed preference and this
/// contract inherits it: the chosen instrument against too much hidden trading
/// is a **quantity cap, not a price.** MiFID II's double volume cap limits dark
/// trading to 4% on a single venue and 8% market-wide on a rolling twelve
/// months, and the enforcement is withdrawal of the mechanism rather than a
/// tariff on using it. Nobody has made privacy expensive to ration it. See
/// `docs/fee-mechanics.md` FM-04, which also records that in block markets the
/// private route is the *cheaper* one once market impact is counted.
///
/// The resolution is that a quota is not a *missing coordinate*, it is a
/// **second layer with the same shape as `DisclosureBudget`**. Both count
/// consumption against a ceiling and reset per window. `DisclosureBudget` counts
/// bits per row per epoch. This counts volume per instrument per window. That is
/// the third sighting of one mechanism, after `SeamJournal`'s `_spent`
/// accumulator and an invariant's proposed bound on margin-call frequency, and the
/// three should be recognised as one pattern rather than three fixes.
///
/// ## Why the enforcement is permissionless, which is the whole point
///
/// the marketplace study's finding across four venues: nobody can be private *and* checkable,
/// so each venue picks one and backfills the other with discretion. A reputation
/// score, a validator set, an emergency vote. **Each of those is a person
/// deciding**, and the JELLYJELLY remedy was a discretionary operator
/// intervention on the most transparent venue in the study.
///
/// So `enforce` takes no arguments, checks nobody's identity, and either
/// suspends or does not according to arithmetic anyone can run. The venue cannot
/// decline to suspend itself, and it cannot suspend a competitor early.
///
/// Note what this does and does not claim. Article 5's cap is **market-wide**
/// and we observe one venue. What is implemented here is the venue's own share
/// against a configured ceiling, which under Regulation (EU) 2024/791 is closer
/// to right than the original text would have been, because the amendment
/// replaced the double volume cap with a single cap **applied by venues**. It is
/// still not the market-wide figure and the difference must be stated.
contract VolumeCap {
    Regime public immutable regime;
    IEpochClock public immutable clock;

    /// @notice Share of volume, in basis points, above which the waiver suspends.
    /// @dev `[DOC]`. The consolidated Article 5 figure has **not** been pulled,
    ///      per the marketplace study's own instruction, so this is a configuration and not a
    ///      derivation. It is a constructor argument and it is emitted, which is
    ///      `who-gets-privacy.md` DP-01's disposition for exactly this case: a
    ///      published constant, with the derivation owed and named as owed.
    uint16 public immutable capBps;

    /// @notice The obligation the venue is held to while the cap is breached.
    /// @dev **This was `narrow` and the sign was wrong.** a design decision built the
    ///      suspension as a move of `Regime`'s ceiling *down*, on the reading
    ///      that withdrawing a hiding mechanism is a restriction on secrecy.
    ///      `the design notes` a design decision records why that does not work: the
    ///      lattice enforces a maximum, a lower maximum forbids disclosure and
    ///      cannot compel it, and the venue's live configuration sat inside the
    ///      new ceiling and never had to move. The cap fired, the ceiling moved,
    ///      and the venue kept trading dark. The test passed, because it asserted
    ///      that `ceiling()` had moved, which was true and was not the property.
    ///
    ///      Article 5 suspends a waiver, and a waiver lowers a floor, so
    ///      suspending it **raises** one. This is where the floor goes.
    uint32 public immutable suspendedFloor;

    struct Window {
        uint128 deferred;
        uint128 total;
    }

    mapping(uint64 => Window) private _window;
    bool public suspendedNow;

    event Recorded(uint64 indexed window, uint128 deferred, uint128 total);
    event Suspended(uint64 indexed window, uint16 shareBps, uint16 capBps);
    event Lifted(uint64 indexed window, uint16 shareBps, uint16 capBps);

    error NotVenue();
    error CapNotBinding(uint16 capBps);

    /// @notice A suspension floor that does not contain the regime's `mandate`
    ///         is one `Regime.raiseFloor` would refuse on every call, so the
    ///         deployment would carry a cap that can never fire. Caught here,
    ///         once, rather than at the moment it was needed.
    error SuspensionDoesNotRaise(uint32 to, uint32 mandate);

    address public immutable venue;

    constructor(Regime regime_, address venue_, uint16 capBps_, uint32 suspendedFloor_) {
        if (capBps_ == 0 || capBps_ >= 10_000) revert CapNotBinding(capBps_);
        L.requireIdeal(suspendedFloor_);
        uint32 m = regime_.mandate();
        if (!L.permits(suspendedFloor_, m)) revert SuspensionDoesNotRaise(suspendedFloor_, m);
        regime = regime_;
        clock = regime_.clock();
        venue = venue_;
        capBps = capBps_;
        suspendedFloor = suspendedFloor_;
    }

    /// @notice Record one execution against the current window.
    /// @dev `deferredNotional` is the part that used a hiding mechanism. Called
    ///      by the venue on every fill. It is deliberately not permissionless:
    ///      an open counter is a counter an adversary inflates to suspend a
    ///      competitor's waiver, which is market abuse wearing a compliance hat.
    ///      The asymmetry that keeps it honest is that **recording** is
    ///      permissioned and **enforcing** is not, so the venue can misreport but
    ///      cannot decline to act on what it reported.
    function record(uint128 notional, uint128 deferredNotional) external {
        if (msg.sender != venue) revert NotVenue();
        uint64 w = clock.currentEpoch();
        Window storage win = _window[w];
        win.total += notional;
        win.deferred += deferredNotional;
        emit Recorded(w, win.deferred, win.total);
    }

    /// @notice Share of this window's volume that used a hiding mechanism, bps.
    function shareBps() public view returns (uint16) {
        Window storage win = _window[clock.currentEpoch()];
        if (win.total == 0) return 0;
        return uint16((uint256(win.deferred) * 10_000) / uint256(win.total));
    }

    /// @notice Suspend or restore the waiver according to the arithmetic.
    /// @dev Permissionless, and it is the sentence this contract exists for.
    ///      Suspension is immediate because `Regime.raiseFloor` is immediate.
    ///      Restoration is not: it goes through `proposeLowerFloor`, so it lands
    ///      at an epoch boundary under Rule 2 like every other widening. A cap
    ///      that suspends instantly and restores instantly would make the restore
    ///      itself a tradeable signal.
    ///
    ///      The restoration target is `regime.mandate()` and not a constant of
    ///      this contract. A suspension is the withdrawal of a waiver and its end
    ///      is the return of that waiver, so the value to return to is the one
    ///      the grant fixed, which is the one thing here nobody can move.
    function enforce() external returns (bool changed) {
        uint16 s = shareBps();
        uint64 w = clock.currentEpoch();

        if (s > capBps && !suspendedNow) {
            suspendedNow = true;
            regime.raiseFloor(suspendedFloor, keccak256(abi.encode("Article5", w, s, capBps)));
            emit Suspended(w, s, capBps);
            return true;
        }
        if (s <= capBps && suspendedNow) {
            suspendedNow = false;
            regime.proposeLowerFloor(
                regime.mandate(), keccak256(abi.encode("Article5.lift", w, s, capBps))
            );
            emit Lifted(w, s, capBps);
            return true;
        }
        return false;
    }
}
