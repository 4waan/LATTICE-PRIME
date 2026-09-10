import {test} from "node:test";
import assert from "node:assert/strict";
import {
    deviationBps,
    median,
    parseDecimal,
    percentToBps,
    printToUsd8,
    weightedMedian,
} from "../lib/fixed.mjs";
import {aggregateHybrid, valueFloatingRateBond} from "../lib/valuation.mjs";

test("decimal parsing rounds once at the requested scale", () => {
    assert.equal(parseDecimal("3.64", 2), 364n);
    assert.equal(parseDecimal("3.645", 2), 365n);
    assert.equal(parseDecimal("8.1e-2", 8), 8_100_000n);
    assert.equal(percentToBps(3.64), 364n);
});

test("median rules match the oracle and weighted median resists a small outlier", () => {
    assert.equal(median([103n, 99n, 101n]), 101n);
    assert.equal(median([99n, 101n]), 100n);
    assert.equal(weightedMedian([
        {value: 100n, weight: 50n},
        {value: 101n, weight: 40n},
        {value: 500n, weight: 1n},
    ]), 100n);
});

test("twice-tinybar auction prices convert without losing a half tinybar", () => {
    assert.equal(printToUsd8(200_000_000n, 8_000_000n), 8_000_000n);
    assert.equal(printToUsd8(255_176_901n, 8_000_000n), 10_207_076n);
});

test("floating-rate model stays near par when coupon and discount margins match", () => {
    const day = 86_400;
    const issuedAt = 1_800_000_000;
    const dates = Array.from({length: 8}, (_, index) => issuedAt + (index + 1) * 91 * day);
    const result = valueFloatingRateBond({
        faceValue: 10_000n,
        cashDecimals: 2,
        issuedAt,
        dates,
        valuationAt: issuedAt,
        referenceRateBps: 364n,
        couponSpreadBps: 75n,
        requiredMarginBps: 75n,
    });
    assert.ok(deviationBps(result.cleanPriceUsd8, 100n * 100_000_000n) <= 2n);
    assert.equal(result.accruedInterestUsd8, 0n);
    assert.equal(result.futureCoupons, 8);
});

test("clean price removes accrued interest inside a coupon period", () => {
    const day = 86_400;
    const issuedAt = 1_800_000_000;
    const dates = [issuedAt + 91 * day, issuedAt + 182 * day];
    const atIssue = valueFloatingRateBond({
        faceValue: 10_000n,
        issuedAt,
        dates,
        valuationAt: issuedAt,
        referenceRateBps: 400n,
        couponSpreadBps: 100n,
        requiredMarginBps: 100n,
    });
    const midPeriod = valueFloatingRateBond({
        faceValue: 10_000n,
        issuedAt,
        dates,
        valuationAt: issuedAt + 45 * day,
        referenceRateBps: 400n,
        couponSpreadBps: 100n,
        requiredMarginBps: 100n,
    });
    assert.ok(midPeriod.accruedInterestUsd8 > 0n);
    assert.ok(deviationBps(midPeriod.cleanPriceUsd8, atIssue.cleanPriceUsd8) < 10n);
});

test("hybrid aggregation requires independent fallback sources", () => {
    const missing = aggregateHybrid({
        model: {cleanPriceUsd8: 10_000_000_000n},
        referenceRateBps: 364n,
        minimumFallbackSources: 2,
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "SOURCE_QUORUM");

    const fallback = aggregateHybrid({
        model: {cleanPriceUsd8: 10_000_000_000n},
        dealers: [{signer: "dealer-a", cleanPriceUsd8: 10_010_000_000n}],
        referenceRateBps: 364n,
        minimumFallbackSources: 2,
    });
    assert.equal(fallback.ok, true);
    assert.equal(fallback.mode, "model-dealer-fallback");
    assert.equal(fallback.cleanPriceUsd8, 10_005_000_000n);
});

test("qualified market price must agree with its fallback cross-check", () => {
    const accepted = aggregateHybrid({
        prints: [
            {priceUsd8: 10_000_000_000n, volume: 90n},
            {priceUsd8: 10_020_000_000n, volume: 10n},
        ],
        model: {cleanPriceUsd8: 10_010_000_000n},
        referenceRateBps: 364n,
        minimumMarketVolume: 50n,
        maximumCrossCheckBps: 300n,
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.mode, "qualified-market");
    assert.equal(accepted.cleanPriceUsd8, 10_000_000_000n);
    assert.deepEqual(accepted.crossCheckSources, ["model"]);

    const rejected = aggregateHybrid({
        prints: [{priceUsd8: 100_000_000n, volume: 100n}],
        model: {cleanPriceUsd8: 10_000_000_000n},
        dealers: [{signer: "dealer-a", cleanPriceUsd8: 10_000_000_000n}],
        referenceRateBps: 364n,
        maximumCrossCheckBps: 300n,
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "SOURCE_DIVERGENCE");
});
