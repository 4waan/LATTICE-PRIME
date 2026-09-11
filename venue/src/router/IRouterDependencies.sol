// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IHoldByPartition} from "../interfaces/IHoldByPartition.sol";
import {IKyc} from "../interfaces/IKyc.sol";

interface IPoseidon2 {
    function poseidon(uint256[2] calldata inputs) external pure returns (uint256);
}

interface IRouterKycRegistry {
    function getKycStatus(address account) external view returns (IKyc.KycStatus);
}

interface IRouterSessionFactory {
    function isSessionAccount(address account) external view returns (bool);
    function deployedCodeHash(address account) external view returns (bytes32);
}

interface IAtsRouterToken is IHoldByPartition {
    function balanceOfByPartition(bytes32 partition, address tokenHolder)
        external
        view
        returns (uint256);
}
