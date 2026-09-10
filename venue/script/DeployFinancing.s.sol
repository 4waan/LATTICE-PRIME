// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {RepoVault} from "../src/repo/RepoVault.sol";
import {MarginWatch} from "../src/observatory/MarginWatch.sol";
import {IHoldByPartition} from "../src/interfaces/IHoldByPartition.sol";
import {IPrimeOracle} from "../src/interfaces/IPrimeOracle.sol";
import {ICouponSchedule} from "../src/interfaces/ICouponSchedule.sol";
import {IExternalKycList} from "../src/interfaces/IExternalKycList.sol";
import {IDisclosurePolicy} from "../src/interfaces/IDisclosurePolicy.sol";

/// @title DeployFinancing
/// @notice Binds RepoVault v5 without moving the bond, oracle, calendar, or policy.
/// @dev The existing CouponSchedule is required. Reusing it keeps the live
///      CouponDistributor and the repo vault on the same immutable calendar.
contract DeployFinancing is Script {
    uint256 internal constant PENALTY_RATE = 10;
    uint64 internal constant FAIL_GRACE = 5 days;
    uint64 internal constant CURE_WINDOW = 1 days;

    uint16 internal constant EXPECTED_SPREAD_BPS = 75;
    uint128 internal constant EXPECTED_FACE_VALUE = 10_000;

    error EmptySchedule(address schedule);
    error FeedIsDark(address oracle);
    error HistoricalFeedIsNotReady(address oracle);
    error WrongScheduleTerms(uint16 spreadBps, uint128 faceValue);

    function run() external {
        uint256 pk = vm.envUint("HEDERA_PRIVATE_KEY");
        address me = vm.addr(pk);

        IHoldByPartition token = IHoldByPartition(vm.envAddress("ATS_TOKEN"));
        IDisclosurePolicy policy = IDisclosurePolicy(vm.envAddress("VENUE_PARAMS"));
        IPrimeOracle oracle = IPrimeOracle(vm.envAddress("PRIME_ORACLE"));
        ICouponSchedule schedule = ICouponSchedule(vm.envAddress("COUPON_SCHEDULE"));
        IExternalKycList registry = IExternalKycList(vm.envAddress("ZK_KYC_REGISTRY"));
        address marginEngine = vm.envOr("MARGIN_ENGINE", me);

        if (oracle.ourLegStale()) revert FeedIsDark(address(oracle));
        bool livePreflightDone = vm.envOr("FINANCING_PREFLIGHT_ACK", false);
        if (!livePreflightDone && oracle.stale()) revert FeedIsDark(address(oracle));
        (,, uint64 publishedAt,) = oracle.latest();
        if (publishedAt == 0 || publishedAt == type(uint64).max) {
            revert HistoricalFeedIsNotReady(address(oracle));
        }
        try oracle.referenceRateBefore(publishedAt + 1) returns (uint64, uint64, uint64) {}
        catch {
            revert HistoricalFeedIsNotReady(address(oracle));
        }

        if (schedule.count() == 0) revert EmptySchedule(address(schedule));
        uint16 spread = schedule.spreadBps();
        uint128 face = schedule.faceValue();
        if (spread != EXPECTED_SPREAD_BPS || face != EXPECTED_FACE_VALUE) {
            revert WrongScheduleTerms(spread, face);
        }

        vm.startBroadcast(pk);
        RepoVault vault = new RepoVault(
            token,
            marginEngine,
            oracle,
            schedule,
            registry,
            policy,
            PENALTY_RATE,
            FAIL_GRACE,
            CURE_WINDOW
        );
        MarginWatch watch = new MarginWatch(vault);
        vm.stopBroadcast();

        console2.log("repoVault        ", address(vault));
        console2.log("marginWatch      ", address(watch));
        console2.log("financingVersion ", vault.FINANCING_VERSION());
        console2.log("security         ", address(vault.security()));
        console2.log("oracle           ", address(vault.oracle()));
        console2.log("schedule         ", address(vault.schedule()));
        console2.log("registry         ", address(vault.registry()));
        console2.log("policy           ", address(vault.policy()));
        console2.log("marginEngine     ", vault.marginEngine());
        console2.log("penaltyRate      ", vault.penaltyRate());
        console2.log("failGrace        ", vault.failGrace());
        console2.log("cureWindow       ", vault.cureWindow());
    }
}
