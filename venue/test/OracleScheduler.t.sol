// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IOracleSchedulerTarget, OracleScheduler} from "../src/oracle/OracleScheduler.sol";
import {IHederaScheduleService} from "../src/interfaces/IHederaScheduleService.sol";

contract OracleTargetMock is IOracleSchedulerTarget {
    uint64 public round = 3;
    uint8 public override quorum = 2;
    uint256 public finalizations;
    bool public failFinalize;
    bool public advanceAfterFinalize = true;
    Answer[] private _answers;

    function setAnswers(uint256 count) external {
        delete _answers;
        for (uint256 i; i < count; ++i) {
            _answers.push(
                Answer({price: uint128(100e8 + i), rate: 364, by: address(uint160(i + 1))})
            );
        }
    }

    function setFailFinalize(bool value) external {
        failFinalize = value;
    }

    function setAdvanceAfterFinalize(bool value) external {
        advanceAfterFinalize = value;
    }

    function advanceRound() external {
        ++round;
        delete _answers;
    }

    function openRound() external view returns (uint64) {
        return round;
    }

    function panelOf(uint64 requested) external view returns (Answer[] memory) {
        require(requested == round, "wrong round");
        return _answers;
    }

    function finalize(uint64 requested) external returns (uint128 price, uint64 rate) {
        require(!failFinalize, "finalize refused");
        require(requested == round, "wrong round");
        ++finalizations;
        if (advanceAfterFinalize) ++round;
        return (100e8, 364);
    }
}

contract HssSuccessMock is IHederaScheduleService {
    function hasScheduleCapacity(uint256, uint256) external pure returns (bool) {
        return true;
    }

    function scheduleCall(address, uint256, uint256, uint64, bytes memory)
        external
        pure
        returns (int64 responseCode, address scheduleAddress)
    {
        return (22, address(0x1234));
    }
}

contract HssNoCapacityOracleMock is IHederaScheduleService {
    function hasScheduleCapacity(uint256, uint256) external pure returns (bool) {
        return false;
    }

    function scheduleCall(address, uint256, uint256, uint64, bytes memory)
        external
        pure
        returns (int64, address)
    {
        revert("capacity was ignored");
    }
}

contract HssBadScheduleResponseMock {
    function hasScheduleCapacity(uint256, uint256) external pure returns (bool) {
        return true;
    }

    function scheduleCall(address, uint256, uint256, uint64, bytes memory)
        external
        pure
        returns (bytes32)
    {
        return bytes32(uint256(22));
    }
}

contract HssRejectedScheduleMock is IHederaScheduleService {
    function hasScheduleCapacity(uint256, uint256) external pure returns (bool) {
        return true;
    }

    function scheduleCall(address, uint256, uint256, uint64, bytes memory)
        external
        pure
        returns (int64, address)
    {
        return (9, address(0));
    }
}

contract HssRevertingScheduleMock is IHederaScheduleService {
    function hasScheduleCapacity(uint256, uint256) external pure returns (bool) {
        return true;
    }

    function scheduleCall(address, uint256, uint256, uint64, bytes memory)
        external
        pure
        returns (int64, address)
    {
        revert("schedule unavailable");
    }
}

