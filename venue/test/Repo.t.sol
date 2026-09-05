// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {RepoMath} from "../src/repo/RepoMath.sol";
import {RepoVault} from "../src/repo/RepoVault.sol";
import {RepoVaultBase} from "../src/repo/RepoVaultBase.sol";
import {IHoldByPartition, IHoldTypes} from "../src/interfaces/IHoldByPartition.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {PolicyFixture} from "./PolicyFixture.sol";

/// @dev Records the ATS calls rather than simulating them. The point of a mock
///      here is to assert that the vault makes exactly the calls the seam call
///      list permits and no others, not to pretend to be ATS. Real hold behaviour
///      is verified against testnet, not here.
contract MockHolds is IHoldByPartition {
    /// @dev Row 12 of the call list. No contract calls it; the client does, and
    ///      nothing in this suite is a client, so it answers zero rather than a
    ///      plausible number. `AtsHolds` in `MatchingEngine.t.sol` keeps a real
    ///      sum, which is where the read is exercised.
    function getHeldAmountForByPartition(bytes32, address) external pure returns (uint256) {
        return 0;
    }

    /// @dev Row 11 of the call list, added with `MatchingEngine`. This suite does
    ///      not exercise the read, so it answers with a hold that would pass no
    ///      check; a stub that returned something plausible would be a stub
    ///      asserting the engine's precondition on the engine's behalf.
    function getHoldForByPartition(IHoldTypes.HoldIdentifier calldata)
        external
        pure
        returns (uint256, uint256, address, address, bytes memory, bytes memory, uint8)
    {
        return (0, 0, address(0), address(0), "", "", 0);
    }

    uint256 public nextId = 1;
    uint256 public created;
    uint256 public executed;
    address public lastExecutedTo;
    uint256 public lastExecutedAmount;

    function createHoldByPartition(bytes32, IHoldTypes.Hold calldata)
        external
        returns (bool, uint256)
    {
        created++;
        return (true, nextId++);
    }

    function createHoldFromByPartition(
        bytes32,
        address,
        IHoldTypes.Hold calldata,
        bytes calldata
    ) external returns (bool, uint256) {
        created++;
        return (true, nextId++);
    }

    function executeHoldByPartition(
        IHoldTypes.HoldIdentifier calldata id,
        address to,
        uint256 amount
    ) external returns (bool, bytes32) {
        executed++;
        lastExecutedTo = to;
        lastExecutedAmount = amount;
        return (true, id.partition);
    }

    function releaseHoldByPartition(IHoldTypes.HoldIdentifier calldata, uint256)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

contract RepoMathTest is Test {
    /// A sterling gilt repo: one million units of cash, 4.50 percent, thirty days.
    /// ACT/365 gives 3698.63, and the library rounds up so the borrower never
    /// repays less than the contract says.
    function test_accrualIsActThreeSixtyFiveAndRoundsUp() public pure {
        uint256 a = RepoMath.accrued(1_000_000, 450, 0, 30 days);
        assertEq(a, 3699, "3698.63 rounded up");
    }

    function test_zeroElapsedAccruesNothing() public pure {
        assertEq(RepoMath.accrued(1_000_000, 450, 100, 100), 0);
    }

    /// Rounding up must never be rounding up by a whole unit on an exact figure.
    /// A full year at a rate that divides cleanly is the case that catches it.
    function test_exactDivisionDoesNotGainAUnit() public pure {
        assertEq(RepoMath.accrued(10_000, 10_000, 0, 365 days), 10_000, "exactly 100 pct");
    }

    function test_haircutReducesTheAdvance() public pure {
        // A two percent haircut on a mark of one million advances 980,000.
        assertEq(RepoMath.purchasePrice(1_000_000, 200), 980_000);
    }

    function test_haircutOfOneHundredPercentIsRefused() public {
        vm.expectRevert();
        this.callPurchasePrice(1_000_000, 10_000);
    }

    function callPurchasePrice(uint256 m, uint256 h) external pure returns (uint256) {
        return RepoMath.purchasePrice(m, h);
    }

    /// Monotone in time: the amount owed never goes down while the repo is open.
    /// A rounding scheme that alternated direction would break this and the break
    /// would only appear at particular timestamps.
    function testFuzz_repurchasePriceIsMonotoneInTime(uint32 t1, uint32 t2) public pure {
        vm.assume(t1 <= t2);
        uint256 p1 = RepoMath.repurchasePrice(1_000_000, 450, 0, t1);
        uint256 p2 = RepoMath.repurchasePrice(1_000_000, 450, 0, t2);
        assertLe(p1, p2);
    }

    function test_marginTriggerBoundary() public pure {
        // Exposure after zero elapsed is the principal. With a 2 percent
        // maintenance margin the collateral must be worth at least 1,020,000.
        assertFalse(
            RepoMath.isUndercollateralised(1_020_000, 1_000_000, 450, 0, 0, 200),
            "exactly on the line is covered"
        );
        assertTrue(
            RepoMath.isUndercollateralised(1_019_999, 1_000_000, 450, 0, 0, 200),
            "one unit below is not"
        );
    }
}

contract RepoVaultTest is Test, PolicyFixture {
    /// @dev 0.10 bp a day, the Article 7 rate for sovereign debt. See
    ///      `RepoVault.penaltyRate` for why it is configured rather than derived.
    uint256 internal constant PENALTY_RATE = 10;
    uint64 internal constant FAIL_GRACE = 5 days;

    MockHolds holds;
    RepoVault vault;

    address constant BORROWER = address(0xB0B);
    address constant LENDER = address(0x1EAD);
    address constant ENGINE = address(0xE49);
    bytes32 constant ID = keccak256("repo-1");
    bytes32 constant PARTITION = bytes32(uint256(1));
    /// A commitment to 12,500, not the number. See `manufacturedCommitment`.
    bytes32 constant COUPON = keccak256("coupon: 12500");

    function setUp() public {
        holds = new MockHolds();
        _deployPolicy(asDeployed());
        vault = new RepoVault(holds, ENGINE, params, PENALTY_RATE, FAIL_GRACE);
    }

    function _open() internal returns (uint256 principal) {
        vm.prank(BORROWER);
        principal = vault.open(
            ID,
            LENDER,
            RepoVault.Terms({
                partition: PARTITION,
                collateralAmount: 1_000e8,
                markValue: 1_000_000,
                haircutBps: 200,
                maintenanceBps: 200,
                repoRateBps: 450,
                term: 30 days
            })
        );
    }

    // ------------------------------------------------------------------ T1

    function test_openTakesOneHoldAndAdvancesTheHaircutPrice() public {
        uint256 principal = _open();
        assertEq(principal, 980_000, "mark less the two percent haircut");
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.OPEN));
        assertEq(holds.created(), 1, "exactly one ATS hold, not a reimplementation");
    }

    // ------------------------------------------------------------------ T2

    function test_closeReturnsTheCollateralAndChargesTheAccrual() public {
        uint256 principal = _open();
        vm.warp(block.timestamp + 30 days);

        uint256 expected = RepoMath.repurchasePrice(
            principal, 450, uint64(block.timestamp - 30 days), block.timestamp
        );

        vm.prank(BORROWER);
        uint256 price = vault.close(ID);

        assertEq(price, expected);
        assertGt(price, principal, "interest accrued");
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.CLOSED));
        assertEq(holds.lastExecutedTo(), BORROWER, "collateral goes back to the seller");
    }

    function test_onlyTheBorrowerCloses() public {
        _open();
        vm.prank(LENDER);
        vm.expectRevert(RepoVaultBase.NotParty.selector);
        vault.close(ID);
    }

    // ------------------------------------------------------------------ T3

    /// @notice Row 14 as a test. The margin call is public; the mark is not.
    function test_marginCallDisclosesTheBooleanAndNotTheNumber() public {
        _open();
        bytes32 commitment = keccak256("mark: 995000");

        vm.recordLogs();
        vm.prank(ENGINE);
        vault.postMark(ID, commitment, true, 1 days);

        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.MARGIN_CALL));

        // Nothing in any emitted log is the mark. The commitment is, by
        // construction, and the state change is a single bit.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            for (uint256 j = 0; j < logs[i].topics.length; ++j) {
                assertTrue(uint256(logs[i].topics[j]) != 995_000, "mark leaked in a topic");
            }
            if (logs[i].data.length >= 32) {
                assertTrue(
                    abi.decode(logs[i].data, (uint256)) != 995_000, "mark leaked in data"
                );
            }
        }
    }

    function test_onlyTheEngineMarks() public {
        _open();
        vm.expectRevert(RepoVaultBase.NotMarginEngine.selector);
        vault.postMark(ID, bytes32(0), true, 1 days);
    }

    // ------------------------------------------------------------------ T4

    function test_cureReturnsToOpen() public {
        _open();
        vm.prank(ENGINE);
        vault.postMark(ID, bytes32(uint256(1)), true, 1 days);
        vm.prank(BORROWER);
        vault.cure(ID);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.OPEN));
    }

    function test_defaultIsPermissionlessButOnlyAfterTheWindow() public {
        _open();
        vm.prank(ENGINE);
        vault.postMark(ID, bytes32(uint256(1)), true, 1 days);

        vm.expectRevert(
            abi.encodeWithSelector(
                RepoVaultBase.CureWindowOpen.selector, uint64(block.timestamp + 1 days)
            )
        );
        vault.declareDefault(ID);

        vm.warp(block.timestamp + 1 days + 1);
        // Anyone. Not the lender, on purpose: a default only the lender can call is
        // a default the lender can decline to call.
        vm.prank(address(0xDEAD));
        vault.declareDefault(ID);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.DEFAULTED));
    }

    // ------------------------------------------------------------- T5 and T6

    /// @notice The transition that proves the design understands the instrument.
    /// Title passed at T1, so ATS pays the mid-term coupon to the lender, who is
    /// not economically entitled to it. The repo cannot close until it is passed
    /// through.
    function test_manufacturedPaymentBlocksTheCloseUntilItIsPaid() public {
        _open();
        vault.noteCoupon(ID, COUPON);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.MANUFACTURED));

        vm.prank(BORROWER);
        vm.expectRevert();
        vault.close(ID);

        vm.prank(LENDER);
        vault.payThrough(ID);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.OPEN));

        vm.prank(BORROWER);
        vault.close(ID);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.CLOSED));
    }

    function test_onlyTheLenderPaysThrough() public {
        _open();
        vault.noteCoupon(ID, COUPON);
        vm.prank(BORROWER);
        vm.expectRevert(RepoVaultBase.NotParty.selector);
        vault.payThrough(ID);
    }

    // ------------------------------------------------------------------ T7

    /// Refused, and refused loudly. A silent absence and a documented refusal read
    /// the same in a diff and differently to anyone deciding whether to trust the
    /// instrument.
    function test_substitutionIsRefusedNotMissing() public {
        vm.expectRevert(RepoVaultBase.SubstitutionRefused.selector);
        vault.substitute(ID);
    }

    // ------------------------------------------------------------------ T8

    function test_auctionSettlesToTheWinner() public {
        _open();
        vm.prank(ENGINE);
        vault.postMark(ID, bytes32(uint256(1)), true, 1 days);
        vm.warp(block.timestamp + 1 days + 1);
        vault.declareDefault(ID);

        vault.settleAuction(ID, address(0x111), 900_000);
        assertEq(holds.lastExecutedTo(), address(0x111));
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.CLOSED));
    }

    // ---------------------------------------------------------- the ceiling

    /// @notice The ceiling is per row now, and the rows genuinely differ.
    /// @dev The old version of this test asked one question of one constant, and
    ///      it passed while every `emit` in the contract ignored that constant.
    ///      A ceiling that is the same for the maturity date and for the position
    ///      size has to be set to whichever of the two is more permissive, so it
    ///      cannot refuse anything at all about the other.
    function test_theCeilingIsPerRowAndTheRowsDiffer() public view {
        // Row 7, asset reference data: exactly, at once.
        assertTrue(vault.wouldDisclose(7, L.G_EXACT, L.T_IMM), "row 7 admits exact now");
        // Row 14, position: a predicate at once, and nothing finer, ever.
        assertTrue(vault.wouldDisclose(14, L.G_PRED, L.T_IMM), "row 14 admits the predicate");
        assertFalse(vault.wouldDisclose(14, L.G_EXACT, L.T_IMM), "row 14 refuses the number");
        assertFalse(vault.wouldDisclose(14, L.G_BUCKET, L.T_EPOCH), "and refuses a band, ever");
        // Row 5, execution price. **This assertion was the opposite until
        // **, when the deployed set moved row 5 to `(exact, imm)`
        // alongside rows 3 and 4. Section 7.2 defers it fifteen minutes through
        // a first cell at `(exact, {cp,ven,reg}, imm)`, and that observer set
        // does not exist on a public ledger any more than `{ven}` does. The
        // vault still publishes no price, for the separate reason `close`
        // records: the repurchase price is computable from `repo(id)` at the
        // moment the repo opens, so deferring it defers nothing.
        assertTrue(vault.wouldDisclose(5, L.G_EXACT, L.T_IMM), "row 5 admits exact now");
        // A row with no published parameter discloses nothing. Fail closed.
        assertFalse(vault.wouldDisclose(1, L.G_PRED, L.T_NEVER), "unpublished row 1 is BOTTOM");
    }

    /// @notice A supervisor narrowing reaches inside the vault without the vault
    ///         trusting the operator, and it reaches the waived rows only.
    function test_aNarrowingPropagatesIntoTheVaultAndSparesTheUnwaivedRows() public {
        assertTrue(vault.wouldDisclose(14, L.G_PRED, L.T_IMM), "before");
        vm.prank(SUPERVISOR);
        regime.narrow(L.point(L.G_PRED, L.T_EOD), "supervisory restriction");
        assertFalse(vault.wouldDisclose(14, L.G_PRED, L.T_IMM), "row 14 is waived, so it moved");
        assertTrue(
            vault.wouldDisclose(7, L.G_EXACT, L.T_IMM), "row 7 is not waived, so it did not"
        );
    }

    /// @notice The manufactured payment no longer publishes the position size.
    /// @dev A coupon amount is the coupon rate times the collateral lot, and the
    ///      rate is public instrument data, so the old `CouponObserved(id,
    ///      uint256)` divided out to the exact position. Row 14 puts that at
    ///      `(none, {}, never)`.
    function test_theCouponAmountIsNotInAnyLogOrInTheStruct() public {
        _open();
        vm.recordLogs();
        vault.noteCoupon(ID, COUPON);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            for (uint256 j = 0; j < logs[i].topics.length; ++j) {
                assertTrue(uint256(logs[i].topics[j]) != 12_500, "amount leaked in a topic");
            }
            if (logs[i].data.length >= 32) {
                assertTrue(
                    abi.decode(logs[i].data, (uint256)) != 12_500, "amount leaked in data"
                );
            }
        }
        assertEq(
            vault.repo(ID).manufacturedCommitment, COUPON, "the commitment, not the number"
        );
    }
}
