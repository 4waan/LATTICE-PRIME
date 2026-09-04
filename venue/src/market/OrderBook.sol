// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {DisclosureLattice as L} from "../lattice/DisclosureLattice.sol";
import {IDisclosurePolicy} from "../interfaces/IDisclosurePolicy.sol";
import {DisclosureMeter} from "../lattice/DisclosureMeter.sol";

/// @title OrderBook
/// @notice Prong one of the marketplace trident: a commit and reveal order book
///         for ATS issued assets. The Studio has no secondary market today, so
///         this is the part of the submission that is not a configuration of
///         something existing.
///
/// ## Why commit and reveal is the ordinary path here, not a liquidation feature
///
/// Rule 1, from the disclosure work: **any value hidden from `pub` must never
/// appear in the clear in a transaction body.** That is not a policy about what
/// the contract emits. an earlier measurement measured that all 29 Hedera consensus node
/// operators hold the plaintext transaction body pre-consensus, which is before
/// any contract has executed and before any venue policy can run. A contract that
/// receives a price as a plain argument has already disclosed it, whatever it
/// does next.
///
/// So an order arrives as a fixed length commitment. One `bytes32`, always, which
/// also means the calldata length carries no signal about order size. The
/// alternative, a plain limit order, hands the size and the price to whoever
/// operates the node the transaction was submitted to. That is not hypothetical:
/// on mainnet today, all 190 transactions on one shared treasury go to a single
/// node, and that node is operated by one of the five competing managers whose
/// funds sit on it.
///
/// ## The commitment binds the committer
///
/// `keccak256(DOMAIN_ORDER, committer, side, price, qty, salt)`. Without the
/// committer inside the preimage a commitment can be copied out of the mempool
/// and submitted first by someone else, who then reveals it and takes the fill.
/// The stolen commitment is perfectly valid; that is what makes the omission easy
/// to miss.
///
/// ## Why keccak here and Poseidon in the auction
///
/// an invariant specifies `Poseidon(DOMAIN_BID, price, qty, r)` for auction bids, and
/// this contract uses keccak256 instead. The difference is where the opening is
/// checked. An order book reveal is checked on chain by re-hashing, and keccak is
/// a precompile costing about 30 gas per word while a Solidity Poseidon costs
/// tens of thousands. A sealed auction bid is opened *inside a circuit*, where
/// keccak costs roughly 150,000 constraints and Poseidon costs about 240. Same
/// primitive, opposite cost model, so the choice differs by call site. Stating it
/// because "we used two hash functions" looks like an inconsistency until the
/// reason is written down.
contract OrderBook {
    enum Side {
        BUY,
        SELL
    }

    /// @param cancelled Voided by its committer before reveal opened. Its own
    ///        flag and not a reuse of `revealed`, which `forfeit` sets to mean
    ///        "no longer openable": conflating them would make a cancelled id
    ///        report `AlreadyRevealed`. Free, the head is still one slot.
    struct Commitment {
        address committer;
        uint64 committedAt;
        bool revealed;
        bool cancelled;
        uint256 bond;
    }

    /// @param filled Cumulative, across every round this order has rested
    ///        through. **This field existed before the engine did and was
    ///        written once, as zero, and never again**, which is what a book
    ///        with no matching looks like from the inside.
    /// @param firstRound The round this order was revealed into, and therefore
    ///        the first round it can be crossed in.
    /// @param lastRound `firstRound + restRounds`. After it the order is dead
    ///        and `expire` returns the bond.
    /// @param retired Filled out, expired, or voided. A retired order is off the
    ///        live list and cannot come back; the flag exists so a second
    ///        `expire` is a no-op rather than a second refund.
    struct Order {
        address trader;
        Side side;
        uint128 price;
        uint128 qty;
        uint128 filled;
        uint64 revealedAt;
        uint64 firstRound;
        uint64 lastRound;
        bool retired;
    }

    bytes32 public constant DOMAIN_ORDER = keccak256("hedera2026.orderbook.v1");

    /// @notice How long after a commitment the reveal window opens and closes.
    /// @dev Two windows and not one. Reveals cannot start immediately or the
    ///      commitment buys nothing: a trader would commit and reveal in adjacent
    ///      blocks and the plaintext would reach the node operators at the same
    ///      moment it would have anyway.
    uint64 public immutable revealDelay;
    uint64 public immutable revealWindow;

    /// @notice Posted at commit, **retained through the order's whole life**,
    ///         forfeited if never revealed, returned when the order retires.
    /// @dev an invariant in its general form. Committing is otherwise free, so a trader
    ///      could flood the book with commitments they never intend to open, which
    ///      moves the reference price and costs nothing. The bond prices that.
    ///
    ///      **It used to be returned at reveal, and that was the security hole
    ///      rather than a loose end.** an invariant says a bid that cannot fund cannot
    ///      win. A book that hands the bond back the moment the order becomes
    ///      real holds nothing at stake over the entire interval in which the
    ///      order can actually take a fill: between reveal and cross the order
    ///      was an unfunded promise, and the promise is the only thing the
    ///      counterparty is trading against. The bond now converts to a
    ///      performance bond at reveal and is released by `expire`.
    ///
    ///      That is the smaller half of the fix. The larger half is that a
    ///      revealed order must be *backed*, in the asset or in cash, which this
    ///      contract cannot check because it does not know what the asset is.
    ///      See `_bind`.
    uint256 public immutable commitBond;

    /// @notice What a committer pays to void their own commitment before the
    ///         reveal window opens. Retained, never paid to anyone.
    ///
    /// @dev **Derived, not chosen.** A refundable cancel cheapens the phantom
    ///      order attack the bond exists to price, so the quantity to bound is
    ///      the cost per *second* of phantom. Two ways to buy one: lapse, costing
    ///      `B` for up to `D + W` seconds, or cancel at `t < D`, costing `f` for
    ///      `t`. Requiring the second is never cheaper is `f / t >= B / (D + W)`
    ///      for every reachable `t`, and the binding case `t -> D` gives
    ///
    ///          f  >=  B * D / (D + W)
    ///
    ///      which `minimumCancelFee` computes and the constructor enforces.
    ///      Backwards it is a pro-rata refund: pay for the fraction of the
    ///      commitment's life you used.
    ///
    ///      **Nobody receives it.** `forfeit` pays a sweeper because sweeping is
    ///      work; a cancel creates none, and every candidate recipient invents an
    ///      incentive to want cancellations. Retaining enriches nobody and so
    ///      distorts nobody. `feesRetained` accounts for it; no path pays it out.
    uint256 public immutable cancelFee;

    /// @notice Cancel fees this contract has kept. Nothing withdraws them.
    /// @dev Accounted rather than merely stuck: `balance == sum(credit) +
    ///      sum(live bonds) + feesRetained` for a bare book, which
    ///      `invariant_bondsAreConserved` runs against random traffic.
    uint256 public feesRetained;

    /// @notice How long a clearing round is, and how many rounds an unfilled
    ///         order rests before it expires.
    /// @dev **Resting is the design lever, and it is measured rather than
    ///      assumed.** At this venue's rate, 600 orders a year Poisson,
    ///      `probes/matching-clearing.py` section 5:
    ///
    ///      | resting rounds | crossings/yr | vs R=0 |
    ///      |---|---|---|
    ///      | R=0 | 130.0 | 1.00x |
    ///      | R=1 | 211.8 | 1.63x |
    ///      | R=7 | 277.8 | 2.14x |
    ///      | R=30 | 292.8 | 2.25x |
    ///
    ///      Resting roughly doubles crossings while keeping a daily price. It is
    ///      also *cheaper in disclosure* than the alternative, which is the
    ///      argument that actually settles it: re-committing each round spends a
    ///      fresh `(exact, imm)` on rows 3 and 4 every round against the same row
    ///      budget, and that is `docs/manipulation-surface.md` MA-04's repetition
    ///      attack with the trader as the attacker. Resting spends one, plus a
    ///      per-round "still unfilled" predicate. Neither is free and both
    ///      saturate; resting saturates later.
    uint64 public immutable roundLength;
    uint64 public immutable restRounds;

    /// @notice Round zero starts here. Deploy time.
    /// @dev An explicit origin rather than `block.timestamp / roundLength`,
    ///      because the second form makes the round boundary a property of the
    ///      unix epoch and therefore unstateable in a prospectus.
    uint64 public immutable genesis;

    /// @notice The governed disclosure policy, asked per row.
    /// @dev Was `uint32 public immutable ceiling = point(bucket, EOD)`, one value
    ///      standing in for rows 3, 4 and 17 at once, and read by nothing. A book
    ///      discloses on several rows and they have different ceilings, so the
    ///      lookup is by row and the ceiling arrives from `ParameterRoot` met
    ///      against `Regime.current()`.
    IDisclosurePolicy public immutable policy;

    /// @notice Bits spent per row per epoch against the governed coalition
    ///         budget.
    /// @dev **Inert until `cancel` existed.** Row 17 at commit and rows 3 and 4
    ///      at reveal all disclose at `G_EXACT`, which costs `domainBits`, and
    ///      `requireWellFormed` demands `budgetBits < domainBits`, so no well
    ///      formed budget can afford one and `ParameterRoot` refuses to publish
    ///      any. The lever that leaves is a coarser disclosure, not a tighter
    ///      bound.
    ///
    ///      `cancel` is that lever: row 15 at `(pred, imm)`, one bit, the book's
    ///      first sub-exact cell and so the first a budget binds.
    ///      `test_theBooksExactRowsAreUnmeterableByConstruction` and
    ///      `OrderCancelTest.test_cancellationIsTheBooksOnlyMeterableRow` pin the
    ///      two halves.
    DisclosureMeter.Meter internal _meter;

    /// @notice Rows of `the build notes` section 7.2 this contract discloses on.
    uint16 internal constant ROW_ORDER_SIZE = 3;
    uint16 internal constant ROW_ORDER_PRICE = 4;

    /// @dev Row 17 and **not** row 1, and the difference is the account
    ///      lifecycle rather than a preference. Row 1 puts trader identity at
    ///      `(none, {iss}, imm)`: the public learns nothing. `Committed` indexes
    ///      `msg.sender`, so if that address were a durable institutional account
    ///      this event would breach row 1 on every order. It is not one. an earlier measurement
    ///      and an earlier measurement put orders on single-use sponsored addresses with no
    ///      funding history, which is exactly row 17's account provenance at
    ///      `(exact, {pub}, imm)`.
    ///
    ///      **This constant is a claim, and the claim is checkable.** If the venue
    ///      ever admits long-lived addresses, the correct row becomes 1, whose
    ///      published ceiling is `BOTTOM`, and every `commit` starts reverting.
    ///      Changing the row here would then be a visible edit to a contract
    ///      rather than a quiet drift in what the addresses mean.
    uint16 internal constant ROW_PROVENANCE = 17;

    /// @notice Row 15, activity fingerprint, disclosed by `cancel` at
    ///         `(pred, imm)`.
    ///
    /// @dev **One bit, and the book's only meterable row.** The id and the
    ///      committer are already public from `Committed`, the order was never
    ///      opened so no price or size exists, and what is left is a single
    ///      boolean about an already-identified object. `bits` prices `pred` at
    ///      literally 1. Every other cell here is `G_EXACT`, which Rule B refuses
    ///      a budget on, so this is the first one a budget binds:
    ///      `breakingSize(15, G_PRED)` is `budgetBits + 1`, and past it a cancel
    ///      still completes in silence under Rule A.
    ///
    ///      **Incomparable to section 7.2, not above it.** The matrix writes row
    ///      15 as `(agg, EOD)` and the venue publishes `(pred, imm)`: less per
    ///      event, sooner. Neither ideal contains the other, so this is the first
    ///      divergence that is not a loosening or a tightening. Recovering the
    ///      matrix cell needs a deferred aggregate, and a contract cannot defer
    ///      an event: it would take an accumulator and an end-of-day flush,
    ///      named here and not built. `test_theCancelCellIsIncomparableToTheMatrix`
    ///      and `test_theLexRuleCallsTheIncomparablePairSafe` pin both, the
    ///      second showing the lex summary clearing a cell the ideal order does
    ///      not.
    ///
    ///      Limit: a cancel is a second timestamped event on the same trader, so
    ///      it doubles that trader's row 16 cadence signal. Row 16 is already
    ///      published at `(exact, imm)` and named as unsolved, and no emission
    ///      site in the venue charges cadence, so this inherits an admitted limit
    ///      rather than opening a new one.
    uint16 internal constant ROW_ACTIVITY = 15;

    mapping(bytes32 => Commitment) public commitments;
    mapping(bytes32 => Order) public orders;

    /// @notice The live book: revealed, unretired, still crossable.
    /// @dev **This replaced a `bytes32[] revealedIds` that was pushed to and read
    ///      by nothing except its own length.** An append-only list on a venue
    ///      that trades forever is not a book, it is a log that a matching
    ///      function would have had to scan in full and in perpetuity. Retirement
    ///      swaps the last element into the vacated slot and pops, so the array
    ///      length is the number of orders that can still trade and the cost of a
    ///      round is bounded by the resting window rather than by the venue's
    ///      lifetime.
    bytes32[] private _live;

    /// @dev One-based, so zero reads as absent and a fresh id needs no
    ///      initialisation. The classic off-by-one here deletes order zero on
    ///      every retirement.
    mapping(bytes32 => uint256) private _liveIndex;

    /// @notice Owed to an address, withdrawable by it.
    /// @dev **Pull, not push, and the reason is that `crossRound` must not be
    ///      revertable by a participant.** Clearing is permissionless and touches
    ///      every filled order in the round; one trader whose `receive` reverts
    ///      would otherwise be able to stop the whole venue clearing, for free,
    ///      forever. Bonds, cash escrow refunds and sale proceeds all land here.
    ///      `forfeit` is the one exception and keeps its direct transfer, because
    ///      there the recipient is `msg.sender`.
    mapping(address => uint256) public credit;

    /// @dev an earlier measurement: nothing in ATS has a reentrancy guard, so ours do. Not an
    ///      invariant of the venue, an ordinary practice. `crossRound` settles
    ///      through ATS and `withdraw` pays out, and both must not be reachable
    ///      from inside themselves.
    uint256 private _lock = 1;

    /// @dev Wrapped into calls rather than inlined, because a modifier body is
    ///      copied into every function that carries it and `MatchingEngine`
    ///      sits at 88 percent of EIP-170. an earlier measurement is why that number is watched.
    ///
    ///      83 percent until `cancel` landed: 21,506 bytes against 20,286, so
    ///      one entry point here spent 1,220 of the engine's 4,290 bytes of
    ///      margin. The engine inherits every byte this file adds. Order
    ///      lifecycle logic that does not belong to every book should go in a
    ///      sibling; a cancel does.
    modifier nonReentrant() {
        _enter();
        _;
        _exit();
    }

    function _enter() private {
        require(_lock == 1, "reentrant");
        _lock = 2;
    }

    function _exit() private {
        _lock = 1;
    }

    event Committed(bytes32 indexed id, address indexed committer);
    event Revealed(bytes32 indexed id, Side side, uint128 price, uint128 qty);
    event BondForfeited(bytes32 indexed id, uint256 amount);
    /// @notice A commitment was voided by its committer before reveal opened.
    /// @dev One field, because everything else is already public or does not
    ///      exist: the id and committer come from `Committed`, the order was
    ///      never opened, and the refund is the constant `commitBond -
    ///      cancelFee`. What is left is the fact, which is row 15 at `pred`.
    event Cancelled(bytes32 indexed id);
    event DisclosureRefused(bytes32 indexed id, uint16 row, uint32 excess);
    /// @notice The order left the live book. `reason` is one of the constants
    ///         below, so a trader can tell a clean expiry from a void.
    event Retired(bytes32 indexed id, uint8 reason);
    event Withdrawn(address indexed who, uint256 amount);

    uint8 internal constant RETIRE_EXPIRED = 0;
    uint8 internal constant RETIRE_FILLED = 1;
    uint8 internal constant RETIRE_VOIDED = 2;

    error AlreadyCommitted(bytes32 id);
    error UnknownCommitment(bytes32 id);
    error WrongBond(uint256 sent, uint256 want);
    error TooEarly(uint64 opensAt);
    error TooLate(uint64 closedAt);
    error AlreadyRevealed(bytes32 id);
    error OpeningDoesNotMatch();
    error StillRevealable(uint64 until);
    error DisclosureExceedsCeiling(uint16 row, uint32 excess);
    error UnknownOrder(bytes32 id);
    error StillResting(uint64 until);
    error ZeroRoundLength();
    error ZeroQuantity();
    error NothingToWithdraw();
    /// @notice Cancelling is the committer's own call, and only theirs.
    /// @dev The one call here that is not permissionless. `expire` and `forfeit`
    ///      are compelled by a clock; this is a choice, and a permissionless
    ///      version is a griefing primitive: anyone could pull anybody's quote
    ///      and charge them `cancelFee` for it.
    error NotCommitter(address committer);
    error AlreadyCancelled(bytes32 id);
    /// @param closedAt The instant cancel closed, which is the instant reveal
    ///        opened. Exclusive here, inclusive there, so the two never overlap.
    error CancelWindowClosed(uint64 closedAt);
    error CancelFeeExceedsBond(uint256 fee, uint256 bond);
    error CancelFeeTooLow(uint256 fee, uint256 minimum);

    constructor(
        uint64 revealDelay_,
        uint64 revealWindow_,
        uint256 commitBond_,
        uint256 cancelFee_,
        IDisclosurePolicy policy_,
        uint64 roundLength_,
        uint64 restRounds_
    ) {
        if (roundLength_ == 0) revert ZeroRoundLength();
        if (cancelFee_ > commitBond_) revert CancelFeeExceedsBond(cancelFee_, commitBond_);
        // The derivation in `cancelFee`, enforced at deploy. The two checks are
        // always jointly satisfiable because the floor is a fraction of the bond:
        // `testFuzz_theFloorNeverExceedsTheBond`.
        uint256 floor_ = minimumCancelFee(commitBond_, revealDelay_, revealWindow_);
        if (cancelFee_ < floor_) revert CancelFeeTooLow(cancelFee_, floor_);

        revealDelay = revealDelay_;
        revealWindow = revealWindow_;
        commitBond = commitBond_;
        cancelFee = cancelFee_;
        policy = policy_;
        roundLength = roundLength_;
        restRounds = restRounds_;
        genesis = uint64(block.timestamp);
    }

    /// @notice The least cancel fee that does not make cancelling the cheaper way
    ///         to buy a second of phantom order book.
    ///
    /// @dev `ceil(bond * delay / (delay + window))`, derivation in `cancelFee`.
    ///      **Rounded up**, because the bound is `f * (D + W) >= B * D` and
    ///      truncating leaves a fee up to one wei short, at which the cancelled
    ///      phantom is strictly the cheapest one. Zero when `delay + window` is
    ///      zero (no phantom to price) or `delay` is zero (no cancel window).
    ///      `bond * delay` is checked, so an absurd deployment reverts here
    ///      rather than deploying against a floor computed modulo 2^256. Public
    ///      and pure for the reason `commitmentOf` is.
    function minimumCancelFee(uint256 bond, uint64 delay, uint64 window)
        public
        pure
        returns (uint256)
    {
        uint256 life = uint256(delay) + uint256(window);
        if (life == 0) return 0;
        return (bond * uint256(delay) + life - 1) / life;
    }

    // ------------------------------------------------------------- the clock

    /// @notice The round now open for reveals. It is crossed once it closes.
    function currentRound() public view returns (uint64) {
        if (block.timestamp <= genesis) return 0;
        return (uint64(block.timestamp) - genesis) / roundLength;
    }

    /// @notice The first instant after round `r`.
    function roundEnd(uint64 r) public view returns (uint64) {
        return genesis + (r + 1) * roundLength;
    }

    /// @notice The commitment a client must produce. Exposed so the client and the
    ///         contract cannot disagree about the preimage.
    function commitmentOf(
        address committer,
        Side side,
        uint128 price,
        uint128 qty,
        bytes32 salt
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_ORDER, committer, side, price, qty, salt));
    }

    /// @notice Submit a sealed order. Fixed length calldata, by construction.
    function commit(bytes32 id) external payable {
        if (commitments[id].committer != address(0)) revert AlreadyCommitted(id);
        if (msg.value != commitBond) revert WrongBond(msg.value, commitBond);
        commitments[id] = Commitment({
            committer: msg.sender,
            committedAt: uint64(block.timestamp),
            revealed: false,
            cancelled: false,
            bond: msg.value
        });
        if (_emitUnder(id, ROW_PROVENANCE, L.G_EXACT, L.T_IMM)) {
            emit Committed(id, msg.sender);
        }
    }

    /// @notice Open a commitment inside its window, and back it.
    ///
    /// @param backing One word, opaque to this contract, handed to `_bind`. For
    ///        a sell it is the ATS hold id standing behind the lot; for a buy the
    ///        cash arrives as `msg.value` and this is unused. **It is not in the
    ///        commitment preimage**, and deliberately: a hold id is ATS
    ///        bookkeeping created after the commitment was sealed, and binding
    ///        the trader to one at commit time would mean choosing the hold
    ///        before choosing the order.
    ///
    /// @dev A reveal is now **firm**. Three things change at this line that did
    ///      not before, and all three are the same finding: a revealed order is
    ///      the thing a counterparty trades against, so it has to be worth
    ///      something.
    ///
    ///      1. The bond is not returned. See `commitBond`.
    ///      2. `_bind` must accept, and the engine's `_bind` refuses an order
    ///         that is not backed in the asset or in cash. A reveal that cannot
    ///         fund now **reverts**, and the trader keeps their reveal window to
    ///         try again with the backing in place.
    ///      3. The order joins the live book for `restRounds + 1` rounds rather
    ///         than being appended to a list nothing read.
    ///
    ///      `payable`, because the buy side's escrow arrives here. That is not a
    ///      new disclosure: this transaction already carries the price and the
    ///      quantity in the clear, so a value equal to their product tells a node
    ///      operator nothing it is not already being told. It would be a
    ///      disclosure at `commit`, which is why it is not there.
    function reveal(Side side, uint128 price, uint128 qty, bytes32 salt, uint256 backing)
        external
        payable
    {
        if (qty == 0) revert ZeroQuantity();
        bytes32 id = commitmentOf(msg.sender, side, price, qty, salt);
        Commitment storage c = commitments[id];
        if (c.committer == address(0)) revert UnknownCommitment(id);
        if (c.revealed) revert AlreadyRevealed(id);
        // **Load bearing.** A cancelled commitment still has `committer != 0`
        // and `revealed == false`, and cancel closes exactly when reveal opens,
        // so a trader who cancels at `opensAt - 1` is inside this window a second
        // later holding a commitment whose bond is already refunded. Without this
        // line they open a live, unbonded order, which is the unfunded promise
        // the bond stopped being returned at reveal to prevent.
        // `test_aCancelledCommitmentCannotBeOpened`.
        if (c.cancelled) revert AlreadyCancelled(id);

        uint64 opensAt = c.committedAt + revealDelay;
        uint64 closesAt = opensAt + revealWindow;
        if (block.timestamp < opensAt) revert TooEarly(opensAt);
        if (block.timestamp > closesAt) revert TooLate(closesAt);

        c.revealed = true;
        uint64 r = currentRound();
        orders[id] = Order({
            trader: msg.sender,
            side: side,
            price: price,
            qty: qty,
            filled: 0,
            revealedAt: uint64(block.timestamp),
            firstRound: r,
            lastRound: r + restRounds,
            retired: false
        });
        _liveIndex[id] = _live.length + 1;
        _live.push(id);

        // Before the disclosure and before anything is emitted, because an order
        // that cannot be backed must leave no trace beyond the commitment that
        // was already public.
        _bind(id, orders[id], backing);

        // Rows 4 and 3, both at `(exact, imm)`, and both are checked because the
        // one event carries two rows' worth of disclosure.
        //
        // **Against section 7.2 as written, both of these fail**, and the failure
        // is a real result rather than a misconfiguration. Row 4 wants price at
        // `(exact, {pub}, +15m)` and row 3 wants size at `(bucket, {pub}, EOD)`;
        // a reveal publishes both exactly and at once. The matrix reaches those
        // cells through a first cell, `(exact, {ven}, imm)`, in which the venue
        // holds the value and the public does not. **On a public ledger there is
        // no such observer set.** A contract that can read a number is a contract
        // whose storage and calldata the public can read, so `{ven}` and `{pub}`
        // are the same set here and the deferral has nothing to defer from.
        //
        // The response is not to loosen the check. It is that rows 3 and 4 are
        // deployed at `(exact, imm)` in `ParameterRoot`, so the divergence from
        // section 7.2 is a published parameter under a committed root rather than
        // an undocumented gap. `test_theMatrixAsWrittenRefusesTheReveal` publishes
        // section 7.2 verbatim and shows this reverting.
        // Two separate bools and not `&&`, because both rows must be charged.
        // Short circuiting would let the size row escape the meter whenever the
        // price row was already spent, which is the failure the one-event-two-rows
        // note above is about.
        bool okPrice = _emitUnder(id, ROW_ORDER_PRICE, L.G_EXACT, L.T_IMM);
        bool okSize = _emitUnder(id, ROW_ORDER_SIZE, L.G_EXACT, L.T_IMM);
        if (okPrice && okSize) {
            emit Revealed(id, side, price, qty);
        }
    }

    /// @notice Retire a rested-out order and release what stands behind it.
    /// @dev Permissionless, following `forfeit`, `Regime.adopt` and
    ///      `VolumeCap.enforce`. Nobody should have to ask the venue for their
    ///      own bond back, and a venue that alone could return it would have a
    ///      lever over every open order.
    ///
    ///      The refund is a credit rather than a transfer. See `credit`.
    function expire(bytes32 id) external {
        Order storage o = orders[id];
        if (o.trader == address(0)) revert UnknownOrder(id);
        if (o.retired) revert UnknownOrder(id);
        if (currentRound() <= o.lastRound) revert StillResting(roundEnd(o.lastRound));
        _retire(id, RETIRE_EXPIRED);
    }

    /// @notice Void your own commitment before its reveal window opens. The bond
    ///         comes back less `cancelFee`.
    ///
    /// @dev **Where the window closes is the security argument.** Cancel is legal
    ///      on `[committedAt, committedAt + revealDelay)` and reveal on the
    ///      window after it; the two are disjoint and the boundary is not a
    ///      taste. The bond prices an option to walk away, and lapsing costs the
    ///      whole bond. Let cancel reach into the reveal window and a committer
    ///      watching the market turn pays `cancelFee` instead, cancel dominates
    ///      lapse at every parameter, and the bond stops pricing non-reveal at
    ///      all. Before `revealDelay` the committer could not have revealed
    ///      anyway, so leaving there forgoes nothing they held; from it onward
    ///      the choice is between two live alternatives and a discount on one
    ///      reprices the other. `test_cancelClosesAtTheInstantRevealOpens` and
    ///      `testFuzz_theWindowsPartitionTheCommitmentLifetime`.
    ///
    ///      Committer only: see `NotCommitter`.
    ///
    ///      A ceiling breach reverts the whole call, so with row 15 unpublished
    ///      the feature does not exist and the failure mode is the status quo:
    ///      the trader keeps their commitment, their bond and both other exits.
    ///      Budget exhaustion is Rule A as everywhere else, withholding only the
    ///      event.
    function cancel(bytes32 id) external {
        Commitment storage c = commitments[id];
        if (c.committer == address(0)) revert UnknownCommitment(id);
        if (c.committer != msg.sender) revert NotCommitter(c.committer);
        if (c.cancelled) revert AlreadyCancelled(id);
        // Reachable through `forfeit`, which sets `revealed` as a tombstone, not
        // through a reveal. Ordered before the window check so a terminal id is
        // told which terminal state it is in rather than blamed on a clock that
        // is not the reason. `test_aSweptCommitmentCannotBeCancelled`.
        if (c.revealed) revert AlreadyRevealed(id);
        uint64 opensAt = c.committedAt + revealDelay;
        if (block.timestamp >= opensAt) revert CancelWindowClosed(opensAt);

        // `c.bond` is `commitBond` here: `commit` is the only writer that sets
        // it, and the other two zero it behind guards already checked above. With
        // `cancelFee <= commitBond` from the constructor this cannot underflow,
        // and a broken invariant reverts rather than paying a wrong refund.
        uint256 refund = c.bond - cancelFee;
        c.cancelled = true;
        c.bond = 0;
        feesRetained += cancelFee;
        // A credit, following `expire`. Not on the clearing path today, so this
        // is consistency rather than necessity: one ledger, one `withdraw`, no
        // second payout path to audit.
        if (refund != 0) credit[msg.sender] += refund;

        // Effects first: a policy re-entering through `_emitUnder`'s reads meets
        // `AlreadyCancelled` rather than a second refund.
        if (_emitUnder(id, ROW_ACTIVITY, L.G_PRED, L.T_IMM)) {
            emit Cancelled(id);
        }
    }

    /// @notice The first instant at which `id` can no longer be cancelled, or
    ///         zero when it cannot be cancelled at all.
    /// @dev **Exclusive**: `cancel` refuses at the returned value and `reveal`
    ///      accepts at it. Public so a client need not guess which side of the
    ///      boundary the contract puts, as with `eligibleIn`.
    function cancellableUntil(bytes32 id) public view returns (uint64) {
        Commitment storage c = commitments[id];
        if (c.committer == address(0)) return 0;
        if (c.revealed || c.cancelled) return 0;
        return c.committedAt + revealDelay;
    }

    /// @notice Take what is owed. One call, whatever it accrued from.
    function withdraw() external nonReentrant {
        uint256 amount = credit[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credit[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    /// @notice Sweep a commitment that was never opened. Permissionless.
    /// @dev The bond goes to the caller, not to the venue, so sweeping is somebody's
    ///      job rather than nobody's. A venue that collected it would have an
    ///      incentive to make reveals fail.
    function forfeit(bytes32 id) external {
        Commitment storage c = commitments[id];
        if (c.committer == address(0)) revert UnknownCommitment(id);
        if (c.revealed) revert AlreadyRevealed(id);
        // Otherwise a cancelled commitment stays sweepable: the bond is zero so
        // the sweeper is paid nothing, but the call succeeds and emits
        // `BondForfeited(id, 0)`. An event stream reporting a forfeit that did
        // not happen is one a supervisor cannot reconcile against the balance.
        if (c.cancelled) revert AlreadyCancelled(id);
        uint64 closesAt = c.committedAt + revealDelay + revealWindow;
        if (block.timestamp <= closesAt) revert StillRevealable(closesAt);

        uint256 bond = c.bond;
        c.bond = 0;
        c.revealed = true;
        emit BondForfeited(id, bond);
        if (bond != 0) {
            (bool ok,) = msg.sender.call{value: bond}("");
            require(ok, "forfeit transfer failed");
        }
    }

    /// @notice How many orders can still trade.
    /// @dev **Not how many have ever been revealed**, which is what the field
    ///      this replaced counted. The difference is the whole of item one: a
    ///      number that only ever goes up is not a book.
    function revealedCount() public view returns (uint256) {
        return _live.length;
    }

    function liveAt(uint256 i) public view returns (bytes32) {
        return _live[i];
    }

    /// @notice Whether `id` is on the live book at all.
    function isLive(bytes32 id) public view returns (bool) {
        return _liveIndex[id] != 0;
    }

    /// @notice Whether `id` can be crossed in round `r`.
    /// @dev The predicate the engine builds each round's book from, exposed so a
    ///      client can compute the same answer without replaying the round.
    function eligibleIn(bytes32 id, uint64 r) public view returns (bool) {
        Order storage o = orders[id];
        if (o.retired || o.trader == address(0)) return false;
        if (r < o.firstRound || r > o.lastRound) return false;
        return o.filled < o.qty;
    }

    // ------------------------------------------------------ retirement hooks

    /// @notice Called at reveal, before any disclosure, to check that the order
    ///         is backed. Reverts to refuse the reveal.
    /// @dev Empty here, and that is the honest default rather than a stub: this
    ///      contract does not know what asset it trades, so it cannot say what
    ///      backing means. `MatchingEngine` overrides it with the ATS hold on the
    ///      sell side and the cash escrow on the buy side. A bare `OrderBook` is
    ///      a book of unbacked intentions, which is a legitimate thing to test
    ///      and not a thing to settle against.
    // solhint-disable-next-line no-empty-blocks
    function _bind(bytes32 id, Order memory o, uint256 backing) internal virtual {}

    /// @notice Called when an order leaves the book, to release what `_bind`
    ///         reserved.
    /// @dev **Must not revert.** Retirement happens inside `crossRound`, which is
    ///      permissionless and touches every filled order in the round, so a
    ///      release that can fail is a release one participant can use to stop
    ///      the venue clearing. The engine's override releases an ATS hold and
    ///      credits cash, and does neither in a way that can throw.
    // solhint-disable-next-line no-empty-blocks
    function _unbind(bytes32 id, Order memory o, uint8 reason) internal virtual {}

    /// @dev Swap and pop, so the live array stays dense and a round costs the
    ///      resting window rather than the venue's history.
    function _retire(bytes32 id, uint8 reason) internal {
        Order storage o = orders[id];
        if (o.retired) return;
        o.retired = true;

        uint256 idx = _liveIndex[id];
        if (idx != 0) {
            uint256 last = _live.length;
            if (idx != last) {
                bytes32 moved = _live[last - 1];
                _live[idx - 1] = moved;
                _liveIndex[moved] = idx;
            }
            _live.pop();
            delete _liveIndex[id];
        }

        _unbind(id, o, reason);

        // The performance bond, back to the trader who posted it.
        Commitment storage c = commitments[id];
        uint256 bond = c.bond;
        if (bond != 0) {
            c.bond = 0;
            credit[o.trader] += bond;
        }
        emit Retired(id, reason);
    }

    /// @notice Every event this contract emits passes through here.
    /// @dev Ceiling then budget, and the two fail differently on purpose. A
    ///      ceiling breach is a configuration error and reverts. An exhausted
    ///      budget is the mechanism working, so the event is withheld and the
    ///      transaction completes: a trader must not lose a reveal window, or a
    ///      bond, because the venue ran out of things it may say. Rule A in
    ///      `DisclosureMeter`.
    /// @return afforded Whether the caller should emit.
    function _emitUnder(bytes32 id, uint16 row, uint8 g, uint8 t)
        internal
        returns (bool afforded)
    {
        uint32 over = L.excess(policy.ceilingFor(row), L.point(g, t));
        if (over != 0) {
            emit DisclosureRefused(id, row, over);
            revert DisclosureExceedsCeiling(row, over);
        }
        return DisclosureMeter.spend(_meter, policy, row, g);
    }

    /// @notice Bits spent against a row's coalition budget in an epoch.
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

    function ceilingFor(uint16 row) external view returns (uint32) {
        return policy.ceilingFor(row);
    }

    function wouldDisclose(uint16 row, uint8 g, uint8 t) external view returns (bool) {
        return L.permits(policy.ceilingFor(row), L.point(g, t));
    }

    // -------------------------------------------------------------------------
    // The three blockers this comment used to name, and where they went.
    //
    //  1. **Row 12, counterparty relationship.** Settled by admitting the cell.
    //     `venue/docs/MATCHING.md` section 3 carries the arithmetic: a netted
    //     layer hides a counterparty only if the netting set holds more than one
    //     trade, and at this venue's rate a set of five needs a weekly batch and
    //     anything worth calling private needs the 30 day epoch that an earlier measurement
    //     already ruled out on the time axis for row 16. Same mechanism, same
    //     arithmetic, opposite row. Row 12 is published at `(exact, {pub}, imm)`
    //     and named as a stated limit, which is the disposition row 16 already
    //     has.
    //  2. **Row 13, the match predicate.** Not a dependent sum here. `dep?` marks
    //     it because the observer set is computed from the hidden value; in a
    //     call auction over already revealed orders under a public deterministic
    //     rule, nothing is hidden at evaluation time and anyone recomputes the
    //     match from the tape. No evaluator, so no trusted evaluator surface,
    //     which is `docs/who-gets-privacy.md` DP-03's owed two column list
    //     getting its first entry on the good side.
    //  3. **Price-time priority.** There is none, because there is nothing for
    //     it to do. See `CallAuction`.
    //
    // The engine is `MatchingEngine`, which extends this contract rather than
    // replacing it: commitment, reveal, disclosure and the bond live here, and
    // clearing and settlement live there.
    // -------------------------------------------------------------------------
}
