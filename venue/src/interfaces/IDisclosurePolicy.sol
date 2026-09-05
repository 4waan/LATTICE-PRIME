// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {DisclosureBudget} from "../lattice/DisclosureBudget.sol";

/// @title IDisclosurePolicy
/// @notice Per-row ceiling, floor, and coalition budget. Fail closed on missing rows.
/// @dev Floor is not a per-event check: an obligation runs over a row and a window.
///      `budgetBits == 0` means unmetered; `ParameterRoot.adopt` refuses a budget
///      on a row whose ceiling already admits `(exact, imm)` (Rule B).
interface IDisclosurePolicy {
    /// @notice Ceiling for `row`. `BOTTOM` if unpublished (fail closed).
    function ceilingFor(uint16 row) external view returns (uint32);

    /// @notice Floor for `row`. Not a per-event check; bounds the ceiling.
    function floorFor(uint16 row) external view returns (uint32);

    /// @notice Coalition budget for `row`. Zero `budgetBits` means unmetered.
    function budgetFor(uint16 row) external view returns (DisclosureBudget.Row memory);

    /// @notice Epoch the budget is counted in. Shared so disclosers cannot drift.
    function currentEpoch() external view returns (uint64);
}
