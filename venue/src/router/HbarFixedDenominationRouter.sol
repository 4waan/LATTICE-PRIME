// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {
    IFixedWithdrawalVerifier,
    IFixedWithdrawalComplianceVerifier
} from "./IRouterVerifiers.sol";
import {IPoseidon2, IRouterKycRegistry, IRouterSessionFactory} from "./IRouterDependencies.sol";
import {FixedDenominationRouter} from "./FixedDenominationRouter.sol";

/// @title HbarFixedDenominationRouter
/// @notice Fixed-value native HBAR pool with public entry and session-only exit.
contract HbarFixedDenominationRouter is FixedDenominationRouter {
    struct Config {
        address admin;
        uint256 denomination;
        uint64 minimumWithdrawalDelay;
        uint64 maximumRootAge;
        uint32 minimumRealNotes;
        uint64 viewKeyEpoch;
        uint256 viewKeyX;
        uint256 viewKeyY;
    }

    event NativeSurplusReceived(address indexed sender, uint256 amount);

    error WrongNativeDenomination(uint256 got, uint256 expected);
    error NativePayoutFailed(address recipient);

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
            address(0),
            config.denomination,
            config.minimumWithdrawalDelay,
            config.maximumRootAge,
            config.minimumRealNotes,
            config.viewKeyEpoch,
            config.viewKeyX,
            config.viewKeyY
        )
    {}

    function deposit(uint256 commitment) external payable nonReentrant returns (uint256 root) {
        if (msg.value != denomination) {
            revert WrongNativeDenomination(msg.value, denomination);
        }
        root = _insert(commitment, msg.sender);
        _requireSolvent();
    }

    /// @notice Recovery and donations are reserves, never anonymous notes.
    receive() external payable {
        emit NativeSurplusReceived(msg.sender, msg.value);
    }

    function _payout(address payable recipient) internal override {
        (bool sent,) = recipient.call{value: denomination}("");
        if (!sent) revert NativePayoutFailed(recipient);
    }

    function _assetBalance() internal view override returns (uint256) {
        return address(this).balance;
    }
}
