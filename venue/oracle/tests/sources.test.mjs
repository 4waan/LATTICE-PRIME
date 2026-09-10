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
import {parseSofrResponse} from "../lib/sofr-source.mjs";

const engineAbi = [
    "event RoundCrossed(uint64 indexed round,uint256 priceTwice,uint256 volume)",
    "event PrintedCoarse(uint64 indexed round,uint256 priceBucket,uint256 volumeBucket)",
    "event Settled(bytes32 indexed sellId,bytes32 indexed buyId,uint256 amount,uint256 cost)",
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
            amount: 18n,
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
            amount: 18n,
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
    assert.equal(result.accepted[0].volume, 18n);
    assert.equal(result.accepted[0].priceUsd8, 10_000_000_000n);
});
