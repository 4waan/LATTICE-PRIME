// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {PrimeOracle} from "../src/oracle/PrimeOracle.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {IDisclosurePolicy} from "../src/interfaces/IDisclosurePolicy.sol";

/// @title DeployPrimeOracle
/// @notice Replaces only an ABI-incompatible oracle while preserving its seats.
/// @dev RepoVault v5 requires `referenceRateBefore(uint64)`. This focused script
///      does not deploy a vault, schedule, rate adapter, or any market contract.
contract DeployPrimeOracle is Script {
    uint64 internal constant CASH_HEARTBEAT = 26 hours;
    uint64 internal constant FEED_HEARTBEAT = 6 hours;
    uint16 internal constant MAX_DEVIATION_BPS = 500;
    uint8 internal constant MAX_PUBLISHERS = 7;

    function run() external {
        uint256 pk = vm.envUint("HEDERA_PRIVATE_KEY");
        address me = vm.addr(pk);
        IDisclosurePolicy policy = IDisclosurePolicy(vm.envAddress("VENUE_PARAMS"));
        AggregatorV3Interface cashFeed = AggregatorV3Interface(vm.envAddress("CASH_FEED"));
        address[] memory fallback_ = new address[](1);
        fallback_[0] = me;
        address[] memory panel = vm.envOr("ORACLE_PUBLISHERS", ",", fallback_);

        vm.startBroadcast(pk);
        PrimeOracle oracle = new PrimeOracle(
            policy,
            me,
            cashFeed,
            panel,
            _quorum(panel.length),
            MAX_PUBLISHERS,
            FEED_HEARTBEAT,
            CASH_HEARTBEAT,
            MAX_DEVIATION_BPS
        );
        vm.stopBroadcast();

        console2.log("primeOracle      ", address(oracle));
        console2.log("cashFeed         ", address(oracle.cashFeed()));
        console2.log("publishers       ", oracle.publisherCount());
        console2.log("quorum           ", oracle.quorum());
        console2.log("heartbeat        ", oracle.heartbeat());
        console2.log("cashHeartbeat    ", oracle.cashHeartbeat());
        console2.log("maxDeviationBps  ", oracle.maxDeviationBps());
    }

    function _quorum(uint256 seats) internal pure returns (uint8) {
        // Safe because PrimeOracle rejects a panel above MAX_PUBLISHERS.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8(seats / 2 + 1);
    }
}
