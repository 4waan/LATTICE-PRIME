// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OrderBook} from "../src/market/OrderBook.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {DisclosureBudget as B} from "../src/lattice/DisclosureBudget.sol";
import {PolicyFixture} from "./PolicyFixture.sol";

/// @notice The numbers `docs/disclosure-receipt.html` prints, asserted against
///         the getters it claims to be reading.
///
/// @dev The page is a receipt: after an action it says what was published, at
///      what granularity, until when, and how much of the row's epoch budget is
///      now gone. Every one of those is a `DisclosureView` getter, and the page
///      recomputes them client side from `tools/lattice.mjs` so it can show the
///      next action's receipt before the reader takes it.
///
///      That recomputation is the risk. A page that derives a budget the venue
///      does not charge is worse than no page, because it is a receipt that
///      reconciles against nothing. `tools/lattice.test.mjs` holds the literals
///      below and this file asserts the same ones against a deployed book, in
///      the pattern `CommitmentVectors.t.sol` established: both sides carry the
///      literals, neither computes the other's.
contract ReceiptVectorsTest is Test, PolicyFixture {
    uint64 constant DELAY = 5 minutes;
    uint64 constant WINDOW = 30 minutes;
    uint256 constant BOND = 0.1 ether;
    uint64 constant ROUND = 1 days;
    uint64 constant REST = 7;
    uint256 constant FEE = (BOND * DELAY + (DELAY + WINDOW) - 1) / (DELAY + WINDOW);

    uint16 constant ROW_ACTIVITY = 15;
    address constant ALICE = address(0xA11CE);

    OrderBook book;

    function setUp() public {
        vm.warp(1_000_000);
        _deployPolicy(meteredCancellations());
        book = new OrderBook(DELAY, WINDOW, BOND, FEE, params, ROUND, REST);
        vm.deal(ALICE, 10 ether);
    }

    // ------------------------------------------------------------- the cells

    function test_theCellsThePagePrintsAreTheCellsTheLatticeComputes() public pure {
        assertEq(L.point(L.G_PRED, L.T_IMM), 4030, "pred,imm");
        assertEq(L.point(L.G_EXACT, L.T_IMM), 1056698302, "exact,imm");
        assertEq(L.point(L.G_AGG, L.T_EOD), 233016, "agg,EOD");
        assertEq(L.point(L.G_BUCKET, L.T_EOD), 14913080, "bucket,EOD");
        assertEq(L.point(L.G_NONE, L.T_PRE), 63, "none,pre");
        assertEq(L.TOP, 1073741823, "TOP");
    }

    function test_row15IsIncomparableInBothDirections() public pure {
        uint32 asWritten = L.point(L.G_AGG, L.T_EOD);
        uint32 asDeployed = L.point(L.G_PRED, L.T_IMM);
        assertFalse(L.permits(asWritten, asDeployed), "as-written admits the cancel");
        assertEq(L.excess(asWritten, asDeployed), 390, "forward excess");
        assertFalse(L.permits(asDeployed, asWritten), "deployed admits the aggregate");
        assertEq(L.excess(asDeployed, asWritten), 229376, "reverse excess");
    }

    function test_theUntilWhenLineIsTheEarliestProjection() public pure {
        (uint8 t1, bool any1) = L.earliest(L.point(L.G_AGG, L.T_EOD));
        assertTrue(any1);
        assertEq(t1, L.T_EOD, "agg,EOD");
        (uint8 t2, bool any2) = L.earliest(L.point(L.G_PRED, L.T_IMM));
        assertTrue(any2);
        assertEq(t2, L.T_IMM, "pred,imm");
    }

    // ------------------------------------------------------------ the budget

    function test_theBudgetThePageReadsIsThePublishedBudget() public view {
        B.Row memory r = params.budgetFor(ROW_ACTIVITY);
        assertEq(r.domainBits, 8, "domainBits");
        assertEq(r.aggBits, 2, "aggBits");
        assertEq(r.bucketBits, 4, "bucketBits");
        assertEq(r.budgetBits, 3, "budgetBits");
        assertEq(B.bits(r, L.G_PRED), 1, "a cancel costs one bit");
        assertEq(B.bits(r, L.G_EXACT), 8, "exact costs the domain");
    }

    function test_theOpeningReceiptIsWhatTheGettersSay() public view {
        assertEq(book.ceilingFor(ROW_ACTIVITY), L.point(L.G_PRED, L.T_IMM), "ceilingFor");
        assertTrue(book.wouldDisclose(ROW_ACTIVITY, L.G_PRED, L.T_IMM), "wouldDisclose");
        assertEq(book.spentBits(ROW_ACTIVITY, params.currentEpoch()), 0, "spentBits");
        assertTrue(book.wouldAfford(ROW_ACTIVITY, L.G_PRED), "wouldAfford");
        assertEq(book.breakingSize(ROW_ACTIVITY, L.G_PRED), 4, "breakingSize");
    }

    function test_theFourthCancellationIsSilentAndStillSucceeds() public {
        uint64 epoch = params.currentEpoch();
        bytes32[4] memory ids;
        for (uint256 i = 0; i < 4; ++i) {
            ids[i] = book.commitmentOf(
                ALICE, OrderBook.Side.BUY, 101, 5_000, bytes32(uint256(i + 1))
            );
            vm.prank(ALICE);
            book.commit{value: BOND}(ids[i]);
        }

        for (uint256 i = 0; i < 3; ++i) {
            assertTrue(book.wouldAfford(ROW_ACTIVITY, L.G_PRED), "audible before cancel");
            vm.recordLogs();
            vm.prank(ALICE);
            book.cancel(ids[i]);
            assertEq(book.spentBits(ROW_ACTIVITY, epoch), i + 1, "one bit per cancel");
        }

        assertFalse(book.wouldAfford(ROW_ACTIVITY, L.G_PRED), "row is spent");
        assertTrue(book.wouldDisclose(ROW_ACTIVITY, L.G_PRED, L.T_IMM), "still permitted");

        uint256 before = book.credit(ALICE);
        vm.prank(ALICE);
        book.cancel(ids[3]);
        assertEq(book.credit(ALICE) - before, BOND - FEE, "the withheld cancel still refunded");
        assertEq(book.spentBits(ROW_ACTIVITY, epoch), 3, "a withheld disclosure spends nothing");
    }

    function test_theExactRowsReportNoBudgetToPrint() public view {
        uint16[3] memory rows = [uint16(3), uint16(4), uint16(17)];
        for (uint256 i = 0; i < rows.length; ++i) {
            assertEq(params.budgetFor(rows[i]).budgetBits, 0, "unmetered");
            assertEq(book.breakingSize(rows[i], L.G_EXACT), 0, "no breaking size");
            assertTrue(book.wouldAfford(rows[i], L.G_EXACT), "unmetered always affords");
        }
    }
}
