// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "../src/TrivialVerifier.sol";
import "../src/CappedVerifier.sol";
import "../src/GuardedVerifier.sol";
import "./ProofData.sol";

/// The two wrappers must not change any verdict. That is the whole bargain:
/// they bound cost and they report "did not run" separately, and in exchange
/// they are allowed to alter nothing about which proofs are accepted.
contract WrapperTest is ProofData {
    TrivialVerifier tv;
    CappedVerifier cv;
    GuardedVerifier gv;

    /// 191,745 is the measured frame cost of a 1-signal verify, obtained by
    /// bisecting the eth_call gas limit against a codeless address with the
    /// same calldata. 200,000 leaves 4.3% of headroom and no more, so a
    /// reprice surfaces as ran == false rather than as a larger bill.
    uint256 constant BOUND = 200_000;

    function setUp() public {
        tv = new TrivialVerifier();
        cv = new CappedVerifier(IGroth16Verifier1(address(tv)), BOUND);
        gv = new GuardedVerifier(IGroth16Verifier1(address(tv)), BOUND);
    }

    function test_capped_agrees_with_raw_on_every_case() public view {
        _agree(tA(), tB(), tC(), tPub(), true);
        uint[2] memory na = tA();
        na[1] = Q - na[1];
        _agree(na, tB(), tC(), tPub(), false);
        uint[1] memory z = tPub();
        z[0] += 1;
        _agree(tA(), tB(), tC(), z, false);
        _agree(bad(1), tB(), tC(), tPub(), false);
    }

    function _agree(
        uint[2] memory a,
        uint[2][2] memory b,
        uint[2] memory c,
        uint[1] memory z,
        bool want
    ) internal view {
        require(tv.verifyProof(a, b, c, z) == want, "raw disagrees with expectation");
        (bool ran1, bool ok1) = cv.verify(a, b, c, z);
        (bool ran2, bool ok2) = gv.verify(a, b, c, z);
        require(ran1 && ran2, "wrapper failed to run");
        require(ok1 == want && ok2 == want, "wrapper changed the verdict");
    }

    /// A point with x or y at or above the base field is not representable and
    /// must be rejected locally, without reaching a precompile.
    function test_guard_rejects_unreduced_coordinates() public view {
        uint[2] memory a = tA();
        a[0] = P_FIELD;
        (bool ran, bool ok) = gv.verify(a, tB(), tC(), tPub());
        require(ran && !ok, "unreduced x accepted");
    }

    /// The identity is the one point with x == y == 0 that must pass the
    /// on-curve test, because EIP-196 encodes it that way and 0**3 + 3 != 0.
    function test_guard_accepts_encoded_identity_as_wellformed() public view {
        uint[2] memory a;
        (bool ran, bool ok) = gv.verify(a, tB(), tC(), tPub());
        require(ran, "identity treated as malformed");
        require(!ok, "identity A produced a valid proof");
    }

    /// Below the bound the wrapper must refuse rather than return a verdict.
    /// This is the case the raw verifier gets wrong: starved of gas it returns
    /// false, which is indistinguishable from a proof that does not verify.
    function test_starved_wrapper_reports_not_run_while_raw_returns_false()
        public view
    {
        uint[2] memory a = tA();
        uint[2][2] memory b = tB();
        uint[2] memory c = tC();
        uint[1] memory z = tPub();

        bytes memory cd = abi.encodeWithSelector(
            IGroth16Verifier1.verifyProof.selector, a, b, c, z
        );
        (bool s1, bytes memory o1) = address(tv).staticcall{gas: 60_000}(cd);
        require(s1 && o1.length == 32, "raw did not return a word");
        require(abi.decode(o1, (uint256)) == 0, "starved raw did not return false");

        bytes memory cd2 = abi.encodeWithSelector(
            GuardedVerifier.verify.selector, a, b, c, z
        );
        (bool s2, bytes memory o2) = address(gv).staticcall{gas: 100_000}(cd2);
        require(s2 && o2.length == 64, "guard did not return a pair");
        (bool ran, bool ok) = abi.decode(o2, (bool, bool));
        require(!ran && !ok, "guard claimed to have run on a starved call");
    }

    uint256 constant P_FIELD =
        21888242871839275222246405745257275088696311157297823662689037894645226208583;

    function bad(uint x) internal pure returns (uint[2] memory a) {
        a[0] = x;
        a[1] = 1;
    }
}
