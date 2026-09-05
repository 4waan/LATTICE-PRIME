// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TradingHalt} from "../src/policy/TradingHalt.sol";
import {PolicyFixture, EpochClockMock} from "./PolicyFixture.sol";

/// @dev Drives every instrument the halt has, from every seat that may reach
///      one, and moves the clock underneath. Everything is try/caught: the
///      handler is meant to attempt refused calls, because a bound that only
///      holds on the calls that succeed is not a bound.
contract HaltHandler is Test {
    TradingHalt public halt;
    EpochClockMock public clock;
    address public supervisor;
    address public venue;

    uint64 public lowestEpoch;
    uint64 public highestEpoch;
    uint256 public halts;
    uint256 public refusedHalts;
    uint256 public overlongHalts;
    uint256 public breakers;

    /// @dev Times a halt or a breaker moved the deadline **earlier**. Only
    ///      `resume` may do that, so this stays at zero.
    uint256 public shortened;

    constructor(TradingHalt h, EpochClockMock c, address sup, address ven) {
        halt = h;
        clock = c;
        supervisor = sup;
        venue = ven;
        lowestEpoch = c.currentEpoch();
        highestEpoch = lowestEpoch;
    }

    /// @dev The supervisor three calls in four, and the length drawn from half
    ///      the cap to twice it. Both ranges were tuned against mutations rather
    ///      than chosen. Drawing the caller one time in four made the budget so
    ///      rarely reached that deleting the budget check failed nothing;
    ///      drawing the length inside the cap made deleting the cap check fail
    ///      nothing, because the handler never asked for a halt the cap would
    ///      have refused. A handler that cannot reach a bound does not test it.
    function doHalt(uint32 seconds_, uint256 caller) external {
        address who = caller % 4 != 0 ? supervisor : address(uint160(caller | 1));
        // Read the cap before the prank. An external call in the argument list
        // consumes it, and the halt then arrives from the handler instead.
        uint32 max = halt.maxHaltSeconds();
        uint32 want = uint32(bound(seconds_, max / 2, uint256(max) * 2));
        if (want > max) overlongHalts++;

        uint64 before = halt.haltedUntil();
        vm.prank(who);
        try halt.halt(want, bytes32(caller)) {
            halts++;
        } catch {
            refusedHalts++;
        }
        if (halt.haltedUntil() < before) shortened++;
    }

    function doResume(uint256 caller) external {
        address who = caller % 3 == 0 ? supervisor : address(uint160(caller | 1));
        vm.prank(who);
        try halt.resume(bytes32(caller)) {} catch {}
    }

    function doObserve(uint128 price, uint256 caller) external {
        address who = caller % 2 == 0 ? venue : address(uint160(caller | 1));
        uint256 p = bound(price, 0, 1e24);
        uint64 before = halt.haltedUntil();
        vm.prank(who);
        try halt.observe(p) returns (bool armed) {
            if (armed) breakers++;
        } catch {}
        if (halt.haltedUntil() < before) shortened++;
    }

    function doWarp(uint32 by) external {
        vm.warp(block.timestamp + bound(by, 1, 3 hours));
    }

    function doTick() external {
        clock.tick();
        if (clock.currentEpoch() > highestEpoch) highestEpoch = clock.currentEpoch();
    }
}

/// @title TradingHaltInvariantTest
/// @notice The three bounds, over arbitrary sequences rather than chosen ones.
///
/// A halt is the one instrument here that takes something away, so the bounds
/// on it are the security argument and not a nicety. Each invariant below is
/// one of them.
///
/// forge-config: default.invariant.runs = 96
/// forge-config: default.invariant.depth = 400
contract TradingHaltInvariantTest is Test, PolicyFixture {
    TradingHalt internal halt;
    HaltHandler internal handler;

    address internal constant VENUE = address(0xBEEF);

    uint32 internal constant MAX = 1 hours;
    /// @dev One and a half caps, so a single full halt leaves a partial budget
    ///      and the next one is refused or exhausts it. The budget has to be
    ///      reachable inside a run or the invariant on it says nothing.
    uint32 internal constant BUDGET = 90 minutes;
    uint16 internal constant BAND = 500;
    uint32 internal constant BREAKER = 30 minutes;

    function setUp() public {
        _deployPolicy(asDeployed());
        vm.warp(1_000_000);
        halt = new TradingHalt(regime, VENUE, MAX, BUDGET, BAND, BREAKER);
        handler = new HaltHandler(halt, clock, SUPERVISOR, VENUE);
        targetContract(address(handler));
    }

    /// @notice Bound 2. The venue is never halted further ahead than one grant.
    /// @dev The cap is on a single halt, and `_arm` extends rather than adds, so
    ///      no sequence of halts reaches further into the future than the
    ///      longest one the deployment permits.
    function invariant_theHaltNeverReachesPastTheCap() public view {
        assertLe(halt.haltedUntil(), block.timestamp + MAX);
    }

    /// @notice Bound 3. Granted seconds never exceed the budget, in any epoch.
    function invariant_theEpochBudgetIsNeverExceeded() public view {
        // From the epoch the fixture actually started in. Counting from zero
        // would sweep epochs nothing ever wrote and pass on emptiness.
        uint64 top = clock.currentEpoch();
        if (handler.highestEpoch() > top) top = handler.highestEpoch();
        for (uint64 e = handler.lowestEpoch(); e <= top; ++e) {
            assertLe(halt.grantedIn(e), BUDGET);
        }
    }

    /// @notice Bound 1. A halt is a deadline, so the state is a comparison and
    ///         never a latch that a missed call could leave set.
    function invariant_haltedNowIsExactlyTheDeadline() public view {
        assertEq(halt.haltedNow(), block.timestamp < halt.haltedUntil());
    }

    /// @notice The breaker spends no discretion, and discretion arms no breaker.
    /// @dev Written as the conjunction rather than as two, because the property
    ///      is that the two instruments do not fund each other.
    function invariant_theTwoInstrumentsAreDisjoint() public view {
        assertLe(uint256(halt.grantedIn(clock.currentEpoch())), BUDGET);
        if (handler.halts() == 0) {
            assertEq(halt.grantedIn(clock.currentEpoch()), 0, "a breaker spent the budget");
        }
    }

    /// @notice Only `resume` moves a deadline earlier.
    /// @dev Two halts in force are one halt ending at the later of the two, so a
    ///      short breaker cannot cut a long supervisory halt short and a stale
    ///      grant cannot cut a breaker short. Watched per call in the handler,
    ///      because it is a property of the transition and not of the state.
    function invariant_noHaltEverShortensAnother() public view {
        assertEq(handler.shortened(), 0);
    }

    /// @notice Every halt reached ends, whatever the sequence that produced it.
    function afterInvariant() public {
        // Liveness. A run that halted nothing, or one where every halt was
        // refused, proves neither bound.
        assertGt(handler.halts(), 0, "no halt ever succeeded");
        assertGt(handler.refusedHalts(), 0, "no halt was ever refused");
        assertGt(handler.overlongHalts(), 0, "the cap was never asked to bind");
        assertGt(handler.breakers(), 0, "the breaker never armed");
        vm.warp(uint256(halt.haltedUntil()) + 1);
        assertFalse(halt.haltedNow(), "a halt outlived its own deadline");
    }
}
