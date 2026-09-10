import {keccak256, toUtf8Bytes} from "ethers";
import {percentToBps} from "./fixed.mjs";

export const NY_FED_LATEST_RATES =
    "https://markets.newyorkfed.org/api/rates/all/latest.json";

export class SofrSourceError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "SofrSourceError";
        this.code = code;
    }
}

function utcDay(timestamp) {
    const date = new Date(Number(timestamp) * 1000);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function effectiveDay(text) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(text))) {
        throw new SofrSourceError("BAD_DATE", "SOFR effectiveDate must be YYYY-MM-DD");
    }
    const value = Date.parse(`${text}T00:00:00Z`);
    if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== text) {
        throw new SofrSourceError("BAD_DATE", `invalid SOFR effective date ${text}`);
    }
    return value;
}

export function businessDaysAfter(fromDay, throughDay) {
    if (throughDay < fromDay) return -1;
    let count = 0;
    for (let day = fromDay + 86_400_000; day <= throughDay; day += 86_400_000) {
        const weekday = new Date(day).getUTCDay();
        if (weekday !== 0 && weekday !== 6) count += 1;
    }
    return count;
}

export function parseSofrResponse(payload, {
    now = Math.floor(Date.now() / 1000),
    maximumCalendarDays = 5,
    maximumBusinessDays = 2,
} = {}) {
    const rows = payload?.refRates;
    if (!Array.isArray(rows)) {
        throw new SofrSourceError("BAD_RESPONSE", "NY Fed response has no refRates array");
    }
    const row = rows.find((candidate) => candidate?.type === "SOFR");
    if (!row || row.percentRate === undefined || row.percentRate === null) {
        throw new SofrSourceError("NO_SOFR", "NY Fed response has no SOFR percentRate");
    }

    const day = effectiveDay(row.effectiveDate);
    const today = utcDay(now);
    if (day > today) {
        throw new SofrSourceError("FUTURE_RATE", "SOFR effective date is in the future");
    }
    const calendarAge = Math.floor((today - day) / 86_400_000);
    const businessAge = businessDaysAfter(day, today);
    if (calendarAge > maximumCalendarDays || businessAge > maximumBusinessDays) {
        throw new SofrSourceError(
            "STALE_RATE",
            `SOFR is ${calendarAge} calendar days and ${businessAge} business days old`,
        );
    }

    const rateBps = percentToBps(row.percentRate);
    if (rateBps > 10_000n) {
        throw new SofrSourceError("RATE_TOO_LARGE", "SOFR exceeds 100 percent");
    }
    const canonical = JSON.stringify({
        effectiveDate: row.effectiveDate,
        percentRate: String(row.percentRate),
        type: "SOFR",
        volumeInBillions: row.volumeInBillions === undefined
            ? null
            : String(row.volumeInBillions),
    });
    return {
        source: "ny-fed-sofr",
        rateBps,
        effectiveDate: row.effectiveDate,
        effectiveAt: Math.floor(day / 1000),
        calendarAge,
        businessAge,
        volumeInBillions: row.volumeInBillions ?? null,
        sourceDigest: keccak256(toUtf8Bytes(canonical)),
    };
}

export async function fetchSofr({
    url = NY_FED_LATEST_RATES,
    fetchImpl = fetch,
    timeoutMs = 15_000,
    now = Math.floor(Date.now() / 1000),
    maximumCalendarDays = 5,
    maximumBusinessDays = 2,
} = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        response = await fetchImpl(url, {
            headers: {accept: "application/json"},
            signal: controller.signal,
        });
    } catch (error) {
        throw new SofrSourceError("UNREACHABLE", `NY Fed request failed: ${error.message}`);
    } finally {
        clearTimeout(timer);
    }
    if (!response.ok) {
        throw new SofrSourceError("HTTP_ERROR", `NY Fed answered HTTP ${response.status}`);
    }
    let payload;
    try {
        payload = await response.json();
    } catch (error) {
        throw new SofrSourceError("BAD_JSON", `NY Fed response is not JSON: ${error.message}`);
    }
    return parseSofrResponse(payload, {
        now,
        maximumCalendarDays,
        maximumBusinessDays,
    });
}
