// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title OracleMath
/// @notice The median of a bounded panel, and nothing else.
/// @dev Insertion sort, because the array is bounded by `PrimeOracle`'s
///      `maxPublishers` immutable and a bound turns a quadratic sort into a
///      known cost. At the deployed bound of seven the worst case is
///      twenty-one comparisons, which is cheaper than the heap a general
///      implementation would reach for and, unlike the heap, is short enough to
///      read.
///
/// ## Why the median and not the mean
///
/// The mean of a panel is a weighted vote and the weights are the answers, so
/// one publisher who submits a price of `type(uint128).max` moves the mean to
/// wherever they like. The median cannot be moved past its neighbours: with `n`
/// seated and `f` dishonest, a colluding minority shifts the result by at most
/// `f` order statistics and never outside the honest range while `f < n/2`.
/// `test_oneDishonestPublisherMovesTheMedianByOneOrderStatistic` is that claim,
/// and `probes/oracle-median.py` is the brute force behind it.
///
/// ## Even panels
///
/// The mean of the two middle values, floored. This is Chainlink's own rule in
/// `Median.sol`, whose `avg` reduces to `(a + b) / 2` over non-negative inputs,
/// and it is followed here for the reason `ParameterRoot` follows one merkle
/// discipline: the repo should not hold two answers to the same question. The
/// floor is stated rather than hidden. It moves the mark down by at most one
/// tinybar of price, which is toward the lender and away from the party a
/// margin call is taken against.
library OracleMath {
    error EmptyPanel();

    /// @notice The median of `xs`. Does not mutate the caller's array.
    /// @dev Copies first: `submit` writes the panel to storage in arrival order
    ///      and `getRoundData` reads it back, so a sort in place would make the
    ///      published panel depend on who read it last.
    function median(uint256[] memory xs) internal pure returns (uint256) {
        uint256 n = xs.length;
        if (n == 0) revert EmptyPanel();

        uint256[] memory a = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            a[i] = xs[i];
        }
        sort(a);

        if (n & 1 == 1) return a[n / 2];
        // Both are at most `type(uint128).max` by `PrimeOracle.submit`, so the
        // sum cannot overflow and the average needs no widening.
        return (a[n / 2 - 1] + a[n / 2]) / 2;
    }

    /// @notice Ascending insertion sort, in place.
    /// @dev Exposed because the test suite sorts a panel to assert what the
    ///      median sits between, and a test that reimplemented the sort would be
    ///      checking its own copy rather than this one.
    function sort(uint256[] memory a) internal pure {
        for (uint256 i = 1; i < a.length; ++i) {
            uint256 x = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > x) {
                a[j] = a[j - 1];
                --j;
            }
            a[j] = x;
        }
    }

    /// @notice `|a - b|` in basis points of `b`. Zero `b` reads as no move.
    /// @dev Against the previous value and not against the new one, so the bound
    ///      a publisher has to clear is the one the venue last agreed on rather
    ///      than the one the publisher just proposed. Reversing that is how a
    ///      deviation cap gets walked: each step is small against its own
    ///      denominator and the sequence is not.
    function deviationBps(uint256 a, uint256 b) internal pure returns (uint256) {
        if (b == 0) return 0;
        uint256 d = a > b ? a - b : b - a;
        return (d * 10_000) / b;
    }
}
