// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {RepoVault} from "../src/repo/RepoVault.sol";
import {MarginWatch} from "../src/observatory/MarginWatch.sol";
import {CouponSchedule} from "../src/coupon/CouponSchedule.sol";
import {CouponMath} from "../src/coupon/CouponMath.sol";
import {IHoldByPartition} from "../src/interfaces/IHoldByPartition.sol";
import {IPrimeOracle} from "../src/interfaces/IPrimeOracle.sol";
import {IExternalKycList} from "../src/interfaces/IExternalKycList.sol";
import {IDisclosurePolicy} from "../src/interfaces/IDisclosurePolicy.sol";

/// @title DeployFinancingDemo
/// @notice A clearly separate testnet vault for time-gated lifecycle evidence.
/// @dev These compressed clocks are not production configuration. This vault is
///      never written into the client address book and never replaces the bound
///      production RepoVault.
contract DeployFinancingDemo is Script {
    uint256 public constant DEMO_PENALTY_RATE = 10;
    uint64 public constant DEMO_FAIL_GRACE = 2 minutes;
    uint64 public constant DEMO_CURE_WINDOW = 5 minutes;
    uint64 public constant DEMO_COUPON_DELAY = 15 minutes;

    uint16 internal constant COUPON_SPREAD_BPS = 75;
    uint128 internal constant FACE_VALUE = 10_000;

    error FeedIsDark(address oracle);
    error HistoricalFeedIsNotReady(address oracle);

    function run() external {
        uint256 pk = vm.envUint("HEDERA_PRIVATE_KEY");
        address me = vm.addr(pk);

        IHoldByPartition token = IHoldByPartition(vm.envAddress("ATS_TOKEN"));
        IDisclosurePolicy policy = IDisclosurePolicy(vm.envAddress("VENUE_PARAMS"));
        IPrimeOracle oracle = IPrimeOracle(vm.envAddress("PRIME_ORACLE"));
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

        uint64 issuedAt = uint64(block.timestamp);
        uint64[] memory dates = new uint64[](1);
        dates[0] = issuedAt + DEMO_COUPON_DELAY;

        vm.startBroadcast(pk);
        CouponSchedule schedule = new CouponSchedule(
            issuedAt, dates, COUPON_SPREAD_BPS, FACE_VALUE, CouponMath.Basis.ACT_365
        );
        RepoVault vault = new RepoVault(
            token,
            marginEngine,
            oracle,
            schedule,
            registry,
            policy,
            DEMO_PENALTY_RATE,
            DEMO_FAIL_GRACE,
            DEMO_CURE_WINDOW
        );
        MarginWatch watch = new MarginWatch(vault);
        vm.stopBroadcast();

        console2.log("demoCouponSchedule", address(schedule));
        console2.log("demoRepoVault     ", address(vault));
        console2.log("demoMarginWatch   ", address(watch));
        console2.log("financingVersion  ", vault.FINANCING_VERSION());
        console2.log("firstCoupon       ", schedule.dateOf(0));
        console2.log("failGrace         ", vault.failGrace());
        console2.log("cureWindow        ", vault.cureWindow());
        console2.log("productionBinding ", false);
    }
}
