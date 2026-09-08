// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {MarginWatch} from "../src/observatory/MarginWatch.sol";
import {RepoVault} from "../src/repo/RepoVault.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {PolicyFixture} from "./PolicyFixture.sol";
import {CouponFixture} from "./CouponFixture.sol";
import {StubOracle} from "./OracleFixture.sol";
import {MockHolds} from "./AtsHolds.sol";
import {RepoFunding} from "./RepoFunding.sol";

/// @notice One claim: the alert survives the silence. `Repo.t.sol` covers the
///         transitions, so nothing here re-tests one.
contract MarginWatchTest is Test, PolicyFixture, CouponFixture, RepoFunding {
    /// @dev Dark by default, which is the venue this suite was written against:
    ///      `postMark` is reachable and `markToMarket` is not. See `OracleFixture`.
    StubOracle internal feed;

    /// @dev `markToMarket` raises a call with a published window rather than a
    ///      caller-chosen one, because it is permissionless. `postMark` still
    ///      takes its own, so nothing below had to change.
    uint64 internal constant CURE_WINDOW = 1 days;

    uint256 internal constant PENALTY_RATE = 10;
    uint64 internal constant FAIL_GRACE = 5 days;

    MockHolds holds;
    RepoVault vault;
    MarginWatch watcher;

    address constant BORROWER = address(0xB0B);
    address constant LENDER = address(0x1EAD);
    address constant ENGINE = address(0xE49);
    bytes32 constant ID = keccak256("repo-1");
    bytes32 constant ID2 = keccak256("repo-2");
    bytes32 constant ID3 = keccak256("repo-3");
    bytes32 constant PARTITION = bytes32(uint256(1));

    bytes32 constant MARGIN_CALLED = keccak256("MarginCalled(bytes32,uint64)");
    bytes32 constant MARK_POSTED = keccak256("MarkPosted(bytes32,bytes32)");

    function setUp() public {
        feed = new StubOracle();
        holds = new MockHolds();
        _deployPolicy(asDeployed());
        vault = new RepoVault(
            holds,
            ENGINE,
            feed,
            _deploySchedule(uint64(block.timestamp)),
            _newKycList(),
            params,
            PENALTY_RATE,
            FAIL_GRACE,
            CURE_WINDOW
        );
        watcher = new MarginWatch(vault);
    }

    function _open(bytes32 id) internal {
        _openRepo(
            vault,
            feed,
            LENDER,
            BORROWER,
            id,
            RepoVault.Terms({
                partition: PARTITION,
                collateralAmount: 1_000e8,
                haircutBps: 200,
                maintenanceBps: 200,
                repoRateBps: 450,
                term: 30 days
            })
        );
    }

    function _call(bytes32 id) internal {
        vm.prank(ENGINE);
        vault.postMark(id, keccak256("mark"), true, 1 days);
    }

    /// @dev `withBudgets` allows three margin disclosures an epoch. Call, cure, call
    ///      spends all three and leaves the position called.
    function _spendToTheBrim(bytes32 id) internal {
        _call(id);
        _cureCovered(vault, feed, BORROWER, id);
        _call(id);
        assertEq(vault.spentBits(14, params.currentEpoch()), 3, "at the bound");
    }

    function _countTopic(Vm.Log[] memory logs, bytes32 sig) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length != 0 && logs[i].topics[0] == sig) ++n;
        }
    }

    function test_aWithheldMarginCallIsStillReported() public {
        _publish(withBudgets());
        _open(ID);
        _spendToTheBrim(ID);

        _cureCovered(vault, feed, BORROWER, ID); // the fourth disclosure, withheld
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.OPEN), "cured, quietly");

        vm.recordLogs();
        _call(ID);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(_countTopic(logs, MARGIN_CALLED), 0, "the log says nothing");
        assertEq(
            uint8(vault.stateOf(ID)),
            uint8(RepoVault.State.MARGIN_CALL),
            "the position is called regardless"
        );

        MarginWatch.Alert memory a = watcher.alertOf(ID);
        assertTrue(a.called, "and the watcher says so");
        assertEq(a.cureDeadline, block.timestamp + 1 days, "with the borrower's clock");
        assertFalse(a.cureExpired);
    }

    /// `postMark` discloses twice and only the margin half is metered, so an observer sees
    /// that a mark was posted and not that it breached.
    function test_theCadenceEventSurvivesWhileThePositionEventIsWithheld() public {
        _publish(withBudgets());
        _open(ID);
        _spendToTheBrim(ID);
        _cureCovered(vault, feed, BORROWER, ID);

        vm.recordLogs();
        _call(ID);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(_countTopic(logs, MARK_POSTED), 1, "unmetered, still speaks");
        assertEq(_countTopic(logs, MARGIN_CALLED), 0, "spent, does not");
    }

    function test_theStreamGoesInaudibleBeforeACallIsLost() public {
        _publish(withBudgets());
        _open(ID);

        MarginWatch.Stream memory s = watcher.stream();
        assertTrue(s.metered);
        assertEq(s.budgetBits, 3);
        assertEq(s.breakingSize, 4, "the fourth call is the one withheld");
        assertTrue(s.audible, "nothing spent yet");
        assertTrue(s.permitted);

        _spendToTheBrim(ID);

        s = watcher.stream();
        assertEq(s.spentBits, 3);
        assertFalse(s.audible, "the next call is withheld");
        assertTrue(s.permitted, "withheld rather than refused: no revert coming");
    }

    /// What the demo runs on, and it is the deployed set rather than a fixture.
    ///
    /// **This test used to assert the opposite.** The deployed parameter set
    /// published ten ceilings and no budget, so `metered` was false, `spentBits`
    /// was zero for every row and every epoch, `breakingSize` was zero and
    /// `audible` was permanently true. Three of the five getters a receipt is
    /// built on were constants and this suite recorded that as expected. The set
    /// now publishes a derived budget on row 14, so the stream reading carries
    /// information on the venue that is actually deployed, and the exposure is
    /// present rather than one adoption away.
    ///
    /// `domainBits` is 3, the cardinality of `RepoVault.State`, and `budgetBits`
    /// is 2, so the third position disclosure of an epoch is the one withheld.
    /// The funded offer is first, the margin call is second, and cure is the
    /// first state transition whose venue event is withheld.
    function test_underTheDeployedSetTheThirdCallIsWithheld() public {
        _open(ID);

        MarginWatch.Stream memory s = watcher.stream();
        assertTrue(s.metered, "a ceiling and a budget");
        assertEq(s.budgetBits, 2, "domainBits 3, so the largest binding bound is 2");
        assertEq(s.breakingSize, 3, "the third call is the one withheld");
        assertEq(s.spentBits, 1, "the funded offer used the first bit");
        assertTrue(s.audible, "the margin call still fits");

        vm.recordLogs();
        _call(ID);
        assertEq(_countTopic(vm.getRecordedLogs(), MARGIN_CALLED), 1, "the event fires");
        assertTrue(watcher.alertOf(ID).called, "and agrees with the watcher");
        assertEq(watcher.stream().spentBits, 2, "the margin call used the second bit");

        _cureCovered(vault, feed, BORROWER, ID); // the third publication is withheld

        s = watcher.stream();
        assertEq(s.spentBits, 2);
        assertFalse(s.audible, "the next call succeeds in silence");
        assertTrue(s.permitted, "withheld rather than refused: no revert coming");

        // Rule A, on the deployed venue rather than in a fixture: the position
        // moves and the log says nothing.
        vm.recordLogs();
        _call(ID);
        assertEq(_countTopic(vm.getRecordedLogs(), MARGIN_CALLED), 0, "withheld");
        assertEq(
            uint8(vault.stateOf(ID)),
            uint8(RepoVault.State.MARGIN_CALL),
            "and the position is called regardless"
        );
        assertTrue(watcher.alertOf(ID).called, "which is what MarginWatch is for");
    }

    /// No event to miss because there is no event at all, under any budget.
    function test_anUnmarkedFailIsAnAlertNoEventCanCarry() public {
        _open(ID);
        assertFalse(watcher.alertOf(ID).unmarkedFail, "inside its term");

        vm.warp(block.timestamp + 30 days);

        MarginWatch.Alert memory a = watcher.alertOf(ID);
        assertEq(uint8(a.state), uint8(RepoVault.State.OPEN), "nobody has marked it");
        assertTrue(a.unmarkedFail);

        vault.markFailing(ID);
        a = watcher.alertOf(ID);
        assertEq(uint8(a.state), uint8(RepoVault.State.FAILING));
        assertFalse(a.unmarkedFail);
    }

    function test_anUnknownPositionIsNotAFail() public view {
        MarginWatch.Alert memory a = watcher.alertOf(keccak256("never opened"));
        assertEq(uint8(a.state), uint8(RepoVault.State.NONE));
        assertFalse(a.unmarkedFail, "absent is not overdue");
        assertFalse(a.called);
        assertFalse(a.defaultable);
    }

    /// `declareDefault` reads a different clock from each state, so assert the flag
    /// against the call itself.
    function test_defaultableTracksTheCureClock() public {
        _open(ID);
        _call(ID);
        assertFalse(watcher.alertOf(ID).defaultable, "the cure window is open");

        vm.warp(block.timestamp + 1 days);

        MarginWatch.Alert memory a = watcher.alertOf(ID);
        assertTrue(a.cureExpired);
        assertTrue(a.defaultable);

        vault.declareDefault(ID);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.DEFAULTED), "and it takes");
    }

    function test_defaultableTracksTheFailGraceClock() public {
        _open(ID);
        vm.warp(block.timestamp + 30 days);
        vault.markFailing(ID);
        assertFalse(watcher.alertOf(ID).defaultable, "grace is running");

        vm.warp(block.timestamp + FAIL_GRACE);
        assertTrue(watcher.alertOf(ID).defaultable);
        vault.declareDefault(ID);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.DEFAULTED));
    }

    function test_calledAmongIsTheReconciliationPrimitive() public {
        _open(ID);
        _open(ID2);
        _open(ID3);
        _call(ID);
        _call(ID3);

        bytes32[] memory ids = new bytes32[](3);
        ids[0] = ID;
        ids[1] = ID2;
        ids[2] = ID3;

        bytes32[] memory called = watcher.calledAmong(ids);
        assertEq(called.length, 2, "two of the three");
        assertEq(called[0], ID, "in the order asked");
        assertEq(called[1], ID3);
    }

    function test_watchReturnsTheBookTheStreamAndTheFeedTogether() public {
        _publish(withBudgets());
        _open(ID);
        _open(ID2);
        _spendToTheBrim(ID);

        bytes32[] memory ids = new bytes32[](2);
        ids[0] = ID;
        ids[1] = ID2;

        (
            MarginWatch.Alert[] memory alerts,
            MarginWatch.Stream memory s,
            MarginWatch.Feed memory f
        ) = watcher.watch(ids);
        assertEq(alerts.length, 2);
        assertTrue(alerts[0].called);
        assertFalse(alerts[1].called);
        assertFalse(s.audible, "and the reading that says the next one is silent");
        // The third reading, and the one this suite's stub makes easy to state:
        // a dark feed is why `postMark` raised those calls at all.
        assertTrue(f.dark, "the fixture's feed is dark, so the manual seat is open");
        assertEq(f.oracle, address(feed));
    }

    /// Cannot fail today, since the watcher is a view. Here to fail on the edit that adds
    /// an event, which would publish the predicate without passing the vault's meter.
    function test_watchingSpendsNothingAndEmitsNothing() public {
        _publish(withBudgets());
        _open(ID);
        _call(ID);

        uint64 e = params.currentEpoch();
        uint32 before = vault.spentBits(14, e);

        bytes32[] memory ids = new bytes32[](1);
        ids[0] = ID;

        vm.recordLogs();
        watcher.watch(ids);
        watcher.calledAmong(ids);
        watcher.alertsOf(ids);
        watcher.stream();

        assertEq(vm.getRecordedLogs().length, 0, "says nothing to anybody");
        assertEq(vault.spentBits(14, e), before, "and spends nothing to do it");
    }
}
