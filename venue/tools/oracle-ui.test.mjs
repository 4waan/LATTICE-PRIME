import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import * as ethers from "ethers";

const source = readFileSync(new URL("./venue-obs.mjs", import.meta.url), "utf8");
const runtime = readFileSync(new URL("./venue-app.mjs", import.meta.url), "utf8");
const marketsTemplate = readFileSync(
    new URL("../app/trade.template.html", import.meta.url),
    "utf8",
);
const financingTemplate = readFileSync(
    new URL("../app/repo.template.html", import.meta.url),
    "utf8",
);

const ZERO = "0x0000000000000000000000000000000000000000";
const ORACLE = "0x00000000000000000000000000000000000000aa";
const PUBLISHER_A = "0x00000000000000000000000000000000000000a1";
const PUBLISHER_B = "0x00000000000000000000000000000000000000b2";
const SCHEDULER = "0x00000000000000000000000000000000000000cc";

function makeElement() {
    const classes = new Set();
    return {
        textContent: "",
        innerHTML: "",
        className: "",
        hidden: false,
        value: "",
        classList: {
            add: (name) => classes.add(name),
            remove: (name) => classes.delete(name),
            toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
            contains: (name) => classes.has(name),
        },
        addEventListener: () => {},
        querySelectorAll: () => [],
        focus: () => {},
        select: () => {},
    };
}

function harness({now = 10_000, topics = [], schedulerRecord = null} = {}) {
    const elements = new Map();
    let currentNow = BigInt(now);
    const element = (name) => {
        if (!elements.has(name)) elements.set(name, makeElement());
        return elements.get(name);
    };
    const Venue = {c: {}, reader: {}};
    runInNewContext(source, {
        Venue,
        $: element,
        esc: String,
        shortId: String,
        shortAddr: (value) => String(value).slice(0, 6),
        asBig: BigInt,
        fmtRemain: (value) => String(value) + "s",
        addrEq: (left, right) =>
            String(left).toLowerCase() === String(right).toLowerCase(),
        decodeRevert: (error) => ({message: error?.message || String(error)}),
        formatPrice: String,
        readableHbar: String,
        explorerAddr: String,
        WEIBAR_PER_TINYBAR: 10_000_000_000n,
        CLIENT: {
            addresses: {
                RepoVault: "0x0000000000000000000000000000000000000001",
                PrimeOracle: ORACLE,
            },
            network: {
                chainId: 296,
                explorer: "https://example.test",
                mirror: "https://mirror.test",
            },
        },
        FINANCING_EVIDENCE: {},
        ORACLE_TOPICS: topics,
        ORACLE_SCHEDULER: schedulerRecord,
        ZERO,
        G: {EXACT: 4},
        T: {IMM: 0},
        nowSec: () => currentNow,
        navigator: {clipboard: {writeText: async () => {}}},
        document: {execCommand: () => false},
        setTimeout: () => {},
        Date,
        fetch: async () => ({ok: true, json: async () => ({})}),
        AbortController,
        ethers,
        atob,
        TextDecoder,
        Uint8Array,
        JSON,
        Promise,
        Buffer,
    });
    return {
        Venue,
        element,
        setNow: (value) => {
            currentNow = BigInt(value);
        },
    };
}

function schedulerState(latestProblem = null) {
    return {
        status: "ready",
        address: SCHEDULER,
        boundOracle: ORACLE,
        bindingIssues: [],
        active: ZERO,
        nextCheckAt: 0,
        trackedRound: 6,
        retryStreak: 0,
        checks: 0,
        maxRetry: 4,
        maxChecks: 8,
        minimumTinybar: 500_000_000n,
        balanceTinybar: 1_000_000_000n,
        events: latestProblem ? [latestProblem] : [],
        eventError: null,
        latestEvent: latestProblem,
        latestProblem,
    };
}

function baseEvidence() {
    return {configured: false, records: [], errors: [], empty: []};
}

