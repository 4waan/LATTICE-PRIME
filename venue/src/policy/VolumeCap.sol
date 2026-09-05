// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {DisclosureLattice as L} from "../lattice/DisclosureLattice.sol";
import {Regime} from "./Regime.sol";
import {IEpochClock} from "../interfaces/IEpochClock.sol";

/// @title VolumeCap
/// @notice Venue share of deferred volume. Suspends by raising `Regime`'s floor.
/// @dev A quota is not a lattice cell. `record` is permissioned; `enforce` is not.
///      Suspension raises the floor (a waiver lowers a minimum). `docs/RULEBOOK.md`.
contract VolumeCap {
    Regime public immutable regime;
    IEpochClock public immutable clock;

    /// @notice Share of volume, bps, above which the waiver suspends. Config, not derived.
    uint16 public immutable capBps;

    /// @notice Floor raised to while the cap is breached. Must contain `mandate`.
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
