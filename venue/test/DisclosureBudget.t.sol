// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";
import {DisclosureBudget as B} from "../src/lattice/DisclosureBudget.sol";

/// @notice The collusion argument the research states in prose, executed.
contract DisclosureBudgetTest is Test {
    /// A concrete row. Order quantity on the venue: a ten bit domain, so about a
    /// thousand distinguishable sizes. Buckets are the thirty two size bands the
    /// venue publishes, an aggregate carries roughly three bits, and the policy
    /// allows a coalition five bits before the row is considered lost.
    function _quantityRow() internal pure returns (B.Row memory) {
        return B.Row({domainBits: 10, aggBits: 3, bucketBits: 5, budgetBits: 5});
    }

    function _levels(uint8 g, uint256 n) internal pure returns (uint8[] memory a) {
        a = new uint8[](n);
        for (uint256 i = 0; i < n; ++i) a[i] = g;
    }

    // ------------------------------------------------------ well formedness

    function test_wellFormedRowAccepted() public pure {
        B.requireWellFormed(_quantityRow());
    }

    function test_nonMonotoneRowRejected() public {
        // An aggregate said to carry more than a bucket. If a row really behaves
        // that way then `agg < bucket` is the wrong order for it and the matrix
        // cell is mis-stated, which is what this refusal is for.
        B.Row memory bad = B.Row({domainBits: 10, aggBits: 7, bucketBits: 5, budgetBits: 5});
        vm.expectRevert();
        this.callWellFormed(bad);
    }

    function test_nonBindingBudgetRejected() public {
        B.Row memory bad = B.Row({domainBits: 10, aggBits: 3, bucketBits: 5, budgetBits: 10});
        vm.expectRevert();
        this.callWellFormed(bad);
    }

    function callWellFormed(B.Row memory r) external pure {
        B.requireWellFormed(r);
    }

    // ----------------------------------------- the k bit collusion, executed

    /// @notice The sentence from the research, run as code.
    ///
    ///   "k disclosures of one bit each, over a domain of 2^k, individually pass
    ///    any cell by cell review and jointly determine the value exactly."
    ///
    /// Ten observers, each holding a single predicate on a ten bit row. Every one
    /// of them is at the coarsest disclosing level in the chain. The lattice sees
    /// nothing wrong, at any ceiling that admits a single one of them. The budget
    /// sees the row is gone.
    function test_kBitCollusionIsInvisibleToTheLatticeAndVisibleToTheBudget()
        public
        pure
    {
        B.Row memory r = _quantityRow();
        B.requireWellFormed(r);

        // --- the lattice half
        uint32 ceiling = L.point(L.G_PRED, L.T_IMM);
        uint32 coalition = L.nothing();
        for (uint256 i = 0; i < 10; ++i) {
            uint32 member = L.point(L.G_PRED, L.T_IMM);
            assert(L.permits(ceiling, member));
            coalition = L.join(coalition, member);
        }
        // Ten observers later the coalition ideal is identical to one observer's.
        assertEq(coalition, ceiling, "the join of ten predicates is one predicate");
        assert(L.permits(ceiling, coalition));

        // --- the budget half, on the same coalition
        uint8[] memory levels = _levels(B.G_PRED, 10);
        assertEq(B.coalitionBits(r, levels), 10, "ten independent bits");
        assertEq(
            B.coalitionBits(r, levels),
            r.domainBits,
            "which is the whole domain: the value is determined exactly"
        );
        assert(!B.permits(r, levels));
    }

    /// The number a policy author wants to be told: how many observers before the
    /// row is gone. Six, for this row, which is well below the ten that determine
    /// the value, because the budget is meant to bite before the loss is total.
    function test_breakingSize() public pure {
        B.Row memory r = _quantityRow();
        assertEq(B.breakingSize(r, B.G_PRED), 6, "six single-bit observers");
        assertEq(B.breakingSize(r, B.G_AGG), 2, "two aggregates");
        // One bucket is five bits, which is exactly the budget, so it is admitted.
        assertEq(B.breakingSize(r, B.G_BUCKET), 2, "two buckets, one sits on the line");
        assertEq(B.breakingSize(r, B.G_NONE), 0, "no coalition of nothings breaks it");
    }

    /// Five is the largest safe coalition, six is the first unsafe one. Checking
    /// the boundary rather than a point well inside it, because an off by one in
    /// `breakingSize` would pass any interior test.
    function test_boundaryIsExact() public pure {
        B.Row memory r = _quantityRow();
        assert(B.permits(r, _levels(B.G_PRED, 5)));
        assert(!B.permits(r, _levels(B.G_PRED, 6)));
    }

    // -------------------------------------------------- composition is sound

    /// Sub additivity is the property that makes the budget a sound over
    /// approximation. The true joint information is at most the sum, so a
    /// coalition that passes the sum test cannot have learned more than the
    /// budget. The test is one sided on purpose: it is allowed to refuse a
    /// coalition that was in fact harmless, and never allowed to admit one that
    /// was not.
    function testFuzz_subadditive(uint8 g1, uint8 g2) public pure {
        B.Row memory r = _quantityRow();
        g1 = uint8(bound(g1, 0, 4));
        g2 = uint8(bound(g2, 0, 4));

        uint8[] memory both = new uint8[](2);
        both[0] = g1;
        both[1] = g2;

        uint256 sum = uint256(B.bits(r, g1)) + uint256(B.bits(r, g2));
        uint256 joint = B.coalitionBits(r, both);
        assertLe(joint, sum, "never more than the sum");
        assertLe(joint, r.domainBits, "and never more than the domain holds");
    }

    /// Saturation matters. Without it a long coalition of coarse observers would
    /// be charged more bits than the row contains, and a budget expressed as a
    /// fraction of the domain would become unreachable rather than merely tight.
    function test_saturatesAtTheDomain() public pure {
        B.Row memory r = _quantityRow();
        assertEq(B.coalitionBits(r, _levels(B.G_EXACT, 4)), r.domainBits, "saturated");
    }

    /// A one bit row cannot be protected by any budget, and the constructor says
    /// so rather than accepting a policy that cannot hold. This is the shape of
    /// the compliance-validity and settlement-validity rows in the matrix, which
    /// are genuinely single bits, and it is why those rows are stated as public
    /// rather than given a ceiling.
    function test_oneBitRowCannotBeProtected() public {
        B.Row memory r = B.Row({domainBits: 1, aggBits: 1, bucketBits: 1, budgetBits: 0});
        B.requireWellFormed(r);
        assert(!B.permits(r, _levels(B.G_PRED, 1)));
        // and there is no budget that both binds and admits a single observer
        B.Row memory loose =
            B.Row({domainBits: 1, aggBits: 1, bucketBits: 1, budgetBits: 1});
        vm.expectRevert();
        this.callWellFormed(loose);
    }
}
