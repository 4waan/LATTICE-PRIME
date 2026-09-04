// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {OrderBook} from "../src/market/OrderBook.sol";
import {ParameterRoot} from "../src/policy/ParameterRoot.sol";
import {PolicyFixture} from "./PolicyFixture.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {DisclosureBudget as B} from "../src/lattice/DisclosureBudget.sol";

/// @title CancelHandler
/// @notice The actor for `invariant_bondsAreConserved`. Every entry point the
///         bond can move through, driven at random.
///
/// @dev Every action is wrapped in `try` by design. A run that only made legal
///      calls would test the sequence the handler author imagined; what the
///      conservation law has to survive is a cancel racing a forfeit, a reveal
///      after a cancel, a withdrawal between the two. Swallowing the reverts is
///      what lets the fuzzer reach them.
contract CancelHandler is Test {
    struct Preimage {
        address who;
        OrderBook.Side side;
        uint128 price;
        uint128 qty;
        bytes32 salt;
    }

    OrderBook public immutable book;
    uint256 public immutable bond;

    address[3] public actors;
    bytes32[] public ids;
    mapping(bytes32 => Preimage) public preimageOf;
    mapping(bytes32 => bool) public known;

    /// @dev Capped so the invariant's own sum stays cheap. Twenty four
    ///      commitments is more than enough concurrency to interleave the four
    ///      terminal states; the depth of the run supplies the rest.
    uint256 internal constant MAX_IDS = 24;

    /// @notice How many of each action actually landed.
    /// @dev The `try` blocks make success invisible, so a run in which every call
    ///      reverted would report zero reverts and pass every invariant having
    ///      tested nothing. `afterInvariant` reads these and fails such a run.
    uint256 public commits;
    uint256 public cancels;
    uint256 public reveals;
    uint256 public forfeits;
    uint256 public expiries;
    uint256 public withdrawals;

    constructor(OrderBook book_) {
        book = book_;
        bond = book_.commitBond();
        actors = [address(0xA1), address(0xA2), address(0xA3)];
        for (uint256 i = 0; i < 3; ++i) {
            vm.deal(actors[i], 1_000 ether);
        }
    }

    function actorCount() external pure returns (uint256) {
        return 3;
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function _pick(uint256 seed) internal view returns (bytes32 id, bool ok) {
        if (ids.length == 0) return (bytes32(0), false);
        return (ids[seed % ids.length], true);
    }

    /// @notice The newest commitment that has taken no exit yet.
    ///
    /// @dev **The coverage gate proved this was needed.** A commitment is
    ///      cancellable for five minutes and revealable for the thirty after,
    ///      but stays in `ids` all run, so a uniform pick asks the fuzzer to hit
    ///      a target that shrinks as the list grows. It did not: the first
    ///      version landed zero reveals in 128,000 calls and three invariants
    ///      passed over a book where no order had ever been opened. Newest,
    ///      because a live window opens when the commitment is posted.
    ///
    ///      **This narrows nothing.** Each caller falls back to the uniform
    ///      `_pick` one time in four, so the stale orderings the guards live on
    ///      are still reached.
    function _pickOpen() internal view returns (bytes32 id, bool ok) {
        for (uint256 i = ids.length; i > 0; --i) {
            (address who,, bool revealed, bool cancelled,) = book.commitments(ids[i - 1]);
            if (who != address(0) && !revealed && !cancelled) return (ids[i - 1], true);
        }
        return (bytes32(0), false);
    }

    /// @dev Eviction is why cancels keep happening late in a run. Without it the
    ///      list saturates, `doCommit` returns early, and no commitment is ever
    ///      fresh again: a cancel is legal for five minutes and every survivor is
    ///      hours past that. Measured, the saturating version landed a third of
    ///      the cancels.
    ///
    ///      **Evicting only at `bond == 0` keeps the conservation sum exact.** A
    ///      bond goes to zero once, at whichever exit it took, and nothing can
    ///      raise it again because `commit` refuses an existing id. So a
    ///      zero-bond id contributes zero whether it is in the list or not.
    function doCommit(uint256 seed) external {
        if (ids.length >= MAX_IDS) {
            bool evicted;
            for (uint256 i = 0; i < ids.length; ++i) {
                (,,,, uint256 held) = book.commitments(ids[i]);
                if (held != 0) continue;
                ids[i] = ids[ids.length - 1];
                ids.pop();
                evicted = true;
                break;
            }
            if (!evicted) return;
        }
        address who = actors[seed % 3];
        Preimage memory pre = Preimage({
            who: who,
            side: seed % 2 == 0 ? OrderBook.Side.BUY : OrderBook.Side.SELL,
            price: uint128(bound(seed, 1, 1_000)),
            qty: uint128(bound(seed >> 8, 1, 1_000)),
            salt: keccak256(abi.encode(seed, ids.length))
        });
        // Before the prank. `commitmentOf` is an external call and would consume
        // it, which `PolicyFixture` already records as costing a debugging cycle.
        bytes32 id = book.commitmentOf(who, pre.side, pre.price, pre.qty, pre.salt);
        if (known[id]) return;
        vm.prank(who);
        try book.commit{value: bond}(id) {
            known[id] = true;
            preimageOf[id] = pre;
            ids.push(id);
            commits++;
        } catch {}
    }

    function doCancel(uint256 seed) external {
        (bytes32 id, bool ok) = seed % 4 == 0 ? _pick(seed) : _pickOpen();
        if (!ok) return;
        vm.prank(preimageOf[id].who);
        try book.cancel(id) {
            cancels++;
        } catch {}
    }

    /// @notice Reveal, usually after stepping the clock into the chosen id's
    ///         reveal window.
    ///
    /// @dev **The one compound action, and the coverage gate is why.** Reaching a
    ///      reveal out of eight uniform actions needs the exact sequence commit,
    ///      small warp, reveal, on the same id: measured at about a seventh of a
    ///      reveal per run. So three times in four this steps to a random instant
    ///      inside that id's window first.
    ///
    ///      **The clock advance is a precondition, not a state transition**, and
    ///      the conservation law is a claim about transitions. The remaining
    ///      quarter reveals at whatever time the run has reached, so mistimed
    ///      orderings are still explored. Time only moves forward.
    function doReveal(uint256 seed) external {
        (bytes32 id, bool ok) = seed % 4 == 0 ? _pick(seed) : _pickOpen();
        if (!ok) return;
        Preimage memory pre = preimageOf[id];
        if (seed % 4 != 0) {
            (, uint64 committedAt,,,) = book.commitments(id);
            uint64 opensAt = committedAt + book.revealDelay();
            uint64 closesAt = opensAt + book.revealWindow();
            if (block.timestamp < opensAt) vm.warp(bound(seed >> 16, opensAt, closesAt));
        }
        vm.prank(pre.who);
        try book.reveal(pre.side, pre.price, pre.qty, pre.salt, 0) {
            reveals++;
        } catch {}
    }

    function doForfeit(uint256 seed) external {
        (bytes32 id, bool ok) = _pick(seed);
        if (!ok) return;
        vm.prank(actors[seed % 3]);
        try book.forfeit(id) {
            forfeits++;
        } catch {}
    }

    function doExpire(uint256 seed) external {
        (bytes32 id, bool ok) = _pick(seed);
        if (!ok) return;
        try book.expire(id) {
            expiries++;
        } catch {}
    }

    function doWithdraw(uint256 seed) external {
        address who = actors[seed % 3];
        vm.prank(who);
        try book.withdraw() {
            withdrawals++;
        } catch {}
    }

    /// @notice Two clock steps, on two scales.
    /// @dev A single `bound(dt, 1, 3 days)` step made the whole invariant vacuous
    ///      and the coverage gate found it: a uniform step averaging a day and a
    ///      half stepped over the thirty minute reveal window every time. The
    ///      fine step lands inside the commit and reveal windows, the coarse one
    ///      reaches the resting horizon where `expire` becomes legal, and neither
    ///      scale reaches the other's states.
    function doWarpFine(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 12 minutes));
    }

    function doWarpCoarse(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1 hours, 3 days));
    }
}

