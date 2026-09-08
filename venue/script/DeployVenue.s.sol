// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {EpochClock} from "../src/policy/EpochClock.sol";
import {Regime} from "../src/policy/Regime.sol";
import {ParameterRoot} from "../src/policy/ParameterRoot.sol";
import {VolumeCap} from "../src/policy/VolumeCap.sol";
import {TradingHalt} from "../src/policy/TradingHalt.sol";
import {MatchingEngine} from "../src/market/MatchingEngine.sol";
import {RepoVault} from "../src/repo/RepoVault.sol";
import {ICouponSchedule} from "../src/interfaces/ICouponSchedule.sol";
import {CouponMath} from "../src/coupon/CouponMath.sol";
import {CouponSchedule} from "../src/coupon/CouponSchedule.sol";
import {PrimeOracle} from "../src/oracle/PrimeOracle.sol";
import {IPrimeOracle} from "../src/interfaces/IPrimeOracle.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {HederaRateFeed} from "../src/oracle/HederaRateFeed.sol";
import {MarginWatch} from "../src/observatory/MarginWatch.sol";
import {Rulebook} from "../src/observatory/Rulebook.sol";
import {SeamJournal} from "../src/observatory/SeamJournal.sol";
import {DisclosureBudget} from "../src/lattice/DisclosureBudget.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {IHoldByPartition} from "../src/interfaces/IHoldByPartition.sol";
import {IExternalKycList} from "../src/interfaces/IExternalKycList.sol";
import {ICompliance} from "../src/interfaces/ICompliance.sol";
import {PolicySets} from "./PolicySets.sol";
import {IAtsToken} from "./ats/IAtsFactory.sol";

