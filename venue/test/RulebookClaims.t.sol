// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MatchingEngine} from "../src/market/MatchingEngine.sol";
import {MatchingEngineBase} from "../src/market/MatchingEngineBase.sol";
import {OrderBook} from "../src/market/OrderBook.sol";
import {CallAuction} from "../src/market/CallAuction.sol";
import {VolumeCap} from "../src/policy/VolumeCap.sol";
import {TradingHalt} from "../src/policy/TradingHalt.sol";
import {IHoldTypes} from "../src/interfaces/IHoldByPartition.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {ParameterRoot} from "../src/policy/ParameterRoot.sol";
import {PolicyFixture} from "./PolicyFixture.sol";
import {AtsHolds, ComplianceSpy} from "./MatchingEngine.t.sol";

/// @title RulebookClaimsTest
/// @notice The two claims in `docs/RULEBOOK.md` that the code can falsify.
///         Sections 5 and 7 are disclosures about behaviour, and a disclosure
///         nothing checks is a sentence.
contract RulebookClaimsTest is Test, PolicyFixture {
    MatchingEngine internal engine;
    AtsHolds internal ats;
    ComplianceSpy internal seamC;
    VolumeCap internal cap;
    TradingHalt internal halt;

    address internal constant SELLER = address(0x5E11);
    address internal constant BUYER = address(0xB4E7);
    address internal constant BUYER2 = address(0xB4E8);
    address internal constant PASSERBY = address(0xBEE);

    uint64 internal constant DELAY = 5 minutes;
    uint64 internal constant WINDOW = 30 minutes;
    uint256 internal constant BOND = 0.01 ether;
    uint256 internal constant FEE = (BOND * DELAY + (DELAY + WINDOW) - 1) / (DELAY + WINDOW);
    uint64 internal constant ROUND = 1 days;
    uint64 internal constant REST = 7;
    bytes32 internal constant PARTITION = bytes32(uint256(1));

    function setUp() public {
        vm.warp(1_000_000);
        _deployPolicy(asDeployed(), address(0));
        ats = new AtsHolds();
        seamC = new ComplianceSpy();
        engine = new MatchingEngine(
            DELAY, WINDOW, BOND, FEE, params, ROUND, REST, ats, PARTITION, seamC
        );
        cap = new VolumeCap(regime, address(engine), 4000, L.point(L.G_EXACT, L.T_IMM));
        regime.bootstrapSupervisor(address(cap));
        engine.attachVolumeCap(cap);
        // The band is set so wide it cannot fire. Tests that want the breaker
        // build their own halt; every other test wants the venue never stopped.
        halt = new TradingHalt(regime, address(engine), 1 hours, 4 hours, 9999, 1 hours);
        engine.attachTradingHalt(halt);

        vm.deal(SELLER, 100 ether);
        vm.deal(BUYER, 100 ether);
        vm.deal(BUYER2, 100 ether);
        vm.deal(PASSERBY, 1 ether);
    }

    // ------------------------------------------------------- section 7

    /// @notice Nothing but the halt stops a round from crossing.
    /// @dev Section 7's claim. It has to be run against a venue whose governance
    ///      has done everything it is permitted to do: the operator moves the
    ///      disclosure point and commits a new parameter set, the supervisor,
    ///      which here is the cap contract, restricts the ceiling and raises the
    ///      floor. Then a passer-by crosses the round.
    ///
    ///      This test read `test_noAddressCanStopACross` until `TradingHalt`
    ///      existed, and the rename is the mechanism working rather than a
    ///      concession. Section 7 said the venue had no halt, this held the
    ///      claim, and adding one had to come back through here. What survives
    ///      is the narrower and now more useful property: **the disclosure
    ///      instruments are not halt instruments.** Any second way to stop a
    ///      cross still fails here.
    function test_nothingButTheHaltStopsACross() public {
        uint256 holdId = _hold(SELLER, 1_000);
        bytes32 sell = _commit(SELLER, OrderBook.Side.SELL, 95, 1_000, "s");
        bytes32 buy = _commit(BUYER, OrderBook.Side.BUY, 105, 1_000, "b");
        _open();
        _reveal(SELLER, OrderBook.Side.SELL, 95, 1_000, "s", holdId, 0);
        _reveal(BUYER, OrderBook.Side.BUY, 105, 1_000, "b", 0, 105 * 1_000);
        uint64 r = engine.currentRound();

        // Everything the operator may do.
        vm.startPrank(OPERATOR);
        regime.propose(L.point(L.G_BUCKET, L.T_IMM), 1, "halt me");
        params.propose(params.rootOf(coarseExecutionPrice()), "halt me");
        vm.stopPrank();

        // Everything the supervisor may do. The seat is held by the cap. The
        // two moves have to be mutually satisfiable or `Regime` refuses the
        // second, which is `Unsatisfiable` and not a halt either.
        vm.startPrank(address(cap));
        regime.narrow(L.point(L.G_BUCKET, L.T_IMM), "halt me");
        regime.raiseFloor(L.point(L.G_PRED, L.T_EPOCH), "halt me");
        vm.stopPrank();

        clock.tick();
        regime.adopt();
        params.adopt(coarseExecutionPrice());

        vm.warp(block.timestamp + ROUND);
        vm.prank(PASSERBY);
        engine.crossRound(r);

        assertTrue(engine.crossed(r), "a disclosure instrument stopped a round from crossing");
        (,,,, uint128 filled,,,,) = engine.orders(sell);
        assertEq(filled, 1_000, "the sell did not settle");
        (,,,, filled,,,,) = engine.orders(buy);
        assertEq(filled, 1_000, "the buy did not settle");
    }

    /// @notice The cap's suspension raises the floor. It does not stop trading.
    /// @dev Section 7's second paragraph. The one suspension the venue has is a
    ///      transparency obligation, so the round after it still crosses.
    function test_theOneSuspensionCompelsDisclosureRatherThanHalting() public {
        _deployPolicy(coarseExecutionPrice(), address(0));
        ats = new AtsHolds();
        seamC = new ComplianceSpy();
        engine = new MatchingEngine(
            DELAY, WINDOW, BOND, FEE, params, ROUND, REST, ats, PARTITION, seamC
        );
        cap = new VolumeCap(regime, address(engine), 1, L.point(L.G_EXACT, L.T_IMM));
        regime.bootstrapSupervisor(address(cap));
        engine.attachVolumeCap(cap);
        // The band is set so wide it cannot fire. Tests that want the breaker
        // build their own halt; every other test wants the venue never stopped.
        halt = new TradingHalt(regime, address(engine), 1 hours, 4 hours, 9999, 1 hours);
        engine.attachTradingHalt(halt);
        vm.deal(SELLER, 100 ether);
        vm.deal(BUYER, 100 ether);

        _crossOne("a");
        cap.enforce();
        assertTrue(cap.suspendedNow(), "the cap did not fire on a fully deferred round");
        assertEq(regime.floor(), L.point(L.G_EXACT, L.T_IMM), "the floor did not rise");

        // Suspended, and still trading.
        _crossOne("b");
    }

    // ------------------------------------------------- section 7, the halt

    /// @notice **A halt stops the venue trading and never stops anyone leaving.**
    /// @dev The property that separates a halt from a hostage-taking, and the
    ///      one section 7 now turns on. The halt gates `crossRound` and nothing
    ///      else, so while it runs a participant can still commit, cancel,
    ///      expire an order the venue never crossed, and take the money out.
    ///
    ///      `OrderBook.expire` states the principle in its own comment: a venue
    ///      that alone could return a bond would have a lever over every open
    ///      order. A halt reaching the exits would be that lever.
    function test_aHaltStopsTheVenueTradingAndNeverStopsAnyoneLeaving() public {
        _deployHaltable(9999);
        uint256 holdId = _hold(SELLER, 1_000);
        bytes32 sell = _commit(SELLER, OrderBook.Side.SELL, 95, 1_000, "s");
        _commit(BUYER, OrderBook.Side.BUY, 105, 1_000, "b");
        _open();
        _reveal(SELLER, OrderBook.Side.SELL, 95, 1_000, "s", holdId, 0);
        _reveal(BUYER, OrderBook.Side.BUY, 105, 1_000, "b", 0, 105 * 1_000);
        uint64 r = engine.currentRound();

        vm.prank(SUPERVISOR);
        uint64 until = halt.halt(20 days, keccak256("article 48(5)"));

        vm.warp(block.timestamp + ROUND);
        vm.prank(PASSERBY);
        vm.expectRevert(abi.encodeWithSelector(MatchingEngineBase.VenueHalted.selector, until));
        engine.crossRound(r);
        assertFalse(engine.crossed(r), "the venue traded while halted");

        // A new commitment, and walking away from it. Both inside the halt.
        bytes32 late = _commit(BUYER2, OrderBook.Side.BUY, 105, 10, "c");
        vm.prank(BUYER2);
        engine.cancel(late);

        // The resting window runs out under the halt, and the exit is open.
        vm.warp(block.timestamp + ROUND * (REST + 1));
        assertTrue(halt.haltedNow(), "the halt ended too early to prove anything");

        vm.prank(PASSERBY);
        engine.expire(sell);
        assertFalse(engine.isLive(sell), "a halted venue held an order in");

        uint256 before = SELLER.balance;
        vm.prank(SELLER);
        engine.withdraw();
        assertGt(SELLER.balance, before, "a halted venue held the money in");
    }

    /// @notice The halt ends without anyone ending it, and the round is not lost.
    /// @dev A halt is a deadline and never a flag, so there is no state it can
    ///      be left in. The round is refused rather than voided, and the reason
    ///      that is safe is the limit and not the clock: every order here is a
    ///      sealed limit, so a late cross still executes inside the price its
    ///      owner named.
    function test_theHaltEndsOnItsOwnAndTheRoundIsNotLost() public {
        _deployHaltable(9999);
        uint256 holdId = _hold(SELLER, 1_000);
        bytes32 sell = _commit(SELLER, OrderBook.Side.SELL, 95, 1_000, "s");
        _commit(BUYER, OrderBook.Side.BUY, 105, 1_000, "b");
        _open();
        _reveal(SELLER, OrderBook.Side.SELL, 95, 1_000, "s", holdId, 0);
        _reveal(BUYER, OrderBook.Side.BUY, 105, 1_000, "b", 0, 105 * 1_000);
        uint64 r = engine.currentRound();

        vm.prank(SUPERVISOR);
        // Longer than a round. A halt inside one round stops nothing, because
        // `crossRound(r)` cannot be called until round r has ended anyway.
        uint64 until = halt.halt(2 days, keccak256("pricing failure"));
        vm.warp(block.timestamp + ROUND);
        vm.expectRevert(abi.encodeWithSelector(MatchingEngineBase.VenueHalted.selector, until));
        engine.crossRound(r);

        vm.warp(until);
        assertFalse(halt.haltedNow(), "nobody lifted it and it did not lift");
        vm.prank(PASSERBY);
        engine.crossRound(r);
        assertTrue(engine.crossed(r));
        (,,,, uint128 filled,,,,) = engine.orders(sell);
        assertEq(filled, 1_000, "the round was lost to the halt");
    }

    /// @notice In the shipped deployment the discretionary halt has no caller.
    /// @dev The supervisor seat is held by `VolumeCap`, so the only address that
    ///      may halt is a contract with no path to it. Driving that contract
    ///      through everything it can do leaves the venue unhalted, which is the
    ///      same argument shape as `test_nothingButTheHaltStopsACross` one layer
    ///      up. What can fire here is the breaker, and the breaker is arithmetic.
    function test_inTheShippedDeploymentTheDiscretionaryHaltHasNoCaller() public {
        assertEq(regime.supervisor(), address(cap), "the seat is not the cap");

        vm.prank(OPERATOR);
        vm.expectRevert(TradingHalt.NotSupervisor.selector);
        halt.halt(60, keccak256("operator"));

        vm.prank(PASSERBY);
        vm.expectRevert(TradingHalt.NotSupervisor.selector);
        halt.halt(60, keccak256("anyone"));

        // Everything the seat-holder can be made to do.
        vm.prank(address(engine));
        cap.record(1_000, 1_000);
        cap.enforce();
        assertTrue(cap.suspendedNow(), "the cap did not fire, so it was not driven");
        assertFalse(halt.haltedNow(), "the only address that may halt found a way to");
    }

    /// @notice The breaker halts the round after the one that breached it.
    /// @dev **A sealed book cannot collar its own auction**, because the price
    ///      does not exist until the round clears. So this is a limit-move halt
    ///      and not an auction collar, and the breaching print is already done.
    ///      Asserted in both directions so the limit cannot quietly change.
    function test_theBreakerHaltsTheRoundAfterTheOneThatBreached() public {
        _deployHaltable(500); // 5%

        uint64 first = _crossAt("a", 95, 105);
        assertTrue(engine.crossed(first));
        assertFalse(halt.haltedNow(), "the first print has nothing to compare to");

        uint64 second = _crossAt("b", 195, 205);
        assertTrue(engine.crossed(second), "the breaching round did not print");
        assertTrue(halt.haltedNow(), "the breaker did not arm on a doubled price");

        // And the next one is refused, by arithmetic nobody chose.
        uint256 holdId = _hold(SELLER, 100);
        _commit(SELLER, OrderBook.Side.SELL, 195, 100, "c");
        _commit(BUYER, OrderBook.Side.BUY, 205, 100, "c");
        _open();
        _reveal(SELLER, OrderBook.Side.SELL, 195, 100, "c", holdId, 0);
        _reveal(BUYER, OrderBook.Side.BUY, 205, 100, "c", 0, 205 * 100);
        uint64 third = engine.currentRound();
        vm.warp(block.timestamp + ROUND);
        // Read before arming: an external call consumes the expectation.
        uint64 until = halt.haltedUntil();
        vm.expectRevert(abi.encodeWithSelector(MatchingEngineBase.VenueHalted.selector, until));
        engine.crossRound(third);
    }

    /// @dev A deployment whose supervisor seat is an ordinary address, so the
    ///      discretionary halt has a caller at all. The shipped one does not:
    ///      see `test_inTheShippedDeploymentTheDiscretionaryHaltHasNoCaller`.
    function _deployHaltable(uint16 band) private {
        _deployPolicy(asDeployed(), SUPERVISOR);
        ats = new AtsHolds();
        seamC = new ComplianceSpy();
        engine = new MatchingEngine(
            DELAY, WINDOW, BOND, FEE, params, ROUND, REST, ats, PARTITION, seamC
        );
        cap = new VolumeCap(regime, address(engine), 4000, L.point(L.G_EXACT, L.T_IMM));
        engine.attachVolumeCap(cap);
        halt = new TradingHalt(regime, address(engine), 30 days, 90 days, band, 2 days);
        engine.attachTradingHalt(halt);
        vm.deal(SELLER, 100 ether);
        vm.deal(BUYER, 100 ether);
        vm.deal(BUYER2, 100 ether);
        vm.deal(PASSERBY, 1 ether);
    }

    function _crossAt(bytes32 salt, uint128 lo, uint128 hi) private returns (uint64 r) {
        uint256 holdId = _hold(SELLER, 100);
        _commit(SELLER, OrderBook.Side.SELL, lo, 100, salt);
        _commit(BUYER, OrderBook.Side.BUY, hi, 100, salt);
        _open();
        _reveal(SELLER, OrderBook.Side.SELL, lo, 100, salt, holdId, 0);
        _reveal(BUYER, OrderBook.Side.BUY, hi, 100, salt, 0, uint256(hi) * 100);
        r = engine.currentRound();
        vm.warp(block.timestamp + ROUND);
        vm.prank(PASSERBY);
        engine.crossRound(r);
    }

    function _crossOne(bytes32 salt) private {
        uint256 holdId = _hold(SELLER, 100);
        _commit(SELLER, OrderBook.Side.SELL, 95, 100, salt);
        _commit(BUYER, OrderBook.Side.BUY, 105, 100, salt);
        _open();
        _reveal(SELLER, OrderBook.Side.SELL, 95, 100, salt, holdId, 0);
        _reveal(BUYER, OrderBook.Side.BUY, 105, 100, salt, 0, 105 * 100);
        uint64 r = engine.currentRound();
        vm.warp(block.timestamp + ROUND);
        vm.prank(PASSERBY);
        engine.crossRound(r);
        assertTrue(engine.crossed(r), "the round did not cross");
    }

    // ------------------------------------------------------- section 5

    /// @notice Reveal order decides nothing but the residue.
    /// @dev Section 5's claim, in two halves. Two sells share the marginal level
    ///      and one unit cannot be split, so book order moves exactly that unit
    ///      and each side is otherwise pro rata by size.
    function test_revealOrderMovesOnlyTheResidue() public {
        uint128[] memory a = _fillsForOrder(true);
        uint128[] memory b = _fillsForOrder(false);

        // Same total, same shares up to the one indivisible unit.
        assertEq(uint256(a[0]) + a[1], uint256(b[0]) + b[1], "book order changed the volume");
        assertEq(a[0], b[1], "book order did more than move the residue");
        assertEq(a[1], b[0], "book order did more than move the residue");
        assertEq(uint256(a[0]) - a[1], 1, "the residue was not one unit");
    }

    /// @dev Three units of demand across two equal sells at the marginal level.
    ///      `first` swaps which of the two is earlier in the book.
    function _fillsForOrder(bool first) private pure returns (uint128[] memory fill) {
        CallAuction.Limit[] memory book = new CallAuction.Limit[](3);
        book[0] = CallAuction.Limit({buy: true, price: 100, qty: 3});
        book[first ? 1 : 2] = CallAuction.Limit({buy: false, price: 100, qty: 2});
        book[first ? 2 : 1] = CallAuction.Limit({buy: false, price: 100, qty: 2});
        CallAuction.Cross memory c = CallAuction.clear(book);
        uint128[] memory raw = CallAuction.allocate(book, c);
        fill = new uint128[](2);
        fill[0] = raw[first ? 1 : 2];
        fill[1] = raw[first ? 2 : 1];
    }

    /// @notice Nobody's own limit sets their own price.
    /// @dev The uniform-price claim, at the one place section 5 makes it: the
    ///      seller asked 95, the buyer bid 105, and both trade at 100.
    function test_nobodysOwnLimitSetsTheirOwnPrice() public {
        uint256 holdId = _hold(SELLER, 1_000);
        _commit(SELLER, OrderBook.Side.SELL, 95, 1_000, "s");
        _commit(BUYER, OrderBook.Side.BUY, 105, 1_000, "b");
        _open();
        _reveal(SELLER, OrderBook.Side.SELL, 95, 1_000, "s", holdId, 0);
        _reveal(BUYER, OrderBook.Side.BUY, 105, 1_000, "b", 0, 105 * 1_000);

        uint64 r = engine.currentRound();
        vm.warp(block.timestamp + ROUND);
        engine.crossRound(r);
        // The credit is the notional plus the performance bond coming back.
        assertEq(engine.credit(SELLER), 100 * 1_000 + BOND, "the seller was paid its own limit");
    }

    // ---------------------------------------------------------- helpers

    function _hold(address who, uint256 amount) private returns (uint256 id) {
        vm.prank(who);
        (, id) = ats.createHoldByPartition(
            PARTITION,
            IHoldTypes.Hold({
                amount: amount,
                expirationTimestamp: block.timestamp + 3650 days,
                escrow: address(engine),
                to: address(0),
                data: ""
            })
        );
    }

    function _commit(address who, OrderBook.Side side, uint128 p, uint128 q, bytes32 salt)
        private
        returns (bytes32 id)
    {
        id = engine.commitmentOf(who, side, p, q, salt);
        vm.prank(who);
        engine.commit{value: BOND}(id);
    }

    function _open() private {
        vm.warp(block.timestamp + DELAY + 1);
    }

    function _reveal(
        address who,
        OrderBook.Side side,
        uint128 p,
        uint128 q,
        bytes32 salt,
        uint256 backing,
        uint256 cash
    ) private {
        vm.prank(who);
        engine.reveal{value: cash}(side, p, q, salt, backing);
    }
}
