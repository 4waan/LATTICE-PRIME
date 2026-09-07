// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title IExchangeRate
/// @notice Hedera's exchange rate system contract, HIP-475, at `0x168`.
/// @dev Apache 2.0, copyright Hedera Hashgraph LLC and the Hiero contributors,
///      from the hedera-smart-contracts repository. Two signatures, unmodified.
///      Declared in `NOTICE` with the rest of the third-party code.
///
///      **Both are declared non-view upstream and both are conversions.** The
///      declaration is Hedera's and is kept as Hedera wrote it rather than
///      quietly softened to `view`, because a caller reading this file should
///      see the interface the network publishes. `HederaRateFeed` reaches them
///      through an explicit `staticcall` instead, which is the honest way to
///      assert that the call does not write: if it ever did, the static context
///      would refuse it rather than a `view` annotation silently permitting it.
///
///      A tinycent is `1e-8` of a US cent, the way a tinybar is `1e-8` of an
///      HBAR.
interface IExchangeRate {
    function tinycentsToTinybars(uint256 tinycents) external returns (uint256);

    function tinybarsToTinycents(uint256 tinybars) external returns (uint256);
}
