// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title CallAuction
/// @notice Uniform-price clearing. Pure: no storage, no settlement.
/// @dev Max `V=min(D,S)`; then min `|D-S|`; then midpoint as `priceTwice=lo+hi`.
///      `notional` divides once after qty. No time priority in the price.
///      Oracle: `probes/matching-clearing.py`. Formulas: `docs/MATH.md`.
library CallAuction {
    /// @notice One revealed order, reduced to what the rule needs.
    /// @dev Deliberately not `OrderBook.Order`. The rule must not be able to see
    ///      a trader, a bond or a hold, or it could come to depend on one.
    struct Limit {
        bool buy;
        uint128 price;
        uint128 qty;
    }

    /// @param crossed False when no price executes anything. A round with no
    ///        crossing is the ordinary case at this venue's order rate, not an
    ///        error: 0.36 crossings a round measured.
    /// @param priceTwice `lo + hi`. **The clearing price at twice scale, and the
    ///        only form in which it exists.** There is no `price` field, on
    ///        purpose: a caller that wants one has to divide, and the point of
    ///        the table above is that dividing early is the bug.
    struct Cross {
        bool crossed;
        uint128 lo;
        uint128 hi;
        uint256 volume;
        uint256 priceTwice;
    }

    /// @notice Prices and sizes are bounded so that every product below fits.
    /// @dev `price * qty < 2^192` and `priceTwice * qty < 2^193`, both inside a
    ///      `uint256` with room to spare. Enforced rather than commented,
    ///      because the alternative is an overflow that is silent under 0.8's
    ///      checked arithmetic only in the sense that it reverts a whole round.
    uint256 internal constant SCALE_LIMIT = 1 << 96;

    error PriceOutOfRange(uint128 price);
    error QtyOutOfRange(uint128 qty);
    /// @dev Unreachable given the interval lemma in `allocate`. Kept because an
    ///      unreachable revert is cheaper than a silently wrong allocation, and
    ///      because "unreachable" is a claim this file should have to defend.
    error NoMarginalLevel(bool buy);

    /// @notice The bound every caller must have established before clearing.
    function requireBounded(Limit[] memory book) internal pure {
        for (uint256 i = 0; i < book.length; ++i) {
            if (uint256(book[i].price) >= SCALE_LIMIT) revert PriceOutOfRange(book[i].price);
            if (uint256(book[i].qty) >= SCALE_LIMIT) revert QtyOutOfRange(book[i].qty);
        }
    }

    /// @notice The clearing price and the executable volume.
    /// @dev Two passes over `n^2`, and the shape is chosen so the second pass is
    ///      `O(n)`: the first records `V` and the imbalance per candidate, the
    ///      second selects. Fusing them would save one array and make the
    ///      selection rule harder to read than the thing it selects.
    ///
    ///      Scanning the submitted prices is **complete**, not a heuristic. `D`
    ///      and `S` change only at submitted prices, so on the open interval
    ///      between two consecutive ones both are constant and `V` there is
    ///      `min(D(p_next), S(p_prev))`, which is at most `V(p_prev)`. So the
    ///      maximum over the reals is attained at a submitted price. Brute forced
    ///      against a half-integer grid over 20,000 books, 0 counterexamples.
    function clear(Limit[] memory book) internal pure returns (Cross memory c) {
        uint256 n = book.length;
        if (n == 0) return c;
        requireBounded(book);

        uint256[] memory v = new uint256[](n);
        uint256[] memory imbalance = new uint256[](n);
        uint256 best = 0;

        for (uint256 i = 0; i < n; ++i) {
            (uint256 d, uint256 s) = _depth(book, book[i].price);
            uint256 vi = d < s ? d : s;
            v[i] = vi;
            imbalance[i] = d > s ? d - s : s - d;
            if (vi > best) best = vi;
        }
        if (best == 0) return c;

        // Among the volume maximisers, the least imbalanced; among those, the
        // outermost two prices. Resetting on a strict improvement is safe
        // because everything already seen was strictly worse, and extending on
        // equality is what makes `lo` and `hi` the ends of the surviving set
        // rather than the first and last one encountered.
        uint256 least = type(uint256).max;
        uint128 lo = 0;
        uint128 hi = 0;
        for (uint256 i = 0; i < n; ++i) {
            if (v[i] != best) continue;
            uint128 p = book[i].price;
            if (imbalance[i] < least) {
                least = imbalance[i];
                lo = p;
                hi = p;
            } else if (imbalance[i] == least) {
                if (p < lo) lo = p;
                if (p > hi) hi = p;
            }
        }

        c.crossed = true;
        c.lo = lo;
        c.hi = hi;
        c.volume = best;
        c.priceTwice = uint256(lo) + uint256(hi);
    }

    /// @notice Who trades, and how much.
    /// @dev Price priority down to the marginal level, then pro rata by size at
    ///      that level.
    ///
    ///      **The lemma the marginal-level search depends on.** `V` is constant
    ///      and equal to the maximum on the whole *real* interval `[lo, hi]`, not
    ///      merely at its two submitted endpoints. For `p` in the interval,
    ///      `D(lo) >= D(p) >= D(hi)` and `S(lo) <= S(p) <= S(hi)`, so
    ///      `V(p) >= min(D(hi), S(lo))`; and `V(lo) <= S(lo)` together with
    ///      `V(hi) <= D(hi)` give `min(D(hi), S(lo)) >= best`. So at the midpoint
    ///      the eligible quantity on each side is at least `volume`, and the
    ///      level the loop looks for always exists. Without it the midpoint could
    ///      name a price at which the cleared volume is not executable, which is
    ///      the failure a `NoMarginalLevel` revert would be reporting.
    function allocate(Limit[] memory book, Cross memory c)
        internal
        pure
        returns (uint128[] memory fill)
    {
        uint256 n = book.length;
        fill = new uint128[](n);
        if (!c.crossed) return fill;

        for (uint256 side = 0; side < 2; ++side) {
            bool buy = side == 0;
            uint128 marginal = _marginal(book, c, buy);

            uint256 residual = c.volume;
            for (uint256 i = 0; i < n; ++i) {
                if (!_eligible(book[i], c.priceTwice, buy)) continue;
                if (_strictlyBetter(book[i].price, marginal, buy)) {
                    fill[i] = book[i].qty;
                    residual -= book[i].qty;
                }
            }

            uint256 atLevel = 0;
            for (uint256 i = 0; i < n; ++i) {
                if (_eligible(book[i], c.priceTwice, buy) && book[i].price == marginal) {
                    atLevel += book[i].qty;
                }
            }

            uint256 given = 0;
            for (uint256 i = 0; i < n; ++i) {
                if (!_eligible(book[i], c.priceTwice, buy)) continue;
                if (book[i].price != marginal) continue;
                // forge-lint: disable-next-line(unsafe-typecast)
                uint128 share = uint128((residual * uint256(book[i].qty)) / atLevel);
                fill[i] = share;
                given += share;
            }

            // The stated residue. At most `k - 1` minor units, in book order.
            uint256 remainder = residual - given;
            for (uint256 i = 0; i < n && remainder != 0; ++i) {
                if (!_eligible(book[i], c.priceTwice, buy)) continue;
                if (book[i].price != marginal) continue;
                if (fill[i] < book[i].qty) {
                    fill[i] += 1;
                    remainder -= 1;
                }
            }
        }
    }

    /// @notice What `qty` at the clearing price costs, in minor units.
    /// @dev **One division, and it happens here.** See the table in the header.
    function notional(uint256 priceTwice, uint256 qty) internal pure returns (uint256) {
        return (priceTwice * qty) / 2;
    }

    // ------------------------------------------------------------- internals

    function _depth(Limit[] memory book, uint128 p)
        private
        pure
        returns (uint256 d, uint256 s)
    {
        for (uint256 j = 0; j < book.length; ++j) {
            if (book[j].buy) {
                if (book[j].price >= p) d += book[j].qty;
            } else {
                if (book[j].price <= p) s += book[j].qty;
            }
        }
    }

    /// @dev A buy is in the money at the clearing price when `2 * price` is at
    ///      least `priceTwice`. Comparing at twice scale is the same discipline
    ///      as `notional`: the half-integer clearing price is never materialised,
    ///      so a buy at exactly the midpoint of an odd sum is decided by an exact
    ///      integer comparison rather than by which way the halving went.
    function _eligible(Limit memory o, uint256 priceTwice, bool buy)
        private
        pure
        returns (bool)
    {
        if (o.buy != buy) return false;
        uint256 twice = 2 * uint256(o.price);
        return buy ? twice >= priceTwice : twice <= priceTwice;
    }

    function _strictlyBetter(uint128 p, uint128 marginal, bool buy)
        private
        pure
        returns (bool)
    {
        return buy ? p > marginal : p < marginal;
    }

    function _marginal(Limit[] memory book, Cross memory c, bool buy)
        private
        pure
        returns (uint128)
    {
        uint256 n = book.length;
        for (uint256 i = 0; i < n; ++i) {
            if (!_eligible(book[i], c.priceTwice, buy)) continue;
            uint128 p = book[i].price;
            uint256 better = 0;
            uint256 here = 0;
            for (uint256 j = 0; j < n; ++j) {
                if (!_eligible(book[j], c.priceTwice, buy)) continue;
                if (_strictlyBetter(book[j].price, p, buy)) better += book[j].qty;
                else if (book[j].price == p) here += book[j].qty;
            }
            if (better < c.volume && better + here >= c.volume) return p;
        }
        revert NoMarginalLevel(buy);
    }
}
