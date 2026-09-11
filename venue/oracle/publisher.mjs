import {Contract, JsonRpcProvider, Transaction, ZeroAddress} from "ethers";
import {createServer} from "node:http";
import {existsSync, readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {publisherHealth} from "./healthcheck.mjs";
import {loadOracleConfig, loadPublisherIdentity} from "./lib/config.mjs";
import {
    QUALITY_FLAGS,
    compactEvidenceIdentity,
    decodeEvidence,
    decodeOracleMessage,
    encodeEvidence,
    encodeStatusEvidence,
    evidenceHash,
    findEvidenceMessage,
    submitEvidence,
} from "./lib/evidence.mjs";
import {deviationBps, uint} from "./lib/fixed.mjs";
import {PublisherJournal} from "./lib/journal.mjs";
import {
    HYBRID_QUOTE_ALGORITHM_VERSION,
    buildHybridQuote,
} from "./lib/quote-engine.mjs";
import {readDeployment} from "./lib/terms-source.mjs";
import {
    broadcastPrepared,
    preflight,
    prepareTransaction,
    receiptSummary,
} from "./lib/transactions.mjs";

const SUBMIT_GAS_LIMIT = 500_000n;
const SCHEDULER_ARM_GAS_LIMIT = 3_000_000n;
const DEFAULT_ALGORITHM_VERSION = HYBRID_QUOTE_ALGORITHM_VERSION;

function json(value) {
    return JSON.stringify(value, (_, child) =>
        typeof child === "bigint" ? child.toString() : child);
}

function output(type, fields = {}) {
    console.log(json({at: new Date().toISOString(), type, ...fields}));
}

export function attachPublisherShutdown(proc = process, {deadlineMs = 10_000} = {}) {
    let stopping = false;
    let wake = () => {};
    const wait = (ms) => new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        wake = () => {
            clearTimeout(timer);
            resolve();
        };
    });
    const stop = () => {
        stopping = true;
        wake();
        const timer = setTimeout(() => {
            proc.exit(0);
        }, deadlineMs);
        timer.unref?.();
    };
    proc.on("SIGINT", stop);
    proc.on("SIGTERM", stop);
    return {
        isStopping: () => stopping,
        wait,
        stop,
    };
}

export function startPublisherHealthServer({
    config,
    env = process.env,
    identity = null,
    create = createServer,
} = {}) {
    const port = Number(env.PORT ?? env.ORACLE_HEALTH_PORT ?? 8080);
    const server = create((req, res) => {
        const path = String(req.url ?? "").split("?")[0];
        if (req.method !== "GET" || path !== "/healthz") {
            res.writeHead(404);
            res.end();
            return;
        }
        let result;
        try {
            result = publisherHealth({config, env});
        } catch {
            result = {
                ok: false,
                status: "stalled",
                publisher: identity?.profile ?? env.ORACLE_PUBLISHER_ID ?? null,
                lastLoopAt: null,
                lastConfirmedRound: null,
                pending: null,
            };
        }
        const body = JSON.stringify({
            status: result.ok ? "ok" : result.status,
            publisher: result.publisher ?? identity?.profile ?? null,
            lastLoopAt: result.lastLoopAt ?? null,
            lastConfirmedRound: result.lastConfirmedRound ?? null,
            pending: result.pending ?? null,
        });
        res.writeHead(result.ok ? 200 : 503, {
            "content-type": "application/json",
            "cache-control": "no-store",
        });
        res.end(body);
    });
    server.listen(port, "0.0.0.0");
    return server;
}

export function assertSchedulerOracle(expected, actual, source = "scheduler") {
    if (String(expected).toLowerCase() === String(actual).toLowerCase()) return;
    const error = new Error(
        `${source} is bound to ${actual}, expected current PrimeOracle ${expected}`,
    );
    error.code = "SCHEDULER_TARGET_MISMATCH";
    throw error;
}

export function assertRuntimeAddress(name, expected, actual) {
    if (String(expected).toLowerCase() === String(actual).toLowerCase()) return;
    const error = new Error(
        `${name} changed from ${expected ?? "unconfigured"} to ${actual ?? "unconfigured"}; restart required`,
    );
    error.code = "DEPLOYMENT_CHANGED";
    throw error;
}

