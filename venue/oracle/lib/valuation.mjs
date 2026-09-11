import {
    BPS,
    PRICE_SCALE,
    YEAR_SECONDS,
    deviationBps,
    median,
    mulDiv,
    uint,
} from "./fixed.mjs";

export const MARKET_VWAP_ROUNDING = "nearest-ties-up";

export class ValuationError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = "ValuationError";
        this.code = code;
        this.details = details;
    }
}

function scaleFace(faceValue, cashDecimals, outputDecimals) {
    const face = uint(faceValue, "faceValue");
    if (!Number.isInteger(cashDecimals) || !Number.isInteger(outputDecimals)) {
        throw new ValuationError("BAD_SCALE", "cash and output decimals must be integers");
    }
    const shift = outputDecimals - cashDecimals;
    if (shift >= 0) return face * 10n ** BigInt(shift);
    const divisor = 10n ** BigInt(-shift);
    if (face % divisor !== 0n) {
        throw new ValuationError("INEXACT_FACE", "face value cannot be represented at output scale");
    }
    return face / divisor;
}

function checkedDates(dates) {
    if (!Array.isArray(dates) || dates.length === 0) {
        throw new ValuationError("NO_SCHEDULE", "coupon schedule has no dates");
    }
    const out = dates.map((value, index) => uint(value, `dates[${index}]`));
    for (let index = 1; index < out.length; index++) {
        if (out[index] <= out[index - 1]) {
            throw new ValuationError("BAD_SCHEDULE", "coupon dates must be strictly ascending");
        }
    }
    return out;
}

function discountCashflow(cash, valuationAt, dueIndex, firstFuture, dates, yieldBps) {
    const unit = BPS * YEAR_SECONDS;
    let numerator = 1n;
    let denominator = 1n;
    let segmentStart = valuationAt;
    for (let index = firstFuture; index <= dueIndex; index++) {
        const segment = dates[index] - segmentStart;
        numerator *= unit;
        denominator *= unit + yieldBps * segment;
        segmentStart = dates[index];
    }
    return mulDiv(cash, numerator, denominator);
}

export function valueFloatingRateBond({
    faceValue,
    cashDecimals = 2,
    outputDecimals = 8,
    issuedAt,
    dates,
    valuationAt,
    referenceRateBps,
    couponSpreadBps,
    requiredMarginBps,
}) {
    const schedule = checkedDates(dates);
    const issued = uint(issuedAt, "issuedAt");
    const at = uint(valuationAt, "valuationAt");
    const reference = uint(referenceRateBps, "referenceRateBps");
    const spread = uint(couponSpreadBps, "couponSpreadBps");
    const margin = uint(requiredMarginBps, "requiredMarginBps");
    if (at < issued) throw new ValuationError("BEFORE_ISSUE", "valuation precedes issuance");
    if (reference + spread > BPS || reference + margin > BPS) {
        throw new ValuationError("RATE_TOO_LARGE", "coupon or discount rate exceeds 100 percent");
    }

    const firstFuture = schedule.findIndex((date) => date > at);
    if (firstFuture === -1) {
        throw new ValuationError("MATURED", "the instrument has no future cash flow");
    }

    const face = scaleFace(faceValue, cashDecimals, outputDecimals);
    const couponRate = reference + spread;
    const discountRate = reference + margin;
    const denominator = BPS * YEAR_SECONDS;
    let dirtyPrice = 0n;

    for (let index = firstFuture; index < schedule.length; index++) {
        const accrualStart = index === 0 ? issued : schedule[index - 1];
        const period = schedule[index] - accrualStart;
        const coupon = face * couponRate * period / denominator;
        const redemption = index === schedule.length - 1 ? face : 0n;
        dirtyPrice += discountCashflow(
            coupon + redemption,
            at,
            index,
            firstFuture,
            schedule,
            discountRate,
        );
    }

    const currentAccrualStart = firstFuture === 0 ? issued : schedule[firstFuture - 1];
    const accruedSeconds = at > currentAccrualStart ? at - currentAccrualStart : 0n;
    const accruedInterest = face * couponRate * accruedSeconds / denominator;
    if (dirtyPrice <= accruedInterest) {
        throw new ValuationError("NON_POSITIVE", "accrued interest is not below dirty value");
    }

    return {
        cleanPriceUsd8: dirtyPrice - accruedInterest,
        dirtyPriceUsd8: dirtyPrice,
        accruedInterestUsd8: accruedInterest,
        faceUsd8: face,
        couponRateBps: couponRate,
        discountRateBps: discountRate,
        futureCoupons: schedule.length - firstFuture,
        scale: 10n ** BigInt(outputDecimals),
    };
}

