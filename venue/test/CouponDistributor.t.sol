// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {CouponDistributor} from "../src/coupon/CouponDistributor.sol";
import {CouponSchedule} from "../src/coupon/CouponSchedule.sol";
import {ICashToken} from "../src/interfaces/ICashToken.sol";
import {ICouponSchedule} from "../src/interfaces/ICouponSchedule.sol";
import {DisclosureView} from "../src/lattice/DisclosureView.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {MerkleSet} from "../src/merkle/MerkleSet.sol";
import {PolicyFixture} from "./PolicyFixture.sol";
import {CouponFixture, MockCashToken} from "./CouponFixture.sol";

/// @notice A cash token that claims again while it is paying the first claim.
/// @dev The distributor marks `claimed` before it calls out, and the only way to
///      assert that ordering is to be the thing it calls out to. HTS is not code
///      this repository controls, so this stands in for the worst version of it:
///      a token whose `transfer` re-enters.
///
///      The `require` is deliberately inside the token rather than in the test.
///      If the re-entrant claim ever succeeds, the whole transaction reverts and
///      the suite fails on a payment that was made twice, which is the failure
///      that matters. A test that only read a flag afterwards would pass on a
///      contract that had already paid out twice.
contract ReentrantCashToken is ICashToken {
    mapping(address => uint256) public balanceOf;

    address public target;
    bytes public payload;
    bool public fired;
    bytes public innerRevert;

    function decimals() external pure returns (uint8) {
        return 2;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "cash: balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;

        if (target != address(0) && !fired) {
            fired = true;
            (bool ok, bytes memory data) = target.call(payload);
            require(!ok, "the re-entrant claim was paid");
            innerRevert = data;
        }
        return true;
    }
}

