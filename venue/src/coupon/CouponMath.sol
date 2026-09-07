// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title CouponMath
/// @notice Variable-rate coupon accrual, ACT/365. Rounds **down**.
/// @dev The sibling of `RepoMath`, and it disagrees with it about rounding on
///      purpose. See `accrue`.
library CouponMath {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant YEAR = 365 days;

    /// @notice The one day count basis implemented, named rather than assumed.
    /// @dev A bond that does not say how its coupon accrues is not a specified
    ///      instrument, so the field exists and `CouponSchedule` publishes it.
    ///      It has one legal value. 30/360 is the other basis this instrument
    ///      class commonly uses and it needs a civil calendar: year, month and
    ///      day decomposed out of a Unix timestamp, with the end-of-month
    ///      conventions that go with it. That is a date library this venue does
    ///      not have and would have to test before trusting. Refusing the
    ///      value at construction is the honest version of not having it;
    ///      accepting it and accruing ACT/365 underneath would be a schedule
    ///      that lies about its own terms.
    enum Basis {
        NONE,
        ACT_365
    }

    error UnsupportedBasis(Basis got);
    error PeriodNotOrdered(uint64 from, uint64 to);
    error RateTooLarge(uint256 bps);

    /// @notice The largest coupon rate a schedule will accrue at.
    /// @dev A hundred percent a year. The reference leg comes from
    ///      `PrimeOracle`, which is a quorum median over seated publishers and
    ///      therefore a number this library does not control, and an unbounded
    ///      rate multiplied by a lot multiplied by a face value is the shape of
    ///      an overflow. The bound is not a view about interest rates; it is
    ///      what makes `accrue`'s arithmetic provably fit, which
    ///      `test_theCouponCannotOverflowAtTheBoundsOfTheTypes` asserts.
    uint256 internal constant MAX_RATE_BPS = BPS;

    /// @notice Reference plus spread, bounded.
    /// @dev The reference is the venue's own published leg and the spread is the
    ///      issuer's, fixed at issuance. Neither is a floor: an FRN whose
    ///      reference goes to zero pays its spread, which is what the sum does
    ///      without a special case.
    function couponBps(uint64 refRateBps, uint16 spreadBps) internal pure returns (uint256) {
        uint256 r = uint256(refRateBps) + uint256(spreadBps);
        if (r > MAX_RATE_BPS) revert RateTooLarge(r);
        return r;
    }

    /// @notice The coupon on `lot` units of `faceValue` face, over `[from, to)`.
    /// @dev **Rounds down, where `RepoMath.accrued` rounds up, and the
    ///      difference is not an inconsistency.** `RepoMath` prices what a
    ///      borrower owes and rounds so the borrower never repays less than the
    ///      contract says. This prices what an issuer owes out of a pool it
    ///      funded in advance, and rounding up there means a set of entitlements
    ///      whose sum can exceed what was funded, which is a rounding choice
    ///      turning into a payment that fails at the last claimant. Down can
    ///      never overspend the pool.
    ///
    ///      The multiplication order is deliberate: every factor first, one
    ///      division last. Dividing early throws away the fraction that the
    ///      remaining factors would have recovered, and on a lot of a million
    ///      that is not a rounding error, it is a missing coupon.
    ///
    ///      The bound, asserted rather than assumed. `lot` is bounded by the
    ///      bond's `maxSupply` of 1,000,000, `faceValue` is a `uint128`,
    ///      `couponBps` is bounded by `MAX_RATE_BPS` at 1e4, and a period is
    ///      bounded by a `uint64` of seconds. The numerator is therefore at most
    ///      about 1e6 * 3.4e38 * 1e4 * 1.8e19, which is 6.1e67 against a
    ///      `uint256` ceiling of 1.1e77.
    function accrue(
        uint256 lot,
        uint128 faceValue,
        uint256 rateBps,
        uint64 from,
        uint64 to,
        Basis basis
    ) internal pure returns (uint256) {
        if (basis != Basis.ACT_365) revert UnsupportedBasis(basis);
        if (to < from) revert PeriodNotOrdered(from, to);
        if (rateBps > MAX_RATE_BPS) revert RateTooLarge(rateBps);

        uint256 elapsed = uint256(to) - uint256(from);
        return (lot * uint256(faceValue) * rateBps * elapsed) / (BPS * YEAR);
    }
}
