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
        ++round;
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

contract OracleSchedulerTest is Test {
    OracleTargetMock private target;
    OracleScheduler private scheduler;

    function setUp() public {
        target = new OracleTargetMock();
        scheduler = new OracleScheduler(target, 60);
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
        assertTrue(scheduler.arm());
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
        (bool finalized, bool scheduled) = scheduler.tick();
        assertTrue(finalized);
        assertFalse(scheduled);
        assertEq(target.finalizations(), 1);
        assertEq(scheduler.lastFinalizedRound(), 3);
        assertEq(scheduler.activeSchedule(), address(0));
        assertEq(scheduler.nextCheckAt(), 0);
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

    function test_hederaOneSecondExecutionSkewStillProcessesTheCheck() public {
        target.setAnswers(2);
        scheduler.arm();
        vm.warp(scheduler.nextCheckAt() - 1);
        (bool finalized, bool scheduled) = scheduler.tick();
        assertTrue(finalized);
        assertFalse(scheduled);
        assertEq(scheduler.lastFinalizedRound(), 3);
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
