// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title RepoMath
/// @notice The arithmetic of a sale and repurchase, on an ACT/365 basis.
///
/// A repo is a sale with an agreed repurchase. The cash borrower sells the
/// security at the **purchase price** and agrees to buy it back at the
/// **repurchase price**, which is the purchase price plus interest at the repo
/// rate over the term. Legally title passes; economically it is a secured loan.
/// That distinction is why the coupon handling in `RepoVault` exists: because
/// title passes, ATS pays a mid-term coupon to the cash *lender*, who is not
/// economically entitled to it.
///
/// ## Rounding, which is an invariant and not a detail
///
/// an invariant requires that cash settled equals cash computed. Integer division makes
/// that a statement about direction, not just about arithmetic. Accrued interest
/// **rounds up**, so the borrower never repays less than the contract says. The
/// alternative, rounding to nearest, leaks value to whichever side the remainder
/// happens to favour and makes the leak depend on the timestamp, which is worse
/// than a small consistent bias.
///
/// The second half of an invariant is not enforceable here at all and is stated so it
/// is not mistaken for enforced. an earlier measurement measured that an HTS fractional fee is a
/// property of the token, and both fee settings break exact settlement. The
/// constraint is therefore on token selection, one cash token with the fee off,
/// and this library computes what *should* move. Whether that is what arrives is
/// a property of the token, checked at deployment.
library RepoMath {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant YEAR = 365 days;

    error HaircutTooLarge(uint256 haircutBps);
    error TermNotStarted();

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
}
