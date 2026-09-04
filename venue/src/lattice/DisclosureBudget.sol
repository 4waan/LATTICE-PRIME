// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title DisclosureBudget
/// @notice The composable half of the disclosure model. Bits, not levels.
///
/// ## Why this file exists
///
/// `DisclosureLattice` orders disclosures and computes what a coalition holds.
/// It cannot detect emergent collusion, and the reason is structural rather than
/// a bug: a coalition's knowledge is the union of ideals, a ceiling is an ideal,
/// and the union of two subsets of a set is a subset of that set. So if every
/// observer is individually under the ceiling, the coalition is too, always. Any
/// monotone map into any lattice has this property.
///
/// That matters because the whole collusion argument the research rests on is
/// the opposite claim. Landauer and Redmond: the combined knowledge of a set of
/// observers is the common refinement of their partitions, and refinement can be
/// strictly finer than either. The concrete form already written down is
///
///     k disclosures of one bit each, over a domain of 2^k, individually pass
///     any cell by cell review and jointly determine the value exactly.
///
/// Under the lattice, k observers each holding `point(pred, imm)` join to
/// `point(pred, imm)`, which passes a `pred` ceiling k times over. The attack is
/// invisible at that resolution.
///
/// ## The mathematics
///
/// Knowledge of a row is a partition of the row's value domain `V`, ordered by
/// refinement. Coalition knowledge is the **common refinement**, the join in the
/// partition lattice. Granularity is a five point chain, so the map
///
///     partition  ->  granularity level
///
/// is a **rank**, monotone, and it is *not* a join homomorphism. Ranks do not
/// add and the level chain has no arithmetic, which is exactly why the level
/// ceiling cannot see the attack.
///
/// The quantity that does compose is information, measured in bits. Writing
/// `I(A)` for the bits observer `A` learns about a row whose domain carries `d`
/// bits, the partition join gives
///
///     I(A join B)  <=  min(d, I(A) + I(B))
///
/// with equality when the two disclosures are independent. Sub additivity is the
/// enforceable direction: a budget on the **sum** is always at least as strict
/// as the truth, so a coalition that passes the sum test cannot have learned
/// more than the budget. That is a sound over approximation, unlike the level
/// ceiling which is an unsound one.
///
/// So the model is two layered, and the layers answer different questions.
///
/// | | question | operation | detects emergence |
/// |---|---|---|---|
/// | `DisclosureLattice` | may this observer see this, and when | union of ideals | no, and cannot |
/// | `DisclosureBudget`  | how much may a coalition learn in total | addition, saturating | yes |
///
/// Neither replaces the other. The lattice carries the time axis, which bits
/// cannot express, and the budget carries composition, which the lattice cannot.
library DisclosureBudget {
    /// @notice Per row parameters. One of these per matrix row.
    /// @param domainBits `d`, the entropy of the row's value domain. `exact`
    ///        discloses all of it by definition.
    /// @param aggBits information carried by an aggregate over the row.
    /// @param bucketBits `log2` of the bucket count, so `bucket` discloses this.
    /// @param budgetBits the ceiling on the coalition sum. Must be `< domainBits`
    ///        or the row is not protected at all.
    struct Row {
        uint16 domainBits;
        uint16 aggBits;
        uint16 bucketBits;
        uint16 budgetBits;
    }

    uint8 internal constant G_NONE = 0;
    uint8 internal constant G_PRED = 1;
    uint8 internal constant G_AGG = 2;
    uint8 internal constant G_BUCKET = 3;
    uint8 internal constant G_EXACT = 4;

    error NotMonotone(Row row);
    error BudgetNotBinding(uint16 budgetBits, uint16 domainBits);
    error UnknownLevel(uint8 g);
    error BudgetExceeded(uint32 spent, uint16 budgetBits);

    /// @notice The chain must be monotone in information or the level order is
    ///         meaningless for this row.
    /// @dev This is a modelling obligation, not a defensive check. If a row's
    ///      aggregate genuinely carries less than a predicate, then `pred < agg`
    ///      is the wrong order for that row and the matrix is mis-stated. Failing
    ///      loudly here is how that gets found before it reaches a cell.
    function requireWellFormed(Row memory r) internal pure {
        if (
            !(1 <= r.aggBits && r.aggBits <= r.bucketBits && r.bucketBits <= r.domainBits)
        ) {
            revert NotMonotone(r);
        }
        if (r.budgetBits >= r.domainBits) {
            revert BudgetNotBinding(r.budgetBits, r.domainBits);
        }
    }

    /// @notice Bits disclosed by one observer at granularity level `g`.
    function bits(Row memory r, uint8 g) internal pure returns (uint16) {
        if (g == G_NONE) return 0;
        if (g == G_PRED) return 1;
        if (g == G_AGG) return r.aggBits;
        if (g == G_BUCKET) return r.bucketBits;
        if (g == G_EXACT) return r.domainBits;
        revert UnknownLevel(g);
    }

    /// @notice The sound over approximation of coalition knowledge.
    /// @dev Saturating at `domainBits`, because no coalition learns more than the
    ///      domain holds. Saturation is what makes the bound tight rather than
    ///      merely true, and it is why a row with `domainBits = 1` cannot be
    ///      protected by any budget.
    function coalitionBits(Row memory r, uint8[] memory levels)
        internal
        pure
        returns (uint32 total)
    {
        for (uint256 i = 0; i < levels.length; ++i) {
            total += bits(r, levels[i]);
        }
        if (total > r.domainBits) total = r.domainBits;
    }

    /// @notice The check. True when the coalition stays inside the row's budget.
    function permits(Row memory r, uint8[] memory levels) internal pure returns (bool) {
        return coalitionBits(r, levels) <= r.budgetBits;
    }

    /// @notice The smallest coalition size that breaks the budget at level `g`.
    /// @dev The number a policy author actually wants. "How many observers each
    ///      holding a single predicate does it take before the row is gone."
    ///      Returns 0 when no coalition of that level ever breaks it.
    function breakingSize(Row memory r, uint8 g) internal pure returns (uint256) {
        uint16 per = bits(r, g);
        if (per == 0) return 0;
        // smallest n with n * per > budgetBits
        uint256 n = uint256(r.budgetBits) / uint256(per) + 1;
        // unreachable if even the whole domain stays inside the budget
        if (uint256(per) * n > r.domainBits && r.domainBits <= r.budgetBits) return 0;
        return n;
    }
}