function installOracle(h, {
    feed = {},
    heartbeat = 1_000n,
    evidence = baseEvidence(),
    finalizedAnswers = [],
    openAnswers = [],
    finalizedRound = 5n,
    nextRound = 6n,
    panelFailureRound = null,
    scheduler = schedulerState(),
} = {}) {
    const completeFeed = {
        dark: false,
        ourLegDark: false,
        cashLegDark: false,
        cleanPrice: 10_000_000_000n,
        refRateBps: 364n,
        publishedAt: 9_990n,
        usdPerHbar: 8_000_000n,
        markPerUnitTinybar: 125_000_000n,
        cashFeed: "0x00000000000000000000000000000000000000dd",
        ...feed,
    };
    h.Venue.page = "repo";
    h.Venue.c.watch = {feed: async () => completeFeed};
    h.Venue.c.oracle = {
        publishers: async () => [PUBLISHER_A, PUBLISHER_B],
        quorum: async () => 2n,
        heartbeat: async () => heartbeat,
        cashHeartbeat: async () => 2_000n,
        maxDeviationBps: async () => 500n,
        lastRound: async () => finalizedRound,
        openRound: async () => nextRound,
        cashLeg: async () => ({updatedAt: 9_995n}),
        panelOf: async (round) => {
            if (String(round) === String(panelFailureRound)) {
                throw new Error("panel RPC timeout");
            }
            return String(round) === String(finalizedRound)
                ? finalizedAnswers
                : openAnswers;
        },
    };
    h.Venue.refreshOracleEvidence = async () => evidence;
    h.Venue.readOracleScheduler = async () => scheduler;
    return completeFeed;
}

function answerRow({
    publisher,
    profile,
    sequence,
    price,
    rate = "364",
    observedAt = 9_980,
    consensus = "9985.000000001",
    mode = "qualified-market",
    hbarMarket = "7990000",
    round = "5",
}) {
    const exactPrints = mode === "model-dealer-fallback" ? 0 : 2;
    const dealerQuotes = mode === "model-dealer-fallback" ? 1 : 0;
    const identity = (digit) => "0x" + String(digit).repeat(16);
    return {
        topic: {topicId: "0.0." + sequence, profile, publisher},
        sequence: String(sequence),
        consensus,
        record: {
            v: 1,
            k: "oracle-answer",
            chain: 296,
            oracle: ORACLE,
            publisher,
            round: String(round),
            tx: "0x" + String(sequence).padStart(64, "0"),
            price: String(price),
            rate: String(rate),
            observedAt,
            expiresAt: observedAt + 600,
            av: "hybrid-vwap-usd8-v1",
            cfg: "0x" + "22".repeat(32),
            source: "0x" + "11".repeat(32),
            mode,
            tr: "NEW_SOFR",
            ss: {
                t: [observedAt, identity(1)],
                r: [observedAt, identity(2)],
                n: [observedAt, identity(3)],
                h: hbarMarket == null ? null : [observedAt, identity(4)],
                a: exactPrints ? [observedAt, identity(5)] : null,
                d: dealerQuotes ? [observedAt, identity(6)] : null,
                m: [observedAt, identity(7)],
            },
            q: [255, exactPrints, 0, dealerQuotes, 0, 1],
            exactPrints,
            dealerQuotes,
            hbarNetwork: "8000000",
            hbarMarket,
            previous: null,
        },
    };
}

function statusRow({
    publisher,
    profile,
    sequence,
    code,
    observedAt,
    round = "6",
}) {
    return {
        topic: {topicId: "0.0." + sequence, profile, publisher},
        sequence: String(sequence),
        consensus: observedAt + ".000000001",
        record: {
            v: 1,
            k: "oracle-status",
            chain: 296,
            oracle: ORACLE,
            publisher,
            round,
            observedAt,
            code,
            exactPrints: 0,
            rejectedPrints: 1,
            dealerQuotes: 0,
            answerCount: 1,
            hbarNetwork: "8000000",
            hbarMarket: "7990000",
            hbarDivergenceBps: code === "HBAR_RATE_DIVERGENCE" ? "450" : null,
            previous: null,
        },
    };
}

test("panel stale and RPC failure hide every valuation", async () => {
    const h = harness();
    const feed = installOracle(h, {
        feed: {
            dark: true,
            ourLegDark: true,
            markPerUnitTinybar: 0n,
            publishedAt: 8_000n,
        },
        openAnswers: [{price: 10_000_000_000n, rate: 364n, by: PUBLISHER_A}],
    });

    await h.Venue.refreshOracle();
    assert.equal(h.element("feed-state").innerHTML, "panel stale");
    assert.equal(h.element("feed-price").innerHTML, "Unavailable");
    assert.equal(h.element("feed-rate").innerHTML, "Unavailable");
    assert.equal(h.element("feed-mark").innerHTML, "Unavailable");
    assert.match(h.element("feed-failure").textContent, /Panel stale/);

    h.Venue.c.watch.feed = async () => {
        throw new Error("testnet RPC timed out");
    };
    assert.equal(await h.Venue.pollOracle(), false);
    assert.equal(h.element("feed-state").textContent, "RPC unavailable");
    assert.equal(h.element("feed-price").textContent, "Unavailable");
    assert.equal(h.element("feed-rate").textContent, "Unavailable");
    assert.equal(h.element("feed-mark").textContent, "Unavailable");
    assert.match(h.element("feed-failure").textContent, /RPC refresh failed/);
    assert.doesNotMatch(h.element("feed-scheduler").textContent, /Not deployed/);
    assert.equal(feed.dark, true);
});

