// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CouponSchedule} from "../src/coupon/CouponSchedule.sol";
import {CouponMath} from "../src/coupon/CouponMath.sol";
import {RepoMath} from "../src/repo/RepoMath.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {PolicyFixture} from "./PolicyFixture.sol";
import {CouponFixture} from "./CouponFixture.sol";

/// @notice The bond's calendar, and the arithmetic that reads it.
contract CouponMathTest is Test {
    /// A million units of face at 100.00, five percent, one year. Exactly
    /// 50,000,000 of the cash token's smallest unit per hundred units of face,
    /// and the point of the case is that it divides cleanly, so a rounding bug
    /// shows up as a whole unit rather than as noise.
    function test_afullYearAtAcleanRateIsExact() public pure {
        uint256 a = CouponMath.accrue(100, 10_000, 500, 0, 365 days, CouponMath.Basis.ACT_365);
        assertEq(a, 50_000, "100 units x 10,000 face x 5 pct");
    }

    function test_zeroElapsedAccruesNothing() public pure {
        assertEq(CouponMath.accrue(1_000, 10_000, 425, 100, 100, CouponMath.Basis.ACT_365), 0);
    }

    /// @notice **Rounds down, where `RepoMath.accrued` rounds up.**
    /// @dev The two directions and the reason for each are in `CouponMath.accrue`'s
    ///      header. This is the assertion that they genuinely differ, so the
    ///      disagreement is a decision on the record rather than a divergence
    ///      nobody noticed. A day of interest on a lot small enough that the
    ///      division has a remainder is the case that separates them.
    function test_theCouponRoundsDownAndTheRepoRateRoundsUp() public pure {
        uint256 coupon = CouponMath.accrue(1, 100, 425, 0, 1 days, CouponMath.Basis.ACT_365);
        assertEq(coupon, 0, "a fraction of one unit, floored");

        uint256 repo = RepoMath.accrued(100, 425, 0, 1 days);
        assertEq(repo, 1, "a fraction of one unit, ceiled");
    }

    /// @notice The reference goes to zero and the bond still pays its spread.
    function test_aZeroReferenceLeavesTheSpread() public pure {
        assertEq(CouponMath.couponBps(0, 75), 75);
        assertEq(CouponMath.couponBps(425, 75), 500);
    }

    function test_aRateOverTheCapIsRefused() public {
        vm.expectRevert(
            abi.encodeWithSelector(CouponMath.RateTooLarge.selector, uint256(10_001))
        );
        this.callCouponBps(10_000, 1);
    }

    function callCouponBps(uint64 r, uint16 s) external pure returns (uint256) {
        return CouponMath.couponBps(r, s);
    }

    function test_anUnorderedPeriodIsRefused() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                CouponMath.PeriodNotOrdered.selector, uint64(200), uint64(100)
            )
        );
        this.callAccrue(1, 100, 425, 200, 100);
    }

    function callAccrue(uint256 lot, uint128 face, uint256 rate, uint64 from, uint64 to)
        external
        pure
        returns (uint256)
    {
        return CouponMath.accrue(lot, face, rate, from, to, CouponMath.Basis.ACT_365);
    }

    /// @notice The bound `accrue`'s header asserts rather than assumes.
    /// @dev Every factor at its ceiling at once: the bond's `maxSupply` of a
    ///      million, a `uint128` face, the rate cap, and a period of a hundred
    ///      years. If this reverts, the multiplication order in `accrue` is
    ///      wrong and the failure is an overflow on a live coupon rather than a
    ///      red test.
    function test_theCouponCannotOverflowAtTheBoundsOfTheTypes() public pure {
        uint256 got = CouponMath.accrue(
            1_000_000,
            type(uint128).max,
            CouponMath.MAX_RATE_BPS,
            0,
            uint64(100 * 365 days),
            CouponMath.Basis.ACT_365
        );
        assertGt(got, 0);
    }

    /// @notice Monotone in time. A coupon never shrinks as the period lengthens.
    function testFuzz_accrualIsMonotoneInTime(uint32 t1, uint32 t2) public pure {
        vm.assume(t1 <= t2);
        uint256 a = CouponMath.accrue(1_000, 10_000, 500, 0, t1, CouponMath.Basis.ACT_365);
        uint256 b = CouponMath.accrue(1_000, 10_000, 500, 0, t2, CouponMath.Basis.ACT_365);
        assertLe(a, b);
    }
}

