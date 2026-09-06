// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {DisclosureBudget as B} from "./DisclosureBudget.sol";
import {DisclosureLattice as L} from "./DisclosureLattice.sol";
import {IDisclosurePolicy} from "../interfaces/IDisclosurePolicy.sol";

/// @title DisclosureMeter
/// @notice Spends a row's coalition budget at emission time.
/// @dev Rule A: exhaustion withholds the event, never reverts the action.
///      Rule B: a ceiling that admits `(exact, imm)` carries no budget, or the
///      row would be silenced forever. Bounds the event stream, not storage.
library DisclosureMeter {
    /// @notice Bits spent against one row's budget in one epoch.
    /// @dev Keyed `row << 64 | epoch` rather than nested mappings, so a caller
    ///      holds one field and the whole meter is one slot per (row, epoch).
    struct Meter {
        mapping(uint256 => uint32) spent;
    }

    /// @notice A disclosure was charged against a row's epoch budget.
    /// @dev The join over an epoch is the sum of these, which is what makes the
    ///      collusion check readable from the chain instead of from a script over
    ///      a document. Carries no value, only the row, the level and the cost.
    event DisclosureCharged(
        uint16 indexed row,
        uint64 indexed epoch,
        uint8 granularity,
        uint32 cost,
        uint32 spentAfter
    );

    function _key(uint16 row, uint64 epoch) private pure returns (uint256) {
        return (uint256(row) << 64) | uint256(epoch);
    }

    /// @notice Bits already spent on `row` in `epoch`.
    /// @dev The supervisor's read, and the one that makes withholding visible.
    ///      A silenced row and a quiet row look identical in the event stream by
    ///      construction, so the distinction has to live in a view.
    function spentBits(Meter storage m, uint16 row, uint64 epoch)
        internal
        view
        returns (uint32)
    {
        return m.spent[_key(row, epoch)];
    }

    /// @notice Whether `row` carries a binding budget at all.
    /// @dev `budgetBits == 0` reads "governance published no bound for this row",
    ///      never "the bound is zero": `requireWellFormed` refuses
    ///      `budgetBits >= domainBits` and `adopt` refuses a budget on a row whose
    ///      ceiling admits exact.
    function isMetered(IDisclosurePolicy policy, uint16 row) internal view returns (bool) {
        return policy.budgetFor(row).budgetBits != 0;
    }

    /// @notice What one disclosure at granularity `g` costs on `row`. Zero when
    ///         the row is unmetered.
    function costOf(IDisclosurePolicy policy, uint16 row, uint8 g)
        internal
        view
        returns (uint32)
    {
        B.Row memory r = policy.budgetFor(row);
        if (r.budgetBits == 0) return 0;
        return B.bits(r, g);
    }

    /// @notice Whether a disclosure at `g` would be afforded on `row` right now.
    /// @dev A view, so a client can ask before it sends a transaction whose
    ///      disclosure would be silently withheld. `wouldDisclose` on the
    ///      disclosing contracts answers the ceiling half; a caller needs both,
    ///      and the two answer different questions: the ceiling asks whether the
    ///      venue **may** say it, this asks whether it can still **afford** to.
    function wouldAfford(Meter storage m, IDisclosurePolicy policy, uint16 row, uint8 g)
        internal
        view
        returns (bool)
    {
        B.Row memory r = policy.budgetFor(row);
        if (r.budgetBits == 0) return true;
        uint32 already = m.spent[_key(row, policy.currentEpoch())];
        return already + B.bits(r, g) <= r.budgetBits;
    }

    /// @notice Charge one disclosure at `g` against `row`'s epoch budget.
    /// @return afforded True when the budget covered it and the caller should
    ///         emit. False when the row is spent and the caller must withhold.
    /// @dev Rule A. This never reverts, and the caller must not turn a `false`
    ///      into one. An unmetered row always affords, so a contract disclosing
    ///      only on unmetered rows behaves exactly as it did before this library
    ///      existed, which is what makes the wiring safe to add everywhere at
    ///      once.
    function spend(Meter storage m, IDisclosurePolicy policy, uint16 row, uint8 g)
        internal
        returns (bool afforded)
    {
        B.Row memory r = policy.budgetFor(row);
        if (r.budgetBits == 0) return true; // unmetered, Rule B
        uint64 e = policy.currentEpoch();
        uint256 k = _key(row, e);
        uint32 cost = B.bits(r, g);
        uint32 already = m.spent[k];
        if (already + cost > r.budgetBits) return false;
        uint32 next = already + cost;
        m.spent[k] = next;
        emit DisclosureCharged(row, e, g, cost, next);
        return true;
    }

    /// @notice The smallest number of disclosures at `g` that exhausts `row`.
    /// @dev `DisclosureBudget.breakingSize` against the governed parameter rather
    ///      than a struct the caller supplied. The number a supervisor asks for:
    ///      how many observations before this row is gone. Zero when unmetered.
    function breakingSize(IDisclosurePolicy policy, uint16 row, uint8 g)
        internal
        view
        returns (uint256)
    {
        B.Row memory r = policy.budgetFor(row);
        if (r.budgetBits == 0) return 0;
        return B.breakingSize(r, g);
    }

    /// @notice Rule B as a predicate, so `ParameterRoot` and the tests ask it the
    ///         same way.
    /// @dev `point(G_EXACT, T_IMM)` generates every granularity at every time from
    ///      `imm` onward, so a ceiling containing it is one under which the venue
    ///      may publish the exact value as soon as it exists.
    function ceilingAdmitsExact(uint32 ceiling) internal pure returns (bool) {
        return L.permits(ceiling, L.point(L.G_EXACT, L.T_IMM));
    }
}
