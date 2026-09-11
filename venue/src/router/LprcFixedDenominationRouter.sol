// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IHoldByPartition, IHoldTypes} from "../interfaces/IHoldByPartition.sol";
import {
    IFixedWithdrawalVerifier,
    IFixedWithdrawalComplianceVerifier
} from "./IRouterVerifiers.sol";
import {
    IPoseidon2,
    IRouterKycRegistry,
    IRouterSessionFactory,
    IAtsRouterToken
} from "./IRouterDependencies.sol";
import {FixedDenominationRouter} from "./FixedDenominationRouter.sol";

/// @title LprcFixedDenominationRouter
/// @notice ATS hold-based LPRC custody with public entry and session-only exit.
/// @dev Activation requires a live ATS canary hash. The canary must establish
///      that hold-from, self execution, router eligibility, and the outbound
///      self-hold path behave atomically on the target deployment.
contract LprcFixedDenominationRouter is FixedDenominationRouter {
    struct Config {
        address admin;
        IAtsRouterToken security;
        bytes32 partition;
        uint256 denomination;
        uint64 minimumWithdrawalDelay;
        uint64 maximumRootAge;
        uint32 minimumRealNotes;
        uint64 viewKeyEpoch;
        uint256 viewKeyX;
        uint256 viewKeyY;
        uint64 holdDuration;
    }

    IAtsRouterToken public immutable security;
    bytes32 public immutable partition;
    uint64 public immutable holdDuration;

    bytes32 public atsCanaryEvidenceHash;

    event AtsCanaryActivated(bytes32 indexed evidenceHash);

    error CanaryNotActivated();
    error CanaryAlreadyActivated();
    error InvalidCanaryEvidence();
    error InvalidHoldDuration();
    error HoldCallFailed(bytes4 selector);
    error HoldIdentifierInvalid();
    error PartitionMismatch(bytes32 got, bytes32 expected);
    error TokenBalanceDeltaMismatch(uint256 beforeBalance, uint256 afterBalance);

    constructor(
        IFixedWithdrawalVerifier withdrawalVerifier_,
        IFixedWithdrawalComplianceVerifier complianceVerifier_,
        IPoseidon2 poseidon_,
        IRouterKycRegistry registry_,
        IRouterSessionFactory sessionFactory_,
        Config memory config
    )
        FixedDenominationRouter(
            withdrawalVerifier_,
            complianceVerifier_,
            poseidon_,
            registry_,
            sessionFactory_,
            config.admin,
            address(config.security),
            config.denomination,
            config.minimumWithdrawalDelay,
            config.maximumRootAge,
            config.minimumRealNotes,
            config.viewKeyEpoch,
            config.viewKeyX,
            config.viewKeyY
        )
    {
        if (address(config.security).code.length == 0) {
            revert DependencyNotContract(address(config.security));
        }
        if (config.holdDuration == 0) revert InvalidHoldDuration();
        security = config.security;
        partition = config.partition;
        holdDuration = config.holdDuration;
    }

    function activateAtsCanary(bytes32 evidenceHash) external onlyAdmin {
        if (atsCanaryEvidenceHash != bytes32(0)) revert CanaryAlreadyActivated();
        if (evidenceHash == bytes32(0)) revert InvalidCanaryEvidence();
        atsCanaryEvidenceHash = evidenceHash;
        emit AtsCanaryActivated(evidenceHash);
    }

    function deposit(uint256 commitment) external nonReentrant returns (uint256 root) {
        _requireCanary();
        _requireRouterEligible();

        uint256 beforeBalance = _assetBalance();
        (bool created, uint256 holdId) = security.createHoldFromByPartition(
            partition,
            msg.sender,
            IHoldTypes.Hold({
                amount: denomination,
                expirationTimestamp: block.timestamp + holdDuration,
                escrow: address(this),
                to: address(this),
                data: ""
            }),
            ""
        );
        if (!created) {
            revert HoldCallFailed(IHoldByPartition.createHoldFromByPartition.selector);
        }
        if (holdId == 0) revert HoldIdentifierInvalid();

        (bool executed, bytes32 executedPartition) = security.executeHoldByPartition(
            IHoldTypes.HoldIdentifier({
                partition: partition, tokenHolder: msg.sender, holdId: holdId
            }),
            address(this),
            denomination
        );
        if (!executed) {
            revert HoldCallFailed(IHoldByPartition.executeHoldByPartition.selector);
        }
        if (executedPartition != partition) {
            revert PartitionMismatch(executedPartition, partition);
        }

        uint256 afterBalance = _assetBalance();
        if (afterBalance != beforeBalance + denomination) {
            revert TokenBalanceDeltaMismatch(beforeBalance, afterBalance);
        }

        root = _insert(commitment, msg.sender);
        _requireSolvent();
    }

    function _payout(address payable recipient) internal override {
        _requireCanary();
        _requireRouterEligible();

        uint256 routerBefore = _assetBalance();
        uint256 recipientBefore = security.balanceOfByPartition(partition, recipient);

        (bool created, uint256 holdId) = security.createHoldByPartition(
            partition,
            IHoldTypes.Hold({
                amount: denomination,
                expirationTimestamp: block.timestamp + holdDuration,
                escrow: address(this),
                to: recipient,
                data: ""
            })
        );
        if (!created) {
            revert HoldCallFailed(IHoldByPartition.createHoldByPartition.selector);
        }
        if (holdId == 0) revert HoldIdentifierInvalid();

        (bool executed, bytes32 executedPartition) = security.executeHoldByPartition(
            IHoldTypes.HoldIdentifier({
                partition: partition, tokenHolder: address(this), holdId: holdId
            }),
            recipient,
            denomination
        );
        if (!executed) {
            revert HoldCallFailed(IHoldByPartition.executeHoldByPartition.selector);
        }
        if (executedPartition != partition) {
            revert PartitionMismatch(executedPartition, partition);
        }

        uint256 routerAfter = _assetBalance();
        uint256 recipientAfter = security.balanceOfByPartition(partition, recipient);
        if (
            routerAfter + denomination != routerBefore
                || recipientAfter != recipientBefore + denomination
        ) {
            revert TokenBalanceDeltaMismatch(routerBefore, routerAfter);
        }
    }

    function _assetBalance() internal view override returns (uint256) {
        return security.balanceOfByPartition(partition, address(this));
    }

    function _requireCanary() private view {
        if (atsCanaryEvidenceHash == bytes32(0)) revert CanaryNotActivated();
    }
}