/// @title CouponDistributorTest
/// @notice The money leg. Declared, funded, claimed, swept, and every way each
///         of those is refused.
///
/// The suite is organised around the one line the contract's header says holds
/// everywhere:
///
///     cash.balanceOf(distributor)  >=  committed
///
/// Every section below is a way that could stop being true. `declare` could
/// accept a pool nobody funded. `claim` could pay twice, or pay against another
/// coupon's tree, or pay more than the coupon holds. `sweep` could return money
/// that was still owed. The cash token could charge the distributor on top of
/// the amount and drain the pool a basis point at a time. Each of those is a
/// named test here, and `CouponDistributorInvariantTest` at the bottom of this
/// file asserts the line itself over arbitrary sequences rather than over the
/// ones chosen here.
contract CouponDistributorTest is Test, PolicyFixture, CouponFixture {
    CouponDistributor internal dist;

    address internal constant ISSUER = address(0x155);
    address internal constant STRANGER = address(0x57A);

    /// @dev Ascending as `uint160`, which is what `MerkleSet.ascends` requires of
    ///      a tree keyed on the holder. A fixture that listed them in any other
    ///      order would be refused by `_entitlementRoot` before it reached a test.
    address internal constant H1 = address(0x111);
    address internal constant H2 = address(0x222);
    address internal constant H3 = address(0x333);

    uint256 internal constant A1 = 1_000;
    uint256 internal constant A2 = 2_500;
    uint256 internal constant A3 = 4_500;
    uint256 internal constant TOTAL = A1 + A2 + A3;

    uint64 internal constant CLAIM_WINDOW = 30 days;

    /// @dev **The calendar, read once and kept.** Every date in this suite comes
    ///      from here rather than from `couponSchedule.dateOf`, because a read
    ///      off the schedule is an external call and an external call in an
    ///      argument list consumes the `vm.prank` or `vm.expectRevert` armed on
    ///      the line above it. `PolicyFixture._publish` records the same trap
    ///      about `rootOf`. It cost a run of twenty-odd tests all failing with
    ///      `NotIssuer`, which is the mechanism working against a test that had
    ///      already spent its prank.
    uint64[] internal _due;

    /// @dev Twenty-five basis points, matching `script/DeployVenue.s.sol`. It
    ///      charges nothing here and charges nothing there; see the immutable's
    ///      header for why the number exists at all.
    uint256 internal constant PAYING_AGENT_FEE_BPS = 25;

    function setUp() public {
        vm.warp(1_000_000);
        _deployPolicy(asDeployed());
        _deploySchedule(uint64(block.timestamp));
        _deployCash();
        _due = couponSchedule.dates();

        dist = new CouponDistributor(
            params, couponSchedule, cashToken, ISSUER, CLAIM_WINDOW, PAYING_AGENT_FEE_BPS
        );
    }

    // -------------------------------------------------------- the fixtures

    /// @dev Three holders, so the tree is an odd width and every declaration in
    ///      this suite exercises `MerkleSet`'s promotion rather than the clean
    ///      power-of-two case. `MerkleSet.t.sol` covers widths one through nine;
    ///      this is the distributor riding on one of them.
    function _three() internal pure returns (address[] memory h, uint256[] memory a) {
        h = new address[](3);
        h[0] = H1;
        h[1] = H2;
        h[2] = H3;
        a = new uint256[](3);
        a[0] = A1;
        a[1] = A2;
        a[2] = A3;
    }

    /// @dev A day before the coupon falls due. Any point at or before the coupon
    ///      date that the chain has already reached would do; the check is a
    ///      range and the fixture picks one point inside it.
    function _recordFor(uint256 index) internal view returns (uint64) {
        return _due[index] - 1 days;
    }

    function _dueOf(uint256 index) internal view returns (uint64) {
        return _due[index];
    }

    function _fund(uint256 amount) internal {
        cashToken.mint(address(dist), amount);
    }

    /// @notice Warp to the coupon date, fund the pool, declare it.
    function _declare(uint256 index) internal returns (bytes32 root) {
        (address[] memory h, uint256[] memory a) = _three();
        root = _entitlementRoot(index, h, a);
        uint64 due = _dueOf(index);
        if (block.timestamp < due) vm.warp(due);
        _fund(TOTAL);
        vm.prank(ISSUER);
        dist.declare(index, _recordFor(index), root, 3, TOTAL);
    }

    function _claim(uint256 index, uint256 position) internal {
        (address[] memory h, uint256[] memory a) = _three();
        dist.claim(index, h[position], position, a[position], _proof(index, h, a, position));
    }

    // ================================================= 1. construction

    function test_theSeatsAreWhatWasPassedIn() public view {
        assertEq(address(dist.schedule()), address(couponSchedule));
        assertEq(address(dist.cash()), address(cashToken));
        assertEq(dist.issuer(), ISSUER);
        assertEq(dist.claimWindow(), CLAIM_WINDOW);
        assertEq(dist.payingAgentFeeBps(), PAYING_AGENT_FEE_BPS);
        assertEq(address(dist.policy()), address(params));
        assertEq(dist.committed(), 0);
    }

    /// @notice The two published tags, against the literals the client carries.
    /// @dev `tools/entitlements.mjs` exports these as constants rather than
    ///      hashing the strings itself, and `EntitlementVectorsTest` asserts the
    ///      same two literals. This is the end of that chain: the tags a client
    ///      builds a root under are the tags this contract verifies it against,
    ///      and a change to either string fails here rather than at a claim.
    function test_theDomainTagsArePublishedAndPinned() public view {
        assertEq(
            dist.DOMAIN_LEAF(),
            0x8f66f67a98507050e4159cde36e2efabb01a5475db27d2d12245fdc676967b56,
            "the leaf tag moved"
        );
        assertEq(
            dist.DOMAIN_NODE(),
            0xab9aa7d0323f49a3026d7125010067e19dada5e943630e4a6224488aedb6c125,
            "the node tag moved"
        );
    }

    /// @notice None of the three addresses may be zero.
    /// @dev A distributor with no schedule cannot refuse a coupon the bond does
    ///      not have; one with no cash token cannot fund anything; one with no
    ///      issuer has an unreachable sweep destination and a pool that can never
    ///      be declared against. Each of those is a contract that deploys and
    ///      then cannot work, which is the class `RepoVault.NoSchedule` refuses.
    function test_aDistributorWithAMissingSeatIsRefusedAtConstruction() public {
        vm.expectRevert(CouponDistributor.ZeroAddress.selector);
        new CouponDistributor(
            params, ICouponSchedule(address(0)), cashToken, ISSUER, CLAIM_WINDOW, 0
        );

        vm.expectRevert(CouponDistributor.ZeroAddress.selector);
        new CouponDistributor(
            params, couponSchedule, ICashToken(address(0)), ISSUER, CLAIM_WINDOW, 0
        );

        vm.expectRevert(CouponDistributor.ZeroAddress.selector);
        new CouponDistributor(params, couponSchedule, cashToken, address(0), CLAIM_WINDOW, 0);
    }

    /// @notice The two trees in this repository are not each other's.
    /// @dev Same library, different tags. `CouponSchedule` publishes a calendar
    ///      and this publishes entitlements, and a leaf from one must not verify
    ///      against a root from the other even though both are `MerkleSet`.
    function test_theEntitlementTagsAreNotTheCalendarTags() public view {
        assertTrue(dist.DOMAIN_LEAF() != couponSchedule.DOMAIN_LEAF());
        assertTrue(dist.DOMAIN_NODE() != couponSchedule.DOMAIN_NODE());
        assertTrue(dist.DOMAIN_LEAF() != dist.DOMAIN_NODE());
    }

    // ====================================================== 2. declare

    function test_aFundedCouponIsDeclaredAndTheStateSaysSo() public {
        (address[] memory h, uint256[] memory a) = _three();
        bytes32 root = _entitlementRoot(0, h, a);
        uint64 due = _dueOf(0);
        vm.warp(due);
        _fund(TOTAL);

        vm.expectEmit(true, false, false, true, address(dist));
        emit CouponDistributor.Declared(0, _recordFor(0), root, 3, TOTAL);
        vm.prank(ISSUER);
        dist.declare(0, _recordFor(0), root, 3, TOTAL);

        CouponDistributor.Declaration memory d = dist.declarationOf(0);
        assertEq(d.root, root);
        assertEq(d.recordDate, _recordFor(0));
        assertEq(d.declaredAt, uint64(block.timestamp));
        assertEq(d.holders, 3);
        assertEq(d.total, TOTAL);
        assertEq(d.remaining, TOTAL, "nothing claimed yet");
        assertFalse(d.swept);

        assertEq(dist.committed(), TOTAL);
        assertEq(dist.claimsCloseAt(0), uint64(block.timestamp) + CLAIM_WINDOW);
    }

    function test_onlyTheIssuerNamesWhoIsPaid() public {
        (address[] memory h, uint256[] memory a) = _three();
        vm.warp(_dueOf(0));
        _fund(TOTAL);

        vm.prank(STRANGER);
        vm.expectRevert(CouponDistributor.NotIssuer.selector);
        dist.declare(0, _recordFor(0), _entitlementRoot(0, h, a), 3, TOTAL);
    }

    function test_aCouponTheBondDoesNotHaveIsRefused() public {
        vm.warp(_dueOf(COUPON_COUNT - 1));
        _fund(TOTAL);
        vm.prank(ISSUER);
        vm.expectRevert(
            abi.encodeWithSelector(CouponDistributor.NoSuchCoupon.selector, COUPON_COUNT)
        );
        dist.declare(COUPON_COUNT, uint64(block.timestamp), bytes32(uint256(1)), 1, 1);
    }

    /// @notice A coupon paid early is a coupon paid on terms the bond does not have.
    function test_aCouponThatHasNotFallenDueIsRefused() public {
        (address[] memory h, uint256[] memory a) = _three();
        _fund(TOTAL);
        uint64 due = _dueOf(0);
        vm.warp(due - 1);

        vm.prank(ISSUER);
        vm.expectRevert(
            abi.encodeWithSelector(CouponDistributor.CouponNotYetDue.selector, uint256(0), due)
        );
        dist.declare(0, uint64(block.timestamp), _entitlementRoot(0, h, a), 3, TOTAL);
    }

    /// @notice The mirror node cannot answer about the future.
    /// @dev A record date the chain has not reached is a set of balances nobody
    ///      could have read, so the tree behind it was not built from anything.
    function test_aRecordDateTheChainHasNotReachedIsRefused() public {
        (address[] memory h, uint256[] memory a) = _three();
        vm.warp(_dueOf(0));
        _fund(TOTAL);
        uint64 ahead = uint64(block.timestamp) + 1;

        vm.prank(ISSUER);
        vm.expectRevert(
            abi.encodeWithSelector(
                CouponDistributor.RecordDateInTheFuture.selector, ahead, uint64(block.timestamp)
            )
        );
        dist.declare(0, ahead, _entitlementRoot(0, h, a), 3, TOTAL);
    }

    /// @notice Balances read after the coupon date are not that coupon's holders.
    function test_aRecordDateAfterTheCouponIsRefused() public {
        (address[] memory h, uint256[] memory a) = _three();
        uint64 due = _dueOf(0);
        vm.warp(due + 1 days);
        _fund(TOTAL);

        vm.prank(ISSUER);
        vm.expectRevert(
            abi.encodeWithSelector(
                CouponDistributor.RecordDateAfterCoupon.selector, due + 1, due
            )
        );
        dist.declare(0, due + 1, _entitlementRoot(0, h, a), 3, TOTAL);
    }

    /// @notice A declaration with no root, no holders or no pool is not one.
    function test_anEmptyDeclarationIsRefused() public {
        (address[] memory h, uint256[] memory a) = _three();
        bytes32 root = _entitlementRoot(0, h, a);
        vm.warp(_dueOf(0));
        _fund(TOTAL);

        vm.startPrank(ISSUER);
        vm.expectRevert(CouponDistributor.EmptyDeclaration.selector);
        dist.declare(0, _recordFor(0), bytes32(0), 3, TOTAL);

        vm.expectRevert(CouponDistributor.EmptyDeclaration.selector);
        dist.declare(0, _recordFor(0), root, 0, TOTAL);

        vm.expectRevert(CouponDistributor.EmptyDeclaration.selector);
        dist.declare(0, _recordFor(0), root, 3, 0);
        vm.stopPrank();
    }

    /// @notice **A declaration nobody funded is not a declaration.**
    /// @dev The failure mode of accepting one is that the shortfall is found by
    ///      the last claimant rather than by the issuer, at which point the
    ///      coupon has already half paid.
    function test_anUnfundedDeclarationIsRefusedNamingTheShortfall() public {
        (address[] memory h, uint256[] memory a) = _three();
        vm.warp(_dueOf(0));
        _fund(TOTAL - 1);

        vm.prank(ISSUER);
        vm.expectRevert(
            abi.encodeWithSelector(CouponDistributor.Underfunded.selector, TOTAL - 1, TOTAL)
        );
        dist.declare(0, _recordFor(0), _entitlementRoot(0, h, a), 3, TOTAL);

        assertEq(dist.committed(), 0, "and nothing was taken on");
    }

    /// @notice **The last coupon's residue does not fund the next one.**
    /// @dev The funding check is against `committed + total` rather than against
    ///      `total`, so a balance that only covers this declaration because it is
    ///      still holding an undeclaimed pool is refused. Without the running
    ///      total the two coupons would share one pot and the second claimant of
    ///      the second coupon would be the one to find out.
    function test_aBalanceAlreadyOwedToAnotherCouponFundsNothing() public {
        _declare(0);
        assertEq(dist.committed(), TOTAL);
        assertEq(cashToken.balanceOf(address(dist)), TOTAL, "still here, and still owed");

        (address[] memory h, uint256[] memory a) = _three();
        vm.warp(_dueOf(1));
        vm.prank(ISSUER);
        vm.expectRevert(
            abi.encodeWithSelector(CouponDistributor.Underfunded.selector, TOTAL, TOTAL * 2)
        );
        dist.declare(1, _recordFor(1), _entitlementRoot(1, h, a), 3, TOTAL);
    }

    /// @notice **Nothing moves a root once it is published.**
    /// @dev There is no amend and no restate. `AlreadyDeclared` is the whole of
    ///      the mechanism, because a distributor that could restate entitlements
    ///      after publishing them has a root that means nothing.
    function test_nothingRestatesARootOnceItIsPublished() public {
        bytes32 root = _declare(0);

        address[] memory h = new address[](1);
        h[0] = STRANGER;
        uint256[] memory a = new uint256[](1);
        a[0] = TOTAL;
        _fund(TOTAL);

        vm.prank(ISSUER);
        vm.expectRevert(
            abi.encodeWithSelector(CouponDistributor.AlreadyDeclared.selector, uint256(0))
        );
        dist.declare(0, _recordFor(0), _entitlementRoot(0, h, a), 1, TOTAL);

        assertEq(dist.declarationOf(0).root, root, "the published root did not move");
    }

    // ======================================================== 3. claim

    function test_aHolderIsPaidWhatTheTreeSays() public {
        _declare(0);

        vm.expectEmit(true, true, false, false, address(dist));
        emit CouponDistributor.Claimed(0, H2);
        _claim(0, 1);

        assertEq(cashToken.balanceOf(H2), A2);
        assertTrue(dist.claimed(0, H2));
        assertEq(dist.remainingOf(0), TOTAL - A2);
        assertEq(dist.committed(), TOTAL - A2);
        assertEq(cashToken.balanceOf(address(dist)), TOTAL - A2);
    }

    function test_everyHolderIsPaidAndThePoolEmptiesExactly() public {
        _declare(0);
        _claim(0, 0);
        _claim(0, 1);
        _claim(0, 2);

        assertEq(cashToken.balanceOf(H1), A1);
        assertEq(cashToken.balanceOf(H2), A2);
        assertEq(cashToken.balanceOf(H3), A3);
        assertEq(dist.remainingOf(0), 0, "the pool is exactly the tree");
        assertEq(dist.committed(), 0);
        assertEq(cashToken.balanceOf(address(dist)), 0);
    }

    /// @notice **Permissionless in the sender, fixed in the destination.**
    /// @dev A stranger pays the gas and the holder receives the coupon. This is
    ///      `RepoVault.markToMarket`'s shape and it buys the same two things: a
    ///      holder who cannot pay gas is still paid, and the timing of a claim
    ///      stops being a signal about who chose to look.
    function test_aStrangerCanClaimAndTheFundsStillGoToTheHolder() public {
        _declare(0);
        (address[] memory h, uint256[] memory a) = _three();

        vm.prank(STRANGER);
        dist.claim(0, H1, 0, a[0], _proof(0, h, a, 0));

        assertEq(cashToken.balanceOf(H1), A1, "the holder");
        assertEq(cashToken.balanceOf(STRANGER), 0, "not the caller");
    }

    function test_aSecondClaimByTheSameHolderIsRefused() public {
        _declare(0);
        _claim(0, 0);

        (address[] memory h, uint256[] memory a) = _three();
        vm.expectRevert(
            abi.encodeWithSelector(CouponDistributor.AlreadyClaimed.selector, uint256(0), H1)
        );
        dist.claim(0, H1, 0, a[0], _proof(0, h, a, 0));
    }

    function test_aClaimAgainstACouponNobodyDeclaredIsRefused() public {
        (address[] memory h, uint256[] memory a) = _three();
        vm.expectRevert(
            abi.encodeWithSelector(CouponDistributor.NotDeclared.selector, uint256(3))
        );
        dist.claim(3, H1, 0, a[0], _proof(3, h, a, 0));
    }

    /// @notice The amount is in the leaf, so asking for more is a different leaf.
    function test_aHolderCannotClaimMoreThanTheTreeGrantedThem() public {
        _declare(0);
        (address[] memory h, uint256[] memory a) = _three();

        vm.expectRevert(
            abi.encodeWithSelector(CouponDistributor.BadProof.selector, uint256(0), H1)
        );
        dist.claim(0, H1, 0, a[0] + 1, _proof(0, h, a, 0));
    }

    /// @notice The holder is in the leaf too.
    function test_aHolderCannotSpendAnotherHoldersProof() public {
        _declare(0);
        (address[] memory h, uint256[] memory a) = _three();

        vm.expectRevert(
            abi.encodeWithSelector(CouponDistributor.BadProof.selector, uint256(0), STRANGER)
        );
        dist.claim(0, STRANGER, 0, a[0], _proof(0, h, a, 0));
    }

    /// @notice A positional tree needs the position, and the wrong one fails.
    /// @dev `MerkleSet` hashes an ordered pair and never sorts it, which is what
    ///      lets an odd node be promoted rather than duplicated. The cost is that
    ///      the direction at each level is an argument, and this is the assertion
    ///      that it is checked rather than carried.
    function test_theWrongPositionIsRefused() public {
        _declare(0);
        (address[] memory h, uint256[] memory a) = _three();

        vm.expectRevert(
            abi.encodeWithSelector(CouponDistributor.BadProof.selector, uint256(0), H1)
        );
        dist.claim(0, H1, 1, a[0], _proof(0, h, a, 0));
    }

    /// @notice **A proof from one coupon cannot be spent against another.**
    /// @dev The named claim in the plan, and the reason `MerkleSet.leafOf` has a
    ///      scoped overload at all. Without the index inside the leaf, a holder
    ///      with a valid proof against coupon zero has a valid proof against
    ///      every other coupon whose tree carries the same `(holder, amount)`
    ///      pair, and this contract cannot tell the two apart because the leaf is
    ///      all it ever sees. The two declarations here are deliberately
    ///      identical in every other respect: same holders, same amounts, same
    ///      pool. The index is the only thing that differs and it is enough.
    function test_aProofFromAnotherCouponIsRefused() public {
        (address[] memory h, uint256[] memory a) = _three();

        bytes32 rootZero = _declare(0);
        bytes32 rootOne = _declare(1);
        assertTrue(rootZero != rootOne, "the same holders, and not the same root");

        bytes32[] memory proofZero = _proof(0, h, a, 0);

        vm.expectRevert(
            abi.encodeWithSelector(CouponDistributor.BadProof.selector, uint256(1), H1)
        );
        dist.claim(1, H1, 0, a[0], proofZero);

        // And the other direction, so the test is about the scoping rather than
        // about one tree happening to be built first.
        bytes32[] memory proofOne = _proof(1, h, a, 0);
        vm.expectRevert(
            abi.encodeWithSelector(CouponDistributor.BadProof.selector, uint256(0), H1)
        );
        dist.claim(0, H1, 0, a[0], proofOne);

        // Each against its own coupon still pays, so what was refused above was
        // the crossing and not the proof.
        _claim(0, 0);
        _claim(1, 0);
        assertEq(cashToken.balanceOf(H1), A1 * 2);
    }

    /// @notice **The pool bounds the tree, not the other way round.**
    /// @dev A tree whose leaves sum past the declared total runs out on its own
    ///      coupon rather than reaching into another declaration's funds. Here
    ///      the issuer declares a pool one unit short of what the tree grants,
    ///      and the shortfall lands on the last claimant of that coupon with
    ///      another coupon's money sitting untouched in the same contract.
    function test_aMisDeclaredTotalCannotReachAnotherCouponsFunds() public {
        (address[] memory h, uint256[] memory a) = _three();

        // Coupon zero, declared one unit short of its own tree.
        vm.warp(_dueOf(0));
        _fund(TOTAL - 1);
        vm.prank(ISSUER);
        dist.declare(0, _recordFor(0), _entitlementRoot(0, h, a), 3, TOTAL - 1);

        // Coupon one, fully funded, sitting in the same contract.
        vm.warp(_dueOf(1));
        _fund(TOTAL);
        vm.prank(ISSUER);
        dist.declare(1, _recordFor(1), _entitlementRoot(1, h, a), 3, TOTAL);

        _claim(0, 0);
        _claim(0, 1);
        assertEq(dist.remainingOf(0), A3 - 1, "one short, and it is the last claimant's");

        vm.expectRevert(
            abi.encodeWithSelector(
                CouponDistributor.ExceedsRemaining.selector, uint256(0), A3, A3 - 1
            )
        );
        _claim(0, 2);

        // Coupon one is untouched, which is the property under test.
        assertEq(dist.remainingOf(1), TOTAL);
        _claim(1, 2);
        assertEq(cashToken.balanceOf(H3), A3, "paid out of its own coupon");
    }

    /// @notice **Marked claimed before the transfer.**
    /// @dev The cash token is HTS and not code this repository controls, so the
    ///      ordering is what makes that irrelevant: a re-entrant call finds
    ///      `claimed` already set and reverts before reaching a second transfer.
    ///      `ReentrantCashToken` fails the whole transaction if the inner claim
    ///      is ever paid, so this cannot pass on a contract that paid twice.
    function test_aReentrantClaimFindsTheFlagAlreadySet() public {
        ReentrantCashToken evil = new ReentrantCashToken();
        CouponDistributor d = new CouponDistributor(
            params, couponSchedule, evil, ISSUER, CLAIM_WINDOW, PAYING_AGENT_FEE_BPS
        );

        (address[] memory h, uint256[] memory a) = _three();
        vm.warp(_dueOf(0));
        evil.mint(address(d), TOTAL);
        vm.prank(ISSUER);
        d.declare(0, _recordFor(0), _entitlementRoot(0, h, a), 3, TOTAL);

        bytes32[] memory proof = _proof(0, h, a, 0);
        evil.arm(address(d), abi.encodeCall(CouponDistributor.claim, (0, H1, 0, a[0], proof)));

        d.claim(0, H1, 0, a[0], proof);

        assertTrue(evil.fired(), "the token did try");
        assertEq(
            bytes4(evil.innerRevert()),
            CouponDistributor.AlreadyClaimed.selector,
            "and was told the claim was already made"
        );
        assertEq(evil.balanceOf(H1), A1, "paid once");
        assertEq(d.remainingOf(0), TOTAL - A1);
    }

    // ================================================ 4. the custom fee

    /// @notice The ordinary fee comes out of the coupon, and the invariant holds.
    /// @dev A fractional custom fee is ordinarily deducted from the amount
    ///      transferred: the holder receives less and this contract's balance
    ///      falls by exactly what it committed. Nothing here needs to know the
    ///      fee exists, which is the whole reason the charge is on the token
    ///      rather than in EVM bookkeeping.
    function test_theOrdinaryFeeComesOutOfTheCouponAndNotOutOfThePool() public {
        cashToken.setFee(PAYING_AGENT_FEE_BPS, false);
        _declare(0);

        uint256 before = cashToken.balanceOf(address(dist));
        _claim(0, 0);
        uint256 fee = (A1 * PAYING_AGENT_FEE_BPS) / 10_000;

        assertEq(cashToken.balanceOf(H1), A1 - fee, "the holder bears it");
        assertEq(before - cashToken.balanceOf(address(dist)), A1, "the pool does not");
        assertGe(cashToken.balanceOf(address(dist)), dist.committed());
    }

    /// @notice **A fee charged on top is refused on the first claim.**
    /// @dev An HTS fee schedule set `netOfTransfers` charges the sender instead,
    ///      so every payment costs this contract more than it committed. The
    ///      funding check cannot see that: the shortfall accrues a basis point at
    ///      a time and surfaces at the last claimant of the last coupon, which is
    ///      the furthest possible point from the fee schedule that caused it.
    ///      Measuring the balance either side turns it into a refusal here,
    ///      naming the fee, with nothing paid and nothing lost.
    function test_aFeeChargedOnTopIsRefusedRatherThanAbsorbed() public {
        _declare(0);
        cashToken.setFee(PAYING_AGENT_FEE_BPS, true);

        uint256 fee = (A1 * PAYING_AGENT_FEE_BPS) / 10_000;
        (address[] memory h, uint256[] memory a) = _three();

        vm.expectRevert(
            abi.encodeWithSelector(CouponDistributor.FeeChargedOnTop.selector, A1 + fee, A1)
        );
        dist.claim(0, H1, 0, a[0], _proof(0, h, a, 0));

        assertEq(cashToken.balanceOf(H1), 0, "nothing paid");
        assertEq(dist.remainingOf(0), TOTAL, "and nothing spent");
        assertGe(cashToken.balanceOf(address(dist)), dist.committed());
    }

    /// @notice A token that answers false rather than reverting is not a payment.
    function test_aTokenThatDeclinesTheTransferIsNotAClaim() public {
        _declare(0);
        cashToken.setRefuse(true);

        (address[] memory h, uint256[] memory a) = _three();
        vm.expectRevert(
            abi.encodeWithSelector(CouponDistributor.TransferFailed.selector, H1, A1)
        );
        dist.claim(0, H1, 0, a[0], _proof(0, h, a, 0));

        assertFalse(dist.claimed(0, H1), "and the flag rolled back with it");
    }

    // ======================================================== 5. sweep

    /// @notice Unclaimed funds return to the issuer once the window closes.
    function test_theResidueGoesBackToTheIssuerWhenTheWindowCloses() public {
        _declare(0);
        _claim(0, 0);

        uint64 closes = dist.claimsCloseAt(0);
        vm.warp(closes);

        vm.expectEmit(true, false, false, true, address(dist));
        emit CouponDistributor.Swept(0, TOTAL - A1);
        uint256 swept = dist.sweep(0);

        assertEq(swept, TOTAL - A1);
        assertEq(cashToken.balanceOf(ISSUER), TOTAL - A1);
        assertEq(dist.remainingOf(0), 0);
        assertEq(dist.committed(), 0);
        assertTrue(dist.declarationOf(0).swept);
    }

    /// @notice Not one second before the window closes.
    function test_aSweepInsideTheWindowIsRefused() public {
        _declare(0);
        uint64 closes = dist.claimsCloseAt(0);
        vm.warp(closes - 1);

        vm.expectRevert(
            abi.encodeWithSelector(CouponDistributor.ClaimWindowOpen.selector, closes)
        );
        dist.sweep(0);
    }

    function test_aSecondSweepIsRefused() public {
        _declare(0);
        vm.warp(dist.claimsCloseAt(0));
        dist.sweep(0);

        vm.expectRevert(
            abi.encodeWithSelector(CouponDistributor.AlreadySwept.selector, uint256(0))
        );
        dist.sweep(0);
    }

    function test_aSweepOfACouponNobodyDeclaredIsRefused() public {
        vm.expectRevert(
            abi.encodeWithSelector(CouponDistributor.NotDeclared.selector, uint256(5))
        );
        dist.sweep(5);
    }

    /// @notice Permissionless, because the destination is fixed at construction.
    /// @dev Closing it would make the issuer the only party who can end a
    ///      coupon's life, and opening it gives away nothing: whoever calls, the
    ///      money goes to the same address.
    function test_aStrangerMaySweepAndTheIssuerStillReceivesIt() public {
        _declare(0);
        vm.warp(dist.claimsCloseAt(0));

        vm.prank(STRANGER);
        dist.sweep(0);

        assertEq(cashToken.balanceOf(ISSUER), TOTAL);
        assertEq(cashToken.balanceOf(STRANGER), 0);
    }

    /// @notice **The window closes on the clock, not on the sweep.**
    /// @dev Deciding this on `swept` instead would make the answer to "may this
    ///      holder still claim" depend on whether anybody had got round to
    ///      calling `sweep`, which is a race between a claimant and a bot rather
    ///      than a term of the bond.
    function test_aClaimAfterTheWindowIsRefusedWhetherOrNotItWasSwept() public {
        _declare(0);
        uint64 closes = dist.claimsCloseAt(0);
        (address[] memory h, uint256[] memory a) = _three();

        vm.warp(closes);
        vm.expectRevert(
            abi.encodeWithSelector(CouponDistributor.ClaimWindowClosed.selector, closes)
        );
        dist.claim(0, H1, 0, a[0], _proof(0, h, a, 0));

        // And identically after the sweep has actually happened.
        dist.sweep(0);
        vm.expectRevert(
            abi.encodeWithSelector(CouponDistributor.ClaimWindowClosed.selector, closes)
        );
        dist.claim(0, H1, 0, a[0], _proof(0, h, a, 0));
    }

    /// @notice A sweep never reaches another coupon's live pool.
    function test_aSweepTakesOnlyItsOwnCouponsResidue() public {
        _declare(0);
        _declare(1);
        assertEq(dist.committed(), TOTAL * 2);

        vm.warp(dist.claimsCloseAt(0));
        dist.sweep(0);

        assertEq(cashToken.balanceOf(ISSUER), TOTAL, "one coupon's worth");
        assertEq(dist.remainingOf(1), TOTAL, "the other is untouched");
        assertEq(dist.committed(), TOTAL);
        assertGe(cashToken.balanceOf(address(dist)), dist.committed());
    }

    // ============================================ 6. sweepUncommitted

    function test_thereIsNothingToReturnWhenEveryUnitIsOwed() public {
        _declare(0);
        vm.expectRevert(CouponDistributor.NothingUncommitted.selector);
        dist.sweepUncommitted();
    }

    /// @notice Cash that arrived by accident goes home.
    function test_cashThatWasNeverCommittedGoesBackToTheIssuer() public {
        _declare(0);
        _fund(777);

        vm.expectEmit(false, false, false, true, address(dist));
        emit CouponDistributor.UncommittedReturned(777);
        assertEq(dist.sweepUncommitted(), 777);

        assertEq(cashToken.balanceOf(ISSUER), 777);
        assertEq(dist.remainingOf(0), TOTAL, "the live pool did not move");
        assertEq(cashToken.balanceOf(address(dist)), TOTAL);
    }

    /// @notice **The valve that stops a refused `declare` stranding a pool.**
    /// @dev The issuer funds this contract before declaring, and `declare` routes
    ///      through the meter, so narrowing row 7 takes the ceiling out from
    ///      under a declaration that has already been funded. Without this call
    ///      the cash would sit here with no declaration to sweep against and no
    ///      way out. It is the same failure `PrimeOracle` has when row 7 narrows
    ///      under it, and the same answer: name the state and give it a door.
    function test_aRefusedDeclarationDoesNotStrandThePool() public {
        (address[] memory h, uint256[] memory a) = _three();
        vm.warp(_dueOf(0));
        _fund(TOTAL);

        // Row 7 down to a predicate. A pool and a root are not a predicate.
        _publish(_with(asDeployed(), bytes32(uint256(7)), L.point(L.G_PRED, L.T_IMM)));

        vm.prank(ISSUER);
        vm.expectRevert();
        dist.declare(0, _recordFor(0), _entitlementRoot(0, h, a), 3, TOTAL);

        assertEq(dist.committed(), 0, "nothing was taken on");
        assertEq(dist.sweepUncommitted(), TOTAL, "and the pool is not stranded");
        assertEq(cashToken.balanceOf(ISSUER), TOTAL);
    }

    // ========================================== 7. the matrix and the money

    /// @notice **A coupon pays whatever the matrix says.**
    /// @dev The named claim in the plan, and the reason `claim` and `sweep` do
    ///      not route through `_emitUnder` while `declare` does. Metering an
    ///      event means withholding it when a budget is spent and reverting when
    ///      a ceiling is breached, and either behaviour on a payment path is
    ///      wrong: a payment the venue may not announce is still a payment
    ///      somebody is owed, and a coupon that cannot be claimed because a
    ///      disclosure budget is spent is a bond that stops paying for a reason
    ///      that has nothing to do with the bond.
    ///
    ///      So the matrix is narrowed *after* the declaration, which is the only
    ///      order in which the question can be asked at all, and the two halves
    ///      of the answer are asserted together: the venue may no longer declare,
    ///      and every coupon it already declared still pays to the last unit.
    function test_aCouponPaysWhateverTheMatrixSays() public {
        _declare(0);
        _publish(_with(asDeployed(), bytes32(uint256(7)), L.point(L.G_PRED, L.T_IMM)));

        // The venue has lost the right to announce a corporate action.
        assertFalse(dist.wouldDisclose(7, L.G_EXACT, L.T_IMM));
        (address[] memory h, uint256[] memory a) = _three();
        vm.warp(_dueOf(1));
        _fund(TOTAL);
        vm.prank(ISSUER);
        vm.expectRevert();
        dist.declare(1, _recordFor(1), _entitlementRoot(1, h, a), 3, TOTAL);

        // And every holder of the coupon it already declared is still paid.
        _claim(0, 0);
        _claim(0, 1);
        _claim(0, 2);
        assertEq(cashToken.balanceOf(H1), A1);
        assertEq(cashToken.balanceOf(H2), A2);
        assertEq(cashToken.balanceOf(H3), A3);
        assertEq(dist.remainingOf(0), 0, "to the last unit");
    }

    /// @notice And a sweep lands under a narrowed row too.
    function test_aSweepIsNotSilencedByTheMatrixEither() public {
        _declare(0);
        _publish(_with(asDeployed(), bytes32(uint256(7)), L.point(L.G_PRED, L.T_IMM)));

        vm.warp(dist.claimsCloseAt(0));
        assertEq(dist.sweep(0), TOTAL);
        assertEq(cashToken.balanceOf(ISSUER), TOTAL);
    }

    /// @notice The declaration is a row 7 disclosure and says so in the trace.
    /// @dev The refusal event is emitted with the revert, so a narrowed ceiling
    ///      names the row it narrowed even though the state rolls back.
    function test_aRefusedDeclarationNamesTheRow() public {
        (address[] memory h, uint256[] memory a) = _three();
        vm.warp(_dueOf(0));
        _fund(TOTAL);
        _publish(_with(asDeployed(), bytes32(uint256(7)), L.point(L.G_PRED, L.T_IMM)));

        uint32 over = L.excess(params.ceilingFor(7), L.point(L.G_EXACT, L.T_IMM));
        assertGt(over, 0);

        vm.prank(ISSUER);
        vm.expectRevert(
            abi.encodeWithSelector(
                DisclosureView.DisclosureExceedsCeiling.selector, uint16(7), over
            )
        );
        dist.declare(0, _recordFor(0), _entitlementRoot(0, h, a), 3, TOTAL);
    }

    // ==================================================== 8. the reads

    /// @notice The leaf the client builds is the leaf this contract checks.
    /// @dev Public and pure for the reason `CouponSchedule.rootOf` is: there is
    ///      one 32-byte value the client, `make vectors` and this contract all
    ///      compute, so they cannot quietly disagree about what a leaf is.
    function test_theLeafIsTheOneTheClientBuilds() public view {
        assertEq(
            dist.leafOf(3, H2, A2),
            MerkleSet.leafOf(dist.DOMAIN_LEAF(), 3, bytes32(uint256(uint160(H2))), A2)
        );
        // And it moves with the index, which is the scoping the cross-coupon
        // test above depends on.
        assertTrue(dist.leafOf(3, H2, A2) != dist.leafOf(4, H2, A2));
    }

    /// @notice `wouldAccept` answers what `claim` would do, without sending one.
    function test_wouldAcceptAgreesWithWhatClaimDoes() public {
        _declare(0);
        (address[] memory h, uint256[] memory a) = _three();
        bytes32[] memory p = _proof(0, h, a, 0);

        assertTrue(dist.wouldAccept(0, H1, 0, a[0], p), "before");
        _claim(0, 0);
        assertFalse(dist.wouldAccept(0, H1, 0, a[0], p), "after");

        // Wrong in each of the three ways `claim` is wrong in.
        assertFalse(dist.wouldAccept(0, H2, 1, a[1] + 1, _proof(0, h, a, 1)), "amount");
        assertFalse(dist.wouldAccept(0, H2, 0, a[1], _proof(0, h, a, 1)), "position");
        assertFalse(dist.wouldAccept(1, H2, 1, a[1], _proof(0, h, a, 1)), "coupon");
        assertTrue(dist.wouldAccept(0, H2, 1, a[1], _proof(0, h, a, 1)), "and right");
    }

    function test_anUndeclaredCouponReadsAsNothingRatherThanReverting() public view {
        assertEq(dist.remainingOf(7), 0);
        assertEq(dist.claimsCloseAt(7), 0);
        assertEq(dist.declarationOf(7).declaredAt, 0);
        assertFalse(dist.claimed(7, H1));
    }
}

