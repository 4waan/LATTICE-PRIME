// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {RepoMath} from "../src/repo/RepoMath.sol";
import {RepoVault} from "../src/repo/RepoVault.sol";
import {RepoVaultBase} from "../src/repo/RepoVaultBase.sol";
import {IHoldByPartition, IHoldTypes} from "../src/interfaces/IHoldByPartition.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {PolicyFixture} from "./PolicyFixture.sol";
import {CouponFixture} from "./CouponFixture.sol";
import {StubOracle} from "./OracleFixture.sol";
import {AtsHolds, MockHolds} from "./AtsHolds.sol";
import {RepoFunding} from "./RepoFunding.sol";

contract RepoMathTest is Test {
    /// A sterling gilt repo: one million units of cash, 4.50 percent, thirty days.
    /// ACT/365 gives 3698.63, and the library rounds up so the borrower never
    /// repays less than the contract says.
    function test_accrualIsActThreeSixtyFiveAndRoundsUp() public pure {
        uint256 a = RepoMath.accrued(1_000_000, 450, 0, 30 days);
        assertEq(a, 3699, "3698.63 rounded up");
    }

    function test_zeroElapsedAccruesNothing() public pure {
        assertEq(RepoMath.accrued(1_000_000, 450, 100, 100), 0);
    }

    /// Rounding up must never be rounding up by a whole unit on an exact figure.
    /// A full year at a rate that divides cleanly is the case that catches it.
    function test_exactDivisionDoesNotGainAUnit() public pure {
        assertEq(RepoMath.accrued(10_000, 10_000, 0, 365 days), 10_000, "exactly 100 pct");
    }

    function test_haircutReducesTheAdvance() public pure {
        // A two percent haircut on a mark of one million advances 980,000.
        assertEq(RepoMath.purchasePrice(1_000_000, 200), 980_000);
    }

    function test_haircutOfOneHundredPercentIsRefused() public {
        vm.expectRevert();
        this.callPurchasePrice(1_000_000, 10_000);
    }

    function callPurchasePrice(uint256 m, uint256 h) external pure returns (uint256) {
        return RepoMath.purchasePrice(m, h);
    }

    /// Monotone in time: the amount owed never goes down while the repo is open.
    /// A rounding scheme that alternated direction would break this and the break
    /// would only appear at particular timestamps.
    function testFuzz_repurchasePriceIsMonotoneInTime(uint32 t1, uint32 t2) public pure {
        vm.assume(t1 <= t2);
        uint256 p1 = RepoMath.repurchasePrice(1_000_000, 450, 0, t1);
        uint256 p2 = RepoMath.repurchasePrice(1_000_000, 450, 0, t2);
        assertLe(p1, p2);
    }

    function test_marginTriggerBoundary() public pure {
        // Exposure after zero elapsed is the principal. With a 2 percent
        // maintenance margin the collateral must be worth at least 1,020,000.
        assertFalse(
            RepoMath.isUndercollateralised(1_020_000, 1_000_000, 450, 0, 0, 200),
            "exactly on the line is covered"
        );
        assertTrue(
            RepoMath.isUndercollateralised(1_019_999, 1_000_000, 450, 0, 0, 200),
            "one unit below is not"
        );
    }

    function test_fractionalMaintenanceRequirementRoundsTowardTheLender() public pure {
        _assertMaintenanceBoundary(1, 1, 2);
        _assertMaintenanceBoundary(9_999, 1, 10_000);
        _assertMaintenanceBoundary(10_000, 1, 10_001);
        _assertMaintenanceBoundary(1_000_001, 200, 1_020_002);
    }

    function test_fullPrecisionPathsDoNotOverflowBeforeDivision() public pure {
        uint256 max = type(uint256).max;
        assertEq(RepoMath.purchasePrice(max, 0), max, "purchase");
        assertEq(
            RepoMath.accrued(max, 10_000, 0, 365 days),
            max,
            "one year at one hundred percent"
        );
        assertEq(
            RepoMath.settlementPenalty(max, 1_000_000, 0, 1),
            max,
            "one full-rate fail day"
        );

        uint256 exposure = max / 2;
        assertTrue(
            RepoMath.isUndercollateralised(max - 2, exposure, 0, 0, 0, 10_000),
            "one below the doubled requirement"
        );
        assertFalse(
            RepoMath.isUndercollateralised(max - 1, exposure, 0, 0, 0, 10_000),
            "the doubled requirement is covered"
        );
    }

    /// @dev Expected values come from `probes/repo-cash.py`, whose formula
    ///      decomposes exposure and margin instead of copying this implementation.
    function _assertMaintenanceBoundary(
        uint256 exposure,
        uint256 maintenanceBps,
        uint256 required
    ) private pure {
        assertTrue(
            RepoMath.isUndercollateralised(
                required - 1, exposure, 0, 0, 0, maintenanceBps
            ),
            "one tinybar below the independent requirement is short"
        );
        assertFalse(
            RepoMath.isUndercollateralised(required, exposure, 0, 0, 0, maintenanceBps),
            "the independent requirement is covered"
        );
    }
}

