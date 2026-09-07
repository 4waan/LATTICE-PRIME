// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FreezeList} from "../src/policy/FreezeList.sol";
import {IExternalControlList} from "../src/interfaces/IExternalControlList.sol";

/// @title FreezeListTest
/// @notice Seam B: the blocklist ATS ANDs into every transfer and into the one
///         rail seam C never sees.
///
/// The two claims worth reading are `test_anUnknownAddressIsAuthorised`, which
/// is the direction this seam runs in and is the opposite of seam D's, and
/// `test_aFreezeIsAlwaysAudible`, which is why nothing here is metered.
contract FreezeListTest is Test {
    FreezeList internal f;

    address internal constant GUARDIAN = address(0x6A4D);
    address internal constant PASSERBY = address(0xF00D);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    function setUp() public {
        f = new FreezeList(GUARDIAN);
        vm.warp(1_000_000);
    }

    function _freeze(address who, uint64 until) internal {
        vm.prank(GUARDIAN);
        f.freeze(who, until, keccak256("designation"));
    }

    // ------------------------------------------------- the default direction

    /// @notice **Allow by default, which is the opposite of seam D.**
    /// @dev `ZkKycRegistry.getKycStatus` denies an address it has never heard
    ///      of. This one authorises it. Getting the two backwards would bar every
    ///      holder from the block the list was registered in, and the bond has
    ///      holders before this contract exists.
    function test_anUnknownAddressIsAuthorised() public view {
        assertTrue(f.isAuthorized(ALICE));
        assertTrue(f.isAuthorized(address(0)));
        assertEq(f.frozenUntil(ALICE), 0);
        assertFalse(f.isFrozen(ALICE));
    }

    /// @notice The seam call is the deadline and nothing else, at every point.
    function testFuzz_theSeamCallIsExactlyTheDeadline(uint64 until, uint32 wait) public {
        until = uint64(bound(until, block.timestamp + 1, block.timestamp + 3650 days));
        _freeze(ALICE, until);

        vm.warp(block.timestamp + bound(wait, 0, 3650 days));
        bool free = block.timestamp >= until;
        assertEq(IExternalControlList(address(f)).isAuthorized(ALICE), free);
        assertEq(f.isFrozen(ALICE), !free);
        // And it never touches anyone else.
        assertTrue(f.isAuthorized(BOB), "a freeze is targeted");
    }

    /// @notice A dated freeze lapses with no transaction from anyone.
    function test_aDatedFreezeLapsesByItself() public {
        uint64 until = uint64(block.timestamp) + 30 days;
        _freeze(ALICE, until);
        assertFalse(f.isAuthorized(ALICE));

        vm.warp(until - 1);
        assertFalse(f.isAuthorized(ALICE), "still frozen one second early");
        vm.warp(until);
        assertTrue(f.isAuthorized(ALICE), "and free on the deadline");
    }

    /// @notice An indefinite freeze does not lapse, and says so in the record.
    /// @dev A sanctions listing has no expiry. `INDEFINITE` is spelled rather
    ///      than passed as a large number so that a consumer of `Frozen` can tell
    ///      a precautionary freeze from a designation without guessing at a date.
    function test_anIndefiniteFreezeDoesNotLapse() public {
        _freeze(ALICE, f.INDEFINITE());
        vm.warp(block.timestamp + 3650 days);
        assertFalse(f.isAuthorized(ALICE), "still frozen a decade later");
        assertEq(f.frozenUntil(ALICE), type(uint64).max);
    }

    // -------------------------------------------------------- the audibility

    /// @notice **A freeze is always audible.** No budget, no ceiling, no meter.
    /// @dev Every other disclosing contract here routes its events through
    ///      `DisclosureView._emitUnder`, which withholds when a row's coalition
    ///      budget is spent. A freeze that could be withheld would be a venue
    ///      that can bar someone in silence, and a silent freeze is
    ///      indistinguishable from a venue that has stopped working. The state
    ///      and the event are the same act here, so there is no policy this
    ///      contract can be deployed under that separates them.
    function test_aFreezeIsAlwaysAudible() public {
        uint64 until = uint64(block.timestamp) + 1 days;
        vm.expectEmit(true, false, false, true, address(f));
        emit FreezeList.Frozen(ALICE, until, "designation");
        vm.prank(GUARDIAN);
        f.freeze(ALICE, until, "designation");

        vm.expectEmit(true, false, false, true, address(f));
        emit FreezeList.Thawed(ALICE, "lifted");
        vm.prank(GUARDIAN);
        f.thaw(ALICE, "lifted");
    }

    /// @notice Extending a freeze is a second event with its own rationale.
    /// @dev What stops a freeze being renewed quietly. There is no path that
    ///      moves the deadline without saying so.
    function test_everyExtensionCarriesItsOwnReason() public {
        uint64 first = uint64(block.timestamp) + 1 days;
        _freeze(ALICE, first);

        uint64 second = first + 30 days;
        vm.expectEmit(true, false, false, true, address(f));
        emit FreezeList.Frozen(ALICE, second, "extended, second reason");
        vm.prank(GUARDIAN);
        f.freeze(ALICE, second, "extended, second reason");
        assertEq(f.frozenUntil(ALICE), second);
    }

    // ------------------------------------------------------------- the seat

    function test_onlyTheGuardianCanFreezeOrThaw() public {
        vm.prank(PASSERBY);
        vm.expectRevert(FreezeList.NotGuardian.selector);
        f.freeze(ALICE, uint64(block.timestamp) + 1, "not mine");

        _freeze(ALICE, uint64(block.timestamp) + 1 days);

        vm.prank(PASSERBY);
        vm.expectRevert(FreezeList.NotGuardian.selector);
        f.thaw(ALICE, "not mine");
        assertFalse(f.isAuthorized(ALICE), "and the freeze held");
    }

    /// @notice A thaw in the record is always a release that happened.
    function test_thawingAFreeAccountIsRefused() public {
        vm.prank(GUARDIAN);
        vm.expectRevert(abi.encodeWithSelector(FreezeList.NotFrozen.selector, ALICE));
        f.thaw(ALICE, "nothing to lift");
    }

    /// @notice A freeze that has already lapsed cannot be thawed either.
    /// @dev Otherwise the record would carry a release of someone who was already
    ///      free, which reads as a reversal that never happened.
    function test_thawingALapsedFreezeIsRefused() public {
        uint64 until = uint64(block.timestamp) + 1 days;
        _freeze(ALICE, until);
        vm.warp(until);
        vm.prank(GUARDIAN);
        vm.expectRevert(abi.encodeWithSelector(FreezeList.NotFrozen.selector, ALICE));
        f.thaw(ALICE, "already lapsed");
    }

    function test_aFreezeInThePastIsRefused() public {
        vm.prank(GUARDIAN);
        vm.expectRevert(
            abi.encodeWithSelector(
                FreezeList.FreezeInThePast.selector,
                uint64(block.timestamp),
                uint64(block.timestamp)
            )
        );
        f.freeze(ALICE, uint64(block.timestamp), "already over");
    }

    // ---------------------------------------------------------- the batch

    /// @notice A designation arrives as a list and lands as one transaction.
    /// @dev Applying one by one leaves a window in which the tail of the list can
    ///      still move, and that window is the whole reason a designation is
    ///      published at a moment rather than over an afternoon.
    function test_aDesignationLandsInOneTransaction() public {
        address[] memory list = new address[](3);
        list[0] = ALICE;
        list[1] = BOB;
        list[2] = PASSERBY;

        uint64 until = uint64(block.timestamp) + 90 days;
        vm.prank(GUARDIAN);
        f.freezeMany(list, until, "OFAC 2026-09-07");

        address[] memory frozen = f.frozenAmong(list);
        assertEq(frozen.length, 3);
        for (uint256 i; i < list.length; ++i) {
            assertFalse(f.isAuthorized(list[i]));
        }
    }

    /// @notice The read that tells a client which freezes are still live.
    /// @dev A dated freeze ends with no transaction from anyone, so a client that
    ///      heard `Frozen` cannot tell from the log alone which of those are
    ///      still in force. `MarginWatch.calledAmong` exists for the same reason.
    function test_frozenAmongDistinguishesLiveFreezesFromLapsedOnes() public {
        address[] memory list = new address[](3);
        list[0] = ALICE;
        list[1] = BOB;
        list[2] = PASSERBY;

        _freeze(ALICE, uint64(block.timestamp) + 1 days);
        _freeze(BOB, uint64(block.timestamp) + 10 days);

        vm.warp(block.timestamp + 2 days);

        address[] memory frozen = f.frozenAmong(list);
        assertEq(frozen.length, 1, "one lapsed, one live, one never listed");
        assertEq(frozen[0], BOB);
    }

    /// @notice Only the guardian can apply a batch, and a refused batch applies
    ///         nothing at all.
    function test_aRefusedBatchAppliesNothing() public {
        address[] memory list = new address[](2);
        list[0] = ALICE;
        list[1] = BOB;

        vm.prank(PASSERBY);
        vm.expectRevert(FreezeList.NotGuardian.selector);
        f.freezeMany(list, uint64(block.timestamp) + 1 days, "not mine");

        assertTrue(f.isAuthorized(ALICE));
        assertTrue(f.isAuthorized(BOB));
    }

    // ------------------------------------------------- the composition rule

    /// @notice **This contract has no global switch, and that is structural.**
    /// @dev ATS ANDs every registered control list, and `removeExternalControlList`
    ///      has no equivalent of the pause path's FIND-016 escape. A blocklist
    ///      that could bar everyone at once would therefore be a second pause
    ///      seated where the exit is not guaranteed. The pause lives in
    ///      `TransferPause`, whose deadline expires on its own.
    ///
    ///      Written as a claim over the ABI rather than as prose: no function on
    ///      this contract takes zero arguments and mutates, so there is nothing
    ///      to call that would freeze the world.
    function testFuzz_freezingIsAlwaysTargeted(address who, uint64 until) public {
        vm.assume(who != ALICE);
        until = uint64(bound(until, block.timestamp + 1, type(uint64).max));
        _freeze(who, until);
        assertTrue(f.isAuthorized(ALICE), "one freeze never reaches a second address");
    }
}
