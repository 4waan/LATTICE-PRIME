pragma circom 2.1.9;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/babyjub.circom";
include "circomlib/circuits/escalarmulfix.circom";
include "circomlib/circuits/escalarmulany.circom";

/// Compliance-encryption half of the session statement.
///
/// complianceBridge is also emitted by session_eligibility.circom. Recomputing
/// it here prevents combining eligibility for one credential with encryption
/// of another credential. No manual-registration nullifier enters this circuit.
///
/// Public signal order is frozen:
///   0 encryptedCredential
///   1 complianceTag
///   2 ephemeralX
///   3 ephemeralY
///   4 complianceBridge
///   5 credentialRoot
///   6 rotationEpoch
///   7 sessionAccount
///   8 sessionSigner
///   9 factory
///  10 implementationCodeHashLow
///  11 implementationCodeHashHigh
///  12 minTier
///  13 jurisdictionMask
///  14 viewKeyEpoch
///  15 viewPublicKeyX
///  16 viewPublicKeyY
template SessionCompliance() {
    signal input holderSecret;
    signal input credentialId;
    signal input complianceNonce;
    signal input encryptionRandomness;

    signal input complianceBridge;
    signal input credentialRoot;
    signal input rotationEpoch;
    signal input sessionAccount;
    signal input sessionSigner;
    signal input factory;
    signal input implementationCodeHashLow;
    signal input implementationCodeHashHigh;
    signal input minTier;
    signal input jurisdictionMask;
    signal input viewKeyEpoch;
    signal input viewPublicKeyX;
    signal input viewPublicKeyY;

    signal output encryptedCredential;
    signal output complianceTag;
    signal output ephemeralX;
    signal output ephemeralY;

    var DOMAIN_SESSION_PAD = 2026091002;
    var DOMAIN_SESSION_RECORD = 2026091003;
    var DOMAIN_COMPLIANCE_BRIDGE = 2026091004;

    component secretNonZero = IsZero();
    secretNonZero.in <== holderSecret;
    secretNonZero.out === 0;

    component nonceNonZero = IsZero();
    nonceNonZero.in <== complianceNonce;
    nonceNonZero.out === 0;

    component holderCommitment = Poseidon(1);
    holderCommitment.inputs[0] <== holderSecret;

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
    bridge.out === complianceBridge;

    component randomnessBits = Num2Bits(246);
    randomnessBits.in <== encryptionRandomness;
    component randomnessNonZero = IsZero();
    randomnessNonZero.in <== encryptionRandomness;
    randomnessNonZero.out === 0;

    var BASE8[2] = [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ];

    component ephemeral = EscalarMulFix(246, BASE8);
    for (var i = 0; i < 246; i++) {
        ephemeral.e[i] <== randomnessBits.out[i];
    }
    ephemeralX <== ephemeral.out[0];
    ephemeralY <== ephemeral.out[1];

    component viewKeyOnCurve = BabyCheck();
    viewKeyOnCurve.x <== viewPublicKeyX;
    viewKeyOnCurve.y <== viewPublicKeyY;

    component clearTwo = BabyDbl();
    clearTwo.x <== viewPublicKeyX;
    clearTwo.y <== viewPublicKeyY;
    component clearFour = BabyDbl();
    clearFour.x <== clearTwo.xout;
    clearFour.y <== clearTwo.yout;
    component clearEight = BabyDbl();
    clearEight.x <== clearFour.xout;
    clearEight.y <== clearFour.yout;

    component clearedKeyNonZero = IsZero();
    clearedKeyNonZero.in <== clearEight.xout;
    clearedKeyNonZero.out === 0;

    component shared = EscalarMulAny(246);
    for (var j = 0; j < 246; j++) {
        shared.e[j] <== randomnessBits.out[j];
    }
    shared.p[0] <== clearEight.xout;
    shared.p[1] <== clearEight.yout;

    component pad = Poseidon(5);
    pad.inputs[0] <== DOMAIN_SESSION_PAD;
    pad.inputs[1] <== shared.out[0];
    pad.inputs[2] <== shared.out[1];
    pad.inputs[3] <== viewKeyEpoch;
    pad.inputs[4] <== sessionAccount;
    encryptedCredential <== credentialId + pad.out;

    component encryptionContext = Poseidon(6);
    encryptionContext.inputs[0] <== viewKeyEpoch;
    encryptionContext.inputs[1] <== viewPublicKeyX;
    encryptionContext.inputs[2] <== viewPublicKeyY;
    encryptionContext.inputs[3] <== ephemeralX;
    encryptionContext.inputs[4] <== ephemeralY;
    encryptionContext.inputs[5] <== encryptedCredential;

    component recordTag = Poseidon(6);
    recordTag.inputs[0] <== DOMAIN_SESSION_RECORD;
    recordTag.inputs[1] <== credentialId;
    recordTag.inputs[2] <== holderCommitment.out;
    recordTag.inputs[3] <== registrationContext.out;
    recordTag.inputs[4] <== encryptionContext.out;
    recordTag.inputs[5] <== complianceBridge;
    complianceTag <== recordTag.out;
}

component main {
    public [
        complianceBridge,
        credentialRoot,
        rotationEpoch,
        sessionAccount,
        sessionSigner,
        factory,
        implementationCodeHashLow,
        implementationCodeHashHigh,
        minTier,
        jurisdictionMask,
        viewKeyEpoch,
        viewPublicKeyX,
        viewPublicKeyY
    ]
} = SessionCompliance();
