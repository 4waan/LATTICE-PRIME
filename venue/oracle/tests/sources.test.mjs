import {test} from "node:test";
import assert from "node:assert/strict";
import {Interface, Wallet, id, keccak256, toUtf8Bytes} from "ethers";
import {
    decodeAuctionLogs,
    qualifyAuctionGroups,
} from "../lib/auction-source.mjs";
import {
    DEALER_QUOTE_TYPES,
    dealerDomain,
    verifyDealerQuote,
} from "../lib/dealer-source.mjs";
import {
    HYBRID_QUOTE_ALGORITHM_VERSION,
    MAX_PROVENANCE_BYTES,
    QUOTE_QUALITY_FLAGS,
    buildHybridQuote,
} from "../lib/quote-engine.mjs";
import {parseSofrResponse} from "../lib/sofr-source.mjs";
import {aggregateHybrid} from "../lib/valuation.mjs";

const engineAbi = [
    "event RoundCrossed(uint64 indexed round,uint256 priceTwice,uint256 volume)",
    "event PrintedCoarse(uint64 indexed round,uint256 priceBucket,uint256 volumeBucket)",
    "event PrintWithheld(uint64 indexed round)",
    "event Settled(bytes32 indexed sellId,bytes32 indexed buyId,uint256 amount,uint256 cost)",
    "event SettlementRefused(bytes32 indexed sellId,bytes32 indexed buyId)",
];
const oracle = "0x05adE174f2C410cccbC2AB4006D14Ca7a3fdA6c2";
const instrument = "0x5Efb2Ed7b36728D4893156B9ce41b7068Fb52fe2";

function logOf(iface, event, args, tx, index, timestamp = "1800000000.000000001") {
    const encoded = iface.encodeEventLog(iface.getEvent(event), args);
    return {
        topics: encoded.topics,
        data: encoded.data,
        transaction_hash: tx,
        index,
        timestamp,
    };
}

test("SOFR parser selects the official rate and enforces business freshness", () => {
    const payload = {refRates: [
        {type: "EFFR", effectiveDate: "2027-01-04", percentRate: 4.2},
        {type: "SOFR", effectiveDate: "2027-01-04", percentRate: 3.64, volumeInBillions: 2200},
    ]};
    const now = Date.parse("2027-01-05T10:00:00Z") / 1000;
    const result = parseSofrResponse(payload, {now});
    assert.equal(result.rateBps, 364n);
    assert.equal(result.businessAge, 1);
    assert.match(result.sourceDigest, /^0x[0-9a-f]{64}$/);

    assert.throws(
        () => parseSofrResponse(payload, {
            now: Date.parse("2027-01-12T10:00:00Z") / 1000,
            maximumCalendarDays: 5,
        }),
        (error) => error.code === "STALE_RATE",
    );
});

test("dealer quotes are bound to chain, oracle, instrument, signer, and time", async () => {
    const dealer = new Wallet("0x" + "11".repeat(32));
    const message = {
        instrument,
        cleanPriceUsd8: 10_025_000_000n,
        effectiveAt: 1_800_000_000n,
        expiresAt: 1_800_003_600n,
        nonce: id("dealer-quote-1"),
        sourceHash: keccak256(toUtf8Bytes("dealer source packet")),
    };
    const signature = await dealer.signTypedData(
        dealerDomain({chainId: 296, oracle}),
        DEALER_QUOTE_TYPES,
        message,
    );
    const verified = verifyDealerQuote({...message, signature}, {
        chainId: 296,
        oracle,
        instrument,
        allowedDealers: [dealer.address],
        now: 1_800_000_060,
    });
    assert.equal(verified.signer, dealer.address);
    assert.equal(verified.cleanPriceUsd8, message.cleanPriceUsd8);
    assert.equal(verified.sourceHash, message.sourceHash);
    assert.notEqual(verified.sourceDigest, message.sourceHash);

    const verifyVariant = async (changes, chainId = 296) => {
        const variant = {...message, ...changes};
        const variantSignature = await dealer.signTypedData(
            dealerDomain({chainId, oracle}),
            DEALER_QUOTE_TYPES,
            variant,
        );
        return verifyDealerQuote({...variant, signature: variantSignature}, {
            chainId,
            oracle,
            instrument,
            allowedDealers: [dealer.address],
            now: 1_800_000_060,
        });
    };
    const changedPrice = await verifyVariant({
        cleanPriceUsd8: message.cleanPriceUsd8 + 1n,
    });
    const changedTime = await verifyVariant({
        effectiveAt: message.effectiveAt + 1n,
    });
    const changedDomain = await verifyVariant({}, 297);
    assert.notEqual(changedPrice.sourceDigest, verified.sourceDigest);
    assert.notEqual(changedTime.sourceDigest, verified.sourceDigest);
    assert.notEqual(changedDomain.sourceDigest, verified.sourceDigest);

    assert.throws(
        () => verifyDealerQuote({...message, signature}, {
            chainId: 296,
            oracle,
            instrument,
            allowedDealers: [new Wallet("0x" + "22".repeat(32)).address],
            now: 1_800_000_060,
        }),
        (error) => error.code === "UNSEATED_DEALER",
    );
});

