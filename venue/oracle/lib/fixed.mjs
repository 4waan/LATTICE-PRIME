export const PRICE_SCALE = 100_000_000n;
export const TINYBAR_PER_HBAR = 100_000_000n;
export const BPS = 10_000n;
export const YEAR_SECONDS = 365n * 24n * 60n * 60n;

export class NumericInputError extends RangeError {}

export function uint(value, name = "value") {
    let out;
    try {
        out = typeof value === "bigint" ? value : BigInt(value);
    } catch {
        throw new NumericInputError(`${name} must be an integer`);
    }
    if (out < 0n) throw new NumericInputError(`${name} must not be negative`);
    return out;
}

export function parseDecimal(value, decimals, name = "value") {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
        throw new NumericInputError("decimals must be an integer from 0 to 30");
    }
    const text = String(value).trim();
    const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!match) throw new NumericInputError(`${name} is not a decimal number`);
    if (match[1] === "-") throw new NumericInputError(`${name} must not be negative`);

    const exponent = Number(match[4] ?? 0);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) {
        throw new NumericInputError(`${name} exponent is out of range`);
    }
    const whole = match[2];
    const fraction = match[3] ?? "";
    const digits = (whole + fraction).replace(/^0+(?=\d)/, "");
    const decimalPlaces = fraction.length - exponent;
    const targetShift = decimals - decimalPlaces;

    if (targetShift >= 0) return BigInt(digits || "0") * 10n ** BigInt(targetShift);

    const divisor = 10n ** BigInt(-targetShift);
    const raw = BigInt(digits || "0");
    const quotient = raw / divisor;
    const remainder = raw % divisor;
    return quotient + (remainder * 2n >= divisor ? 1n : 0n);
}

export function percentToBps(value) {
    return parseDecimal(value, 2, "percent rate");
}

export function median(values) {
    if (!Array.isArray(values) || values.length === 0) {
        throw new NumericInputError("median needs at least one value");
    }
    const sorted = values.map((value) => uint(value)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2n;
}

export function weightedMedian(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new NumericInputError("weighted median needs at least one row");
    }
    const sorted = rows.map((row, index) => ({
        value: uint(row.value, `rows[${index}].value`),
        weight: uint(row.weight, `rows[${index}].weight`),
    })).filter((row) => row.weight > 0n)
        .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    if (sorted.length === 0) throw new NumericInputError("weighted median needs positive weight");

    const total = sorted.reduce((sum, row) => sum + row.weight, 0n);
    let cumulative = 0n;
    for (const row of sorted) {
        cumulative += row.weight;
        if (cumulative * 2n >= total) return row.value;
    }
    return sorted.at(-1).value;
}

export function deviationBps(value, reference) {
    const a = uint(value, "value");
    const b = uint(reference, "reference");
    if (b === 0n) throw new NumericInputError("reference must be positive");
    const delta = a > b ? a - b : b - a;
    return delta * BPS / b;
}

export function printToUsd8(priceTwice, usdPerHbar8) {
    const twice = uint(priceTwice, "priceTwice");
    const rate = uint(usdPerHbar8, "usdPerHbar8");
    if (rate === 0n) throw new NumericInputError("usdPerHbar8 must be positive");
    return twice * rate / (2n * TINYBAR_PER_HBAR);
}

export function mulDiv(value, multiplier, denominator, {round = "floor"} = {}) {
    const x = uint(value, "value");
    const y = uint(multiplier, "multiplier");
    const d = uint(denominator, "denominator");
    if (d === 0n) throw new NumericInputError("denominator must be positive");
    const product = x * y;
    const quotient = product / d;
    const remainder = product % d;
    if (round === "floor") return quotient;
    if (round === "ceil") return quotient + (remainder === 0n ? 0n : 1n);
    if (round === "nearest") return quotient + (remainder * 2n >= d ? 1n : 0n);
    throw new NumericInputError(`unknown rounding mode ${round}`);
}
