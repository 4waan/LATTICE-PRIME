// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KycVerifier} from "../src/kyc/KycVerifier.sol";
import {IPlonkVerifier} from "../src/kyc/IPlonkVerifier.sol";
import {ZkKycRegistry} from "../src/kyc/ZkKycRegistry.sol";
import {RegistrationGate} from "../src/kyc/RegistrationGate.sol";
import {IKyc} from "../src/interfaces/IKyc.sol";

/// @notice The gate swap `script/DeployGate.s.sol` performs, end to end, against
///         real proofs over the wide issuer tree.
///
/// The first gate published the four-leaf tree, where one credential passes and
/// every participant therefore shares one nullifier. The second gate publishes
/// the twelve-leaf tree from `circuits/tree.mjs` (`botCreds`), so each synthetic
/// participant proves its own credential and `MAX_USES_PER_EPOCH` binds per
/// participant. Same verifier, same registry: the root is a public signal, and
/// only the gate's `rootForEpoch` decides which tree counts.
///
/// `test/fixtures/proofs-wide.json` holds two real PLONK proofs for epoch 8
/// against the wide root: `bot_1` for one bot wallet and `valid` (the shared
/// credential) for the operator.
contract KycGateSwapTest is Test {
    KycVerifier verifier;
    ZkKycRegistry registry;
    RegistrationGate narrowGate;
    RegistrationGate wideGate;

    address constant ISSUER = address(0x155);
    address constant ADMIN = address(0xAD1);
    address constant ANYONE = address(0xA11);

    /// Signal 4 of the two fixture proofs.
    address constant BOT1 = 0x5Bc82B99A1F6daa847c1aa7AB397043DfB810A4c;
    address constant OPERATOR = 0xCFc5923dEf1F25db05FE50754Ef0822175AFD449;

    uint64 constant EPOCH_ZERO = 1_000;
    uint64 constant EPOCH_LEN = 100;
    uint64 constant OLD_EPOCH = 7;
    uint64 constant NEW_EPOCH = 8;

    uint256 constant NARROW_ROOT =
        6169089262182662551765430451869477850822369012194942422016362324771265384099;
    uint256 constant WIDE_ROOT =
        17351106410120225295902853388625488734211813428465793460035694687490561491484;

    string json;

    function setUp() public {
        json = vm.readFile("test/fixtures/proofs-wide.json");

        verifier = new KycVerifier();
        registry = new ZkKycRegistry(ADMIN, EPOCH_ZERO, EPOCH_LEN);
        narrowGate = new RegistrationGate(IPlonkVerifier(address(verifier)), registry, ISSUER, 3, 0xff);
        vm.prank(ADMIN);
        registry.bootstrapGate(address(narrowGate));

        vm.warp(EPOCH_ZERO + uint256(OLD_EPOCH) * EPOCH_LEN);
        assertEq(registry.currentEpoch(), OLD_EPOCH, "epoch setup");

        // The first gate has the narrow root for both epochs, as the live one does.
        vm.startPrank(ISSUER);
        narrowGate.publishRoot(OLD_EPOCH, NARROW_ROOT);
        narrowGate.publishRoot(NEW_EPOCH, NARROW_ROOT);
        vm.stopPrank();

        // What DeployGate does today, in epoch 7: a second gate, wide root for
        // epoch 8 onward, proposed to the registry.
        wideGate = new RegistrationGate(IPlonkVerifier(address(verifier)), registry, ISSUER, 3, 0xff);
        vm.prank(ISSUER);
        wideGate.publishRoot(NEW_EPOCH, WIDE_ROOT);
        vm.prank(ADMIN);
        registry.proposeGate(address(wideGate));
    }

    // ------------------------------------------------------------ fixtures

    function _proof(string memory name) internal view returns (uint256[24] memory p) {
        uint256[] memory a = vm.parseJsonUintArray(json, string.concat(".", name, ".proof"));
        require(a.length == 24, "proof length");
        for (uint256 i = 0; i < 24; ++i) p[i] = a[i];
    }

    function _pub(string memory name) internal view returns (uint256[7] memory s) {
        uint256[] memory a = vm.parseJsonUintArray(json, string.concat(".", name, ".pub"));
        require(a.length == 7, "pub length");
        for (uint256 i = 0; i < 7; ++i) s[i] = a[i];
    }

    function _status(address who) internal view returns (uint8) {
        return uint8(registry.getKycStatus(who));
    }

    // --------------------------------------------------- before the boundary

    function test_fixturesAreWideTreeEpoch8Proofs() public view {
        uint256[7] memory b = _pub("bot_1");
        uint256[7] memory v = _pub("valid");
        assertEq(b[2], WIDE_ROOT, "bot_1 root");
        assertEq(v[2], WIDE_ROOT, "valid root");
        assertEq(b[3], NEW_EPOCH, "bot_1 epoch");
        assertEq(v[3], NEW_EPOCH, "valid epoch");
        assertEq(b[4], uint256(uint160(BOT1)), "bot_1 registrant");
        assertEq(v[4], uint256(uint160(OPERATOR)), "valid registrant");
        assertTrue(b[0] != v[0], "two credentials, two nullifiers");
    }

    function test_proposalDoesNothingUntilTheBoundary() public {
        assertEq(registry.gate(), address(narrowGate), "live gate unchanged");
        assertEq(registry.pendingGate(), address(wideGate), "pending recorded");
        assertEq(registry.pendingGateEpoch(), NEW_EPOCH, "effective next epoch");

        vm.expectRevert(abi.encodeWithSelector(ZkKycRegistry.NotYetEffective.selector, NEW_EPOCH, OLD_EPOCH));
        vm.prank(ANYONE);
        registry.adoptGate();
    }

    /// An epoch-8 proof is refused in epoch 7 by the gate's own epoch pin,
    /// whichever gate it is sent to. Holding proofs ahead of the boundary is safe.
    function test_nextEpochProofIsRefusedBeforeTheBoundary() public {
        (bool ok, string memory why) = wideGate.wouldAccept(BOT1, _pub("bot_1"));
        assertFalse(ok, "wide gate refuses in epoch 7");
        assertEq(why, "wrong epoch", "reason");

        vm.expectRevert();
        wideGate.register(BOT1, _proof("bot_1"), _pub("bot_1"));
        assertEq(_status(BOT1), uint8(IKyc.KycStatus.NOT_GRANTED), "still denied");
    }

    // ---------------------------------------------------- after the boundary

    function _crossTheBoundary() internal {
        vm.warp(EPOCH_ZERO + uint256(NEW_EPOCH) * EPOCH_LEN);
        assertEq(registry.currentEpoch(), NEW_EPOCH, "epoch 8");
    }

    function test_adoptIsPermissionlessOnceTheEpochArrives() public {
        _crossTheBoundary();
        vm.prank(ANYONE);
        registry.adoptGate();
        assertEq(registry.gate(), address(wideGate), "wide gate live");
        assertEq(registry.pendingGate(), address(0), "pending cleared");
    }

    /// The narrow gate has a root for epoch 8 too, but it is the narrow root: a
    /// wide-tree proof fails its root check, and even a proof it accepted could
    /// not grant, because `grant` checks `msg.sender == gate`.
    function test_supersededGateCannotGrant() public {
        _crossTheBoundary();
        registry.adoptGate();

        (bool ok, string memory why) = narrowGate.wouldAccept(BOT1, _pub("bot_1"));
        assertFalse(ok, "narrow gate refuses the wide proof");
        assertEq(why, "wrong credential root", "reason");

        vm.expectRevert(
            abi.encodeWithSelector(RegistrationGate.RootMismatch.selector, WIDE_ROOT, NARROW_ROOT)
        );
        narrowGate.register(BOT1, _proof("bot_1"), _pub("bot_1"));
    }

    function test_wideProofsGrantThroughTheAdoptedGate() public {
        _crossTheBoundary();
        registry.adoptGate();

        assertEq(_status(BOT1), uint8(IKyc.KycStatus.NOT_GRANTED), "bot denied before");
        assertEq(_status(OPERATOR), uint8(IKyc.KycStatus.NOT_GRANTED), "operator's epoch-7 grant died at the boundary");

        // Anybody may pay: the proof pins the registrant.
        vm.prank(ANYONE);
        wideGate.register(BOT1, _proof("bot_1"), _pub("bot_1"));
        vm.prank(ANYONE);
        wideGate.register(OPERATOR, _proof("valid"), _pub("valid"));

        assertEq(_status(BOT1), uint8(IKyc.KycStatus.GRANTED), "bot granted");
        assertEq(_status(OPERATOR), uint8(IKyc.KycStatus.GRANTED), "operator granted");
    }

    /// The point of the wider tree: the bot's registration does not draw on the
    /// shared credential's five uses, and the shared credential's does not draw
    /// on the bot's.
    function test_distinctCredentialsHaveIndependentSybilBudgets() public {
        _crossTheBoundary();
        registry.adoptGate();

        bytes32 botNullifier = bytes32(_pub("bot_1")[0]);
        bytes32 sharedNullifier = bytes32(_pub("valid")[0]);
        assertTrue(botNullifier != sharedNullifier, "distinct nullifiers");

        wideGate.register(BOT1, _proof("bot_1"), _pub("bot_1"));
        assertEq(registry.usesThisEpoch(botNullifier), 1, "bot credential used once");
        assertEq(registry.usesThisEpoch(sharedNullifier), 0, "shared credential untouched");

        wideGate.register(OPERATOR, _proof("valid"), _pub("valid"));
        assertEq(registry.usesThisEpoch(botNullifier), 1, "bot credential still once");
        assertEq(registry.usesThisEpoch(sharedNullifier), 1, "shared credential used once");
    }

    /// Re-registering the same wallet under the same credential spends another
    /// use. The bound is on the credential, not on the address, by design.
    function test_reRegistrationSpendsAnotherUse() public {
        _crossTheBoundary();
        registry.adoptGate();

        bytes32 n = bytes32(_pub("bot_1")[0]);
        wideGate.register(BOT1, _proof("bot_1"), _pub("bot_1"));
        wideGate.register(BOT1, _proof("bot_1"), _pub("bot_1"));
        assertEq(registry.usesThisEpoch(n), 2, "two uses");
    }
}