test("mirror logs are grouped into one exact print and its settlements", () => {
    const iface = new Interface(engineAbi);
    const tx = "0x" + "ab".repeat(32);
    const sellId = "0x" + "01".repeat(32);
    const buyId = "0x" + "02".repeat(32);
    const decoded = decodeAuctionLogs([
        logOf(iface, "RoundCrossed", [7, 250_000_000_000n, 20], tx, 0),
        logOf(iface, "Settled", [sellId, buyId, 18, 1_000], tx, 1),
    ], engineAbi);
    assert.equal(decoded.groups.length, 1);
    assert.equal(decoded.groups[0].exact.round, 7);
    assert.equal(decoded.groups[0].settlements.length, 1);
    assert.equal(decoded.groups[0].refusals.length, 0);
});

test("SettlementRefused blocks an otherwise exact crossed transaction", async () => {
    const iface = new Interface(engineAbi);
    const tx = "0x" + "ac".repeat(32);
    const sellId = "0x" + "03".repeat(32);
    const buyId = "0x" + "04".repeat(32);
    const decoded = decodeAuctionLogs([
        logOf(iface, "RoundCrossed", [9, 250_000_000_000n, 20], tx, 0),
        logOf(iface, "Settled", [sellId, buyId, 20, 1_000], tx, 1),
        logOf(iface, "SettlementRefused", [sellId, buyId], tx, 2),
    ], engineAbi);
    assert.equal(decoded.groups[0].refusals.length, 1);

    const result = await qualifyAuctionGroups(decoded.groups, {
        orderLookup: async (orderId) => ({
            trader: orderId === sellId
                ? "0x" + "33".repeat(20)
                : "0x" + "44".repeat(20),
        }),
        now: 1_800_000_010,
        usdPerHbar8: 8_000_000n,
    });
    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected[0].code, "SETTLEMENT_REFUSED");
});

test("coarse, withheld, and missing settlement outputs are rejected", async () => {
    const iface = new Interface(engineAbi);
    const coarseTx = "0x" + "ad".repeat(32);
    const withheldTx = "0x" + "ae".repeat(32);
    const degraded = decodeAuctionLogs([
        logOf(iface, "PrintedCoarse", [11, 10, 1], coarseTx, 0),
        logOf(iface, "PrintWithheld", [12], withheldTx, 1),
    ], engineAbi);
    const options = {
        orderLookup: async () => {
            throw new Error("degraded output must not look up orders");
        },
        now: 1_800_000_010,
        usdPerHbar8: 8_000_000n,
    };
    const degradedResult = await qualifyAuctionGroups(degraded.groups, options);
    assert.equal(degradedResult.accepted.length, 0);
    assert.deepEqual(
        degradedResult.rejected.map((row) => row.code),
        ["DEGRADED_PRINT", "DEGRADED_PRINT"],
    );

    const missing = await qualifyAuctionGroups([{
        tx: "0x" + "af".repeat(32),
        exact: {
            round: 13,
            priceTwice: 250_000_000_000n,
            indicatedVolume: 20n,
            at: 1_800_000_000,
        },
        settlements: [],
        degraded: null,
    }], options);
    assert.equal(missing.rejected[0].code, "NO_SETTLEMENT");
});

