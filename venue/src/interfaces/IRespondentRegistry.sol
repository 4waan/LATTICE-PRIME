// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @notice Who may answer an axe. Classification is off-venue; the board only reads it.
interface IRespondentRegistry {
    /// @return FIX 1172: 1 participant, 3 market maker, 4 primary.
    function respondentType(address who) external view returns (uint8);
}
