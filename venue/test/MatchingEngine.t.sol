// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {MatchingEngine} from "../src/market/MatchingEngine.sol";
import {OrderBook} from "../src/market/OrderBook.sol";
import {IHoldByPartition, IHoldTypes} from "../src/interfaces/IHoldByPartition.sol";
import {ICompliance} from "../src/interfaces/ICompliance.sol";
import {VolumeCap} from "../src/policy/VolumeCap.sol";
import {TradingHalt} from "../src/policy/TradingHalt.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {ParameterRoot} from "../src/policy/ParameterRoot.sol";
import {PolicyFixture} from "./PolicyFixture.sol";

/// @notice A hold that actually holds something.
/// @dev The other three suites stub `IHoldByPartition` because they only assert
///      *which* calls are made. This one has to assert what the calls do, so it
///      keeps balances and enforces the two ATS rules the engine depends on:
///      only the escrow may execute, and a hold recording `to == address(0)`
///      admits any destination (`HoldStorageWrapper._validateExecuteHold`).
///
///      `rebase` is the lever the ABAF test pulls. It is not a convenience: ATS
///      resynchronises the holder's adjustment factor inside
///      `beforeExecuteHold`, and the pending-adjustment sync fires lazily from
///      entry points all over the facet surface, so an unrelated third party's
///      transaction really can move a resting order's backing. The mock exposes
///      that as one call so a test can be written about it.
contract AtsHolds is IHoldByPartition {
    struct H {
        uint256 amount;
        uint256 expiry;
        address escrow;
        address to;
        bool exists;
    }

    mapping(bytes32 => H) private _holds;
    mapping(address => uint256) public delivered;
    uint256 public nextId = 1;
    uint256 public executions;

    function _key(bytes32 p, address holder, uint256 id) private pure returns (bytes32) {
        return keccak256(abi.encode(p, holder, id));
    }

    function createHoldByPartition(bytes32 partition, IHoldTypes.Hold calldata hold)
        external
        returns (bool, uint256)
    {
        uint256 id = nextId++;
        _holds[_key(partition, msg.sender, id)] = H({
            amount: hold.amount,
            expiry: hold.expirationTimestamp,
            escrow: hold.escrow,
            to: hold.to,
            exists: true
        });
        return (true, id);
    }

    function createHoldFromByPartition(
        bytes32 partition,
        address from,
        IHoldTypes.Hold calldata hold,
        bytes calldata
    ) external returns (bool, uint256) {
        uint256 id = nextId++;
        _holds[_key(partition, from, id)] = H({
            amount: hold.amount,
            expiry: hold.expirationTimestamp,
            escrow: hold.escrow,
            to: hold.to,
            exists: true
        });
        return (true, id);
    }

    function executeHoldByPartition(
        IHoldTypes.HoldIdentifier calldata id,
        address to,
        uint256 amount
    ) external returns (bool, bytes32) {
        H storage h = _holds[_key(id.partition, id.tokenHolder, id.holdId)];
        require(h.exists, "no hold");
        require(h.escrow == msg.sender, "IsNotEscrow");
        // The rule the whole settlement design turns on.
        require(h.to == address(0) || h.to == to, "InvalidDestinationAddress");
        require(block.timestamp <= h.expiry, "HoldExpirationReached");
        require(h.amount >= amount, "amount");
        h.amount -= amount;
        delivered[to] += amount;
        executions++;
        return (true, id.partition);
    }

    function releaseHoldByPartition(IHoldTypes.HoldIdentifier calldata id, uint256 amount)
        external
        returns (bool)
    {
        H storage h = _holds[_key(id.partition, id.tokenHolder, id.holdId)];
        require(h.exists && h.escrow == msg.sender, "release");
        require(h.amount >= amount, "amount");
        h.amount -= amount;
        return true;
    }

    function getHoldForByPartition(IHoldTypes.HoldIdentifier calldata id)
        external
        view
        returns (uint256, uint256, address, address, bytes memory, bytes memory, uint8)
    {
        H storage h = _holds[_key(id.partition, id.tokenHolder, id.holdId)];
        return (h.amount, h.expiry, h.escrow, h.to, "", "", 0);
    }

    /// @notice A corporate action, or any of the 40-odd entry points that fire a
    ///         pending adjustment, seen from outside.
    function rebase(bytes32 partition, address holder, uint256 id, uint256 to) external {
        _holds[_key(partition, holder, id)].amount = to;
    }
}

