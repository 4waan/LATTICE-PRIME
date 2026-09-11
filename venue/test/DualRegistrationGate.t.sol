// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IPlonkVerifier} from "../src/kyc/IPlonkVerifier.sol";
import {KycVerifier} from "../src/kyc/KycVerifier.sol";
import {ZkKycRegistry} from "../src/kyc/ZkKycRegistry.sol";
import {IKyc} from "../src/interfaces/IKyc.sol";
import {IHoldByPartition, IHoldTypes} from "../src/interfaces/IHoldByPartition.sol";
import {
    DualRegistrationGate,
    ISessionFactoryEligibility
} from "../src/session/DualRegistrationGate.sol";
import {ISessionEligibilityVerifier} from "../src/session/ISessionEligibilityVerifier.sol";
import {ISessionComplianceVerifier} from "../src/session/ISessionComplianceVerifier.sol";
import {SessionAccountFactory} from "../src/session/SessionAccountFactory.sol";
import {ISessionEngine, SessionAccount} from "../src/session/SessionAccount.sol";

contract ManualVerifierStub is IPlonkVerifier {
    bool public answer = true;

    function setAnswer(bool next) external {
        answer = next;
    }

    function verifyProof(uint256[24] calldata, uint256[7] calldata)
        external
        view
        returns (bool)
    {
        return answer;
    }
}

contract EligibilityVerifierStub is ISessionEligibilityVerifier {
    bool public answer = true;

    function setAnswer(bool next) external {
        answer = next;
    }

    function verifyProof(uint256[24] calldata, uint256[12] calldata)
        external
        view
        returns (bool)
    {
        return answer;
    }
}

contract ComplianceVerifierStub is ISessionComplianceVerifier {
    bool public answer = true;

    function setAnswer(bool next) external {
        answer = next;
    }

    function verifyProof(uint256[24] calldata, uint256[17] calldata)
        external
        view
        returns (bool)
    {
        return answer;
    }
}

contract GateHoldStub is IHoldByPartition {
    function createHoldByPartition(bytes32, IHoldTypes.Hold calldata)
        external
        pure
        returns (bool, uint256)
    {
        return (true, 1);
    }

    function createHoldFromByPartition(
        bytes32,
        address,
        IHoldTypes.Hold calldata,
        bytes calldata
    ) external pure returns (bool, uint256) {
        return (true, 1);
    }

    function executeHoldByPartition(IHoldTypes.HoldIdentifier calldata id, address, uint256)
        external
        pure
        returns (bool, bytes32)
    {
        return (true, id.partition);
    }

    function releaseHoldByPartition(IHoldTypes.HoldIdentifier calldata, uint256)
        external
        pure
        returns (bool)
    {
        return true;
    }

    function getHoldForByPartition(IHoldTypes.HoldIdentifier calldata)
        external
        pure
        returns (uint256, uint256, address, address, bytes memory, bytes memory, uint8)
    {
        return (0, 0, address(0), address(0), "", "", 0);
    }

    function getHeldAmountForByPartition(bytes32, address) external pure returns (uint256) {
        return 0;
    }
}

contract GateEngineStub {
    IHoldByPartition public immutable security;
    bytes32 public immutable partition;

    constructor(IHoldByPartition security_, bytes32 partition_) {
        security = security_;
        partition = partition_;
    }

    function commitBond() external pure returns (uint256) {
        return 1;
    }

    function revealDelay() external pure returns (uint64) {
        return 10;
    }

    function revealWindow() external pure returns (uint64) {
        return 100;
    }

    function roundLength() external pure returns (uint64) {
        return 300;
    }

    function restRounds() external pure returns (uint64) {
        return 1;
    }

    function genesis() external pure returns (uint64) {
        return 1_000;
    }
}

