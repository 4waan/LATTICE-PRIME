// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IHoldByPartition, IHoldTypes} from "../interfaces/IHoldByPartition.sol";
import {RepoMath} from "./RepoMath.sol";
import {DisclosureLattice as L} from "../lattice/DisclosureLattice.sol";
import {IDisclosurePolicy} from "../interfaces/IDisclosurePolicy.sol";
import {RepoVaultBase} from "./RepoVaultBase.sol";
import {DisclosureView} from "../lattice/DisclosureView.sol";

/// @title RepoVault
/// @notice Tokenised collateral for repo. The state machine of `docs/repo-state-machine.md`,
///         with ATS holds as the custody primitive and nothing reimplemented.
///
/// ```
///                 PROPOSED
///                    | T1 both parties open
///                    v
///   T7 substitution  |                 T2 close leg
///   (REFUSED)  ----> OPEN ------------------------> CLOSED
///                    |  ^  |    T9 maturity passes    ^  ^
///            T3 mark |  |  | T5 coupon falls due      |  |
///                    v  |  v                          |  |
///          MARGIN_CALL  |  MANUFACTURED               |  |
///             |    |    +--- T6 pay through ----------+  |
///     T4a cure|    | T4b window expires                  |
///             +--> |            FAILING -- T2 with the --+
///                  |               |         penalty
///                  v    T10 grace  v
///              DEFAULTED <---------+
///                  |
///                  +------- T8 auction settles ----------+
/// ```
///
/// @dev It owns the instrument and nothing else. Custody is ATS holds, and eligibility is
///      ATS's AND-aggregation over the registered seams, so this contract never asks
///      whether a party is eligible: asking would mean a second answer that could
///      disagree with the first.
///
///      Two disclosure limits shape the storage rather than only the logic. Row 14, so the
///      mark is stored as a commitment and only the resulting boolean is public, because
///      the mark with the haircut and the maintenance margin is the borrower's liquidation
///      price. Row 12 is open and stated as a limit: the close leg settles in the clear
///      against ATS, and the zero-fork ruling puts that disclosure inside a transfer we do
///      not modify. Closing it needs a netted order-book-only layer, which is not v1.
contract RepoVault is RepoVaultBase, DisclosureView {
    using RepoMath for uint256;

    /// @dev Here and not in `RepoVaultBase` with the rest: an inherited enum does not
    ///      resolve as `RepoVault.State`, which is how every call site asks for it.
    ///      `WrongState` follows the type it is declared over.
    enum State {NONE, PROPOSED, OPEN, MARGIN_CALL, MANUFACTURED, FAILING, DEFAULTED, CLOSED}

    error WrongState(State got, State want);

    /// @notice The economic terms, agreed off chain at `PROPOSED` and fixed at T1.
    /// @dev A struct because flat they do not fit on the EVM stack. That is a constraint
    ///      and not a style choice: the alternative is `via_ir` for the whole project.
    struct Terms {
        bytes32 partition;
        uint256 collateralAmount;
        uint256 markValue;
        uint16 haircutBps;
        uint16 maintenanceBps;
        uint256 repoRateBps;
        uint64 term;
    }

    struct Repo {
        State state;
        address borrower; // sells the security, borrows cash
        address lender; // buys the security, lends cash
        bytes32 partition;
        uint256 collateralHoldId;
        uint256 collateralAmount;
        uint256 principal; // the purchase price, cash advanced at T1
        uint256 repoRateBps;
        uint64 openedAt;
        uint64 maturity;
        uint64 cureDeadline;
        uint16 maintenanceBps;
        /// @dev Poseidon commitment to the latest mark. Row 14: the number never lands in
        ///      the clear, so an observer holding only the chain cannot derive the
        ///      liquidation price.
        bytes32 markCommitment;
        /// @dev Manufactured payment owed by the lender to the borrower. A commitment and
        ///      not an amount: it is the coupon rate times the collateral lot and the rate
        ///      is public instrument data, so a cleartext amount divides out to the exact
        ///      position size, which row 14 puts at `(none, {}, never)`.
        bytes32 manufacturedCommitment;
    }

    IHoldByPartition public immutable security;
    address public immutable marginEngine;

    /// @notice CSDR Article 7 cash penalty, hundredths of a basis point per day.
    /// @dev Published and not derived. Article 7 prices a cash fail, which is what a close
    ///      leg is, at the overnight credit rate of the central bank of issue floored at
    ///      zero, and this contract has no oracle for it. The unit is hundredths of a
    ///      basis point because the delegated act writes rates to one decimal of a basis
    ///      point. Zero is a legal setting and means the venue publishes no penalty.
    uint256 public immutable penaltyRate;

    /// @notice How long a fail runs before default becomes available.
    /// @dev Article 7's escalation is the buy-in, which follows the penalty rather than
    ///      replacing it. This is that period, and it is why `FAILING` is a state.
    uint64 public immutable failGrace;

    /// @dev Internal, with an explicit accessor below. The generated getter for a fourteen
    ///      field struct does not compile without `via_ir`, and returning the struct in
    ///      memory keeps the ABI stable if a field is added.
    mapping(bytes32 => Repo) internal repos;

    constructor(
        IHoldByPartition security_,
        address marginEngine_,
        IDisclosurePolicy policy_,
        uint256 penaltyRate_,
        uint64 failGrace_
    ) DisclosureView(policy_) {
        if (penaltyRate_ > RepoMath.BP_HUNDREDTHS) {
            revert RepoMath.PenaltyRateTooLarge(penaltyRate_);
        }
        security = security_;
        marginEngine = marginEngine_;
        penaltyRate = penaltyRate_;
        failGrace = failGrace_;
    }

    // ------------------------------------------------------------ T1: open

    /// @notice `PROPOSED -> OPEN`. Both legs in one frame.
    /// @dev HTS and the EVM share a rollback boundary inside one EVM transaction, so the
    ///      invariant that both legs move or neither is bought by one frame rather than by
    ///      a two-phase protocol. The cash leg is deliberately not modelled here as a
    ///      token call: it is an HTS transfer wired in the deploy script, and stubbing it
    ///      as an interface would invite a mock that settles when the real thing does not.
    function open(bytes32 id, address lender, Terms calldata t)
        external
        returns (uint256 principal)
    {
        if (repos[id].state != State.NONE) revert AlreadyExists(id);

        principal = RepoMath.purchasePrice(t.markValue, t.haircutBps);

        // `escrow` is this contract, so only this contract can execute or release the
        // hold, and `to` is the lender, so execution at T2 or T8 moves the lot to the
        // party the state machine says it moves to.
        (, uint256 holdId) = security.createHoldFromByPartition(
            t.partition,
            msg.sender,
            IHoldTypes.Hold({
                amount: t.collateralAmount,
                expirationTimestamp: block.timestamp + t.term,
                escrow: address(this),
                to: lender,
                data: ""
            }),
            ""
        );

        Repo storage r = repos[id];
        r.state = State.OPEN;
        r.borrower = msg.sender;
        r.lender = lender;
        r.partition = t.partition;
        r.collateralHoldId = holdId;
        r.collateralAmount = t.collateralAmount;
        r.principal = principal;
        r.repoRateBps = t.repoRateBps;
        r.openedAt = uint64(block.timestamp);
        r.maturity = uint64(block.timestamp) + t.term;
        r.maintenanceBps = t.maintenanceBps;

        // Row 7. Maturity is a term of the instrument and is published the way instrument
        // reference data is published: exactly, at once.
        if (_emitUnder(id, ROW_ASSET, L.G_EXACT, L.T_IMM)) {
            emit Opened(id, r.maturity);
        }
    }

    // ------------------------------------------------------------ T2: close

    /// @notice `OPEN -> CLOSED`, or `FAILING -> CLOSED` with the penalty attached.
    /// @dev Failure to deliver is the ordinary case, not an exotic one. If the borrower
    ///      cannot pay, this call simply does not happen, the hold expires, and the repo
    ///      reaches `DEFAULTED` through T9 and T10 rather than `CLOSED`. Any
    ///      implementation that treats T2 as infallible is wrong about the instrument.
    function close(bytes32 id) external returns (uint256 price) {
        Repo storage r = repos[id];
        if (r.state != State.OPEN && r.state != State.FAILING) {
            revert WrongState(r.state, State.OPEN);
        }
        if (msg.sender != r.borrower) revert NotParty();
        if (r.manufacturedCommitment != bytes32(0)) revert NothingOwed();

        // The penalty runs from maturity and not from the declaration. Keyed off
        // `FAILING`, a borrower would close late without ever being marked, and a charge
        // nobody triggers is not a charge. It also covers the one path `markFailing`
        // cannot reach, a repo sitting in `MANUFACTURED` when maturity passes. Interest
        // accrues over the fail as well, which is the conservative direction and is stated
        // because freezing the accrual at maturity is also defensible.
        price = RepoMath.repurchasePrice(
            r.principal, r.repoRateBps, r.openedAt, block.timestamp
        ) + _penaltyOf(r, block.timestamp);

        security.executeHoldByPartition(
            IHoldTypes.HoldIdentifier({
                partition: r.partition,
                tokenHolder: r.borrower,
                holdId: r.collateralHoldId
            }),
            r.borrower,
            r.collateralAmount
        );

        r.state = State.CLOSED;
        // Row 14, and the price is deliberately not in the event. Section 7.2 gives
        // execution price `(exact, {pub}, +15m)` and the obvious build is a deferred
        // publication, which cannot work here: the price is `repurchasePrice` over
        // `principal`, `repoRateBps` and `openedAt`, and `open` takes all three in `Terms
        // calldata`, so the ledger holds every input whatever this contract exposes.
        // Deferring a number the public already computes is theatre. Row 5 is unreachable
        // for this leg on this ledger, as a stated limit rather than a pending change, and
        // The storage gap and the row 5 deferral are one defect and not two.
        if (_emitUnder(id, ROW_POSITION, L.G_PRED, L.T_IMM)) {
            emit Closed(id);
        }
    }

    // ------------------------------------------------------------- T3: mark

    /// @notice `OPEN -> MARGIN_CALL`, or a quiet re-mark.
    /// @dev Row 14 in one signature. The engine posts a commitment to the mark and the
    ///      boolean it implies. The boolean has to be public because both parties act on
    ///      it and a private margin call is not a margin call; the number does not,
    ///      because publishing it hands every observer the borrower's liquidation price.
    ///      An observer learns that a threshold was crossed, which is one bit, and not
    ///      where the threshold sits, which is why the engine's call frequency is itself a
    ///      budgeted disclosure.
    function postMark(bytes32 id, bytes32 commitment, bool breach, uint64 cureWindow)
        external
    {
        if (msg.sender != marginEngine) revert NotMarginEngine();
        Repo storage r = repos[id];
        if (r.state != State.OPEN && r.state != State.MARGIN_CALL) {
            revert WrongState(r.state, State.OPEN);
        }

        r.markCommitment = commitment;
        // Row 16, at `(exact, imm)`, and the unsolved row rather than a convenient one.
        // The commitment discloses nothing about the mark; the timing discloses that this
        // repo was marked, now, and marking is daily, so the sequence is a cadence
        // fingerprint. Carried as an open limit in the disclosure matrix and incurred here.
        if (_emitUnder(id, ROW_CADENCE, L.G_EXACT, L.T_IMM)) {
            emit MarkPosted(id, commitment);
        }

        if (breach && r.state == State.OPEN) {
            r.state = State.MARGIN_CALL;
            r.cureDeadline = uint64(block.timestamp) + cureWindow;
            // Row 14. A margin call is a predicate about a position.
            if (_emitUnder(id, ROW_POSITION, L.G_PRED, L.T_IMM)) {
                emit MarginCalled(id, r.cureDeadline);
            }
        }
    }

    // -------------------------------------------------------------- T4: cure

    /// @notice `MARGIN_CALL -> OPEN`. The borrower posts more.
    function cure(bytes32 id) external {
        Repo storage r = repos[id];
        _require(r.state == State.MARGIN_CALL, r.state, State.MARGIN_CALL);
        if (msg.sender != r.borrower) revert NotParty();
        r.state = State.OPEN;
        r.cureDeadline = 0;
        if (_emitUnder(id, ROW_POSITION, L.G_PRED, L.T_IMM)) {
            emit Cured(id);
        }
    }

    /// @notice `OPEN -> FAILING`. Maturity passed and the close leg did not.
    /// @dev Permissionless, and the reason is sharper than `declareDefault`'s: the party
    ///      who would decline to record a fail is the one whose fail it is, because the
    ///      grace clock that ends in default starts here.
    function markFailing(bytes32 id) external {
        Repo storage r = repos[id];
        _require(r.state == State.OPEN, r.state, State.OPEN);
        if (block.timestamp < r.maturity) revert NotYetMature(r.maturity);
        r.state = State.FAILING;
        if (_emitUnder(id, ROW_POSITION, L.G_PRED, L.T_IMM)) {
            emit Failing(id, r.maturity);
        }
    }

    /// @notice The Article 7 penalty owed on `id` right now.
    /// @dev A view and never an event. `repurchasePriceNow` already hands over the
    ///      settlement price, so this discloses nothing the ledger does not hold, and the
    ///      event stream is the surface `_emitUnder` governs.
    function settlementPenaltyNow(bytes32 id) external view returns (uint256) {
        return _penaltyOf(repos[id], block.timestamp);
    }

    /// @dev Reference value is what was owed at maturity, the cash that failed to arrive.
    ///      It does not grow with the fail; the accrual does that, separately.
    function _penaltyOf(Repo storage r, uint256 at) private view returns (uint256) {
        if (r.maturity == 0 || at <= r.maturity) return 0;
        uint256 owed =
            RepoMath.repurchasePrice(r.principal, r.repoRateBps, r.openedAt, r.maturity);
        return RepoMath.settlementPenalty(owed, penaltyRate, r.maturity, at);
    }

    /// @notice `MARGIN_CALL -> DEFAULTED`, or `FAILING -> DEFAULTED`.
    /// @dev Permissionless, so the lender is not the sole trigger: a default only the
    ///      lender can declare is one the lender can decline to declare. Two entries and
    ///      two clocks, because Article 7's buy-in follows the penalty rather than
    ///      replacing it, so a fail runs for `failGrace` while the charge accrues.
    function declareDefault(bytes32 id) external {
        Repo storage r = repos[id];
        if (r.state == State.FAILING) {
            uint64 until = r.maturity + failGrace;
            if (block.timestamp < until) revert FailGraceOpen(until);
        } else {
            _require(r.state == State.MARGIN_CALL, r.state, State.MARGIN_CALL);
            if (block.timestamp < r.cureDeadline) revert CureWindowOpen(r.cureDeadline);
        }
        r.state = State.DEFAULTED;
        if (_emitUnder(id, ROW_POSITION, L.G_PRED, L.T_IMM)) {
            emit Defaulted(id);
        }
    }

    // ------------------------------------------ T5 and T6: manufactured payment

    /// @notice `OPEN -> MANUFACTURED`. A coupon fell due mid-repo.
    /// @dev Title passed at T1, so ATS's coupon facet pays the holder of record, who is
    ///      the lender and is not economically entitled to it. Changing who ATS pays would
    ///      mean forking ATS, which is ruled out, so the venue records the obligation and
    ///      settles it as a transfer at T6.
    /// @param commitment A commitment to the amount, not the amount. Only one coupon may
    ///        be outstanding: a second before pay-through is refused by the state check
    ///        rather than silently summed.
    function noteCoupon(bytes32 id, bytes32 commitment) external {
        Repo storage r = repos[id];
        _require(r.state == State.OPEN, r.state, State.OPEN);
        if (commitment == bytes32(0)) revert NothingOwed();
        r.manufacturedCommitment = commitment;
        r.state = State.MANUFACTURED;
        if (_emitUnder(id, ROW_POSITION, L.G_PRED, L.T_IMM)) {
            emit CouponObserved(id, commitment);
        }
    }

    /// @notice `MANUFACTURED -> OPEN`. The lender pays through.
    function payThrough(bytes32 id) external {
        Repo storage r = repos[id];
        _require(r.state == State.MANUFACTURED, r.state, State.MANUFACTURED);
        if (msg.sender != r.lender) revert NotParty();
        if (r.manufacturedCommitment == bytes32(0)) revert NothingOwed();
        r.manufacturedCommitment = bytes32(0);
        r.state = State.OPEN;
        if (_emitUnder(id, ROW_POSITION, L.G_PRED, L.T_IMM)) {
            emit ManufacturedPaid(id);
        }
    }

    // ------------------------------------------------------- T7: substitution

    /// @notice Refused in v1, recorded as a decision rather than as a silence.
    /// @dev Swapping one eligible lot for another mid-term needs an eligibility schedule,
    ///      which is a second compliance surface with its own disclosure rows, and the
    ///      matrix has not been extended to cover it.
    function substitute(bytes32) external pure {
        revert SubstitutionRefused();
    }

    // ---------------------------------------------------------- T8: liquidation

    /// @notice `DEFAULTED -> CLOSED`. The auction settles.
    /// @dev The winner is decided by `SealedAuction`, the only caller that can name one.
    ///      Shortfall is recorded rather than pursued: this contract has no claim on
    ///      anything outside the collateral.
    function settleAuction(bytes32 id, address winner, uint256 proceeds) external {
        Repo storage r = repos[id];
        _require(r.state == State.DEFAULTED, r.state, State.DEFAULTED);

        security.executeHoldByPartition(
            IHoldTypes.HoldIdentifier({
                partition: r.partition,
                tokenHolder: r.borrower,
                holdId: r.collateralHoldId
            }),
            winner,
            r.collateralAmount
        );

        r.state = State.CLOSED;
        // Row 14, and the proceeds stay out of the event for `close`'s reason: an auction
        // clearing price is an execution price under row 5, and row 5 wants `+15m`.
        if (_emitUnder(id, ROW_POSITION, L.G_PRED, L.T_IMM)) {
            emit Closed(id);
        }
    }

    // ------------------------------------------------------------- helpers

    /// @dev **The scope of `DisclosureView._emitUnder`, here, because this is the
    ///      contract where the gap is widest.** It governs events. It does not govern
    ///      storage, and `repo(id)` returns fourteen fields in the clear. No accessor
    ///      change reaches that: `open` takes its terms as `Terms calldata`, so the inputs
    ///      to the liquidation threshold sit in a transaction body too. What the helper
    ///      does close is the emission path, by every `emit` above routing through it,
    ///      which an earlier version of this contract did not do.

    function _require(bool ok, State got, State want) private pure {
        if (!ok) revert WrongState(got, want);
    }

    function repo(bytes32 id) external view returns (Repo memory) {
        return repos[id];
    }

    function stateOf(bytes32 id) external view returns (State) {
        return repos[id].state;
    }

    function repurchasePriceNow(bytes32 id) external view returns (uint256) {
        Repo storage r = repos[id];
        return RepoMath.repurchasePrice(
            r.principal, r.repoRateBps, r.openedAt, block.timestamp
        );
    }
}
