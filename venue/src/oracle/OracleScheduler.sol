// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IHederaScheduleService} from "../interfaces/IHederaScheduleService.sol";

interface IOracleSchedulerTarget {
    struct Answer {
        uint128 price;
        uint64 rate;
        address by;
    }

    function openRound() external view returns (uint64);
    function quorum() external view returns (uint8);
    function panelOf(uint64 round) external view returns (Answer[] memory);
    function finalize(uint64 round) external returns (uint128 price, uint64 rate);
}

/// @title OracleScheduler
/// @notice Runs bounded quorum checks through Hedera Schedule Service after an answer.
/// @dev Correctness never depends on HSS. Anyone may call `tick`, and every failed
///      system-contract interaction becomes an event instead of reverting the loop.
contract OracleScheduler {
    address public constant HSS = address(0x16b);
    int64 public constant HEDERA_SUCCESS = 22;
    uint256 public constant SCHEDULE_GAS_LIMIT = 2_000_000;
    uint256 public constant MIN_BALANCE_TINYBAR = 5 * 1e8;
    uint64 public constant EXECUTION_CLOCK_TOLERANCE = 2 seconds;
    uint64 public constant SCHEDULE_LATE_GRACE = 5 minutes;
    uint8 public constant MAX_RETRY_STREAK = 4;
    uint8 public constant MAX_CHECKS_PER_ROUND = 8;
    uint64 public constant RETRY_ONE = 5 minutes;
    uint64 public constant RETRY_TWO = 15 minutes;
    uint64 public constant RETRY_THREE = 1 hours;

    int64 public constant REASON_UNAVAILABLE = -1;
    int64 public constant REASON_NO_CAPACITY = -2;
    int64 public constant REASON_UNFUNDED = -3;
    int64 public constant REASON_BAD_RESPONSE = -4;

    IOracleSchedulerTarget public immutable oracle;
    uint64 public immutable initialDelay;
    address public immutable treasury;

    address public activeSchedule;
    uint64 public nextCheckAt;
    uint64 public trackedRound;
    uint64 public lastCheckedRound;
    uint64 public lastFinalizedRound;
    uint8 public retryStreak;
    /// @notice Scheduling attempts spent for the tracked round, including failed HSS paths.
    uint8 public checksThisRound;
    uint256 public lastAnswerCount;
    mapping(uint64 round => bool finalized) public isFinalizedRound;

    event CheckScheduled(address indexed scheduleAddress, uint64 indexed dueAt);
    event CheckUnscheduled(uint64 indexed dueAt, int64 reason);
    event QuorumObserved(uint64 indexed round, uint256 answers, uint8 quorum);
    event FinalizeAttempt(uint64 indexed round, bool success, bytes result);
    event OracleReadFailed(bytes4 indexed selector);
    event EarlyTick(uint64 indexed dueAt, uint64 indexed calledAt);
    event ArmRefused(uint64 indexed round, uint256 answers, bytes32 reason);
    event AutomationStopped(uint64 indexed round, bytes32 reason);
    event FundsWithdrawn(address indexed recipient, uint256 tinybarAmount);

    error ZeroAddress();
    error ZeroInterval();
    error Unauthorized();
    error TransferFailed();

    bytes32 public constant STOP_EMPTY_ROUND = keccak256("EMPTY_ROUND");
    bytes32 public constant STOP_ROUND_ADVANCED = keccak256("ROUND_ADVANCED");
    bytes32 public constant STOP_FINALIZED = keccak256("FINALIZED");
    bytes32 public constant STOP_RETRY_LIMIT = keccak256("RETRY_LIMIT");
    bytes32 public constant STOP_CHECK_LIMIT = keccak256("CHECK_LIMIT");
    bytes32 public constant STOP_NO_NEW_ANSWER = keccak256("NO_NEW_ANSWER");
    bytes32 public constant STOP_STALE_SCHEDULE = keccak256("STALE_SCHEDULE");

    constructor(IOracleSchedulerTarget oracle_, uint64 initialDelay_) {
        if (address(oracle_) == address(0)) revert ZeroAddress();
        if (initialDelay_ == 0) revert ZeroInterval();
        oracle = oracle_;
        initialDelay = initialDelay_;
        treasury = msg.sender;
    }

    receive() external payable {}

    function withdraw(address payable recipient, uint256 tinybarAmount) external {
        if (msg.sender != treasury) revert Unauthorized();
        if (recipient == address(0)) revert ZeroAddress();
        (bool sent,) = recipient.call{value: tinybarAmount}("");
        if (!sent) revert TransferFailed();
        emit FundsWithdrawn(recipient, tinybarAmount);
    }

    /// @notice Arm one check after the first answer in a round. Safe to call repeatedly.
    function arm() external returns (bool scheduled) {
        if (activeSchedule != address(0)) {
            if (block.timestamp <= uint256(nextCheckAt) + SCHEDULE_LATE_GRACE) return true;
            activeSchedule = address(0);
            nextCheckAt = 0;
            emit AutomationStopped(trackedRound, STOP_STALE_SCHEDULE);
        }
        (bool readable, uint64 round,, uint256 answers) = _snapshot();
        if (!readable) return false;
        if (isFinalizedRound[round]) {
            emit ArmRefused(round, answers, STOP_FINALIZED);
            return false;
        }
        if (answers == 0) {
            emit ArmRefused(round, answers, STOP_EMPTY_ROUND);
            return false;
        }

        if (round != trackedRound) {
            trackedRound = round;
            checksThisRound = 0;
            retryStreak = 0;
            lastAnswerCount = answers;
        } else if (answers > lastAnswerCount) {
            lastAnswerCount = answers;
            retryStreak = 0;
        } else if (retryStreak >= MAX_RETRY_STREAK) {
            emit ArmRefused(round, answers, STOP_NO_NEW_ANSWER);
            return false;
        }
        if (checksThisRound >= MAX_CHECKS_PER_ROUND) {
            emit ArmRefused(round, answers, STOP_CHECK_LIMIT);
            return false;
        }
        scheduled = _trySchedule(_after(initialDelay));
    }

    /// @notice Finalize only when quorum is visible, with bounded backoff otherwise.
    /// @dev The function deliberately returns through every failure path.
    function tick() external returns (bool finalized, bool scheduled) {
        uint64 dueAt = nextCheckAt;
        if (dueAt != 0 && block.timestamp + EXECUTION_CLOCK_TOLERANCE < dueAt) {
            emit EarlyTick(dueAt, uint64(block.timestamp));
            return (false, activeSchedule != address(0));
        }
        activeSchedule = address(0);
        nextCheckAt = 0;

        (bool readable, uint64 round, uint8 needed, uint256 answers) = _snapshot();
        if (!readable) {
            if (trackedRound != 0) scheduled = _scheduleRetry();
            return (false, scheduled);
        }
        if (trackedRound == 0) {
            if (answers == 0) {
                emit AutomationStopped(round, STOP_EMPTY_ROUND);
                return (false, false);
            }
            trackedRound = round;
            lastAnswerCount = answers;
        } else if (round != trackedRound) {
            emit AutomationStopped(trackedRound, STOP_ROUND_ADVANCED);
            return (false, false);
        }
        if (isFinalizedRound[round]) {
            emit AutomationStopped(round, STOP_FINALIZED);
            return (false, false);
        }
        if (answers == 0) {
            emit AutomationStopped(round, STOP_EMPTY_ROUND);
            return (false, false);
        }
        if (answers > lastAnswerCount) {
            lastAnswerCount = answers;
            retryStreak = 0;
        }

        lastCheckedRound = round;
        emit QuorumObserved(round, answers, needed);
        if (needed != 0 && answers >= needed) {
            (bool ok, bytes memory result) =
                address(oracle).call(abi.encodeCall(IOracleSchedulerTarget.finalize, (round)));
            emit FinalizeAttempt(round, ok, result);
            if (ok && result.length == 64) {
                finalized = true;
                lastFinalizedRound = round;
                isFinalizedRound[round] = true;
                emit AutomationStopped(round, STOP_FINALIZED);
                return (true, false);
            }
        }
        scheduled = _scheduleRetry();
    }

    function _snapshot()
        private
        returns (bool readable, uint64 round, uint8 needed, uint256 answers)
    {
        readable = true;
        try oracle.openRound() returns (uint64 value) {
            round = value;
        } catch {
            readable = false;
            emit OracleReadFailed(IOracleSchedulerTarget.openRound.selector);
        }
        if (readable) {
            try oracle.quorum() returns (uint8 value) {
                needed = value;
            } catch {
                readable = false;
                emit OracleReadFailed(IOracleSchedulerTarget.quorum.selector);
            }
        }
        if (readable) {
            try oracle.panelOf(round) returns (IOracleSchedulerTarget.Answer[] memory panel) {
                answers = panel.length;
            } catch {
                readable = false;
                emit OracleReadFailed(IOracleSchedulerTarget.panelOf.selector);
            }
        }
    }

    function _scheduleRetry() private returns (bool scheduled) {
        if (checksThisRound >= MAX_CHECKS_PER_ROUND) {
            emit AutomationStopped(trackedRound, STOP_CHECK_LIMIT);
            return false;
        }
        if (retryStreak >= MAX_RETRY_STREAK) {
            emit AutomationStopped(trackedRound, STOP_RETRY_LIMIT);
            return false;
        }
        uint64 wait = retryStreak == 0
            ? initialDelay
            : retryStreak == 1 ? RETRY_ONE : retryStreak == 2 ? RETRY_TWO : RETRY_THREE;
        scheduled = _trySchedule(_after(wait));
    }

    function _after(uint64 delay) private view returns (uint64 dueAt) {
        uint256 future = block.timestamp + uint256(delay);
        dueAt = future > type(uint64).max ? type(uint64).max : uint64(future);
    }

    function _trySchedule(uint64 dueAt) private returns (bool scheduled) {
        if (checksThisRound >= MAX_CHECKS_PER_ROUND) {
            emit AutomationStopped(trackedRound, STOP_CHECK_LIMIT);
            return false;
        }
        if (retryStreak >= MAX_RETRY_STREAK) {
            emit AutomationStopped(trackedRound, STOP_RETRY_LIMIT);
            return false;
        }
        // Capacity probes and all later HSS paths are attempts. Charge the round
        // budget before interacting so unavailable, malformed, refused, and
        // unfunded paths cannot be retried without bound.
        ++checksThisRound;
        (bool probeOk, bytes memory probe) = HSS.staticcall(
            abi.encodeCall(
                IHederaScheduleService.hasScheduleCapacity, (uint256(dueAt), SCHEDULE_GAS_LIMIT)
            )
        );
        if (!probeOk || probe.length != 32) {
            emit CheckUnscheduled(dueAt, REASON_UNAVAILABLE);
            return false;
        }
        uint256 capacityWord;
        assembly ("memory-safe") {
            capacityWord := mload(add(probe, 0x20))
        }
        if (capacityWord > 1) {
            emit CheckUnscheduled(dueAt, REASON_BAD_RESPONSE);
            return false;
        }
        if (capacityWord == 0) {
            emit CheckUnscheduled(dueAt, REASON_NO_CAPACITY);
            return false;
        }
        if (address(this).balance < MIN_BALANCE_TINYBAR) {
            emit CheckUnscheduled(dueAt, REASON_UNFUNDED);
            return false;
        }

        (bool callOk, bytes memory result) = HSS.call(
            abi.encodeCall(
                IHederaScheduleService.scheduleCall,
                (
                    address(this),
                    uint256(dueAt),
                    SCHEDULE_GAS_LIMIT,
                    uint64(0),
                    abi.encodeCall(this.tick, ())
                )
            )
        );
        if (!callOk || result.length != 64) {
            emit CheckUnscheduled(dueAt, REASON_BAD_RESPONSE);
            return false;
        }

        uint256 responseWord;
        uint256 addressWord;
        assembly ("memory-safe") {
            responseWord := mload(add(result, 0x20))
            addressWord := mload(add(result, 0x40))
        }
        if (responseWord > uint256(uint64(type(int64).max)) || addressWord >> 160 != 0) {
            emit CheckUnscheduled(dueAt, REASON_BAD_RESPONSE);
            return false;
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        int64 responseCode = int64(uint64(responseWord));
        // forge-lint: disable-next-line(unsafe-typecast)
        address scheduleAddress = address(uint160(addressWord));
        if (responseCode != HEDERA_SUCCESS) {
            emit CheckUnscheduled(dueAt, responseCode);
            return false;
        }
        if (scheduleAddress == address(0)) {
            emit CheckUnscheduled(dueAt, REASON_BAD_RESPONSE);
            return false;
        }

        activeSchedule = scheduleAddress;
        nextCheckAt = dueAt;
        ++retryStreak;
        emit CheckScheduled(scheduleAddress, dueAt);
        return true;
    }
}
