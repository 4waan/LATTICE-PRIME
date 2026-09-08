// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IHederaScheduleService} from "../src/interfaces/IHederaScheduleService.sol";
import {RepoVault} from "../src/repo/RepoVault.sol";
import {ScheduledSettlement} from "../src/schedule/ScheduledSettlement.sol";
import {CouponFixture} from "./CouponFixture.sol";
import {StubOracle} from "./OracleFixture.sol";
import {PolicyFixture} from "./PolicyFixture.sol";
import {MockHolds} from "./AtsHolds.sol";
import {RepoFunding} from "./RepoFunding.sol";

contract HssSuccessMock is IHederaScheduleService {
    address internal constant CREATED = address(0x5CED);

    address public firstTarget;
    uint256 public firstExpiry;
    uint256 public firstGasLimit;
    uint64 public firstValue;
    bytes public firstCallData;
    uint256 public calls;

    function hasScheduleCapacity(uint256, uint256) external pure returns (bool) {
        return true;
    }

    function scheduleCall(
        address target,
        uint256 expiry,
        uint256 gasLimit,
        uint64 value,
        bytes memory callData
    ) external returns (int64 responseCode, address scheduleAddress) {
        if (calls == 0) {
            (
                firstTarget, firstExpiry, firstGasLimit, firstValue, firstCallData
            ) = (target, expiry, gasLimit, value, callData);
        }
        calls += 1;
        return (22, CREATED);
    }
}

contract HssFailureMock is IHederaScheduleService {
    function hasScheduleCapacity(uint256, uint256) external pure returns (bool) {
        return true;
    }

    function scheduleCall(address, uint256, uint256, uint64, bytes memory)
        external
        pure
        returns (int64 responseCode, address scheduleAddress)
    {
        return (370, address(0));
    }
}

contract HssZeroAddressMock is IHederaScheduleService {
    function hasScheduleCapacity(uint256, uint256) external pure returns (bool) {
        return true;
    }

    function scheduleCall(address, uint256, uint256, uint64, bytes memory)
        external
        pure
        returns (int64 responseCode, address scheduleAddress)
    {
        return (22, address(0));
    }
}

contract HssNoCapacityMock is IHederaScheduleService {
    function hasScheduleCapacity(uint256, uint256) external pure returns (bool) {
        return false;
    }

    function scheduleCall(address, uint256, uint256, uint64, bytes memory)
        external
        pure
        returns (int64, address)
    {
        revert("capacity probe was ignored");
    }
}

