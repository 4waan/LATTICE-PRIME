import {test} from "node:test";
import assert from "node:assert/strict";
import {Interface, Wallet, id} from "ethers";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {loadPublisherIdentity} from "../lib/config.mjs";
import {
    decodeEvidence,
    decodeOracleMessage,
    encodeEvidence,
    encodeStatusEvidence,
} from "../lib/evidence.mjs";
import {accountIdAddress} from "../lib/evidence-verifier.mjs";
import {PublisherJournal} from "../lib/journal.mjs";
import {runPublisherPass} from "../publisher.mjs";

const privateKey = "0x" + "11".repeat(32);
const wallet = new Wallet(privateKey);
const oracleAddress = "0x05adE174f2C410cccbC2AB4006D14Ca7a3fdA6c2";
const topicId = "0.0.7001";
const sourceDigest = id("source bundle");
const abi = [
    "function submit(uint64 round,uint128 cleanPrice,uint64 refRateBps)",
];

test("Hedera account IDs map to the long-zero sender returned by Mirror Node", () => {
    assert.equal(
        accountIdAddress("0.0.10301312").toLowerCase(),
        "0x00000000000000000000000000000000009d2f80",
    );
    assert.equal(accountIdAddress("not-an-account"), null);
});

function config() {
    return {
        chainId: 296,
        keepaliveSeconds: 100,
        publishMoveBps: 25,
        evidence: {maximumBroadcastDelaySeconds: 600},
    };
}

function identity(root) {
    return {
        profile: "publisher-a",
        accountId: "0.0.5001",
        topicId,
        wallet,
        address: wallet.address,
        stateRoot: root,
    };
}

function fakeOracle() {
    const iface = new Interface(abi);
    return {
        target: oracleAddress,
        interface: iface,
        openRound: async () => 3n,
        latest: async () => ({
            cleanPrice: 10_000_000_000n,
            refRateBps: 360n,
            publishedAt: 1_799_999_000n,
            round: 2n,
        }),
        heartbeat: async () => 21_600n,
        maxDeviationBps: async () => 500n,
        seated: async () => true,
        answered: async () => false,
        panelOf: async () => [],
    };
}

function fakeScheduler() {
    return {
        target: "0x" + "44".repeat(20),
        interface: new Interface(["function arm() returns (bool)"]),
        activeSchedule: async () => "0x" + "00".repeat(20),
        nextCheckAt: async () => 0n,
        SCHEDULE_LATE_GRACE: async () => 300n,
        MIN_BALANCE_TINYBAR: async () => 500_000_000n,
    };
}

function quote() {
    return {
        ok: true,
        cleanPriceUsd8: 10_010_000_000n,
        referenceRateBps: 364n,
        observedAt: 1_800_000_000,
        sourceDigest,
        mode: "model-dealer-fallback",
        quality: {exactPrints: 0, dealerQuotes: 1},
        terms: {usdPerHbar8: 8_000_000n},
        marketRate: {usdPerHbar8: 7_990_000n},
    };
}

function fakeProvider(order) {
    return {
        call: async () => "0x",
        getTransactionCount: async () => 7,
        getFeeData: async () => ({gasPrice: 1n}),
        getBalance: async () => 10_000_000_000_000_000_000n,
        broadcastTransaction: async () => {
            order.push("evm");
            return {};
        },
        waitForTransaction: async (hash) => ({
            hash,
            status: 1,
            blockNumber: 10,
            gasUsed: 100_000n,
            gasPrice: 1n,
        }),
        getTransactionReceipt: async () => null,
        getTransaction: async () => ({}),
    };
}

test("publisher process rejects shared multi-key environments", () => {
    assert.throws(
        () => loadPublisherIdentity({evidence: {topicId}}, {
            ORACLE_PUBLISHER_ID: "publisher-a",
            ORACLE_PUBLISHER_ACCOUNT_ID: "0.0.5001",
            ORACLE_PUBLISHER_PRIVATE_KEY: privateKey,
            ORACLE_PUBLISHER_2_PRIVATE_KEY: "another-key",
        }),
        (error) => error.code === "MULTI_KEY_ENV",
    );
});

test("oracle evidence is canonical, bounded, and carries an expiry", () => {
    const message = encodeEvidence({
        chain: 296,
        oracle: oracleAddress,
        publisher: wallet.address,
        round: 3,
        tx: id("transaction"),
        price: 10_010_000_000n,
        rate: 364,
        observedAt: 1_800_000_000,
        expiresAt: 1_800_000_600,
        source: sourceDigest,
        mode: "qualified-market",
        exactPrints: 2,
        dealerQuotes: 1,
        hbarNetwork: 8_000_000,
        hbarMarket: 7_990_000,
        previous: null,
    });
    assert.ok(Buffer.byteLength(message) < 1024);
    assert.equal(decodeEvidence(message).expiresAt, 1_800_000_600);
    assert.throws(() => decodeEvidence(message + " "), (error) => error.code === "NON_CANONICAL");
});

test("status evidence carries a machine-readable failure reason", () => {
    const message = encodeStatusEvidence({
        chain: 296,
        oracle: oracleAddress,
        publisher: wallet.address,
        round: 3,
        observedAt: 1_800_000_000,
        code: "SOURCE_QUORUM",
        source: sourceDigest,
        exactPrints: 0,
        rejectedPrints: 1,
        dealerQuotes: 0,
        answerCount: 0,
        hbarNetwork: 8_000_000,
        hbarMarket: 7_990_000,
        hbarDivergenceBps: 12,
        previous: null,
    });
    const decoded = decodeOracleMessage(message);
    assert.equal(decoded.k, "oracle-status");
    assert.equal(decoded.code, "SOURCE_QUORUM");
    assert.equal(decoded.rejectedPrints, 1);
});

