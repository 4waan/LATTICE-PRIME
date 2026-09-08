// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RepoVault} from "../src/repo/RepoVault.sol";
import {RepoVaultBase} from "../src/repo/RepoVaultBase.sol";
import {RepoMath} from "../src/repo/RepoMath.sol";
import {CouponSchedule} from "../src/coupon/CouponSchedule.sol";
import {CouponMath} from "../src/coupon/CouponMath.sol";
import {DisclosureView} from "../src/lattice/DisclosureView.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {PolicyFixture} from "./PolicyFixture.sol";
import {CouponFixture} from "./CouponFixture.sol";
import {StubOracle} from "./OracleFixture.sol";
import {MockHolds} from "./AtsHolds.sol";
import {RepoFunding} from "./RepoFunding.sol";

/// @title NoteCouponTest
/// @notice The other half of section 02: what `RepoVault.noteCoupon` became once
///         a calendar existed for it to read.
///
/// The old signature was `noteCoupon(bytes32 id, bytes32 commitment)`. Any caller
/// handed the commitment in and the vault wrote it down. Nothing on chain
/// connected that value to a coupon date, to a rate, or to the bond: **the
/// commitment was asserted rather than derived**, and a manufactured payment is
/// the one number in a repo that both parties have an interest in.
///
/// The new signature takes an index and derives four things, none of which is
/// the caller's:
///
/// - the **date**, from `CouponSchedule`, fixed at issuance;
/// - the **period**, from `accrualStart`, so a caller cannot lengthen it;
/// - the **rate**, from `PrimeOracle`'s reference plus the schedule's spread;
/// - the **lot**, from this vault's own storage, written at `open`.
///
/// Section 1 below is the assertion that each of those four is genuinely read
/// rather than accepted. The rest is the boundary: which coupons belong to this
/// repo's term, what happens when the feed has nothing to say, and what a
/// scheduled call sees when it fires late.
///
/// `Repo.t.sol` keeps the lifecycle tests that route through a coupon.
/// `DisclosureMeter.t.sol` keeps the metering. This file is about the derivation.
contract NoteCouponTest is Test, PolicyFixture, CouponFixture, RepoFunding {
    StubOracle internal feed;
    MockHolds internal holds;
    RepoVault internal vault;

    address internal constant BORROWER = address(0xB0B);
    address internal constant LENDER = address(0x1EAD);
    address internal constant ENGINE = address(0xE49);

    bytes32 internal constant ID = keccak256("repo-coupon");
    bytes32 internal constant PARTITION = bytes32(uint256(1));

    uint256 internal constant PENALTY_RATE = 10;
    uint64 internal constant FAIL_GRACE = 5 days;
    uint64 internal constant CURE_WINDOW = 1 days;

    uint64 internal constant TERM = 30 days;
    uint256 internal constant LOT = 1_000e8;

    /// @dev What round one on chain 296 medianed to.
    ///      `deployments/296-venue.json` `venue.feed`.
    uint64 internal constant REF_RATE_BPS = 425;

    /// @dev A weekly calendar against a thirty day repo puts coupons 0 through 3
    ///      inside the term and coupon 4 past maturity, which is the boundary
    ///      section 2 is about, reachable without a second fixture.
    uint256 internal constant LAST_INSIDE = 3;
    uint256 internal constant FIRST_OUTSIDE = 4;

    function setUp() public {
        vm.warp(1_000_000);
        feed = new StubOracle();
        holds = new MockHolds();
        _deployPolicy(asDeployed());
        vault = new RepoVault(
            holds,
            ENGINE,
            feed,
            _deploySchedule(uint64(block.timestamp)),
            _newKycList(),
            params,
            PENALTY_RATE,
            FAIL_GRACE,
            CURE_WINDOW
        );
    }

    // ------------------------------------------------------- the fixtures

    function _open(bytes32 id, uint256 lot) internal {
        _openRepo(
            vault,
            feed,
            LENDER,
            BORROWER,
            id,
            RepoVault.Terms({
                partition: PARTITION,
                collateralAmount: lot,
                haircutBps: 200,
                maintenanceBps: 200,
                repoRateBps: 450,
                term: TERM
            })
        );
    }

    /// @dev The stub is dark at construction, which is what lets every suite
    ///      written before the feed keep testing the venue it was written
    ///      against. Turning it on is one call, and this file is one of the
    ///      places that has to.
    function _liveFeed(uint64 rateBps) internal {
        feed.setTerms(100e8, rateBps);
        feed.setMark(1);
    }

    /// @notice The coupon, computed here and not by the code under test.
    /// @dev **Deliberately not `CouponMath.accrue` and not
    ///      `schedule.amountFor`.** A test that called either would be asserting
    ///      that the vault calls the library, which it plainly does. What is
    ///      under test is that the four inputs are the ones the header names, so
    ///      the arithmetic is written out longhand from the published terms:
    ///      the vault's own lot, the schedule's face and spread, the oracle's
    ///      reference, and one weekly period at ACT/365.
    function _expected(uint256 lot, uint64 refRateBps, uint64 seconds_)
        internal
        pure
        returns (uint256)
    {
        return (lot * FACE_VALUE * (uint256(refRateBps) + SPREAD_BPS) * seconds_)
            / (10_000 * 365 days);
    }

    // ============================================ 1. derived, not asserted

    /// @notice The amount is the schedule, the feed and the vault's own lot.
    function test_theAmountIsDerivedFromTheScheduleTheFeedAndTheLot() public {
        _open(ID, LOT);
        _liveFeed(REF_RATE_BPS);
        vm.warp(couponSchedule.dateOf(0));

        uint256 owed = vault.noteCoupon(ID, 0);

        assertEq(owed, _expected(LOT, REF_RATE_BPS, COUPON_PERIOD), "longhand");
        assertGt(owed, 0, "and a coupon that accrued nothing would pass vacuously");
        assertEq(
            vault.repo(ID).lastCouponCommitment,
            vault.commitmentOf(ID, 0, owed),
            "the commitment binds the index and the amount together"
        );
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.OPEN));
    }

    /// @notice **The shape that took a caller's word is gone from the ABI.**
    /// @dev Not a stylistic assertion. While `noteCoupon(bytes32,bytes32)` still
    ///      answered, a client built against it would keep asserting commitments
    ///      and the derivation would be an unused code path next to a live one.
    ///      The selector moved from `0x2df30366` to `0x2bae2cde`, `tools/hcs.mjs`
    ///      carries the new one, and this is the check that the old door is shut
    ///      rather than merely unadvertised.
    function test_theOldShapeThatTookACallersWordIsGone() public {
        _open(ID, LOT);
        (bool ok,) = address(vault)
            .call(abi.encodeWithSelector(bytes4(0x2df30366), ID, keccak256("12500")));
        assertFalse(ok, "noteCoupon(bytes32,bytes32) is not answerable");

        // And the selector this venue does publish is the derived one.
        assertEq(RepoVault.noteCoupon.selector, bytes4(0x2bae2cde), "tools/hcs.mjs line 82");
    }

    /// @notice A delayed caller cannot replace the coupon-date fixing.
    /// @dev Both repos share one bond and one coupon. A newer rate published
    ///      after the due date may price a later coupon, but it cannot make this
    ///      coupon depend on which repo somebody happened to note first.
    function test_aRatePublishedAfterTheCouponDateCannotRewriteTheCoupon() public {
        bytes32 second = keccak256("repo-coupon-2");
        _open(ID, LOT);
        _open(second, LOT);
        uint64 due = couponSchedule.dateOf(0);
        vm.warp(due - 1);
        _liveFeed(REF_RATE_BPS);
        vm.warp(due);
        uint256 low = vault.noteCoupon(ID, 0);

        vm.warp(due + 1);
        _liveFeed(REF_RATE_BPS * 2);
        uint256 delayed = vault.noteCoupon(second, 0);

        assertEq(low, _expected(LOT, REF_RATE_BPS, COUPON_PERIOD));
        assertEq(delayed, low, "one coupon has one historical fixing");
    }

    /// @notice The lot is the vault's own, so two repos on one bond differ.
    function test_theLotIsTheVaultsOwnAndNotAnArgument() public {
        bytes32 small = keccak256("repo-small");
        _open(ID, LOT);
        _open(small, LOT / 4);
        _liveFeed(REF_RATE_BPS);
        vm.warp(couponSchedule.dateOf(0));

        assertEq(vault.noteCoupon(ID, 0), _expected(LOT, REF_RATE_BPS, COUPON_PERIOD));
        assertEq(vault.noteCoupon(small, 0), _expected(LOT / 4, REF_RATE_BPS, COUPON_PERIOD));
    }

    /// @notice The period is the schedule's, so the second coupon is not two.
    /// @dev A caller that could pick the accrual start could accrue the whole
    ///      term into one coupon. `accrualStart` is the previous coupon date, so
    ///      noting coupon 1 a fortnight in still pays one week of interest.
    function test_thePeriodIsTheSchedulesAndNotTheTimeSinceIssue() public {
        _open(ID, LOT);
        _liveFeed(REF_RATE_BPS);

        vm.warp(couponSchedule.dateOf(1));
        uint256 owed = vault.noteCoupon(ID, 1);

        assertEq(owed, _expected(LOT, REF_RATE_BPS, COUPON_PERIOD), "one period");
        assertLt(
            owed,
            _expected(LOT, REF_RATE_BPS, COUPON_PERIOD * 2),
            "and not everything since the dated date"
        );
    }

    /// @notice A coupon that accrues to nothing is refused rather than recorded.
    /// @dev Unreachable on the deployed calendar, which is why it needs its own
    ///      fixture: a weekly period on a lot of a thousand units accrues
    ///      hundreds of billions of the cash token's smallest unit. Make the
    ///      period one second and the lot one unit and `CouponMath.accrue` floors
    ///      to zero. Recording an observation of nothing would still be false.
    function test_aCouponThatAccruesToNothingIsRefused() public {
        uint64[] memory dates = new uint64[](1);
        dates[0] = uint64(block.timestamp) + 1;
        CouponSchedule tiny = new CouponSchedule(
            uint64(block.timestamp), dates, SPREAD_BPS, FACE_VALUE, CouponMath.Basis.ACT_365
        );
        RepoVault dust = new RepoVault(
            holds,
            ENGINE,
            feed,
            tiny,
            _newKycList(),
            params,
            PENALTY_RATE,
            FAIL_GRACE,
            CURE_WINDOW
        );

        uint256 dustMark = 100;
        uint256 principal = RepoMath.purchasePrice(dustMark, 200);
        vm.deal(LENDER, principal);
        feed.setMark(dustMark);
        vm.prank(LENDER);
        dust.fundOffer{value: principal}(
            ID,
            BORROWER,
            RepoVault.Terms({
                partition: PARTITION,
                collateralAmount: 1,
                haircutBps: 200,
                maintenanceBps: 200,
                repoRateBps: 450,
                term: TERM
            }),
            uint64(block.timestamp + 7 days)
        );
        holds.mint(PARTITION, BORROWER, 1);
        vm.prank(BORROWER);
        holds.approve(address(dust), 1);
        vm.prank(BORROWER);
        dust.accept(ID);
        feed.setDark(true);
        _liveFeed(REF_RATE_BPS);
        vm.warp(block.timestamp + 1);

        assertEq(_expected(1, REF_RATE_BPS, 1), 0, "the fixture really does floor");
        vm.expectRevert(RepoVaultBase.NothingOwed.selector);
        dust.noteCoupon(ID, 0);
    }

    // ================================================ 2. the repo's term

    /// @notice A coupon that fell before T1 was the borrower's own.
    /// @dev The obligation exists only because title sat with the lender when the
    ///      issuer paid. Before the repo opened it did not, so there is nothing
    ///      to manufacture and the refusal names all four dates rather than
    ///      saying no.
    function test_aCouponBeforeTheRepoOpenedIsNotManufactured() public {
        uint64 firstCoupon = couponSchedule.dateOf(0);
        vm.warp(firstCoupon + 1 days);
        _open(ID, LOT);
        _liveFeed(REF_RATE_BPS);

        RepoVault.Repo memory r = vault.repo(ID);
        vm.expectRevert(
            abi.encodeWithSelector(
                RepoVaultBase.CouponOutsideTerm.selector,
                uint256(0),
                firstCoupon,
                r.openedAt,
                r.maturity
            )
        );
        vault.noteCoupon(ID, 0);
    }

    /// @notice And a coupon after maturity is not this vault's business either.
    function test_aCouponAfterMaturityIsNotManufactured() public {
        _open(ID, LOT);
        _liveFeed(REF_RATE_BPS);
        uint64 due = couponSchedule.dateOf(FIRST_OUTSIDE);
        vm.warp(due);

        RepoVault.Repo memory r = vault.repo(ID);
        assertGt(due, r.maturity, "the fixture really does reach past the term");
        vm.expectRevert(
            abi.encodeWithSelector(
                RepoVaultBase.CouponOutsideTerm.selector,
                FIRST_OUTSIDE,
                due,
                r.openedAt,
                r.maturity
            )
        );
        vault.noteCoupon(ID, FIRST_OUTSIDE);

        // The last coupon inside the term is still reachable, so what was refused
        // above was the boundary and not the whole tail of the calendar.
        assertLe(couponSchedule.dateOf(LAST_INSIDE), r.maturity);
    }

    function test_aCouponThatHasNotFallenDueIsRefused() public {
        _open(ID, LOT);
        _liveFeed(REF_RATE_BPS);
        uint64 due = couponSchedule.dateOf(0);
        vm.warp(due - 1);

        vm.expectRevert(
            abi.encodeWithSelector(RepoVaultBase.CouponNotYetDue.selector, uint256(0), due)
        );
        vault.noteCoupon(ID, 0);
    }

    /// @notice An index the bond does not have is the schedule's refusal, not this
    ///         vault's, and it arrives before any state moves.
    function test_anIndexTheBondDoesNotHaveIsRefusedByTheSchedule() public {
        _open(ID, LOT);
        _liveFeed(REF_RATE_BPS);
        vm.warp(couponSchedule.dateOf(0));

        vm.expectRevert(
            abi.encodeWithSelector(
                CouponSchedule.NoSuchCoupon.selector, COUPON_COUNT, COUPON_COUNT
            )
        );
        vault.noteCoupon(ID, COUPON_COUNT);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.OPEN));
    }

    // ==================================================== 3. the feed

    /// @notice **A dark feed refuses rather than inventing a rate.**
    function test_aDarkFeedRefusesRatherThanInventingARate() public {
        _open(ID, LOT);
        vm.warp(couponSchedule.dateOf(0));

        vm.expectRevert(RepoVaultBase.FeedIsDark.selector);
        vault.noteCoupon(ID, 0);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.OPEN), "nothing moved");
    }

    /// @notice A current outage does not erase a valid historical fixing.
    /// @dev Manual marking needs the feed to be dark now. Coupon observation
    ///      needs a valid round before the due date. Those are different clocks,
    ///      so both operations can correctly be available at once.
    function test_aHistoricalFixingSurvivesACurrentFeedOutage() public {
        _open(ID, LOT);
        uint64 due = couponSchedule.dateOf(0);
        vm.warp(due - 1);
        _liveFeed(REF_RATE_BPS);
        feed.setDark(true);
        vm.warp(due);

        vm.prank(ENGINE);
        vault.postMark(ID, keccak256("mark"), false, 0);
        assertEq(
            vault.noteCoupon(ID, 0),
            _expected(LOT, REF_RATE_BPS, COUPON_PERIOD)
        );
    }

    // ========================================== 4. idempotence and state

    /// @notice **A second call for the same coupon is a no-op, not a failure.**
    /// @dev `docs/BUILD-REMAINING.md` §3 puts this behind a HIP-1215
    ///      `scheduleCall` at each coupon date. A scheduled call that fires after
    ///      somebody already made the call by hand has to be a no-op: a revert
    ///      there is a failed scheduled transaction in the record of a bond that
    ///      paid its coupon correctly.
    function test_aSecondCallForTheSameCouponIsANoOp() public {
        _open(ID, LOT);
        _liveFeed(REF_RATE_BPS);
        vm.warp(couponSchedule.dateOf(0));

        uint256 owed = vault.noteCoupon(ID, 0);
        bytes32 commitment = vault.repo(ID).lastCouponCommitment;

        assertEq(vault.noteCoupon(ID, 0), 0, "zero, and no revert");
        assertEq(vault.repo(ID).lastCouponCommitment, commitment, "and nothing moved");
        assertGt(owed, 0);
    }

    /// @notice The no-op survives the repo moving on underneath it.
    /// @dev A scheduled call is not entitled to know what happened between being
    ///      scheduled and firing. Here the coupon is noted and the repo closed
    ///      before the scheduled call lands: the state check would
    ///      refuse a closed repo, and the idempotence guard sits in front of it
    ///      precisely so that this is a no-op rather than a failure.
    function test_theNoOpSurvivesTheRepoBeingClosedUnderneathIt() public {
        _open(ID, LOT);
        _liveFeed(REF_RATE_BPS);
        vm.warp(couponSchedule.dateOf(0));
        vault.noteCoupon(ID, 0);

        vm.warp(vault.repo(ID).maturity);
        _repayRepo(vault, BORROWER, ID);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.CLOSED));

        assertEq(vault.noteCoupon(ID, 0), 0, "the late scheduled call lands quietly");
    }

    /// @notice Different coupon indices are independent observations.
    function test_aSecondDifferentCouponDoesNotWaitForAFakePayThrough() public {
        _open(ID, LOT);
        _liveFeed(REF_RATE_BPS);
        vm.warp(couponSchedule.dateOf(0));
        uint256 first = vault.noteCoupon(ID, 0);

        vm.warp(couponSchedule.dateOf(1));
        uint256 second = vault.noteCoupon(ID, 1);

        assertTrue(vault.notedCoupon(ID, 0));
        assertTrue(vault.notedCoupon(ID, 1));
        assertEq(first, second);
        assertEq(
            vault.repo(ID).lastCouponCommitment,
            vault.commitmentOf(ID, 1, second),
            "latest observation identifies its own index"
        );
    }

    /// @notice Coupon observation never clears or blocks an existing margin call.
    function test_couponObservationPreservesAMarginCall() public {
        _open(ID, LOT);
        vm.prank(ENGINE);
        vault.postMark(ID, keccak256("short"), true, 1 days);
        _liveFeed(REF_RATE_BPS);

        vm.warp(couponSchedule.dateOf(0));
        assertGt(vault.noteCoupon(ID, 0), 0);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.MARGIN_CALL));
    }

    /// @notice A commitment from one coupon is not a commitment for another.
    function test_theCommitmentBindsTheIndex() public view {
        assertTrue(vault.commitmentOf(ID, 0, 12_500) != vault.commitmentOf(ID, 1, 12_500));
        assertTrue(vault.commitmentOf(ID, 0, 12_500) != vault.commitmentOf(ID, 0, 12_501));
    }

    // ================================================= 5. the disclosure

    /// @notice **The disclosure did not widen.** The event is the one it was.
    /// @dev Four reads moved behind it and nothing moved in front of it: the same
    ///      name, the same two fields, the same row and the same granularity. No
    ///      client, no ABI and no field list in `tools/venue-obs.mjs` has to
    ///      change for the derivation to land, which is the property that made
    ///      this a change worth making rather than a rewrite.
    function test_theEventIsExactlyTheOneItAlwaysWas() public {
        _open(ID, LOT);
        _liveFeed(REF_RATE_BPS);
        vm.warp(couponSchedule.dateOf(0));

        uint256 owed = _expected(LOT, REF_RATE_BPS, COUPON_PERIOD);
        vm.expectEmit(true, false, false, true, address(vault));
        emit RepoVaultBase.CouponObserved(ID, vault.commitmentOf(ID, 0, owed));
        vault.noteCoupon(ID, 0);
    }

    /// @notice It is still a predicate under row 14, and narrowing that row still
    ///         stops it.
    /// @dev **The deliberate asymmetry with `CouponDistributor.claim`, asserted
    ///      from this side.** A note is a disclosure about a position and nothing
    ///      else: no money moves, and a venue that may not say a repo has a
    ///      manufactured payment outstanding must not record one, because the
    ///      record is the only thing the call produces. A claim is the opposite,
    ///      and it opts out of the meter for exactly that reason. The two
    ///      contracts differ here on purpose and each says so in its header.
    function test_aNarrowedRowFourteenStopsTheNote() public {
        _open(ID, LOT);
        _liveFeed(REF_RATE_BPS);
        vm.warp(couponSchedule.dateOf(0));

        _publish(_with(asDeployed(), bytes32(uint256(14)), L.point(L.G_NONE, L.T_NEVER)));
        uint32 over = L.excess(params.ceilingFor(14), L.point(L.G_PRED, L.T_IMM));
        assertGt(over, 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                DisclosureView.DisclosureExceedsCeiling.selector, uint16(14), over
            )
        );
        vault.noteCoupon(ID, 0);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.OPEN));
    }

    // ================================================== 6. couponOwed

    /// @notice The preview answers the number `noteCoupon` writes.
    function test_couponOwedAnswersWhatNoteCouponWillWrite() public {
        _open(ID, LOT);
        _liveFeed(REF_RATE_BPS);
        vm.warp(couponSchedule.dateOf(0));

        (uint256 owed, bool dark, bool noted) = vault.couponOwed(ID, 0);
        assertEq(owed, _expected(LOT, REF_RATE_BPS, COUPON_PERIOD));
        assertFalse(dark);
        assertFalse(noted);

        assertEq(vault.noteCoupon(ID, 0), owed, "and the send agrees with the preview");
        (,, noted) = vault.couponOwed(ID, 0);
        assertTrue(noted, "which the preview then reports");
    }

    /// @notice **Total, on `previewMark`'s argument.** A dark feed answers rather
    ///         than reverting, so the Repo screen says the feed is down instead
    ///         of failing to render.
    function test_couponOwedSaysDarkRatherThanReverting() public {
        _open(ID, LOT);
        vm.warp(couponSchedule.dateOf(0));

        (uint256 owed, bool dark,) = vault.couponOwed(ID, 0);
        assertEq(owed, 0);
        assertTrue(dark);
    }
}
