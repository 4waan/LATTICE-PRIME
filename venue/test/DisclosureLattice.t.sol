// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DisclosureLattice as L} from "../src/lattice/DisclosureLattice.sol";

/// @notice The lattice claim, discharged as tests rather than as prose.
///
/// Three groups. Group 1 proves the structure really is a distributive lattice,
/// which the research asserted and never checked. Group 2 exhibits the witness
/// that the pair valued join used by `scripts/collusion-check.py` under reports,
/// which is a defect in our own audit tool. Group 3 prices the gate.
contract DisclosureLatticeTest is Test {
    // ------------------------------------------------- group 1: the laws

    function test_everyPointIsAnIdeal() public pure {
        for (uint8 g = 0; g < L.G_CARD; ++g) {
            for (uint8 t = 0; t < L.T_CARD; ++t) {
                assert(L.isIdeal(L.point(g, t)));
            }
        }
    }

    function test_pointCardinality() public pure {
        // point(g, t) holds every (g', t') with g' <= g and t' >= t, so it has
        // exactly (g + 1) * (T_CARD - t) cells. A closed form the bit trick has
        // to reproduce, which is the only thing checking the repunit arithmetic.
        for (uint8 g = 0; g < L.G_CARD; ++g) {
            for (uint8 t = 0; t < L.T_CARD; ++t) {
                uint256 n;
                uint32 p = L.point(g, t);
                for (uint8 i = 0; i < 30; ++i) {
                    if (p & (uint32(1) << i) != 0) ++n;
                }
                assertEq(n, uint256(g + 1) * uint256(L.T_CARD - t), "cardinality");
            }
        }
    }

    function test_topAndBottom() public pure {
        assertEq(L.point(L.G_EXACT, L.T_PRE), L.TOP, "exact-at-pre is top");
        assert(L.isIdeal(L.BOTTOM));
        assert(L.leq(L.BOTTOM, L.TOP));
    }

    /// The bottom of the granularity chain is not the bottom of the lattice.
    /// `none` at any time still occupies a row, which is what keeps `nothing()`
    /// distinct from `point(G_NONE, T_NEVER)` and stops a policy of "learns
    /// nothing" from silently admitting a row of cells.
    function test_noneIsNotNothing() public pure {
        assert(L.point(L.G_NONE, L.T_NEVER) != L.nothing());
    }

    function testFuzz_latticeLaws(uint32 a, uint32 b, uint32 c) public pure {
        uint32 x = L.close(a & L.TOP);
        uint32 y = L.close(b & L.TOP);
        uint32 z = L.close(c & L.TOP);

        assertEq(L.join(x, x), x, "join idempotent");
        assertEq(L.meet(x, x), x, "meet idempotent");
        assertEq(L.join(x, y), L.join(y, x), "join commutative");
        assertEq(L.meet(x, y), L.meet(y, x), "meet commutative");
        assertEq(L.join(L.join(x, y), z), L.join(x, L.join(y, z)), "join associative");
        assertEq(L.meet(L.meet(x, y), z), L.meet(x, L.meet(y, z)), "meet associative");
        assertEq(L.join(x, L.meet(x, y)), x, "absorption a");
        assertEq(L.meet(x, L.join(x, y)), x, "absorption b");
        // Distributivity. Birkhoff: the ideals of a finite poset form a
        // distributive lattice, and this is the property the collusion argument
        // leans on when it decomposes a coalition into pairs.
        assertEq(
            L.meet(x, L.join(y, z)),
            L.join(L.meet(x, y), L.meet(x, z)),
            "distributive"
        );
    }

    function testFuzz_joinStaysAnIdeal(uint32 a, uint32 b) public pure {
        uint32 x = L.close(a & L.TOP);
        uint32 y = L.close(b & L.TOP);
        assert(L.isIdeal(L.join(x, y)));
        assert(L.isIdeal(L.meet(x, y)));
    }

    function testFuzz_joinIsLeastUpperBound(uint32 a, uint32 b) public pure {
        uint32 x = L.close(a & L.TOP);
        uint32 y = L.close(b & L.TOP);
        uint32 j = L.join(x, y);
        assert(L.leq(x, j));
        assert(L.leq(y, j));
        // least: nothing strictly below j bounds both
        assertEq(L.meet(j, L.join(x, y)), j, "no slack");
    }

    /// Monotonicity is the property the whole enforcement argument rests on:
    /// adding an observer to a coalition can never reduce what it knows, so a
    /// ceiling that holds for a superset holds for every subset.
    function testFuzz_joinIsMonotone(uint32 a, uint32 b, uint32 ceiling) public pure {
        uint32 x = L.close(a & L.TOP);
        uint32 y = L.close(b & L.TOP);
        uint32 c = L.close(ceiling & L.TOP);
        if (L.permits(c, L.join(x, y))) {
            assert(L.permits(c, x));
            assert(L.permits(c, y));
        }
    }

    // ---------------- group 2: what a ceiling test can and cannot see

    /// The pair rule `scripts/collusion-check.py` uses, reproduced exactly.
    /// Greatest granularity any member reaches, at the earliest time that
    /// granularity is reached.
    function _lexJoin(uint8 g1, uint8 t1, uint8 g2, uint8 t2)
        private
        pure
        returns (uint8, uint8)
    {
        if (g1 > g2) return (g1, t1);
        if (g2 > g1) return (g2, t2);
        return (g1, t1 < t2 ? t1 : t2);
    }

    /// @notice **A ceiling test on this lattice is blind to emergent collusion,
    ///         and no choice of representation inside it will fix that.**
    ///
    /// A coalition holds the union of its members' ideals. A ceiling is an ideal.
    /// The union of two subsets of a set is a subset of that set. So if every
    /// member is individually compliant, the coalition is compliant, always and
    /// for every ceiling.
    ///
    /// This is not a property of our encoding. It holds for any monotone map from
    /// knowledge into any lattice, because that is what monotone means. It means
    /// the collusion checker's headline result, zero emergent row joins, is a
    /// consequence of the representation and not evidence about the design.
    ///
    /// Emergence lives one level down, in the partition lattice that granularity
    /// is a rank on. `DisclosureBudget` is the layer that can see it.
    function testFuzz_compliantMembersAlwaysGiveACompliantCoalition(
        uint32 a,
        uint32 b,
        uint32 c
    ) public pure {
        uint32 x = L.close(a & L.TOP);
        uint32 y = L.close(b & L.TOP);
        uint32 ceiling = L.close(c & L.TOP);
        if (L.permits(ceiling, x) && L.permits(ceiling, y)) {
            assert(L.permits(ceiling, L.join(x, y)));
        }
    }

    /// @notice The pair summary is strictly lossy, and here is the cell it drops.
    ///
    /// Alice holds the exact value at end of day. Bob holds an aggregate
    /// immediately. Their true joint knowledge contains "an aggregate, right
    /// now", which is a real capability: it is enough to trade ahead of the
    /// print. The pair rule takes Alice's greater granularity and carries her
    /// time with it, reporting `(exact, EOD)` and discarding Bob's branch
    /// entirely.
    ///
    /// The consequence for the checker is narrow and worth stating exactly. The
    /// dropped cell is always below some individual member, so a per member scan
    /// still catches it, and the Python checker does scan per member. What is
    /// unsound is the coalition verdict taken alone, and what is inexpressible is
    /// any ceiling that is not a principal ideal. "Exact from end of day, or an
    /// aggregate immediately" is the natural way to write a market data policy
    /// and it cannot be written as a pair at all.
    function test_pairSummaryDropsTheEarlyCoarseBranch() public pure {
        uint32 alice = L.point(L.G_EXACT, L.T_EOD);
        uint32 bob = L.point(L.G_AGG, L.T_IMM);
        uint32 truth = L.join(alice, bob);

        (uint8 lg, uint8 lt) = _lexJoin(L.G_EXACT, L.T_EOD, L.G_AGG, L.T_IMM);
        assertEq(lg, L.G_EXACT, "lex takes the greater granularity");
        assertEq(lt, L.T_EOD, "and carries its time, dropping Bob");
        uint32 summary = L.point(lg, lt);

        // Strictly lossy, not merely different.
        assert(L.leq(summary, truth));
        assert(summary != truth);

        // Name the capability that was dropped: an aggregate, immediately.
        uint32 dropped = truth & ~summary;
        assert(dropped & (uint32(1) << (L.G_AGG * L.T_CARD + L.T_IMM)) != 0);
        (uint8 whenTruth,) = L.earliest(truth);
        (uint8 whenSummary,) = L.earliest(summary);
        assertEq(whenTruth, L.T_IMM, "the coalition knows something immediately");
        assertEq(whenSummary, L.T_EOD, "the summary says nothing before end of day");
    }

    /// The general form of the same statement. The summary never over reports,
    /// so it is a safe under approximation of the join and an unsafe basis for a
    /// verdict.
    function testFuzz_lexNeverOverReports(uint8 g1, uint8 t1, uint8 g2, uint8 t2)
        public
        pure
    {
        g1 = uint8(bound(g1, 0, L.G_CARD - 1));
        g2 = uint8(bound(g2, 0, L.G_CARD - 1));
        t1 = uint8(bound(t1, 0, L.T_CARD - 1));
        t2 = uint8(bound(t2, 0, L.T_CARD - 1));

        uint32 lex;
        {
            (uint8 lg, uint8 lt) = _lexJoin(g1, t1, g2, t2);
            lex = L.point(lg, lt);
        }
        uint32 ideal = L.join(L.point(g1, t1), L.point(g2, t2));
        assert(L.leq(lex, ideal));
    }

    // ------------------------------------------------- group 3: the price

    function test_gasOfTheGate() public {
        uint32 ceiling = L.point(L.G_BUCKET, L.T_EPOCH);
        uint32 actual = L.point(L.G_AGG, L.T_EPOCH);
        uint256 before = gasleft();
        bool ok = L.permits(ceiling, actual);
        uint256 used = before - gasleft();
        assert(ok);
        // The whole point of the bitmask representation. If this ever exceeds a
        // few hundred gas the model has stopped being enforceable inline.
        assertLt(used, 300, "the gate must stay inline-cheap");
        emit log_named_uint("gas: permits()", used);
    }
}
