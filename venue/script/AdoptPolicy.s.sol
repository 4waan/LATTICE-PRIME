// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ParameterRoot} from "../src/policy/ParameterRoot.sol";
import {DisclosureBudget as B} from "../src/lattice/DisclosureBudget.sol";
import {PolicySets} from "./PolicySets.sol";

/// @title AdoptPolicy
/// @notice Move the live parameter root to the current `PolicySets.asDeployed()`.
///         Two entry points, one epoch apart, because the contract makes them so.
///
/// `DeployPolicy` does this once at genesis and then hands the root to a venue
/// that does not exist yet. This does it to a venue that is already trading, and
/// that is the only difference: same `propose`, same wait, same `adopt`, same
/// set. It exists as a script rather than as two `cast send` invocations so the
/// bytes that reach the chain are `PolicySets.asDeployed()` itself, and a
/// governance action cannot be a set somebody retyped.
///
/// ```
/// forge script script/AdoptPolicy.s.sol --sig 'propose()' --rpc-url $RPC --broadcast
/// # wait for ParameterRoot.currentEpoch() to advance, which is 300 seconds
/// forge script script/AdoptPolicy.s.sol --sig 'adopt()'   --rpc-url $RPC --broadcast
/// ```
///
/// **`propose` is the operator's and `adopt` is anyone's.** That asymmetry is
/// deliberate in the contract: if only the operator could open its own
/// commitment, the timing of adoption would be a second discretionary signal and
/// the epoch rule would buy nothing. The script sends both from the same key
/// because that is the key that is funded, not because `adopt` needs it.
///
/// ## What this run publishes, and why it is not a parameter change
///
/// The set's ten row ceilings are unchanged. What is added is three coalition
/// budgets, on rows 13, 14 and 15, which are the only three the deployed
/// ceilings admit one on: Rule B makes a budget on an `(exact, imm)` row
/// un-adoptable, and the other seven rows sit there.
///
/// Before this, `budgetFor(row)` answered `(0,0,0,0)` for every row of the
/// matrix, which is the unmetered marker. So on the live venue `spentBits` was
/// zero for every row and every epoch, `wouldAfford` was true at every level and
/// `breakingSize` was zero: three of the five getters `DisclosureView` exposes
/// were constants, and the coalition half of the disclosure model ran in the
/// test suite and nowhere else. `PolicySets.budgetFor` carries the derivation.
contract AdoptPolicy is Script {
    address internal constant PARAMS = 0xD2ca252Da75D7dfA4784F05e040cc6089e4747E6;

    function _params() internal view returns (ParameterRoot) {
        return ParameterRoot(vm.envOr("PARAMETER_ROOT", PARAMS));
    }

    /// @notice Commit to the set. Lands at the next epoch, and only the operator
    ///         may call it.
    function propose() external {
        ParameterRoot params = _params();
        ParameterRoot.Param[] memory set = PolicySets.asDeployed();
        bytes32 next = params.rootOf(set);

        console2.log("current root");
        console2.logBytes32(params.root());
        console2.log("proposing   ");
        console2.logBytes32(next);
        require(next != params.root(), "the set is already adopted");

        uint256 pk = vm.envUint("HEDERA_PRIVATE_KEY");
        require(vm.addr(pk) == params.regime().operator(), "propose is the operator's");

        vm.startBroadcast(pk);
        params.propose(next, "budgets: rows 13, 14, 15");
        vm.stopBroadcast();

        console2.log("effective at epoch", params.pendingEpoch());
        console2.log("current epoch     ", params.currentEpoch());
    }

    /// @notice Open the committed set. Permissionless, and refuses early.
    function adopt() external {
        ParameterRoot params = _params();
        ParameterRoot.Param[] memory set = PolicySets.asDeployed();

        uint64 pending = params.pendingEpoch();
        uint64 now_ = params.currentEpoch();
        require(pending != 0, "nothing pending");
        require(now_ >= pending, "not yet effective: wait for the epoch");
        require(params.rootOf(set) == params.pendingRoot(), "the set is not what was proposed");

        vm.startBroadcast(vm.envUint("HEDERA_PRIVATE_KEY"));
        params.adopt(set);
        vm.stopBroadcast();

        console2.log("adopted in epoch", params.currentEpoch());
        console2.log("root");
        console2.logBytes32(params.root());
        _report(params);
    }

    /// @notice Read the three budgets back off the chain, which is the only
    ///         evidence that matters.
    function check() external view {
        _report(_params());
    }

    function _report(ParameterRoot params) internal view {
        console2.log("epoch", params.currentEpoch());
        uint16[] memory rows = PolicySets.meteredRows();
        for (uint256 i = 0; i < rows.length; ++i) {
            B.Row memory r = params.budgetFor(rows[i]);
            // `budgetBits == 0` is the unmetered marker and is the whole finding:
            // before this set, every row read back as one.
            console2.log("row", rows[i]);
            console2.log("  domainBits", r.domainBits);
            console2.log("  budgetBits", r.budgetBits);
            console2.log("  metered   ", r.budgetBits != 0);
        }
    }
}
