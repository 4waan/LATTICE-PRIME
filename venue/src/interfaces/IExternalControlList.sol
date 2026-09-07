// SPDX-License-Identifier: BUSL-1.1
// VENDORED from hashgraph/asset-tokenization-studio, Apache-2.0.
// Source: packages/ats/contracts/contracts/facets/layer_1/externalControlList/IExternalControlList.sol
// Verbatim. This is seam B, the interface our freeze list implements so that ATS
// calls into it on every transfer.
//
// Seam B is narrow, 16 entry points, and its value is not its width. It is the
// only seam besides D that runs on `MaturityByPartition.redeemAtMaturityByPartition`,
// which seam C never sees: `test_theMaturityRailIsNotSeenByTheSizeSeam` is the
// measurement. So a redemption at maturity is reachable by this seam and by no
// other control the venue holds.
//
// The composition rule is AND. `ExternalListManagementStorageWrapper.isExternallyAuthorized`
// returns false on the first registered list that refuses, so `isAuthorized`
// answering false is a veto and answering true is only an abstention.
pragma solidity ^0.8.24;

interface IExternalControlList {
    /// @notice Whether `account` is authorised to hold and move the token.
    /// @dev ANDed across every registered list. False bars the account; true
    ///      defers to the other seams. A revert here is a revert on the transfer
    ///      path, exactly as in seam D.
    function isAuthorized(address account) external view returns (bool);
}
