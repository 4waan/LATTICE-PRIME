// SPDX-License-Identifier: Apache-2.0
// VENDORED from hashgraph/asset-tokenization-studio, Apache-2.0.
// Source: packages/ats/contracts/contracts/facets/layer_1/externalKycList/IExternalKycList.sol
// Verbatim. This is seam D, the interface our registry implements so that ATS
// calls into it on every transfer.
pragma solidity ^0.8.24;

import {IKyc} from "./IKyc.sol";

interface IExternalKycList {
    /// @notice Gets user KYC status from the external KYC list contract
    function getKycStatus(address account) external view returns (IKyc.KycStatus);
}
