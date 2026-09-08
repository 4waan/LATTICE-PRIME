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
import {IExternalKycList} from "../interfaces/IExternalKycList.sol";
import {IKyc} from "../interfaces/IKyc.sol";
import {ScheduledSettlement} from "../schedule/ScheduledSettlement.sol";

/// @title RepoVault
/// @notice Tokenised repo on ATS holds with venue and ATS eligibility checks.
/// @dev Row 14: mark is a commitment, public event is a boolean. Row 12 is
///      stated: close settles in the clear inside ATS. HTS and EVM share one
///      rollback boundary, so both legs move or neither.
contract RepoVault is RepoVaultBase, DisclosureView, ScheduledSettlement {
    using RepoMath for uint256;

    /// @dev Here and not in `RepoVaultBase` with the rest: an inherited enum does not
    ///      resolve as `RepoVault.State`, which is how every call site asks for it.
    ///      `WrongState` follows the type it is declared over.
    enum State {
        NONE,
        PROPOSED,
        OPEN,
        MARGIN_CALL,
        // Reserved so historical state numbers remain stable. Hold custody gives
        // the issuer coupon directly to the borrower, so new repos never enter it.
        MANUFACTURED,
        FAILING,
        DEFAULTED,
        CLOSED
    }

    error WrongState(State got, State want);

    /// @notice The economic terms a lender funds and a borrower accepts.
    /// @dev Mark is not a field. Principal is quoted from `PrimeOracle` at fund
    ///      and checked again at accept. A struct because flat they do not fit
    ///      on the EVM stack.
    struct Terms {
        bytes32 partition;
        uint256 collateralAmount;
        uint16 haircutBps;
        uint16 maintenanceBps;
        uint256 repoRateBps;
        uint64 term;
    }

    struct Offer {
        address lender;
        address borrower;
        Terms terms;
        uint256 principal;
        uint64 expiresAt;
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
        /// @dev Latest in-term coupon observation. The amount is independently
        ///      derivable from public terms; this binds the repo, index, and amount
        ///      without inventing a second payment under hold custody.
        bytes32 lastCouponCommitment;
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

    /// @notice The same external eligibility list configured on the ATS bond.
    /// @dev ATS v8.0.0 does not check external KYC when creating an authorised
    ///      hold, but it does check the recipient when executing one. The vault
    ///      therefore checks both parties at offer and acceptance, then gives a
    ///      clear, retryable refusal if the lender must renew before default.
    IExternalKycList public immutable registry;

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

    /// @dev Domain tag on a repo coupon observation. Separate from every tree
    ///      tag in `src/merkle`, because the two shapes must not share preimages.
    bytes32 public constant DOMAIN_COUPON_OBSERVATION =
        keccak256("hedera2026.repo.coupon-observation.v1");

    /// @notice Client capability gate. Historical vaults do not expose this getter.
    uint8 public constant FINANCING_VERSION = 5;

    /// @notice ATS collateral stays live until this vault resolves the repo.
    /// @dev A short expiry turns keeper delay into an unsecured loan: after expiry
    ///      ATS permits reclaim to the borrower and refuses execution to the lender.
    ///      `uint64.max` is effectively open-ended on Hedera while remaining a valid
    ///      future timestamp for ATS v8.0.0.
    uint256 public constant HOLD_EXPIRY = type(uint64).max;

    mapping(bytes32 => Offer) public offers;
    mapping(address => uint256) public credit;
    mapping(bytes32 => uint256[]) internal extraHolds;
    uint256 public cashReserved;
    uint256 private _lock = 1;

    constructor(
        IHoldByPartition security_,
        address marginEngine_,
        IPrimeOracle oracle_,
        ICouponSchedule schedule_,
        IExternalKycList registry_,
        IDisclosurePolicy policy_,
        uint256 penaltyRate_,
        uint64 failGrace_,
        uint64 cureWindow_
    ) DisclosureView(policy_) {
        if (penaltyRate_ > RepoMath.BP_HUNDREDTHS) {
            revert RepoMath.PenaltyRateTooLarge(penaltyRate_);
        }
        if (address(security_) == address(0)) revert ZeroAddress();
        if (address(oracle_) == address(0)) revert NoFeed();
        if (address(schedule_) == address(0)) revert NoSchedule();
        if (address(registry_) == address(0)) revert ZeroAddress();
        security = security_;
        marginEngine = marginEngine_;
        oracle = oracle_;
        schedule = schedule_;
        registry = registry_;
        penaltyRate = penaltyRate_;
        failGrace = failGrace_;
        cureWindow = cureWindow_;
    }

    // ------------------------------------------------------------ T1: funded offer

    /// @notice Cashless `open` is refused. Use `fundOffer` then `accept`.
    function open(bytes32, address, Terms calldata) external pure returns (uint256) {
        revert UseFundedOffer();
    }

    /// @notice Lender deposits exact principal against terms. Quoted from the live feed.
    function fundOffer(bytes32 id, address borrower, Terms calldata t, uint64 expiresAt)
        external
        payable
        returns (uint256 principal)
    {
        if (offers[id].lender != address(0)) revert AlreadyExists(id);
        if (repos[id].state != State.NONE) revert AlreadyExists(id);
        if (expiresAt <= block.timestamp) revert OfferExpired(expiresAt);
        if (borrower == address(0)) revert ZeroAddress();
        if (borrower == msg.sender) revert SelfDeal();
        _requireEligible(msg.sender);
        _requireEligible(borrower);
        if (t.collateralAmount == 0 || t.term == 0) revert ZeroAmount();
        if (t.repoRateBps > RepoMath.MAX_REPO_RATE_BPS) {
            revert RepoMath.RepoRateTooLarge(t.repoRateBps);
        }
        uint64 maturity = _checkedMaturity(t.term);
        principal = _quote(t);
        if (principal == 0) revert ZeroAmount();
        RepoMath.repurchasePrice(principal, t.repoRateBps, block.timestamp, maturity);
        if (msg.value != principal) revert InsufficientRepayment(msg.value, principal);

        offers[id] = Offer({
            lender: msg.sender,
            borrower: borrower,
            terms: t,
            principal: principal,
            expiresAt: expiresAt
        });
        cashReserved += principal;
        if (_emitUnder(id, ROW_POSITION, L.G_PRED, L.T_IMM)) {
            emit OfferFunded(id);
        }
    }

    /// @notice Lender pulls the unused principal. The HBAR stays until `withdraw`.
    function cancelOffer(bytes32 id) external {
        Offer memory o = offers[id];
        if (o.lender == address(0)) revert UnknownOffer(id);
        if (msg.sender != o.lender) revert NotParty();
        delete offers[id];
        credit[o.lender] += o.principal;
        if (_emitWithoutBlocking(ROW_POSITION, L.G_PRED, L.T_IMM)) {
            emit OfferCancelled(id);
        }
    }

    /// @notice Borrower locks collateral and is credited the funded principal.
    /// @dev One reverting frame: a refused ATS hold returns the lender's HBAR
    ///      to the offer (the offer is not consumed). Quoted again so a moved
    ///      mark cannot close at yesterday's principal.
    function accept(bytes32 id) external nonReentrant returns (uint256 principal) {
        Offer memory o = offers[id];
        if (o.lender == address(0)) revert UnknownOffer(id);
        if (block.timestamp >= o.expiresAt) revert OfferExpired(o.expiresAt);
        if (msg.sender != o.borrower) revert NotParty();
        if (repos[id].state != State.NONE) revert AlreadyExists(id);
        _requireEligible(o.lender);
        _requireEligible(o.borrower);
        uint64 maturity = _checkedMaturity(o.terms.term);

        uint256 live = _quote(o.terms);
        if (live != o.principal) revert MarkMoved(o.principal, live);
        principal = o.principal;
        RepoMath.repurchasePrice(
            principal, o.terms.repoRateBps, block.timestamp, maturity
        );

        (, uint256 holdId) = security.createHoldFromByPartition(
            o.terms.partition,
            msg.sender,
            IHoldTypes.Hold({
                amount: o.terms.collateralAmount,
                expirationTimestamp: HOLD_EXPIRY,
                escrow: address(this),
                to: address(0),
                data: ""
            }),
            ""
        );

        delete offers[id];

        Repo storage r = repos[id];
        r.state = State.OPEN;
        r.borrower = msg.sender;
        r.lender = o.lender;
        r.partition = o.terms.partition;
        r.collateralHoldId = holdId;
        r.collateralAmount = o.terms.collateralAmount;
        r.principal = principal;
        r.repoRateBps = o.terms.repoRateBps;
        r.openedAt = uint64(block.timestamp);
        r.maturity = maturity;
        r.maintenanceBps = o.terms.maintenanceBps;

        credit[msg.sender] += principal;

        if (_emitUnder(id, ROW_ASSET, L.G_EXACT, L.T_IMM)) {
            emit Opened(id, r.maturity);
        }

        _registerSettlement(failObligation(id), id, Kind.FAIL, r.maturity, 0);
        uint256 coupons = schedule.count();
        for (uint256 i = 0; i < coupons; ++i) {
            uint64 due = schedule.dateOf(i);
            if (due < r.openedAt || due > r.maturity) continue;
            _registerSettlement(couponObligation(id, i), id, Kind.COUPON, due, i);
        }
    }

    /// @notice Principal this vault would demand for `t` right now.
    function quotePrincipal(Terms calldata t) external view returns (uint256) {
        return _quote(t);
    }

    function _quote(Terms memory t) private view returns (uint256) {
        if (oracle.stale()) revert FeedIsDark();
        uint256 mark = RepoMath.markedValue(
            oracle.markPerUnitTinybar(), t.collateralAmount
        );
        return RepoMath.purchasePrice(mark, t.haircutBps);
    }

    function _cashLiabilities() internal view override returns (uint256) {
        return cashReserved;
    }

    modifier nonReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @notice Take HBAR this vault owes `msg.sender`.
    function withdraw() external nonReentrant {
        uint256 amount = credit[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credit[msg.sender] = 0;
        cashReserved -= amount;
        emit Withdrawn(msg.sender);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    // ------------------------------------------------------------ T2: close

    /// @notice An active repo closes when its borrower repays in full.
    /// @dev Borrower pays at least the repurchase price (plus any fail penalty).
    ///      Repayment before maturity includes interest through maturity, so an
    ///      immediate close is an exit and not a free option on lender cash.
    ///      Collateral is **released** to the borrower. The lender is credited
    ///      the price and withdraws. Excess `msg.value` is credited back.
    function close(bytes32 id) external payable nonReentrant returns (uint256 price) {
        Repo storage r = repos[id];
        if (!_isCloseable(r.state)) {
            revert WrongState(r.state, State.OPEN);
        }
        if (msg.sender != r.borrower) revert NotParty();
        price = _closePrice(r, block.timestamp) + _penaltyOf(r, block.timestamp);
        if (msg.value < price) revert InsufficientRepayment(msg.value, price);

        _releaseAll(r, id);

        cashReserved += msg.value;
        credit[r.lender] += price;
        if (msg.value > price) credit[msg.sender] += msg.value - price;

        r.state = State.CLOSED;
        if (_emitWithoutBlocking(ROW_POSITION, L.G_PRED, L.T_IMM)) {
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
        if (_emitWithoutBlocking(ROW_CADENCE, L.G_EXACT, L.T_IMM)) {
            emit MarkPosted(id, commitment);
        }

        if (breach && r.state == State.OPEN) {
            uint64 deadline = _checkedDeadline(window);
            r.state = State.MARGIN_CALL;
            r.cureDeadline = deadline;
            // Row 14. A margin call is a predicate about a position.
            if (_emitWithoutBlocking(ROW_POSITION, L.G_PRED, L.T_IMM)) {
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

        breach = _short(
            r, RepoMath.markedValue(oracle.markPerUnitTinybar(), r.collateralAmount)
        );

        if (breach && r.state == State.OPEN) {
            uint64 deadline = _checkedDeadline(cureWindow);
            r.state = State.MARGIN_CALL;
            r.cureDeadline = deadline;
            if (_emitWithoutBlocking(ROW_POSITION, L.G_PRED, L.T_IMM)) {
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
        mark = RepoMath.markedValue(oracle.markPerUnitTinybar(), r.collateralAmount);
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

    /// @notice `MARGIN_CALL -> OPEN` only when a live mark shows coverage restored.
    function cure(bytes32 id) external {
        Repo storage r = repos[id];
        _require(r.state == State.MARGIN_CALL, r.state, State.MARGIN_CALL);
        if (msg.sender != r.borrower) revert NotParty();
        if (block.timestamp >= r.cureDeadline) {
            revert CureWindowClosed(r.cureDeadline);
        }
        if (oracle.stale()) revert FeedIsDark();
        if (
            _short(
                r, RepoMath.markedValue(oracle.markPerUnitTinybar(), r.collateralAmount)
            )
        ) revert EmptyCure();
        r.state = State.OPEN;
        r.cureDeadline = 0;
        if (_emitWithoutBlocking(ROW_POSITION, L.G_PRED, L.T_IMM)) {
            emit Cured(id);
        }
    }

    /// @notice Borrower posts more collateral while OPEN or MARGIN_CALL.
    function addCollateral(bytes32 id, uint256 amount) external nonReentrant {
        Repo storage r = repos[id];
        if (r.state != State.OPEN && r.state != State.MARGIN_CALL) {
            revert WrongState(r.state, State.OPEN);
        }
        if (msg.sender != r.borrower) revert NotParty();
        if (amount == 0) revert ZeroAmount();
        if (r.state == State.MARGIN_CALL && block.timestamp >= r.cureDeadline) {
            revert CureWindowClosed(r.cureDeadline);
        }
        _requireEligible(msg.sender);

        (, uint256 holdId) = security.createHoldFromByPartition(
            r.partition,
            msg.sender,
            IHoldTypes.Hold({
                amount: amount,
                expirationTimestamp: HOLD_EXPIRY,
                escrow: address(this),
                to: address(0),
                data: ""
            }),
            ""
        );
        extraHolds[id].push(holdId);
        r.collateralAmount += amount;
        if (_emitWithoutBlocking(ROW_POSITION, L.G_PRED, L.T_IMM)) {
            emit CollateralAdded(id);
        }
    }

    /// @notice `OPEN -> FAILING`. Maturity passed and the close leg did not.
    /// @dev Permissionless, and the reason is sharper than `declareDefault`'s: the party
    ///      who would decline to record a fail is the one whose fail it is, because the
    ///      grace clock that ends in default starts here.
    function markFailing(bytes32 id) external {
        _markFailing(id);
    }

    function _markFailing(bytes32 id) private {
        Repo storage r = repos[id];
        if (r.state == State.FAILING) return;
        _require(r.state == State.OPEN, r.state, State.OPEN);
        if (block.timestamp < r.maturity) revert NotYetMature(r.maturity);
        r.state = State.FAILING;
        if (_emitWithoutBlocking(ROW_POSITION, L.G_PRED, L.T_IMM)) {
            emit Failing(id, r.maturity);
        }
    }

    /// @notice The Article 7 penalty owed on `id` right now.
    /// @dev A view and never an event. `repurchasePriceNow` already hands over the
    ///      settlement price, so this discloses nothing the ledger does not hold, and the
    ///      event stream is the surface `_emitUnder` governs.
    function settlementPenaltyNow(bytes32 id) external view returns (uint256) {
        Repo storage r = repos[id];
        if (!_isCloseable(r.state)) revert WrongState(r.state, State.OPEN);
        return _penaltyOf(r, block.timestamp);
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
        if (_emitWithoutBlocking(ROW_POSITION, L.G_PRED, L.T_IMM)) {
            emit Defaulted(id);
        }
    }

    // ----------------------------------------------- T5 and T6: income record

    /// @notice Record that an issuer coupon fell due while this repo was active.
    /// @dev Title stays with the borrower. ATS has no coupon facet that reroutes a
    ///      mid-term payment to `hold.to`, so the issuer coupon is already the
    ///      borrower's. This call records the observation without changing repo
    ///      state or creating a second payment. See `docs/FINANCING-DECISIONS.md`.
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
    ///      - the **rate** is the last valid `PrimeOracle` round strictly before
    ///        the coupon date, plus the schedule's spread. A delayed manual or
    ///        scheduled call therefore cannot substitute the then-current rate;
    ///      - the **lot** is this vault's own `collateralAmount`, written at `accept`.
    ///
    ///      **The disclosure does not widen.** The event is the one it always was, a
    ///      predicate under row 14, and the amount stays out of it for the reason it
    ///      always did. What changed is behind the event, not in front of it.
    ///
    ///      **A missing fixing refuses.** The manual mark seat opens when the live
    ///      feed goes dark, because a repo book that cannot be marked is frozen.
    ///      Coupon arithmetic instead reads the immutable historical round before
    ///      the due date. If no round existed inside the oracle heartbeat, there is
    ///      no discretionary substitute and the observation is refused.
    ///
    ///      **Idempotent in the coupon, on purpose.** A second call for an index this
    ///      repo has already noted returns rather than reverts. That is what a scheduled
    ///      call needs: `docs/BUILD-REMAINING.md` §3 puts `noteCoupon` behind the
    ///      dispatcher targeted by HIP-1215 at each coupon date. A scheduled call that
    ///      fires after somebody already made it by hand must be a no-op and not a failure.
    ///      Different coupon indices are independent observations, so delayed settlement
    ///      of one cannot block a later coupon, margin action, repayment, or default.
    /// @param index The coupon, as `CouponSchedule` numbers it.
    /// @return owed The observed coupon amount, returned to the caller and written
    ///         nowhere in the clear. Zero when the call was a no-op.
    function noteCoupon(bytes32 id, uint256 index) external returns (uint256 owed) {
        return _noteCoupon(id, index);
    }

    function _noteCoupon(bytes32 id, uint256 index) private returns (uint256 owed) {
        // Before the state check, so the no-op path is reachable from a repo that has
        // since moved on. A scheduled call is not entitled to know what happened to the
        // repo between being scheduled and firing.
        if (notedCoupon[id][index]) return 0;

        Repo storage r = repos[id];
        if (
            r.state != State.OPEN && r.state != State.MARGIN_CALL
                && r.state != State.FAILING
        ) {
            revert WrongState(r.state, State.OPEN);
        }

        uint64 due = schedule.dateOf(index);
        // The coupon has to have fallen due inside this repo's term. Outside that
        // interval there is no repo-linked observation to record.
        if (due < r.openedAt || due > r.maturity) {
            revert CouponOutsideTerm(index, due, r.openedAt, r.maturity);
        }
        if (block.timestamp < due) revert CouponNotYetDue(index, due);

        uint64 refRateBps = _referenceRateFor(due);
        owed = schedule.amountFor(index, refRateBps, r.collateralAmount);
        if (owed == 0) revert NothingOwed();

        notedCoupon[id][index] = true;
        bytes32 commitment = commitmentOf(id, index, owed);
        r.lastCouponCommitment = commitment;
        if (_emitUnder(id, ROW_POSITION, L.G_PRED, L.T_IMM)) {
            emit CouponObserved(id, commitment);
        }
    }

    /// @dev The HIP-1215 target and its manual fallback share these exact state
    ///      transitions. A satisfied fail or coupon is a no-op when its native
    ///      schedule lands second.
    function _runSettlement(Kind kind, bytes32 id, uint256 index) internal override {
        Repo storage r = repos[id];
        if (kind == Kind.FAIL) {
            if (
                r.state == State.MARGIN_CALL || r.state == State.FAILING
                    || r.state == State.DEFAULTED || r.state == State.CLOSED
            ) return;
            _markFailing(id);
            return;
        }
        if (kind == Kind.COUPON) {
            if (notedCoupon[id][index]) return;
            if (r.state == State.DEFAULTED || r.state == State.CLOSED) return;
            _noteCoupon(id, index);
        }
    }

    /// @notice What `noteCoupon` would find, without sending anything.
    /// @dev A view and never an event, on `previewMark`'s argument, and total for the
    ///      same reason: a dark feed answers `dark` rather than reverting, so the Repo
    ///      screen can say the feed is down instead of failing to render.
    /// @param dark No valid historical fixing exists before this coupon date.
    function couponOwed(bytes32 id, uint256 index)
        external
        view
        returns (uint256 owed, bool dark, bool noted)
    {
        noted = notedCoupon[id][index];
        uint64 due = schedule.dateOf(index);
        if (block.timestamp < due) return (0, false, noted);
        uint64 refRateBps;
        try oracle.referenceRateBefore(due) returns (
            uint64 rate, uint64, uint64
        ) {
            refRateBps = rate;
        } catch {
            return (0, true, noted);
        }
        Repo storage r = repos[id];
        owed = schedule.amountFor(index, refRateBps, r.collateralAmount);
    }

    function _referenceRateFor(uint64 due) private view returns (uint64 refRateBps) {
        try oracle.referenceRateBefore(due) returns (
            uint64 rate, uint64, uint64
        ) {
            return rate;
        } catch {
            revert FeedIsDark();
        }
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
    ///      The stored commitment also lets a client compare the latest observation
    ///      with an independently calculated amount without treating it as a payment.
    function commitmentOf(bytes32 id, uint256 index, uint256 amount)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(DOMAIN_COUPON_OBSERVATION, id, index, amount));
    }

    /// @notice Explicitly refused under this vault's hold-custody model.
    /// @dev The ATS token holder remains the borrower and receives the issuer
    ///      coupon directly. A second lender payment would double-pay income.
    function payThrough(bytes32) external pure {
        revert NoManufacturedPayment();
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

    /// @notice `DEFAULTED -> CLOSED`. Collateral executes to the lender.
    function settleDefault(bytes32 id) external nonReentrant {
        Repo storage r = repos[id];
        _require(r.state == State.DEFAULTED, r.state, State.DEFAULTED);
        _requireEligible(r.lender);
        _executeAll(r, id, r.lender);
        r.state = State.CLOSED;
        if (_emitWithoutBlocking(ROW_POSITION, L.G_PRED, L.T_IMM)) {
            emit Closed(id);
        }
    }

    /// @notice A sealed liquidation auction is not in this release.
    function settleAuction(bytes32, address, uint256) external pure {
        revert AuctionNotSupported();
    }

    function extraHoldCount(bytes32 id) external view returns (uint256) {
        return extraHolds[id].length;
    }

    function extraHoldAt(bytes32 id, uint256 i) external view returns (uint256) {
        return extraHolds[id][i];
    }

    function _releaseAll(Repo storage r, bytes32 id) private {
        IHoldTypes.HoldIdentifier memory hid = IHoldTypes.HoldIdentifier({
            partition: r.partition, tokenHolder: r.borrower, holdId: r.collateralHoldId
        });
        security.releaseHoldByPartition(hid, _holdRemaining(hid));
        uint256 n = extraHolds[id].length;
        for (uint256 i = 0; i < n; ++i) {
            hid.holdId = extraHolds[id][i];
            uint256 left = _holdRemaining(hid);
            if (left != 0) security.releaseHoldByPartition(hid, left);
        }
    }

    function _executeAll(Repo storage r, bytes32 id, address to) private {
        IHoldTypes.HoldIdentifier memory hid = IHoldTypes.HoldIdentifier({
            partition: r.partition, tokenHolder: r.borrower, holdId: r.collateralHoldId
        });
        uint256 left = _holdRemaining(hid);
        if (left != 0) security.executeHoldByPartition(hid, to, left);
        uint256 n = extraHolds[id].length;
        for (uint256 i = 0; i < n; ++i) {
            hid.holdId = extraHolds[id][i];
            left = _holdRemaining(hid);
            if (left != 0) security.executeHoldByPartition(hid, to, left);
        }
    }

    function _holdRemaining(IHoldTypes.HoldIdentifier memory hid)
        private
        view
        returns (uint256 amount)
    {
        (amount,,,,,,) = security.getHoldForByPartition(hid);
    }

    function _requireEligible(address account) private view {
        (bool ok, bytes memory result) = address(registry).staticcall(
            abi.encodeWithSelector(IExternalKycList.getKycStatus.selector, account)
        );
        if (!ok || result.length != 32) revert NotEligible(account);
        uint256 status;
        assembly ("memory-safe") {
            status := mload(add(result, 0x20))
        }
        if (status != uint256(IKyc.KycStatus.GRANTED)) revert NotEligible(account);
    }

    // ------------------------------------------------------------- helpers

    /// @dev The disclosure gates govern venue events, not storage or transaction
    ///      calldata. `repo(id)` returns fourteen fields and `fundOffer` carries
    ///      its terms in public calldata. Margin enforcement and mandatory exits
    ///      use the non-blocking gate so publication policy cannot weaken risk
    ///      controls or trap cash or collateral. `Withdrawn` is always emitted
    ///      as a payment receipt but omits the amount already visible in the
    ///      native transfer.

    function _require(bool ok, State got, State want) private pure {
        if (!ok) revert WrongState(got, want);
    }

    function repo(bytes32 id) external view returns (Repo memory) {
        return repos[id];
    }

    function stateOf(bytes32 id) external view returns (State) {
        return repos[id].state;
    }

    /// @notice Current accrued exposure used for margin coverage.
    function exposureNow(bytes32 id) external view returns (uint256) {
        Repo storage r = repos[id];
        if (!_isCloseable(r.state)) revert WrongState(r.state, State.OPEN);
        return RepoMath.repurchasePrice(
            r.principal, r.repoRateBps, r.openedAt, block.timestamp
        );
    }

    /// @notice Cash required to close before any settlement-fail penalty.
    /// @dev Early repayment is permitted but still pays interest through the
    ///      agreed maturity. After maturity, interest continues to actual close.
    function repurchasePriceNow(bytes32 id) external view returns (uint256) {
        Repo storage r = repos[id];
        if (!_isCloseable(r.state)) revert WrongState(r.state, State.OPEN);
        return _closePrice(r, block.timestamp);
    }

    function _isCloseable(State state) private pure returns (bool) {
        return state == State.OPEN || state == State.MARGIN_CALL || state == State.FAILING;
    }

    function _checkedMaturity(uint64 term) private view returns (uint64 maturity) {
        uint256 end = block.timestamp + uint256(term);
        if (end > type(uint64).max || uint256(failGrace) > type(uint64).max - end) {
            revert MaturityOverflow();
        }
        maturity = uint64(end);
    }

    function _checkedDeadline(uint64 window) private view returns (uint64 deadline) {
        uint256 end = block.timestamp + uint256(window);
        if (end > type(uint64).max) revert DeadlineOverflow();
        deadline = uint64(end);
    }

    function _closePrice(Repo storage r, uint256 at) private view returns (uint256) {
        uint256 interestThrough = at < r.maturity ? r.maturity : at;
        return RepoMath.repurchasePrice(
            r.principal, r.repoRateBps, r.openedAt, interestThrough
        );
    }
}