test("panel read failure never becomes zero answers", async () => {
    const h = harness();
    installOracle(h, {
        finalizedAnswers: [
            {price: 10_000_000_000n, rate: 364n, by: PUBLISHER_A},
            {price: 10_000_000_000n, rate: 364n, by: PUBLISHER_B},
        ],
        panelFailureRound: 6n,
    });

    await h.Venue.refreshOracle();
    assert.match(h.element("feed-open").innerHTML, /Panel read failed: panel RPC timeout/);
    assert.doesNotMatch(h.element("feed-open").innerHTML, /\b0 of\b/);
    assert.match(h.element("feed-state").innerHTML, /panel read failed/);
    assert.match(h.element("feed-failure").textContent, /Answer count is unknown/);
    assert.notEqual(h.element("feed-price").innerHTML, "Unavailable");
});

test("current publisher statuses are deduplicated with exact blockers", async () => {
    const h = harness();
    const rows = [
        statusRow({
            publisher: PUBLISHER_A,
            profile: "issuer",
            sequence: 1,
            code: "SOURCE_ERROR",
            observedAt: 9_970,
        }),
        statusRow({
            publisher: PUBLISHER_A,
            profile: "issuer",
            sequence: 2,
            code: "SOURCE_QUORUM",
            observedAt: 9_990,
        }),
        statusRow({
            publisher: PUBLISHER_B,
            profile: "seller",
            sequence: 3,
            code: "HBAR_RATE_DIVERGENCE",
            observedAt: 9_995,
        }),
        statusRow({
            publisher: PUBLISHER_B,
            profile: "seller",
            sequence: 4,
            code: "SOURCE_ERROR",
            observedAt: 9_999,
            round: "4",
        }),
    ];
    const latest = h.Venue.latestOraclePublisherRows(rows, "oracle-status", 6n);
    assert.equal(
        latest.map((row) => row.record.code).join(","),
        "HBAR_RATE_DIVERGENCE,SOURCE_QUORUM",
    );

    installOracle(h, {
        evidence: {configured: true, records: rows, errors: [], empty: []},
    });
    await h.Venue.refreshOracle();
    assert.equal(h.element("feed-failure").hidden, true);
    assert.doesNotMatch(h.element("feed-failure").textContent, /SOURCE_QUORUM|HBAR_RATE_DIVERGENCE|NOT_DUE/);
    assert.match(h.element("feed-evidence").innerHTML, /Unverified publisher status only/);
    assert.match(h.element("feed-evidence").className, /\bbad\b/);

    installOracle(h, {
        feed: {dark: true, ourLegDark: true, markPerUnitTinybar: 0n},
        evidence: {configured: true, records: rows, errors: [], empty: []},
    });
    await h.Venue.refreshOracle();
    const failure = h.element("feed-failure").textContent;
    assert.match(failure, /Publishers withheld: HBAR_RATE_DIVERGENCE, SOURCE_QUORUM/);
    assert.doesNotMatch(failure, /SOURCE_ERROR|NOT_DUE|from issuer|from seller/);
    assert.match(h.element("feed-evidence").innerHTML, /Unverified publisher status only/);
});

test("a live quote hides keepalive status and historical HCS mismatches", async () => {
    const topics = [
        {topicId: "0.0.11", profile: "buyer", publisher: PUBLISHER_A},
        {topicId: "0.0.12", profile: "issuer", publisher: PUBLISHER_B},
    ];
    const h = harness({topics});
    const rows = [
        statusRow({
            publisher: PUBLISHER_A,
            profile: "buyer",
            sequence: 21,
            code: "NOT_DUE",
            observedAt: 9_995,
        }),
        statusRow({
            publisher: PUBLISHER_B,
            profile: "issuer",
            sequence: 22,
            code: "NOT_DUE",
            observedAt: 9_996,
        }),
    ];
    installOracle(h, {
        evidence: {
            configured: true,
            records: rows,
            errors: [],
            empty: [],
            skipped: [
                {
                    topic: topics[0],
                    sequence: "1",
                    skipped: true,
                    skipReason: "message does not match this deployment and publisher",
                },
            ],
        },
        finalizedAnswers: [
            {price: 10_000_000_000n, rate: 364n, by: PUBLISHER_A},
            {price: 10_000_000_000n, rate: 364n, by: PUBLISHER_B},
        ],
    });
    await h.Venue.refreshOracle();
    assert.equal(h.element("feed-failure").hidden, true);
    assert.doesNotMatch(
        h.element("feed-failure").textContent,
        /NOT_DUE|does not match this deployment|Publisher status/,
    );
    assert.notEqual(h.element("feed-price").innerHTML, "Unavailable");
    assert.notEqual(h.element("feed-mark").innerHTML, "Unavailable");
});

