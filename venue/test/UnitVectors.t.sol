// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CallAuction} from "../src/market/CallAuction.sol";
import {OrderBook} from "../src/market/OrderBook.sol";
import {PolicyFixture} from "./PolicyFixture.sol";

/// @title UnitVectorsTest
/// @notice The contract half of `tools/units.mjs`. Both files carry the same
///         literals and neither computes the other's, which is the arrangement
///         `CommitmentVectors.t.sol` and `tools/commitment.test.mjs` already
///         use for the order preimage.
///
/// **The venue was deployed once with `commitBond` at `0.01 ether`.** `msg.value`
/// inside the Hedera EVM is tinybars, so that literal asked for a hundred
/// million HBAR, every `commit` reverted `WrongBond(1000000,
/// 10000000000000000)`, and `Regime.bootstrapSupervisor` being single use meant
/// the whole governed stack had to come down. Nothing in `src/` was wrong. The
/// number was in the wrong unit, in a place no test looked.
///
/// This is where a test looks. Every literal below is read out of
/// `deployments/296-venue.json`: the market parameters from `venue.market`, the
/// trade from `evidence`. If the client's arithmetic and the contract's ever
/// disagree, one of the two suites fails rather than a bond being lost.
contract UnitVectorsTest is Test, PolicyFixture {
    /// @dev `venue.market`, 296-venue.json.
    uint256 internal constant COMMIT_BOND = 1_000_000;
    uint256 internal constant CANCEL_FEE = 100_000;
    uint64 internal constant REVEAL_DELAY = 30;
    uint64 internal constant REVEAL_WINDOW = 270;
    uint64 internal constant ROUND_LENGTH = 300;
    uint64 internal constant REST_ROUNDS = 2;

    /// @dev The relay divides a transaction's `value` by this before the EVM
    ///      sees it. Measured at two points and recorded in
    ///      `superseded.why`: 1e18 weibar arrives as 1e8, 5e18 as 5e8.
    uint256 internal constant WEIBAR_PER_TINYBAR = 1e10;

    OrderBook internal book;

    function setUp() public {
        _deployPolicy(asDeployed());
        book = new OrderBook(
            REVEAL_DELAY,
            REVEAL_WINDOW,
            COMMIT_BOND,
            CANCEL_FEE,
            params,
            ROUND_LENGTH,
            REST_ROUNDS
        );
    }

    /// @notice The deployed market parameters, as the contract holds them.
    /// @dev The claim is not that these are good numbers. It is that they are
    ///      **tinybars**, which is the only claim the redeployment turned on.
    function test_theMarketParametersAreTheDeployedOnes() public view {
        assertEq(book.commitBond(), COMMIT_BOND, "commitBond, tinybar");
        assertEq(book.cancelFee(), CANCEL_FEE, "cancelFee, tinybar");
        assertEq(book.revealDelay(), REVEAL_DELAY, "seconds");
        assertEq(book.revealWindow(), REVEAL_WINDOW, "seconds");
        assertEq(book.roundLength(), ROUND_LENGTH, "seconds");
        assertEq(book.restRounds(), REST_ROUNDS, "rounds");
    }

    /// @notice The bond in HBAR is a hundredth of one, and the failed deployment
    ///         asked for a hundred million.
    /// @dev The arithmetic that would have caught it, written down. `0.01 ether`
    ///      is 1e16, and 1e16 tinybars is 1e8 HBAR. The venue holds 1e6 tinybars,
    ///      which is 0.01 HBAR. Ten orders of magnitude, and the two literals
    ///      look alike in a diff.
    function test_theBondIsAHundredthOfOneHbarAndNotAHundredMillion() public pure {
        assertEq(COMMIT_BOND * WEIBAR_PER_TINYBAR, 0.01 ether, "the correct value field");
        assertEq(uint256(0.01 ether) / 1e8, 100_000_000, "what the failed deployment asked for");
    }

    /// @notice `CallAuction.notional` against the recorded cross.
    /// @dev `evidence.reveals.quote` is `priceTwice 200, volume 1000` and
    ///      `evidence.cross` records a clearing price of 100. The notional is
    ///      100,000 tinybars and `tools/units.mjs` carries the same three numbers.
    function test_theRecordedCrossMultipliesOut() public pure {
        assertEq(CallAuction.notional(200, 1_000), 100_000, "priceTwice x qty / 2");
        // `evidence.cross.sellerCredit`: proceeds plus the bond returned.
        assertEq(CallAuction.notional(200, 1_000) + COMMIT_BOND, 1_100_000, "sellerCredit");
        // `evidence.cross.buyerCredit`: the overpayment plus the bond. The buyer
        // escrowed at their own limit of 105 and paid at 100.
        assertEq(
            uint256(105) * 1_000 - CallAuction.notional(200, 1_000) + COMMIT_BOND,
            1_005_000,
            "buyerCredit"
        );
    }

    /// @notice Halving `priceTwice` before multiplying loses the odd interval.
    /// @dev **This is why the contract returns twice the price at all.** The
    ///      uniform price is the midpoint of the maximiser interval, and an
    ///      interval of odd width has a midpoint that is not an integer, so
    ///      there is no rounded price to return. A client that divides first and
    ///      multiplies second is short by `qty / 2` on every such round, which is
    ///      a real amount of money and never a rounding artefact.
    function test_halvingBeforeMultiplyingLosesTheOddInterval() public pure {
        assertEq(CallAuction.notional(201, 1_000), 100_500, "the contract's order");
        assertEq((uint256(201) / 2) * 1_000, 100_000, "the client's, if it halves first");
        assertEq(CallAuction.notional(201, 1_000) - (uint256(201) / 2) * 1_000, 500, "the loss");
    }

    /// @notice A quantity carries no decimals, so scaling one is never right.
    /// @dev `token.decimals` is 0 and `token.maxSupply` is 1,000,000 in
    ///      296-venue.json. `formatUnits(1000, 8)` is `0.00001`, which is the
    ///      shape of the mistake: a plausible number rather than an error.
    function test_aQuantityIsACountAndNotAFixedPointNumber() public pure {
        uint256 qty = 1_000;
        assertEq(qty, 1_000, "a thousand bonds");
        assertEq(qty * 1e8, 100_000_000_000, "what an eight decimal scale would send");
        // And the engine would refuse it, because the seller's hold cannot cover
        // a hundred billion units of a million unit issue.
        assertGt(qty * 1e8, 1_000_000, "past the whole supply");
    }

    /// @notice The buy escrow is exactly `price * qty` tinybars.
    /// @dev `MatchingEngine.reveal` refuses `WrongEscrow(sent, want)` on anything
    ///      else, so this multiplication is the whole of the buyer's arithmetic
    ///      and no scaling enters it: price is tinybars per bond and qty is a
    ///      count.
    function test_theBuyEscrowIsPriceTimesQuantity() public pure {
        assertEq(uint256(105) * 1_000, 105_000, "tinybars, at the buyer's own limit");
        assertEq(
            uint256(105) * 1_000 * WEIBAR_PER_TINYBAR, 1_050_000_000_000_000, "value field"
        );
    }
}
