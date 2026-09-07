// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CallAuction} from "../src/market/CallAuction.sol";
import {PrimeOracle} from "../src/oracle/PrimeOracle.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {MockAggregator} from "./OracleFixture.sol";
import {OrderBook} from "../src/market/OrderBook.sol";
import {CouponMath} from "../src/coupon/CouponMath.sol";
import {CouponSchedule} from "../src/coupon/CouponSchedule.sol";
import {MerkleSet} from "../src/merkle/MerkleSet.sol";
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
    PrimeOracle internal oracle;

    function setUp() public {
        _deployPolicy(asDeployed());
        address[] memory panel = new address[](1);
        panel[0] = address(this);
        oracle = new PrimeOracle(
            params,
            address(this),
            AggregatorV3Interface(address(new MockAggregator(8_152_235, block.timestamp))),
            panel,
            1,
            7,
            6 hours,
            26 hours,
            500
        );
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

    // ---------------------------------------------------------- the fourth unit

    /// @notice A price is not a denomination of HBAR, and this is the fourth
    ///         quantity in a file that was written when there were three.
    /// @dev `tools/units.mjs` gained `PRICE_DECIMALS` beside the same claim.
    ///      A clean price of 1e10 is 100.00 **USD** per unit of face. It is not
    ///      100 HBAR and it is not 1e10 tinybars, and the reason it is worth a
    ///      test rather than a comment is that `formatHbar` on it prints
    ///      `100.00000000`, which is the right digits arrived at for the wrong
    ///      reason and is wrong the moment either scale moves.
    function test_aPriceIsNotADenominationOfHbar() public pure {
        uint256 par = 100_00000000;
        assertEq(par, 1e10, "100.00 USD at the feed's eight decimals");
        // The same digits, read as the two things they are not.
        assertEq(par / 1e8, 100, "read as HBAR this is a hundred, which it is not");
        assertGt(par, 1e8, "and read as tinybars it is a hundred HBAR, which it is not");
    }

    /// @notice The feed's scale is Chainlink's, and the contract holds it.
    /// @dev Measured rather than chosen: `probes/chainlink-hedera.out` reads
    ///      `decimals()` off all seven Chainlink feeds on chain 296 and every one
    ///      answers eight. `PrimeOracle._requireEightDecimals` refuses anything
    ///      else rather than normalising, which is what keeps a second price
    ///      scale out of this repository.
    function test_theFeedScaleIsTheOneChainlinkPublishesOnThisChain() public view {
        assertEq(oracle.DECIMALS(), 8, "the venue's leg");
        assertEq(oracle.decimals(), 8, "and the Chainlink surface it answers on");
        assertEq(oracle.cashFeed().decimals(), 8, "and the upstream leg it composes with");
    }

    /// @notice The composite mark, as a literal, in both directions.
    /// @dev The client's copy is `tools/units.mjs markPerUnitTinybar` and its
    ///      vectors come out of `test/fixtures/median.json`, which
    ///      `probes/oracle-median.py` wrote and `PrimeOracle.t.sol` replays. This
    ///      one is written by hand so that the two generated halves are checked
    ///      against a third thing that is neither of them.
    ///
    ///      100.00 USD per unit of face, at HBAR/USD of 0.08152235, is
    ///      1226.65747491 HBAR per unit. The venue holds that as tinybars.
    function test_theCompositeMarkInBothDirections() public pure {
        uint256 cleanPrice = 100_00000000;
        uint256 usdPerHbar = 8_152_235;

        uint256 markPerUnit = (cleanPrice * 1e8) / usdPerHbar;
        assertEq(markPerUnit, 122_665_747_491, "tinybars per unit of face");
        assertEq(markPerUnit / 1e8, 1_226, "which is about 1,226 HBAR");

        // Back the other way, to within the floor the division takes.
        assertApproxEqAbs((markPerUnit * usdPerHbar) / 1e8, cleanPrice, 1, "and it inverts");

        // A thousand units, which is the lot `MarkToMarket.t.sol` opens with.
        assertEq(markPerUnit * 1_000, 122_665_747_491_000, "the whole mark, tinybars");
    }
}

