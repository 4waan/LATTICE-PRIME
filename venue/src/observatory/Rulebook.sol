// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {RootWindow} from "../policy/RootWindow.sol";
import {Regime, IEpochClock} from "../policy/Regime.sol";

/// @title Rulebook
/// @notice The venue's operating rules and its tariff, as a committed edition.
///
/// ## Why a contract and not only a document
///
/// Form ATS-N asks an alternative trading system to disclose order types, market
/// data, fees, priority and segmentation, and MiFIR Article 5's sibling rule on
/// venue rebates permits them only under an *approved and public* tariff
/// structure. Both obligations are about a document, and a document alone can
/// say anything. Two properties make it checkable and neither is prose:
///
/// 1. **Every charge names the code that holds it.** A tariff line carries a
///    `(source, reader)` pair, and `reconcile` reads the live number back. A
///    venue that charges something it did not publish is visible to anyone.
/// 2. **Publication precedes effect.** `propose` then `adopt` at the next epoch,
///    following `ParameterRoot`, with `RootWindow` keeping the superseded
///    edition checkable for the grace period. A tariff cannot move retroactively
///    and the operator cannot open its own commitment early.
///
/// ## What is not here
///
/// The prose claims: one order type, no external market data, price then pro
/// rata, no venue halt. Those are bound by `document` and tested in
/// `test/Rulebook.t.sol` against the contracts that would falsify them. Putting
/// them on chain as booleans would add a second thing to keep true.
///
/// ## The zero
///
/// The deployed schedule's `netOperatorTake` is zero, and D-22 is why: the venue
/// prices nothing, and every route to cost recovery reopens a closed decision.
/// The zero is published rather than assumed, so the day it stops being zero is
/// an `Adopted` event with a number in it.
contract Rulebook {
    using RootWindow for RootWindow.Window;

    /// @notice Who bears a charge and who receives it.
    /// @dev `COUNTERPARTY` is another participant: the other side of the trade,
    ///      or whoever performs the work the charge pays for. `NOBODY` is a
    ///      charge the contract retains and no path pays out. The distinction
    ///      that matters to the regulation is `OPERATOR`.
    enum Party {
        NOBODY,
        PARTICIPANT,
        COUNTERPARTY,
        OPERATOR
    }

    /// @param key The charge, named. Strictly ascending across a schedule, so a
    ///        schedule is a set and a duplicate is rejected in the same pass.
    /// @param source The contract holding the number. Zero means the line is a
    ///        published zero with no mechanism behind it.
    /// @param reader A no-argument getter returning `uint256`.
    /// @param refundable Returned to the payer on the ordinary path. A refundable
    ///        charge has no payee.
    struct Charge {
        bytes32 key;
        address source;
        bytes4 reader;
        uint256 amount;
        Party payer;
        Party payee;
        bool refundable;
    }

    bytes32 public constant DOMAIN_EDITION = keccak256("hedera2026.rulebook.edition.v1");
    bytes32 public constant DOMAIN_CHARGE = keccak256("hedera2026.rulebook.charge.v1");

    /// @notice Longest publishable schedule.
    /// @dev A bound on `reconcile`, not on ambition. The check is worth having
    ///      only if anyone can afford to run it, and an unbounded schedule is an
    ///      operator's way to make the public check uncallable while staying
    ///      technically published.
    uint256 public constant MAX_CHARGES = 32;

    /// @notice Gas forwarded to a tariff line's getter.
    /// @dev Bounded for the same reason, one layer down: a source is arbitrary
    ///      code and `reconcile` must terminate against a hostile one. A getter
    ///      that will not answer inside this cannot be adopted, so nothing is
    ///      published that cannot later be checked.
    uint256 public constant READ_GAS = 50_000;

    Regime public immutable regime;
    IEpochClock public immutable clock;

    RootWindow.Window private window;

    /// @notice `DEPTH_ONE_BEHIND`. A trade priced under the superseded edition is
    ///         still checkable against it for the grace period.
    uint8 public constant DEPTH = RootWindow.DEPTH_ONE_BEHIND;
    uint64 public constant GRACE = RootWindow.GRACE;

    /// @notice keccak256 of `docs/RULEBOOK.md`, as adopted.
    bytes32 public document;

    Charge[] private _schedule;
    mapping(bytes32 => uint256) private _slot;

    bytes32 public pendingEdition;
    uint64 public pendingEpoch;

    event Proposed(bytes32 indexed edition, uint64 effectiveEpoch, bytes32 rationale);
    event Adopted(bytes32 indexed edition, uint64 epoch, uint256 count, int256 netOperatorTake);

    error NotOperator();
    error NothingPending();
    error NotYetEffective(uint64 want, uint64 have);
    error EditionMismatch(bytes32 got, bytes32 want);
    error EmptySchedule();
    error ScheduleTooLong(uint256 count, uint256 max);
    error KeysNotAscending(bytes32 previous, bytes32 next);
    error NoDocument();

    /// @notice A charge nobody pays.
    error ChargeHasNoPayer(bytes32 key);
    /// @notice Payer and payee are the same party, so nothing moves.
    error ChargeIsCircular(bytes32 key, Party party);
    /// @notice A refundable charge names a payee. It comes back; it goes nowhere.
    error RefundableChargeHasPayee(bytes32 key, Party payee);
    /// @notice A non-zero amount with no contract behind it. The venue may
    ///         publish a zero it does not charge; it may not publish a number
    ///         nobody can read back.
    error UnsourcedCharge(bytes32 key, uint256 amount);
    error SourceHasNoCode(bytes32 key, address source);
    error SourceHasNoReader(bytes32 key);
    /// @notice The published number is not the number the code charges. Refused
    ///         at adoption and reported by `reconcile` after it.
    error ChargeDoesNotReconcile(bytes32 key, uint256 published, uint256 live);
    /// @notice An amount `netOperatorTake` could not report. The bound is the
    ///         signed maximum divided by `MAX_CHARGES`, so a full schedule of
    ///         them still sums without overflowing and the public read of the
    ///         venue's take always answers.
    error AmountNotRepresentable(bytes32 key, uint256 amount, uint256 max);

    constructor(Regime regime_) {
        regime = regime_;
        clock = regime_.clock();
    }

    // ------------------------------------------------------- the edition

    function edition() external view returns (bytes32) {
        return window.current;
    }

    function previousEdition() external view returns (bytes32) {
        return window.previous;
    }

    function accepts(bytes32 e) external view returns (bool) {
        return window.accepts(e, DEPTH, GRACE);
    }

    function windowClosesAt() external view returns (uint64) {
        return window.closesAt(DEPTH, GRACE);
    }

    /// @notice The commitment to a document and a schedule together.
    /// @dev Pure and public so a participant, the page and this contract cannot
    ///      disagree. One hash over both halves is what makes a tariff amendment
    ///      impossible without moving the document that explains it.
    function editionOf(bytes32 document_, Charge[] calldata schedule)
        public
        pure
        returns (bytes32)
    {
        uint256 n = schedule.length;
        if (n == 0) revert EmptySchedule();
        if (n > MAX_CHARGES) revert ScheduleTooLong(n, MAX_CHARGES);

        bytes32 acc = keccak256(abi.encode(DOMAIN_EDITION, document_, n));
        for (uint256 i = 0; i < n; ++i) {
            Charge calldata c = schedule[i];
            if (i > 0 && c.key <= schedule[i - 1].key) {
                revert KeysNotAscending(schedule[i - 1].key, c.key);
            }
            acc = keccak256(
                abi.encode(
                    DOMAIN_CHARGE,
                    acc,
                    c.key,
                    c.source,
                    c.reader,
                    c.amount,
                    c.payer,
                    c.payee,
                    c.refundable
                )
            );
        }
        return acc;
    }

    // -------------------------------------------------------- governance

    /// @notice Commit to the next edition. Lands at the next epoch.
    /// @dev Proposing the zero edition withdraws a pending one, because `adopt`
    ///      refuses a zero commitment. There is no expiry on a proposal and none
    ///      is needed: a stale edition still has to agree with the code at the
    ///      moment it lands, so one whose sources have since moved cannot be
    ///      adopted at all.
    function propose(bytes32 nextEdition, bytes32 rationale) external {
        if (msg.sender != regime.operator()) revert NotOperator();
        pendingEdition = nextEdition;
        pendingEpoch = clock.currentEpoch() + 1;
        emit Proposed(nextEdition, pendingEpoch, rationale);
    }

    /// @notice Open the committed edition once its epoch has arrived.
    /// @dev Permissionless, following `ParameterRoot.adopt`: if only the operator
    ///      could open its own commitment, the timing would be a second
    ///      discretionary signal. Anyone may call it and only someone holding the
    ///      document and the schedule can, which is what makes the commitment a
    ///      commitment.
    function adopt(bytes32 document_, Charge[] calldata schedule) external {
        if (pendingEdition == bytes32(0)) revert NothingPending();
        uint64 e = clock.currentEpoch();
        if (e < pendingEpoch) revert NotYetEffective(pendingEpoch, e);
        if (document_ == bytes32(0)) revert NoDocument();

        bytes32 got = editionOf(document_, schedule);
        if (got != pendingEdition) revert EditionMismatch(got, pendingEdition);

        // Clear the old index before the array, or a key dropped by this edition
        // keeps pointing into a shorter schedule.
        uint256 old = _schedule.length;
        for (uint256 i = 0; i < old; ++i) {
            _slot[_schedule[i].key] = 0;
        }
        delete _schedule;

        int256 take = 0;
        for (uint256 i = 0; i < schedule.length; ++i) {
            Charge calldata c = schedule[i];
            _validate(c);
            _schedule.push(c);
            _slot[c.key] = i + 1;
            take += _takeOf(c);
        }

        document = document_;
        pendingEdition = bytes32(0);
        window.advance(got);
        emit Adopted(got, e, schedule.length, take);
    }

    /// @dev The rules a line must satisfy to be publishable at all, and the one
    ///      that matters: a sourced line must already agree with its source. A
    ///      schedule that does not reconcile at adoption is a false tariff
    ///      published truthfully, which is the failure this contract exists to
    ///      make impossible.
    function _validate(Charge calldata c) private view {
        if (c.payer == Party.NOBODY) revert ChargeHasNoPayer(c.key);
        uint256 max = uint256(type(int256).max) / MAX_CHARGES;
        if (c.amount > max) revert AmountNotRepresentable(c.key, c.amount, max);
        if (c.payer == c.payee) revert ChargeIsCircular(c.key, c.payer);
        if (c.refundable && c.payee != Party.NOBODY) {
            revert RefundableChargeHasPayee(c.key, c.payee);
        }

        if (c.source == address(0)) {
            if (c.amount != 0) revert UnsourcedCharge(c.key, c.amount);
            return;
        }
        if (c.source.code.length == 0) revert SourceHasNoCode(c.key, c.source);
        if (c.reader == bytes4(0)) revert SourceHasNoReader(c.key);

        (bool ok, uint256 live) = _read(c.source, c.reader);
        if (!ok || live != c.amount) revert ChargeDoesNotReconcile(c.key, c.amount, live);
    }

    // ---------------------------------------------------------- the tariff

    function chargeCount() external view returns (uint256) {
        return _schedule.length;
    }

    function chargeAt(uint256 i) external view returns (Charge memory) {
        return _schedule[i];
    }

    /// @notice The line under `key`, and whether there is one.
    function chargeOf(bytes32 key) external view returns (bool found, Charge memory c) {
        uint256 s = _slot[key];
        if (s == 0) return (false, c);
        return (true, _schedule[s - 1]);
    }

    /// @notice What the operator nets across the whole schedule. Negative is a
    ///         rebate paid by the venue.
    /// @dev The number MiFIR's tariff rule is about. Zero on this deployment.
    function netOperatorTake() external view returns (int256 take) {
        uint256 n = _schedule.length;
        for (uint256 i = 0; i < n; ++i) {
            take += _takeOf(_schedule[i]);
        }
    }

    /// @notice Whether every published charge still equals what the code charges.
    /// @dev Permissionless and cheap. Reports the first divergence rather than a
    ///      bare `false`, because a reader who cannot name the line cannot act on
    ///      the answer. A source that reverts, self-destructs or answers short
    ///      diverges rather than reverting the check: an unreadable tariff is an
    ///      unpublished one, and this fails in that direction on purpose.
    function reconcile()
        external
        view
        returns (bool ok, bytes32 key, uint256 published, uint256 live)
    {
        uint256 n = _schedule.length;
        for (uint256 i = 0; i < n; ++i) {
            Charge storage c = _schedule[i];
            if (c.source == address(0)) {
                // Held to zero at adoption; re-checked here so a future rule
                // change cannot quietly widen what an unsourced line may say.
                if (c.amount != 0) return (false, c.key, c.amount, 0);
                continue;
            }
            (bool got, uint256 v) = _read(c.source, c.reader);
            if (!got || v != c.amount) return (false, c.key, c.amount, v);
        }
        return (true, bytes32(0), 0, 0);
    }

    function _takeOf(Charge memory c) private pure returns (int256) {
        if (c.payee == Party.OPERATOR) return int256(c.amount);
        if (c.payer == Party.OPERATOR) return -int256(c.amount);
        return 0;
    }

    /// @dev A bounded read of an untrusted contract. The return buffer is one
    ///      word, so a source returning megabytes costs this call nothing, and
    ///      the gas is capped so one hostile line cannot exhaust the loop. A
    ///      reply shorter than a word is not a `uint256` and is refused.
    function _read(address source, bytes4 reader) private view returns (bool ok, uint256 v) {
        assembly ("memory-safe") {
            let cd := mload(0x40)
            mstore(cd, reader)
            let out := add(cd, 0x04)
            mstore(out, 0)
            ok := staticcall(READ_GAS, source, cd, 0x04, out, 0x20)
            if ok { if lt(returndatasize(), 0x20) { ok := 0 } }
            v := mload(out)
        }
        if (!ok) v = 0;
    }
}
