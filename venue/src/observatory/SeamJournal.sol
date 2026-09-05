// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {ICompliance} from "../interfaces/ICompliance.sol";
import {ISeamJournal} from "../interfaces/ISeamJournal.sol";
import {IKyc} from "../interfaces/IKyc.sol";
import {IExternalKycList} from "../interfaces/IExternalKycList.sol";
import {DisclosureLattice as L} from "../lattice/DisclosureLattice.sol";
import {DisclosureBudget as B} from "../lattice/DisclosureBudget.sol";

/// @title SeamJournal
/// @notice Seam C and seam C-prime: the check ATS staticcalls before a transfer,
///         and the notification it calls after the balance has moved.
///
/// `SeamMap` measures what seam D, the eligibility gate, sees: 16 of 393 entry
/// points. Three of the gaps matter for a repo venue.
///
/// - **Controller rail.** `controllerTransferByPartition` and `forcedTransfer`
///   move a balance without `onlyCanTransferFromByPartition`, the modifier that
///   carries the ordinary rail into seams B, C, D and E.
/// - **Maturity rail.** `redeemAtMaturityByPartition` reaches A, B, D and
///   C-prime but not C, so size is invisible where a bond pays out.
/// - **Hold creation.** `createHoldByPartition` reaches A alone. Only execution
///   is gated.
///
/// None of the three can be re-gated: ATS does not call us before those writes.
/// This contract notices instead. An arrival at an address holding no live grant
/// did not pass seam D, because seam D denies by default, so `UnverifiedArrival`
/// records the bypass without case analysis over rails, including rails a later
/// ATS version adds.
///
/// Invariants. `canTransfer` never reverts: ATS re-reverts anything but 32 bytes
/// of bool, so a revert bricks the token rather than failing open. The write side
/// reverts only on a forged caller, never on policy, because it runs after the
/// balance has moved. A disclosure the ceiling or the budget will not carry is
/// withheld rather than reverted.
contract SeamJournal is ICompliance, ISeamJournal {
    // -------------------------------------------------------------- wiring

    /// @notice The ATS token, and the only address the write side accepts.
    address public immutable token;

    /// @notice Seam D, read here so the bypass inference above can be made.
    IExternalKycList public immutable registry;

    address public immutable admin;
    uint64 public immutable epochZero;
    uint64 public immutable epochLength;

    /// @notice The ceiling this journal's disclosures stay under, as an ideal of
    ///         `G x T^op`. Validated to be one at deploy.
    uint32 public immutable ceiling;

    /// @notice The coalition budget, per epoch. Taken at deploy rather than read
    ///         from `ParameterRoot`, because an `ICompliance` must never revert
    ///         and a governed read is a new revert path into a token's transfer.
    B.Row public row;

    // ------------------------------------------------------------- storage

    mapping(uint64 => EpochRecord) private _epoch;

    /// @notice Bits already spent against `row.budgetBits` in an epoch.
    mapping(uint64 => uint32) private _spent;

    /// @dev `_magnitude` is base ten over a value clamped to `uint128`, so at
    ///      most thirty nine decades. Six bits carry sixty four, which covers it.
    uint16 internal constant MIN_BUCKET_BITS = 6;

    // --------------------------------------------------------- constructor

    constructor(
        address admin_,
        address token_,
        address registry_,
        uint64 epochZero_,
        uint64 epochLength_,
        uint32 ceiling_,
        B.Row memory row_
    ) {
        if (epochLength_ == 0) revert ZeroEpochLength();
        L.requireIdeal(ceiling_);
        B.requireWellFormed(row_);
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

    // --------------------------------------------------- seam C, read side

    /// @inheritdoc ICompliance
    /// @dev No revert path. Three shapes arrive here and they are not the same
    ///      question, so the declared parameters cannot be taken at face value.
    ///
    ///      1. `(sender, 0, 0)` from `_validateSenderCompliance`, which asks only
    ///         whether the operator is barred. A size test on it would be a size
    ///         test on the constant zero.
    ///      2. `(from, to, value)` from `_validateTransferCompliance`. The real
    ///         one, and the only place in the protocol where a policy sees size.
    ///      3. `(0, to, 0)` on the hold execution rail. The held amount is not
    ///         passed, so a size policy is blind here and must not pretend
    ///         otherwise by reading the zero as small.
    function canTransfer(address _from, address _to, uint256 _amount)
        external
        view
        returns (bool)
    {
        (bool ok,) = _judge(_from, _to, _amount);
        return ok;
    }

    /// @inheritdoc ISeamJournal
    function explain(address _from, address _to, uint256 _amount)
        external
        view
        returns (bool ok, Reason reason)
    {
        return _judge(_from, _to, _amount);
    }

    function _judge(address from, address to, uint256 amount)
        internal
        view
        returns (bool, Reason)
    {
        // Shape 1: the operator probe.
        if (to == address(0) && amount == 0) {
            if (from == address(0)) return (true, Reason.OK);
            return _granted(from)
                ? (true, Reason.OK)
                : (false, Reason.SENDER_NOT_GRANTED);
        }
        // Shape 3: the hold execution probe. Judge the recipient and say nothing
        // about size, because nothing about size was asked.
        if (from == address(0)) {
            return _granted(to)
                ? (true, Reason.OK)
                : (false, Reason.RECIPIENT_NOT_GRANTED);
        }
        // Shape 2: the real transfer.
        if (!_granted(to)) return (false, Reason.RECIPIENT_NOT_GRANTED);
        if (!_granted(from)) return (false, Reason.SENDER_NOT_GRANTED);
        return (true, Reason.OK);
    }

    /// @dev A staticcall into seam D, defended so the no-revert invariant survives
    ///      a registry that reverts or answers in the wrong shape. `try` alone is
    ///      not enough: a registry returning 64 bytes would decode and be believed.
    function _granted(address account) internal view returns (bool) {
        (bool ok, bytes memory out) = address(registry).staticcall(
            abi.encodeWithSelector(IExternalKycList.getKycStatus.selector, account)
        );
        if (!ok || out.length != 32) return false;
        return abi.decode(out, (uint256)) == uint256(IKyc.KycStatus.GRANTED);
    }

    // ------------------------------------------------- seam C', write side

    /// @inheritdoc ICompliance
    function transferred(address _from, address _to, uint256 _amount) external {
        if (msg.sender != token) revert NotToken();
        uint64 e = _epochAt(block.timestamp);
        EpochRecord storage r = _epoch[e];
        r.transfers += 1;
        r.grossIn += _clamp(_amount);
        r.grossOut += _clamp(_amount);
        _flagIfUnverified(r, _to, _amount, e);
        _from; // the sender side is covered by the epoch aggregate
    }

    /// @inheritdoc ICompliance
    function created(address _to, uint256 _amount) external {
        if (msg.sender != token) revert NotToken();
        uint64 e = _epochAt(block.timestamp);
        EpochRecord storage r = _epoch[e];
        r.issues += 1;
        r.grossIn += _clamp(_amount);
        _flagIfUnverified(r, _to, _amount, e);
    }

    /// @inheritdoc ICompliance
    /// @dev Redemption has no recipient, so there is no arrival to check.
    function destroyed(address _from, uint256 _amount) external {
        if (msg.sender != token) revert NotToken();
        uint64 e = _epochAt(block.timestamp);
        EpochRecord storage r = _epoch[e];
        r.redemptions += 1;
        r.grossOut += _clamp(_amount);
        _from;
    }

    /// @dev The inference. One direction, and it does not name a rail.
    function _flagIfUnverified(
        EpochRecord storage r,
        address to,
        uint256 amount,
        uint64 e
    ) internal {
        if (_granted(to)) return;
        r.unverifiedArrivals += 1;
        _discloseArrival(to, amount, e);
    }

    // ------------------------------------------------------ the disclosure

    /// @dev The magnitude costs `row.bucketBits`, the bare fact one bit. Both are
    ///      checked against the ceiling and the epoch's remaining budget, and the
    ///      stronger is dropped rather than the transaction failed: a compliant
    ///      transfer must not revert because the venue has run out of things it
    ///      may say. If neither is affordable nothing goes out, and the arrival
    ///      is still counted in the epoch record, which is not a public channel.
    function _discloseArrival(address to, uint256 amount, uint64 e) internal {
        uint32 spent = _spent[e];
        uint32 bucketCost = B.bits(row, B.G_BUCKET);
        uint32 predCost = B.bits(row, B.G_PRED);

        if (
            L.permits(ceiling, L.point(L.G_BUCKET, L.T_IMM))
                && spent + bucketCost <= row.budgetBits
        ) {
            _spent[e] = spent + bucketCost;
            emit UnverifiedArrival(to, _magnitude(_clamp(amount)), e);
        } else if (
            L.permits(ceiling, L.point(L.G_PRED, L.T_IMM))
                && spent + predCost <= row.budgetBits
        ) {
            _spent[e] = spent + predCost;
            emit UnverifiedArrivalWithheld(to, e);
        }
    }

    /// @inheritdoc ISeamJournal
    /// @dev Spends from the same budget as the arrivals. It has to: a coalition
    ///      reading both learns the sum of what each carries, and a budget that
    ///      bound only one of them would describe a different observer from the
    ///      one that exists.
    function disclose(uint64 e) external {
        if (e >= _epochAt(block.timestamp)) return; // not closed yet
        EpochRecord storage r = _epoch[e];
        uint32 spent = _spent[e];
        uint32 aggCost = B.bits(row, B.G_AGG);
        uint32 bucketCost = B.bits(row, B.G_BUCKET);

        if (
            L.permits(ceiling, L.point(L.G_AGG, L.T_EPOCH))
                && spent + aggCost <= row.budgetBits
        ) {
            _spent[e] = spent + aggCost;
            emit EpochDisclosed(e, B.G_AGG, uint256(r.grossIn));
        } else if (
            L.permits(ceiling, L.point(L.G_BUCKET, L.T_EPOCH))
                && spent + bucketCost <= row.budgetBits
        ) {
            _spent[e] = spent + bucketCost;
            emit EpochDisclosed(e, B.G_BUCKET, _magnitude(r.grossIn));
        }
    }

    /// @dev Order of magnitude, base ten. A bucket has to be a stated function of
    ///      the value or `bucketBits` charges for a disclosure nobody defined.
    function _magnitude(uint128 v) internal pure returns (uint8 m) {
        while (v >= 10) {
            v /= 10;
            m += 1;
        }
    }

    // --------------------------------------------------------------- reads

    /// @inheritdoc ISeamJournal
    function epochRecord(uint64 e) external view returns (EpochRecord memory) {
        return _epoch[e];
    }

    /// @inheritdoc ISeamJournal
    function spentBits(uint64 e) external view returns (uint32) {
        return _spent[e];
    }

    /// @inheritdoc ISeamJournal
    function currentEpoch() external view returns (uint64) {
        return _epochAt(block.timestamp);
    }

    function _epochAt(uint256 ts) internal view returns (uint64) {
        if (ts < epochZero) return 0;
        return uint64((ts - epochZero) / epochLength);
    }

    /// @dev The aggregates are `uint128` and the notification is `uint256`.
    ///      Saturating is the point: a wrapped audit total reads as a small one,
    ///      which is the failure mode that matters.
    function _clamp(uint256 v) internal pure returns (uint128) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return v > type(uint128).max ? type(uint128).max : uint128(v);
    }
}