/// @title CouponVectorsTest
/// @notice The contract half of `tools/units.mjs`'s coupon block.
///
/// Same arrangement as `UnitVectorsTest` above and same reason: both files carry
/// the literals and neither computes the other's. A screen that shows a holder
/// what a coupon will pay does the arithmetic in JavaScript; the vault does it in
/// Solidity out of `CouponSchedule` and `PrimeOracle`; and the two agreeing is a
/// property somebody has to check rather than one that follows from both being
/// "the same formula".
///
/// The five vectors are chosen, not sampled. One divides cleanly, so a rounding
/// bug is a whole unit of the cash token rather than noise. One floors to
/// nothing, which is the direction that matters here and the opposite of the one
/// `RepoMath` takes. Two are the deployed shape at two different references, so
/// the spread is shown to be additive rather than a multiplier. The fifth is the
/// cap, refused rather than clamped.
contract CouponVectorsTest is Test {
    /// @dev `script/DeployVenue.s.sol`, the coupon constants block.
    uint16 internal constant SPREAD_BPS = 75;
    uint128 internal constant FACE_VALUE = 10_000;
    uint64 internal constant QUARTER = 91 days;

    /// @dev What round one on chain 296 medianed to.
    uint64 internal constant REF_RATE_BPS = 425;

    /// @dev The bond's `maxSupply`. `deployments/296-venue.json` `token`.
    uint256 internal constant WHOLE_ISSUE = 1_000_000;

    CouponSchedule internal schedule;

    function setUp() public {
        vm.warp(1_000_000);
        uint64[] memory dates = new uint64[](2);
        dates[0] = uint64(block.timestamp) + QUARTER;
        dates[1] = uint64(block.timestamp) + QUARTER * 2;
        schedule = new CouponSchedule(
            uint64(block.timestamp), dates, SPREAD_BPS, FACE_VALUE, CouponMath.Basis.ACT_365
        );
    }

    function test_theConstantsAreTheOnesTheClientCarries() public pure {
        assertEq(CouponMath.BPS, 10_000, "tools/units.mjs BPS");
        assertEq(CouponMath.YEAR, 31_536_000, "COUPON_YEAR, and never a calendar year");
        assertEq(CouponMath.MAX_RATE_BPS, 10_000, "MAX_RATE_BPS");
    }

    function test_theSpreadIsAdditiveAndTheReferenceCanGoToZero() public pure {
        assertEq(CouponMath.couponBps(0, SPREAD_BPS), 75);
        assertEq(CouponMath.couponBps(REF_RATE_BPS, SPREAD_BPS), 500);
    }

    function test_aFullYearAtACleanRateIsExact() public pure {
        assertEq(
            CouponMath.accrue(100, 10_000, 500, 0, 365 days, CouponMath.Basis.ACT_365), 50_000
        );
    }

    /// @notice The floor, which is the direction that matters.
    function test_aFractionOfOneUnitFloorsToNothing() public pure {
        assertEq(CouponMath.accrue(1, 100, 425, 0, 1 days, CouponMath.Basis.ACT_365), 0);
    }

    /// @notice The whole issue over one quarter, at two references.
    /// @dev Through `amountFor` rather than through `accrue`, so the period and
    ///      the spread come off the schedule the way `RepoVault.noteCoupon` takes
    ///      them, and the vector covers the composition rather than the library.
    function test_theDeployedShapeAtTwoReferences() public view {
        assertEq(schedule.amountFor(0, REF_RATE_BPS, WHOLE_ISSUE), 124_657_534);
        assertEq(schedule.amountFor(0, 175, WHOLE_ISSUE), 62_328_767);
    }

    function test_aRateOverTheCapIsRefusedNotClamped() public {
        vm.expectRevert(
            abi.encodeWithSelector(CouponMath.RateTooLarge.selector, uint256(10_001))
        );
        this.callCouponBps(10_000, 1);
    }

    function callCouponBps(uint64 r, uint16 s) external pure returns (uint256) {
        return CouponMath.couponBps(r, s);
    }
}