/// @notice HIP-1215 integration at the node-native `0x16b` address.
/// @dev `vm.etch` is deliberate. Hedera implements HSS in the node and reports
///      no EVM bytecode at the address, so a code-size mock would assert the
///      wrong availability rule. These mocks exercise the returned values that
///      the production integration actually validates.
contract ScheduledSettlementTest is Test, PolicyFixture, CouponFixture, RepoFunding {
    StubOracle internal feed;
    MockHolds internal holds;
    RepoVault internal vault;

    address internal constant BORROWER = address(0xB0B);
    address internal constant LENDER = address(0x1EAD);
    address internal constant ENGINE = address(0xE49);
    address internal constant PASSERBY = address(0xCA11E2);
    address internal constant CREATED_SCHEDULE = address(0x5CED);

    bytes32 internal constant ID = keccak256("scheduled-repo");
    bytes32 internal constant PARTITION = bytes32(uint256(1));

    uint64 internal constant TERM = 30 days;
    uint256 internal constant INSIDE_COUPONS = 4;
    bool internal restoreDarkAfterAccept;

    event Scheduled(bytes32 indexed id, address indexed scheduleAddress, uint64 dueAt);
    event Unscheduled(bytes32 indexed id, int64 reason);

    function setUp() public {
        vm.warp(1_000_000);
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
            10,
            5 days,
            1 days
        );
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

    function _fund() internal {
        restoreDarkAfterAccept = feed.stale();
        _fundRepo(vault, feed, LENDER, BORROWER, ID, _terms());
        holds.mint(PARTITION, BORROWER, _terms().collateralAmount);
        vm.prank(BORROWER);
        holds.approve(address(vault), _terms().collateralAmount);
    }

    function _accept() internal {
        vm.prank(BORROWER);
        vault.accept(ID);
        if (restoreDarkAfterAccept) feed.setDark(true);
    }

    function _open() internal {
        _fund();
        _accept();
    }

    function _install(address implementation) internal {
        vm.etch(vault.HSS(), implementation.code);
    }

    function _fundAllCalls() internal {
        vm.deal(address(vault), (INSIDE_COUPONS + 1) * vault.FUNDING_PER_CALL());
    }

    function test_successStoresEachScheduleAddressAndReservesItsFunding() public {
        HssSuccessMock hss = new HssSuccessMock();
        _install(address(hss));
        _fundAllCalls();

        uint64 maturity = uint64(block.timestamp) + TERM;
        bytes32 failId = vault.failObligation(ID);
        _fund();
        vm.expectEmit(true, true, false, true, address(vault));
        emit Scheduled(failId, CREATED_SCHEDULE, maturity);
        _accept();

        ScheduledSettlement.Obligation memory fail = vault.obligation(failId);
        assertEq(fail.scheduleAddress, CREATED_SCHEDULE);
        assertEq(fail.repoId, ID);
        assertEq(fail.dueAt, maturity);
        assertEq(uint8(fail.kind), uint8(ScheduledSettlement.Kind.FAIL));
        assertEq(uint8(fail.status), uint8(ScheduledSettlement.Status.PENDING));

        HssSuccessMock recorded = HssSuccessMock(vault.HSS());
        assertEq(recorded.firstTarget(), address(vault));
        assertEq(recorded.firstExpiry(), maturity);
        assertEq(recorded.firstGasLimit(), vault.SCHEDULE_GAS_LIMIT());
        assertEq(recorded.firstValue(), 0);
        assertEq(recorded.firstCallData(), abi.encodeCall(vault.settle, (failId)));

        for (uint256 i = 0; i < INSIDE_COUPONS; ++i) {
            ScheduledSettlement.Obligation memory coupon =
                vault.obligation(vault.couponObligation(ID, i));
            assertEq(coupon.scheduleAddress, CREATED_SCHEDULE);
            assertEq(coupon.index, i);
            assertEq(coupon.dueAt, couponSchedule.dateOf(i));
            assertEq(uint8(coupon.kind), uint8(ScheduledSettlement.Kind.COUPON));
        }

        assertEq(vault.reservedFunding(), (INSIDE_COUPONS + 1) * vault.FUNDING_PER_CALL());
        assertEq(vault.fundedFor(), 0, "all supplied funding is reserved");
        assertTrue(vault.fundedFor(failId));
    }

    function test_failureResponseIsRecordedAndTheFailCanStillSettle() public {
        HssFailureMock hss = new HssFailureMock();
        _install(address(hss));
        _fundAllCalls();

        bytes32 failId = vault.failObligation(ID);
        _fund();
        vm.expectEmit(true, false, false, true, address(vault));
        emit Unscheduled(failId, 370);
        _accept();

        assertEq(vault.obligation(failId).scheduleAddress, address(0));
        vm.warp(vault.repo(ID).maturity);
        vm.prank(PASSERBY);
        assertTrue(vault.settle(failId));
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.FAILING));
    }

    function test_absentServiceIsRecordedAndTheFailCanStillSettle() public {
        bytes32 failId = vault.failObligation(ID);
        _fund();
        vm.expectEmit(true, false, false, true, address(vault));
        emit Unscheduled(failId, vault.REASON_UNAVAILABLE());
        _accept();

        vm.warp(vault.repo(ID).maturity);
        vm.prank(PASSERBY);
        assertTrue(vault.settle(failId));
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.FAILING));
    }

    function test_successCodeWithoutScheduleAddressKeepsTheFallback() public {
        HssZeroAddressMock hss = new HssZeroAddressMock();
        _install(address(hss));
        _fundAllCalls();

        bytes32 failId = vault.failObligation(ID);
        _fund();
        vm.expectEmit(true, false, false, true, address(vault));
        emit Unscheduled(failId, vault.REASON_BAD_RESPONSE());
        _accept();

        assertEq(vault.obligation(failId).scheduleAddress, address(0));
        vm.warp(vault.repo(ID).maturity);
        vm.prank(PASSERBY);
        assertTrue(vault.settle(failId));
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.FAILING));
    }

    function test_capacityIsCheckedBeforeScheduleCall() public {
        HssNoCapacityMock hss = new HssNoCapacityMock();
        _install(address(hss));
        _fundAllCalls();

        bytes32 failId = vault.failObligation(ID);
        _fund();
        vm.expectEmit(true, false, false, true, address(vault));
        emit Unscheduled(failId, vault.REASON_NO_CAPACITY());
        _accept();

        assertEq(vault.obligation(failId).scheduleAddress, address(0));
        assertEq(vault.reservedFunding(), 0);
    }

    function test_unfundedCallIsRecordedAndKeepsItsFallback() public {
        HssSuccessMock hss = new HssSuccessMock();
        _install(address(hss));

        bytes32 failId = vault.failObligation(ID);
        _fund();
        vm.expectEmit(true, false, false, true, address(vault));
        emit Unscheduled(failId, vault.REASON_UNFUNDED());
        _accept();

        vm.warp(vault.repo(ID).maturity);
        vm.prank(PASSERBY);
        assertTrue(vault.settle(failId));
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.FAILING));
    }

    function test_maxCashLiabilityCannotMakeOptionalSchedulingOverflow() public {
        HssSuccessMock hss = new HssSuccessMock();
        _install(address(hss));

        RepoVault.Terms memory terms = _terms();
        terms.collateralAmount = 1;
        terms.haircutBps = 0;
        terms.repoRateBps = 0;
        feed.setMark(type(uint256).max);

        _fundRepo(vault, feed, LENDER, BORROWER, ID, terms);
        holds.mint(PARTITION, BORROWER, 1);
        vm.prank(BORROWER);
        holds.approve(address(vault), 1);
        vm.prank(BORROWER);
        vault.accept(ID);

        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.OPEN));
        assertEq(vault.cashReserved(), type(uint256).max);
        assertEq(vault.reservedFunding(), 0, "there is no unencumbered scheduler cash");
        assertEq(vault.fundedFor(), 0, "the total read remains defined at the bound");
    }

    function test_couponHasPermissionlessFallbackWhenHssIsAbsent() public {
        _open();
        feed.setTerms(100e8, 425);
        feed.setMark(1);

        bytes32 couponId = vault.couponObligation(ID, 0);
        vm.warp(couponSchedule.dateOf(0));
        vm.prank(PASSERBY);
        assertTrue(vault.settle(couponId));

        assertTrue(vault.notedCoupon(ID, 0));
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.OPEN));
        assertTrue(vault.repo(ID).lastCouponCommitment != bytes32(0));
        assertEq(
            uint8(vault.obligation(couponId).status), uint8(ScheduledSettlement.Status.SETTLED)
        );
    }

    function test_lateScheduledTargetsAreIdempotentAfterManualCalls() public {
        HssSuccessMock hss = new HssSuccessMock();
        _install(address(hss));
        _fundAllCalls();
        _open();

        feed.setTerms(100e8, 425);
        feed.setMark(1);
        bytes32 couponId = vault.couponObligation(ID, 0);
        vm.warp(couponSchedule.dateOf(0));
        vault.noteCoupon(ID, 0);
        assertTrue(vault.settle(couponId), "late coupon schedule is a no-op success");

        bytes32 failId = vault.failObligation(ID);
        vm.warp(vault.repo(ID).maturity);
        vault.markFailing(ID);
        vault.markFailing(ID);
        assertTrue(vault.settle(failId), "late fail schedule is a no-op success");
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.FAILING));
        assertFalse(vault.fundedFor(failId), "settled reserve is released");
    }

    function test_failScheduleSettlesWhenTheMarginClockAlreadyControlsDefault() public {
        _open();
        vm.prank(ENGINE);
        vault.postMark(ID, keccak256("short"), true, 1 days);

        bytes32 failId = vault.failObligation(ID);
        vm.warp(vault.repo(ID).maturity);
        assertTrue(vault.settle(failId));

        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.MARGIN_CALL));
        assertEq(
            uint8(vault.obligation(failId).status),
            uint8(ScheduledSettlement.Status.SETTLED)
        );
    }

    function test_delayedCouponObservationDoesNotDisplaceAFailingRepo() public {
        _open();
        feed.setTerms(100e8, 425);
        feed.setMark(1);
        vm.warp(vault.repo(ID).maturity);
        vault.markFailing(ID);

        uint256 index = INSIDE_COUPONS - 1;
        bytes32 couponId = vault.couponObligation(ID, index);
        assertTrue(vault.settle(couponId));

        assertTrue(vault.notedCoupon(ID, index));
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.FAILING));
    }

    function test_manualFallbackCannotRunBeforeDueTime() public {
        _open();
        bytes32 failId = vault.failObligation(ID);
        uint64 maturity = vault.repo(ID).maturity;

        vm.expectRevert(
            abi.encodeWithSelector(
                ScheduledSettlement.SettlementNotDue.selector, failId, maturity
            )
        );
        vault.settle(failId);
    }
}
