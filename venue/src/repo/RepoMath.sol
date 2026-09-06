// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title RepoMath
/// @notice Sale-and-repurchase arithmetic, ACT/365. Haircut ≠ initial margin.
/// @dev Interest and fail-days round up. Penalty unit is hundredths of a bp
///      (CSDR). Article 7(2) is who is paid, enforced in `Rulebook`, not here.
library RepoMath {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant YEAR = 365 days;

    /// @notice Hundredths of a basis point, the unit CSDR penalty rates need.
    /// @dev The delegated act writes its rates to one decimal place of a basis
    ///      point: 0.10 bp a day for sovereign debt, 0.20 for other bonds, 1.00
    ///      for a liquid share. In basis points the first two are zero, so the
    ///      unit is not a preference. `penaltyRate` is in these.
    uint256 internal constant BP_HUNDREDTHS = 1_000_000;

    error HaircutTooLarge(uint256 haircutBps);
    error TermNotStarted();
    error PenaltyRateTooLarge(uint256 rate);

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
        return (markValue * (BPS - haircutBps)) / BPS;
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
        uint256 num = principal * repoRateBps * elapsed;
        uint256 den = BPS * YEAR;
        return (num + den - 1) / den;
    }

    /// @notice What the borrower owes to close, at time `at`.
    function repurchasePrice(
        uint256 principal,
        uint256 repoRateBps,
        uint256 openedAt,
        uint256 at
    ) internal pure returns (uint256) {
        return principal + accrued(principal, repoRateBps, openedAt, at);
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
        uint256 required = (exposure * (BPS + maintenanceBps)) / BPS;
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
        uint256 num = referenceValue * penaltyRate * d;
        return (num + BP_HUNDREDTHS - 1) / BP_HUNDREDTHS;
    }
}
