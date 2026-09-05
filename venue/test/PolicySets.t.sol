// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Regime} from "../src/policy/Regime.sol";
import {IEpochClock} from "../src/interfaces/IEpochClock.sol";
import {ParameterRoot} from "../src/policy/ParameterRoot.sol";
import {EpochClock} from "../src/policy/EpochClock.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {DisclosureBudget as B} from "../src/lattice/DisclosureBudget.sol";
import {DisclosureMeter} from "../src/lattice/DisclosureMeter.sol";
import {PolicySets} from "../script/PolicySets.sol";

/// @title PolicySetsTest
/// @notice Pins the root of the deployed matrix to the value that is on Hedera
///         testnet, so "the venue publishes the set the suite tests" is a test
///         and not a sentence in a README.
///
/// `ParameterRoot.propose` commits a root and `adopt` opens a set against it, so
/// the root is the whole identity of a parameter set. If a row moves, this
/// constant stops matching and the failure names the deployment rather than the
/// row, which is the right place to be told: a row change is a governance action
/// with a transaction behind it, not an edit.
///
/// To move a row deliberately: change `PolicySets`, run this test, take the
/// value it reports, put it here, and then propose and adopt it on chain with
/// `script/AdoptPolicy.s.sol`, which sends `PolicySets.asDeployed()` itself so
/// the bytes that land are the bytes this test pinned.
contract PolicySetsTest is Test {
    /// @dev `ParameterRoot.root()` at 0xD2ca252Da75D7dfA4784F05e040cc6089e4747E6,
    ///      chain 296, adopted in epoch 34 by transaction
    ///      0xd877cbe61de37d6337c6e3b54ca3997d35c52b5a0afcd00ec644a1e1dac12b58.
    ///
    ///      The root it superseded was
    ///      0xb24633c7d8b306282e8ca5c25685c90ddab8b1764457f0d71fd1461b1d212454,
    ///      which published ten ceilings and no budget on any of them, so
    ///      `budgetFor` answered the unmetered marker for every row of the matrix
    ///      and three of the five getters a receipt reads were constants. That
    ///      root is still accepted for `windowClosesAt()`, which is
    ///      `RootWindow`'s one-behind window rather than an oversight.
    bytes32 internal constant DEPLOYED_ROOT =
        0xa88540d3e7e8e0f8146ea1c30589d789e59d9c0b78c59f1512ca6b31039c8edc;

    ParameterRoot internal params;

    function setUp() public {
        EpochClock clock = new EpochClock(uint64(block.timestamp), 300);
        Regime regime = new Regime(L.TOP, L.BOTTOM, L.TOP, address(0), address(0x09E), clock);
        params = new ParameterRoot(regime);
    }

    function test_theDeployedRootIsTheTestedRoot() public view {
        assertEq(params.rootOf(PolicySets.asDeployed()), DEPLOYED_ROOT);
    }

    /// @notice And the set it is a root of has the shape the venue claims.
    /// @dev Fourteen entries: nine rows, one incomparable row, three coalition
    ///      budgets, one waiver mask. Counted rather than asserted row by row
    ///      because `ParameterRoot.t.sol` already asserts the rows; what this
    ///      adds is that nothing was appended without the root moving.
    function test_theSetIsFourteenEntriesUnderAnAscendingKeyRule() public pure {
        ParameterRoot.Param[] memory set = PolicySets.asDeployed();
        assertEq(set.length, 14);
        for (uint256 i = 1; i < set.length; ++i) {
            assertTrue(set[i].key > set[i - 1].key, "keys must strictly ascend");
        }
    }

    /// @notice Every published budget is well formed and every one binds.
    /// @dev `requireWellFormed` is what `adopt` runs, so this is the same check
    ///      the chain ran. `budgetBits != 0` is the separate claim: a well formed
    ///      budget can still be the unmetered marker, and the finding this set
    ///      exists to close was that every row read back as one.
    function test_everyPublishedBudgetIsWellFormedAndBinding() public pure {
        uint16[] memory rows = PolicySets.meteredRows();
        for (uint256 i = 0; i < rows.length; ++i) {
            B.Row memory r = _unpack(PolicySets.budgetFor(rows[i]));
            assertTrue(r.budgetBits != 0, "published, so metered");
            assertTrue(
                1 <= r.aggBits && r.aggBits <= r.bucketBits && r.bucketBits <= r.domainBits,
                "monotone"
            );
            assertTrue(r.budgetBits < r.domainBits, "binding");
        }
    }

    /// @notice Rule 2, as arithmetic rather than as a sentence.
    /// @dev The budget is `domainBits - 1`, so at one bit a disclosure the row
    ///      is spent after exactly `domainBits` of them. Asserting
    ///      `breakingSize` rather than `budgetBits` checks the derivation
    ///      against the behaviour it is supposed to produce, which is the shape
    ///      `test_breakingSizeIsTheNumberObserved` already uses.
    function test_theBudgetIsTheLargestOneTheModelAdmits() public pure {
        uint16[] memory rows = PolicySets.meteredRows();
        for (uint256 i = 0; i < rows.length; ++i) {
            B.Row memory r = _unpack(PolicySets.budgetFor(rows[i]));
            assertEq(r.budgetBits, PolicySets.domainBitsOf(rows[i]) - 1, "the largest bound");
            assertEq(
                B.breakingSize(r, L.G_PRED), r.domainBits, "so it is spent after domainBits"
            );
            assertEq(B.bits(r, L.G_PRED), 1, "a predicate costs one bit");
        }
    }

    /// @notice Rule B, restated as the reason there are exactly three.
    /// @dev A budget on any other published row is un-adoptable, so the metered
    ///      set is not a choice about which rows to meter. It is the published
    ///      ceilings read back.
    function test_theMeteredRowsAreExactlyTheRowsRuleBAllows() public view {
        ParameterRoot.Param[] memory set = PolicySets.asDeployed();
        uint256 meterable;
        for (uint256 i = 0; i < set.length; ++i) {
            uint256 k = uint256(set[i].key);
            if (k >= params.ROW_CARD()) continue;
            if (DisclosureMeter.ceilingAdmitsExact(uint32(set[i].value))) continue;
            ++meterable;
        }
        assertEq(meterable, PolicySets.meteredRows().length, "every meterable row is metered");
    }

    /// @notice The packing the set does is the packing the contract undoes.
    function test_theSetPacksWhatTheContractUnpacks() public view {
        uint16[] memory rows = PolicySets.meteredRows();
        for (uint256 i = 0; i < rows.length; ++i) {
            B.Row memory mine = _unpack(PolicySets.budgetFor(rows[i]));
            B.Row memory theirs = params.unpackBudget(PolicySets.budgetFor(rows[i]));
            assertEq(mine.domainBits, theirs.domainBits);
            assertEq(mine.aggBits, theirs.aggBits);
            assertEq(mine.bucketBits, theirs.bucketBits);
            assertEq(mine.budgetBits, theirs.budgetBits);
        }
    }

    /// @notice And the budget key the set writes is the key the contract reads.
    function test_theBudgetKeysAreTheContractsBudgetKeys() public view {
        uint16[] memory rows = PolicySets.meteredRows();
        ParameterRoot.Param[] memory set = PolicySets.asDeployed();
        for (uint256 i = 0; i < rows.length; ++i) {
            bytes32 k = params.keyOfRowBudget(rows[i]);
            bool found;
            for (uint256 j = 0; j < set.length; ++j) {
                if (set[j].key != k) continue;
                found = true;
                assertEq(set[j].value, PolicySets.budgetFor(rows[i]), "and the value under it");
            }
            assertTrue(found, "the budget is in the set under the contract's key");
        }
    }

    function _unpack(uint256 v) private pure returns (B.Row memory) {
        return B.Row(uint16(v), uint16(v >> 16), uint16(v >> 32), uint16(v >> 48));
    }

    /// @notice The four rows section 7.2 waives are the four rows in the mask.
    function test_theWaiverMaskNamesFourRows() public pure {
        assertEq(PolicySets.WAIVED, (1 << 3) | (1 << 4) | (1 << 5) | (1 << 14));
    }
}