/// @notice Drives the distributor from the issuer's seat and from a stranger's,
///         moves the clock underneath, and changes the cash token's fee schedule
///         while payments are in flight.
/// @dev Everything is try/caught, for `PauseHandler`'s reason: a bound that only
///      holds on the calls that succeeded is not a bound. What the counters are
///      for is `afterInvariant`, which checks the campaign actually reached each
///      path rather than passing because nothing ever happened.
///
///      `doClaimCrossIndex` is the adversary. It builds a genuine proof against
///      one coupon and spends it against another, over and over, at every
///      position and every pair of indices the fuzzer picks. `crossIndexClaims`
///      counts the ones that were *paid*, and the invariant says that number is
///      zero. It is the fuzzed form of
///      `test_aProofFromAnotherCouponIsRefused`, and it is here because the unit
///      test picks one pair and this picks all of them.
contract DistributorHandler is Test, CouponFixture {
    CouponDistributor public dist;

    address internal constant STRANGER = address(0x57A);

    uint256 internal constant N = 3;
    uint256 internal constant SUM = 8_000;

    address[N] internal _h = [address(0x111), address(0x222), address(0x333)];
    uint256[N] internal _a = [uint256(1_000), uint256(2_500), uint256(4_500)];

    uint64 public recordDate;

    /// @dev **What has actually been declared, so a claim can find it.**
    ///      A coupon is declarable once, so twelve of the campaign's calls
    ///      succeed and every later `declare` is refused; if `doClaim` also drew
    ///      its index freely it would land on a live declaration about one time
    ///      in twelve, inside a window that closes in a day. The first version of
    ///      this handler did exactly that and reached zero successful claims,
    ///      which is a suite that asserts the invariant over sequences in which
    ///      nothing was ever paid. Drawing from what exists points the campaign
    ///      at the paths that can move money. `doClaimCrossIndex` still draws
    ///      freely, because refusal is the whole of what it is looking for.
    uint256[] public declaredIndices;

    uint256 public declares;
    uint256 public refusedDeclares;
    uint256 public claims;
    uint256 public refusedClaims;
    uint256 public sweeps;
    uint256 public refusedSweeps;
    uint256 public uncommittedReturns;
    uint256 public feeFlips;

    /// @dev Cross-coupon proofs that were **paid**. The invariant says zero.
    uint256 public crossIndexClaims;

    function wire(CouponDistributor dist_, CouponSchedule s, MockCashToken c) external {
        dist = dist_;
        couponSchedule = s;
        cashToken = c;
        recordDate = s.issuedAt();
    }

    function _set() internal view returns (address[] memory h, uint256[] memory a) {
        h = new address[](N);
        a = new uint256[](N);
        for (uint256 i = 0; i < N; ++i) {
            h[i] = _h[i];
            a[i] = _a[i];
        }
    }

    /// @dev Generous on purpose. A campaign in which almost every declaration is
    ///      underfunded never reaches a claim, and the funding refusal is a unit
    ///      test rather than the thing this suite is for.
    function doFund(uint64 amount) external {
        cashToken.mint(address(dist), bound(amount, SUM, SUM * 3));
    }

    function doDeclare(uint256 indexSeed) external {
        uint256 index = bound(indexSeed, 0, COUPON_COUNT - 1);
        (address[] memory h, uint256[] memory a) = _set();
        vm.prank(dist.issuer());
        try dist.declare(index, recordDate, _entitlementRoot(index, h, a), uint32(N), SUM) {
            declares++;
            declaredIndices.push(index);
        } catch {
            refusedDeclares++;
        }
    }

    /// @dev From a stranger's seat, because `claim` is permissionless in the
    ///      sender and a handler that only ever called it as the issuer would be
    ///      testing a narrower contract than the one deployed.
    ///
    ///      **It walks to a coupon whose window is still open**, rather than
    ///      drawing one blind. A declaration is claimable for a day and a run
    ///      spans the better part of a week, so by the middle of a campaign most
    ///      of what has been declared is already shut and a blind draw spends the
    ///      depth on `ClaimWindowClosed`. Measured: zero successful claims per
    ///      run, which is an invariant asserted over sequences in which nothing
    ///      was ever paid. Nothing is lost by pointing this at the payments,
    ///      because the refusals arrive in quantity from three other places: a
    ///      second claim by the same holder, a poisoned fee schedule, and every
    ///      call `doClaimCrossIndex` makes.
    function doClaim(uint256 indexSeed, uint256 posSeed) external {
        uint256 n = declaredIndices.length;
        if (n == 0) return;
        uint256 pos = bound(posSeed, 0, N - 1);

        uint256 index = declaredIndices[indexSeed % n];
        for (uint256 k = 0; k < n; ++k) {
            uint256 c = declaredIndices[(indexSeed + k) % n];
            if (block.timestamp < dist.claimsCloseAt(c)) {
                index = c;
                break;
            }
        }

        (address[] memory h, uint256[] memory a) = _set();
        vm.prank(STRANGER);
        try dist.claim(index, h[pos], pos, a[pos], _proof(index, h, a, pos)) {
            claims++;
        } catch {
            refusedClaims++;
        }
    }

    /// @dev The adversary. See the class comment.
    function doClaimCrossIndex(uint256 aSeed, uint256 bSeed, uint256 posSeed) external {
        uint256 from = bound(aSeed, 0, COUPON_COUNT - 1);
        uint256 to = bound(bSeed, 0, COUPON_COUNT - 1);
        if (from == to) return;
        uint256 pos = bound(posSeed, 0, N - 1);
        (address[] memory h, uint256[] memory a) = _set();

        try dist.claim(to, h[pos], pos, a[pos], _proof(from, h, a, pos)) {
            crossIndexClaims++;
        } catch {
            refusedClaims++;
        }
    }

    /// @dev The oldest declaration nobody has swept, for `doClaim`'s reason in
    ///      the other direction: it is the one whose window is most likely to
    ///      have closed. Early in a run it has not closed and the refusal is
    ///      `ClaimWindowOpen`, which is the same bound asserted from the other
    ///      side, so both outcomes are reached without either being chosen.
    function doSweep(uint256 indexSeed) external {
        uint256 n = declaredIndices.length;
        if (n == 0) return;
        uint256 index = declaredIndices[indexSeed % n];
        for (uint256 k = 0; k < n; ++k) {
            if (!dist.declarationOf(declaredIndices[k]).swept) {
                index = declaredIndices[k];
                break;
            }
        }
        try dist.sweep(index) {
            sweeps++;
        } catch {
            refusedSweeps++;
        }
    }

    function doSweepUncommitted() external {
        try dist.sweepUncommitted() {
            uncommittedReturns++;
        } catch {}
    }

    /// @dev Poisoned one time in four. A fee schedule that charges the sender on
    ///      top makes every payment cost more than was committed, and the whole
    ///      of the defence is the two balance reads in `_pay`. Leaving it on for
    ///      the whole campaign would stop every claim and prove nothing; a
    ///      quarter of the time it interleaves with real payments, which is where
    ///      an off-by-one in that guard would show up.
    function doSetFee(uint16 bps, uint256 netSeed) external {
        cashToken.setFee(bound(bps, 0, 500), netSeed % 4 == 0);
        feeFlips++;
    }

    /// @dev Steps of at most a third of the claim window, so a single warp
    ///      cannot jump a whole window and leave every claim on that coupon
    ///      unreachable, and small enough that a declaration is live for a
    ///      stretch of the campaign rather than for one call.
    function doWarp(uint32 by) external {
        vm.warp(block.timestamp + bound(by, 1 hours, 8 hours));
    }
}