/// @title OrderCancelTest
/// @notice The cancel, its bond policy, and the disclosure row it opened. Four
///         parts, four questions.
///
/// - **The mechanism.** Does the exit work and close every door it opened.
///   `test_aCancelledCommitmentCannotBeOpened` is the regression.
/// - **The windows.** Cancel is legal on `[commit, reveal)` and nowhere else,
///   and why the boundary is there rather than a second later is the whole
///   security argument.
/// - **The arithmetic.** The fee is derived from a rate inequality, checked as
///   that inequality over random inputs rather than as the formula it produced.
/// - **The disclosure.** One bit on row 15: the only cell in the book a
///   coalition budget can bind, and the venue's first divergence from section
///   7.2 that is incomparable to the matrix rather than looser or tighter.
contract OrderCancelTest is Test, PolicyFixture {
    OrderBook internal book;

    address internal constant ALICE = address(0xA11CE);
    address internal constant MALLORY = address(0x4A11);

    uint64 internal constant DELAY = 5 minutes;
    uint64 internal constant WINDOW = 30 minutes;
    uint256 internal constant BOND = 0.1 ether;
    uint64 internal constant ROUND = 1 days;
    uint64 internal constant REST = 7;
    /// `ceil(BOND * DELAY / (DELAY + WINDOW))`, as arithmetic rather than a
    /// literal. `test_theDeployedFeeIsTheDerivedMinimum` ties it to the contract.
    uint256 internal constant FEE = (BOND * DELAY + (DELAY + WINDOW) - 1) / (DELAY + WINDOW);

    uint16 internal constant ROW_ACTIVITY = 15;

    function setUp() public {
        vm.warp(1_000_000);
        _deployPolicy(asDeployed());
        book = new OrderBook(DELAY, WINDOW, BOND, FEE, params, ROUND, REST);
        vm.deal(ALICE, 10 ether);
        vm.deal(MALLORY, 10 ether);
    }

    function _commit(address who, bytes32 salt) internal returns (bytes32 id) {
        id = book.commitmentOf(who, OrderBook.Side.BUY, 101, 5_000, salt);
        vm.prank(who);
        book.commit{value: BOND}(id);
    }

    function _bondOf(bytes32 id) internal view returns (uint256 b) {
        (,,,, b) = book.commitments(id);
    }

    function _cancelledFlag(bytes32 id) internal view returns (bool c) {
        (,,, c,) = book.commitments(id);
    }

    // ==================================================== part 1, the mechanism

    /// @notice The exit exists, it pays the stated price, and it says one thing.
    function test_theCommitterCanVoidTheirOwnCommitment() public {
        bytes32 id = _commit(ALICE, "s1");
        assertEq(ALICE.balance, 10 ether - BOND, "bond posted");

        vm.expectEmit(true, false, false, true, address(book));
        emit OrderBook.Cancelled(id);
        vm.prank(ALICE);
        book.cancel(id);

        assertTrue(_cancelledFlag(id), "the flag is its own, not `revealed`");
        assertEq(_bondOf(id), 0, "nothing left at stake");
        assertEq(book.credit(ALICE), BOND - FEE, "the refund is a credit");
        assertEq(book.feesRetained(), FEE, "and the fee is accounted, not stuck");
        assertEq(book.revealedCount(), 0, "no order was ever created");
    }

    /// @notice The refund goes through the one ledger, like every other payout
    ///         that is not a sweep.
    function test_theRefundIsWithdrawable() public {
        bytes32 id = _commit(ALICE, "s1");
        vm.prank(ALICE);
        book.cancel(id);
        vm.prank(ALICE);
        book.withdraw();
        assertEq(ALICE.balance, 10 ether - FEE, "the committer paid exactly the fee");
        assertEq(address(book).balance, FEE, "which the book still holds");
    }

    /// @notice Cancelling is a choice, so it is the one call here that is not
    ///         permissionless. See `OrderBook.NotCommitter`.
    function test_onlyTheCommitterCanCancel() public {
        bytes32 id = _commit(ALICE, "s1");
        vm.prank(MALLORY);
        vm.expectRevert(abi.encodeWithSelector(OrderBook.NotCommitter.selector, ALICE));
        book.cancel(id);
        assertEq(_bondOf(id), BOND, "Mallory could not pull Alice's quote");
    }

    /// @notice A second cancel is not a second refund.
    function test_cancellingTwiceIsRefused() public {
        bytes32 id = _commit(ALICE, "s1");
        vm.prank(ALICE);
        book.cancel(id);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(OrderBook.AlreadyCancelled.selector, id));
        book.cancel(id);
        assertEq(book.credit(ALICE), BOND - FEE, "credited once");
    }

    function test_anUnknownCommitmentCannotBeCancelled() public {
        bytes32 id = keccak256("never committed");
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(OrderBook.UnknownCommitment.selector, id));
        book.cancel(id);
    }

    /// @notice **The regression, and the one thing this feature could plausibly
    ///         have broken.**
    ///
    /// A cancelled commitment still has a committer and `revealed == false`, and
    /// cancel closes at the instant reveal opens. So a trader who cancels one
    /// second before the boundary is inside the reveal window one second later,
    /// holding a commitment whose bond is already refunded. Without the
    /// `cancelled` guard in `reveal` they open it and stand on the live book with
    /// nothing at stake, which is the unfunded promise that keeping the bond past
    /// reveal exists to prevent. The refund would re-create the hole.
    function test_aCancelledCommitmentCannotBeOpened() public {
        bytes32 id = _commit(ALICE, "s1");
        vm.warp(block.timestamp + DELAY - 1);
        vm.prank(ALICE);
        book.cancel(id);

        vm.warp(block.timestamp + 2); // now inside the reveal window
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(OrderBook.AlreadyCancelled.selector, id));
        book.reveal(OrderBook.Side.BUY, 101, 5_000, "s1", 0);

        assertEq(book.revealedCount(), 0, "and no unbonded order reached the book");
        assertFalse(book.isLive(id));
    }

    /// @notice A cancelled commitment is not sweepable either.
    /// @dev The bond is zero so the sweeper is paid nothing, but the call would
    ///      succeed and emit `BondForfeited(id, 0)`. An event stream reporting a
    ///      forfeit that did not happen cannot be reconciled against the balance.
    function test_aCancelledCommitmentCannotBeSwept() public {
        bytes32 id = _commit(ALICE, "s1");
        vm.prank(ALICE);
        book.cancel(id);

        vm.warp(block.timestamp + DELAY + WINDOW + 1);
        uint256 before = MALLORY.balance;
        vm.prank(MALLORY);
        vm.expectRevert(abi.encodeWithSelector(OrderBook.AlreadyCancelled.selector, id));
        book.forfeit(id);
        assertEq(MALLORY.balance, before, "no phantom sweep");
    }

    /// @notice And the reverse: a swept commitment cannot then be cancelled, and
    ///         the error names the state rather than the clock.
    /// @dev Two guards refuse this and the informative one fires.
    ///      `CancelWindowClosed` is also true and useless, because the commitment
    ///      is gone and reopening the window would not bring it back.
    ///
    ///      **This is why the `revealed` check in `cancel` is not dead code**: it
    ///      is unreachable through a reveal, which the clock forbids, and
    ///      reachable through a sweep, which the clock requires.
    function test_aSweptCommitmentCannotBeCancelled() public {
        bytes32 id = _commit(ALICE, "s1");
        vm.warp(block.timestamp + DELAY + WINDOW + 1);
        book.forfeit(id);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(OrderBook.AlreadyRevealed.selector, id));
        book.cancel(id);
    }

    // ====================================================== part 2, the windows

    /// @notice The boundary, checked on both sides of the same second.
    ///
    /// @dev The security argument for the whole feature, checked at the
    ///      granularity the contract compares at. The bond prices an option to
    ///      decline, and lapsing costs `commitBond`. One second later and that
    ///      price becomes `cancelFee`, cancel dominates lapse at every parameter,
    ///      and **the feature quietly repeals an existing property.**
    function test_cancelClosesAtTheInstantRevealOpens() public {
        uint64 opensAt = uint64(block.timestamp) + DELAY;

        bytes32 early = _commit(ALICE, "early");
        vm.warp(opensAt - 1);
        vm.prank(ALICE);
        book.cancel(early); // legal with one second to spare

        bytes32 late = book.commitmentOf(ALICE, OrderBook.Side.BUY, 101, 5_000, "late");
        vm.prank(ALICE);
        book.commit{value: BOND}(late);
        uint64 lateOpensAt = uint64(block.timestamp) + DELAY;

        vm.warp(lateOpensAt);
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(OrderBook.CancelWindowClosed.selector, lateOpensAt)
        );
        book.cancel(late);

        // The same instant, and the other door is open.
        vm.prank(ALICE);
        book.reveal(OrderBook.Side.BUY, 101, 5_000, "late", 0);
        assertTrue(book.isLive(late), "reveal is legal at the instant cancel is not");
    }

    /// @notice The three exits tile the commitment's lifetime: at every instant
    ///         exactly one of cancel, reveal and forfeit is legal.
    ///
    /// @dev The two illegal probes come first and are `expectRevert`ed, leaving
    ///      no state behind, so one commitment answers all three questions at a
    ///      single instant. No gap and no overlap is what makes the bond policy
    ///      readable: a committer always has exactly one way out, and which one
    ///      depends only on the clock.
    function testFuzz_theWindowsPartitionTheCommitmentLifetime(uint64 offset) public {
        offset = uint64(bound(offset, 0, uint256(DELAY) + WINDOW + 2 days));
        uint64 committedAt = uint64(block.timestamp);
        bytes32 id = _commit(ALICE, "partition");
        vm.warp(committedAt + offset);

        if (offset < DELAY) {
            vm.prank(ALICE);
            vm.expectRevert(
                abi.encodeWithSelector(OrderBook.TooEarly.selector, committedAt + DELAY)
            );
            book.reveal(OrderBook.Side.BUY, 101, 5_000, "partition", 0);
            vm.expectRevert(
                abi.encodeWithSelector(
                    OrderBook.StillRevealable.selector, committedAt + DELAY + WINDOW
                )
            );
            book.forfeit(id);
            vm.prank(ALICE);
            book.cancel(id);
            assertTrue(_cancelledFlag(id), "cancel is the only exit before reveal opens");
        } else if (offset <= uint256(DELAY) + WINDOW) {
            vm.prank(ALICE);
            vm.expectRevert(
                abi.encodeWithSelector(
                    OrderBook.CancelWindowClosed.selector, committedAt + DELAY
                )
            );
            book.cancel(id);
            vm.expectRevert(
                abi.encodeWithSelector(
                    OrderBook.StillRevealable.selector, committedAt + DELAY + WINDOW
                )
            );
            book.forfeit(id);
            vm.prank(ALICE);
            book.reveal(OrderBook.Side.BUY, 101, 5_000, "partition", 0);
            assertTrue(book.isLive(id), "reveal is the only exit inside the window");
        } else {
            vm.prank(ALICE);
            vm.expectRevert(
                abi.encodeWithSelector(
                    OrderBook.CancelWindowClosed.selector, committedAt + DELAY
                )
            );
            book.cancel(id);
            vm.prank(ALICE);
            vm.expectRevert(
                abi.encodeWithSelector(OrderBook.TooLate.selector, committedAt + DELAY + WINDOW)
            );
            book.reveal(OrderBook.Side.BUY, 101, 5_000, "partition", 0);
            book.forfeit(id);
            assertEq(_bondOf(id), 0, "the sweep is the only exit after the window");
        }
    }

    /// @notice The view and the guard agree about which side of the boundary is
    ///         which.
    function test_cancellableUntilIsTheBoundaryTheContractUses() public {
        uint64 committedAt = uint64(block.timestamp);
        bytes32 id = _commit(ALICE, "s1");
        assertEq(book.cancellableUntil(id), committedAt + DELAY, "exclusive bound");

        vm.prank(ALICE);
        book.cancel(id);
        assertEq(book.cancellableUntil(id), 0, "a spent commitment is not cancellable");
        assertEq(book.cancellableUntil(keccak256("nothing")), 0, "nor is an unknown one");
    }

    /// @notice A book with no reveal delay has no cancel window, and that is
    ///         coherent rather than a hole.
    /// @dev Without a delay there is no moment at which a committer holds
    ///      something they cannot yet act on, so nothing for a cancel to release.
    ///      Such a book is already broken for the reason `revealDelay` documents.
    function test_aBookWithNoRevealDelayHasNoCancelWindow() public {
        OrderBook instant = new OrderBook(0, WINDOW, BOND, 0, params, ROUND, REST);
        bytes32 id = instant.commitmentOf(ALICE, OrderBook.Side.BUY, 101, 5_000, "s1");
        vm.prank(ALICE);
        instant.commit{value: BOND}(id);
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderBook.CancelWindowClosed.selector, uint64(block.timestamp)
            )
        );
        instant.cancel(id);
    }

    // =================================================== part 3, the arithmetic

    /// @notice The deployed fee is the derived floor and not a round number
    ///         somebody liked.
    function test_theDeployedFeeIsTheDerivedMinimum() public view {
        assertEq(book.cancelFee(), FEE, "the constant and the contract agree");
        assertEq(
            book.cancelFee(),
            book.minimumCancelFee(BOND, DELAY, WINDOW),
            "and the fee is exactly the floor"
        );
        // `ceil(0.1e18 * 300 / 2100)`, which is one seventh of the bond rounded
        // up, because the reveal delay is one seventh of the commitment's life.
        assertEq(book.cancelFee(), 14_285_714_285_714_286, "one seventh, rounded up");
        assertTrue(book.cancelFee() < BOND, "and strictly cheaper than lapsing");
    }

    /// @notice A fee one wei under the floor cannot be deployed.
    /// @dev The single wei matters because the bound is an inequality on a rate
    ///      and the floor is its ceiling division. At `floor - 1` the cancelled
    ///      phantom is strictly the cheapest per second, which is the one thing
    ///      the derivation rules out.
    function test_aFeeBelowTheFloorCannotBeDeployed() public {
        uint256 floor_ = book.minimumCancelFee(BOND, DELAY, WINDOW);
        vm.expectRevert(
            abi.encodeWithSelector(OrderBook.CancelFeeTooLow.selector, floor_ - 1, floor_)
        );
        new OrderBook(DELAY, WINDOW, BOND, floor_ - 1, params, ROUND, REST);

        // And the floor itself deploys, so the bound is tight rather than merely
        // restrictive.
        OrderBook ok = new OrderBook(DELAY, WINDOW, BOND, floor_, params, ROUND, REST);
        assertEq(ok.cancelFee(), floor_);
    }

    /// @notice A fee above the bond cannot be deployed, or a cancel would charge
    ///         more than was ever posted.
    function test_aFeeAboveTheBondCannotBeDeployed() public {
        vm.expectRevert(
            abi.encodeWithSelector(OrderBook.CancelFeeExceedsBond.selector, BOND + 1, BOND)
        );
        new OrderBook(DELAY, WINDOW, BOND, BOND + 1, params, ROUND, REST);
    }

    /// @notice The two constructor checks are never jointly unsatisfiable.
    /// @dev `minimumCancelFee <= bond` because `delay <= delay + window`, so a
    ///      deployable fee always exists. Bounds that could cross would make the
    ///      contract undeployable at some parameters, found only on trying.
    function testFuzz_theFloorNeverExceedsTheBond(uint256 bond_, uint64 delay, uint64 window)
        public
        view
    {
        bond_ = bound(bond_, 0, 1e30);
        delay = uint64(bound(delay, 0, 3650 days));
        window = uint64(bound(window, 0, 3650 days));
        assertLe(book.minimumCancelFee(bond_, delay, window), bond_, "a fee always exists");
    }

    /// @notice **The theorem the fee is derived from, checked as the inequality
    ///         rather than as the formula.**
    ///
    /// @dev Two ways to buy phantom order book: lapse, costing `bond` for
    ///      `delay + window` seconds, or cancel at `t < delay`, costing `fee` for
    ///      `t`. Neither may be cheaper per second, which is
    ///      `fee * (delay + window) >= bond * t` for every reachable `t`. This
    ///      asserts that, at the floor fee, over random parameters and instants.
    ///      It never mentions the closed form, so it still fails if
    ///      `minimumCancelFee` is rewritten to agree with the old formula rather
    ///      than with the requirement.
    function testFuzz_cancellingIsNeverTheCheaperPhantom(
        uint256 bond_,
        uint64 delay,
        uint64 window,
        uint64 t
    ) public view {
        bond_ = bound(bond_, 1, 1e24);
        delay = uint64(bound(delay, 1, 365 days));
        window = uint64(bound(window, 0, 365 days));
        // Every instant a cancel can actually happen at.
        t = uint64(bound(t, 0, uint256(delay) - 1));

        uint256 fee = book.minimumCancelFee(bond_, delay, window);
        assertGe(
            fee * (uint256(delay) + window),
            bond_ * uint256(t),
            "cancelling bought phantom more cheaply than lapsing"
        );
    }

    /// @notice The same claim once more, against the contract instead of the
    ///         formula, at the worst instant the window allows.
    /// @dev `t = delay - 1` is where the rate inequality binds, so an arithmetic
    ///      slip shows up as a committer paying less per second than a lapser.
    function test_theWorstCaseCancelIsStillNoCheaperThanLapsing() public {
        uint64 committedAt = uint64(block.timestamp);
        bytes32 id = _commit(ALICE, "worst");
        vm.warp(committedAt + DELAY - 1);
        vm.prank(ALICE);
        book.cancel(id);

        uint256 paid = BOND - book.credit(ALICE);
        uint64 phantomSeconds = DELAY - 1;
        assertEq(paid, FEE, "the committer paid the fee and nothing else");
        assertGe(
            paid * (uint256(DELAY) + WINDOW),
            BOND * uint256(phantomSeconds),
            "the cancelled phantom was not the cheaper one"
        );
    }

    /// @notice **The cost the feature does have, stated as a number rather than
    ///         argued away.**
    ///
    /// @dev A refundable cancel makes flooding cheaper in absolute terms and no
    ///      framing removes it: `n` phantoms cost `n * bond` lapsed and
    ///      `n * cancelFee` cancelled, a discount of `bond / cancelFee`. What the
    ///      rate bound buys is that the cheaper attack is proportionally
    ///      shorter-lived, so the discount is on phantom count, never on
    ///      phantom-seconds. Pinned because an unstated discount found later is a
    ///      finding and a stated one is a parameter.
    function test_theFloodDiscountIsExactlyStatedAndNotHidden() public {
        uint256 n = 5;
        uint256 spentCancelling;
        for (uint256 i = 0; i < n; ++i) {
            bytes32 id = _commit(ALICE, keccak256(abi.encode("flood", i)));
            vm.prank(ALICE);
            book.cancel(id);
        }
        spentCancelling = BOND * n - book.credit(ALICE);
        assertEq(spentCancelling, FEE * n, "cancelling n phantoms costs n fees");

        // The same n phantoms bought the other way, by letting them lapse.
        uint256 spentLapsing = BOND * n;

        // **The bound, and it is an inequality rather than the round number it
        // looks like.** The discount on phantom *count* is `bond / cancelFee`,
        // and the derivation caps that at the ratio of the lives,
        // `(delay + window) / delay`, which here is seven. It does not reach
        // seven, because the floor fee is a ceiling division and so is a few wei
        // above the exact seventh. The assertion is written as the cap it came
        // from; the integer ratio below records what that costs an attacker in
        // practice, which is one phantom out of every seven they hoped for.
        assertLe(
            spentLapsing * uint256(DELAY),
            spentCancelling * (uint256(DELAY) + WINDOW),
            "the count discount exceeded the ratio of the two phantom lifetimes"
        );
        assertEq(spentLapsing / spentCancelling, 6, "sixfold, not the sevenfold cap");
        assertEq((uint256(DELAY) + WINDOW) / DELAY, 7, "because the cap is seven");
    }

    // =================================================== part 4, the disclosure

    /// @notice Section 7.2 as written refuses the cancel, exactly as it refuses
    ///         the reveal, and for a different reason.
    /// @dev Rows 3 and 4 are refused because the venue publishes more than the
    ///      matrix allows. Row 15 is refused because it publishes *sooner*:
    ///      `(pred, imm)` against `(agg, EOD)`, granularity under the cell and
    ///      time not, and on that axis being under does not help.
    function test_theMatrixAsWrittenRefusesTheCancel() public {
        _publish(sevenTwoAsWritten());
        bytes32 id = _commit(ALICE, "s1");

        assertFalse(book.wouldDisclose(15, L.G_PRED, L.T_IMM), "row 15 refuses it");
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderBook.DisclosureExceedsCeiling.selector,
                ROW_ACTIVITY,
                L.excess(L.point(L.G_AGG, L.T_EOD), L.point(L.G_PRED, L.T_IMM))
            )
        );
        book.cancel(id);
        assertEq(_bondOf(id), BOND, "and the commitment is untouched");
    }

    /// @notice **The deployed cell is incomparable to the matrix cell.** Not
    ///         looser, not tighter.
    ///
    /// @dev Every previous divergence moved one way along one axis: rows 3, 4
    ///      and 5 all landed strictly above section 7.2 because a public ledger
    ///      has no `{ven}` distinct from `{pub}`. Row 15 discloses **less** per
    ///      event than the matrix allows and **sooner**, and neither ideal
    ///      contains the other.
    ///
    ///      The first place the venue needs the lattice to be a lattice rather
    ///      than a chain. A model ranking disclosures on one scale must call this
    ///      pair ordered, and either ordering is wrong about one of the axes.
    function test_theCancelCellIsIncomparableToTheMatrix() public pure {
        uint32 deployed = L.point(L.G_PRED, L.T_IMM);
        uint32 matrix = L.point(L.G_AGG, L.T_EOD);

        assertFalse(L.leq(deployed, matrix), "the matrix does not contain the deployed cell");
        assertFalse(L.leq(matrix, deployed), "nor the deployed cell the matrix");
        assertTrue(deployed != matrix, "and they are not the same cell");

        // What each holds that the other does not, named rather than implied.
        assertTrue(
            L.excess(matrix, deployed) != 0, "the deployed cell speaks sooner than the matrix"
        );
        assertTrue(
            L.excess(deployed, matrix) != 0, "the matrix speaks in more detail than the venue"
        );
    }

    /// @notice The lex rule the Python checker uses calls this pair ordered and
    ///         safe, which is a false negative on a live venue row.
    ///
    /// @dev `DisclosureLattice`'s header records that
    ///      `scripts/collusion-check.py` computes a lex maximum on `G x T^op` and
    ///      that it under-reports, with a constructed witness. This one is not
    ///      constructed: it is the cell the venue publishes on row 15 against the
    ///      cell the study wrote. The lex summary ranks the deployed cell
    ///      strictly **below** the matrix, reporting the venue as disclosing less
    ///      than allowed, while the ideal order says the two are incomparable and
    ///      the venue is outside the cell on the time axis. A checker answering
    ///      "under the ceiling" here clears a disclosure the contract needs a
    ///      parameter change to make.
    function test_theLexRuleCallsTheIncomparablePairSafe() public pure {
        uint32 deployed = L.point(L.G_PRED, L.T_IMM);
        uint32 matrix = L.point(L.G_AGG, L.T_EOD);

        (uint8 gD, uint8 tD, bool anyD) = L.lexSummary(deployed);
        (uint8 gM, uint8 tM, bool anyM) = L.lexSummary(matrix);
        assertTrue(anyD && anyM, "both cells are non-empty");
        assertEq(gD, L.G_PRED, "the deployed summary is (pred, imm)");
        assertEq(tD, L.T_IMM);
        assertEq(gM, L.G_AGG, "the matrix summary is (agg, EOD)");
        assertEq(tM, L.T_EOD);

        // Lex on `G x T^op`: compare granularity first, and only on a tie the
        // time, later being safer. Granularity decides it here.
        bool lexSaysSafe = gD < gM || (gD == gM && tD > tM);
        assertTrue(lexSaysSafe, "the lex rule clears the deployed cell");
        assertFalse(L.leq(deployed, matrix), "and the ideal order does not");
    }

    /// @notice With row 15 unpublished the feature does not exist, and the
    ///         failure mode is the behaviour that shipped before it.
    /// @dev Fail closed and gracefully: the commitment, the bond and both other
    ///      exits survive, so an ungranted venue leaves its traders exactly as
    ///      locked in as they already were.
    function test_anUnpublishedRowMeansNoCancelFeature() public {
        _publish(_withoutRow15());
        assertEq(book.ceilingFor(15), L.BOTTOM, "row 15 is un-granted");

        bytes32 id = _commit(ALICE, "s1");
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderBook.DisclosureExceedsCeiling.selector,
                ROW_ACTIVITY,
                L.point(L.G_PRED, L.T_IMM)
            )
        );
        book.cancel(id);

        assertEq(_bondOf(id), BOND, "the bond is untouched");
        assertEq(book.feesRetained(), 0, "and no fee was taken");
        // The status quo, in full: the trader can still open the order.
        vm.warp(block.timestamp + DELAY);
        vm.prank(ALICE);
        book.reveal(OrderBook.Side.BUY, 101, 5_000, "s1", 0);
        assertTrue(book.isLive(id));
    }

    /// @notice **The cancel is the only cell in the order book a coalition
    ///         budget can bind.**
    ///
    /// @dev `DisclosureMeter`'s header records the book as unmeterable by
    ///      construction, rows 3, 4 and 17 all publishing at `exact` against a
    ///      budget that must sit below `domainBits`, and says the lever that
    ///      leaves is a coarser disclosure. This is the lever taken, tested as
    ///      the pair: row 3's budget still refused and row 15's adopted.
    function test_cancellationIsTheBooksOnlyMeterableRow() public {
        // The refusal, unchanged.
        assertTrue(
            L.permits(params.ceilingFor(3), L.point(L.G_EXACT, L.T_IMM)),
            "row 3 admits exact, so Rule B refuses a budget on it"
        );
        // The admission, new.
        assertFalse(
            L.permits(params.ceilingFor(15), L.point(L.G_EXACT, L.T_IMM)),
            "row 15 does not admit exact, so a budget can bind"
        );

        _publish(meteredCancellations());
        assertTrue(params.budgetFor(15).budgetBits != 0, "and one is published");
        assertEq(book.breakingSize(15, L.G_PRED), 4, "the fourth cancel of an epoch is silent");
        assertEq(book.breakingSize(3, L.G_EXACT), 0, "row 3 is still unmetered");
    }

    /// @notice Rule A at the new site: the budget silences the venue, never the
    ///         trader.
    ///
    /// @dev Three cancels are announced and the fourth is not, but the fourth
    ///      still completes and still refunds. A trader must not lose the ability
    ///      to pull a quote because the venue ran out of things it may say. Third
    ///      site where that rule is the difference between a disclosure budget
    ///      and a denial of service.
    function test_theFourthCancellationOfAnEpochIsSilentAndStillRefunds() public {
        _publish(meteredCancellations());
        uint64 epoch = params.currentEpoch();

        for (uint256 i = 0; i < 4; ++i) {
            bytes32 id = _commit(ALICE, keccak256(abi.encode("meter", i)));
            vm.recordLogs();
            vm.prank(ALICE);
            book.cancel(id);
            Vm.Log[] memory logs = vm.getRecordedLogs();

            bool announced;
            for (uint256 j = 0; j < logs.length; ++j) {
                if (logs[j].topics[0] == OrderBook.Cancelled.selector) announced = true;
            }
            if (i < 3) {
                assertTrue(announced, "inside the budget, the cancel is announced");
            } else {
                assertFalse(announced, "past it, the venue goes quiet");
            }
            // Either way the trader got their money and their exit.
            assertTrue(_cancelledFlag(id), "the cancel completed");
            assertEq(book.credit(ALICE), (BOND - FEE) * (i + 1), "the refund landed");
        }

        assertEq(book.spentBits(15, epoch), 3, "one bit each, three spent, none over");
        assertFalse(book.wouldAfford(15, L.G_PRED), "and the row is out for the epoch");
    }

    /// @notice A cancel costs one bit, which is what makes the budget arithmetic
    ///         exact instead of rounded.
    /// @dev `bits` returns a literal 1 for `pred`, independent of the row's
    ///      other three numbers, so `breakingSize` at `pred` is `budgetBits + 1`
    ///      with no division to argue about.
    function test_aCancelCostsExactlyOneBit() public {
        _publish(meteredCancellations());
        B.Row memory r = params.budgetFor(15);
        assertEq(B.bits(r, L.G_PRED), 1, "one bit, by definition of the level");
        assertEq(r.budgetBits, 3, "against a three bit budget");
        assertEq(B.breakingSize(r, L.G_PRED), r.budgetBits + 1, "so the arithmetic is exact");
    }

    /// @dev A filtered copy rather than a zeroed entry: a zero value publishes a
    ///      `BOTTOM` ceiling, which reads the same to `ceilingFor` but is a
    ///      different parameter set.
    function _withoutRow15() internal pure returns (ParameterRoot.Param[] memory out) {
        ParameterRoot.Param[] memory set = asDeployed();
        out = new ParameterRoot.Param[](set.length - 1);
        uint256 k;
        for (uint256 i = 0; i < set.length; ++i) {
            if (set[i].key == bytes32(uint256(15))) continue;
            out[k++] = set[i];
        }
    }

    receive() external payable {}
}

