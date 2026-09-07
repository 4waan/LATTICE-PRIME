// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HederaRateFeed} from "../src/oracle/HederaRateFeed.sol";
import {PrimeOracle} from "../src/oracle/PrimeOracle.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {PolicyFixture} from "./PolicyFixture.sol";

/// @dev `0x168` as the network implements it: `tinybars * cents / hbars`, in
///      tinycents, with the council-set pair from the exchange rate file. The
///      shape is Hedera's; the numbers below are the ones the testnet mirror
///      node published on 2026-09-07.
contract MockExchangeRate {
    uint256 public centEquivalent = 241_924;
    uint256 public hbarEquivalent = 30_000;
    bool public broken;

    function set(uint256 cents, uint256 hbars) external {
        centEquivalent = cents;
        hbarEquivalent = hbars;
    }

    function setBroken(bool v) external {
        broken = v;
    }

    function tinybarsToTinycents(uint256 tinybars) external view returns (uint256) {
        if (broken) revert("rate unavailable");
        // Tinycents per tinybar is `cents / hbars` scaled by 1e8, because a
        // tinycent is 1e-8 of a cent and a tinybar is 1e-8 of an HBAR.
        return (tinybars * centEquivalent * 1e8) / (hbarEquivalent * 1e8);
    }
}

