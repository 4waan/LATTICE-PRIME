// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ParameterRoot} from "../src/policy/ParameterRoot.sol";
import {RepoVault} from "../src/repo/RepoVault.sol";
import {ICouponSchedule} from "../src/interfaces/ICouponSchedule.sol";
import {CouponMath} from "../src/coupon/CouponMath.sol";
import {CouponSchedule} from "../src/coupon/CouponSchedule.sol";
import {MarginWatch} from "../src/observatory/MarginWatch.sol";
import {IPrimeOracle} from "../src/interfaces/IPrimeOracle.sol";
import {IHoldByPartition} from "../src/interfaces/IHoldByPartition.sol";
import {IExternalKycList} from "../src/interfaces/IExternalKycList.sol";

/// @title DeploySettlement
/// @notice Replaces RepoVault and MarginWatch. Historical vaults stay in
///         `superseded`; this does not migrate their state.
/// @dev `FINANCING_VERSION` on the new vault is 5: funded HBAR offers bound to
///      one eligible borrower, fixed-term economics, pull credits, collateral
///      held until close or default, and due-date historical coupon fixings.
///      The live oracle, policy,
///      ATS bond, market and compliance stack are reused. Do not regenerate
///      `client.json` until this script has actually been broadcast.
///
/// Required environment:
///
/// ```
/// ATS_TOKEN       the existing ATS bond
/// VENUE_PARAMS    the existing ParameterRoot
/// PRIME_ORACLE    a PrimeOracle with `referenceRateBefore` and a finalized round
/// ZK_KYC_REGISTRY the external list configured on the ATS bond
/// MARGIN_ENGINE   optional manual mark and liquidation seat, defaults to deployer
/// ```
contract DeploySettlement is Script {
    uint256 internal constant PENALTY_RATE = 10;
    uint64 internal constant FAIL_GRACE = 5 days;
    uint64 internal constant CURE_WINDOW = 1 days;

    uint16 internal constant COUPON_SPREAD_BPS = 75;
    uint128 internal constant FACE_VALUE = 10_000;
    uint256 internal constant COUPONS = 8;
    uint64 internal constant COUPON_PERIOD = 91 days;
    uint64 internal constant FIRST_COUPON = 1 hours;

    error FeedIsNotReady(address oracle);
    error HistoricalFeedIsNotReady(address oracle);

    function run() external {
        uint256 pk = vm.envUint("HEDERA_PRIVATE_KEY");
        address me = vm.addr(pk);

        IHoldByPartition token = IHoldByPartition(vm.envAddress("ATS_TOKEN"));
        ParameterRoot params = ParameterRoot(vm.envAddress("VENUE_PARAMS"));
        IPrimeOracle oracle = IPrimeOracle(vm.envAddress("PRIME_ORACLE"));
        IExternalKycList registry =
            IExternalKycList(vm.envAddress("ZK_KYC_REGISTRY"));
        address marginEngine = vm.envOr("MARGIN_ENGINE", me);

        // A wrong oracle address should fail before any deployment is broadcast.
        // `stale` is total on PrimeOracle, so this validates the interface even
        // when the panel simply needs a fresh round.
        (bool ok, bytes memory result) =
            address(oracle).staticcall(abi.encodeCall(IPrimeOracle.stale, ()));
        if (!ok || result.length != 32) revert FeedIsNotReady(address(oracle));
        (ok, result) = address(oracle).staticcall(abi.encodeCall(IPrimeOracle.latest, ()));
        if (!ok || result.length != 128) revert HistoricalFeedIsNotReady(address(oracle));
        (,, uint64 publishedAt,) = abi.decode(result, (uint128, uint64, uint64, uint64));
        if (publishedAt == 0 || publishedAt == type(uint64).max) {
            revert HistoricalFeedIsNotReady(address(oracle));
        }
        (ok, result) = address(oracle).staticcall(
            abi.encodeCall(IPrimeOracle.referenceRateBefore, (publishedAt + 1))
        );
        if (!ok || result.length != 96) revert HistoricalFeedIsNotReady(address(oracle));

        vm.startBroadcast(pk);

        CouponSchedule schedule = new CouponSchedule(
            uint64(block.timestamp),
            _couponDates(uint64(block.timestamp)),
            COUPON_SPREAD_BPS,
            FACE_VALUE,
            CouponMath.Basis.ACT_365
        );

        RepoVault vault = new RepoVault(
            token,
            marginEngine,
            oracle,
            ICouponSchedule(address(schedule)),
            registry,
            params,
            PENALTY_RATE,
            FAIL_GRACE,
            CURE_WINDOW
        );
        MarginWatch watch = new MarginWatch(vault);

        vm.stopBroadcast();

        console2.log("couponSchedule   ", address(schedule));
        console2.log("  coupons        ", schedule.count());
        console2.log("  spreadBps      ", schedule.spreadBps());
        console2.log("  faceValue      ", schedule.faceValue());
        console2.log("  firstCoupon    ", schedule.dateOf(0));
        console2.log("repoVault        ", address(vault));
        console2.log("marginWatch      ", address(watch));
        console2.log("vault.oracle     ", address(vault.oracle()));
        console2.log("vault.schedule   ", address(vault.schedule()));
        console2.log("marginEngine     ", vault.marginEngine());
    }

    function _couponDates(uint64 from) internal pure returns (uint64[] memory dates) {
        dates = new uint64[](COUPONS);
        dates[0] = from + FIRST_COUPON;
        for (uint256 i = 1; i < COUPONS; ++i) {
            dates[i] = dates[i - 1] + COUPON_PERIOD;
        }
    }
}
