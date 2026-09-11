import {test} from "node:test";
import assert from "node:assert/strict";
import {id, keccak256, toUtf8Bytes} from "ethers";
import {readHbarMarketRate} from "../lib/hbar-market-source.mjs";
import {readDeployment, readInstrumentTerms} from "../lib/terms-source.mjs";
import {HYBRID_QUOTE_ALGORITHM_VERSION, buildHybridQuote} from "../lib/quote-engine.mjs";

const now = 1_800_000_000;
const feedAddress = "0x" + "88".repeat(20);

function scheduleFixture(overrides = {}) {
    return {
        issuedAt: async () => 1_700_000_000n,
        dates: async () => [1_800_000_000n, 1_810_000_000n],
        spreadBps: async () => 75n,
        faceValue: async () => 10_000n,
        basis: async () => 1n,
        ...overrides,
    };
}

function cashFixture(overrides = {}) {
    return {
        ok: true,
        usdPerHbar: 8_000_000n,
        updatedAt: 1_799_999_000n,
        ...overrides,
    };
}

test("terms adapter reads deployment addresses and contract terms", async () => {
    const {client} = readDeployment();
    const terms = await readInstrumentTerms({
        scheduleContract: scheduleFixture(),
        oracleContract: {cashLeg: async () => cashFixture()},
    });
    assert.equal(terms.chainId, 296);
    assert.equal(terms.oracle.toLowerCase(), client.addresses.PrimeOracle.toLowerCase());
    assert.equal(terms.instrument.toLowerCase(), client.addresses.token.toLowerCase());
    assert.equal(terms.schedule.toLowerCase(), client.addresses.CouponSchedule.toLowerCase());
    assert.equal(terms.engine.toLowerCase(), client.addresses.MatchingEngine.toLowerCase());
    assert.equal(terms.usdPerHbar8, 8_000_000n);
    assert.equal(terms.spreadBps, 75n);
    assert.match(terms.sourceDigest, /^0x[0-9a-f]{64}$/);
    const again = await readInstrumentTerms({
        scheduleContract: scheduleFixture(),
        oracleContract: {cashLeg: async () => cashFixture()},
    });
    assert.equal(again.sourceDigest, terms.sourceDigest);
});

test("terms adapter rejects missing addresses and malformed numerics", async () => {
    const {client} = readDeployment();
    await assert.rejects(
        () => readInstrumentTerms({
            client: {
                ...client,
                addresses: {...client.addresses, PrimeOracle: "0x0000000000000000000000000000000000000000"},
            },
            scheduleContract: scheduleFixture(),
            oracleContract: {cashLeg: async () => cashFixture()},
        }),
        /missing PrimeOracle/,
    );
    await assert.rejects(
        () => readInstrumentTerms({
            client: {
                ...client,
                addresses: {...client.addresses, token: "not-an-address"},
            },
            scheduleContract: scheduleFixture(),
            oracleContract: {cashLeg: async () => cashFixture()},
        }),
        /missing token/,
    );
    await assert.rejects(
        () => readInstrumentTerms({
            scheduleContract: scheduleFixture({basis: async () => 2n}),
            oracleContract: {cashLeg: async () => cashFixture()},
        }),
        /unsupported coupon basis/,
    );
    await assert.rejects(
        () => readInstrumentTerms({
            scheduleContract: scheduleFixture(),
            oracleContract: {cashLeg: async () => cashFixture({usdPerHbar: "not-a-number"})},
        }),
        /usdPerHbar is malformed/,
    );
    await assert.rejects(
        () => readInstrumentTerms({
            scheduleContract: scheduleFixture(),
            oracleContract: {cashLeg: async () => cashFixture({ok: false})},
        }),
        /unavailable/,
    );
});

