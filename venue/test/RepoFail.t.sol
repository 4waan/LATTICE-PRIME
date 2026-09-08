// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {RepoMath} from "../src/repo/RepoMath.sol";
import {RepoVault} from "../src/repo/RepoVault.sol";
import {RepoVaultBase} from "../src/repo/RepoVaultBase.sol";
import {MockHolds} from "./AtsHolds.sol";
import {PolicyFixture} from "./PolicyFixture.sol";
import {CouponFixture} from "./CouponFixture.sol";
import {StubOracle} from "./OracleFixture.sol";
import {RepoFunding, KycListStub} from "./RepoFunding.sol";

/// @title RepoFailTest
/// @notice A settlement fail is not a default, and before `FAILING` it was not
///         anything at all.
///
/// `maturity` was written by `open`, published by `Opened`, and never read
/// again. `close` had no maturity check, and the only route to `DEFAULTED` ran
/// through `MARGIN_CALL`, which needs the margin engine to post a breaching
/// mark. So a borrower who simply never closed left the repo `OPEN` for ever
/// and the lender had no remedy unless the collateral happened to move.
/// `test_theOldMachineHadNoRouteOutOfAFail` is that hole, written as the thing
/// that now works.
contract RepoFailTest is Test, PolicyFixture, CouponFixture, RepoFunding {
    /// @dev Dark by default, which is the venue this suite was written against:
    ///      `postMark` is reachable and `markToMarket` is not. See `OracleFixture`.
    StubOracle internal feed;

    /// @dev `markToMarket` raises a call with a published window rather than a
    ///      caller-chosen one, because it is permissionless. `postMark` still
    ///      takes its own, so nothing below had to change.
    uint64 internal constant CURE_WINDOW = 1 days;

    MockHolds internal holds;
    KycListStub internal eligibility;
    RepoVault internal vault;

    address internal constant BORROWER = address(0xB0B);
    address internal constant LENDER = address(0x1EAD);
    address internal constant ENGINE = address(0xE49);
    address internal constant PASSERBY = address(0xF00D);
    bytes32 internal constant ID = keccak256("repo-fail");
    bytes32 internal constant PARTITION = bytes32(uint256(1));

    /// @dev 0.10 bp a day, Article 7's rate for sovereign debt.
    uint256 internal constant RATE = 10;
    uint64 internal constant GRACE = 5 days;
    uint64 internal constant TERM = 30 days;

    uint64 internal openedAt;
    uint64 internal maturity;

    function setUp() public {
        feed = new StubOracle();
        holds = new MockHolds();
        eligibility = _newKycList();
        _deployPolicy(asDeployed());
        vault = new RepoVault(
            holds,
            ENGINE,
            feed,
            _deploySchedule(uint64(block.timestamp)),
            eligibility,
            params,
            RATE,
            GRACE,
            CURE_WINDOW
        );
        vm.warp(1_000_000);
    }

    function _terms() internal pure returns (RepoVault.Terms memory) {
        return RepoVault.Terms({
            partition: PARTITION,
            collateralAmount: 1_000e8,
            haircutBps: 200,
            maintenanceBps: 200,
            repoRateBps: 450,
            term: TERM
        });
    }

    function _open() internal returns (uint256 principal) {
        principal = _openRepo(vault, feed, LENDER, BORROWER, ID, _terms());
        openedAt = uint64(block.timestamp);
        maturity = openedAt + TERM;
    }

    /// @dev What was owed at the intended settlement date, which is the
    ///      reference value the penalty is charged on.
    function _owedAtMaturity(uint256 principal) internal view returns (uint256) {
        return RepoMath.repurchasePrice(principal, 450, openedAt, maturity);
    }

    // ------------------------------------------------------- the hole itself

    /// @notice The repo now has a route out of a fail, and had none before.
    function test_theOldMachineHadNoRouteOutOfAFail() public {
        _open();
        vm.warp(maturity + 1);

        // Nobody has posted a mark, so `MARGIN_CALL` was never entered and the
        // pre-`FAILING` machine had no transition available from here at all.
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.OPEN));

        vault.markFailing(ID);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.FAILING));

        vm.warp(maturity + GRACE);
        vault.declareDefault(ID);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.DEFAULTED));
    }

    /// @notice Anyone may record a fail, and the borrower cannot sit on it.
    /// @dev Sharper than `declareDefault`'s reason. The party who would decline
    ///      to record this fail is the one whose fail it is, because the grace
    ///      clock that ends in default starts here.
    function test_recordingAFailIsPermissionless() public {
        _open();
        vm.warp(maturity);
        vm.prank(PASSERBY);
        vault.markFailing(ID);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.FAILING));
    }

    function test_aRepoCannotFailBeforeItMatures() public {
        _open();
        vm.warp(maturity - 1);
        vm.expectRevert(abi.encodeWithSelector(RepoVaultBase.NotYetMature.selector, maturity));
        vault.markFailing(ID);
    }

    // ------------------------------------------------------------ the charge

    /// @notice **The penalty runs from maturity, not from the declaration.**
    /// @dev The property that makes the charge unavoidable. Key it off the
    ///      `FAILING` state and a borrower closes late without ever being
    ///      marked, which is a charge nobody triggers, which is no charge.
    function test_thePenaltyRunsFromMaturityAndNotFromTheDeclaration() public {
        uint256 principal = _open();
        vm.warp(maturity + 3 days);

        // Never marked. Still charged.
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.OPEN));

        uint256 expected = RepoMath.settlementPenalty(
            _owedAtMaturity(principal), RATE, maturity, block.timestamp
        );
        assertGt(expected, 0);
        assertEq(vault.settlementPenaltyNow(ID), expected);

        uint256 accrual = RepoMath.repurchasePrice(principal, 450, openedAt, block.timestamp);
        assertEq(_repayRepo(vault, BORROWER, ID), accrual + expected, "the accrual plus the penalty");
    }

    /// @notice A fail of any length costs a day.
    /// @dev Rounding up, for `RepoMath.accrued`'s reason and one more: a floor
    ///      makes twenty three hours free, which is a free option to settle a
    ///      day late, and pricing that option is the whole point.
    function test_aFailOfAnySizeCostsAWholeDay() public {
        uint256 principal = _open();
        uint256 owed = _owedAtMaturity(principal);

        vm.warp(maturity);
        assertEq(vault.settlementPenaltyNow(ID), 0, "on time is not a fail");

        vm.warp(maturity + 1);
        uint256 oneSecond = vault.settlementPenaltyNow(ID);
        vm.warp(maturity + 1 days);
        assertEq(
            vault.settlementPenaltyNow(ID), oneSecond, "one second and one day cost the same"
        );
        assertEq(oneSecond, RepoMath.settlementPenalty(owed, RATE, 0, 1 days));

        vm.warp(maturity + 1 days + 1);
        assertGt(vault.settlementPenaltyNow(ID), oneSecond, "and day two costs more");
    }

    function testFuzz_thePenaltyOnlyEverGrows(uint32 a, uint32 b) public {
        _open();
        uint64 x = maturity + uint64(bound(a, 0, 400 days));
        uint64 y = maturity + uint64(bound(b, 0, 400 days));
        if (x > y) (x, y) = (y, x);
        vm.warp(x);
        uint256 first = vault.settlementPenaltyNow(ID);
        vm.warp(y);
        assertGe(vault.settlementPenaltyNow(ID), first);
    }

    function testFuzz_failDaysRoundsUp(uint64 elapsed) public pure {
        elapsed = uint64(bound(elapsed, 0, 3650 days));
        uint256 d = RepoMath.failDays(0, elapsed);
        assertEq(d, elapsed == 0 ? 0 : (uint256(elapsed) - 1) / 1 days + 1);
        assertGe(d * 1 days, elapsed);
    }

    /// @notice Zero is a legal rate, and it is what a venue publishing no
    ///         penalty looks like. The rulebook then has to say so.
    function test_aZeroRateIsLegalAndCostsNothing() public {
        RepoVault free =
            new RepoVault(
                holds,
                ENGINE,
                feed,
                couponSchedule,
                eligibility,
                params,
                0,
                GRACE,
                CURE_WINDOW
            );
        _openRepo(free, feed, LENDER, BORROWER, ID, _terms());
        vm.warp(block.timestamp + TERM + 90 days);
        assertEq(free.settlementPenaltyNow(ID), 0);
    }

    function test_aRateAboveOneHundredPercentIsRefusedAtDeployment() public {
        uint256 tooBig = RepoMath.BP_HUNDREDTHS + 1;
        vm.expectRevert(abi.encodeWithSelector(RepoMath.PenaltyRateTooLarge.selector, tooBig));
        new RepoVault(
            holds,
            ENGINE,
            feed,
            couponSchedule,
            eligibility,
            params,
            tooBig,
            GRACE,
            CURE_WINDOW
        );
    }

    // ------------------------------------------------------ the grace and out

    /// @notice A failing repo can still settle. That is what makes it a fail.
    function test_aFailingRepoStillClosesAndTheCollateralGoesBack() public {
        uint256 principal = _open();
        vm.warp(maturity + 2 days);
        vault.markFailing(ID);

        uint256 expected = RepoMath.repurchasePrice(principal, 450, openedAt, block.timestamp)
            + RepoMath.settlementPenalty(
                _owedAtMaturity(principal), RATE, maturity, block.timestamp
            );

        assertEq(_repayRepo(vault, BORROWER, ID), expected);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.CLOSED));
        assertEq(holds.released(), 1, "the collateral still goes back");
        assertEq(holds.executed(), 0);
    }

    /// @notice Article 7's escalation follows the penalty rather than replacing
    ///         it, so the fail runs for the grace before it becomes a default.
    function test_theGraceRunsBeforeTheDefaultIsAvailable() public {
        _open();
        vm.warp(maturity + 1);
        vault.markFailing(ID);

        vm.expectRevert(
            abi.encodeWithSelector(RepoVaultBase.FailGraceOpen.selector, maturity + GRACE)
        );
        vault.declareDefault(ID);

        vm.warp(maturity + GRACE);
        vault.declareDefault(ID);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.DEFAULTED));
    }

    /// @notice The margin route to default is untouched by the new one.
    function test_theMarginCallRouteToDefaultStillWorks() public {
        _open();
        vm.prank(ENGINE);
        vault.postMark(ID, keccak256("mark"), true, 1 days);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.MARGIN_CALL));

        vm.warp(block.timestamp + 1 days);
        vault.declareDefault(ID);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.DEFAULTED));
    }

    /// @notice A margin call still cannot be defaulted inside its cure window.
    /// @dev The two clocks are separate, and reading the wrong one would let a
    ///      margin call default the instant the fail grace happened to pass.
    function test_theTwoClocksDoNotReadEachOther() public {
        _open();
        vm.warp(maturity + GRACE + 30 days);
        vm.prank(ENGINE);
        vault.postMark(ID, keccak256("mark"), true, 1 days);

        uint64 cure = uint64(block.timestamp) + 1 days;
        vm.expectRevert(abi.encodeWithSelector(RepoVaultBase.CureWindowOpen.selector, cure));
        vault.declareDefault(ID);
    }

    // ------------------------------------------------------- the disclosure

    /// @notice The fail is published and its amount is not.
    /// @dev Row 14, and the same reason `lastCouponCommitment` is a
    ///      commitment. The penalty is `value * rate * days` with rate and days
    ///      both public, so an amount in the event divides out to the position.
    function test_theFailIsPublishedWithoutItsAmount() public {
        _open();
        vm.warp(maturity + 4 days);

        vm.recordLogs();
        vault.markFailing(ID);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 sig = keccak256("Failing(bytes32,uint64)");
        uint256 seen;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] != sig) continue;
            seen++;
            assertEq(logs[i].topics[1], ID);
            assertEq(
                abi.decode(logs[i].data, (uint64)), maturity, "the date, published by Opened"
            );
            assertEq(logs[i].data.length, 32, "one field, and it is not an amount");
        }
        assertEq(seen, 1);
        assertGt(vault.settlementPenaltyNow(ID), 0, "while the charge itself is real");
    }
}