/// @title DeployVenue
/// @notice Stage two. Adopts the parameter set proposed an epoch ago, then puts
///         up every contract that trades against the ATS bond and points each of
///         them at the real token.
///
/// The order below is the one `MatchingEngine.t.sol::_deploy` establishes, and
/// it is not arbitrary. The regime is already up with its supervisor seat
/// vacant; the engine goes up; the cap takes the engine as its venue; the seat
/// is filled with the cap; and only then is the cap attached, which verifies
/// `cap.venue() == engine` so a borrowed cap cannot be installed. Running the
/// suite's order on chain is the point: a deployment that wires the venue
/// differently from the tests is a deployment the tests do not cover.
///
/// ## What is now real that was a mock an hour ago
///
/// `MatchingEngine` takes `IHoldByPartition security_` and `ICompliance
/// compliance_`. Until this script the only implementations of those in the
/// tree were `AtsHolds` and `ComplianceSpy`, both declared inside
/// `test/MatchingEngine.t.sol`. Here `security_` is a diamond over Hashgraph's
/// 108 deployed facets and `compliance_` is `SeamJournal`, which was never a
/// mock; it simply had no token to be the compliance module of.
///
/// The last call in this script is `setCompliance`, which is the one that makes
/// the venue observable to itself: from that transaction on, every transfer,
/// issue and redemption of the bond calls `SeamJournal.canTransfer` before the
/// balance moves and `SeamJournal.transferred` after it.
contract DeployVenue is Script {
    // ------------------------------------------------------------ the market

    /// @dev Thirty seconds to reveal, four and a half minutes to do it in, five
    ///      minute rounds, two rounds of rest. The suite runs five minutes,
    ///      thirty minutes, one day and seven, which are the numbers a venue
    ///      with real participants would want and are unusable in a session
    ///      where somebody has to watch a round cross. The *relations* are
    ///      preserved, which is what the contracts constrain: `cancelFee` is at
    ///      its floor, the reveal window strictly contains the delay, and the
    ///      round outlives both.
    uint64 internal constant DELAY = 30;
    uint64 internal constant WINDOW = 270;
    uint64 internal constant ROUND = 300;
    uint64 internal constant REST = 2;
    /// @notice One HBAR in the units `msg.value` carries **inside the Hedera
    ///         EVM**, which is tinybars and not weibars.
    /// @dev This constant exists because the first deployment of this venue got
    ///      it wrong, and nothing short of a live chain could have said so.
    ///
    ///      Solidity's `ether` literal is 1e18 and every test in this repo runs
    ///      on an EVM where that is what `msg.value` counts in. Hedera's is not:
    ///      the JSON-RPC relay takes a transaction's `value` in weibars, divides
    ///      by 1e10 to reach tinybars, and the EVM sees the tinybars. A
    ///      `commitBond` of `0.01 ether` therefore asks for 1e16 **tinybars**,
    ///      which is a hundred million HBAR, and every `commit` reverts
    ///      `WrongBond`.
    ///
    ///      Measured rather than assumed: sending 1e18 weibar to `commit` came
    ///      back `WrongBond(100000000, ...)` and 5e18 came back
    ///      `WrongBond(500000000, ...)`, so the ratio is 1e10 at two points.
    ///
    ///      Nothing in `src/` changes. `commitBond` is a `uint256` the deployer
    ///      picks and the contracts are unit-agnostic; it was the deployment
    ///      that was wrong, which is the correct place for a chain's native
    ///      denomination to live.
    uint256 internal constant HBAR = 1e8;

    uint256 internal constant BOND = HBAR / 100; // 0.01 HBAR
    /// @dev `ceil(BOND * DELAY / (DELAY + WINDOW))`, which is
    ///      `OrderBook.minimumCancelFee` exactly. Set at the floor rather than
    ///      above it so the constructor's `CancelFeeTooLow` check is the thing
    ///      that decides it, not a round number chosen here. With DELAY 30 and
    ///      WINDOW 270 that division is exact, so the floor is `BOND / 10`.
    uint256 internal constant FEE = BOND / 10;

    /// @dev ATS's `_DEFAULT_PARTITION`. The venue's own constant was already
    ///      this value; `isMultiPartition = false` on the token is what makes
    ///      the agreement enforced rather than coincidental.
    bytes32 internal constant PARTITION = bytes32(uint256(1));

    // ------------------------------------------------------------ the policy

    /// @dev Forty per cent, as in the suite. Article 5's double volume cap.
    uint16 internal constant CAP_BPS = 4000;
    uint32 internal constant MAX_HALT = 1 hours;
    uint32 internal constant HALT_BUDGET = 4 hours;
    /// @dev Wide enough that the breaker cannot fire on its own. A venue whose
    ///      first live trade trips a circuit breaker has tested the breaker and
    ///      nothing else; the halt tests build their own band.
    uint16 internal constant BAND_BPS = 9999;
    uint32 internal constant BREAKER = 1 hours;

    // -------------------------------------------------------------- the repo

    uint256 internal constant PENALTY_RATE = 10;
    uint64 internal constant FAIL_GRACE = 5 days;

    /// @notice The window `markToMarket` gives a borrower to cure.
    /// @dev Published rather than passed, because `markToMarket` is
    ///      permissionless and a caller-chosen window would let anyone call a
    ///      position and default it in the next block. `postMark` keeps its
    ///      argument; that seat is a named address.
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

    // ------------------------------------------------------------ the oracle

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
    ///      feed as dark, which is what opens `RepoVault.postMark`.
    uint64 internal constant CASH_HEARTBEAT = 26 hours;

    /// @dev The venue's own leg is a panel this venue seats, so it is held to a
    ///      tighter clock than the one it does not control.
    uint64 internal constant FEED_HEARTBEAT = 6 hours;

    /// @dev Five percent. A private bond's clean price does not move five
    ///      percent between rounds for a reason the venue would not already
    ///      know about, so a round that does is a bad publisher long before it
    ///      is a market. The cost of the bound is stated in `docs/RULEBOOK.md`
    ///      section 4: a genuine jump larger than this takes several rounds to
    ///      walk, and until it does the feed goes stale and the manual seat runs.
    uint16 internal constant MAX_DEVIATION_BPS = 500;

    /// @dev The sort in `finalize` is bounded by this and nothing else.
    uint8 internal constant MAX_PUBLISHERS = 7;

    struct FinancingDeployment {
        CouponSchedule schedule;
        RepoVault vault;
        MarginWatch watch;
        Rulebook rulebook;
    }

    function run() external {
        uint256 pk = vm.envUint("HEDERA_PRIVATE_KEY");
        address me = vm.addr(pk);

        EpochClock clock = EpochClock(vm.envAddress("VENUE_CLOCK"));
        Regime regime = Regime(vm.envAddress("VENUE_REGIME"));
        ParameterRoot params = ParameterRoot(vm.envAddress("VENUE_PARAMS"));
        address token = vm.envAddress("ATS_TOKEN");
        address registry = vm.envAddress("ZK_KYC_REGISTRY");

        vm.startBroadcast(pk);

        // --- the epoch has passed, so the commitment opens. Permissionless by
        //     design: if only the operator could open its own commitment the
        //     timing of adoption would be a second discretionary signal.
        {
            ParameterRoot.Param[] memory set = PolicySets.asDeployed();
            params.adopt(set);
        }

        // --- seam C and C-prime. Built before the engine because the engine
        //     takes it, and after the token because `SeamJournal.token` is
        //     immutable and is the write side's only accepted caller.
        // Reused when `VENUE_JOURNAL` is set. The journal depends on the token,
        // the registry and the clock, and on none of the contracts below it, so
        // a redeployment of the governed stack does not oblige a second journal
        // and the token's `setCompliance` does not have to be spent again.
        SeamJournal journal = _existing("VENUE_JOURNAL") != address(0)
            ? SeamJournal(_existing("VENUE_JOURNAL"))
            : new SeamJournal(
                me, token, registry, clock.epochZero(), clock.epochLength(), L.TOP, _row()
            );

        MatchingEngine engine = new MatchingEngine(
            DELAY,
            WINDOW,
            BOND,
            FEE,
            params,
            ROUND,
            REST,
            IHoldByPartition(token),
            PARTITION,
            ICompliance(address(journal))
        );

        VolumeCap cap =
            new VolumeCap(regime, address(engine), CAP_BPS, L.point(L.G_EXACT, L.T_IMM));
        regime.bootstrapSupervisor(address(cap));
        engine.attachVolumeCap(cap);

        TradingHalt halt =
            new TradingHalt(regime, address(engine), MAX_HALT, HALT_BUDGET, BAND_BPS, BREAKER);
        engine.attachTradingHalt(halt);

        // --- the feed. This is the line that closes the note the previous
        //     version of this script carried: "`postMark` is a price feed's call
        //     and this venue has no oracle wired. It is the one seat here held
        //     by an address rather than by a contract."
        //
        //     Half of it is ours and half of it is not, and the split is the
        //     design. LPRC's clean price is a private instrument nobody else
        //     quotes, so a panel this venue seats is the only honest source.
        //     HBAR/USD is not, so the cash-leg seat holds somebody else's
        //     number: `HederaRateFeed` over the network's own rate at `0x168`,
        //     or whatever `CASH_FEED` names on a chain with something better.
        PrimeOracle oracle;
        {
            address[] memory panel = _publishers(me);
            oracle = new PrimeOracle(
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
        }

        // --- `me` is still the margin engine, and that seat is now the
        //     degradation rather than the mechanism: `postMark` refuses while
        //     the feed is live and opens when it goes dark.
        FinancingDeployment memory financing =
            _deployFinancing(token, me, oracle, registry, params, regime);

        // --- and the call that closes the loop. From here the bond's every
        //     balance write passes through the journal. Skipped when the token
        //     already names this journal, because `setCompliance` on an
        //     unchanged value is a transaction that buys nothing.
        if (IAtsToken(token).compliance() != address(journal)) {
            IAtsToken(token).setCompliance(address(journal));
        }

        vm.stopBroadcast();

        console2.log("journal          ", address(journal));
        console2.log("engine           ", address(engine));
        console2.log("volumeCap        ", address(cap));
        console2.log("tradingHalt      ", address(halt));
        console2.log("primeOracle      ", address(oracle));
        console2.log("  cashFeed       ", address(oracle.cashFeed()));
        console2.log("  publishers     ", oracle.publisherCount());
        console2.log("  quorum         ", oracle.quorum());
        console2.log("couponSchedule   ", address(financing.schedule));
        console2.log("  coupons        ", financing.schedule.count());
        console2.log("  spreadBps      ", financing.schedule.spreadBps());
        console2.log("  faceValue      ", financing.schedule.faceValue());
        console2.log("  firstCoupon    ", financing.schedule.dateOf(0));
        console2.log("repoVault        ", address(financing.vault));
        console2.log("marginWatch      ", address(financing.watch));
        console2.log("rulebook         ", address(financing.rulebook));
        console2.log("token.compliance ", IAtsToken(token).compliance());
        console2.log("adopted epoch    ", params.currentEpoch());
    }

    function _deployFinancing(
        address token,
        address marginEngine,
        PrimeOracle oracle,
        address registry,
        ParameterRoot params,
        Regime regime
    ) internal returns (FinancingDeployment memory out) {
        out.schedule = new CouponSchedule(
            uint64(block.timestamp),
            _couponDates(uint64(block.timestamp)),
            COUPON_SPREAD_BPS,
            FACE_VALUE,
            CouponMath.Basis.ACT_365
        );
        out.vault = new RepoVault(
            IHoldByPartition(token),
            marginEngine,
            IPrimeOracle(address(oracle)),
            ICouponSchedule(address(out.schedule)),
            IExternalKycList(registry),
            params,
            PENALTY_RATE,
            FAIL_GRACE,
            CURE_WINDOW
        );
        out.watch = new MarginWatch(out.vault);
        out.rulebook = new Rulebook(regime);
    }

    /// @dev An address from the environment, or zero when the variable is unset.
    ///      `vm.envOr` rather than `vm.envAddress` so a fresh deployment does not
    ///      have to name the things it is about to create.
    function _existing(string memory key) internal view returns (address) {
        return vm.envOr(key, address(0));
    }

    /// @dev The four numbers `docs/OUTLINE.md` 5.2 records as missing, stated
    ///      for the journal's notional row exactly as `SeamJournal.t.sol` states
    ///      them. They are fixture numbers on a live deployment too, and saying
    ///      so here is cheaper than being asked.
    function _row() internal pure returns (DisclosureBudget.Row memory) {
        return
            DisclosureBudget.Row({domainBits: 32, aggBits: 8, bucketBits: 16, budgetBits: 20});
    }

    // ------------------------------------------------------------- the panel

    /// @notice The cash leg. An override, or a fresh adapter over `0x168`.
    /// @dev See `script/DeployOracle.s.sol`, which carries the same helper and
    ///      the same reason.
    function _cashFeed() internal returns (AggregatorV3Interface) {
        address given = vm.envOr("CASH_FEED", address(0));
        if (given != address(0)) return AggregatorV3Interface(given);
        return AggregatorV3Interface(address(new HederaRateFeed()));
    }

    /// @notice Who may price the bond. `ORACLE_PUBLISHERS`, comma separated.
    /// @dev Falls back to the deployer alone, which is a one-seat panel and is
    ///      honest about being one: a median of one is that one answer, and
    ///      nothing in `PrimeOracle` pretends otherwise. The testnet deployment
    ///      seats three, which is the smallest panel where the median is doing
    ///      any work at all.
    function _publishers(address me) internal view returns (address[] memory) {
        address[] memory fallback_ = new address[](1);
        fallback_[0] = me;
        return vm.envOr("ORACLE_PUBLISHERS", ",", fallback_);
    }

    /// @notice A strict majority of the seated panel.
    /// @dev Not the whole panel. Requiring every seat to answer makes one absent
    ///      publisher a dark feed, and a feed that any single participant can
    ///      switch off is a worse feed than one that tolerates them. A strict
    ///      majority is also the bound the median's own robustness argument
    ///      needs: with `f < n/2` dishonest answers the median stays inside the
    ///      honest range.
    function _quorum(uint256 seats) internal pure returns (uint8) {
        // Safe: `PrimeOracle` refuses a panel above `maxPublishers`, a `uint8`.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8(seats / 2 + 1);
    }
}
