// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IHoldByPartition, IHoldTypes} from "../interfaces/IHoldByPartition.sol";
import {RepoMath} from "./RepoMath.sol";
import {DisclosureLattice as L} from "../lattice/DisclosureLattice.sol";
import {IDisclosurePolicy} from "../interfaces/IDisclosurePolicy.sol";
import {RepoVaultBase} from "./RepoVaultBase.sol";
import {DisclosureView} from "../lattice/DisclosureView.sol";
import {IPrimeOracle} from "../interfaces/IPrimeOracle.sol";
import {ICouponSchedule} from "../interfaces/ICouponSchedule.sol";

/// @title RepoVault
/// @notice Tokenised repo on ATS holds. Instrument only; eligibility is ATS's.
/// @dev Row 14: mark is a commitment, public event is a boolean. Row 12 is
///      stated: close settles in the clear inside ATS. HTS and EVM share one
///      rollback boundary, so both legs move or neither.
contract RepoVault is RepoVaultBase, DisclosureView {
    using RepoMath for uint256;

    /// @dev Here and not in `RepoVaultBase` with the rest: an inherited enum does not
    ///      resolve as `RepoVault.State`, which is how every call site asks for it.
    ///      `WrongState` follows the type it is declared over.
    enum State {
        NONE,
        PROPOSED,
        OPEN,
        MARGIN_CALL,
        MANUFACTURED,
        FAILING,
        DEFAULTED,
        CLOSED
    }

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

    /// @notice The seat that may post a mark by hand. Open only when the feed is dark.
    /// @dev Kept, and kept as an address, because a feed that goes dark must not
    ///      freeze the repo book. What changed is that it is no longer the
    ///      *only* way a mark reaches this contract, and `postMark` now refuses
    ///      while `oracle.stale()` is false, so the discretionary seat cannot be
    ///      used to overrule a live price.
    address public immutable marginEngine;

    /// @notice The price feed. `src/oracle/PrimeOracle.sol`.
    /// @dev Immutable and required. A vault constructed without one is a vault
    ///      whose only mark is an account's word, which is the arrangement this
    ///      contract was built to end.
    IPrimeOracle public immutable oracle;

    /// @notice The bond's coupon calendar. `src/coupon/CouponSchedule.sol`.
    /// @dev Immutable and required, for the reason `oracle` is. A vault
    ///      constructed without one is a vault whose only account of when a
    ///      coupon fell due is whatever the caller of `noteCoupon` said, which
    ///      is the arrangement this seat was added to end.
    ///
    ///      It is a seat and not a governed one, which is the single place this
    ///      venue does not reach for its own propose-and-adopt idiom. An
    ///      operator who could reseat the calendar could move the date a payment
    ///      became due on a bond somebody had already bought.
    ///      `CouponSchedule`'s header carries the whole argument and the cost.
    ICouponSchedule public immutable schedule;

    /// @notice How long a borrower has to cure a call raised by `markToMarket`.
    /// @dev A published constant rather than an argument, because `markToMarket`
    ///      is permissionless. If the caller chose the window, anyone could call
    ///      a position with a window of zero and declare it in default in the
    ///      next block. `postMark` keeps its argument: that seat is held by a
    ///      named address, and narrowing it would change a path this venue's
    ///      existing evidence was produced against.
    uint64 public immutable cureWindow;

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

    /// @notice Which coupons this repo has already had noted against it.
    /// @dev A mapping and not a field on `Repo`, so `repo(id)` keeps the shape every
    ///      client and `tools/venue-obs.mjs` already decode. It is what makes
    ///      `noteCoupon` idempotent per coupon rather than per repo, which is the
    ///      property a scheduled call needs. See there.
    mapping(bytes32 => mapping(uint256 => bool)) public notedCoupon;

    /// @dev Domain tag on the manufactured payment commitment. Separate from every tree
    ///      tag in `src/merkle`, because a commitment and a merkle leaf that shared one
    ///      would be candidate preimages for each other.
    bytes32 public constant DOMAIN_MANUFACTURED = keccak256("hedera2026.repo.manufactured.v1");

    constructor(
        IHoldByPartition security_,
        address marginEngine_,
        IPrimeOracle oracle_,
        ICouponSchedule schedule_,
        IDisclosurePolicy policy_,
        uint256 penaltyRate_,
        uint64 failGrace_,
        uint64 cureWindow_
    ) DisclosureView(policy_) {
        if (penaltyRate_ > RepoMath.BP_HUNDREDTHS) {
            revert RepoMath.PenaltyRateTooLarge(penaltyRate_);
        }
        if (address(oracle_) == address(0)) revert NoFeed();
        if (address(schedule_) == address(0)) revert NoSchedule();
        security = security_;
        marginEngine = marginEngine_;
        oracle = oracle_;
        schedule = schedule_;
        penaltyRate = penaltyRate_;
        failGrace = failGrace_;
        cureWindow = cureWindow_;
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
                partition: r.partition, tokenHolder: r.borrower, holdId: r.collateralHoldId
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

    /// @notice `OPEN -> MARGIN_CALL` by hand. Reachable only while the feed is dark.
    /// @dev **This used to be the only way a mark reached this contract**, and
    ///      `script/DeployVenue.s.sol` said so: "`postMark` is a price feed's call and
    ///      this venue has no oracle wired. It is the one seat here held by an address
    ///      rather than by a contract." `markToMarket` is now that call, and this one is
    ///      the documented degradation: it refuses while `oracle.stale()` is false, so
    ///      the discretionary seat cannot overrule a live price, and it stays open when
    ///      the feed goes dark, so a feed outage is not a frozen repo book.
    ///
    ///      Row 14 in one signature. The engine posts a commitment to the mark and the
    ///      boolean it implies. The boolean has to be public because both parties act on
    ///      it and a private margin call is not a margin call; the number does not,
    ///      because publishing it hands every observer the borrower's liquidation price.
    ///      An observer learns that a threshold was crossed, which is one bit, and not
    ///      where the threshold sits, which is why the engine's call frequency is itself a
    ///      budgeted disclosure.
    ///
    ///      The commitment's weakness is stated rather than repaired here, because it
    ///      cannot be repaired here: `markCommitment` hides `price x lot` while `repo(id)`
    ///      returns `collateralAmount` in the clear two lines down, so an observer who can
    ///      read a price can divide. `markToMarket` is the actual answer. It computes the
    ///      mark in memory and stores nothing, so the number that must not be public is
    ///      not written anywhere rather than written as a commitment whose preimage is two
    ///      public reads away.
    function postMark(bytes32 id, bytes32 commitment, bool breach, uint64 window) external {
        if (msg.sender != marginEngine) revert NotMarginEngine();
        if (!oracle.stale()) revert FeedIsLive();
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
            r.cureDeadline = uint64(block.timestamp) + window;
            // Row 14. A margin call is a predicate about a position.
            if (_emitUnder(id, ROW_POSITION, L.G_PRED, L.T_IMM)) {
                emit MarginCalled(id, r.cureDeadline);
            }
        }
    }

    // ------------------------------------------------ T3': mark, from the feed

    /// @notice `OPEN -> MARGIN_CALL` against `PrimeOracle`. Permissionless.
    /// @dev The call `postMark` was standing in for. Three things change and each one is
    ///      an argument the old signature could not make.
    ///
    ///      **The mark is never stored.** It is a product of two public reads, the feed's
    ///      price and this repo's own lot, taken in memory and discarded. Row 14 is
    ///      answered by not writing something, which is where `RepoMath` already said the
    ///      constraint had to reach.
    ///
    ///      **The cadence stops being a signal.** `postMark` charges row 16 because the
    ///      margin engine's call frequency is itself a disclosure: marking is daily, so
    ///      the sequence of `MarkPosted` events is a fingerprint, and the matrix carries
    ///      that as an open limit. Nothing here charges row 16, because nothing here is
    ///      the venue's cadence. Anyone may call this at any time against a price the feed
    ///      already published, so the timing of a mark carries no information about who
    ///      chose to look.
    ///
    ///      **A stale price refuses rather than reads through.** `markPerUnitTinybar`
    ///      reverts on either dark leg. Acting on an old price is the failure that
    ///      matters, and a margin call is not a place to be optimistic.
    /// @return breach Whether the position is short right now, whether or not this call
    ///         was the one that moved the state.
    function markToMarket(bytes32 id) external returns (bool breach) {
        Repo storage r = repos[id];
        if (r.state != State.OPEN && r.state != State.MARGIN_CALL) {
            revert WrongState(r.state, State.OPEN);
        }

        breach = _short(r, oracle.markPerUnitTinybar() * r.collateralAmount);

        if (breach && r.state == State.OPEN) {
            r.state = State.MARGIN_CALL;
            r.cureDeadline = uint64(block.timestamp) + cureWindow;
            if (_emitUnder(id, ROW_POSITION, L.G_PRED, L.T_IMM)) {
                emit MarginCalled(id, r.cureDeadline);
            }
        }
    }

    /// @notice What `markToMarket` would find, without sending anything.
    /// @dev A view and never an event, on `settlementPenaltyNow`'s argument: the mark is
    ///      `markPerUnitTinybar` times `repo(id).collateralAmount` and both are already
    ///      public reads, so this discloses nothing the ledger does not hold. It exists
    ///      because the alternative for a client is to send a transaction to find out
    ///      whether it needed to, and because a screen that can only show a margin call
    ///      after it lands is a screen that tells a borrower too late.
    ///
    ///      Total. A dark feed answers `dark` rather than reverting, so the Repo screen
    ///      can say the feed is down instead of failing to render.
    function previewMark(bytes32 id)
        external
        view
        returns (uint256 mark, bool breach, bool dark)
    {
        Repo storage r = repos[id];
        if (oracle.stale()) return (0, false, true);
        mark = oracle.markPerUnitTinybar() * r.collateralAmount;
        breach = _short(r, mark);
    }

    /// @dev One place, so `markToMarket` and `previewMark` cannot disagree about what
    ///      short means. `RepoMath.isUndercollateralised` accrues the exposure to now and
    ///      grosses it up by the maintenance margin; nothing about that changes because
    ///      the mark arrived from a feed rather than from an account.
    function _short(Repo storage r, uint256 mark) private view returns (bool) {
        return RepoMath.isUndercollateralised(
            mark, r.principal, r.repoRateBps, r.openedAt, block.timestamp, r.maintenanceBps
        );
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
    ///
    ///      **This used to take the commitment as an argument, from any caller, with no
    ///      check that a coupon had fallen due at all.** The scorecard read that as
    ///      "coupons only, and only as a commitment"; the sharper reading is that the
    ///      commitment was *asserted rather than derived*. Nothing on chain connected it
    ///      to a coupon date, to a rate, or to the bond. Four reads now stand behind it
    ///      and not one of them is the caller's:
    ///
    ///      - the **date** comes from `CouponSchedule`, fixed at issuance;
    ///      - the **period** comes from the same place, as `accrualStart`, so the caller
    ///        cannot pick a longer one;
    ///      - the **rate** is `PrimeOracle`'s published reference plus the schedule's
    ///        spread, which is what makes this bond's `"kind": "bond, variable rate"` a
    ///        property of the contract rather than of the deployment record;
    ///      - the **lot** is this vault's own `collateralAmount`, written at `open`.
    ///
    ///      **The disclosure does not widen.** The event is the one it always was, a
    ///      predicate under row 14, and the amount stays out of it for the reason it
    ///      always did. What changed is behind the event, not in front of it.
    ///
    ///      **A dark feed refuses, and this is the opposite door from `postMark`.** The
    ///      manual mark seat opens when the feed goes dark, because a repo book that
    ///      cannot be marked is a frozen book. A coupon is not like that: there is no
    ///      discretionary substitute for a published reference rate, and a coupon accrued
    ///      against a rate nobody published is an invented number. So `postMark` requires
    ///      `stale()` and this requires the negation of `ourLegStale()`: our own leg,
    ///      not the composite, because a coupon is denominated in the cash asset and
    ///      never passes through the HBAR conversion `markPerUnitTinybar` performs.
    ///
    ///      **Idempotent in the coupon, on purpose.** A second call for an index this
    ///      repo has already noted returns rather than reverts. That is what a scheduled
    ///      call needs: `docs/BUILD-REMAINING.md` §3 puts `noteCoupon` behind a
    ///      HIP-1215 `scheduleCall` at each coupon date, and a scheduled call that fires
    ///      after somebody already made it by hand must be a no-op and not a failure.
    ///      Only one coupon may be *outstanding*, which is still the state check's job:
    ///      a second, different coupon before pay-through is refused rather than silently
    ///      summed.
    /// @param index The coupon, as `CouponSchedule` numbers it.
    /// @return owed The obligation, returned to the caller and written nowhere in the
    ///         clear. Zero when the call was a no-op.
    function noteCoupon(bytes32 id, uint256 index) external returns (uint256 owed) {
        // Before the state check, so the no-op path is reachable from a repo that has
        // since moved on. A scheduled call is not entitled to know what happened to the
        // repo between being scheduled and firing.
        if (notedCoupon[id][index]) return 0;

        Repo storage r = repos[id];
        _require(r.state == State.OPEN, r.state, State.OPEN);

        uint64 due = schedule.dateOf(index);
        // The coupon has to have fallen due *inside this repo's term*. A coupon before
        // T1 was the borrower's own and a coupon after maturity is nobody's business of
        // this vault's, and neither is a manufactured payment: the whole obligation
        // exists because title sat with the lender when the issuer paid.
        if (due < r.openedAt || due > r.maturity) {
            revert CouponOutsideTerm(index, due, r.openedAt, r.maturity);
        }
        if (block.timestamp < due) revert CouponNotYetDue(index, due);

        if (oracle.ourLegStale()) revert FeedIsDark();
        (, uint64 refRateBps,,) = oracle.latest();
        owed = schedule.amountFor(index, refRateBps, r.collateralAmount);
        if (owed == 0) revert NothingOwed();

        notedCoupon[id][index] = true;
        bytes32 commitment = commitmentOf(id, index, owed);
        r.manufacturedCommitment = commitment;
        r.state = State.MANUFACTURED;
        if (_emitUnder(id, ROW_POSITION, L.G_PRED, L.T_IMM)) {
            emit CouponObserved(id, commitment);
        }
    }

    /// @notice What `noteCoupon` would find, without sending anything.
    /// @dev A view and never an event, on `previewMark`'s argument, and total for the
    ///      same reason: a dark feed answers `dark` rather than reverting, so the Repo
    ///      screen can say the feed is down instead of failing to render.
    /// @param dark The venue's own leg is stale, so there is no rate to accrue against.
    function couponOwed(bytes32 id, uint256 index)
        external
        view
        returns (uint256 owed, bool dark, bool noted)
    {
        noted = notedCoupon[id][index];
        if (oracle.ourLegStale()) return (0, true, noted);
        Repo storage r = repos[id];
        (, uint64 refRateBps,,) = oracle.latest();
        owed = schedule.amountFor(index, refRateBps, r.collateralAmount);
    }

    /// @notice The commitment `noteCoupon` writes. Public and pure so the client and this
    ///         contract cannot disagree about one.
    /// @dev **This hides less than a commitment usually does, and the honest version of
    ///      saying so is to say it here rather than to let the word carry the claim.**
    ///      Every input is public: `id` is in the log, `index` is instrument data, and
    ///      `owed` is a product of four published reads. Anyone who wants the amount can
    ///      recompute it; nobody has to invert anything.
    ///
    ///      It stays a commitment for two reasons that are worth more than the hiding.
    ///      Writing the amount into storage in the clear would be strictly worse, since
    ///      one `repo(id)` would make the position fall out with no arithmetic at all.
    ///      And the field, the event and the client that reads both are already this
    ///      shape, so the change that mattered lands without a client having to move.
    ///      `markCommitment` carries the same limit under `markToMarket`'s header, and
    ///      that one was answered by not storing the number; here the number is an
    ///      obligation between two named parties and somebody has to hold it.
    function commitmentOf(bytes32 id, uint256 index, uint256 amount)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(DOMAIN_MANUFACTURED, id, index, amount));
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
                partition: r.partition, tokenHolder: r.borrower, holdId: r.collateralHoldId
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
        return RepoMath.repurchasePrice(r.principal, r.repoRateBps, r.openedAt, block.timestamp);
    }
}
