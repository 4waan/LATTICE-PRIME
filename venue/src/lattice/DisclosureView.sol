// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {DisclosureLattice as L} from "./DisclosureLattice.sol";
import {DisclosureMeter} from "./DisclosureMeter.sol";
import {IDisclosurePolicy} from "../interfaces/IDisclosurePolicy.sol";

/// @title DisclosureView
/// @notice The disclosing half of a venue contract: the policy it answers to, the meter
///         it spends from, the one path its events pass through, and the five questions
///         anyone may ask about what it just said.
/// @dev `OrderBook`, `AxeBoard` and `RepoVault` each held their own copy, and the copies
///      had drifted: `RepoVault` reverted without naming the row that broke, and the
///      getters carried three different doc comments, two of them empty. Drift in a copy
///      of an access check is how a venue enforces three policies and describes one.
///
///      The five getters are a product surface rather than a debug aid. Together they let
///      a client show a trader, after the fact, exactly what the venue published about
///      them: what was permitted and how soon, how much of the row's epoch budget is
///      gone, whether the next disclosure will be heard at all, and how many more it
///      takes to exhaust the row. `docs/disclosure-receipt.html` is that client and
///      `MarginWatch.stream` is the same read made on chain for one row. Each is a `view`
///      over at most two `SLOAD`s, which is what makes a receipt after every action
///      affordable rather than a nice idea.
abstract contract DisclosureView {
    /// @notice The governed disclosure policy, asked per row.
    IDisclosurePolicy public immutable policy;

    /// @notice Bits spent per row per epoch against the governed coalition budget.
    DisclosureMeter.Meter internal _meter;

    /// @notice A disclosure was refused by the row's ceiling. Emitted with the
    ///         revert, so the refusal is in the trace even though the state is
    ///         rolled back.
    event DisclosureRefused(bytes32 indexed id, uint16 row, uint32 excess);

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
    function _emitUnder(bytes32 id, uint16 row, uint8 g, uint8 t)
        internal
        returns (bool afforded)
    {
        uint32 over = L.excess(policy.ceilingFor(row), L.point(g, t));
        if (over != 0) {
            emit DisclosureRefused(id, row, over);
            revert DisclosureExceedsCeiling(row, over);
        }
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
