// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

interface IFixedWithdrawalVerifier {
    function verifyProof(uint256[24] calldata proof, uint256[8] calldata publicSignals)
        external
        view
        returns (bool);
}

interface IFixedWithdrawalComplianceVerifier {
    function verifyProof(uint256[24] calldata proof, uint256[14] calldata publicSignals)
        external
        view
        returns (bool);
}
