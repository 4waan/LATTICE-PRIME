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

    struct Commitment {
        address committer;
        uint64 committedAt;
        bool revealed;
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
    /// @dev **Provably inert for this contract, and that is the finding rather
    ///      than dead code.** Every cell this book discloses is at `G_EXACT`:
    ///      row 17 at commit, rows 3 and 4 at reveal. `DisclosureBudget`
    ///      requires `budgetBits < domainBits` and an exact disclosure costs
    ///      `domainBits`, so no well formed budget can ever afford one, and
    ///      `ParameterRoot` refuses to publish a budget against a row whose
    ///      ceiling admits exact. An order book that publishes everything
    ///      exactly has nothing to meter.
    ///
    ///      The lever this leaves is a coarser disclosure, not a tighter bound,
    ///      which is precisely what section 7.2 asked for on row 3
    ///      (`(bucket, EOD)`) and what `asDeployed` gave up.
    ///      `test_theOrderBookIsUnmeterableByConstruction` pins the reasoning so
    ///      that a future sub-exact cell inherits a working meter rather than a
    ///      forgotten one.
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
    ///      sits at 83 percent of EIP-170. an earlier measurement is why that number is watched.
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

    constructor(
        uint64 revealDelay_,
        uint64 revealWindow_,
        uint256 commitBond_,
        IDisclosurePolicy policy_,
        uint64 roundLength_,
        uint64 restRounds_
    ) {
        if (roundLength_ == 0) revert ZeroRoundLength();
        revealDelay = revealDelay_;
        revealWindow = revealWindow_;
        commitBond = commitBond_;
        policy = policy_;
        roundLength = roundLength_;
        restRounds = restRounds_;
        genesis = uint64(block.timestamp);
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
