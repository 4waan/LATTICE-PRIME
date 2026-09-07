// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {ICouponSchedule} from "../interfaces/ICouponSchedule.sol";
import {CouponMath} from "./CouponMath.sol";
import {MerkleSet} from "../merkle/MerkleSet.sol";

/// @title CouponSchedule
/// @notice The bond's coupon calendar, fixed at issuance. `docs/RULEBOOK.md` §8.
/// @dev Row 7 of the disclosure matrix, at `(exact, imm)`: a coupon calendar is
///      a term of the bond and a bond whose coupon dates are private is not an
///      instrument anybody can price. Everything here is public and everything
///      here is immutable.
///
/// ## What this fixes
///
/// `RepoVault.noteCoupon(id, commitment)` took the commitment as an argument
/// from any caller, with no check that a coupon had fallen due at all. The
/// scorecard read that as "coupons only, and only as a commitment"; the sharper
/// reading is that the commitment was **asserted rather than derived**. Nothing
/// on chain connected it to a coupon date, to a rate, or to the bond. This
/// contract is the thing that was missing, and `noteCoupon(id, index)` is what
/// happens once it exists.
///
/// ## Fixed at issuance, and what that costs
///
/// There is no propose-and-adopt seat here, unlike `ParameterRoot`,
/// `PrimeOracle` and `ZkKycRegistry`. That is deliberate and it is the one place
/// this venue does not reach for its own governance idiom. A coupon calendar is
/// not a venue parameter; it is the issuer's promise, and an operator who could
/// move a coupon date could move the date a payment became due on a bond
/// somebody had already bought. The cost is stated: an instrument whose terms
/// genuinely change, whether by a restructuring or by a bondholder vote, is a
/// new `CouponSchedule` and a redeployment, not an amendment. That is the
/// correct shape for the rare case and the wrong shape for a frequent one, and
/// nothing about this bond makes it frequent.
///
/// ## Why nothing here is metered
///
/// Every disclosing contract in this venue routes its events through
/// `DisclosureView._emitUnder`. This one does not, for the reason `FreezeList`
/// states about a freeze: the mechanism does not apply.
///
/// A budget withholds an event so that a sequence of events does not add up to
/// somebody's position. Nothing here is a sequence. This contract emits exactly
/// once, in its constructor, and everything that event carries is also a public
/// getter on the same address the moment the transaction lands, so a meter over
/// it could only make the venue quieter about data an observer reads directly
/// out of storage. Routing the constructor through `_emitUnder` would also make a
/// narrowed row 7 a schedule that cannot be deployed, which is a venue with no
/// coupon calendar rather than a venue with a private one.
///
/// `test_theCalendarIsPublicWhateverTheMatrixSays` is that claim.
contract CouponSchedule is ICouponSchedule {
    // ------------------------------------------------------- the tree tags

    /// @dev This tree's identity. `MerkleSet` holds the rules and each tree
    ///      holds its own tags, so a parameter-set leaf and a calendar leaf can
    ///      never be each other's preimage.
    bytes32 public constant DOMAIN_LEAF = keccak256("hedera2026.coupon.schedule.leaf.v1");
    bytes32 public constant DOMAIN_NODE = keccak256("hedera2026.coupon.schedule.node.v1");

    /// @dev The scope on the leaf at position zero. See `_rootOf`.
    uint256 internal constant SCOPE_TERMS = type(uint256).max;

    // ---------------------------------------------------------- the bounds

    /// @notice The longest calendar this contract will publish.
    /// @dev A bound on the constructor's loop and on `_rootOf`'s, and the reason
    ///      is `Rulebook.MAX_CHARGES`'s: a schedule nobody can afford to
    ///      reconstruct is one nobody can check, so the bound is what keeps the
    ///      root reproducible off chain. Sixty-four is quarterly coupons on a
    ///      sixteen year bond, comfortably past the 2028 maturity this one has.
    uint256 public constant MAX_COUPONS = 64;

    // ----------------------------------------------------------- the terms

    /// @notice The dated date. Coupon zero accrues from here.
    uint64 public immutable issuedAt;

    /// @inheritdoc ICouponSchedule
    uint16 public immutable spreadBps;

    /// @inheritdoc ICouponSchedule
    uint128 public immutable faceValue;

    /// @inheritdoc ICouponSchedule
    CouponMath.Basis public immutable basis;

    /// @inheritdoc ICouponSchedule
    /// @dev The commitment to everything above and to every date below, in the
    ///      discipline `ParameterRoot` publishes its parameter set under. It
    ///      buys one thing and it is worth stating what: a client, `make
    ///      vectors` and this contract cannot disagree about what the calendar
    ///      is, because there is one 32-byte value all three compute and
    ///      compare. It buys no privacy at all, since every input is a public
    ///      getter a line above, and this venue does not claim otherwise.
    bytes32 public immutable root;

    uint64[] private _dates;

    // -------------------------------------------------------------- events

    /// @notice Row 7, at `(exact, imm)`, emitted once and never metered.
    /// @dev See the class comment for why this does not route through
    ///      `DisclosureView`.
    event ScheduleFixed(bytes32 indexed root, uint64 issuedAt, uint256 coupons);

    // -------------------------------------------------------------- errors

    error NoCoupons();
    error TooManyCoupons(uint256 got, uint256 max);
    error DatesNotAscending(uint64 previous, uint64 next);
    error FirstCouponBeforeIssue(uint64 issuedAt_, uint64 first);
    error NoSuchCoupon(uint256 index, uint256 count_);
    error ZeroFaceValue();

    // --------------------------------------------------------- construction

    constructor(
        uint64 issuedAt_,
        uint64[] memory dates_,
        uint16 spreadBps_,
        uint128 faceValue_,
        CouponMath.Basis basis_
    ) {
        uint256 n = dates_.length;
        if (n == 0) revert NoCoupons();
        if (n > MAX_COUPONS) revert TooManyCoupons(n, MAX_COUPONS);
        if (faceValue_ == 0) revert ZeroFaceValue();
        // Refused here rather than at the first accrual, so a schedule that
        // cannot pay a coupon cannot be deployed. See `CouponMath.Basis`.
        if (basis_ != CouponMath.Basis.ACT_365) revert CouponMath.UnsupportedBasis(basis_);
        // A rate the schedule could never accrue at is a schedule with a coupon
        // it can never pay, and finding that out at the first payment date is
        // finding it out too late.
        CouponMath.couponBps(0, spreadBps_);

        if (dates_[0] <= issuedAt_) revert FirstCouponBeforeIssue(issuedAt_, dates_[0]);
        for (uint256 i = 1; i < n; ++i) {
            // Strictly ascending, for `MerkleSet.ascends`'s reason one type over:
            // a calendar with two coupons on one date is a calendar whose
            // periods do not partition the term, and the same comparison
            // rejects an out-of-order date and a duplicate one.
            if (dates_[i] <= dates_[i - 1]) {
                revert DatesNotAscending(dates_[i - 1], dates_[i]);
            }
        }

        issuedAt = issuedAt_;
        spreadBps = spreadBps_;
        faceValue = faceValue_;
        basis = basis_;
        _dates = dates_;

        bytes32 r = _rootOf(issuedAt_, dates_, spreadBps_, faceValue_, basis_);
        root = r;
        emit ScheduleFixed(r, issuedAt_, n);
    }

    // ----------------------------------------------------------- the reads

    /// @inheritdoc ICouponSchedule
    function count() public view returns (uint256) {
        return _dates.length;
    }

    /// @inheritdoc ICouponSchedule
    function dateOf(uint256 index) public view returns (uint64) {
        if (index >= _dates.length) revert NoSuchCoupon(index, _dates.length);
        return _dates[index];
    }

    /// @inheritdoc ICouponSchedule
    function accrualStart(uint256 index) public view returns (uint64) {
        if (index >= _dates.length) revert NoSuchCoupon(index, _dates.length);
        return index == 0 ? issuedAt : _dates[index - 1];
    }

    /// @notice Every coupon date, for a client that wants the calendar in one call.
    /// @dev Bounded by `MAX_COUPONS`, so this is a read a client can make
    ///      unconditionally rather than one it has to page.
    function dates() external view returns (uint64[] memory) {
        return _dates;
    }

    /// @inheritdoc ICouponSchedule
    /// @dev The whole of the derivation `noteCoupon` used to take on trust:
    ///      period from the schedule, rate from the schedule's spread over a
    ///      reference the caller passes in, lot from the caller's own storage.
    ///      Nothing here is an argument a caller can pick freely except the lot,
    ///      and the lot is the one number the caller is the authority on.
    function amountFor(uint256 index, uint64 refRateBps, uint256 lot)
        external
        view
        returns (uint256)
    {
        uint64 to = dateOf(index);
        uint64 from = accrualStart(index);
        return CouponMath.accrue(
            lot, faceValue, CouponMath.couponBps(refRateBps, spreadBps), from, to, basis
        );
    }

    /// @notice The root, rebuilt from a candidate calendar. Public and pure so
    ///         the client, `make vectors` and this contract cannot disagree.
    function rootOf(
        uint64 issuedAt_,
        uint64[] memory dates_,
        uint16 spreadBps_,
        uint128 faceValue_,
        CouponMath.Basis basis_
    ) external pure returns (bytes32) {
        return _rootOf(issuedAt_, dates_, spreadBps_, faceValue_, basis_);
    }

    // ------------------------------------------------------------ the tree

    /// @dev One flat tree, `MerkleSet`'s collapse, `n + 1` leaves.
    ///
    ///      **Position zero is the terms and positions `1..n` are the dates, in
    ///      index order.** `ParameterRoot` fixes its leaf order with the
    ///      ascending-key rule; a calendar has no key to ascend on, so the order
    ///      is fixed by position instead. Both buy the same property, which is
    ///      the only one that matters: the order is a published rule rather than
    ///      the caller's choice, so the root commits to a set and not to a
    ///      submission.
    ///
    ///      The terms leaf carries `SCOPE_TERMS` rather than an index, so a date
    ///      leaf and the terms leaf cannot be each other's preimage even though
    ///      they share a domain tag. That is the same scoping argument
    ///      `CouponDistributor` makes about the coupon index, one tree over.
    function _rootOf(
        uint64 issuedAt_,
        uint64[] memory dates_,
        uint16 spreadBps_,
        uint128 faceValue_,
        CouponMath.Basis basis_
    ) private pure returns (bytes32) {
        uint256 n = dates_.length;
        bytes32[] memory leaves = new bytes32[](n + 1);

        leaves[0] = MerkleSet.leafOf(
            DOMAIN_LEAF,
            SCOPE_TERMS,
            bytes32(uint256(issuedAt_)),
            // Three terms in one word, ascending in the order they are declared
            // above. They are 16, 128 and 8 bits against a 256-bit slot, so the
            // packing is lossless and asserted to be by
            // `test_theRootMovesWhenAnyTermMoves`.
            uint256(spreadBps_) | (uint256(faceValue_) << 16) | (uint256(basis_) << 144)
        );
        for (uint256 i = 0; i < n; ++i) {
            leaves[i + 1] =
                MerkleSet.leafOf(DOMAIN_LEAF, i, bytes32(uint256(i)), uint256(dates_[i]));
        }
        return MerkleSet.rootOfLeaves(DOMAIN_NODE, leaves);
    }
}