/// @title HederaRateFeedTest
/// @notice The seat that exists because Chainlink's own feed could not take it.
///
/// `probes/chainlink-hedera.out` is the measurement behind this whole contract:
/// Chainlink runs HBAR/USD on Hedera and refuses to answer a *contract* that
/// reads it, on testnet and on mainnet, with `No access`. `decimals()` is not
/// gated, which is why `PrimeOracle`'s constructor check passed on a feed it
/// could never price against. That is the bug this suite exists to make
/// impossible to reintroduce: the last test seats a feed that answers
/// `decimals()` and refuses everything else, and asserts the venue reads it as
/// dark rather than as a price.
contract HederaRateFeedTest is Test, PolicyFixture {
    HederaRateFeed internal feed;
    MockExchangeRate internal rate;

    address internal constant P1 = address(0xB1CE);
    address internal constant P2 = address(0xB2CE);

    function setUp() public {
        vm.warp(1_000_000);
        _deployPolicy(asDeployed());
        rate = new MockExchangeRate();
        vm.etch(address(0x168), address(rate).code);
        // `vm.etch` copies code, not storage, so the mock's defaults have to be
        // written into the etched account rather than assumed to travel with it.
        MockExchangeRate(address(0x168)).set(241_924, 30_000);
        feed = new HederaRateFeed();
    }

    /// @notice The rate the network publishes, in the scale the venue reads.
    /// @dev The mirror node published `cent_equivalent 241924` against
    ///      `hbar_equivalent 30000` on 2026-09-07, which is 8.06413333 cents per
    ///      HBAR, which is 0.0806413333 USD, which at eight decimals is
    ///      8064133 after the floor. The literal is written out so a reader can
    ///      check the chain against this file rather than against a comment.
    function test_theRateIsTheOneTheNetworkPublishes() public view {
        assertEq(feed.usdPerHbar(), 8_064_133, "0.08064133 USD per HBAR");
    }

    /// @notice Eight decimals, which is what makes it seatable at all.
    function test_itAnswersOnTheScalePrimeOracleRequires() public view {
        assertEq(feed.decimals(), 8);
        assertEq(feed.version(), 1);
        assertEq(
            feed.description(), "HBAR / USD (Hedera network exchange rate, 0x168)"
        );
    }

    /// @notice The round shape a Chainlink consumer checks.
    function test_theRoundShapePassesTheChecksAConsumerMakes() public view {
        (uint80 id, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 inRound) =
            feed.latestRoundData();
        assertEq(answer, 8_064_133);
        assertGt(answer, 0, "a non-positive answer is refused upstream of here");
        assertTrue(updatedAt != 0, "a zero updatedAt reads as an unfinished round");
        assertTrue(inRound >= id, "never a carried-forward answer: there are no rounds");
        assertEq(updatedAt, block.timestamp, "consensus state, current by construction");
        assertEq(startedAt, updatedAt);
    }

    /// @notice There is no history, and it says so rather than inventing some.
    /// @dev A consumer asking for a past round and getting today's price back
    ///      would have no way to know. Chainlink's own convention on a round it
    ///      does not hold is to revert.
    function test_thereIsNoHistoryAndItSaysSo() public {
        vm.expectRevert(abi.encodeWithSelector(HederaRateFeed.NoHistory.selector));
        feed.getRoundData(1);
    }

    /// @notice A missing or broken system contract reverts rather than answering zero.
    function test_anUnavailableRateRevertsRatherThanAnsweringZero() public {
        MockExchangeRate(address(0x168)).setBroken(true);
        vm.expectRevert(abi.encodeWithSelector(HederaRateFeed.RateUnavailable.selector));
        feed.usdPerHbar();

        // And on a chain with no system contract at all.
        vm.etch(address(0x168), "");
        vm.expectRevert(abi.encodeWithSelector(HederaRateFeed.RateUnavailable.selector));
        feed.usdPerHbar();
    }

    /// @notice The rate moving moves the mark, and nothing else has to happen.
    /// @dev The closed form is derived rather than copied from the contract, so
    ///      this is a check and not a restatement. The exchange rate file gives
    ///      `cents` per `hbars` HBAR, so cents per HBAR is `cents / hbars`, USD
    ///      per HBAR is that over a hundred, and eight decimals of USD is
    ///      `cents * 1e6 / hbars`. The tolerance is one, because the adapter
    ///      floors twice — once inside `0x168` and once on the way back — and
    ///      the closed form floors once.
    function testFuzz_theMarkFollowsTheNetworkRate(uint64 cents) public {
        cents = uint64(bound(cents, 1_000, 10_000_000));
        MockExchangeRate(address(0x168)).set(cents, 30_000);
        assertApproxEqAbs(
            feed.usdPerHbar(), (uint256(cents) * 1e6) / 30_000, 1, "USD, 8 dp"
        );
    }

    // ------------------------------------------- the bug this seat came from

    /// @notice A feed that answers `decimals()` and refuses prices reads as dark.
    /// @dev **This is the failure that produced this contract, as a test.**
    ///      `PrimeOracle` seats a feed after checking `decimals()`, and every
    ///      Chainlink proxy on Hedera answers that one while refusing every
    ///      price read from a contract with `No access`. So the seat took, the
    ///      deployment succeeded, and the first `markToMarket` reverted. The
    ///      venue's behaviour was correct throughout — a leg it cannot read is
    ///      dark, and dark opens `RepoVault.postMark` — and this test is that
    ///      claim, so a future seat with the same shape fails here instead of on
    ///      chain.
    function test_aFeedThatAnswersDecimalsAndRefusesPricesIsSeatableAndDark() public {
        AccessControlledFeed gated = new AccessControlledFeed();
        address[] memory panel = new address[](2);
        panel[0] = P1;
        panel[1] = P2;

        PrimeOracle oracle = new PrimeOracle(
            params,
            address(this),
            AggregatorV3Interface(address(gated)),
            panel,
            2,
            7,
            6 hours,
            26 hours,
            500
        );

        // It seated. The constructor's only question was the scale.
        assertEq(address(oracle.cashFeed()), address(gated));

        uint64 r = oracle.openRound();
        vm.prank(P1);
        oracle.submit(r, 100_00000000, 425);
        vm.prank(P2);
        oracle.submit(r, 100_00000000, 425);
        oracle.finalize(r);

        assertFalse(oracle.ourLegStale(), "the venue's own leg is fine");
        (bool ok,,) = oracle.cashLeg();
        assertFalse(ok, "and the seated leg is not");
        assertTrue(oracle.stale(), "so the composite is dark");
        vm.expectRevert(
            abi.encodeWithSelector(PrimeOracle.CashFeedStale.selector, address(gated))
        );
        oracle.markPerUnitTinybar();

        // Swapping in the adapter fixes it, through the ordinary seat.
        oracle.proposeCashFeed(AggregatorV3Interface(address(feed)));
        clock.tick();
        oracle.adoptCashFeed();
        assertFalse(oracle.stale(), "and the venue is live again");
        assertGt(oracle.markPerUnitTinybar(), 0);
    }
}

/// @dev Chainlink's `SimpleReadAccessController` behaviour, reduced to the part
///      that matters here: the scale is public and the price is not.
///      `probes/chainlink-hedera.out` has the returndata this reproduces.
contract AccessControlledFeed is AggregatorV3Interface {
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function description() external pure returns (string memory) {
        return "HBAR / USD";
    }

    function version() external pure returns (uint256) {
        return 6;
    }

    function latestRoundData() external pure returns (uint80, int256, uint256, uint256, uint80) {
        revert("No access");
    }

    function getRoundData(uint80) external pure returns (uint80, int256, uint256, uint256, uint80) {
        revert("No access");
    }
}
