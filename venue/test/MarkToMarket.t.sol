// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {RepoVault} from "../src/repo/RepoVault.sol";
import {RepoVaultBase} from "../src/repo/RepoVaultBase.sol";
import {RepoMath} from "../src/repo/RepoMath.sol";
import {PrimeOracle} from "../src/oracle/PrimeOracle.sol";
import {IPrimeOracle} from "../src/interfaces/IPrimeOracle.sol";
import {ICouponSchedule} from "../src/interfaces/ICouponSchedule.sol";
import {IExternalKycList} from "../src/interfaces/IExternalKycList.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {MockHolds} from "./AtsHolds.sol";
import {RepoFunding} from "./RepoFunding.sol";
import {MockAggregator} from "./OracleFixture.sol";
import {PolicyFixture} from "./PolicyFixture.sol";
import {CouponFixture} from "./CouponFixture.sol";

/// @title MarkToMarketTest
/// @notice The seam between the feed and the repo book, from the vault's side.
///
/// `RepoVault.postMark` used to be the only way a mark reached this venue, and
/// `script/DeployVenue.s.sol` said so in a comment: "`postMark` is a price
/// feed's call and this venue has no oracle wired. It is the one seat here held
/// by an address rather than by a contract." Every test below is one half of
/// closing that.
///
/// The numbers are the deployed instrument's. The lot is a thousand units of a
/// bond with a nominal value of 100.00 USD, the clean price starts at par, and
/// the cash leg is HBAR/USD at 0.08152235, which is what
/// `probes/chainlink-hedera.out` read off chain 296. Nothing here is a round
/// number chosen to make the arithmetic tidy.
contract MarkToMarketTest is Test, PolicyFixture, CouponFixture, RepoFunding {
    RepoVault internal vault;
    PrimeOracle internal oracle;
    MockAggregator internal cash;
    MockHolds internal holds;
    IExternalKycList internal eligibility;

    address internal constant BORROWER = address(0xB0B);
    address internal constant LENDER = address(0x1EAD);
    address internal constant ENGINE = address(0xE49);
    address internal constant PASSERBY = address(0xF00D);
    address internal constant ADMIN = address(0xAD1);
    address internal constant P1 = address(0xB1CE);
    address internal constant P2 = address(0xB2CE);

    bytes32 internal constant ID = keccak256("repo-feed-1");
    bytes32 internal constant PARTITION = bytes32(uint256(1));

    uint256 internal constant LOT = 1_000;
    uint128 internal constant PAR = 100_00000000;
    int256 internal constant HBAR_USD = 8_152_235;
    uint64 internal constant COUPON_BPS = 425;

    uint16 internal constant HAIRCUT_BPS = 500;
    uint16 internal constant MAINTENANCE_BPS = 200;
    uint256 internal constant REPO_RATE_BPS = 450;

    uint256 internal constant PENALTY_RATE = 10;
    uint64 internal constant FAIL_GRACE = 5 days;
    uint64 internal constant CURE_WINDOW = 1 days;
    uint64 internal constant HEARTBEAT = 6 hours;
    uint64 internal constant CASH_HEARTBEAT = 26 hours;
    uint16 internal constant MAX_DEVIATION_BPS = 500;

    function setUp() public {
        vm.warp(1_000_000);
        _deployPolicy(asDeployed());
        holds = new MockHolds();
        eligibility = _newKycList();
        cash = new MockAggregator(HBAR_USD, block.timestamp);

        address[] memory panel = new address[](2);
        panel[0] = P1;
        panel[1] = P2;
        oracle = new PrimeOracle(
            params,
            ADMIN,
            AggregatorV3Interface(address(cash)),
            panel,
            2,
            7,
            HEARTBEAT,
            CASH_HEARTBEAT,
            MAX_DEVIATION_BPS
        );
        vault = new RepoVault(
            holds,
            ENGINE,
            IPrimeOracle(address(oracle)),
            _deploySchedule(uint64(block.timestamp)),
            eligibility,
            params,
            PENALTY_RATE,
            FAIL_GRACE,
            CURE_WINDOW
        );
        _publishPrice(PAR);
    }

    function _publishPrice(uint128 price) internal {
        uint64 r = oracle.openRound();
        vm.prank(P1);
        oracle.submit(r, price, COUPON_BPS);
        vm.prank(P2);
        oracle.submit(r, price, COUPON_BPS);
        oracle.finalize(r);
        // Keep the upstream leg live alongside ours; this suite is about the
        // vault, and `PrimeOracleTest` is where the cash leg's failures live.
        cash.set(HBAR_USD, block.timestamp);
    }

    /// @dev Opened at whatever the feed says right now, so the repo's own
    ///      `markValue` is the feed's number rather than a literal that would
    ///      drift from it the first time either changed.
    function _open() internal returns (uint256 principal) {
        // Read the feed *before* arming the prank. `markPerUnitTinybar` is an
        // external call and would otherwise consume it, leaving the repo owned
        // by this test contract rather than by the borrower, which is a bug that
        // hides until a test asserts on who may close. `PolicyFixture._publish`
        // carries the same note about `rootOf`; this is the second time the trap
        // has cost a debugging cycle in this repository.
        uint256 markValue = oracle.markPerUnitTinybar() * LOT;
        principal = RepoMath.purchasePrice(markValue, HAIRCUT_BPS);
        vm.deal(LENDER, principal);
        vm.prank(LENDER);
        vault.fundOffer{value: principal}(
            ID,
            BORROWER,
            RepoVault.Terms({
                partition: PARTITION,
                collateralAmount: LOT,
                haircutBps: HAIRCUT_BPS,
                maintenanceBps: MAINTENANCE_BPS,
                repoRateBps: REPO_RATE_BPS,
                term: 30 days
            }),
            uint64(block.timestamp + 7 days)
        );
        holds.mint(PARTITION, BORROWER, LOT);
        vm.prank(BORROWER);
        holds.approve(address(vault), LOT);
        vm.prank(BORROWER);
        vault.accept(ID);
    }

    /// @dev A price `bps` below par, within one round of the deviation cap.
    function _drop(uint16 bps) internal {
        _publishPrice(uint128(uint256(PAR) - (uint256(PAR) * bps) / 10_000));
    }

    // ------------------------------------------- 1. the feed calls the margin

    /// @notice The call the margin engine used to make, made by the feed.
    function test_theFeedCallsMarginAndTheEngineNoLongerHasTo() public {
        _open();
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.OPEN));

        _drop(MAX_DEVIATION_BPS);

        vm.prank(PASSERBY);
        bool breach = vault.markToMarket(ID);

        assertTrue(breach, "a five percent fall is short of the maintenance margin");
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.MARGIN_CALL));
        assertEq(
            vault.repo(ID).cureDeadline,
            uint64(block.timestamp) + CURE_WINDOW,
            "the published window, not one the caller chose"
        );
    }

    function test_aNarrowedPublicationCeilingCannotBlockAMarginCall() public {
        _open();
        _drop(MAX_DEVIATION_BPS);
        vm.prank(SUPERVISOR);
        regime.narrow(L.point(L.G_PRED, L.T_EOD), "defer margin events");

        vm.recordLogs();
        vm.prank(PASSERBY);
        bool breach = vault.markToMarket(ID);

        assertTrue(breach);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.MARGIN_CALL));
        assertEq(vm.getRecordedLogs().length, 0, "risk moves while venue speech is withheld");
    }

    /// @notice A mark that does not breach changes nothing and says nothing.
    /// @dev Both halves matter. The state is unmoved, and **the event stream is
    ///      empty**, which is what makes a permissionless mark safe to leave
    ///      open: an observer watching the chain learns nothing from the fact
    ///      that somebody looked.
    function test_aMarkThatDoesNotBreachChangesNothingAndSaysNothing() public {
        _open();
        _drop(100); // one percent, inside the maintenance margin

        vm.recordLogs();
        vm.prank(PASSERBY);
        bool breach = vault.markToMarket(ID);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertFalse(breach);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.OPEN));
        assertEq(logs.length, 0, "a mark that decided nothing discloses nothing");
    }

    /// @notice The mark is computed in memory and never written.
    /// @dev The second problem the first one hid. `markCommitment` was
    ///      justified by row 14 while `repo(id)` returned `collateralAmount` in
    ///      the clear two fields down, so a commitment to `price x lot` was two
    ///      public reads from its own preimage. This is the actual answer: the
    ///      number is not written anywhere.
    function test_theMarkIsNeverStored() public {
        _open();
        _drop(MAX_DEVIATION_BPS);
        vault.markToMarket(ID);

        assertEq(vault.repo(ID).markCommitment, bytes32(0), "nothing was written");
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.MARGIN_CALL));
    }

    /// @notice Marking carries no cadence, because its timing is not the venue's.
    /// @dev `postMark` charges row 16 and says why: the engine marks daily, so
    ///      the sequence of `MarkPosted` events is a fingerprint the matrix
    ///      carries as an open limit. Nothing here emits on row 16, because
    ///      anyone may call this at any time against a price the feed already
    ///      published. The old path is exercised beside it so the difference is
    ///      the assertion rather than the description.
    function test_markingIsPermissionlessAndItsTimingIsNotTheVenues() public {
        _open();
        _drop(100);

        vm.recordLogs();
        vm.prank(PASSERBY);
        vault.markToMarket(ID);
        assertEq(vm.getRecordedLogs().length, 0, "no cadence on the feed path");

        vm.warp(block.timestamp + HEARTBEAT + 1);
        vm.recordLogs();
        vm.prank(ENGINE);
        vault.postMark(ID, keccak256("mark"), false, 1 days);
        assertEq(vm.getRecordedLogs().length, 1, "one MarkPosted on the discretionary path");
    }

    /// @notice Calling an already-called position does not move the cure deadline.
    /// @dev Permissionless plus a mutable deadline would be a way for anyone to
    ///      keep a borrower's clock running, or to restart it. Neither happens:
    ///      the state write is guarded on `OPEN`.
    function test_markingAnAlreadyCalledPositionDoesNotTouchItsClock() public {
        _open();
        _drop(MAX_DEVIATION_BPS);
        vault.markToMarket(ID);
        uint64 deadline = vault.repo(ID).cureDeadline;

        vm.warp(block.timestamp + 1 hours);
        vm.prank(PASSERBY);
        assertTrue(vault.markToMarket(ID), "still short");
        assertEq(vault.repo(ID).cureDeadline, deadline, "the clock is untouched");
    }

    function test_aRepoInAStateThatCannotBeMarkedIsRefused() public {
        _open();
        vm.warp(block.timestamp + 30 days);
        _repayRepo(vault, BORROWER, ID);

        vm.expectRevert(
            abi.encodeWithSelector(
                RepoVault.WrongState.selector, RepoVault.State.CLOSED, RepoVault.State.OPEN
            )
        );
        vault.markToMarket(ID);
    }

    // -------------------------------------------------- 2. the dark feed path

    /// @notice A dark feed refuses to mark rather than marking on an old price.
    function test_aDarkFeedRefusesToMarkRatherThanMarkingOnAnOldPrice() public {
        _open();
        vm.warp(block.timestamp + HEARTBEAT + 1);
        assertTrue(oracle.stale());
        vm.expectRevert();
        vault.markToMarket(ID);
    }

    /// @notice The manual seat is shut while the feed is live.
    /// @dev The seat is not removed, it is narrowed. A margin engine that could
    ///      post a mark over a working feed would be the same discretionary
    ///      seat wearing a feed as a decoration.
    function test_theManualSeatIsShutWhileTheFeedIsLive() public {
        _open();
        assertFalse(oracle.stale());
        vm.prank(ENGINE);
        vm.expectRevert(abi.encodeWithSelector(RepoVaultBase.FeedIsLive.selector));
        vault.postMark(ID, keccak256("mark"), true, 1 days);
    }

    /// @notice And it opens when the feed goes dark.
    /// @dev The whole reason `postMark` survives. A feed outage that froze the
    ///      repo book would be a worse failure than the one it was meant to fix,
    ///      and `PrimeOracle.stale()` is total so this path cannot itself be
    ///      blocked by the feed.
    function test_theManualSeatOpensWhenTheFeedGoesDark() public {
        _open();
        vm.warp(block.timestamp + HEARTBEAT + 1);

        vm.prank(ENGINE);
        vault.postMark(ID, keccak256("mark"), true, 1 days);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.MARGIN_CALL));
    }

    function test_aNarrowedCeilingCannotBlockTheDarkFeedFallback() public {
        _open();
        vm.warp(block.timestamp + HEARTBEAT + 1);
        vm.prank(SUPERVISOR);
        regime.narrow(L.point(L.G_PRED, L.T_EOD), "defer margin events");

        bytes32 commitment = keccak256("dark-feed mark");
        vm.recordLogs();
        vm.prank(ENGINE);
        vault.postMark(ID, commitment, true, 1 days);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(vault.repo(ID).markCommitment, commitment);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.MARGIN_CALL));
        assertEq(logs.length, 1, "only the unwaived cadence event remains");
        assertEq(logs[0].topics[0], keccak256("MarkPosted(bytes32,bytes32)"));
    }

    /// @notice A dark cash leg opens the seat as surely as a dark panel does.
    /// @dev The composite is two feeds and either one going quiet is an outage.
    function test_aDarkUpstreamOpensTheSeatToo() public {
        _open();
        cash.setReverts(true);
        assertTrue(oracle.stale());

        vm.prank(ENGINE);
        vault.postMark(ID, keccak256("mark"), true, 1 days);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.MARGIN_CALL));
    }

    /// @notice Only the margin engine holds the manual seat, dark feed or not.
    function test_theDarkFeedDoesNotOpenTheSeatToEveryone() public {
        _open();
        vm.warp(block.timestamp + HEARTBEAT + 1);
        vm.prank(PASSERBY);
        vm.expectRevert(abi.encodeWithSelector(RepoVaultBase.NotMarginEngine.selector));
        vault.postMark(ID, keccak256("mark"), true, 1 days);
    }

    // ------------------------------------------------------- 3. the preview

    /// @notice The preview says what marking would do, without sending anything.
    function test_previewSaysWhatMarkingWouldDoWithoutSendingAnything() public {
        _open();
        _drop(MAX_DEVIATION_BPS);

        (uint256 mark, bool breach, bool dark) = vault.previewMark(ID);
        assertFalse(dark);
        assertTrue(breach);
        assertEq(mark, oracle.markPerUnitTinybar() * LOT);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.OPEN), "nothing moved");

        assertEq(vault.markToMarket(ID), breach, "and the send agrees with the view");
    }

    /// @notice A dark feed answers `dark`, so a screen can say so.
    /// @dev Total on purpose. A view that reverted on an outage would take the
    ///      Repo screen down with the feed, and the screen is exactly where
    ///      somebody needs to be told the feed is down.
    function test_previewReportsADarkFeedRatherThanReverting() public {
        _open();
        vm.warp(block.timestamp + HEARTBEAT + 1);

        (uint256 mark, bool breach, bool dark) = vault.previewMark(ID);
        assertTrue(dark);
        assertEq(mark, 0);
        assertFalse(breach);
    }

    /// @notice The preview and the send agree on every price the cap admits.
    function testFuzz_thePreviewNeverDisagreesWithTheSend(uint16 bps) public {
        bps = uint16(bound(bps, 0, MAX_DEVIATION_BPS));
        _open();
        _drop(bps);

        (, bool previewed,) = vault.previewMark(ID);
        assertEq(vault.markToMarket(ID), previewed);
    }

    // ------------------------------------------ 4. the arithmetic it stands on

    /// @notice The mark is the feed's price times this repo's own lot.
    /// @dev Both are public reads, which is the argument that lets `previewMark`
    ///      be a view at all: it discloses nothing the ledger does not hold.
    function test_theMarkIsThePriceTimesTheLotAndNothingElse() public {
        _open();
        (uint256 mark,,) = vault.previewMark(ID);

        uint256 expected = (uint256(PAR) * 1e8 / uint256(HBAR_USD)) * LOT;
        assertEq(mark, expected, "clean price over HBAR/USD, times the lot");
        assertEq(vault.repo(ID).collateralAmount, LOT);
    }

    /// @notice A vault cannot be built without a feed.
    function test_aVaultWithNoFeedIsRefusedAtConstruction() public {
        vm.expectRevert(abi.encodeWithSelector(RepoVaultBase.NoFeed.selector));
        new RepoVault(
            holds,
            ENGINE,
            IPrimeOracle(address(0)),
            couponSchedule,
            eligibility,
            params,
            PENALTY_RATE,
            FAIL_GRACE,
            CURE_WINDOW
        );
    }

    function test_aVaultWithNoSecurityIsRefusedAtConstruction() public {
        vm.expectRevert(RepoVaultBase.ZeroAddress.selector);
        new RepoVault(
            MockHolds(address(0)),
            ENGINE,
            IPrimeOracle(address(oracle)),
            couponSchedule,
            eligibility,
            params,
            PENALTY_RATE,
            FAIL_GRACE,
            CURE_WINDOW
        );
    }

    function test_aVaultWithNoEligibilityRegistryIsRefusedAtConstruction() public {
        vm.expectRevert(RepoVaultBase.ZeroAddress.selector);
        new RepoVault(
            holds,
            ENGINE,
            IPrimeOracle(address(oracle)),
            couponSchedule,
            IExternalKycList(address(0)),
            params,
            PENALTY_RATE,
            FAIL_GRACE,
            CURE_WINDOW
        );
    }

    /// @notice Nor without a coupon calendar, and for the same reason.
    /// @dev The seat next to the feed's. A vault with no schedule is a vault
    ///      whose only account of when a coupon fell due is whatever the caller
    ///      of `noteCoupon` said, which is the arrangement `CouponSchedule` was
    ///      built to end. Refused at construction rather than at the first
    ///      coupon, because a bond that cannot record its income dates is
    ///      a bond that cannot be repo'd, and finding that out mid-term is
    ///      finding it out too late.
    function test_aVaultWithNoScheduleIsRefusedAtConstruction() public {
        vm.expectRevert(abi.encodeWithSelector(RepoVaultBase.NoSchedule.selector));
        new RepoVault(
            holds,
            ENGINE,
            IPrimeOracle(address(oracle)),
            ICouponSchedule(address(0)),
            eligibility,
            params,
            PENALTY_RATE,
            FAIL_GRACE,
            CURE_WINDOW
        );
    }

    /// @notice The published cure window is what a borrower actually gets.
    /// @dev The failure this prevents: a permissionless `markToMarket` with a
    ///      caller-chosen window lets anyone call a position with a window of
    ///      zero and `declareDefault` it in the same block. The window is an
    ///      immutable for that reason and this is the assertion.
    function test_theCureWindowIsPublishedAndNotChosenByTheCaller() public {
        _open();
        _drop(MAX_DEVIATION_BPS);

        vm.prank(PASSERBY);
        vault.markToMarket(ID);

        uint64 until = vault.repo(ID).cureDeadline;
        assertEq(until, uint64(block.timestamp) + vault.cureWindow());

        vm.prank(PASSERBY);
        vm.expectRevert(abi.encodeWithSelector(RepoVaultBase.CureWindowOpen.selector, until));
        vault.declareDefault(ID);

        vm.warp(until);
        vm.prank(PASSERBY);
        vault.declareDefault(ID);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.DEFAULTED));
    }

    function test_anOverflowingCureDeadlineCannotHalfOpenAMarginCall() public {
        vault = new RepoVault(
            holds,
            ENGINE,
            IPrimeOracle(address(oracle)),
            _deploySchedule(uint64(block.timestamp)),
            eligibility,
            params,
            PENALTY_RATE,
            FAIL_GRACE,
            type(uint64).max
        );
        _open();
        _drop(MAX_DEVIATION_BPS);

        vm.expectRevert(RepoVaultBase.DeadlineOverflow.selector);
        vault.markToMarket(ID);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.OPEN));
    }
}
