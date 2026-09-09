// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IPlonkVerifier} from "../src/kyc/IPlonkVerifier.sol";
import {ZkKycRegistry} from "../src/kyc/ZkKycRegistry.sol";
import {RegistrationGate} from "../src/kyc/RegistrationGate.sol";

/// @title DeployGate
/// @notice A second RegistrationGate over the same verifier and registry, with
///         the wide credential root, proposed to the registry for the next epoch.
///
/// ## Why a second gate
///
/// The first gate published a four-leaf tree in which one credential passes, so
/// every live participant proves the same credential and shares one nullifier.
/// `ZkKycRegistry.MAX_USES_PER_EPOCH` is five, which is the sybil bound doing
/// its job, and it is also the whole venue's head count. The wide tree
/// (`circuits/tree.mjs` `botCreds`) adds eight passing credentials with their
/// own secrets, so the synthetic population registers under distinct
/// nullifiers and the bound binds per participant.
///
/// The verifier does not change: the root is a public signal the gate compares
/// with `rootForEpoch`, so the same circuit and the same verifier accept proofs
/// against any root a gate has published.
///
/// ## Rule 2, and why nothing happens today
///
/// `registry.proposeGate` takes effect at the next epoch boundary and
/// `adoptGate` is permissionless from then on. Grants die at that boundary
/// anyway, so the swap costs nobody anything they were not already losing:
/// every participant re-registers after the boundary, through this gate, with a
/// proof for the new epoch against the wide root.
///
/// The root is published for several epochs ahead in the same broadcast. It does
/// not depend on the epoch (no leaf carries one), and `publishRoot` is write once
/// per epoch, so publishing ahead removes the `RootNotPublished` half of every
/// coming cliff at once.
///
/// Environment: HEDERA_PRIVATE_KEY (registry admin and gate issuer),
/// ZK_KYC_REGISTRY, KYC_VERIFIER, WIDE_ROOT, FIRST_ROOT_EPOCH, ROOT_EPOCHS.
///
/// ```
/// forge script script/DeployGate.s.sol --rpc-url $RPC --broadcast --slow
/// ```
///
/// `--slow` is not optional on Hedera. The relay enforces nonce order at
/// submission and answers `WRONG_NONCE` for a transaction whose predecessor has
/// not been consensus-ordered yet, so forge's default of sending the whole batch
/// at once lands the first transaction and loses the rest. `--resume` cannot
/// repair that: the discarded transactions were signed with nonces the chain
/// has moved past. On 2026-09-09 this script was run without `--slow`; the
/// CREATE landed (gate 0xEA937e90a9aac050b08FEf86d7CA72227e017D0B, nonce 97)
/// and the five `publishRoot` calls and `proposeGate` were then sent one at a
/// time with `cast send`. `deployments/296-kyc.json` has the hashes.
contract DeployGate is Script {
    uint256 internal constant MIN_TIER = 3;
    uint256 internal constant JURISDICTION_MASK = 0xff;

    function run() external {
        uint256 pk = vm.envUint("HEDERA_PRIVATE_KEY");
        address me = vm.addr(pk);
        ZkKycRegistry registry = ZkKycRegistry(vm.envAddress("ZK_KYC_REGISTRY"));
        IPlonkVerifier verifier = IPlonkVerifier(vm.envAddress("KYC_VERIFIER"));
        uint256 wideRoot = vm.envUint("WIDE_ROOT");
        uint64 firstEpoch = uint64(vm.envUint("FIRST_ROOT_EPOCH"));
        uint64 epochs = uint64(vm.envUint("ROOT_EPOCHS"));

        require(registry.admin() == me, "signer is not the registry admin");
        require(wideRoot != 0, "WIDE_ROOT is zero");
        require(epochs >= 1 && epochs <= 52, "ROOT_EPOCHS out of range");
        uint64 current = registry.currentEpoch();
        require(firstEpoch == current + 1, "FIRST_ROOT_EPOCH must be the next epoch");

        vm.startBroadcast(pk);

        RegistrationGate gate = new RegistrationGate(verifier, registry, me, MIN_TIER, JURISDICTION_MASK);
        for (uint64 e = firstEpoch; e < firstEpoch + epochs; e++) {
            gate.publishRoot(e, wideRoot);
        }
        registry.proposeGate(address(gate));

        vm.stopBroadcast();

        console2.log("RegistrationGate (wide) ", address(gate));
        console2.log("verifier                ", address(verifier));
        console2.log("registry                ", address(registry));
        console2.log("roots published from    ", firstEpoch);
        console2.log("roots published through ", firstEpoch + epochs - 1);
        console2.log("pendingGate             ", registry.pendingGate());
        console2.log("pendingGateEpoch        ", registry.pendingGateEpoch());
    }
}
