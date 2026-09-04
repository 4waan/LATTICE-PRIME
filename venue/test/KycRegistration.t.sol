// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KycVerifier} from "../src/kyc/KycVerifier.sol";
import {IPlonkVerifier} from "../src/kyc/IPlonkVerifier.sol";
import {ZkKycRegistry} from "../src/kyc/ZkKycRegistry.sol";
import {RegistrationGate} from "../src/kyc/RegistrationGate.sol";
import {IKyc} from "../src/interfaces/IKyc.sol";

/// @notice Seam D, end to end, against real PLONK proofs over `circuits/kyc.circom`.
///
/// The proofs in `test/fixtures/proofs.json` are produced by snarkjs from the
/// compiled circuit, not mocked. Regenerate them with `make fixtures`. A mock
/// verifier would prove the plumbing works; only these prove the statement is the
/// one we think it is.
contract KycRegistrationTest is Test {
    KycVerifier verifier;
    ZkKycRegistry registry;
    RegistrationGate gate;

    address constant ISSUER = address(0x155);
    address constant ADMIN = address(0xAD1);
    /// The address the fixture proofs are bound to. Signal 4.
    address constant HOLDER = 0xd30DE9C5aEF8079B4718B4988E8FD1D1A96F3115;

    uint64 constant EPOCH_ZERO = 1_000;
    uint64 constant EPOCH_LEN = 100;
    uint64 constant PROOF_EPOCH = 7;
    /// The issuer's published root for this epoch. All four in-tree fixtures
    /// prove against it; `forged_root` proves against a tree the prover built.
    uint256 constant CRED_ROOT =
        6169089262182662551765430451869477850822369012194942422016362324771265384099;
    uint256 constant FORGED_ROOT =
        7611142786501304429922825364145714245341053521273085805899057624258210665189;

    string json;

    function setUp() public {
        json = vm.readFile("test/fixtures/proofs.json");

        verifier = new KycVerifier();
        registry = new ZkKycRegistry(ADMIN, EPOCH_ZERO, EPOCH_LEN);
        gate = new RegistrationGate(
            IPlonkVerifier(address(verifier)), registry, ISSUER, 3, 0xff
        );
        vm.prank(ADMIN);
        registry.bootstrapGate(address(gate));

        // Put the chain in the epoch the proofs were made for.
        vm.warp(EPOCH_ZERO + uint256(PROOF_EPOCH) * EPOCH_LEN);
        assertEq(registry.currentEpoch(), PROOF_EPOCH, "epoch setup");

        vm.prank(ISSUER);
        gate.publishRoot(PROOF_EPOCH, CRED_ROOT);
    }

    // ------------------------------------------------------------ fixtures

    function _proof(string memory name) internal view returns (uint256[24] memory p) {
        uint256[] memory a =
            vm.parseJsonUintArray(json, string.concat(".", name, ".proof"));
        require(a.length == 24, "proof length");
        for (uint256 i = 0; i < 24; ++i) p[i] = a[i];
    }

    function _pub(string memory name) internal view returns (uint256[7] memory s) {
        uint256[] memory a =
            vm.parseJsonUintArray(json, string.concat(".", name, ".pub"));
        require(a.length == 7, "pub length");
        for (uint256 i = 0; i < 7; ++i) s[i] = a[i];
    }

    // ------------------------------------------------------- the happy path

    function test_validProofGrantsForThisEpoch() public {
        assertEq(
            uint8(registry.getKycStatus(HOLDER)),
            uint8(IKyc.KycStatus.NOT_GRANTED),
            "denied before registration"
        );

        gate.register(HOLDER, _proof("valid"), _pub("valid"));

        assertEq(
            uint8(registry.getKycStatus(HOLDER)),
            uint8(IKyc.KycStatus.GRANTED),
            "granted after"
        );
    }

    /// @notice **Finding one, as a test. `verifyProof` returning true carries no
    ///         compliance information.**
    ///
    /// Three credentials the issuer really did sign into this epoch's tree, each
    /// failing the policy a different way: tier below the minimum, expired before
    /// this epoch, jurisdiction outside the mask. All three produce proofs the
    /// verifier accepts, because all three were computed honestly. The only thing
    /// separating them from a compliant holder is public signal 1.
    ///
    /// If someone later decides the gate's `passes` check is redundant because
    /// "the proof verified", this is the test that stops them.
    function test_verifierAcceptsProofsOfNonCompliance() public view {
        string[3] memory bad = ["fail_tier", "fail_epoch", "fail_jurisdiction"];
        for (uint256 i = 0; i < bad.length; ++i) {
            uint256[24] memory p = _proof(bad[i]);
            uint256[7] memory s = _pub(bad[i]);
            assertTrue(verifier.verifyProof(p, s), "verifier accepts a failing policy");
            assertEq(s[1], 0, "and the answer is in signal 1, not the return value");
            assertEq(s[2], CRED_ROOT, "these are real credentials in the issuer's tree");
        }
    }

    /// @notice **Finding two, as a test. Reading `passes` is not enough either.**
    ///
    /// This prover built their own tree containing one credential they wrote
    /// themselves, at tier 9, in an admitted jurisdiction, expiring far in the
    /// future. The inclusion proof is honest, so `passes` is genuinely 1 and the
    /// verifier is genuinely satisfied. Every check inside the circuit passed.
    ///
    /// Nothing about the proof is wrong. What is wrong is the tree, and the
    /// circuit has no opinion about which tree is the issuer's. That question is
    /// answerable only on chain, by pinning signal 2 to a root the issuer
    /// published. Two attacks, two defences, and neither one covers the other.
    function test_honestProofAgainstAForgedTree() public {
        uint256[24] memory p = _proof("forged_root");
        uint256[7] memory s = _pub("forged_root");

        assertTrue(verifier.verifyProof(p, s), "the proof is valid");
        assertEq(s[1], 1, "and the policy genuinely passed");
        assertEq(s[2], FORGED_ROOT, "against a tree the prover made up");

        vm.expectRevert(
            abi.encodeWithSelector(
                RegistrationGate.RootMismatch.selector, FORGED_ROOT, CRED_ROOT
            )
        );
        gate.register(HOLDER, p, s);
    }

    function test_gateRefusesEveryFailingProof() public {
        string[3] memory policyFailures =
            ["fail_tier", "fail_epoch", "fail_jurisdiction"];
        for (uint256 i = 0; i < policyFailures.length; ++i) {
            vm.expectRevert(RegistrationGate.PolicyNotSatisfied.selector);
            gate.register(HOLDER, _proof(policyFailures[i]), _pub(policyFailures[i]));
        }
        assertEq(
            uint8(registry.getKycStatus(HOLDER)),
            uint8(IKyc.KycStatus.NOT_GRANTED),
            "nothing was granted"
        );
    }

    // ------------------------------------------------------------- an invariant

    /// A valid proof lying in the mempool is not a bearer token. Signal 4 pins it
    /// to one address, so lifting it grants nothing to the lifter.
    function test_proofCannotBeReplayedForAnotherAddress() public {
        address thief = address(0xBAD);
        uint256[7] memory s = _pub("valid");
        vm.expectRevert(
            abi.encodeWithSelector(
                RegistrationGate.RegistrantMismatch.selector, s[4], thief
            )
        );
        gate.register(thief, _proof("valid"), s);
    }

    /// The relay, not the holder, submits under HIP-410. That has to work, and it
    /// has to work without weakening the line above.
    function test_anyoneMaySubmitForTheBoundAddress() public {
        vm.prank(address(0xBEEF));
        gate.register(HOLDER, _proof("valid"), _pub("valid"));
        assertEq(uint8(registry.getKycStatus(HOLDER)), uint8(IKyc.KycStatus.GRANTED));
    }

    // ------------------------------------------------------------- an invariant

    function test_grantExpiresAtTheEpochBoundary() public {
        gate.register(HOLDER, _proof("valid"), _pub("valid"));
        assertEq(uint8(registry.getKycStatus(HOLDER)), uint8(IKyc.KycStatus.GRANTED));

        // One second into the next epoch. Nobody swept anything.
        vm.warp(EPOCH_ZERO + uint256(PROOF_EPOCH + 1) * EPOCH_LEN);
        assertEq(
            uint8(registry.getKycStatus(HOLDER)),
            uint8(IKyc.KycStatus.NOT_GRANTED),
            "read time expiry, no keeper required"
        );
    }

    // ------------------------------------------------------------- an invariant

    function test_relayPreviewAgreesWithTheGate() public view {
        (bool ok, string memory why) = gate.wouldAccept(HOLDER, _pub("valid"));
        assertTrue(ok, why);

        (bool ok2, string memory why2) = gate.wouldAccept(HOLDER, _pub("fail_tier"));
        assertFalse(ok2);
        assertEq(why2, "policy not satisfied");

        (bool ok3,) = gate.wouldAccept(address(0xBAD), _pub("valid"));
        assertFalse(ok3, "preview catches the binding too");
    }

    /// The refusal has to be cheap, because the relay pays for it. If a rejected
    /// submission cost as much as an accepted one, an invariant would buy nothing and
    /// the sponsorship budget would be a griefing target.
    function test_refusalIsCheaperThanVerification() public {
        uint256[24] memory p = _proof("fail_tier");
        uint256[7] memory s = _pub("fail_tier");

        uint256 g0 = gasleft();
        try gate.register(HOLDER, p, s) {revert("should have refused");}
        catch {}
        uint256 refusal = g0 - gasleft();

        uint256 g1 = gasleft();
        verifier.verifyProof(p, s);
        uint256 verification = g1 - gasleft();

        emit log_named_uint("gas: gate refusal", refusal);
        emit log_named_uint("gas: bare verification", verification);
        assertLt(refusal, verification, "refusal must not pay for verification");
    }

    // ------------------------------------------------------------- an invariant

    /// `getKycStatus` is on the ATS critical path and a revert there bricks the
    /// token. Fuzzed over arbitrary addresses and arbitrary times, including
    /// before epoch zero, where the naive implementation underflows.
    function testFuzz_getKycStatusNeverReverts(address who, uint64 ts) public {
        vm.warp(ts);
        registry.getKycStatus(who);
    }

    function test_beforeEpochZeroIsSafe() public {
        vm.warp(1);
        assertEq(registry.currentEpoch(), 0, "clamped, not underflowed");
        assertEq(uint8(registry.getKycStatus(HOLDER)), uint8(IKyc.KycStatus.NOT_GRANTED));
    }

    // ------------------------------------------------------------- an invariant

    function testFuzz_unknownAddressIsDenied(address who) public view {
        vm.assume(who != HOLDER);
        assertEq(
            uint8(registry.getKycStatus(who)),
            uint8(IKyc.KycStatus.NOT_GRANTED),
            "the default is denial, by the zero value"
        );
    }

    // ------------------------------------------------ gate is the only writer

    function test_onlyGateCanGrant() public {
        vm.expectRevert(ZkKycRegistry.NotGate.selector);
        registry.grant(address(0xBAD), bytes32(uint256(1)));
    }
}
