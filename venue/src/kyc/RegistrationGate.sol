// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IPlonkVerifier} from "./IPlonkVerifier.sol";
import {ZkKycRegistry} from "./ZkKycRegistry.sol";

/// @title RegistrationGate
/// @notice The write half of the two transaction structure. Verifies a proof and,
///         only then, tells `ZkKycRegistry` to grant.
///
/// ## The frozen circuit interface
///
/// `circuits/kyc.circom` emits its public signals in snarkjs order: outputs
/// first, then public inputs in declaration order. Seven signals.
///
/// | # | signal | chosen by | how it is bound here |
/// |---|---|---|---|
/// | 0 | `nullifier` | the circuit | not pinned. It is the output. Bounded by an invariant's counter |
/// | 1 | `passes` | the circuit | **must equal 1.** See below |
/// | 2 | `credentialRoot` | **the prover** | pinned to the issuer's published root for this epoch |
/// | 3 | `epoch` | **the prover** | pinned to the registry's current epoch |
/// | 4 | `registrant` | **the prover** | pinned to the account being granted. an invariant |
/// | 5 | `minTier` | **the prover** | pinned to this gate's policy |
/// | 6 | `jurisdictionMask` | **the prover** | pinned to this gate's policy |
///
/// **Five of the seven are attacker chosen and every one of them has to be
/// pinned.** This is the failure mode that looks like nothing in review, because
/// the proof does verify and the circuit is correct. A prover who is free to
/// choose signal 5 sets `minTier = 0`; free to choose signal 6, sets the mask to
/// all ones; free to choose signal 2, supplies the root of a tree they built
/// themselves containing one credential they wrote. In each case the proof is
/// honest, `passes` is genuinely 1, and the policy has been replaced by the
/// attacker's. Verification is not authorisation. The circuit proves a statement;
/// this contract decides which statement is worth anything.
///
/// ## `passes` is checked separately, and that is not redundant
///
/// Measured on the real circuit, not argued. All four policy failure modes,
/// wrong tier, expired credential, excluded jurisdiction and a root that is not
/// the issuer's, produce proofs that **verify** with `passes = 0`. So
/// `verifyProof` returning true carries no compliance information at all on this
/// circuit. This is the shape of an earlier measurement one layer up: the check cannot
/// distinguish false from could not check, so the caller has to read the answer
/// rather than the fact that an answer was produced.
///
/// ## Ordering: cheap refusals first
///
/// an invariant. A sponsored registration is paid for by the relay, and proof validity
/// does not carry the sybil bound. So the relay needs to know a submission will
/// be refused before it pays, and the gate needs to refuse without spending the
/// verification gas. Every pinned equality is checked before `verifyProof` is
/// called, and the nullifier counter is checked first of all.
contract RegistrationGate {
    // ------------------------------------------- frozen signal layout

    uint256 internal constant SIG_NULLIFIER = 0;
    uint256 internal constant SIG_PASSES = 1;
    uint256 internal constant SIG_ROOT = 2;
    uint256 internal constant SIG_EPOCH = 3;
    uint256 internal constant SIG_REGISTRANT = 4;
    uint256 internal constant SIG_MIN_TIER = 5;
    uint256 internal constant SIG_JUR_MASK = 6;

    IPlonkVerifier public immutable verifier;
    ZkKycRegistry public immutable registry;
    address public immutable issuer;

    /// @notice The issuer's valid-credential root, per epoch.
    /// @dev Revocation is by omission: a credential is revoked by not appearing in
    ///      the next epoch's tree. One Merkle proof rather than two, at the cost
    ///      of one epoch of latency, which is the latency an invariant and an invariant
    ///      already impose on everything else.
    mapping(uint64 => uint256) public rootForEpoch;

    /// @notice The policy the circuit must have been evaluated against.
    uint256 public minTier;
    uint256 public jurisdictionMask;
    /// @dev Rule 2 again. A policy that moves on demand is itself an observation.
    uint256 public pendingMinTier;
    uint256 public pendingJurisdictionMask;
    uint64 public pendingPolicyEpoch;

    event Registered(address indexed account, uint64 indexed epoch, bytes32 nullifier);
    event RootPublished(uint64 indexed epoch, uint256 root);
    event PolicyProposed(uint256 minTier, uint256 mask, uint64 effectiveEpoch);
    event PolicyAdopted(uint256 minTier, uint256 mask, uint64 epoch);

    error NotIssuer();
    error RootAlreadySet(uint64 epoch);
    error RootNotPublished(uint64 epoch);
    error EpochMismatch(uint256 got, uint64 want);
    error RootMismatch(uint256 got, uint256 want);
    error RegistrantMismatch(uint256 got, address want);
    error PolicyMismatch(uint256 gotTier, uint256 gotMask);
    error PolicyNotSatisfied();
    error ProofInvalid();
    error NullifierExhausted(bytes32 nullifier);
    error PolicyNotYetEffective(uint64 effectiveEpoch, uint64 current);

    constructor(
        IPlonkVerifier verifier_,
        ZkKycRegistry registry_,
        address issuer_,
        uint256 minTier_,
        uint256 jurisdictionMask_
    ) {
        verifier = verifier_;
        registry = registry_;
        issuer = issuer_;
        minTier = minTier_;
        jurisdictionMask = jurisdictionMask_;
    }

    // ------------------------------------------------------ the registration

    /// @notice Verify a proof and grant `account` eligibility for this epoch.
    /// @dev Permissionless in `msg.sender` on purpose. Under HIP-410 the relay
    ///      pays and submits, so the caller is routinely not the registrant.
    ///      Safety does not come from who calls: it comes from signal 4 being
    ///      pinned to `account`, which is what makes a lifted proof useless for
    ///      registering any address other than the one it was made for.
    function register(
        address account,
        uint256[24] calldata proof,
        uint256[7] calldata pub
    ) external {
        uint64 epoch = registry.currentEpoch();
        bytes32 nullifier = bytes32(pub[SIG_NULLIFIER]);

        // --- an invariant. First, and cheapest. The relay reads the same counter
        //     off chain before it pays, and this is the on chain twin of that read.
        if (registry.usesThisEpoch(nullifier) >= registry.MAX_USES_PER_EPOCH()) {
            revert NullifierExhausted(nullifier);
        }

        // --- pin every attacker chosen signal, all still before verification
        if (pub[SIG_EPOCH] != uint256(epoch)) {
            revert EpochMismatch(pub[SIG_EPOCH], epoch);
        }
        uint256 want = rootForEpoch[epoch];
        if (want == 0) revert RootNotPublished(epoch);
        if (pub[SIG_ROOT] != want) revert RootMismatch(pub[SIG_ROOT], want);
        if (pub[SIG_REGISTRANT] != uint256(uint160(account))) {
            revert RegistrantMismatch(pub[SIG_REGISTRANT], account);
        }
        if (pub[SIG_MIN_TIER] != minTier || pub[SIG_JUR_MASK] != jurisdictionMask) {
            revert PolicyMismatch(pub[SIG_MIN_TIER], pub[SIG_JUR_MASK]);
        }

        // --- the output the verifier does not check for us
        if (pub[SIG_PASSES] != 1) revert PolicyNotSatisfied();

        // --- and only now the expensive part
        if (!verifier.verifyProof(proof, pub)) revert ProofInvalid();

        registry.grant(account, nullifier);
        emit Registered(account, epoch, nullifier);
    }

    /// @notice What the relay calls before it pays. an invariant's off chain half,
    ///         exposed so the relay reads exactly the state the gate will read.
    /// @dev Deliberately duplicates the checks rather than sharing a modifier, so
    ///      that a divergence between the preview and the gate shows up as two
    ///      different answers in a test rather than as a silent agreement.
    function wouldAccept(address account, uint256[7] calldata pub)
        external
        view
        returns (bool ok, string memory reason)
    {
        uint64 epoch = registry.currentEpoch();
        if (registry.usesThisEpoch(bytes32(pub[SIG_NULLIFIER])) >= registry.MAX_USES_PER_EPOCH()) {
            return (false, "nullifier exhausted for this epoch");
        }
        if (pub[SIG_EPOCH] != uint256(epoch)) return (false, "wrong epoch");
        if (rootForEpoch[epoch] == 0) return (false, "root not published");
        if (pub[SIG_ROOT] != rootForEpoch[epoch]) return (false, "wrong credential root");
        if (pub[SIG_REGISTRANT] != uint256(uint160(account))) {
            return (false, "proof is bound to a different address");
        }
        if (pub[SIG_MIN_TIER] != minTier || pub[SIG_JUR_MASK] != jurisdictionMask) {
            return (false, "policy mismatch");
        }
        if (pub[SIG_PASSES] != 1) return (false, "policy not satisfied");
        return (true, "");
    }

    // ------------------------------------------------------- issuer actions

    /// @notice Publish the valid-credential root for an epoch.
    /// @dev Write once per epoch. A root that could be replaced mid epoch would
    ///      let the issuer revoke inside an epoch, which contradicts the stated
    ///      revocation latency and, worse, would make the latency depend on
    ///      issuer behaviour rather than on the schedule.
    function publishRoot(uint64 epoch, uint256 root) external {
        if (msg.sender != issuer) revert NotIssuer();
        if (rootForEpoch[epoch] != 0) revert RootAlreadySet(epoch);
        rootForEpoch[epoch] = root;
        emit RootPublished(epoch, root);
    }

    // ----------------------------------------------- policy, an invariant / Rule 2

    function proposePolicy(uint256 minTier_, uint256 mask_) external {
        if (msg.sender != issuer) revert NotIssuer();
        pendingMinTier = minTier_;
        pendingJurisdictionMask = mask_;
        pendingPolicyEpoch = registry.currentEpoch() + 1;
        emit PolicyProposed(minTier_, mask_, pendingPolicyEpoch);
    }

    function adoptPolicy() external {
        uint64 e = registry.currentEpoch();
        if (pendingPolicyEpoch == 0 || e < pendingPolicyEpoch) {
            revert PolicyNotYetEffective(pendingPolicyEpoch, e);
        }
        minTier = pendingMinTier;
        jurisdictionMask = pendingJurisdictionMask;
        pendingPolicyEpoch = 0;
        emit PolicyAdopted(minTier, jurisdictionMask, e);
    }
}
