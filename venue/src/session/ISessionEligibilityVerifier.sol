// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @notice PLONK verifier shape for session_eligibility.circom.
interface ISessionEligibilityVerifier {
    function verifyProof(uint256[24] calldata proof, uint256[12] calldata publicSignals)
        external
        view
        returns (bool);
}
