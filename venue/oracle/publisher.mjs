import {Contract, JsonRpcProvider, ZeroAddress} from "ethers";
import {existsSync, readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {loadOracleConfig, loadPublisherIdentity} from "./lib/config.mjs";
import {
    encodeEvidence,
    encodeStatusEvidence,
    evidenceHash,
    submitEvidence,
} from "./lib/evidence.mjs";
import {deviationBps, uint} from "./lib/fixed.mjs";
import {PublisherJournal} from "./lib/journal.mjs";
import {buildHybridQuote} from "./lib/quote-engine.mjs";
import {readDeployment} from "./lib/terms-source.mjs";
import {
    broadcastPrepared,
    preflight,
    prepareTransaction,
    recoverPrepared,
} from "./lib/transactions.mjs";

const SUBMIT_GAS_LIMIT = 500_000n;
const SCHEDULER_ARM_GAS_LIMIT = 3_000_000n;

function json(value) {
    return JSON.stringify(value, (_, child) =>
        typeof child === "bigint" ? child.toString() : child);
}

function output(type, fields = {}) {
    console.log(json({at: new Date().toISOString(), type, ...fields}));
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
    submitEvidenceFn,
    now,
}) {
    const pending = journal.state.pending;
    if (!pending) return null;
    if (pending.status === "FAILED") {
        journal.clearFailed();
        return {recovered: false, cleared: true};
    }
    if (now > Number(pending.expiresAt) && pending.status !== "BROADCAST") {
        journal.abandon("EVIDENCE_EXPIRED", "prepared answer expired before broadcast");
        return {recovered: false, expired: true};
    }
    if (pending.status === "PREPARED") {
        const evidenceReceipt = await submitEvidenceFn({
            chainId: config.chainId,
            accountId: identity.accountId,
            privateKey: identity.wallet.privateKey.replace(/^0x/, ""),
            topicId: identity.topicId,
            message: pending.evidenceMessage,
        });
        journal.evidenced(evidenceReceipt, evidenceHash(pending.evidenceMessage));
    }
    if (journal.state.pending?.status === "EVIDENCED") {
        journal.broadcast();
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
    if (journal.state.pending?.status === "BROADCAST") {
        let receipt;
        try {
            receipt = await recoverPrepared(
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

async function armSchedulerIfNeeded({
    scheduler,
    identity,
    journal,
    provider,
    config,
    round,
}) {
    if (!scheduler) return {configured: false, armed: false};
    const now = Math.floor(Date.now() / 1000);
    const active = await scheduler.activeSchedule();
    const nextCheckAt = Number(await scheduler.nextCheckAt());
    const lateGrace = Number(await scheduler.SCHEDULE_LATE_GRACE());
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
        round: String(round),
        status: "PREPARED",
        txHash: prepared.txHash,
    });
    const receipt = await broadcastPrepared(provider, prepared, config.transactions);
    const scheduleAddress = String(await scheduler.activeSchedule());
    const armed = scheduleAddress.toLowerCase() !== ZeroAddress.toLowerCase();
    journal.schedulerArm({
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

function publishDecision(state, quote, config, now) {
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
    const keepalive = Number(config.keepaliveSeconds ?? Math.floor(state.heartbeat * 2 / 3));
    const keepaliveDue = state.publishedAt === 0 || now >= state.publishedAt + keepalive;
    const feedStale = state.publishedAt === 0 || now > state.publishedAt + state.heartbeat;
    const moveDue = moved !== null && moved >= uint(config.publishMoveBps ?? 25, "publishMoveBps");
    const joinOpenRound = state.answerCount > 0;
    if (!keepaliveDue && !moveDue && !joinOpenRound) {
        return {
            publish: false,
            code: "NOT_DUE",
            reason: "keepalive and movement thresholds are not due",
            movedBps: moved,
            nextKeepaliveAt: state.publishedAt + keepalive,
        };
    }
    return {
        publish: true,
        code: feedStale ? "RECOVER_STALE" : joinOpenRound ? "JOIN_ROUND" : moveDue ? "PRICE_MOVE" : "KEEPALIVE",
        reason: "validated source quorum permits publication",
        movedBps: moved,
        price,
        rate,
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
        oracle: quote.terms?.oracle ?? oracleAddress,
        publisher: identity.address,
        round: state.round,
        observedAt: now,
        code: decision.code,
        source: quote.sourceDigest ?? null,
        exactPrints: quote.quality?.exactPrints ?? quote.prints?.accepted?.length ?? 0,
        rejectedPrints: quote.quality?.rejectedPrints ?? quote.prints?.rejected?.length ?? 0,
        dealerQuotes: quote.quality?.dealerQuotes ?? quote.dealers?.accepted?.length ?? 0,
        answerCount: state.answerCount,
        hbarNetwork: quote.terms?.usdPerHbar8 ?? null,
        hbarMarket: quote.marketRate?.usdPerHbar8 ?? null,
        hbarDivergenceBps: quote.hbarDivergenceBps ?? null,
        previous: journal.state.lastEvidenceHash,
    });
    const receipt = await submitEvidenceFn({
        chainId: config.chainId,
        accountId: identity.accountId,
        privateKey: identity.wallet.privateKey.replace(/^0x/, ""),
        topicId: identity.topicId,
        message,
    });
    const hash = evidenceHash(message);
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
    now = Math.floor(Date.now() / 1000),
}) {
    const recovered = await recoverPending({
        config,
        identity,
        journal,
        provider,
        submitEvidenceFn,
        now,
    });
    if (recovered) {
        let schedulerArm = null;
        if (recovered.recovered) {
            schedulerArm = await armSchedulerIfNeeded({
                scheduler,
                identity,
                journal,
                provider,
                config,
                round: journal.state.lastConfirmedRound,
            }).catch((error) => ({armed: false, code: error.code, message: error.message}));
        }
        return {ok: true, action: "recovery", schedulerArm, ...recovered};
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
    const decision = publishDecision(state, quote, config, now);
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
                now,
            });
        } catch (error) {
            statusEvidenceError = {
                code: error.code ?? "STATUS_EVIDENCE_FAILED",
                message: error.message,
            };
        }
        return {
            ok: true,
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
        source: quote.sourceDigest,
        mode: quote.mode,
        exactPrints: quote.quality?.exactPrints ?? 0,
        dealerQuotes: quote.quality?.dealerQuotes ?? 0,
        hbarNetwork: quote.terms.usdPerHbar8,
        hbarMarket: quote.marketRate?.usdPerHbar8 ?? null,
        previous: journal.state.lastEvidenceHash,
    });
    journal.prepared({
        ...prepared,
        round: state.round.toString(),
        cleanPriceUsd8: decision.price.toString(),
        referenceRateBps: decision.rate.toString(),
        sourceDigest: quote.sourceDigest,
        observedAt: quote.observedAt ?? now,
        expiresAt,
        evidenceMessage: message,
    });
    const evidenceReceipt = await submitEvidenceFn({
        chainId: config.chainId,
        accountId: identity.accountId,
        privateKey: identity.wallet.privateKey.replace(/^0x/, ""),
        topicId: identity.topicId,
        message,
    });
    if (Math.floor(Date.now() / 1000) > expiresAt) {
        journal.abandon("EVIDENCE_EXPIRED", "HCS receipt arrived after answer expiry");
        return {ok: false, action: "expired", evidenceReceipt};
    }
    journal.evidenced(evidenceReceipt, evidenceHash(message));
    journal.broadcast();
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
    const schedulerAddress = config.scheduler?.address ??
        (existsSync(schedulerRecordPath)
            ? JSON.parse(readFileSync(schedulerRecordPath, "utf8")).address
            : null);
    const scheduler = schedulerAddress
        ? new Contract(schedulerAddress, [
            "function arm() returns (bool)",
            "function activeSchedule() view returns (address)",
            "function nextCheckAt() view returns (uint64)",
            "function SCHEDULE_LATE_GRACE() view returns (uint64)",
            "function MIN_BALANCE_TINYBAR() view returns (uint256)",
        ], provider)
        : null;
    const journal = PublisherJournal.open(
        identity.stateRoot,
        identity.profile,
        identity.address,
    );
    const once = args.includes("--once") || args.includes("--one-shot");
    const intervalMs = Math.max(5, Number(value("--interval", config.pollSeconds ?? 15))) * 1000;

    let stopping = false;
    process.on("SIGINT", () => { stopping = true; });
    process.on("SIGTERM", () => { stopping = true; });
    do {
        try {
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
        }
        if (!once && !stopping) {
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    } while (!once && !stopping);
    provider.destroy();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
