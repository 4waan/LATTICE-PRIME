// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @title HederaRateFeed
/// @notice HBAR/USD from Hedera's own exchange rate, in Chainlink's shape.
/// @dev The cash leg of `PrimeOracle`, on a chain where Chainlink's own feed
///      cannot be the cash leg.
///
/// ## Why this contract exists, measured rather than assumed
///
/// The design called for Chainlink's HBAR/USD aggregator, and Chainlink does run
/// it on Hedera: `probes/chainlink-hedera.out` reads `description()`,
/// `decimals()`, `version()` and a live `latestRoundData()` off all seven feeds
/// on chain 296. Every one of those reads is from an externally owned account.
///
/// **From a contract, every price read on those feeds reverts `No access`.**
/// The proxies are access controlled and the controller admits a caller only
/// when `msg.sender == tx.origin` or when the caller has been allowlisted, so a
/// contract is refused by construction. Measured on testnet and again on
/// mainnet, both networks, same revert string; the probe prints the returndata.
/// `decimals()` is not gated, which is why `PrimeOracle`'s constructor check
/// passed and the failure only appeared at the first `markToMarket`.
///
/// That is not a thing this venue can code around. It is a property of the feed.
///
/// ## What is seated instead
///
/// Hedera publishes an HBAR/USD rate of its own, at the system contract
/// `0x168`, and it is the rate the network charges every transaction fee at. It
/// is contract readable because being read by contracts is what it is for. This
/// contract is a thin adapter over it in `AggregatorV3Interface`'s shape, so
/// `PrimeOracle`'s seat does not have to know which chain it is on and a
/// readable Chainlink aggregator can be seated in its place, through the same
/// propose-and-adopt path, on any chain that permits one.
///
/// ## The two things this is not
///
/// **It is not a market price.** Hedera's rate is governed by the council and
/// updated on the network's own schedule; Chainlink's is aggregated from
/// exchanges. They do not agree, and the size of the disagreement is recorded
/// rather than waved at: on 2026-09-07 Chainlink read 8.305103 cents and this
/// read 8.064133, a difference of about 2.9 percent.
///
/// **It cannot go stale, so `updatedAt` is `block.timestamp` and that is not a
/// lie by omission.** There is no last-update to report: the rate is consensus
/// state that every transaction in the block is already priced against, so a
/// timestamp older than now would be a fiction and a heartbeat over it would
/// never bind. What replaces staleness as the risk on this seat is divergence
/// from the market, which a heartbeat cannot express and which
/// `docs/RULEBOOK.md` section 4.2 states in words instead.
contract HederaRateFeed is AggregatorV3Interface {
    /// @notice HIP-475. `src/interfaces/IExchangeRate.sol`.
    address public constant EXCHANGE_RATE = address(0x168);

    /// @notice Eight, matching every Chainlink feed on this chain.
    /// @dev `PrimeOracle._requireEightDecimals` refuses anything else, so this
    ///      constant is what makes the adapter seatable at all.
    uint8 public constant DECIMALS = 8;

    /// @notice Tinybars handed to the system contract per conversion.
    /// @dev A million HBAR rather than one. The system contract converts by
    ///      integer multiply and divide, so a larger input leaves less of the
    ///      answer in the truncation; the division below scales it back. Chosen
    ///      to be large enough to matter and small enough that the product
    ///      cannot approach `uint256` at any rate the network could publish.
    uint256 internal constant PROBE_TINYBARS = 1e14;

    /// @dev `tinycents / (probe / 1e8) / 1e8` is cents per HBAR, and USD is that
    ///      over a hundred, so eight decimals of USD is `tinycents * 1e6 /
    ///      probe`. Folded into one constant so the read is one multiply and one
    ///      divide rather than four.
    uint256 internal constant SCALE = 1e6;

    /// @notice There are no historical rounds to return.
    error NoHistory();
    /// @notice `0x168` did not answer, or answered with something else.
    error RateUnavailable();

    function decimals() external pure returns (uint8) {
        return DECIMALS;
    }

    function description() external pure returns (string memory) {
        return "HBAR / USD (Hedera network exchange rate, 0x168)";
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    /// @notice USD per HBAR, eight decimals, as of this block.
    /// @dev `roundId` and `answeredInRound` are both one and are equal, which is
    ///      the shape a consumer checks: an answer here is never carried forward
    ///      from an earlier round because there are no rounds. `startedAt` and
    ///      `updatedAt` are both now, for the reason in the header.
    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (1, int256(usdPerHbar()), block.timestamp, block.timestamp, 1);
    }

    /// @dev Refused rather than answered. A consumer asking for a past round
    ///      that got today's price back would have no way to know, and this
    ///      adapter has no history to give it. Chainlink's own convention is to
    ///      revert on a round it does not hold.
    function getRoundData(uint80) external pure returns (uint80, int256, uint256, uint256, uint80) {
        revert NoHistory();
    }

    /// @notice USD per HBAR at eight decimals, straight off `0x168`.
    /// @dev Reached by `staticcall` because `IExchangeRate` declares its
    ///      conversions non-view. The static context is the assertion that the
    ///      call does not write; annotating the interface `view` would be
    ///      asserting the same thing without checking it.
    ///
    ///      A failure reverts rather than returning zero.
    ///      `PrimeOracle._cash` wraps this seat in a `try` and reads a revert as
    ///      a dark leg, which is the correct degradation and the one the venue
    ///      already has a fallback for.
    function usdPerHbar() public view returns (uint256) {
        (bool ok, bytes memory ret) = EXCHANGE_RATE.staticcall(
            abi.encodeWithSignature("tinybarsToTinycents(uint256)", PROBE_TINYBARS)
        );
        if (!ok || ret.length != 32) revert RateUnavailable();
        uint256 tinycents = abi.decode(ret, (uint256));
        if (tinycents == 0) revert RateUnavailable();
        return (tinycents * SCALE) / PROBE_TINYBARS;
    }

    /// @notice The raw answer, for anyone checking the arithmetic above.
    function tinycentsPer(uint256 tinybars) external view returns (uint256) {
        (bool ok, bytes memory ret) = EXCHANGE_RATE.staticcall(
            abi.encodeWithSignature("tinybarsToTinycents(uint256)", tinybars)
        );
        if (!ok || ret.length != 32) revert RateUnavailable();
        return abi.decode(ret, (uint256));
    }
}