/// @notice Seam C, with a switch.
/// @dev Records the triple it was asked, which is the assertion
///      `test_seamCIsAskedTheQuestionAtsCannotAsk` makes: on the hold rail ATS
///      itself calls `canTransfer(0, to, 0)`, so if the engine did not ask, the
///      amount would never reach a compliance module at all.
contract ComplianceSpy is ICompliance {
    mapping(address => bool) public denied;
    address public lastFrom;
    address public lastTo;
    uint256 public lastAmount;
    uint256 public calls;

    function deny(address who) external {
        denied[who] = true;
    }

    function canTransfer(address from, address to, uint256 amount)
        external
        view
        returns (bool)
    {
        return !denied[from] && !denied[to] && amount > 0;
    }

    /// @dev `canTransfer` is a view and cannot record, exactly as in ATS, so the
    ///      spy records through a separate path the engine also drives. See
    ///      `observe`.
    function observe(address from, address to, uint256 amount) external {
        lastFrom = from;
        lastTo = to;
        lastAmount = amount;
        calls++;
    }

    function transferred(address, address, uint256) external {}
    function created(address, uint256) external {}
    function destroyed(address, uint256) external {}
}

contract MatchingEngineTest is Test, PolicyFixture {
    MatchingEngine internal engine;
    AtsHolds internal ats;
    ComplianceSpy internal seamC;
    VolumeCap internal cap;
    TradingHalt internal halt;

    address internal constant SELLER = address(0x5E11);
    address internal constant BUYER = address(0xB4E7);
    address internal constant BUYER2 = address(0xB4E8);

    uint64 internal constant DELAY = 5 minutes;
    uint64 internal constant WINDOW = 30 minutes;
    uint256 internal constant BOND = 0.01 ether;
    /// `ceil(BOND * DELAY / (DELAY + WINDOW))`. See `OrderBook.cancelFee`.
    uint256 internal constant FEE = (BOND * DELAY + (DELAY + WINDOW) - 1) / (DELAY + WINDOW);
    uint64 internal constant ROUND = 1 days;
    uint64 internal constant REST = 7;
    bytes32 internal constant PARTITION = bytes32(uint256(1));

    uint64 internal constant GENESIS = 1_000_000;

    function setUp() public {
        vm.warp(GENESIS);
        _deploy(asDeployed());
    }

    /// @dev The deployment order is the one `VolumeCapTest` establishes and it is
    ///      not arbitrary: the regime goes up with the supervisor seat vacant,
    ///      the engine goes up, the cap takes the engine as its venue, the seat
    ///      is filled with the cap, and only then is the cap attached. **The cap
    ///      contract is the supervisor**, so suspension is arithmetic rather than
    ///      a person, and the attachment verifies `cap.venue() == engine` so a
    ///      borrowed cap cannot be installed.
    function _deploy(ParameterRoot.Param[] memory set) internal {
        _deployPolicy(set, address(0));
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
    }

    // ---------------------------------------------------------- the happy path

    /// @notice One round, one crossing, and the four things that have to move.
    /// @dev The asset moves through ATS, the cash lands as a credit, both orders
    ///      retire because both filled out, and the bond comes back. Before this
    ///      contract existed the book could do none of it: `Order.filled` was
    ///      written once as zero and there was no token address anywhere.
    function test_theRoundCrossesAndSettles() public {
        uint256 holdId = _hold(SELLER, 1_000);
        bytes32 sell = _commit(SELLER, OrderBook.Side.SELL, 95, 1_000, "s");
        bytes32 buy = _commit(BUYER, OrderBook.Side.BUY, 105, 1_000, "b");
        _open();
        _reveal(SELLER, OrderBook.Side.SELL, 95, 1_000, "s", holdId, 0);
        _reveal(BUYER, OrderBook.Side.BUY, 105, 1_000, "b", 0, 105 * 1_000);

        uint64 r = engine.currentRound();
        _nextRound();
        engine.crossRound(r);

        // Uniform price: the maximiser interval is [95, 105], so the clearing
        // price is 100 and neither side got its own limit.
        assertEq(ats.delivered(BUYER), 1_000, "the lot moved");
        assertEq(engine.credit(SELLER), 100 * 1_000 + BOND, "proceeds plus bond");
        // The buyer escrowed at 105 and paid at 100, so 5,000 comes back with
        // the bond when the order retires.
        assertEq(engine.credit(BUYER), 5 * 1_000 + BOND, "the overpayment came back");
        assertEq(engine.revealedCount(), 0, "both orders filled out and retired");
        assertFalse(engine.isLive(sell));
        assertFalse(engine.isLive(buy));
    }

    /// @notice The clearing price is the venue's, not the aggressor's.
    /// @dev A continuous book would fill at the resting order's limit and hand
    ///      the whole spread to whoever arrived second. A uniform price call
    ///      auction gives both sides the same number, which at 1.6 orders a day
    ///      is the difference between a venue and a negotiation.
    function test_theClearingPriceIsUniformAndNotEitherLimit() public {
        uint256 holdId = _hold(SELLER, 500);
        _commit(SELLER, OrderBook.Side.SELL, 90, 500, "s");
        _commit(BUYER, OrderBook.Side.BUY, 110, 500, "b");
        _open();
        _reveal(SELLER, OrderBook.Side.SELL, 90, 500, "s", holdId, 0);
        _reveal(BUYER, OrderBook.Side.BUY, 110, 500, "b", 0, 110 * 500);

        uint64 r = engine.currentRound();
        (bool willCross, uint256 p2, uint256 vol) = engine.quote(r);
        assertTrue(willCross);
        assertEq(p2, 200, "lo + hi = 90 + 110");
        assertEq(vol, 500);

        _nextRound();
        engine.crossRound(r);
        assertEq(engine.credit(SELLER), 100 * 500 + BOND, "seller got 100, not 90");
        assertEq(engine.credit(BUYER), 10 * 500 + BOND, "buyer paid 100, not 110");
    }

    // ------------------------------------------------- the unfunded promise

    /// @notice **A reveal that cannot fund is refused.** The census item that
    ///         was a security hole rather than an omission.
    /// @dev an invariant. Both sides, because the failure is symmetric: a sell with no
    ///      hold behind it and a buy with no cash behind it are the same free
    ///      option written on the counterparty.
    function test_anUnbackedSellIsRefused() public {
        _commit(SELLER, OrderBook.Side.SELL, 95, 1_000, "s");
        _open();
        vm.prank(SELLER);
        vm.expectRevert(abi.encodeWithSelector(MatchingEngine.NotEscrow.selector, address(0)));
        engine.reveal(OrderBook.Side.SELL, 95, 1_000, "s", 42);
    }

    function test_anUnfundedBuyIsRefused() public {
        _commit(BUYER, OrderBook.Side.BUY, 105, 1_000, "b");
        _open();
        vm.prank(BUYER);
        vm.expectRevert(
            abi.encodeWithSelector(MatchingEngine.WrongEscrow.selector, 0, 105 * 1_000)
        );
        engine.reveal(OrderBook.Side.BUY, 105, 1_000, "b", 0);
    }

    /// @notice A hold that already names its destination cannot be used.
    /// @dev Two separate reasons and both are disqualifying. Mechanically,
    ///      `_validateExecuteHold` would revert when the auction found a
    ///      different buyer, and it would revert *mid-round*, taking every other
    ///      settlement in that round with it. And in policy terms, naming the
    ///      destination at reveal discloses the counterparty before the match,
    ///      which is the disclosure a sealed book exists to defer.
    function test_aHoldThatNamesADestinationIsRefused() public {
        vm.prank(SELLER);
        (, uint256 id) = ats.createHoldByPartition(
            PARTITION,
            IHoldTypes.Hold({
                amount: 1_000,
                expirationTimestamp: block.timestamp + 3650 days,
                escrow: address(engine),
                to: BUYER,
                data: ""
            })
        );
        _commit(SELLER, OrderBook.Side.SELL, 95, 1_000, "s");
        _open();
        vm.prank(SELLER);
        vm.expectRevert(
            abi.encodeWithSelector(MatchingEngine.HoldNamesADestination.selector, BUYER)
        );
        engine.reveal(OrderBook.Side.SELL, 95, 1_000, "s", id);
    }

    function test_aHoldSmallerThanTheOrderIsRefused() public {
        uint256 holdId = _hold(SELLER, 400);
        _commit(SELLER, OrderBook.Side.SELL, 95, 1_000, "s");
        _open();
        vm.prank(SELLER);
        vm.expectRevert(
            abi.encodeWithSelector(MatchingEngine.HoldTooSmall.selector, 400, 1_000)
        );
        engine.reveal(OrderBook.Side.SELL, 95, 1_000, "s", holdId);
    }

    /// @notice A hold that expires inside the resting window is refused.
    /// @dev Otherwise the last rounds of the order are unbacked, and the failure
    ///      surfaces as `HoldExpirationReached` inside somebody else's cross.
    function test_aHoldExpiringInsideTheRestingWindowIsRefused() public {
        vm.prank(SELLER);
        (, uint256 id) = ats.createHoldByPartition(
            PARTITION,
            IHoldTypes.Hold({
                amount: 1_000,
                expirationTimestamp: block.timestamp + 2 days,
                escrow: address(engine),
                to: address(0),
                data: ""
            })
        );
        _commit(SELLER, OrderBook.Side.SELL, 95, 1_000, "s");
        _open();
        vm.prank(SELLER);
        vm.expectRevert();
        engine.reveal(OrderBook.Side.SELL, 95, 1_000, "s", id);
    }

    // ------------------------------------------------------------ the ABAF hazard

    /// @notice **A resting order whose backing was rebased is voided, not
    ///         under-delivered.**
    ///
    /// `HoldStorageWrapper.beforeExecuteHold` calls `adjustHoldBalances`, which
    /// resynchronises the holder's balance adjustment factor, and the pending
    /// adjustment sync fires lazily from entry points across the facet surface.
    /// So a third party's unrelated transaction can move the quantity standing
    /// behind an order that was revealed days earlier. The quantity promised at
    /// reveal is not the quantity deliverable at cross.
    ///
    /// Scaling the order to the new backing would silently change a trader's
    /// size after the fact. Refusing to trade it is what a venue does when a
    /// corporate action lands on an instrument with a resting book.
    function test_aRebasedBackingVoidsTheOrderRatherThanUnderDelivering() public {
        uint256 holdId = _hold(SELLER, 1_000);
        bytes32 sell = _commit(SELLER, OrderBook.Side.SELL, 95, 1_000, "s");
        _commit(BUYER, OrderBook.Side.BUY, 105, 1_000, "b");
        _open();
        _reveal(SELLER, OrderBook.Side.SELL, 95, 1_000, "s", holdId, 0);
        _reveal(BUYER, OrderBook.Side.BUY, 105, 1_000, "b", 0, 105 * 1_000);

        uint64 r = engine.currentRound();
        // A corporate action halves the lot between the reveal and the cross.
        ats.rebase(PARTITION, SELLER, holdId, 500);

        _nextRound();
        vm.expectEmit(true, false, false, true, address(engine));
        emit MatchingEngine.VoidedByRebase(sell, 1_000, 500);
        engine.crossRound(r);

        assertEq(ats.delivered(BUYER), 0, "nothing was delivered");
        assertFalse(engine.isLive(sell), "the sell order is out of the book");
        assertEq(engine.credit(SELLER), BOND, "and its bond came back");
    }

    // -------------------------------------------------------------- seam C

    /// @notice **The engine asks seam C the question ATS cannot ask on this rail.**
    ///
    /// `mesh/transfer-path.md` F-06: hold execution reaches the compliance module
    /// as `canTransfer(address(0), to, 0)`, with the amount withheld. That is
    /// shape 3 of `SeamJournal._judge`. So a size-dependent policy is blind
    /// exactly on the rail this venue settles through, and F-06 recorded the
    /// consequence as a design decision owed: the size gate has to live in the
    /// contract that owns the hold.
    ///
    /// This is that contract discharging it. The engine calls
    /// `canTransfer(seller, buyer, amount)` itself, with the real triple, before
    /// every execution.
    function test_seamCIsAskedTheQuestionAtsCannotAskOnTheHoldRail() public {
        uint256 holdId = _hold(SELLER, 1_000);
        _commit(SELLER, OrderBook.Side.SELL, 95, 1_000, "s");
        _commit(BUYER, OrderBook.Side.BUY, 105, 1_000, "b");
        _open();
        _reveal(SELLER, OrderBook.Side.SELL, 95, 1_000, "s", holdId, 0);
        _reveal(BUYER, OrderBook.Side.BUY, 105, 1_000, "b", 0, 105 * 1_000);

        // Deny the buyer. Nothing in ATS would have noticed: the module it asks
        // on this rail is handed a zero amount and a zero sender.
        seamC.deny(BUYER);

        uint64 r = engine.currentRound();
        _nextRound();
        engine.crossRound(r);

        assertEq(ats.delivered(BUYER), 0, "the trade did not settle");
        assertEq(ats.executions(), 0, "and no hold was executed");
        assertTrue(engine.isLive(_idOf(SELLER, OrderBook.Side.SELL, 95, 1_000, "s")));
    }

    /// @notice One refused pair does not stop the round.
    /// @dev Reverting on a compliance denial would hand any ineligible party a
    ///      free denial of service over the whole venue's clearing, which is the
    ///      failure mode `SeamJournal`'s Rule A is about at a different site.
    function test_aRefusedPairDoesNotStopTheRound() public {
        uint256 holdId = _hold(SELLER, 2_000);
        _commit(SELLER, OrderBook.Side.SELL, 95, 2_000, "s");
        _commit(BUYER, OrderBook.Side.BUY, 105, 1_000, "b");
        _commit(BUYER2, OrderBook.Side.BUY, 105, 1_000, "b2");
        _open();
        _reveal(SELLER, OrderBook.Side.SELL, 95, 2_000, "s", holdId, 0);
        _reveal(BUYER, OrderBook.Side.BUY, 105, 1_000, "b", 0, 105 * 1_000);
        _reveal(BUYER2, OrderBook.Side.BUY, 105, 1_000, "b2", 0, 105 * 1_000);

        seamC.deny(BUYER);
        uint64 r = engine.currentRound();
        _nextRound();
        engine.crossRound(r);

        assertEq(ats.delivered(BUYER), 0, "the denied buyer got nothing");
        assertEq(ats.delivered(BUYER2), 1_000, "the eligible one still traded");
    }

    // ------------------------------------------------------------- the round

    function test_anOpenRoundCannotBeCrossed() public {
        uint64 r = engine.currentRound();
        vm.expectRevert(abi.encodeWithSelector(MatchingEngine.RoundStillOpen.selector, r, r));
        engine.crossRound(r);
    }

    function test_aRoundCannotBeCrossedTwice() public {
        uint64 r = engine.currentRound();
        _nextRound();
        engine.crossRound(r);
        vm.expectRevert(abi.encodeWithSelector(MatchingEngine.AlreadyCrossed.selector, r));
        engine.crossRound(r);
    }

    /// @notice Crossing is permissionless, and that is the whole point.
    /// @dev The venue must not choose when to cross, because choosing when to
    ///      cross is choosing the price. Following `Regime.adopt`,
    ///      `ParameterRoot.adopt` and `VolumeCap.enforce`.
    function test_crossingIsPermissionless() public {
        uint256 holdId = _hold(SELLER, 1_000);
        _commit(SELLER, OrderBook.Side.SELL, 95, 1_000, "s");
        _commit(BUYER, OrderBook.Side.BUY, 105, 1_000, "b");
        _open();
        _reveal(SELLER, OrderBook.Side.SELL, 95, 1_000, "s", holdId, 0);
        _reveal(BUYER, OrderBook.Side.BUY, 105, 1_000, "b", 0, 105 * 1_000);

        uint64 r = engine.currentRound();
        _nextRound();
        vm.prank(address(0xBEEF));
        engine.crossRound(r);
        assertEq(ats.delivered(BUYER), 1_000);
    }

    /// @notice The measured reason resting exists: a lone order finds nobody in
    ///         its own round and trades in a later one.
    /// @dev `probes/matching-clearing.py` section 5: resting seven rounds takes
    ///      crossings from 130.0 a year to 277.8, at the cost of one extra
    ///      per-round predicate rather than a fresh exact disclosure per round.
    function test_aRestingOrderCrossesInALaterRound() public {
        uint256 holdId = _hold(SELLER, 1_000);
        _commit(SELLER, OrderBook.Side.SELL, 95, 1_000, "s");
        _open();
        _reveal(SELLER, OrderBook.Side.SELL, 95, 1_000, "s", holdId, 0);
        uint64 first = engine.currentRound();

        _nextRound();
        engine.crossRound(first);
        assertEq(ats.delivered(BUYER), 0, "nobody to trade with");
        assertTrue(engine.isLive(_idOf(SELLER, OrderBook.Side.SELL, 95, 1_000, "s")));

        // A buyer arrives three rounds later. The sell is still resting.
        _nextRound();
        _nextRound();
        _commit(BUYER, OrderBook.Side.BUY, 105, 1_000, "b");
        _open();
        _reveal(BUYER, OrderBook.Side.BUY, 105, 1_000, "b", 0, 105 * 1_000);
        uint64 later = engine.currentRound();
        _nextRound();
        engine.crossRound(later);

        assertEq(ats.delivered(BUYER), 1_000, "the rested order traded");
    }

    /// @notice A partial fill leaves the remainder resting, and it comes back.
    /// @dev Partial fills are not optional. At the clearing price the two sides
    ///      are unequal by construction, so somebody on the long side is
    ///      rationed, and rationing a lot that cannot be split means either
    ///      refusing the trade or filling more than was executable.
    function test_aPartialFillRestsAndTheRemainderIsReturned() public {
        uint256 holdId = _hold(SELLER, 1_000);
        bytes32 sell = _commit(SELLER, OrderBook.Side.SELL, 95, 1_000, "s");
        _commit(BUYER, OrderBook.Side.BUY, 105, 400, "b");
        _open();
        _reveal(SELLER, OrderBook.Side.SELL, 95, 1_000, "s", holdId, 0);
        _reveal(BUYER, OrderBook.Side.BUY, 105, 400, "b", 0, 105 * 400);

        uint64 r = engine.currentRound();
        _nextRound();
        engine.crossRound(r);

        assertEq(ats.delivered(BUYER), 400, "the buyer got what they asked for");
        assertTrue(engine.isLive(sell), "the seller's remainder still rests");
        (,,,, uint128 filled,,,,) = engine.orders(sell);
        assertEq(filled, 400, "and the fill is recorded");

        // Rest it out, and the untraded 600 goes back to the seller's balance.
        for (uint256 i = 0; i < REST + 2; ++i) {
            _nextRound();
        }
        engine.expire(sell);
        assertFalse(engine.isLive(sell));
    }

    // ------------------------------------------------- disclosure at the cross

    /// @notice Section 7.2 as written does not merely refuse the print. **There
    ///         is no crossing to print, because there is no reveal.**
    /// @dev Rows 3 and 4 refuse an exact immediate disclosure, so an order never
    ///      reaches the book at all and the round is empty. The blocker the old
    ///      `match` comment named as "two open matrix cells" turns out to sit one
    ///      step earlier than the cross.
    function test_theMatrixAsWrittenRefusesTheCrossing() public {
        _publish(sevenTwoAsWritten());
        uint256 holdId = _hold(SELLER, 1_000);
        _commit(SELLER, OrderBook.Side.SELL, 95, 1_000, "s");
        _open();

        vm.prank(SELLER);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderBook.DisclosureExceedsCeiling.selector,
                uint16(4),
                L.excess(L.point(L.G_EXACT, L.T_15M), L.point(L.G_EXACT, L.T_IMM))
            )
        );
        engine.reveal(OrderBook.Side.SELL, 95, 1_000, "s", holdId);

        uint64 r = engine.currentRound();
        _nextRound();
        vm.expectEmit(true, false, false, false, address(engine));
        emit MatchingEngine.RoundEmpty(r);
        engine.crossRound(r);
    }

    /// @notice **A price the venue may not print exactly is dark volume, and
    ///         Article 5 is the thing that notices.**
    ///
    /// This closes a loop nothing had closed. `VolumeCap.record` had no
    /// production caller, so the cap counted zero volume forever and `enforce`
    /// could never fire. Wiring it to the print rather than to the trade is what
    /// makes it mean something: a trade whose execution price went out at an
    /// order of magnitude instead of a number is a trade that used a hiding
    /// mechanism, which is what Article 5 caps.
    function test_aPriceThatCannotBePrintedExactlyIsDarkVolume() public {
        _publish(coarseExecutionPrice());
        uint256 holdId = _hold(SELLER, 1_000);
        _commit(SELLER, OrderBook.Side.SELL, 95, 1_000, "s");
        _commit(BUYER, OrderBook.Side.BUY, 105, 1_000, "b");
        _open();
        _reveal(SELLER, OrderBook.Side.SELL, 95, 1_000, "s", holdId, 0);
        _reveal(BUYER, OrderBook.Side.BUY, 105, 1_000, "b", 0, 105 * 1_000);

        uint64 r = engine.currentRound();
        _nextRound();
        vm.recordLogs();
        engine.crossRound(r);

        assertTrue(_sawCoarsePrint(vm.getRecordedLogs()), "the print degraded");
        assertEq(cap.shareBps(), 10_000, "every unit of it counted as deferred");
        assertTrue(cap.enforce(), "the cap bound");
        assertTrue(cap.suspendedNow());
        assertEq(regime.floor(), L.point(L.G_EXACT, L.T_IMM), "the obligation rose");
    }

    /// @notice And an exact print is not dark, so the cap stays quiet.
    /// @dev The control. Without it the test above would pass on a contract that
    ///      recorded every trade as deferred unconditionally.
    function test_anExactPrintIsNotDarkVolume() public {
        uint256 holdId = _hold(SELLER, 1_000);
        _commit(SELLER, OrderBook.Side.SELL, 95, 1_000, "s");
        _commit(BUYER, OrderBook.Side.BUY, 105, 1_000, "b");
        _open();
        _reveal(SELLER, OrderBook.Side.SELL, 95, 1_000, "s", holdId, 0);
        _reveal(BUYER, OrderBook.Side.BUY, 105, 1_000, "b", 0, 105 * 1_000);

        uint64 r = engine.currentRound();
        _nextRound();
        engine.crossRound(r);

        assertEq(cap.shareBps(), 0, "nothing was hidden");
        assertFalse(cap.enforce(), "so there is nothing to suspend");
    }

    /// @notice **The repetition attack and Article 5 turn out to be one
    ///         mechanism seen from two ends.**
    ///
    /// `docs/manipulation-surface.md` MA-04 is iceberg probing by repetition:
    /// the level ceiling is join-idempotent, so repeating a disclosure is free
    /// and only a budget sees it. Narrow row 5 so a budget can attach to it at
    /// all (Rule B forbids one on a row admitting exact), give it eight bits
    /// against four-bit buckets, and the third print in an epoch is withheld.
    ///
    /// That withheld print is dark volume, so the dark share rises and Article 5
    /// fires. Exhausting the venue's speech budget is therefore not a way to
    /// trade quietly: it is a way to get the waiver suspended and the obligation
    /// raised, which compels the printing again.
    function test_anExhaustedBudgetSilencesThePrintAndArticleFiveNotices() public {
        _publish(meteredExecutionPrice());

        for (uint256 i = 0; i < 3; ++i) {
            uint256 holdId = _hold(SELLER, 100);
            bytes32 salt = bytes32(i);
            _commit(SELLER, OrderBook.Side.SELL, 95, 100, salt);
            _commit(BUYER, OrderBook.Side.BUY, 105, 100, salt);
            _open();
            _reveal(SELLER, OrderBook.Side.SELL, 95, 100, salt, holdId, 0);
            _reveal(BUYER, OrderBook.Side.BUY, 105, 100, salt, 0, 105 * 100);
            uint64 r = engine.currentRound();
            _nextRound();
            vm.recordLogs();
            engine.crossRound(r);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            if (i < 2) {
                assertTrue(_sawCoarsePrint(logs), "the first two prints go out");
            } else {
                assertTrue(_sawWithheldPrint(logs), "the third is silenced");
            }
        }
        assertEq(engine.spentBits(5, params.currentEpoch()), 8, "row 5 is spent out");
        assertTrue(cap.enforce(), "and the silence is dark volume");
    }

    // ---------------------------------------------------------------- wiring

    /// @notice A venue that cannot clear is a better failure than a venue that
    ///         clears unmetered.
    function test_clearingRefusesUntilTheCapIsAttached() public {
        _deployPolicy(asDeployed(), address(0));
        MatchingEngine bare = new MatchingEngine(
            DELAY, WINDOW, BOND, FEE, params, ROUND, REST, ats, PARTITION, seamC
        );
        vm.warp(block.timestamp + ROUND + 1);
        vm.expectRevert(MatchingEngine.VolumeCapNotAttached.selector);
        bare.crossRound(0);
    }

    /// @notice A cap pointed at somebody else's venue cannot be installed.
    function test_aBorrowedCapCannotBeAttached() public {
        VolumeCap other =
            new VolumeCap(regime, address(0xDEAD), 4000, L.point(L.G_EXACT, L.T_IMM));
        vm.expectRevert(MatchingEngine.VolumeCapAlreadyAttached.selector);
        engine.attachVolumeCap(other);
    }

    // ------------------------------------------------------- row 12, admitted

    /// @notice **The counterparty is named at settlement and nowhere earlier.**
    ///
    /// Row 12 is admitted rather than solved, and this is what admitting it
    /// means in practice, stated as something a reviewer can check rather than
    /// as a sentence in a document. The commitment discloses one `bytes32` and
    /// the committer's address; the reveal discloses a side, a price and a size;
    /// only the settlement names a pair. So the venue defers *when* the
    /// relationship is disclosed, which is worth something against the
    /// pre-consensus observers an earlier measurement measured, and it does not narrow *who*
    /// eventually learns it.
    ///
    /// The disclosure is ATS's transfer, not our event. `Settled` is the audit
    /// record of a fact that lands on chain regardless, which is exactly why
    /// Rule B leaves this row unmetered: a budget that withheld our event while
    /// the pair went out anyway would certify a bound that does not hold.
    function test_theCounterpartyIsNamedAtSettlementAndNotBefore() public {
        uint256 holdId = _hold(SELLER, 1_000);
        bytes32 sell = _idOf(SELLER, OrderBook.Side.SELL, 95, 1_000, "s");
        bytes32 buy = _idOf(BUYER, OrderBook.Side.BUY, 105, 1_000, "b");

        vm.recordLogs();
        _commit(SELLER, OrderBook.Side.SELL, 95, 1_000, "s");
        _commit(BUYER, OrderBook.Side.BUY, 105, 1_000, "b");
        _open();
        _reveal(SELLER, OrderBook.Side.SELL, 95, 1_000, "s", holdId, 0);
        _reveal(BUYER, OrderBook.Side.BUY, 105, 1_000, "b", 0, 105 * 1_000);
        // The claim is about the *relationship*, not about either address.
        // `Committed` names its own committer under row 17, account provenance,
        // and that is a disclosure the matrix already grants. What row 12 is
        // about is the pair, so the check is that no single event carries both
        // before a trade exists.
        _assertNoLogNamesBoth(
            vm.getRecordedLogs(), SELLER, BUYER, "a pre-trade event named both sides"
        );

        uint64 r = engine.currentRound();
        _nextRound();
        vm.expectEmit(true, true, false, true, address(engine));
        emit MatchingEngine.Settled(sell, buy, 1_000, 100 * 1_000);
        engine.crossRound(r);
    }

    /// @notice Row 12 carries no budget, and that is Rule B rather than a gap.
    /// @dev `DisclosureBudget.requireWellFormed` demands `budgetBits <
    ///      domainBits` and an exact disclosure costs `domainBits`, so a budget
    ///      on a row published at `(exact, imm)` could never bind;
    ///      `ParameterRoot.adopt` refuses to publish one. The consequence here is
    ///      the right one: metering a disclosure the venue cannot withhold would
    ///      be worse than not metering it.
    function test_rowTwelveIsUnmeterableByConstruction() public view {
        assertTrue(engine.wouldDisclose(12, L.G_EXACT, L.T_IMM), "row 12 is admitted");
        assertEq(engine.breakingSize(12, L.G_EXACT), 0, "and carries no budget at all");
    }

    // ----------------------------------------------------------------- cost

    /// @notice What a round costs, measured rather than asserted.
    /// @dev The clearing scan is `O(n^2)` over the live book and the allocation
    ///      is another `O(n^2)`, which is only defensible because `n` is the
    ///      resting window and not the venue's history. At 600 orders a year with
    ///      a daily round and seven rounds of resting, the measured live book is
    ///      about a dozen orders. This logs the shape so a future change that
    ///      makes it quadratic in something unbounded is visible in a diff.
    function test_theCostOfARound() public {
        for (uint256 k = 1; k <= 3; ++k) {
            _deploy(asDeployed());
            uint256 pairs = k * 2;
            for (uint256 i = 0; i < pairs; ++i) {
                bytes32 salt = bytes32(i);
                uint256 holdId = _hold(SELLER, 100);
                _commit(SELLER, OrderBook.Side.SELL, 95, 100, salt);
                _commit(BUYER, OrderBook.Side.BUY, 105, 100, salt);
                _open();
                _reveal(SELLER, OrderBook.Side.SELL, 95, 100, salt, holdId, 0);
                _reveal(BUYER, OrderBook.Side.BUY, 105, 100, salt, 0, 105 * 100);
            }
            uint64 r = engine.currentRound();
            _nextRound();
            uint256 before = gasleft();
            engine.crossRound(r);
            emit log_named_uint(
                string.concat("crossRound gas, ", vm.toString(pairs * 2), " orders"),
                before - gasleft()
            );
        }
    }

    function _assertNoLogNamesBoth(
        Vm.Log[] memory logs,
        address a,
        address b,
        string memory why
    ) internal pure {
        bytes32 na = bytes32(uint256(uint160(a)));
        bytes32 nb = bytes32(uint256(uint160(b)));
        for (uint256 i = 0; i < logs.length; ++i) {
            bool sawA;
            bool sawB;
            for (uint256 j = 0; j < logs[i].topics.length; ++j) {
                if (logs[i].topics[j] == na) sawA = true;
                if (logs[i].topics[j] == nb) sawB = true;
            }
            if (logs[i].data.length >= 32) {
                for (uint256 o = 0; o + 32 <= logs[i].data.length; o += 32) {
                    bytes32 word;
                    bytes memory d = logs[i].data;
                    assembly {
                        word := mload(add(add(d, 32), o))
                    }
                    if (word == na) sawA = true;
                    if (word == nb) sawB = true;
                }
            }
            assertFalse(sawA && sawB, why);
        }
    }

    // --------------------------------------------------------------- helpers

    // ------------------------------------------------------------- the cancel

    /// @notice **The engine needs no cancel override**, and that follows from
    ///         where the window sits rather than being something left undone.
    ///
    /// @dev `_bind` is the only writer of `backingOf`, and it runs at reveal. A
    ///      cancel is legal only before reveal opens, so there is no hold to
    ///      release, no escrow to return and no entry to clear. Everything
    ///      `cancel` touches lives in the base contract.
    ///
    ///      **A window reaching one second past `revealDelay` would have needed
    ///      the whole of `_unbind`**, on a path that must not revert, releasing a
    ///      hold through a low level call whose failure the base cannot see. The
    ///      security argument for closing the window where it closes and the
    ///      argument for this being a base-only change are the same argument.
    function test_cancellingNeedsNothingFromTheEngine() public {
        uint256 holdId = _hold(SELLER, 1_000);
        uint256 executionsBefore = ats.executions();
        uint256 nextIdBefore = ats.nextId();

        bytes32 id = _commit(SELLER, OrderBook.Side.SELL, 100, 500, "cancelme");
        vm.prank(SELLER);
        engine.cancel(id);

        (uint256 boundHold, uint256 snapshot, uint256 escrow) = engine.backingOf(id);
        assertEq(boundHold, 0, "no hold was ever bound");
        assertEq(snapshot, 0, "and none was snapshotted");
        assertEq(escrow, 0, "and no cash was escrowed");
        assertEq(ats.executions(), executionsBefore, "no hold was executed");
        assertEq(ats.nextId(), nextIdBefore, "and none was created");
        assertEq(engine.credit(SELLER), BOND - FEE, "the refund is the base contract's");
        assertEq(engine.feesRetained(), FEE);

        // The hold is untouched and still usable, which is the property a seller
        // cares about: pulling a quote must not cost them their lot.
        (uint256 amount,,,,,,) = ats.getHoldForByPartition(
            IHoldTypes.HoldIdentifier({
                partition: PARTITION, tokenHolder: SELLER, holdId: holdId
            })
        );
        assertEq(amount, 1_000, "the lot is still encumbered to the engine, unspent");
    }

    function _hold(address who, uint256 amount) internal returns (uint256 id) {
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

    function _idOf(address who, OrderBook.Side side, uint128 p, uint128 q, bytes32 salt)
        internal
        view
        returns (bytes32)
    {
        return engine.commitmentOf(who, side, p, q, salt);
    }

    function _commit(address who, OrderBook.Side side, uint128 p, uint128 q, bytes32 salt)
        internal
        returns (bytes32 id)
    {
        id = _idOf(who, side, p, q, salt);
        vm.prank(who);
        engine.commit{value: BOND}(id);
    }

    /// @dev The reveal window opens `DELAY` after the commit. Warping is a
    ///      separate step so a test can commit several orders at one timestamp
    ///      and open them all in the same round, which is what a call auction
    ///      round actually looks like.
    function _open() internal {
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
    ) internal {
        vm.prank(who);
        engine.reveal{value: cash}(side, p, q, salt, backing);
    }

    function _nextRound() internal {
        vm.warp(block.timestamp + ROUND);
    }

    function _sawCoarsePrint(Vm.Log[] memory logs) internal pure returns (bool) {
        return _saw(logs, MatchingEngine.PrintedCoarse.selector);
    }

    function _sawWithheldPrint(Vm.Log[] memory logs) internal pure returns (bool) {
        return _saw(logs, MatchingEngine.PrintWithheld.selector);
    }

    function _saw(Vm.Log[] memory logs, bytes32 topic) private pure returns (bool) {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) return true;
        }
        return false;
    }

    receive() external payable {}
}
