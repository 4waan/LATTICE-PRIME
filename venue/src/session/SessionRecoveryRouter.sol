// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

interface ICanonicalSessionFactory {
    function isSessionAccount(address account) external view returns (bool);
}

interface IFixedRecoveryPool {
    function asset() external view returns (address);
    function denomination() external view returns (uint256);
    function deposit(uint256 commitment) external payable returns (uint256 root);
}

interface IRecoveryToken {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @title SessionRecoveryRouter
/// @notice Atomically turns assets from a retiring canonical session into a new
///         fixed-denomination privacy-pool note.
/// @dev The session recovery signature binds the note commitment before this
///      contract is called. This router accepts only canonical SessionAccount
///      callers, the configured security, and the exact released denominations.
///      It has no arbitrary destination or administrative withdrawal surface.
contract SessionRecoveryRouter {
    ICanonicalSessionFactory public immutable factory;
    IRecoveryToken public immutable security;
    IFixedRecoveryPool public immutable hbarPool;
    IFixedRecoveryPool public immutable lprcPool;

    event RecoveryRouted(
        address indexed session,
        address indexed asset,
        uint256 indexed commitment,
        uint256 denomination,
        uint256 root
    );

    error NotCanonicalSession(address caller);
    error InvalidContract(address target);
    error PoolAssetMismatch(address pool, address got, address expected);
    error WrongRecoveryAmount(uint256 got, uint256 expected);
    error WrongRecoveryAsset(address got);
    error TokenBalanceTooLow(uint256 available, uint256 required);
    error TokenApprovalFailed();

    constructor(
        ICanonicalSessionFactory factory_,
        IRecoveryToken security_,
        IFixedRecoveryPool hbarPool_,
        IFixedRecoveryPool lprcPool_
    ) {
        if (address(factory_).code.length == 0) revert InvalidContract(address(factory_));
        if (address(security_).code.length == 0) revert InvalidContract(address(security_));
        if (address(hbarPool_).code.length == 0) revert InvalidContract(address(hbarPool_));
        if (address(lprcPool_).code.length == 0) revert InvalidContract(address(lprcPool_));
        address hbarAsset = hbarPool_.asset();
        if (hbarAsset != address(0)) {
            revert PoolAssetMismatch(address(hbarPool_), hbarAsset, address(0));
        }
        address lprcAsset = lprcPool_.asset();
        if (lprcAsset != address(security_)) {
            revert PoolAssetMismatch(address(lprcPool_), lprcAsset, address(security_));
        }
        factory = factory_;
        security = security_;
        hbarPool = hbarPool_;
        lprcPool = lprcPool_;
    }

    modifier onlyCanonicalSession() {
        if (!factory.isSessionAccount(msg.sender)) {
            revert NotCanonicalSession(msg.sender);
        }
        _;
    }

    function routeNative(uint256 commitment)
        external
        payable
        onlyCanonicalSession
        returns (uint256 root)
    {
        uint256 expected = hbarPool.denomination();
        if (msg.value != expected) revert WrongRecoveryAmount(msg.value, expected);
        root = hbarPool.deposit{value: msg.value}(commitment);
        emit RecoveryRouted(msg.sender, address(0), commitment, msg.value, root);
    }

    function routeToken(address asset, uint256 amount, uint256 commitment)
        external
        onlyCanonicalSession
        returns (uint256 root)
    {
        if (asset != address(security)) revert WrongRecoveryAsset(asset);
        uint256 expected = lprcPool.denomination();
        if (amount != expected) revert WrongRecoveryAmount(amount, expected);
        uint256 available = security.balanceOf(address(this));
        if (available < amount) revert TokenBalanceTooLow(available, amount);
        if (!security.approve(address(lprcPool), amount)) revert TokenApprovalFailed();
        root = lprcPool.deposit(commitment);
        emit RecoveryRouted(msg.sender, asset, commitment, amount, root);
    }
}
