// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IHoldByPartition, IHoldTypes} from "../interfaces/IHoldByPartition.sol";
import {RepoMath} from "./RepoMath.sol";
import {DisclosureLattice as L} from "../lattice/DisclosureLattice.sol";
import {IDisclosurePolicy} from "../interfaces/IDisclosurePolicy.sol";
import {DisclosureMeter} from "../lattice/DisclosureMeter.sol";

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
/// ## What this contract does and does not own
///
/// It does not own custody. The open leg is two ATS holds (a design decision), and a hold is
/// an ATS primitive: `createHoldByPartition`, `executeHoldByPartition`,
/// `releaseHoldByPartition`. Clearing was read and rejected, because an earlier measurement found
/// it blocks all direct transfers and an earlier measurement found it is mutually exclusive with
/// holds, so choosing it would forfeit the primitive both legs are built on.
///
/// It does not own eligibility either. Every transfer of the security passes ATS's
/// AND-aggregation over the registered external seams, and seam D is
/// `ZkKycRegistry`. This contract never asks whether a party is eligible, because
/// asking would mean a second answer that could disagree with the first.
///
/// What it owns is the *instrument*: the two legs as one atomic frame, the
/// accrual, the margin state, the manufactured payment, and the default path.
///
/// ## Two disclosure constraints that shape the storage, not just the logic
///
/// **Row 14, position risk.** The mark, the haircut and the maintenance margin
/// together determine the price at which this position gets liquidated. Publishing
/// them hands every observer the borrower's stop. So the mark is stored as a
/// commitment and only the resulting boolean is public. The state transition has
/// to be public, because both parties act on it. The number does not.
///
/// **Row 12, counterparty relationship.** This one is open and it is stated as a
/// limit rather than defended. The close leg settles in the clear against ATS, so
/// settlement discloses the pair, by construction, at `(exact, {pub}, imm)`. The
/// zero-fork ruling is what makes it unavoidable: the disclosure happens inside
/// ATS's transfer, which we do not modify. Closing it needs an order-book-only
/// layer where settlement is netted, which is a design decision and is not v1.
contract RepoVault {
    using RepoMath for uint256;

    enum State {NONE, PROPOSED, OPEN, MARGIN_CALL, MANUFACTURED, FAILING, DEFAULTED, CLOSED}

    /// @notice The economic terms, agreed off chain at `PROPOSED` and fixed at T1.
    /// @dev Grouped into a struct rather than passed flat, because flat it does not
    ///      fit on the EVM stack. That is a real constraint and not a style choice:
    ///      the alternative is `via_ir`, which changes the compilation pipeline for
    ///      the whole project to work around one function signature.
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
        /// @dev Poseidon commitment to the latest mark. Row 14: the number never
        ///      lands in the clear, so the liquidation price cannot be derived by
        ///      an observer who has only the chain.
        bytes32 markCommitment;
        /// @dev Manufactured payment owed by the lender to the borrower. A coupon
        ///      falling due mid-repo is paid by ATS to the holder of record, who
        ///      is the lender, and the lender is not economically entitled to it.
        ///
        ///      **A commitment and not an amount, and the change was forced by
        ///      wiring `_emitUnder` to something.** A manufactured payment is the
        ///      coupon rate times the collateral lot, and the coupon rate is
        ///      public instrument data, so an exact amount here divides out to the
        ///      exact position size. Row 14 gives position `(none, {}, never)`.
        ///      The old `uint256 manufacturedOwed` published it in an event and in
        ///      the struct accessor, and nothing caught it because the check that
        ///      was supposed to catch it was never called.
        bytes32 manufacturedCommitment;
    }

    IHoldByPartition public immutable security;
    address public immutable marginEngine;

    /// @notice CSDR Article 7 cash penalty, hundredths of a basis point per day.
    /// @dev `[DOC]`, and the disposition is `VolumeCap.capBps`'s unchanged: a
    ///      published constant with the derivation named as owed. A close leg
    ///      fails on the **cash** side, and Article 7 prices a cash fail at the
    ///      overnight credit rate of the central bank of issue, floored at zero.
    ///      That is a rate this contract has no oracle for, so it is configured
    ///      and emitted rather than derived. The security-side table, which the
    ///      same field would carry if the failing leg were the collateral, is in
    ///      `RepoMath.BP_HUNDREDTHS`.
    ///
    ///      Zero is a legal setting and means the venue publishes no penalty,
    ///      which the rulebook then has to say.
    uint256 public immutable penaltyRate;

    /// @notice How long a fail runs before default becomes available.
    /// @dev Article 7's escalation is the buy-in, which happens after the
    ///      penalty has run for a period rather than instead of it. This is that
    ///      period. It is why `FAILING` is a state and not a flag: a fail that
    ///      went straight to default would price nothing.
    uint64 public immutable failGrace;

    /// @notice The governed disclosure policy, asked per row.
    /// @dev This replaced `uint32 public immutable ceiling`, and the replacement
    ///      is not a generalisation for its own sake. One ceiling for a contract
    ///      that discloses several different rows has to be set to the most
    ///      permissive row it touches, so it cannot refuse anything that row
    ///      allows. The old value was `(bucket, EOD)`, chosen for the size rows,
    ///      and under it the coupon amount and the settlement price both passed
    ///      unexamined because nothing ever asked.
    IDisclosurePolicy public immutable policy;

    /// @notice Bits spent per row per epoch against the governed coalition
    ///         budget. `DisclosureMeter`, and the reason it is storage rather
    ///         than an immutable is that a budget is a thing you spend.
    DisclosureMeter.Meter private _meter;

    /// @notice The rows of `the build notes` section 7.2 this contract discloses on.
    /// @dev Named rather than inlined because the row is the claim. `_emitUnder`
    ///      enforces the cell; the constant beside each `emit` says which row the
    ///      contract believes it is emitting on, and a reviewer who disagrees with
    ///      the classification is disagreeing with something written down.
    uint16 internal constant ROW_EXEC_PRICE = 5;
    uint16 internal constant ROW_ASSET = 7;
    uint16 internal constant ROW_POSITION = 14;
    uint16 internal constant ROW_CADENCE = 16;

    /// @dev Internal, with an explicit accessor below. The generated getter for a
    ///      fourteen field struct returns fourteen stack values and does not
    ///      compile without `via_ir`, which is a heavier change than writing one
    ///      accessor. Returning the struct in memory also keeps the ABI stable if
    ///      a field is added.
    mapping(bytes32 => Repo) internal repos;

    // -------------------------------------------------------------- events

    event Opened(bytes32 indexed id, uint64 maturity);
    event MarkPosted(bytes32 indexed id, bytes32 commitment);
    /// @dev The boolean and nothing else. Row 14.
    event MarginCalled(bytes32 indexed id, uint64 cureDeadline);
    event Cured(bytes32 indexed id);
    event CouponObserved(bytes32 indexed id, bytes32 commitment);
    event ManufacturedPaid(bytes32 indexed id);
    /// @dev No amount, for `manufacturedCommitment`'s reason. The penalty is
    ///      `value * rate * days`, and rate and days are both public, so an
    ///      amount here divides out to the position. Row 14 gives position
    ///      `(none, {}, never)`. The date is a term of the instrument and was
    ///      already published by `Opened`.
    event Failing(bytes32 indexed id, uint64 intendedAt);
    event Defaulted(bytes32 indexed id);
    /// @dev The predicate and not the price. See `close`.
    event Closed(bytes32 indexed id);
    event DisclosureRefused(bytes32 indexed id, uint16 row, uint32 excess);

    // -------------------------------------------------------------- errors

    error WrongState(State got, State want);
    error NotParty();
    error NotMarginEngine();
    error CureWindowOpen(uint64 until);
    error NothingOwed();
    error NotYetMature(uint64 maturity);
    error FailGraceOpen(uint64 until);
    error SubstitutionRefused();
    error DisclosureExceedsCeiling(uint32 excess);
    error AlreadyExists(bytes32 id);

    constructor(
        IHoldByPartition security_,
        address marginEngine_,
        IDisclosurePolicy policy_,
        uint256 penaltyRate_,
        uint64 failGrace_
    ) {
        if (penaltyRate_ > RepoMath.BP_HUNDREDTHS) {
            revert RepoMath.PenaltyRateTooLarge(penaltyRate_);
        }
        security = security_;
        marginEngine = marginEngine_;
        policy = policy_;
        penaltyRate = penaltyRate_;
        failGrace = failGrace_;
    }

    // ------------------------------------------------------------ T1: open

    /// @notice `PROPOSED -> OPEN`. Both legs in one frame.
    /// @dev an earlier measurement measured that HTS and the EVM share a rollback boundary inside
    ///      one EVM transaction, so an invariant, the close leg moves both legs or
    ///      neither, is bought by keeping them in one frame rather than by a
    ///      two-phase protocol. The same argument applies at open.
    ///
    ///      The cash leg is deliberately not modelled here as a token call. It is
    ///      an HTS transfer of the single cash token an invariant constrains, and the
    ///      integration lives in the deploy script where the token id is known.
    ///      Stubbing it as an interface would invite a mock that settles when the
    ///      real thing would not.
    function open(bytes32 id, address lender, Terms calldata t)
        external
        returns (uint256 principal)
    {
        if (repos[id].state != State.NONE) revert AlreadyExists(id);

        principal = RepoMath.purchasePrice(t.markValue, t.haircutBps);

        // The collateral hold. `escrow` is this contract, so only this contract
        // can execute or release it, and `to` is the lender, so execution at T2
        // or T8 moves the lot to the party the state machine says it moves to.
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

        // Row 7. The maturity is a term of the instrument and it is published
        // the way instrument reference data is published: exactly, at once.
        if (_emitUnder(id, ROW_ASSET, L.G_EXACT, L.T_IMM)) {
            emit Opened(id, r.maturity);
        }
    }

    // ------------------------------------------------------------ T2: close

    /// @notice `OPEN -> CLOSED`. The borrower repurchases.
    /// @dev Failure to deliver is the ordinary case, not an exotic one. If the
    ///      borrower cannot pay, this call simply does not happen, the hold
    ///      expires, an invariant returns the lot to the holder, and the venue reaches
    ///      `DEFAULTED` through T4b rather than `CLOSED`. Any implementation that
    ///      treats T2 as infallible is wrong about the instrument.
    function close(bytes32 id) external returns (uint256 price) {
        Repo storage r = repos[id];
        if (r.state != State.OPEN && r.state != State.FAILING) {
            revert WrongState(r.state, State.OPEN);
        }
        if (msg.sender != r.borrower) revert NotParty();
        if (r.manufacturedCommitment != bytes32(0)) revert NothingOwed();

        // **The penalty runs from maturity and not from the declaration.** If it
        // keyed off `FAILING` the borrower would simply close late without ever
        // being marked, and a charge nobody triggers is not a charge. It also
        // covers the one path `markFailing` cannot reach, a repo sitting in
        // `MANUFACTURED` when maturity passes.
        //
        // Interest accrues over the fail as well. A failing borrower pays both,
        // which is the conservative direction and is stated because the
        // alternative, freezing the accrual at maturity, is also defensible.
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
        // Row 14, and the price is deliberately not in the event.
        //
        // Section 7.2 gives execution price `(exact, {pub}, +15m)`, and the
        // obvious build is a deferred publication: emit the predicate now, open
        // the price after fifteen minutes. **That mechanism cannot work here, and
        // wiring this check is what proved it.** The repurchase price is
        // `RepoMath.repurchasePrice` over `principal`, `repoRateBps` and
        // `openedAt`, and all three are returned in the clear by `repo(id)`. So
        // the exact settlement price of every open repo is computable by anyone,
        // for every future timestamp, at the moment the repo opens. That is
        // `docs/manipulation-surface.md` MA-01, and a fifteen minute deferral of
        // a number the public already holds is theatre.
        //
        // **And deleting the getter does not buy the deferral back.** This
        // comment first said row 5 was unreachable here only until the struct
        // accessor was dealt with, which understates it three ways.
        // `repurchasePriceNow(id)` hands over the settlement price directly, so
        // an observer watching for `Closed` and calling it in the same block
        // never touches the struct. Delete that accessor too and `open` still
        // takes `Terms calldata`: `repoRateBps` is in it verbatim, `principal`
        // is `purchasePrice(markValue, haircutBps)` over two more of its fields,
        // and `openedAt` is that transaction's timestamp. The ledger keeps that
        // calldata whatever this contract exposes.
        //
        // So this is `OrderBook`'s rows 3 and 4 collapse arriving one contract
        // early: a contract that can read a number is a contract whose calldata
        // anyone can read, `{ven}` and `{pub}` are one set, and the deferral has
        // nothing to defer from. The event carries the predicate, which is
        // honest, and row 5 is unreachable for this leg on this ledger as a
        // stated limit rather than as a pending change. MA-01 and the row 5
        // deferral are one defect and not two, which is the finding.
        if (_emitUnder(id, ROW_POSITION, L.G_PRED, L.T_IMM)) {
            emit Closed(id);
        }
    }

    // ------------------------------------------------------------- T3: mark

    /// @notice `OPEN -> MARGIN_CALL`, or a quiet re-mark.
    /// @dev Row 14 in one signature. The engine posts a commitment to the mark and
    ///      the boolean it implies. The boolean has to be public because both
    ///      parties act on it and a private margin call is not a margin call. The
    ///      number does not, and publishing it would hand every observer the
    ///      borrower's liquidation price, which is the marketplace study's `liquidationPx`
    ///      arriving on our own venue.
    ///
    ///      What this buys and what it does not: an observer learns that the
    ///      position crossed a threshold, which is one bit, and not where the
    ///      threshold is. Under `DisclosureBudget` that is exactly one bit per
    ///      mark, which is why the margin engine's call frequency is itself a
    ///      budgeted disclosure and not a free operation.
    function postMark(bytes32 id, bytes32 commitment, bool breach, uint64 cureWindow)
        external
    {
        if (msg.sender != marginEngine) revert NotMarginEngine();
        Repo storage r = repos[id];
        if (r.state != State.OPEN && r.state != State.MARGIN_CALL) {
            revert WrongState(r.state, State.OPEN);
        }

        r.markCommitment = commitment;
        // Row 16, at `(exact, imm)`, and that is the unsolved row rather than a
        // convenient one. The commitment discloses nothing about the mark. The
        // *timing* discloses that this repo was marked, now, and marking is
        // daily, so the sequence is a cadence fingerprint. Row 16 is carried as
        // an open limit in section 7.2 and this is where it is incurred.
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
    /// @dev **The transition the state machine did not have.** `maturity` was
    ///      written, emitted by `Opened`, and never read again: `close` had no
    ///      maturity check, and the only route to `DEFAULTED` ran through
    ///      `MARGIN_CALL`, which needs the margin engine to post a breaching
    ///      mark. So a borrower who simply never closed left the repo `OPEN`
    ///      indefinitely and the lender had no remedy unless the collateral
    ///      happened to move. The comment on `close` asserting the venue reaches
    ///      `DEFAULTED` through T4b was describing a path that did not exist
    ///      from here.
    ///
    ///      Permissionless, and the reason is sharper than `declareDefault`'s.
    ///      The party who would decline to record a fail is the one whose fail
    ///      it is, because the grace clock that ends in default starts here.
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
    /// @dev A view and never an event. `repurchasePriceNow` already hands over
    ///      the settlement price, so this discloses nothing the ledger does not
    ///      hold, and the event stream is the surface `_emitUnder` governs.
    function settlementPenaltyNow(bytes32 id) external view returns (uint256) {
        return _penaltyOf(repos[id], block.timestamp);
    }

    /// @dev Reference value is what was owed **at maturity**, the cash that
    ///      failed to arrive. It does not grow with the fail; the accrual does
    ///      that, separately.
    function _penaltyOf(Repo storage r, uint256 at) private view returns (uint256) {
        if (r.maturity == 0 || at <= r.maturity) return 0;
        uint256 owed =
            RepoMath.repurchasePrice(r.principal, r.repoRateBps, r.openedAt, r.maturity);
        return RepoMath.settlementPenalty(owed, penaltyRate, r.maturity, at);
    }

    /// @notice `MARGIN_CALL -> DEFAULTED`, or `FAILING -> DEFAULTED`.
    /// @dev Permissionless, so the lender is not the sole trigger. A default that
    ///      only the lender can declare is a default the lender can decline to
    ///      declare, and the borrower has no way to force resolution.
    ///
    ///      Two entries and two clocks. Article 7's escalation is the buy-in,
    ///      which follows the penalty rather than replacing it, so the fail runs
    ///      for `failGrace` while the charge accrues and only then becomes a
    ///      default. That is the whole reason `FAILING` is a state: a fail sent
    ///      straight to `DEFAULTED` prices nothing.
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
    /// @dev The transition that proves the design understands the instrument.
    ///      Title passed at T1, so ATS's coupon facet pays the holder of record,
    ///      who is the lender. The lender is not economically entitled to it. Our
    ///      contract cannot change who ATS pays, because changing it would mean
    ///      forking ATS and a design decision forbids that. So the venue records the obligation
    ///      and settles it as a transfer, which is T6.
    /// @param commitment A commitment to the amount, not the amount. See the
    ///        `manufacturedCommitment` field: the cleartext amount divided out to
    ///        the exact position size, which row 14 puts at `(none, {}, never)`.
    /// @dev Only one coupon may be outstanding, because the state machine already
    ///      says so: this requires `OPEN` and leaves `MANUFACTURED`. That is why a
    ///      single commitment replaces the accumulator without losing anything. A
    ///      second coupon before pay-through is refused by the state check rather
    ///      than silently summed, which is the better behaviour anyway.
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
    /// @dev Substitution swaps one eligible collateral lot for another mid-term.
    ///      It is standard in production repo and it is out of scope here for one
    ///      reason: it requires an eligibility schedule, which is a second
    ///      compliance surface with its own disclosure rows, and the matrix has
    ///      not been extended to cover it. Shipping it undocumented would be worse
    ///      than refusing it.
    function substitute(bytes32) external pure {
        revert SubstitutionRefused();
    }

    // ---------------------------------------------------------- T8: liquidation

    /// @notice `DEFAULTED -> CLOSED`. The auction settles.
    /// @dev The winner is decided by `SealedAuction`, which is the only caller
    ///      that can name one. Shortfall is recorded rather than pursued: this
    ///      contract has no claim on anything outside the collateral.
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
        // Row 14, and the proceeds are not in the event for the same reason the
        // repurchase price is not. An auction clearing price is an execution
        // price under row 5, and row 5 wants `+15m`.
        if (_emitUnder(id, ROW_POSITION, L.G_PRED, L.T_IMM)) {
            emit Closed(id);
        }
    }

    // ------------------------------------------------------------- helpers

    /// @notice Every event this contract emits passes through here.
    ///
    /// @dev **The previous version of this comment said the same thing and it was
    ///      false.** `_emitUnder` was called by nothing. The contract had nine
    ///      disclosing `emit` statements and not one of them reached this
    ///      function, so the ceiling was a stored constant that no execution path
    ///      ever read, and `wouldDisclose` answered questions about a value the
    ///      contract did not use. That is `docs/manipulation-surface.md` MA-03 and
    ///      it is closed here. It is recorded rather than quietly deleted because
    ///      a check that is documented as enforced and is not is worse than no
    ///      check: it is what made every other disclosure in this file look
    ///      examined.
    ///
    ///      Scope, stated because the fix is narrower than the claim it replaces.
    ///      This covers **events**. It does not cover storage, and `repo(id)`
    ///      returns fourteen fields in the clear to any caller. A public getter
    ///      is neither an event nor a transaction, so MA-01 lives in that gap and
    ///      is not closed by anything in this file.
    ///
    ///      It does not only live there, and reading it as a getter problem is
    ///      what made row 5 look reachable at T2. Rule 1 is about what appears in
    ///      a transaction body, and `open` takes its terms as `Terms calldata`,
    ///      so the inputs to the liquidation threshold are in a transaction body
    ///      too. No change to this contract's accessors reaches them.
    ///      **The budget half, added with `DisclosureMeter`.** The ceiling asks
    ///      whether the venue may say this; the meter asks whether it can still
    ///      afford to. The two failure modes are deliberately different. A
    ///      ceiling breach is a configuration error and reverts, because a
    ///      contract disclosing above its published ceiling should not be allowed
    ///      to continue. An exhausted budget is the mechanism working, so the
    ///      disclosure is withheld and the transition completes. Rule A in
    ///      `DisclosureMeter`, and it is `SeamJournal`'s rule adopted unchanged:
    ///      a repurchase must not fail because the venue has run out of things it
    ///      may say.
    ///
    ///      Row 14 is the row this actually binds. It is disclosed at
    ///      `(pred, imm)` from seven call sites, and the comment on `postMark`
    ///      already claimed the margin engine's call frequency was "itself a
    ///      budgeted disclosure and not a free operation". Until this function
    ///      read a budget, that sentence was false in the same way the sentence
    ///      above it was: true of the design, and true of nothing running.
    /// @return afforded Whether the caller should emit. False means the row's
    ///         epoch budget is spent and the event is withheld.
    function _emitUnder(bytes32 id, uint16 row, uint8 g, uint8 t)
        internal
        returns (bool afforded)
    {
        uint32 actual = L.point(g, t);
        uint32 over = L.excess(policy.ceilingFor(row), actual);
        if (over != 0) {
            emit DisclosureRefused(id, row, over);
            revert DisclosureExceedsCeiling(over);
        }
        return DisclosureMeter.spend(_meter, policy, row, g);
    }

    /// @notice Bits spent against a row's coalition budget in an epoch.
    /// @dev The supervisor's read. A row silenced by an exhausted budget and a
    ///      row nobody disclosed on look identical in the event stream, by
    ///      construction, so the difference has to be a view.
    function spentBits(uint16 row, uint64 epoch) external view returns (uint32) {
        return DisclosureMeter.spentBits(_meter, row, epoch);
    }

    /// @notice Whether a disclosure at `g` on `row` would still be afforded.
    function wouldAfford(uint16 row, uint8 g) external view returns (bool) {
        return DisclosureMeter.wouldAfford(_meter, policy, row, g);
    }

    /// @notice How many disclosures at `g` exhaust `row`. Zero when unmetered.
    function breakingSize(uint16 row, uint8 g) external view returns (uint256) {
        return DisclosureMeter.breakingSize(policy, row, g);
    }

    /// @notice Public so tests and the deploy script can ask the same question the
    ///         contract asks itself.
    function wouldDisclose(uint16 row, uint8 g, uint8 t) external view returns (bool) {
        return L.permits(policy.ceilingFor(row), L.point(g, t));
    }

    /// @notice The ceiling in force for one row, after the regime's narrowing.
    function ceilingFor(uint16 row) external view returns (uint32) {
        return policy.ceilingFor(row);
    }

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
