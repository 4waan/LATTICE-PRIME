// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EpochClock} from "../src/policy/EpochClock.sol";
import {Regime, IEpochClock} from "../src/policy/Regime.sol";
import {ParameterRoot} from "../src/policy/ParameterRoot.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";

/// @title EpochClockTest
/// @notice The clock the deployed venue counts in, and the one property the
///         governed contracts actually rest on.
///
/// The suite's other clocks tick by hand, which is why this file exists: it is
/// the only place where "an epoch passed" and "time passed" are the same claim,
/// so it is the only place the wall-clock arithmetic is under test.
contract EpochClockTest is Test {
    uint64 internal constant ZERO = 1_700_000_000;
    uint64 internal constant LEN = 300;

    EpochClock internal clock;

    function setUp() public {
        clock = new EpochClock(ZERO, LEN);
    }

    function test_zeroLengthIsRefused() public {
        vm.expectRevert(EpochClock.ZeroEpochLength.selector);
        new EpochClock(ZERO, 0);
    }

    function test_beforeEpochZeroIsZeroAndNotARevert() public view {
        assertEq(clock.epochAt(0), 0);
        assertEq(clock.epochAt(ZERO - 1), 0, "the second before zero is still epoch zero");
    }

    function test_theFirstSecondOfEpochZero() public view {
        assertEq(clock.epochAt(ZERO), 0);
        assertEq(clock.epochAt(ZERO + LEN - 1), 0, "the last second of epoch zero");
        assertEq(clock.epochAt(ZERO + LEN), 1, "and the first of epoch one");
    }

    function test_currentEpochFollowsTheBlock() public {
        vm.warp(ZERO + 7 * LEN);
        assertEq(clock.currentEpoch(), 7);
        vm.warp(ZERO + 8 * LEN - 1);
        assertEq(clock.currentEpoch(), 7, "still, one second short");
        vm.warp(ZERO + 8 * LEN);
        assertEq(clock.currentEpoch(), 8);
    }

    function test_startOfInvertsEpochAt() public view {
        for (uint64 e = 0; e < 20; ++e) {
            assertEq(clock.epochAt(clock.startOf(e)), e, "startOf lands inside its own epoch");
        }
    }

    /// @dev The clock is total by construction, so the fuzzer is asking whether
    ///      any timestamp reverts rather than whether a particular one is right.
    function testFuzz_neverReverts(uint256 ts) public view {
        clock.epochAt(ts);
    }

    function testFuzz_monotonic(uint64 a, uint64 b) public view {
        if (a > b) (a, b) = (b, a);
        assertLe(clock.epochAt(a), clock.epochAt(b));
    }

    // ------------------------------------------------- the governed property

    /// @notice The one thing `Regime` and `ParameterRoot` rest on: a proposal
    ///         cannot be adopted in the epoch it was made in.
    /// @dev Worth stating against the real clock rather than the mock, because
    ///      it is the claim a short deployment epoch is accused of weakening.
    ///      It does not weaken it. It shortens the worst case wait and leaves
    ///      the separation intact.
    function test_adoptionCannotHappenInTheProposingEpoch() public {
        vm.warp(ZERO + 100 * LEN);
        address operator = address(0x09E);

        Regime regime = new Regime(L.TOP, L.BOTTOM, L.TOP, address(0), operator, clock);
        ParameterRoot params = new ParameterRoot(regime);

        ParameterRoot.Param[] memory set = new ParameterRoot.Param[](1);
        set[0] = ParameterRoot.Param(bytes32(uint256(3)), L.point(L.G_EXACT, L.T_IMM));
        bytes32 r = params.rootOf(set);

        vm.prank(operator);
        params.propose(r, "clock test");

        // Same epoch, one second later. Refused.
        vm.warp(block.timestamp + 1);
        vm.expectRevert();
        params.adopt(set);

        // The next epoch. Accepted.
        vm.warp(ZERO + 101 * LEN);
        params.adopt(set);
        assertEq(params.currentEpoch(), 101);
    }

    /// @notice And the edge the doc comment admits to: proposing in an epoch's
    ///         last second makes the wait one second long.
    function test_aProposalAtTheEdgeWaitsOneSecond() public {
        vm.warp(ZERO + 101 * LEN - 1);
        address operator = address(0x09E);

        Regime regime = new Regime(L.TOP, L.BOTTOM, L.TOP, address(0), operator, clock);
        ParameterRoot params = new ParameterRoot(regime);

        ParameterRoot.Param[] memory set = new ParameterRoot.Param[](1);
        set[0] = ParameterRoot.Param(bytes32(uint256(3)), L.point(L.G_EXACT, L.T_IMM));
        bytes32 r = params.rootOf(set);

        vm.prank(operator);
        params.propose(r, "edge");

        vm.warp(block.timestamp + 1);
        params.adopt(set);
        assertEq(params.currentEpoch(), 101, "one second of wall clock, one epoch of separation");
    }
}
