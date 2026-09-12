import {test} from "node:test";
import assert from "node:assert/strict";
import {Interface, Wallet, id} from "ethers";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {loadPublisherIdentity} from "../lib/config.mjs";
import {
    QUALITY_FLAGS,
    compactEvidenceIdentity,
    decodeEvidence,
    decodeOracleMessage,
    encodeEvidence,
    encodeStatusEvidence,
    evidenceHash,
    findEvidenceMessage,
} from "../lib/evidence.mjs";
import {accountIdAddress} from "../lib/evidence-verifier.mjs";
import {PublisherJournal} from "../lib/journal.mjs";
import {
    HEDERA_TRANSACTION_VALID_SECONDS,
    assertRuntimeAddress,
    assertSchedulerOracle,
    reusableEvidenceTransactionId,
    runPublisherPass,
} from "../publisher.mjs";

const privateKey = "0x" + "11".repeat(32);
const wallet = new Wallet(privateKey);
const oracleAddress = "0x05adE174f2C410cccbC2AB4006D14Ca7a3fdA6c2";
const promotedOracleAddress = "0x4fdFf36036e13eFA7D1fB07408cE69F546c082b8";
const topicId = "0.0.7001";
const sourceDigest = id("source bundle");
const termsDigest = id("instrument terms");
const sofrDigest = id("official sofr");
const marketDigest = id("hbar market");
const dealerDigest = id("dealer source");
const abi = [
    "function submit(uint64 round,uint128 cleanPrice,uint64 refRateBps)",
];
const NOW = 1_800_000_000;

test("Hedera account IDs map to the long-zero sender returned by Mirror Node", () => {
    assert.equal(
        accountIdAddress("0.0.10301312").toLowerCase(),
        "0x00000000000000000000000000000000009d2f80",
    );
    assert.equal(accountIdAddress("not-an-account"), null);
});

test("publisher refuses a scheduler bound to another oracle", () => {
    assert.doesNotThrow(() => assertSchedulerOracle(oracleAddress, oracleAddress.toLowerCase()));
    assert.throws(
        () => assertSchedulerOracle(oracleAddress, wallet.address),
        (error) => error.code === "SCHEDULER_TARGET_MISMATCH",
    );
});

test("publisher exits when the deployment address book changes", () => {
    assert.doesNotThrow(() => assertRuntimeAddress("PrimeOracle", oracleAddress, oracleAddress));
    assert.throws(
        () => assertRuntimeAddress("PrimeOracle", oracleAddress, wallet.address),
        (error) => error.code === "DEPLOYMENT_CHANGED",
    );
});

