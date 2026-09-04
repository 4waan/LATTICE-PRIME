// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {DisclosureBudget} from "../lattice/DisclosureBudget.sol";

/// @title IDisclosurePolicy
/// @notice The questions a disclosing contract asks its policy, and the whole
///         reason the interface is this narrow.
///
/// `RepoVault` and `OrderBook` each carried `uint32 public immutable ceiling`, a
/// single value for a contract that discloses several different rows of the
/// matrix in `the build notes` section 7.2. That was the wrong shape and it hid a
/// defect rather than causing one: one ceiling for many rows has to be set to the
/// most permissive row, so it cannot refuse anything the most permissive row
/// allows. A ceiling is a property of a **row**, so the lookup is by row.
///
/// The same argument, made a second time, is why `budgetFor` is here rather than
/// in a constructor argument. `SeamJournal` takes its budget at deploy, which
/// means the only bound in the venue that can detect collusion is a number no
/// published root commits to. A coalition bound a supervisor cannot read off the
/// parameter root is a coalition bound nobody can audit.
interface IDisclosurePolicy {
    /// @notice The ceiling in force for one row of the section 7.2 matrix.
    /// @dev Returns `BOTTOM` (zero) for a row with no published parameter, which
    ///      refuses every disclosure on that row. Fail closed: an unconfigured
    ///      venue discloses nothing rather than everything.
    function ceilingFor(uint16 row) external view returns (uint32);

    /// @notice The obligation in force for one row: what the venue **must**
    ///         publish, as against what it may.
    /// @dev The lattice is a ceiling and MiFIR states a minimum, so a row needs
    ///      both bounds. `the design notes` a design decision.
    ///
    ///      **This is not a per-event check and no disclosing contract should
    ///      treat it as one.** An event discloses at one cell; an obligation runs
    ///      over a row and a window, and a predicate emitted now can be
    ///      legitimately followed by the exact publication later. What the floor
    ///      enforces is an invariant, that it bounds the ceiling, and that enforcement
    ///      lives in the policy rather than at the emission site. Returns
    ///      `BOTTOM` for a row with no published parameter, alongside the
    ///      `BOTTOM` ceiling: an unpublished row is un-granted and un-obliged.
    function floorFor(uint16 row) external view returns (uint32);

    /// @notice The coalition budget in force for one row, in bits.
    /// @dev The third bound, and the only one of the three that composes. The
    ///      ceiling says what an observer may see and provably cannot detect
    ///      collusion: a union of ideals inside a ceiling ideal stays inside it.
    ///      The budget bounds the **sum** over a coalition, which is the sound
    ///      over-approximation of the partition join, so a coalition that passes
    ///      it cannot have learned more than the bound.
    ///
    ///      Returns a zero `Row` for a row with no published budget, and
    ///      `budgetBits == 0` is the unmetered marker read by `DisclosureMeter`.
    ///      Unmetered is not fail-open here: `ParameterRoot.adopt` refuses to
    ///      publish a budget on a row whose ceiling admits `(exact, imm)`,
    ///      because such a budget could never bind, and refuses a budget that is
    ///      not well formed. So an unmetered row is one the ceiling has already
    ///      declared fully public, and which rows those are is readable from the
    ///      committed root.
    function budgetFor(uint16 row) external view returns (DisclosureBudget.Row memory);

    /// @notice The epoch the budget is counted in.
    /// @dev A budget is per row **per epoch** or it is a lifetime cap, and a
    ///      lifetime cap on a venue that trades forever is a shutdown date. The
    ///      clock lives here rather than in each disclosing contract so that
    ///      `OrderBook`, `RepoVault` and the policy cannot disagree about which
    ///      epoch a disclosure was charged to, which is the same argument
    ///      `commitmentOf` makes about a preimage.
    function currentEpoch() external view returns (uint64);
}
