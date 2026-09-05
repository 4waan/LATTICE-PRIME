// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {KycVerifier} from "../src/kyc/KycVerifier.sol";
import {IPlonkVerifier} from "../src/kyc/IPlonkVerifier.sol";
import {ZkKycRegistry} from "../src/kyc/ZkKycRegistry.sol";
import {RegistrationGate} from "../src/kyc/RegistrationGate.sol";

/// @title DeployKyc
/// @notice Seam D on a live network: verifier, registry, gate.
///
/// The three contracts go up in dependency order and the gate is bootstrapped in
/// the same broadcast, because a registry with `gate == address(0)` denies every
/// registration and a deploy that leaves it that way is a deploy that has to be
/// redone.
///
/// ## Why the epoch is computed and not a constant
///
/// `test/fixtures/proofs.json` holds real PLONK proofs over `circuits/kyc.circom`
/// and every one of them is bound to epoch 7 as signal 2. A test warps to that
/// epoch. A live chain cannot be warped, so the deployment moves instead: with
/// `epochLength` at seven days and `epochZero` set seven epochs back from the
/// deploy timestamp, `currentEpoch()` reads 7 from the moment the registry exists
/// and stays there for a week. The fixture proofs therefore verify against this
/// deployment without regenerating a single one, which is the property that lets
/// the same proofs gate the tests and the demo.
///
/// ## Roles
///
/// `admin` and `issuer` are both the deployer. On this testnet deployment there is
/// one operator and pretending otherwise would be theatre. The separation is real
/// in the contracts and is exercised in `KycRegistration.t.sol`, where `ADMIN` and
/// `ISSUER` are distinct addresses and each negative path is asserted.
contract DeployKyc is Script {
    uint64 internal constant EPOCH_LEN = 7 days;
    uint64 internal constant PROOF_EPOCH = 7;

    /// The issuer's published credential root for epoch 7. Same value the fixture
    /// proofs were produced against; see `KycRegistrationTest.CRED_ROOT`.
    uint256 internal constant CRED_ROOT =
        6169089262182662551765430451869477850822369012194942422016362324771265384099;

    uint256 internal constant MIN_TIER = 3;
    uint256 internal constant JURISDICTION_MASK = 0xff;

    function run() external {
        uint256 pk = vm.envUint("HEDERA_PRIVATE_KEY");
        address me = vm.addr(pk);
        uint64 epochZero = uint64(block.timestamp) - PROOF_EPOCH * EPOCH_LEN;

        vm.startBroadcast(pk);

        KycVerifier verifier = new KycVerifier();
        ZkKycRegistry registry = new ZkKycRegistry(me, epochZero, EPOCH_LEN);
        RegistrationGate gate = new RegistrationGate(
            IPlonkVerifier(address(verifier)), registry, me, MIN_TIER, JURISDICTION_MASK
        );

        registry.bootstrapGate(address(gate));
        gate.publishRoot(PROOF_EPOCH, CRED_ROOT);

        vm.stopBroadcast();

        console2.log("KycVerifier      ", address(verifier));
        console2.log("ZkKycRegistry    ", address(registry));
        console2.log("RegistrationGate ", address(gate));
        console2.log("epochZero        ", epochZero);
        console2.log("epochLength      ", EPOCH_LEN);
        console2.log("currentEpoch     ", registry.currentEpoch());
    }
}