/// @title OrderCancelInvariantTest
/// @notice Conservation of the bond, over random interleavings of every exit.
contract OrderCancelInvariantTest is Test, PolicyFixture {
    OrderBook internal book;
    CancelHandler internal handler;

    uint64 internal constant DELAY = 5 minutes;
    uint64 internal constant WINDOW = 30 minutes;
    uint256 internal constant BOND = 0.1 ether;
    /// @dev **A fast clock, chosen for reachability.** At the venue's real
    ///      numbers an order becomes expirable eight simulated days after its
    ///      reveal, which the fuzzer must string together from hour-scale steps
    ///      and then pick the same id again out of two dozen. Measured,
    ///      `afterInvariant` reported zero expiries per run and refused to
    ///      certify the law over a path never taken.
    ///
    ///      Nothing in the law reads `roundLength` or `restRounds`; they decide
    ///      only *when* `_retire` runs, and the invariant is about what it does
    ///      to the balance. The resting numbers are argued in
    ///      `OrderBook.restRounds` and tested at the real values in
    ///      `OrderBookTest`.
    uint64 internal constant ROUND = 1 hours;
    uint64 internal constant REST = 1;
    uint256 internal constant FEE = (BOND * DELAY + (DELAY + WINDOW) - 1) / (DELAY + WINDOW);

    function setUp() public {
        vm.warp(1_000_000);
        _deployPolicy(asDeployed());
        book = new OrderBook(DELAY, WINDOW, BOND, FEE, params, ROUND, REST);
        handler = new CancelHandler(book);
        // **The handler pays the bonds, not the actors.** `vm.prank` rewrites
        // `msg.sender` but not who the value leaves, which is whichever contract
        // executes the call. Neither balance appears in the conservation law,
        // which reads only the book's.
        vm.deal(address(handler), 10_000 ether);

        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = CancelHandler.doCommit.selector;
        selectors[1] = CancelHandler.doCancel.selector;
        selectors[2] = CancelHandler.doReveal.selector;
        selectors[3] = CancelHandler.doForfeit.selector;
        selectors[4] = CancelHandler.doExpire.selector;
        selectors[5] = CancelHandler.doWithdraw.selector;
        selectors[6] = CancelHandler.doWarpFine.selector;
        selectors[7] = CancelHandler.doWarpCoarse.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice **Every wei the book holds is spoken for, whatever order the exits
    ///         happened in.**
    ///
    /// @dev The law is
    ///
    ///          balance  ==  outstanding bonds + owed credit + retained fees
    ///
    ///      and each exit moves value between exactly two terms. `commit` adds to
    ///      balance and bonds, `cancel` moves a bond into credit and fees,
    ///      `_retire` moves one into credit, and `forfeit` and `withdraw` are the
    ///      only two that pay out, each zeroing its term first.
    ///
    ///      **The failure this catches is the one the feature makes easy.** A
    ///      cancel that refunded without zeroing `bond` counts the same wei twice
    ///      and the book runs short at the second withdrawal rather than at the
    ///      cancel. A single-path unit test does not see that; the sum does, on
    ///      any interleaving that reaches it.
    /// forge-config: default.invariant.runs = 32
    /// forge-config: default.invariant.depth = 512
    function invariant_bondsAreConserved() public view {
        uint256 outstanding;
        uint256 n = handler.idCount();
        for (uint256 i = 0; i < n; ++i) {
            (,,,, uint256 bond) = book.commitments(handler.ids(i));
            outstanding += bond;
        }
        uint256 owed;
        for (uint256 i = 0; i < 3; ++i) {
            owed += book.credit(handler.actors(i));
        }
        assertEq(
            address(book).balance,
            outstanding + owed + book.feesRetained(),
            "the book holds exactly what it owes"
        );
    }

    /// @notice A commitment reaches at most one terminal state, whatever order
    ///         the fuzzer tried them in.
    /// @dev The compiled form of the window disjointness. The clock makes the
    ///      pair unreachable and the guards make it unreachable a second time, so
    ///      this holds even if one of the two arguments is later broken.
    /// forge-config: default.invariant.runs = 32
    /// forge-config: default.invariant.depth = 512
    function invariant_noCommitmentIsBothRevealedAndCancelled() public view {
        uint256 n = handler.idCount();
        for (uint256 i = 0; i < n; ++i) {
            (,, bool revealed, bool cancelled,) = book.commitments(handler.ids(i));
            assertFalse(revealed && cancelled, "a commitment took two exits");
        }
    }

    /// @notice Every exit was actually reached, so the invariants above ran
    ///         against a state machine rather than against an empty book.
    /// @dev Swallowing reverts is what lets the fuzzer explore illegal
    ///      orderings, and also what would hide a run in which nothing succeeded.
    ///      Forge calls this once per run, so a run that never committed,
    ///      cancelled, revealed or swept fails rather than passing vacuously.
    function afterInvariant() public view {
        assertGt(handler.commits(), 0, "no commitment ever landed");
        assertGt(handler.cancels(), 0, "no cancel ever landed");
        assertGt(handler.reveals(), 0, "no reveal ever landed");
        assertGt(handler.forfeits(), 0, "no sweep ever landed");
        assertGt(handler.expiries(), 0, "no order ever rested out");
        assertGt(handler.withdrawals(), 0, "nothing was ever withdrawn");
    }

    /// @notice Retained fees only ever grow, and only in whole fee units.
    /// @dev Nothing pays them out, so a decrease means an accounting path nobody
    ///      wrote. The divisibility half catches a partial charge, which is what
    ///      a refund computed from a stale bond looks like.
    /// forge-config: default.invariant.runs = 32
    /// forge-config: default.invariant.depth = 512
    function invariant_retainedFeesAreWholeAndMonotone() public view {
        uint256 retained = book.feesRetained();
        assertEq(retained % FEE, 0, "fees are charged whole or not at all");
        assertLe(retained, BOND * handler.idCount(), "and never more than was posted");
    }
}
