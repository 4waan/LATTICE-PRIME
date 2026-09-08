// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {IPrimeOracle} from "../src/interfaces/IPrimeOracle.sol";

/// @title MockAggregator
/// @notice An upstream Chainlink feed, including the ways one misbehaves.
/// @dev Every switch here corresponds to a check in `PrimeOracle._cash`, and
///      each one is a real failure mode of a real feed rather than an invented
///      one: a feed can carry a non-positive answer, can hand back a round it
///      has not finished, can carry an older answer forward under a newer id,
///      can go quiet past its heartbeat, and can revert outright when its proxy
///      is repointed at something that is not an aggregator. A mock that only
///      returned good prices would let `_cash` be written wrong and stay green.
contract MockAggregator is AggregatorV3Interface {
    uint8 private _decimals = 8;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId = 1;
    uint80 public answeredInRound = 1;
    bool public reverts;

    constructor(int256 answer_, uint256 updatedAt_) {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
        roundId += 1;
        answeredInRound = roundId;
    }

    function setDecimals(uint8 d) external {
        _decimals = d;
    }

    /// @dev An answer carried forward: the id moves, the answer does not.
    function setCarriedForward() external {
        roundId += 1;
    }

    function setReverts(bool v) external {
        reverts = v;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function description() external pure returns (string memory) {
        return "MOCK / USD";
    }

    function version() external pure returns (uint256) {
        return 6;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        if (reverts) revert("aggregator down");
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }

    function getRoundData(uint80 id)
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        if (reverts) revert("aggregator down");
        return (id, answer, updatedAt, updatedAt, answeredInRound);
    }
}

/// @title StubOracle
/// @notice `IPrimeOracle` with the answers set by hand.
/// @dev **Dark by default**, and that is the point rather than a convenience.
///      Every repo suite that predates the feed constructs one of these and
///      keeps testing exactly the venue it was written against: `postMark` is
///      reachable, `markToMarket` is not, and no assertion in those files had to
///      move. Turning the feed on is one call, and the suites that do it are the
///      ones making a claim about the feed.
contract StubOracle is IPrimeOracle {
    struct RateRound {
        uint64 rate;
        uint64 publishedAt;
    }

    bool private _stale = true;
    uint256 private _mark;
    uint128 private _price;
    uint64 private _rate;
    uint64 private _ratePublishedAt;
    RateRound[] private _rates;

    function setDark(bool v) external {
        _stale = v;
    }

    /// @notice Turn the feed on with a mark in tinybars per unit of face.
    function setMark(uint256 markPerUnit) external {
        _mark = markPerUnit;
        _stale = false;
    }

    function setTerms(uint128 cleanPrice, uint64 refRateBps) external {
        _price = cleanPrice;
        _rate = refRateBps;
        _ratePublishedAt = uint64(block.timestamp);
        _rates.push(RateRound({rate: refRateBps, publishedAt: _ratePublishedAt}));
    }

    function stale() external view returns (bool) {
        return _stale;
    }

    function latest() external view returns (uint128, uint64, uint64, uint64) {
        return (_price, _rate, _ratePublishedAt, 1);
    }

    function referenceRateBefore(uint64 cutoff) external view returns (uint64, uint64, uint64) {
        for (uint256 i = _rates.length; i > 0; --i) {
            RateRound storage r = _rates[i - 1];
            // Test fixtures never approach uint64 rounds.
            // forge-lint: disable-next-line(unsafe-typecast)
            if (r.publishedAt < cutoff) return (r.rate, r.publishedAt, uint64(i));
        }
        revert("no historical rate");
    }

    function markPerUnitTinybar() external view returns (uint256) {
        if (_stale) revert("dark");
        return _mark;
    }

    /// @dev The stub has one leg, so both halves answer the same thing. A stub
    ///      that pretended to have two would be asserting `PrimeOracle`'s
    ///      behaviour on `PrimeOracle`'s behalf, which is what
    ///      `PrimeOracleTest` is for.
    function ourLegStale() external view returns (bool) {
        return _stale;
    }

    function cashLeg() external view returns (bool, uint256, uint64) {
        return (!_stale, 0, uint64(block.timestamp));
    }

    function cashFeed() external pure returns (AggregatorV3Interface) {
        return AggregatorV3Interface(address(0));
    }
}
