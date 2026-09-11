import {
    QUICKNET_CHAIN_HASH,
    TIMED_TICKET_CHAIN_ID,
    TimedTicketError,
    assertSafeTargetRound,
    decryptTimedTicketEnvelope,
    parseTimedTicketEnvelope,
    roundTime,
} from "../../tools/timed-ticket.mjs";
import {TIMED_TICKET_STATES} from "./timed-ticket-store.mjs";

const HEX_32 = /^0x[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HANDLE = /^[A-Za-z0-9_-]{16,128}$/;

export class TimedTicketServiceError extends TimedTicketError {
    constructor(code, message) {
        super(code, message);
        this.name = "TimedTicketServiceError";
    }
}

function fail(code, message) {
    throw new TimedTicketServiceError(code, message);
}

function decimal(value, code = "CHAIN_OBSERVATION_INVALID") {
    if (
        (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
        && typeof value !== "bigint"
        && !(typeof value === "number" && Number.isSafeInteger(value))
    ) {
        fail(code, "timed ticket adapter returned invalid public data");
    }
    try {
        const result = BigInt(value);
        if (result < 0n || result >= 1n << 64n) throw new Error();
        return result;
    } catch {
        fail(code, "timed ticket adapter returned invalid public data");
    }
}

function commitment(value) {
    if (typeof value !== "string" || !HEX_32.test(value)) {
        fail("CHAIN_OBSERVATION_INVALID", "timed ticket adapter returned invalid public data");
    }
    return value;
}

function placement(value) {
    if (
        value?.status === "ABSENT"
        && Object.keys(value).sort().join(",") === "status"
    ) {
        return {status: "ABSENT"};
    }
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || value.status !== "PLACED"
    ) {
        fail("CHAIN_OBSERVATION_INVALID", "timed ticket adapter returned invalid public data");
    }
    return {
        status: "PLACED",
        commitment: commitment(value.commitment),
        commitTime: decimal(value.commitTime),
        revealDelay: decimal(value.revealDelay),
        revealWindow: decimal(value.revealWindow),
    };
}

function chainState(value) {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || !["REVEALABLE", "REVEALED", "CANCELLED", "ABSENT"].includes(value.status)
    ) {
        fail("CHAIN_OBSERVATION_INVALID", "timed ticket adapter returned invalid public data");
    }
    if (
        ["REVEALABLE", "REVEALED"].includes(value.status)
        && commitment(value.commitment) === ""
    ) {
        fail("CHAIN_OBSERVATION_INVALID", "timed ticket adapter returned invalid public data");
    }
    return {
        status: value.status,
        commitment: value.commitment === undefined ? null : commitment(value.commitment),
        transactionHash: value.transactionHash === undefined
            ? null
            : commitment(value.transactionHash),
    };
}

function prepared(value) {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || !HANDLE.test(value.handle ?? "")
        || !DIGEST.test(value.byteDigest ?? "")
    ) {
        fail("REVEAL_PREPARATION_INVALID", "reveal adapter did not return a durable exact-byte handle");
    }
    return {handle: value.handle, byteDigest: value.byteDigest};
}

function broadcast(value) {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || !["CONFIRMED", "UNKNOWN", "PENDING", "ABSENT", "REJECTED"].includes(value.status)
    ) {
        fail("BROADCAST_RESULT_INVALID", "reveal adapter returned an invalid public result");
    }
    const transactionHash = value.transactionHash === undefined || value.transactionHash === null
        ? null
        : commitment(value.transactionHash);
    return {status: value.status, transactionHash};
}

function adapterMethod(adapter, name, code) {
    if (adapter === null || typeof adapter !== "object" || typeof adapter[name] !== "function") {
        fail(code, "timed ticket adapter is incomplete");
    }
}

function safeErrorCode(error, fallback) {
    return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
        ? error.code
        : fallback;
}

function adapterFailure(error, fallback) {
    fail(safeErrorCode(error, fallback), "timed ticket adapter operation failed");
}

function timingFromMetadata(metadata) {
    if (!metadata.timing) fail("TIMING_MISSING", "placed timed ticket has no verified timing");
    return {
        commitTime: BigInt(metadata.timing.commitTime),
        revealDelay: BigInt(metadata.timing.revealDelay),
        revealWindow: BigInt(metadata.timing.revealWindow),
        earliest: BigInt(metadata.timing.earliest),
        latest: BigInt(metadata.timing.latest),
    };
}