function fallbackRows(model, dealers) {
    const rows = [];
    if (model?.cleanPriceUsd8 !== undefined) {
        rows.push({source: "model", value: uint(model.cleanPriceUsd8, "model.cleanPriceUsd8")});
    }
    for (const dealer of dealers ?? []) {
        rows.push({
            source: `dealer:${dealer.signer ?? dealer.source ?? rows.length}`,
            value: uint(dealer.cleanPriceUsd8, "dealer.cleanPriceUsd8"),
        });
    }
    const unique = new Map(rows.map((row) => [row.source, row]));
    return [...unique.values()];
}

function fallbackMark(rows, minimumSources) {
    if (rows.length < minimumSources) return null;
    return {
        value: median(rows.map((row) => row.value)),
        sources: rows.map((row) => row.source),
    };
}

export function volumeWeightedMarketMark(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new ValuationError("NO_MARKET_ROWS", "market VWAP needs at least one row");
    }
    let weightedTotal = 0n;
    let totalVolume = 0n;
    for (let index = 0; index < rows.length; index++) {
        const value = uint(rows[index].value, `rows[${index}].value`);
        const volume = uint(rows[index].weight, `rows[${index}].weight`);
        if (volume === 0n) continue;
        weightedTotal += value * volume;
        totalVolume += volume;
    }
    if (totalVolume === 0n) {
        throw new ValuationError("NO_MARKET_VOLUME", "market VWAP needs positive volume");
    }
    // Products and accumulation are exact. This division is the only rounding
    // operation: nearest integer at the USD8 scale, with exact half ties rounded up.
    return mulDiv(weightedTotal, 1n, totalVolume, {round: "nearest"});
}

export function aggregateHybrid({
    prints = [],
    model = null,
    dealers = [],
    referenceRateBps,
    minimumMarketVolume = 1n,
    minimumFallbackSources = 2,
    maximumCrossCheckBps = 300n,
    requireCrossCheck = true,
}) {
    const minVolume = uint(minimumMarketVolume, "minimumMarketVolume");
    const maxDeviation = uint(maximumCrossCheckBps, "maximumCrossCheckBps");
    const marketRows = [];
    let marketVolume = 0n;
    for (const print of prints) {
        const volume = uint(print.volume, "print.volume");
        const value = uint(print.priceUsd8, "print.priceUsd8");
        if (volume === 0n || value === 0n) continue;
        marketRows.push({value, weight: volume});
        marketVolume += volume;
    }
    const market = marketVolume >= minVolume && marketRows.length > 0
        ? volumeWeightedMarketMark(marketRows)
        : null;
    const support = fallbackRows(model, dealers);
    const crossCheck = fallbackMark(support, 1);
    const fallback = fallbackMark(support, minimumFallbackSources);

    if (market !== null && crossCheck !== null) {
        const moved = deviationBps(market, crossCheck.value);
        if (moved > maxDeviation) {
            return {
                ok: false,
                code: "SOURCE_DIVERGENCE",
                reason: `qualified market and fallback differ by ${moved} bps`,
                market,
                fallback: crossCheck.value,
                deviationBps: moved,
                marketRounding: MARKET_VWAP_ROUNDING,
            };
        }
        return {
            ok: true,
            cleanPriceUsd8: market,
            referenceRateBps: uint(referenceRateBps, "referenceRateBps"),
            mode: "qualified-market",
            marketVolume,
            crossCheckUsd8: crossCheck.value,
            crossCheckSources: crossCheck.sources,
            deviationBps: moved,
            marketRounding: MARKET_VWAP_ROUNDING,
            priceScale: PRICE_SCALE,
        };
    }

    if (market !== null && !requireCrossCheck) {
        return {
            ok: true,
            cleanPriceUsd8: market,
            referenceRateBps: uint(referenceRateBps, "referenceRateBps"),
            mode: "market-only",
            marketVolume,
            crossCheckSources: [],
            marketRounding: MARKET_VWAP_ROUNDING,
            priceScale: PRICE_SCALE,
        };
    }

    if (fallback !== null) {
        return {
            ok: true,
            cleanPriceUsd8: fallback.value,
            referenceRateBps: uint(referenceRateBps, "referenceRateBps"),
            mode: "model-dealer-fallback",
            marketVolume,
            crossCheckSources: fallback.sources,
            priceScale: PRICE_SCALE,
        };
    }

    return {
        ok: false,
        code: market === null ? "SOURCE_QUORUM" : "CROSS_CHECK_MISSING",
        reason: market === null
            ? "no qualified market print and model/dealer source quorum is missing"
            : "qualified market print has no independent cross-check",
        market,
        marketVolume,
    };
}
