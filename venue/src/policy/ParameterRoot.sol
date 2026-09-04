// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {DisclosureLattice as L} from "../lattice/DisclosureLattice.sol";
import {DisclosureBudget as B} from "../lattice/DisclosureBudget.sol";
import {DisclosureMeter} from "../lattice/DisclosureMeter.sol";
import {IDisclosurePolicy} from "../interfaces/IDisclosurePolicy.sol";
import {RootWindow} from "./RootWindow.sol";
import {Regime, IEpochClock} from "./Regime.sol";

/// @title ParameterRoot
/// @notice The governed parameter set, committed to one word.
///
/// ## What D11b actually buys, and why it is not a gas optimisation
///
/// `the study plan` D11b starts from a measured property: Groth16 verification
/// costs `181,000 + 6,150n` gas and depends only on the public input count, never
/// on circuit size. So a Merkle tree over every governed parameter, with the
/// **root** as one public input, gives the circuit an unbounded parameter set for
/// 6,150 gas. The prover supplies the value and its path as private witness, the
/// circuit checks the path, the verifier checks the root against storage.
///
/// That is the ZK-side argument and it is already written down. The part that was
/// not written down is what the root does for the contracts that hold no proof at
/// all, and it is the larger half:
///
/// > **The root turns the disclosure matrix from a document into a deployment
/// > artefact.** Section 7.2 has seventeen rows. Before this contract, two of
/// > those rows were compiled into `RepoVault` and `OrderBook` as immutable
/// > constants and the other fifteen existed only in Markdown. A regulator asking
/// > "which cells is this venue actually operating under" had no on-chain answer.
///
/// ## Committed at proposal, opened at adoption
///
/// `propose` takes a **root** and nothing else. `adopt` takes the parameter set
/// and rebuilds the root from it, so the set is revealed only when it lands.
/// This is the order book's own commit-and-reveal discipline turned on
/// governance, and it is there because D11d.1 says governance is itself a
/// disclosure channel and names the dangerous case: per-asset parameter changes.
/// A proposal in the clear announces which asset is about to have its threshold
/// moved, one epoch before it moves, to everyone.
///
/// Row 10 of section 7.2 gives governance actions `(exact, {pub}, epoch)`. This
/// construction meets it exactly and adds a predicate at `imm`: the commitment
/// discloses **that** a change is coming and nothing about which parameter or
/// which asset, so the pair of cells is `(pred, {pub}, imm)` then
/// `(exact, {pub}, epoch)`.
///
/// ## The root is derived, never declared
///
/// `adopt` does not take the publisher's word for the tree. It hashes the set it
/// was given and compares. So contract storage and the root the circuit checks
/// against cannot disagree, and nobody has to trust that whoever built the tree
/// built it over the values that were actually written. `rootOf` is public and
/// pure for the same reason `OrderBook.commitmentOf` is: the client and the
/// contract must not be able to disagree about the preimage.
///
/// ## A row has two bounds, and the second one arrived late
///
/// Keys 0 to 17 are row **ceilings** and keys 18 to 35 are row **floors**.
/// `the design notes` a design decision: the lattice expresses a maximum, MiFID imposes a
/// minimum, and a parameter set that carried only the maximum could say what the
/// venue may hide and had no way to say what it must publish. Adoption now
/// refuses a set whose row ceiling forbids that same set's row floor, and every
/// read returns the pair under one regime state. See `_effective`.
///
/// ## Two hash functions again, and the same reason as the order book
///
/// The path is checked with Poseidon **inside** the circuit, where keccak costs
/// roughly 150,000 constraints and Poseidon about 240. The tree here is built
/// with keccak because it is built **on chain**, where keccak is a precompile at
/// about 30 gas a word. These are not competing implementations of one tree: the
/// contract never walks a path, it only ever compares a root, and the prover
/// never touches this contract. Same primitive, opposite cost model, chosen per
/// call site. `OrderBook` states this for bids and it is the identical argument.
contract ParameterRoot is IDisclosurePolicy {
    using RootWindow for RootWindow.Window;

    struct Param {
        bytes32 key;
        uint256 value;
    }

    /// @notice Rows 1 to 17 of the section 7.2 matrix key themselves.
    /// @dev A row key is literally `bytes32(row)`, so `key < ROW_CARD` identifies
    ///      one in a single comparison and the adopt path can validate that a row
    ///      value is a coherent disclosure ideal without seventeen keccaks per
    ///      leaf. Every other governed key is a `keccak256`, which does not
    ///      collide with an integer below eighteen in any world we need to reason
    ///      about.
    uint16 public constant ROW_CARD = 18;

    /// @notice A row's **floor** is keyed `ROW_CARD + row`, so keys 18 to 35 are
    ///         the obligations and keys 0 to 17 are the ceilings.
    /// @dev `the design notes` a design decision: the lattice expresses a maximum and
    ///      MiFID imposes a minimum, so a row needs both. An integer offset
    ///      rather than a `keccak256` for two reasons that are the same reason.
    ///      The `k < ROW_CARD` test that identifies a row in one comparison
    ///      extends to `k < KEY_CARD` for a floor, so both are validated as
    ///      ideals without seventeen more keccaks per leaf. And keys must
    ///      strictly ascend in `rootOf`, so an offset puts every row ceiling
    ///      before every row floor in the tree, which is what lets `adopt` check
    ///      a floor against its own ceiling in the same single pass.
    uint16 public constant KEY_CARD = 36;

    /// @notice A row's **coalition budget** is keyed `KEY_CARD + row`, so keys 36
    ///         to 53 are the budgets and the parameter space is three bands.
    /// @dev The third bound, and the reason it is governed rather than a
    ///      constructor argument is the reason `IDisclosurePolicy` exists: a
    ///      bound nobody can read off the committed root is a bound nobody can
    ///      audit. `SeamJournal` still takes its budget at deploy and that is
    ///      recorded as owed rather than fixed here, because it is an
    ///      `ICompliance` that must never revert and a governed read is a new
    ///      revert path into a token's transfer.
    ///
    ///      The band sits above the floors and the same ascending-key discipline
    ///      applies, so a budget leaf is validated in the same single pass and
    ///      against the row ceiling that `adopt` has already written.
    uint16 public constant BUDGET_BASE = KEY_CARD;

    /// @notice One past the last integer-keyed parameter. Keys at or above this
    ///         are `keccak256` and carry no row semantics.
    uint16 public constant PARAM_CARD = 54;

    /// @notice A bitmask over rows: which rows the granted waiver actually
    ///         covers, and therefore which rows `Regime` may narrow.
    /// @dev **Meeting the regime into every row was the first version and it was
    ///      wrong.** A waiver is granted over named rows. MiFIR's reference-price
    ///      waiver covers pre-trade transparency for order size and price; it says
    ///      nothing about instrument reference data. Under a blanket meet, a
    ///      supervisor narrowing the venue's disclosure policy would also stop it
    ///      publishing a maturity date, and the venue could not open a repo. A
    ///      suspension that halts the venue is not the suspension the regulation
    ///      describes.
    bytes32 public constant KEY_WAIVED_ROWS = keccak256("hedera2026.param.waivedRows.v1");

    bytes32 public constant DOMAIN_LEAF = keccak256("hedera2026.param.leaf.v1");
    bytes32 public constant DOMAIN_NODE = keccak256("hedera2026.param.node.v1");

    /// @notice The regime that bounds every row. A row ceiling is only ever the
    ///         meet of the published parameter and the live disclosure policy, so
    ///         a supervisor narrowing under Article 5 reaches every row of every
    ///         venue contract without any of them trusting the operator.
    Regime public immutable regime;
    IEpochClock public immutable clock;

    RootWindow.Window private window;

    /// @notice `DEPTH_ONE_BEHIND`. See `RootWindow` and a design decision's table.
    uint8 public constant DEPTH = RootWindow.DEPTH_ONE_BEHIND;
    uint64 public constant GRACE = RootWindow.GRACE;

    mapping(bytes32 => uint256) public valueOf;
    bytes32[] private keys;

    bytes32 public pendingRoot;
    uint64 public pendingEpoch;

    event Proposed(bytes32 indexed root, uint64 effectiveEpoch, bytes32 rationale);
    event Adopted(bytes32 indexed root, uint64 epoch, uint256 count);
    event ParameterSet(bytes32 indexed key, uint256 value);

    error NotOperator();
    error NothingPending();
    error NotYetEffective(uint64 want, uint64 have);
    error RootMismatch(bytes32 got, bytes32 want);
    error EmptySet();
    error KeysNotAscending(bytes32 previous, bytes32 next);
    error RowValueIsNotAnIdeal(uint16 row, uint256 value);

    /// @notice an invariant at the parameter set's end. A published set whose row
    ///         ceiling forbids what the same set's row floor requires is
    ///         **un-adoptable**, which is a design decision's word for it.
    error RowFloorAboveCeiling(uint16 row, uint32 ceiling_, uint32 floor_);

    /// @notice Rule B of `DisclosureMeter`. A budget published against a row
    ///         whose ceiling already admits an exact disclosure could never bind,
    ///         because `bits(row, G_EXACT)` is `domainBits` and
    ///         `requireWellFormed` demands `budgetBits < domainBits`. Publishing
    ///         one would certify a bound that does not hold, which is worse than
    ///         publishing none.
    error BudgetCannotBindRow(uint16 row, uint32 ceiling_);

    /// @notice A budget on a row with no published ceiling. An un-granted row
    ///         refuses every disclosure already, so a budget on it is a bound on
    ///         a channel that does not exist, and a reader of the root would take
    ///         it for a governed limit.
    error BudgetOnUnpublishedRow(uint16 row);

    constructor(Regime regime_) {
        regime = regime_;
        clock = regime_.clock();
    }

    // ------------------------------------------------------- the root

    function root() external view returns (bytes32) {
        return window.current;
    }

    function previousRoot() external view returns (bytes32) {
        return window.previous;
    }

    /// @notice The check a verifier contract runs on the proof's declared root.
    /// @dev This is the whole of D11d.2 and F5b's shared half, at one call site.
    function accepts(bytes32 r) external view returns (bool) {
        return window.accepts(r, DEPTH, GRACE);
    }

    /// @notice When the superseded root stops being accepted. Zero if none.
    function windowClosesAt() external view returns (uint64) {
        return window.closesAt(DEPTH, GRACE);
    }

    /// @notice The root of a parameter set. Public and pure so the client, the
    ///         circuit's tree builder and this contract cannot disagree.
    /// @dev Keys must be strictly ascending, which fixes the leaf order (a tree
    ///      whose root depends on submission order is not a commitment to a set)
    ///      and rejects a duplicate key in the same comparison. Odd levels
    ///      promote the last node rather than duplicating it: duplication is the
    ///      classic source of a second valid tree for one leaf multiset.
    function rootOf(Param[] calldata set) public pure returns (bytes32) {
        uint256 n = set.length;
        if (n == 0) revert EmptySet();

        bytes32[] memory level = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) {
            if (i > 0 && set[i].key <= set[i - 1].key) {
                revert KeysNotAscending(set[i - 1].key, set[i].key);
            }
            level[i] = keccak256(abi.encode(DOMAIN_LEAF, set[i].key, set[i].value));
        }

        while (n > 1) {
            uint256 out = 0;
            for (uint256 i = 0; i + 1 < n; i += 2) {
                level[out++] = keccak256(abi.encode(DOMAIN_NODE, level[i], level[i + 1]));
            }
            if (n & 1 == 1) level[out++] = level[n - 1];
            n = out;
        }
        return level[0];
    }

    // -------------------------------------------------------- governance

    /// @notice Commit to the next parameter set. Lands at the next epoch.
    /// @dev The operator, because this is a configuration choice inside a granted
    ///      waiver and `Regime` already decides who that is. Nothing here can
    ///      raise a ceiling above the regime: `ceilingFor` meets against
    ///      `regime.current()` on every read, so a parameter set published while
    ///      the venue is suspended simply does not take effect until it is not.
    function propose(bytes32 nextRoot, bytes32 rationale) external {
        if (msg.sender != regime.operator()) revert NotOperator();
        pendingRoot = nextRoot;
        pendingEpoch = clock.currentEpoch() + 1;
        emit Proposed(nextRoot, pendingEpoch, rationale);
    }

    /// @notice Open the committed set once its epoch has arrived. Permissionless.
    /// @dev Permissionless following `ZkKycRegistry.adoptGate` and `Regime.adopt`:
    ///      if only the operator could open its own commitment, the timing of
    ///      adoption would be a second discretionary signal and the epoch rule
    ///      would buy nothing.
    ///
    ///      Anyone can call this, but only someone holding the set can, which is
    ///      the property that makes the commitment a commitment. The operator
    ///      publishes the set off chain at proposal time; a set nobody holds is a
    ///      set that never lands.
    function adopt(Param[] calldata set) external {
        if (pendingEpoch == 0) revert NothingPending();
        uint64 e = clock.currentEpoch();
        if (e < pendingEpoch) revert NotYetEffective(pendingEpoch, e);

        bytes32 computed = rootOf(set);
        if (computed != pendingRoot) revert RootMismatch(computed, pendingRoot);

        // Clear the old set first. A key dropped from the new set must stop
        // answering, or a row could be silently un-governed by omission and the
        // fail-closed default would never be reached.
        uint256 old = keys.length;
        for (uint256 i = 0; i < old; ++i) {
            delete valueOf[keys[i]];
        }
        delete keys;

        for (uint256 i = 0; i < set.length; ++i) {
            bytes32 k = set[i].key;
            uint256 v = set[i].value;
            uint256 ki = uint256(k);
            if (ki < KEY_CARD) {
                // A row parameter that is not an order ideal claims an observer
                // may know an exact value but not the bucket containing it.
                // True of a floor for the same reason it is true of a ceiling:
                // an obligation to publish an exact value is an obligation to
                // publish the bucket around it.
                // forge-lint: disable-next-line(unsafe-typecast)
                if (v > L.TOP || !L.isIdeal(uint32(v))) {
                    // Safe: `ki < KEY_CARD` is `2 * ROW_CARD`, so the residue
                    // is below eighteen and names the row for either key.
                    // forge-lint: disable-next-line(unsafe-typecast)
                    revert RowValueIsNotAnIdeal(uint16(ki % ROW_CARD), v);
                }
            }
            if (ki >= ROW_CARD && ki < KEY_CARD) {
                // Keys ascend, so this row's ceiling is already written. The
                // check is static: it holds against the published set and does
                // not read the live regime, because `adopt` is permissionless
                // and a check against a moving supervisory state would let a
                // suspension wedge the operator's committed root out of
                // governance for the length of the suspension. The regime's own
                // half of an invariant is held in `Regime` and read back in
                // `_effective` below.
                // Safe: the branch is `ROW_CARD <= ki < KEY_CARD`, so the
                // difference is in `[0, ROW_CARD)`.
                // forge-lint: disable-next-line(unsafe-typecast)
                uint16 row = uint16(ki - ROW_CARD);
                // forge-lint: disable-next-line(unsafe-typecast)
                uint32 f = uint32(v);
                uint32 c = uint32(valueOf[bytes32(uint256(row))]);
                if (!L.permits(c, f)) revert RowFloorAboveCeiling(row, c, f);
            }
            if (ki >= BUDGET_BASE && ki < PARAM_CARD) {
                // Same single pass and the same reason: keys ascend, so this
                // row's ceiling is already written and the budget can be checked
                // against it without a second traversal. Rule B of
                // `DisclosureMeter`, enforced here rather than at the meter,
                // because a bound that cannot bind should be un-adoptable rather
                // than silently inert at every call site that reads it.
                // Safe: the branch is `BUDGET_BASE <= ki < PARAM_CARD`, so the
                // difference is in `[0, ROW_CARD)`.
                // forge-lint: disable-next-line(unsafe-typecast)
                uint16 row = uint16(ki - BUDGET_BASE);
                B.requireWellFormed(unpackBudget(v));
                // forge-lint: disable-next-line(unsafe-typecast)
                uint32 c = uint32(valueOf[bytes32(uint256(row))]);
                if (c == L.BOTTOM) revert BudgetOnUnpublishedRow(row);
                if (DisclosureMeter.ceilingAdmitsExact(c)) {
                    revert BudgetCannotBindRow(row, c);
                }
            }
            valueOf[k] = v;
            keys.push(k);
            emit ParameterSet(k, v);
        }

        window.advance(computed);
        pendingRoot = bytes32(0);
        pendingEpoch = 0;
        emit Adopted(computed, e, set.length);
    }

    // ------------------------------------------------- IDisclosurePolicy

    /// @notice The ceiling in force for one matrix row.
    /// @dev Two bounds, met. The published parameter is what the venue was
    ///      configured to do; `regime.current()` is what it is currently allowed
    ///      to do. Meeting them means a narrowing propagates to every row without
    ///      a parameter republication, which is what makes a suspension
    ///      immediate rather than an epoch away.
    ///
    ///      An unpublished row returns `BOTTOM` and every disclosure on it
    ///      reverts. That is deliberate and it is the direction a design decision chose for
    ///      seam D: a venue whose parameters have not been published is a venue
    ///      that has not been granted anything.
    function ceilingFor(uint16 row) external view returns (uint32) {
        (uint32 c,) = _effective(row);
        return c;
    }

    /// @notice The obligation in force for one matrix row: what the venue must
    ///         publish, as against what it may.
    /// @dev **A floor is not checked per event and nothing here offers to.** An
    ///      event discloses at one cell; an obligation runs over a row and a
    ///      window, and a predicate emitted now can be legitimately followed by
    ///      the exact publication later, so `permits(floorFor(row), actual)` is
    ///      not a question with a meaningful answer at emission time. This is a
    ///      view for a regulator and for the tests, and the enforcement it
    ///      belongs to is an invariant: the floor bounds the ceiling, held in
    ///      `_effective` and in `Regime._reconcile`.
    function floorFor(uint16 row) external view returns (uint32) {
        (, uint32 f) = _effective(row);
        return f;
    }

    /// @dev Both bounds in one read, because the property that matters is the
    ///      relation between them and a caller that computed them separately
    ///      could see two different regime states.
    ///
    ///      **`floorFor(row) <= ceilingFor(row)` holds by construction here**,
    ///      for every row and every reachable regime state, given only the static
    ///      check `adopt` already ran. Three cases. An unpublished row is
    ///      `(BOTTOM, BOTTOM)`. An unwaived row is the published pair, which
    ///      `adopt` ordered. A waived row meets both against the same
    ///      `regime.current()`, which preserves the order, then joins both with
    ///      the same `regime.floor()`, which preserves it again.
    ///
    ///      The join is the half a design decision is about and it is worth saying plainly:
    ///      **a supervisory obligation lifts a row ceiling the operator
    ///      published.** That is not a leak. `Regime` holds `floor <= current`,
    ///      so the lift never carries the row above what the regime permits, and
    ///      an operator cannot use it as a lever because it is the *regime's*
    ///      floor that is joined in and not the row's. A parameter set that
    ///      forbids what the supervisor compels does not get to forbid it.
    function _effective(uint16 row) private view returns (uint32 c, uint32 f) {
        uint256 v = valueOf[bytes32(uint256(row))];
        // An unpublished row is un-granted and un-obliged, in that order. Seam
        // D's direction from a design decision, and it has to apply to both bounds or the
        // regime's floor would attach itself to a row nobody published.
        if (v == 0) return (L.BOTTOM, L.BOTTOM);

        // Safe: `adopt` rejects a row value that is not an ideal, and every ideal
        // is at most `L.TOP`, which is thirty bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        c = uint32(v);
        // forge-lint: disable-next-line(unsafe-typecast)
        f = uint32(valueOf[bytes32(uint256(row) + ROW_CARD)]);
        if (!isWaived(row)) return (c, f);

        uint32 cur = regime.current();
        uint32 obliged = regime.floor();
        return (L.join(L.meet(c, cur), obliged), L.join(L.meet(f, cur), obliged));
    }

    /// @notice Whether the granted waiver covers this row.
    function isWaived(uint16 row) public view returns (bool) {
        if (row >= ROW_CARD) return false;
        return valueOf[KEY_WAIVED_ROWS] & (uint256(1) << row) != 0;
    }

    /// @notice The coalition budget in force for one row.
    /// @dev Returned unnarrowed by the regime, and the reason is that a
    ///      narrowing cannot leave this bound stale. `ceilingAdmitsExact` is the
    ///      test for whether a row is metered, and `adopt` refuses a budget on a
    ///      row that passes it. A supervisor narrowing a row **below** exact does
    ///      not create an unmetered leak, because the ceiling check at the
    ///      emission site already refuses the exact disclosure the row was
    ///      publishing. What remains is a governance omission rather than a
    ///      mechanism gap: a narrowed row on which a sub-exact disclosure is
    ///      permitted and for which no budget was ever published is unmetered.
    ///      That is visible in the root, and it is recorded as owed rather than
    ///      defended.
    function budgetFor(uint16 row) external view returns (B.Row memory) {
        if (row >= ROW_CARD) return B.Row(0, 0, 0, 0);
        return unpackBudget(valueOf[bytes32(uint256(row) + BUDGET_BASE)]);
    }

    /// @notice The epoch a disclosure is charged to.
    /// @dev The disclosing contracts hold `policy` and nothing else, so the clock
    ///      reaches them through here. One clock, so `OrderBook`, `RepoVault` and
    ///      the parameter set cannot disagree about which epoch a charge landed
    ///      in, which is the argument `commitmentOf` and `rootOf` both make about
    ///      a preimage.
    function currentEpoch() external view returns (uint64) {
        return clock.currentEpoch();
    }

    /// @notice The four budget numbers packed into one parameter value.
    /// @dev Public and pure for the reason `rootOf` is: the client that builds
    ///      the set, the tree, and this contract must not be able to disagree
    ///      about a leaf. Four `uint16` in the low sixty four bits, ascending in
    ///      the order `DisclosureBudget.Row` declares them.
    function packBudget(B.Row memory r) public pure returns (uint256) {
        return uint256(r.domainBits) | (uint256(r.aggBits) << 16)
            | (uint256(r.bucketBits) << 32) | (uint256(r.budgetBits) << 48);
    }

    /// @notice The inverse of `packBudget`. A zero value unpacks to a zero row,
    ///         which is the unmetered marker `DisclosureMeter` reads.
    function unpackBudget(uint256 v) public pure returns (B.Row memory) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return B.Row(uint16(v), uint16(v >> 16), uint16(v >> 32), uint16(v >> 48));
    }

    function keyOfRowBudget(uint16 row) external pure returns (bytes32) {
        return bytes32(uint256(row) + BUDGET_BASE);
    }

    function keyOfRow(uint16 row) external pure returns (bytes32) {
        return bytes32(uint256(row));
    }

    function keyOfRowFloor(uint16 row) external pure returns (bytes32) {
        return bytes32(uint256(row) + ROW_CARD);
    }

    function keyCount() external view returns (uint256) {
        return keys.length;
    }

    function keyAt(uint256 i) external view returns (bytes32) {
        return keys[i];
    }
}
