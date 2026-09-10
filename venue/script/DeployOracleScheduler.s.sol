// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IOracleSchedulerTarget, OracleScheduler} from "../src/oracle/OracleScheduler.sol";

/// @title DeployOracleScheduler
/// @notice Deploys the permissionless HSS finalization loop for an existing oracle.
contract DeployOracleScheduler is Script {
    function run() external {
        uint256 key = vm.envUint("HEDERA_PRIVATE_KEY");
        address oracle = vm.envAddress("PRIME_ORACLE");
        uint64 initialDelay = uint64(vm.envOr("ORACLE_SCHEDULER_INITIAL_DELAY", uint256(90)));

        vm.startBroadcast(key);
        OracleScheduler scheduler =
            new OracleScheduler(IOracleSchedulerTarget(oracle), initialDelay);
        vm.stopBroadcast();

        console2.log("oracleScheduler", address(scheduler));
        console2.log("  oracle       ", oracle);
        console2.log("  treasury     ", scheduler.treasury());
        console2.log("  initialDelay ", initialDelay);
        console2.log("  minBalance   ", scheduler.MIN_BALANCE_TINYBAR());
        console2.log("Fund the scheduler before calling arm().");
    }
}