test("synthetic and wash prints never enter valuation", async () => {
    const seller = "0x" + "33".repeat(20);
    const buyer = "0x" + "44".repeat(20);
    const group = {
        tx: "0x" + "ab".repeat(32),
        exact: {
            round: 7,
            priceTwice: 250_000_000_000n,
            indicatedVolume: 20n,
            at: 1_800_000_000,
        },
        settlements: [{
            sellId: "sell",
            buyId: "buy",
            amount: 20n,
            cost: 1_000n,
        }],
        degraded: null,
    };
    const lookup = async (orderId) => ({trader: orderId === "sell" ? seller : buyer});
    const synthetic = await qualifyAuctionGroups([group], {
        orderLookup: lookup,
        excludedAddresses: [seller],
        now: 1_800_000_010,
        usdPerHbar8: 8_000_000n,
    });
    assert.equal(synthetic.accepted.length, 0);
    assert.equal(synthetic.rejected[0].code, "SYNTHETIC_PRINT");
    const mark = aggregateHybrid({
        prints: synthetic.accepted,
        model: {cleanPriceUsd8: 10_000_000_000n},
        dealers: [{signer: buyer, cleanPriceUsd8: 10_000_000_000n}],
        referenceRateBps: 364n,
    });
    assert.equal(mark.mode, "model-dealer-fallback");
    assert.equal(mark.cleanPriceUsd8, 10_000_000_000n);

    const wash = await qualifyAuctionGroups([group], {
        orderLookup: async () => ({trader: seller}),
        now: 1_800_000_010,
        usdPerHbar8: 8_000_000n,
    });
    assert.equal(wash.rejected[0].code, "WASH_PRINT");
});

test("qualified print uses settled volume and exact fixed-point conversion", async () => {
    const seller = "0x" + "33".repeat(20);
    const buyer = "0x" + "44".repeat(20);
    const group = {
        tx: "0x" + "cd".repeat(32),
        exact: {
            round: 8,
            priceTwice: 250_000_000_000n,
            indicatedVolume: 20n,
            at: 1_800_000_000,
        },
        settlements: [{
            sellId: "sell",
            buyId: "buy",
            amount: 20n,
            cost: 1_000n,
        }],
        degraded: null,
    };
    const result = await qualifyAuctionGroups([group], {
        orderLookup: async (orderId) => ({trader: orderId === "sell" ? seller : buyer}),
        now: 1_800_000_010,
        minimumVolume: 10n,
        usdPerHbar8: 8_000_000n,
    });
    assert.equal(result.accepted.length, 1);
    assert.equal(result.accepted[0].volume, 20n);
    assert.equal(result.accepted[0].priceUsd8, 10_000_000_000n);
    assert.deepEqual(result.accepted[0].provenance, {
        transaction: group.tx,
        auctionRound: "8",
        timestamp: 1_800_000_000,
        indicatedVolume: "20",
        settledVolume: "20",
        priceTwice: "250000000000",
        priceUsd8: "10000000000",
        usdPerHbar8: "8000000",
        counterparties: [seller, buyer].sort(),
    });
});

test("settled volume must exactly equal the crossed indicated volume", async () => {
    const seller = "0x" + "55".repeat(20);
    const buyer = "0x" + "66".repeat(20);
    const base = {
        tx: "0x" + "de".repeat(32),
        exact: {
            round: 10,
            priceTwice: 250_000_000_000n,
            indicatedVolume: 20n,
            at: 1_800_000_000,
        },
        degraded: null,
    };
    const options = {
        orderLookup: async (orderId) => ({trader: orderId === "sell" ? seller : buyer}),
        now: 1_800_000_010,
        usdPerHbar8: 8_000_000n,
    };
    const partial = await qualifyAuctionGroups([{
        ...base,
        settlements: [{sellId: "sell", buyId: "buy", amount: 19n, cost: 1_000n}],
    }], options);
    assert.equal(partial.accepted.length, 0);
    assert.equal(partial.rejected[0].code, "PARTIAL_SETTLEMENT");
    assert.equal(partial.rejected[0].settledVolume, 19n);

    const excess = await qualifyAuctionGroups([{
        ...base,
        settlements: [{sellId: "sell", buyId: "buy", amount: 21n, cost: 1_000n}],
    }], options);
    assert.equal(excess.accepted.length, 0);
    assert.equal(excess.rejected[0].code, "INDICATED_VOLUME_MISMATCH");
    assert.equal(excess.rejected[0].indicatedVolume, 20n);

    const duplicate = await qualifyAuctionGroups([{
        ...base,
        settlements: [
            {sellId: "sell", buyId: "buy", amount: 10n, cost: 500n},
            {sellId: "sell", buyId: "buy", amount: 10n, cost: 500n},
        ],
    }], options);
    assert.equal(duplicate.accepted.length, 0);
    assert.equal(duplicate.rejected[0].code, "AMBIGUOUS_SETTLEMENT");
});

