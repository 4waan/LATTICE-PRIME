// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {RepoVault} from "../src/repo/RepoVault.sol";
import {OrderBook} from "../src/market/OrderBook.sol";
import {IHoldByPartition, IHoldTypes} from "../src/interfaces/IHoldByPartition.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {DisclosureBudget as B} from "../src/lattice/DisclosureBudget.sol";
import {DisclosureMeter} from "../src/lattice/DisclosureMeter.sol";
import {ParameterRoot} from "../src/policy/ParameterRoot.sol";
import {PolicyFixture} from "./PolicyFixture.sol";
import {StubOracle} from "./OracleFixture.sol";

contract HoldsStub is IHoldByPartition {
    /// @dev Row 12 of the call list. No contract calls it; the client does, and
    ///      nothing in this suite is a client, so it answers zero rather than a
    ///      plausible number. `AtsHolds` in `MatchingEngine.t.sol` keeps a real
    ///      sum, which is where the read is exercised.
    function getHeldAmountForByPartition(bytes32, address) external pure returns (uint256) {
        return 0;
    }

    /// @dev Row 11 of the call list, added with `MatchingEngine`. This suite does
    ///      not exercise the read, so it answers with a hold that would pass no
    ///      check; a stub that returned something plausible would be a stub
    ///      asserting the engine's precondition on the engine's behalf.
    function getHoldForByPartition(IHoldTypes.HoldIdentifier calldata)
        external
        pure
        returns (uint256, uint256, address, address, bytes memory, bytes memory, uint8)
    {
        return (0, 0, address(0), address(0), "", "", 0);
    }

    uint256 private _next = 1;

    function createHoldByPartition(bytes32, IHoldTypes.Hold calldata)
        external
        returns (bool, uint256)
    {
        return (true, _next++);
    }

    function createHoldFromByPartition(
        bytes32,
        address,
        IHoldTypes.Hold calldata,
        bytes calldata
    ) external returns (bool, uint256) {
        return (true, _next++);
    }

    function executeHoldByPartition(IHoldTypes.HoldIdentifier calldata id, address, uint256)
        external
        pure
        returns (bool, bytes32)
    {
        return (true, id.partition);
    }

    function releaseHoldByPartition(IHoldTypes.HoldIdentifier calldata, uint256)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

/// @title DisclosureMeterTest
/// @notice The collusion check, run against the deployed system rather than
///         against a document.
///
/// `scripts/collusion-check.py` computes joins over a transcribed matrix. This
/// suite computes them over the contracts, which is a different claim: the
/// script says the matrix would hold if the venue behaved as written, and these
/// say the venue behaves that way. The two disagreements that motivated the
/// meter are pinned here as tests rather than left as prose, in
/// `test_theBooksExactRowsAreUnmeterableByConstruction` and
/// `test_everyMeterableRowCarriesABudgetAndNoOtherRowDoes`.
contract DisclosureMeterTest is Test, PolicyFixture {
    /// @dev Dark by default, which is the venue this suite was written against:
    ///      `postMark` is reachable and `markToMarket` is not. See `OracleFixture`.
    StubOracle internal feed;

    /// @dev `markToMarket` raises a call with a published window rather than a
    ///      caller-chosen one, because it is permissionless. `postMark` still
    ///      takes its own, so nothing below had to change.
    uint64 internal constant CURE_WINDOW = 1 days;

    /// @dev 0.10 bp a day, the Article 7 rate for sovereign debt. See
    ///      `RepoVault.penaltyRate` for why it is configured rather than derived.
    uint256 internal constant PENALTY_RATE = 10;
    uint64 internal constant FAIL_GRACE = 5 days;

    RepoVault internal vault;
    OrderBook internal book;
    HoldsStub internal holds;

    address internal constant BORROWER = address(0xB0);
    address internal constant LENDER = address(0x1E);
    address internal constant ENGINE = address(0x3A);

    uint16 internal constant ROW_POSITION = 14;
    uint16 internal constant ROW_ORDER_SIZE = 3;
    uint16 internal constant ROW_PROVENANCE = 17;
    uint16 internal constant ROW_ACTIVITY = 15;

    bytes32 internal constant PARTITION = bytes32(uint256(1));

    function setUp() public {
        feed = new StubOracle();
        _deployPolicy(withBudgets());
        holds = new HoldsStub();
        vault = new RepoVault(holds, ENGINE, feed, params, PENALTY_RATE, FAIL_GRACE, CURE_WINDOW);
        // A zero bond, so the derived cancel-fee floor is zero too and this
        // deployment says nothing about the fee policy. `OrderCancelTest` owns
        // that; this suite only needs a book that discloses.
        book = new OrderBook(1 hours, 1 days, 0, 0, params, 1 days, 0);
    }

    function _terms() internal pure returns (RepoVault.Terms memory) {
        return RepoVault.Terms({
            partition: PARTITION,
            collateralAmount: 1_000e18,
            markValue: 1_000e18,
            haircutBps: 200,
            maintenanceBps: 500,
            repoRateBps: 300,
            term: 30 days
        });
    }

    function _open(bytes32 id) internal {
        vm.prank(BORROWER);
        vault.open(id, LENDER, _terms());
    }

    /// @dev One coupon cycle costs two `(pred, imm)` disclosures on row 14:
    ///      `noteCoupon` moves `OPEN -> MANUFACTURED` and `payThrough` moves it
    ///      back. Used to spend the budget a bit at a time.
    function _cycle(bytes32 id) internal {
        vault.noteCoupon(id, keccak256("coupon"));
        vm.prank(LENDER);
        vault.payThrough(id);
    }

    // ------------------------------------------------------- the parameters

    /// @notice The fixture and the contract must agree about a leaf, for the
    ///         reason `rootOf` and `commitmentOf` are both public and pure.
    function test_theFixturePacksWhatTheContractUnpacks() public view {
        B.Row memory r = params.unpackBudget(_packBudget(8, 2, 4, 3));
        assertEq(r.domainBits, 8, "domain");
        assertEq(r.aggBits, 2, "agg");
        assertEq(r.bucketBits, 4, "bucket");
        assertEq(r.budgetBits, 3, "budget");
        assertEq(params.packBudget(r), _packBudget(8, 2, 4, 3), "round trip");
    }

    /// @notice The deployed matrix carries one budget, and two rows could carry
    ///         one. The gap between those numbers is the finding.
    ///
    /// @dev Rows 3, 4, 5, 7, 16 and 17 publish at `(exact, imm)`, which costs
    ///      `domainBits` against a budget `requireWellFormed` holds below it, so
    ///      `adopt` refuses every one. Rule B, and structural: no number fixes
    ///      those rows.
    ///
    ///      **Two rows escape it and the second arrived with the cancel.** Row 14
    ///      has carried the venue's only budget since the meter was wired; row 15
    ///      is the first meterable row on the trading path rather than the repo
    ///      one. `asDeployed` publishes its ceiling with no budget under it and
    ///      `meteredCancellations` is the set that binds it.
    ///
    ///      So the distinction drawn here is between a row that carries a bound
    ///      and one that could. Collapsing them is how a venue ends up believing
    ///      it is metered on a surface it merely could be.
    function test_everyMeterableRowCarriesABudgetAndNoOtherRowDoes() public view {
        uint16[9] memory rows = [uint16(3), 4, 5, 7, 13, 14, 15, 16, 17];
        uint256 metered;
        uint256 meterable;
        for (uint256 i = 0; i < rows.length; ++i) {
            bool exactCeiling =
                L.permits(params.ceilingFor(rows[i]), L.point(L.G_EXACT, L.T_IMM));
            bool published = params.ceilingFor(rows[i]) != L.BOTTOM;
            bool hasBudget = params.budgetFor(rows[i]).budgetBits != 0;
            assertTrue(
                !(exactCeiling && hasBudget), "Rule B pairs an exact ceiling with a budget"
            );
            if (hasBudget) metered++;
            if (published && !exactCeiling) meterable++;
        }
        assertEq(meterable, 3, "rows 13, 14 and 15 sit below exact");
        assertEq(metered, meterable, "and the deployed set meters every one of them");
        assertTrue(params.budgetFor(ROW_POSITION).budgetBits != 0, "row 14, the position");
        assertTrue(params.budgetFor(ROW_ACTIVITY).budgetBits != 0, "row 15, the cancel");
        assertTrue(params.budgetFor(13).budgetBits != 0, "row 13, the match predicate");
    }

    /// @notice The order book's **exact** rows cannot be metered by any
    ///         parameter set, and no budget number fixes them.
    ///
    /// @dev The lever is a coarser disclosure, which `OrderBook.ROW_ACTIVITY`
    ///      took: see `OrderCancelTest.test_cancellationIsTheBooksOnlyMeterableRow`
    ///      for the row that now binds. **This test's scope narrowed when the
    ///      cancel landed**: it used to say the book was unmeterable full stop,
    ///      and what it ever demonstrated is that rows disclosed at `exact` are.
    ///
    ///      Recorded so nobody later reads the inert meter on rows 3, 4 and 17 as
    ///      an oversight and "fixes" it with a budget, which under Rule A would
    ///      silence those rows on every call rather than bounding them.
    function test_theBooksExactRowsAreUnmeterableByConstruction() public {
        // Attach a budget to row 3, which the book discloses at `exact`.
        ParameterRoot.Param[] memory bad =
            _with(withBudgets(), bytes32(uint256(36 + 3)), _packBudget(8, 2, 4, 3));

        bytes32 r = params.rootOf(bad);
        vm.prank(OPERATOR);
        params.propose(r, "row 3 budget");
        clock.tick();
        vm.expectRevert(
            abi.encodeWithSelector(
                ParameterRoot.BudgetCannotBindRow.selector, uint16(3), params.ceilingFor(3)
            )
        );
        params.adopt(bad);
    }

    /// @notice A budget on a row nobody published is a bound on a channel that
    ///         does not exist.
    function test_aBudgetOnAnUnpublishedRowIsUnadoptable() public {
        // Row 9 is in no set, so it has no ceiling. Key 45 sorts before 49.
        ParameterRoot.Param[] memory bad =
            _with(withBudgets(), bytes32(uint256(36 + 9)), _packBudget(8, 2, 4, 3));

        bytes32 r = params.rootOf(bad);
        vm.prank(OPERATOR);
        params.propose(r, "unpublished row budget");
        clock.tick();
        vm.expectRevert(
            abi.encodeWithSelector(ParameterRoot.BudgetOnUnpublishedRow.selector, uint16(9))
        );
        params.adopt(bad);
    }

    /// @notice A budget that is not binding is un-adoptable, because it would
    ///         certify a limit it does not hold.
    function test_aBudgetAtOrAboveTheDomainIsUnadoptable() public {
        // budgetBits == domainBits. `requireWellFormed` refuses it.
        ParameterRoot.Param[] memory set =
            _with(withBudgets(), bytes32(uint256(36 + 14)), _packBudget(8, 2, 4, 8));
        bytes32 r = params.rootOf(set);
        vm.prank(OPERATOR);
        params.propose(r, "non binding budget");
        clock.tick();
        vm.expectRevert();
        params.adopt(set);
    }

    // ------------------------------------------------------- the mechanism

    /// @notice The headline. A row's budget is spent by disclosures and the
    ///         venue stops speaking on that row when it runs out.
    function test_theBudgetBindsAndTheRowGoesQuiet() public {
        bytes32 id = keccak256("r1");
        _open(id);
        uint64 e = params.currentEpoch();

        assertEq(vault.spentBits(ROW_POSITION, e), 0, "nothing spent yet");
        assertTrue(vault.wouldAfford(ROW_POSITION, L.G_PRED), "affordable at the start");

        // Three `(pred, imm)` disclosures fit in a budget of three bits.
        vault.noteCoupon(id, keccak256("c1"));
        assertEq(vault.spentBits(ROW_POSITION, e), 1, "one bit");
        vm.prank(LENDER);
        vault.payThrough(id);
        assertEq(vault.spentBits(ROW_POSITION, e), 2, "two bits");
        vault.noteCoupon(id, keccak256("c2"));
        assertEq(vault.spentBits(ROW_POSITION, e), 3, "three bits, spent");

        assertFalse(vault.wouldAfford(ROW_POSITION, L.G_PRED), "the row is now quiet");

        // The fourth disclosure is withheld. The transition still happens.
        vm.recordLogs();
        vm.prank(LENDER);
        vault.payThrough(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            assertTrue(
                logs[i].topics[0] != keccak256("ManufacturedPaid(bytes32)"),
                "the disclosure was withheld"
            );
        }
        assertEq(
            uint8(vault.stateOf(id)), uint8(RepoVault.State.OPEN), "and the state moved anyway"
        );
        assertEq(vault.spentBits(ROW_POSITION, e), 3, "no overspend");
    }

    /// @notice Rule A. An exhausted budget never fails an action, because nearly
    ///         every disclosure in a repo lifecycle sits on an obligation path.
    /// @dev The property that made the reverting design unshippable: exhaust the
    ///      row and a position must still close.
    function test_anExhaustedRowStillLetsAPositionClose() public {
        bytes32 id = keccak256("r2");
        _open(id);
        _cycle(id);
        vault.noteCoupon(id, keccak256("c"));
        vm.prank(LENDER);
        vault.payThrough(id); // withheld, budget already at three
        assertFalse(vault.wouldAfford(ROW_POSITION, L.G_PRED), "row is spent");

        vm.warp(block.timestamp + 31 days);
        vm.prank(BORROWER);
        vault.close(id);
        assertEq(uint8(vault.stateOf(id)), uint8(RepoVault.State.CLOSED), "closed regardless");
    }

    /// @notice The arithmetic in `DisclosureBudget.breakingSize` is the number
    ///         the mechanism actually produces.
    /// @dev Checked against behaviour rather than against itself. This is the
    ///      sentence a supervisor asks for: how many observations before the row
    ///      is gone.
    function test_breakingSizeIsTheNumberObserved() public {
        assertEq(vault.breakingSize(ROW_POSITION, L.G_PRED), 4, "predicted");
        bytes32 id = keccak256("r3");
        _open(id);
        uint256 admitted;
        for (uint256 i = 0; i < 8; ++i) {
            if (vault.wouldAfford(ROW_POSITION, L.G_PRED)) admitted++;
            if (i % 2 == 0) {
                vault.noteCoupon(id, keccak256(abi.encode(i)));
            } else {
                vm.prank(LENDER);
                vault.payThrough(id);
            }
        }
        assertEq(admitted, 3, "three fit, so the fourth breaks it");
    }

    /// @notice The budget is per epoch. A lifetime cap on a venue that trades
    ///         forever is a shutdown date.
    function test_theBudgetRefillsWithTheEpoch() public {
        bytes32 id = keccak256("r4");
        _open(id);
        _cycle(id);
        vault.noteCoupon(id, keccak256("c"));
        assertFalse(vault.wouldAfford(ROW_POSITION, L.G_PRED), "spent in this epoch");
        clock.tick();
        assertTrue(vault.wouldAfford(ROW_POSITION, L.G_PRED), "and refilled in the next");
        assertEq(
            vault.spentBits(ROW_POSITION, params.currentEpoch()), 0, "new epoch, new ledger"
        );
    }

    /// @notice An unmetered row behaves exactly as it did before the meter
    ///         existed, which is what made the wiring safe to add everywhere at
    ///         once.
    function test_anUnmeteredRowIsUnaffected() public {
        assertEq(params.budgetFor(ROW_PROVENANCE).budgetBits, 0, "row 17 is unmetered");
        vm.recordLogs();
        vm.prank(BORROWER);
        book.commit(keccak256("order"));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawCommitted;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("Committed(bytes32,address)")) {
                sawCommitted = true;
            }
        }
        assertTrue(sawCommitted, "the event still goes out");
        assertTrue(book.wouldAfford(ROW_PROVENANCE, L.G_EXACT), "and always will");
        assertEq(
            book.breakingSize(ROW_PROVENANCE, L.G_EXACT),
            0,
            "no coalition breaks an unmetered row"
        );
    }

    /// @notice What a charged disclosure costs, and what a withheld one costs,
    ///         measured on the **same function** so the difference is the meter
    ///         and not two different state transitions.
    /// @dev `docs/fee-mechanics.md` prices the lattice half at 42 gas inline.
    ///      This is the budget half.
    ///
    ///      The gap is the finding, and it is a gas side channel: a withheld
    ///      disclosure skips one `SSTORE` to the meter, the `DisclosureCharged`
    ///      log and the withheld event itself, so a fee observer can tell a
    ///      charged call from a silenced one. **It leaks nothing new**, because
    ///      `spentBits` is a public view and the budget state was already
    ///      readable, which is the general rule: a gas channel is a leak only
    ///      when it branches on something not already public. Recorded here so
    ///      that the rule is checked rather than assumed, and so a future branch
    ///      on a secret draw is measured against a number that exists.
    function test_theCostOfMeteringOneDisclosure() public {
        bytes32 a = keccak256("gasA");
        bytes32 b = keccak256("gasB");
        _open(a);
        _open(b);

        // Both repos reach MANUFACTURED. The first `payThrough` is charged, and
        // by then the row has one bit left; the second is withheld.
        vault.noteCoupon(a, keccak256("ca")); // 1 bit
        vault.noteCoupon(b, keccak256("cb")); // 2 bits

        uint256 g0 = gasleft();
        vm.prank(LENDER);
        vault.payThrough(a); // 3 bits, the last that fits
        uint256 charged = g0 - gasleft();

        assertFalse(vault.wouldAfford(ROW_POSITION, L.G_PRED), "row spent");

        uint256 g1 = gasleft();
        vm.prank(LENDER);
        vault.payThrough(b); // withheld
        uint256 withheld = g1 - gasleft();

        emit log_named_uint("payThrough, disclosure charged ", charged);
        emit log_named_uint("payThrough, disclosure withheld", withheld);
        emit log_named_uint("the meter's visible gas delta   ", charged - withheld);
        assertLt(charged, 60_000, "a metered disclosure is not a governance vote");
        assertGt(charged, withheld, "withholding is cheaper, and that is measurable");
    }
}
