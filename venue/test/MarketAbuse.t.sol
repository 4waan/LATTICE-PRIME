// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {RepoMath} from "../src/repo/RepoMath.sol";
import {RepoVault} from "../src/repo/RepoVault.sol";
import {IHoldByPartition, IHoldTypes} from "../src/interfaces/IHoldByPartition.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {PolicyFixture} from "./PolicyFixture.sol";
import {ParameterRoot} from "../src/policy/ParameterRoot.sol";
import {DisclosureBudget as B} from "../src/lattice/DisclosureBudget.sol";
import {ZkKycRegistry} from "../src/kyc/ZkKycRegistry.sol";

/// @title MarketAbuse
/// @notice The integrity adversary, executed rather than argued.
///
/// Every other test in this suite asks whether an observer learns something they
/// should not. This file asks the opposite question: **what can someone DO with
/// the disclosure policy working exactly as specified.** `SECURITY-MODEL.md` 6.1
/// lists eight adversaries and all eight of them are trying to learn. None of
/// them is trying to trade.
///
/// See `docs/manipulation-surface.md` for the reasoning. Each test here is the
/// executable half of one finding in that file.
contract Holds is IHoldByPartition {
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

    function createHoldByPartition(bytes32, IHoldTypes.Hold calldata)
        external
        returns (bool, uint256)
    {
        return (true, nextId++);
    }

    function createHoldFromByPartition(
        bytes32,
        address,
        IHoldTypes.Hold calldata,
        bytes calldata
    ) external returns (bool, uint256) {
        return (true, nextId++);
    }

    function executeHoldByPartition(IHoldTypes.HoldIdentifier calldata id, address, uint256)
        external
        pure
        returns (bool, bytes32)
    {
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

contract MarketAbuseTest is Test, PolicyFixture {
    /// @dev 0.10 bp a day, the Article 7 rate for sovereign debt. See
    ///      `RepoVault.penaltyRate` for why it is configured rather than derived.
    uint256 internal constant PENALTY_RATE = 10;
    uint64 internal constant FAIL_GRACE = 5 days;

    Holds holds;
    RepoVault vault;

    address constant BORROWER = address(0xB0B);
    address constant LENDER = address(0x1EAD);
    address constant ENGINE = address(0xE49);
    bytes32 constant ID = keccak256("gilt-repo-1");
    bytes32 constant PARTITION = bytes32(uint256(1));

    /// A sterling gilt repo sized so the position is actually solvent at open,
    /// which requires the haircut to dominate the maintenance margin. See
    /// MA-06 in the doc: with h = 200bp and m = 500bp the vault opens already
    /// in breach, and nothing in `open` checks it.
    uint256 constant MARK_AT_OPEN = 10_000_000;
    uint16 constant HAIRCUT_BPS = 800;
    uint16 constant MAINTENANCE_BPS = 200;
    uint256 constant RATE_BPS = 425;
    uint64 constant TERM = 30 days;

    function setUp() public {
        holds = new Holds();
        _deployPolicy(asDeployed());
        vault = new RepoVault(holds, ENGINE, params, PENALTY_RATE, FAIL_GRACE);
        vm.warp(1_760_000_000);
        vm.prank(BORROWER);
        vault.open(
            ID,
            LENDER,
            RepoVault.Terms({
                partition: PARTITION,
                collateralAmount: 1_000e8,
                markValue: MARK_AT_OPEN,
                haircutBps: HAIRCUT_BPS,
                maintenanceBps: MAINTENANCE_BPS,
                repoRateBps: RATE_BPS,
                term: TERM
            })
        );
    }

    // ---------------------------------------------------------------- MA-01
    //
    // The liquidation threshold is public to the unit, from the public ABI
    // alone, with no access to the mark. `RepoVault`'s own class comment says
    // hiding the mark means "the liquidation price cannot be derived by an
    // observer who has only the chain." This test is that sentence failing.

    /// @dev The whole attacker. Two view calls and one multiplication. No
    ///      privileged access, no events, no mark.
    function _thresholdFromPublicAbiOnly(bytes32 id) internal view returns (uint256) {
        RepoVault.Repo memory r = vault.repo(id); // public accessor
        uint256 exposure = vault.repurchasePriceNow(id); // public accessor
        return (exposure * (10_000 + uint256(r.maintenanceBps))) / 10_000;
    }

    function test_MA01_liquidationThresholdIsPublicToTheUnit() public {
        vm.warp(block.timestamp + 15 days);

        uint256 attacker = _thresholdFromPublicAbiOnly(ID);
        RepoVault.Repo memory r = vault.repo(ID);

        // The attacker's number is the exact boundary of the private predicate.
        assertTrue(
            RepoMath.isUndercollateralised(
                attacker - 1,
                r.principal,
                r.repoRateBps,
                r.openedAt,
                block.timestamp,
                r.maintenanceBps
            ),
            "one unit below the derived threshold must be a breach"
        );
        assertFalse(
            RepoMath.isUndercollateralised(
                attacker,
                r.principal,
                r.repoRateBps,
                r.openedAt,
                block.timestamp,
                r.maintenanceBps
            ),
            "the derived threshold itself must not be a breach"
        );

        emit log_named_uint("MA-01 mark at open              ", MARK_AT_OPEN);
        emit log_named_uint("MA-01 liquidation threshold, t+15d", attacker);
        emit log_named_uint(
            "MA-01 fall required, bps        ",
            (MARK_AT_OPEN - attacker) * 10_000 / MARK_AT_OPEN
        );
    }

    /// The threshold is not merely readable now, it is *predictable forever*.
    /// Accrual is deterministic, so the entire future trajectory is computable
    /// at open. the marketplace study's `liquidationPx` at least required polling.
    function test_MA01b_theWholeFutureTrajectoryIsComputableAtOpen() public {
        RepoVault.Repo memory r = vault.repo(ID);
        uint64 t0 = r.openedAt;

        for (uint64 d = 1; d <= 30; ++d) {
            uint256 at = t0 + uint256(d) * 1 days;
            // Computed at open, using only values already public at open.
            uint256 predicted =
                (RepoMath.repurchasePrice(r.principal, r.repoRateBps, r.openedAt, at)
                        * (10_000 + uint256(r.maintenanceBps))) / 10_000;

            vm.warp(at);
            assertEq(predicted, _thresholdFromPublicAbiOnly(ID), "trajectory diverged");
        }
    }

    // ---------------------------------------------------------------- MA-03
    //
    // CLOSED. This test used to assert the defect and now asserts the fix, and
    // both versions are worth reading together: the old one showed the vault's
    // own oracle answering "not permitted" while the same call emitted under
    // exactly that cell in the same block, because no `emit` in the file reached
    // `_emitUnder`. Every disclosing `emit` reaches it now, and the oracle and
    // the emit are the same expression over the same value.

    function test_MA03_theOracleAndTheEmitAgree() public {
        // Under the deployed set, row 14 admits a predicate at once, and the
        // margin call goes out.
        assertTrue(vault.wouldDisclose(14, L.G_PRED, L.T_IMM), "row 14 admits it");
        vm.prank(ENGINE);
        vault.postMark(ID, keccak256("mark"), true, 1 days);
        assertEq(uint8(vault.stateOf(ID)), uint8(RepoVault.State.MARGIN_CALL));

        // Move row 14 to `(pred, EOD)`. The oracle changes its answer, and so
        // does the contract's behaviour, which is the property the old version
        // of this test proved absent.
        ParameterRoot.Param[] memory set = asDeployed();
        set[_rowAt(set, 14)].value = L.point(L.G_PRED, L.T_EOD);
        _publish(set);

        assertFalse(vault.wouldDisclose(14, L.G_PRED, L.T_IMM), "row 14 now refuses it");
        vm.prank(BORROWER);
        vm.expectRevert(
            abi.encodeWithSelector(
                RepoVault.DisclosureExceedsCeiling.selector,
                L.excess(L.point(L.G_PRED, L.T_EOD), L.point(L.G_PRED, L.T_IMM))
            )
        );
        vault.cure(ID);
    }

    // ---------------------------------------------------------------- MA-04
    //
    // Repeated one-bit disclosures. The lattice cannot see the accumulation and
    // says so in its own header; the budget can, and is not wired to this path.

    function _row14() internal pure returns (B.Row memory) {
        // A gilt mark over a +/- 20 percent band at one basis point of par is
        // about 2^12 candidates; the vault stores a uint256, so take the band as
        // the real domain and not the type.
        return B.Row({domainBits: 12, aggBits: 3, bucketBits: 6, budgetBits: 8});
    }

    function test_MA04_thirtyDailyMarksExceedTheBudgetTheLatticeCannotSee() public {
        B.Row memory row = _row14();
        B.requireWellFormed(row);

        // What the lattice sees: thirty identical disclosures join to one.
        uint32 one = L.point(L.G_PRED, L.T_IMM);
        uint32 joined = one;
        for (uint256 i = 1; i < 30; ++i) {
            joined = L.join(joined, one);
        }
        assertEq(joined, one, "the level order is blind to repetition, by construction");

        // What the budget sees.
        uint8[] memory levels = new uint8[](30);
        for (uint256 i; i < 30; ++i) {
            levels[i] = B.G_PRED;
        }
        assertEq(B.coalitionBits(row, levels), row.domainBits, "saturated: the row is gone");
        assertFalse(B.permits(row, levels), "thirty marks blow an eight bit budget");

        // The number a policy author wants: how many marks before row 14 is spent.
        uint256 n = B.breakingSize(row, B.G_PRED);
        assertEq(n, 9, "nine daily marks exhaust the budget");
        emit log_named_uint("MA-04 marks until row 14 is spent", n);
        emit log_named_uint("MA-04 marks in one 30 day epoch  ", 30);
    }

    // ---------------------------------------------------------------- MA-02
    //
    // The mark commitment carries no blinder. an invariant requires one for the bid
    // commitment and an invariant for the linkage ciphertext. Nothing requires one
    // here, and the mark is the lowest entropy value in the system.

    function test_MA02_unblindedMarkCommitmentFallsToASmallSearch() public {
        uint256 secretMark = 9_431_000; // known only to the margin engine
        bytes32 commitment = keccak256(abi.encode(secretMark));

        vm.prank(ENGINE);
        vault.postMark(ID, commitment, false, 1 days);
        bytes32 published = vault.repo(ID).markCommitment;

        // The search band an observer picks: the open mark, plus or minus 20
        // percent, at 1000 units of granularity. 4000 candidates.
        uint256 lo = MARK_AT_OPEN - MARK_AT_OPEN / 5;
        uint256 recovered;
        uint256 tried;
        for (uint256 c = lo; c <= MARK_AT_OPEN + MARK_AT_OPEN / 5; c += 1000) {
            ++tried;
            if (keccak256(abi.encode(c)) == published) {
                recovered = c;
                break;
            }
        }

        assertEq(
            recovered, secretMark, "the private mark, recovered from the public commitment"
        );
        emit log_named_uint("MA-02 candidates tried", tried);
    }

    // ---------------------------------------------------------------- MA-07
    //
    // The K = 5 addresses under one nullifier are publicly linked to each other
    // by the `Granted` event. That is row 11 working, and it is the venue's only
    // self dealing detector. Recorded here so that a future change which hides
    // row 11 fails this test rather than passing quietly.

    function test_MA07_theOnlySelfDealingDetectorIsRow11AndItIsAnEventField() public {
        ZkKycRegistry reg = new ZkKycRegistry(address(this), uint64(block.timestamp), 30 days);
        reg.bootstrapGate(address(this));

        bytes32 n = keccak256("one-holder");
        vm.recordLogs();
        for (uint160 i = 1; i <= 5; ++i) {
            reg.grant(address(i), n);
        }

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 linked;
        for (uint256 i; i < logs.length; ++i) {
            // Granted(address indexed account, uint64 indexed epoch, bytes32 nullifier)
            if (logs[i].topics[0] == keccak256("Granted(address,uint64,bytes32)")) {
                if (abi.decode(logs[i].data, (bytes32)) == n) ++linked;
            }
        }
        assertEq(linked, 5, "all K addresses of one holder are joinable from public logs");

        vm.expectRevert();
        reg.grant(address(6), n); // an invariant holds at K = 5
    }
}

