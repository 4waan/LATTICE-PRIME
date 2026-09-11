// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IHoldByPartition} from "../src/interfaces/IHoldByPartition.sol";
import {IPlonkVerifier} from "../src/kyc/IPlonkVerifier.sol";
import {ZkKycRegistry} from "../src/kyc/ZkKycRegistry.sol";
import {
    IPoseidon2,
    IRouterKycRegistry,
    IRouterSessionFactory,
    IAtsRouterToken
} from "../src/router/IRouterDependencies.sol";
import {
    IFixedWithdrawalVerifier,
    IFixedWithdrawalComplianceVerifier
} from "../src/router/IRouterVerifiers.sol";
import {FixedDenominationRouter} from "../src/router/FixedDenominationRouter.sol";
import {
    FixedWithdrawalComplianceVerifier
} from "../src/router/FixedWithdrawalComplianceVerifier.sol";
import {FixedWithdrawalVerifier} from "../src/router/FixedWithdrawalVerifier.sol";
import {HbarFixedDenominationRouter} from "../src/router/HbarFixedDenominationRouter.sol";
import {LprcFixedDenominationRouter} from "../src/router/LprcFixedDenominationRouter.sol";
import {
    DualRegistrationGate,
    ISessionFactoryEligibility
} from "../src/session/DualRegistrationGate.sol";
import {ISessionComplianceVerifier} from "../src/session/ISessionComplianceVerifier.sol";
import {ISessionEligibilityVerifier} from "../src/session/ISessionEligibilityVerifier.sol";
import {ISessionEngine, SessionAccount} from "../src/session/SessionAccount.sol";
import {SessionAccountFactory} from "../src/session/SessionAccountFactory.sol";
import {SessionComplianceVerifier} from "../src/session/SessionComplianceVerifier.sol";
import {SessionEligibilityVerifier} from "../src/session/SessionEligibilityVerifier.sol";
import {
    ICanonicalSessionFactory,
    IFixedRecoveryPool,
    IRecoveryToken,
    SessionRecoveryRouter
} from "../src/session/SessionRecoveryRouter.sol";