/// @title CouponDistributorInvariantTest
/// @notice The one line the contract's header says holds everywhere, over
///         arbitrary sequences rather than over the ones chosen above.
///
///     cash.balanceOf(distributor)  >=  committed
///
/// The unit suite asserts it after each named scenario. That is worth something
/// and it is not the claim: the claim is about **every reachable state**, and a
/// declaration, a claim, a sweep, an uncommitted return and a change of fee
/// schedule can interleave in orders nobody wrote a test for. This is where
/// those orders get generated.
///
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 256
contract CouponDistributorInvariantTest is Test, PolicyFixture, CouponFixture {
    CouponDistributor internal dist;
    DistributorHandler internal handler;

    uint64 internal constant CLAIM_WINDOW = 1 days;

    function setUp() public {
        vm.warp(1_000_000);
        _deployPolicy(asDeployed());
        _deploySchedule(uint64(block.timestamp));
        _deployCash();

        // The handler is the issuer, so it can declare and so a sweep has a
        // destination the campaign can see. It exists before the distributor
        // because the issuer is fixed at construction, and it is wired
        // afterwards because it needs the address it is the issuer of.
        handler = new DistributorHandler();
        dist = new CouponDistributor(
            params, couponSchedule, cashToken, address(handler), CLAIM_WINDOW, 25
        );
        handler.wire(dist, couponSchedule, cashToken);

        // Past the last coupon date, so every index is due and the campaign
        // spends its depth on the money rather than on `CouponNotYetDue`.
        vm.warp(uint256(couponSchedule.dateOf(COUPON_COUNT - 1)) + 1);
        cashToken.mint(address(dist), 8_000 * 4);

        // **Selectors rather than the whole contract.** `wire` is external
        // because the handler has to learn the address it is the issuer of, and
        // a bare `targetContract` hands the fuzzer that setter: it spent eleven
        // percent of every campaign's depth trying to re-point the handler at
        // random addresses. Naming the eight drivers spends the depth on the
        // contract under test instead.
        bytes4[] memory drivers = new bytes4[](8);
        drivers[0] = DistributorHandler.doFund.selector;
        drivers[1] = DistributorHandler.doDeclare.selector;
        drivers[2] = DistributorHandler.doClaim.selector;
        drivers[3] = DistributorHandler.doClaimCrossIndex.selector;
        drivers[4] = DistributorHandler.doSweep.selector;
        drivers[5] = DistributorHandler.doSweepUncommitted.selector;
        drivers[6] = DistributorHandler.doSetFee.selector;
        drivers[7] = DistributorHandler.doWarp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: drivers}));
        targetContract(address(handler));
    }

    /// @notice **The contract never owes more than it holds.**
    /// @dev The named claim in `CouponDistributor`'s header. Everything the
    ///      contract does to defend it is somewhere in this file: the funding
    ///      check at `declare`, the `remaining` bound at `claim`, the ordering
    ///      of the flag and the transfer, and the two balance reads in `_pay`.
    ///      Deleting any one of them fails this.
    function invariant_theContractNeverOwesMoreThanItHolds() public view {
        assertGe(cashToken.balanceOf(address(dist)), dist.committed());
    }

    /// @notice And what it owes is exactly the sum of what is still claimable.
    /// @dev `committed` is a running total kept by hand across four entry points,
    ///      which is the shape of state that drifts. This is the reconciliation
    ///      against the per-coupon ledger it is supposed to summarise.
    function invariant_committedIsExactlyWhatIsStillOwed() public view {
        uint256 owed;
        for (uint256 i = 0; i < COUPON_COUNT; ++i) {
            owed += dist.remainingOf(i);
        }
        assertEq(dist.committed(), owed);
    }

    /// @notice No coupon ever pays past its own pool.
    function invariant_noCouponPaysPastItsOwnPool() public view {
        for (uint256 i = 0; i < COUPON_COUNT; ++i) {
            CouponDistributor.Declaration memory d = dist.declarationOf(i);
            assertLe(d.remaining, d.total);
        }
    }

    /// @notice **No proof crosses between coupons.** Not once, in any run.
    /// @dev The fuzzed form of `test_aProofFromAnotherCouponIsRefused`. The
    ///      handler spends genuine proofs against the wrong index for the length
    ///      of the campaign; this says none of them was ever paid.
    function invariant_noProofCrossesBetweenCoupons() public view {
        assertEq(handler.crossIndexClaims(), 0);
    }

    /// @notice The campaign reached each path rather than passing on an empty run.
    function afterInvariant() public view {
        assertGt(handler.declares(), 0, "nothing was ever declared");
        assertGt(handler.claims(), 0, "nothing was ever claimed");
        assertGt(handler.refusedClaims(), 0, "no claim was ever refused");
        assertGt(handler.sweeps(), 0, "no coupon ever reached the end of its window");
        assertGt(handler.refusedSweeps(), 0, "no sweep was ever refused");
        assertGt(handler.feeFlips(), 0, "the fee schedule never moved");
    }
}