function sameAddress(left, right) {
    return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function operationClock(now, clock) {
    return () => Math.max(
        Number(now),
        Math.floor(Number(clock()) || 0),
    );
}

async function currentDeployment(readDeploymentFn) {
    const deployment = await readDeploymentFn();
    if (!deployment?.client?.addresses?.PrimeOracle) {
        const error = new Error("deployment has no current PrimeOracle");
        error.code = "BAD_DEPLOYMENT";
        throw error;
    }
    return deployment.client;
}

async function assertCurrentDeployment(oracleAddress, readDeploymentFn) {
    const deployment = await currentDeployment(readDeploymentFn);
    assertRuntimeAddress(
        "PrimeOracle",
        oracleAddress,
        deployment.addresses.PrimeOracle,
    );
    return deployment;
}

function sourceIdentity(value) {
    return compactEvidenceIdentity(value);
}

function confirmedSourceState(quote) {
    const prints = (quote.prints?.accepted ?? []).map((row) => {
        const tx = String(row.tx ?? "").toLowerCase();
        const round = String(row.round ?? "");
        const observedAt = String(row.observedAt ?? "");
        return tx && round && observedAt
            ? `${tx}:${round}:${observedAt}`
            : String(row.sourceDigest ?? tx).toLowerCase();
    }).filter(Boolean).sort();
    const sofr = quote.sofr?.source === "ny-fed-sofr"
        ? {
            effectiveAt: Number(quote.sofr.effectiveAt),
            rateBps: BigInt(quote.sofr.rateBps).toString(),
        }
        : null;
    return {
        prints: [...new Set(prints)],
        sofr,
        sofrSeen: sofr ? [`${sofr.effectiveAt}:${sofr.rateBps}`] : [],
    };
}

function sourceChange(previous, current) {
    if (!previous) {
        return {newPrint: null, newSofr: false, initialized: true};
    }
    const priorPrints = new Set(previous?.prints ?? []);
    const newPrint = current.prints.find((identity) => !priorPrints.has(identity)) ?? null;
    const currentRate = current.sofr
        ? `${current.sofr.effectiveAt}:${current.sofr.rateBps}`
        : null;
    const priorRates = new Set(previous?.sofrSeen ?? []);
    if (previous?.sofr) {
        priorRates.add(`${previous.sofr.effectiveAt}:${previous.sofr.rateBps}`);
    }
    return {
        newPrint,
        newSofr: currentRate !== null &&
            !priorRates.has(currentRate) &&
            (!previous?.sofr ||
                Number(current.sofr.effectiveAt) >= Number(previous.sofr.effectiveAt)),
    };
}

function mergeConfirmedSourceState(previous, current) {
    const prints = [...new Set([
        ...(previous?.prints ?? []),
        ...current.prints,
    ])].sort();
    const sofrSeen = [...new Set([
        ...(previous?.sofrSeen ?? []),
        ...(previous?.sofr
            ? [`${previous.sofr.effectiveAt}:${previous.sofr.rateBps}`]
            : []),
        ...current.sofrSeen,
    ])].sort();
    let sofr = previous?.sofr ?? null;
    if (current.sofr && (!sofr ||
        Number(current.sofr.effectiveAt) >= Number(sofr.effectiveAt))) {
        sofr = current.sofr;
    }
    return {prints, sofr, sofrSeen};
}

function latestTimestamp(rows, field, fallback) {
    return (rows ?? []).reduce(
        (latest, row) => Math.max(latest, Number(row?.[field] ?? 0)),
        Number(fallback),
    );
}

function evidenceSources(quote, algorithmVersion) {
    const at = Number(quote.observedAt);
    const prints = quote.prints?.accepted ?? [];
    const dealers = quote.dealers?.accepted ?? [];
    return {
        terms: {
            observedAt: at,
            identity: sourceIdentity([
                quote.terms.sourceDigest,
                quote.terms.oracle,
                quote.terms.schedule,
            ]),
        },
        sofr: {
            observedAt: Number(quote.sofr.effectiveAt),
            identity: sourceIdentity(quote.sofr.sourceDigest),
        },
        hbarNetwork: {
            observedAt: Number(quote.terms.hbarRateUpdatedAt),
            identity: sourceIdentity([
                quote.terms.oracle,
                quote.terms.hbarRateUpdatedAt,
                quote.terms.usdPerHbar8,
            ]),
        },
        hbarMarket: quote.marketRate ? {
            observedAt: Number(quote.marketRate.updatedAt),
            identity: sourceIdentity(quote.marketRate.sourceDigest),
        } : null,
        auction: prints.length > 0 ? {
            observedAt: latestTimestamp(prints, "observedAt", at),
            identity: sourceIdentity(
                prints.map((row) => row.sourceDigest ?? row.tx).sort(),
            ),
        } : null,
        dealers: dealers.length > 0 ? {
            observedAt: latestTimestamp(dealers, "effectiveAt", at),
            identity: sourceIdentity(dealers.map((row) => [
                row.signer,
                row.effectiveAt,
                row.nonce,
                row.sourceDigest,
            ]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))),
        } : null,
        model: {
            observedAt: Number(quote.model?.observedAt ?? at),
            identity: sourceIdentity([
                algorithmVersion,
                quote.model?.cleanPriceUsd8,
                quote.model?.discountRateBps,
            ]),
        },
    };
}

function evidenceQuality(quote) {
    const quotedFlags = Number(
        quote.quality?.qualityFlags ?? quote.provenance?.qualityFlags,
    );
    let flags = Number.isSafeInteger(quotedFlags) && quotedFlags >= 0
        ? quotedFlags
        : 0;
    if (quote.sofr) flags |= QUALITY_FLAGS.SOFR_QUALIFIED;
    if (["qualified-market", "market-only"].includes(quote.mode)) {
        flags |= QUALITY_FLAGS.AUCTION_QUALIFIED;
        flags |= QUALITY_FLAGS.MARKET_VWAP;
    }
    if ((quote.dealers?.accepted?.length ?? 0) > 0) {
        flags |= QUALITY_FLAGS.DEALER_QUALIFIED;
    }
    if (quote.mode === "qualified-market") {
        flags |= QUALITY_FLAGS.INDEPENDENT_CROSS_CHECK;
    }
    if (quote.marketRate) {
        flags |= QUALITY_FLAGS.HBAR_MARKET_QUALIFIED;
    }
    if (quote.ok) flags |= QUALITY_FLAGS.VALUATION_QUALIFIED;
    if ((quote.prints?.rejected?.length ?? 0) > 0 ||
        (quote.dealers?.rejected?.length ?? 0) > 0) {
        flags |= QUALITY_FLAGS.SOURCE_REJECTIONS;
    }
    return {
        flags,
        exactPrints: quote.quality?.exactPrints ?? quote.prints?.accepted?.length ?? 0,
        rejectedPrints: quote.quality?.rejectedPrints ?? quote.prints?.rejected?.length ?? 0,
        dealerQuotes: quote.quality?.dealerQuotes ?? quote.dealers?.accepted?.length ?? 0,
        rejectedDealerQuotes: quote.quality?.rejectedDealerQuotes ??
            quote.dealers?.rejected?.length ?? 0,
        crossCheckSources: quote.crossCheckSources?.length ?? 0,
    };
}

