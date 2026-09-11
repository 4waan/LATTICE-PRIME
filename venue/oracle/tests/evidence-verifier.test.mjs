import {test} from "node:test";
import assert from "node:assert/strict";
import {Interface, Wallet, id} from "ethers";
import {
    QUALITY_FLAGS,
    compactEvidenceIdentity,
    encodeEvidence,
    evidenceHash,
} from "../lib/evidence.mjs";
import {verifyEvidenceTopic} from "../lib/evidence-verifier.mjs";
import {
    summarizeEvidence,
    summaryFailsClosed,
} from "../verify-evidence.mjs";

const NOW = 1_800_000_000;
const oracle = "0x4fdFf36036e13eFA7D1fB07408cE69F546c082b8";
const historicalOracle = "0x05adE174f2C410cccbC2AB4006D14Ca7a3fdA6c2";
const publisher = new Wallet("0x" + "22".repeat(32)).address;
const topic = {
    topicId: "0.0.7001",
    publisher: {
        profile: "publisher-a",
        accountId: "0.0.5001",
        evmAddress: publisher,
    },
};
const abi = [
    "function submit(uint64 round,uint128 cleanPrice,uint64 refRateBps)",
];
const iface = new Interface(abi);

function source(name, observedAt = NOW - 10) {
    return {
        observedAt,
        identity: compactEvidenceIdentity(name),
    };
}

function evidence(overrides = {}) {
    return encodeEvidence({
        chain: 296,
        oracle,
        publisher,
        round: 3,
        tx: id(`transaction:${overrides.round ?? 3}:${overrides.oracle ?? oracle}`),
        price: 10_010_000_000n,
        rate: 364n,
        observedAt: NOW,
        expiresAt: NOW + 600,
        algorithmVersion: "hybrid-vwap-usd8-v1",
        configurationDigest: id("quote configuration"),
        source: id("source bundle"),
        mode: "qualified-market",
        sources: {
            terms: source("terms"),
            sofr: source("sofr", NOW - 86_400),
            hbarNetwork: source("hbar-network"),
            hbarMarket: source("hbar-market"),
            auction: source("auction"),
            dealers: source("dealers"),
            model: source("model"),
        },
        quality: {
            flags: QUALITY_FLAGS.VALUATION_QUALIFIED |
                QUALITY_FLAGS.SOFR_QUALIFIED |
                QUALITY_FLAGS.AUCTION_QUALIFIED |
                QUALITY_FLAGS.INDEPENDENT_CROSS_CHECK,
            exactPrints: 1,
            rejectedPrints: 0,
            dealerQuotes: 1,
            rejectedDealerQuotes: 0,
            crossCheckSources: 1,
        },
        hbarNetwork: 8_000_000n,
        hbarMarket: 7_990_000n,
        previous: null,
        ...overrides,
    });
}

function message(text, sequence = 1, timestamp = `${NOW + sequence}.000000001`) {
    return {
        sequence_number: sequence,
        consensus_timestamp: timestamp,
        message: Buffer.from(text).toString("base64"),
    };
}

function resultFor(text, overrides = {}) {
    const decoded = JSON.parse(text);
    const round = decoded.round;
    const price = decoded.price;
    const rate = decoded.rate;
    return {
        result: "SUCCESS",
        address: decoded.oracle,
        from: publisher,
        function_parameters: iface.encodeFunctionData("submit", [round, price, rate]),
        timestamp: `${NOW + 20}.000000001`,
        ...overrides,
    };
}

function panelReader({
    currentOpenRound = 3,
    panels = new Map(),
    errors = new Set(),
} = {}) {
    return {
        async openRound(address) {
            if (errors.has(`${String(address).toLowerCase()}:open`)) {
                throw new Error("open round unavailable");
            }
            return currentOpenRound;
        },
        async panelOf(address, round) {
            const key = `${String(address).toLowerCase()}:${round}`;
            if (errors.has(key)) throw new Error("panel unavailable");
            return panels.get(key) ?? [];
        },
    };
}

async function verify({
    texts = [],
    panels = new Map(),
    reader = null,
    history = [],
    contractResultFn = null,
    pagedFn = null,
    now = NOW + 100,
} = {}) {
    const messages = texts.map((text, index) => message(text, index + 1));
    return verifyEvidenceTopic({
        mirrorUrl: "https://mirror.invalid",
        topic,
        oracle,
        oracleHistory: history,
        chainId: 296,
        oracleAbi: abi,
        oracleReader: reader ?? panelReader({panels}),
        now,
        pagedFn: pagedFn ?? (async () => messages),
        contractResultFn: contractResultFn ?? (async (_mirrorUrl, tx) => {
            const text = texts.find((candidate) => JSON.parse(candidate).tx === tx);
            return resultFor(text);
        }),
    });
}

test("verifier proves the EVM transaction and exact panel answer", async () => {
    const text = evidence();
    const key = `${oracle.toLowerCase()}:3`;
    const report = await verify({
        texts: [text],
        panels: new Map([[key, [{
            price: 10_010_000_000n,
            rate: 364n,
            by: publisher,
        }]]]),
    });
    assert.equal(report.verified, 1);
    assert.equal(report.currentVerified, 1);
    assert.equal(report.historicalVerified, 0);
    assert.equal(report.missingPanelEvidence, 0);
    assert.equal(report.invalid, 0);
    assert.equal(
        report.records[0].checks.find((check) =>
            check.name === "publisher answer exists in panelOf").pass,
        true,
    );
});

