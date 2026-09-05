// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {EpochClock} from "../src/policy/EpochClock.sol";
import {Regime} from "../src/policy/Regime.sol";
import {ParameterRoot} from "../src/policy/ParameterRoot.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {PolicySets} from "./PolicySets.sol";

/// @title DeployPolicy
/// @notice Stage one of the venue: the clock, the regime, the parameter root,
///         and a proposal that cannot be adopted yet.
///
/// This is a separate script from `DeployVenue` for a reason the contracts
/// impose rather than one of convenience. `ParameterRoot.propose` writes
/// `pendingEpoch = currentEpoch() + 1` and `adopt` refuses before it. In the
/// suite an `EpochClockMock` is ticked between the two calls inside one
/// function. On a live chain the only thing that advances the clock is time, so
/// the two calls cannot sit in one broadcast, and pretending otherwise would
/// mean either a clock the operator can wind or a governance delay that is not
/// a delay.
///
/// So: run this, wait one epoch, run `DeployVenue`. The wait is the guarantee.
///
/// ## The three constructor arguments to `Regime`, and why they are not defaults
///
/// `ideal = L.TOP` is the waiver this venue holds: it may be fully transparent.
/// `mandate = L.BOTTOM` is a stated limit and not an absence of one, because the
/// seventeen per-row obligations have not been derived from the regulation and
/// `who-gets-privacy.md` DP-01 refuses a published constant with no derivation
/// behind it. `initial = L.TOP` starts the venue at its ceiling. All three
/// match `PolicyFixture._deployPolicy`, which is what the 402-test suite runs
/// against, so the deployed regime is the tested regime.
///
/// The supervisor seat is left vacant on purpose. `VolumeCap` does not exist
/// yet, it takes the engine which does not exist yet, and **the cap contract is
/// the supervisor**: suspension is arithmetic rather than a person.
/// `DeployVenue` fills the seat once the cap can verify it belongs to this
/// venue.
contract DeployPolicy is Script {
    /// @dev Five minutes. A governance cooling-off period, an Article 5 volume
    ///      window, and a disclosure budget window, all at once, because
    ///      `Regime`, `VolumeCap` and `TradingHalt` share one clock.
    ///
    ///      A production venue would count in days. Five minutes is chosen so
    ///      the propose-then-adopt separation is *observable* inside a working
    ///      session rather than notional, and the honest cost of that is
    ///      recorded in `EpochClock`'s class comment: a short epoch shortens the
    ///      worst-case wait, it does not weaken the rule that a proposal cannot
    ///      land in the epoch it was made in.
    uint64 internal constant EPOCH_LEN = 300;

    function run() external {
        uint256 pk = vm.envUint("HEDERA_PRIVATE_KEY");
        address me = vm.addr(pk);

        ParameterRoot.Param[] memory set = PolicySets.asDeployed();

        // Reused when `VENUE_CLOCK` is set. The clock is a pure function of two
        // immutables and depends on nothing downstream of it, so redeploying the
        // regime does not oblige a new one, and keeping it means the epoch
        // numbering the venue has already published does not restart.
        address existingClock = vm.envOr("VENUE_CLOCK", address(0));

        vm.startBroadcast(pk);
        EpochClock clock = existingClock != address(0)
            ? EpochClock(existingClock)
            : new EpochClock(uint64(block.timestamp), EPOCH_LEN);
        // `me` is the operator. It is not the supervisor and cannot become one:
        // `bootstrapSupervisor` is single-use and `DeployVenue` spends it on the
        // cap.
        Regime regime = new Regime(L.TOP, L.BOTTOM, L.TOP, address(0), me, clock);
        ParameterRoot params = new ParameterRoot(regime);
        // `rootOf` is a call on `params`, so it is inside the broadcast and
        // costs a transaction's worth of nothing: it is `view`, and forge does
        // not broadcast a staticcall.
        bytes32 root = params.rootOf(set);
        params.propose(root, "PolicySets.asDeployed");
        vm.stopBroadcast();

        console2.log("clock            ", address(clock));
        console2.log("regime           ", address(regime));
        console2.log("params           ", address(params));
        console2.log("epochZero        ", clock.epochZero());
        console2.log("epochLength      ", clock.epochLength());
        console2.log("proposed root    ", vm.toString(root));
        console2.log("adoptable at     ", clock.startOf(clock.currentEpoch() + 1));
        console2.log("rows in the set  ", set.length);
    }
}
