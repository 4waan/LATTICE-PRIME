// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title RepoVaultBase
/// @notice The state enum, disclosure rows, events and errors of `RepoVault`, held apart
///         so the contract body carries transitions and arithmetic only.
/// @dev An abstract contract rather than a library or an interface: an interface cannot
///      hold the row constants, and errors and events belong to the contract that reverts
///      and emits them. Inheritance does not re-export any of this under the deriving
///      name, so a call site asks for `RepoVaultBase.NotParty.selector`. `State` stays in
///      `RepoVault` for the mirror of that reason: it is spelled `RepoVault.State` at
///      twenty one call sites and moving it would buy nothing.
abstract contract RepoVaultBase {
    /// @dev Rows of the venue's disclosure matrix, named beside each `emit` because the
    ///      row is the claim. `ROW_EXEC_PRICE` is declared and never emitted on: see
    ///      `RepoVault.close`.
    uint16 internal constant ROW_EXEC_PRICE = 5;
    uint16 internal constant ROW_ASSET = 7;
    uint16 internal constant ROW_POSITION = 14;
    uint16 internal constant ROW_CADENCE = 16;

    event Opened(bytes32 indexed id, uint64 maturity);
    event MarkPosted(bytes32 indexed id, bytes32 commitment);
    /// @dev The boolean and nothing else. Row 14.
    event MarginCalled(bytes32 indexed id, uint64 cureDeadline);
    event Cured(bytes32 indexed id);
    event CouponObserved(bytes32 indexed id, bytes32 commitment);
    event ManufacturedPaid(bytes32 indexed id);
    /// @dev No amount. The penalty is `value * rate * days` with rate and days both
    ///      public, so an amount divides out to the position, which row 14 refuses. The
    ///      date is a term of the instrument and `Opened` published it already.
    event Failing(bytes32 indexed id, uint64 intendedAt);
    event Defaulted(bytes32 indexed id);
    /// @dev The predicate and not the price. See `RepoVault.close`.
    event Closed(bytes32 indexed id);

    error NotParty();
    error NotMarginEngine();
    error CureWindowOpen(uint64 until);
    error NothingOwed();
    error NotYetMature(uint64 maturity);
    error FailGraceOpen(uint64 until);
    error SubstitutionRefused();
    error AlreadyExists(bytes32 id);
}
