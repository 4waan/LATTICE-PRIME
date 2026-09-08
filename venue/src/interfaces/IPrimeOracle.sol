// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {AggregatorV3Interface} from "./AggregatorV3Interface.sol";

/// @title IPrimeOracle
/// @notice What this venue needs from a price feed.
/// @dev Separate from `AggregatorV3Interface`, which `PrimeOracle` also
///      implements, because the two answer different questions. The Chainlink
///      shape answers "what is the clean price", in USD, for any consumer that
///      already speaks it. This one answers "may I act on it, and what is it
///      worth in the unit this venue settles in", which is a question about two
///      feeds at once and has no standard shape.
///
///      Two consumers and one interface. `RepoVault` uses the live composite
///      for collateral and `referenceRateBefore` for dated coupon fixings.
///      `MarginWatch` uses the diagnostic reads, because a client
///      cannot act on "the feed is dark" without being told which half of it
///      went dark and when. Splitting these into two interfaces was the
///      alternative and it buys a smaller dependency for the vault at the cost
///      of a second name for one contract.
interface IPrimeOracle {
    /// @notice True when the venue must not act on this feed.
    /// @dev Total, and never reverts, for `RepoVault.postMark`'s sake: the
    ///      manual seat opens exactly when this is true, so a `stale()` that
    ///      could revert would be a venue with no working mark at all. Covers
    ///      both legs. An upstream aggregator that reverts, returns a
    ///      non-positive answer, or has not answered inside its own heartbeat
    ///      reads as dark here rather than as a price.
    function stale() external view returns (bool);

    /// @notice The last finalised round of the venue's own publishers.
    /// @param cleanPrice USD per unit of face, eight decimals. Row 7.
    /// @param refRateBps The reference rate the variable coupon resets against,
    ///        in basis points. Row 7.
    /// @param publishedAt The block timestamp `finalize` landed in.
    /// @param round The round number, which is also the Chainlink round id.
    /// @dev **Not named `at`.** `ethers` v6 decodes a return tuple into a
    ///      `Result`, which is array-like, so a member called `at` resolves to
    ///      `Array.prototype.at` and a client reads a function where it expected
    ///      a timestamp. It fails at the first arithmetic, far from the cause.
    ///      `tools/gen-app.mjs` refuses to bundle an ABI carrying a name that
    ///      collides, so this cannot be reintroduced quietly.
    function latest()
        external
        view
        returns (uint128 cleanPrice, uint64 refRateBps, uint64 publishedAt, uint64 round);

    /// @notice The last valid reference-rate round strictly before `cutoff`.
    /// @dev Strictly before avoids a same-second race in which two callers could
    ///      observe different rounds finalized at the coupon timestamp.
    function referenceRateBefore(uint64 cutoff)
        external
        view
        returns (uint64 refRateBps, uint64 publishedAt, uint64 round);

    /// @notice Tinybars per unit of face, both legs composed.
    /// @dev Reverts rather than returning a number when either leg is dark.
    ///      Acting on an old price is the failure that matters here, and a
    ///      margin call is not a place to be optimistic.
    function markPerUnitTinybar() external view returns (uint256);

    /// @notice The venue's own leg alone.
    /// @dev Split from `stale` because the two legs fail for different reasons
    ///      and a client saying "the feed is down" should be able to say which
    ///      one. Also total.
    function ourLegStale() external view returns (bool);

    /// @notice The upstream leg as the oracle reads it. Total.
    /// @param ok False whenever the venue must not act on it, for any of the
    ///        reasons a Chainlink consumer has to check.
    /// @param usdPerHbar Eight decimals, on the scale Chainlink set.
    function cashLeg()
        external
        view
        returns (bool ok, uint256 usdPerHbar, uint64 updatedAt);

    /// @notice The seated upstream feed. Whoever's it is, it is not the panel's.
    /// @dev Typed as Chainlink's interface rather than as an `address` so a
    ///      reader can see what shape the second leg has to have. What actually
    ///      sits there is a deployment decision: on Hedera it is
    ///      `HederaRateFeed` over the network's own rate, because Chainlink's
    ///      feeds here refuse a contract caller. `probes/chainlink-hedera.out`.
    function cashFeed() external view returns (AggregatorV3Interface);
}
