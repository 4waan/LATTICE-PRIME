// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title RepoVaultBase
/// @notice Rows, events and errors of `RepoVault`.
/// @dev Selectors are `RepoVaultBase.NotParty`. `State` stays on `RepoVault`.
abstract contract RepoVaultBase {
    /// @dev Rows of the venue's disclosure matrix, named beside each `emit` because the
    ///      row is the claim. `ROW_EXEC_PRICE` is declared and never emitted on: see
    ///      `RepoVault.close`.
    uint16 internal constant ROW_EXEC_PRICE = 5;
    uint16 internal constant ROW_ASSET = 7;
    uint16 internal constant ROW_POSITION = 14;
    uint16 internal constant ROW_CADENCE = 16;

    event Opened(bytes32 indexed id, uint64 maturity);
    /// @dev Position predicates only. Exact terms remain readable from storage
    ///      and calldata, but the venue event does not repeat them.
    event OfferFunded(bytes32 indexed id);
    event OfferCancelled(bytes32 indexed id);
    /// @dev Payment cannot depend on a publication budget. The native transfer
    ///      remains public; this venue receipt intentionally omits the amount.
    event Withdrawn(address indexed account);
    /// @dev Exact collateral is in storage and the ATS hold event. Row 14 admits
    ///      only the predicate, so the venue event carries only the reference.
    event CollateralAdded(bytes32 indexed id);
    event MarkPosted(bytes32 indexed id, bytes32 commitment);
    /// @dev The boolean and nothing else. Row 14.
    event MarginCalled(bytes32 indexed id, uint64 cureDeadline);
    event Cured(bytes32 indexed id);
    event CouponObserved(bytes32 indexed id, bytes32 commitment);
    /// @dev No amount. The penalty is `value * rate * days` with rate and days both
    ///      public, so an amount divides out to the position, which row 14 refuses. The
    ///      date is a term of the instrument and `Opened` published it already.
    event Failing(bytes32 indexed id, uint64 intendedAt);
    event Defaulted(bytes32 indexed id);
    /// @dev The predicate and not the price. See `RepoVault.close`.
    event Closed(bytes32 indexed id);

    error NotParty();
    error NotEligible(address account);
    error NotMarginEngine();
    error NotLiquidationEngine();
    error CureWindowOpen(uint64 until);
    error NothingOwed();
    error NotYetMature(uint64 maturity);
    error FailGraceOpen(uint64 until);
    error SubstitutionRefused();
    error AlreadyExists(bytes32 id);
    /// @dev `postMark` is the degradation path and nothing else. See its header.
    error FeedIsLive();
    error NoFeed();
    error NoSchedule();
    /// @dev A coupon this repo was not open across. See `RepoVault.noteCoupon`.
    error CouponOutsideTerm(uint256 index, uint64 due, uint64 openedAt, uint64 maturity);
    error CouponNotYetDue(uint256 index, uint64 due);
    /// @dev The mirror of `FeedIsLive`. `postMark` opens when the feed is dark;
    ///      `noteCoupon` closes, because a coupon rate read off a dark feed is a
    ///      number nobody published.
    error FeedIsDark();
    error UseFundedOffer();
    error UnknownOffer(bytes32 id);
    error OfferExpired(uint64 expiresAt);
    error MarkMoved(uint256 quoted, uint256 live);
    error InsufficientRepayment(uint256 got, uint256 want);
    error EmptyCure();
    error AuctionNotSupported();
    error NothingToWithdraw();
    error ZeroAmount();
    error ZeroAddress();
    error MaturityOverflow();
    error DeadlineOverflow();
    error CureWindowClosed(uint64 deadline);
    error SelfDeal();
    error NoManufacturedPayment();
}
