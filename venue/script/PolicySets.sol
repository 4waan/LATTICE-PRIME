// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {ParameterRoot} from "../src/policy/ParameterRoot.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {DisclosureBudget as B} from "../src/lattice/DisclosureBudget.sol";

/// @title PolicySets
/// @notice The parameter matrix, in one place, because the deployment publishes
///         it and the suite tests it and those had better be the same set.
///
/// This started in `test/PolicyFixture.sol` and moved here when the venue went
/// to testnet. A script cannot import a test fixture's `vm` machinery, and
/// copying twenty rows into a deploy script would have made "what the venue
/// publishes" a claim in a comment rather than a fact in the tree. Now
/// `PolicyFixture` delegates to this library, so every assertion the suite makes
/// about `asDeployed()` is an assertion about the set that went on chain.
///
/// `withFloors` stays in the fixture. It is not deployed, and the point of it is
/// to exercise a bound the venue does not currently publish. The coalition
/// budgets used to sit there too and now do not: `asDeployed` publishes three,
/// and `budgetFor` below carries the derivation DP-01 asks for.
library PolicySets {
    /// @dev Rows the reference-price waiver covers: order size, order price,
    ///      execution price, position risk. Not asset reference data, not
    ///      cadence, not account provenance.
    uint256 internal constant WAIVED = (1 << 3) | (1 << 4) | (1 << 5) | (1 << 14);

    /// @notice Section 7.2, verbatim, for the rows these contracts touch.
    function sevenTwoAsWritten() internal pure returns (ParameterRoot.Param[] memory set) {
        set = new ParameterRoot.Param[](11);
        set[0] = ParameterRoot.Param(bytes32(uint256(3)), L.point(L.G_BUCKET, L.T_EOD));
        set[1] = ParameterRoot.Param(bytes32(uint256(4)), L.point(L.G_EXACT, L.T_15M));
        set[2] = ParameterRoot.Param(bytes32(uint256(5)), L.point(L.G_EXACT, L.T_15M));
        set[3] = ParameterRoot.Param(bytes32(uint256(7)), L.point(L.G_EXACT, L.T_IMM));
        // Row 12, counterparty relationship, verbatim from section 7.2, where
        // its citation column reads "the worst cell". **It was already admitted
        // in the matrix and the open question was whether to keep it**, which is
        // why settling it is a decision rather than a parameter change: the
        // alternative on the table was moving settlement to a netted layer, and
        // `venue/docs/MATCHING.md` section 3 prices that alternative at this
        // venue's order rate and finds it does not clear the bar it was supposed
        // to clear.
        set[4] = ParameterRoot.Param(bytes32(uint256(12)), L.point(L.G_EXACT, L.T_IMM));
        // Row 13, the match predicate. `dep?` in the matrix; not dependent here.
        // See `MatchingEngine.ROW_MATCH_PREDICATE`.
        set[5] = ParameterRoot.Param(bytes32(uint256(13)), L.point(L.G_PRED, L.T_IMM));
        set[6] = ParameterRoot.Param(bytes32(uint256(14)), L.point(L.G_PRED, L.T_IMM));
        // Row 15, activity fingerprint, verbatim. `OrderBook.cancel` is the
        // venue's first caller on this row and the cell as written refuses it: a
        // contract with no scheduler cannot produce an aggregate deferred to end
        // of day. Disposition in `asDeployed`.
        set[7] = ParameterRoot.Param(bytes32(uint256(15)), L.point(L.G_AGG, L.T_EOD));
        set[8] = ParameterRoot.Param(bytes32(uint256(16)), L.point(L.G_EXACT, L.T_IMM));
        set[9] = ParameterRoot.Param(bytes32(uint256(17)), L.point(L.G_EXACT, L.T_IMM));
        set[10] = ParameterRoot.Param(keccak256("hedera2026.param.waivedRows.v1"), WAIVED);
    }

    /// @notice Where a row's key sits in a parameter set.
    /// @dev **Added because five tests broke on a change that had nothing to do
    ///      with them.** Every suite that wanted to move "row 14" wrote `set[4]`,
    ///      so publishing rows 12 and 13 renumbered assertions in
    ///      `ParameterRoot.t.sol` and `MarketAbuse.t.sol` and each one failed
    ///      naming the wrong row. A parameter set is a set; the order is an
    ///      artefact of the ascending-key rule `rootOf` imposes on the tree. Look
    ///      the row up rather than counting.
    function _rowAt(ParameterRoot.Param[] memory set, uint16 row)
        internal
        pure
        returns (uint256)
    {
        bytes32 k = bytes32(uint256(row));
        for (uint256 i = 0; i < set.length; ++i) {
            if (set[i].key == k) return i;
        }
        revert("row not in set");
    }

    /// @notice What the venue publishes. Rows 3 and 4 move to `(exact, imm)`.
    /// @dev The derivation, because DP-01 asks for one rather than for a number.
    ///      Section 7.2 reaches rows 3 and 4's public cells through a first cell
    ///      at `(exact, {ven}, imm)`, in which the venue holds the value and the
    ///      public does not. A public ledger has no such observer set: a contract
    ///      that can read a number is a contract whose calldata and storage
    ///      anyone can read. So the deferral has nothing to defer from, and the
    ///      honest published cell for a revealed order on this ledger is
    ///      `(exact, {pub}, imm)`. Commit-and-reveal still moves *when* that
    ///      happens, which is what buys Rule 1 against the node operators, and it
    ///      does not narrow *who*.
    function asDeployed() internal pure returns (ParameterRoot.Param[] memory set) {
        set = sevenTwoAsWritten();
        set[_rowAt(set, 3)].value = L.point(L.G_EXACT, L.T_IMM);
        set[_rowAt(set, 4)].value = L.point(L.G_EXACT, L.T_IMM);
        // **Row 5 joined them on , and the omission was a real
        // inconsistency rather than a conservative choice.**
        //
        // The argument above is that a public ledger has no `{ven}` distinct
        // from `{pub}`, so a cell reached through `(exact, {ven}, imm)` has
        // nothing to defer from. Row 5's first cell is `(exact, {cp,ven,reg},
        // imm)`, which is the same collapse with two more observers in it, and
        // the set applied the argument to rows 3 and 4 and stopped. Nothing
        // caught it because nothing in the venue had ever published an execution
        // price: `RepoVault` declares `ROW_EXEC_PRICE` and deliberately emits no
        // price, and the order book had no matching. `MatchingEngine` is the
        // first contract that prints one, and under the set as it stood **every
        // cross was dark volume and Article 5 fired on the first trade.**
        //
        // The collapse is in fact stronger here than on rows 3 and 4. A clearing
        // price is a deterministic function of orders that are already public at
        // `(exact, imm)`, so anyone recomputes it from the tape whether or not
        // the venue emits it. Deferring it fifteen minutes withholds nothing;
        // it is the same objection `RepoVault.close` already records about the
        // repurchase price, at a second site.
        set[_rowAt(set, 5)].value = L.point(L.G_EXACT, L.T_IMM);
        // **Row 15 moves sideways rather than up.** Rows 3, 4 and 5 all moved
        // because their cells are reached through a `{ven}` stage a public ledger
        // does not have, and each landed strictly above section 7.2. Row 15's
        // cell is a genuine deferral with no stage to collapse, achievable in
        // principle by counting cancellations and publishing at end of day. The
        // venue lacks the mechanism: a contract cannot defer an event, so that
        // needs an accumulator and a permissionless flush, and neither is built.
        //
        // So the published cell is `(pred, {pub}, imm)`: less per event than the
        // matrix allows and sooner. Neither ideal contains the other, making this
        // the venue's only incomparable divergence. Worth publishing rather than
        // dropping the feature because `pred` is the one granularity in the book
        // a coalition budget can bind, and one is published below.
        set[_rowAt(set, 15)].value = L.point(L.G_PRED, L.T_IMM);

        // **The three coalition budgets, which used to live in the fixture.**
        // Keys ascend: rows 0-17, floors 18-35, budgets 36-53, then the keccak
        // keys, so a budget leaf goes between row 17 and the waiver mask.
        // `budgetFor` carries the derivation, and `PolicySets.t.sol` asserts
        // each of its three rules against the behaviour it produces.
        ParameterRoot.Param[] memory withBudgets = new ParameterRoot.Param[](set.length + 3);
        for (uint256 i = 0; i < set.length - 1; ++i) {
            withBudgets[i] = set[i];
        }
        uint256 n = set.length - 1;
        withBudgets[n] = ParameterRoot.Param(_budgetKey(13), budgetFor(13));
        withBudgets[n + 1] = ParameterRoot.Param(_budgetKey(14), budgetFor(14));
        withBudgets[n + 2] = ParameterRoot.Param(_budgetKey(15), budgetFor(15));
        withBudgets[n + 3] = set[set.length - 1];
        set = withBudgets;
    }

    // ------------------------------------------------------- the budgets

    /// @notice `ParameterRoot.BUDGET_BASE + row`, spelled here so a set can be
    ///         built without a deployed contract to ask.
    /// @dev The offset is `ParameterRoot.KEY_CARD`, which is `2 * ROW_CARD`.
    ///      `test_theBudgetKeysAreTheContractsBudgetKeys` pins the two together.
    function _budgetKey(uint16 row) internal pure returns (bytes32) {
        return bytes32(uint256(row) + 36);
    }

    /// @notice The published coalition budget for one metered row, packed the
    ///         way `ParameterRoot.packBudget` packs it.
    ///
    /// @dev **Every number here is read off a deployed encoding. None is
    ///      chosen.** That is the whole reason this function exists rather than
    ///      four literals in a deploy script: `docs/who-gets-privacy.md` DP-01
    ///      refuses a published constant with no derivation behind it, and the
    ///      budgets sat in `PolicyFixture` for exactly that long. Three rules,
    ///      applied uniformly, and each one is checkable against `src/`.
    ///
    ///      **Rule 1. `domainBits` is the width of the row's value domain as the
    ///      venue itself encodes it.** The same rule `AxeGrid.RECTANGLE_BITS`
    ///      already follows. Per row:
    ///
    ///      - Row 13, the match predicate. The row-13 channel carries a round's
    ///        outcome, and `MatchingEngine` encodes that outcome in exactly four
    ///        events: `RoundEmpty`, `RoundCrossed`, `PrintedCoarse`,
    ///        `PrintWithheld`. Four values, so two bits.
    ///      - Row 14, position risk. The row-14 channel carries a repo's state,
    ///        and `RepoVault.State` has eight members. Eight values, three bits.
    ///      - Row 15, the activity fingerprint. The row-15 channel carries which
    ///        branch a committer took, and `OrderBook` partitions a commitment's
    ///        life into exactly three disjoint windows: cancel, reveal, forfeit.
    ///        `testFuzz_theWindowsPartitionTheCommitmentLifetime` is the proof
    ///        that there is no fourth. Three values, two bits.
    ///
    ///      **Rule 2. `budgetBits` is `domainBits - 1`, the largest bound
    ///      `DisclosureBudget.requireWellFormed` admits.** So the venue publishes
    ///      the loosest bound the model allows rather than a number somebody
    ///      liked, and the published budget cannot be read as the operator
    ///      tuning the meter: any smaller value would be a choice, and there is
    ///      no larger one. It still binds, which is the point. At `G_PRED`, one
    ///      bit a disclosure, `breakingSize` is then exactly `domainBits`: the
    ///      second cross of an epoch, the third position move, and the second
    ///      cancellation are the ones that go quiet.
    ///
    ///      **Rule 3. `aggBits` and `bucketBits` are `domainBits`, because the
    ///      venue defines no aggregate and no bucketing on any of these three
    ///      rows.** `_bucket` exists on rows 3 and 5 and nowhere else, and
    ///      nothing in `src/` ever charges these rows above `G_PRED`. A level
    ///      with no defined coarsening has to cost the whole domain: pricing it
    ///      lower would charge less than an undefined disclosure could leak,
    ///      which is the unsound direction. Priced at the domain, it is
    ///      unaffordable under Rule 2 by construction, which is the same
    ///      statement as "the venue does not make it".
    function budgetFor(uint16 row) internal pure returns (uint256) {
        uint16 domainBits = domainBitsOf(row);
        return _pack(
            B.Row({
                domainBits: domainBits,
                aggBits: domainBits,
                bucketBits: domainBits,
                budgetBits: domainBits - 1
            })
        );
    }

    /// @notice Rule 1, alone, so a test can assert the derivation without
    ///         unpacking anything.
    function domainBitsOf(uint16 row) internal pure returns (uint16) {
        // Four outcome events on the round: RoundEmpty, RoundCrossed,
        // PrintedCoarse, PrintWithheld.
        if (row == 13) return 2;
        // `RepoVault.State`: NONE, PROPOSED, OPEN, MARGIN_CALL, MANUFACTURED,
        // FAILING, DEFAULTED, CLOSED.
        if (row == 14) return 3;
        // Three windows: cancel, reveal, forfeit.
        if (row == 15) return 2;
        revert("row carries no published budget");
    }

    /// @notice The rows `asDeployed` publishes a budget on, in ascending order.
    /// @dev The list, so a client and a test enumerate the same three rather
    ///      than each keeping its own copy. Every other row the venue publishes
    ///      sits at `(exact, imm)` and Rule B of `DisclosureMeter` makes a budget
    ///      on it un-adoptable, which is the published ceiling restated rather
    ///      than a gap.
    function meteredRows() internal pure returns (uint16[] memory rows) {
        rows = new uint16[](3);
        rows[0] = 13;
        rows[1] = 14;
        rows[2] = 15;
    }

    /// @dev `ParameterRoot.packBudget`, repeated so a set can be built without a
    ///      deployed contract. `test_theSetPacksWhatTheContractUnpacks` fails if
    ///      the two ever disagree.
    function _pack(B.Row memory r) internal pure returns (uint256) {
        return uint256(r.domainBits) | (uint256(r.aggBits) << 16)
            | (uint256(r.bucketBits) << 32) | (uint256(r.budgetBits) << 48);
    }
}
