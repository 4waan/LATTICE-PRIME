// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OrderBook} from "../src/market/OrderBook.sol";
import {OrderBookBase} from "../src/market/OrderBookBase.sol";
import {PolicyFixture} from "./PolicyFixture.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {DisclosureView} from "../src/lattice/DisclosureView.sol";

contract OrderBookTest is Test, PolicyFixture {
    OrderBook book;
    address constant ALICE = address(0xA11CE);
    address constant MALLORY = address(0x4A11);

    uint64 constant DELAY = 5 minutes;
    uint64 constant WINDOW = 30 minutes;
    uint256 constant BOND = 0.1 ether;
    /// A daily round, which `probes/matching-clearing.py` section 5 measures at
    /// 1.644 orders and 0.36 crossings, and a week of resting on top of it.
    uint64 constant ROUND = 1 days;
    uint64 constant REST = 7;
    /// The derived floor, `ceil(BOND * DELAY / (DELAY + WINDOW))`, as arithmetic
    /// rather than a literal. `OrderCancelTest.test_theDeployedFeeIsTheDerivedMinimum`
    /// checks it against the contract's own `minimumCancelFee`.
    uint256 constant FEE = (BOND * DELAY + (DELAY + WINDOW) - 1) / (DELAY + WINDOW);

    function setUp() public {
        _deployPolicy(asDeployed());
        book = new OrderBook(DELAY, WINDOW, BOND, FEE, params, ROUND, REST);
        vm.deal(ALICE, 10 ether);
        vm.deal(MALLORY, 10 ether);
        vm.warp(1_000_000);
    }

    // ------------------------------------------------ the matrix, enforced

    function test_theMatrixAsWrittenRefusesTheReveal() public {
        _publish(sevenTwoAsWritten());

        bytes32 id = _id(ALICE);
        vm.prank(ALICE);
        book.commit{value: BOND}(id); // row 17 is unchanged, so this still lands
        vm.warp(block.timestamp + DELAY + 1);

        assertFalse(book.wouldDisclose(4, L.G_EXACT, L.T_IMM), "row 4 refuses it");
        assertFalse(book.wouldDisclose(3, L.G_EXACT, L.T_IMM), "row 3 refuses it too");

        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                DisclosureView.DisclosureExceedsCeiling.selector,
                uint16(4),
                L.excess(L.point(L.G_EXACT, L.T_15M), L.point(L.G_EXACT, L.T_IMM))
            )
        );
        book.reveal(OrderBook.Side.BUY, 101, 5_000, keccak256("salt"), 0);
    }

    function test_theCommitmentIsFiledUnderProvenanceAndNotIdentity() public view {
        assertTrue(book.wouldDisclose(17, L.G_EXACT, L.T_IMM), "row 17 admits the address");
        assertEq(book.ceilingFor(1), L.BOTTOM, "row 1 is unpublished and would refuse it");
    }

    function _id(address who) internal view returns (bytes32) {
        return book.commitmentOf(who, OrderBook.Side.BUY, 101, 5_000, keccak256("salt"));
    }

    function test_theBondIsNotReturnedAtReveal() public {
        bytes32 id = _id(ALICE);
        vm.prank(ALICE);
        book.commit{value: BOND}(id);
        assertEq(ALICE.balance, 10 ether - BOND, "bond posted");

        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(ALICE);
        book.reveal(OrderBook.Side.BUY, 101, 5_000, keccak256("salt"), 0);

        assertEq(ALICE.balance, 10 ether - BOND, "the bond is still at stake");
        assertEq(book.credit(ALICE), 0, "and it is not yet claimable either");
        assertEq(book.revealedCount(), 1, "the order is on the live book");
        assertTrue(book.isLive(id));
    }

    function test_theBondComesBackWhenTheOrderRestsOut() public {
        bytes32 id = _id(ALICE);
        vm.prank(ALICE);
        book.commit{value: BOND}(id);
        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(ALICE);
        book.reveal(OrderBook.Side.BUY, 101, 5_000, keccak256("salt"), 0);

        uint64 last = ROUND * (REST + 1);
        vm.expectRevert();
        book.expire(id);

        vm.warp(block.timestamp + last + ROUND);
        vm.prank(address(0xBEEF)); // anyone
        book.expire(id);

        assertEq(book.revealedCount(), 0, "the live book cleared");
        assertEq(book.credit(ALICE), BOND, "credited, not pushed");
        vm.prank(ALICE);
        book.withdraw();
        assertEq(ALICE.balance, 10 ether, "and withdrawable");
    }

    /// @notice The live book is a book, not a log.
    /// @dev The field this replaced was appended to and read by nothing except
    ///      its own length, so it grew forever and a matching function would have
    ///      had to scan the venue's whole history every round. Retirement swaps
    ///      and pops, so what a round costs is the resting window.
    function test_theLiveBookShrinksWhenAnOrderRetires() public {
        bytes32 a = _commitAndReveal(ALICE, OrderBook.Side.BUY, 101, 5_000, "s1");
        bytes32 b = _commitAndReveal(MALLORY, OrderBook.Side.SELL, 99, 4_000, "s2");
        assertEq(book.revealedCount(), 2);

        vm.warp(block.timestamp + ROUND * (REST + 2));
        book.expire(a);
        assertEq(book.revealedCount(), 1);
        assertEq(book.liveAt(0), b, "the survivor moved into the vacated slot");
        assertFalse(book.isLive(a));

        book.expire(b);
        assertEq(book.revealedCount(), 0);
    }

    function _commitAndReveal(
        address who,
        OrderBook.Side side,
        uint128 price,
        uint128 qty,
        bytes32 salt
    ) internal returns (bytes32 id) {
        id = book.commitmentOf(who, side, price, qty, salt);
        vm.prank(who);
        book.commit{value: BOND}(id);
        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(who);
        book.reveal(side, price, qty, salt, 0);
    }

    /// @notice **The commitment is bound to its committer, so it cannot be stolen.**
    ///
    /// Mallory watches the mempool, sees Alice's commitment, and front-runs it.
    /// The commitment lands under Mallory's name and is perfectly valid. What
    /// Mallory cannot do is open it, because the preimage contains Alice's
    /// address, so `reveal` from Mallory hashes to a different id that was never
    /// committed. Mallory's bond is stuck until the window closes and then anyone
    /// can sweep it.
    ///
    /// Without the committer in the preimage this attack works completely, and
    /// nothing about the resulting transaction looks wrong.
    function test_stolenCommitmentCannotBeOpened() public {
        bytes32 aliceId = _id(ALICE);

        vm.prank(MALLORY);
        book.commit{value: BOND}(aliceId);

        vm.warp(block.timestamp + DELAY + 1);
        // Computed before the prank: `commitmentOf` is an external call and would
        // otherwise consume it, which is a trap worth leaving a note about.
        bytes32 malloryId = _id(MALLORY);
        assertTrue(malloryId != aliceId, "the same tuple hashes differently per sender");

        vm.prank(MALLORY);
        vm.expectRevert(
            abi.encodeWithSelector(OrderBookBase.UnknownCommitment.selector, malloryId)
        );
        book.reveal(OrderBook.Side.BUY, 101, 5_000, keccak256("salt"), 0);
    }

    /// The reveal delay is what the commitment buys. Committing and revealing in
    /// the same block would hand the plaintext to the node operators at the same
    /// moment a plain order would have.
    function test_revealBeforeTheDelayIsRefused() public {
        bytes32 id = _id(ALICE);
        vm.prank(ALICE);
        book.commit{value: BOND}(id);

        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderBookBase.TooEarly.selector, uint64(block.timestamp + DELAY)
            )
        );
        book.reveal(OrderBook.Side.BUY, 101, 5_000, keccak256("salt"), 0);
    }

    function test_revealAfterTheWindowIsRefused() public {
        bytes32 id = _id(ALICE);
        vm.prank(ALICE);
        book.commit{value: BOND}(id);

        vm.warp(block.timestamp + DELAY + WINDOW + 1);
        vm.prank(ALICE);
        vm.expectRevert();
        book.reveal(OrderBook.Side.BUY, 101, 5_000, keccak256("salt"), 0);
    }

    /// Sweeping pays the sweeper, not the venue. A venue that collected forfeited
    /// bonds would have an incentive to make reveals fail.
    function test_unrevealedBondIsSweptByWhoeverSweeps() public {
        bytes32 id = _id(ALICE);
        vm.prank(ALICE);
        book.commit{value: BOND}(id);

        vm.warp(block.timestamp + DELAY + WINDOW + 1);
        uint256 before = address(this).balance;
        book.forfeit(id);
        assertEq(address(this).balance, before + BOND, "sweeper is paid");
    }

    function test_forfeitBeforeTheWindowClosesIsRefused() public {
        bytes32 id = _id(ALICE);
        vm.prank(ALICE);
        book.commit{value: BOND}(id);
        vm.expectRevert();
        book.forfeit(id);
    }

    function testFuzz_commitCalldataIsConstantLength(uint128 price, uint128 qty, bytes32 salt)
        public
        view
    {
        bytes memory small = abi.encodeCall(OrderBook.commit, (_id(ALICE)));
        bytes memory large = abi.encodeCall(
            OrderBook.commit, (book.commitmentOf(ALICE, OrderBook.Side.SELL, price, qty, salt))
        );
        assertEq(small.length, large.length, "calldata carries no size signal");
        assertEq(small.length, 36, "4 byte selector plus one word");
    }

    receive() external payable {}
}
