pragma circom 2.1.9;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/mux1.circom";

template SessionMerkleLevel() {
    signal input current;
    signal input sibling;
    signal input indexBit;
    signal output parent;

    indexBit * (indexBit - 1) === 0;

    component order = MultiMux1(2);
    order.c[0][0] <== current;
    order.c[0][1] <== sibling;
    order.c[1][0] <== sibling;
    order.c[1][1] <== current;
    order.s <== indexBit;

    component hash = Poseidon(2);
    hash.inputs[0] <== order.out[0];
    hash.inputs[1] <== order.out[1];
    parent <== hash.out;
}

template SessionMerkleInclusion(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    signal current[depth + 1];
    component levels[depth];
    current[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        levels[i] = SessionMerkleLevel();
        levels[i].current <== current[i];
        levels[i].sibling <== pathElements[i];
        levels[i].indexBit <== pathIndices[i];
        current[i + 1] <== levels[i].parent;
    }

    root <== current[depth];
}

/// V2 eligibility half of the session statement.
///
/// The power-15 ceremony cannot fit Merkle eligibility and Baby Jubjub
/// encryption in one snarkjs PLONK circuit. This circuit and
/// session_compliance.circom are linked by complianceBridge. Both circuits
/// prove the same private credentialId, holderSecret preimage, fresh
/// complianceNonce, and registration context.
///
/// The issuer receives holderSecretCommitment, never holderSecret. The V2 leaf
/// is Poseidon(credentialId, Poseidon(holderSecret), jurisdiction, tier,
/// validUntilEpoch).
///
/// Public signal order is frozen:
///   0 sessionSlot
///   1 passes
///   2 complianceBridge
///   3 credentialRoot
///   4 rotationEpoch
///   5 sessionAccount
///   6 sessionSigner
///   7 factory
///   8 implementationCodeHashLow
///   9 implementationCodeHashHigh
///  10 minTier
///  11 jurisdictionMask
template SessionEligibility(depth) {
    signal input holderSecret;
    signal input credentialId;
    signal input jurisdiction;
    signal input tier;
    signal input validUntilEpoch;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal input complianceNonce;

    signal input credentialRoot;
    signal input rotationEpoch;
    signal input sessionAccount;
    signal input sessionSigner;
    signal input factory;
    signal input implementationCodeHashLow;
    signal input implementationCodeHashHigh;
    signal input minTier;
    signal input jurisdictionMask;

    signal output sessionSlot;
    signal output passes;
    signal output complianceBridge;

    var DOMAIN_SESSION_SLOT = 2026091001;
    var DOMAIN_COMPLIANCE_BRIDGE = 2026091004;

    component secretNonZero = IsZero();
    secretNonZero.in <== holderSecret;
    secretNonZero.out === 0;

    component nonceNonZero = IsZero();
    nonceNonZero.in <== complianceNonce;
    nonceNonZero.out === 0;

    component holderCommitment = Poseidon(1);
    holderCommitment.inputs[0] <== holderSecret;

    component credentialLeaf = Poseidon(5);
    credentialLeaf.inputs[0] <== credentialId;
    credentialLeaf.inputs[1] <== holderCommitment.out;
    credentialLeaf.inputs[2] <== jurisdiction;
    credentialLeaf.inputs[3] <== tier;
    credentialLeaf.inputs[4] <== validUntilEpoch;

    component inclusion = SessionMerkleInclusion(depth);
    inclusion.leaf <== credentialLeaf.out;
    for (var i = 0; i < depth; i++) {
        inclusion.pathElements[i] <== pathElements[i];
        inclusion.pathIndices[i] <== pathIndices[i];
    }

    inclusion.root === credentialRoot;

    component slotHash = Poseidon(3);
    slotHash.inputs[0] <== holderSecret;
    slotHash.inputs[1] <== DOMAIN_SESSION_SLOT;
    slotHash.inputs[2] <== rotationEpoch;
    sessionSlot <== slotHash.out;

    component tierOk = GreaterEqThan(16);
    tierOk.in[0] <== tier;
    tierOk.in[1] <== minTier;

    component freshOk = GreaterThan(64);
    freshOk.in[0] <== validUntilEpoch;
    freshOk.in[1] <== rotationEpoch;

    component maskBits = Num2Bits(32);
    maskBits.in <== jurisdictionMask;
    component jurisdictionMatches[32];
    signal jurisdictionAccumulator[33];
    jurisdictionAccumulator[0] <== 0;
    for (var j = 0; j < 32; j++) {
        jurisdictionMatches[j] = IsEqual();
        jurisdictionMatches[j].in[0] <== jurisdiction;
        jurisdictionMatches[j].in[1] <== j;
        jurisdictionAccumulator[j + 1] <==
            jurisdictionAccumulator[j] + jurisdictionMatches[j].out * maskBits.out[j];
    }

    signal policyStageOne;
    policyStageOne <== tierOk.out * freshOk.out;
    passes <== policyStageOne * jurisdictionAccumulator[32];

    component policyHash = Poseidon(2);
    policyHash.inputs[0] <== minTier;
    policyHash.inputs[1] <== jurisdictionMask;

    component registrationContext = Poseidon(8);
    registrationContext.inputs[0] <== sessionAccount;
    registrationContext.inputs[1] <== sessionSigner;
    registrationContext.inputs[2] <== factory;
    registrationContext.inputs[3] <== implementationCodeHashLow;
    registrationContext.inputs[4] <== implementationCodeHashHigh;
    registrationContext.inputs[5] <== credentialRoot;
    registrationContext.inputs[6] <== rotationEpoch;
    registrationContext.inputs[7] <== policyHash.out;

    component bridge = Poseidon(5);
    bridge.inputs[0] <== DOMAIN_COMPLIANCE_BRIDGE;
    bridge.inputs[1] <== credentialId;
    bridge.inputs[2] <== holderCommitment.out;
    bridge.inputs[3] <== complianceNonce;
    bridge.inputs[4] <== registrationContext.out;
    complianceBridge <== bridge.out;
}

component main {
    public [
        credentialRoot,
        rotationEpoch,
        sessionAccount,
        sessionSigner,
        factory,
        implementationCodeHashLow,
        implementationCodeHashHigh,
        minTier,
        jurisdictionMask
    ]
} = SessionEligibility(16);
