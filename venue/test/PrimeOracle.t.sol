// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PrimeOracle} from "../src/oracle/PrimeOracle.sol";
import {OracleMath} from "../src/oracle/OracleMath.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {PolicyFixture} from "./PolicyFixture.sol";
import {MockAggregator} from "./OracleFixture.sol";

/// @title PrimeOracleTest
/// @notice The bounds on the contract that decides what the collateral is worth.
///
/// A feed is the one contract in a venue whose failure modes are not its own
/// bugs. It fails because a publisher lies, because a publisher goes quiet,
/// because an upstream aggregator this repository does not control returns
/// something it should not, or because the venue's own disclosure policy stops
/// permitting a price to be published. Every section below is one of those.
///
/// **Two mutations have to fail a named test**, which is the standard the pause
/// work set after a headline invariant survived its own mutation:
///
/// - delete the staleness gate in `markPerUnitTinybar`
///     -> `test_MUTATION_deletingTheStalenessGateFailsHere`
/// - delete the deviation cap in `finalize`
///     -> `test_MUTATION_deletingTheDeviationCapFailsHere`
///
/// The median is checked against `probes/oracle-median.py`, which was written
/// against the specification rather than against `OracleMath` and brute forces
/// 18,340 panels to establish what one dishonest publisher can do. Its vectors
/// are replayed from `test/fixtures/median.json`, the arrangement
/// `CallAuction.t.sol` already uses for the clearing rule.
contract PrimeOracleTest is Test, PolicyFixture {
    PrimeOracle internal oracle;
    MockAggregator internal cash;

    address internal constant P1 = address(0xB1CE);
    address internal constant P2 = address(0xB2CE);
    address internal constant P3 = address(0xB3CE);
    address internal constant ADMIN = address(0xAD1);
    address internal constant PASSERBY = address(0xF00D);

    uint8 internal constant QUORUM = 2;
    uint8 internal constant MAX_PUBLISHERS = 7;
    uint64 internal constant HEARTBEAT = 6 hours;
    uint64 internal constant CASH_HEARTBEAT = 26 hours;
    uint16 internal constant MAX_DEVIATION_BPS = 500;

    /// @dev HBAR/USD as `probes/chainlink-hedera.out` read it off chain 296:
    ///      0.08152235 USD, at the eight decimals every Chainlink feed on Hedera
    ///      answers with.
    int256 internal constant HBAR_USD = 8_152_235;

    /// @dev Par for a bond with a nominal value of 100.00 USD.
    uint128 internal constant PAR = 100_00000000;

    uint64 internal constant COUPON_BPS = 425;

    function setUp() public {
        vm.warp(1_000_000);
        _deployPolicy(asDeployed());
        cash = new MockAggregator(HBAR_USD, block.timestamp);
        oracle = _oracle(_panel3());
    }

    function _panel3() internal pure returns (address[] memory p) {
        p = new address[](3);
        p[0] = P1;
        p[1] = P2;
        p[2] = P3;
    }

    function _oracle(address[] memory panel) internal returns (PrimeOracle) {
        return new PrimeOracle(
            params,
            ADMIN,
            AggregatorV3Interface(address(cash)),
            panel,
            QUORUM,
            MAX_PUBLISHERS,
            HEARTBEAT,
            CASH_HEARTBEAT,
            MAX_DEVIATION_BPS
        );
    }

    /// @dev One round, submitted by all three and finalised. Returns the round.
    function _round(uint128 a, uint128 b, uint128 c) internal returns (uint64 r) {
        r = oracle.openRound();
        vm.prank(P1);
        oracle.submit(r, a, COUPON_BPS);
        vm.prank(P2);
        oracle.submit(r, b, COUPON_BPS);
        vm.prank(P3);
        oracle.submit(r, c, COUPON_BPS);
        oracle.finalize(r);
    }

    // ------------------------------------------------ 1. the median is a median

    /// @notice Every vector `probes/oracle-median.py` wrote, replayed.
    /// @dev The reference does not share this implementation's sort: it is
    ///      Python's `sorted` and a slice, written from the specification. A
    ///      disagreement fails here rather than being discovered by a margin
    ///      call taken against the wrong number.
    function test_theMedianAgreesWithAReferenceThatDoesNotShareItsCode() public view {
        string memory json = vm.readFile("test/fixtures/median.json");
        uint256 n = vm.parseJsonUint(json, ".panelCount");
        assertGt(n, 40, "the fixture is thin; rerun probes/oracle-median.py");
        for (uint256 i; i < n; ++i) {
            string memory at = string.concat(".panels[", vm.toString(i), "]");
            uint256[] memory xs = vm.parseJsonUintArray(json, string.concat(at, ".xs"));
            uint256 want = vm.parseJsonUint(json, string.concat(at, ".median"));
            assertEq(
                _median(xs),
                want,
                string.concat("panel ", vm.toString(i), ": ",
                    vm.parseJsonString(json, string.concat(at, ".what")))
            );
        }
    }

    /// @notice The deviation measure, against the same reference.
    function test_theDeviationMeasureAgreesWithTheReference() public view {
        string memory json = vm.readFile("test/fixtures/median.json");
        uint256 n = vm.parseJsonUint(json, ".deviationCount");
        for (uint256 i; i < n; ++i) {
            string memory at = string.concat(".deviations[", vm.toString(i), "]");
            uint256 prev = vm.parseJsonUint(json, string.concat(at, ".prev"));
            uint256 next = vm.parseJsonUint(json, string.concat(at, ".next"));
            uint256 want = vm.parseJsonUint(json, string.concat(at, ".bps"));
            assertEq(OracleMath.deviationBps(next, prev), want, "deviation bps");
        }
    }

    /// @notice The composite, against the same reference.
    function test_theCompositeMarkAgreesWithTheReference() public {
        string memory json = vm.readFile("test/fixtures/median.json");
        uint256 n = vm.parseJsonUint(json, ".markCount");
        for (uint256 i; i < n; ++i) {
            string memory at = string.concat(".marks[", vm.toString(i), "]");
            uint256 price = vm.parseJsonUint(json, string.concat(at, ".cleanPrice"));
            uint256 rate = vm.parseJsonUint(json, string.concat(at, ".usdPerHbar"));
            uint256 want =
                vm.parseJsonUint(json, string.concat(at, ".markPerUnitTinybar"));

            // A fresh oracle per vector, because the deviation cap binds the
            // *second* round and these vectors are unrelated prices.
            cash = new MockAggregator(int256(rate), block.timestamp);
            oracle = _oracle(_panel3());
            // forge-lint: disable-next-line(unsafe-typecast)
            _round(uint128(price), uint128(price), uint128(price));
            assertEq(oracle.markPerUnitTinybar(), want, "composite mark");
        }
    }

    /// @notice One dishonest publisher cannot move the mark where it likes.
    /// @dev The claim `probes/oracle-median.py` brute forces over 18,340 panels,
    ///      asserted here against the contract for the case the panel is three
    ///      and the liar is at the top of the type. The mean is what this venue
    ///      did not build: with the same inputs it lands above
    ///      `type(uint128).max / 3`, which is not a price.
    function test_oneDishonestPublisherMovesTheMedianByOneOrderStatistic() public {
        _round(99_00000000, 100_00000000, 101_00000000);
        (uint128 honest,,,) = oracle.latest();
        assertEq(honest, 100_00000000, "the middle answer");

        cash = new MockAggregator(HBAR_USD, block.timestamp);
        oracle = _oracle(_panel3());
        _round(99_00000000, 100_00000000, type(uint128).max);
        (uint128 corrupted,,,) = oracle.latest();

        assertEq(corrupted, 100_00000000, "moved to the adjacent honest answer");
        assertLe(corrupted, 101_00000000, "and never outside the honest range");
    }

    // ------------------------------------------------------- 2. the heartbeat

    /// @notice A price older than the heartbeat is refused, not read through.
    function test_aStalePriceRefusesRatherThanReadingThrough() public {
        _round(PAR, PAR, PAR);
        assertFalse(oracle.stale(), "live at the moment it was finalised");
        assertGt(oracle.markPerUnitTinybar(), 0);

        vm.warp(block.timestamp + HEARTBEAT);
        assertFalse(oracle.stale(), "exactly on the heartbeat is still live");

        vm.warp(block.timestamp + 1);
        assertTrue(oracle.stale(), "one second past it is not");
        vm.expectRevert();
        oracle.markPerUnitTinybar();
    }

    /// @notice **Mutation.** Delete the staleness gate and this test fails.
    /// @dev Named so the mutation has somewhere to fail. Deleting `if
    ///      (ourLegStale()) revert FeedStale(...)` from `markPerUnitTinybar`
    ///      leaves a function that happily prices a repo off a price from any
    ///      point in the past, and every other test in this file still passes,
    ///      because every other test reads the feed while it is live. That is
    ///      exactly the shape of bug the pause work found surviving its own
    ///      mutation.
    function test_MUTATION_deletingTheStalenessGateFailsHere() public {
        _round(PAR, PAR, PAR);
        uint256 live = oracle.markPerUnitTinybar();
        assertGt(live, 0, "a price exists to be read through");

        vm.warp(block.timestamp + HEARTBEAT + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                PrimeOracle.FeedStale.selector, uint64(1_000_000), HEARTBEAT
            )
        );
        oracle.markPerUnitTinybar();
    }

    /// @notice Before the first round there is no price and the feed says so.
    /// @dev The zero value is dark rather than free. A feed that answered zero
    ///      until someone published would price every position at zero, which
    ///      calls margin on all of them.
    function test_aFeedWithNoRoundsIsDarkAndNotFree() public {
        assertTrue(oracle.stale(), "dark before the first finalise");
        assertEq(oracle.lastRound(), 0);
        vm.expectRevert(abi.encodeWithSelector(PrimeOracle.NoData.selector));
        oracle.latestRoundData();
        vm.expectRevert();
        oracle.markPerUnitTinybar();
    }

    // --------------------------------------------------- 3. the deviation cap

    /// @notice A round that jumps further than the cap does not land.
    function test_aRoundBeyondTheDeviationCapIsRefused() public {
        _round(PAR, PAR, PAR);
        uint128 tooFar = PAR + (PAR * (MAX_DEVIATION_BPS + 1)) / 10_000;

        uint64 r = oracle.openRound();
        vm.prank(P1);
        oracle.submit(r, tooFar, COUPON_BPS);
        vm.prank(P2);
        oracle.submit(r, tooFar, COUPON_BPS);
        vm.expectRevert(
            abi.encodeWithSelector(
                PrimeOracle.DeviationTooLarge.selector, PAR, tooFar, MAX_DEVIATION_BPS
            )
        );
        oracle.finalize(r);

        (uint128 held,,,) = oracle.latest();
        assertEq(held, PAR, "and the last agreed price is still the price");
    }

    /// @notice Exactly at the cap lands. The bound is inclusive and stated.
    function test_exactlyAtTheDeviationCapLands() public {
        _round(PAR, PAR, PAR);
        uint128 edge = PAR + (PAR * MAX_DEVIATION_BPS) / 10_000;
        _round(edge, edge, edge);
        (uint128 held,,,) = oracle.latest();
        assertEq(held, edge, "500 bps is permitted; 500 bps and one wei is not");
    }

    /// @notice **Mutation.** Delete the deviation cap and this test fails.
    /// @dev The cap is the only thing standing between a compromised quorum and
    ///      an arbitrary mark. With it deleted the round below lands, the feed
    ///      prices the bond at one tinybar, and every open repo is instantly in
    ///      breach. Nothing else in this file notices, because nothing else
    ///      submits a price far from the last one.
    function test_MUTATION_deletingTheDeviationCapFailsHere() public {
        _round(PAR, PAR, PAR);

        uint64 r = oracle.openRound();
        vm.prank(P1);
        oracle.submit(r, 1, COUPON_BPS);
        vm.prank(P2);
        oracle.submit(r, 1, COUPON_BPS);
        vm.prank(P3);
        oracle.submit(r, 1, COUPON_BPS);

        vm.expectRevert(
            abi.encodeWithSelector(
                PrimeOracle.DeviationTooLarge.selector, PAR, uint128(1), MAX_DEVIATION_BPS
            )
        );
        oracle.finalize(r);
    }

    /// @notice The cap is not applied to the reference rate, on purpose.
    /// @dev A coupon reference rate near zero moves by thousands of basis points
    ///      on an ordinary day. A cap that refused that would refuse the
    ///      ordinary case, which is a cap that gets removed the first time it
    ///      fires rather than a cap.
    function test_theReferenceRateIsNotBoundedByThePriceCap() public {
        _round(PAR, PAR, PAR);
        uint64 r = oracle.openRound();
        vm.prank(P1);
        oracle.submit(r, PAR, 1);
        vm.prank(P2);
        oracle.submit(r, PAR, 5000);
        vm.prank(P3);
        oracle.submit(r, PAR, 9000);
        oracle.finalize(r);

        (, uint64 rate,,) = oracle.latest();
        assertEq(rate, 5000, "the median rate, unbounded by the price cap");
    }

    /// @notice The first round has nothing to deviate from.
    function test_theFirstRoundIsNotBoundedByAPriceThatDoesNotExist() public {
        _round(1, 1, 1);
        (uint128 held,,,) = oracle.latest();
        assertEq(held, 1, "any first price is admissible; there is no previous one");
    }

    // -------------------------------------------------------- 4. the quorum

    function test_aRoundShortOfQuorumDoesNotFinalise() public {
        uint64 r = oracle.openRound();
        vm.prank(P1);
        oracle.submit(r, PAR, COUPON_BPS);
        vm.expectRevert(
            abi.encodeWithSelector(PrimeOracle.QuorumShort.selector, uint256(1), QUORUM)
        );
        oracle.finalize(r);
    }

    function test_onlyASeatedPublisherMayAnswer() public {
        uint64 r = oracle.openRound();
        vm.prank(PASSERBY);
        vm.expectRevert(
            abi.encodeWithSelector(PrimeOracle.NotPublisher.selector, PASSERBY)
        );
        oracle.submit(r, PAR, COUPON_BPS);
    }

    function test_onePublisherIsOneAnswer() public {
        uint64 r = oracle.openRound();
        vm.prank(P1);
        oracle.submit(r, PAR, COUPON_BPS);
        vm.prank(P1);
        vm.expectRevert(
            abi.encodeWithSelector(PrimeOracle.AlreadyAnswered.selector, P1, r)
        );
        oracle.submit(r, PAR + 1, COUPON_BPS);
    }

    /// @notice An answer to a round that is not open is refused, not reassigned.
    /// @dev The round is an argument for this reason. A publisher whose answer
    ///      was mined after the round they meant it for had closed would
    ///      otherwise have it counted against a question they were not asked.
    function test_anAnswerToAClosedRoundIsRefusedRatherThanReassigned() public {
        _round(PAR, PAR, PAR);
        vm.prank(P1);
        vm.expectRevert(
            abi.encodeWithSelector(PrimeOracle.WrongRound.selector, uint64(1), uint64(2))
        );
        oracle.submit(1, PAR, COUPON_BPS);
    }

    function test_finalisingIsPermissionless() public {
        uint64 r = oracle.openRound();
        vm.prank(P1);
        oracle.submit(r, PAR, COUPON_BPS);
        vm.prank(P2);
        oracle.submit(r, PAR, COUPON_BPS);
        vm.prank(PASSERBY);
        oracle.finalize(r);
        assertEq(oracle.lastRound(), r, "anyone may close a round nobody owns");
    }

    // ---------------------------------------------- 5. the panel, and its bound

    /// @notice A seating restarts the open round rather than mixing two panels.
    /// @dev The bug this rule exists for: without it, a round straddling a panel
    ///      change is decided partly by publishers who no longer hold a seat,
    ///      and the array `finalize` sorts is bounded by `maxPublishers` plus
    ///      however many the outgoing panel already contributed. Both are
    ///      unacceptable and the second is a gas bound governance could raise.
    function test_aSeatingRestartsTheOpenRoundRatherThanMixingTwoPanels() public {
        uint64 r = oracle.openRound();
        vm.prank(P1);
        oracle.submit(r, PAR, COUPON_BPS);
        vm.prank(P2);
        oracle.submit(r, PAR, COUPON_BPS);
        assertEq(oracle.panelOf(r).length, 2);

        address[] memory next = _panel3();
        next[2] = PASSERBY;
        vm.prank(ADMIN);
        oracle.proposePublishers(next);
        clock.tick();
        oracle.adoptPublishers();

        assertEq(oracle.openRound(), r, "the round number a reader sees is unchanged");
        assertEq(oracle.panelOf(r).length, 0, "and its answers are gone");
        assertFalse(oracle.answered(r, P1), "so P1 may answer the round again");

        vm.prank(P1);
        oracle.submit(r, PAR, COUPON_BPS);
        vm.prank(PASSERBY);
        oracle.submit(r, PAR, COUPON_BPS);
        oracle.finalize(r);
        assertEq(oracle.roundOf(r).panel, 2, "decided by the panel that exists");
    }

    /// @notice A published round keeps its answers after the panel changes.
    function test_aPublishedRoundKeepsItsAnswersThroughASeating() public {
        uint64 r = _round(PAR, PAR, PAR);
        assertEq(oracle.panelOf(r).length, 3);

        vm.prank(ADMIN);
        oracle.proposePublishers(_panel3());
        clock.tick();
        oracle.adoptPublishers();

        assertEq(oracle.panelOf(r).length, 3, "history is not erased by a seating");
    }

    /// @notice The sort in `finalize` is bounded by the panel and by nothing else.
    function testFuzz_theSortIsBoundedByTheSeatedPanel(uint8 seats) public {
        seats = uint8(bound(seats, QUORUM, MAX_PUBLISHERS));
        address[] memory panel = new address[](seats);
        for (uint256 i; i < seats; ++i) {
            panel[i] = address(uint160(0x1000 + i));
        }
        cash = new MockAggregator(HBAR_USD, block.timestamp);
        oracle = _oracle(panel);

        uint64 r = oracle.openRound();
        for (uint256 i; i < seats; ++i) {
            vm.prank(panel[i]);
            oracle.submit(r, PAR, COUPON_BPS);
        }
        oracle.finalize(r);
        assertEq(oracle.roundOf(r).panel, seats);
        assertLe(oracle.roundOf(r).panel, MAX_PUBLISHERS, "never above the bound");
    }

    function test_aPanelBelowQuorumIsRefusedRatherThanSeatedDark() public {
        address[] memory one = new address[](1);
        one[0] = P1;
        vm.prank(ADMIN);
        vm.expectRevert(
            abi.encodeWithSelector(
                PrimeOracle.PanelSize.selector, uint256(1), QUORUM, MAX_PUBLISHERS
            )
        );
        oracle.proposePublishers(one);
    }

    function test_aDuplicateSeatIsRefused() public {
        address[] memory dup = _panel3();
        dup[2] = P1;
        vm.prank(ADMIN);
        vm.expectRevert(
            abi.encodeWithSelector(PrimeOracle.PanelNotDistinct.selector, P1)
        );
        oracle.proposePublishers(dup);
    }

    // ------------------------------------------------- 6. the governance delay

    /// @notice A panel change is visible an epoch before it binds.
    function test_aPanelChangeWaitsAnEpochAndThenAnyoneMayAdoptIt() public {
        address[] memory next = _panel3();
        next[2] = PASSERBY;

        vm.prank(PASSERBY);
        vm.expectRevert(abi.encodeWithSelector(PrimeOracle.NotAdmin.selector));
        oracle.proposePublishers(next);

        vm.prank(ADMIN);
        oracle.proposePublishers(next);
        assertFalse(oracle.seated(PASSERBY), "proposed is not seated");

        vm.expectRevert(
            abi.encodeWithSelector(
                PrimeOracle.NotYetEffective.selector,
                oracle.pendingPanelEpoch(),
                params.currentEpoch()
            )
        );
        oracle.adoptPublishers();

        clock.tick();
        vm.prank(PASSERBY);
        oracle.adoptPublishers();
        assertTrue(oracle.seated(PASSERBY), "and adoption is permissionless");
        assertFalse(oracle.seated(P3), "the outgoing seat is vacated");
    }

    function test_theCashFeedSeatFollowsTheSameIdiom() public {
        MockAggregator next = new MockAggregator(HBAR_USD, block.timestamp);
        vm.prank(ADMIN);
        oracle.proposeCashFeed(AggregatorV3Interface(address(next)));
        assertEq(address(oracle.cashFeed()), address(cash), "not yet");

        clock.tick();
        oracle.adoptCashFeed();
        assertEq(address(oracle.cashFeed()), address(next));
    }

    /// @notice A feed that does not answer eight decimals cannot be seated.
    /// @dev Refused rather than normalised. `probes/chainlink-hedera.out` reads
    ///      all seven Chainlink feeds on this chain and every one answers eight,
    ///      so the refusal turns nothing real away and it keeps a second price
    ///      scale out of this repository and out of `tools/units.mjs`.
    function test_aFeedWithTheWrongScaleCannotBeSeated() public {
        MockAggregator odd = new MockAggregator(HBAR_USD, block.timestamp);
        odd.setDecimals(18);
        vm.prank(ADMIN);
        vm.expectRevert(
            abi.encodeWithSelector(PrimeOracle.FeedDecimals.selector, uint8(18), uint8(8))
        );
        oracle.proposeCashFeed(AggregatorV3Interface(address(odd)));
    }

    /// @notice A proxy repointed between proposal and adoption is caught.
    function test_aCashFeedRepointedAfterProposalIsRefusedAtAdoption() public {
        MockAggregator next = new MockAggregator(HBAR_USD, block.timestamp);
        vm.prank(ADMIN);
        oracle.proposeCashFeed(AggregatorV3Interface(address(next)));
        next.setDecimals(6);
        clock.tick();
        vm.expectRevert(
            abi.encodeWithSelector(PrimeOracle.FeedDecimals.selector, uint8(6), uint8(8))
        );
        oracle.adoptCashFeed();
        assertEq(address(oracle.cashFeed()), address(cash), "and the old seat holds");
    }

    // -------------------------------------- 7. every way the upstream misbehaves

    /// @notice A negative or zero answer is dark, never a price.
    function test_aNonPositiveUpstreamAnswerIsDark() public {
        _round(PAR, PAR, PAR);
        assertFalse(oracle.stale());

        cash.set(0, block.timestamp);
        assertTrue(oracle.stale(), "zero is not a price");

        cash.set(-1, block.timestamp);
        assertTrue(oracle.stale(), "and neither is a negative one");
        vm.expectRevert(
            abi.encodeWithSelector(
                PrimeOracle.CashFeedStale.selector, address(cash)
            )
        );
        oracle.markPerUnitTinybar();
    }

    /// @notice An answer carried forward under a newer round id is dark.
    function test_anAnswerCarriedForwardUnderANewerIdIsDark() public {
        _round(PAR, PAR, PAR);
        cash.setCarriedForward();
        assertTrue(oracle.stale(), "answeredInRound < roundId");
    }

    /// @notice An unfinished upstream round is dark.
    function test_anUnfinishedUpstreamRoundIsDark() public {
        _round(PAR, PAR, PAR);
        cash.set(HBAR_USD, 0);
        assertTrue(oracle.stale(), "a zero updatedAt is a round in progress");
    }

    /// @notice An upstream past its own heartbeat is dark.
    function test_anUpstreamPastItsOwnHeartbeatIsDark() public {
        _round(PAR, PAR, PAR);
        vm.warp(block.timestamp + CASH_HEARTBEAT);
        // Keep our own leg live so the only thing under test is the cash leg.
        _refreshOurLeg();
        assertFalse(oracle.stale(), "exactly on the upstream heartbeat is live");

        vm.warp(block.timestamp + 1);
        _refreshOurLeg();
        assertTrue(oracle.stale(), "one second past it is not");
    }

    /// @notice An upstream that reverts is dark, and does not take `stale()` with it.
    /// @dev The reason `_cash` uses `try`. `RepoVault.postMark` gates the manual
    ///      seat on `stale()`, so a `stale()` that could revert would be a venue
    ///      with no working mark at all: the feed would be unusable and the
    ///      fallback unreachable in the same call.
    function test_anUpstreamThatRevertsIsDarkAndDoesNotPropagate() public {
        _round(PAR, PAR, PAR);
        cash.setReverts(true);
        assertTrue(oracle.stale(), "and stale() answered rather than reverting");
        vm.expectRevert(
            abi.encodeWithSelector(PrimeOracle.CashFeedStale.selector, address(cash))
        );
        oracle.markPerUnitTinybar();
    }

    /// @notice The two legs are reported apart, because they fail apart.
    function test_theTwoLegsAreDistinguishable() public {
        _round(PAR, PAR, PAR);
        assertFalse(oracle.ourLegStale());
        (bool ok,,) = oracle.cashLeg();
        assertTrue(ok);

        cash.setReverts(true);
        assertFalse(oracle.ourLegStale(), "our leg is fine");
        (ok,,) = oracle.cashLeg();
        assertFalse(ok, "theirs is not");
        assertTrue(oracle.stale(), "and the composite is dark either way");
    }

    // ---------------------------------------------------- 8. the disclosure row

    /// @notice Narrowing row 7 takes the feed dark rather than silencing it.
    /// @dev This is the design and not a bug. `_emitUnder` reverts on a ceiling
    ///      breach, a reverting `finalize` publishes no price, and a venue that
    ///      may not publish a price is a venue that must not act on one. The
    ///      seat that opens is `RepoVault.postMark`, which
    ///      `MarkToMarketTest` asserts from the other side.
    function test_narrowingRowSevenTakesTheFeedDarkAndOpensTheManualSeat() public {
        _round(PAR, PAR, PAR);
        assertFalse(oracle.stale());

        // Row 7 down to a predicate. A price is not a predicate, so `finalize`
        // can no longer say one.
        _publish(_with(asDeployed(), bytes32(uint256(7)), L.point(L.G_PRED, L.T_IMM)));

        uint64 r = oracle.openRound();
        vm.prank(P1);
        oracle.submit(r, PAR, COUPON_BPS);
        vm.prank(P2);
        oracle.submit(r, PAR, COUPON_BPS);
        vm.expectRevert();
        oracle.finalize(r);

        vm.warp(block.timestamp + HEARTBEAT + 1);
        assertTrue(oracle.stale(), "the feed goes dark, which is the fallback signal");
    }

    /// @notice A withheld `Submitted` does not withhold the answer.
    /// @dev Row 16 is metered in the deployed matrix in the sense the venue
    ///      publishes it; whatever the meter says, the answer still lands. The
    ///      distinction the whole lattice turns on: an event is a disclosure and
    ///      the state is not.
    function test_anAnswerLandsWhetherOrNotItsEventIsAudible() public {
        uint64 r = oracle.openRound();
        vm.prank(P1);
        oracle.submit(r, PAR, COUPON_BPS);
        assertTrue(oracle.answered(r, P1), "the state moved");
        assertEq(oracle.panelOf(r).length, 1, "and the answer is readable");
    }

    // -------------------------------------------- 9. the bound on the multiply

    /// @notice The composite cannot overflow at the bounds of its own types.
    /// @dev Asserted rather than assumed, which is what the plan for this
    ///      contract said it would be. `price` is a `uint128` and the cash leg's
    ///      answer is at least one, so the worst numerator is `2^128 * 1e8`, and
    ///      `RepoVault` then multiplies by a lot bounded by the bond's
    ///      `maxSupply` of 1,000,000.
    function test_theMarkCannotOverflowAtTheBoundsOfTheTypes() public {
        cash = new MockAggregator(1, block.timestamp);
        oracle = _oracle(_panel3());
        _round(type(uint128).max, type(uint128).max, type(uint128).max);

        uint256 mark = oracle.markPerUnitTinybar();
        assertEq(mark, uint256(type(uint128).max) * 1e8, "the worst case is finite");

        uint256 maxSupply = 1_000_000;
        unchecked {
            uint256 product = mark * maxSupply;
            assertEq(product / maxSupply, mark, "and the lot multiply does not wrap");
        }
    }

    function test_aZeroPriceIsRefusedAtSubmission() public {
        uint64 r = oracle.openRound();
        vm.prank(P1);
        vm.expectRevert(abi.encodeWithSelector(PrimeOracle.ZeroPrice.selector));
        oracle.submit(r, 0, COUPON_BPS);
    }

    // -------------------------------------- 10. the Chainlink shape it answers

    /// @notice It is a Chainlink feed to anyone who reads it as one.
    /// @dev The other half of the reason `AggregatorV3Interface` is vendored: a
    ///      venue feed shaped like every other feed is one an existing consumer
    ///      can already read, and the shape is not ours to invent.
    function test_itAnswersAsAChainlinkFeed() public {
        uint64 r = _round(99_00000000, PAR, 101_00000000);

        assertEq(oracle.decimals(), 8, "the scale every Hedera feed answers with");
        assertEq(oracle.version(), 1);
        assertEq(oracle.description(), "Lattice Prime LPRC clean price / USD");

        (uint80 id, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 inRound) =
            oracle.latestRoundData();
        assertEq(id, uint80(r));
        assertEq(answer, int256(uint256(PAR)), "the clean price, in USD");
        assertEq(updatedAt, block.timestamp);
        assertEq(startedAt, updatedAt, "one instant: the round held no answer before it");
        assertEq(inRound, id, "never a carried-forward answer");

        (, int256 back,,,) = oracle.getRoundData(uint80(r));
        assertEq(back, answer, "and history reads back");
    }

    /// @notice The Chainlink surface answers the clean price, never the composite.
    /// @dev A consumer speaking this interface is asking for the instrument's
    ///      price in the currency the instrument is denominated in, and would
    ///      have no way to know a tinybar answer had been substituted.
    function test_theChainlinkSurfaceIsTheCleanPriceAndNotTheComposite() public {
        _round(PAR, PAR, PAR);
        (, int256 answer,,,) = oracle.latestRoundData();
        assertEq(uint256(answer), uint256(PAR), "USD, eight decimals");
        assertTrue(
            oracle.markPerUnitTinybar() != uint256(answer),
            "the composite is a different number and has its own name"
        );
    }

    // ------------------------------------------------------------- helpers

    /// @dev The library, reached through a call so the fixture replay exercises
    ///      the same code path `finalize` does rather than an inlined copy.
    function _median(uint256[] memory xs) internal pure returns (uint256) {
        return OracleMath.median(xs);
    }

    function _refreshOurLeg() internal {
        uint64 r = oracle.openRound();
        vm.prank(P1);
        oracle.submit(r, PAR, COUPON_BPS);
        vm.prank(P2);
        oracle.submit(r, PAR, COUPON_BPS);
        oracle.finalize(r);
    }
}
