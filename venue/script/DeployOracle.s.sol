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
import {PrimeOracle} from "../src/oracle/PrimeOracle.sol";
import {IPrimeOracle} from "../src/interfaces/IPrimeOracle.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {HederaRateFeed} from "../src/oracle/HederaRateFeed.sol";
import {IHoldByPartition} from "../src/interfaces/IHoldByPartition.sol";

/// @title DeployOracle
/// @notice The feed, and the two contracts that had to move to reach it.
///
/// **Deliberately not `DeployVenue`.** That script puts up the whole venue and
/// begins by calling `params.adopt`, which needs a parameter set proposed an
/// epoch earlier; running it to add a feed would redeploy the matching engine,
/// the volume cap, the trading halt and the rulebook, and would spend a
/// governance cycle on a set nobody wanted to change. None of that is required
/// by the feed.
///
/// What is required is exactly three contracts, and the second and third only
/// because Solidity has no way to add an immutable to a deployed contract:
///
///   PrimeOracle   new. The panel, the median, and the Chainlink leg.
///   RepoVault     redeployed. `oracle` and `cureWindow` are immutables.
///   MarginWatch   redeployed. `vault` is an immutable and the vault moved.
///
/// Everything else is reused at the address it already holds: the parameter
/// root, the regime, the clock, the journal, the engine, the KYC stack and the
/// bond itself. `RepoVault` is not registered with ATS in any way that would
/// need re-doing: it takes holds through `IHoldByPartition` as any caller does,
/// and the compliance seat belongs to `SeamJournal`, which does not move.
///
/// The outgoing vault has no history. Checked before writing this, against the
/// mirror node's log index for its address: zero entries, so no repo is
/// stranded by the move and nothing has to be migrated. Had there been one,
/// this script would not be the right shape.
contract DeployOracle is Script {
    /// @notice Chainlink's HBAR/USD aggregator on Hedera testnet.
    /// @dev **Named, and deliberately not seated.** Chainlink's proxies on
    ///      Hedera are access controlled: a contract reading one gets
    ///      `No access` while `decimals()` answers anyone, on testnet and on
    ///      mainnet alike. `probes/chainlink-hedera.out` measures all seven
    ///      through an on-chain probe, which is the only way to see it, because
    ///      an `eth_call` sets `tx.origin` to its own `from` and passes the
    ///      check. The constant stays because `CHAINLINK_HBAR_USD` is the
    ///      override a chain that permits contract reads would use, and because
    ///      a decision this expensive to rediscover should be written where the
    ///      next person looks.
    address internal constant CHAINLINK_HBAR_USD = 0xd4DC5F0a891381D09d6437482a0E4E2dca4ACCAa;

    /// @dev Kept at Chainlink's own 86,400 second heartbeat plus slack, even
    ///      though the seat holds `HederaRateFeed`, which is consensus state and
    ///      cannot go quiet. It costs nothing, and it is the bound that binds
    ///      again the moment a readable Chainlink aggregator is seated in its
    ///      place. A bound tighter than a publisher's own would read a healthy
    ///      feed as dark, and a dark cash leg is what opens the manual seat.
    uint64 internal constant CASH_HEARTBEAT = 26 hours;

    /// @dev The venue's own panel is held to a tighter clock than the feed it
    ///      does not control.
    uint64 internal constant FEED_HEARTBEAT = 6 hours;

    uint16 internal constant MAX_DEVIATION_BPS = 500;
    uint8 internal constant MAX_PUBLISHERS = 7;

    uint256 internal constant PENALTY_RATE = 10;
    uint64 internal constant FAIL_GRACE = 5 days;
    uint64 internal constant CURE_WINDOW = 1 days;

    // ------------------------------------------------------------ the coupon

    /// @notice The bond's spread over the reference rate, in basis points.
    /// @dev The deployed instrument is `"kind": "bond, variable rate"`, which
    ///      means the coupon resets against something. `PrimeOracle` publishes
    ///      the reference leg and this is the issuer's margin over it, fixed at
    ///      issuance because that is what a spread is.
    uint16 internal constant COUPON_SPREAD_BPS = 75;

    /// @notice Nominal value of one unit of the bond, in the cash token's
    ///         smallest unit.
    /// @dev `deployments/296-venue.json` says `nominalValue: "100.00"` and
    ///      `currency: "USD"`. The cash asset carries two decimals, so one unit
    ///      of face is ten thousand of them. This is the second place in this
    ///      repository where a scale has to be right and cannot be inferred from
    ///      the type, after `HBAR` above, and it is written out for the same
    ///      reason that one is.
    uint128 internal constant FACE_VALUE = 10_000;

    /// @notice How many coupons the calendar carries, and how far apart.
    /// @dev Quarterly to the 2028 maturity, near enough, and **not compressed
    ///      the way `DELAY` and `ROUND` are**. The market constants are squeezed
    ///      because somebody has to watch a round cross inside a session; a
    ///      coupon calendar is not watched, it is read, and a bond with hourly
    ///      coupons would be a bond that does not exist. What makes a coupon
    ///      demonstrable instead is `FIRST_COUPON` below.
    uint256 internal constant COUPONS = 8;
    uint64 internal constant COUPON_PERIOD = 91 days;

    /// @dev **The one compression, and it is at the front rather than
    ///      throughout.** `CouponDistributor.declare` refuses a coupon that has
    ///      not fallen due, so a calendar whose first date is three months out
    ///      is a distributor nobody can exercise until March. One hour in makes
    ///      the first coupon reachable in the session the venue is deployed in,
    ///      and every date after it is a real quarter. The accrual is ACT/365
    ///      either way, so the first coupon is simply a small one: an hour of a
    ///      year at the reference rate, which is the arithmetic being correct
    ///      rather than the arithmetic being bypassed.
    uint64 internal constant FIRST_COUPON = 1 hours;

    // The calendar is deployed here and the distributor is not, because the
    // distributor needs a cash token and an HTS fungible token with a fractional
    // custom fee is made by a receipted HTS transaction rather than by a
    // Solidity `new`. `script/DeployCoupon.s.sol` takes the schedule address
    // this script prints, plus `CASH_TOKEN`, and carries `CLAIM_WINDOW` and
    // `PAYING_AGENT_FEE_BPS` with the reasoning behind both numbers. Holding
    // them in one place keeps a redeployment from publishing a tariff rate that
    // disagrees with the one `docs/RULEBOOK.md` §8 reconciles against.

    /// @notice Quarterly coupon dates from now, with the first one an hour out.
    /// @dev A function and not a literal array, because the dates are relative
    ///      to the deployment and a committed array would be a calendar that
    ///      went stale the moment it was written.
    function _couponDates(uint64 from) internal pure returns (uint64[] memory dates) {
        dates = new uint64[](COUPONS);
        dates[0] = from + FIRST_COUPON;
        for (uint256 i = 1; i < COUPONS; ++i) {
            dates[i] = dates[i - 1] + COUPON_PERIOD;
        }
    }

    function run() external {
        uint256 pk = vm.envUint("HEDERA_PRIVATE_KEY");
        address me = vm.addr(pk);

        ParameterRoot params = ParameterRoot(vm.envAddress("VENUE_PARAMS"));
        address token = vm.envAddress("ATS_TOKEN");
        address[] memory panel = _publishers(me);

        vm.startBroadcast(pk);

        PrimeOracle oracle = new PrimeOracle(
            params,
            me,
            _cashFeed(),
            panel,
            _quorum(panel.length),
            MAX_PUBLISHERS,
            FEED_HEARTBEAT,
            CASH_HEARTBEAT,
            MAX_DEVIATION_BPS
        );

        CouponSchedule schedule = new CouponSchedule(
            uint64(block.timestamp),
            _couponDates(uint64(block.timestamp)),
            COUPON_SPREAD_BPS,
            FACE_VALUE,
            CouponMath.Basis.ACT_365
        );

        RepoVault vault = new RepoVault(
            IHoldByPartition(token),
            me,
            IPrimeOracle(address(oracle)),
            ICouponSchedule(address(schedule)),
            params,
            PENALTY_RATE,
            FAIL_GRACE,
            CURE_WINDOW
        );
        MarginWatch watch = new MarginWatch(vault);

        vm.stopBroadcast();

        console2.log("primeOracle      ", address(oracle));
        console2.log("  cashFeed       ", address(oracle.cashFeed()));
        console2.log("  publishers     ", oracle.publisherCount());
        console2.log("  quorum         ", oracle.quorum());
        console2.log("  heartbeat      ", oracle.heartbeat());
        console2.log("  cashHeartbeat  ", oracle.cashHeartbeat());
        console2.log("  maxDeviationBps", oracle.maxDeviationBps());
        console2.log("couponSchedule   ", address(schedule));
        console2.log("  coupons        ", schedule.count());
        console2.log("  spreadBps      ", schedule.spreadBps());
        console2.log("  faceValue      ", schedule.faceValue());
        console2.log("  firstCoupon    ", schedule.dateOf(0));
        console2.log("repoVault        ", address(vault));
        console2.log("marginWatch      ", address(watch));
        console2.log("vault.oracle     ", address(vault.oracle()));
    }

    /// @notice The cash leg. An override, or a fresh adapter over `0x168`.
    /// @dev `CASH_FEED` seats an existing `AggregatorV3Interface` at an address,
    ///      which is how a chain that permits a contract to read a Chainlink
    ///      aggregator would seat one. With nothing set, this deploys
    ///      `HederaRateFeed` and seats that, which is the only thing on Hedera
    ///      that answers.
    function _cashFeed() internal returns (AggregatorV3Interface) {
        address given = vm.envOr("CASH_FEED", address(0));
        if (given != address(0)) return AggregatorV3Interface(given);
        return AggregatorV3Interface(address(new HederaRateFeed()));
    }

    /// @notice Who may price the bond. `ORACLE_PUBLISHERS`, comma separated.
    function _publishers(address me) internal view returns (address[] memory) {
        address[] memory fallback_ = new address[](1);
        fallback_[0] = me;
        return vm.envOr("ORACLE_PUBLISHERS", ",", fallback_);
    }

    /// @notice A strict majority of the seated panel.
    /// @dev Not the whole panel. Requiring every seat to answer makes one absent
    ///      publisher a dark feed, and a feed any single participant can switch
    ///      off is worse than one that tolerates them. A strict majority is also
    ///      the bound the median's own robustness argument needs: with `f < n/2`
    ///      dishonest answers the median stays inside the honest range, which
    ///      `probes/oracle-median.py` sweeps at every panel size.
    function _quorum(uint256 seats) internal pure returns (uint8) {
        // Safe: `PrimeOracle` refuses a panel above `maxPublishers`, a `uint8`.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8(seats / 2 + 1);
    }
}