test("HCS evidence reaches consensus before the signed EVM transaction broadcasts", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-publisher-"));
    try {
        const actor = identity(root);
        const journal = PublisherJournal.open(root, actor.profile, actor.address);
        const order = [];
        const result = await runPublisherPass({
            config: config(),
            identity: actor,
            journal,
            provider: fakeProvider(order),
            oracle: fakeOracle(),
            buildQuoteFn: async () => quote(),
            submitEvidenceFn: async ({message}) => {
                decodeEvidence(message);
                order.push("hcs");
                return {topicId, sequenceNumber: "1", transactionId: "0.0.5001@1.2"};
            },
            now: 1_800_000_000,
        });
        assert.equal(result.action, "submitted");
        assert.deepEqual(order, ["hcs", "evm"]);
        assert.equal(journal.state.pending, null);
        assert.equal(journal.state.lastConfirmedRound, "3");
        const events = readFileSync(join(root, "events.jsonl"), "utf8")
            .trim().split("\n").map((line) => JSON.parse(line).type);
        assert.deepEqual(events, ["decision", "prepared", "evidenced", "broadcast", "confirmed"]);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("restart resumes an evidenced transaction without recomputing valuation", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-recovery-"));
    try {
        const actor = identity(root);
        const journal = PublisherJournal.open(root, actor.profile, actor.address);
        let evidenceAttempts = 0;
        await assert.rejects(() => runPublisherPass({
            config: config(),
            identity: actor,
            journal,
            provider: fakeProvider([]),
            oracle: fakeOracle(),
            buildQuoteFn: async () => quote(),
            submitEvidenceFn: async () => {
                evidenceAttempts += 1;
                throw new Error("temporary HCS failure");
            },
            now: 1_800_000_000,
        }));
        assert.equal(journal.state.pending.status, "PREPARED");

        let quoteCalls = 0;
        const order = [];
        const result = await runPublisherPass({
            config: config(),
            identity: actor,
            journal,
            provider: fakeProvider(order),
            oracle: fakeOracle(),
            buildQuoteFn: async () => {
                quoteCalls += 1;
                return quote();
            },
            submitEvidenceFn: async () => {
                evidenceAttempts += 1;
                order.push("hcs");
                return {topicId, sequenceNumber: "2", transactionId: "0.0.5001@1.3"};
            },
            now: 1_800_000_010,
        });
        assert.equal(result.action, "recovery");
        assert.equal(quoteCalls, 0);
        assert.equal(evidenceAttempts, 2);
        assert.deepEqual(order, ["hcs", "evm"]);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("withheld valuation publishes one throttled HCS status and no EVM transaction", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-status-"));
    try {
        const actor = identity(root);
        const journal = PublisherJournal.open(root, actor.profile, actor.address);
        const order = [];
        const unavailable = {
            ok: false,
            code: "SOURCE_QUORUM",
            reason: "no qualified source quorum",
            sourceDigest,
            terms: {oracle: oracleAddress, usdPerHbar8: 8_000_000n},
            marketRate: {usdPerHbar8: 7_990_000n},
            hbarDivergenceBps: 12n,
            prints: {accepted: [], rejected: [{}]},
            dealers: {accepted: [], rejected: []},
        };
        const submitStatus = async ({message}) => {
            const decoded = decodeOracleMessage(message);
            assert.equal(decoded.code, "SOURCE_QUORUM");
            order.push("hcs-status");
            return {topicId, sequenceNumber: "4", transactionId: "0.0.5001@1.4"};
        };
        const first = await runPublisherPass({
            config: config(),
            identity: actor,
            journal,
            provider: fakeProvider(order),
            oracle: fakeOracle(),
            buildQuoteFn: async () => unavailable,
            submitEvidenceFn: submitStatus,
            now: 1_800_000_000,
        });
        assert.equal(first.action, "withhold");
        assert.equal(first.decision.code, "SOURCE_QUORUM");
        assert.deepEqual(order, ["hcs-status"]);
        assert.equal(journal.state.lastStatus.code, "SOURCE_QUORUM");

        await runPublisherPass({
            config: config(),
            identity: actor,
            journal,
            provider: fakeProvider(order),
            oracle: fakeOracle(),
            buildQuoteFn: async () => unavailable,
            submitEvidenceFn: submitStatus,
            now: 1_800_000_100,
        });
        assert.deepEqual(order, ["hcs-status"]);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("an existing open answer rearms a missing scheduler after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-rearm-"));
    try {
        const order = [];
        const target = fakeOracle();
        target.answered = async () => true;
        target.panelOf = async () => [{
            price: 10_010_000_000n,
            rate: 364n,
            by: wallet.address,
        }];
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        const pass = {
            config: config(),
            identity: identity(root),
            journal,
            provider: fakeProvider(order),
            oracle: target,
            scheduler: fakeScheduler(),
            buildQuoteFn: async () => quote(),
            submitEvidenceFn: async () => {
                order.push("hcs");
                return {topicId, sequenceNumber: "2", consensusTimestamp: "1800000001.0"};
            },
            now: 1_800_000_000,
        };
        const result = await runPublisherPass(pass);
        assert.equal(result.decision.code, "ALREADY_ANSWERED");
        assert.equal(result.schedulerArm.configured, true);
        assert.deepEqual(order, ["evm", "hcs"]);
        const retry = await runPublisherPass({...pass, now: 1_800_000_001});
        assert.equal(retry.schedulerArm.throttled, true);
        assert.deepEqual(order, ["evm", "hcs"]);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});