function closeTime(timing) {
    return timing.commitTime + timing.revealDelay + timing.revealWindow;
}

function wipeSecret(secret) {
    secret?.randomSalt?.fill?.(0);
    secret?.revealSalt?.fill?.(0);
}

function recoveryOutput(secret, summary) {
    const randomSalt = `0x${[...secret.randomSalt]
        .map((item) => item.toString(16).padStart(2, "0"))
        .join("")}`;
    return Object.freeze({
        ticketId: summary.ticketId,
        engineCommitment: summary.engineCommitment,
        side: secret.side,
        price: secret.price.toString(),
        quantity: secret.quantity.toString(),
        randomSalt,
    });
}

export class TimedTicketCustodyService {
    constructor({
        store,
        lockedKeyProvider,
        chainAdapter,
        revealAdapter,
        nowSeconds = () => BigInt(Math.floor(Date.now() / 1000)),
        transitionHook = async () => {},
        crypto,
        allowInsecureTestProvider = false,
    }) {
        adapterMethod(store, "stage", "STORE_INVALID");
        adapterMethod(store, "read", "STORE_INVALID");
        adapterMethod(store, "list", "STORE_INVALID");
        adapterMethod(store, "transition", "STORE_INVALID");
        adapterMethod(store, "finalizeTerminal", "STORE_INVALID");
        adapterMethod(store, "cancel", "STORE_INVALID");
        adapterMethod(store, "purgeExpired", "STORE_INVALID");
        adapterMethod(store, "workerAccess", "STORE_INVALID");
        adapterMethod(chainAdapter, "observePlacement", "CHAIN_ADAPTER_INVALID");
        adapterMethod(chainAdapter, "recheckBeforeReveal", "CHAIN_ADAPTER_INVALID");
        adapterMethod(revealAdapter, "prepareReveal", "REVEAL_ADAPTER_INVALID");
        adapterMethod(revealAdapter, "broadcastPrepared", "REVEAL_ADAPTER_INVALID");
        adapterMethod(revealAdapter, "reconcilePrepared", "REVEAL_ADAPTER_INVALID");
        if (
            typeof lockedKeyProvider?.verifyTarget !== "function"
            || typeof nowSeconds !== "function"
            || typeof transitionHook !== "function"
        ) {
            fail("SERVICE_CONFIG_INVALID", "timed ticket service configuration is invalid");
        }
        this.store = store;
        this.workerStore = store.workerAccess();
        adapterMethod(this.workerStore, "read", "STORE_INVALID");
        adapterMethod(this.workerStore, "list", "STORE_INVALID");
        adapterMethod(this.workerStore, "transition", "STORE_INVALID");
        adapterMethod(this.workerStore, "finalizeTerminal", "STORE_INVALID");
        adapterMethod(this.workerStore, "cancel", "STORE_INVALID");
        this.lockedKeyProvider = lockedKeyProvider;
        this.chainAdapter = chainAdapter;
        this.revealAdapter = revealAdapter;
        this.nowSeconds = nowSeconds;
        this.transitionHook = transitionHook;
        this.crypto = crypto;
        this.allowInsecureTestProvider = allowInsecureTestProvider;
        this.queues = new Map();
    }

    async prearm(envelope, {capability} = {}) {
        return this.store.stage(envelope, {capability});
    }

    async readback(ticketId, capability) {
        const stored = await this.store.read(ticketId, capability, {includeEnvelope: true});
        if (!stored.envelope) {
            fail("PAYLOAD_PURGED", "timed ticket payload is unavailable");
        }
        try {
            await parseTimedTicketEnvelope(stored.envelope, {
                crypto: this.crypto,
                expected: {
                    chainId: stored.summary.chainId,
                    chainHash: QUICKNET_CHAIN_HASH,
                    engine: stored.summary.engine,
                    sessionAccount: stored.summary.sessionAccount,
                    envelopeId: stored.summary.envelopeId,
                    engineCommitment: stored.summary.engineCommitment,
                    targetRound: stored.summary.targetRound,
                },
            });
            return {
                summary: stored.summary,
                envelope: Buffer.from(stored.envelope),
            };
        } finally {
            stored.envelope.fill(0);
        }
    }

    async summary(ticketId, capability) {
        return (await this.store.read(ticketId, capability, {includeEnvelope: false})).summary;
    }

