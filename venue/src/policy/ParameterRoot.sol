// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {DisclosureLattice as L} from "../lattice/DisclosureLattice.sol";
import {DisclosureBudget as B} from "../lattice/DisclosureBudget.sol";
import {DisclosureMeter} from "../lattice/DisclosureMeter.sol";
import {IDisclosurePolicy} from "../interfaces/IDisclosurePolicy.sol";
import {RootWindow} from "./RootWindow.sol";
import {Regime} from "./Regime.sol";
import {IEpochClock} from "../interfaces/IEpochClock.sol";

/// @title ParameterRoot
/// @notice Governed parameter set, committed as one keccak root.
/// @dev `propose` takes a root; `adopt` rebuilds it from the opened set.
///      On-chain tree is keccak (precompile); circuit paths are Poseidon.
///      Keys 0–17 ceilings, 18–35 floors, 36–53 budgets. `docs/MATH.md`.
contract ParameterRoot is IDisclosurePolicy {
    using RootWindow for RootWindow.Window;

    struct Param {
        bytes32 key;
        uint256 value;
    }

    /// @notice Rows 1–17 key themselves as `bytes32(row)`.
    uint16 public constant ROW_CARD = 18;

    /// @notice Floors are keyed `ROW_CARD + row` (18–35).
    uint16 public constant KEY_CARD = 36;

    /// @notice Budgets are keyed `KEY_CARD + row` (36–53).
    uint16 public constant BUDGET_BASE = KEY_CARD;

    /// @notice First keccak-keyed parameter. Integer keys below this carry row semantics.
    uint16 public constant PARAM_CARD = 54;

    /// @notice Bitmask of rows the waiver covers, hence rows `Regime` may narrow.
    /// @dev A blanket meet would let a size/price suspension also silence maturity.
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

    /// @notice `DEPTH_ONE_BEHIND`. See `RootWindow`.
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

    error RowFloorAboveCeiling(uint16 row, uint32 ceiling_, uint32 floor_);
    /// @dev Rule B: a budget on a row that already admits exact can never bind.
    error BudgetCannotBindRow(uint16 row, uint32 ceiling_);
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
                // Static vs the published set, not the live regime: `adopt` is
                // permissionless and must not be wedgeable by a suspension.
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

    /// @notice Ceiling for one row: meet of published param and live regime.
    ///         Unpublished → `BOTTOM` (fail closed).
    function ceilingFor(uint16 row) external view returns (uint32) {
        (uint32 c,) = _effective(row);
        return c;
    }

    /// @notice Floor for one row. Not a per-event check; it bounds the ceiling.
    function floorFor(uint16 row) external view returns (uint32) {
        (, uint32 f) = _effective(row);
        return f;
    }

    /// @dev Both bounds in one read so they cannot come from two regime states.
    ///      Unpublished → `(BOTTOM, BOTTOM)`. Waived rows meet then join against
    ///      the live regime, which preserves `floor ≤ ceiling` and can lift a
    ///      published ceiling to the supervisor's obligation.
    function _effective(uint16 row) private view returns (uint32 c, uint32 f) {
        uint256 v = valueOf[bytes32(uint256(row))];
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
