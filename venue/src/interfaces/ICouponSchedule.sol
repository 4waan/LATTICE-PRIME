// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {CouponMath} from "../coupon/CouponMath.sol";

/// @title ICouponSchedule
/// @notice What the rest of the venue needs from a bond's coupon calendar.
/// @dev Split from `CouponSchedule` for `IPrimeOracle`'s reason: two consumers
///      that want different halves. `RepoVault` needs a date, a period and an
///      amount, which is the whole of what deriving a manufactured payment
///      takes. `CouponDistributor` needs the date and the count, to refuse a
///      declaration against a coupon the instrument does not have. Neither
///      needs the root or the terms, and a vault that imported the concrete
///      contract would have both in its dependency graph.
///
///      Every function here is a view over data fixed at construction, so
///      nothing on this interface can revert for a reason that changes between
///      two blocks. `amountFor` is the exception and it says so.
interface ICouponSchedule {
    /// @notice How many coupons the bond pays over its life.
    function count() external view returns (uint256);

    /// @notice The date coupon `index` falls due.
    function dateOf(uint256 index) external view returns (uint64);

    /// @notice Where coupon `index` starts accruing.
    /// @dev The previous coupon date, or the dated date for the first one. A
    ///      caller that computed this itself would be a caller that could
    ///      disagree with the schedule about the length of a period.
    function accrualStart(uint256 index) external view returns (uint64);

    /// @notice The coupon on `lot` units, at a reference rate of `refRateBps`.
    /// @dev Reverts on an index the bond does not have, and on a reference rate
    ///      that would put the coupon over `CouponMath.MAX_RATE_BPS`. The rate
    ///      is an argument rather than a read, so this interface does not drag
    ///      the oracle in behind it and so the caller is the one that decided
    ///      which published rate it was willing to act on.
    function amountFor(uint256 index, uint64 refRateBps, uint256 lot)
        external
        view
        returns (uint256);

    /// @notice The spread over the reference rate, fixed at issuance.
    function spreadBps() external view returns (uint16);

    /// @notice The day count basis. One legal value. See `CouponMath.Basis`.
    function basis() external view returns (CouponMath.Basis);

    /// @notice Nominal value of one unit of the bond, in the cash token's
    ///         smallest unit.
    function faceValue() external view returns (uint128);

    /// @notice The commitment to the whole calendar and its terms.
    function root() external view returns (bytes32);
}