contract OracleSchedulerTest is Test {
    event CheckUnscheduled(uint64 indexed dueAt, int64 reason);

    OracleTargetMock private target;
    OracleScheduler private scheduler;

    function setUp() public {
        target = new OracleTargetMock();
        scheduler = new OracleScheduler(target, 90);
        HssSuccessMock hss = new HssSuccessMock();
        vm.etch(scheduler.HSS(), address(hss).code);
        vm.deal(address(scheduler), 100 * 1e8);
    }

    function test_emptyRoundCannotBeArmedToDrainFees() public {
        assertFalse(scheduler.arm());
        assertEq(scheduler.activeSchedule(), address(0));
        assertEq(scheduler.checksThisRound(), 0);
    }

    function test_armIsIdempotentWhileOneCheckIsActive() public {
        target.setAnswers(1);
        uint256 armedAt = block.timestamp;
        assertTrue(scheduler.arm());
        assertEq(scheduler.nextCheckAt(), armedAt + 90);
        uint64 dueAt = scheduler.nextCheckAt();
        assertTrue(scheduler.arm());
        assertEq(scheduler.nextCheckAt(), dueAt);
        assertEq(scheduler.activeSchedule(), address(0x1234));
    }

    function test_armRepairsAConsumedScheduleThatNeverUpdatedState() public {
        target.setAnswers(1);
        assertTrue(scheduler.arm());
        uint64 firstDueAt = scheduler.nextCheckAt();
        vm.warp(firstDueAt + scheduler.SCHEDULE_LATE_GRACE() + 1);
        assertTrue(scheduler.arm());
        assertGt(scheduler.nextCheckAt(), firstDueAt);
        assertEq(scheduler.checksThisRound(), 2);
    }

    function test_tickDoesNotFinalizeBeforeQuorumAndKeepsScheduling() public {
        target.setAnswers(1);
        scheduler.arm();
        vm.warp(scheduler.nextCheckAt());
        (bool finalized, bool scheduled) = scheduler.tick();
        assertFalse(finalized);
        assertTrue(scheduled);
        assertEq(target.finalizations(), 0);
        assertEq(scheduler.lastCheckedRound(), 3);
        assertEq(scheduler.activeSchedule(), address(0x1234));
    }

    function test_tickFinalizesAtQuorumAndStopsScheduling() public {
        target.setAnswers(2);
        scheduler.arm();
        vm.warp(scheduler.nextCheckAt());
        vm.prank(address(0xCAFE));
        (bool finalized, bool scheduled) = scheduler.tick();
        assertTrue(finalized);
        assertFalse(scheduled);
        assertEq(target.finalizations(), 1);
        assertEq(scheduler.lastFinalizedRound(), 3);
        assertEq(scheduler.activeSchedule(), address(0));
        assertEq(scheduler.nextCheckAt(), 0);
    }

    function test_successfulFinalizationPermanentlyStopsThatRound() public {
        target.setAdvanceAfterFinalize(false);
        target.setAnswers(2);
        scheduler.arm();
        vm.warp(scheduler.nextCheckAt());
        (bool finalized,) = scheduler.tick();
        assertTrue(finalized);

        assertFalse(scheduler.arm());
        (finalized,) = scheduler.tick();
        assertFalse(finalized);
        assertEq(target.finalizations(), 1);
        assertTrue(scheduler.isFinalizedRound(3));
    }

    function test_failedFinalizeUsesBoundedRetry() public {
        target.setAnswers(2);
        target.setFailFinalize(true);
        scheduler.arm();
        vm.warp(scheduler.nextCheckAt());
        (bool finalized, bool scheduled) = scheduler.tick();
        assertFalse(finalized);
        assertTrue(scheduled);
        assertEq(target.finalizations(), 0);
        assertEq(scheduler.activeSchedule(), address(0x1234));
    }

    function test_noCapacityLeavesPermissionlessManualTickAvailable() public {
        HssNoCapacityOracleMock hss = new HssNoCapacityOracleMock();
        vm.etch(scheduler.HSS(), address(hss).code);
        target.setAnswers(2);
        (bool finalized, bool scheduled) = scheduler.tick();
        assertTrue(finalized);
        assertFalse(scheduled);
        assertEq(target.finalizations(), 1);
        assertEq(scheduler.activeSchedule(), address(0));
    }

    function test_unfundedAttemptConsumesRoundBudget() public {
        target.setAnswers(1);
        vm.deal(address(scheduler), scheduler.MIN_BALANCE_TINYBAR() - 1);

        vm.expectEmit(true, false, false, true, address(scheduler));
        emit CheckUnscheduled(uint64(block.timestamp + 90), scheduler.REASON_UNFUNDED());
        assertFalse(scheduler.arm());
        assertEq(scheduler.checksThisRound(), 1);
        assertEq(scheduler.retryStreak(), 0);
    }

    function test_unavailableHssAttemptConsumesRoundBudget() public {
        target.setAnswers(1);
        vm.etch(scheduler.HSS(), hex"");

        vm.expectEmit(true, false, false, true, address(scheduler));
        emit CheckUnscheduled(uint64(block.timestamp + 90), scheduler.REASON_UNAVAILABLE());
        assertFalse(scheduler.arm());
        assertEq(scheduler.checksThisRound(), 1);
        assertEq(scheduler.retryStreak(), 0);
    }

    function test_noCapacityAttemptConsumesRoundBudget() public {
        HssNoCapacityOracleMock hss = new HssNoCapacityOracleMock();
        vm.etch(scheduler.HSS(), address(hss).code);
        target.setAnswers(1);

        vm.expectEmit(true, false, false, true, address(scheduler));
        emit CheckUnscheduled(uint64(block.timestamp + 90), scheduler.REASON_NO_CAPACITY());
        assertFalse(scheduler.arm());
        assertEq(scheduler.checksThisRound(), 1);
        assertEq(scheduler.retryStreak(), 0);
    }

    function test_badScheduleResponseConsumesRoundBudget() public {
        HssBadScheduleResponseMock hss = new HssBadScheduleResponseMock();
        vm.etch(scheduler.HSS(), address(hss).code);
        target.setAnswers(1);

        vm.expectEmit(true, false, false, true, address(scheduler));
        emit CheckUnscheduled(uint64(block.timestamp + 90), scheduler.REASON_BAD_RESPONSE());
        assertFalse(scheduler.arm());
        assertEq(scheduler.checksThisRound(), 1);
        assertEq(scheduler.retryStreak(), 0);
    }

    function test_rejectedAndRevertingCallsConsumeRoundBudget() public {
        target.setAnswers(1);
        HssRejectedScheduleMock rejected = new HssRejectedScheduleMock();
        vm.etch(scheduler.HSS(), address(rejected).code);
        assertFalse(scheduler.arm());
        assertEq(scheduler.checksThisRound(), 1);

        HssRevertingScheduleMock revertingHss = new HssRevertingScheduleMock();
        vm.etch(scheduler.HSS(), address(revertingHss).code);
        assertFalse(scheduler.arm());
        assertEq(scheduler.checksThisRound(), 2);
    }

    function test_failedAttemptsExhaustGlobalRoundBudget() public {
        HssNoCapacityOracleMock hss = new HssNoCapacityOracleMock();
        vm.etch(scheduler.HSS(), address(hss).code);
        target.setAnswers(1);

        for (uint256 i; i < scheduler.MAX_CHECKS_PER_ROUND(); ++i) {
            assertFalse(scheduler.arm());
            assertEq(scheduler.checksThisRound(), i + 1);
        }
        HssSuccessMock success = new HssSuccessMock();
        vm.etch(scheduler.HSS(), address(success).code);
        assertFalse(scheduler.arm());
        assertEq(scheduler.checksThisRound(), scheduler.MAX_CHECKS_PER_ROUND());
        assertEq(scheduler.activeSchedule(), address(0));
    }

    function test_earlyTickNeitherFinalizesNorDuplicatesTheSchedule() public {
        target.setAnswers(2);
        scheduler.arm();
        uint64 dueAt = scheduler.nextCheckAt();
        (bool finalized, bool scheduled) = scheduler.tick();
        assertFalse(finalized);
        assertTrue(scheduled);
        assertEq(target.finalizations(), 0);
        assertEq(scheduler.nextCheckAt(), dueAt);
    }

    function test_hederaTwoSecondExecutionSkewStillProcessesTheCheck() public {
        target.setAnswers(2);
        scheduler.arm();
        vm.warp(scheduler.nextCheckAt() - scheduler.EXECUTION_CLOCK_TOLERANCE());
        (bool finalized, bool scheduled) = scheduler.tick();
        assertTrue(finalized);
        assertFalse(scheduled);
        assertEq(scheduler.lastFinalizedRound(), 3);
    }

    function test_retryScheduleUsesFiveFifteenAndSixtyMinuteBackoff() public {
        target.setAnswers(1);
        scheduler.arm();

        uint64 dueAt = scheduler.nextCheckAt();
        assertEq(dueAt, block.timestamp + 90);
        vm.warp(dueAt);
        scheduler.tick();
        assertEq(scheduler.nextCheckAt(), dueAt + 5 minutes);

        dueAt = scheduler.nextCheckAt();
        vm.warp(dueAt);
        scheduler.tick();
        assertEq(scheduler.nextCheckAt(), dueAt + 15 minutes);

        dueAt = scheduler.nextCheckAt();
        vm.warp(dueAt);
        scheduler.tick();
        assertEq(scheduler.nextCheckAt(), dueAt + 60 minutes);
    }

    function test_onlyTreasuryCanRecoverSchedulerFunding() public {
        address payable recipient = payable(address(0xBEEF));
        vm.prank(address(0xCAFE));
        vm.expectRevert(OracleScheduler.Unauthorized.selector);
        scheduler.withdraw(recipient, 1e8);

        uint256 before = recipient.balance;
        scheduler.withdraw(recipient, 10e8);
        assertEq(recipient.balance - before, 10e8);
    }

    function test_shortQuorumStopsAfterFourChecksForTheSameAnswerSet() public {
        target.setAnswers(1);
        assertTrue(scheduler.arm());
        for (uint256 i; i < scheduler.MAX_RETRY_STREAK(); ++i) {
            vm.warp(scheduler.nextCheckAt());
            (bool finalized, bool scheduled) = scheduler.tick();
            assertFalse(finalized);
            assertEq(scheduled, i + 1 < scheduler.MAX_RETRY_STREAK());
        }
        assertEq(scheduler.checksThisRound(), scheduler.MAX_RETRY_STREAK());
        assertEq(scheduler.activeSchedule(), address(0));
        assertFalse(scheduler.arm());
        assertEq(scheduler.checksThisRound(), scheduler.MAX_RETRY_STREAK());
    }

    function test_newAnswerCanRearmAfterRetryLimitAndThenFinalize() public {
        target.setAnswers(1);
        scheduler.arm();
        for (uint256 i; i < scheduler.MAX_RETRY_STREAK(); ++i) {
            vm.warp(scheduler.nextCheckAt());
            scheduler.tick();
        }
        target.setAnswers(2);
        assertTrue(scheduler.arm());
        assertEq(scheduler.checksThisRound(), scheduler.MAX_RETRY_STREAK() + 1);
        vm.warp(scheduler.nextCheckAt());
        (bool finalized, bool scheduled) = scheduler.tick();
        assertTrue(finalized);
        assertFalse(scheduled);
    }

    function test_externalFinalizationMakesTheOldCheckStop() public {
        target.setAnswers(1);
        scheduler.arm();
        target.advanceRound();
        vm.warp(scheduler.nextCheckAt());
        (bool finalized, bool scheduled) = scheduler.tick();
        assertFalse(finalized);
        assertFalse(scheduled);
        assertEq(scheduler.activeSchedule(), address(0));
    }
}