contract RepoVaultTest is Test, PolicyFixture, CouponFixture, RepoFunding {
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

    MockHolds holds;
    RepoVault vault;

    address constant BORROWER = address(0xB0B);
    address constant LENDER = address(0x1EAD);
    address constant ENGINE = address(0xE49);
    bytes32 constant ID = keccak256("repo-1");
    bytes32 constant PARTITION = bytes32(uint256(1));
    /// @dev The coupon `_noteCoupon` reaches for. Index and not an amount:
    ///      `noteCoupon` derives the amount now. See `RepoVault.noteCoupon`.
    uint256 constant COUPON_INDEX = 0;
    /// @dev The reference rate the stub publishes. Four hundred and twenty five
    ///      basis points, which is the number round one on chain 296 medianed
    ///      to. `deployments/296-venue.json` `venue.feed`.
    uint64 constant REF_RATE_BPS = 425;

    function setUp() public {
        feed = new StubOracle();
        holds = new MockHolds();
        _deployPolicy(asDeployed());
        vault = new RepoVault(
            holds,
            ENGINE,
            feed,
            _deploySchedule(uint64(block.timestamp)),
            _newKycList(),
            params,
            PENALTY_RATE,
            FAIL_GRACE,
            CURE_WINDOW
        );
    }

    function _terms() internal pure returns (RepoVault.Terms memory) {
        return RepoVault.Terms({
            partition: PARTITION,
            collateralAmount: 1_000e8,
            haircutBps: 200,
            maintenanceBps: 200,
            repoRateBps: 450,
            term: 30 days
        });
    }

    function _open() internal returns (uint256 principal) {
        return _openRepo(vault, feed, LENDER, BORROWER, ID, _terms());
    }

    /// @dev Turns the feed on and warps to the first coupon date, because
    ///      `noteCoupon` now needs both: a coupon that has fallen due, and a
    ///      published reference rate to accrue against. The feed is left dark in
    ///      `setUp` on purpose (see `OracleFixture.StubOracle`), so every other
    ///      test in this suite keeps running against the venue it was written
    ///      for, where `postMark` is the reachable seat.
    function _noteCoupon() internal returns (uint256 owed) {
        feed.setTerms(100e8, REF_RATE_BPS);
        feed.setMark(1);
        vm.warp(couponSchedule.dateOf(COUPON_INDEX));
        owed = vault.noteCoupon(ID, COUPON_INDEX);
    }

    // ------------------------------------------------------------------ T1

    function test_openTakesOneHoldAndAdvancesTheHaircutPrice() public {
        uint256 principal = _open();
        assertEq(
            principal,
            RepoMath.purchasePrice(DEFAULT_MARK_PER_UNIT * 1_000e8, 200),
            "mark less the two percent haircut"
        );
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.OPEN));
        assertEq(holds.created(), 1, "exactly one ATS hold, not a reimplementation");
        assertEq(holds.lastHoldTo(), address(0), "destination is open so close can release");
        assertEq(vault.credit(BORROWER), principal);
    }

    // ------------------------------------------------------------------ T2

    function test_closeReturnsTheCollateralAndChargesTheAccrual() public {
        uint256 principal = _open();
        vm.warp(block.timestamp + 30 days);

        uint256 expected = RepoMath.repurchasePrice(
            principal, 450, uint64(block.timestamp - 30 days), block.timestamp
        );

        vm.prank(BORROWER);
        uint256 price = _repayRepo(vault, BORROWER, ID);

        assertEq(price, expected);
        assertGt(price, principal, "interest accrued");
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.CLOSED));
        assertEq(holds.released(), 1, "collateral is released, not executed");
        assertEq(holds.executed(), 0);
        assertEq(vault.credit(LENDER), price);
    }

    function test_onlyTheBorrowerCloses() public {
        _open();
        vm.prank(LENDER);
        vm.expectRevert(RepoVaultBase.NotParty.selector);
        vault.close(ID);
    }

    // ------------------------------------------------------------------ T3

    /// @notice Row 14 as a test. The margin call is public; the mark is not.
    function test_marginCallDisclosesTheBooleanAndNotTheNumber() public {
        _open();
        bytes32 commitment = keccak256("mark: 995000");

        vm.recordLogs();
        vm.prank(ENGINE);
        vault.postMark(ID, commitment, true, 1 days);

        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.MARGIN_CALL));

        // Nothing in any emitted log is the mark. The commitment is, by
        // construction, and the state change is a single bit.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            for (uint256 j = 0; j < logs[i].topics.length; ++j) {
                assertTrue(uint256(logs[i].topics[j]) != 995_000, "mark leaked in a topic");
            }
            if (logs[i].data.length >= 32) {
                assertTrue(
                    abi.decode(logs[i].data, (uint256)) != 995_000, "mark leaked in data"
                );
            }
        }
    }

    function test_onlyTheEngineMarks() public {
        _open();
        vm.expectRevert(RepoVaultBase.NotMarginEngine.selector);
        vault.postMark(ID, bytes32(0), true, 1 days);
    }

    // ------------------------------------------------------------------ T4

    function test_cureReturnsToOpen() public {
        _open();
        vm.prank(ENGINE);
        vault.postMark(ID, bytes32(uint256(1)), true, 1 days);
        feed.setMark(DEFAULT_MARK_PER_UNIT);
        vm.prank(BORROWER);
        vault.cure(ID);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.OPEN));
    }

    function test_emptyCureIsRefusedWhileStillShort() public {
        _open();
        vm.prank(ENGINE);
        vault.postMark(ID, bytes32(uint256(1)), true, 1 days);
        feed.setMark(0);
        vm.prank(BORROWER);
        vm.expectRevert(RepoVaultBase.EmptyCure.selector);
        vault.cure(ID);
    }

    function test_cureAndNewCollateralStopAtThePublishedDeadline() public {
        _open();
        vm.prank(ENGINE);
        vault.postMark(ID, bytes32(uint256(1)), true, 1 days);
        uint64 deadline = vault.repo(ID).cureDeadline;
        vm.warp(deadline);
        feed.setMark(DEFAULT_MARK_PER_UNIT);

        vm.prank(BORROWER);
        vm.expectRevert(
            abi.encodeWithSelector(RepoVaultBase.CureWindowClosed.selector, deadline)
        );
        vault.cure(ID);

        vm.prank(BORROWER);
        vm.expectRevert(
            abi.encodeWithSelector(RepoVaultBase.CureWindowClosed.selector, deadline)
        );
        vault.addCollateral(ID, 1);
        assertEq(vault.extraHoldCount(ID), 0, "late collateral was not trapped");
    }

    function test_defaultIsPermissionlessButOnlyAfterTheWindow() public {
        _open();
        vm.prank(ENGINE);
        vault.postMark(ID, bytes32(uint256(1)), true, 1 days);

        vm.expectRevert(
            abi.encodeWithSelector(
                RepoVaultBase.CureWindowOpen.selector, uint64(block.timestamp + 1 days)
            )
        );
        vault.declareDefault(ID);

        vm.warp(block.timestamp + 1 days + 1);
        // Anyone. Not the lender, on purpose: a default only the lender can call is
        // a default the lender can decline to call.
        vm.prank(address(0xDEAD));
        vault.declareDefault(ID);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.DEFAULTED));
    }

    // ------------------------------------------------------------- T5 and T6

    /// @notice Hold custody leaves issuer income with the borrower, so observing
    ///         a coupon neither invents another payment nor blocks repayment.
    function test_couponObservationDoesNotInventAPaymentOrBlockTheClose() public {
        _open();
        _noteCoupon();
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.OPEN));

        _repayRepo(vault, BORROWER, ID);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.CLOSED));
    }

    function test_manufacturedPayThroughIsExplicitlyRefused() public {
        _open();
        _noteCoupon();
        vm.prank(LENDER);
        vm.expectRevert(RepoVaultBase.NoManufacturedPayment.selector);
        vault.payThrough(ID);
    }

    // ------------------------------------------------------------------ T7

    /// Refused, and refused loudly. A silent absence and a documented refusal read
    /// the same in a diff and differently to anyone deciding whether to trust the
    /// instrument.
    function test_substitutionIsRefusedNotMissing() public {
        vm.expectRevert(RepoVaultBase.SubstitutionRefused.selector);
        vault.substitute(ID);
    }

    // ------------------------------------------------------------------ T8

    function test_defaultSendsCollateralToTheLender() public {
        _open();
        vm.prank(ENGINE);
        vault.postMark(ID, bytes32(uint256(1)), true, 1 days);
        vm.warp(block.timestamp + 1 days + 1);
        vault.declareDefault(ID);

        vault.settleDefault(ID);
        assertEq(holds.lastExecutedTo(), LENDER);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.CLOSED));
    }

    function test_settleAuctionIsRefused() public {
        _open();
        vm.prank(ENGINE);
        vault.postMark(ID, bytes32(uint256(1)), true, 1 days);
        vm.warp(block.timestamp + 1 days + 1);
        vault.declareDefault(ID);

        vm.expectRevert(RepoVaultBase.AuctionNotSupported.selector);
        vault.settleAuction(ID, address(0xBAD), 0);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.DEFAULTED));
    }

    // ---------------------------------------------------------- the ceiling

    /// @notice The ceiling is per row now, and the rows genuinely differ.
    /// @dev The old version of this test asked one question of one constant, and
    ///      it passed while every `emit` in the contract ignored that constant.
    ///      A ceiling that is the same for the maturity date and for the position
    ///      size has to be set to whichever of the two is more permissive, so it
    ///      cannot refuse anything at all about the other.
    function test_theCeilingIsPerRowAndTheRowsDiffer() public view {
        // Row 7, asset reference data: exactly, at once.
        assertTrue(vault.wouldDisclose(7, L.G_EXACT, L.T_IMM), "row 7 admits exact now");
        // Row 14, position: a predicate at once, and nothing finer, ever.
        assertTrue(vault.wouldDisclose(14, L.G_PRED, L.T_IMM), "row 14 admits the predicate");
        assertFalse(vault.wouldDisclose(14, L.G_EXACT, L.T_IMM), "row 14 refuses the number");
        assertFalse(vault.wouldDisclose(14, L.G_BUCKET, L.T_EPOCH), "and refuses a band, ever");
        // Row 5, execution price. **This assertion was the opposite until
        // **, when the deployed set moved row 5 to `(exact, imm)`
        // alongside rows 3 and 4. Section 7.2 defers it fifteen minutes through
        // a first cell at `(exact, {cp,ven,reg}, imm)`, and that observer set
        // does not exist on a public ledger any more than `{ven}` does. The
        // vault still publishes no price, for the separate reason `close`
        // records: the repurchase price is computable from `repo(id)` at the
        // moment the repo opens, so deferring it defers nothing.
        assertTrue(vault.wouldDisclose(5, L.G_EXACT, L.T_IMM), "row 5 admits exact now");
        // A row with no published parameter discloses nothing. Fail closed.
        assertFalse(vault.wouldDisclose(1, L.G_PRED, L.T_NEVER), "unpublished row 1 is BOTTOM");
    }

    /// @notice A supervisor narrowing reaches inside the vault without the vault
    ///         trusting the operator, and it reaches the waived rows only.
    function test_aNarrowingPropagatesIntoTheVaultAndSparesTheUnwaivedRows() public {
        assertTrue(vault.wouldDisclose(14, L.G_PRED, L.T_IMM), "before");
        vm.prank(SUPERVISOR);
        regime.narrow(L.point(L.G_PRED, L.T_EOD), "supervisory restriction");
        assertFalse(vault.wouldDisclose(14, L.G_PRED, L.T_IMM), "row 14 is waived, so it moved");
        assertTrue(
            vault.wouldDisclose(7, L.G_EXACT, L.T_IMM), "row 7 is not waived, so it did not"
        );
    }

    function test_aNarrowedPublicationCeilingCannotBlockRepayment() public {
        _open();
        vm.prank(SUPERVISOR);
        regime.narrow(L.point(L.G_PRED, L.T_EOD), "defer position events");

        vm.recordLogs();
        _repayRepo(vault, BORROWER, ID);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.CLOSED));
        assertEq(holds.released(), 1, "the publication rule did not trap collateral");
        _assertNoEvent(logs, keccak256("Closed(bytes32)"));
    }

    function test_aNarrowedPublicationCeilingCannotBlockCure() public {
        _open();
        vm.prank(ENGINE);
        vault.postMark(ID, bytes32(uint256(1)), true, 1 days);
        feed.setMark(DEFAULT_MARK_PER_UNIT);
        vm.prank(SUPERVISOR);
        regime.narrow(L.point(L.G_PRED, L.T_EOD), "defer position events");

        vm.recordLogs();
        vm.prank(BORROWER);
        vault.cure(ID);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.OPEN));
        _assertNoEvent(logs, keccak256("Cured(bytes32)"));
    }

    function test_aNarrowedPublicationCeilingCannotBlockDefaultRecovery() public {
        _open();
        uint64 maturity = vault.repo(ID).maturity;
        vm.prank(SUPERVISOR);
        regime.narrow(L.point(L.G_PRED, L.T_EOD), "defer position events");

        vm.warp(maturity);
        vm.recordLogs();
        vault.markFailing(ID);
        vm.warp(uint256(maturity) + FAIL_GRACE + 1);
        vault.declareDefault(ID);
        vault.settleDefault(ID);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.CLOSED));
        assertEq(holds.lastExecutedTo(), LENDER, "the lender still receives the collateral");
        _assertNoEvent(logs, keccak256("Failing(bytes32,uint64)"));
        _assertNoEvent(logs, keccak256("Defaulted(bytes32)"));
        _assertNoEvent(logs, keccak256("Closed(bytes32)"));
    }

    /// @notice The coupon observation does not publish the position size.
    /// @dev A coupon amount is the coupon rate times the collateral lot, and the
    ///      rate is public instrument data, so the old `CouponObserved(id,
    ///      uint256)` divided out to the exact position. Row 14 puts that at
    ///      `(none, {}, never)`.
    ///
    ///      **The amount this test hunts for is derived now rather than
    ///      hard-coded**, which is the whole of what changed underneath it. It
    ///      used to look for 12,500 because a caller had handed 12,500 in; it
    ///      looks for whatever `noteCoupon` computed, because nobody hands
    ///      anything in any more. The claim is unchanged and it is now a claim
    ///      about a number the contract chose.
    function test_theCouponAmountIsNotInAnyLogOrInTheStruct() public {
        _open();
        feed.setTerms(100e8, REF_RATE_BPS);
        feed.setMark(1);
        vm.warp(couponSchedule.dateOf(COUPON_INDEX));

        vm.recordLogs();
        uint256 owed = vault.noteCoupon(ID, COUPON_INDEX);
        assertGt(owed, 0, "a coupon that accrued nothing would pass this test vacuously");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            for (uint256 j = 0; j < logs[i].topics.length; ++j) {
                assertTrue(uint256(logs[i].topics[j]) != owed, "amount leaked in a topic");
            }
            if (logs[i].data.length >= 32) {
                assertTrue(abi.decode(logs[i].data, (uint256)) != owed, "amount leaked in data");
            }
        }
        assertEq(
            vault.repo(ID).lastCouponCommitment,
            vault.commitmentOf(ID, COUPON_INDEX, owed),
            "the commitment, not the number"
        );
    }

    function _assertNoEvent(Vm.Log[] memory logs, bytes32 signature) private pure {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length != 0) {
                assertTrue(logs[i].topics[0] != signature, "forbidden venue event was emitted");
            }
        }
    }
}
