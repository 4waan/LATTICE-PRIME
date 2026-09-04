// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Regime, IEpochClock} from "../src/policy/Regime.sol";
import {ParameterRoot} from "../src/policy/ParameterRoot.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {DisclosureBudget} from "../src/lattice/DisclosureBudget.sol";

contract EpochClockMock is IEpochClock {
    uint64 public e;

    function currentEpoch() external view returns (uint64) {
        return e;
    }

    function tick() external {
        e += 1;
    }
}

/// @title PolicyFixture
/// @notice Deploys the policy stack and publishes a parameter set, so that every
///         suite exercising a disclosing contract exercises it under a real,
///         root-committed matrix rather than under a constant.
///
/// Three sets, and the differences between them are the point.
///
/// - `sevenTwoAsWritten` is `the build notes` section 7.2 transcribed. It is the
///   matrix the study claims to operate under.
/// - `asDeployed` is what the venue actually publishes. It differs from section
///   7.2 on rows 3 and 4, and the divergence is a governed parameter under a
///   committed root rather than an undocumented gap.
/// - `withFloors` adds row obligations to two rows. It is **not** deployed: the
///   per-row minimums have not been derived from the regulation, and a design decision's
///   floor is built without them. It exists so the tests exercise the bound the
///   venue does not currently publish.
///
/// `OrderBook.t.sol` publishes the first and shows a reveal reverting under it.
/// That test is the evidence that the second set is a decision and not a
/// convenience.
abstract contract PolicyFixture {
    EpochClockMock internal clock;
    Regime internal regime;
    ParameterRoot internal params;

    address internal constant OPERATOR = address(0x09E);
    address internal constant SUPERVISOR = address(0x5E4);

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
        // a coalition budget can bind. See `meteredCancellations`.
        set[_rowAt(set, 15)].value = L.point(L.G_PRED, L.T_IMM);
    }

    /// @notice `asDeployed`, plus a row floor on rows 3 and 5.
    /// @dev Not what the venue publishes. This is the set the floor tests use,
    ///      and the values are chosen to be *inside* the corresponding ceilings
    ///      so the set is adoptable: the point under test is the relation between
    ///      the two bounds, not either number.
    function withFloors() internal pure returns (ParameterRoot.Param[] memory set) {
        ParameterRoot.Param[] memory base = asDeployed();
        set = new ParameterRoot.Param[](base.length + 2);
        for (uint256 i = 0; i < base.length - 1; ++i) {
            set[i] = base[i];
        }
        // Keys must strictly ascend and `KEY_WAIVED_ROWS` is a `keccak256`, so
        // the floors at 18 + row go between the rows and it.
        uint32 obliged = L.point(L.G_AGG, L.T_EOD);
        set[base.length - 1] = ParameterRoot.Param(bytes32(uint256(18 + 3)), obliged);
        set[base.length] = ParameterRoot.Param(bytes32(uint256(18 + 5)), obliged);
        set[base.length + 1] = base[base.length - 1];
    }

    /// @notice `asDeployed`, plus a coalition budget on row 14.
    /// @dev The set that makes `DisclosureMeter` bind. Row 14 is the only row in
    ///      the deployed matrix that is both published and disclosed below
    ///      `exact`, so it is the only row a well formed budget can attach to.
    ///      Rows 3, 4, 7, 16 and 17 all sit at `(exact, imm)` and Rule B refuses a
    ///      budget on each of them, which is the finding rather than a gap in this
    ///      fixture.
    ///
    ///      The four numbers, and none of them is decorative:
    ///
    ///      - `domainBits = 8`. A position predicate ranges over a repo lifecycle
    ///        with 256 distinguishable states at the resolution this row cares
    ///        about. It is a fixture number and it is marked as one.
    ///      - `budgetBits = 3`. So three `(pred, imm)` disclosures fit in an epoch
    ///        and the fourth is withheld. `breakingSize` says 4 and
    ///        `test_breakingSizeIsTheNumberObserved` checks the arithmetic
    ///        against the behaviour rather than against itself.
    function withBudgets() internal pure returns (ParameterRoot.Param[] memory set) {
        ParameterRoot.Param[] memory base = asDeployed();
        set = new ParameterRoot.Param[](base.length + 1);
        for (uint256 i = 0; i < base.length - 1; ++i) {
            set[i] = base[i];
        }
        // Keys ascend: rows 0-17, floors 18-35, budgets 36-53, then the keccak
        // keys. Row 14's budget is key 50.
        set[base.length - 1] =
            ParameterRoot.Param(bytes32(uint256(36 + 14)), _packBudget(8, 2, 4, 3));
        set[base.length] = base[base.length - 1];
    }

    /// @notice `asDeployed`, plus a coalition budget on row 15.
    /// @dev **The set in which the order book is metered for the first time.**
    ///      Rows 3, 4 and 17 publish at `exact` and Rule B refuses a budget on
    ///      each, so until `cancel` existed there was nothing to attach one to.
    ///
    ///      A cancel discloses at `pred`, priced at one bit, so the arithmetic is
    ///      exact rather than rounded: `budgetBits = 3` announces the first three
    ///      cancellations of an epoch and withholds the fourth, and
    ///      `breakingSize(15, G_PRED)` says 4 with no division to argue about.
    ///
    ///      `domainBits = 8` is a fixture number on the same footing as row 14's
    ///      and marked as one. It is not derived from the regulation, which is
    ///      why this is a fixture set and `asDeployed` publishes the ceiling with
    ///      no budget under it.
    function meteredCancellations() internal pure returns (ParameterRoot.Param[] memory set) {
        ParameterRoot.Param[] memory base = asDeployed();
        set = new ParameterRoot.Param[](base.length + 1);
        for (uint256 i = 0; i < base.length - 1; ++i) {
            set[i] = base[i];
        }
        // Keys ascend: rows 0-17, floors 18-35, budgets 36-53, then keccak keys.
        // Row 15's budget is key 51.
        set[base.length - 1] =
            ParameterRoot.Param(bytes32(uint256(36 + 15)), _packBudget(8, 2, 4, 3));
        set[base.length] = base[base.length - 1];
    }

    /// @dev The packing `ParameterRoot.packBudget` performs, repeated here so the
    ///      fixture does not need a deployed contract to build a set. If the two
    ///      ever disagree, `test_theFixturePacksWhatTheContractUnpacks` fails.
    function _packBudget(uint16 domain, uint16 agg, uint16 bucket, uint16 budget)
        internal
        pure
        returns (uint256)
    {
        return uint256(domain) | (uint256(agg) << 16) | (uint256(bucket) << 32)
            | (uint256(budget) << 48);
    }

    /// @notice `asDeployed`, with the execution price row narrowed to a bucket.
    /// @dev Row 5 is in the waived set, so this is the shape a supervisory
    ///      narrowing takes: the venue may still say *something* about the price
    ///      and not the number. It is the middle branch of
    ///      `MatchingEngine._print`, and the branch that makes Article 5's
    ///      counter move, because a price published as an order of magnitude is a
    ///      price that used a hiding mechanism.
    function coarseExecutionPrice() internal pure returns (ParameterRoot.Param[] memory set) {
        set = asDeployed();
        set[_rowAt(set, 5)].value = L.point(L.G_BUCKET, L.T_IMM);
    }

    /// @notice `coarseExecutionPrice`, plus a binding budget on row 5.
    /// @dev Row 5 is now the second row in the venue that a well formed budget
    ///      can attach to at all, and the first one on the trading path. Rule B
    ///      refuses a budget on any row whose ceiling admits `(exact, imm)`, and
    ///      narrowing row 5 to a bucket is exactly what makes it meterable.
    ///
    ///      `budgetBits = 8` against `bucketBits = 4`, so **two** bucketed prints
    ///      fit in an epoch and the third is withheld. That number is the whole
    ///      point of the fixture: it is small enough that a test can reach the
    ///      exhaustion in three rounds rather than by simulating a month.
    function meteredExecutionPrice() internal pure returns (ParameterRoot.Param[] memory set) {
        ParameterRoot.Param[] memory base = coarseExecutionPrice();
        set = new ParameterRoot.Param[](base.length + 1);
        for (uint256 i = 0; i < base.length - 1; ++i) {
            set[i] = base[i];
        }
        // Keys ascend: rows 0-17, floors 18-35, budgets 36-53, then keccak keys.
        set[base.length - 1] =
            ParameterRoot.Param(bytes32(uint256(36 + 5)), _packBudget(16, 2, 4, 8));
        set[base.length] = base[base.length - 1];
    }

    function _deployPolicy(ParameterRoot.Param[] memory set) internal {
        _deployPolicy(set, SUPERVISOR);
    }

    /// @notice The deployment where the supervisor seat is left vacant for
    ///         `VolumeCap` to take.
    /// @dev `VolumeCapTest` already establishes this order and the reason
    ///      `bootstrapSupervisor` exists: the regime goes up with the role
    ///      empty, the cap takes the regime, then the role is filled once and
    ///      **the cap contract is the supervisor**. Suspension is arithmetic
    ///      rather than a person. The engine suite needs the same order because
    ///      it is the first caller that makes the cap's counter move.
    function _deployPolicy(ParameterRoot.Param[] memory set, address supervisor_) internal {
        clock = new EpochClockMock();
        // The ideal is `TOP` and that is not an absence of a ceiling, it is the
        // grant this venue holds: it may be fully transparent. The per-row
        // restrictions live in the parameter set, and `Regime` narrows the waived
        // rows underneath them.
        //
        // The mandate is `BOTTOM`, and that is a stated limit rather than a
        // default. `the design notes` a design decision builds the floor; it does not
        // derive the seventeen per-row obligations from the regulation, and
        // `who-gets-privacy.md` DP-01 refuses a published constant with no
        // derivation behind it. So this venue ships obliged to nothing at rest,
        // and the floor that binds it is the one `VolumeCap` raises when Article
        // 5's cap fires. `withFloors` is the set that exercises the other half.
        regime = new Regime(L.TOP, L.BOTTOM, L.TOP, supervisor_, OPERATOR, clock);
        params = new ParameterRoot(regime);
        _publish(set);
    }

    function _publish(ParameterRoot.Param[] memory set) internal {
        bytes32 r = params.rootOf(set);
        // The prank must be armed *after* `rootOf`, which is an external call and
        // would otherwise consume it. Cost one debugging cycle; noted so it costs
        // nobody a second one.
        vmPrank(OPERATOR);
        params.propose(r, "fixture");
        clock.tick();
        params.adopt(set);
    }

    /// @dev `vm.prank` without inheriting `Test`, so this fixture composes with
    ///      suites that already inherit it.
    function vmPrank(address who) private {
        (bool ok,) = address(uint160(uint256(keccak256("hevm cheat code"))))
            .call(abi.encodeWithSignature("prank(address)", who));
        require(ok, "prank failed");
    }
}
