// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TradingHalt} from "../src/policy/TradingHalt.sol";
import {Regime} from "../src/policy/Regime.sol";
import {PolicyFixture} from "./PolicyFixture.sol";

/// @title TradingHaltTest
/// @notice The three bounds, the one function a halt may stop, and the breaker.
contract TradingHaltTest is Test, PolicyFixture {
    TradingHalt internal halt;

    address internal constant VENUE = address(0xBEEF);
    address internal constant PASSERBY = address(0xF00D);

    uint32 internal constant MAX = 1 hours;
    uint32 internal constant BUDGET = 3 hours;
    uint16 internal constant BAND = 500; // 5%
    uint32 internal constant BREAKER = 30 minutes;

    function setUp() public {
        _deployPolicy(asDeployed());
        halt = new TradingHalt(regime, VENUE, MAX, BUDGET, BAND, BREAKER);
        vm.warp(1_000_000);
    }

    function _halt(uint32 s) internal returns (uint64) {
        vm.prank(SUPERVISOR);
        return halt.halt(s, keccak256("because"));
    }

    // ------------------------------------------------- bound 1: a deadline

    /// @notice A halt ends by itself, and nothing has to be called to end it.
    /// @dev The bound that separates this from a pause key. A halt that must be
    ///      lifted is a halt whose lifting can be declined.
    function test_aHaltEndsWithoutAnyoneEndingIt() public {
        uint64 until = _halt(MAX);
        assertTrue(halt.haltedNow());
        assertEq(until, uint64(block.timestamp) + MAX);

        vm.warp(until - 1);
        assertTrue(halt.haltedNow(), "still halted one second early");

        vm.warp(until);
        assertFalse(halt.haltedNow(), "and it lifted on its own");
    }

    /// @notice There is no state a halt can be left in, over any inputs.
    function testFuzz_everyHaltLiftsWithoutACall(uint32 s, uint32 wait) public {
        s = uint32(bound(s, 1, MAX));
        wait = uint32(bound(wait, 0, 10 days));
        uint64 until = _halt(s);
        vm.warp(uint256(block.timestamp) + wait);
        assertEq(halt.haltedNow(), wait < s);
        assertEq(halt.haltedUntil(), until);
    }

    // --------------------------------------------------- bound 2: the cap

    /// @notice The supervisor cannot grant itself a longer halt than the grant.
    function test_theSupervisorCannotOutrunTheDeployedCap() public {
        vm.prank(SUPERVISOR);
        vm.expectRevert(abi.encodeWithSelector(TradingHalt.HaltTooLong.selector, MAX + 1, MAX));
        halt.halt(MAX + 1, keccak256("too long"));
    }

    /// @notice And the cap is immutable, so a longer halt is a deployment.
    function test_theCapIsNotAValueAnyoneCanMove() public {
        assertEq(halt.maxHaltSeconds(), MAX);
        // No setter exists. The assertion is the absence, so it is written as a
        // read of the deployed value plus the fact that `Regime`'s own mutators
        // reach nothing here: the halt takes the regime read-only, for
        // `supervisor()`.
        assertEq(address(halt.regime()), address(regime));
    }

    // ------------------------------------------------ bound 3: the budget

    /// @notice Unlimited maximum-length halts are an unlimited halt.
    function test_haltedTimeIsBudgetedPerEpoch() public {
        assertEq(halt.remainingBudget(), BUDGET);
        _halt(MAX);
        assertEq(halt.remainingBudget(), BUDGET - MAX);
        vm.warp(block.timestamp + MAX);
        _halt(MAX);
        vm.warp(block.timestamp + MAX);
        _halt(MAX);
        assertEq(halt.remainingBudget(), 0);

        vm.warp(block.timestamp + MAX);
        // Read the epoch before the prank: an external call consumes it.
        uint64 e = clock.currentEpoch();
        vm.prank(SUPERVISOR);
        vm.expectRevert(
            abi.encodeWithSelector(TradingHalt.BudgetExhausted.selector, e, MAX, uint32(0))
        );
        halt.halt(MAX, keccak256("one too many"));
    }

    /// @notice The budget resets per window, like every other accumulator here.
    function test_theBudgetResetsWithTheEpoch() public {
        uint64 e = clock.currentEpoch();
        _halt(MAX);
        _halt(MAX);
        _halt(MAX);
        assertEq(halt.remainingBudget(), 0);
        clock.tick();
        assertEq(halt.remainingBudget(), BUDGET, "a new window, a new budget");
        assertEq(halt.grantedIn(e), BUDGET, "and the old one still reads");
    }

    /// @notice Resuming early does not buy back the authority to halt again.
    /// @dev The budget bounds the authority and not the seconds realised. Refund
    ///      the tail and a supervisor halts, resumes, and halts again for free.
    function test_anEarlyResumeDoesNotRefundTheBudget() public {
        _halt(MAX);
        vm.prank(SUPERVISOR);
        halt.resume(keccak256("sorry"));
        assertFalse(halt.haltedNow());
        assertEq(halt.remainingBudget(), BUDGET - MAX, "spent is spent");
    }

    /// @notice Whatever the sequence, granted seconds never exceed the budget.
    function testFuzz_theEpochBudgetIsNeverExceeded(uint32[8] memory asks) public {
        uint64 e = clock.currentEpoch();
        uint256 granted;
        for (uint256 i = 0; i < asks.length; ++i) {
            uint32 s = uint32(bound(asks[i], 0, MAX + 60));
            vm.prank(SUPERVISOR);
            try halt.halt(s, bytes32(i)) {
                granted += s;
            } catch {}
            vm.warp(block.timestamp + 1);
        }
        assertEq(halt.grantedIn(e), granted);
        assertLe(granted, BUDGET);
    }

    // -------------------------------------------------------- the principal

    /// @notice The operator cannot halt. This is the JELLYJELLY point.
    function test_nobodyButTheSupervisorCanHalt() public {
        vm.prank(OPERATOR);
        vm.expectRevert(TradingHalt.NotSupervisor.selector);
        halt.halt(60, keccak256("operator"));

        vm.prank(PASSERBY);
        vm.expectRevert(TradingHalt.NotSupervisor.selector);
        halt.halt(60, keccak256("anyone"));

        vm.prank(VENUE);
        vm.expectRevert(TradingHalt.NotSupervisor.selector);
        halt.halt(60, keccak256("the venue itself"));
    }

    /// @notice Resuming is the safe direction, and it is still the supervisor's.
    /// @dev A permissionless resume would let anyone undo a halt the instant it
    ///      fired, which makes the instrument worthless. The bound that keeps a
    ///      halt from becoming a hostage is the deadline, not an open resume.
    function test_resumingIsTheSupervisorsAndTheDeadlineIsEveryones() public {
        _halt(MAX);
        vm.prank(PASSERBY);
        vm.expectRevert(TradingHalt.NotSupervisor.selector);
        halt.resume(keccak256("let me out"));

        vm.warp(block.timestamp + MAX);
        assertFalse(halt.haltedNow(), "the deadline needed nobody");
    }

    function test_resumingWhenNotHaltedIsRefused() public {
        vm.prank(SUPERVISOR);
        vm.expectRevert(TradingHalt.NotHalted.selector);
        halt.resume(keccak256("nothing to end"));
    }

    /// @notice The supervisor seat follows the regime, so a bootstrap carries.
    function test_theHaltReadsTheSeatLiveRatherThanCachingIt() public {
        Regime r2 = new Regime(
            regime.ideal(), regime.mandate(), regime.current(), address(0), OPERATOR, clock
        );
        TradingHalt h = new TradingHalt(r2, VENUE, MAX, BUDGET, BAND, BREAKER);

        vm.prank(PASSERBY);
        vm.expectRevert(TradingHalt.NotSupervisor.selector);
        h.halt(60, bytes32(0));

        r2.bootstrapSupervisor(PASSERBY);
        vm.prank(PASSERBY);
        h.halt(60, bytes32(0));
        assertTrue(h.haltedNow());
    }

    // ----------------------------------------------------------- the breaker

    /// @notice Only the venue may report a price.
    /// @dev `VolumeCap.record`'s asymmetry: an open reporter is a reporter an
    ///      adversary feeds a fake print to in order to halt a rival.
    function test_onlyTheVenueMayReportAPrice() public {
        vm.prank(PASSERBY);
        vm.expectRevert(TradingHalt.NotVenue.selector);
        halt.observe(100);
    }

    /// @notice The first price arms nothing. There is nothing to compare it to.
    function test_theFirstPriceArmsNothing() public {
        vm.prank(VENUE);
        assertFalse(halt.observe(1_000));
        assertFalse(halt.haltedNow());
        assertEq(halt.lastPriceTwice(), 1_000);
    }

    /// @notice A move inside the band does not halt; one outside it does.
    function test_theBandDecidesAndNobodyElseDoes() public {
        vm.startPrank(VENUE);
        halt.observe(1_000);
        assertFalse(halt.observe(1_050), "exactly 5% is inside a 5% band");
        assertFalse(halt.haltedNow());

        assertTrue(halt.observe(1_575), "50% is not");
        vm.stopPrank();
        assertTrue(halt.haltedNow());
        assertEq(halt.haltedUntil(), uint64(block.timestamp) + BREAKER);
    }

    /// @notice The breaker measures against the last price, either direction.
    function testFuzz_theBreakerIsSymmetric(uint128 from, uint128 to) public {
        from = uint128(bound(from, 1_000, 1e18));
        to = uint128(bound(to, 1, 1e18));
        vm.startPrank(VENUE);
        halt.observe(from);
        bool armed = halt.observe(to);
        vm.stopPrank();

        uint256 delta = to > from ? to - from : from - to;
        assertEq(armed, (delta * 10_000) / from > BAND);
    }

    /// @notice **The breaker cannot stop the round that breached it.**
    /// @dev A sealed book has no indicative price to collar, because the price
    ///      does not exist until the round clears. Stated in the header and
    ///      asserted here so it cannot quietly become false either way.
    function test_theBreachingRoundIsAlreadyDoneWhenTheBreakerFires() public {
        vm.startPrank(VENUE);
        halt.observe(1_000);
        assertFalse(halt.haltedNow(), "not halted before the breaching print");
        halt.observe(2_000);
        vm.stopPrank();
        assertTrue(halt.haltedNow(), "halted only after it");
    }

    /// @notice A breaker halt spends no budget, because nobody chose it.
    function test_theBreakerIsNotBudgeted() public {
        vm.startPrank(VENUE);
        halt.observe(1_000);
        halt.observe(5_000);
        halt.observe(1_000);
        halt.observe(5_000);
        vm.stopPrank();
        assertTrue(halt.haltedNow());
        assertEq(halt.remainingBudget(), BUDGET, "the discretion was untouched");
    }

    /// @notice Two halts in force are one halt ending at the later deadline.
    function test_haltsExtendAndNeverShorten() public {
        uint64 long_ = _halt(MAX);
        vm.startPrank(VENUE);
        halt.observe(1_000);
        halt.observe(9_000);
        vm.stopPrank();
        assertEq(halt.haltedUntil(), long_, "the shorter breaker did not cut it short");
    }

    // ----------------------------------------------------- the constructor

    function test_aBudgetBelowTheCapIsRefusedAtDeployment() public {
        vm.expectRevert(
            abi.encodeWithSelector(TradingHalt.BudgetBelowCap.selector, MAX - 1, MAX)
        );
        new TradingHalt(regime, VENUE, MAX, MAX - 1, BAND, BREAKER);
    }

    function test_aBreakerLongerThanTheCapIsRefused() public {
        vm.expectRevert(abi.encodeWithSelector(TradingHalt.HaltTooLong.selector, MAX + 1, MAX));
        new TradingHalt(regime, VENUE, MAX, BUDGET, BAND, MAX + 1);
    }

    function test_aZeroHaltIsRefused() public {
        vm.expectRevert(TradingHalt.ZeroHalt.selector);
        new TradingHalt(regime, VENUE, 0, BUDGET, BAND, BREAKER);
        vm.expectRevert(TradingHalt.ZeroHalt.selector);
        new TradingHalt(regime, VENUE, MAX, BUDGET, BAND, 0);
    }

    function test_aBandThatCannotBindIsRefused() public {
        vm.expectRevert(abi.encodeWithSelector(TradingHalt.BandNotBinding.selector, uint16(0)));
        new TradingHalt(regime, VENUE, MAX, BUDGET, 0, BREAKER);
        vm.expectRevert(
            abi.encodeWithSelector(TradingHalt.BandNotBinding.selector, uint16(10_000))
        );
        new TradingHalt(regime, VENUE, MAX, BUDGET, 10_000, BREAKER);
    }

    function test_aZeroLengthHaltIsRefusedAtCall() public {
        vm.prank(SUPERVISOR);
        vm.expectRevert(TradingHalt.ZeroHalt.selector);
        halt.halt(0, bytes32(0));
    }
}
