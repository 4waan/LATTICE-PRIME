// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IHoldByPartition} from "../src/interfaces/IHoldByPartition.sol";
import {OrderBook} from "../src/market/OrderBook.sol";
import {ISessionEngine, SessionAccount} from "../src/session/SessionAccount.sol";
import {
    ISessionAccountRegistrationHook,
    SessionAccountFactory
} from "../src/session/SessionAccountFactory.sol";

contract SessionFactoryEngine is ISessionEngine {
    IHoldByPartition private immutable _security;
    bytes32 private immutable _partition;

    constructor(IHoldByPartition security_, bytes32 partition_) {
        _security = security_;
        _partition = partition_;
    }

    function commit(bytes32) external payable override {
        revert("factory only");
    }

    function reveal(OrderBook.Side, uint128, uint128, bytes32, uint256)
        external
        payable
        override
    {
        revert("factory only");
    }

    function cancel(bytes32) external pure override {
        revert("factory only");
    }

    function expire(bytes32) external pure override {
        revert("factory only");
    }

    function withdraw() external pure override {
        revert("factory only");
    }

    function commitmentOf(address, OrderBook.Side, uint128, uint128, bytes32)
        external
        pure
        override
        returns (bytes32)
    {
        return bytes32(0);
    }

    function commitBond() external pure override returns (uint256) {
        return 0.01 ether;
    }

    function commitments(bytes32)
        external
        pure
        override
        returns (address, uint64, bool, bool, uint256)
    {
        return (address(0), 0, false, false, 0);
    }

    function revealDelay() external pure override returns (uint64) {
        return 5 minutes;
    }

    function revealWindow() external pure override returns (uint64) {
        return 30 minutes;
    }

    function roundLength() external pure override returns (uint64) {
        return 5 minutes;
    }

    function restRounds() external pure override returns (uint64) {
        return 7;
    }

    function genesis() external pure override returns (uint64) {
        return 2_000_000_000;
    }

    function security() external view override returns (IHoldByPartition) {
        return _security;
    }

    function partition() external view override returns (bytes32) {
        return _partition;
    }
}

contract SessionRegistrationHook is ISessionAccountRegistrationHook {
    address public registered;
    bytes public registrationData;

    function registerSessionAccount(address account, bytes calldata data) external override {
        registered = account;
        registrationData = data;
    }
}

contract RevertingSessionRegistrationHook is ISessionAccountRegistrationHook {
    error RegistrationRefused();

    function registerSessionAccount(address, bytes calldata) external pure override {
        revert RegistrationRefused();
    }
}

contract SessionFactoryRouter {
    receive() external payable {}
}