test("panel value mismatch invalidates evidence and reports missing exact evidence", async () => {
    const text = evidence();
    const key = `${oracle.toLowerCase()}:3`;
    const report = await verify({
        texts: [text],
        panels: new Map([[key, [{
            price: 10_020_000_000n,
            rate: 364n,
            by: publisher,
        }]]]),
    });
    assert.equal(report.verified, 0);
    assert.equal(report.invalid, 1);
    assert.equal(report.missingPanelEvidence, 1);
    assert.equal(report.records[0].state, "invalid");
});

test("onchain publisher answer without HCS evidence is detected", async () => {
    const key = `${oracle.toLowerCase()}:2`;
    const report = await verify({
        texts: [],
        panels: new Map([[key, [{
            price: 9_990_000_000n,
            rate: 360n,
            by: publisher,
        }]]]),
    });
    assert.equal(report.messages, 0);
    assert.equal(report.panelAnswers, 1);
    assert.equal(report.missingPanelEvidence, 1);
    assert.equal(report.missing[0].round, "2");
});

test("pending and expired answer evidence both fail the aggregate summary", async () => {
    const expired = evidence({
        round: 1,
        tx: id("expired"),
        observedAt: NOW - 1_000,
        expiresAt: NOW - 400,
    });
    const pending = evidence({
        round: 2,
        tx: id("pending"),
        previous: evidenceHash(expired),
    });
    const report = await verify({
        texts: [expired, pending],
        contractResultFn: async () => ({__missing: true}),
    });
    assert.equal(report.expired, 1);
    assert.equal(report.pending, 1);
    const summary = summarizeEvidence([report], oracle);
    assert.equal(summaryFailsClosed(summary), true);
});

test("contract result mirror errors are explicit and fail closed", async () => {
    const report = await verify({
        texts: [evidence()],
        contractResultFn: async () => ({__mirrorError: "mirror timed out"}),
    });
    assert.equal(report.mirrorErrors, 1);
    assert.equal(report.records[0].state, "mirror-error");
    assert.equal(summaryFailsClosed(summarizeEvidence([report], oracle)), true);
});

test("topic message mirror errors produce a fail-closed report", async () => {
    const report = await verify({
        pagedFn: async () => {
            throw new Error("topic mirror unavailable");
        },
    });
    assert.equal(report.mirrorErrors, 1);
    assert.match(report.errors[0].message, /topic mirror unavailable/);
    assert.equal(summaryFailsClosed(summarizeEvidence([report], oracle)), true);
});

test("historical oracle evidence counts only with an explicit activation range", async () => {
    const text = evidence({
        oracle: historicalOracle,
        round: 1,
        tx: id("historical transaction"),
    });
    const historicalKey = `${historicalOracle.toLowerCase()}:1`;
    const panels = new Map([[historicalKey, [{
        price: 10_010_000_000n,
        rate: 364n,
        by: publisher,
    }]]]);
    const ranged = await verify({
        texts: [text],
        panels,
        history: [{
            address: historicalOracle,
            fromRound: 1,
            toRound: 2,
        }],
    });
    assert.equal(ranged.verified, 1);
    assert.equal(ranged.currentVerified, 0);
    assert.equal(ranged.historicalVerified, 1);
    assert.equal(ranged.excluded, 0);

    let transactionQueries = 0;
    const unscoped = await verify({
        texts: [text],
        panels,
        history: [historicalOracle],
        contractResultFn: async () => {
            transactionQueries += 1;
            return resultFor(text);
        },
    });
    assert.equal(unscoped.verified, 0);
    assert.equal(unscoped.historicalVerified, 0);
    assert.equal(unscoped.excluded, 1);
    assert.equal(transactionQueries, 0);
});

test("unreadable panel state invalidates an otherwise successful answer", async () => {
    const text = evidence();
    const key = `${oracle.toLowerCase()}:3`;
    const report = await verify({
        texts: [text],
        reader: panelReader({errors: new Set([key])}),
    });
    assert.equal(report.panelErrors, 1);
    assert.equal(report.invalid, 1);
    assert.equal(report.verified, 0);
    assert.equal(summaryFailsClosed(summarizeEvidence([report], oracle)), true);
});

test("fail-closed summary rejects every blocker class", () => {
    for (const field of [
        "pending",
        "expired",
        "invalid",
        "missingPanelEvidence",
        "mirrorErrors",
        "panelErrors",
    ]) {
        const summary = {
            pending: 0,
            expired: 0,
            invalid: 0,
            missingPanelEvidence: 0,
            mirrorErrors: 0,
            panelErrors: 0,
            [field]: 1,
        };
        assert.equal(summaryFailsClosed(summary), true, field);
    }
    assert.equal(summaryFailsClosed({
        pending: 0,
        expired: 0,
        invalid: 0,
        missingPanelEvidence: 0,
        mirrorErrors: 0,
        panelErrors: 0,
    }), false);
});
