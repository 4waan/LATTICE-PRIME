// SPDX-License-Identifier: Apache-2.0
// VENDORED from hashgraph/asset-tokenization-studio, Apache-2.0.
// Source: packages/ats/contracts/contracts/facets/kyc/IKyc.sol
// Reduced to the one declaration seam D needs. Not modified otherwise.
pragma solidity ^0.8.24;

interface IKyc {
    enum KycStatus {
        NOT_GRANTED,
        GRANTED
    }
}