function config(overrides = {}) {
    const base = {
        chainId: 296,
        mirrorUrl: "https://mirror.invalid",
        pollSeconds: 15,
        keepaliveSeconds: 100,
        publishMoveBps: 25,
        auction: {excludedAddresses: [wallet.address]},
        scheduler: {retrySeconds: 300},
        evidence: {
            maximumBroadcastDelaySeconds: 600,
            receiptRecoverySeconds: 0,
            maximumEvidenceAttempts: 2,
        },
    };
    return {
        ...base,
        ...overrides,
        auction: {...base.auction, ...overrides.auction},
        scheduler: {...base.scheduler, ...overrides.scheduler},
        evidence: {...base.evidence, ...overrides.evidence},
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

function deploymentReader(address = oracleAddress) {
    return async () => ({
        client: {
            addresses: {PrimeOracle: address},
            network: {mirror: "https://mirror.invalid"},
        },
    });
}

function fakeOracle({
    address = oracleAddress,
    round = 3n,
    cleanPrice = 10_000_000_000n,
    refRateBps = 360n,
    publishedAt = BigInt(NOW - 1_000),
    lastRound = 2n,
    heartbeat = 21_600n,
    seated = true,
    answered = false,
    panel = [],
} = {}) {
    const iface = new Interface(abi);
    return {
        target: address,
        interface: iface,
        openRound: async () => round,
        latest: async () => ({
            cleanPrice,
            refRateBps,
            publishedAt,
            round: lastRound,
        }),
        heartbeat: async () => heartbeat,
        maxDeviationBps: async () => 500n,
        seated: async () => seated,
        answered: async () => answered,
        panelOf: async () => panel,
    };
}

function fakeScheduler(overrides = {}) {
    return {
        target: "0x" + "44".repeat(20),
        interface: new Interface(["function arm() returns (bool)"]),
        activeSchedule: async () => "0x" + "00".repeat(20),
        nextCheckAt: async () => 0n,
        SCHEDULE_LATE_GRACE: async () => 300n,
        MIN_BALANCE_TINYBAR: async () => 500_000_000n,
        trackedRound: async () => 0n,
        retryStreak: async () => 0n,
        checksThisRound: async () => 0n,
        lastAnswerCount: async () => 0n,
        MAX_RETRY_STREAK: async () => 4n,
        MAX_CHECKS_PER_ROUND: async () => 8n,
        lastFinalizedRound: async () => 0n,
        ...overrides,
    };
}

function quote(overrides = {}) {
    const base = {
        ok: true,
        cleanPriceUsd8: 10_010_000_000n,
        referenceRateBps: 364n,
        observedAt: NOW,
        algorithmVersion: "hybrid-vwap-usd8-v1",
        configurationDigest: id("quote configuration"),
        sourceDigest,
        mode: "model-dealer-fallback",
        marketVolume: 0n,
        crossCheckSources: ["model", `dealer:${wallet.address}`],
        quality: {
            exactPrints: 0,
            rejectedPrints: 0,
            dealerQuotes: 1,
            rejectedDealerQuotes: 0,
            hbarMarketCrossCheck: true,
            qualityFlags: QUALITY_FLAGS.SOFR_QUALIFIED |
                QUALITY_FLAGS.DEALER_QUALIFIED |
                QUALITY_FLAGS.HBAR_MARKET_QUALIFIED |
                QUALITY_FLAGS.VALUATION_QUALIFIED,
        },
        terms: {
            oracle: oracleAddress,
            schedule: "0x" + "55".repeat(20),
            sourceDigest: termsDigest,
            usdPerHbar8: 8_000_000n,
            hbarRateUpdatedAt: NOW - 30,
        },
        sofr: {
            source: "ny-fed-sofr",
            rateBps: 364n,
            effectiveAt: NOW - 86_400,
            sourceDigest: sofrDigest,
        },
        marketRate: {
            usdPerHbar8: 7_990_000n,
            updatedAt: NOW - 60,
            roundId: 7n,
            sourceDigest: marketDigest,
        },
        hbarDivergenceBps: 12n,
        prints: {accepted: [], rejected: []},
        dealers: {
            accepted: [{
                signer: wallet.address,
                effectiveAt: NOW - 120,
                nonce: id("dealer nonce"),
                sourceDigest: dealerDigest,
                signature: "0x12",
            }],
            rejected: [],
        },
        model: {
            observedAt: NOW,
            cleanPriceUsd8: 10_020_000_000n,
            discountRateBps: 439n,
        },
    };
    return {
        ...base,
        ...overrides,
        quality: {...base.quality, ...overrides.quality},
        terms: {...base.terms, ...overrides.terms},
        sofr: {...base.sofr, ...overrides.sofr},
        marketRate: overrides.marketRate === null
            ? null
            : {...base.marketRate, ...overrides.marketRate},
        prints: {...base.prints, ...overrides.prints},
        dealers: {...base.dealers, ...overrides.dealers},
        model: {...base.model, ...overrides.model},
    };
}

function sourceState(value) {
    const sofr = {
        effectiveAt: Number(value.sofr.effectiveAt),
        rateBps: BigInt(value.sofr.rateBps).toString(),
    };
    return {
        prints: (value.prints?.accepted ?? []).map((row) => {
            const tx = String(row.tx ?? "").toLowerCase();
            const round = String(row.round ?? "");
            const observedAt = String(row.observedAt ?? "");
            return tx && round && observedAt
                ? `${tx}:${round}:${observedAt}`
                : String(row.sourceDigest ?? tx).toLowerCase();
        }).sort(),
        sofr,
        sofrSeen: [`${sofr.effectiveAt}:${sofr.rateBps}`],
    };
}

function fakeProvider(order, {
    broadcastError = null,
    receipt = null,
} = {}) {
    return {
        call: async () => "0x",
        getTransactionCount: async () => 7,
        getFeeData: async () => ({gasPrice: 1n}),
        getBalance: async () => 10_000_000_000_000_000_000n,
        broadcastTransaction: async () => {
            order.push("evm");
            if (broadcastError) throw broadcastError;
            return {};
        },
        waitForTransaction: async (hash) => receipt ?? ({
            hash,
            status: 1,
            blockNumber: 10,
            gasUsed: 100_000n,
            gasPrice: 1n,
        }),
        getTransactionReceipt: async () => receipt,
        getTransaction: async () => null,
    };
}

function passOptions(root, overrides = {}) {
    const target = overrides.oracle ?? fakeOracle();
    return {
        config: overrides.config ?? config(),
        identity: identity(root),
        journal: overrides.journal ??
            PublisherJournal.open(root, "publisher-a", wallet.address),
        provider: overrides.provider ?? fakeProvider([]),
        oracle: target,
        buildQuoteFn: overrides.buildQuoteFn ?? (async () => quote()),
        submitEvidenceFn: overrides.submitEvidenceFn ?? (async () => ({
            topicId,
            sequenceNumber: "1",
            transactionId: "0.0.5001@1.2",
        })),
        findEvidenceFn: overrides.findEvidenceFn ?? (async () => null),
        readDeploymentFn: overrides.readDeploymentFn ??
            deploymentReader(target.target),
        now: overrides.now ?? NOW,
        clock: overrides.clock ?? (() => overrides.now ?? NOW),
        scheduler: overrides.scheduler ?? null,
    };
}

function answerEvidenceInput(overrides = {}) {
    const source = (name) => ({
        observedAt: NOW - 10,
        identity: compactEvidenceIdentity(name),
    });
    return {
        chain: 296,
        oracle: oracleAddress,
        publisher: wallet.address,
        round: 3,
        tx: id("transaction"),
        price: 10_010_000_000n,
        rate: 364,
        observedAt: NOW,
        expiresAt: NOW + 600,
        algorithmVersion: "hybrid-vwap-usd8-v1",
        configurationDigest: id("quote configuration"),
        source: sourceDigest,
        mode: "qualified-market",
        trigger: "NEW_AUCTION_PRINT",
        sources: {
            terms: source("terms"),
            sofr: source("sofr"),
            hbarNetwork: source("hbar-network"),
            hbarMarket: source("hbar-market"),
            auction: source("auction"),
            dealers: source("dealers"),
            model: source("model"),
        },
        quality: {
            flags: Object.values(QUALITY_FLAGS).reduce((sum, flag) => sum | flag, 0),
            exactPrints: 2,
            rejectedPrints: 1,
            dealerQuotes: 1,
            rejectedDealerQuotes: 1,
            crossCheckSources: 2,
        },
        hbarNetwork: 8_000_000,
        hbarMarket: 7_990_000,
        previous: null,
        ...overrides,
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

test("answer evidence uses canonical compact fields with complete bounded provenance", () => {
    const message = encodeEvidence(answerEvidenceInput({previous: id("previous evidence")}));
    const wire = JSON.parse(message);
    const decoded = decodeEvidence(message);
    assert.ok(Buffer.byteLength(message) <= 1024);
    assert.equal(wire.k, "oracle-answer");
    assert.equal(wire.chain, 296);
    assert.equal(wire.c, undefined);
    assert.equal(wire.av, "hybrid-vwap-usd8-v1");
    assert.equal(wire.tr, "NEW_AUCTION_PRINT");
    assert.equal(decoded.expiresAt, NOW + 600);
    assert.equal(decoded.algorithmVersion, "hybrid-vwap-usd8-v1");
    assert.equal(decoded.trigger, "NEW_AUCTION_PRINT");
    assert.equal(decoded.configurationDigest, id("quote configuration"));
    assert.equal(decoded.sources.sofr.observedAt, NOW - 10);
    for (const source of Object.values(decoded.sources)) {
        assert.match(source.identity, /^0x[0-9a-f]{16}$/);
        assert.equal(Number.isSafeInteger(source.observedAt), true);
    }
    assert.equal(decoded.quality.rejectedDealerQuotes, 1);
    assert.equal(
        decoded.quality.flags,
        Object.values(QUALITY_FLAGS).reduce((flags, value) => flags | value, 0),
    );
    assert.equal(
        decoded.quality.flags & QUALITY_FLAGS.MARKET_VWAP,
        QUALITY_FLAGS.MARKET_VWAP,
    );
    assert.throws(() => decodeEvidence(message + " "), (error) =>
        error.code === "NON_CANONICAL");
});

test("status evidence stays bounded and carries machine-readable quality", () => {
    const message = encodeStatusEvidence({
        chain: 296,
        oracle: oracleAddress,
        publisher: wallet.address,
        round: 3,
        observedAt: NOW,
        code: "SOURCE_QUORUM",
        source: sourceDigest,
        quality: {
            flags: 0,
            exactPrints: 0,
            rejectedPrints: 1,
            dealerQuotes: 0,
            rejectedDealerQuotes: 2,
            crossCheckSources: 0,
        },
        answerCount: 0,
        hbarNetwork: 8_000_000,
        hbarMarket: 7_990_000,
        hbarDivergenceBps: 12,
        previous: null,
    });
    const decoded = decodeOracleMessage(message);
    assert.ok(Buffer.byteLength(message) <= 1024);
    assert.equal(decoded.k, "oracle-status");
    assert.equal(decoded.code, "SOURCE_QUORUM");
    assert.equal(decoded.quality.rejectedPrints, 1);
    assert.equal(decoded.quality.rejectedDealerQuotes, 2);
});

test("decoder preserves canonical legacy topic history", () => {
    const legacy = JSON.stringify({
        v: 1,
        k: "oracle-answer",
        chain: 296,
        oracle: oracleAddress.toLowerCase(),
        publisher: wallet.address.toLowerCase(),
        round: "2",
        tx: id("legacy transaction"),
        price: "10000000000",
        rate: "360",
        observedAt: NOW - 1_000,
        expiresAt: NOW - 400,
        source: id("legacy source"),
        mode: "qualified-market",
        exactPrints: 1,
        dealerQuotes: 1,
        hbarNetwork: "8000000",
        hbarMarket: "7990000",
        previous: null,
    });
    const decoded = decodeEvidence(legacy);
    assert.equal(decoded.v, 1);
    assert.equal(decoded.round, "2");
    assert.equal(decoded.exactPrints, 1);
});

test("mirror discovery finds one exact canonical message and rejects duplicates", async () => {
    const message = encodeEvidence(answerEvidenceInput());
    const row = {
        sequence_number: 7,
        consensus_timestamp: "1800000001.000000001",
        running_hash: "abcd",
        message: Buffer.from(message).toString("base64"),
    };
    const found = await findEvidenceMessage({
        mirrorUrl: "https://mirror.invalid",
        topicId,
        message,
        after: NOW,
        pagedFn: async () => [row],
    });
    assert.equal(found.sequenceNumber, "7");
    assert.equal(found.consensusTimestamp, "1800000001.000000001");
    await assert.rejects(
        () => findEvidenceMessage({
            mirrorUrl: "https://mirror.invalid",
            topicId,
            message,
            pagedFn: async () => [row, {...row, sequence_number: 8}],
        }),
        (error) => error.code === "DUPLICATE_EVIDENCE",
    );
});

test("HCS evidence reaches consensus before the signed EVM transaction broadcasts", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-publisher-"));
    try {
        const order = [];
        const result = await runPublisherPass(passOptions(root, {
            provider: fakeProvider(order),
            submitEvidenceFn: async ({message}) => {
                decodeEvidence(message);
                order.push("hcs");
                return {topicId, sequenceNumber: "1", transactionId: "0.0.5001@1.2"};
            },
        }));
        assert.equal(result.action, "submitted");
        assert.deepEqual(order, ["hcs", "evm"]);
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        assert.equal(journal.state.pending, null);
        assert.equal(journal.state.lastConfirmedRound, "3");
        assert.deepEqual(journal.state.lastConfirmedSources, sourceState(quote()));
        const events = readFileSync(join(root, "events.jsonl"), "utf8")
            .trim().split("\n").map((line) => JSON.parse(line).type);
        assert.deepEqual(events, [
            "decision",
            "prepared",
            "evidence-attempted",
            "evidenced",
            "broadcast",
            "confirmed",
        ]);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("receipt loss recovers the consensused answer without another HCS submit", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-recovery-"));
    try {
        let acceptedMessage = null;
        let submits = 0;
        await assert.rejects(
            () => runPublisherPass(passOptions(root, {
                submitEvidenceFn: async ({message}) => {
                    submits += 1;
                    acceptedMessage = message;
                    throw new Error("receipt lost after consensus");
                },
            })),
            /receipt lost/,
        );
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        assert.equal(journal.state.pending.status, "EVIDENCE_PENDING");

        const order = [];
        let quoteCalls = 0;
        const result = await runPublisherPass(passOptions(root, {
            journal,
            provider: fakeProvider(order),
            buildQuoteFn: async () => {
                quoteCalls += 1;
                return quote();
            },
            submitEvidenceFn: async () => {
                submits += 1;
                throw new Error("must not resubmit");
            },
            findEvidenceFn: async ({message}) => {
                assert.equal(message, acceptedMessage);
                order.push("hcs-found");
                return {
                    topicId,
                    sequenceNumber: "2",
                    consensusTimestamp: "1800000001.0",
                };
            },
            now: NOW + 10,
        }));
        assert.equal(result.action, "recovery");
        assert.equal(quoteCalls, 0);
        assert.equal(submits, 1);
        assert.deepEqual(order, ["hcs-found", "evm"]);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("an HCS retry reuses the persisted Hedera transaction ID", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-hcs-idempotent-retry-"));
    try {
        const hederaTransactionId = "0.0.5001@1799999999.123456789";
        await assert.rejects(
            () => runPublisherPass(passOptions(root, {
                submitEvidenceFn: async ({onTransactionId}) => {
                    await onTransactionId(hederaTransactionId);
                    throw new Error("receipt unavailable");
                },
            })),
            /receipt unavailable/,
        );
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        let retriedTransactionId = null;
        const result = await runPublisherPass(passOptions(root, {
            journal,
            now: NOW + 1,
            findEvidenceFn: async () => null,
            submitEvidenceFn: async ({transactionId}) => {
                retriedTransactionId = transactionId;
                return {topicId, sequenceNumber: "4", transactionId};
            },
        }));
        assert.equal(result.action, "recovery");
        assert.equal(result.recovered, true);
        assert.equal(retriedTransactionId, hederaTransactionId);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("a persisted Hedera transaction ID is only reused inside its valid duration", () => {
    const fresh = `0.0.5001@${NOW - 30}.123456789`;
    assert.equal(reusableEvidenceTransactionId(fresh, NOW), fresh);
    assert.equal(
        reusableEvidenceTransactionId(`0.0.5001@${NOW - HEDERA_TRANSACTION_VALID_SECONDS}.0`, NOW),
        null,
    );
    assert.equal(reusableEvidenceTransactionId(`0.0.5001@${NOW - 2_000}.0`, NOW), null);
    assert.equal(reusableEvidenceTransactionId(null, NOW), null);
    assert.equal(reusableEvidenceTransactionId("not-a-transaction-id", NOW), null);
});

test("an HCS retry mints a fresh transaction ID once the persisted one expired", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-hcs-fresh-retry-"));
    try {
        const staleTransactionId = `0.0.5001@${NOW - 400}.123456789`;
        await assert.rejects(
            () => runPublisherPass(passOptions(root, {
                submitEvidenceFn: async ({onTransactionId}) => {
                    await onTransactionId(staleTransactionId);
                    throw new Error("receipt unavailable");
                },
            })),
            /receipt unavailable/,
        );
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        assert.equal(journal.state.pending.evidenceTransactionId, staleTransactionId);
        let retriedTransactionId = "unset";
        const result = await runPublisherPass(passOptions(root, {
            journal,
            now: NOW + 1,
            findEvidenceFn: async () => null,
            submitEvidenceFn: async ({transactionId}) => {
                retriedTransactionId = transactionId;
                return {topicId, sequenceNumber: "4", transactionId: `0.0.5001@${NOW + 1}.0`};
            },
        }));
        assert.equal(result.action, "recovery");
        assert.equal(result.recovered, true);
        assert.equal(retriedTransactionId, null);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("an exhausted status heartbeat is abandoned and the pass carries on", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-status-exhausted-"));
    try {
        const unavailable = {
            ok: false,
            code: "SOURCE_QUORUM",
            reason: "no qualified source quorum",
            sourceDigest,
            terms: {oracle: oracleAddress, usdPerHbar8: 8_000_000n},
            prints: {accepted: [], rejected: []},
            dealers: {accepted: [], rejected: []},
        };
        const submits = [];
        const failing = async ({transactionId, onTransactionId}) => {
            submits.push(transactionId ?? null);
            // Report a valid-start already outside the Hedera window so the
            // retry has to mint a fresh ID instead of replaying this one.
            await onTransactionId(`0.0.5001@${NOW - 1_000 + submits.length}.0`);
            throw new Error("HCS unreachable");
        };
        const first = await runPublisherPass(passOptions(root, {
            buildQuoteFn: async () => unavailable,
            submitEvidenceFn: failing,
        }));
        assert.equal(first.action, "withhold");
        assert.equal(first.statusEvidenceError.message, "HCS unreachable");
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        assert.equal(journal.state.pendingStatus.status, "EVIDENCE_PENDING");
        assert.equal(journal.state.pendingStatus.evidenceAttempts, 1);

        await assert.rejects(
            () => runPublisherPass(passOptions(root, {
                journal,
                now: NOW + 1,
                buildQuoteFn: async () => unavailable,
                submitEvidenceFn: failing,
            })),
            /HCS unreachable/,
        );
        assert.equal(journal.state.pendingStatus.evidenceAttempts, 2);
        assert.deepEqual(submits, [null, null]);

        const waiting = await runPublisherPass(passOptions(root, {
            journal,
            now: NOW + 2,
            buildQuoteFn: async () => {
                throw new Error("valuation must wait for the last HCS attempt to die");
            },
            submitEvidenceFn: async () => {
                throw new Error("must not resubmit an exhausted status");
            },
        }));
        assert.equal(waiting.action, "status-recovery");
        assert.equal(waiting.retryExhausted, true);
        assert.equal(waiting.abandoned, undefined);
        assert.equal(journal.state.pendingStatus.status, "EVIDENCE_PENDING");

        const lastAttemptAt = Number(journal.state.pendingStatus.lastEvidenceAttemptAt);
        const failedBefore = journal.state.counters.failed;
        const hashBefore = journal.state.lastEvidenceHash;
        let statusMessages = 0;
        const resumed = await runPublisherPass(passOptions(root, {
            journal,
            now: lastAttemptAt + HEDERA_TRANSACTION_VALID_SECONDS,
            buildQuoteFn: async () => unavailable,
            findEvidenceFn: async () => null,
            submitEvidenceFn: async () => {
                statusMessages += 1;
                return {topicId, sequenceNumber: "9", transactionId: "0.0.5001@9.9"};
            },
        }));
        assert.equal(resumed.action, "withhold");
        assert.equal(resumed.ok, true);
        assert.equal(statusMessages, 1);
        assert.equal(journal.state.pendingStatus, null);
        assert.equal(journal.state.counters.failed, failedBefore + 1);
        assert.equal(journal.state.lastStatus.code, "SOURCE_QUORUM");
        assert.notEqual(journal.state.lastEvidenceHash, hashBefore);
        const events = readFileSync(join(root, "events.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        const abandoned = events.filter((event) => event.type === "status-abandoned");
        assert.equal(abandoned.length, 1);
        assert.equal(abandoned[0].code, "STATUS_EVIDENCE_EXHAUSTED");
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("expired unresolved HCS evidence blocks until its hash-chain position is known", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-expired-hcs-recovery-"));
    try {
        let acceptedMessage = null;
        let submits = 0;
        const shortWindow = config({
            evidence: {maximumBroadcastDelaySeconds: 5},
        });
        await assert.rejects(
            () => runPublisherPass(passOptions(root, {
                config: shortWindow,
                submitEvidenceFn: async ({message}) => {
                    acceptedMessage = message;
                    submits += 1;
                    throw new Error("receipt lost after consensus");
                },
            })),
            /receipt lost/,
        );
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        const noReceipt = await runPublisherPass(passOptions(root, {
            journal,
            config: shortWindow,
            now: NOW + 10,
            findEvidenceFn: async () => null,
        }));
        assert.equal(noReceipt.action, "recovery");
        assert.equal(noReceipt.blocked, true);
        assert.equal(journal.state.pending.status, "HCS_EXPIRED");

        const order = [];
        const recovered = await runPublisherPass(passOptions(root, {
            journal,
            config: shortWindow,
            provider: fakeProvider(order),
            now: NOW + 20,
            submitEvidenceFn: async () => {
                submits += 1;
                throw new Error("must not resubmit expired evidence");
            },
            findEvidenceFn: async ({message}) => {
                assert.equal(message, acceptedMessage);
                return {
                    topicId,
                    sequenceNumber: "3",
                    consensusTimestamp: "1800000002.0",
                };
            },
        }));
        assert.equal(recovered.action, "recovery");
        assert.equal(recovered.expired, true);
        assert.equal(submits, 1);
        assert.deepEqual(order, []);
        assert.equal(journal.state.pending, null);
        assert.equal(journal.state.lastEvidenceHash, evidenceHash(acceptedMessage));
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("receipt loss on status evidence is recovered before the hash chain advances", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-status-recovery-"));
    try {
        const unavailable = {
            ok: false,
            code: "SOURCE_QUORUM",
            reason: "no qualified source quorum",
            sourceDigest,
            terms: {oracle: oracleAddress, usdPerHbar8: 8_000_000n},
            prints: {accepted: [], rejected: []},
            dealers: {accepted: [], rejected: []},
        };
        let acceptedMessage = null;
        await runPublisherPass(passOptions(root, {
            buildQuoteFn: async () => unavailable,
            submitEvidenceFn: async ({message}) => {
                acceptedMessage = message;
                throw new Error("status receipt lost");
            },
        }));
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        assert.equal(journal.state.pendingStatus.status, "EVIDENCE_PENDING");
        const result = await runPublisherPass(passOptions(root, {
            journal,
            buildQuoteFn: async () => {
                throw new Error("valuation must wait");
            },
            submitEvidenceFn: async () => {
                throw new Error("must not resubmit status");
            },
            findEvidenceFn: async ({message}) => {
                assert.equal(message, acceptedMessage);
                return {topicId, sequenceNumber: "4"};
            },
            now: NOW + 1,
        }));
        assert.equal(result.action, "status-recovery");
        assert.equal(journal.state.pendingStatus, null);
        assert.equal(journal.state.lastEvidenceHash, evidenceHash(acceptedMessage));
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("withheld valuation publishes one throttled status and no EVM transaction", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-status-"));
    try {
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
        const first = await runPublisherPass(passOptions(root, {
            provider: fakeProvider(order),
            buildQuoteFn: async () => unavailable,
            submitEvidenceFn: submitStatus,
        }));
        assert.equal(first.action, "withhold");
        assert.equal(first.decision.code, "SOURCE_QUORUM");
        assert.deepEqual(order, ["hcs-status"]);

        await runPublisherPass(passOptions(root, {
            provider: fakeProvider(order),
            buildQuoteFn: async () => unavailable,
            submitEvidenceFn: submitStatus,
            now: NOW + 100,
        }));
        assert.deepEqual(order, ["hcs-status"]);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("runtime upgrade baselines existing sources without a false publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-source-baseline-"));
    try {
        const currentQuote = quote({
            cleanPriceUsd8: 10_000_000_000n,
            referenceRateBps: 360n,
        });
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        journal.state.lastStatus = {
            code: "NOT_DUE",
            observedAt: NOW,
        };
        journal.save();
        const result = await runPublisherPass(passOptions(root, {
            journal,
            oracle: fakeOracle({
                cleanPrice: 10_000_000_000n,
                refRateBps: 360n,
                publishedAt: BigInt(NOW - 10),
            }),
            config: config({keepaliveSeconds: 1_000}),
            buildQuoteFn: async () => currentQuote,
            submitEvidenceFn: async () => {
                throw new Error("baseline must not submit evidence");
            },
        }));
        assert.equal(result.action, "withhold");
        assert.equal(result.decision.code, "NOT_DUE");
        assert.equal(result.decision.initializeSources, true);
        assert.deepEqual(journal.state.lastSourceBaseline, sourceState(currentQuote));
        assert.equal(journal.state.counters.broadcasts, 0);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("a new qualified auction print triggers an answer once", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-print-trigger-"));
    try {
        const oldPrint = {
            tx: id("old auction transaction"),
            round: 7,
            sourceDigest: id("old qualified print"),
            observedAt: NOW - 30,
            volume: 25n,
        };
        const prior = quote({
            cleanPriceUsd8: 10_000_000_000n,
            referenceRateBps: 360n,
            prints: {accepted: [oldPrint], rejected: []},
        });
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        journal.state.lastConfirmedSources = sourceState(prior);
        journal.save();
        const next = quote({
            cleanPriceUsd8: 10_000_000_000n,
            referenceRateBps: 360n,
            mode: "qualified-market",
            crossCheckSources: ["model"],
            prints: {
                accepted: [{
                    tx: id("new auction transaction"),
                    round: 8,
                    sourceDigest: id("new qualified print"),
                    observedAt: NOW - 5,
                    volume: 30n,
                }],
                rejected: [],
            },
            quality: {exactPrints: 1},
        });
        const result = await runPublisherPass(passOptions(root, {
            journal,
            oracle: fakeOracle({publishedAt: BigInt(NOW - 10)}),
            config: config({keepaliveSeconds: 1_000}),
            buildQuoteFn: async () => next,
        }));
        assert.equal(result.action, "submitted");
        assert.equal(journal.state.lastDecision.code, "NEW_AUCTION_PRINT");
        assert.deepEqual(
            journal.state.lastConfirmedSources.prints,
            [...sourceState(prior).prints, ...sourceState(next).prints].sort(),
        );
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("revaluing the same auction print does not repeat its source trigger", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-print-repeat-"));
    try {
        const print = {
            tx: id("stable auction transaction"),
            round: 8,
            observedAt: NOW - 5,
            sourceDigest: id("print at first HBAR rate"),
            volume: 30n,
        };
        const prior = quote({
            cleanPriceUsd8: 10_000_000_000n,
            referenceRateBps: 360n,
            mode: "qualified-market",
            prints: {accepted: [print], rejected: []},
        });
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        journal.state.lastConfirmedSources = sourceState(prior);
        journal.save();
        const repriced = quote({
            cleanPriceUsd8: 10_000_000_000n,
            referenceRateBps: 360n,
            mode: "qualified-market",
            sourceDigest: id("bundle at second HBAR rate"),
            prints: {
                accepted: [{
                    ...print,
                    sourceDigest: id("print at second HBAR rate"),
                }],
                rejected: [],
            },
        });
        const result = await runPublisherPass(passOptions(root, {
            journal,
            oracle: fakeOracle({publishedAt: BigInt(NOW - 10)}),
            config: config({keepaliveSeconds: 1_000}),
            buildQuoteFn: async () => repriced,
        }));
        assert.equal(result.action, "withhold");
        assert.equal(result.decision.code, "NOT_DUE");
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("a confirmed print does not retrigger after rotating out of the source window", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-print-history-"));
    try {
        const first = {
            tx: id("first rotating auction transaction"),
            round: 7,
            observedAt: NOW - 30,
            sourceDigest: id("first rotating print"),
            volume: 30n,
        };
        const second = {
            tx: id("second rotating auction transaction"),
            round: 8,
            observedAt: NOW - 10,
            sourceDigest: id("second rotating print"),
            volume: 35n,
        };
        const firstQuote = quote({
            cleanPriceUsd8: 10_000_000_000n,
            referenceRateBps: 360n,
            mode: "qualified-market",
            prints: {accepted: [first], rejected: []},
        });
        const secondQuote = quote({
            cleanPriceUsd8: 10_000_000_000n,
            referenceRateBps: 360n,
            mode: "qualified-market",
            prints: {accepted: [second], rejected: []},
        });
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        journal.state.lastConfirmedSources = sourceState(secondQuote);
        journal.state.lastConfirmedSources.prints = [
            ...sourceState(firstQuote).prints,
            ...sourceState(secondQuote).prints,
        ].sort();
        journal.save();
        const result = await runPublisherPass(passOptions(root, {
            journal,
            oracle: fakeOracle({publishedAt: BigInt(NOW - 10)}),
            config: config({keepaliveSeconds: 1_000}),
            buildQuoteFn: async () => firstQuote,
        }));
        assert.equal(result.action, "withhold");
        assert.equal(result.decision.code, "NOT_DUE");
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("a new official SOFR observation triggers an answer", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-sofr-trigger-"));
    try {
        const prior = quote({
            cleanPriceUsd8: 10_000_000_000n,
            referenceRateBps: 360n,
        });
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        journal.state.lastConfirmedSources = sourceState(prior);
        journal.save();
        const next = quote({
            cleanPriceUsd8: 10_000_000_000n,
            referenceRateBps: 361n,
            sofr: {
                rateBps: 361n,
                effectiveAt: prior.sofr.effectiveAt + 86_400,
                sourceDigest: id("next official sofr"),
            },
        });
        const result = await runPublisherPass(passOptions(root, {
            journal,
            oracle: fakeOracle({publishedAt: BigInt(NOW - 10)}),
            config: config({keepaliveSeconds: 1_000}),
            buildQuoteFn: async () => next,
        }));
        assert.equal(result.action, "submitted");
        assert.equal(journal.state.lastDecision.code, "NEW_SOFR");
        assert.deepEqual(journal.state.lastConfirmedSources.sofrSeen, [
            `${prior.sofr.effectiveAt}:${prior.sofr.rateBps}`,
            `${next.sofr.effectiveAt}:${next.sofr.rateBps}`,
        ].sort());
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("a corrected official SOFR rate triggers at the same observation time", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-sofr-correction-"));
    try {
        const prior = quote({
            cleanPriceUsd8: 10_000_000_000n,
            referenceRateBps: 360n,
        });
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        journal.state.lastConfirmedSources = sourceState(prior);
        journal.save();
        const corrected = quote({
            cleanPriceUsd8: 10_000_000_000n,
            referenceRateBps: 361n,
            sofr: {
                rateBps: 361n,
                effectiveAt: prior.sofr.effectiveAt,
                sourceDigest: id("corrected official sofr"),
            },
        });
        const result = await runPublisherPass(passOptions(root, {
            journal,
            oracle: fakeOracle({publishedAt: BigInt(NOW - 10)}),
            config: config({keepaliveSeconds: 1_000}),
            buildQuoteFn: async () => corrected,
        }));
        assert.equal(result.action, "submitted");
        assert.equal(journal.state.lastDecision.code, "NEW_SOFR");
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("dealer re-signing alone does not trigger an oracle answer", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-dealer-resign-"));
    try {
        const prior = quote({
            cleanPriceUsd8: 10_000_000_000n,
            referenceRateBps: 360n,
        });
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        journal.state.lastConfirmedSources = sourceState(prior);
        journal.save();
        const order = [];
        const resigned = quote({
            cleanPriceUsd8: 10_000_000_000n,
            referenceRateBps: 360n,
            sourceDigest: id("same dealer quote re-signed"),
            dealers: {
                accepted: [{
                    ...prior.dealers.accepted[0],
                    signature: "0x34",
                }],
            },
        });
        const result = await runPublisherPass(passOptions(root, {
            journal,
            provider: fakeProvider(order),
            oracle: fakeOracle({publishedAt: BigInt(NOW - 10)}),
            config: config({keepaliveSeconds: 1_000}),
            buildQuoteFn: async () => resigned,
            submitEvidenceFn: async () => {
                order.push("hcs-status");
                return {topicId, sequenceNumber: "8"};
            },
        }));
        assert.equal(result.action, "withhold");
        assert.equal(result.decision.code, "NOT_DUE");
        assert.deepEqual(order, ["hcs-status"]);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("keepalive is capped early enough for the evidence broadcast window", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-safe-keepalive-"));
    try {
        const currentQuote = quote({
            cleanPriceUsd8: 10_000_000_000n,
            referenceRateBps: 360n,
        });
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        journal.state.lastConfirmedSources = sourceState(currentQuote);
        journal.save();
        const result = await runPublisherPass(passOptions(root, {
            journal,
            oracle: fakeOracle({
                cleanPrice: 10_000_000_000n,
                publishedAt: BigInt(NOW - 890),
                heartbeat: 1_000n,
            }),
            config: config({
                keepaliveSeconds: 50_000,
                pollSeconds: 10,
                evidence: {maximumBroadcastDelaySeconds: 100},
            }),
            buildQuoteFn: async () => currentQuote,
        }));
        assert.equal(result.action, "submitted");
        assert.equal(journal.state.lastDecision.code, "KEEPALIVE");
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("deployment promotion blocks an uncertain pending answer before recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-promotion-"));
    try {
        await assert.rejects(
            () => runPublisherPass(passOptions(root, {
                submitEvidenceFn: async () => {
                    throw new Error("receipt lost");
                },
            })),
            /receipt lost/,
        );
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        let externalCalls = 0;
        const result = await runPublisherPass(passOptions(root, {
            journal,
            oracle: fakeOracle({address: promotedOracleAddress}),
            readDeploymentFn: deploymentReader(promotedOracleAddress),
            buildQuoteFn: async () => {
                externalCalls += 1;
                return quote({terms: {oracle: promotedOracleAddress}});
            },
            submitEvidenceFn: async () => {
                externalCalls += 1;
                throw new Error("must not evidence stale pending");
            },
            findEvidenceFn: async () => {
                externalCalls += 1;
                return null;
            },
            provider: fakeProvider([]),
        }));
        assert.equal(result.action, "recovery");
        assert.equal(result.code, "STALE_PENDING_ORACLE");
        assert.equal(result.blocked, true);
        assert.equal(journal.state.pending.status, "BLOCKED");
        assert.equal(externalCalls, 0);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("deployment is rechecked after HCS immediately before broadcast", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-promotion-during-hcs-"));
    try {
        const order = [];
        let promoted = false;
        await assert.rejects(
            () => runPublisherPass(passOptions(root, {
                provider: fakeProvider(order),
                submitEvidenceFn: async () => {
                    order.push("hcs");
                    promoted = true;
                    return {topicId, sequenceNumber: "11"};
                },
                readDeploymentFn: async () => ({
                    client: {
                        addresses: {
                            PrimeOracle: promoted
                                ? promotedOracleAddress
                                : oracleAddress,
                        },
                        network: {mirror: "https://mirror.invalid"},
                    },
                }),
            })),
            (error) => error.code === "DEPLOYMENT_CHANGED",
        );
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        assert.deepEqual(order, ["hcs"]);
        assert.equal(journal.state.pending.status, "EVIDENCED");
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("tampered pending evidence binding fails before discovery or broadcast", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-binding-"));
    try {
        await assert.rejects(
            () => runPublisherPass(passOptions(root, {
                submitEvidenceFn: async () => {
                    throw new Error("receipt lost");
                },
            })),
            /receipt lost/,
        );
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        journal.state.pending.sourceDigest = id("tampered source");
        journal.save();
        let externalCalls = 0;
        await assert.rejects(
            () => runPublisherPass(passOptions(root, {
                journal,
                findEvidenceFn: async () => {
                    externalCalls += 1;
                    return null;
                },
                submitEvidenceFn: async () => {
                    externalCalls += 1;
                    return {topicId, sequenceNumber: "11"};
                },
                provider: fakeProvider([]),
            })),
            (error) => error.code === "PENDING_BINDING_MISMATCH",
        );
        assert.equal(externalCalls, 0);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("expiry crossing during HCS abandons the signed transaction before EVM broadcast", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-hcs-expiry-"));
    try {
        const order = [];
        let wall = NOW;
        const result = await runPublisherPass(passOptions(root, {
            config: config({evidence: {maximumBroadcastDelaySeconds: 5}}),
            provider: fakeProvider(order),
            clock: () => wall,
            submitEvidenceFn: async () => {
                order.push("hcs");
                wall = NOW + 6;
                return {topicId, sequenceNumber: "9"};
            },
        }));
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        assert.equal(result.action, "expired");
        assert.deepEqual(order, ["hcs"]);
        assert.equal(journal.state.pending, null);
        assert.match(journal.state.lastEvidenceHash, /^0x[0-9a-f]{64}$/);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("an expired broadcast record is never rebroadcast", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-rebroadcast-expiry-"));
    try {
        const firstOrder = [];
        await assert.rejects(
            () => runPublisherPass(passOptions(root, {
                config: config({evidence: {maximumBroadcastDelaySeconds: 5}}),
                provider: fakeProvider(firstOrder, {
                    broadcastError: new Error("relay unavailable"),
                }),
            })),
            (error) => error.code === "BROADCAST_FAILED",
        );
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        assert.equal(journal.state.pending.status, "BROADCAST");
        const secondOrder = [];
        let wall = NOW + 4;
        const recoveryProvider = fakeProvider(secondOrder);
        recoveryProvider.getTransactionReceipt = async () => {
            wall = NOW + 6;
            return null;
        };
        const result = await runPublisherPass(passOptions(root, {
            journal,
            config: config({evidence: {maximumBroadcastDelaySeconds: 5}}),
            provider: recoveryProvider,
            now: NOW + 4,
            clock: () => wall,
        }));
        assert.equal(result.action, "recovery");
        assert.equal(result.expired, true);
        assert.equal(journal.state.pending.status, "EXPIRED");
        assert.deepEqual(secondOrder, []);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("an expired answer whose nonce another transaction spent is abandoned", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-nonce-consumed-"));
    try {
        const firstOrder = [];
        await assert.rejects(
            () => runPublisherPass(passOptions(root, {
                config: config({evidence: {maximumBroadcastDelaySeconds: 5}}),
                provider: fakeProvider(firstOrder, {
                    broadcastError: new Error("relay unavailable"),
                }),
            })),
            (error) => error.code === "BROADCAST_FAILED",
        );
        const journal = PublisherJournal.open(root, "publisher-a", wallet.address);
        assert.equal(journal.state.pending.status, "BROADCAST");
        assert.equal(journal.state.pending.nonce, 7);
        const hashBefore = journal.state.lastEvidenceHash;
        const failedBefore = journal.state.counters.failed;

        const secondOrder = [];
        const nonceQueries = [];
        const recoveryProvider = fakeProvider(secondOrder);
        recoveryProvider.getTransactionReceipt = async () => null;
        recoveryProvider.getTransactionCount = async (address, tag) => {
            nonceQueries.push([address, tag]);
            return 8;
        };
        const result = await runPublisherPass(passOptions(root, {
            journal,
            config: config({evidence: {maximumBroadcastDelaySeconds: 5}}),
            provider: recoveryProvider,
            now: NOW + 6,
        }));
        assert.equal(result.action, "recovery");
        assert.equal(result.expired, true);
        assert.equal(result.abandoned, true);
        assert.equal(result.code, "NONCE_CONSUMED");
        assert.deepEqual(nonceQueries, [[wallet.address, "latest"]]);
        assert.deepEqual(secondOrder, []);
        assert.equal(journal.state.pending, null);
        assert.equal(journal.state.lastConfirmedRound, null);
        assert.equal(journal.state.lastEvidenceHash, hashBefore);
        assert.equal(journal.state.counters.failed, failedBefore + 1);

        const reopened = PublisherJournal.open(root, "publisher-a", wallet.address);
        assert.equal(reopened.state.pending, null);
        const events = readFileSync(join(root, "events.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        const abandoned = events.filter((event) => event.type === "abandoned");
        assert.equal(abandoned.length, 1);
        assert.equal(abandoned[0].code, "NONCE_CONSUMED");
        assert.equal(abandoned[0].status, "BROADCAST");
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("an existing open answer rearms a missing scheduler after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-rearm-"));
    try {
        const order = [];
        const target = fakeOracle({
            answered: true,
            panel: [{
                price: 10_010_000_000n,
                rate: 364n,
                by: wallet.address,
            }],
        });
        const options = passOptions(root, {
            provider: fakeProvider(order),
            oracle: target,
            scheduler: fakeScheduler(),
            submitEvidenceFn: async () => {
                order.push("hcs");
                return {topicId, sequenceNumber: "2"};
            },
        });
        const result = await runPublisherPass(options);
        assert.equal(result.decision.code, "ALREADY_ANSWERED");
        assert.equal(result.schedulerArm.configured, true);
        assert.deepEqual(order, ["evm", "hcs"]);
        const retry = await runPublisherPass({...options, now: NOW + 1});
        assert.equal(retry.schedulerArm.throttled, true);
        assert.deepEqual(order, ["evm", "hcs"]);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("scheduler stop state prevents further paid arm calls for the round", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-scheduler-stop-"));
    try {
        const order = [];
        const target = fakeOracle({
            answered: true,
            panel: [{
                price: 10_010_000_000n,
                rate: 364n,
                by: wallet.address,
            }],
        });
        const scheduler = fakeScheduler({
            trackedRound: async () => 3n,
            retryStreak: async () => 4n,
            checksThisRound: async () => 4n,
            lastAnswerCount: async () => 1n,
        });
        const result = await runPublisherPass(passOptions(root, {
            provider: fakeProvider(order),
            oracle: target,
            scheduler,
            submitEvidenceFn: async () => {
                order.push("hcs");
                return {topicId, sequenceNumber: "10"};
            },
        }));
        assert.equal(result.schedulerArm.stopped, true);
        assert.equal(result.schedulerArm.code, "SCHEDULER_RETRY_LIMIT");
        assert.deepEqual(order, ["hcs"]);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});
