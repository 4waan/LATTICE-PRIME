// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IPlonkVerifier} from "../kyc/IPlonkVerifier.sol";
import {ZkKycRegistry} from "../kyc/ZkKycRegistry.sol";
import {ISessionEligibilityVerifier} from "./ISessionEligibilityVerifier.sol";
import {ISessionComplianceVerifier} from "./ISessionComplianceVerifier.sol";

interface ISessionFactoryEligibility {
    function isSessionAccount(address account) external view returns (bool);
    function creationCodeHash() external view returns (bytes32);
    function deployedCodeHash(address account) external view returns (bytes32);
}

interface ISessionAccountEligibility {
    function sessionSigner() external view returns (address);
}

/// @title DualRegistrationGate
/// @notice The registry's single writer for legacy wallet and V2 session proofs.
/// @dev register(address,uint256[24],uint256[7]) preserves RegistrationGate's
///      frozen manual ABI and signal semantics. Session eligibility uses two
///      soundly linked PLONK proofs because the power-15 ceremony cannot fit the
///      credential tree and Baby Jubjub encryption in one circuit.
contract DualRegistrationGate {
    uint256 internal constant MANUAL_NULLIFIER = 0;
    uint256 internal constant MANUAL_PASSES = 1;
    uint256 internal constant MANUAL_ROOT = 2;
    uint256 internal constant MANUAL_EPOCH = 3;
    uint256 internal constant MANUAL_REGISTRANT = 4;
    uint256 internal constant MANUAL_MIN_TIER = 5;
    uint256 internal constant MANUAL_JURISDICTION_MASK = 6;

    uint256 internal constant ELIGIBILITY_SLOT = 0;
    uint256 internal constant ELIGIBILITY_PASSES = 1;
    uint256 internal constant ELIGIBILITY_BRIDGE = 2;
    uint256 internal constant ELIGIBILITY_ROOT = 3;
    uint256 internal constant ELIGIBILITY_EPOCH = 4;
    uint256 internal constant ELIGIBILITY_ACCOUNT = 5;
    uint256 internal constant ELIGIBILITY_SIGNER = 6;
    uint256 internal constant ELIGIBILITY_FACTORY = 7;
    uint256 internal constant ELIGIBILITY_CODE_HASH_LOW = 8;
    uint256 internal constant ELIGIBILITY_CODE_HASH_HIGH = 9;
    uint256 internal constant ELIGIBILITY_MIN_TIER = 10;
    uint256 internal constant ELIGIBILITY_JURISDICTION_MASK = 11;

    uint256 internal constant COMPLIANCE_ENCRYPTED_CREDENTIAL = 0;
    uint256 internal constant COMPLIANCE_TAG = 1;
    uint256 internal constant COMPLIANCE_EPHEMERAL_X = 2;
    uint256 internal constant COMPLIANCE_EPHEMERAL_Y = 3;
    uint256 internal constant COMPLIANCE_BRIDGE = 4;
    uint256 internal constant COMPLIANCE_ROOT = 5;
    uint256 internal constant COMPLIANCE_EPOCH = 6;
    uint256 internal constant COMPLIANCE_ACCOUNT = 7;
    uint256 internal constant COMPLIANCE_SIGNER = 8;
    uint256 internal constant COMPLIANCE_FACTORY = 9;
    uint256 internal constant COMPLIANCE_CODE_HASH_LOW = 10;
    uint256 internal constant COMPLIANCE_CODE_HASH_HIGH = 11;
    uint256 internal constant COMPLIANCE_MIN_TIER = 12;
    uint256 internal constant COMPLIANCE_JURISDICTION_MASK = 13;
    uint256 internal constant COMPLIANCE_VIEW_KEY_EPOCH = 14;
    uint256 internal constant COMPLIANCE_VIEW_KEY_X = 15;
    uint256 internal constant COMPLIANCE_VIEW_KEY_Y = 16;

    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    struct ComplianceCiphertext {
        uint256 encryptedCredential;
        uint256 tag;
        uint256 ephemeralX;
        uint256 ephemeralY;
    }

    struct ViewKey {
        uint256 x;
        uint256 y;
        bool published;
    }

    IPlonkVerifier public immutable manualVerifier;
    ISessionEligibilityVerifier public immutable sessionEligibilityVerifier;
    ISessionComplianceVerifier public immutable sessionComplianceVerifier;
    ZkKycRegistry public immutable registry;
    address public immutable issuer;
    ISessionFactoryEligibility public immutable sessionFactory;
    bytes32 public immutable sessionImplementationCodeHash;
    uint256 public immutable sessionImplementationCodeHashLow;
    uint256 public immutable sessionImplementationCodeHashHigh;

    mapping(uint64 => uint256) public rootForEpoch;
    mapping(uint64 => uint256) public sessionRootForEpoch;
    mapping(uint64 => uint64) public viewKeyEpochForRotationEpoch;
    mapping(uint64 => ViewKey) public viewKeyForEpoch;
    mapping(bytes32 => bool) public sessionSlotUsed;

    uint256 public minTier;
    uint256 public jurisdictionMask;
    uint256 public pendingMinTier;
    uint256 public pendingJurisdictionMask;
    uint64 public pendingPolicyEpoch;

    event Registered(address indexed account, uint64 indexed epoch, bytes32 nullifier);
    event SessionRegistered(
        address indexed account,
        address indexed sessionSigner,
        uint64 indexed rotationEpoch,
        bytes32 sessionSlot,
        uint64 viewKeyEpoch
    );
    event SessionComplianceRecord(
        address indexed account,
        bytes32 indexed sessionSlot,
        uint256 encryptedCredential,
        uint256 tag,
        uint256 ephemeralX,
        uint256 ephemeralY
    );
    event RootPublished(uint64 indexed epoch, uint256 root);
    event SessionRootPublished(
        uint64 indexed rotationEpoch, uint256 root, uint64 indexed viewKeyEpoch
    );
    event ViewKeyPublished(uint64 indexed viewKeyEpoch, uint256 x, uint256 y);
    event PolicyProposed(uint256 minTier, uint256 mask, uint64 effectiveEpoch);
    event PolicyAdopted(uint256 minTier, uint256 mask, uint64 epoch);

    error NotIssuer();
    error NotSessionFactory();
    error VerifierNotContract(address verifier);
    error FactoryNotContract(address factory);
    error RootAlreadySet(uint64 epoch);
    error RootNotPublished(uint64 epoch);
    error InvalidFieldElement(uint256 value);
    error EpochMismatch(uint256 got, uint64 want);
    error RootMismatch(uint256 got, uint256 want);
    error RegistrantMismatch(uint256 got, address want);
    error SessionSignerMismatch(uint256 got, address want);
    error FactoryMismatch(uint256 got, address want);
    error ImplementationCodeHashMismatch(uint256 gotLow, uint256 gotHigh);
    error PolicyMismatch(uint256 gotTier, uint256 gotMask);
    error PolicyNotSatisfied();
    error ProofInvalid();
    error ComplianceProofInvalid();
    error NullifierExhausted(bytes32 nullifier);
    error SessionSlotAlreadyUsed(bytes32 sessionSlot);
    error NonCanonicalSessionAccount(address account);
    error SplitProofMismatch(uint256 eligibilityValue, uint256 complianceValue);
    error CiphertextMismatch();
    error ViewKeyAlreadyPublished(uint64 viewKeyEpoch);
    error ViewKeyNotPublished(uint64 viewKeyEpoch);
    error ViewKeyEpochMismatch(uint256 got, uint64 want);
    error ViewKeyMismatch(uint256 gotX, uint256 gotY);
    error PolicyNotYetEffective(uint64 effectiveEpoch, uint64 current);

    constructor(
        IPlonkVerifier manualVerifier_,
        ISessionEligibilityVerifier sessionEligibilityVerifier_,
        ISessionComplianceVerifier sessionComplianceVerifier_,
        ZkKycRegistry registry_,
        address issuer_,
        ISessionFactoryEligibility sessionFactory_,
        uint256 minTier_,
        uint256 jurisdictionMask_
    ) {
        if (address(manualVerifier_).code.length == 0) {
            revert VerifierNotContract(address(manualVerifier_));
        }
        if (address(sessionEligibilityVerifier_).code.length == 0) {
            revert VerifierNotContract(address(sessionEligibilityVerifier_));
        }
        if (address(sessionComplianceVerifier_).code.length == 0) {
            revert VerifierNotContract(address(sessionComplianceVerifier_));
        }
        if (address(sessionFactory_).code.length == 0) {
            revert FactoryNotContract(address(sessionFactory_));
        }

        manualVerifier = manualVerifier_;
        sessionEligibilityVerifier = sessionEligibilityVerifier_;
        sessionComplianceVerifier = sessionComplianceVerifier_;
        registry = registry_;
        issuer = issuer_;
        sessionFactory = sessionFactory_;
        minTier = minTier_;
        jurisdictionMask = jurisdictionMask_;

        bytes32 codeHash = sessionFactory_.creationCodeHash();
        sessionImplementationCodeHash = codeHash;
        sessionImplementationCodeHashLow = uint256(uint128(uint256(codeHash)));
        sessionImplementationCodeHashHigh = uint256(codeHash) >> 128;
    }

    /// @notice Preserve the legacy manual-registration ABI and behavior.
    function register(address account, uint256[24] calldata proof, uint256[7] calldata pub)
        external
    {
        uint64 epoch = registry.currentEpoch();
        bytes32 nullifier = bytes32(pub[MANUAL_NULLIFIER]);

        if (registry.usesThisEpoch(nullifier) >= registry.MAX_USES_PER_EPOCH()) {
            revert NullifierExhausted(nullifier);
        }
        if (pub[MANUAL_EPOCH] != uint256(epoch)) {
            revert EpochMismatch(pub[MANUAL_EPOCH], epoch);
        }

        uint256 expectedRoot = rootForEpoch[epoch];
        if (expectedRoot == 0) revert RootNotPublished(epoch);
        if (pub[MANUAL_ROOT] != expectedRoot) {
            revert RootMismatch(pub[MANUAL_ROOT], expectedRoot);
        }
        if (pub[MANUAL_REGISTRANT] != uint256(uint160(account))) {
            revert RegistrantMismatch(pub[MANUAL_REGISTRANT], account);
        }
        if (
            pub[MANUAL_MIN_TIER] != minTier || pub[MANUAL_JURISDICTION_MASK] != jurisdictionMask
        ) {
            revert PolicyMismatch(pub[MANUAL_MIN_TIER], pub[MANUAL_JURISDICTION_MASK]);
        }
        if (pub[MANUAL_PASSES] != 1) revert PolicyNotSatisfied();
        if (!manualVerifier.verifyProof(proof, pub)) revert ProofInvalid();

        registry.grant(account, nullifier);
        emit Registered(account, epoch, nullifier);
    }

    /// @notice Register a canonical CREATE2 session with linked eligibility and
    ///         compliance-encryption proofs.
    function registerSession(
        address account,
        ComplianceCiphertext calldata ciphertext,
        uint256[24] calldata eligibilityProof,
        uint256[12] calldata eligibilityPublicSignals,
        uint256[24] calldata complianceProof,
        uint256[17] calldata compliancePublicSignals
    ) external {
        _registerSession(
            account,
            ciphertext,
            eligibilityProof,
            eligibilityPublicSignals,
            complianceProof,
            compliancePublicSignals
        );
    }

    /// @notice Factory hook for atomic CREATE2 deployment and registration.
    /// @dev registrationData contains ciphertext, both proofs, and both public arrays.
    function registerSessionAccount(address account, bytes calldata registrationData) external {
        if (msg.sender != address(sessionFactory)) revert NotSessionFactory();
        (
            ComplianceCiphertext memory ciphertext,
            uint256[24] memory eligibilityProof,
            uint256[12] memory eligibilityPublicSignals,
            uint256[24] memory complianceProof,
            uint256[17] memory compliancePublicSignals
        ) = abi.decode(
            registrationData,
            (ComplianceCiphertext, uint256[24], uint256[12], uint256[24], uint256[17])
        );

        _registerSession(
            account,
            ciphertext,
            eligibilityProof,
            eligibilityPublicSignals,
            complianceProof,
            compliancePublicSignals
        );
    }

    function _registerSession(
        address account,
        ComplianceCiphertext memory ciphertext,
        uint256[24] memory eligibilityProof,
        uint256[12] memory eligibilityPublicSignals,
        uint256[24] memory complianceProof,
        uint256[17] memory compliancePublicSignals
    ) private {
        uint64 epoch = registry.currentEpoch();
        bytes32 sessionSlot = bytes32(eligibilityPublicSignals[ELIGIBILITY_SLOT]);

        if (sessionSlotUsed[sessionSlot] || registry.usesThisEpoch(sessionSlot) != 0) {
            revert SessionSlotAlreadyUsed(sessionSlot);
        }
        if (!_isCanonicalAccount(account)) {
            revert NonCanonicalSessionAccount(account);
        }

        address signer = ISessionAccountEligibility(account).sessionSigner();
        _pinSessionEligibility(
            account, signer, epoch, eligibilityPublicSignals, compliancePublicSignals
        );
        _pinCiphertext(ciphertext, compliancePublicSignals);

        if (eligibilityPublicSignals[ELIGIBILITY_PASSES] != 1) {
            revert PolicyNotSatisfied();
        }
        if (!sessionEligibilityVerifier.verifyProof(eligibilityProof, eligibilityPublicSignals))
        {
            revert ProofInvalid();
        }
        if (!sessionComplianceVerifier.verifyProof(complianceProof, compliancePublicSignals)) {
            revert ComplianceProofInvalid();
        }

        sessionSlotUsed[sessionSlot] = true;
        registry.grant(account, sessionSlot);

        uint64 viewKeyEpoch = viewKeyEpochForRotationEpoch[epoch];
        emit SessionRegistered(account, signer, epoch, sessionSlot, viewKeyEpoch);
        emit SessionComplianceRecord(
            account,
            sessionSlot,
            ciphertext.encryptedCredential,
            ciphertext.tag,
            ciphertext.ephemeralX,
            ciphertext.ephemeralY
        );
    }

    function _pinSessionEligibility(
        address account,
        address signer,
        uint64 epoch,
        uint256[12] memory eligibilityPublicSignals,
        uint256[17] memory compliancePublicSignals
    ) private view {
        if (eligibilityPublicSignals[ELIGIBILITY_EPOCH] != uint256(epoch)) {
            revert EpochMismatch(eligibilityPublicSignals[ELIGIBILITY_EPOCH], epoch);
        }

        uint256 expectedRoot = sessionRootForEpoch[epoch];
        if (expectedRoot == 0) revert RootNotPublished(epoch);
        if (eligibilityPublicSignals[ELIGIBILITY_ROOT] != expectedRoot) {
            revert RootMismatch(eligibilityPublicSignals[ELIGIBILITY_ROOT], expectedRoot);
        }
        if (eligibilityPublicSignals[ELIGIBILITY_ACCOUNT] != uint256(uint160(account))) {
            revert RegistrantMismatch(eligibilityPublicSignals[ELIGIBILITY_ACCOUNT], account);
        }
        if (eligibilityPublicSignals[ELIGIBILITY_SIGNER] != uint256(uint160(signer))) {
            revert SessionSignerMismatch(eligibilityPublicSignals[ELIGIBILITY_SIGNER], signer);
        }
        if (
            eligibilityPublicSignals[ELIGIBILITY_FACTORY]
                != uint256(uint160(address(sessionFactory)))
        ) {
            revert FactoryMismatch(
                eligibilityPublicSignals[ELIGIBILITY_FACTORY], address(sessionFactory)
            );
        }
        if (
            eligibilityPublicSignals[ELIGIBILITY_CODE_HASH_LOW]
                    != sessionImplementationCodeHashLow
                || eligibilityPublicSignals[ELIGIBILITY_CODE_HASH_HIGH]
                    != sessionImplementationCodeHashHigh
        ) {
            revert ImplementationCodeHashMismatch(
                eligibilityPublicSignals[ELIGIBILITY_CODE_HASH_LOW],
                eligibilityPublicSignals[ELIGIBILITY_CODE_HASH_HIGH]
            );
        }
        if (
            eligibilityPublicSignals[ELIGIBILITY_MIN_TIER] != minTier
                || eligibilityPublicSignals[ELIGIBILITY_JURISDICTION_MASK] != jurisdictionMask
        ) {
            revert PolicyMismatch(
                eligibilityPublicSignals[ELIGIBILITY_MIN_TIER],
                eligibilityPublicSignals[ELIGIBILITY_JURISDICTION_MASK]
            );
        }

        _pinSplitProof(eligibilityPublicSignals, compliancePublicSignals);
        _pinViewKey(epoch, compliancePublicSignals);
    }

    function _pinSplitProof(
        uint256[12] memory eligibilityPublicSignals,
        uint256[17] memory compliancePublicSignals
    ) private pure {
        _requireSplitEqual(
            eligibilityPublicSignals[ELIGIBILITY_BRIDGE],
            compliancePublicSignals[COMPLIANCE_BRIDGE]
        );
        _requireSplitEqual(
            eligibilityPublicSignals[ELIGIBILITY_ROOT], compliancePublicSignals[COMPLIANCE_ROOT]
        );
        _requireSplitEqual(
            eligibilityPublicSignals[ELIGIBILITY_EPOCH],
            compliancePublicSignals[COMPLIANCE_EPOCH]
        );
        _requireSplitEqual(
            eligibilityPublicSignals[ELIGIBILITY_ACCOUNT],
            compliancePublicSignals[COMPLIANCE_ACCOUNT]
        );
        _requireSplitEqual(
            eligibilityPublicSignals[ELIGIBILITY_SIGNER],
            compliancePublicSignals[COMPLIANCE_SIGNER]
        );
        _requireSplitEqual(
            eligibilityPublicSignals[ELIGIBILITY_FACTORY],
            compliancePublicSignals[COMPLIANCE_FACTORY]
        );
        _requireSplitEqual(
            eligibilityPublicSignals[ELIGIBILITY_CODE_HASH_LOW],
            compliancePublicSignals[COMPLIANCE_CODE_HASH_LOW]
        );
        _requireSplitEqual(
            eligibilityPublicSignals[ELIGIBILITY_CODE_HASH_HIGH],
            compliancePublicSignals[COMPLIANCE_CODE_HASH_HIGH]
        );
        _requireSplitEqual(
            eligibilityPublicSignals[ELIGIBILITY_MIN_TIER],
            compliancePublicSignals[COMPLIANCE_MIN_TIER]
        );
        _requireSplitEqual(
            eligibilityPublicSignals[ELIGIBILITY_JURISDICTION_MASK],
            compliancePublicSignals[COMPLIANCE_JURISDICTION_MASK]
        );
    }

    function _requireSplitEqual(uint256 eligibilityValue, uint256 complianceValue)
        private
        pure
    {
        if (eligibilityValue != complianceValue) {
            revert SplitProofMismatch(eligibilityValue, complianceValue);
        }
    }

    function _pinViewKey(uint64 rotationEpoch, uint256[17] memory compliancePublicSignals)
        private
        view
    {
        uint64 expectedEpoch = viewKeyEpochForRotationEpoch[rotationEpoch];
        ViewKey memory expected = viewKeyForEpoch[expectedEpoch];
        if (!expected.published) revert ViewKeyNotPublished(expectedEpoch);
        if (compliancePublicSignals[COMPLIANCE_VIEW_KEY_EPOCH] != uint256(expectedEpoch)) {
            revert ViewKeyEpochMismatch(
                compliancePublicSignals[COMPLIANCE_VIEW_KEY_EPOCH], expectedEpoch
            );
        }
        if (
            compliancePublicSignals[COMPLIANCE_VIEW_KEY_X] != expected.x
                || compliancePublicSignals[COMPLIANCE_VIEW_KEY_Y] != expected.y
        ) {
            revert ViewKeyMismatch(
                compliancePublicSignals[COMPLIANCE_VIEW_KEY_X],
                compliancePublicSignals[COMPLIANCE_VIEW_KEY_Y]
            );
        }
    }

    function _pinCiphertext(
        ComplianceCiphertext memory ciphertext,
        uint256[17] memory compliancePublicSignals
    ) private pure {
        if (
            ciphertext.encryptedCredential
                    != compliancePublicSignals[COMPLIANCE_ENCRYPTED_CREDENTIAL]
                || ciphertext.tag != compliancePublicSignals[COMPLIANCE_TAG]
                || ciphertext.ephemeralX != compliancePublicSignals[COMPLIANCE_EPHEMERAL_X]
                || ciphertext.ephemeralY != compliancePublicSignals[COMPLIANCE_EPHEMERAL_Y]
        ) {
            revert CiphertextMismatch();
        }
    }

    function _isCanonicalAccount(address account) private view returns (bool) {
        if (account.code.length == 0 || !sessionFactory.isSessionAccount(account)) {
            return false;
        }

        bytes32 recordedHash = sessionFactory.deployedCodeHash(account);
        bytes32 actualHash;
        assembly {
            actualHash := extcodehash(account)
        }
        return recordedHash != bytes32(0) && recordedHash == actualHash;
    }

    /// @notice Legacy relay preview with the original seven-signal semantics.
    function wouldAccept(address account, uint256[7] calldata pub)
        external
        view
        returns (bool ok, string memory reason)
    {
        uint64 epoch = registry.currentEpoch();
        if (
            registry.usesThisEpoch(bytes32(pub[MANUAL_NULLIFIER]))
                >= registry.MAX_USES_PER_EPOCH()
        ) {
            return (false, "nullifier exhausted for this epoch");
        }
        if (pub[MANUAL_EPOCH] != uint256(epoch)) return (false, "wrong epoch");
        if (rootForEpoch[epoch] == 0) return (false, "root not published");
        if (pub[MANUAL_ROOT] != rootForEpoch[epoch]) {
            return (false, "wrong credential root");
        }
        if (pub[MANUAL_REGISTRANT] != uint256(uint160(account))) {
            return (false, "proof is bound to a different address");
        }
        if (
            pub[MANUAL_MIN_TIER] != minTier || pub[MANUAL_JURISDICTION_MASK] != jurisdictionMask
        ) {
            return (false, "policy mismatch");
        }
        if (pub[MANUAL_PASSES] != 1) return (false, "policy not satisfied");
        return (true, "");
    }

    function publishRoot(uint64 epoch, uint256 root) external {
        if (msg.sender != issuer) revert NotIssuer();
        if (rootForEpoch[epoch] != 0) revert RootAlreadySet(epoch);
        rootForEpoch[epoch] = root;
        emit RootPublished(epoch, root);
    }

    function publishViewKey(uint64 viewKeyEpoch, uint256 x, uint256 y) external {
        if (msg.sender != issuer) revert NotIssuer();
        if (viewKeyForEpoch[viewKeyEpoch].published) {
            revert ViewKeyAlreadyPublished(viewKeyEpoch);
        }
        _requireFieldElement(x);
        _requireFieldElement(y);
        viewKeyForEpoch[viewKeyEpoch] = ViewKey({x: x, y: y, published: true});
        emit ViewKeyPublished(viewKeyEpoch, x, y);
    }

    function publishSessionRoot(uint64 rotationEpoch, uint256 root, uint64 viewKeyEpoch)
        external
    {
        if (msg.sender != issuer) revert NotIssuer();
        if (sessionRootForEpoch[rotationEpoch] != 0) {
            revert RootAlreadySet(rotationEpoch);
        }
        if (!viewKeyForEpoch[viewKeyEpoch].published) {
            revert ViewKeyNotPublished(viewKeyEpoch);
        }
        _requireFieldElement(root);
        if (root == 0) revert InvalidFieldElement(root);

        sessionRootForEpoch[rotationEpoch] = root;
        viewKeyEpochForRotationEpoch[rotationEpoch] = viewKeyEpoch;
        emit SessionRootPublished(rotationEpoch, root, viewKeyEpoch);
    }

    function proposePolicy(uint256 minTier_, uint256 mask_) external {
        if (msg.sender != issuer) revert NotIssuer();
        pendingMinTier = minTier_;
        pendingJurisdictionMask = mask_;
        pendingPolicyEpoch = registry.currentEpoch() + 1;
        emit PolicyProposed(minTier_, mask_, pendingPolicyEpoch);
    }

    function adoptPolicy() external {
        uint64 epoch = registry.currentEpoch();
        if (pendingPolicyEpoch == 0 || epoch < pendingPolicyEpoch) {
            revert PolicyNotYetEffective(pendingPolicyEpoch, epoch);
        }
        minTier = pendingMinTier;
        jurisdictionMask = pendingJurisdictionMask;
        pendingPolicyEpoch = 0;
        emit PolicyAdopted(minTier, jurisdictionMask, epoch);
    }

    function _requireFieldElement(uint256 value) private pure {
        if (value >= SNARK_SCALAR_FIELD) revert InvalidFieldElement(value);
    }
}
