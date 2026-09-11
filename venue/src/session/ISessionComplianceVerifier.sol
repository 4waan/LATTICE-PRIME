// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @notice PLONK verifier shape for session_compliance.circom.
interface ISessionComplianceVerifier {
    function verifyProof(uint256[24] calldata proof, uint256[17] calldata publicSignals)
        external
        view
        returns (bool);
}
