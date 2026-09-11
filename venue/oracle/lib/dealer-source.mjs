import {
    Signature,
    getAddress,
    isAddress,
    isHexString,
    keccak256,
    toUtf8Bytes,
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

export const SIGNED_DEALER_SOURCE = "signed-dealer";
export const MAX_DEALER_RESPONSE_BYTES = 64 * 1024;

export function dealerFetchPolicy(options = {}, env = process.env) {
    const production = options.production ?? env.NODE_ENV === "production";
    return {
        production,
        allowFileEndpoints: options.allowFileEndpoints === true,
        timeoutMs: options.timeoutMs ?? 10_000,
        authorization: options.authorization ?? env.ORACLE_DEALER_AUTHORIZATION ?? null,
    };
}

export function assertDealerEndpoint(endpoint, policy) {
    const url = String(endpoint ?? "");
    if (policy.production) {
        if (!url.startsWith("https://")) {
            throw new DealerQuoteError(
                "INSECURE_ENDPOINT",
                "production dealer endpoints must use HTTPS",
            );
        }
        return;
    }
    if (url.startsWith("file:")) {
        if (!policy.allowFileEndpoints) {
            throw new DealerQuoteError(
                "FILE_ENDPOINT_FORBIDDEN",
                "file dealer endpoints are limited to explicit tests",
            );
        }
        return;
    }
    if (!url.startsWith("https://") && !url.startsWith("http://")) {
        throw new DealerQuoteError("BAD_ENDPOINT", "dealer endpoint must be HTTP(S) or a test file URL");
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

function dealerQuoteDigest(domain, message, signer, signature) {
    const canonical = JSON.stringify({
        schema: "lattice-prime-dealer-quote-v1",
        domain: {
            name: domain.name,
            version: domain.version,
            chainId: String(domain.chainId),
            verifyingContract: domain.verifyingContract.toLowerCase(),
        },
        primaryType: "DealerQuote",
        fields: DEALER_QUOTE_TYPES.DealerQuote,
        message: {
            instrument: message.instrument.toLowerCase(),
            cleanPriceUsd8: message.cleanPriceUsd8.toString(),
            effectiveAt: message.effectiveAt.toString(),
            expiresAt: message.expiresAt.toString(),
            nonce: message.nonce,
            sourceHash: message.sourceHash,
        },
        signer: signer.toLowerCase(),
        signature,
    });
    return keccak256(toUtf8Bytes(canonical));
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

    const domain = dealerDomain({chainId, oracle});
    let signer;
    let signature;
    try {
        signature = Signature.from(raw.signature).serialized.toLowerCase();
        signer = getAddress(verifyTypedData(
            domain,
            DEALER_QUOTE_TYPES,
            message,
            signature,
        ));
    } catch (error) {
        throw new DealerQuoteError("BAD_SIGNATURE", `dealer signature is invalid: ${error.message}`);
    }
    const allowed = new Set((allowedDealers ?? []).map((address) => getAddress(address)));
    if (allowed.size === 0 || !allowed.has(signer)) {
        throw new DealerQuoteError("UNSEATED_DEALER", `dealer ${signer} is not allowed`);
    }

    return {
        source: SIGNED_DEALER_SOURCE,
        signer,
        instrument: message.instrument,
        cleanPriceUsd8: message.cleanPriceUsd8,
        effectiveAt: Number(message.effectiveAt),
        expiresAt: Number(message.expiresAt),
        nonce: message.nonce,
        sourceHash: message.sourceHash,
        sourceDigest: dealerQuoteDigest(domain, message, signer, signature),
        signature,
    };
}

function headerValue(headers, name) {
    if (!headers) return null;
    if (typeof headers.get === "function") return headers.get(name);
    return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

function classifyFetchError(error) {
    const name = error?.name ?? "";
    const message = String(error?.message ?? error);
    if (name === "TimeoutError" || name === "AbortError" || /timeout|aborted/i.test(message)) {
        return new DealerQuoteError("TIMEOUT", "dealer endpoint timed out");
    }
    if (/redirect/i.test(message)) {
        return new DealerQuoteError("REDIRECT", "dealer endpoint must not redirect");
    }
    if (error instanceof DealerQuoteError) return error;
    return new DealerQuoteError("UNREACHABLE", message);
}

async function readDealerPayload(response) {
    const contentType = String(headerValue(response.headers, "content-type") ?? "");
    if (!contentType.toLowerCase().includes("application/json")) {
        throw new DealerQuoteError("BAD_CONTENT_TYPE", "dealer response must be JSON");
    }
    const declared = headerValue(response.headers, "content-length");
    if (declared != null && declared !== "") {
        const length = Number(declared);
        if (!Number.isFinite(length) || length > MAX_DEALER_RESPONSE_BYTES) {
            throw new DealerQuoteError("RESPONSE_TOO_LARGE", "dealer response exceeds 64 KiB");
        }
    }
    if (response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
            total += bytes.byteLength;
            if (total > MAX_DEALER_RESPONSE_BYTES) {
                try { await reader.cancel(); } catch { /* already over the bound */ }
                throw new DealerQuoteError("RESPONSE_TOO_LARGE", "dealer response exceeds 64 KiB");
            }
            chunks.push(bytes);
        }
        const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
        try {
            return JSON.parse(body.toString("utf8"));
        } catch {
            throw new DealerQuoteError("MALFORMED_JSON", "dealer response is not valid JSON");
        }
    }
    const text = typeof response.text === "function"
        ? await response.text()
        : JSON.stringify(await response.json());
    if (Buffer.byteLength(text, "utf8") > MAX_DEALER_RESPONSE_BYTES) {
        throw new DealerQuoteError("RESPONSE_TOO_LARGE", "dealer response exceeds 64 KiB");
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new DealerQuoteError("MALFORMED_JSON", "dealer response is not valid JSON");
    }
}

export async function fetchDealerQuotes(endpoints, options = {}) {
    const accepted = [];
    const rejected = [];
    const policy = dealerFetchPolicy(options);
    for (const endpoint of endpoints ?? []) {
        try {
            assertDealerEndpoint(endpoint, policy);
            let payload;
            if (String(endpoint).startsWith("file:")) {
                try {
                    payload = JSON.parse(await readFile(fileURLToPath(endpoint), "utf8"));
                } catch (error) {
                    if (error instanceof SyntaxError) {
                        throw new DealerQuoteError("MALFORMED_JSON", "dealer response is not valid JSON");
                    }
                    throw error;
                }
            } else {
                const headers = {accept: "application/json"};
                if (policy.authorization) headers.authorization = policy.authorization;
                let response;
                const ac = new AbortController();
                const timer = setTimeout(() => ac.abort(), policy.timeoutMs);
                try {
                    response = await (options.fetchImpl ?? fetch)(endpoint, {
                        headers,
                        redirect: "error",
                        signal: ac.signal,
                    });
                } catch (error) {
                    throw classifyFetchError(error);
                } finally {
                    clearTimeout(timer);
                }
                if (!response.ok) {
                    throw new DealerQuoteError("HTTP_ERROR", `HTTP ${response.status}`);
                }
                payload = await readDealerPayload(response);
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
            rejected.push({
                endpoint,
                code: error.code ?? "UNREACHABLE",
                message: error.message,
            });
        }
    }
    return {accepted, rejected};
}
