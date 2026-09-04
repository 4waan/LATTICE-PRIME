// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IGroth16Verifier1} from "./CappedVerifier.sol";

/// Capped call plus a local on-curve check of the two G1 elements of the proof.
///
/// bn254 G1 has COFACTOR == 1, so the curve group is the prime order subgroup
/// and "on the curve" is a complete validity check for A and C. Two mulmods and
/// an addmod each. B lives in G2, whose cofactor is not 1, so no cheap complete
/// check exists for it and the gas cap is what covers it.
///
/// `ran` is reported separately from `ok`. Note what it can and cannot tell
/// you: the generated verifier returns false both for a proof that fails the
/// pairing equation and for a call that ran out of gas partway through, so the
/// wrapper cannot recover that distinction after the fact. It can only refuse
/// to make the call unless the full bound is available, which is what the
/// gasleft check below is for. That is a floor guard, not a measurement.
contract GuardedVerifier {
    uint256 internal constant P =
        21888242871839275222246405745257275088696311157297823662689037894645226208583;

    IGroth16Verifier1 public immutable inner;
    uint256 public immutable bound;

    constructor(IGroth16Verifier1 _inner, uint256 _bound) {
        inner = _inner;
        bound = _bound;
    }

    function isValidG1(uint256 x, uint256 y) internal pure returns (bool) {
        if (x >= P || y >= P) return false;
        if (x == 0 && y == 0) return true; // EIP-196 encodes the identity as (0,0)
        return mulmod(y, y, P) == addmod(mulmod(mulmod(x, x, P), x, P), 3, P);
    }

    function verify(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[1] calldata pub
    ) external view returns (bool ran, bool ok) {
        if (!isValidG1(a[0], a[1]) || !isValidG1(c[0], c[1])) return (true, false);
        if (b[0][0] >= P || b[0][1] >= P || b[1][0] >= P || b[1][1] >= P) return (true, false);
        // refuse to start a check we cannot finish, so a starved call is never
        // silently reported as a failed proof
        if (gasleft() < bound + 5000) return (false, false);

        (bool success, bytes memory out) = address(inner).staticcall{gas: bound}(
            abi.encodeWithSelector(IGroth16Verifier1.verifyProof.selector, a, b, c, pub)
        );
        if (!success || out.length != 32) return (false, false);
        uint256 word = abi.decode(out, (uint256));
        if (word > 1) return (false, false);
        return (true, word == 1);
    }
}
