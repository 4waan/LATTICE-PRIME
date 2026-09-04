pragma circom 2.0.0;

// Prove knowledge of a factorisation a*b == c without revealing a or b.
// c is an output, so it is a public signal. One public signal means the
// verifier does exactly one ecMul and one ecAdd to build vk_x, which is the
// 6,150 gas per public input measured separately.
template Multiplier() {
    signal input a;
    signal input b;
    signal output c;

    // reject the trivial factorisations that make the statement vacuous
    signal inv_a;
    signal inv_b;
    inv_a <-- 1 / (a - 1);
    inv_b <-- 1 / (b - 1);
    (a - 1) * inv_a === 1;
    (b - 1) * inv_b === 1;

    c <== a * b;
}

component main = Multiplier();