test("HBAR market adapter rejects stale, missing, and incomplete rounds", async () => {
    const latest = {
        0: 12n,
        1: 8_000_000n,
        3: 1_799_999_980n,
        4: 12n,
    };
    const fresh = await readHbarMarketRate({
        address: feedAddress,
        now,
        feedContract: {
            decimals: async () => 8,
            description: async () => "HBAR / USD",
            latestRoundData: async () => latest,
        },
    });
    assert.equal(fresh.usdPerHbar8, 8_000_000n);
    assert.equal(
        fresh.sourceDigest,
        keccak256(toUtf8Bytes(JSON.stringify({
            address: feedAddress.toLowerCase(),
            roundId: "12",
            answer: "8000000",
            updatedAt: "1799999980",
            answeredInRound: "12",
        }))),
    );

    await assert.rejects(
        () => readHbarMarketRate({
            address: feedAddress,
            now,
            maximumAgeSeconds: 60,
            feedContract: {
                decimals: async () => 8,
                description: async () => "HBAR / USD",
                latestRoundData: async () => ({...latest, 3: 1_799_999_000n}),
            },
        }),
        (error) => error.code === "STALE",
    );
    await assert.rejects(
        () => readHbarMarketRate({
            address: feedAddress,
            now,
            feedContract: {
                decimals: async () => 8,
                description: async () => "HBAR / USD",
                latestRoundData: async () => ({...latest, 3: 0n}),
            },
        }),
        (error) => error.code === "BAD_ROUND",
    );
});

test("required market cross-check and excessive divergence fail closed", async () => {
    const terms = {
        chainId: 296,
        rpcUrl: "https://rpc.example",
        mirrorUrl: "https://mirror.example",
        oracle: "0x4fdFf36036e13eFA7D1fB07408cE69F546c082b8",
        instrument: "0x5Efb2Ed7b36728D4893156B9ce41b7068Fb52fe2",
        usdPerHbar8: 8_000_000n,
        faceValue: 10_000n,
        cashDecimals: 2,
        issuedAt: now - 86_400,
        dates: [now + 90 * 86_400],
        spreadBps: 75n,
        sourceDigest: id("terms"),
    };
    const config = {
        network: "hedera-testnet",
        chainId: 296,
        sourceProfile: "publisher-a-primary",
        dealers: {endpoints: [], allowedAddresses: []},
        model: {requireCrossCheck: true, minimumFallbackSources: 2, maximumCrossCheckBps: "300"},
        hbarMarket: {
            address: feedAddress,
            required: true,
            maximumAgeSeconds: 93_600,
            maximumDivergenceBps: "400",
        },
    };
    const missing = await buildHybridQuote(config, {
        now,
        readTerms: async () => terms,
        fetchSofr: async () => ({rateBps: 364n, effectiveDate: "2027-01-04", effectiveAt: now, sourceDigest: id("sofr")}),
        readHbarMarketRate: async () => {
            throw Object.assign(new Error("feed down"), {code: "UNAVAILABLE"});
        },
        fetchAuctionPrints: async () => ({accepted: [], rejected: []}),
        fetchDealerQuotes: async () => ({accepted: [], rejected: []}),
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "HBAR_MARKET_UNAVAILABLE");

    const diverged = await buildHybridQuote(config, {
        now,
        readTerms: async () => terms,
        fetchSofr: async () => ({rateBps: 364n, effectiveDate: "2027-01-04", effectiveAt: now, sourceDigest: id("sofr")}),
        readHbarMarketRate: async () => ({
            usdPerHbar8: 8_400_000n,
            roundId: 9n,
            updatedAt: now - 10,
            sourceDigest: id("hbar-market"),
        }),
        fetchAuctionPrints: async () => ({accepted: [], rejected: []}),
        fetchDealerQuotes: async () => ({accepted: [], rejected: []}),
    });
    assert.equal(diverged.ok, false);
    assert.equal(diverged.code, "HBAR_RATE_DIVERGENCE");
    assert.equal(diverged.algorithmVersion, HYBRID_QUOTE_ALGORITHM_VERSION);
});
