// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {ICompliance} from "../interfaces/ICompliance.sol";
import {IKyc} from "../interfaces/IKyc.sol";
import {IExternalKycList} from "../interfaces/IExternalKycList.sol";
import {DisclosureLattice} from "../lattice/DisclosureLattice.sol";
import {DisclosureBudget} from "../lattice/DisclosureBudget.sol";

/// @title SeamJournal
/// @notice Seam C and seam C-prime. The second observer, and the reason the
///         callstack census was worth running.
///
/// ## Why this contract exists
///
/// Until the census, the venue implemented exactly one seam: `ZkKycRegistry` at
/// seam D, on the theory that seam D is the eligibility gate and eligibility is
/// the thing we prove in zero knowledge. `docs/CALLSTACK.md` measured what seam D
/// actually sees across all 393 entry points of the ATS lifecycle surface, and
/// the answer is: sixteen of them. Not the other three hundred and seventy seven.
///
/// Three of the gaps are load bearing for a repo venue.
///
/// **The controller rail.** `ControllerByPartition.controllerTransferByPartition`
/// and `Controller.forcedTransfer` move a holder's balance to any address, and
/// their modifier list is `onlyOperational onlyActivated onlyUnpaused
/// onlyDefaultPartitionWithSinglePartition onlyControllable onlyAnyRole`. There
/// is no `onlyCanTransferFromByPartition`, which is the modifier the ordinary
/// `transferByPartition` carries and the only thing that reaches seams B, C, D
/// and E. Both then call the same `TokenCoreOps.transferByPartition`. So a
/// `ROLE_CONTROLLER` moves collateral to an address that has never proved
/// anything, and seam D is never asked. Measured, not inferred: `SeamMap`
/// records `C|CW|A` for those entry points and `A|B|C|CW|D|E` for the ordinary
/// transfer, and `test_theControllerRailSkipsTheEligibilityGate` pins it.
///
/// **The maturity rail.** `MaturityByPartition.redeemAtMaturityByPartition`
/// reaches A, B, D and C-prime, but **not C**. Redemption at maturity consults
/// the eligibility gate and the control list, and never consults the one seam
/// that receives the amount. A size-dependent policy is blind exactly where a
/// bond pays out.
///
/// **Hold creation.** `createHoldByPartition` reaches seam A and nothing else,
/// which corroborates `mesh/transfer-path.md` F-05 from a second instrument. A
/// hold can be created toward an address no gate has approved. Only its
/// execution is checked.
///
/// ## What this contract does about it
///
/// It cannot re-gate the controller rail: ATS does not call us there before the
/// write. What it can do is **notice**, and noticing is sound without knowing
/// which rail fired.
///
/// > If a `transferred(from, to, value)` notification arrives and `to` holds no
/// > live grant in the registry, then the transfer did not pass seam D. Seam D
/// > denies by default (an invariant), so any path that consulted it would have
/// > reverted before reaching the balance write and therefore before reaching
/// > this notification.
///
/// One implication, one direction, no case analysis over rails. That is
/// `UnverifiedArrival`, and it is the audit record for every bypass at once,
/// including bypasses added by a future ATS version this census has not seen.
///
/// ## Invariants
///
/// **an invariant', `canTransfer` never reverts.** Same reasoning as the registry, one
/// notch worse: ATS reverts the transfer when the returndata is not exactly 32
/// bytes decoding to 0 or 1 (`ERC1594StorageWrapper._validateTransferCompliance`),
/// so a revert here does not fail open, it bricks the token.
///
/// **an invariant, the write side never reverts either.** The six C-prime call sites
/// are `LowLevelCall.functionCall` **after** the balance has already moved. A
/// revert here unwinds a completed, compliant transfer. The journal records and
/// returns; it never judges after the fact.
///
/// **an invariant, the journal publishes no cell the lattice forbids.** Every
/// disclosure this contract makes is checked against the configured ceiling
/// before it is emitted, and the granular event is withheld rather than the
/// transaction reverted, because withholding is the failure mode that keeps the
/// token working.
contract SeamJournal is ICompliance {
    using DisclosureBudget for DisclosureBudget.Row;

    // ------------------------------------------------------------- wiring

    /// @notice The ATS token this journal serves. The only address the write
    ///         side accepts, because C-prime is a full CALL and anyone could
    ///         otherwise forge a notification and poison the audit record.
    address public immutable token;

    /// @notice Seam D, read here so the bypass inference above can be made.
    IExternalKycList public immutable registry;

    uint64 public immutable epochZero;
    uint64 public immutable epochLength;

    address public immutable admin;

    // ------------------------------------------------- disclosure policy

    /// @notice The ceiling this journal's own disclosures must stay under, as an
    ///         ideal of `G x T^op`. Set once at deploy, and validated to be an
    ///         ideal, so a policy that claims an exact value may be published
    ///         but not the bucket containing it cannot be stored.
    uint32 public immutable ceiling;

    /// @notice The four numbers `docs/OUTLINE.md` section 5.2 records as missing
    ///         from the seventeen row matrix. This contract is the first caller
    ///         that cannot proceed without them, which is the point: a budget
    ///         nobody has to supply is a budget nobody computes.
    DisclosureBudget.Row public row;

    // ------------------------------------------------------------ storage

    struct EpochRecord {
        uint128 grossIn;
        uint128 grossOut;
        uint64 transfers;
        uint64 issues;
        uint64 redemptions;
        uint64 unverifiedArrivals;
    }

    mapping(uint64 => EpochRecord) private _epoch;

    /// @notice Bits already spent against `row.budgetBits` in an epoch.
    mapping(uint64 => uint32) private _spent;

    // ------------------------------------------------------------- events

    /// @notice A transfer arrived at an address holding no live seam D grant.
    /// @dev The bypass record, at bucket granularity: `bucket` is the order of
    ///      magnitude, never the figure.
    ///
    ///      The exact figure is deliberately unreachable from any public event
    ///      in this contract, and that is a theorem rather than a taste.
    ///      `DisclosureBudget.requireWellFormed` demands `budgetBits <
    ///      domainBits`, and `bits(row, G_EXACT)` **is** `domainBits`. So a
    ///      single exact disclosure exceeds any well formed budget on its own,
    ///      always, and an event carrying one could never fire. Writing it
    ///      anyway would be dead code that reads like a capability.
    ///      `test_aWellFormedBudgetCanNeverAffordAnExactDisclosure` pins it.
    ///
    ///      Which is the design the frame asks for anyway: prove to the public,
    ///      disclose to the supervisor. The exact figure lives in the epoch
    ///      aggregate, read through `epochRecord`, and never in a log topic.
    event UnverifiedArrival(address indexed to, uint256 bucket, uint64 indexed epoch);
    /// @notice The same event with the magnitude withheld too, when the ceiling
    ///         permits only a predicate. The fact still gets out.
    event UnverifiedArrivalWithheld(address indexed to, uint64 indexed epoch);

    /// @notice The epoch's activity, at whatever granularity the ceiling permits.
    event EpochDisclosed(uint64 indexed epoch, uint8 granularity, uint256 figure);

    /// @notice A `canTransfer` that returned false, and the reason, so a denial
    ///         is debuggable without replaying the ATS call.
    event Denied(address indexed from, address indexed to, uint8 reason);

    // ------------------------------------------------------------- errors

    error NotToken();
    error NotAdmin();
    error ZeroEpochLength();
    error BucketBitsTooSmall(uint16 given, uint16 required);

    /// @dev `_bucket` is base ten over a value clamped to `uint128`, which is at
    ///      most thirty nine decades. Six bits carry sixty four, which covers it.
    uint16 internal constant MIN_BUCKET_BITS = 6;

    /// @dev Reasons carried by `Denied`, and returned nowhere else. `canTransfer`
    ///      is `view` and cannot emit, so the enum exists for `explain`, which a
    ///      client calls off the hot path to learn why a simulation failed.
    uint8 internal constant R_OK = 0;
    uint8 internal constant R_RECIPIENT_NOT_GRANTED = 1;
    uint8 internal constant R_SENDER_NOT_GRANTED = 2;
    uint8 internal constant R_OVER_EPOCH_BUDGET = 3;

    // --------------------------------------------------------- constructor

    constructor(
        address admin_,
        address token_,
        address registry_,
        uint64 epochZero_,
        uint64 epochLength_,
        uint32 ceiling_,
        DisclosureBudget.Row memory row_
    ) {
        if (epochLength_ == 0) revert ZeroEpochLength();
        DisclosureLattice.requireIdeal(ceiling_);
        DisclosureBudget.requireWellFormed(row_);
        if (row_.bucketBits < MIN_BUCKET_BITS) {
            revert BucketBitsTooSmall(row_.bucketBits, MIN_BUCKET_BITS);
        }
        admin = admin_;
        token = token_;
        registry = IExternalKycList(registry_);
        epochZero = epochZero_;
        epochLength = epochLength_;
        ceiling = ceiling_;
        row = row_;
    }

    // -------------------------------------------------- seam C, read side

    /// @inheritdoc ICompliance
    /// @dev an invariant'. No revert path. Read the class comment before touching it.
    ///
    /// Three shapes arrive here and they are not the same question.
    ///
    /// 1. `(sender, address(0), 0)` from `_validateSenderCompliance`. The
    ///    declared parameters are not the ones sent, which is `mesh` F-04. It
    ///    asks only whether the operator is barred, and a size test on it would
    ///    be a size test on the constant zero.
    /// 2. `(from, to, value)` from `_validateTransferCompliance`. The real one,
    ///    and the only place in the whole protocol where a policy can see how
    ///    much is moving.
    /// 3. `(address(0), to, 0)` on the hold execution rail, F-06. The held
    ///    amount is not passed, so a size policy is blind here too and must not
    ///    pretend otherwise by treating zero as small.
    function canTransfer(address _from, address _to, uint256 _amount)
        external
        view
        returns (bool)
    {
        (bool ok,) = _judge(_from, _to, _amount);
        return ok;
    }

    /// @notice The same decision with its reason. Not on the ATS path; a client
    ///         calls this to explain a failed simulation.
    function explain(address _from, address _to, uint256 _amount)
        external
        view
        returns (bool ok, uint8 reason)
    {
        return _judge(_from, _to, _amount);
    }

    function _judge(address from, address to, uint256 amount)
        internal
        view
        returns (bool, uint8)
    {
        // Shape 1: the operator probe. `to` is zero and so is the amount.
        if (to == address(0) && amount == 0) {
            if (from == address(0)) return (true, R_OK);
            return _granted(from) ? (true, R_OK) : (false, R_SENDER_NOT_GRANTED);
        }
        // Shape 3: the hold execution probe. `from` is zero, amount is withheld.
        // Judge the recipient and say nothing about size, because nothing about
        // size was asked.
        if (from == address(0)) {
            return _granted(to) ? (true, R_OK) : (false, R_RECIPIENT_NOT_GRANTED);
        }
        // Shape 2: the real transfer.
        if (!_granted(to)) return (false, R_RECIPIENT_NOT_GRANTED);
        if (!_granted(from)) return (false, R_SENDER_NOT_GRANTED);
        return (true, R_OK);
    }

    /// @dev A staticcall into seam D, defended so an invariant' survives a registry
    ///      that reverts or answers in the wrong shape. `try` alone is not
    ///      enough: a registry returning 64 bytes would decode and be believed.
    function _granted(address account) internal view returns (bool) {
        (bool ok, bytes memory out) = address(registry).staticcall(
            abi.encodeWithSelector(IExternalKycList.getKycStatus.selector, account)
        );
        if (!ok || out.length != 32) return false;
        return abi.decode(out, (uint256)) == uint256(IKyc.KycStatus.GRANTED);
    }

    // ------------------------------------------ seam C-prime, write side

    /// @inheritdoc ICompliance
    /// @dev an invariant. Records, never reverts on policy. The only revert is the
    ///      caller check, and that one must exist: a forged notification is a
    ///      forged audit record, and the audit record is the product.
    function transferred(address _from, address _to, uint256 _amount) external {
        if (msg.sender != token) revert NotToken();
        uint64 e = _epochAt(block.timestamp);
        EpochRecord storage r = _epoch[e];
        r.transfers += 1;
        r.grossIn += _clamp(_amount);
        r.grossOut += _clamp(_amount);

        // The inference. One direction, and it does not name a rail.
        if (!_granted(_to)) {
            r.unverifiedArrivals += 1;
            _discloseArrival(_to, _amount, e);
        }
        _from; // the sender side is covered by the epoch aggregate
    }

    /// @inheritdoc ICompliance
    function created(address _to, uint256 _amount) external {
        if (msg.sender != token) revert NotToken();
        uint64 e = _epochAt(block.timestamp);
        EpochRecord storage r = _epoch[e];
        r.issues += 1;
        r.grossIn += _clamp(_amount);
        if (!_granted(_to)) {
            r.unverifiedArrivals += 1;
            _discloseArrival(_to, _amount, e);
        }
    }

    /// @inheritdoc ICompliance
    /// @dev Redemption has no recipient, so there is no arrival to check. This
    ///      is the maturity rail, and the census says it reaches seam D but not
    ///      seam C: the eligibility gate ran, the size gate did not.
    function destroyed(address _from, uint256 _amount) external {
        if (msg.sender != token) revert NotToken();
        uint64 e = _epochAt(block.timestamp);
        EpochRecord storage r = _epoch[e];
        r.redemptions += 1;
        r.grossOut += _clamp(_amount);
        _from;
    }

    // ----------------------------------------------------- the disclosure

    /// @dev an invariant. Publishing the magnitude is a disclosure at `(bucket, imm)`
    ///      costing `row.bucketBits`. Publishing only that an unverified arrival
    ///      happened is `(pred, imm)`, costing one bit. Both are checked against
    ///      the ceiling **and** the epoch's remaining budget, and the stronger
    ///      one is dropped rather than the transaction failed: a disclosure
    ///      policy is not a transfer policy, and a compliant transfer must not
    ///      revert because the venue has run out of things it may say.
    function _discloseArrival(address to, uint256 amount, uint64 e) internal {
        uint32 bucketNow =
            DisclosureLattice.point(DisclosureLattice.G_BUCKET, DisclosureLattice.T_IMM);
        uint32 predNow =
            DisclosureLattice.point(DisclosureLattice.G_PRED, DisclosureLattice.T_IMM);

        uint32 bucketCost = DisclosureBudget.bits(row, DisclosureBudget.G_BUCKET);
        uint32 predCost = DisclosureBudget.bits(row, DisclosureBudget.G_PRED);
        uint32 spent = _spent[e];

        if (
            DisclosureLattice.permits(ceiling, bucketNow)
                && spent + bucketCost <= row.budgetBits
        ) {
            _spent[e] = spent + bucketCost;
            emit UnverifiedArrival(to, _bucket(_clamp(amount)), e);
        } else if (
            DisclosureLattice.permits(ceiling, predNow) && spent + predCost <= row.budgetBits
        ) {
            _spent[e] = spent + predCost;
            emit UnverifiedArrivalWithheld(to, e);
        }
        // Neither permitted, or the budget is spent: nothing goes out. The
        // arrival is still counted in the epoch record, which is the supervisor
        // channel and not a public one.
    }

    /// @notice Publish the epoch's activity at the coarsest granularity the
    ///         ceiling allows. Permissionless, so the timing of disclosure is
    ///         not itself a discretionary signal.
    function disclose(uint64 e) external {
        if (e >= _epochAt(block.timestamp)) return; // not closed yet
        EpochRecord storage r = _epoch[e];
        uint32 aggEpoch =
            DisclosureLattice.point(DisclosureLattice.G_AGG, DisclosureLattice.T_EPOCH);
        uint32 bucketEpoch =
            DisclosureLattice.point(DisclosureLattice.G_BUCKET, DisclosureLattice.T_EPOCH);
        uint32 spent = _spent[e];
        uint32 aggCost = DisclosureBudget.bits(row, DisclosureBudget.G_AGG);
        uint32 bucketCost = DisclosureBudget.bits(row, DisclosureBudget.G_BUCKET);
        // The epoch disclosure spends from the same budget as the arrivals. It
        // has to: a coalition reading both learns the sum of what each carries,
        // and a budget that only bound one of them would be describing a
        // different observer from the one that exists.
        if (DisclosureLattice.permits(ceiling, aggEpoch) && spent + aggCost <= row.budgetBits) {
            _spent[e] = spent + aggCost;
            emit EpochDisclosed(e, DisclosureBudget.G_AGG, uint256(r.grossIn));
        } else if (
            DisclosureLattice.permits(ceiling, bucketEpoch)
                && spent + bucketCost <= row.budgetBits
        ) {
            _spent[e] = spent + bucketCost;
            emit EpochDisclosed(e, DisclosureBudget.G_BUCKET, _bucket(r.grossIn));
        }
    }

    /// @dev Order of magnitude, base ten. Thirty nine decades span a `uint128`,
    ///      so `row.bucketBits` must be at least six or the budget is charging
    ///      for a coarser disclosure than the one being made. Checked in the
    ///      constructor, because a budget that under-charges is worse than no
    ///      budget: it certifies a bound it does not hold.
    function _bucket(uint128 v) internal pure returns (uint256 b) {
        while (v >= 10) {
            v /= 10;
            b += 1;
        }
    }

    // -------------------------------------------------------------- reads

    function epochRecord(uint64 e) external view returns (EpochRecord memory) {
        return _epoch[e];
    }

    function spentBits(uint64 e) external view returns (uint32) {
        return _spent[e];
    }

    function currentEpoch() external view returns (uint64) {
        return _epochAt(block.timestamp);
    }

    function _epochAt(uint256 ts) internal view returns (uint64) {
        if (ts < epochZero) return 0;
        return uint64((ts - epochZero) / epochLength);
    }

    /// @dev The aggregates are `uint128` and the notification is `uint256`. A
    ///      token with a supply above 2^128 would wrap the accumulator, and a
    ///      wrapped audit total is worse than a saturated one.
    function _clamp(uint256 v) internal pure returns (uint128) {
        // The ternary is the check. Saturating is the point: a wrapped audit
        // total reads as a small one, which is the failure mode that matters.
        // forge-lint: disable-next-line(unsafe-typecast)
        return v > type(uint128).max ? type(uint128).max : uint128(v);
    }
}
