// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @notice The shape snarkjs 0.7.6 exports for a PLONK verifier, specialised to
///         `circuits/kyc.circom`.
/// @dev The public signal array is fixed length in the generated contract, not
///      dynamic, and its length is part of the frozen circuit interface. If the
///      circuit's public signals change, this interface, `KycVerifier.sol` and
///      `RegistrationGate`'s layout constants all change together or the system
///      is silently reading the wrong slots.
///
///      a design decision chose PLONK over Groth16 so the project inherits a universal
///      ceremony and runs no trusted setup of its own.
interface IPlonkVerifier {
    function verifyProof(uint256[24] calldata proof, uint256[7] calldata pubSignals)
        external
        view
        returns (bool);
}
