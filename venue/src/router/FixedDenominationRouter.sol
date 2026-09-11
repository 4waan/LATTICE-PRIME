// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IKyc} from "../interfaces/IKyc.sol";
import {
    IFixedWithdrawalVerifier,
    IFixedWithdrawalComplianceVerifier
} from "./IRouterVerifiers.sol";
import {IPoseidon2, IRouterKycRegistry, IRouterSessionFactory} from "./IRouterDependencies.sol";

/// @title FixedDenominationRouter
/// @notice Shared proof, Merkle, delay, anonymity, and eligibility boundary.
/// @dev Asset-specific custody is implemented by HbarFixedDenominationRouter
///      and LprcFixedDenominationRouter. There is no bearer transfer surface.
abstract contract FixedDenominationRouter {
    uint256 public constant TREE_DEPTH = 20;
    uint32 public constant TREE_CAPACITY = uint32(1 << TREE_DEPTH);
    uint32 public constant MAX_COMMITMENT_PAGE = 256;
    uint32 public constant DEFAULT_MINIMUM_REAL_NOTES = 8;
    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    uint256 internal constant WITHDRAWAL_NULLIFIER = 0;
    uint256 internal constant WITHDRAWAL_BRIDGE = 1;
    uint256 internal constant WITHDRAWAL_ROOT = 2;
    uint256 internal constant WITHDRAWAL_RECIPIENT = 3;
    uint256 internal constant WITHDRAWAL_POOL = 4;
    uint256 internal constant WITHDRAWAL_ASSET = 5;
    uint256 internal constant WITHDRAWAL_DENOMINATION = 6;
    uint256 internal constant WITHDRAWAL_CHAIN_ID = 7;

    uint256 internal constant COMPLIANCE_ENCRYPTED_COMMITMENT = 0;
    uint256 internal constant COMPLIANCE_TAG = 1;
    uint256 internal constant COMPLIANCE_EPHEMERAL_X = 2;
    uint256 internal constant COMPLIANCE_EPHEMERAL_Y = 3;
    uint256 internal constant COMPLIANCE_BRIDGE = 4;
    uint256 internal constant COMPLIANCE_ROOT = 5;
    uint256 internal constant COMPLIANCE_RECIPIENT = 6;
    uint256 internal constant COMPLIANCE_POOL = 7;
    uint256 internal constant COMPLIANCE_ASSET = 8;
    uint256 internal constant COMPLIANCE_DENOMINATION = 9;
    uint256 internal constant COMPLIANCE_CHAIN_ID = 10;
    uint256 internal constant COMPLIANCE_VIEW_KEY_EPOCH = 11;
    uint256 internal constant COMPLIANCE_VIEW_KEY_X = 12;
    uint256 internal constant COMPLIANCE_VIEW_KEY_Y = 13;

    struct RootMetadata {
        uint64 acceptedAt;
        uint32 realNotes;
        uint32 independentFunders;
        bool known;
    }

    struct ComplianceCiphertext {
        uint256 encryptedCommitment;
        uint256 tag;
        uint256 ephemeralX;
        uint256 ephemeralY;
    }

    struct WithdrawalProofBundle {
        uint256[24] withdrawalProof;
        uint256[8] withdrawalPublicSignals;
        uint256[24] complianceProof;
        uint256[14] compliancePublicSignals;
    }

    IFixedWithdrawalVerifier public immutable withdrawalVerifier;
    IFixedWithdrawalComplianceVerifier public immutable complianceVerifier;
    IPoseidon2 public immutable poseidon;
    bytes32 public immutable poseidonRuntimeCodeHash;
    IRouterKycRegistry public immutable registry;
    IRouterSessionFactory public immutable sessionFactory;
    address public immutable admin;
    address public immutable asset;
    uint256 public immutable denomination;
    uint64 public immutable minimumWithdrawalDelay;
    uint64 public immutable maximumRootAge;
    uint256 public immutable deploymentChainId;

    uint256[TREE_DEPTH] public zeroAtLevel;
    uint256[TREE_DEPTH] public filledSubtree;
    uint32 public nextLeafIndex;
    uint256 public currentRoot;
    uint32 public independentFunders;
    uint32 public minimumRealNotes;
    uint64 public activeViewKeyEpoch;
    uint256 public activeViewKeyX;
    uint256 public activeViewKeyY;
    uint256 public totalDeposited;
    uint256 public totalWithdrawn;

    mapping(uint256 => RootMetadata) public rootMetadata;
    mapping(uint256 => bool) public commitmentSeen;
    mapping(uint32 => uint256) public commitmentAt;
    mapping(uint32 => uint256) public rootAtNoteCount;
    mapping(bytes32 => bool) public nullifierSpent;
    mapping(address => bool) public hasFunded;

    uint256 private _reentrancyLock;

    event Deposited(
        uint256 indexed commitment,
        uint32 indexed leafIndex,
        uint256 indexed root,
        address depositor,
        address asset,
        uint256 denomination,
        uint64 acceptedAt
    );
    event Withdrawn(
        bytes32 indexed nullifier,
        address indexed recipient,
        uint256 indexed root,
        address asset,
        uint256 denomination
    );
    event RouterComplianceRecord(
        bytes32 indexed nullifier,
        address indexed recipient,
        uint64 indexed viewKeyEpoch,
        uint256 encryptedCommitment,
        uint256 tag,
        uint256 ephemeralX,
        uint256 ephemeralY
    );
    event MinimumRealNotesUpdated(uint32 previousMinimum, uint32 newMinimum);
    event ViewKeyUpdated(uint64 indexed viewKeyEpoch, uint256 x, uint256 y);

    error NotAdmin();
    error DependencyNotContract(address dependency);
    error InvalidFieldElement(uint256 value);
    error InvalidDenomination();
    error InvalidDelay();
    error InvalidMinimumRealNotes(uint32 value);
    error InvalidViewKeyEpoch(uint64 current, uint64 proposed);
    error PoseidonCodeChanged(bytes32 expected, bytes32 actual);
    error PoseidonOutputInvalid(uint256 output);
    error CommitmentAlreadySeen(uint256 commitment);
    error TreeFull();
    error CommitmentRangeInvalid(uint32 start, uint32 count);
    error UnknownRoot(uint256 root);
    error RootTooYoung(uint64 acceptedAt, uint256 availableAt);
    error StaleRoot(uint64 acceptedAt, uint256 expiredAt);
    error AnonymityThresholdNotMet(uint32 realNotes, uint32 required);
    error IndependentFundersThresholdNotMet(uint32 funders, uint32 required);
    error NullifierAlreadySpent(bytes32 nullifier);
    error RecipientNotEligible(address recipient);
    error PublicSignalMismatch(uint256 got, uint256 expected);
    error SplitProofMismatch(uint256 withdrawalValue, uint256 complianceValue);
    error CiphertextMismatch();
    error WithdrawalProofInvalid();
    error ComplianceProofInvalid();
    error ReentrantCall();
    error Insolvent(uint256 available, uint256 liability);

    constructor(
        IFixedWithdrawalVerifier withdrawalVerifier_,
        IFixedWithdrawalComplianceVerifier complianceVerifier_,
        IPoseidon2 poseidon_,
        IRouterKycRegistry registry_,
        IRouterSessionFactory sessionFactory_,
        address admin_,
        address asset_,
        uint256 denomination_,
        uint64 minimumWithdrawalDelay_,
        uint64 maximumRootAge_,
        uint32 minimumRealNotes_,
        uint64 viewKeyEpoch_,
        uint256 viewKeyX_,
        uint256 viewKeyY_
    ) {
        _requireContract(address(withdrawalVerifier_));
        _requireContract(address(complianceVerifier_));
        _requireContract(address(poseidon_));
        _requireContract(address(registry_));
        _requireContract(address(sessionFactory_));
        if (denomination_ == 0 || denomination_ >= SNARK_SCALAR_FIELD) {
            revert InvalidDenomination();
        }
        if (minimumWithdrawalDelay_ == 0 || maximumRootAge_ <= minimumWithdrawalDelay_) {
            revert InvalidDelay();
        }

        uint32 configuredMinimum =
            minimumRealNotes_ == 0 ? DEFAULT_MINIMUM_REAL_NOTES : minimumRealNotes_;
        if (configuredMinimum < DEFAULT_MINIMUM_REAL_NOTES || configuredMinimum > TREE_CAPACITY)
        {
            revert InvalidMinimumRealNotes(configuredMinimum);
        }
        _requireFieldElement(viewKeyX_);
        _requireFieldElement(viewKeyY_);
        if (block.chainid >= SNARK_SCALAR_FIELD) {
            revert InvalidFieldElement(block.chainid);
        }

        withdrawalVerifier = withdrawalVerifier_;
        complianceVerifier = complianceVerifier_;
        poseidon = poseidon_;
        registry = registry_;
        sessionFactory = sessionFactory_;
        admin = admin_;
        asset = asset_;
        denomination = denomination_;
        minimumWithdrawalDelay = minimumWithdrawalDelay_;
        maximumRootAge = maximumRootAge_;
        minimumRealNotes = configuredMinimum;
        activeViewKeyEpoch = viewKeyEpoch_;
        activeViewKeyX = viewKeyX_;
        activeViewKeyY = viewKeyY_;
        deploymentChainId = block.chainid;

        bytes32 runtimeHash;
        assembly {
            runtimeHash := extcodehash(poseidon_)
        }
        poseidonRuntimeCodeHash = runtimeHash;

        uint256 zero;
        for (uint256 level = 0; level < TREE_DEPTH; ++level) {
            zeroAtLevel[level] = zero;
            filledSubtree[level] = zero;
            zero = _hashPair(zero, zero);
        }
        currentRoot = zero;
        rootAtNoteCount[0] = zero;
        rootMetadata[zero] = RootMetadata({
            acceptedAt: uint64(block.timestamp),
            realNotes: 0,
            independentFunders: 0,
            known: true
        });
    }

    modifier nonReentrant() {
        if (_reentrancyLock != 0) revert ReentrantCall();
        _reentrancyLock = 1;
        _;
        _reentrancyLock = 0;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    function setMinimumRealNotes(uint32 nextMinimum) external onlyAdmin {
        if (nextMinimum < DEFAULT_MINIMUM_REAL_NOTES || nextMinimum > TREE_CAPACITY) {
            revert InvalidMinimumRealNotes(nextMinimum);
        }
        uint32 previous = minimumRealNotes;
        minimumRealNotes = nextMinimum;
        emit MinimumRealNotesUpdated(previous, nextMinimum);
    }

    function setViewKey(uint64 nextEpoch, uint256 x, uint256 y) external onlyAdmin {
        if (nextEpoch <= activeViewKeyEpoch) {
            revert InvalidViewKeyEpoch(activeViewKeyEpoch, nextEpoch);
        }
        _requireFieldElement(x);
        _requireFieldElement(y);
        activeViewKeyEpoch = nextEpoch;
        activeViewKeyX = x;
        activeViewKeyY = y;
        emit ViewKeyUpdated(nextEpoch, x, y);
    }

    function commitmentRange(uint32 start, uint32 count)
        external
        view
        returns (uint256[] memory values)
    {
        uint32 end = start + count;
        if (
            count == 0 || count > MAX_COMMITMENT_PAGE || end < start
                || end > nextLeafIndex
        ) {
            revert CommitmentRangeInvalid(start, count);
        }
        values = new uint256[](count);
        for (uint32 index = 0; index < count; ++index) {
            values[index] = commitmentAt[start + index];
        }
    }

    /// @notice Permissionless relayed withdrawal to a canonical eligible session.
    function withdraw(
        address payable recipient,
        ComplianceCiphertext calldata ciphertext,
        WithdrawalProofBundle calldata bundle
    ) external nonReentrant {
        bytes32 nullifier = bytes32(bundle.withdrawalPublicSignals[WITHDRAWAL_NULLIFIER]);
        if (nullifierSpent[nullifier]) revert NullifierAlreadySpent(nullifier);

        uint256 root = bundle.withdrawalPublicSignals[WITHDRAWAL_ROOT];
        {
            RootMetadata memory metadata = rootMetadata[root];
            if (!metadata.known) revert UnknownRoot(root);
            uint256 availableAt = uint256(metadata.acceptedAt) + minimumWithdrawalDelay;
            if (block.timestamp < availableAt) {
                revert RootTooYoung(metadata.acceptedAt, availableAt);
            }
            uint256 expiredAt = uint256(metadata.acceptedAt) + maximumRootAge;
            if (root != currentRoot && block.timestamp > expiredAt) {
                revert StaleRoot(metadata.acceptedAt, expiredAt);
            }
            if (metadata.realNotes < minimumRealNotes) {
                revert AnonymityThresholdNotMet(metadata.realNotes, minimumRealNotes);
            }
            if (metadata.independentFunders < minimumRealNotes) {
                revert IndependentFundersThresholdNotMet(
                    metadata.independentFunders, minimumRealNotes
                );
            }
        }
        if (!_isEligibleSession(recipient)) {
            revert RecipientNotEligible(recipient);
        }

        _pinWithdrawalSignals(
            recipient, root, bundle.withdrawalPublicSignals, bundle.compliancePublicSignals
        );
        _pinComplianceCiphertext(ciphertext, bundle.compliancePublicSignals);

        if (!withdrawalVerifier.verifyProof(
                bundle.withdrawalProof, bundle.withdrawalPublicSignals
            )) {
            revert WithdrawalProofInvalid();
        }
        if (!complianceVerifier.verifyProof(
                bundle.complianceProof, bundle.compliancePublicSignals
            )) {
            revert ComplianceProofInvalid();
        }

        nullifierSpent[nullifier] = true;
        totalWithdrawn += denomination;
        _payout(recipient);
        _requireSolvent();

        _emitWithdrawal(nullifier, recipient, root, ciphertext);
    }

    function _emitWithdrawal(
        bytes32 nullifier,
        address recipient,
        uint256 root,
        ComplianceCiphertext calldata ciphertext
    ) private {
        emit Withdrawn(nullifier, recipient, root, asset, denomination);
        emit RouterComplianceRecord(
            nullifier,
            recipient,
            activeViewKeyEpoch,
            ciphertext.encryptedCommitment,
            ciphertext.tag,
            ciphertext.ephemeralX,
            ciphertext.ephemeralY
        );
    }

    function _insert(uint256 commitment, address depositor) internal returns (uint256 newRoot) {
        _requireFieldElement(commitment);
        if (commitment == 0) revert InvalidFieldElement(commitment);
        if (commitmentSeen[commitment]) revert CommitmentAlreadySeen(commitment);

        uint32 index = nextLeafIndex;
        if (index >= TREE_CAPACITY) revert TreeFull();
        commitmentSeen[commitment] = true;
        commitmentAt[index] = commitment;

        uint256 current = commitment;
        uint256 cursor = uint256(index);
        for (uint256 level = 0; level < TREE_DEPTH; ++level) {
            if ((cursor & 1) == 0) {
                filledSubtree[level] = current;
                current = _hashPair(current, zeroAtLevel[level]);
            } else {
                current = _hashPair(filledSubtree[level], current);
            }
            cursor >>= 1;
        }

        nextLeafIndex = index + 1;
        uint32 funders = independentFunders;
        if (!hasFunded[depositor]) {
            hasFunded[depositor] = true;
            funders += 1;
            independentFunders = funders;
        }
        currentRoot = current;
        rootAtNoteCount[index + 1] = current;
        rootMetadata[current] = RootMetadata({
            acceptedAt: uint64(block.timestamp),
            realNotes: index + 1,
            independentFunders: funders,
            known: true
        });
        totalDeposited += denomination;

        emit Deposited(
            commitment, index, current, depositor, asset, denomination, uint64(block.timestamp)
        );
        return current;
    }

    function _pinWithdrawalSignals(
        address recipient,
        uint256 root,
        uint256[8] calldata withdrawalPublicSignals,
        uint256[14] calldata compliancePublicSignals
    ) private view {
        _requireSignal(
            withdrawalPublicSignals[WITHDRAWAL_RECIPIENT], uint256(uint160(recipient))
        );
        _requireSignal(
            withdrawalPublicSignals[WITHDRAWAL_POOL], uint256(uint160(address(this)))
        );
        _requireSignal(withdrawalPublicSignals[WITHDRAWAL_ASSET], uint256(uint160(asset)));
        _requireSignal(withdrawalPublicSignals[WITHDRAWAL_DENOMINATION], denomination);
        _requireSignal(withdrawalPublicSignals[WITHDRAWAL_CHAIN_ID], deploymentChainId);

        _requireSplit(
            withdrawalPublicSignals[WITHDRAWAL_BRIDGE],
            compliancePublicSignals[COMPLIANCE_BRIDGE]
        );
        _requireSplit(root, compliancePublicSignals[COMPLIANCE_ROOT]);
        _requireSplit(
            withdrawalPublicSignals[WITHDRAWAL_RECIPIENT],
            compliancePublicSignals[COMPLIANCE_RECIPIENT]
        );
        _requireSplit(
            withdrawalPublicSignals[WITHDRAWAL_POOL], compliancePublicSignals[COMPLIANCE_POOL]
        );
        _requireSplit(
            withdrawalPublicSignals[WITHDRAWAL_ASSET], compliancePublicSignals[COMPLIANCE_ASSET]
        );
        _requireSplit(
            withdrawalPublicSignals[WITHDRAWAL_DENOMINATION],
            compliancePublicSignals[COMPLIANCE_DENOMINATION]
        );
        _requireSplit(
            withdrawalPublicSignals[WITHDRAWAL_CHAIN_ID],
            compliancePublicSignals[COMPLIANCE_CHAIN_ID]
        );

        _requireSignal(
            compliancePublicSignals[COMPLIANCE_VIEW_KEY_EPOCH], uint256(activeViewKeyEpoch)
        );
        _requireSignal(compliancePublicSignals[COMPLIANCE_VIEW_KEY_X], activeViewKeyX);
        _requireSignal(compliancePublicSignals[COMPLIANCE_VIEW_KEY_Y], activeViewKeyY);
    }

    function _pinComplianceCiphertext(
        ComplianceCiphertext calldata ciphertext,
        uint256[14] calldata compliancePublicSignals
    ) private pure {
        if (
            ciphertext.encryptedCommitment
                    != compliancePublicSignals[COMPLIANCE_ENCRYPTED_COMMITMENT]
                || ciphertext.tag != compliancePublicSignals[COMPLIANCE_TAG]
                || ciphertext.ephemeralX != compliancePublicSignals[COMPLIANCE_EPHEMERAL_X]
                || ciphertext.ephemeralY != compliancePublicSignals[COMPLIANCE_EPHEMERAL_Y]
        ) {
            revert CiphertextMismatch();
        }
    }

    function _isEligibleSession(address recipient) private view returns (bool) {
        if (
            recipient.code.length == 0 || !sessionFactory.isSessionAccount(recipient)
                || registry.getKycStatus(recipient) != IKyc.KycStatus.GRANTED
        ) {
            return false;
        }

        bytes32 recordedHash = sessionFactory.deployedCodeHash(recipient);
        bytes32 actualHash;
        assembly {
            actualHash := extcodehash(recipient)
        }
        return recordedHash != bytes32(0) && recordedHash == actualHash;
    }

    function _requireRouterEligible() internal view {
        if (registry.getKycStatus(address(this)) != IKyc.KycStatus.GRANTED) {
            revert RecipientNotEligible(address(this));
        }
    }

    function _requireSolvent() internal view {
        uint256 liability = totalDeposited - totalWithdrawn;
        uint256 available = _assetBalance();
        if (available < liability) revert Insolvent(available, liability);
    }

    function _hashPair(uint256 left, uint256 right) private view returns (uint256) {
        bytes32 actualHash;
        address hasher = address(poseidon);
        assembly {
            actualHash := extcodehash(hasher)
        }
        if (actualHash != poseidonRuntimeCodeHash) {
            revert PoseidonCodeChanged(poseidonRuntimeCodeHash, actualHash);
        }

        uint256[2] memory inputs = [left, right];
        uint256 output = poseidon.poseidon(inputs);
        if (output >= SNARK_SCALAR_FIELD) revert PoseidonOutputInvalid(output);
        return output;
    }

    function _requireSignal(uint256 got, uint256 expected) private pure {
        if (got != expected) revert PublicSignalMismatch(got, expected);
    }

    function _requireSplit(uint256 withdrawalValue, uint256 complianceValue) private pure {
        if (withdrawalValue != complianceValue) {
            revert SplitProofMismatch(withdrawalValue, complianceValue);
        }
    }

    function _requireContract(address dependency) private view {
        if (dependency.code.length == 0) revert DependencyNotContract(dependency);
    }

    function _requireFieldElement(uint256 value) internal pure {
        if (value >= SNARK_SCALAR_FIELD) revert InvalidFieldElement(value);
    }

    function _payout(address payable recipient) internal virtual;
    function _assetBalance() internal view virtual returns (uint256);
}