test("historical HCS mismatches are skipped instead of counted as evidence errors", async () => {
    const topics = [
        {topicId: "0.0.11", profile: "issuer", publisher: PUBLISHER_A},
    ];
    const h = harness({topics});
    const current = statusRow({
        publisher: PUBLISHER_A,
        profile: "issuer",
        sequence: 9,
        code: "NOT_DUE",
        observedAt: 9_995,
    }).record;
    const stale = {
        ...current,
        oracle: "0x00000000000000000000000000000000000000ff",
        publisher: "0x00000000000000000000000000000000000000ee",
    };
    h.Venue.mirror = async () => ({
        messages: [
            {
                message: Buffer.from(JSON.stringify(current), "utf8").toString("base64"),
                sequence_number: 9,
                consensus_timestamp: "9995.000000001",
            },
            {
                message: Buffer.from(JSON.stringify(stale), "utf8").toString("base64"),
                sequence_number: 1,
                consensus_timestamp: "1000.000000001",
            },
        ],
    });
    const evidence = await h.Venue.refreshOracleEvidence();
    assert.equal(evidence.records.length, 1);
    assert.equal(evidence.records[0].record.code, "NOT_DUE");
    assert.equal(evidence.errors.length, 0);
    assert.equal(evidence.skipped.length, 1);
    assert.match(evidence.skipped[0].skipReason, /does not match this deployment/);
});

