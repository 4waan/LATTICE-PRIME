// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {RepoMath} from "../src/repo/RepoMath.sol";
import {RepoVault} from "../src/repo/RepoVault.sol";
import {RepoVaultBase} from "../src/repo/RepoVaultBase.sol";
import {PolicyFixture} from "./PolicyFixture.sol";
import {CouponFixture} from "./CouponFixture.sol";
import {StubOracle} from "./OracleFixture.sol";
import {AtsHolds} from "./AtsHolds.sol";
import {RepoFunding, KycListStub} from "./RepoFunding.sol";

/// @notice Cash conservation, ATS hold rules, and the four financing defects.
/// @dev Expected principal and repurchase figures are the Python oracle in
///      `probes/repo-cash.py`, not a second copy of `RepoMath`.
contract RepoCashTest is Test, PolicyFixture, CouponFixture, RepoFunding {
    uint64 internal constant CURE_WINDOW = 1 days;
    uint256 internal constant PENALTY_RATE = 10;
    uint64 internal constant FAIL_GRACE = 5 days;
    uint256 internal constant LOT = 1_000;
    uint256 internal constant MARK_PER = 1_000;
    uint16 internal constant HAIRCUT = 200;

    /// Independent of RepoMath: `probes/repo-cash.py` for lot=1000, mark=1000,
    /// haircut=200, rate=450, 30 days. purchase = 980000; repurchase = 983625.
    uint256 internal constant ORACLE_PRINCIPAL = 980_000;
    uint256 internal constant ORACLE_REPAY_30D = 983_625;

    AtsHolds internal holds;
    StubOracle internal feed;
    KycListStub internal registry;
    RepoVault internal vault;

    address internal constant BORROWER = address(0xB0B);
    address internal constant LENDER = address(0x1EAD);
    address internal constant ENGINE = address(0xE49);
    bytes32 internal constant ID = keccak256("cash-1");
    bytes32 internal constant PARTITION = bytes32(uint256(1));

    function setUp() public {
        feed = new StubOracle();
        holds = new AtsHolds();
        registry = _newKycList();
        _deployPolicy(asDeployed());
        vault = new RepoVault(
            holds,
            ENGINE,
            feed,
            _deploySchedule(uint64(block.timestamp)),
            registry,
            params,
            PENALTY_RATE,
            FAIL_GRACE,
            CURE_WINDOW
        );
        feed.setTerms(100e8, 425);
        feed.setMark(MARK_PER);
        holds.mint(PARTITION, BORROWER, LOT);
        vm.prank(BORROWER);
        holds.approve(address(vault), LOT);
    }

    function _terms() internal pure returns (RepoVault.Terms memory) {
        return RepoVault.Terms({
            partition: PARTITION,
            collateralAmount: LOT,
            haircutBps: HAIRCUT,
            maintenanceBps: 200,
            repoRateBps: 450,
            term: 30 days
        });
    }

    function test_cashlessOpenIsRefused() public {
        vm.prank(BORROWER);
        vm.expectRevert(RepoVaultBase.UseFundedOffer.selector);
        vault.open(ID, LENDER, _terms());
    }

    function test_principalMatchesIndependentOracle() public {
        uint256 principal = vault.quotePrincipal(_terms());
        assertEq(principal, ORACLE_PRINCIPAL);
        assertEq(
            principal,
            RepoMath.purchasePrice(MARK_PER * LOT, HAIRCUT),
            "Solidity and the Python oracle must agree"
        );
    }

    function test_fundedOfferPublishesAPredicateNotExactEconomics() public {
        vm.deal(LENDER, ORACLE_PRINCIPAL);
        vm.recordLogs();
        vm.prank(LENDER);
        vault.fundOffer{value: ORACLE_PRINCIPAL}(
            ID, BORROWER, _terms(), uint64(block.timestamp + 7 days)
        );

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 signature = keccak256("OfferFunded(bytes32)");
        bool sawPredicate;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length == 0 || logs[i].topics[0] != signature) continue;
            sawPredicate = true;
            assertEq(logs[i].topics.length, 2, "only the signature and offer reference");
            assertEq(logs[i].topics[1], ID);
            assertEq(logs[i].data.length, 0, "no lender, principal, or expiry in venue data");
        }
        assertTrue(sawPredicate, "the afforded predicate is still receipted");
        assertEq(
            vault.spentBits(14, params.currentEpoch()),
            1,
            "funding consumes the position-publication budget"
        );
    }

    function test_aFundedOfferCannotAdvanceZeroCash() public {
        RepoVault.Terms memory dust = _terms();
        dust.collateralAmount = 1;
        dust.haircutBps = 9_999;
        assertEq(vault.quotePrincipal(dust), 0, "fixture must round to zero");

        vm.prank(LENDER);
        vm.expectRevert(RepoVaultBase.ZeroAmount.selector);
        vault.fundOffer(ID, BORROWER, dust, uint64(block.timestamp + 1 hours));
    }

    function test_repoRateAboveOneHundredPercentIsRefusedBeforeFunding() public {
        RepoVault.Terms memory terms = _terms();
        terms.repoRateBps = 10_001;
        vm.prank(LENDER);
        vm.expectRevert(
            abi.encodeWithSelector(RepoMath.RepoRateTooLarge.selector, uint256(10_001))
        );
        vault.fundOffer(ID, BORROWER, terms, uint64(block.timestamp + 1 hours));
    }

    function test_defaultGraceMustFitAfterTheOfferedMaturity() public {
        RepoVault.Terms memory terms = _terms();
        terms.term = uint64(
            uint256(type(uint64).max) - block.timestamp - uint256(FAIL_GRACE) + 1
        );

        vm.prank(LENDER);
        vm.expectRevert(RepoVaultBase.MaturityOverflow.selector);
        vault.fundOffer(ID, BORROWER, terms, uint64(block.timestamp + 1 hours));
    }

    function test_acceptRechecksThatDefaultGraceStillFits() public {
        RepoVault.Terms memory terms = _terms();
        terms.term =
            uint64(uint256(type(uint64).max) - block.timestamp - uint256(FAIL_GRACE));
        _fundRepo(vault, feed, LENDER, BORROWER, ID, terms);

        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        vm.expectRevert(RepoVaultBase.MaturityOverflow.selector);
        vault.accept(ID);
    }

    function test_quoteUsesFullPrecisionBeforeApplyingTheHaircut() public {
        RepoVault.Terms memory terms = _terms();
        terms.collateralAmount = 1;
        terms.haircutBps = 5_000;
        feed.setMark(type(uint256).max);
        assertEq(vault.quotePrincipal(terms), type(uint256).max / 2);
    }

    function test_anOfferWhoseContractedRepaymentCannotFitIsRefused() public {
        RepoVault.Terms memory terms = _terms();
        terms.collateralAmount = 1;
        terms.haircutBps = 0;
        terms.repoRateBps = 1;
        terms.term = 1;
        feed.setMark(type(uint256).max);

        vm.prank(LENDER);
        vm.expectRevert(RepoMath.MulDivOverflow.selector);
        vault.fundOffer(ID, BORROWER, terms, uint64(block.timestamp + 1 hours));
    }

    function test_fundAcceptWithdrawCloseWithdrawConservesHbar() public {
        uint256 principal = ORACLE_PRINCIPAL;
        vm.deal(LENDER, principal);
        uint256 lenderBefore = LENDER.balance;
        uint256 borrowerBefore = BORROWER.balance;

        vm.prank(LENDER);
        vault.fundOffer{value: principal}(
            ID, BORROWER, _terms(), uint64(block.timestamp + 7 days)
        );
        assertEq(LENDER.balance, lenderBefore - principal);
        assertEq(address(vault).balance, principal);
        assertEq(vault.cashReserved(), principal);

        vm.prank(BORROWER);
        vault.accept(ID);
        assertEq(holds.lastHoldTo(), address(0));
        assertEq(vault.credit(BORROWER), principal);
        assertEq(holds.created(), 1);
        assertEq(holds.balanceOfByPartition(PARTITION, BORROWER), 0);
        assertEq(holds.allowance(BORROWER, address(vault)), 0, "ATS consumed the allowance");

        vm.prank(BORROWER);
        vault.withdraw();
        assertEq(BORROWER.balance, borrowerBefore + principal);
        assertEq(vault.credit(BORROWER), 0);

        vm.warp(block.timestamp + 30 days);
        uint256 repay = vault.repurchasePriceNow(ID) + vault.settlementPenaltyNow(ID);
        assertEq(repay, ORACLE_REPAY_30D, "independent oracle, 30 day ACT/365 round-up");

        vm.deal(BORROWER, repay);
        uint256 borrowerMid = BORROWER.balance;
        vm.prank(BORROWER);
        vault.close{value: repay}(ID);

        assertEq(BORROWER.balance, borrowerMid - repay);
        assertEq(holds.released(), 1);
        assertEq(holds.executed(), 0);
        assertEq(holds.balanceOfByPartition(PARTITION, BORROWER), LOT);
        assertEq(
            holds.allowance(BORROWER, address(vault)),
            LOT,
            "ATS restores authorized allowance on release"
        );
        assertEq(vault.credit(LENDER), repay);

        vm.prank(LENDER);
        vault.withdraw();
        assertEq(LENDER.balance, lenderBefore - principal + repay);
        assertEq(address(vault).balance, 0);
        assertEq(vault.cashReserved(), 0);
    }

    function test_immediateClosePaysTheLendersContractedTerm() public {
        vm.deal(LENDER, ORACLE_PRINCIPAL);
        vm.prank(LENDER);
        vault.fundOffer{value: ORACLE_PRINCIPAL}(
            ID, BORROWER, _terms(), uint64(block.timestamp + 7 days)
        );
        vm.prank(BORROWER);
        vault.accept(ID);

        assertEq(vault.exposureNow(ID), ORACLE_PRINCIPAL, "no time has accrued for margin");
        assertEq(
            vault.repurchasePriceNow(ID),
            ORACLE_REPAY_30D,
            "early exit still honours the thirty-day price"
        );
        assertEq(_repayRepo(vault, BORROWER, ID), ORACLE_REPAY_30D);
        assertEq(vault.credit(LENDER), ORACLE_REPAY_30D);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.CLOSED));
    }

    function test_aTerminalRepoDoesNotQuoteAPayableExit() public {
        vm.deal(LENDER, ORACLE_PRINCIPAL);
        vm.prank(LENDER);
        vault.fundOffer{value: ORACLE_PRINCIPAL}(
            ID, BORROWER, _terms(), uint64(block.timestamp + 7 days)
        );
        vm.prank(BORROWER);
        vault.accept(ID);
        _repayRepo(vault, BORROWER, ID);

        bytes memory terminal = abi.encodeWithSelector(
            RepoVault.WrongState.selector, RepoVault.State.CLOSED, RepoVault.State.OPEN
        );
        vm.expectRevert(terminal);
        vault.repurchasePriceNow(ID);
        vm.expectRevert(terminal);
        vault.exposureNow(ID);
        vm.expectRevert(terminal);
        vault.settlementPenaltyNow(ID);
    }

    function test_injectedHoldFailureRollsBackTheCash() public {
        uint256 principal = ORACLE_PRINCIPAL;
        vm.deal(LENDER, principal);
        vm.prank(LENDER);
        vault.fundOffer{value: principal}(
            ID, BORROWER, _terms(), uint64(block.timestamp + 7 days)
        );

        holds.setRevertNextCreate(true);
        vm.prank(BORROWER);
        vm.expectRevert(AtsHolds.InjectedHoldFailure.selector);
        vault.accept(ID);

        assertEq(vault.credit(BORROWER), 0);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.NONE));
        assertEq(address(vault).balance, principal);
        assertEq(vault.cashReserved(), principal);
        assertEq(holds.balanceOfByPartition(PARTITION, BORROWER), LOT);
        assertEq(holds.allowance(BORROWER, address(vault)), LOT);
    }

    function test_acceptRequiresTheAtsAllowanceTheLiveTokenConsumes() public {
        uint256 principal = ORACLE_PRINCIPAL;
        vm.deal(LENDER, principal);
        vm.prank(LENDER);
        vault.fundOffer{value: principal}(
            ID, BORROWER, _terms(), uint64(block.timestamp + 7 days)
        );

        vm.prank(BORROWER);
        holds.approve(address(vault), 0);
        vm.prank(BORROWER);
        vm.expectRevert(
            abi.encodeWithSelector(AtsHolds.InsufficientAllowance.selector, 0, LOT)
        );
        vault.accept(ID);

        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.NONE));
        (,,, uint256 stillFunded,) = vault.offers(ID);
        assertEq(stillFunded, principal, "failed accept leaves lender offer funded");
        assertEq(vault.cashReserved(), principal);
    }

    function test_fundedOfferRequiresBothPartiesToBeCurrentlyEligible() public {
        vm.deal(LENDER, ORACLE_PRINCIPAL);

        registry.setEligible(BORROWER, false);
        vm.prank(LENDER);
        vm.expectRevert(
            abi.encodeWithSelector(RepoVaultBase.NotEligible.selector, BORROWER)
        );
        vault.fundOffer{value: ORACLE_PRINCIPAL}(
            ID, BORROWER, _terms(), uint64(block.timestamp + 7 days)
        );

        registry.setEligible(BORROWER, true);
        registry.setEligible(LENDER, false);
        vm.prank(LENDER);
        vm.expectRevert(
            abi.encodeWithSelector(RepoVaultBase.NotEligible.selector, LENDER)
        );
        vault.fundOffer{value: ORACLE_PRINCIPAL}(
            ID, BORROWER, _terms(), uint64(block.timestamp + 7 days)
        );

        assertEq(vault.cashReserved(), 0);
        assertEq(LENDER.balance, ORACLE_PRINCIPAL, "a rejected offer returns the value");
    }

    function test_expiredEligibilityCannotBypassTheBrowserAtAcceptance() public {
        vm.deal(LENDER, ORACLE_PRINCIPAL);
        vm.prank(LENDER);
        vault.fundOffer{value: ORACLE_PRINCIPAL}(
            ID, BORROWER, _terms(), uint64(block.timestamp + 7 days)
        );
        registry.setEligible(BORROWER, false);

        vm.prank(BORROWER);
        vm.expectRevert(
            abi.encodeWithSelector(RepoVaultBase.NotEligible.selector, BORROWER)
        );
        vault.accept(ID);

        (,,, uint256 stillFunded,) = vault.offers(ID);
        assertEq(stillFunded, ORACLE_PRINCIPAL, "the lender can still cancel or await renewal");
        assertEq(holds.created(), 0, "no collateral moved under an expired grant");
    }

    function test_onlyTheLendersNamedBorrowerCanAccept() public {
        uint256 principal = ORACLE_PRINCIPAL;
        address stranger = address(0xBAD);
        vm.deal(LENDER, principal);
        vm.prank(LENDER);
        vault.fundOffer{value: principal}(
            ID, BORROWER, _terms(), uint64(block.timestamp + 7 days)
        );

        vm.prank(stranger);
        vm.expectRevert(RepoVaultBase.NotParty.selector);
        vault.accept(ID);

        (address lender, address borrower,, uint256 stillFunded,) = vault.offers(ID);
        assertEq(lender, LENDER);
        assertEq(borrower, BORROWER);
        assertEq(stillFunded, principal, "front run leaves the named offer intact");
    }

    function test_offerExpiresAtItsPublishedBoundary() public {
        uint256 principal = ORACLE_PRINCIPAL;
        uint64 expiresAt = uint64(block.timestamp + 1 hours);
        vm.deal(LENDER, principal);
        vm.prank(LENDER);
        vault.fundOffer{value: principal}(ID, BORROWER, _terms(), expiresAt);

        vm.warp(expiresAt);
        vm.prank(BORROWER);
        vm.expectRevert(
            abi.encodeWithSelector(RepoVaultBase.OfferExpired.selector, expiresAt)
        );
        vault.accept(ID);
    }

    function test_wrongDestinationWouldRevertOnRealAts() public {
        uint256 principal = ORACLE_PRINCIPAL;
        vm.deal(LENDER, principal);
        vm.prank(LENDER);
        vault.fundOffer{value: principal}(
            ID, BORROWER, _terms(), uint64(block.timestamp + 7 days)
        );
        vm.prank(BORROWER);
        vault.accept(ID);
        assertEq(holds.lastHoldTo(), address(0));
        vm.warp(block.timestamp + 1 days);
        uint256 repay = vault.repurchasePriceNow(ID);
        vm.deal(BORROWER, repay);
        vm.prank(BORROWER);
        vault.close{value: repay}(ID);
        assertEq(holds.executed(), 0);
        assertEq(holds.released(), 1);
    }

    function test_keeperDelayCannotExpireTheLendersCollateralRemedy() public {
        uint256 principal = ORACLE_PRINCIPAL;
        vm.deal(LENDER, principal);
        vm.prank(LENDER);
        vault.fundOffer{value: principal}(
            ID, BORROWER, _terms(), uint64(block.timestamp + 7 days)
        );
        vm.prank(BORROWER);
        vault.accept(ID);

        assertEq(holds.lastHoldExpiry(), vault.HOLD_EXPIRY(), "hold resolves with the repo");
        vm.warp(block.timestamp + 30 days + FAIL_GRACE + 365 days);
        vault.markFailing(ID);
        vault.declareDefault(ID);
        vault.settleDefault(ID);

        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.CLOSED));
        assertEq(holds.delivered(LENDER), LOT, "late keeper still enforces collateral");
    }

    function test_cancelOfferCreditsTheLender() public {
        uint256 principal = ORACLE_PRINCIPAL;
        vm.deal(LENDER, principal);
        vm.prank(LENDER);
        vault.fundOffer{value: principal}(
            ID, BORROWER, _terms(), uint64(block.timestamp + 7 days)
        );
        vm.prank(LENDER);
        vault.cancelOffer(ID);
        assertEq(vault.credit(LENDER), principal);
        vm.prank(LENDER);
        vault.withdraw();
        assertEq(LENDER.balance, principal);
    }

    function test_movedMarkRefusesAccept() public {
        uint256 principal = ORACLE_PRINCIPAL;
        vm.deal(LENDER, principal);
        vm.prank(LENDER);
        vault.fundOffer{value: principal}(
            ID, BORROWER, _terms(), uint64(block.timestamp + 7 days)
        );
        feed.setMark(MARK_PER + 1);
        vm.prank(BORROWER);
        vm.expectRevert();
        vault.accept(ID);
    }

    function test_emptyCureRefusesWithoutCoverage() public {
        uint256 principal = ORACLE_PRINCIPAL;
        vm.deal(LENDER, principal);
        vm.prank(LENDER);
        vault.fundOffer{value: principal}(
            ID, BORROWER, _terms(), uint64(block.timestamp + 7 days)
        );
        vm.prank(BORROWER);
        vault.accept(ID);
        feed.setDark(true);
        vm.prank(ENGINE);
        vault.postMark(ID, bytes32(uint256(1)), true, 1 days);
        feed.setMark(0);
        vm.prank(BORROWER);
        vm.expectRevert(RepoVaultBase.EmptyCure.selector);
        vault.cure(ID);
    }

    function test_fullRepaymentClosesDuringAMarginCall() public {
        uint256 principal = ORACLE_PRINCIPAL;
        vm.deal(LENDER, principal);
        vm.prank(LENDER);
        vault.fundOffer{value: principal}(
            ID, BORROWER, _terms(), uint64(block.timestamp + 7 days)
        );
        vm.prank(BORROWER);
        vault.accept(ID);

        feed.setDark(true);
        vm.prank(ENGINE);
        vault.postMark(ID, bytes32(uint256(1)), true, 1 days);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.MARGIN_CALL));

        _repayRepo(vault, BORROWER, ID);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.CLOSED));
        assertEq(holds.released(), 1, "repayment remains an exit while called");
    }

    function test_defaultExecutesToLender() public {
        uint256 principal = ORACLE_PRINCIPAL;
        vm.deal(LENDER, principal);
        vm.prank(LENDER);
        vault.fundOffer{value: principal}(
            ID, BORROWER, _terms(), uint64(block.timestamp + 7 days)
        );
        vm.prank(BORROWER);
        vault.accept(ID);
        feed.setDark(true);
        vm.prank(ENGINE);
        vault.postMark(ID, bytes32(uint256(1)), true, 1 days);
        vm.warp(block.timestamp + 1 days + 1);
        vault.declareDefault(ID);
        vault.settleDefault(ID);
        assertEq(holds.lastExecutedTo(), LENDER);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.CLOSED));
        assertEq(
            holds.allowance(BORROWER, address(vault)),
            0,
            "executed collateral does not restore borrower allowance"
        );
    }

    function test_defaultRecoveryWaitsForLenderRenewalAndCanBeRetried() public {
        vm.deal(LENDER, ORACLE_PRINCIPAL);
        vm.prank(LENDER);
        vault.fundOffer{value: ORACLE_PRINCIPAL}(
            ID, BORROWER, _terms(), uint64(block.timestamp + 7 days)
        );
        vm.prank(BORROWER);
        vault.accept(ID);
        feed.setDark(true);
        vm.prank(ENGINE);
        vault.postMark(ID, bytes32(uint256(1)), true, 1 days);
        vm.warp(block.timestamp + 1 days + 1);
        vault.declareDefault(ID);

        registry.setEligible(LENDER, false);
        holds.setRecipientEligible(LENDER, false);
        vm.expectRevert(
            abi.encodeWithSelector(RepoVaultBase.NotEligible.selector, LENDER)
        );
        vault.settleDefault(ID);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.DEFAULTED));

        registry.setEligible(LENDER, true);
        vm.expectRevert(
            abi.encodeWithSelector(AtsHolds.RecipientNotEligible.selector, LENDER)
        );
        vault.settleDefault(ID);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.DEFAULTED));

        holds.setRecipientEligible(LENDER, true);
        vault.settleDefault(ID);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.CLOSED));
        assertEq(holds.delivered(LENDER), LOT);
    }
}