function validatePendingBinding(record, {
    config,
    identity,
    oracle,
    lastEvidenceHash,
    status = false,
}) {
    const decoded = status
        ? decodeOracleMessage(record.evidenceMessage)
        : decodeEvidence(record.evidenceMessage);
    const expectedKind = status ? "oracle-status" : "oracle-answer";
    const mismatches = [];
    if (decoded.k !== expectedKind) mismatches.push("kind");
    if (Number(record.chainId) !== Number(config.chainId) ||
        decoded.chain !== Number(config.chainId)) mismatches.push("chain");
    if (!sameAddress(record.publisher, identity.address) ||
        !sameAddress(decoded.publisher, identity.address)) mismatches.push("publisher");
    if (String(record.topicId) !== String(identity.topicId)) mismatches.push("topic");
    if (!sameAddress(record.oracle, decoded.oracle) ||
        !sameAddress(record.oracle, record.to ?? record.oracle)) mismatches.push("oracle-record");
    if (record.evidenceHash !== evidenceHash(record.evidenceMessage)) {
        mismatches.push("evidence-hash");
    }
    if (status) {
        if (decoded.round !== String(record.round)) mismatches.push("round");
        if (decoded.code !== String(record.code)) mismatches.push("code");
        if (decoded.observedAt !== Number(record.observedAt)) {
            mismatches.push("observedAt");
        }
        if (decoded.previous !== (lastEvidenceHash ?? null)) {
            mismatches.push("journal-head");
        }
    } else {
        if (decoded.tx !== String(record.txHash).toLowerCase()) mismatches.push("tx");
        if (decoded.round !== String(record.round)) mismatches.push("round");
        if (decoded.price !== String(record.cleanPriceUsd8)) mismatches.push("price");
        if (decoded.rate !== String(record.referenceRateBps)) mismatches.push("rate");
        if (decoded.expiresAt !== Number(record.expiresAt)) mismatches.push("expiry");
        if (decoded.observedAt !== Number(record.observedAt)) mismatches.push("observedAt");
        if (decoded.source !== String(record.sourceDigest).toLowerCase()) {
            mismatches.push("source");
        }
        try {
            const transaction = Transaction.from(record.signedTransaction);
            if (transaction.hash?.toLowerCase() !== decoded.tx) {
                mismatches.push("signed-tx-hash");
            }
            if (Number(transaction.chainId) !== Number(config.chainId)) {
                mismatches.push("signed-tx-chain");
            }
            if (!sameAddress(transaction.to, record.oracle)) {
                mismatches.push("signed-tx-oracle");
            }
            if (!sameAddress(transaction.from, identity.address)) {
                mismatches.push("signed-tx-publisher");
            }
            const call = oracle.interface.parseTransaction({data: transaction.data});
            if (call?.name !== "submit" ||
                BigInt(call.args[0]).toString() !== decoded.round ||
                BigInt(call.args[1]).toString() !== decoded.price ||
                BigInt(call.args[2]).toString() !== decoded.rate) {
                mismatches.push("signed-tx-calldata");
            }
        } catch {
            mismatches.push("signed-transaction");
        }
        const evidenceKnown = ["EVIDENCED", "BROADCAST", "EXPIRED"].includes(
            record.status,
        );
        if (evidenceKnown
            ? record.evidenceHash !== lastEvidenceHash
            : decoded.previous !== (lastEvidenceHash ?? null)) {
            mismatches.push("journal-head");
        }
    }
    if (mismatches.length > 0) {
        const error = new Error(`pending record binding mismatch: ${mismatches.join(", ")}`);
        error.code = "PENDING_BINDING_MISMATCH";
        throw error;
    }
    return {
        decoded,
        currentOracle: sameAddress(record.oracle, oracle.target),
    };
}

function pendingTransaction(record) {
    return {
        purpose: record.purpose,
        nonce: record.nonce,
        to: record.to,
        gasLimit: record.gasLimit,
        value: record.value,
        txHash: record.txHash,
        signedTransaction: record.signedTransaction,
    };
}

async function recoverPending({
    config,
    identity,
    journal,
    provider,
    oracle,
    submitEvidenceFn,
    findEvidenceFn,
    readDeploymentFn,
    now,
    clock,
    mirrorUrl,
}) {
    const pending = journal.state.pending;
    if (!pending) return null;
    if (["FAILED", "BLOCKED"].includes(pending.status)) {
        return {
            recovered: false,
            blocked: true,
            code: pending.lastError?.code ?? "PENDING_BLOCKED",
        };
    }
    const binding = validatePendingBinding(pending, {
        config,
        identity,
        oracle,
        lastEvidenceHash: journal.state.lastEvidenceHash,
    });
    if (!binding.currentOracle) {
        const message = `pending answer targets superseded oracle ${pending.oracle}`;
        if (pending.status === "PREPARED" &&
            Number(pending.evidenceAttempts ?? 0) === 0) {
            journal.abandon("STALE_PENDING_ORACLE", message);
        } else {
            journal.blockPending("STALE_PENDING_ORACLE", message);
        }
        return {
            recovered: false,
            stale: true,
            blocked: journal.state.pending !== null,
            code: "STALE_PENDING_ORACLE",
        };
    }
    await assertCurrentDeployment(oracle.target, readDeploymentFn);
    const currentTime = operationClock(now, clock);
    const isExpired = () => currentTime() > Number(
        journal.state.pending?.expiresAt ?? pending.expiresAt,
    );

    if (pending.status === "PREPARED") {
        if (isExpired()) {
            journal.abandon("EVIDENCE_EXPIRED", "prepared answer expired before HCS");
            return {recovered: false, expired: true};
        }
        await assertCurrentDeployment(oracle.target, readDeploymentFn);
        journal.evidenceAttempted(currentTime());
        const evidenceReceipt = await submitEvidenceFn({
            chainId: config.chainId,
            accountId: identity.accountId,
            privateKey: identity.wallet.privateKey.replace(/^0x/, ""),
            topicId: identity.topicId,
            message: pending.evidenceMessage,
            onTransactionId: async (transactionId) => {
                if (transactionId) journal.evidenceTransactionId(transactionId);
            },
        });
        journal.evidenced(evidenceReceipt, evidenceHash(pending.evidenceMessage));
    }
    if (["EVIDENCE_PENDING", "HCS_EXPIRED"].includes(
        journal.state.pending?.status,
    )) {
        const record = journal.state.pending;
        const found = await findEvidenceFn({
            mirrorUrl,
            topicId: identity.topicId,
            message: record.evidenceMessage,
            after: record.lastEvidenceAttemptAt,
        });
        if (found) {
            journal.evidenced(found, record.evidenceHash);
        } else if (isExpired()) {
            journal.expirePendingEvidence(
                "EVIDENCE_EXPIRED",
                "answer expired while its HCS receipt was unresolved",
            );
            return {
                recovered: false,
                expired: true,
                evidencePending: true,
                blocked: true,
            };
        } else {
            const delay = Math.max(
                0,
                Number(config.evidence?.receiptRecoverySeconds ?? 120),
            );
            const attemptedAt = Number(record.lastEvidenceAttemptAt ?? currentTime());
            if (currentTime() < attemptedAt + delay) {
                return {
                    recovered: false,
                    evidencePending: true,
                    retryAt: attemptedAt + delay,
                };
            }
            const maximumAttempts = Math.max(
                1,
                Number(config.evidence?.maximumEvidenceAttempts ?? 2),
            );
            if (Number(record.evidenceAttempts ?? 0) >= maximumAttempts) {
                return {
                    recovered: false,
                    evidencePending: true,
                    retryExhausted: true,
                };
            }
            await assertCurrentDeployment(oracle.target, readDeploymentFn);
            journal.evidenceAttempted(currentTime());
            const evidenceReceipt = await submitEvidenceFn({
                chainId: config.chainId,
                accountId: identity.accountId,
                privateKey: identity.wallet.privateKey.replace(/^0x/, ""),
                topicId: identity.topicId,
                message: record.evidenceMessage,
                transactionId: record.evidenceTransactionId ?? null,
                onTransactionId: async (transactionId) => {
                    if (transactionId) journal.evidenceTransactionId(transactionId);
                },
            });
            journal.evidenced(evidenceReceipt, record.evidenceHash);
        }
    }
    if (journal.state.pending?.status === "EVIDENCED") {
        if (isExpired()) {
            journal.abandon("EVIDENCE_EXPIRED", "evidenced answer expired before broadcast");
            return {recovered: false, expired: true};
        }
        await assertCurrentDeployment(oracle.target, readDeploymentFn);
        journal.broadcast();
        await assertCurrentDeployment(oracle.target, readDeploymentFn);
        if (isExpired()) {
            journal.abandon("EVIDENCE_EXPIRED", "answer expired immediately before broadcast");
            return {recovered: false, expired: true};
        }
        let receipt;
        try {
            receipt = await broadcastPrepared(
                provider,
                pendingTransaction(journal.state.pending),
                config.transactions,
            );
        } catch (error) {
            if (error.code === "REVERTED") {
                journal.failed(error.code, error.message, {terminal: true});
                return {recovered: false, terminal: true, code: error.code};
            }
            throw error;
        }
        journal.confirmed(receipt);
        return {recovered: true, receipt};
    }
    if (["BROADCAST", "EXPIRED"].includes(journal.state.pending?.status)) {
        await assertCurrentDeployment(oracle.target, readDeploymentFn);
        const known = await provider.getTransactionReceipt(
            journal.state.pending.txHash,
        ).catch(() => null);
        if (known) {
            const summary = receiptSummary(known);
            if (summary.status !== 1) {
                journal.failed(
                    "REVERTED",
                    `transaction ${journal.state.pending.txHash} reverted`,
                    {terminal: true},
                );
                return {recovered: false, terminal: true, code: "REVERTED"};
            }
            journal.confirmed(summary);
            return {recovered: true, receipt: summary};
        }
        await assertCurrentDeployment(oracle.target, readDeploymentFn);
        if (isExpired()) {
            journal.expireBroadcast(
                "EVIDENCE_EXPIRED",
                "expired answer will not be rebroadcast",
            );
            return {recovered: false, expired: true, blocked: true};
        }
        let receipt;
        try {
            receipt = await broadcastPrepared(
                provider,
                pendingTransaction(journal.state.pending),
                config.transactions,
            );
        } catch (error) {
            if (error.code === "REVERTED") {
                journal.failed(error.code, error.message, {terminal: true});
                return {recovered: false, terminal: true, code: error.code};
            }
            throw error;
        }
        journal.confirmed(receipt);
        return {recovered: true, receipt};
    }
    return null;
}

