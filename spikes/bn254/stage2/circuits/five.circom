pragma circom 2.0.0;

// Same shape, wider public surface: 4 public inputs plus 1 public output = 5
// public signals. Used to test whether verifier gas really scales at the
// 6,150 per public input we measured against the bare precompiles.
template Lin(n) {
    signal input x[n];
    signal input k;
    signal output y;

    signal acc[n + 1];
    acc[0] <== k;
    for (var i = 0; i < n; i++) {
        acc[i + 1] <== acc[i] + x[i] * x[i];
    }
    y <== acc[n];
}

component main {public [x]} = Lin(4);
