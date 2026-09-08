// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title RepoMath
/// @notice Sale-and-repurchase arithmetic, ACT/365. Haircut ≠ initial margin.
/// @dev Interest and fail-days round up. Penalty unit is hundredths of a bp
///      (CSDR). Article 7(2) is who is paid, enforced in `Rulebook`, not here.
library RepoMath {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant MAX_REPO_RATE_BPS = BPS;

    /// @notice Hundredths of a basis point, the unit CSDR penalty rates need.
    /// @dev The delegated act writes its rates to one decimal place of a basis
    ///      point: 0.10 bp a day for sovereign debt, 0.20 for other bonds, 1.00
    ///      for a liquid share. In basis points the first two are zero, so the
    ///      unit is not a preference. `penaltyRate` is in these.
    uint256 internal constant BP_HUNDREDTHS = 1_000_000;

    error HaircutTooLarge(uint256 haircutBps);
    error RepoRateTooLarge(uint256 repoRateBps);
    error TermNotStarted();
    error PenaltyRateTooLarge(uint256 rate);
    error MulDivOverflow();

    /// @notice Purchase price after the haircut.
    /// @dev The haircut is the lender's protection against the collateral falling
    ///      between the two legs. It is applied to the mark, so the cash advanced
    ///      is strictly less than the collateral's value at open.
    function purchasePrice(uint256 markValue, uint256 haircutBps)
        internal
        pure
        returns (uint256)
    {
        if (haircutBps >= BPS) revert HaircutTooLarge(haircutBps);
        return _mulDiv(markValue, BPS - haircutBps, BPS);
    }

    /// @notice Value of `amount` units at `markPerUnit`.
    function markedValue(uint256 markPerUnit, uint256 amount) internal pure returns (uint256) {
        return _mulDiv(markPerUnit, amount, 1);
    }

    /// @notice Interest accrued on ACT/365 from `openedAt` to `at`.
    /// @dev Rounds up. See the class comment.
    function accrued(uint256 principal, uint256 repoRateBps, uint256 openedAt, uint256 at)
        internal
        pure
        returns (uint256)
    {
        if (at < openedAt) revert TermNotStarted();
        uint256 elapsed = at - openedAt;
        if (elapsed == 0 || principal == 0 || repoRateBps == 0) return 0;
        return _mulDiv3Up(principal, repoRateBps, elapsed, BPS * YEAR);
    }

    /// @notice What the borrower owes to close, at time `at`.
    function repurchasePrice(
        uint256 principal,
        uint256 repoRateBps,
        uint256 openedAt,
        uint256 at
    ) internal pure returns (uint256) {
        uint256 interest = accrued(principal, repoRateBps, openedAt, at);
        if (interest > type(uint256).max - principal) revert MulDivOverflow();
        return principal + interest;
    }

    /// @notice True when the collateral no longer covers the exposure.
    /// @dev Exposure is the repurchase price accrued to now, grossed up by the
    ///      maintenance margin. Note what is *not* here: this function takes the
    ///      mark as an argument and returns a bool, and `RepoVault` never stores
    ///      the mark in the clear. Row 14 of the disclosure matrix, position risk,
    ///      is answered by not writing something, which is a constraint that has
    ///      to reach the storage layout rather than the logic.
    function isUndercollateralised(
        uint256 markValue,
        uint256 principal,
        uint256 repoRateBps,
        uint256 openedAt,
        uint256 at,
        uint256 maintenanceBps
    ) internal pure returns (bool) {
        uint256 exposure = repurchasePrice(principal, repoRateBps, openedAt, at);
        uint256 required = _mulDivUp(exposure, BPS + maintenanceBps, BPS);
        return markValue < required;
    }

    // ------------------------------------------------- CSDR Article 7 penalty

    /// @notice Days of a settlement fail, from the intended settlement date.
    /// @dev Rounds **up**, for the reason `accrued` does and for one more. A
    ///      floor makes a fail of twenty three hours free, which is a free
    ///      option to settle a day late, and the whole point of a penalty is
    ///      that the option is priced.
    ///
    ///      A day here is 24 hours and Article 7 counts business days. The
    ///      contract has no calendar and cannot be given one without an oracle,
    ///      so this over-counts across a weekend. Over-counting is the direction
    ///      that favours the party that was failed against, which is the party
    ///      the article is written for.
    function failDays(uint256 intendedAt, uint256 at) internal pure returns (uint256) {
        if (at <= intendedAt) return 0;
        uint256 elapsed = at - intendedAt;
        return (elapsed + 1 days - 1) / 1 days;
    }

    /// @notice The cash penalty owed for a fail running to `at`.
    /// @dev CSDR Article 7 charges a fail daily from the intended settlement
    ///      date through to actual settlement, and Article 7(2) says the
    ///      mechanism "shall not operate as a revenue source". That second
    ///      sentence is a constraint on **who is paid**, not on the arithmetic,
    ///      and it is enforced a layer up: the tariff line for this charge names
    ///      the counterparty as payee, so `Rulebook.netOperatorTake` cannot
    ///      include it and stay honest.
    ///
    ///      `referenceValue` is the cash that failed to arrive, not the
    ///      collateral. A close leg fails on the cash side, because the borrower
    ///      is the one who has to pay.
    function settlementPenalty(
        uint256 referenceValue,
        uint256 penaltyRate,
        uint256 intendedAt,
        uint256 at
    ) internal pure returns (uint256) {
        if (penaltyRate > BP_HUNDREDTHS) {
            revert PenaltyRateTooLarge(penaltyRate);
        }
        uint256 d = failDays(intendedAt, at);
        if (d == 0) return 0;
        return _mulDiv3Up(referenceValue, penaltyRate, d, BP_HUNDREDTHS);
    }

    function _mulDiv3Up(uint256 x, uint256 y, uint256 z, uint256 denominator)
        private
        pure
        returns (uint256 result)
    {
        uint256 quotient = _mulDiv(x, y, denominator);
        uint256 remainder = mulmod(x, y, denominator);
        result = _mulDiv(quotient, z, 1) + _mulDiv(remainder, z, denominator);
        if (mulmod(remainder, z, denominator) != 0) {
            if (result == type(uint256).max) revert MulDivOverflow();
            result += 1;
        }
    }

    function _mulDivUp(uint256 x, uint256 y, uint256 denominator)
        private
        pure
        returns (uint256 result)
    {
        result = _mulDiv(x, y, denominator);
        if (mulmod(x, y, denominator) != 0) {
            if (result == type(uint256).max) revert MulDivOverflow();
            result += 1;
        }
    }

    /// @dev Full-precision floor of `x * y / denominator`.
    function _mulDiv(uint256 x, uint256 y, uint256 denominator)
        private
        pure
        returns (uint256 result)
    {
        unchecked {
            uint256 low;
            uint256 high;
            assembly ("memory-safe") {
                let mm := mulmod(x, y, not(0))
                low := mul(x, y)
                high := sub(sub(mm, low), lt(mm, low))
            }

            if (high == 0) return low / denominator;
            if (denominator <= high) revert MulDivOverflow();

            uint256 remainder;
            assembly ("memory-safe") {
                remainder := mulmod(x, y, denominator)
                high := sub(high, gt(remainder, low))
                low := sub(low, remainder)
            }

            uint256 twos = denominator & (0 - denominator);
            assembly ("memory-safe") {
                denominator := div(denominator, twos)
                low := div(low, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            low |= high * twos;

            uint256 inverse = (3 * denominator) ^ 2;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            result = low * inverse;
        }
    }
}