test("HCS source claims turn green only after EVM panel verification", async () => {
    const topics = [
        {topicId: "0.0.11", profile: "issuer", publisher: PUBLISHER_A},
        {topicId: "0.0.12", profile: "seller", publisher: PUBLISHER_B},
    ];
    const rows = [
        answerRow({
            publisher: PUBLISHER_A,
            profile: "issuer",
            sequence: 11,
            price: 10_000_000_001n,
        }),
        answerRow({
            publisher: PUBLISHER_B,
            profile: "seller",
            sequence: 12,
            price: 9_999_999_999n,
        }),
    ];
    const panel = [
        {price: 10_000_000_001n, rate: 364n, by: PUBLISHER_A},
        {price: 9_999_999_999n, rate: 364n, by: PUBLISHER_B},
    ];
    const verified = harness({topics});
    installOracle(verified, {
        evidence: {configured: true, records: rows, errors: [], empty: []},
        finalizedAnswers: panel,
    });
    await verified.Venue.refreshOracle();
    assert.match(verified.element("feed-source").innerHTML, /^qualified-market:/);
    assert.match(verified.element("feed-source").className, /\bok\b/);
    assert.match(verified.element("feed-evidence").innerHTML, /issuer #11, seller #12/);
    assert.match(verified.element("feed-evidence").className, /\bok\b/);
    assert.match(verified.element("feed-print-age").innerHTML, /EVM panel verified/);
    assert.match(verified.element("feed-age").innerHTML, /Finalized .*Z · 10s ago/);
    assert.match(verified.element("feed-countdown").textContent, /remaining/);
    assert.match(verified.element("feed-quorum").innerHTML, /2 required.*2 HCS messages EVM-verified/);
    assert.equal(verified.element("feed-hbar-market").innerHTML, "7990000 USD");
    assert.match(verified.element("feed-market-age").innerHTML, /verified market observation/);
    assert.match(verified.element("feed-evidence").innerHTML, /source timestamps and identities committed/);

    const unverified = harness({topics});
    installOracle(unverified, {
        evidence: {configured: true, records: rows, errors: [], empty: []},
        finalizedAnswers: [
            {price: 1n, rate: 364n, by: PUBLISHER_A},
            {price: 2n, rate: 364n, by: PUBLISHER_B},
        ],
    });
    await unverified.Venue.refreshOracle();
    assert.match(unverified.element("feed-source").innerHTML, /Unverified HCS source claim/);
    assert.match(unverified.element("feed-source").className, /\bbad\b/);
    assert.match(unverified.element("feed-evidence").innerHTML, /Schema-valid but unverified/);
    assert.equal(unverified.element("feed-hbar-market").innerHTML, "Unavailable");
});

test("one mounted page recovers from round three to four without reload", async () => {
    const topics = [
        {topicId: "0.0.11", profile: "issuer", publisher: PUBLISHER_A},
        {topicId: "0.0.12", profile: "seller", publisher: PUBLISHER_B},
    ];
    const roundThreeRows = [
        answerRow({
            publisher: PUBLISHER_A,
            profile: "issuer",
            sequence: 11,
            price: 10_000_000_001n,
            round: 3,
        }),
        answerRow({
            publisher: PUBLISHER_B,
            profile: "seller",
            sequence: 12,
            price: 9_999_999_999n,
            round: 3,
        }),
    ];
    const h = harness({topics});
    const feed = installOracle(h, {
        finalizedRound: 3n,
        nextRound: 4n,
        evidence: {
            configured: true,
            records: roundThreeRows,
            errors: [],
            empty: [],
        },
        finalizedAnswers: [
            {price: 10_000_000_001n, rate: 364n, by: PUBLISHER_A},
            {price: 9_999_999_999n, rate: 364n, by: PUBLISHER_B},
        ],
    });
    await h.Venue.refreshOracle();
    const mountedRoundElement = h.element("feed-round");
    assert.equal(mountedRoundElement.innerHTML, "3");

    const roundFourRows = roundThreeRows.map((row, index) => answerRow({
        publisher: row.record.publisher,
        profile: row.topic.profile,
        sequence: 21 + index,
        price: index === 0 ? 10_000_000_011n : 10_000_000_009n,
        round: 4,
        observedAt: 9_995,
        consensus: "9996.000000001",
    }));
    feed.publishedAt = 9_998n;
    feed.cleanPrice = 10_000_000_010n;
    h.Venue.c.oracle.lastRound = async () => 4n;
    h.Venue.c.oracle.openRound = async () => 5n;
    h.Venue.c.oracle.panelOf = async (round) => String(round) === "4"
        ? [
            {price: 10_000_000_011n, rate: 364n, by: PUBLISHER_A},
            {price: 10_000_000_009n, rate: 364n, by: PUBLISHER_B},
        ]
        : [];
    h.Venue.refreshOracleEvidence = async () => ({
        configured: true,
        records: roundFourRows,
        errors: [],
        empty: [],
    });
    await h.Venue.refreshOracle();

    assert.equal(h.element("feed-round"), mountedRoundElement);
    assert.equal(mountedRoundElement.innerHTML, "4");
    assert.match(h.element("feed-source").innerHTML, /trigger NEW_SOFR/);
    assert.match(h.element("feed-source").className, /\bok\b/);
    assert.match(h.element("feed-evidence").className, /\bok\b/);
});

test("stale market observations are shown by age and rejected", async () => {
    const topics = [
        {topicId: "0.0.11", profile: "issuer", publisher: PUBLISHER_A},
        {topicId: "0.0.12", profile: "seller", publisher: PUBLISHER_B},
    ];
    const rows = [
        answerRow({
            publisher: PUBLISHER_A,
            profile: "issuer",
            sequence: 11,
            price: 10_000_000_001n,
            observedAt: 8_000,
        }),
        answerRow({
            publisher: PUBLISHER_B,
            profile: "seller",
            sequence: 12,
            price: 9_999_999_999n,
            observedAt: 8_000,
        }),
    ];
    const h = harness({topics});
    installOracle(h, {
        heartbeat: 1_000n,
        evidence: {configured: true, records: rows, errors: [], empty: []},
        finalizedAnswers: [
            {price: 10_000_000_001n, rate: 364n, by: PUBLISHER_A},
            {price: 9_999_999_999n, rate: 364n, by: PUBLISHER_B},
        ],
    });
    await h.Venue.refreshOracle();
    assert.equal(h.element("feed-hbar-market").innerHTML, "Unavailable");
    assert.match(h.element("feed-market-age").innerHTML, /2000s.*rejected/);
    assert.match(h.element("feed-source").innerHTML, /Stale HCS source claim rejected/);
    assert.match(h.element("feed-print-age").innerHTML, /stale or unverified provenance rejected/);
});

test("missing and failed evidence is explicit", async () => {
    const topics = [
        {topicId: "0.0.11", profile: "issuer", publisher: PUBLISHER_A},
    ];
    const h = harness({topics});
    installOracle(h, {
        evidence: {
            configured: true,
            records: [],
            empty: [],
            errors: [{
                topic: topics[0],
                error: "Mirror node answered 503",
                fetchError: true,
            }],
        },
    });
    await h.Venue.refreshOracle();
    assert.match(h.element("feed-evidence").innerHTML, /0\/1 topic tails readable/);
    assert.match(h.element("feed-evidence").innerHTML, /Mirror node answered 503/);
    assert.match(h.element("feed-evidence").className, /\bbad\b/);
    assert.equal(h.element("feed-failure").hidden, true);
    assert.doesNotMatch(h.element("feed-failure").textContent, /HCS evidence missing or failed/);

    installOracle(h, {
        feed: {dark: true, ourLegDark: true, markPerUnitTinybar: 0n},
        evidence: {
            configured: true,
            records: [],
            empty: [],
            errors: [{
                topic: topics[0],
                error: "Mirror node answered 503",
                fetchError: true,
            }],
        },
    });
    await h.Venue.refreshOracle();
    assert.match(h.element("feed-failure").textContent, /HCS evidence missing or failed/);
});

function mockScheduler(boundOracle = ORACLE) {
    return {
        target: SCHEDULER,
        oracle: async () => boundOracle,
        activeSchedule: async () => ZERO,
        nextCheckAt: async () => 0n,
        trackedRound: async () => 6n,
        retryStreak: async () => 1n,
        checksThisRound: async () => 2n,
        MAX_RETRY_STREAK: async () => 4n,
        MAX_CHECKS_PER_ROUND: async () => 8n,
        MIN_BALANCE_TINYBAR: async () => 500_000_000n,
    };
}

test("scheduler reads verify deployment and live oracle bindings", async () => {
    const record = {address: SCHEDULER, oracle: ORACLE, chainId: 296};
    const h = harness({schedulerRecord: record});
    h.Venue.reader = {
        getCode: async () => "0x01",
        getBalance: async () => 10_000_000_000_000_000_000n,
    };
    h.Venue.c.oracleScheduler = mockScheduler();
    h.Venue.readOracleSchedulerEvents = async () => [];
    assert.equal((await h.Venue.readOracleScheduler()).status, "ready");

    h.Venue.c.oracleScheduler = mockScheduler(PUBLISHER_A);
    const mismatch = await h.Venue.readOracleScheduler();
    assert.equal(mismatch.status, "binding-failed");
    assert.match(mismatch.bindingIssues.join(" "), /on-chain oracle\(\)/);
    h.Venue.oracleClock = {
        publishedAt: 9_990,
        expiresAt: 10_500,
        scheduler: mismatch,
    };
    h.Venue.paintOracleCountdown();
    assert.match(h.element("feed-scheduler").textContent, /Scheduler binding failed/);

    const missing = harness({schedulerRecord: record});
    missing.Venue.reader = {
        getCode: async () => "0x",
        getBalance: async () => 0n,
    };
    missing.Venue.c.oracleScheduler = mockScheduler();
    const missingState = await missing.Venue.readOracleScheduler();
    assert.equal(missingState.status, "deployment-missing");
    missing.Venue.oracleClock = {
        publishedAt: 9_990,
        expiresAt: 10_500,
        scheduler: missingState,
    };
    missing.Venue.paintOracleCountdown();
    assert.match(missing.element("feed-scheduler").textContent, /Deployment missing/);

    const staleRecord = harness({
        schedulerRecord: {...record, oracle: PUBLISHER_B},
    });
    staleRecord.Venue.reader = {
        getCode: async () => "0x01",
        getBalance: async () => 10_000_000_000_000_000_000n,
    };
    staleRecord.Venue.c.oracleScheduler = mockScheduler();
    staleRecord.Venue.readOracleSchedulerEvents = async () => [];
    const deploymentMismatch = await staleRecord.Venue.readOracleScheduler();
    assert.equal(deploymentMismatch.status, "binding-failed");
    assert.match(deploymentMismatch.bindingIssues.join(" "), /deployment record targets/);
});

test("scheduler RPC failure is not rendered as an absent deployment", async () => {
    const h = harness();
    installOracle(h, {
        finalizedAnswers: [
            {price: 10_000_000_000n, rate: 364n, by: PUBLISHER_A},
            {price: 10_000_000_000n, rate: 364n, by: PUBLISHER_B},
        ],
    });
    h.Venue.readOracleScheduler = async () => {
        throw new Error("scheduler eth_call timed out");
    };
    await h.Venue.refreshOracle();
    assert.match(h.element("feed-scheduler").textContent, /Scheduler RPC failed/);
    assert.match(h.element("feed-scheduler").textContent, /eth_call timed out/);
    assert.doesNotMatch(h.element("feed-scheduler").textContent, /Not deployed/);
    assert.equal(h.element("feed-failure").hidden, true);
    assert.doesNotMatch(h.element("feed-failure").textContent, /Scheduler RPC failure/);
});

test("scheduler displays exact capacity, funding, and stop reasons", () => {
    const h = harness();
    const cases = [
        [
            {name: "CheckUnscheduled", reason: -2n, at: 9_990},
            "CheckUnscheduled: REASON_NO_CAPACITY (-2)",
        ],
        [
            {name: "CheckUnscheduled", reason: -3n, at: 9_991},
            "CheckUnscheduled: REASON_UNFUNDED (-3)",
        ],
        [
            {name: "AutomationStopped", reason: ethers.id("RETRY_LIMIT"), at: 9_992},
            "AutomationStopped: STOP_RETRY_LIMIT",
        ],
        [
            {name: "ArmRefused", reason: ethers.id("NO_NEW_ANSWER"), at: 9_993},
            "ArmRefused: STOP_NO_NEW_ANSWER",
        ],
    ];
    for (const [problem, exact] of cases) {
        h.Venue.oracleClock = {
            publishedAt: 9_990,
            expiresAt: 10_500,
            scheduler: schedulerState(problem),
        };
        h.Venue.paintOracleCountdown();
        assert.match(h.element("feed-scheduler").textContent, new RegExp(exact.replace(
            /[()[\]]/g,
            "\\$&",
        )));
        assert.match(h.element("feed-scheduler-reason").textContent, new RegExp(exact.replace(
            /[()[\]]/g,
            "\\$&",
        )));
    }
});

test("scheduler event history reads and orders Mirror Node logs", async () => {
    const h = harness();
    let requested = "";
    h.Venue.mirror = async (path) => {
        requested = path;
        return {
            logs: [
                {data: "older", topics: [], timestamp: "9990.1", transaction_hash: "0x1"},
                {data: "newer", topics: [], timestamp: "9991.1", transaction_hash: "0x2"},
            ],
        };
    };
    const scheduler = {
        target: SCHEDULER,
        interface: {
            parseLog: ({data}) => data === "newer"
                ? {name: "CheckScheduled", args: {scheduleAddress: PUBLISHER_A, dueAt: 10_100n}}
                : {name: "CheckUnscheduled", args: {dueAt: 10_000n, reason: -2n}},
        },
    };
    const rows = await h.Venue.readOracleSchedulerEvents(scheduler);
    assert.match(requested, new RegExp(SCHEDULER));
    assert.equal(
        rows.map((row) => row.name).join(","),
        "CheckScheduled,CheckUnscheduled",
    );
    assert.equal(
        h.Venue.schedulerEventReason(rows[1]),
        "CheckUnscheduled: REASON_NO_CAPACITY (-2)",
    );
});

test("both oracle panels expose all freshness and evidence fields", () => {
    for (const template of [marketsTemplate, financingTemplate]) {
        for (const id of [
            "feed-age",
            "feed-countdown",
            "feed-source",
            "feed-print-age",
            "feed-market-age",
            "feed-evidence",
            "feed-quorum",
            "feed-scheduler-reason",
        ]) {
            assert.match(template, new RegExp('id="' + id + '"'));
        }
    }
    assert.match(financingTemplate, /Last finalized/);
    assert.match(financingTemplate, /HCS evidence sequence/);
});

test("Markets and Financing refresh every 30 seconds without reloading", async () => {
    const start = runtime.indexOf("Venue.startPolling = function");
    const end = runtime.indexOf("\n// Every read on this page", start);
    const polling = runtime.slice(start, end);
    assert.match(runtime, /const ORACLE_REFRESH_MS = 30_000;/);
    assert.doesNotMatch(polling, /location\.(?:reload|replace)|window\.location/);

    for (const page of ["trade", "repo"]) {
        let current = 30_999;
        let polls = 0;
        const Venue = {
            page,
            timer: 0,
            localTimer: 0,
            pollMs: 5_000,
            snap: {},
            viewer: () => null,
            refreshClocks: async () => {},
            refreshBook: async () => {},
            pollOracle: async () => {
                polls++;
            },
        };
        Venue[page === "trade" ? "_tradeOracleAt" : "_repoOracleAt"] = 1_000;
        runInNewContext(
            "const ORACLE_REFRESH_MS = 30_000;\n" + polling,
            {
                Venue,
                document: {hidden: false},
                Date: {now: () => current},
                clearInterval: () => {},
                setInterval: () => 1,
                is429: () => false,
            },
        );
        await Venue.tick();
        assert.equal(polls, 0);
        current = 31_000;
        await Venue.tick();
        assert.equal(polls, 1);
    }
});

test("core price renders before delayed evidence and failed Mirror", async () => {
    const h = harness();
    let releaseEvidence;
    installOracle(h, {
        evidence: baseEvidence(),
        finalizedAnswers: [
            {price: 10_000_000_000n, rate: 364n, by: PUBLISHER_A},
            {price: 10_000_000_000n, rate: 364n, by: PUBLISHER_B},
        ],
    });
    h.Venue.refreshOracleEvidence = () => new Promise((resolve) => {
        releaseEvidence = resolve;
    });
    const pending = h.Venue.refreshOracle();
    for (let i = 0; i < 20 && !/10000000000/.test(h.element("feed-price").innerHTML); i++) {
        await Promise.resolve();
    }
    assert.notEqual(h.element("feed-price").innerHTML, "Loading");
    assert.notEqual(h.element("feed-price").innerHTML, "Unavailable");
    assert.match(h.element("feed-price").innerHTML, /10000000000/);
    releaseEvidence({
        configured: true,
        records: [],
        errors: [{topic: {profile: "issuer"}, error: "timed out", fetchError: true}],
        empty: [],
    });
    await pending;
    assert.match(h.element("feed-price").innerHTML, /10000000000/);
    assert.match(h.element("feed-evidence").innerHTML, /Evidence details unavailable/);
});

test("oracle polling is single-flight and manual refresh joins the in-flight read", async () => {
    const h = harness();
    let started = 0;
    let release;
    h.Venue.refreshOracle = () => {
        started += 1;
        return new Promise((resolve) => { release = resolve; });
    };
    const first = h.Venue.pollOracle();
    const second = h.Venue.pollOracle();
    assert.equal(first, second);
    assert.equal(started, 1);
    release();
    assert.equal(await first, true);
    assert.equal(await second, true);
});

test("wallet discovery is not awaited before public boot and financing probe is page scoped", () => {
    const boot = runtime.slice(
        runtime.indexOf("Venue.boot = async function"),
        runtime.indexOf("\nVenue.block = function"),
    );
    assert.match(boot, /page === "position" \|\| page === "repo"/);
    assert.match(boot, /await Venue.probeFinancing\(\)/);
    assert.doesNotMatch(boot, /await walletReady/);
    assert.match(runtime, /const ORACLE_REFRESH_MS = 30_000;/);
});

test("Financing starts vault and oracle together and defers prefetch", () => {
    const mount = source.slice(
        source.indexOf("Venue.mountRepo = async function"),
        source.indexOf("\nVenue.paintFinancingEvidence = function"),
    );
    assert.match(mount, /Venue.refreshVault\(\)/);
    assert.match(mount, /Venue.pollOracle\(\)/);
    assert.match(mount, /await Venue.whenOracleHeadline\(\)/);
    assert.match(mount, /Venue.discoverRepos/);
    assert.match(source, /requestIdleCallback/);
    assert.doesNotMatch(marketsTemplate, /rel="prefetch"/);
    assert.doesNotMatch(financingTemplate, /rel="prefetch"/);
    assert.match(source, /SOFR model plus signed dealer quote/);
    assert.doesNotMatch(source, /disclosed testnet dealer simulation/);
});

test("Vercel responses add browser hardening headers without a CSP rewrite", () => {
    const vercel = readFileSync(new URL("../../vercel.json", import.meta.url), "utf8");
    assert.match(vercel, /X-Content-Type-Options/);
    assert.match(vercel, /nosniff/);
    assert.match(vercel, /Referrer-Policy/);
    assert.match(vercel, /no-referrer/);
    assert.match(vercel, /X-Frame-Options/);
    assert.match(vercel, /DENY/);
    assert.match(vercel, /Permissions-Policy/);
    assert.match(vercel, /camera=\(\), microphone=\(\), geolocation=\(\)/);
    assert.doesNotMatch(vercel, /Content-Security-Policy/);
});

test("generated pages keep the institutional source label and skip prefetch", () => {
    const markets = readFileSync(new URL("../app/trade.html", import.meta.url), "utf8");
    const financing = readFileSync(new URL("../app/repo.html", import.meta.url), "utf8");
    for (const page of [markets, financing]) {
        assert.match(page, /SOFR model plus signed dealer quote/);
        assert.doesNotMatch(page, /rel="prefetch"/);
    }
    assert.match(marketsTemplate, /\/\*INLINE app\/private-trading-crypto.bundle.mjs\*\//);
    assert.doesNotMatch(financingTemplate, /private-trading|FixedDenominationRouter|SessionAccount/);
});

test("desktop and 390 pixel market layouts stay inside the viewport", () => {
    const css = readFileSync(new URL("../app/app.css", import.meta.url), "utf8");
    assert.match(css, /html\{[^}]*overflow-x:clip/);
    assert.match(css, /@media\(max-width:520px\)/);
    assert.match(css, /\.market-oracle\{grid-template-columns:minmax\(0,1fr\) auto/);
    assert.match(marketsTemplate, /class="market-oracle"/);
});