async function recoverPendingStatus({
    config,
    identity,
    journal,
    oracle,
    submitEvidenceFn,
    findEvidenceFn,
    readDeploymentFn,
    now,
    clock,
    mirrorUrl,
}) {
    const pending = journal.state.pendingStatus;
    if (!pending) return null;
    if (["FAILED", "BLOCKED"].includes(pending.status)) {
        return {
            recovered: false,
            blocked: true,
            code: pending.lastError?.code ?? "STATUS_PENDING_BLOCKED",
        };
    }
    const binding = validatePendingBinding(pending, {
        config,
        identity,
        oracle,
        lastEvidenceHash: journal.state.lastEvidenceHash,
        status: true,
    });
    if (!binding.currentOracle) {
        const message = `pending status targets superseded oracle ${pending.oracle}`;
        if (pending.status === "PREPARED" &&
            Number(pending.evidenceAttempts ?? 0) === 0) {
            journal.abandonStatus("STALE_PENDING_ORACLE", message);
        } else {
            journal.blockStatus("STALE_PENDING_ORACLE", message);
        }
        return {
            recovered: false,
            stale: true,
            blocked: journal.state.pendingStatus !== null,
            code: "STALE_PENDING_ORACLE",
        };
    }
    await assertCurrentDeployment(oracle.target, readDeploymentFn);
    const currentTime = operationClock(now, clock);
    const submit = async () => {
        const record = journal.state.pendingStatus;
        await assertCurrentDeployment(oracle.target, readDeploymentFn);
        journal.statusEvidenceAttempted(currentTime());
        const receipt = await submitEvidenceFn({
            chainId: config.chainId,
            accountId: identity.accountId,
            privateKey: identity.wallet.privateKey.replace(/^0x/, ""),
            topicId: identity.topicId,
            message: record.evidenceMessage,
            transactionId: record.evidenceTransactionId ?? null,
            onTransactionId: async (transactionId) => {
                if (transactionId) {
                    journal.statusEvidenceTransactionId(transactionId);
                }
            },
        });
        journal.statusEvidenced(
            receipt,
            record.evidenceHash,
            record.code,
            record.observedAt,
        );
        return receipt;
    };
    if (pending.status === "PREPARED") {
        const receipt = await submit();
        return {recovered: true, statusEvidence: receipt};
    }
    if (pending.status === "EVIDENCE_PENDING") {
        const found = await findEvidenceFn({
            mirrorUrl,
            topicId: identity.topicId,
            message: pending.evidenceMessage,
            after: pending.lastEvidenceAttemptAt,
        });
        if (found) {
            journal.statusEvidenced(
                found,
                pending.evidenceHash,
                pending.code,
                pending.observedAt,
            );
            return {recovered: true, statusEvidence: found};
        }
        const delay = Math.max(
            0,
            Number(config.evidence?.receiptRecoverySeconds ?? 120),
        );
        const attemptedAt = Number(pending.lastEvidenceAttemptAt ?? currentTime());
        if (currentTime() < attemptedAt + delay) {
            return {
                recovered: false,
                evidencePending: true,
                retryAt: attemptedAt + delay,
            };
        }
        const maximumAttempts = Math.max(
            1,
            Number(config.evidence?.maximumEvidenceAttempts ?? 2),
        );
        if (Number(pending.evidenceAttempts ?? 0) >= maximumAttempts) {
            return {
                recovered: false,
                evidencePending: true,
                retryExhausted: true,
            };
        }
        const receipt = await submit();
        return {recovered: true, statusEvidence: receipt};
    }
    return {
        recovered: false,
        blocked: true,
        code: "UNKNOWN_STATUS_PENDING_STATE",
    };
}

