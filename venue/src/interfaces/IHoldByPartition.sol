// SPDX-License-Identifier: BUSL-1.1
// VENDORED from hashgraph/asset-tokenization-studio, Apache-2.0.
// Sources: packages/ats/contracts/contracts/facets/hold/IHoldTypes.sol
//          packages/ats/contracts/contracts/facets/holdByPartition/IHoldByPartition.sol
// Reduced to the seam call list, rows 5 to 7 and row 11. Adding a call here without
// amending that list breaks the zero-fork contract, so row 11 was added to it in the
// same change that added `getHoldForByPartition` below.
pragma solidity ^0.8.24;

interface IHoldTypes {
    struct Hold {
        uint256 amount;
        uint256 expirationTimestamp;
        address escrow;
        address to;
        bytes data;
    }

    struct HoldIdentifier {
        bytes32 partition;
        address tokenHolder;
        uint256 holdId;
    }
}

interface IHoldByPartition {
    function createHoldByPartition(bytes32 partition, IHoldTypes.Hold calldata hold)
        external
        returns (bool success, uint256 holdId);

    function createHoldFromByPartition(
        bytes32 partition,
        address from,
        IHoldTypes.Hold calldata hold,
        bytes calldata operatorData
    ) external returns (bool success, uint256 holdId);

    function executeHoldByPartition(
        IHoldTypes.HoldIdentifier calldata id,
        address to,
        uint256 amount
    ) external returns (bool success, bytes32 partition);

    function releaseHoldByPartition(IHoldTypes.HoldIdentifier calldata id, uint256 amount)
        external
        returns (bool success);

    /// @notice Row 11 of the call list. A read, added because `MatchingEngine`
    ///         cannot take a seller's word for the backing behind a sell order.
    /// @dev Two distinct jobs, and neither is served by any call already on the
    ///      list.
    ///
    ///      **At reveal**, it is the only way to establish that the lot exists,
    ///      that this contract is the escrow that can move it, and that the hold
    ///      names no destination yet. `createHoldByPartition` returns an id and
    ///      nothing about the hold's terms, and the seller creates the hold in a
    ///      transaction we never see.
    ///
    ///      **At cross**, it is the ABAF check. `HoldStorageWrapper.beforeExecuteHold`
    ///      synchronises the holder's adjustment factor before every execution,
    ///      and the pending-adjustment sync fires lazily from a long list of
    ///      unrelated entry points, so a third party's transaction can rebase a
    ///      resting order's backing between reveal and cross. The quantity
    ///      promised is then not the quantity deliverable. Reading the hold again
    ///      is how the engine notices; see `MatchingEngine._voidOnRebase`.
    ///
    ///      `thirdPartyType_` is declared `uint8` rather than as ATS's
    ///      `ThirdPartyType` enum. The ABI is identical, an enum being a `uint8`
    ///      on the wire, and vendoring the enum would pull a second file across
    ///      the boundary for a value this contract never reads.
    function getHoldForByPartition(IHoldTypes.HoldIdentifier calldata id)
        external
        view
        returns (
            uint256 amount_,
            uint256 expirationTimestamp_,
            address escrow_,
            address destination_,
            bytes memory data_,
            bytes memory operatorData_,
            uint8 thirdPartyType_
        );
}
