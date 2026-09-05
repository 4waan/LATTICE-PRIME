// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Regime, IEpochClock} from "../src/policy/Regime.sol";
import {ParameterRoot} from "../src/policy/ParameterRoot.sol";
import {EpochClock} from "../src/policy/EpochClock.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
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
/// value it reports, put it here, and then propose and adopt it on chain.
contract PolicySetsTest is Test {
    /// @dev `ParameterRoot.pendingRoot` at 0xD218e55f9d745331bAbfD3b03bEC874F67b9994a,
    ///      chain 296, proposed in transaction
    ///      0x49bf066c8744056416482985ae93be9680002a71182758fc10694014e05ad3dc.
    bytes32 internal constant DEPLOYED_ROOT =
        0xb24633c7d8b306282e8ca5c25685c90ddab8b1764457f0d71fd1461b1d212454;

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
    /// @dev Eleven entries: nine rows, one incomparable row, one waiver mask.
    ///      Counted rather than asserted row by row because `ParameterRoot.t.sol`
    ///      already asserts the rows; what this adds is that nothing was
    ///      appended without the root moving.
    function test_theSetIsElevenEntriesUnderAnAscendingKeyRule() public pure {
        ParameterRoot.Param[] memory set = PolicySets.asDeployed();
        assertEq(set.length, 11);
        for (uint256 i = 1; i < set.length; ++i) {
            assertTrue(set[i].key > set[i - 1].key, "keys must strictly ascend");
        }
    }

    /// @notice The four rows section 7.2 waives are the four rows in the mask.
    function test_theWaiverMaskNamesFourRows() public pure {
        assertEq(PolicySets.WAIVED, (1 << 3) | (1 << 4) | (1 << 5) | (1 << 14));
    }
}