test("quote engine exposes deterministic compact source provenance", async () => {
    const now = 1_800_000_000;
    const dealer = "0x" + "77".repeat(20);
    const terms = {
        chainId: 296,
        rpcUrl: "https://rpc.example",
        mirrorUrl: "https://mirror.example",
        oracle,
        instrument,
        usdPerHbar8: 8_000_000n,
        faceValue: 10_000n,
        cashDecimals: 2,
        issuedAt: now - 86_400,
        dates: [now + 90 * 86_400, now + 180 * 86_400],
        spreadBps: 75n,
        sourceDigest: id("terms"),
    };
    const sofr = {
        rateBps: 364n,
        effectiveDate: "2027-01-04",
        effectiveAt: now - 86_400,
        sourceDigest: id("sofr"),
    };
    const marketRate = {
        usdPerHbar8: terms.usdPerHbar8,
        roundId: 123n,
        updatedAt: now - 20,
        sourceDigest: id("hbar-market"),
    };
    const auctionPrints = [
        {
            tx: "0x" + "ab".repeat(32),
            round: 7,
            observedAt: now - 10,
            priceUsd8: 10_000_000_000n,
            volume: 40n,
            sourceDigest: id("print-old"),
        },
        {
            tx: "0x" + "cd".repeat(32),
            round: 8,
            observedAt: now - 5,
            priceUsd8: 10_000_000_000n,
            volume: 60n,
            sourceDigest: id("print-latest"),
        },
    ];
    const dealerQuotes = [{
        signer: dealer,
        effectiveAt: now - 30,
        cleanPriceUsd8: 10_000_000_000n,
        sourceDigest: id("dealer"),
    }];
    const config = {
        network: "hedera-testnet",
        chainId: 296,
        rpcUrl: terms.rpcUrl,
        mirrorUrl: terms.mirrorUrl,
        auction: {
            minimumAggregateVolume: "100",
            maximumOutlierBps: "500",
            excludedAddresses: [],
        },
        sofr: {maximumCalendarDays: 5, maximumBusinessDays: 2},
        dealers: {
            endpoints: ["https://dealer.example"],
            allowedAddresses: [dealer],
        },
        model: {
            requiredMarginBps: "75",
            minimumFallbackSources: 2,
            maximumCrossCheckBps: "300",
            requireCrossCheck: true,
        },
        hbarMarket: {
            address: "0x" + "88".repeat(20),
            required: true,
            maximumAgeSeconds: 93_600,
            maximumDivergenceBps: "400",
        },
    };
    const dependencies = {
        now,
        readTerms: async () => terms,
        fetchSofr: async () => sofr,
        readHbarMarketRate: async () => marketRate,
        fetchAuctionPrints: async () => ({accepted: auctionPrints, rejected: []}),
        fetchDealerQuotes: async () => ({accepted: dealerQuotes, rejected: []}),
    };
    const quote = await buildHybridQuote(config, dependencies);
    assert.equal(quote.ok, true);
    assert.equal(quote.algorithmVersion, HYBRID_QUOTE_ALGORITHM_VERSION);
    assert.deepEqual(quote.provenance.latestPrint, {
        tx: auctionPrints[1].tx,
        round: "8",
        at: now - 5,
    });
    assert.deepEqual(quote.provenance.sofr, {
        date: sofr.effectiveDate,
        at: sofr.effectiveAt,
    });
    assert.deepEqual(quote.provenance.dealer, {
        signer: dealer,
        at: now - 30,
    });
    assert.deepEqual(quote.provenance.hbarMarket, {
        round: "123",
        at: now - 20,
    });
    assert.ok(
        quote.provenance.qualityFlags & QUOTE_QUALITY_FLAGS.INDEPENDENT_CROSS_CHECK,
    );
    assert.ok(quote.provenance.qualityFlags & QUOTE_QUALITY_FLAGS.MARKET_VWAP);
    assert.ok(
        Buffer.byteLength(JSON.stringify(quote.provenance), "utf8") <= MAX_PROVENANCE_BYTES,
    );

    const reordered = await buildHybridQuote(config, {
        ...dependencies,
        fetchAuctionPrints: async () => ({
            accepted: [...auctionPrints].reverse(),
            rejected: [],
        }),
    });
    assert.deepEqual(reordered.provenance, quote.provenance);
    assert.equal(reordered.sourceDigest, quote.sourceDigest);

    const changedConfig = await buildHybridQuote({
        ...config,
        auction: {...config.auction, maximumOutlierBps: "501"},
    }, dependencies);
    assert.notEqual(changedConfig.configurationDigest, quote.configurationDigest);
    assert.notEqual(changedConfig.sourceDigest, quote.sourceDigest);

    const changedProfile = await buildHybridQuote({
        ...config,
        sourceProfile: "publisher-b-secondary",
    }, dependencies);
    assert.notEqual(changedProfile.configurationDigest, quote.configurationDigest);
    assert.notEqual(changedProfile.sourceDigest, quote.sourceDigest);
});
