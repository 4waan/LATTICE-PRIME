// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IHoldByPartition} from "../interfaces/IHoldByPartition.sol";
import {ISessionEngine, SessionAccount} from "./SessionAccount.sol";

/// @notice Optional atomic registration seam for a session eligibility gate.
/// @dev The hook receives only the new pseudonymous account and opaque proof
///      input. There is deliberately no connected-wallet identity argument.
interface ISessionAccountRegistrationHook {
    function registerSessionAccount(address account, bytes calldata registrationData) external;
}

/// @title SessionAccountFactory
/// @notice Canonical CREATE2 deployment of full immutable SessionAccount code.
/// @dev Caller-supplied salts are used verbatim and are not caller namespaced.
///      A relayer can therefore deploy the address the browser calculated.
contract SessionAccountFactory {
    struct VenueConfig {
        ISessionEngine engine;
        IHoldByPartition security;
        bytes32 partition;
        address payable router;
        bytes32 quicknetChainHash;
        bytes32 feePolicyDigest;
    }

    struct Config {
        address sessionSigner;
        address recoverySigner;
        ISessionEngine engine;
        IHoldByPartition security;
        bytes32 partition;
        address payable router;
        bytes32 quicknetChainHash;
        uint64 generation;
        bytes32 feePolicyDigest;
    }

    address public immutable admin;
    mapping(address => bool) public isSessionAccount;
    mapping(bytes32 => bool) public approvedVenueConfig;

    event SessionAccountDeployed(address indexed account, bytes32 indexed salt);
    event VenueConfigApproval(bytes32 indexed configDigest, bool approved);

    error NotAdmin();
    error VenueConfigNotApproved(bytes32 configDigest);
    error AccountAlreadyDeployed(address account);
    error InvalidRegistrationHook(address hook);

    constructor() {
        admin = msg.sender;
    }

    function setVenueConfigApproval(VenueConfig calldata config, bool approved) external {
        if (msg.sender != admin) revert NotAdmin();
        bytes32 digest = venueConfigDigest(config);
        approvedVenueConfig[digest] = approved;
        emit VenueConfigApproval(digest, approved);
    }

    function venueConfigDigest(VenueConfig calldata config) public pure returns (bytes32) {
        return _venueConfigDigest(
            config.engine,
            config.security,
            config.partition,
            config.router,
            config.quicknetChainHash,
            config.feePolicyDigest
        );
    }

    function accountVenueConfigDigest(Config calldata config) public pure returns (bytes32) {
        return _venueConfigDigest(
            config.engine,
            config.security,
            config.partition,
            config.router,
            config.quicknetChainHash,
            config.feePolicyDigest
        );
    }

    /// @notice Deploy and atomically prefund an account without a registration hook.
    function deploy(Config calldata config, bytes32 salt)
        external
        payable
        returns (SessionAccount account)
    {
        account = _deploy(config, salt);
    }

    /// @notice Deploy, prefund, and register in one reverting transaction frame.
    function deployAndRegister(
        Config calldata config,
        bytes32 salt,
        ISessionAccountRegistrationHook hook,
        bytes calldata registrationData
    ) external payable returns (SessionAccount account) {
        if (address(hook).code.length == 0) {
            revert InvalidRegistrationHook(address(hook));
        }

        account = _deploy(config, salt);
        hook.registerSessionAccount(address(account), registrationData);
    }

    function _deploy(Config calldata config, bytes32 salt)
        private
        returns (SessionAccount account)
    {
        bytes32 configDigest = accountVenueConfigDigest(config);
        if (!approvedVenueConfig[configDigest]) {
            revert VenueConfigNotApproved(configDigest);
        }
        address predicted = accountAddress(config, salt);
        if (predicted.code.length != 0 || isSessionAccount[predicted]) {
            revert AccountAlreadyDeployed(predicted);
        }

        account = new SessionAccount{salt: salt, value: msg.value}(
            config.sessionSigner,
            config.recoverySigner,
            config.engine,
            config.security,
            config.partition,
            config.router,
            config.quicknetChainHash,
            config.generation,
            config.feePolicyDigest
        );
        isSessionAccount[address(account)] = true;
        emit SessionAccountDeployed(address(account), salt);
    }

    function _venueConfigDigest(
        ISessionEngine engine,
        IHoldByPartition security,
        bytes32 partition,
        address router,
        bytes32 quicknetChainHash,
        bytes32 feePolicyDigest
    ) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                engine,
                security,
                partition,
                router,
                quicknetChainHash,
                feePolicyDigest
            )
        );
    }

    /// @notice Hash of the full CREATE2 init code, including immutable arguments.
    function initCodeHash(Config calldata config) public pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                type(SessionAccount).creationCode,
                abi.encode(
                    config.sessionSigner,
                    config.recoverySigner,
                    config.engine,
                    config.security,
                    config.partition,
                    config.router,
                    config.quicknetChainHash,
                    config.generation,
                    config.feePolicyDigest
                )
            )
        );
    }

    /// @notice Hash of the implementation creation code before constructor arguments.
    function creationCodeHash() external pure returns (bytes32) {
        return keccak256(type(SessionAccount).creationCode);
    }

    /// @notice Canonical address for this factory, exact config, and raw salt.
    function accountAddress(Config calldata config, bytes32 salt)
        public
        view
        returns (address)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash(config))
        );
        return address(uint160(uint256(digest)));
    }

    /// @notice True only for a live account deployed here at its calculated address.
    function isCanonical(address account, Config calldata config, bytes32 salt)
        external
        view
        returns (bool)
    {
        return isSessionAccount[account] && account.code.length != 0
            && account == accountAddress(config, salt);
    }

    /// @notice Runtime hash for a deployed canonical account, or zero otherwise.
    function deployedCodeHash(address account) external view returns (bytes32 codeHash) {
        if (!isSessionAccount[account]) return bytes32(0);
        assembly {
            codeHash := extcodehash(account)
        }
    }
}
