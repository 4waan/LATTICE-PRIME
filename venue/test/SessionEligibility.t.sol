// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SessionEligibilityVerifier} from "../src/session/SessionEligibilityVerifier.sol";
import {SessionComplianceVerifier} from "../src/session/SessionComplianceVerifier.sol";
import {ISessionEligibilityVerifier} from "../src/session/ISessionEligibilityVerifier.sol";
import {ISessionComplianceVerifier} from "../src/session/ISessionComplianceVerifier.sol";
import {IPlonkVerifier} from "../src/kyc/IPlonkVerifier.sol";
import {ZkKycRegistry} from "../src/kyc/ZkKycRegistry.sol";
import {IKyc} from "../src/interfaces/IKyc.sol";
import {
    DualRegistrationGate,
    ISessionFactoryEligibility
} from "../src/session/DualRegistrationGate.sol";

contract SessionManualVerifierStub is IPlonkVerifier {
    function verifyProof(uint256[24] calldata, uint256[7] calldata)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

contract FixtureSessionAccount {
    function sessionSigner() external pure returns (address) {
        return 0x2222222222222222222222222222222222222222;
    }
}

contract FixtureSessionFactory {
    address internal constant FIXTURE_ACCOUNT = 0x1111111111111111111111111111111111111111;

    function isSessionAccount(address account) external pure returns (bool) {
        return account == FIXTURE_ACCOUNT;
    }

    function creationCodeHash() external pure returns (bytes32) {
        return keccak256(bytes("session-account-fixture-implementation-v1"));
    }

    function deployedCodeHash(address account) external view returns (bytes32 codeHash) {
        if (account != FIXTURE_ACCOUNT) return bytes32(0);
        assembly {
            codeHash := extcodehash(account)
        }
    }
}

contract SessionEligibilityTest is Test {
    address internal constant FIXTURE_ACCOUNT = 0x1111111111111111111111111111111111111111;
    address internal constant FIXTURE_FACTORY = 0x3333333333333333333333333333333333333333;

    string internal fixture;
    string internal issuerCredential;
    SessionEligibilityVerifier internal eligibilityVerifier;
    SessionComplianceVerifier internal complianceVerifier;

    function setUp() public {
        fixture = vm.readFile("test/fixtures/session/proofs.json");
        issuerCredential = vm.readFile("test/fixtures/session/issuer-credential.json");
        eligibilityVerifier = new SessionEligibilityVerifier();
        complianceVerifier = new SessionComplianceVerifier();
    }

    function _eligibilityProof() internal view returns (uint256[24] memory proof) {
        uint256[] memory values = vm.parseJsonUintArray(fixture, ".eligibility.proof");
        assertEq(values.length, 24);
        for (uint256 i = 0; i < values.length; ++i) {
            proof[i] = values[i];
        }
    }

    function _eligibilityPublic() internal view returns (uint256[12] memory publicSignals) {
        uint256[] memory values = vm.parseJsonUintArray(fixture, ".eligibility.publicSignals");
        assertEq(values.length, 12);
        for (uint256 i = 0; i < values.length; ++i) {
            publicSignals[i] = values[i];
        }
    }

    function _complianceProof() internal view returns (uint256[24] memory proof) {
        uint256[] memory values = vm.parseJsonUintArray(fixture, ".compliance.proof");
        assertEq(values.length, 24);
        for (uint256 i = 0; i < values.length; ++i) {
            proof[i] = values[i];
        }
    }

    function _compliancePublic() internal view returns (uint256[17] memory publicSignals) {
        uint256[] memory values = vm.parseJsonUintArray(fixture, ".compliance.publicSignals");
        assertEq(values.length, 17);
        for (uint256 i = 0; i < values.length; ++i) {
            publicSignals[i] = values[i];
        }
    }

    function test_realSplitProofsVerifyAndShareOneCredentialBridge() public view {
        uint256[12] memory eligibilityPublicSignals = _eligibilityPublic();
        uint256[17] memory compliancePublicSignals = _compliancePublic();

        assertTrue(
            eligibilityVerifier.verifyProof(_eligibilityProof(), eligibilityPublicSignals)
        );
        assertTrue(complianceVerifier.verifyProof(_complianceProof(), compliancePublicSignals));
        assertEq(eligibilityPublicSignals[2], compliancePublicSignals[4], "sound split bridge");
    }

    function test_sessionAccountSignerFactoryRootEpochAndPolicyAreProofBound() public view {
        uint256[12] memory original = _eligibilityPublic();
        uint256[24] memory proof = _eligibilityProof();
        uint256[9] memory indices = [uint256(3), 4, 5, 6, 7, 8, 9, 10, 11];

        for (uint256 i = 0; i < indices.length; ++i) {
            uint256[12] memory tampered = original;
            tampered[indices[i]] ^= 1;
            assertFalse(
                eligibilityVerifier.verifyProof(proof, tampered),
                "tampered session context verified"
            );
        }
    }

    function test_ciphertextViewKeyAndBridgeTamperingInvalidateRealProof() public view {
        uint256[17] memory original = _compliancePublic();
        uint256[24] memory proof = _complianceProof();
        uint256[17] memory tampered = original;

        tampered[0] ^= 1;
        assertFalse(complianceVerifier.verifyProof(proof, tampered));
        tampered = original;
        tampered[1] ^= 1;
        assertFalse(complianceVerifier.verifyProof(proof, tampered));
        tampered = original;
        tampered[4] ^= 1;
        assertFalse(complianceVerifier.verifyProof(proof, tampered));
        tampered = original;
        tampered[14] ^= 1;
        assertFalse(complianceVerifier.verifyProof(proof, tampered));
        tampered = original;
        tampered[15] ^= 1;
        assertFalse(complianceVerifier.verifyProof(proof, tampered));
    }

    function test_issuerBundleExposesCommitmentButNeverHolderSecret() public view {
        uint256 holderSecretCommitment =
            vm.parseJsonUint(issuerCredential, ".holderSecretCommitment");
        assertTrue(holderSecretCommitment != 0);
        assertFalse(
            _contains(bytes(issuerCredential), bytes("\"holderSecret\":")),
            "issuer bundle contains holder secret"
        );
        assertFalse(
            _contains(bytes(fixture), bytes("\"holderSecret\":")),
            "proof fixture contains holder secret"
        );
    }

    function test_credentialIdIsEncryptedAndAbsentFromProofPublicSignals() public view {
        uint256 credentialId = vm.parseJsonUint(issuerCredential, ".credentialId");
        uint256[12] memory eligibilityPublicSignals = _eligibilityPublic();
        uint256[17] memory compliancePublicSignals = _compliancePublic();

        assertTrue(compliancePublicSignals[0] != credentialId);
        for (uint256 i = 0; i < eligibilityPublicSignals.length; ++i) {
            assertTrue(
                eligibilityPublicSignals[i] != credentialId,
                "credential id leaked in eligibility public signals"
            );
        }
    }

    function test_sessionSlotDoesNotReuseTheManualRegistrationNullifier() public view {
        string memory manualFixture = vm.readFile("test/fixtures/proofs.json");
        uint256[] memory manualPublicSignals =
            vm.parseJsonUintArray(manualFixture, ".valid.pub");
        uint256[12] memory sessionPublicSignals = _eligibilityPublic();

        assertTrue(
            sessionPublicSignals[0] != manualPublicSignals[0],
            "manual and session public nullifiers collided"
        );
    }

    function test_fixturePinsFactoryDeclaredImplementationCode() public view {
        bytes32 fixtureCodeHash =
            vm.parseJsonBytes32(issuerCredential, ".implementationCodeHash");
        assertEq(fixtureCodeHash, keccak256(bytes("session-account-fixture-implementation-v1")));
    }

    function test_realProofRegistersCanonicalPinnedSessionEndToEnd() public {
        FixtureSessionAccount accountTemplate = new FixtureSessionAccount();
        FixtureSessionFactory factoryTemplate = new FixtureSessionFactory();
        vm.etch(FIXTURE_ACCOUNT, address(accountTemplate).code);
        vm.etch(FIXTURE_FACTORY, address(factoryTemplate).code);

        uint64 epochZero = 1_000;
        uint64 epochLength = 100;
        uint64 epoch = 7;
        address admin = address(0xAD1);
        address issuer = address(0x155);
        vm.warp(epochZero + uint256(epoch) * epochLength);

        SessionManualVerifierStub manualVerifier = new SessionManualVerifierStub();
        ZkKycRegistry registry = new ZkKycRegistry(admin, epochZero, epochLength);
        DualRegistrationGate gate = new DualRegistrationGate(
            manualVerifier,
            ISessionEligibilityVerifier(address(eligibilityVerifier)),
            ISessionComplianceVerifier(address(complianceVerifier)),
            registry,
            issuer,
            ISessionFactoryEligibility(FIXTURE_FACTORY),
            3,
            0xff
        );
        vm.prank(admin);
        registry.bootstrapGate(address(gate));

        uint256[12] memory eligibilityPublicSignals = _eligibilityPublic();
        uint256[17] memory compliancePublicSignals = _compliancePublic();
        vm.startPrank(issuer);
        gate.publishViewKey(
            uint64(compliancePublicSignals[14]),
            compliancePublicSignals[15],
            compliancePublicSignals[16]
        );
        gate.publishSessionRoot(
            epoch, eligibilityPublicSignals[3], uint64(compliancePublicSignals[14])
        );
        vm.stopPrank();

        DualRegistrationGate.ComplianceCiphertext memory ciphertext =
            DualRegistrationGate.ComplianceCiphertext({
                encryptedCredential: compliancePublicSignals[0],
                tag: compliancePublicSignals[1],
                ephemeralX: compliancePublicSignals[2],
                ephemeralY: compliancePublicSignals[3]
            });
        gate.registerSession(
            FIXTURE_ACCOUNT,
            ciphertext,
            _eligibilityProof(),
            eligibilityPublicSignals,
            _complianceProof(),
            compliancePublicSignals
        );

        assertEq(uint8(registry.getKycStatus(FIXTURE_ACCOUNT)), uint8(IKyc.KycStatus.GRANTED));
    }

    function _contains(bytes memory haystack, bytes memory needle) private pure returns (bool) {
        if (needle.length == 0 || needle.length > haystack.length) return false;
        for (uint256 i = 0; i <= haystack.length - needle.length; ++i) {
            bool matches = true;
            for (uint256 j = 0; j < needle.length; ++j) {
                if (haystack[i + j] != needle[j]) {
                    matches = false;
                    break;
                }
            }
            if (matches) return true;
        }
        return false;
    }
}
