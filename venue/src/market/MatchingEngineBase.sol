// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title MatchingEngineBase
/// @notice Rows, events and errors of `MatchingEngine`.
/// @dev Abstract rather than an interface: an interface cannot hold the row
///      constants. Selectors live here (`MatchingEngineBase.RoundStillOpen`),
///      matching `OrderBookBase`.
abstract contract MatchingEngineBase {
    /// @dev Row 5: the print. Degrades (exact → bucket → withhold); the trade still settles.
    uint16 internal constant ROW_EXEC_PRICE = 5;
    /// @dev Row 12: counterparties. ATS `executeHold` names them anyway; our event is not
    ///      the disclosure. Unwaived so Regime cannot turn settlement into a revert.
    uint16 internal constant ROW_COUNTERPARTY = 12;
    /// @dev Row 13: that a round did or did not cross. Public deterministic rule, so not
    ///      a trusted-evaluator surface. See `docs/MATCHING.md`.
    uint16 internal constant ROW_MATCH_PREDICATE = 13;

    event RoundCrossed(uint64 indexed round, uint256 priceTwice, uint256 volume);
    /// @notice Degraded print. Magnitudes are base-ten orders of magnitude.
    event PrintedCoarse(uint64 indexed round, uint256 priceBucket, uint256 volumeBucket);
    /// @notice Nothing printable. The trade still settled.
    event PrintWithheld(uint64 indexed round);
    event RoundEmpty(uint64 indexed round);
    event Settled(bytes32 indexed sellId, bytes32 indexed buyId, uint256 amount, uint256 cost);
    /// @dev Not a revert: one ineligible pair must not stop the round for everyone.
    event SettlementRefused(bytes32 indexed sellId, bytes32 indexed buyId);
    event VoidedByRebase(bytes32 indexed id, uint256 promised, uint256 found);
    event VolumeCapAttached(address indexed cap);
    event TradingHaltAttached(address indexed halt);
    event CrossRefusedWhileHalted(uint64 indexed round, uint64 until);
    event HoldReleaseAttempted(bytes32 indexed id, bool released);

    error RoundStillOpen(uint64 round, uint64 current);
    error AlreadyCrossed(uint64 round);
    error UnexpectedValue(uint256 sent);
    error WrongEscrow(uint256 sent, uint256 want);
    error NotEscrow(address escrow);
    error HoldNamesADestination(address destination);
    error HoldTooSmall(uint256 held, uint256 qty);
    error HoldExpiresTooSoon(uint256 expiry, uint64 needed);
    error OutOfRange(uint128 value);
    error VolumeCapNotAttached();
    error VolumeCapAlreadyAttached();
    error TradingHaltNotAttached();
    error TradingHaltAlreadyAttached();
    error VenueHalted(uint64 until);
    error NotInstaller();
    error CapIsNotOurs(address venue);
}