async function armSchedulerIfNeeded({
    scheduler,
    identity,
    journal,
    provider,
    config,
    round,
    answerCount = null,
    now = Math.floor(Date.now() / 1000),
}) {
    if (!scheduler) return {configured: false, armed: false};
    const [
        active,
        nextCheckAtValue,
        lateGraceValue,
        trackedRoundValue,
        retryStreakValue,
        checksThisRoundValue,
        lastAnswerCountValue,
        maximumRetryValue,
        maximumChecksValue,
        lastFinalizedRoundValue,
    ] = await Promise.all([
        scheduler.activeSchedule(),
        scheduler.nextCheckAt(),
        scheduler.SCHEDULE_LATE_GRACE(),
        scheduler.trackedRound(),
        scheduler.retryStreak(),
        scheduler.checksThisRound(),
        scheduler.lastAnswerCount(),
        scheduler.MAX_RETRY_STREAK(),
        scheduler.MAX_CHECKS_PER_ROUND(),
        scheduler.lastFinalizedRound(),
    ]);
    const nextCheckAt = Number(nextCheckAtValue);
    const lateGrace = Number(lateGraceValue);
    if (String(active).toLowerCase() !== ZeroAddress.toLowerCase() &&
        now <= nextCheckAt + lateGrace) {
        return {
            configured: true,
            armed: true,
            alreadyActive: true,
            scheduleAddress: String(active),
            nextCheckAt,
        };
    }
    const trackedRound = BigInt(trackedRoundValue);
    const retryStreak = Number(retryStreakValue);
    const checksThisRound = Number(checksThisRoundValue);
    const lastAnswerCount = Number(lastAnswerCountValue);
    const maximumRetry = Number(maximumRetryValue);
    const maximumChecks = Number(maximumChecksValue);
    const lastFinalizedRound = BigInt(lastFinalizedRoundValue);
    const currentAnswers = answerCount === null
        ? lastAnswerCount
        : Number(answerCount);
    let stopCode = null;
    if (lastFinalizedRound >= BigInt(round)) {
        stopCode = "SCHEDULER_ROUND_FINALIZED";
    } else if (trackedRound === BigInt(round) && checksThisRound >= maximumChecks) {
        stopCode = "SCHEDULER_CHECK_LIMIT";
    } else if (trackedRound === BigInt(round) && retryStreak >= maximumRetry &&
        currentAnswers <= lastAnswerCount) {
        stopCode = "SCHEDULER_RETRY_LIMIT";
    }
    if (stopCode) {
        journal.schedulerArm({
            at: now,
            round: String(round),
            status: "STOPPED",
            code: stopCode,
            checksThisRound,
            retryStreak,
            answerCount: currentAnswers,
        });
        return {
            configured: true,
            armed: false,
            stopped: true,
            code: stopCode,
            checksThisRound,
            retryStreak,
        };
    }
    const lastAttempt = journal.state.lastSchedulerArm;
    const retrySeconds = Math.max(60, Number(config.scheduler?.retrySeconds ?? 300));
    if (lastAttempt && String(lastAttempt.round) === String(round) &&
        now < Number(lastAttempt.at) + retrySeconds) {
        return {
            configured: true,
            armed: false,
            throttled: true,
            retryAt: Number(lastAttempt.at) + retrySeconds,
        };
    }
    const minimumTinybar = BigInt(await scheduler.MIN_BALANCE_TINYBAR());
    const balanceWeibar = BigInt(await provider.getBalance(scheduler.target));
    if (balanceWeibar < minimumTinybar * 10_000_000_000n) {
        journal.schedulerArm({
            at: now,
            round: String(round),
            status: "UNFUNDED",
            balanceWeibar: balanceWeibar.toString(),
        });
        return {
            configured: true,
            armed: false,
            code: "SCHEDULER_UNFUNDED",
        };
    }
    const prepared = await prepareTransaction({
        wallet: identity.wallet,
        provider,
        chainId: config.chainId,
        to: scheduler.target,
        data: scheduler.interface.encodeFunctionData("arm"),
        purpose: "oracle-scheduler-arm",
        gasLimit: SCHEDULER_ARM_GAS_LIMIT,
    });
    journal.schedulerArm({
        at: now,
        round: String(round),
        status: "PREPARED",
        txHash: prepared.txHash,
    });
    const receipt = await broadcastPrepared(provider, prepared, config.transactions);
    const scheduleAddress = String(await scheduler.activeSchedule());
    const armed = scheduleAddress.toLowerCase() !== ZeroAddress.toLowerCase();
    journal.schedulerArm({
        at: now,
        round: String(round),
        status: armed ? "ARMED" : "UNSCHEDULED",
        txHash: prepared.txHash,
        scheduleAddress,
    });
    return {
        configured: true,
        armed,
        alreadyActive: false,
        txHash: prepared.txHash,
        receipt,
        scheduleAddress,
        nextCheckAt: armed ? Number(await scheduler.nextCheckAt()) : 0,
    };
}

async function oracleState(oracle, publisher) {
    const [round, latest, heartbeat, maximumDeviationBps] = await Promise.all([
        oracle.openRound(),
        oracle.latest(),
        oracle.heartbeat(),
        oracle.maxDeviationBps(),
    ]);
    const [seated, answered, panel] = await Promise.all([
        oracle.seated(publisher),
        oracle.answered(round, publisher),
        oracle.panelOf(round),
    ]);
    return {
        round: BigInt(round),
        latestPrice: BigInt(latest.cleanPrice ?? latest[0]),
        latestRate: BigInt(latest.refRateBps ?? latest[1]),
        publishedAt: Number(latest.publishedAt ?? latest[2]),
        lastRound: BigInt(latest.round ?? latest[3]),
        heartbeat: Number(heartbeat),
        maximumDeviationBps: BigInt(maximumDeviationBps),
        seated: Boolean(seated),
        answered: Boolean(answered),
        answerCount: panel.length,
    };
}