/// @title DeployPrivateTrading
/// @notice Deploys a Hedera testnet private-trading candidate and wires it once.
/// @dev This script deliberately does not activate the LPRC pool. Its one-time
///      activation needs an evidence hash produced against the deployed pool.
///      It also does not write any deployment or release file.
contract DeployPrivateTrading is Script {
    uint256 internal constant HEDERA_TESTNET_CHAIN_ID = 296;
    uint32 internal constant MINIMUM_ROUTING_NOTES = 8;
    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    bytes32 internal constant QUICKNET_CHAIN_HASH =
        0x52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971;

    struct Inputs {
        uint256 deployKey;
        uint256 adminKey;
        uint256 issuerKey;
        address deployer;
        address admin;
        address issuer;
        address relayer;
        address sessionSigner;
        address recoverySigner;
        ISessionEngine engine;
        IAtsRouterToken security;
        ZkKycRegistry registry;
        IPlonkVerifier manualVerifier;
        IPoseidon2 poseidon;
        bytes32 poseidonCodeHash;
        bytes32 partition;
        bytes32 feePolicyDigest;
        bytes32 accountSalt;
        uint64 generation;
        uint64 activationEpoch;
        uint256 manualRoot;
        uint256 sessionRoot;
        uint256 minTier;
        uint256 jurisdictionMask;
        uint256 hbarDenomination;
        uint256 lprcDenomination;
        uint64 minimumWithdrawalDelay;
        uint64 maximumRootAge;
        uint32 minimumRealNotes;
        uint64 viewKeyEpoch;
        uint256 viewKeyX;
        uint256 viewKeyY;
        uint64 lprcHoldDuration;
    }

    struct Deployment {
        SessionEligibilityVerifier sessionEligibilityVerifier;
        SessionComplianceVerifier sessionComplianceVerifier;
        FixedWithdrawalVerifier withdrawalVerifier;
        FixedWithdrawalComplianceVerifier withdrawalComplianceVerifier;
        SessionAccountFactory factory;
        DualRegistrationGate gate;
        HbarFixedDenominationRouter hbarPool;
        LprcFixedDenominationRouter lprcPool;
        SessionRecoveryRouter recoveryRouter;
        SessionAccount canarySession;
    }

    error WrongChain(uint256 got, uint256 expected);
    error MissingCode(address target);
    error AddressMismatch(address got, address expected);
    error Bytes32Mismatch(bytes32 got, bytes32 expected);
    error UintMismatch(uint256 got, uint256 expected);
    error InvalidRoleSeparation(address role);
    error InvalidConfiguration();
    error PendingGateExists(address pendingGate);
    error RuntimeCodeHashMismatch(address target, bytes32 got, bytes32 expected);
    error WiringFailed();

    function run() external {
        if (block.chainid != HEDERA_TESTNET_CHAIN_ID) {
            revert WrongChain(block.chainid, HEDERA_TESTNET_CHAIN_ID);
        }

        Inputs memory input = _inputs();
        _preflight(input);

        Deployment memory deployed;
        vm.startBroadcast(input.deployKey);
        deployed.sessionEligibilityVerifier = new SessionEligibilityVerifier();
        deployed.sessionComplianceVerifier = new SessionComplianceVerifier();
        deployed.withdrawalVerifier = new FixedWithdrawalVerifier();
        deployed.withdrawalComplianceVerifier = new FixedWithdrawalComplianceVerifier();
        deployed.factory = new SessionAccountFactory();
        deployed.gate = _deployGate(input, deployed);
        deployed.hbarPool = _deployHbarPool(input, deployed);
        deployed.lprcPool = _deployLprcPool(input, deployed);

        // Both pools must exist before the recovery router can validate their
        // asset bindings in its constructor.
        deployed.recoveryRouter = new SessionRecoveryRouter(
            ICanonicalSessionFactory(address(deployed.factory)),
            IRecoveryToken(address(input.security)),
            IFixedRecoveryPool(address(deployed.hbarPool)),
            IFixedRecoveryPool(address(deployed.lprcPool))
        );

        // The exact venue tuple contains the recovery router. Approval therefore
        // cannot happen before the router, and the canonical account cannot be
        // deployed before approval.
        SessionAccountFactory.VenueConfig memory venueConfig =
            _venueConfig(input, deployed.recoveryRouter);
        deployed.factory.setVenueConfigApproval(venueConfig, true);
        SessionAccountFactory.Config memory accountConfig =
            _accountConfig(input, deployed.recoveryRouter);
        deployed.canarySession = deployed.factory.deploy(accountConfig, input.accountSalt);
        vm.stopBroadcast();

        _wireRegistry(input, deployed.gate);
        _publishRoots(input, deployed.gate);
        _verify(input, deployed, venueConfig, accountConfig);
        _emitMachineReadable(input, deployed, venueConfig);
    }

    function _inputs() private view returns (Inputs memory input) {
        input.deployKey = vm.envUint("PRIVATE_TRADING_DEPLOY_KEY");
        input.adminKey = vm.envUint("PRIVATE_TRADING_ADMIN_KEY");
        input.issuerKey = vm.envUint("PRIVATE_TRADING_ISSUER_KEY");
        input.deployer = vm.addr(input.deployKey);
        input.admin = vm.addr(input.adminKey);
        input.issuer = vm.addr(input.issuerKey);
        input.relayer = vm.envAddress("PRIVATE_TRADING_RELAYER_ADDRESS");
        input.sessionSigner = vm.envAddress("PRIVATE_TRADING_CANARY_SESSION_SIGNER");
        input.recoverySigner = vm.envAddress("PRIVATE_TRADING_CANARY_RECOVERY_SIGNER");

        input.engine = ISessionEngine(vm.envAddress("VENUE_ENGINE"));
        input.security = IAtsRouterToken(vm.envAddress("ATS_TOKEN"));
        input.registry = ZkKycRegistry(vm.envAddress("ZK_KYC_REGISTRY"));
        input.manualVerifier = IPlonkVerifier(vm.envAddress("KYC_VERIFIER"));
        input.poseidon = IPoseidon2(vm.envAddress("PRIVATE_TRADING_POSEIDON2"));
        input.poseidonCodeHash = vm.envBytes32("PRIVATE_TRADING_POSEIDON2_CODE_HASH");
        input.partition = vm.envBytes32("PRIVATE_TRADING_PARTITION");
        input.feePolicyDigest = vm.envBytes32("PRIVATE_TRADING_FEE_POLICY_DIGEST");
        input.accountSalt = vm.envBytes32("PRIVATE_TRADING_CANARY_ACCOUNT_SALT");
        input.generation = uint64(vm.envUint("PRIVATE_TRADING_GENERATION"));

        bytes32 configuredQuicknet = vm.envBytes32("PRIVATE_TRADING_QUICKNET_CHAIN_HASH");
        if (configuredQuicknet != QUICKNET_CHAIN_HASH) {
            revert Bytes32Mismatch(configuredQuicknet, QUICKNET_CHAIN_HASH);
        }

        input.activationEpoch = uint64(vm.envUint("PRIVATE_TRADING_ACTIVATION_EPOCH"));
        input.manualRoot = vm.envUint("PRIVATE_TRADING_MANUAL_ROOT");
        input.sessionRoot = vm.envUint("PRIVATE_TRADING_SESSION_ROOT");
        input.minTier = vm.envUint("PRIVATE_TRADING_MIN_TIER");
        input.jurisdictionMask = vm.envUint("PRIVATE_TRADING_JURISDICTION_MASK");
        input.hbarDenomination = vm.envUint("PRIVATE_TRADING_HBAR_DENOMINATION_TINYBAR");
        input.lprcDenomination = vm.envUint("PRIVATE_TRADING_LPRC_DENOMINATION");
        input.minimumWithdrawalDelay =
            uint64(vm.envUint("PRIVATE_TRADING_MINIMUM_WITHDRAWAL_DELAY"));
        input.maximumRootAge = uint64(vm.envUint("PRIVATE_TRADING_MAXIMUM_ROOT_AGE"));
        input.minimumRealNotes = uint32(vm.envUint("PRIVATE_TRADING_MINIMUM_REAL_NOTES"));
        input.viewKeyEpoch = uint64(vm.envUint("PRIVATE_TRADING_VIEW_KEY_EPOCH"));
        input.viewKeyX = vm.envUint("PRIVATE_TRADING_VIEW_KEY_X");
        input.viewKeyY = vm.envUint("PRIVATE_TRADING_VIEW_KEY_Y");
        input.lprcHoldDuration = uint64(vm.envUint("PRIVATE_TRADING_LPRC_HOLD_DURATION"));
    }

    function _preflight(Inputs memory input) private view {
        _requireCode(address(input.engine));
        _requireCode(address(input.security));
        _requireCode(address(input.registry));
        _requireCode(address(input.manualVerifier));
        _requireCode(address(input.poseidon));

        _requireAddress(address(input.engine.security()), address(input.security));
        _requireBytes32(input.engine.partition(), input.partition);
        _requireAddress(input.registry.admin(), input.admin);
        if (input.registry.pendingGate() != address(0)) {
            revert PendingGateExists(input.registry.pendingGate());
        }

        bytes32 poseidonRuntimeHash;
        address poseidonAddress = address(input.poseidon);
        assembly {
            poseidonRuntimeHash := extcodehash(poseidonAddress)
        }
        if (poseidonRuntimeHash != input.poseidonCodeHash) {
            revert RuntimeCodeHashMismatch(
                poseidonAddress, poseidonRuntimeHash, input.poseidonCodeHash
            );
        }

        address[6] memory roles = [
            input.deployer,
            input.admin,
            input.issuer,
            input.relayer,
            input.sessionSigner,
            input.recoverySigner
        ];
        for (uint256 i = 0; i < roles.length; ++i) {
            if (roles[i] == address(0)) revert InvalidRoleSeparation(roles[i]);
            for (uint256 j = i + 1; j < roles.length; ++j) {
                if (roles[i] == roles[j]) revert InvalidRoleSeparation(roles[i]);
            }
        }

        uint64 expectedActivationEpoch = input.registry.currentEpoch();
        if (input.registry.gate() != address(0)) expectedActivationEpoch += 1;
        if (input.activationEpoch != expectedActivationEpoch) {
            revert UintMismatch(input.activationEpoch, expectedActivationEpoch);
        }

        if (
            input.feePolicyDigest == bytes32(0) || input.accountSalt == bytes32(0)
                || input.generation == 0 || input.manualRoot == 0 || input.sessionRoot == 0
                || input.manualRoot >= SNARK_SCALAR_FIELD
                || input.sessionRoot >= SNARK_SCALAR_FIELD || input.hbarDenomination == 0
                || input.hbarDenomination >= SNARK_SCALAR_FIELD || input.lprcDenomination == 0
                || input.lprcDenomination >= SNARK_SCALAR_FIELD
                || input.minimumWithdrawalDelay == 0
                || input.maximumRootAge <= input.minimumWithdrawalDelay
                || input.minimumRealNotes < MINIMUM_ROUTING_NOTES
                || input.viewKeyX >= SNARK_SCALAR_FIELD || input.viewKeyY >= SNARK_SCALAR_FIELD
                || input.lprcHoldDuration == 0
        ) {
            revert InvalidConfiguration();
        }
    }

    function _deployGate(Inputs memory input, Deployment memory deployed)
        private
        returns (DualRegistrationGate)
    {
        return new DualRegistrationGate(
            input.manualVerifier,
            ISessionEligibilityVerifier(address(deployed.sessionEligibilityVerifier)),
            ISessionComplianceVerifier(address(deployed.sessionComplianceVerifier)),
            input.registry,
            input.issuer,
            ISessionFactoryEligibility(address(deployed.factory)),
            input.minTier,
            input.jurisdictionMask
        );
    }

    function _deployHbarPool(Inputs memory input, Deployment memory deployed)
        private
        returns (HbarFixedDenominationRouter)
    {
        HbarFixedDenominationRouter.Config memory config =
            HbarFixedDenominationRouter.Config({
                admin: input.admin,
                denomination: input.hbarDenomination,
                minimumWithdrawalDelay: input.minimumWithdrawalDelay,
                maximumRootAge: input.maximumRootAge,
                minimumRealNotes: input.minimumRealNotes,
                viewKeyEpoch: input.viewKeyEpoch,
                viewKeyX: input.viewKeyX,
                viewKeyY: input.viewKeyY
            });
        return new HbarFixedDenominationRouter(
            IFixedWithdrawalVerifier(address(deployed.withdrawalVerifier)),
            IFixedWithdrawalComplianceVerifier(address(deployed.withdrawalComplianceVerifier)),
            input.poseidon,
            IRouterKycRegistry(address(input.registry)),
            IRouterSessionFactory(address(deployed.factory)),
            config
        );
    }

    function _deployLprcPool(Inputs memory input, Deployment memory deployed)
        private
        returns (LprcFixedDenominationRouter)
    {
        LprcFixedDenominationRouter.Config memory config =
            LprcFixedDenominationRouter.Config({
                admin: input.admin,
                security: input.security,
                partition: input.partition,
                denomination: input.lprcDenomination,
                minimumWithdrawalDelay: input.minimumWithdrawalDelay,
                maximumRootAge: input.maximumRootAge,
                minimumRealNotes: input.minimumRealNotes,
                viewKeyEpoch: input.viewKeyEpoch,
                viewKeyX: input.viewKeyX,
                viewKeyY: input.viewKeyY,
                holdDuration: input.lprcHoldDuration
            });
        return new LprcFixedDenominationRouter(
            IFixedWithdrawalVerifier(address(deployed.withdrawalVerifier)),
            IFixedWithdrawalComplianceVerifier(address(deployed.withdrawalComplianceVerifier)),
            input.poseidon,
            IRouterKycRegistry(address(input.registry)),
            IRouterSessionFactory(address(deployed.factory)),
            config
        );
    }

    function _venueConfig(Inputs memory input, SessionRecoveryRouter router)
        private
        pure
        returns (SessionAccountFactory.VenueConfig memory)
    {
        return SessionAccountFactory.VenueConfig({
            engine: input.engine,
            security: IHoldByPartition(address(input.security)),
            partition: input.partition,
            router: payable(address(router)),
            quicknetChainHash: QUICKNET_CHAIN_HASH,
            feePolicyDigest: input.feePolicyDigest
        });
    }

    function _accountConfig(Inputs memory input, SessionRecoveryRouter router)
        private
        pure
        returns (SessionAccountFactory.Config memory)
    {
        return SessionAccountFactory.Config({
            sessionSigner: input.sessionSigner,
            recoverySigner: input.recoverySigner,
            engine: input.engine,
            security: IHoldByPartition(address(input.security)),
            partition: input.partition,
            router: payable(address(router)),
            quicknetChainHash: QUICKNET_CHAIN_HASH,
            generation: input.generation,
            feePolicyDigest: input.feePolicyDigest
        });
    }

    function _wireRegistry(Inputs memory input, DualRegistrationGate gate) private {
        vm.startBroadcast(input.adminKey);
        if (input.registry.gate() == address(0)) {
            input.registry.bootstrapGate(address(gate));
        } else {
            input.registry.proposeGate(address(gate));
        }
        vm.stopBroadcast();
    }

    function _publishRoots(Inputs memory input, DualRegistrationGate gate) private {
        vm.startBroadcast(input.issuerKey);
        gate.publishViewKey(input.viewKeyEpoch, input.viewKeyX, input.viewKeyY);
        gate.publishRoot(input.activationEpoch, input.manualRoot);
        gate.publishSessionRoot(input.activationEpoch, input.sessionRoot, input.viewKeyEpoch);
        vm.stopBroadcast();
    }

    function _verify(
        Inputs memory input,
        Deployment memory deployed,
        SessionAccountFactory.VenueConfig memory venueConfig,
        SessionAccountFactory.Config memory accountConfig
    ) private view {
        _requireDeploymentCode(deployed);

        _requireAddress(deployed.factory.admin(), input.deployer);
        bytes32 creationCodeHash = keccak256(type(SessionAccount).creationCode);
        _requireBytes32(deployed.factory.creationCodeHash(), creationCodeHash);
        bytes32 venueDigest = deployed.factory.venueConfigDigest(venueConfig);
        if (!deployed.factory.approvedVenueConfig(venueDigest)) revert WiringFailed();
        if (!deployed.factory.isSessionAccount(address(deployed.canarySession))) {
            revert WiringFailed();
        }
        if (!deployed.factory
                .isCanonical(address(deployed.canarySession), accountConfig, input.accountSalt))
        {
            revert WiringFailed();
        }

        _requireAddress(address(deployed.gate.manualVerifier()), address(input.manualVerifier));
        _requireAddress(
            address(deployed.gate.sessionEligibilityVerifier()),
            address(deployed.sessionEligibilityVerifier)
        );
        _requireAddress(
            address(deployed.gate.sessionComplianceVerifier()),
            address(deployed.sessionComplianceVerifier)
        );
        _requireAddress(address(deployed.gate.registry()), address(input.registry));
        _requireAddress(deployed.gate.issuer(), input.issuer);
        _requireAddress(address(deployed.gate.sessionFactory()), address(deployed.factory));
        _requireUint(deployed.gate.minTier(), input.minTier);
        _requireUint(deployed.gate.jurisdictionMask(), input.jurisdictionMask);
        _requireBytes32(deployed.gate.sessionImplementationCodeHash(), creationCodeHash);
        _requireUint(
            deployed.gate.sessionImplementationCodeHashLow(),
            uint256(uint128(uint256(creationCodeHash)))
        );
        _requireUint(
            deployed.gate.sessionImplementationCodeHashHigh(), uint256(creationCodeHash) >> 128
        );
        _requireUint(deployed.gate.rootForEpoch(input.activationEpoch), input.manualRoot);
        _requireUint(
            deployed.gate.sessionRootForEpoch(input.activationEpoch), input.sessionRoot
        );
        _requireUint(
            deployed.gate.viewKeyEpochForRotationEpoch(input.activationEpoch),
            input.viewKeyEpoch
        );
        (uint256 viewX, uint256 viewY, bool viewPublished) =
            deployed.gate.viewKeyForEpoch(input.viewKeyEpoch);
        if (!viewPublished) revert WiringFailed();
        _requireUint(viewX, input.viewKeyX);
        _requireUint(viewY, input.viewKeyY);

        _verifyPoolDependencies(
            input, deployed, deployed.hbarPool, address(0), input.hbarDenomination
        );
        _verifyPoolDependencies(
            input, deployed, deployed.lprcPool, address(input.security), input.lprcDenomination
        );
        _requireAddress(address(deployed.lprcPool.security()), address(input.security));
        _requireBytes32(deployed.lprcPool.partition(), input.partition);
        _requireUint(deployed.lprcPool.holdDuration(), input.lprcHoldDuration);
        _requireBytes32(deployed.lprcPool.atsCanaryEvidenceHash(), bytes32(0));

        _requireAddress(address(deployed.recoveryRouter.factory()), address(deployed.factory));
        _requireAddress(address(deployed.recoveryRouter.security()), address(input.security));
        _requireAddress(address(deployed.recoveryRouter.hbarPool()), address(deployed.hbarPool));
        _requireAddress(address(deployed.recoveryRouter.lprcPool()), address(deployed.lprcPool));

        _verifyCanarySession(input, deployed);
        if (input.registry.gate() == address(deployed.gate)) {
            _requireUint(input.registry.currentEpoch(), input.activationEpoch);
        } else {
            _requireAddress(input.registry.pendingGate(), address(deployed.gate));
            _requireUint(input.registry.pendingGateEpoch(), input.activationEpoch);
        }
    }

    function _verifyPoolDependencies(
        Inputs memory input,
        Deployment memory deployed,
        FixedDenominationRouter pool,
        address expectedAsset,
        uint256 expectedDenomination
    ) private view {
        _requireAddress(
            address(pool.withdrawalVerifier()), address(deployed.withdrawalVerifier)
        );
        _requireAddress(
            address(pool.complianceVerifier()), address(deployed.withdrawalComplianceVerifier)
        );
        _requireAddress(address(pool.poseidon()), address(input.poseidon));
        _requireBytes32(pool.poseidonRuntimeCodeHash(), input.poseidonCodeHash);
        _requireAddress(address(pool.registry()), address(input.registry));
        _requireAddress(address(pool.sessionFactory()), address(deployed.factory));
        _requireAddress(pool.admin(), input.admin);
        _requireAddress(pool.asset(), expectedAsset);
        _requireUint(pool.denomination(), expectedDenomination);
        _requireUint(pool.minimumWithdrawalDelay(), input.minimumWithdrawalDelay);
        _requireUint(pool.maximumRootAge(), input.maximumRootAge);
        _requireUint(pool.minimumRealNotes(), input.minimumRealNotes);
        _requireUint(pool.activeViewKeyEpoch(), input.viewKeyEpoch);
        _requireUint(pool.activeViewKeyX(), input.viewKeyX);
        _requireUint(pool.activeViewKeyY(), input.viewKeyY);
        _requireUint(pool.deploymentChainId(), HEDERA_TESTNET_CHAIN_ID);
    }

    function _verifyCanarySession(Inputs memory input, Deployment memory deployed)
        private
        view
    {
        SessionAccount account = deployed.canarySession;
        _requireAddress(account.sessionSigner(), input.sessionSigner);
        _requireAddress(account.recoverySigner(), input.recoverySigner);
        _requireAddress(address(account.engine()), address(input.engine));
        _requireAddress(address(account.security()), address(input.security));
        _requireBytes32(account.partition(), input.partition);
        _requireAddress(address(account.router()), address(deployed.recoveryRouter));
        _requireBytes32(account.quicknetChainHash(), QUICKNET_CHAIN_HASH);
        _requireUint(account.generation(), input.generation);
        _requireBytes32(account.feePolicyDigest(), input.feePolicyDigest);
        _requireUint(account.engineCommitBond(), input.engine.commitBond());
        _requireUint(account.engineRevealDelay(), input.engine.revealDelay());
        _requireUint(account.engineRevealWindow(), input.engine.revealWindow());
        _requireUint(account.engineRoundLength(), input.engine.roundLength());
        _requireUint(account.engineRestRounds(), input.engine.restRounds());
        _requireUint(account.engineGenesis(), input.engine.genesis());
    }

    function _requireDeploymentCode(Deployment memory deployed) private view {
        _requireCode(address(deployed.sessionEligibilityVerifier));
        _requireCode(address(deployed.sessionComplianceVerifier));
        _requireCode(address(deployed.withdrawalVerifier));
        _requireCode(address(deployed.withdrawalComplianceVerifier));
        _requireCode(address(deployed.factory));
        _requireCode(address(deployed.gate));
        _requireCode(address(deployed.hbarPool));
        _requireCode(address(deployed.lprcPool));
        _requireCode(address(deployed.recoveryRouter));
        _requireCode(address(deployed.canarySession));
    }

    function _emitMachineReadable(
        Inputs memory input,
        Deployment memory deployed,
        SessionAccountFactory.VenueConfig memory venueConfig
    ) private {
        string memory objectKey = "privateTradingCandidate";
        vm.serializeUint(objectKey, "chainId", block.chainid);
        vm.serializeAddress(objectKey, "deployer", input.deployer);
        vm.serializeAddress(objectKey, "admin", input.admin);
        vm.serializeAddress(objectKey, "issuer", input.issuer);
        vm.serializeAddress(objectKey, "relayer", input.relayer);
        vm.serializeAddress(objectKey, "CanarySessionAccount", address(deployed.canarySession));
        vm.serializeAddress(objectKey, "SessionAccountFactory", address(deployed.factory));
        vm.serializeAddress(objectKey, "DualRegistrationGate", address(deployed.gate));
        vm.serializeAddress(
            objectKey,
            "SessionEligibilityVerifier",
            address(deployed.sessionEligibilityVerifier)
        );
        vm.serializeAddress(
            objectKey, "SessionComplianceVerifier", address(deployed.sessionComplianceVerifier)
        );
        vm.serializeAddress(
            objectKey, "FixedWithdrawalVerifier", address(deployed.withdrawalVerifier)
        );
        vm.serializeAddress(
            objectKey,
            "FixedWithdrawalComplianceVerifier",
            address(deployed.withdrawalComplianceVerifier)
        );
        vm.serializeAddress(objectKey, "HbarRouter", address(deployed.hbarPool));
        vm.serializeAddress(objectKey, "LprcRouter", address(deployed.lprcPool));
        vm.serializeAddress(
            objectKey, "SessionRecoveryRouter", address(deployed.recoveryRouter)
        );
        vm.serializeAddress(objectKey, "engine", address(input.engine));
        vm.serializeAddress(objectKey, "security", address(input.security));
        vm.serializeAddress(objectKey, "registry", address(input.registry));
        vm.serializeAddress(objectKey, "poseidon2", address(input.poseidon));
        vm.serializeBytes32(objectKey, "partition", input.partition);
        vm.serializeBytes32(objectKey, "feePolicyDigest", input.feePolicyDigest);
        vm.serializeBytes32(objectKey, "quicknetChainHash", QUICKNET_CHAIN_HASH);
        vm.serializeBytes32(
            objectKey, "venueConfigDigest", deployed.factory.venueConfigDigest(venueConfig)
        );
        vm.serializeUint(objectKey, "activationEpoch", input.activationEpoch);
        vm.serializeUint(objectKey, "generation", input.generation);
        vm.serializeUint(objectKey, "hbarDenominationTinybar", input.hbarDenomination);
        vm.serializeUint(objectKey, "lprcDenomination", input.lprcDenomination);
        vm.serializeUint(objectKey, "engineRevealDelay", input.engine.revealDelay());
        vm.serializeUint(objectKey, "engineRevealWindow", input.engine.revealWindow());
        vm.serializeUint(objectKey, "minimumWithdrawalDelay", input.minimumWithdrawalDelay);
        vm.serializeUint(objectKey, "maximumRootAge", input.maximumRootAge);
        string memory json =
            vm.serializeUint(objectKey, "minimumRealNotes", input.minimumRealNotes);
        console2.log(string.concat("PRIVATE_TRADING_DEPLOYMENT_JSON=", json));
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert MissingCode(target);
    }

    function _requireAddress(address got, address expected) private pure {
        if (got != expected) revert AddressMismatch(got, expected);
    }

    function _requireBytes32(bytes32 got, bytes32 expected) private pure {
        if (got != expected) revert Bytes32Mismatch(got, expected);
    }

    function _requireUint(uint256 got, uint256 expected) private pure {
        if (got != expected) revert UintMismatch(got, expected);
    }
}
