// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * Spike 1: does Hedera implement the bn254 precompiles, and what do they cost?
 *
 * Deploy, then call each probe. Every function returns (ok, gasUsed) so a failure
 * localises to one precompile instead of showing up as "the verifier didn't work".
 *
 * Vectors are the known-answer cases from EIP-196 (0x06, 0x07) and EIP-197 (0x08).
 *
 * CRITICAL, and the reason this file exists: a MISSING precompile on the EVM is
 * an address with no code. staticcall to it SUCCEEDS and returns empty. Naive
 * verifier code reads that as "no revert" and treats the proof as valid. So
 * `success` alone proves nothing. Every probe below asserts on the RETURNED
 * BYTES, not on the call status.
 */
contract PrecompileProbe {
    /// 0x06 ecAdd: (1,2) + (1,2) = 2*(1,2). Expected output is the ecMul vector below.
    function probeAdd() external view returns (bool ok, uint256 gasUsed, uint256 x, uint256 y) {
        bytes memory input = abi.encode(uint256(1), uint256(2), uint256(1), uint256(2));
        uint256 g0 = gasleft();
        (bool success, bytes memory out) = address(0x06).staticcall(input);
        gasUsed = g0 - gasleft();
        if (!success || out.length != 64) return (false, gasUsed, 0, 0);
        (x, y) = abi.decode(out, (uint256, uint256));
        ok =
            x == 0x030644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd3 &&
            y == 0x15ed738c0e0a7c92e7845f96b2ae9c0a68a6a449e3538fc7ff3ebf7a5a18a2c4;
    }

    /// 0x07 ecMul: 2 * (1,2). Same expected point as probeAdd, reached differently.
    function probeMul() external view returns (bool ok, uint256 gasUsed, uint256 x, uint256 y) {
        bytes memory input = abi.encode(uint256(1), uint256(2), uint256(2));
        uint256 g0 = gasleft();
        (bool success, bytes memory out) = address(0x07).staticcall(input);
        gasUsed = g0 - gasleft();
        if (!success || out.length != 64) return (false, gasUsed, 0, 0);
        (x, y) = abi.decode(out, (uint256, uint256));
        ok =
            x == 0x030644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd3 &&
            y == 0x15ed738c0e0a7c92e7845f96b2ae9c0a68a6a449e3538fc7ff3ebf7a5a18a2c4;
    }

    /// 0x08 ecPairing, empty input. Per EIP-197 an empty pairing set is vacuously true.
    /// Cheapest possible liveness check for the precompile that Groth16 actually needs.
    function probePairingEmpty() external view returns (bool ok, uint256 gasUsed, uint256 result) {
        uint256 g0 = gasleft();
        (bool success, bytes memory out) = address(0x08).staticcall("");
        gasUsed = g0 - gasleft();
        if (!success || out.length != 32) return (false, gasUsed, 0);
        result = abi.decode(out, (uint256));
        ok = result == 1;
    }

    /// 0x08 with one real pair: e(G1, G2). Non-degeneracy makes this != 1, so the
    /// check returns 0. NOTE: this is a weak test. It excludes an always-1 stub and
    /// nothing else, because a broken pairing also returns 0. The test that carries
    /// the weight is probePairingBilinear below. See the audit notes an earlier measurement.
    function probePairingOnePair() external view returns (bool ok, uint256 gasUsed, uint256 result) {
        bytes memory input = abi.encode(
            uint256(1),
            uint256(2),
            uint256(0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2),
            uint256(0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed),
            uint256(0x090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b),
            uint256(0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa)
        );
        uint256 g0 = gasleft();
        (bool success, bytes memory out) = address(0x08).staticcall(input);
        gasUsed = g0 - gasleft();
        if (!success || out.length != 32) return (false, gasUsed, 0);
        result = abi.decode(out, (uint256));
        ok = result == 0;
    }

    /// Marginal cost of one extra public input in a Groth16 verifier: one ecMul
    /// plus one ecAdd. This number is the per-cell gas price of the the disclosure matrix disclosure
    /// matrix, so measure it rather than assuming 6150.
    /// Returns ok == false if either call did not return a point, so this cannot
    /// report a plausible number on a chain with no bn254 precompiles at all.
    /// The gas figure brackets ABI encoding and memory expansion as well as the
    /// calls, so treat it as an upper bound. The exact op costs were taken by
    /// bisecting eth_call instead; see the audit notes Measurements.
    function probePublicInputCost() external view returns (bool ok, uint256 gasPerInput) {
        bytes memory mulIn = abi.encode(uint256(1), uint256(2), uint256(7));
        bytes memory addIn = abi.encode(uint256(1), uint256(2), uint256(1), uint256(2));
        uint256 g0 = gasleft();
        (bool s1, bytes memory o1) = address(0x07).staticcall(mulIn);
        (bool s2, bytes memory o2) = address(0x06).staticcall(addIn);
        gasPerInput = g0 - gasleft();
        ok = s1 && s2 && o1.length == 64 && o2.length == 64;
    }

    // ---- the tests that actually prove the pairing works (an earlier measurement) ----

    uint256 private constant P =
        0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47;
    // G2 generator, EIP-197 order: (x_imag, x_real, y_imag, y_real).
    uint256 private constant G2X1 =
        0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2;
    uint256 private constant G2X0 =
        0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed;
    uint256 private constant G2Y1 =
        0x090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b;
    uint256 private constant G2Y0 =
        0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa;

    /// Exposed so a test can assert the encoding equals the exact bytes that were
    /// verified against Hedera by eth_call. Keeps the on-chain
    /// measurement and this contract from being two unrelated claims.
    function exposePairInput2() external pure returns (bytes memory) {
        return bytes.concat(_pairWithG2(1, P - 2), _pairWithG2(1, 2));
    }

    function exposePairInput3() external pure returns (bytes memory) {
        return bytes.concat(
            _pairWithG2(
                0x030644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd3,
                0x15ed738c0e0a7c92e7845f96b2ae9c0a68a6a449e3538fc7ff3ebf7a5a18a2c4
            ),
            _pairWithG2(1, P - 2),
            _pairWithG2(1, P - 2)
        );
    }

    /// One 192-byte EIP-197 pairing term: a G1 point against the G2 generator.
    /// Kept as a helper because encoding three terms inline runs the stack out.
    function _pairWithG2(uint256 x, uint256 y) private pure returns (bytes memory) {
        return abi.encode(x, y, G2X1, G2X0, G2Y1, G2Y0);
    }

    /// 0x08 bilinearity: e(-G1, G2) . e(G1, G2) == 1.
    ///
    /// This is the probe that matters. The identity holds for ANY P and Q by
    /// bilinearity alone, so it needs no reference implementation and no copied
    /// vector to check against: it is true by the algebra or the precompile is
    /// broken. A stub returning 0 fails it. A stub returning 1 fails
    /// probePairingOnePair. A wrong Miller loop or a wrong final exponentiation
    /// fails it. Nothing else in this file tests that a non-trivial pairing
    /// returns 1, which is the one behaviour Groth16 verification depends on.
    function probePairingBilinear() external view returns (bool ok, uint256 gasUsed, uint256 result) {
        bytes memory input = bytes.concat(
            _pairWithG2(1, P - 2),  // (-G1, G2)
            _pairWithG2(1, 2)       // ( G1, G2)
        );
        uint256 g0 = gasleft();
        (bool success, bytes memory out) = address(0x08).staticcall(input);
        gasUsed = g0 - gasleft();
        if (!success || out.length != 32) return (false, gasUsed, 0);
        result = abi.decode(out, (uint256));
        ok = result == 1;
    }

    /// 0x08 three-pair bilinearity: e(2G1, G2) . e(-G1, G2)^2 == 1.
    /// Chains an ecMul result into the pairing and exercises k > 2, which is the
    /// shape a real Groth16 verifier uses.
    function probePairingBilinear3() external view returns (bool ok, uint256 gasUsed, uint256 result) {
        bytes memory input = bytes.concat(
            _pairWithG2(
                0x030644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd3,
                0x15ed738c0e0a7c92e7845f96b2ae9c0a68a6a449e3538fc7ff3ebf7a5a18a2c4
            ),                      // ( 2G1, G2)
            _pairWithG2(1, P - 2),  // (-G1,  G2)
            _pairWithG2(1, P - 2)   // (-G1,  G2)
        );
        uint256 g0 = gasleft();
        (bool success, bytes memory out) = address(0x08).staticcall(input);
        gasUsed = g0 - gasleft();
        if (!success || out.length != 32) return (false, gasUsed, 0);
        result = abi.decode(out, (uint256));
        ok = result == 1;
    }

    /// Negative control: an off-curve G1 point must be REJECTED, not accepted.
    /// ok == true means the precompile correctly refused the input.
    function probeRejectsOffCurve() external view returns (bool ok) {
        (bool success, bytes memory out) = address(0x06).staticcall(
            abi.encode(uint256(1), uint256(3), uint256(1), uint256(2))
        );
        ok = !success || out.length == 0;
    }
}
