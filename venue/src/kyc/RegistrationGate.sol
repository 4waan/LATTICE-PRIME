// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IPlonkVerifier} from "./IPlonkVerifier.sol";
import {ZkKycRegistry} from "./ZkKycRegistry.sol";

/// @title RegistrationGate
/// @notice Verify a PLONK proof, then grant via `ZkKycRegistry`.
/// @dev Five of seven public signals are prover-chosen and must be pinned here.
///      `verifyProof == true` does not mean compliance: require `passes == 1`.
///      Cheap pins before verification. Layout: `docs/MATH.md`.
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
    /// @dev Revocation by omission from the next epoch's tree. One proof, one epoch of latency.
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
    function register(address account, uint256[24] calldata proof, uint256[7] calldata pub)
        external
    {
        uint64 epoch = registry.currentEpoch();
        bytes32 nullifier = bytes32(pub[SIG_NULLIFIER]);

        // Cheap first: same counter the relay reads before it pays.
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

    /// @notice Relay preview. Duplicates `register`'s cheap checks on purpose.
    function wouldAccept(address account, uint256[7] calldata pub)
        external
        view
        returns (bool ok, string memory reason)
    {
        uint64 epoch = registry.currentEpoch();
        if (
            registry.usesThisEpoch(bytes32(pub[SIG_NULLIFIER])) >= registry.MAX_USES_PER_EPOCH()
        ) {
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

    // Policy moves at an epoch boundary (Rule 2).

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