    async run(ticketId, capability) {
        return this.#serialize(ticketId, () => this.#run(ticketId, capability));
    }

    async runPending() {
        const summaries = await this.workerStore.list();
        const results = [];
        for (const summary of summaries) {
            if (
                ["REVEALED", "CANCELLED", "MISSED"].includes(summary.state)
                && !summary.payloadPresent
            ) {
                continue;
            }
            try {
                results.push({
                    ticketId: summary.ticketId,
                    status: "OK",
                    summary: await this.run(summary.ticketId),
                });
            } catch (error) {
                results.push({
                    ticketId: summary.ticketId,
                    status: "ERROR",
                    code: safeErrorCode(error, "WORKER_FAILED"),
                });
            }
        }
        return Object.freeze(results.map((result) => Object.freeze(result)));
    }

    async cancel(ticketId, capability) {
        return this.#serialize(ticketId, async () => {
            const stored = await this.store.read(ticketId, capability, {
                includeEnvelope: false,
            });
            if (stored.metadata.state === "CANCELLED") {
                const cancelled = await this.store.cancel(ticketId, capability);
                return Object.freeze({...cancelled, chainCancellation: "ALREADY_CANCELLED"});
            }
            let chainCancellation = "NOT_REQUIRED";
            let committed = stored.metadata.state !== "PREARMED";
            if (!committed) {
                let observed;
                try {
                    observed = placement(await this.chainAdapter.observePlacement(
                        this.#chainRequest(stored.summary),
                    ));
                } catch (error) {
                    adapterFailure(error, "CANCELLATION_PREFLIGHT_FAILED");
                }
                if (observed.status === "PLACED") {
                    if (observed.commitment !== stored.metadata.engineCommitment) {
                        fail("COMMITMENT_MISMATCH", "chain state does not match timed ticket");
                    }
                    committed = true;
                }
            }
            if (committed) {
                if (typeof this.chainAdapter.cancel !== "function") {
                    fail("CHAIN_CANCELLATION_REQUIRED", "placed timed ticket requires chain cancellation");
                }
                let result;
                try {
                    result = await this.chainAdapter.cancel(this.#chainRequest(stored.summary));
                } catch (error) {
                    adapterFailure(error, "CHAIN_CANCELLATION_FAILED");
                }
                if (result?.status !== "CONFIRMED") {
                    fail("CHAIN_CANCELLATION_UNCONFIRMED", "chain cancellation is not confirmed");
                }
                chainCancellation = "CONFIRMED";
            }
            const cancelled = await this.store.cancel(ticketId, capability);
            return Object.freeze({...cancelled, chainCancellation});
        });
    }

    async manualRecovery(ticketId, capability) {
        return this.#serialize(ticketId, async () => {
            const stored = await this.store.read(ticketId, capability);
            if (
                stored.metadata.state === "CANCELLED"
                || stored.metadata.state === "MISSED"
                || !stored.envelope
            ) {
                fail("RECOVERY_REFUSED", "timed ticket is not available for manual recovery");
            }
            const now = this.#now();
            if (now < roundTime(stored.metadata.targetRound)) {
                fail("EARLY_DECRYPT_REFUSED", "target Quicknet beacon is not due");
            }
            const verified = await this.lockedKeyProvider.verifyTarget(
                BigInt(stored.metadata.targetRound),
            );
            let secret;
            try {
                secret = await decryptTimedTicketEnvelope(stored.envelope, {
                    lockedKeyProvider: this.lockedKeyProvider,
                    verifiedBeacon: verified,
                    crypto: this.crypto,
                    expected: this.#expected(stored.metadata),
                    allowInsecureTestProvider: this.allowInsecureTestProvider,
                });
                await this.#verifySessionContext(
                    ticketId,
                    stored.summary,
                    secret,
                );
                const observed = chainState(await this.chainAdapter.recheckBeforeReveal(
                    this.#chainRequest(stored.summary),
                ));
                if (
                    !["REVEALABLE", "REVEALED"].includes(observed.status)
                    || observed.commitment !== stored.metadata.engineCommitment
                ) {
                    fail("RECOVERY_REFUSED", "chain state does not permit manual recovery");
                }
                return recoveryOutput(secret, stored.summary);
            } finally {
                wipeSecret(secret);
                stored.envelope.fill(0);
            }
        });
    }

    async purgeExpired() {
        return this.store.purgeExpired();
    }

    async #run(ticketId, capability) {
        let verifiedBeacon;
        for (let step = 0; step < 8; step += 1) {
            const stored = await this.#readForRun(ticketId, capability, {
                includeEnvelope: true,
            });
            const {metadata, summary, envelope} = stored;
            if (!TIMED_TICKET_STATES.includes(metadata.state)) {
                if (envelope) envelope.fill(0);
                fail("STATE_INVALID", "timed ticket state is invalid");
            }
            try {
                if (["REVEALED", "CANCELLED", "MISSED"].includes(metadata.state)) {
                    if (metadata.payloadPresent) {
                        return this.#finalizeForRun(ticketId, capability);
                    }
                    return summary;
                }
                if (metadata.state === "PREARMED") {
                    const observed = placement(await this.chainAdapter.observePlacement(
                        this.#chainRequest(summary),
                    ));
                    if (observed.status === "ABSENT") return summary;
                    if (observed.commitment !== metadata.engineCommitment) {
                        fail("COMMITMENT_MISMATCH", "observed engine commitment does not match ticket");
                    }
                    const safe = assertSafeTargetRound(metadata.targetRound, observed);
                    const placed = await this.#transition(ticketId, capability, {
                        from: "PREARMED",
                        to: "PLACED",
                        patch: {
                            timing: {
                                commitTime: observed.commitTime.toString(),
                                revealDelay: observed.revealDelay.toString(),
                                revealWindow: observed.revealWindow.toString(),
                                earliest: safe.earliest.toString(),
                                latest: safe.latest.toString(),
                            },
                        },
                    });
                    await this.transitionHook("PLACED", placed);
                    continue;
                }
                if (metadata.state === "PLACED") {
                    const waiting = await this.#transition(ticketId, capability, {
                        from: "PLACED",
                        to: "WAITING_BEACON",
                    });
                    await this.transitionHook("WAITING_BEACON", waiting);
                    continue;
                }
                if (metadata.state === "WAITING_BEACON") {
                    const timing = timingFromMetadata(metadata);
                    const now = this.#now();
                    if (now > closeTime(timing)) {
                        return this.#markMissed(ticketId, capability, "WAITING_BEACON");
                    }
                    if (now < BigInt(metadata.targetTime)) return summary;
                    verifiedBeacon = await this.lockedKeyProvider.verifyTarget(
                        BigInt(metadata.targetRound),
                    );
                    const decrypting = await this.#transition(ticketId, capability, {
                        from: "WAITING_BEACON",
                        to: "DECRYPTING",
                    });
                    await this.transitionHook("DECRYPTING", decrypting);
                    continue;
                }
                if (metadata.state === "DECRYPTING") {
                    if (!envelope) fail("PAYLOAD_PURGED", "timed ticket payload is unavailable");
                    if (this.#now() > closeTime(timingFromMetadata(metadata))) {
                        return this.#markMissed(ticketId, capability, "DECRYPTING");
                    }
                    if (!verifiedBeacon) {
                        if (this.#now() < BigInt(metadata.targetTime)) {
                            fail("EARLY_DECRYPT_REFUSED", "target Quicknet beacon is not due");
                        }
                        verifiedBeacon = await this.lockedKeyProvider.verifyTarget(
                            BigInt(metadata.targetRound),
                        );
                    }
                    let secret;
                    try {
                        secret = await decryptTimedTicketEnvelope(envelope, {
                            lockedKeyProvider: this.lockedKeyProvider,
                            verifiedBeacon,
                            crypto: this.crypto,
                            expected: this.#expected(metadata),
                            allowInsecureTestProvider: this.allowInsecureTestProvider,
                        });
                        await this.#verifySessionContext(ticketId, summary, secret);
                        const observed = chainState(await this.chainAdapter.recheckBeforeReveal(
                            this.#chainRequest(summary),
                        ));
                        const terminal = await this.#terminalFromObservation(
                            ticketId,
                            capability,
                            metadata,
                            observed,
                        );
                        if (terminal) return terminal;
                        let preparedResult;
                        try {
                            preparedResult = await this.revealAdapter.prepareReveal({
                                ...this.#chainRequest(summary),
                                ticketId,
                                side: secret.side,
                                price: secret.price.toString(),
                                quantity: secret.quantity.toString(),
                                randomSalt: `0x${[...secret.randomSalt]
                                    .map((item) => item.toString(16).padStart(2, "0"))
                                    .join("")}`,
                                generation: secret.generation.toString(),
                                feePolicyDigest: secret.feePolicyDigest,
                            });
                        } catch (error) {
                            adapterFailure(error, "REVEAL_PREPARATION_FAILED");
                        }
                        const exact = prepared(preparedResult);
                        const revealing = await this.#transition(ticketId, capability, {
                            from: "DECRYPTING",
                            to: "REVEALING",
                            patch: {prepared: exact},
                        });
                        await this.transitionHook("REVEALING", revealing);
                    } finally {
                        wipeSecret(secret);
                    }
                    continue;
                }
                if (metadata.state === "REVEALING") {
                    return this.#broadcast(ticketId, capability, metadata, summary, false);
                }
                if (metadata.state === "BROADCAST_UNKNOWN") {
                    return this.#broadcast(ticketId, capability, metadata, summary, true);
                }
            } finally {
                if (envelope) envelope.fill(0);
            }
        }
        fail("STEP_LIMIT", "timed ticket worker exceeded its transition limit");
    }

    async #broadcast(ticketId, capability, metadata, summary, reconcileFirst) {
        if (!metadata.prepared) {
            fail("PREPARED_REVEAL_MISSING", "durable exact-byte reveal handle is missing");
        }
        if (reconcileFirst) {
            let reconcileResult;
            try {
                reconcileResult = await this.revealAdapter.reconcilePrepared({
                    ticketId,
                    ...metadata.prepared,
                });
            } catch (error) {
                adapterFailure(error, "RECONCILIATION_FAILED");
            }
            const reconciled = broadcast(reconcileResult);
            if (reconciled.status === "CONFIRMED") {
                return this.#markRevealed(ticketId, capability, metadata.state, reconciled);
            }
            if (["UNKNOWN", "PENDING"].includes(reconciled.status)) return summary;
            if (reconciled.status === "REJECTED") {
                fail("BROADCAST_REJECTED", "prepared reveal was rejected");
            }
        }
        const timing = timingFromMetadata(metadata);
        if (this.#now() > closeTime(timing)) {
            return this.#markMissed(ticketId, capability, metadata.state);
        }
        const observed = chainState(await this.chainAdapter.recheckBeforeReveal(
            this.#chainRequest(summary),
        ));
        const terminal = await this.#terminalFromObservation(
            ticketId,
            capability,
            metadata,
            observed,
        );
        if (terminal) return terminal;
        let result;
        try {
            result = broadcast(await this.revealAdapter.broadcastPrepared({
                ticketId,
                ...metadata.prepared,
            }));
        } catch (error) {
            if (error?.code === "BROADCAST_UNKNOWN") {
                result = {status: "UNKNOWN", transactionHash: null};
            } else {
                adapterFailure(error, "BROADCAST_FAILED");
            }
        }
        if (result.status === "CONFIRMED") {
            return this.#markRevealed(ticketId, capability, metadata.state, result);
        }
        if (["UNKNOWN", "PENDING"].includes(result.status)) {
            const unknown = await this.#transition(ticketId, capability, {
                from: ["REVEALING", "BROADCAST_UNKNOWN"],
                to: "BROADCAST_UNKNOWN",
                patch: {
                    broadcast: {
                        status: "UNKNOWN",
                        transactionHash: result.transactionHash,
                    },
                },
            });
            await this.transitionHook("BROADCAST_UNKNOWN", unknown);
            return unknown;
        }
        if (result.status === "ABSENT") {
            fail("BROADCAST_NOT_ACCEPTED", "prepared reveal was not accepted");
        }
        fail("BROADCAST_REJECTED", "prepared reveal was rejected");
    }

    async #terminalFromObservation(ticketId, capability, metadata, observed) {
        if (
            ["REVEALABLE", "REVEALED"].includes(observed.status)
            && observed.commitment !== metadata.engineCommitment
        ) {
            fail("COMMITMENT_MISMATCH", "chain state does not match timed ticket commitment");
        }
        if (observed.status === "REVEALED") {
            return this.#markRevealed(ticketId, capability, metadata.state, {
                status: "CONFIRMED",
                transactionHash: observed.transactionHash,
            });
        }
        if (["CANCELLED", "ABSENT"].includes(observed.status)) {
            const cancelled = await this.#cancelForRun(ticketId, capability);
            await this.transitionHook("CANCELLED", cancelled);
            return cancelled;
        }
        const timing = timingFromMetadata(metadata);
        if (this.#now() > closeTime(timing)) {
            return this.#markMissed(ticketId, capability, metadata.state);
        }
        return null;
    }

    async #markRevealed(ticketId, capability, from, result) {
        const revealed = await this.#transition(ticketId, capability, {
            from: [from, "REVEALING", "BROADCAST_UNKNOWN"],
            to: "REVEALED",
            patch: {
                broadcast: {
                    status: "CONFIRMED",
                    transactionHash: result.transactionHash,
                },
            },
        });
        await this.transitionHook("REVEALED", revealed);
        return revealed;
    }

    async #markMissed(ticketId, capability, from) {
        const missed = await this.#transition(ticketId, capability, {
            from,
            to: "MISSED",
        });
        await this.transitionHook("MISSED", missed);
        return missed;
    }

    async #transition(ticketId, capability, request) {
        return capability === undefined
            ? this.workerStore.transition(ticketId, request)
            : this.store.transition(ticketId, capability, request);
    }

    async #readForRun(ticketId, capability, options) {
        return capability === undefined
            ? this.workerStore.read(ticketId, options)
            : this.store.read(ticketId, capability, options);
    }

    async #cancelForRun(ticketId, capability) {
        return capability === undefined
            ? this.workerStore.cancel(ticketId)
            : this.store.cancel(ticketId, capability);
    }

    async #finalizeForRun(ticketId, capability) {
        return capability === undefined
            ? this.workerStore.finalizeTerminal(ticketId)
            : this.store.finalizeTerminal(ticketId, capability);
    }

    async #verifySessionContext(ticketId, summary, secret) {
        if (typeof this.chainAdapter.verifySessionContext !== "function") return;
        try {
            await this.chainAdapter.verifySessionContext({
                ...this.#chainRequest(summary),
                ticketId,
                generation: secret.generation.toString(),
                feePolicyDigest: secret.feePolicyDigest,
            });
        } catch (error) {
            adapterFailure(error, "SESSION_CONTEXT_MISMATCH");
        }
    }

    #expected(metadata) {
        return {
            chainId: TIMED_TICKET_CHAIN_ID,
            chainHash: QUICKNET_CHAIN_HASH,
            engine: metadata.engine,
            sessionAccount: metadata.sessionAccount,
            envelopeId: metadata.envelopeId,
            engineCommitment: metadata.engineCommitment,
            targetRound: BigInt(metadata.targetRound),
        };
    }

    #chainRequest(summary) {
        return Object.freeze({
            chainId: summary.chainId,
            chainHash: QUICKNET_CHAIN_HASH,
            engine: summary.engine,
            sessionAccount: summary.sessionAccount,
            envelopeId: summary.envelopeId,
            envelopeDigest: summary.envelopeDigest,
            engineCommitment: summary.engineCommitment,
            targetRound: summary.targetRound,
        });
    }

    #now() {
        let result;
        try {
            result = BigInt(this.nowSeconds());
        } catch {
            fail("CLOCK_INVALID", "timed ticket worker clock is invalid");
        }
        if (result < 0n || result >= 1n << 64n) {
            fail("CLOCK_INVALID", "timed ticket worker clock is invalid");
        }
        return result;
    }

    #serialize(ticketId, operation) {
        if (typeof ticketId !== "string" || !/^[0-9a-f]{64}$/.test(ticketId)) {
            fail("TICKET_ID_INVALID", "timed ticket identifier is invalid");
        }
        const previous = this.queues.get(ticketId) ?? Promise.resolve();
        const current = previous.then(operation);
        const settled = current.catch(() => {});
        this.queues.set(ticketId, settled);
        settled.finally(() => {
            if (this.queues.get(ticketId) === settled) this.queues.delete(ticketId);
        });
        return current;
    }
}

export class TimedTicketWorker {
    constructor(service) {
        if (!(service instanceof TimedTicketCustodyService)) {
            fail("SERVICE_INVALID", "timed ticket worker requires a custody service");
        }
        this.service = service;
    }

    run(ticketId, capability) {
        return this.service.run(ticketId, capability);
    }

    manualRecovery(ticketId, capability) {
        return this.service.manualRecovery(ticketId, capability);
    }

    runOnce() {
        return this.service.runPending();
    }
}
