// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ParameterRoot} from "../src/policy/ParameterRoot.sol";
import {IDisclosurePolicy} from "../src/interfaces/IDisclosurePolicy.sol";
import {ICouponSchedule} from "../src/interfaces/ICouponSchedule.sol";
import {ICashToken} from "../src/interfaces/ICashToken.sol";
import {CouponSchedule} from "../src/coupon/CouponSchedule.sol";
import {CouponDistributor} from "../src/coupon/CouponDistributor.sol";

/// @title DeployCoupon
/// @notice The paying leg. One contract, against a calendar and a cash token
///         that both already exist.
///
/// **Deliberately not folded into `DeployVenue`.** That script puts up a whole
/// venue from nothing, and the cash token is the one input it cannot create:
/// an HTS fungible token with a fractional custom fee is made by a receipted
/// HTS transaction and not by a Solidity `new`, so a distributor deployed
/// inside `DeployVenue` would either take a zero address or force every fresh
/// deployment to have arranged an unrelated token first. This script is the
/// seam between the two. `DeployVenue` prints `couponSchedule`; the token
/// creation prints its own address; this takes both and refuses if either is
/// missing.
///
/// The refusal is the point of the environment reads below. A cash token
/// silently defaulting to zero would deploy a distributor that reverts on the
/// first claim, months after the deployment that caused it, and
/// `CouponDistributor`'s own constructor guard would catch only the zero and
/// not the wrong one. So the checks are here, where the transaction that would
/// be wrong has not been sent yet.
///
/// ```
///   VENUE_PARAMS      the parameter root the venue already governs
///   COUPON_SCHEDULE   the calendar `DeployVenue` printed
///   CASH_TOKEN        the HTS fungible token coupons are paid in
///   COUPON_ISSUER     who may declare. Defaults to the broadcaster.
/// ```
contract DeployCoupon is Script {
    /// @notice A required address was not in the environment.
    error Unset(string key);

    /// @notice The cash token does not carry the decimals the venue prices in.
    /// @dev Two, because `deployments/296-venue.json` records the bond at
    ///      `nominalValue: "100.00"` and `CouponSchedule.faceValue` is that
    ///      number in the cash token's smallest unit. A token with a different
    ///      scale pays every coupon off by a factor of a hundred and nothing on
    ///      chain would say so, because the arithmetic is correct in units and
    ///      only the units are wrong.
    error WrongDecimals(uint8 got, uint8 want);

    /// @notice The schedule at `COUPON_SCHEDULE` has no coupons.
    /// @dev Cheap, and it catches the address that points at the wrong contract
    ///      rather than at no contract. `count()` on something that is not a
    ///      schedule either reverts or answers zero, and both fail here.
    error EmptySchedule(address schedule);

    uint8 internal constant CASH_DECIMALS = 2;

    /// @notice How long a declared coupon stays claimable before the residue
    ///         goes back to the issuer.
    /// @dev Thirty days. Long enough that a holder who is not watching the chain
    ///      is not disinherited by a weekend, short enough that the issuer is
    ///      not funding an open-ended obligation. It is a published number with
    ///      no derivation behind it and it is marked as one, in the register
    ///      `RepoVault.penaltyRate` uses.
    uint64 internal constant CLAIM_WINDOW = 30 days;

    /// @notice The paying agent's charge, in basis points.
    /// @dev Twenty-five, which is what `spikes/d02-atomicity/fractional-fee.js`
    ///      measured against a live HTS fractional fee. **This constant does not
    ///      charge anything**: the charge is on the cash token's own fee
    ///      schedule and HTS collects it. What the number is for is the tariff
    ///      line in `docs/RULEBOOK.md` §8, which names a `(source, reader)` pair
    ///      so a reader can check the published charge against the chain rather
    ///      than against the document. `CouponDistributor.payingAgentFeeBps`
    ///      carries the rest of that argument.
    ///
    ///      Publishing it and setting it are separate acts, and this script only
    ///      does the first. Whether the token's live fee schedule agrees is what
    ///      `make client` reads off the mirror node.
    uint256 internal constant PAYING_AGENT_FEE_BPS = 25;

    function run() external {
        uint256 pk = vm.envUint("HEDERA_PRIVATE_KEY");
        address me = vm.addr(pk);

        ParameterRoot params = ParameterRoot(_required("VENUE_PARAMS"));
        CouponSchedule schedule = CouponSchedule(_required("COUPON_SCHEDULE"));
        ICashToken cash = ICashToken(_required("CASH_TOKEN"));
        address issuer = vm.envOr("COUPON_ISSUER", me);

        // --- the two reads that make the refusal worth having. Both are static
        //     calls on contracts that already exist, so neither costs a
        //     broadcast, and both fail before `vm.startBroadcast`.
        if (schedule.count() == 0) revert EmptySchedule(address(schedule));

        uint8 decimals = cash.decimals();
        if (decimals != CASH_DECIMALS) revert WrongDecimals(decimals, CASH_DECIMALS);

        vm.startBroadcast(pk);

        CouponDistributor distributor = new CouponDistributor(
            IDisclosurePolicy(address(params)),
            ICouponSchedule(address(schedule)),
            cash,
            issuer,
            CLAIM_WINDOW,
            PAYING_AGENT_FEE_BPS
        );

        vm.stopBroadcast();

        console2.log("couponDistributor", address(distributor));
        console2.log("  schedule       ", address(distributor.schedule()));
        console2.log("  cash           ", address(distributor.cash()));
        console2.log("  cashDecimals   ", decimals);
        console2.log("  issuer         ", distributor.issuer());
        console2.log("  claimWindow    ", distributor.claimWindow());
        console2.log("  agentFeeBps    ", distributor.payingAgentFeeBps());
        console2.log("  coupons        ", schedule.count());
        console2.log("  firstCoupon    ", schedule.dateOf(0));
    }

    /// @dev `vm.envAddress` reverts on an unset key with a message about the
    ///      environment, which is true and does not say which of this script's
    ///      four inputs was missing. `vm.envOr` plus a named error does.
    function _required(string memory key) internal view returns (address a) {
        a = vm.envOr(key, address(0));
        if (a == address(0)) revert Unset(key);
    }
}
