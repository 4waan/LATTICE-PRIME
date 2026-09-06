// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IEpochClock} from "../interfaces/IEpochClock.sol";

/// @title EpochClock
/// @notice Wall-clock epochs. Same division as `ZkKycRegistry._epochAt`.
/// @dev Total: timestamps before `epochZero` return 0. Length sets worst-case
///      delay only; a proposal still cannot land in the epoch it was made in.
contract EpochClock is IEpochClock {
    /// @notice The instant epoch zero begins.
    uint64 public immutable epochZero;
    /// @notice Seconds per epoch.
    uint64 public immutable epochLength;

    error ZeroEpochLength();

    constructor(uint64 epochZero_, uint64 epochLength_) {
        if (epochLength_ == 0) revert ZeroEpochLength();
        epochZero = epochZero_;
        epochLength = epochLength_;
    }

    /// @inheritdoc IEpochClock
    function currentEpoch() external view returns (uint64) {
        return epochAt(block.timestamp);
    }

    /// @notice The epoch containing `ts`. Total: no input reverts.
    /// @dev Exposed so a caller can ask when the next epoch begins without
    ///      duplicating the division, which is how the two-epoch drift in an
    ///      earlier draft of the deployment script would have been caught.
    function epochAt(uint256 ts) public view returns (uint64) {
        if (ts < epochZero) return 0;
        return uint64((ts - epochZero) / epochLength);
    }

    /// @notice The first timestamp at which `currentEpoch()` returns `e`.
    function startOf(uint64 e) external view returns (uint64) {
        return epochZero + e * epochLength;
    }
}
