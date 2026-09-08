// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.4.9 <0.9.0;

/// @title IHederaScheduleService
/// @notice The HIP-1215 subset used by this venue at system address `0x16b`.
/// @dev Vendored from Hiero's HIP-1215 interface. The schedule service is
///      implemented by the Hedera node, so an empty `extcodesize` does not prove
///      it is absent. Callers must validate the returndata instead.
interface IHederaScheduleService {
    /// @notice Schedule `callData` against `to` for `expirySecond`.
    /// @return responseCode Hedera response code. `22` is success.
    /// @return scheduleAddress Address of the created schedule, or zero on failure.
    function scheduleCall(
        address to,
        uint256 expirySecond,
        uint256 gasLimit,
        uint64 value,
        bytes memory callData
    ) external returns (int64 responseCode, address scheduleAddress);

    /// @notice Whether `expirySecond` can accept a call with `gasLimit`.
    function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit)
        external
        view
        returns (bool hasCapacity);
}