contract SessionAccountFactoryTest is Test {
    uint256 internal constant SESSION_KEY = 0xA11CE;
    uint256 internal constant RECOVERY_KEY = 0xB0B;
    bytes32 internal constant PARTITION = bytes32(uint256(9));
    bytes32 internal constant QUICKNET_CHAIN_HASH =
        0x52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971;
    bytes32 internal constant FEE_POLICY =
        0xd74242b49f657e09305d83d2f31d1f2437e492538673004b14e948ba7a701037;

    address internal constant TOKEN = address(0x3333333333333333333333333333333333333333);

    SessionAccountFactory internal factory;
    SessionFactoryEngine internal engine;
    SessionFactoryRouter internal router;
    SessionAccountFactory.Config internal config;

    function setUp() public {
        vm.chainId(296);
        vm.warp(2_000_000_000);
        factory = new SessionAccountFactory();
        engine = new SessionFactoryEngine(IHoldByPartition(TOKEN), PARTITION);
        router = new SessionFactoryRouter();
        config = SessionAccountFactory.Config({
            sessionSigner: vm.addr(SESSION_KEY),
            recoverySigner: vm.addr(RECOVERY_KEY),
            engine: ISessionEngine(address(engine)),
            security: IHoldByPartition(TOKEN),
            partition: PARTITION,
            router: payable(address(router)),
            quicknetChainHash: QUICKNET_CHAIN_HASH,
            generation: 3,
            feePolicyDigest: FEE_POLICY
        });
        factory.setVenueConfigApproval(_venueConfig(), true);
    }

    function test_create2AddressIsCanonicalAndDeploymentIsPrefunded() public {
        bytes32 salt = keccak256("caller random salt");
        address predicted = factory.accountAddress(config, salt);

        vm.deal(address(0xBEEF), 4 ether);
        vm.prank(address(0xBEEF));
        SessionAccount deployed = factory.deploy{value: 4 ether}(config, salt);

        assertEq(address(deployed), predicted);
        assertEq(address(deployed).balance, 4 ether);
        assertTrue(factory.isSessionAccount(predicted));
        assertTrue(factory.isCanonical(predicted, config, salt));
        assertEq(deployed.sessionSigner(), config.sessionSigner);
        assertEq(deployed.recoverySigner(), config.recoverySigner);
        assertEq(address(deployed.engine()), address(config.engine));
        assertEq(address(deployed.security()), address(config.security));
        assertEq(deployed.partition(), PARTITION);
        assertEq(address(deployed.router()), address(router));
        assertEq(deployed.quicknetChainHash(), QUICKNET_CHAIN_HASH);
        assertEq(deployed.generation(), 3);
        assertEq(deployed.feePolicyDigest(), FEE_POLICY);
        assertEq(factory.deployedCodeHash(predicted), predicted.codehash);
    }

    function test_create2SaltIsNotCallerNamespaced() public {
        bytes32 salt = keccak256("same browser salt");
        address beforeCaller = factory.accountAddress(config, salt);

        vm.prank(address(0xAAAA));
        address afterCaller = factory.accountAddress(config, salt);
        assertEq(beforeCaller, afterCaller);

        address anotherSalt = factory.accountAddress(config, bytes32(uint256(salt) + 1));
        assertTrue(anotherSalt != beforeCaller);
    }

    function test_create2CollisionIsPermanent() public {
        bytes32 salt = keccak256("collision");
        address predicted = factory.accountAddress(config, salt);
        factory.deploy(config, salt);

        vm.expectRevert(
            abi.encodeWithSelector(
                SessionAccountFactory.AccountAlreadyDeployed.selector, predicted
            )
        );
        factory.deploy(config, salt);
    }

    function test_factoryCannotDeployAnAccountForAnotherDrandChain() public {
        config.quicknetChainHash = bytes32(uint256(1));
        factory.setVenueConfigApproval(_venueConfig(), true);
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionAccount.WrongQuicknetChainHash.selector, bytes32(uint256(1))
            )
        );
        factory.deploy(config, keccak256("wrong drand chain"));
    }

    function test_factoryCannotConfigureAConnectedWalletAsRouter() public {
        address payable wallet = payable(address(0xCAFE));
        config.router = wallet;
        factory.setVenueConfigApproval(_venueConfig(), true);
        vm.expectRevert(abi.encodeWithSelector(SessionAccount.RouterHasNoCode.selector, wallet));
        factory.deploy(config, keccak256("wallet is not a router"));
    }

    function test_onlyGovernanceApprovedVenueConfigurationCanDeploy() public {
        config.feePolicyDigest = keccak256("unapproved policy");
        bytes32 digest = factory.accountVenueConfigDigest(config);
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionAccountFactory.VenueConfigNotApproved.selector, digest
            )
        );
        factory.deploy(config, keccak256("unapproved config"));

        vm.prank(address(0xBAD));
        vm.expectRevert(SessionAccountFactory.NotAdmin.selector);
        factory.setVenueConfigApproval(_venueConfig(), true);
    }

    function test_initCodeHashAndAddressFollowEip1014() public view {
        bytes32 expectedInitHash = keccak256(
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
        assertEq(factory.initCodeHash(config), expectedInitHash);
        assertEq(factory.creationCodeHash(), keccak256(type(SessionAccount).creationCode));

        bytes32 salt = keccak256("eip-1014");
        address expected = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(factory), salt, expectedInitHash)
                    )
                )
            )
        );
        assertEq(factory.accountAddress(config, salt), expected);
    }

    function test_optionalRegistrationHookRunsAtomically() public {
        SessionRegistrationHook hook = new SessionRegistrationHook();
        bytes memory proof = abi.encode(bytes32(uint256(1)), bytes32(uint256(2)));
        bytes32 salt = keccak256("registered");
        address predicted = factory.accountAddress(config, salt);

        SessionAccount deployed = factory.deployAndRegister(config, salt, hook, proof);

        assertEq(address(deployed), predicted);
        assertEq(hook.registered(), predicted);
        assertEq(hook.registrationData(), proof);
        assertTrue(factory.isSessionAccount(predicted));
    }

    function test_failedRegistrationRollsBackDeploymentAndCanRetry() public {
        RevertingSessionRegistrationHook hook = new RevertingSessionRegistrationHook();
        bytes32 salt = keccak256("atomic registration");
        address predicted = factory.accountAddress(config, salt);

        vm.expectRevert(RevertingSessionRegistrationHook.RegistrationRefused.selector);
        factory.deployAndRegister(config, salt, hook, bytes("proof"));

        assertEq(predicted.code.length, 0);
        assertFalse(factory.isSessionAccount(predicted));

        SessionAccount deployed = factory.deploy(config, salt);
        assertEq(address(deployed), predicted);
    }

    function _venueConfig()
        private
        view
        returns (SessionAccountFactory.VenueConfig memory)
    {
        return SessionAccountFactory.VenueConfig({
            engine: config.engine,
            security: config.security,
            partition: config.partition,
            router: config.router,
            quicknetChainHash: config.quicknetChainHash,
            feePolicyDigest: config.feePolicyDigest
        });
    }
}
