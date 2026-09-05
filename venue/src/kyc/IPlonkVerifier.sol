// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @notice The shape snarkjs 0.7.6 exports for a PLONK verifier, specialised to
///         `circuits/kyc.circom`.
/// @dev Fixed length: part of the frozen circuit interface. Changing public
///      signals means this, `KycVerifier.sol`, and `RegistrationGate` change together.
///      PLONK over Groth16: universal ceremony, no project-specific trusted setup.
interface IPlonkVerifier {
    function verifyProof(uint256[24] calldata proof, uint256[7] calldata pubSignals)
        external
        view
        returns (bool);
}