function publishDecision(
    state,
    quote,
    config,
    now,
    previousSources,
    oracleAddress,
) {
    if (!quote.ok) {
        return {
            publish: false,
            code: quote.code ?? "VALUATION_UNAVAILABLE",
            reason: quote.reason ?? "valuation sources are unavailable",
        };
    }
    if (state.answered) {
        return {
            publish: false,
            code: "ALREADY_ANSWERED",
            reason: `publisher already answered round ${state.round}`,
        };
    }
    if (!state.seated) {
        return {
            publish: false,
            code: "NOT_SEATED",
            reason: "publisher address is not seated in PrimeOracle",
        };
    }
    if (!quote.terms?.oracle || !sameAddress(quote.terms.oracle, oracleAddress)) {
        return {
            publish: false,
            code: "QUOTE_TARGET_MISSING",
            reason: "valuation does not carry a bound oracle target",
        };
    }
    if (!quote.algorithmVersion ||
        !/^0x[0-9a-fA-F]{64}$/.test(String(quote.configurationDigest ?? ""))) {
        return {
            publish: false,
            code: "QUOTE_METADATA_MISSING",
            reason: "valuation lacks its algorithm or configuration identity",
        };
    }
    const price = uint(quote.cleanPriceUsd8, "cleanPriceUsd8");
    if (price === 0n || price > (1n << 128n) - 1n) {
        return {publish: false, code: "BAD_PRICE", reason: "price is outside uint128"};
    }
    const rate = uint(quote.referenceRateBps, "referenceRateBps");
    if (rate > (1n << 64n) - 1n) {
        return {publish: false, code: "BAD_RATE", reason: "reference rate is outside uint64"};
    }

    let moved = null;
    if (state.latestPrice > 0n) {
        moved = deviationBps(price, state.latestPrice);
        if (moved > state.maximumDeviationBps) {
            return {
                publish: false,
                code: "ORACLE_DEVIATION_CAP",
                reason: `valuation moved ${moved} bps, contract cap is ${state.maximumDeviationBps}`,
                movedBps: moved,
            };
        }
    }
    const maximumDelay = Math.max(
        1,
        Number(config.evidence?.maximumBroadcastDelaySeconds ?? 600),
    );
    const pollSeconds = Math.max(1, Number(config.pollSeconds ?? 15));
    const configuredKeepalive = Number(
        config.keepaliveSeconds ?? Math.floor(state.heartbeat * 2 / 3),
    );
    const latestSafeInterval = Math.max(
        1,
        state.heartbeat - maximumDelay - pollSeconds,
    );
    const keepalive = Math.min(configuredKeepalive, latestSafeInterval);
    const keepaliveDue = state.publishedAt === 0 || now >= state.publishedAt + keepalive;
    const feedStale = state.publishedAt === 0 || now > state.publishedAt + state.heartbeat;
    const moveDue = moved !== null && moved >= uint(config.publishMoveBps ?? 25, "publishMoveBps");
    const joinOpenRound = state.answerCount > 0;
    const observedSources = confirmedSourceState(quote);
    const changed = sourceChange(previousSources, observedSources);
    const sources = mergeConfirmedSourceState(previousSources, observedSources);
    if (!keepaliveDue && !moveDue && !joinOpenRound &&
        !changed.newPrint && !changed.newSofr) {
        return {
            publish: false,
            code: "NOT_DUE",
            reason: "no qualified source, movement, open-round, or keepalive trigger is due",
            movedBps: moved,
            nextKeepaliveAt: state.publishedAt + keepalive,
            sources,
            initializeSources: Boolean(changed.initialized),
        };
    }
    let code;
    if (changed.newPrint) code = "NEW_AUCTION_PRINT";
    else if (changed.newSofr) code = "NEW_SOFR";
    else if (joinOpenRound) code = "JOIN_ROUND";
    else if (moveDue) code = "PRICE_MOVE";
    else code = feedStale ? "RECOVER_STALE" : "KEEPALIVE";
    return {
        publish: true,
        code,
        reason: "validated source quorum permits publication",
        movedBps: moved,
        price,
        rate,
        sources,
    };
}

async function publishStatusIfDue({
    config,
    identity,
    journal,
    submitEvidenceFn,
    state,
    quote,
    decision,
    oracleAddress,
    readDeploymentFn,
    now,
}) {
    const previous = journal.state.lastStatus;
    const heartbeat = Number(config.evidence?.statusHeartbeatSeconds ?? 900);
    if (previous?.code === decision.code &&
        now < Number(previous.observedAt) + heartbeat) {
        return null;
    }
    const message = encodeStatusEvidence({
        chain: config.chainId,
        oracle: oracleAddress,
        publisher: identity.address,
        round: state.round,
        observedAt: now,
        code: decision.code,
        source: quote.sourceDigest ?? null,
        quality: quote.ok ? evidenceQuality(quote) : {
            flags: Number(
                quote.quality?.qualityFlags ?? quote.provenance?.qualityFlags ?? 0,
            ),
            exactPrints: quote.quality?.exactPrints ?? quote.prints?.accepted?.length ?? 0,
            rejectedPrints: quote.quality?.rejectedPrints ??
                quote.prints?.rejected?.length ?? 0,
            dealerQuotes: quote.quality?.dealerQuotes ??
                quote.dealers?.accepted?.length ?? 0,
            rejectedDealerQuotes: quote.quality?.rejectedDealerQuotes ??
                quote.dealers?.rejected?.length ?? 0,
            crossCheckSources: quote.crossCheckSources?.length ?? 0,
        },
        answerCount: state.answerCount,
        hbarNetwork: quote.terms?.usdPerHbar8 ?? null,
        hbarMarket: quote.marketRate?.usdPerHbar8 ?? null,
        hbarDivergenceBps: quote.hbarDivergenceBps ?? null,
        previous: journal.state.lastEvidenceHash,
    });
    const hash = evidenceHash(message);
    await assertCurrentDeployment(oracleAddress, readDeploymentFn);
    journal.statusPrepared({
        chainId: Number(config.chainId),
        oracle: oracleAddress,
        publisher: identity.address,
        topicId: identity.topicId,
        round: state.round.toString(),
        code: decision.code,
        observedAt: now,
        evidenceMessage: message,
        evidenceHash: hash,
    });
    journal.statusEvidenceAttempted(now);
    const receipt = await submitEvidenceFn({
        chainId: config.chainId,
        accountId: identity.accountId,
        privateKey: identity.wallet.privateKey.replace(/^0x/, ""),
        topicId: identity.topicId,
        message,
        onTransactionId: async (transactionId) => {
            if (transactionId) journal.statusEvidenceTransactionId(transactionId);
        },
    });
    journal.statusEvidenced(receipt, hash, decision.code, now);
    return receipt;
}

