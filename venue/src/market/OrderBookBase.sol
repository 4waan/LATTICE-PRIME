// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title OrderBookBase
/// @notice Rows, retirement reasons, events and errors of `OrderBook`.
/// @dev Abstract: interfaces cannot hold constants. Selectors are
///      `OrderBookBase.TooEarly`. `Side` stays on `OrderBook` so call sites
///      keep `OrderBook.Side`.
abstract contract OrderBookBase {
    /// @dev Rows of the venue's disclosure matrix, named beside each `emit` because the
    ///      row is the claim. Row 17 rather than row 1 for trader identity, because
    ///      orders are sent from single-use addresses with no funding history: if the
    ///      venue ever admits durable accounts the correct row becomes 1, whose ceiling
    ///      is `BOTTOM`, and every `commit` starts reverting.
    uint16 internal constant ROW_ORDER_SIZE = 3;
    uint16 internal constant ROW_ORDER_PRICE = 4;
    /// @dev The book's only cell below `exact`, so the only one a coalition budget binds.
    uint16 internal constant ROW_ACTIVITY = 15;
    uint16 internal constant ROW_PROVENANCE = 17;

    /// @dev Why an order left the live book, so a trader can tell an expiry from a void.
    uint8 internal constant RETIRE_EXPIRED = 0;
    uint8 internal constant RETIRE_FILLED = 1;
    uint8 internal constant RETIRE_VOIDED = 2;

    event Committed(bytes32 indexed id, address indexed committer);
    event BondForfeited(bytes32 indexed id, uint256 amount);
    /// @dev The fact and nothing else. Everything else is public already or never
    ///      existed: the order was not opened, so no price or size exists. Row 15.
    event Cancelled(bytes32 indexed id);
    event Retired(bytes32 indexed id, uint8 reason);
    event Withdrawn(address indexed who, uint256 amount);

    error AlreadyCommitted(bytes32 id);
    error UnknownCommitment(bytes32 id);
    error WrongBond(uint256 sent, uint256 want);
    error TooEarly(uint64 opensAt);
    error TooLate(uint64 closedAt);
    error AlreadyRevealed(bytes32 id);
    error OpeningDoesNotMatch();
    error StillRevealable(uint64 until);
    error UnknownOrder(bytes32 id);
    error StillResting(uint64 until);
    error ZeroRoundLength();
    error ZeroQuantity();
    error NothingToWithdraw();
    /// @dev The one call here that is not permissionless. A permissionless cancel is a
    ///      griefing primitive: anyone could pull anybody's quote and charge them for it.
    error NotCommitter(address committer);
    error AlreadyCancelled(bytes32 id);
    /// @param closedAt The instant cancel closed, which is the instant reveal opened.
    ///        Exclusive here and inclusive there, so the two windows never overlap.
    error CancelWindowClosed(uint64 closedAt);
    error CancelFeeExceedsBond(uint256 fee, uint256 bond);
    error CancelFeeTooLow(uint256 fee, uint256 minimum);
}
