pragma circom 2.1.9;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/mux1.circom";

// One level of a Poseidon Merkle path. `bit` selects which side the sibling is on.
template MerkleLevel() {
    signal input cur;
    signal input sibling;
    signal input bit;          // 0: cur is the left child, 1: cur is the right
    signal output out;

    bit * (bit - 1) === 0;     // boolean, or the path can be forged

    component mux = MultiMux1(2);
    mux.c[0][0] <== cur;
    mux.c[0][1] <== sibling;
    mux.c[1][0] <== sibling;
    mux.c[1][1] <== cur;
    mux.s <== bit;

    component h = Poseidon(2);
    h.inputs[0] <== mux.out[0];
    h.inputs[1] <== mux.out[1];
    out <== h.out;
}

template MerkleInclusion(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    component levels[depth];
    signal cur[depth + 1];
    cur[0] <== leaf;
    for (var i = 0; i < depth; i++) {
        levels[i] = MerkleLevel();
        levels[i].cur <== cur[i];
        levels[i].sibling <== pathElements[i];
        levels[i].bit <== pathIndices[i];
        cur[i + 1] <== levels[i].out;
    }
    root <== cur[depth];
}

// ---------------------------------------------------------------------------
// KycRegistration
//
// Proves: the prover holds a credential in the issuer's set for this epoch, the
// credential meets the policy, and the nullifier is the one that credential
// generates for this epoch. Reveals: the nullifier, and whether the checks
// passed. Nothing else.
//
// Design notes that are load bearing, each one traceable to a decision already
// taken elsewhere in the project.
//
// 1. REVOCATION IS BY OMISSION, NOT BY NON MEMBERSHIP. The issuer republishes
//    the tree of currently valid credentials once per epoch, and revoking means
//    leaving a leaf out of the next one. A non membership proof against a second
//    sparse tree would roughly double the circuit and buy immediacy the rest of
//    the design does not have anyway: an invariant already defers governance to epoch
//    boundaries and an invariant already expires every grant at one. The stated cost is
//    that revocation takes effect at the next boundary and not before, which is
//    the same latency every other control in this system has.
//
// 2. THE NULLIFIER IS PER EPOCH. `n = Poseidon(secret, DOMAIN_KYC, epoch)`. The
//    epoch is the `ctx` of the F5b construction and it is what cuts the join: two
//    registrations by the same holder in different epochs are unlinkable to
//    anyone without the secret. an invariant is why the secret and not the credential
//    id is the seed, and it is also why the secret must never be the disclosure
//    plaintext: one lawful disclosure of `secret` would retroactively deanonymise
//    the holder's whole history.
//
// 3. THE REGISTRANT ADDRESS IS INSIDE THE CONSTRAINT SYSTEM. an invariant. Without it
//    a valid proof is a bearer token: anyone watching the mempool, or any of the
//    29 node operators holding the plaintext body pre consensus, can lift it and
//    register their own address against someone else's credential. Binding needs
//    a real constraint, because a public input that no constraint touches is
//    optimised out of the R1CS and silently stops being bound. The squaring
//    below is that constraint and it exists for no other reason.
//
// 4. `passes` IS AN OUTPUT, NOT AN ASSERTION. A circuit that asserted the policy
//    would make a failing holder unable to produce a proof at all, which sounds
//    stricter and is worse: it moves the failure to the client, where nothing is
//    accountable, and it means the chain never learns that a check ran. Emitting
//    the bit means the gate can refuse on chain, in public, with a reason.
//    The consequence is the one the toolchain control found: a verifier returning
//    true does NOT mean the holder is compliant, and any caller that treats
//    verification as the whole check is wrong. `RegistrationGate` requires
//    `passes == 1` separately, and there is a test that fails if it stops.
// ---------------------------------------------------------------------------
template KycRegistration(depth) {
    // ---- private
    signal input secret;              // s_h, never leaves the client
    signal input credentialId;        // cid, the disclosure plaintext under an invariant
    signal input jurisdiction;        // small integer code
    signal input tier;                // accreditation tier
    signal input validUntilEpoch;     // credential expiry, in epochs
    signal input pathElements[depth];
    signal input pathIndices[depth];

    // ---- public inputs
    signal input credentialRoot;      // this epoch's valid set
    signal input epoch;
    signal input registrant;          // the address being granted, as a field element
    signal input minTier;
    signal input jurisdictionMask;    // bit i set means jurisdiction i is admitted

    // ---- public outputs
    signal output nullifier;
    signal output passes;

    // ---- 1. the credential is in this epoch's tree
    component leaf = Poseidon(5);
    leaf.inputs[0] <== credentialId;
    leaf.inputs[1] <== secret;
    leaf.inputs[2] <== jurisdiction;
    leaf.inputs[3] <== tier;
    leaf.inputs[4] <== validUntilEpoch;

    component inc = MerkleInclusion(depth);
    inc.leaf <== leaf.out;
    for (var i = 0; i < depth; i++) {
        inc.pathElements[i] <== pathElements[i];
        inc.pathIndices[i] <== pathIndices[i];
    }
    component rootOk = IsEqual();
    rootOk.in[0] <== inc.root;
    rootOk.in[1] <== credentialRoot;

    // ---- 2. the nullifier for this epoch. DOMAIN_KYC is a fixed tag so that a
    //         nullifier for one purpose can never collide with one for another.
    var DOMAIN_KYC = 20260904;
    component n = Poseidon(3);
    n.inputs[0] <== secret;
    n.inputs[1] <== DOMAIN_KYC;
    n.inputs[2] <== epoch;
    nullifier <== n.out;

    // ---- 3. the policy
    component tierOk = GreaterEqThan(16);
    tierOk.in[0] <== tier;
    tierOk.in[1] <== minTier;

    component freshOk = GreaterThan(64);
    freshOk.in[0] <== validUntilEpoch;
    freshOk.in[1] <== epoch;

    // jurisdiction admitted: bit `jurisdiction` of `jurisdictionMask` is set.
    // Done by decomposing the mask and selecting, which is 32 constraints rather
    // than the modular arithmetic a shift would need over a prime field.
    component maskBits = Num2Bits(32);
    maskBits.in <== jurisdictionMask;
    component pick[32];
    signal jurAcc[33];
    jurAcc[0] <== 0;
    for (var i = 0; i < 32; i++) {
        pick[i] = IsEqual();
        pick[i].in[0] <== jurisdiction;
        pick[i].in[1] <== i;
        jurAcc[i + 1] <== jurAcc[i] + pick[i].out * maskBits.out[i];
    }
    signal jurOk;
    jurOk <== jurAcc[32];

    // ---- 4. an invariant. Bind the registrant with a real constraint so the signal
    //         survives into the R1CS.
    signal registrantBound;
    registrantBound <== registrant * registrant;

    // ---- 5. the conjunction, as an output
    signal p1;
    signal p2;
    signal p3;
    p1 <== rootOk.out * tierOk.out;
    p2 <== p1 * freshOk.out;
    p3 <== p2 * jurOk;
    passes <== p3;
}

component main {public [credentialRoot, epoch, registrant, minTier, jurisdictionMask]} =
    KycRegistration(16);
