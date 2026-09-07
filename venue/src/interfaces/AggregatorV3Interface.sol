// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AggregatorV3Interface
/// @notice Chainlink's data feed interface, vendored verbatim. **Not our work.**
/// @dev MIT, copyright SmartContract Chainlink Limited SEZC. Taken from the
///      npm package "chainlink slash contracts", file
///      `src/v0.8/shared/interfaces/AggregatorV3Interface.sol`, unmodified.
///      Declared in `NOTICE` with the rest of the third-party code. The package
///      name is spelled out rather than written with its leading at-sign
///      because solc parses that as a documentation tag and refuses the file.
///
/// ## Why this file is here, and what happened to the plan behind it
///
/// The venue needs two prices and it is only entitled to publish one of them.
/// The bond's clean price is a private instrument nobody else quotes, so the
/// venue's own seated publishers are the only possible source and `PrimeOracle`
/// medians them. HBAR/USD is not, so the design read it off Chainlink, which
/// does run that feed on Hedera.
///
/// **It cannot be read from a contract.** Chainlink's proxies here are access
/// controlled, and the controller admits a caller only when it is allowlisted or
/// when `msg.sender == tx.origin`. An externally owned account sees a price; a
/// contract sees `No access`. Measured on testnet and on mainnet, all seven
/// feeds, in `probes/chainlink-hedera.out`. `decimals()` is *not* gated, which
/// is why `PrimeOracle`'s constructor seated one happily and the failure only
/// arrived at the first margin call.
///
/// So this interface stays, and it is load-bearing in both directions.
///
/// - `PrimeOracle` **implements** it, so the venue's own clean price is readable
///   by anything that already speaks Chainlink. The shape is not ours to invent.
/// - `PrimeOracle` **consumes** it on the cash-leg seat, which is a governed
///   address rather than a hard-coded one. On Hedera that seat holds
///   `HederaRateFeed`, an adapter over the network's own exchange rate at
///   `0x168`, which is contract-readable because being read by contracts is what
///   it is for. On a chain that permits a contract to read a Chainlink
///   aggregator, `proposeCashFeed` seats one with no code change.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);

    function description() external view returns (string memory);

    function version() external view returns (uint256);

    function getRoundData(uint80 _roundId)
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}