/// @title EntitlementVectorsTest
/// @notice The contract half of `tools/entitlements.mjs`.
/// @dev Same arrangement as `CouponVectorsTest` above: both files carry the same
///      literals and neither computes the other's. It matters more here than it
///      does for the arithmetic, because the failure mode is silent. A client
///      that builds this tree with a library that **sorts pairs** or
///      **duplicates the odd node**, which is what nearly every merkle library
///      does, produces a root the distributor will not recognise and proofs it
///      refuses with `BadProof`, and nothing in the revert says the shape was
///      wrong. These literals are where that gets caught, off chain, before a
///      declaration is funded against a root nobody can claim from.
contract EntitlementVectorsTest is Test {
    address internal constant H1 = address(0x111);
    address internal constant H2 = address(0x222);
    address internal constant H3 = address(0x333);

    bytes32 internal constant DOMAIN_LEAF = keccak256("hedera2026.coupon.entitlement.leaf.v1");
    bytes32 internal constant DOMAIN_NODE = keccak256("hedera2026.coupon.entitlement.node.v1");

    /// @notice The two published tags, as `tools/entitlements.mjs` exports them.
    function test_theDomainTags() public pure {
        assertEq(
            DOMAIN_LEAF,
            0x8f66f67a98507050e4159cde36e2efabb01a5475db27d2d12245fdc676967b56,
            "DOMAIN_LEAF"
        );
        assertEq(
            DOMAIN_NODE,
            0xab9aa7d0323f49a3026d7125010067e19dada5e943630e4a6224488aedb6c125,
            "DOMAIN_NODE"
        );
    }

    /// @notice One leaf, twice, at two coupon indices.
    /// @dev The pair is the vector for the scope rule. Same holder, same amount,
    ///      different coupon, and the two leaves must not be equal, because a
    ///      client that dropped the index would build a tree whose proofs cross
    ///      between coupons. `test_aProofFromAnotherCouponIsRefused` is the same
    ///      claim against the distributor.
    function test_theLeafCarriesTheCouponIndex() public pure {
        bytes32 zero = MerkleSet.leafOf(DOMAIN_LEAF, 0, _w(H1), 1_000);
        bytes32 one = MerkleSet.leafOf(DOMAIN_LEAF, 1, _w(H1), 1_000);
        assertEq(
            zero, 0x051895e0779b153467b79dcdb750d3ee07afb31601303dbd0eb01a34f9d0b5ac, "index 0"
        );
        assertEq(
            one, 0xc4a60d40b351823c9aa638b61820b0e05858e44f23374ee54ec99fa3bc3db88e, "index 1"
        );
        assertTrue(zero != one, "the index is not in the leaf");
    }

    /// @notice A tree of one. The root is the leaf and the proof is empty.
    function test_aTreeOfOne() public pure {
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = MerkleSet.leafOf(DOMAIN_LEAF, 0, _w(H1), 1_000);
        assertEq(
            MerkleSet.rootOfLeaves(DOMAIN_NODE, leaves),
            0x051895e0779b153467b79dcdb750d3ee07afb31601303dbd0eb01a34f9d0b5ac
        );
    }

    /// @notice A tree of two, at a non-zero index, and the node above it.
    function test_aTreeOfTwo() public pure {
        bytes32 l0 = MerkleSet.leafOf(DOMAIN_LEAF, 7, _w(H1), 1);
        bytes32 l1 = MerkleSet.leafOf(DOMAIN_LEAF, 7, _w(H2), 2);
        assertEq(
            MerkleSet.nodeOf(DOMAIN_NODE, l0, l1),
            0x2431103dde7824e986ccfb90a532e941c9f222c9a904ec93747adfff1c2cbe0b
        );
    }

    /// @notice The odd tree, which is the one that separates the two disciplines.
    /// @dev Three leaves. Position 2 is promoted at the leaf level, so its proof
    ///      is **one** element and the other two need **two**. A library that
    ///      duplicated the odd node would hand back two elements for every
    ///      position and a different root.
    function test_theOddTreeAndItsThreeProofs() public view {
        bytes32 root = 0x80ff7e014666963a7a9d4cec7d4a9519d96a22f27e249ea04ae51f35a202a4a9;
        assertEq(_root3(), root, "the three-leaf root");

        bytes32[] memory p0 = new bytes32[](2);
        p0[0] = 0xf84280408334aef6e4e77c3892cef0a2d36898ce41d35cd3a67df41a49c1ab7f;
        p0[1] = 0xbf9f306ac8a0e41aa2b8346a47be87a8c90bb6720d623074cb44f973b6bbb9f1;

        bytes32[] memory p1 = new bytes32[](2);
        p1[0] = 0x051895e0779b153467b79dcdb750d3ee07afb31601303dbd0eb01a34f9d0b5ac;
        p1[1] = 0xbf9f306ac8a0e41aa2b8346a47be87a8c90bb6720d623074cb44f973b6bbb9f1;

        bytes32[] memory p2 = new bytes32[](1);
        p2[0] = 0x4ccfa27f6569a8ce693d5349330117327792645be5c972a55b525b8843346632;

        assertTrue(this.check(root, _leaf3(H1, 1_000), 0, 3, p0), "position 0");
        assertTrue(this.check(root, _leaf3(H2, 2_500), 1, 3, p1), "position 1");
        assertTrue(this.check(root, _leaf3(H3, 4_500), 2, 3, p2), "position 2");

        // The promoted path is shorter, and the verifier refuses the padding a
        // duplicating library would have produced rather than ignoring it.
        bytes32[] memory padded = new bytes32[](2);
        padded[0] = p2[0];
        padded[1] = p2[0];
        assertFalse(this.check(root, _leaf3(H3, 4_500), 2, 3, padded), "an unused tail passed");

        // And the width is not redundant, though only a promoted path shows it.
        // Position 2's proof verifies against the three-leaf shape the
        // declaration pinned and fails against a four-leaf one, because the
        // width is what decides whether this level consumes an element at all.
        // Positions 0 and 1 walk the same two levels under either width, which
        // is why `declare` pins the width rather than letting a claimant assert
        // it: the paths that would notice are exactly the ones an attacker
        // would not choose.
        assertFalse(this.check(root, _leaf3(H3, 4_500), 2, 4, p2), "the width was ignored");
    }

    /// @dev `verify` takes `calldata`, so the vectors reach it through an
    ///      external call on this contract rather than through a memory array.
    function check(
        bytes32 root,
        bytes32 leaf,
        uint256 position,
        uint256 width,
        bytes32[] calldata proof
    ) external pure returns (bool) {
        return MerkleSet.verify(root, DOMAIN_NODE, leaf, position, width, proof);
    }

    function _w(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _leaf3(address holder, uint256 amount) internal pure returns (bytes32) {
        return MerkleSet.leafOf(DOMAIN_LEAF, 0, _w(holder), amount);
    }

    function _root3() internal pure returns (bytes32) {
        bytes32[] memory leaves = new bytes32[](3);
        leaves[0] = _leaf3(H1, 1_000);
        leaves[1] = _leaf3(H2, 2_500);
        leaves[2] = _leaf3(H3, 4_500);
        return MerkleSet.rootOfLeaves(DOMAIN_NODE, leaves);
    }
}
