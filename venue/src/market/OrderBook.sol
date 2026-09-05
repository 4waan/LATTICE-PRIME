// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {DisclosureLattice as L} from "../lattice/DisclosureLattice.sol";
import {IDisclosurePolicy} from "../interfaces/IDisclosurePolicy.sol";
import {DisclosureView} from "../lattice/DisclosureView.sol";
import {OrderBookBase} from "./OrderBookBase.sol";

/// @title OrderBook
/// @notice Commit-reveal book for ATS assets. Always one `bytes32`.
/// @dev Hedera: ~29 consensus operators see plaintext before execution.
///      Bond stays until retire, not returned at reveal. Cancel fee:
///      `ceil(B·D/(D+W))`, window closes when reveal opens. keccak on chain,
///      Poseidon in circuit. `docs/MATCHING.md`, `docs/MATH.md`.
contract OrderBook is OrderBookBase, DisclosureView {
    enum Side {
        BUY,
        SELL
    }

    /// @param cancelled Its own flag and not a reuse of `revealed`, which `forfeit` sets
    ///        to mean "no longer openable". Conflating them makes a cancelled id report
    ///        `AlreadyRevealed`.
    struct Commitment {
        address committer;
        uint64 committedAt;
        bool revealed;
        bool cancelled;
        uint256 bond;
    }

    /// @param filled Cumulative across every round this order has rested through.
    /// @param firstRound The round it was revealed into, so the first it can cross in.
    /// @param lastRound `firstRound + restRounds`. Past it `expire` returns the bond.
    /// @param retired Off the live list and unable to return, so a second `expire` is a
    ///        no-op rather than a second refund.
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

    /// @notice How long after a commitment the reveal window opens, and how long it lasts.
    /// @dev A delay and not just a window. Reveal immediately and the plaintext reaches
    ///      the node operators at the moment it would have anyway.
    uint64 public immutable revealDelay;
    uint64 public immutable revealWindow;

    /// @notice Posted at commit, held for the order's whole life, forfeited if never
    ///         revealed, returned when the order retires.
    /// @dev Not returned at reveal, which is where it used to go and where it was a hole:
    ///      between reveal and cross the order is the only thing a counterparty trades
    ///      against, and a book holding nothing at stake over that interval is trading an
    ///      unfunded promise. The bond converts to a performance bond at reveal. Backing
    ///      the order in the asset or in cash is the larger half, and lives in `_bind`.
    uint256 public immutable commitBond;

    /// @notice What a committer pays to void their own commitment before reveal opens.
    /// @dev Derived rather than chosen, and retained rather than paid to anyone. The
    ///      derivation is `docs/MATH.md`; `minimumCancelFee` computes the floor and the
    ///      constructor enforces it. Nobody receives it because every candidate recipient
    ///      would gain an incentive to want cancellations.
    uint256 public immutable cancelFee;

    /// @notice Cancel fees this contract has kept. Nothing withdraws them.
    /// @dev Accounted rather than stuck: `balance == sum(credit) + sum(live bonds) +
    ///      feesRetained` for a bare book, pinned by `invariant_bondsAreConserved`.
    uint256 public feesRetained;

    /// @notice How long a clearing round is, and how many rounds an unfilled order rests
    ///         before it expires.
    /// @dev Resting is the design lever and it is measured rather than assumed. The
    ///      crossing rates and the disclosure argument for resting over re-committing are
    ///      in `docs/MATCHING.md`.
    uint64 public immutable roundLength;
    uint64 public immutable restRounds;

    /// @notice Round zero starts here. Deploy time.
    /// @dev An explicit origin, because `block.timestamp / roundLength` makes the round
    ///      boundary a property of the unix epoch and so unstateable in a prospectus.
    uint64 public immutable genesis;

    mapping(bytes32 => Commitment) public commitments;
    mapping(bytes32 => Order) public orders;

    /// @notice The live book: revealed, unretired, still crossable.
    /// @dev Retirement swaps and pops, so the length is the number of orders that can
    ///      still trade and a round costs the resting window rather than all history.
    bytes32[] private _live;

    /// @dev One-based, so zero reads as absent. The off-by-one here deletes order zero
    ///      on every retirement.
    mapping(bytes32 => uint256) private _liveIndex;

    /// @notice Owed to an address, withdrawable by it.
    /// @dev Pull and not push, because `crossRound` is permissionless and touches every
    ///      filled order: one trader whose `receive` reverts could otherwise stop the
    ///      venue clearing, for free, forever. `forfeit` keeps a direct transfer because
    ///      there the recipient is `msg.sender`.
    mapping(address => uint256) public credit;

    /// @dev Nothing in ATS carries a reentrancy guard, so this does. `crossRound`
    ///      settles through ATS and `withdraw` pays out; neither may re-enter itself.
    uint256 private _lock = 1;

    /// @dev The body is two calls rather than inline code, because a modifier is copied
    ///      into every function carrying it and `MatchingEngine`, which inherits every
    ///      byte of this file, sits at 88 percent of the contract size limit.
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

    /// @dev The one event that stays here rather than in `OrderBookBase`, because it
    ///      carries `Side`. Rows 4 and 3 at once.
    event Revealed(bytes32 indexed id, Side side, uint128 price, uint128 qty);

    constructor(
        uint64 revealDelay_,
        uint64 revealWindow_,
        uint256 commitBond_,
        uint256 cancelFee_,
        IDisclosurePolicy policy_,
        uint64 roundLength_,
        uint64 restRounds_
    ) DisclosureView(policy_) {
        if (roundLength_ == 0) revert ZeroRoundLength();
        if (cancelFee_ > commitBond_) revert CancelFeeExceedsBond(cancelFee_, commitBond_);
        // Jointly satisfiable because the floor is a fraction of the bond:
        // `testFuzz_theFloorNeverExceedsTheBond`.
        uint256 floor_ = minimumCancelFee(commitBond_, revealDelay_, revealWindow_);
        if (cancelFee_ < floor_) revert CancelFeeTooLow(cancelFee_, floor_);

        revealDelay = revealDelay_;
        revealWindow = revealWindow_;
        commitBond = commitBond_;
        cancelFee = cancelFee_;
        roundLength = roundLength_;
        restRounds = restRounds_;
        genesis = uint64(block.timestamp);
    }

    /// @notice The least cancel fee that does not make cancelling the cheaper way to buy
    ///         a second of phantom order book.
    /// @dev `ceil(bond * delay / (delay + window))`. Rounded up because truncating leaves
    ///      the fee a wei short of the bound, at which the cancelled phantom is strictly
    ///      cheapest. Public and pure for the reason `commitmentOf` is.
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

    /// @notice The commitment a client must produce. Public so the client and the
    ///         contract cannot disagree about the preimage; the committer is inside it so
    ///         a commitment lifted off the wire cannot be revealed by whoever took it.
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
    /// @param backing One word, opaque here, handed to `_bind`: the ATS hold id on a sell,
    ///        unused on a buy where cash arrives as `msg.value`. Not in the commitment
    ///        preimage, because a hold id is created after the commitment was sealed.
    /// @dev A reveal is firm. The bond stays posted, `_bind` must accept, and the order
    ///      joins the live book for `restRounds + 1` rounds. `payable` because the buy
    ///      side's escrow arrives here, which discloses nothing new: this transaction
    ///      already carries the price and quantity in the clear. At `commit` it would.
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

        // Before any disclosure, so an order that cannot be backed leaves no trace
        // beyond the commitment that was already public.
        _bind(id, orders[id], backing);

        // Rows 4 and 3, both at `(exact, imm)`. The matrix as written wants price
        // deferred and size bucketed, and reaches those cells through a stage where the
        // venue holds the value and the public does not. A public ledger has no such
        // stage, so both rows are published at `(exact, imm)` under the committed root
        // instead: `test_theMatrixAsWrittenRefusesTheReveal` shows this reverting under
        // the matrix verbatim. Two bools and not `&&`, because short circuiting would let
        // the size row escape the meter whenever the price row was already spent.
        bool okPrice = _emitUnder(id, ROW_ORDER_PRICE, L.G_EXACT, L.T_IMM);
        bool okSize = _emitUnder(id, ROW_ORDER_SIZE, L.G_EXACT, L.T_IMM);
        if (okPrice && okSize) {
            emit Revealed(id, side, price, qty);
        }
    }

    /// @notice Retire a rested-out order and release what stands behind it.
    /// @dev Permissionless: a venue that alone could return a bond would hold a lever
    ///      over every open order. The refund is a credit rather than a transfer.
    function expire(bytes32 id) external {
        Order storage o = orders[id];
        if (o.trader == address(0)) revert UnknownOrder(id);
        if (o.retired) revert UnknownOrder(id);
        if (currentRound() <= o.lastRound) revert StillResting(roundEnd(o.lastRound));
        _retire(id, RETIRE_EXPIRED);
    }

    /// @notice Void your own commitment before its reveal window opens. The bond comes
    ///         back less `cancelFee`. Committer only.
    /// @dev Where the window closes is the security argument. Cancel and reveal are
    ///      disjoint, and letting cancel reach into the reveal window means a committer
    ///      watching the market turn pays the fee instead of the bond, cancel dominates
    ///      lapse at every parameter, and the bond stops pricing non-reveal at all.
    ///      `test_cancelClosesAtTheInstantRevealOpens` and
    ///      `testFuzz_theWindowsPartitionTheCommitmentLifetime`.
    function cancel(bytes32 id) external {
        Commitment storage c = commitments[id];
        if (c.committer == address(0)) revert UnknownCommitment(id);
        if (c.committer != msg.sender) revert NotCommitter(c.committer);
        if (c.cancelled) revert AlreadyCancelled(id);
        // Reachable through `forfeit`, which sets `revealed` as a tombstone. Before the
        // window check, so a terminal id is told which terminal state it is in rather
        // than blamed on a clock. `test_aSweptCommitmentCannotBeCancelled`.
        if (c.revealed) revert AlreadyRevealed(id);
        uint64 opensAt = c.committedAt + revealDelay;
        if (block.timestamp >= opensAt) revert CancelWindowClosed(opensAt);

        // `commit` is the only writer of `c.bond` and the constructor holds
        // `cancelFee <= commitBond`, so this cannot underflow.
        uint256 refund = c.bond - cancelFee;
        c.cancelled = true;
        c.bond = 0;
        feesRetained += cancelFee;
        // A credit, following `expire`: one ledger, one `withdraw`, no second payout
        // path to audit.
        if (refund != 0) credit[msg.sender] += refund;

        // Effects first: a policy re-entering through `_emitUnder`'s reads meets
        // `AlreadyCancelled` rather than a second refund.
        if (_emitUnder(id, ROW_ACTIVITY, L.G_PRED, L.T_IMM)) {
            emit Cancelled(id);
        }
    }

    /// @notice The first instant at which `id` can no longer be cancelled, or zero when
    ///         it cannot be cancelled at all.
    /// @dev Exclusive: `cancel` refuses at this value and `reveal` accepts at it.
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
    /// @dev The bond goes to the caller and not the venue, so sweeping is somebody's job
    ///      and the venue gains nothing from a failed reveal.
    function forfeit(bytes32 id) external {
        Commitment storage c = commitments[id];
        if (c.committer == address(0)) revert UnknownCommitment(id);
        if (c.revealed) revert AlreadyRevealed(id);
        // Otherwise a cancelled commitment stays sweepable and emits
        // `BondForfeited(id, 0)`, which a supervisor cannot reconcile against the balance.
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

    /// @notice How many orders can still trade. Not how many were ever revealed.
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
    /// @dev The predicate the engine builds each round's book from, public so a client
    ///      reaches the same answer without replaying the round.
    function eligibleIn(bytes32 id, uint64 r) public view returns (bool) {
        Order storage o = orders[id];
        if (o.retired || o.trader == address(0)) return false;
        if (r < o.firstRound || r > o.lastRound) return false;
        return o.filled < o.qty;
    }

    // ------------------------------------------------------ retirement hooks

    /// @notice Called at reveal, before any disclosure, to check the order is backed.
    ///         Reverts to refuse the reveal.
    /// @dev Empty here because this contract does not know what asset it trades.
    ///      `MatchingEngine` overrides it with the ATS hold on the sell side and the cash
    ///      escrow on the buy side. A bare `OrderBook` is a book of unbacked intentions.
    // solhint-disable-next-line no-empty-blocks
    function _bind(bytes32 id, Order memory o, uint256 backing) internal virtual {}

    /// @notice Called when an order leaves the book, to release what `_bind` reserved.
    /// @dev Must not revert. Retirement runs inside the permissionless `crossRound`, so a
    ///      release that can fail is one a participant can use to stop the venue clearing.
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

    // `MatchingEngine` extends this contract rather than replacing it: commitment,
    // reveal, disclosure and the bond live here, clearing and settlement live there.
    // The counterparty, match predicate and priority questions are in `docs/MATCHING.md`.
}
