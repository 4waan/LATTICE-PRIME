// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {HederaRateFeed} from "../src/oracle/HederaRateFeed.sol";
import {PrimeOracle} from "../src/oracle/PrimeOracle.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";

/// @title DeployRateFeed
/// @notice Puts up the cash-leg adapter and proposes it into the oracle's seat.
/// @dev **Proposes. It does not adopt.** `PrimeOracle.proposeCashFeed` lands at
///      the next disclosure epoch and `adoptCashFeed` is permissionless, which
///      is the same idiom `ZkKycRegistry.proposeGate` and `ParameterRoot.propose`
///      already use and is not worth an exception for a feed swap. The epoch is
///      300 seconds on this deployment, so the second half is a separate call a
///      few minutes later:
///
///        forge script script/DeployRateFeed.s.sol:AdoptRateFeed --broadcast
///
///      Doing it in two halves on chain is also the evidence: the seat visibly
///      does not move until the epoch turns.
contract DeployRateFeed is Script {
    function run() external {
        uint256 pk = vm.envUint("HEDERA_PRIVATE_KEY");
        PrimeOracle oracle = PrimeOracle(vm.envAddress("PRIME_ORACLE"));

        vm.startBroadcast(pk);
        HederaRateFeed feed = new HederaRateFeed();
        oracle.proposeCashFeed(AggregatorV3Interface(address(feed)));
        vm.stopBroadcast();

        console2.log("hederaRateFeed   ", address(feed));
        console2.log("  proposed for   ", oracle.pendingCashFeedEpoch());
        console2.log("  current epoch  ", oracle.policy().currentEpoch());

        // **The adapter is not read here and cannot be.** `forge script` runs
        // the script body against a local fork, and a fork carries a chain's
        // *contract* bytecode but not its system contracts: `0x168` has no code
        // there, so `usdPerHbar()` reverts `RateUnavailable` in simulation while
        // answering perfectly on the network the transaction is sent to. Read it
        // with `cast` against the real relay instead. The same limit is why
        // `spikes/scheduling` measured `0x16b` on chain rather than in a test.
    }
}

/// @notice The second half. Permissionless, so anyone may send it.
contract AdoptRateFeed is Script {
    function run() external {
        uint256 pk = vm.envUint("HEDERA_PRIVATE_KEY");
        PrimeOracle oracle = PrimeOracle(vm.envAddress("PRIME_ORACLE"));

        vm.startBroadcast(pk);
        oracle.adoptCashFeed();
        vm.stopBroadcast();

        console2.log("cashFeed         ", address(oracle.cashFeed()));
        // Same limit as above: `stale()` reads `0x168` through the adapter and
        // would answer dark on a fork whatever the network says. Read it back
        // with `cast`.
    }
}
