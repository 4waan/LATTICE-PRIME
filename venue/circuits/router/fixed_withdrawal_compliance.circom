pragma circom 2.1.9;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/babyjub.circom";
include "circomlib/circuits/escalarmulfix.circom";
include "circomlib/circuits/escalarmulany.circom";

/// Compliance-encryption half of a fixed-denomination withdrawal.
///
/// The bridge is recomputed from the same note commitment and routing context
/// as fixed_withdrawal.circom. This prevents a valid spend proof from being
/// paired with a compliance record for a different deposit.
///
/// Public signal order is frozen:
///   0 encryptedCommitment
///   1 complianceTag
///   2 ephemeralX
///   3 ephemeralY
///   4 complianceBridge
///   5 root
///   6 recipient
///   7 pool
///   8 asset
///   9 denomination
///  10 chainId
///  11 viewKeyEpoch
///  12 viewPublicKeyX
///  13 viewPublicKeyY
template FixedWithdrawalCompliance() {
    signal input noteSecret;
    signal input noteNullifier;
    signal input fundingTag;
    signal input complianceNonce;
    signal input encryptionRandomness;

    signal input complianceBridge;
    signal input root;
    signal input recipient;
    signal input pool;
    signal input asset;
    signal input denomination;
    signal input chainId;
    signal input viewKeyEpoch;
    signal input viewPublicKeyX;
    signal input viewPublicKeyY;

    signal output encryptedCommitment;
    signal output complianceTag;
    signal output ephemeralX;
    signal output ephemeralY;

    var DOMAIN_ROUTER_BRIDGE = 2026091012;
    var DOMAIN_ROUTER_PAD = 2026091013;
    var DOMAIN_ROUTER_RECORD = 2026091014;

    component secretNonZero = IsZero();
    secretNonZero.in <== noteSecret;
    secretNonZero.out === 0;
    component nullifierNonZero = IsZero();
    nullifierNonZero.in <== noteNullifier;
    nullifierNonZero.out === 0;
    component nonceNonZero = IsZero();
    nonceNonZero.in <== complianceNonce;
    nonceNonZero.out === 0;

    component note = Poseidon(7);
    note.inputs[0] <== noteSecret;
    note.inputs[1] <== noteNullifier;
    note.inputs[2] <== fundingTag;
    note.inputs[3] <== chainId;
    note.inputs[4] <== pool;
    note.inputs[5] <== asset;
    note.inputs[6] <== denomination;

    component routingContext = Poseidon(6);
    routingContext.inputs[0] <== root;
    routingContext.inputs[1] <== recipient;
    routingContext.inputs[2] <== pool;
    routingContext.inputs[3] <== asset;
    routingContext.inputs[4] <== denomination;
    routingContext.inputs[5] <== chainId;

    component bridge = Poseidon(4);
    bridge.inputs[0] <== DOMAIN_ROUTER_BRIDGE;
    bridge.inputs[1] <== note.out;
    bridge.inputs[2] <== complianceNonce;
    bridge.inputs[3] <== routingContext.out;
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

    component pad = Poseidon(6);
    pad.inputs[0] <== DOMAIN_ROUTER_PAD;
    pad.inputs[1] <== shared.out[0];
    pad.inputs[2] <== shared.out[1];
    pad.inputs[3] <== viewKeyEpoch;
    pad.inputs[4] <== recipient;
    pad.inputs[5] <== pool;
    encryptedCommitment <== note.out + pad.out;

    component encryptionContext = Poseidon(6);
    encryptionContext.inputs[0] <== viewKeyEpoch;
    encryptionContext.inputs[1] <== viewPublicKeyX;
    encryptionContext.inputs[2] <== viewPublicKeyY;
    encryptionContext.inputs[3] <== ephemeralX;
    encryptionContext.inputs[4] <== ephemeralY;
    encryptionContext.inputs[5] <== encryptedCommitment;

    component record = Poseidon(6);
    record.inputs[0] <== DOMAIN_ROUTER_RECORD;
    record.inputs[1] <== note.out;
    record.inputs[2] <== routingContext.out;
    record.inputs[3] <== encryptionContext.out;
    record.inputs[4] <== complianceBridge;
    record.inputs[5] <== fundingTag;
    complianceTag <== record.out;
}

component main {
    public [
        complianceBridge,
        root,
        recipient,
        pool,
        asset,
        denomination,
        chainId,
        viewKeyEpoch,
        viewPublicKeyX,
        viewPublicKeyY
    ]
} = FixedWithdrawalCompliance();
