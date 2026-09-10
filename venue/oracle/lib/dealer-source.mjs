import {
    getAddress,
    isAddress,
    isHexString,
    verifyTypedData,
} from "ethers";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {uint} from "./fixed.mjs";

export const DEALER_QUOTE_TYPES = {
    DealerQuote: [
        {name: "instrument", type: "address"},
        {name: "cleanPriceUsd8", type: "uint128"},
        {name: "effectiveAt", type: "uint64"},
        {name: "expiresAt", type: "uint64"},
        {name: "nonce", type: "bytes32"},
        {name: "sourceHash", type: "bytes32"},
    ],
};

export class DealerQuoteError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "DealerQuoteError";
        this.code = code;
    }
}

export function dealerDomain({chainId, oracle}) {
    if (!Number.isSafeInteger(Number(chainId)) || Number(chainId) <= 0) {
        throw new DealerQuoteError("BAD_CHAIN", "chainId must be positive");
    }
    if (!isAddress(oracle)) throw new DealerQuoteError("BAD_ORACLE", "oracle is not an address");
    return {
        name: "Lattice Prime Dealer Quote",
        version: "1",
        chainId: Number(chainId),
        verifyingContract: getAddress(oracle),
    };
}

function normalizedMessage(raw, instrument) {
    if (!isAddress(instrument)) {
        throw new DealerQuoteError("BAD_INSTRUMENT", "instrument is not an address");
    }
    if (!isAddress(raw?.instrument)) {
        throw new DealerQuoteError("BAD_INSTRUMENT", "quote instrument is not an address");
    }
    if (!isHexString(raw?.nonce, 32) || !isHexString(raw?.sourceHash, 32)) {
        throw new DealerQuoteError("BAD_EVIDENCE", "nonce and sourceHash must be bytes32");
    }
    const message = {
        instrument: getAddress(raw.instrument),
        cleanPriceUsd8: uint(raw.cleanPriceUsd8, "cleanPriceUsd8"),
        effectiveAt: uint(raw.effectiveAt, "effectiveAt"),
        expiresAt: uint(raw.expiresAt, "expiresAt"),
        nonce: raw.nonce.toLowerCase(),
        sourceHash: raw.sourceHash.toLowerCase(),
    };
    if (message.instrument !== getAddress(instrument)) {
        throw new DealerQuoteError("WRONG_INSTRUMENT", "quote names another instrument");
    }
    if (message.cleanPriceUsd8 === 0n || message.cleanPriceUsd8 > (1n << 128n) - 1n) {
        throw new DealerQuoteError("BAD_PRICE", "clean price is outside uint128");
    }
    if (message.expiresAt <= message.effectiveAt) {
        throw new DealerQuoteError("BAD_WINDOW", "quote expiresAt must follow effectiveAt");
    }
    return message;
}

export function verifyDealerQuote(raw, {
    chainId,
    oracle,
    instrument,
    allowedDealers,
    now = Math.floor(Date.now() / 1000),
    maximumAgeSeconds = 3600,
    maximumFutureSeconds = 30,
} = {}) {
    const message = normalizedMessage(raw, instrument);
    const at = uint(now, "now");
    if (message.effectiveAt > at + BigInt(maximumFutureSeconds)) {
        throw new DealerQuoteError("FUTURE_QUOTE", "dealer quote is too far in the future");
    }
    if (at > message.expiresAt) {
        throw new DealerQuoteError("EXPIRED_QUOTE", "dealer quote has expired");
    }
    if (at > message.effectiveAt + BigInt(maximumAgeSeconds)) {
        throw new DealerQuoteError("STALE_QUOTE", "dealer quote exceeds maximum age");
    }
    if (typeof raw.signature !== "string") {
        throw new DealerQuoteError("NO_SIGNATURE", "dealer quote has no signature");
    }

    let signer;
    try {
        signer = getAddress(verifyTypedData(
            dealerDomain({chainId, oracle}),
            DEALER_QUOTE_TYPES,
            message,
            raw.signature,
        ));
    } catch (error) {
        throw new DealerQuoteError("BAD_SIGNATURE", `dealer signature is invalid: ${error.message}`);
    }
    const allowed = new Set((allowedDealers ?? []).map((address) => getAddress(address)));
    if (allowed.size === 0 || !allowed.has(signer)) {
        throw new DealerQuoteError("UNSEATED_DEALER", `dealer ${signer} is not allowed`);
    }

    return {
        source: raw.source ?? "signed-dealer",
        signer,
        cleanPriceUsd8: message.cleanPriceUsd8,
        effectiveAt: Number(message.effectiveAt),
        expiresAt: Number(message.expiresAt),
        nonce: message.nonce,
        sourceDigest: message.sourceHash,
        signature: raw.signature,
    };
}

export async function fetchDealerQuotes(endpoints, options = {}) {
    const accepted = [];
    const rejected = [];
    for (const endpoint of endpoints ?? []) {
        try {
            let payload;
            if (String(endpoint).startsWith("file:")) {
                payload = JSON.parse(await readFile(fileURLToPath(endpoint), "utf8"));
            } else {
                const response = await (options.fetchImpl ?? fetch)(endpoint, {
                    headers: {accept: "application/json"},
                    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                payload = await response.json();
            }
            const quotes = Array.isArray(payload) ? payload : [payload];
            for (const quote of quotes) {
                try {
                    accepted.push(verifyDealerQuote(quote, options));
                } catch (error) {
                    rejected.push({endpoint, code: error.code ?? "INVALID", message: error.message});
                }
            }
        } catch (error) {
            rejected.push({endpoint, code: "UNREACHABLE", message: error.message});
        }
    }
    return {accepted, rejected};
}
