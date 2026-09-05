// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {RepoVault} from "../repo/RepoVault.sol";
import {DisclosureBudget as B} from "../lattice/DisclosureBudget.sol";
import {DisclosureLattice as L} from "../lattice/DisclosureLattice.sol";
import {IDisclosurePolicy} from "../interfaces/IDisclosurePolicy.sol";

/// @title MarginWatch
/// @notice Position and margin alerts, read from state rather than from events.
///
/// `RepoVault.postMark` moves to `MARGIN_CALL` and starts the cure clock
/// unconditionally, then emits `MarginCalled` only if the disclosure meter can still
/// afford it. An exhausted budget withholds the event and lets the transition stand, so a
/// log subscriber can miss a live margin call. A state read cannot.
///
/// `unmarkedFail` needs no event at all: `markFailing` is permissionless, so a repo past
/// maturity sits in `OPEN` until somebody calls it.
///
/// No events, no storage, no access control. An event here would publish the position
/// predicate without passing the vault's meter, which is the thing the meter rations.
/// Everything returned is already public through `RepoVault.repo`.
contract MarginWatch {
    /// @dev The position-risk disclosure the vault charges margin calls against.
    uint16 internal constant ROW_POSITION = 14;

    RepoVault public immutable vault;

    /// @dev Deadlines rather than countdowns: the caller has `block.timestamp` in the
    ///      same reply, and a countdown goes stale in its hands.
    struct Alert {
        RepoVault.State state;
        /// @dev True whenever the position is called, emitted or not.
        bool called;
        uint64 cureDeadline;
        uint64 maturity;
        bool cureExpired;
        /// @dev `OPEN` past maturity, so no `Failing` event exists or can.
        bool unmarkedFail;
        /// @dev `declareDefault(id)` would succeed in this block.
        bool defaultable;
    }

    /// @dev Whether the margin event stream can be believed. `permitted` false means the
    ///      next transition reverts, loudly. `audible` false means it succeeds in silence,
    ///      and that is the one an alerting client has to watch.
    struct Stream {
        uint64 epoch;
        bool metered;
        uint32 budgetBits;
        uint32 spentBits;
        bool permitted;
        bool audible;
        /// @dev Calls remaining before the row is spent. Zero when unmetered.
        uint256 breakingSize;
    }

    constructor(RepoVault vault_) {
        vault = vault_;
    }

    function alertOf(bytes32 id) public view returns (Alert memory a) {
        RepoVault.Repo memory r = vault.repo(id);
        a.state = r.state;
        a.cureDeadline = r.cureDeadline;
        a.maturity = r.maturity;
        a.called = r.state == RepoVault.State.MARGIN_CALL;
        a.cureExpired = a.called && block.timestamp >= r.cureDeadline;

        // `maturity == 0` is a position that never opened, not one that is overdue.
        a.unmarkedFail = r.state == RepoVault.State.OPEN && r.maturity != 0
            && block.timestamp >= r.maturity;

        a.defaultable = a.cureExpired
            || (
                r.state == RepoVault.State.FAILING
                    && block.timestamp >= uint256(r.maturity) + vault.failGrace()
            );
    }

    function alertsOf(bytes32[] calldata ids) public view returns (Alert[] memory out) {
        out = new Alert[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = alertOf(ids[i]);
        }
    }

    function stream() public view returns (Stream memory s) {
        IDisclosurePolicy policy = vault.policy();
        B.Row memory row = policy.budgetFor(ROW_POSITION);

        s.epoch = policy.currentEpoch();
        s.metered = row.budgetBits != 0;
        s.budgetBits = row.budgetBits;
        s.spentBits = vault.spentBits(ROW_POSITION, s.epoch);
        s.permitted = vault.wouldDisclose(ROW_POSITION, L.G_PRED, L.T_IMM);
        s.audible = vault.wouldAfford(ROW_POSITION, L.G_PRED);
        s.breakingSize = vault.breakingSize(ROW_POSITION, L.G_PRED);
    }

    /// @notice A book and the reading that says whether to trust the log beside it.
    /// @dev One call because positions alone cannot distinguish a quiet market from a
    ///      silenced one.
    function watch(bytes32[] calldata ids)
        external
        view
        returns (Alert[] memory alerts, Stream memory s)
    {
        return (alertsOf(ids), stream());
    }

    /// @notice The subset of `ids` currently called.
    /// @dev Diff this against what the caller heard on `MarginCalled`; the difference is
    ///      what the budget withheld. The diff belongs to the caller because only the
    ///      caller knows what it heard.
    function calledAmong(bytes32[] calldata ids) external view returns (bytes32[] memory out) {
        uint256 n;
        for (uint256 i; i < ids.length; ++i) {
            if (vault.stateOf(ids[i]) == RepoVault.State.MARGIN_CALL) ++n;
        }
        out = new bytes32[](n);
        uint256 j;
        for (uint256 i; i < ids.length; ++i) {
            if (vault.stateOf(ids[i]) == RepoVault.State.MARGIN_CALL) out[j++] = ids[i];
        }
    }
}
