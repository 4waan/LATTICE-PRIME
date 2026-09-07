// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {RepoVault} from "../repo/RepoVault.sol";
import {DisclosureBudget as B} from "../lattice/DisclosureBudget.sol";
import {DisclosureLattice as L} from "../lattice/DisclosureLattice.sol";
import {IDisclosurePolicy} from "../interfaces/IDisclosurePolicy.sol";
import {IPrimeOracle} from "../interfaces/IPrimeOracle.sol";

/// @title MarginWatch
/// @notice Position alerts from state, not events. A withheld `MarginCalled` still happened.
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

    /// @dev Whether the price the alerts were computed from can be believed.
    ///      `Stream` answers the same question about the event log and this is
    ///      the same question about the feed, so it belongs in the same contract
    ///      rather than in a second one: an alert derived from a dark feed and an
    ///      alert nobody published look identical to a client that only has the
    ///      positions.
    struct Feed {
        address oracle;
        /// @dev True when `RepoVault.markToMarket` reverts and `postMark` opens.
        bool dark;
        /// @dev Which half. Both can be true.
        bool ourLegDark;
        bool cashLegDark;
        /// @notice USD per unit of face, eight decimals. Row 7.
        uint128 cleanPrice;
        /// @notice The coupon reference rate, basis points. Row 7.
        uint64 refRateBps;
        /// @dev Not `at`. See `IPrimeOracle.latest`.
        uint64 publishedAt;
        uint64 round;
        /// @notice USD per HBAR, eight decimals. Whoever holds the cash seat.
        uint256 usdPerHbar;
        /// @notice Tinybars per unit of face. Zero when dark.
        uint256 markPerUnitTinybar;
        address cashFeed;
    }

    constructor(RepoVault vault_) {
        vault = vault_;
    }

    /// @notice The feed behind every alert above. Total: never reverts.
    /// @dev A view that reverted on an outage would take a client's whole
    ///      position screen down with the feed, which is exactly when somebody
    ///      needs to be told the feed is down. Everything here degrades to a
    ///      zero beside a flag that says why it is zero.
    function feed() public view returns (Feed memory f) {
        IPrimeOracle o = vault.oracle();
        f.oracle = address(o);
        f.dark = o.stale();
        f.ourLegDark = o.ourLegStale();
        f.cashFeed = address(o.cashFeed());
        (f.cleanPrice, f.refRateBps, f.publishedAt, f.round) = o.latest();
        (bool ok, uint256 usdPerHbar,) = o.cashLeg();
        f.cashLegDark = !ok;
        f.usdPerHbar = usdPerHbar;
        if (!f.dark) f.markPerUnitTinybar = o.markPerUnitTinybar();
    }

    function alertOf(bytes32 id) public view returns (Alert memory a) {
        RepoVault.Repo memory r = vault.repo(id);
        a.state = r.state;
        a.cureDeadline = r.cureDeadline;
        a.maturity = r.maturity;
        a.called = r.state == RepoVault.State.MARGIN_CALL;
        a.cureExpired = a.called && block.timestamp >= r.cureDeadline;

        // `maturity == 0` is a position that never opened, not one that is overdue.
        a.unmarkedFail =
            r.state == RepoVault.State.OPEN && r.maturity != 0 && block.timestamp >= r.maturity;

        a.defaultable = a.cureExpired
            || (r.state == RepoVault.State.FAILING
                && block.timestamp >= uint256(r.maturity) + vault.failGrace());
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

    /// @notice A book and the two readings that say whether to trust it.
    /// @dev One call because positions alone cannot distinguish a quiet market from a
    ///      silenced one, and now cannot distinguish either from a market whose price
    ///      stopped arriving. Three questions, one round trip: what the positions are,
    ///      whether the log that would have announced them is audible, and whether the
    ///      price they were computed against is live.
    function watch(bytes32[] calldata ids)
        external
        view
        returns (Alert[] memory alerts, Stream memory s, Feed memory f)
    {
        return (alertsOf(ids), stream(), feed());
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
