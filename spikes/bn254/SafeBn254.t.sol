// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "../src/SafeBn254.sol";

/// Regression tests for SafeBn254. No forge-std: this repo builds offline.
contract SafeBn254Harness is SafeBn254 {
    function xIsValidG1(uint256 x, uint256 y) external pure returns (bool) {
        return isValidG1(x, y);
    }
    function xSafePairing(bytes memory i) external view returns (bool, bool) {
        return safePairing(i);
    }
    function xSafeAdd(uint256 a, uint256 b, uint256 c, uint256 d)
        external view returns (bool, uint256, uint256) { return safeAdd(a, b, c, d); }
}

contract SafeBn254Test {
    SafeBn254Harness h;
    uint256 constant PP =
        0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47;
    uint256 constant G2X1 = 0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2;
    uint256 constant G2X0 = 0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed;
    uint256 constant G2Y1 = 0x090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b;
    uint256 constant G2Y0 = 0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa;

    function setUp() public { h = new SafeBn254Harness(); }

    function _pair(uint256 x, uint256 y) internal pure returns (bytes memory) {
        return abi.encode(x, y, G2X1, G2X0, G2Y1, G2Y0);
    }

    /// The load-bearing one. This failed on the first draft of safePairing,
    /// which passed a stack slot as the staticcall return buffer and therefore
    /// read Solidity scratch space instead of the precompile's answer.
    function test_bilinearity_returns_true() public view {
        (bool ran, bool ok) = h.xSafePairing(
            bytes.concat(_pair(1, PP - 2), _pair(1, 2))
        );
        require(ran, "pairing did not run");
        require(ok, "e(-G,H).e(G,H) must be 1");
    }

    /// Negative control for the test above: a pairing that is genuinely not 1
    /// must come back ran = true, ok = false, never ran = false.
    function test_non_degenerate_returns_false() public view {
        (bool ran, bool ok) = h.xSafePairing(_pair(1, 2));
        require(ran, "pairing did not run");
        require(!ok, "e(G,H) must not be 1");
    }

    /// A malformed pair is refused by the precompile, and `ran` reports that
    /// separately from `ok`. Collapsing the two is the fail-open bug.
    function test_offcurve_pairing_does_not_run() public view {
        (bool ran, bool ok) = h.xSafePairing(
            bytes.concat(_pair(1, 3), _pair(1, 2))
        );
        require(!ran, "off-curve input must not produce an answer");
        require(!ok, "ok must be false when ran is false");
    }

    /// Length is checked before any gas reaches the precompile.
    function test_bad_length_rejected_locally() public view {
        (bool ran, ) = h.xSafePairing(abi.encode(uint256(1), uint256(2)));
        require(!ran, "non-multiple of 192 must be refused");
    }

    /// COFACTOR == 1 on bn254 G1, so on-curve is a complete validity test.
    function test_isValidG1() public view {
        require(h.xIsValidG1(1, 2), "G is valid");
        require(h.xIsValidG1(0, 0), "point at infinity is valid per EIP-196");
        require(!h.xIsValidG1(1, 3), "off-curve must be rejected");
        require(!h.xIsValidG1(PP, 2), "x >= p must be rejected");
        require(!h.xIsValidG1(1, PP), "y >= p must be rejected");
    }

    /// The capped add still computes the right point.
    function test_safeAdd_matches_known_answer() public view {
        (bool ran, uint256 x, uint256 y) = h.xSafeAdd(1, 2, 1, 2);
        require(ran, "add did not run");
        require(x == 0x030644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd3, "x");
        require(y == 0x15ed738c0e0a7c92e7845f96b2ae9c0a68a6a449e3538fc7ff3ebf7a5a18a2c4, "y");
    }

    /// A second off-curve y for the same x, so the curve check is not passing
    /// by accident on one hardcoded value. The mutation control that proves
    /// these assertions can actually fail lives in Encoding.t.sol.
    function test_second_offcurve_point_rejected() public view {
        require(!h.xIsValidG1(1, 4), "(1,4) is not on y^2 = x^3 + 3");
    }
}
