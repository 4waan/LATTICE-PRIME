// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MatchingEngine} from "../src/market/MatchingEngine.sol";
import {OrderBook} from "../src/market/OrderBook.sol";
import {CallAuction} from "../src/market/CallAuction.sol";
import {VolumeCap} from "../src/policy/VolumeCap.sol";
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

        vm.deal(SELLER, 100 ether);
        vm.deal(BUYER, 100 ether);
        vm.deal(BUYER2, 100 ether);
        vm.deal(PASSERBY, 1 ether);
    }

    // ------------------------------------------------------- section 7

    /// @notice No address can stop a round from crossing.
    /// @dev Section 7's claim, and it has to be run against a venue whose
    ///      governance has done everything it is permitted to do. The operator
    ///      moves the disclosure point and commits a new parameter set; the
    ///      supervisor, which is the cap contract, restricts the ceiling and
    ///      raises the floor. Then a passer-by crosses the round.
    ///
    ///      The reason this is a test and not a comment: any halt anyone adds
    ///      later has to be reachable from one of those seats, and this fails
    ///      the moment one is.
    function test_noAddressCanStopACross() public {
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

        assertTrue(engine.crossed(r), "governance stopped a round from crossing");
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
        vm.deal(SELLER, 100 ether);
        vm.deal(BUYER, 100 ether);

        _crossOne("a");
        cap.enforce();
        assertTrue(cap.suspendedNow(), "the cap did not fire on a fully deferred round");
        assertEq(regime.floor(), L.point(L.G_EXACT, L.T_IMM), "the floor did not rise");

        // Suspended, and still trading.
        _crossOne("b");
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