export async function runPublisherPass({
    config,
    identity,
    journal,
    provider,
    oracle,
    scheduler = null,
    buildQuoteFn = buildHybridQuote,
    submitEvidenceFn = submitEvidence,
    findEvidenceFn = findEvidenceMessage,
    readDeploymentFn = readDeployment,
    now = Math.floor(Date.now() / 1000),
    clock = () => Math.floor(Date.now() / 1000),
}) {
    const deployment = await assertCurrentDeployment(oracle.target, readDeploymentFn);
    const mirrorUrl = config.mirrorUrl ?? deployment.network?.mirror;
    const statusRecovery = await recoverPendingStatus({
        config,
        identity,
        journal,
        oracle,
        submitEvidenceFn,
        findEvidenceFn,
        readDeploymentFn,
        now,
        clock,
        mirrorUrl,
    });
    if (statusRecovery) {
        return {
            ok: Boolean(statusRecovery.recovered) && !statusRecovery.blocked,
            action: "status-recovery",
            ...statusRecovery,
        };
    }
    const recovered = await recoverPending({
        config,
        identity,
        journal,
        provider,
        oracle,
        submitEvidenceFn,
        findEvidenceFn,
        readDeploymentFn,
        now,
        clock,
        mirrorUrl,
    });
    if (recovered) {
        let schedulerArm = null;
        if (recovered.recovered) {
            const panel = await oracle.panelOf(journal.state.lastConfirmedRound)
                .catch(() => []);
            schedulerArm = await armSchedulerIfNeeded({
                scheduler,
                identity,
                journal,
                provider,
                config,
                round: journal.state.lastConfirmedRound,
                answerCount: panel.length,
                now,
            }).catch((error) => ({armed: false, code: error.code, message: error.message}));
        }
        return {
            ok: Boolean(recovered.recovered) && !recovered.blocked,
            action: "recovery",
            schedulerArm,
            ...recovered,
        };
    }

    const state = await oracleState(oracle, identity.address);
    let schedulerArm = null;
    if (state.answerCount > 0) {
        schedulerArm = await armSchedulerIfNeeded({
            scheduler,
            identity,
            journal,
            provider,
            config,
            round: state.round,
            answerCount: state.answerCount,
            now,
        }).catch((error) => ({armed: false, code: error.code, message: error.message}));
    }
    let quote;
    try {
        quote = await buildQuoteFn(config, {provider, now});
    } catch (error) {
        quote = {
            ok: false,
            code: error.code ?? "SOURCE_ERROR",
            reason: error.message,
        };
    }
    const decision = publishDecision(
        state,
        quote,
        config,
        now,
        journal.state.lastSourceBaseline ?? journal.state.lastConfirmedSources,
        oracle.target,
    );
    if (decision.initializeSources) journal.sourceBaseline(decision.sources);
    journal.decision({
        ...decision,
        round: state.round,
        answerCount: state.answerCount,
        sourceDigest: quote.sourceDigest ?? null,
    });
    if (!decision.publish) {
        let statusEvidence = null;
        let statusEvidenceError = null;
        try {
            statusEvidence = await publishStatusIfDue({
                config,
                identity,
                journal,
                submitEvidenceFn,
                state,
                quote,
                decision,
                oracleAddress: oracle.target,
                readDeploymentFn,
                now,
            });
        } catch (error) {
            statusEvidenceError = {
                code: error.code ?? "STATUS_EVIDENCE_FAILED",
                message: error.message,
            };
        }
        return {
            ok: statusEvidenceError === null,
            action: "withhold",
            decision,
            state,
            quote,
            statusEvidence,
            statusEvidenceError,
            schedulerArm,
        };
    }

    const data = oracle.interface.encodeFunctionData("submit", [
        state.round,
        decision.price,
        decision.rate,
    ]);
    await assertCurrentDeployment(oracle.target, readDeploymentFn);
    await preflight(provider, identity.address, {to: oracle.target, data});
    const prepared = await prepareTransaction({
        wallet: identity.wallet,
        provider,
        chainId: config.chainId,
        to: oracle.target,
        data,
        purpose: "oracle-submit",
        gasLimit: SUBMIT_GAS_LIMIT,
    });
    const expiresAt = now + Number(config.evidence?.maximumBroadcastDelaySeconds ?? 600);
    const algorithmVersion = String(
        quote.algorithmVersion ?? config.evidence?.algorithmVersion ??
            DEFAULT_ALGORITHM_VERSION,
    );
    const configurationDigest = quote.configurationDigest;
    const message = encodeEvidence({
        chain: config.chainId,
        oracle: oracle.target,
        publisher: identity.address,
        round: state.round,
        tx: prepared.txHash,
        price: decision.price,
        rate: decision.rate,
        observedAt: quote.observedAt ?? now,
        expiresAt,
        algorithmVersion,
        configurationDigest,
        source: quote.sourceDigest,
        mode: quote.mode,
        trigger: decision.code,
        sources: evidenceSources(quote, algorithmVersion),
        quality: evidenceQuality(quote),
        hbarNetwork: quote.terms.usdPerHbar8,
        hbarMarket: quote.marketRate?.usdPerHbar8 ?? null,
        previous: journal.state.lastEvidenceHash,
    });
    const messageHash = evidenceHash(message);
    journal.prepared({
        ...prepared,
        chainId: Number(config.chainId),
        oracle: oracle.target,
        publisher: identity.address,
        topicId: identity.topicId,
        round: state.round.toString(),
        cleanPriceUsd8: decision.price.toString(),
        referenceRateBps: decision.rate.toString(),
        sourceDigest: quote.sourceDigest,
        observedAt: quote.observedAt ?? now,
        expiresAt,
        evidenceMessage: message,
        evidenceHash: messageHash,
        confirmedSources: decision.sources,
    });
    const currentTime = operationClock(now, clock);
    await assertCurrentDeployment(oracle.target, readDeploymentFn);
    journal.evidenceAttempted(currentTime());
    const evidenceReceipt = await submitEvidenceFn({
        chainId: config.chainId,
        accountId: identity.accountId,
        privateKey: identity.wallet.privateKey.replace(/^0x/, ""),
        topicId: identity.topicId,
        message,
        onTransactionId: async (transactionId) => {
            if (transactionId) journal.evidenceTransactionId(transactionId);
        },
    });
    journal.evidenced(evidenceReceipt, messageHash);
    if (currentTime() > expiresAt) {
        journal.abandon("EVIDENCE_EXPIRED", "HCS receipt arrived after answer expiry");
        return {ok: false, action: "expired", evidenceReceipt};
    }
    await assertCurrentDeployment(oracle.target, readDeploymentFn);
    if (currentTime() > expiresAt) {
        journal.abandon("EVIDENCE_EXPIRED", "answer expired before broadcast");
        return {ok: false, action: "expired", evidenceReceipt};
    }
    journal.broadcast();
    await assertCurrentDeployment(oracle.target, readDeploymentFn);
    if (currentTime() > expiresAt) {
        journal.abandon("EVIDENCE_EXPIRED", "answer expired immediately before broadcast");
        return {ok: false, action: "expired", evidenceReceipt};
    }
    let receipt;
    try {
        receipt = await broadcastPrepared(provider, prepared, config.transactions);
    } catch (error) {
        if (error.code === "REVERTED") {
            journal.failed(error.code, error.message, {terminal: true});
            return {ok: false, action: "transaction-failed", code: error.code};
        }
        throw error;
    }
    journal.confirmed(receipt);
    schedulerArm = await armSchedulerIfNeeded({
        scheduler,
        identity,
        journal,
        provider,
        config,
        round: state.round,
        answerCount: state.answerCount + 1,
        now,
    }).catch((error) => ({armed: false, code: error.code, message: error.message}));
    return {
        ok: true,
        action: "submitted",
        round: state.round,
        txHash: prepared.txHash,
        evidence: evidenceReceipt,
        receipt,
        schedulerArm,
    };
}

