// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IHederaScheduleService} from "../interfaces/IHederaScheduleService.sol";

/// @title ScheduledSettlement
/// @notice Optional HIP-1215 scheduling with a permissionless manual fallback.
/// @dev Scheduling is never a correctness dependency. Every obligation is stored
///      before `0x16b` is called and `settle` remains callable after its due time
///      whether scheduling succeeded, failed, was unfunded or was unavailable.
///
///      These events are operational receipts, not new position disclosures.
///      Their identifiers, dates and schedule addresses are also public getters,
///      while the target calls retain RepoVault's existing disclosure controls.
abstract contract ScheduledSettlement {
    enum Kind {
        NONE,
        FAIL,
        COUPON
    }

    enum Status {
        NONE,
        PENDING,
        RUNNING,
        SETTLED
    }

    struct Obligation {
        address scheduleAddress;
        bytes32 repoId;
        uint64 dueAt;
        uint256 index;
        Kind kind;
        Status status;
    }

    address public constant HSS = address(0x16b);
    int64 public constant HEDERA_SUCCESS = 22;

    /// @notice Gas made available to either scheduled target.
    /// @dev Above the measured Forge cost of both `markFailing` and `noteCoupon`,
    ///      with room for the scheduler bookkeeping around them.
    uint256 public constant SCHEDULE_GAS_LIMIT = 750_000;

    /// @notice HBAR reserved for each future call, expressed in tinybars.
    /// @dev The live spike funded five HBAR for one call. Keeping that measured
    ///      amount as the reserve is conservative and makes funding observable.
    uint256 public constant FUNDING_PER_CALL = 5 * 1e8;

    /// @dev Hedera consensus can lead the EVM block clock at a second boundary.
    ///      Schedule after the economic due time so the strict guard still holds.
    uint256 private constant HSS_EXECUTION_DELAY = 2;

    /// @dev Negative local reasons cannot collide with non-negative HAPI codes.
    int64 public constant REASON_UNAVAILABLE = -1;
    int64 public constant REASON_NO_CAPACITY = -2;
    int64 public constant REASON_UNFUNDED = -3;
    int64 public constant REASON_BAD_RESPONSE = -4;

    bytes32 public constant DOMAIN_FAIL = keccak256("hedera2026.schedule.fail.v1");
    bytes32 public constant DOMAIN_COUPON = keccak256("hedera2026.schedule.coupon.v1");

    mapping(bytes32 => Obligation) private _obligations;

    /// @notice Funding reserved for scheduled calls that have not settled yet.
    uint256 public reservedFunding;

    event Scheduled(bytes32 indexed id, address indexed scheduleAddress, uint64 dueAt);
    event Unscheduled(bytes32 indexed id, int64 reason);

    error UnknownObligation(bytes32 id);
    error ObligationAlreadyExists(bytes32 id);
    error SettlementNotDue(bytes32 id, uint64 dueAt);

    /// @notice The scheduler is its own payer, so it must be able to hold HBAR.
    receive() external payable {}

    /// @notice HBAR owed as repo cash (offers + credits). Scheduler gas is separate.
    function _cashLiabilities() internal view virtual returns (uint256) {
        return 0;
    }

    /// @notice Number of additional calls backed by unreserved HBAR.
    function fundedFor() public view returns (uint256) {
        return _unreservedBalance() / FUNDING_PER_CALL;
    }

    /// @notice Whether a scheduled obligation remains covered by the reserve.
    function fundedFor(bytes32 id) public view returns (bool) {
        Obligation storage o = _obligations[id];
        return
            o.status == Status.PENDING && o.scheduleAddress != address(0) && _reservesCovered();
    }

    function obligation(bytes32 id) external view returns (Obligation memory) {
        return _obligations[id];
    }

    function failObligation(bytes32 repoId) public pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_FAIL, repoId));
    }

    function couponObligation(bytes32 repoId, uint256 index) public pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_COUPON, repoId, index));
    }

    /// @notice Execute a due obligation, including every unscheduled fallback.
    /// @return moved False only when this obligation already settled.
    function settle(bytes32 id) external returns (bool moved) {
        Obligation storage o = _obligations[id];
        if (o.status == Status.NONE) revert UnknownObligation(id);
        if (o.status == Status.SETTLED || o.status == Status.RUNNING) return false;
        if (block.timestamp < o.dueAt) revert SettlementNotDue(id, o.dueAt);

        o.status = Status.RUNNING;
        _runSettlement(o.kind, o.repoId, o.index);
        o.status = Status.SETTLED;

        if (o.scheduleAddress != address(0)) {
            reservedFunding -= FUNDING_PER_CALL;
        }
        return true;
    }

    function _registerSettlement(
        bytes32 id,
        bytes32 repoId,
        Kind kind,
        uint64 dueAt,
        uint256 index
    ) internal {
        if (_obligations[id].status != Status.NONE) {
            revert ObligationAlreadyExists(id);
        }
        _obligations[id] = Obligation({
            scheduleAddress: address(0),
            repoId: repoId,
            dueAt: dueAt,
            index: index,
            kind: kind,
            status: Status.PENDING
        });
        _trySchedule(id, dueAt);
    }

    /// @dev Total over all HSS behavior. Empty and malformed returndata become
    ///      an `Unscheduled` receipt instead of reverting the repo opening.
    function _trySchedule(bytes32 id, uint64 dueAt) private {
        uint256 executeAt = uint256(dueAt) + HSS_EXECUTION_DELAY;
        (bool probeOk, bytes memory probe) = HSS.staticcall(
            abi.encodeCall(
                IHederaScheduleService.hasScheduleCapacity, (executeAt, SCHEDULE_GAS_LIMIT)
            )
        );
        if (!probeOk || probe.length != 32) {
            emit Unscheduled(id, REASON_UNAVAILABLE);
            return;
        }

        uint256 capacityWord;
        assembly ("memory-safe") {
            capacityWord := mload(add(probe, 0x20))
        }
        if (capacityWord > 1) {
            emit Unscheduled(id, REASON_BAD_RESPONSE);
            return;
        }
        if (capacityWord == 0) {
            emit Unscheduled(id, REASON_NO_CAPACITY);
            return;
        }
        if (_unreservedBalance() < FUNDING_PER_CALL) {
            emit Unscheduled(id, REASON_UNFUNDED);
            return;
        }

        (bool callOk, bytes memory result) = HSS.call(
            abi.encodeCall(
                IHederaScheduleService.scheduleCall,
                (
                    address(this),
                    executeAt,
                    SCHEDULE_GAS_LIMIT,
                    uint64(0),
                    abi.encodeCall(this.settle, (id))
                )
            )
        );
        if (!callOk || result.length != 64) {
            emit Unscheduled(id, REASON_BAD_RESPONSE);
            return;
        }

        uint256 responseWord;
        uint256 addressWord;
        assembly ("memory-safe") {
            responseWord := mload(add(result, 0x20))
            addressWord := mload(add(result, 0x40))
        }
        if (responseWord > uint256(uint64(type(int64).max)) || addressWord >> 160 != 0) {
            emit Unscheduled(id, REASON_BAD_RESPONSE);
            return;
        }

        // The response word is bounded to the positive int64 range above.
        // forge-lint: disable-next-line(unsafe-typecast)
        int64 responseCode = int64(uint64(responseWord));
        // The high 96 bits were rejected above.
        // forge-lint: disable-next-line(unsafe-typecast)
        address scheduleAddress = address(uint160(addressWord));
        if (responseCode != HEDERA_SUCCESS) {
            emit Unscheduled(id, responseCode);
            return;
        }
        if (scheduleAddress == address(0)) {
            emit Unscheduled(id, REASON_BAD_RESPONSE);
            return;
        }

        _obligations[id].scheduleAddress = scheduleAddress;
        reservedFunding += FUNDING_PER_CALL;
        emit Scheduled(id, scheduleAddress, dueAt);
    }

    function _reservesCovered() private view returns (bool) {
        uint256 balance = address(this).balance;
        uint256 cash = _cashLiabilities();
        if (cash > balance) return false;
        return reservedFunding <= balance - cash;
    }

    function _unreservedBalance() private view returns (uint256) {
        uint256 balance = address(this).balance;
        uint256 cash = _cashLiabilities();
        if (cash >= balance) return 0;
        uint256 afterCash = balance - cash;
        if (reservedFunding >= afterCash) return 0;
        return afterCash - reservedFunding;
    }

    function _runSettlement(Kind kind, bytes32 repoId, uint256 index) internal virtual;
}