contract DualRegistrationGateTest is Test {
    address internal constant ADMIN = address(0xAD1);
    address internal constant ISSUER = address(0x155);
    address internal constant SESSION_SIGNER = address(0xA11CE);
    address internal constant RECOVERY_SIGNER = address(0xB0B);
    address internal constant MANUAL_ACCOUNT = address(0xCAFE);

    uint64 internal constant EPOCH_ZERO = 1_000;
    uint64 internal constant EPOCH_LENGTH = 100;
    uint64 internal constant EPOCH = 7;
    uint64 internal constant VIEW_KEY_EPOCH = 4;
    uint256 internal constant MANUAL_ROOT_VALUE = 111;
    uint256 internal constant SESSION_ROOT_VALUE = 222;
    uint256 internal constant VIEW_X = 333;
    uint256 internal constant VIEW_Y = 444;
    bytes32 internal constant PARTITION = bytes32(uint256(1));
    bytes32 internal constant QUICKNET_CHAIN_HASH =
        0x52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971;

    ManualVerifierStub internal manualVerifier;
    EligibilityVerifierStub internal eligibilityVerifier;
    ComplianceVerifierStub internal complianceVerifier;
    ZkKycRegistry internal registry;
    SessionAccountFactory internal factory;
    GateHoldStub internal security;
    GateEngineStub internal engine;
    DualRegistrationGate internal gate;
    SessionAccount internal account;
    SessionAccount internal secondAccount;

    function setUp() public {
        vm.warp(EPOCH_ZERO + uint256(EPOCH) * EPOCH_LENGTH);
        manualVerifier = new ManualVerifierStub();
        eligibilityVerifier = new EligibilityVerifierStub();
        complianceVerifier = new ComplianceVerifierStub();
        registry = new ZkKycRegistry(ADMIN, EPOCH_ZERO, EPOCH_LENGTH);
        factory = new SessionAccountFactory();
        security = new GateHoldStub();
        engine = new GateEngineStub(security, PARTITION);
        factory.setVenueConfigApproval(
            SessionAccountFactory.VenueConfig({
                engine: ISessionEngine(address(engine)),
                security: security,
                partition: PARTITION,
                router: payable(address(this)),
                quicknetChainHash: QUICKNET_CHAIN_HASH,
                feePolicyDigest: bytes32(uint256(456))
            }),
            true
        );

        gate = new DualRegistrationGate(
            manualVerifier,
            eligibilityVerifier,
            complianceVerifier,
            registry,
            ISSUER,
            ISessionFactoryEligibility(address(factory)),
            3,
            0xff
        );
        vm.prank(ADMIN);
        registry.bootstrapGate(address(gate));

        vm.startPrank(ISSUER);
        gate.publishRoot(EPOCH, MANUAL_ROOT_VALUE);
        gate.publishViewKey(VIEW_KEY_EPOCH, VIEW_X, VIEW_Y);
        gate.publishSessionRoot(EPOCH, SESSION_ROOT_VALUE, VIEW_KEY_EPOCH);
        vm.stopPrank();

        account = factory.deploy(_config(SESSION_SIGNER), bytes32(uint256(1)));
        secondAccount = factory.deploy(_config(address(0xA11CE2)), bytes32(uint256(2)));
    }

    function _config(address signer)
        internal
        view
        returns (SessionAccountFactory.Config memory)
    {
        return SessionAccountFactory.Config({
            sessionSigner: signer,
            recoverySigner: RECOVERY_SIGNER,
            engine: ISessionEngine(address(engine)),
            security: security,
            partition: PARTITION,
            router: payable(address(this)),
            quicknetChainHash: QUICKNET_CHAIN_HASH,
            generation: 1,
            feePolicyDigest: bytes32(uint256(456))
        });
    }

    function _manualPublicSignals() internal pure returns (uint256[7] memory publicSignals) {
        publicSignals[0] = 123;
        publicSignals[1] = 1;
        publicSignals[2] = MANUAL_ROOT_VALUE;
        publicSignals[3] = EPOCH;
        publicSignals[4] = uint256(uint160(MANUAL_ACCOUNT));
        publicSignals[5] = 3;
        publicSignals[6] = 0xff;
    }

    function _sessionInputs(address target, address signer)
        internal
        view
        returns (
            DualRegistrationGate.ComplianceCiphertext memory ciphertext,
            uint256[24] memory eligibilityProof,
            uint256[12] memory eligibilitySignals,
            uint256[24] memory complianceProof,
            uint256[17] memory complianceSignals
        )
    {
        eligibilitySignals[0] = 999;
        eligibilitySignals[1] = 1;
        eligibilitySignals[2] = 555;
        eligibilitySignals[3] = SESSION_ROOT_VALUE;
        eligibilitySignals[4] = EPOCH;
        eligibilitySignals[5] = uint256(uint160(target));
        eligibilitySignals[6] = uint256(uint160(signer));
        eligibilitySignals[7] = uint256(uint160(address(factory)));
        eligibilitySignals[8] = gate.sessionImplementationCodeHashLow();
        eligibilitySignals[9] = gate.sessionImplementationCodeHashHigh();
        eligibilitySignals[10] = 3;
        eligibilitySignals[11] = 0xff;

        complianceSignals[0] = 700;
        complianceSignals[1] = 701;
        complianceSignals[2] = 702;
        complianceSignals[3] = 703;
        complianceSignals[4] = eligibilitySignals[2];
        complianceSignals[5] = eligibilitySignals[3];
        complianceSignals[6] = eligibilitySignals[4];
        complianceSignals[7] = eligibilitySignals[5];
        complianceSignals[8] = eligibilitySignals[6];
        complianceSignals[9] = eligibilitySignals[7];
        complianceSignals[10] = eligibilitySignals[8];
        complianceSignals[11] = eligibilitySignals[9];
        complianceSignals[12] = eligibilitySignals[10];
        complianceSignals[13] = eligibilitySignals[11];
        complianceSignals[14] = VIEW_KEY_EPOCH;
        complianceSignals[15] = VIEW_X;
        complianceSignals[16] = VIEW_Y;

        ciphertext = DualRegistrationGate.ComplianceCiphertext({
            encryptedCredential: complianceSignals[0],
            tag: complianceSignals[1],
            ephemeralX: complianceSignals[2],
            ephemeralY: complianceSignals[3]
        });
    }

    function _registerSession(
        address target,
        DualRegistrationGate.ComplianceCiphertext memory ciphertext,
        uint256[24] memory eligibilityProof,
        uint256[12] memory eligibilitySignals,
        uint256[24] memory complianceProof,
        uint256[17] memory complianceSignals
    ) internal {
        gate.registerSession(
            target,
            ciphertext,
            eligibilityProof,
            eligibilitySignals,
            complianceProof,
            complianceSignals
        );
    }

    function test_manualAbiAndVerifierSemanticsRemainCompatible() public {
        assertEq(
            DualRegistrationGate.register.selector,
            bytes4(keccak256("register(address,uint256[24],uint256[7])"))
        );

        uint256[24] memory proof;
        gate.register(MANUAL_ACCOUNT, proof, _manualPublicSignals());
        assertEq(uint8(registry.getKycStatus(MANUAL_ACCOUNT)), uint8(IKyc.KycStatus.GRANTED));
        assertEq(registry.usesThisEpoch(bytes32(uint256(123))), 1);
    }

    function test_existingManualProofFixtureVerifiesThroughDualGate() public {
        string memory proofFixture = vm.readFile("test/fixtures/proofs.json");
        uint256[] memory rawProof = vm.parseJsonUintArray(proofFixture, ".valid.proof");
        uint256[] memory rawPublicSignals = vm.parseJsonUintArray(proofFixture, ".valid.pub");
        uint256[24] memory proof;
        uint256[7] memory publicSignals;
        for (uint256 i = 0; i < proof.length; ++i) {
            proof[i] = rawProof[i];
        }
        for (uint256 i = 0; i < publicSignals.length; ++i) {
            publicSignals[i] = rawPublicSignals[i];
        }

        KycVerifier realManualVerifier = new KycVerifier();
        ZkKycRegistry realRegistry = new ZkKycRegistry(ADMIN, EPOCH_ZERO, EPOCH_LENGTH);
        DualRegistrationGate realGate = new DualRegistrationGate(
            IPlonkVerifier(address(realManualVerifier)),
            eligibilityVerifier,
            complianceVerifier,
            realRegistry,
            ISSUER,
            ISessionFactoryEligibility(address(factory)),
            3,
            0xff
        );
        vm.prank(ADMIN);
        realRegistry.bootstrapGate(address(realGate));
        vm.prank(ISSUER);
        realGate.publishRoot(EPOCH, publicSignals[2]);

        address fixtureHolder = address(uint160(publicSignals[4]));
        realGate.register(fixtureHolder, proof, publicSignals);
        assertEq(uint8(realRegistry.getKycStatus(fixtureHolder)), uint8(IKyc.KycStatus.GRANTED));
    }

    function test_sessionProofPinsCanonicalAccountSignerFactoryAndCodeHash() public {
        (
            DualRegistrationGate.ComplianceCiphertext memory ciphertext,
            uint256[24] memory eligibilityProof,
            uint256[12] memory eligibilitySignals,
            uint256[24] memory complianceProof,
            uint256[17] memory complianceSignals
        ) = _sessionInputs(address(account), SESSION_SIGNER);

        eligibilitySignals[5] = uint256(uint160(address(secondAccount)));
        vm.expectRevert();
        _registerSession(
            address(account),
            ciphertext,
            eligibilityProof,
            eligibilitySignals,
            complianceProof,
            complianceSignals
        );

        (, eligibilityProof, eligibilitySignals, complianceProof, complianceSignals) =
            _sessionInputs(address(account), SESSION_SIGNER);
        eligibilitySignals[6] = uint256(uint160(address(0xBAD)));
        vm.expectRevert();
        _registerSession(
            address(account),
            ciphertext,
            eligibilityProof,
            eligibilitySignals,
            complianceProof,
            complianceSignals
        );

        (, eligibilityProof, eligibilitySignals, complianceProof, complianceSignals) =
            _sessionInputs(address(account), SESSION_SIGNER);
        eligibilitySignals[7] = uint256(uint160(address(0xBAD)));
        vm.expectRevert();
        _registerSession(
            address(account),
            ciphertext,
            eligibilityProof,
            eligibilitySignals,
            complianceProof,
            complianceSignals
        );

        (, eligibilityProof, eligibilitySignals, complianceProof, complianceSignals) =
            _sessionInputs(address(account), SESSION_SIGNER);
        eligibilitySignals[8] ^= 1;
        vm.expectRevert();
        _registerSession(
            address(account),
            ciphertext,
            eligibilityProof,
            eligibilitySignals,
            complianceProof,
            complianceSignals
        );
    }

    function test_nonFactoryAccountIsRejected() public {
        SessionAccount impostor = new SessionAccount(
            SESSION_SIGNER,
            RECOVERY_SIGNER,
            ISessionEngine(address(engine)),
            security,
            PARTITION,
            payable(address(this)),
            QUICKNET_CHAIN_HASH,
            1,
            bytes32(uint256(456))
        );
        (
            DualRegistrationGate.ComplianceCiphertext memory ciphertext,
            uint256[24] memory eligibilityProof,
            uint256[12] memory eligibilitySignals,
            uint256[24] memory complianceProof,
            uint256[17] memory complianceSignals
        ) = _sessionInputs(address(impostor), SESSION_SIGNER);

        vm.expectRevert(
            abi.encodeWithSelector(
                DualRegistrationGate.NonCanonicalSessionAccount.selector, address(impostor)
            )
        );
        _registerSession(
            address(impostor),
            ciphertext,
            eligibilityProof,
            eligibilitySignals,
            complianceProof,
            complianceSignals
        );
    }

    function test_splitProofAndCiphertextArePinned() public {
        (
            DualRegistrationGate.ComplianceCiphertext memory ciphertext,
            uint256[24] memory eligibilityProof,
            uint256[12] memory eligibilitySignals,
            uint256[24] memory complianceProof,
            uint256[17] memory complianceSignals
        ) = _sessionInputs(address(account), SESSION_SIGNER);

        complianceSignals[4] ^= 1;
        vm.expectRevert(
            abi.encodeWithSelector(DualRegistrationGate.SplitProofMismatch.selector, 555, 554)
        );
        _registerSession(
            address(account),
            ciphertext,
            eligibilityProof,
            eligibilitySignals,
            complianceProof,
            complianceSignals
        );

        (, eligibilityProof, eligibilitySignals, complianceProof, complianceSignals) =
            _sessionInputs(address(account), SESSION_SIGNER);
        ciphertext.tag ^= 1;
        vm.expectRevert(DualRegistrationGate.CiphertextMismatch.selector);
        _registerSession(
            address(account),
            ciphertext,
            eligibilityProof,
            eligibilitySignals,
            complianceProof,
            complianceSignals
        );
    }

    function test_rootEpochPolicyAndViewKeyArePinnedBeforeProofs() public {
        (
            DualRegistrationGate.ComplianceCiphertext memory ciphertext,
            uint256[24] memory eligibilityProof,
            uint256[12] memory eligibilitySignals,
            uint256[24] memory complianceProof,
            uint256[17] memory complianceSignals
        ) = _sessionInputs(address(account), SESSION_SIGNER);

        eligibilitySignals[3] ^= 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                DualRegistrationGate.RootMismatch.selector, 223, SESSION_ROOT_VALUE
            )
        );
        _registerSession(
            address(account),
            ciphertext,
            eligibilityProof,
            eligibilitySignals,
            complianceProof,
            complianceSignals
        );

        (, eligibilityProof, eligibilitySignals, complianceProof, complianceSignals) =
            _sessionInputs(address(account), SESSION_SIGNER);
        complianceSignals[15] ^= 1;
        vm.expectRevert(
            abi.encodeWithSelector(DualRegistrationGate.ViewKeyMismatch.selector, 332, VIEW_Y)
        );
        _registerSession(
            address(account),
            ciphertext,
            eligibilityProof,
            eligibilitySignals,
            complianceProof,
            complianceSignals
        );
    }

    function test_duplicateSessionSlotIsRejectedAndDomainsDoNotShareCounters() public {
        uint256[24] memory manualProof;
        gate.register(MANUAL_ACCOUNT, manualProof, _manualPublicSignals());

        (
            DualRegistrationGate.ComplianceCiphertext memory ciphertext,
            uint256[24] memory eligibilityProof,
            uint256[12] memory eligibilitySignals,
            uint256[24] memory complianceProof,
            uint256[17] memory complianceSignals
        ) = _sessionInputs(address(account), SESSION_SIGNER);
        _registerSession(
            address(account),
            ciphertext,
            eligibilityProof,
            eligibilitySignals,
            complianceProof,
            complianceSignals
        );

        assertEq(registry.usesThisEpoch(bytes32(uint256(123))), 1);
        assertEq(registry.usesThisEpoch(bytes32(uint256(999))), 1);
        assertTrue(bytes32(uint256(123)) != bytes32(uint256(999)));

        vm.expectRevert(
            abi.encodeWithSelector(
                DualRegistrationGate.SessionSlotAlreadyUsed.selector, bytes32(uint256(999))
            )
        );
        _registerSession(
            address(account),
            ciphertext,
            eligibilityProof,
            eligibilitySignals,
            complianceProof,
            complianceSignals
        );
    }

    function test_invalidEitherVerifierFailsClosed() public {
        (
            DualRegistrationGate.ComplianceCiphertext memory ciphertext,
            uint256[24] memory eligibilityProof,
            uint256[12] memory eligibilitySignals,
            uint256[24] memory complianceProof,
            uint256[17] memory complianceSignals
        ) = _sessionInputs(address(account), SESSION_SIGNER);

        eligibilityVerifier.setAnswer(false);
        vm.expectRevert(DualRegistrationGate.ProofInvalid.selector);
        _registerSession(
            address(account),
            ciphertext,
            eligibilityProof,
            eligibilitySignals,
            complianceProof,
            complianceSignals
        );

        eligibilityVerifier.setAnswer(true);
        complianceVerifier.setAnswer(false);
        vm.expectRevert(DualRegistrationGate.ComplianceProofInvalid.selector);
        _registerSession(
            address(account),
            ciphertext,
            eligibilityProof,
            eligibilitySignals,
            complianceProof,
            complianceSignals
        );
    }
}