async function main() {
    const args = process.argv.slice(2);
    const value = (flag, fallback = null) => {
        const index = args.indexOf(flag);
        return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
    };
    const config = loadOracleConfig(value("--config") ?? undefined, {
        allowExample: args.includes("--dry-run"),
    });
    if (args.includes("--dry-run")) {
        const quote = await buildHybridQuote(config);
        output("dry-run", {quote});
        process.exitCode = quote.ok ? 0 : 2;
        return;
    }

    const identity = loadPublisherIdentity(config);
    const deployment = readDeployment().client;
    const provider = new JsonRpcProvider(
        config.rpcUrl ?? deployment.network.rpc,
        config.chainId,
        {staticNetwork: true, batchMaxCount: 20},
    );
    const code = await provider.getCode(deployment.addresses.PrimeOracle);
    if (code === "0x") throw new Error("PrimeOracle has no deployed bytecode");
    const oracle = new Contract(
        deployment.addresses.PrimeOracle,
        JSON.parse((await import("node:fs")).readFileSync(
            new URL("../deployments/abi/PrimeOracle.json", import.meta.url),
            "utf8",
        )),
        provider,
    );
    const schedulerRecordPath = new URL("../deployments/oracle-scheduler.json", import.meta.url);
    const readSchedulerRecord = () => existsSync(schedulerRecordPath)
        ? JSON.parse(readFileSync(schedulerRecordPath, "utf8"))
        : null;
    const schedulerRecord = readSchedulerRecord();
    if (schedulerRecord?.oracle) {
        assertSchedulerOracle(
            deployment.addresses.PrimeOracle,
            schedulerRecord.oracle,
            "scheduler deployment record",
        );
    }
    const schedulerAddress = schedulerRecord?.address ?? config.scheduler?.address ?? null;
    const scheduler = schedulerAddress
        ? new Contract(schedulerAddress, [
            "function arm() returns (bool)",
            "function oracle() view returns (address)",
            "function activeSchedule() view returns (address)",
            "function nextCheckAt() view returns (uint64)",
            "function SCHEDULE_LATE_GRACE() view returns (uint64)",
            "function MIN_BALANCE_TINYBAR() view returns (uint256)",
            "function trackedRound() view returns (uint64)",
            "function retryStreak() view returns (uint8)",
            "function checksThisRound() view returns (uint8)",
            "function lastAnswerCount() view returns (uint256)",
            "function MAX_RETRY_STREAK() view returns (uint8)",
            "function MAX_CHECKS_PER_ROUND() view returns (uint8)",
            "function lastFinalizedRound() view returns (uint64)",
        ], provider)
        : null;
    if (scheduler) {
        assertSchedulerOracle(
            deployment.addresses.PrimeOracle,
            await scheduler.oracle(),
            "onchain scheduler",
        );
    }
    const journal = PublisherJournal.open(
        identity.stateRoot,
        identity.profile,
        identity.address,
    );
    const once = args.includes("--once") || args.includes("--one-shot");
    const intervalMs = Math.max(5, Number(value("--interval", config.pollSeconds ?? 15))) * 1000;

    const shutdown = attachPublisherShutdown();
    const healthServer = startPublisherHealthServer({config, identity});
    do {
        try {
            const currentDeployment = readDeployment().client;
            const currentSchedulerRecord = readSchedulerRecord();
            assertRuntimeAddress(
                "PrimeOracle",
                oracle.target,
                currentDeployment.addresses.PrimeOracle,
            );
            assertRuntimeAddress(
                "OracleScheduler",
                scheduler?.target ?? null,
                currentSchedulerRecord?.address ?? config.scheduler?.address ?? null,
            );
            if (currentSchedulerRecord?.oracle) {
                assertSchedulerOracle(
                    currentDeployment.addresses.PrimeOracle,
                    currentSchedulerRecord.oracle,
                    "current scheduler deployment record",
                );
            }
            const result = await runPublisherPass({
                config,
                identity,
                journal,
                provider,
                oracle,
                scheduler,
            });
            output("pass", {
                profile: identity.profile,
                address: identity.address,
                action: result.action,
                round: result.round ?? result.state?.round ?? null,
                code: result.decision?.code ?? null,
                txHash: result.txHash ?? null,
            });
        } catch (error) {
            journal.failed(error.code ?? "PASS_FAILED", error.message);
            output("error", {
                profile: identity.profile,
                code: error.code ?? "PASS_FAILED",
                message: error.message,
            });
            if (error.code === "DEPLOYMENT_CHANGED" ||
                error.code === "SCHEDULER_TARGET_MISMATCH") {
                process.exitCode = 1;
                break;
            }
        }
        if (!once && !shutdown.isStopping()) {
            await shutdown.wait(intervalMs);
        }
    } while (!once && !shutdown.isStopping());
    await new Promise((resolve) => healthServer.close(resolve));
    provider.destroy();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
