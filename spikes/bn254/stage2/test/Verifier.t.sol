// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "../src/TrivialVerifier.sol";
import "../src/FiveVerifier.sol";
import "../src/AbsentPairingVerifier.sol";
import "./ProofData.sol";

/// Spike 1 stage 2. Exercises the verifier snarkjs actually emits, unmodified,
/// plus one copy whose only difference is that the pairing call points at a
/// codeless address. No forge-std: this tree builds offline.
///
/// Gas is deliberately not measured here. Every number in the write-up comes
/// from an anvil or Hedera transaction receipt, never from gasleft().
contract VerifierTest is ProofData {
    TrivialVerifier tv;
    FiveVerifier fv;
    AbsentPairingVerifier av;

    function setUp() public {
        tv = new TrivialVerifier();
        fv = new FiveVerifier();
        av = new AbsentPairingVerifier();
    }

    // ---------------------------------------------------------------- real 0x08

    function test_valid_proof_accepted() public view {
        require(tv.verifyProof(tA(), tB(), tC(), tPub()), "valid proof rejected");
    }

    function test_five_public_signals_accepted() public view {
        require(fv.verifyProof(fA(), fB(), fC(), fPub()), "valid 5-signal proof rejected");
    }

    /// Negating A keeps the point on the curve, so the pairing runs to
    /// completion and returns 0. This is the "false, not a revert" case the
    /// spike README asks for.
    function test_negated_A_rejected_without_revert() public view {
        uint[2] memory a = tA();
        a[1] = Q - a[1];
        require(!tv.verifyProof(a, tB(), tC(), tPub()), "negated A accepted");
    }

    /// The realistic corruption: a well formed proof presented against a
    /// statement it does not prove.
    function test_wrong_public_signal_rejected() public view {
        uint[1] memory z = tPub();
        z[0] = z[0] + 1; // claim 3 * 11 == 34
        require(!tv.verifyProof(tA(), tB(), tC(), z), "wrong statement accepted");
    }

    /// checkField is the only input validation the generated verifier performs.
    function test_public_signal_at_field_order_rejected() public view {
        uint[1] memory z;
        z[0] = 21888242871839275222246405745257275088548364400416034343698204186575808495617; // r
        require(!tv.verifyProof(tA(), tB(), tC(), z), "signal at r accepted");
    }

    /// The same forged proof used in the fail-open tests below. Here 0x08 is
    /// present, so it is rejected. This is the control: it isolates the
    /// difference to the presence of the precompile.
    function test_forged_proof_rejected_when_pairing_present() public view {
        require(!tv.verifyProof(forgedA(1), tB(), tC(), tPub()), "forged proof accepted");
    }

    // ------------------------------------------------- 0x08 absent (fail open)

    /// The finding. staticcall to a codeless address succeeds and writes
    /// nothing, and the generated verifier reads its result out of the same
    /// buffer that holds pA.x. So mload returns attacker calldata and
    /// and(success, pA.x) is 1 whenever pA.x is odd.
    function test_absent_pairing_accepts_forged_proof() public view {
        require(av.verifyProof(forgedA(1), tB(), tC(), tPub()), "expected fail-open accept");
    }

    /// Same forged proof with an even x. If the accept above were a blanket
    /// "codeless address returns true" this would also pass. It does not,
    /// which pins the mechanism to the aliased output buffer.
    function test_absent_pairing_even_x_rejected() public view {
        require(!av.verifyProof(forgedA(2), tB(), tC(), tPub()), "even x accepted");
    }

    /// The accept condition is exactly "pA.x is odd", so half of all forged
    /// first coordinates are accepted. Counted against the parity of the same
    /// pseudorandom draws rather than against a fixed 16, because keccak is not
    /// obliged to split 32 samples evenly and an exact count would be a flaky
    /// assertion rather than a real one.
    function test_absent_pairing_accepts_exactly_the_odd_half() public view {
        uint accepted;
        uint odd;
        for (uint i = 0; i < 64; i++) {
            uint x = uint(keccak256(abi.encode(i)));
            if (x & 1 == 1) odd++;
            if (av.verifyProof(forgedA(x), tB(), tC(), tPub())) accepted++;
        }
        require(accepted == odd, "accept set is not the odd set");
        require(odd > 0 && odd < 64, "degenerate sample, parity test proved nothing");
    }

    // ---------------------------------------------------------------- helpers

    /// A proof that is not a proof: A is not even on the curve.
    function forgedA(uint x) internal pure returns (uint[2] memory a) {
        a[0] = x;
        a[1] = 1;
    }
}
