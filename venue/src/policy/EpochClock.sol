// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IEpochClock} from "./Regime.sol";

/// @title EpochClock
/// @notice The wall clock the governed contracts count in. One epoch is the
///         cooling-off unit between proposing a change and adopting it, the
///         window `VolumeCap` measures Article 5 volume over, and the window
///         `TradingHalt` budgets halt seconds against.
///
/// ## Why this contract did not exist until the venue was deployed
///
/// Every `IEpochClock` in the tree before this one was a test double that a
/// suite ticked by hand, which is the right shape for a test: it separates
/// "an epoch passed" from "time passed" so the governance separation can be
/// exercised without warping. A live chain has no hand to tick it, so the
/// separation has to come from somewhere real, and the only monotonic thing a
/// contract can read is `block.timestamp`.
///
/// ## The arithmetic is `ZkKycRegistry._epochAt`, deliberately
///
/// The registry already counts epochs this way, and two different epoch
/// definitions in one venue is a defect waiting for a boundary condition. The
/// **numbers** differ and should: a credential's validity window and a
/// governance cooling-off period are not the same duration. The **shape** does
/// not.
///
/// Below `epochZero` this returns zero rather than reverting. The registry
/// needs that because seam D admits no revert path; this contract does not sit
/// on a seam, but a clock with two behaviours depending on which contract reads
/// it is worse than a clock that is uniformly total.
///
/// ## What a short epoch does and does not weaken
///
/// `Regime` and `ParameterRoot` both write `pendingEpoch = currentEpoch() + 1`
/// and refuse to adopt before it. That guarantee is "not in the epoch you
/// proposed in", and it holds at any epoch length. What the length sets is the
/// *worst case* delay, not the minimum: a proposal made in the last second of
/// an epoch is adoptable a second later. That is true of any wall-clock epoch
/// and is why the mock ticks instead. A deployment choosing a short epoch is
/// choosing an observable delay over a meaningful one, and should say so.
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
