// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// Bounds what a malformed Groth16 proof can cost the caller.
///
/// The verifier snarkjs generates forwards `gas() - 2000` to 0x08 and performs
/// no validation of A, B or C. A point that is not on the curve makes the
/// pairing precompile fail, and a failing precompile consumes every gas unit
/// forwarded to it (EIP-150 gives it 63/64 of everything the caller holds).
/// The verifier then returns false, correctly, having spent the whole
/// transaction. Capping the call at a value derived from the EIP-1108 schedule
/// turns that into a fixed, small cost.
///
/// `ran` and `ok` are returned separately on purpose. A call that ran out of
/// gas, or hit a chain where the precompiles are absent, must never be
/// readable as "the proof verified".
interface IGroth16Verifier1 {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[1] calldata pub
    ) external view returns (bool);
}

contract CappedVerifier {
    IGroth16Verifier1 public immutable inner;

    /// Precompile cost of a 1-public-signal verify under EIP-1108:
    ///   vk_x   6,000 (ecMul) + 150 (ecAdd)
    ///   pair  45,000 + 4 * 34,000 = 181,000
    /// = 187,150, plus the generated verifier's own framing. The constant below
    /// is measured, not guessed: see BOUND_EVIDENCE in the spike notes. It is
    /// deliberately tight, so a future reprice makes valid proofs report
    /// ran == false rather than silently costing more.
    uint256 public immutable bound;

    constructor(IGroth16Verifier1 _inner, uint256 _bound) {
        inner = _inner;
        bound = _bound;
    }

    function verify(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[1] calldata pub
    ) external view returns (bool ran, bool ok) {
        (bool success, bytes memory out) = address(inner).staticcall{gas: bound}(
            abi.encodeWithSelector(IGroth16Verifier1.verifyProof.selector, a, b, c, pub)
        );
        if (!success || out.length != 32) return (false, false);
        uint256 word = abi.decode(out, (uint256));
        if (word > 1) return (false, false); // not a bool, do not guess
        return (true, word == 1);
    }
}
