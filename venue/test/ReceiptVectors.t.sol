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
///      reconciles against nothing. Which is why the page moved off
///      `meteredCancellations()` and onto `asDeployed()` the moment the deployed
///      set had a budget to print: a receipt reconciling against a fixture is
///      the same failure in a politer form. `tools/lattice.test.mjs` holds the literals
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
        // `asDeployed`, not a fixture. The page prints the numbers the venue
        // publishes; before `PolicySets.budgetFor` existed there were none to
        // print and this ran on `meteredCancellations()` instead.
        _deployPolicy(asDeployed());
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
        assertEq(r.domainBits, 2, "domainBits: cancel, reveal, forfeit");
        assertEq(r.aggBits, 2, "aggBits: no aggregate defined, so it costs the domain");
        assertEq(r.bucketBits, 2, "bucketBits: likewise");
        assertEq(r.budgetBits, 1, "budgetBits: domainBits - 1, the largest that binds");
        assertEq(B.bits(r, L.G_PRED), 1, "a cancel costs one bit");
        assertEq(B.bits(r, L.G_EXACT), 2, "exact costs the domain");
    }

    function test_theOpeningReceiptIsWhatTheGettersSay() public view {
        assertEq(book.ceilingFor(ROW_ACTIVITY), L.point(L.G_PRED, L.T_IMM), "ceilingFor");
        assertTrue(book.wouldDisclose(ROW_ACTIVITY, L.G_PRED, L.T_IMM), "wouldDisclose");
        assertEq(book.spentBits(ROW_ACTIVITY, params.currentEpoch()), 0, "spentBits");
        assertTrue(book.wouldAfford(ROW_ACTIVITY, L.G_PRED), "wouldAfford");
        assertEq(book.breakingSize(ROW_ACTIVITY, L.G_PRED), 2, "breakingSize");
    }

    function test_theSecondCancellationIsSilentAndStillSucceeds() public {
        uint64 epoch = params.currentEpoch();
        bytes32[2] memory ids;
        for (uint256 i = 0; i < 2; ++i) {
            ids[i] = book.commitmentOf(
                ALICE, OrderBook.Side.BUY, 101, 5_000, bytes32(uint256(i + 1))
            );
            vm.prank(ALICE);
            book.commit{value: BOND}(ids[i]);
        }

        assertTrue(book.wouldAfford(ROW_ACTIVITY, L.G_PRED), "audible before the first");
        vm.prank(ALICE);
        book.cancel(ids[0]);
        assertEq(book.spentBits(ROW_ACTIVITY, epoch), 1, "one bit per cancel");

        assertFalse(book.wouldAfford(ROW_ACTIVITY, L.G_PRED), "row is spent");
        assertTrue(book.wouldDisclose(ROW_ACTIVITY, L.G_PRED, L.T_IMM), "still permitted");

        uint256 before = book.credit(ALICE);
        vm.prank(ALICE);
        book.cancel(ids[1]);
        assertEq(book.credit(ALICE) - before, BOND - FEE, "the withheld cancel still refunded");
        assertEq(book.spentBits(ROW_ACTIVITY, epoch), 1, "a withheld disclosure spends nothing");
    }

    /// @notice Sweeping a stranded bond must not spend the row the receipt reports.
    ///
    /// @dev `forfeit` is the recovery path for a commitment whose cancel window
    ///      shut, and `script/live/receipt-beat.sh sweep` is the operational form
    ///      of it. It is permissionless and pays the bond to whoever calls, so a
    ///      missed window costs a fee and not a bond.
    ///
    ///      It is also the one terminal branch of a commitment's life that does
    ///      **not** go through `_emitUnder`: `BondForfeited` is emitted
    ///      unconditionally. That is deliberate and worth pinning, because the
    ///      alternative is a receipt nobody can reconcile. Row 15's budget is one
    ///      bit, so if a sweep charged it, the trader's first real cancellation of
    ///      the epoch would be withheld and the screen would show a spent row with
    ///      no cancellation behind it. The live run met this on 2026-09-06: two
    ///      bonds stranded by a closed window were swept, and `spentBits(15, e)`
    ///      read zero across both, which is this assertion made on chain.
    function test_aSweptBondDoesNotSpendTheActivityRow() public {
        uint64 epoch = params.currentEpoch();
        bytes32 stranded =
            book.commitmentOf(ALICE, OrderBook.Side.BUY, 101, 5_000, bytes32(uint256(7)));
        vm.prank(ALICE);
        book.commit{value: BOND}(stranded);

        // Past the cancel window and past the reveal window: the state the beat's
        // first attempt actually reached.
        vm.warp(block.timestamp + DELAY + WINDOW + 1);
        // In the past, not zero. `cancellableUntil` returns the instant the
        // window shut and only answers zero for a commitment that is already
        // terminal, so a client asking "can I still cancel" has to compare it
        // against the clock rather than against zero. `receipt-beat.sh` does.
        assertLe(book.cancellableUntil(stranded), block.timestamp, "cancel is shut");
        assertGt(book.cancellableUntil(stranded), 0, "and not terminal yet");

        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        book.forfeit(stranded);
        assertEq(ALICE.balance - before, BOND, "the sweeper takes the whole bond");
        assertEq(book.spentBits(ROW_ACTIVITY, epoch), 0, "a sweep charges nothing");
        assertTrue(book.wouldAfford(ROW_ACTIVITY, L.G_PRED), "the row is still audible");

        // And the next real cancellation is still the epoch's first charge.
        bytes32 id =
            book.commitmentOf(ALICE, OrderBook.Side.BUY, 101, 5_000, bytes32(uint256(8)));
        vm.prank(ALICE);
        book.commit{value: BOND}(id);
        vm.prank(ALICE);
        book.cancel(id);
        assertEq(book.spentBits(ROW_ACTIVITY, params.currentEpoch()), 1, "first charge");
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
