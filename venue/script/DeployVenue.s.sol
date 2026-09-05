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
import {MarginWatch} from "../src/observatory/MarginWatch.sol";
import {Rulebook} from "../src/observatory/Rulebook.sol";
import {SeamJournal} from "../src/observatory/SeamJournal.sol";
import {DisclosureBudget} from "../src/lattice/DisclosureBudget.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {IHoldByPartition} from "../src/interfaces/IHoldByPartition.sol";
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

    function run() external {
        uint256 pk = vm.envUint("HEDERA_PRIVATE_KEY");
        address me = vm.addr(pk);

        EpochClock clock = EpochClock(vm.envAddress("VENUE_CLOCK"));
        Regime regime = Regime(vm.envAddress("VENUE_REGIME"));
        ParameterRoot params = ParameterRoot(vm.envAddress("VENUE_PARAMS"));
        address token = vm.envAddress("ATS_TOKEN");
        address registry = vm.envAddress("ZK_KYC_REGISTRY");

        ParameterRoot.Param[] memory set = PolicySets.asDeployed();

        vm.startBroadcast(pk);

        // --- the epoch has passed, so the commitment opens. Permissionless by
        //     design: if only the operator could open its own commitment the
        //     timing of adoption would be a second discretionary signal.
        params.adopt(set);

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
                me,
                token,
                registry,
                clock.epochZero(),
                clock.epochLength(),
                L.TOP,
                _row()
            );

        MatchingEngine engine = new MatchingEngine(
            DELAY, WINDOW, BOND, FEE, params, ROUND, REST,
            IHoldByPartition(token), PARTITION, ICompliance(address(journal))
        );

        VolumeCap cap = new VolumeCap(
            regime, address(engine), CAP_BPS, L.point(L.G_EXACT, L.T_IMM)
        );
        regime.bootstrapSupervisor(address(cap));
        engine.attachVolumeCap(cap);

        TradingHalt halt = new TradingHalt(
            regime, address(engine), MAX_HALT, HALT_BUDGET, BAND_BPS, BREAKER
        );
        engine.attachTradingHalt(halt);

        // --- `me` is the margin engine: `postMark` is a price feed's call and
        //     this venue has no oracle wired. It is the one seat here held by an
        //     address rather than by a contract, and it is named so in the
        //     record rather than left to be discovered.
        RepoVault vault = new RepoVault(
            IHoldByPartition(token), me, params, PENALTY_RATE, FAIL_GRACE
        );
        MarginWatch watch = new MarginWatch(vault);
        Rulebook rulebook = new Rulebook(regime);

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
        console2.log("repoVault        ", address(vault));
        console2.log("marginWatch      ", address(watch));
        console2.log("rulebook         ", address(rulebook));
        console2.log("token.compliance ", IAtsToken(token).compliance());
        console2.log("adopted epoch    ", params.currentEpoch());
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
        return DisclosureBudget.Row({
            domainBits: 32, aggBits: 8, bucketBits: 16, budgetBits: 20
        });
    }
}
