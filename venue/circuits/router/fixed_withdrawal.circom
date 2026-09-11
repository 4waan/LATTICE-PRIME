pragma circom 2.1.9;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/mux1.circom";

template RouterMerkleLevel() {
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

template RouterMerkleInclusion(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    signal current[depth + 1];
    component levels[depth];
    current[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        levels[i] = RouterMerkleLevel();
        levels[i].current <== current[i];
        levels[i].sibling <== pathElements[i];
        levels[i].indexBit <== pathIndices[i];
        current[i + 1] <== levels[i].parent;
    }

    root <== current[depth];
}

/// Membership and spend half of a fixed-denomination withdrawal.
///
/// A note commitment is:
/// Poseidon(noteSecret, noteNullifier, fundingTag, chainId, pool, asset,
/// denomination). The encrypted compliance record reveals this commitment only
/// to the authorized view key, which lets that viewer map the public deposit to
/// the public recipient session without exposing any order ticket.
///
/// Public signal order is frozen:
///   0 nullifierHash
///   1 complianceBridge
///   2 root
///   3 recipient
///   4 pool
///   5 asset
///   6 denomination
///   7 chainId
template FixedWithdrawal(depth) {
    signal input noteSecret;
    signal input noteNullifier;
    signal input fundingTag;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal input complianceNonce;

    signal input root;
    signal input recipient;
    signal input pool;
    signal input asset;
    signal input denomination;
    signal input chainId;

    signal output nullifierHash;
    signal output complianceBridge;

    var DOMAIN_ROUTER_NULLIFIER = 2026091011;
    var DOMAIN_ROUTER_BRIDGE = 2026091012;

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

    component inclusion = RouterMerkleInclusion(depth);
    inclusion.leaf <== note.out;
    for (var i = 0; i < depth; i++) {
        inclusion.pathElements[i] <== pathElements[i];
        inclusion.pathIndices[i] <== pathIndices[i];
    }
    inclusion.root === root;

    component nullifier = Poseidon(6);
    nullifier.inputs[0] <== noteNullifier;
    nullifier.inputs[1] <== DOMAIN_ROUTER_NULLIFIER;
    nullifier.inputs[2] <== chainId;
    nullifier.inputs[3] <== pool;
    nullifier.inputs[4] <== asset;
    nullifier.inputs[5] <== denomination;
    nullifierHash <== nullifier.out;

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
    complianceBridge <== bridge.out;
}

component main {
    public [root, recipient, pool, asset, denomination, chainId]
} = FixedWithdrawal(20);
