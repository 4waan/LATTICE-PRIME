// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IExternalControlList} from "../interfaces/IExternalControlList.sol";

/// @title FreezeList
/// @notice Seam B. ATS calls `isAuthorized` on every transfer and at maturity.
/// @dev Never reverts, never unbounded gas: a revert here bars every holder at
///      once, which is the one failure this contract must not have.
///      `docs/RULEBOOK.md` §7b.
///
/// ## Allow by default, which is the opposite of seam D
///
/// `ZkKycRegistry` denies by default: the zero value is `NOT_GRANTED` and a
/// holder is barred until a proof says otherwise. This contract allows by
/// default: the zero value is a deadline in the past and a holder is free until
/// the guardian names them. The two seams are ANDed by ATS, so the composition is
///
///     may move  <=>  holds a live KYC grant  AND  is not frozen here
///
/// which is an allowlist intersected with a blocklist, and each half is the shape
/// its own question wants. Getting this backwards is not a style error. A
/// blocklist that denied by default would bar every holder from the block it was
/// registered in, and a freeze list is registered on a token that already has
/// holders.
///
/// ## Why nothing here is metered
///
/// Every other disclosing contract in this venue routes its events through
/// `DisclosureView._emitUnder`, which withholds when a row's coalition budget is
/// spent. This one does not, and the omission is the design.
///
/// A freeze is a deprivation of property applied to a named person. The venue's
/// whole argument for withholding is that a disclosure the market has not paid
/// for is a disclosure that leaks someone's position; none of that applies to
/// telling someone they have been barred. Routing `Frozen` through the meter
/// would mean a venue that had spent row 17 could freeze an account in silence,
/// and a freeze nobody can hear is indistinguishable from a venue that has
/// stopped working. So the state and the event are the same act here, and
/// `test_aFreezeIsAlwaysAudibleWhateverTheMatrixSays` is that claim.
contract FreezeList is IExternalControlList {
    // -------------------------------------------------------------- wiring

    /// @notice The only address that may freeze or thaw.
    address public immutable guardian;

    /// @notice `until` for a freeze that carries no end date.
    /// @dev Spelled rather than passed as a magic number by callers, and read
    ///      back by `Frozen` consumers to tell a precautionary freeze from an
    ///      indefinite one. A sanctions listing has no expiry and pretending
    ///      otherwise would put a date in the record that nobody chose.
    uint64 public constant INDEFINITE = type(uint64).max;

    // ------------------------------------------------------------- storage

    /// @dev The deadline a freeze runs to. Zero, the default, is a deadline in
    ///      the past, which is how "not frozen" is the zero value rather than a
    ///      branch. One warm SLOAD on the transfer path, for `TransferPause`'s
    ///      reason.
    mapping(address => uint64) private _frozenUntil;

    // -------------------------------------------------------------- events

    /// @notice Never withheld. See the note above.
    /// @param until The deadline, or `INDEFINITE`.
    event Frozen(address indexed account, uint64 until, bytes32 rationale);
    event Thawed(address indexed account, bytes32 rationale);

    // -------------------------------------------------------------- errors

    error NotGuardian();
    error FreezeInThePast(uint64 until, uint64 now_);
    error NotFrozen(address account);

    // --------------------------------------------------------- constructor

    constructor(address guardian_) {
        guardian = guardian_;
    }

    // ------------------------------------------------------- the seam call

    /// @inheritdoc IExternalControlList
    /// @dev Never reverts, one SLOAD. ATS ANDs this across every registered list
    ///      inside `isExternallyAuthorized`, so a revert is not a refusal, it is
    ///      a token on which no holder can transact and which no role can repair
    ///      except by unregistering this contract.
    ///
    ///      Deliberately has no global switch. A blocklist that could bar
    ///      everyone at once would be a second pause, seated on the seam that
    ///      cannot be removed while it is refusing. The pause lives in
    ///      `TransferPause`, where the exit is open by construction.
    function isAuthorized(address account) external view returns (bool) {
        return block.timestamp >= _frozenUntil[account];
    }

    // ------------------------------------------------------------ the state

    /// @notice The deadline `account`'s freeze runs to. Zero when never frozen.
    function frozenUntil(address account) external view returns (uint64) {
        return _frozenUntil[account];
    }

    function isFrozen(address account) public view returns (bool) {
        return block.timestamp < _frozenUntil[account];
    }

    /// @notice The subset of `accounts` frozen right now.
    /// @dev `MarginWatch.calledAmong`'s shape and its reason: a client that heard
    ///      `Frozen` cannot tell which of those freezes has since lapsed, because
    ///      a dated freeze ends with no transaction from anyone. This is the read
    ///      that answers it.
    function frozenAmong(address[] calldata accounts)
        external
        view
        returns (address[] memory out)
    {
        uint256 n;
        for (uint256 i; i < accounts.length; ++i) {
            if (isFrozen(accounts[i])) ++n;
        }
        out = new address[](n);
        uint256 j;
        for (uint256 i; i < accounts.length; ++i) {
            if (isFrozen(accounts[i])) out[j++] = accounts[i];
        }
    }

    // -------------------------------------------------------- the discretion

    /// @notice Bar `account` until `until`. Guardian only.
    /// @dev Extending an existing freeze is a second call with its own rationale
    ///      and its own event, which is what stops a freeze being renewed
    ///      quietly. Shortening one is the same call with an earlier date, and it
    ///      is allowed for `TransferPause.resume`'s reason: nothing here should
    ///      make releasing someone harder than holding them.
    function freeze(address account, uint64 until, bytes32 rationale) public {
        if (msg.sender != guardian) revert NotGuardian();
        if (until <= block.timestamp) revert FreezeInThePast(until, uint64(block.timestamp));
        _frozenUntil[account] = until;
        emit Frozen(account, until, rationale);
    }

    /// @notice Bar every address in `accounts` until `until`. Guardian only.
    /// @dev A designation arrives as a list, and applying one by one is a window
    ///      in which the tail of the list can still move. Unbounded on purpose:
    ///      it is a guardian call and not a transfer path, so the caller's own gas
    ///      limit is the right bound and a fixed cap here would be a second
    ///      window with a number attached.
    function freezeMany(address[] calldata accounts, uint64 until, bytes32 rationale)
        external
    {
        for (uint256 i; i < accounts.length; ++i) {
            freeze(accounts[i], until, rationale);
        }
    }

    /// @notice Release `account`. Guardian only, immediate.
    /// @dev Refuses when the account is not frozen, so a thaw in the record is
    ///      always a release that happened and never a call that did nothing.
    function thaw(address account, bytes32 rationale) external {
        if (msg.sender != guardian) revert NotGuardian();
        if (!isFrozen(account)) revert NotFrozen(account);
        _frozenUntil[account] = 0;
        emit Thawed(account, rationale);
    }
}
