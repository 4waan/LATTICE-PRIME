// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @notice Wall-clock epochs for governance, Article 5 windows, and halt budgets.
/// @dev Intentionally one function so test doubles stay a single ticker.
interface IEpochClock {
    function currentEpoch() external view returns (uint64);
}
