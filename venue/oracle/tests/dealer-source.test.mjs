import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {Wallet, id, keccak256, toUtf8Bytes} from "ethers";
import {
    DEALER_QUOTE_TYPES,
    MAX_DEALER_RESPONSE_BYTES,
    SIGNED_DEALER_SOURCE,
    dealerDomain,
    fetchDealerQuotes,
    verifyDealerQuote,
} from "../lib/dealer-source.mjs";
import {aggregateHybrid} from "../lib/valuation.mjs";
import {loadOracleConfig} from "../lib/config.mjs";

const oracle = "0x4fdFf36036e13eFA7D1fB07408cE69F546c082b8";
const instrument = "0x5Efb2Ed7b36728D4893156B9ce41b7068Fb52fe2";
const now = 1_800_000_060;

async function signedQuote(wallet, overrides = {}) {
    const message = {
        instrument,
        cleanPriceUsd8: 10_025_000_000n,
        effectiveAt: 1_800_000_000n,
        expiresAt: 1_800_003_600n,
        nonce: id("dealer-quote-1"),
        sourceHash: keccak256(toUtf8Bytes("dealer source packet")),
        ...overrides,
    };
    const signature = await wallet.signTypedData(
        dealerDomain({chainId: 296, oracle}),
        DEALER_QUOTE_TYPES,
        message,
    );
    return {...message, signature, source: "vendor-private-label"};
}

function jsonSafe(value) {
    return JSON.stringify(value, (_key, child) =>
        typeof child === "bigint" ? child.toString() : child);
}

function jsonResponse(payload, {
    status = 200,
    contentType = "application/json",
    contentLength,
} = {}) {
    const text = typeof payload === "string" ? payload : jsonSafe(payload);
    const bytes = Buffer.from(text);
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get(name) {
                const key = name.toLowerCase();
                if (key === "content-type") return contentType;
                if (key === "content-length") {
                    return contentLength === undefined ? String(bytes.length) : contentLength;
                }
                return null;
            },
        },
        async text() { return text; },
    };
}

function streamResponse(chunks, {contentType = "application/json"} = {}) {
    const stream = new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
            }
            controller.close();
        },
    });
    return {
        ok: true,
        status: 200,
        headers: {
            get(name) {
                if (name.toLowerCase() === "content-type") return contentType;
                return null;
            },
        },
        body: stream,
    };
}

async function fetchCase(endpoint, fetchImpl, extra = {}) {
    const dealer = extra.dealer ?? new Wallet("0x" + "11".repeat(32));
    return fetchDealerQuotes([endpoint], {
        fetchImpl,
        chainId: 296,
        oracle,
        instrument,
        allowedDealers: extra.allowedDealers ?? [dealer.address],
        now,
        ...extra,
    });
}

test("institutional HTTPS quotes verify as a single object or an array", async () => {
    const dealer = new Wallet("0x" + "11".repeat(32));
    const quote = await signedQuote(dealer);
    const single = await fetchCase("https://dealer.example/quote", async () => jsonResponse(quote), {dealer});
    assert.equal(single.accepted.length, 1);
    assert.equal(single.accepted[0].signer, dealer.address);
    assert.equal(single.accepted[0].source, SIGNED_DEALER_SOURCE);
    assert.notEqual(single.accepted[0].source, quote.source);

    const second = await signedQuote(dealer, {nonce: id("dealer-quote-2")});
    const many = await fetchCase("https://dealer.example/quotes", async () => jsonResponse([quote, second]), {dealer});
    assert.equal(many.accepted.length, 2);
});

test("HTTP failures, timeouts, and redirects are rejected", async () => {
    const httpError = await fetchCase("https://dealer.example/quote", async () => jsonResponse({}, {status: 503}));
    assert.equal(httpError.rejected[0].code, "HTTP_ERROR");

    const timeout = await fetchCase("https://dealer.example/quote", async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "TimeoutError";
            reject(error);
        });
    }), {timeoutMs: 20});
    assert.equal(timeout.rejected[0].code, "TIMEOUT");

    const redirect = await fetchCase("https://dealer.example/quote", async () => {
        throw new TypeError("unexpected redirect");
    });
    assert.equal(redirect.rejected[0].code, "REDIRECT");
});

