// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CallAuction} from "../src/market/CallAuction.sol";

/// @title CallAuctionTest
/// @notice The clearing rule against an oracle that does not share its code.
///
/// `probes/matching-clearing.py` implements the same rule in Python from the
/// definition rather than from this Solidity, brute-forces the two structural
/// claims the Solidity *relies on but cannot check*, and writes 64 vectors to
/// `test/fixtures/clearing.json`. This suite replays them and then fuzzes the
/// same claims here, which is a weaker test on its own and a much stronger one
/// beside a differential that would catch a shared misreading of the rule.
///
/// Eight of the 64 vectors deliberately do not cross. A differential test that
/// only replays crossing books never checks the answer this venue gives on the
/// majority of its rounds: 0.36 crossings per daily round, measured.
contract CallAuctionTest is Test {
    using CallAuction for CallAuction.Limit[];

    string internal json;

    function setUp() public {
        json = vm.readFile("test/fixtures/clearing.json");
    }

    // ------------------------------------------------------ the differential

    /// @notice Every vector the Python reference produced, replayed.
    /// @dev Price, volume, both surviving endpoints and every fill. Checking the
    ///      endpoints and not only the price matters: `lo` and `hi` are what make
    ///      the midpoint reconstructible, and two implementations can agree on a
    ///      midpoint while disagreeing about which set it is the midpoint of.
    function test_theReferenceVectorsReplay() public view {
        uint256 n = vm.parseJsonUint(json, ".count");
        uint256 crossing;
        for (uint256 k = 0; k < n; ++k) {
            string memory v = string.concat(".v", vm.toString(k));
            CallAuction.Limit[] memory book = _book(v);

            CallAuction.Cross memory c = CallAuction.clear(book);
            bool wantCrossed = vm.parseJsonUint(json, string.concat(v, ".crossed")) == 1;
            assertEq(c.crossed, wantCrossed, string.concat(v, " crossed"));
            if (!wantCrossed) continue;
            crossing++;

            assertEq(
                c.priceTwice,
                vm.parseJsonUint(json, string.concat(v, ".priceTwice")),
                string.concat(v, " priceTwice")
            );
            assertEq(
                c.volume,
                vm.parseJsonUint(json, string.concat(v, ".volume")),
                string.concat(v, " volume")
            );
            assertEq(
                uint256(c.lo),
                vm.parseJsonUint(json, string.concat(v, ".lo")),
                string.concat(v, " lo")
            );
            assertEq(
                uint256(c.hi),
                vm.parseJsonUint(json, string.concat(v, ".hi")),
                string.concat(v, " hi")
            );

            uint256[] memory wantFills = vm.parseJsonUintArray(json, string.concat(v, ".fills"));
            uint128[] memory got = CallAuction.allocate(book, c);
            assertEq(got.length, wantFills.length, string.concat(v, " fill count"));
            for (uint256 i = 0; i < got.length; ++i) {
                assertEq(uint256(got[i]), wantFills[i], string.concat(v, " fill"));
            }
        }
        assertEq(crossing, 56, "the fixture's crossing/non-crossing split moved");
    }

    // ------------------------------------------------- the two structural claims

    /// @notice **Theorem A.** The scan over submitted prices is complete.
    ///
    /// `clear` never evaluates a price that nobody submitted. That is sound only
    /// if the executable volume can never peak strictly between two submitted
    /// prices, and a fuzzer over `clear` alone could never find the counterexample
    /// because it would be asking the code that made the assumption.
    ///
    /// So this evaluates `V` on a grid of half-integer steps spanning the whole
    /// submitted range and two units past each end, at twice scale so no
    /// fractional arithmetic is needed, and asserts nothing there beats the best
    /// submitted price.
    function testFuzz_theMaximumIsAttainedAtASubmittedPrice(
        uint8[8] memory sides,
        uint8[8] memory prices,
        uint16[8] memory qtys
    ) public pure {
        CallAuction.Limit[] memory book = _fuzzBook(sides, prices, qtys);

        uint256 bestSubmitted;
        uint128 loP = type(uint128).max;
        uint128 hiP;
        for (uint256 i = 0; i < book.length; ++i) {
            uint256 v = _volumeTwice(book, 2 * uint256(book[i].price));
            if (v > bestSubmitted) bestSubmitted = v;
            if (book[i].price < loP) loP = book[i].price;
            if (book[i].price > hiP) hiP = book[i].price;
        }

        uint256 from = 2 * uint256(loP) >= 4 ? 2 * uint256(loP) - 4 : 0;
        uint256 to = 2 * uint256(hiP) + 4;
        for (uint256 t = from; t <= to; ++t) {
            assertLe(
                _volumeTwice(book, t),
                bestSubmitted,
                "a price between two submitted prices cleared more volume"
            );
        }
    }

    /// @notice **Theorem B.** Both tie-break stages have connected argmax sets.
    ///
    /// The rule takes a midpoint, which presumes the surviving set is an
    /// interval. If it can be disconnected then the midpoint is a price that is
    /// not itself a survivor, `lo` and `hi` stop describing the set, and two
    /// correct implementations can return different clearing prices for the same
    /// book.
    ///
    /// Checked as contiguity of the surviving indices over the sorted distinct
    /// submitted prices, which is what connectedness means on a finite chain.
    function testFuzz_bothArgmaxSetsAreConnected(
        uint8[8] memory sides,
        uint8[8] memory prices,
        uint16[8] memory qtys
    ) public pure {
        CallAuction.Limit[] memory book = _fuzzBook(sides, prices, qtys);
        uint128[] memory grid = _sortedPrices(book);
        if (grid.length == 0) return;

        uint256 best;
        for (uint256 i = 0; i < grid.length; ++i) {
            uint256 v = _volumeTwice(book, 2 * uint256(grid[i]));
            if (v > best) best = v;
        }
        if (best == 0) return;

        bool seen;
        bool ended;
        uint256 least = type(uint256).max;
        for (uint256 i = 0; i < grid.length; ++i) {
            bool isMax = _volumeTwice(book, 2 * uint256(grid[i])) == best;
            if (isMax) {
                assertFalse(ended, "the volume maximisers are disconnected");
                seen = true;
                uint256 im = _imbalance(book, grid[i]);
                if (im < least) least = im;
            } else if (seen) {
                ended = true;
            }
        }

        seen = false;
        ended = false;
        for (uint256 i = 0; i < grid.length; ++i) {
            if (_volumeTwice(book, 2 * uint256(grid[i])) != best) continue;
            if (_imbalance(book, grid[i]) == least) {
                assertFalse(ended, "the imbalance minimisers are disconnected");
                seen = true;
            } else if (seen) {
                ended = true;
            }
        }
    }

    // --------------------------------------------------------- the allocation

    /// @notice The cleared volume is allocated exactly, on both sides, and no
    ///         order is filled beyond its own size.
    /// @dev The two halves fail in opposite directions and both are real. A
    ///      short allocation invents a settlement that does not balance; an
    ///      over-fill hands a seller's hold an amount it does not contain, which
    ///      ATS would revert at execution and which would take the whole round
    ///      down with it.
    function testFuzz_theAllocationIsExactAndNeverOverfills(
        uint8[8] memory sides,
        uint8[8] memory prices,
        uint16[8] memory qtys
    ) public pure {
        CallAuction.Limit[] memory book = _fuzzBook(sides, prices, qtys);
        CallAuction.Cross memory c = CallAuction.clear(book);
        uint128[] memory fill = CallAuction.allocate(book, c);
        if (!c.crossed) {
            for (uint256 i = 0; i < fill.length; ++i) {
                assertEq(fill[i], 0, "no cross");
            }
            return;
        }
        uint256 bought;
        uint256 sold;
        for (uint256 i = 0; i < book.length; ++i) {
            assertLe(fill[i], book[i].qty, "an order was filled beyond its size");
            if (book[i].buy) bought += fill[i];
            else sold += fill[i];
        }
        assertEq(bought, c.volume, "the buy side does not sum to the cleared volume");
        assertEq(sold, c.volume, "the sell side does not sum to the cleared volume");
    }

    // ------------------------------------------------------------- rounding

    /// @notice **The rounding is carried, not chosen.**
    ///
    /// A clearing price of 100.5 on a lot of 1,000 is 100,500 minor units. Round
    /// the price to 100 first and it is 100,000, and the 500 unit difference is
    /// paid by the seller on every fill where the two surviving prices happen to
    /// sum to an odd number, which is half of them.
    ///
    /// `docs/MATH.md` section 6 records that rounding direction is an invariant
    /// rather than a detail, for the repo accrual. This is the same invariant at
    /// a second site, and the disposition is the same: the number that would have
    /// to be rounded is never materialised.
    function test_theRoundingDirectionIsCarriedNotChosen() public pure {
        uint256 priceTwice = 201; // lo = 100, hi = 101
        uint256 qty = 1_000;

        assertEq(CallAuction.notional(priceTwice, qty), 100_500, "carried");
        assertEq((priceTwice / 2) * qty, 100_000, "rounded first");
        assertEq(
            CallAuction.notional(priceTwice, qty) - (priceTwice / 2) * qty,
            qty / 2,
            "the gap is half a lot, so it grows with the lot"
        );
    }

    /// @notice And the carried form is within half a minor unit of exact, for
    ///         every price and every lot.
    /// @dev The bound that makes the table in `CallAuction`'s header a theorem
    ///      rather than a benchmark: the round-first error is `qty/2` and grows
    ///      without limit, this one is at most one half whatever the lot is.
    function testFuzz_notionalIsWithinOneHalfUnitOfExact(uint96 priceTwice, uint96 qty)
        public
        pure
    {
        uint256 exactTwice = uint256(priceTwice) * uint256(qty);
        uint256 got = CallAuction.notional(priceTwice, qty);
        assertLe(exactTwice - 2 * got, 1, "more than half a minor unit out");
    }

    // ---------------------------------------------------------------- edges

    /// @notice A round with nothing to match is the ordinary case, not an error.
    /// @dev 0.36 crossings per daily round, measured. A rule that reverted here
    ///      would make the venue's most common outcome a failed transaction.
    function test_aRoundWithNoCrossingIsNotAnError() public pure {
        CallAuction.Limit[] memory book = new CallAuction.Limit[](2);
        book[0] = CallAuction.Limit(true, 100, 10); // bid 100
        book[1] = CallAuction.Limit(false, 101, 10); // ask 101
        CallAuction.Cross memory c = CallAuction.clear(book);
        assertFalse(c.crossed, "a bid below the ask does not cross");
        assertEq(c.volume, 0);
    }

    function test_anEmptyBookIsNotAnError() public pure {
        CallAuction.Cross memory c = CallAuction.clear(new CallAuction.Limit[](0));
        assertFalse(c.crossed);
    }

    /// @notice The overflow bound is enforced, not commented.
    /// @dev `price * qty` must fit, and the guard is at the library boundary so
    ///      a caller cannot reach the arithmetic without passing it.
    function test_anOutOfRangePriceIsRefused() public {
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 tooBig = uint128(CallAuction.SCALE_LIMIT);
        vm.expectRevert(abi.encodeWithSelector(CallAuction.PriceOutOfRange.selector, tooBig));
        this.clearOne(true, tooBig, 1);
    }

    function test_anOutOfRangeQtyIsRefused() public {
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 tooBig = uint128(CallAuction.SCALE_LIMIT);
        vm.expectRevert(abi.encodeWithSelector(CallAuction.QtyOutOfRange.selector, tooBig));
        this.clearOne(true, 1, tooBig);
    }

    /// @dev External so `expectRevert` has a call boundary to watch. The guard
    ///      lives at the library entry point, so there is no way in without it.
    function clearOne(bool buy, uint128 price, uint128 qty) external pure returns (bool) {
        CallAuction.Limit[] memory book = new CallAuction.Limit[](1);
        book[0] = CallAuction.Limit(buy, price, qty);
        return CallAuction.clear(book).crossed;
    }

    // ------------------------------------------------------------- helpers

    function _book(string memory v) internal view returns (CallAuction.Limit[] memory) {
        uint256[] memory sides = vm.parseJsonUintArray(json, string.concat(v, ".sides"));
        uint256[] memory prices = vm.parseJsonUintArray(json, string.concat(v, ".prices"));
        uint256[] memory qtys = vm.parseJsonUintArray(json, string.concat(v, ".qtys"));
        CallAuction.Limit[] memory book = new CallAuction.Limit[](sides.length);
        for (uint256 i = 0; i < sides.length; ++i) {
            // The reference writes 0 for a buy, matching `OrderBook.Side.BUY`.
            // forge-lint: disable-next-line(unsafe-typecast)
            book[i] = CallAuction.Limit(sides[i] == 0, uint128(prices[i]), uint128(qtys[i]));
        }
        return book;
    }

    /// @dev Prices are drawn from a small range on purpose: theorem A's grid is
    ///      every half step across the whole submitted range, so a wide range
    ///      would make the fuzz run measure the grid rather than the rule.
    function _fuzzBook(uint8[8] memory sides, uint8[8] memory prices, uint16[8] memory qtys)
        internal
        pure
        returns (CallAuction.Limit[] memory book)
    {
        book = new CallAuction.Limit[](8);
        for (uint256 i = 0; i < 8; ++i) {
            book[i] = CallAuction.Limit(
                sides[i] & 1 == 0, uint128(prices[i] % 64) + 1, uint128(qtys[i]) + 1
            );
        }
    }

    /// @dev `V` at a price expressed at twice scale, so half-integer prices are
    ///      evaluated with integer arithmetic only.
    function _volumeTwice(CallAuction.Limit[] memory book, uint256 twice)
        internal
        pure
        returns (uint256)
    {
        uint256 d;
        uint256 s;
        for (uint256 j = 0; j < book.length; ++j) {
            uint256 p2 = 2 * uint256(book[j].price);
            if (book[j].buy) {
                if (p2 >= twice) d += book[j].qty;
            } else {
                if (p2 <= twice) s += book[j].qty;
            }
        }
        return d < s ? d : s;
    }

    function _imbalance(CallAuction.Limit[] memory book, uint128 p)
        internal
        pure
        returns (uint256)
    {
        uint256 d;
        uint256 s;
        for (uint256 j = 0; j < book.length; ++j) {
            if (book[j].buy) {
                if (book[j].price >= p) d += book[j].qty;
            } else {
                if (book[j].price <= p) s += book[j].qty;
            }
        }
        return d > s ? d - s : s - d;
    }

    function _sortedPrices(CallAuction.Limit[] memory book)
        internal
        pure
        returns (uint128[] memory out)
    {
        uint128[] memory tmp = new uint128[](book.length);
        uint256 n;
        for (uint256 i = 0; i < book.length; ++i) {
            uint128 p = book[i].price;
            bool dup;
            for (uint256 j = 0; j < n; ++j) {
                if (tmp[j] == p) dup = true;
            }
            if (dup) continue;
            uint256 k = n;
            while (k > 0 && tmp[k - 1] > p) {
                tmp[k] = tmp[k - 1];
                --k;
            }
            tmp[k] = p;
            ++n;
        }
        out = new uint128[](n);
        for (uint256 i = 0; i < n; ++i) {
            out[i] = tmp[i];
        }
    }
}
