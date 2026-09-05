// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Regime, IEpochClock} from "../src/policy/Regime.sol";
import {ParameterRoot} from "../src/policy/ParameterRoot.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {DisclosureBudget} from "../src/lattice/DisclosureBudget.sol";
import {PolicySets} from "../script/PolicySets.sol";

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

    /// @dev Rows the reference-price waiver covers. Kept as an alias because
    ///      seventeen test files name it; the value lives in `PolicySets`.
    uint256 internal constant WAIVED = PolicySets.WAIVED;

    /// @notice Section 7.2, verbatim, for the rows these contracts touch.
    /// @dev Moved to `script/PolicySets.sol` when the venue went to testnet, so
    ///      the deploy script and this fixture cannot publish different matrices.
    ///      The wrapper stays so no suite has to change its call.
    function sevenTwoAsWritten() internal pure returns (ParameterRoot.Param[] memory set) {
        return PolicySets.sevenTwoAsWritten();
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
        return PolicySets._rowAt(set, row);
    }

    /// @notice What the venue publishes. Rows 3, 4 and 5 move to `(exact, imm)`
    ///         and row 15 moves sideways. The derivation is in `PolicySets`.
    function asDeployed() internal pure returns (ParameterRoot.Param[] memory set) {
        return PolicySets.asDeployed();
    }

    /// @notice `asDeployed`, plus a row floor on rows 3 and 5.
    /// @dev Not what the venue publishes. This is the set the floor tests use,
    ///      and the values are chosen to be *inside* the corresponding ceilings
    ///      so the set is adoptable: the point under test is the relation between
    ///      the two bounds, not either number.
    function withFloors() internal pure returns (ParameterRoot.Param[] memory set) {
        uint256 obliged = L.point(L.G_AGG, L.T_EOD);
        set = _with(
            _with(asDeployed(), bytes32(uint256(18 + 3)), obliged),
            bytes32(uint256(18 + 5)),
            obliged
        );
    }

    /// @notice `set` with `key` written, keeping keys strictly ascending.
    /// @dev **Every derived set in this fixture used to splice by index**, which
    ///      worked only while `asDeployed` ended in exactly one `keccak256` key
    ///      and carried nothing between the rows and it. `asDeployed` now
    ///      publishes three budgets, so a hand-spliced floor landed after a
    ///      budget and `rootOf` refused the whole set with `KeysNotAscending`.
    ///      An insert that knows the ordering rule cannot make that mistake, and
    ///      it replaces rather than duplicates, which is what lets a fixture
    ///      override a published budget with its own.
    function _with(ParameterRoot.Param[] memory set, bytes32 key, uint256 value)
        internal
        pure
        returns (ParameterRoot.Param[] memory out)
    {
        for (uint256 i = 0; i < set.length; ++i) {
            if (set[i].key == key) {
                out = set;
                out[i].value = value;
                return out;
            }
        }
        out = new ParameterRoot.Param[](set.length + 1);
        uint256 k;
        bool placed;
        for (uint256 i = 0; i < set.length; ++i) {
            if (!placed && uint256(set[i].key) > uint256(key)) {
                out[k++] = ParameterRoot.Param(key, value);
                placed = true;
            }
            out[k++] = set[i];
        }
        if (!placed) out[k] = ParameterRoot.Param(key, value);
    }

    /// @notice `set` with `key` removed. A no-op when it is not there.
    function _without(ParameterRoot.Param[] memory set, bytes32 key)
        internal
        pure
        returns (ParameterRoot.Param[] memory out)
    {
        uint256 n;
        for (uint256 i = 0; i < set.length; ++i) {
            if (set[i].key != key) ++n;
        }
        out = new ParameterRoot.Param[](n);
        uint256 k;
        for (uint256 i = 0; i < set.length; ++i) {
            if (set[i].key != key) out[k++] = set[i];
        }
    }

    /// @notice A row and the budget published under it, dropped together.
    /// @dev `ParameterRoot.adopt` refuses `BudgetOnUnpublishedRow`, so a test
    ///      that un-publishes a metered row has to take both or the set will not
    ///      adopt at all. That refusal is the mechanism working; taking both is
    ///      how a test asks the question it meant to ask.
    function _withoutRowAndItsBudget(uint16 row)
        internal
        pure
        returns (ParameterRoot.Param[] memory out)
    {
        out = _without(
            _without(asDeployed(), bytes32(uint256(row))), bytes32(uint256(row) + 36)
        );
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
        set = _with(asDeployed(), bytes32(uint256(36 + 14)), _packBudget(8, 2, 4, 3));
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
        set = _with(asDeployed(), bytes32(uint256(36 + 15)), _packBudget(8, 2, 4, 3));
    }

    /// @notice The set an `AxeBoard` deployment would publish: row 13 rederived
    ///         against the board's own domain.
    /// @dev **One row, two encodings, and the deployed set can only carry one.**
    ///      `PolicySets` derives row 13 from `MatchingEngine`, which encodes a
    ///      round's outcome in four events, so `domainBits` is 2 and the largest
    ///      binding budget is 1 bit. A probe here ranges over an `AxeGrid`
    ///      rectangle, `RECTANGLE_BITS` = 18. The board is not deployed and has
    ///      no address, so `asDeployed` answers to the engine; this is what the
    ///      operator would have to propose before the board could take a second
    ///      probe in an epoch.
    ///
    ///      The three rules are `PolicySets.budgetFor`'s unchanged: `domainBits`
    ///      read off the encoding, `budgetBits` the largest bound the model
    ///      admits, `aggBits` and `bucketBits` at the domain because the board
    ///      defines no coarsening on this row either.
    function boardRectangle() internal pure returns (ParameterRoot.Param[] memory set) {
        set = _with(asDeployed(), bytes32(uint256(36 + 13)), _packBudget(18, 18, 18, 17));
    }

    /// @notice Row 13 budget: 18-bit rectangular domain, 3 bits (fourth probe reverts).
    function meteredAxePredicate() internal pure returns (ParameterRoot.Param[] memory set) {
        set = _with(asDeployed(), bytes32(uint256(36 + 13)), _packBudget(18, 2, 4, 3));
    }

    /// @notice Rows 3 and 4 at bucket: a probe may speak; an exact reveal may not.
    function bandedDiscovery() internal pure returns (ParameterRoot.Param[] memory set) {
        set = asDeployed();
        set[_rowAt(set, 3)].value = L.point(L.G_BUCKET, L.T_IMM);
        set[_rowAt(set, 4)].value = L.point(L.G_BUCKET, L.T_IMM);
    }

    /// @notice `bandedDiscovery` plus row 3/4 budgets (two probes announce, third is silent).
    function meteredAxeBands() internal pure returns (ParameterRoot.Param[] memory set) {
        // Row 13 widened to the board's domain first, for `boardRectangle`'s
        // reason: without it the engine's one-bit budget stops the second probe
        // and the test never reaches the bands it is about.
        set = _with(
            _with(
                _with(
                    bandedDiscovery(), bytes32(uint256(36 + 13)), _packBudget(18, 18, 18, 17)
                ),
                bytes32(uint256(36 + 3)),
                _packBudget(16, 2, 4, 8)
            ),
            bytes32(uint256(36 + 4)),
            _packBudget(16, 2, 4, 8)
        );
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
        set = _with(coarseExecutionPrice(), bytes32(uint256(36 + 5)), _packBudget(16, 2, 4, 8));
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