test("production permits HTTPS only and keeps file endpoints for explicit tests", async () => {
    const dealer = new Wallet("0x" + "11".repeat(32));
    const quote = await signedQuote(dealer);
    const root = mkdtempSync(join(tmpdir(), "dealer-file-"));
    const filePath = join(root, "quote.json");
    writeFileSync(filePath, jsonSafe(quote));
    const fileUrl = pathToFileURL(filePath).href;
    try {
        const httpProd = await fetchCase("http://dealer.example/quote", async () => jsonResponse(quote), {
            dealer,
            production: true,
        });
        assert.equal(httpProd.rejected[0].code, "INSECURE_ENDPOINT");

        const fileProd = await fetchCase(fileUrl, undefined, {
            dealer,
            production: true,
            allowFileEndpoints: true,
        });
        assert.equal(fileProd.rejected[0].code, "INSECURE_ENDPOINT");

        const fileForbidden = await fetchCase(fileUrl, undefined, {dealer, production: false});
        assert.equal(fileForbidden.rejected[0].code, "FILE_ENDPOINT_FORBIDDEN");

        const fileAllowed = await fetchCase(fileUrl, undefined, {
            dealer,
            production: false,
            allowFileEndpoints: true,
        });
        assert.equal(fileAllowed.accepted.length, 1);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("production configuration rejects a file dealer endpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "dealer-config-"));
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify({
        sourceProfile: "publisher-a-primary",
        dealers: {endpoints: ["file:///dealer/quote.json"]},
    }));
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
        assert.throws(
            () => loadOracleConfig(path),
            (error) => error.code === "INSECURE_DEALER_ENDPOINT",
        );
    } finally {
        if (previous === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previous;
        rmSync(root, {recursive: true, force: true});
    }
});

test("wrong content type, oversized bodies, and malformed JSON are rejected", async () => {
    const dealer = new Wallet("0x" + "11".repeat(32));
    const quote = await signedQuote(dealer);
    const type = await fetchCase("https://dealer.example/quote", async () => jsonResponse(quote, {
        contentType: "text/plain",
    }), {dealer});
    assert.equal(type.rejected[0].code, "BAD_CONTENT_TYPE");

    const oversized = await fetchCase("https://dealer.example/quote", async () => jsonResponse(quote, {
        contentLength: String(MAX_DEALER_RESPONSE_BYTES + 1),
    }), {dealer});
    assert.equal(oversized.rejected[0].code, "RESPONSE_TOO_LARGE");

    const streamed = await fetchCase("https://dealer.example/quote", async () => streamResponse([
        "x".repeat(MAX_DEALER_RESPONSE_BYTES + 8),
    ]), {dealer});
    assert.equal(streamed.rejected[0].code, "RESPONSE_TOO_LARGE");

    const malformed = await fetchCase("https://dealer.example/quote", async () => jsonResponse("{", {
        contentType: "application/json",
    }), {dealer});
    assert.equal(malformed.rejected[0].code, "MALFORMED_JSON");
});

test("quote validation stays bound to chain, oracle, instrument, signer, and time", async () => {
    const dealer = new Wallet("0x" + "11".repeat(32));
    const quote = await signedQuote(dealer);
    const options = {
        chainId: 296,
        oracle,
        instrument,
        allowedDealers: [dealer.address],
        now,
    };
    assert.throws(
        () => verifyDealerQuote(quote, {...options, chainId: 297}),
        (error) => error.code === "BAD_SIGNATURE" || error.code === "UNSEATED_DEALER",
    );
    assert.throws(
        () => verifyDealerQuote(quote, {
            ...options,
            oracle: "0x05adE174f2C410cccbC2AB4006D14Ca7a3fdA6c2",
        }),
        (error) => error.code === "BAD_SIGNATURE" || error.code === "UNSEATED_DEALER",
    );
    assert.throws(
        () => verifyDealerQuote(quote, {
            ...options,
            instrument: "0x00000000000000000000000000000000000000aa",
        }),
        (error) => error.code === "WRONG_INSTRUMENT",
    );
    assert.throws(
        () => verifyDealerQuote(quote, {
            ...options,
            allowedDealers: [new Wallet("0x" + "22".repeat(32)).address],
        }),
        (error) => error.code === "UNSEATED_DEALER",
    );
    const other = new Wallet("0x" + "33".repeat(32));
    const forged = {...quote, signature: (await signedQuote(other)).signature};
    assert.throws(
        () => verifyDealerQuote(forged, options),
        (error) => error.code === "UNSEATED_DEALER" || error.code === "BAD_SIGNATURE",
    );
    assert.throws(
        () => verifyDealerQuote(quote, {...options, now: 1_800_004_000}),
        (error) => error.code === "EXPIRED_QUOTE",
    );
    const longLived = await signedQuote(dealer, {expiresAt: 1_800_100_000n});
    assert.throws(
        () => verifyDealerQuote(longLived, {...options, now: 1_800_003_601}),
        (error) => error.code === "STALE_QUOTE",
    );
    assert.throws(
        () => verifyDealerQuote(quote, {...options, now: 1_799_000_000}),
        (error) => error.code === "FUTURE_QUOTE",
    );
    assert.throws(
        () => verifyDealerQuote({...quote, cleanPriceUsd8: 0n}, options),
        (error) => error.code === "BAD_PRICE",
    );
    const {nonce, ...noNonce} = quote;
    assert.throws(
        () => verifyDealerQuote(noNonce, options),
        (error) => error.code === "BAD_EVIDENCE",
    );
    const {sourceHash, ...noHash} = quote;
    assert.throws(
        () => verifyDealerQuote(noHash, options),
        (error) => error.code === "BAD_EVIDENCE",
    );
});

test("unsigned source text cannot change dealer identity or authorization", async () => {
    const dealer = new Wallet("0x" + "11".repeat(32));
    const quote = await signedQuote(dealer);
    quote.source = "impersonated-institutional-desk";
    const verified = verifyDealerQuote(quote, {
        chainId: 296,
        oracle,
        instrument,
        allowedDealers: [dealer.address],
        now,
    });
    assert.equal(verified.signer, dealer.address);
    assert.equal(verified.source, SIGNED_DEALER_SOURCE);
    const mark = aggregateHybrid({
        model: {cleanPriceUsd8: 10_025_000_000n},
        dealers: [{...verified, source: "impersonated-institutional-desk"}],
        referenceRateBps: 364n,
        minimumFallbackSources: 2,
    });
    assert.deepEqual(mark.crossCheckSources, ["model", `dealer:${dealer.address}`]);
});
