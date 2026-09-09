// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {DisclosureLattice as L} from "./DisclosureLattice.sol";
import {DisclosureMeter} from "./DisclosureMeter.sol";
import {IDisclosurePolicy} from "../interfaces/IDisclosurePolicy.sol";

/// @title DisclosureView
/// @notice Policy, meter, and the strict and non-blocking event gates.
/// @dev Ceiling breach reverts (misconfig). Exhausted budget withholds (Rule A)
///      and the tx completes. Five getters are the receipt surface.
abstract contract DisclosureView {
    /// @notice The governed disclosure policy, asked per row.
    IDisclosurePolicy public immutable policy;

    /// @notice Bits spent per row per epoch against the governed coalition budget.
    DisclosureMeter.Meter internal _meter;

    /// @notice The cells by which a disclosure exceeded `row`'s ceiling.
    error DisclosureExceedsCeiling(uint16 row, uint32 excess);

    constructor(IDisclosurePolicy policy_) {
        policy = policy_;
    }

    /// @notice Every disclosing event in these contracts passes through here.
    /// @dev Ceiling then budget, failing differently on purpose. A ceiling breach is a
    ///      configuration error and reverts; an exhausted budget is the mechanism
    ///      working, so the event is withheld and the transaction completes.
    /// @return afforded Whether the caller should emit.
    function _emitUnder(bytes32, uint16 row, uint8 g, uint8 t)
        internal
        returns (bool afforded)
    {
        uint32 over = L.excess(policy.ceilingFor(row), L.point(g, t));
        if (over != 0) {
            revert DisclosureExceedsCeiling(row, over);
        }
        return DisclosureMeter.spend(_meter, policy, row, g);
    }

    /// @notice Gate an event without allowing publication policy to block an action.
    /// @dev Reserved for paths that release cash or collateral, including cure
    ///      and the transitions required for default recovery. In that case the
    ///      venue emits nothing when the ceiling narrows. This controls only the
    ///      venue event; transaction calldata, storage, transfers, and upstream
    ///      token events remain public.
    function _emitWithoutBlocking(uint16 row, uint8 g, uint8 t)
        internal
        returns (bool afforded)
    {
        if (L.excess(policy.ceilingFor(row), L.point(g, t)) != 0) return false;
        return DisclosureMeter.spend(_meter, policy, row, g);
    }

    /// @notice What the venue **may** publish on this row, and how soon.
    function ceilingFor(uint16 row) external view returns (uint32) {
        return policy.ceilingFor(row);
    }

    function wouldDisclose(uint16 row, uint8 g, uint8 t) external view returns (bool) {
        return L.permits(policy.ceilingFor(row), L.point(g, t));
    }

    /// @notice The read that makes withholding visible: a row silenced by an exhausted
    ///         budget and a row nobody disclosed on are identical in the event stream.
    function spentBits(uint16 row, uint64 epoch) external view returns (uint32) {
        return DisclosureMeter.spentBits(_meter, row, epoch);
    }

    /// @notice Whether the venue can still **afford** to. Not the same question as
    ///         `wouldDisclose`, which asks whether it may.
    function wouldAfford(uint16 row, uint8 g) external view returns (bool) {
        return DisclosureMeter.wouldAfford(_meter, policy, row, g);
    }

    /// @notice How many disclosures at `g` exhaust `row`. Zero when unmetered.
    function breakingSize(uint16 row, uint8 g) external view returns (uint256) {
        return DisclosureMeter.breakingSize(policy, row, g);
    }
}
