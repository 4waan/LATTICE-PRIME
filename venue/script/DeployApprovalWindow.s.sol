// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ApprovalWindowCompliance} from "../src/policy/ApprovalWindowCompliance.sol";

contract DeployApprovalWindow is Script {
    function run() external returns (ApprovalWindowCompliance window) {
        uint256 pk = vm.envUint("HEDERA_PRIVATE_KEY");
        address token = vm.envAddress("ATS_TOKEN");
        address owner = vm.envAddress("COLLATERAL_OWNER");
        address spender = vm.envAddress("COLLATERAL_SPENDER");

        vm.startBroadcast(pk);
        window = new ApprovalWindowCompliance(token, owner, spender);
        vm.stopBroadcast();

        console2.log("ApprovalWindowCompliance", address(window));
    }
}
