// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title ICashToken
/// @notice The cash asset a coupon settles in, as the EVM sees it.
/// @dev **Deliberately three functions and not ERC-20.** What sits behind this
///      on chain 296 is a Hedera Token Service fungible token, reached through
///      the ERC-20 facade every HTS token exposes at its own EVM address. HTS is
///      the ledger of record for it; the facade is a view onto that ledger, not
///      a Solidity token contract. Declaring the full standard here would
///      advertise `approve` and an allowance model that this venue's paying
///      agent never uses and that HTS implements with its own semantics.
///
///      What the distributor needs is the balance it holds and the ability to
///      push funds out. It never pulls, so there is no `transferFrom` and no
///      approval anywhere on the coupon path: the issuer funds the distributor
///      by sending, which is one transaction on HTS and needs no EVM
///      permission at all.
///
///      `decimals` is here because the tariff and the deployment record both
///      quote a face value in this token's smallest unit, and a face value whose
///      scale is assumed rather than read is the class of bug
///      `PrimeOracle._requireEightDecimals` exists to refuse.
///
/// ## The custom fee is not on this interface, and that is the point
///
/// The paying agent's charge is a **fractional custom fee on the token itself**,
/// collected by HTS during the transfer below. There is no EVM bookkeeping for
/// it here, no fee arithmetic to get wrong, and nothing for this repository to
/// argue is correct. The charge either is on the token's fee schedule or it is
/// not, and a reader checks it against the chain.
/// `spikes/d02-atomicity/fractional-fee.js` measured the behaviour with three
/// distinct parties before any of this was built.
///
/// The one thing that arrangement can get wrong is *which side* pays, and
/// `CouponDistributor.claim` refuses rather than absorbs it. See there.
interface ICashToken {
    function balanceOf(address account) external view returns (uint256);

    /// @notice Push `amount` to `to`. Returns false rather than reverting on a
    ///         standard-conformant token; the caller checks.
    function transfer(address to, uint256 amount) external returns (bool);

    function decimals() external view returns (uint8);
}