contract CouponScheduleTest is Test, PolicyFixture, CouponFixture {
    uint64 internal constant DATED = 1_000_000;

    function setUp() public {
        vm.warp(DATED);
        _deployPolicy(asDeployed());
        _deploySchedule(DATED);
    }

    // ------------------------------------------------------------ the terms

    function test_theCalendarIsWhatWasHandedIn() public view {
        assertEq(couponSchedule.count(), COUPON_COUNT);
        assertEq(couponSchedule.issuedAt(), DATED);
        assertEq(couponSchedule.dateOf(0), DATED + COUPON_PERIOD);
        assertEq(couponSchedule.dateOf(11), DATED + COUPON_PERIOD * 12);
        assertEq(couponSchedule.spreadBps(), SPREAD_BPS);
        assertEq(couponSchedule.faceValue(), FACE_VALUE);
        assertEq(uint8(couponSchedule.basis()), uint8(CouponMath.Basis.ACT_365));
    }

    /// @notice The first period runs from the dated date, not from zero.
    function test_theFirstPeriodStartsAtIssue() public view {
        assertEq(couponSchedule.accrualStart(0), DATED, "the dated date");
        assertEq(
            couponSchedule.accrualStart(1), couponSchedule.dateOf(0), "then the last coupon"
        );
    }

    function test_anIndexTheBondDoesNotHaveIsRefused() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                CouponSchedule.NoSuchCoupon.selector, COUPON_COUNT, COUPON_COUNT
            )
        );
        couponSchedule.dateOf(COUPON_COUNT);
    }

    // ---------------------------------------------------- what it refuses

    function test_anEmptyCalendarIsRefused() public {
        uint64[] memory none = new uint64[](0);
        vm.expectRevert(CouponSchedule.NoCoupons.selector);
        new CouponSchedule(DATED, none, SPREAD_BPS, FACE_VALUE, CouponMath.Basis.ACT_365);
    }

    function test_datesMustAscendStrictly() public {
        uint64[] memory d = new uint64[](2);
        d[0] = DATED + 2 days;
        d[1] = DATED + 1 days;
        vm.expectRevert(
            abi.encodeWithSelector(CouponSchedule.DatesNotAscending.selector, d[0], d[1])
        );
        new CouponSchedule(DATED, d, SPREAD_BPS, FACE_VALUE, CouponMath.Basis.ACT_365);

        // The same comparison rejects a duplicate, which is the property that
        // makes the calendar's periods partition the term.
        d[1] = d[0];
        vm.expectRevert(
            abi.encodeWithSelector(CouponSchedule.DatesNotAscending.selector, d[0], d[1])
        );
        new CouponSchedule(DATED, d, SPREAD_BPS, FACE_VALUE, CouponMath.Basis.ACT_365);
    }

    function test_aCouponBeforeTheDatedDateIsRefused() public {
        uint64[] memory d = new uint64[](1);
        d[0] = DATED;
        vm.expectRevert(
            abi.encodeWithSelector(CouponSchedule.FirstCouponBeforeIssue.selector, DATED, DATED)
        );
        new CouponSchedule(DATED, d, SPREAD_BPS, FACE_VALUE, CouponMath.Basis.ACT_365);
    }

    /// @notice **The unimplemented day count is refused, not silently ACT/365.**
    /// @dev The whole argument in `CouponMath.Basis`: a schedule that accepted
    ///      30/360 and accrued ACT/365 underneath would be an instrument lying
    ///      about its own terms, and the lie would only be visible to someone
    ///      who recomputed a coupon by hand.
    function test_anUnimplementedDayCountIsRefusedAtConstruction() public {
        uint64[] memory d = new uint64[](1);
        d[0] = DATED + 1 days;
        vm.expectRevert(
            abi.encodeWithSelector(CouponMath.UnsupportedBasis.selector, CouponMath.Basis.NONE)
        );
        new CouponSchedule(DATED, d, SPREAD_BPS, FACE_VALUE, CouponMath.Basis.NONE);
    }

    function test_aZeroFaceValueIsRefused() public {
        uint64[] memory d = new uint64[](1);
        d[0] = DATED + 1 days;
        vm.expectRevert(CouponSchedule.ZeroFaceValue.selector);
        new CouponSchedule(DATED, d, SPREAD_BPS, 0, CouponMath.Basis.ACT_365);
    }

    function test_aCalendarLongerThanTheBoundIsRefused() public {
        uint256 n = couponSchedule.MAX_COUPONS() + 1;
        uint64[] memory d = new uint64[](n);
        for (uint256 i = 0; i < n; ++i) {
            d[i] = DATED + uint64(i + 1) * 1 days;
        }
        vm.expectRevert(
            abi.encodeWithSelector(
                CouponSchedule.TooManyCoupons.selector, n, couponSchedule.MAX_COUPONS()
            )
        );
        new CouponSchedule(DATED, d, SPREAD_BPS, FACE_VALUE, CouponMath.Basis.ACT_365);
    }

    /// @notice A spread that could never accrue is refused at construction.
    function test_aSpreadOverTheRateCapIsRefusedAtConstruction() public {
        uint64[] memory d = new uint64[](1);
        d[0] = DATED + 1 days;
        vm.expectRevert(
            abi.encodeWithSelector(CouponMath.RateTooLarge.selector, uint256(10_001))
        );
        new CouponSchedule(DATED, d, 10_001, FACE_VALUE, CouponMath.Basis.ACT_365);
    }

    // ------------------------------------------------------------- the root

    function test_theRootIsReproducibleOffChain() public view {
        uint64[] memory d = new uint64[](COUPON_COUNT);
        for (uint256 i = 0; i < COUPON_COUNT; ++i) {
            d[i] = DATED + COUPON_PERIOD * uint64(i + 1);
        }
        assertEq(
            couponSchedule.root(),
            couponSchedule.rootOf(DATED, d, SPREAD_BPS, FACE_VALUE, CouponMath.Basis.ACT_365),
            "the client rebuilds the same value"
        );
    }

    /// @notice Every term is inside the commitment, including the packed ones.
    /// @dev The terms leaf carries three fields in one word. A packing that
    ///      dropped or overlapped one would make two different instruments hash
    ///      to the same root, and the only way to notice is to move each field
    ///      on its own and check the root moves with it.
    function test_theRootMovesWhenAnyTermMoves() public view {
        uint64[] memory d = new uint64[](2);
        d[0] = DATED + 30 days;
        d[1] = DATED + 60 days;
        bytes32 base = couponSchedule.rootOf(DATED, d, 75, 10_000, CouponMath.Basis.ACT_365);

        assertTrue(
            base != couponSchedule.rootOf(DATED + 1, d, 75, 10_000, CouponMath.Basis.ACT_365),
            "dated date"
        );
        assertTrue(
            base != couponSchedule.rootOf(DATED, d, 76, 10_000, CouponMath.Basis.ACT_365),
            "spread"
        );
        assertTrue(
            base != couponSchedule.rootOf(DATED, d, 75, 10_001, CouponMath.Basis.ACT_365),
            "face value"
        );

        uint64[] memory moved = new uint64[](2);
        moved[0] = d[0] + 1;
        moved[1] = d[1];
        assertTrue(
            base != couponSchedule.rootOf(DATED, moved, 75, 10_000, CouponMath.Basis.ACT_365),
            "a coupon date"
        );
    }

    /// @notice A calendar of a different length is a different root.
    /// @dev Promotion rather than duplication, one type up. See
    ///      `MerkleSetTest.test_aPromotedNodeIsNotADuplicatedOne`.
    function test_aLongerCalendarIsADifferentRoot() public view {
        uint64[] memory two = new uint64[](2);
        two[0] = DATED + 30 days;
        two[1] = DATED + 60 days;
        uint64[] memory three = new uint64[](3);
        three[0] = two[0];
        three[1] = two[1];
        three[2] = DATED + 90 days;
        assertTrue(
            couponSchedule.rootOf(DATED, two, 75, 10_000, CouponMath.Basis.ACT_365)
                != couponSchedule.rootOf(DATED, three, 75, 10_000, CouponMath.Basis.ACT_365)
        );
    }

    // --------------------------------------------------------- the accrual

    function test_theCouponIsTheReferencePlusTheSpreadOverThePeriod() public view {
        uint256 lot = 1_000;
        uint64 ref = 425;
        uint256 got = couponSchedule.amountFor(0, ref, lot);
        uint256 want = CouponMath.accrue(
            lot,
            FACE_VALUE,
            uint256(ref) + SPREAD_BPS,
            couponSchedule.accrualStart(0),
            couponSchedule.dateOf(0),
            CouponMath.Basis.ACT_365
        );
        assertEq(got, want);
        assertGt(got, 0, "a week of five percent on a thousand units is not nothing");
    }

    /// @notice A bigger lot is a bigger coupon, and the relation is linear.
    /// @dev The property that makes an amount in a log divide out to a position,
    ///      which is why `RepoVault.CouponObserved` carries none.
    function testFuzz_theCouponIsLinearInTheLot(uint64 lot) public view {
        vm.assume(lot > 0 && lot <= 1_000_000);
        uint256 one = couponSchedule.amountFor(0, 425, 1);
        uint256 many = couponSchedule.amountFor(0, 425, lot);
        // Floor division, so the many-lot answer is at least the linear one and
        // at most one unit of rounding above it per lot.
        assertGe(many, one * lot);
    }

    // ------------------------------------------------------- the disclosure

    /// @notice **The calendar is public whatever the matrix says.**
    /// @dev `CouponSchedule` is the one contract in this venue that publishes on
    ///      row 7 and does not route through `DisclosureView`. The header gives
    ///      the argument; this is the claim. A supervisor narrowing row 7 to
    ///      nothing takes `PrimeOracle` dark, because a venue that may not
    ///      publish a price must not act on one. It does not take the coupon
    ///      calendar away, because a bond whose coupon dates cannot be read is
    ///      not an instrument that has been made private, it is one that cannot
    ///      be settled.
    function test_theCalendarIsPublicWhateverTheMatrixSays() public {
        vm.prank(SUPERVISOR);
        regime.narrow(L.point(L.G_NONE, L.T_NEVER), "everything off");

        // Row 7 is not in the waived set, so narrow the published parameter too
        // and leave nothing standing anywhere.
        assertEq(couponSchedule.dateOf(0), DATED + COUPON_PERIOD, "still readable");
        assertEq(couponSchedule.count(), COUPON_COUNT);
        assertGt(couponSchedule.amountFor(0, 425, 1_000), 0, "and still computable");

        // And it can still be deployed, which a metered constructor could not.
        uint64[] memory d = new uint64[](1);
        d[0] = DATED + 1 days;
        CouponSchedule fresh =
            new CouponSchedule(DATED, d, SPREAD_BPS, FACE_VALUE, CouponMath.Basis.ACT_365);
        assertEq(fresh.count(), 1);
    }
}
