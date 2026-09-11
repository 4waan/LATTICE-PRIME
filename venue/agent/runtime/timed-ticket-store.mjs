import {
    createHash,
    randomBytes,
    randomUUID,
    timingSafeEqual,
    webcrypto,
} from "node:crypto";
import {
    chmod,
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    rename,
    rm,
} from "node:fs/promises";
import path from "node:path";

import {
    QUICKNET_CHAIN_HASH,
    TIMED_TICKET_SIZE,
    parseTimedTicketEnvelope,
} from "../../tools/timed-ticket.mjs";

export const TIMED_TICKET_STATES = Object.freeze([
    "PREARMED",
    "PLACED",
    "WAITING_BEACON",
    "DECRYPTING",
    "REVEALING",
    "BROADCAST_UNKNOWN",
    "REVEALED",
    "CANCELLED",
    "MISSED",
    "PURGED",
]);
export const TIMED_TICKET_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;

const STORE_SCHEMA = "hedera2026.timed-ticket-store.v1";
const ID_DOMAIN = Buffer.from("hedera2026.timed-ticket.store-id.v1", "utf8");
const ID_PATTERN = /^[0-9a-f]{64}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const HEX_32_PATTERN = /^0x[0-9a-f]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const TERMINAL = new Set(["REVEALED", "CANCELLED", "MISSED"]);
const WORKER_AUTHORITY = Symbol("timed-ticket-worker-authority");
const TRANSITIONS = Object.freeze({
    PREARMED: new Set(["PLACED", "CANCELLED"]),
    PLACED: new Set(["WAITING_BEACON", "CANCELLED", "MISSED"]),
    WAITING_BEACON: new Set(["DECRYPTING", "CANCELLED", "MISSED"]),
    DECRYPTING: new Set(["REVEALING", "CANCELLED", "MISSED"]),
    REVEALING: new Set(["BROADCAST_UNKNOWN", "REVEALED", "CANCELLED", "MISSED"]),
    BROADCAST_UNKNOWN: new Set(["REVEALED", "CANCELLED", "MISSED"]),
    REVEALED: new Set(),
    CANCELLED: new Set(),
    MISSED: new Set(),
});
const METADATA_KEYS = [
    "broadcast",
    "byteDigest",
    "capabilityHash",
    "chainHash",
    "chainId",
    "createdAtMs",
    "engine",
    "engineCommitment",
    "envelopeDigest",
    "envelopeId",
    "id",
    "payloadPresent",
    "prepared",
    "revision",
    "schemaVersion",
    "sessionAccount",
    "state",
    "targetRound",
    "targetTime",
    "terminalAtMs",
    "timing",
    "updatedAtMs",
].sort().join(",");

export class TimedTicketStoreError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "TimedTicketStoreError";
        this.code = code;
    }
}

function fail(code, message) {
    throw new TimedTicketStoreError(code, message);
}

function sha256(value) {
    return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function constantTextEqual(left, right) {
    const leftBytes = Buffer.from(left, "utf8");
    const rightBytes = Buffer.from(right, "utf8");
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function capabilityBytes(value, {generate = false} = {}) {
    if (value === undefined && generate) return randomBytes(32);
    if (value instanceof Uint8Array && value.byteLength === 32) {
        return Buffer.from(value);
    }
    if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) {
        return Buffer.from(value.slice(2), "hex");
    }
    fail("CAPABILITY_REJECTED", "timed ticket capability was rejected");
}

function ticketId(envelopeId) {
    return createHash("sha256")
        .update(ID_DOMAIN)
        .update(Buffer.from(envelopeId.slice(2), "hex"))
        .digest("hex");
}

function validId(value) {
    if (typeof value !== "string" || !ID_PATTERN.test(value)) {
        fail("TICKET_ID_INVALID", "timed ticket identifier is invalid");
    }
    return value;
}

function decimal(value) {
    return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function validateTiming(value) {
    return value === null || (
        value
        && typeof value === "object"
        && !Array.isArray(value)
        && Object.keys(value).sort().join(",")
            === "commitTime,earliest,latest,revealDelay,revealWindow"
        && decimal(value.commitTime)
        && decimal(value.revealDelay)
        && decimal(value.revealWindow)
        && decimal(value.earliest)
        && decimal(value.latest)
    );
}

function validatePrepared(value) {
    return value === null || (
        value
        && typeof value === "object"
        && !Array.isArray(value)
        && Object.keys(value).sort().join(",") === "byteDigest,handle"
        && HANDLE_PATTERN.test(value.handle)
        && DIGEST_PATTERN.test(value.byteDigest)
    );
}

function validateBroadcast(value) {
    return value === null || (
        value
        && typeof value === "object"
        && !Array.isArray(value)
        && Object.keys(value).sort().join(",") === "status,transactionHash"
        && ["CONFIRMED", "UNKNOWN"].includes(value.status)
        && (
            value.transactionHash === null
            || /^0x[0-9a-f]{64}$/.test(value.transactionHash)
        )
    );
}

function validateMetadata(value, expectedId) {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== METADATA_KEYS
        || value.schemaVersion !== STORE_SCHEMA
        || value.id !== expectedId
        || !ID_PATTERN.test(value.id)
        || !TIMED_TICKET_STATES.slice(0, -1).includes(value.state)
        || !Number.isSafeInteger(value.revision)
        || value.revision < 0
        || !Number.isSafeInteger(value.createdAtMs)
        || !Number.isSafeInteger(value.updatedAtMs)
        || value.createdAtMs < 0
        || value.updatedAtMs < value.createdAtMs
    ) {
        fail("STORE_CORRUPT", "timed ticket metadata is invalid");
    }
    if (
        (value.terminalAtMs !== null
            && (!Number.isSafeInteger(value.terminalAtMs) || value.terminalAtMs < value.createdAtMs))
        || TERMINAL.has(value.state) !== (value.terminalAtMs !== null)
        || typeof value.payloadPresent !== "boolean"
        || !DIGEST_PATTERN.test(value.capabilityHash)
        || !DIGEST_PATTERN.test(value.byteDigest)
        || !HEX_32_PATTERN.test(value.envelopeDigest)
        || !HEX_32_PATTERN.test(value.envelopeId)
        || !HEX_32_PATTERN.test(value.engineCommitment)
        || !ADDRESS_PATTERN.test(value.engine)
        || !ADDRESS_PATTERN.test(value.sessionAccount)
        || value.chainId !== "296"
        || value.chainHash !== QUICKNET_CHAIN_HASH
        || !decimal(value.targetRound)
        || !decimal(value.targetTime)
        || !validateTiming(value.timing)
        || !validatePrepared(value.prepared)
        || !validateBroadcast(value.broadcast)
    ) {
        fail("STORE_CORRUPT", "timed ticket metadata is invalid");
    }
    return value;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function publicSummary(metadata) {
    return clone({
        schemaVersion: metadata.schemaVersion,
        ticketId: metadata.id,
        state: metadata.state,
        revision: metadata.revision,
        chainId: metadata.chainId,
        engine: metadata.engine,
        sessionAccount: metadata.sessionAccount,
        envelopeId: metadata.envelopeId,
        envelopeDigest: metadata.envelopeDigest,
        byteDigest: metadata.byteDigest,
        engineCommitment: metadata.engineCommitment,
        targetRound: metadata.targetRound,
        targetTime: metadata.targetTime,
        timing: metadata.timing,
        broadcast: metadata.broadcast,
        payloadPresent: metadata.payloadPresent,
        createdAtMs: metadata.createdAtMs,
        updatedAtMs: metadata.updatedAtMs,
        terminalAtMs: metadata.terminalAtMs,
    });
}

async function syncDirectory(directory) {
    const handle = await open(directory, "r");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function writeFileDurable(file, value) {
    const handle = await open(file, "wx", 0o600);
    try {
        await handle.writeFile(value);
        await handle.sync();
    } finally {
        await handle.close();
    }
}

function metadataFor(header, id, capabilityHash, byteDigest, now) {
    return {
        schemaVersion: STORE_SCHEMA,
        id,
        state: "PREARMED",
        revision: 0,
        chainId: header.chainId.toString(),
        engine: header.engine,
        sessionAccount: header.sessionAccount,
        envelopeId: header.envelopeId,
        envelopeDigest: header.envelopeDigest,
        engineCommitment: header.engineCommitment,
        chainHash: header.chainHash,
        targetRound: header.targetRound.toString(),
        targetTime: header.targetTime.toString(),
        capabilityHash,
        byteDigest,
        payloadPresent: true,
        timing: null,
        prepared: null,
        broadcast: null,
        createdAtMs: now,
        updatedAtMs: now,
        terminalAtMs: null,
    };
}

function normalizedPatch(patch) {
    if (patch === undefined) return {};
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
        fail("TRANSITION_INVALID", "timed ticket state transition is invalid");
    }
    const allowed = new Set(["timing", "prepared", "broadcast"]);
    if (Object.keys(patch).some((key) => !allowed.has(key))) {
        fail("TRANSITION_INVALID", "timed ticket state transition is invalid");
    }
    const output = {};
    if (patch.timing !== undefined) {
        if (!validateTiming(patch.timing) || patch.timing === null) {
            fail("TRANSITION_INVALID", "timed ticket state transition is invalid");
        }
        output.timing = clone(patch.timing);
    }
    if (patch.prepared !== undefined) {
        if (!validatePrepared(patch.prepared) || patch.prepared === null) {
            fail("TRANSITION_INVALID", "timed ticket state transition is invalid");
        }
        output.prepared = clone(patch.prepared);
    }
    if (patch.broadcast !== undefined) {
        if (!validateBroadcast(patch.broadcast) || patch.broadcast === null) {
            fail("TRANSITION_INVALID", "timed ticket state transition is invalid");
        }
        output.broadcast = clone(patch.broadcast);
    }
    return output;
}

export class DurableTimedTicketStore {
    constructor({
        directory,
        crypto: cryptoImpl = webcrypto,
        nowMs = () => Date.now(),
        retentionMs = TIMED_TICKET_TERMINAL_RETENTION_MS,
    }) {
        if (typeof directory !== "string" || !path.isAbsolute(directory)) {
            fail("DIRECTORY_INVALID", "timed ticket store directory must be absolute");
        }
        if (
            !cryptoImpl?.subtle
            || typeof nowMs !== "function"
            || !Number.isSafeInteger(retentionMs)
            || retentionMs < TIMED_TICKET_TERMINAL_RETENTION_MS
        ) {
            fail("STORE_CONFIG_INVALID", "timed ticket store configuration is invalid");
        }
        this.directory = path.resolve(directory);
        this.crypto = cryptoImpl;
        this.nowMs = nowMs;
        this.retentionMs = retentionMs;
        this.queue = Promise.resolve();
    }

    async initialize() {
        try {
            const existing = await lstat(this.directory);
            if (!existing.isDirectory() || existing.isSymbolicLink()) {
                fail("DIRECTORY_INVALID", "timed ticket store path is invalid");
            }
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
            await mkdir(this.directory, {recursive: true, mode: 0o700});
        }
        await chmod(this.directory, 0o700);
    }

    workerAccess() {
        return Object.freeze({
            read: (id, options) => this.read(id, WORKER_AUTHORITY, options),
            list: () => this.list(WORKER_AUTHORITY),
            transition: (id, request) => this.transition(id, WORKER_AUTHORITY, request),
            finalizeTerminal: (id) => this.finalizeTerminal(id, WORKER_AUTHORITY),
            cancel: (id) => this.cancel(id, WORKER_AUTHORITY),
        });
    }

    async stage(envelope, {capability} = {}) {
        const input = Buffer.from(
            envelope instanceof Uint8Array ? envelope : new Uint8Array(),
        );
        if (input.length !== TIMED_TICKET_SIZE) {
            fail("SIZE_INVALID", "timed ticket envelope has invalid dimensions");
        }
        const header = await parseTimedTicketEnvelope(input, {crypto: this.crypto});
        const id = ticketId(header.envelopeId);
        const secret = capabilityBytes(capability, {generate: true});
        const capabilityHash = sha256(secret);
        const byteDigest = sha256(input);
        const operation = this.#serialize(async () => {
            await this.initialize();
            return this.#withLock(id, async () => {
                const existing = await this.#readMetadataIfPresent(id);
                if (existing) {
                    this.#authenticate(existing, secret);
                    if (!constantTextEqual(existing.byteDigest, byteDigest)) {
                        fail("ENVELOPE_CONFLICT", "timed ticket envelope conflicts with staged bytes");
                    }
                    if (existing.payloadPresent) {
                        const persisted = await this.#readEnvelope(id);
                        if (persisted.length !== input.length || !timingSafeEqual(persisted, input)) {
                            fail("STORE_CORRUPT", "staged timed ticket bytes failed readback");
                        }
                    }
                    return {...publicSummary(existing), capability: `0x${secret.toString("hex")}`};
                }
                const now = this.#now();
                const metadata = metadataFor(header, id, capabilityHash, byteDigest, now);
                validateMetadata(metadata, id);
                await this.#install(id, input, metadata);
                const persisted = await this.#readEnvelope(id);
                const readback = await this.#readMetadata(id);
                if (
                    persisted.length !== input.length
                    || !timingSafeEqual(persisted, input)
                    || !constantTextEqual(sha256(persisted), byteDigest)
                    || !constantTextEqual(readback.byteDigest, byteDigest)
                ) {
                    await rm(this.#recordDirectory(id), {recursive: true, force: true});
                    fail("READBACK_FAILED", "staged timed ticket failed atomic readback");
                }
                return {...publicSummary(readback), capability: `0x${secret.toString("hex")}`};
            });
        });
        try {
            return await operation;
        } finally {
            secret.fill(0);
            input.fill(0);
        }
    }

    async read(id, capability, {includeEnvelope = true} = {}) {
        const ticket = validId(id);
        const secret = capability === WORKER_AUTHORITY
            ? WORKER_AUTHORITY
            : capabilityBytes(capability);
        try {
            return await this.#serialize(async () => {
                return this.#withLock(ticket, async () => {
                    const metadata = await this.#readMetadata(ticket);
                    this.#authenticate(metadata, secret);
                    let envelope = null;
                    if (includeEnvelope && metadata.payloadPresent) {
                        envelope = await this.#readEnvelope(ticket);
                        if (!constantTextEqual(sha256(envelope), metadata.byteDigest)) {
                            envelope.fill(0);
                            fail("STORE_CORRUPT", "staged timed ticket bytes failed verification");
                        }
                    }
                    return {
                        metadata: clone(metadata),
                        summary: publicSummary(metadata),
                        envelope,
                    };
                });
            });
        } finally {
            if (secret !== WORKER_AUTHORITY) secret.fill(0);
        }
    }

    async list(authority) {
        if (authority !== WORKER_AUTHORITY) {
            fail("CAPABILITY_REJECTED", "timed ticket capability was rejected");
        }
        return this.#serialize(async () => {
            await this.initialize();
            const entries = await readdir(this.directory, {withFileTypes: true});
            const summaries = [];
            for (const entry of entries) {
                if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
                summaries.push(publicSummary(await this.#readMetadata(entry.name)));
            }
            return summaries.sort((left, right) => left.createdAtMs - right.createdAtMs);
        });
    }

    async transition(id, capability, {from, to, patch} = {}) {
        const ticket = validId(id);
        const secret = capability === WORKER_AUTHORITY
            ? WORKER_AUTHORITY
            : capabilityBytes(capability);
        const expected = Array.isArray(from) ? from : [from];
        if (
            expected.length === 0
            || expected.some((state) => !TIMED_TICKET_STATES.includes(state))
            || !TIMED_TICKET_STATES.includes(to)
            || to === "PURGED"
        ) {
            if (secret !== WORKER_AUTHORITY) secret.fill(0);
            fail("TRANSITION_INVALID", "timed ticket state transition is invalid");
        }
        const additions = normalizedPatch(patch);
        try {
            return await this.#serialize(() => this.#withLock(ticket, async () => {
                const metadata = await this.#readMetadata(ticket);
                this.#authenticate(metadata, secret);
                if (metadata.state === to) {
                    const finalized = TERMINAL.has(to)
                        ? await this.#purgePayload(ticket, metadata)
                        : metadata;
                    return publicSummary(finalized);
                }
                if (
                    !expected.includes(metadata.state)
                    || !TRANSITIONS[metadata.state]?.has(to)
                ) {
                    fail("STATE_CONFLICT", "timed ticket state changed before the requested transition");
                }
                const now = this.#now();
                const updated = {
                    ...metadata,
                    ...additions,
                    state: to,
                    revision: metadata.revision + 1,
                    updatedAtMs: now,
                    terminalAtMs: TERMINAL.has(to) ? now : null,
                };
                validateMetadata(updated, ticket);
                await this.#writeMetadata(ticket, updated);
                const finalized = TERMINAL.has(to)
                    ? await this.#purgePayload(ticket, updated)
                    : updated;
                return publicSummary(finalized);
            }));
        } finally {
            if (secret !== WORKER_AUTHORITY) secret.fill(0);
        }
    }

    async finalizeTerminal(id, capability) {
        const ticket = validId(id);
        const secret = capability === WORKER_AUTHORITY
            ? WORKER_AUTHORITY
            : capabilityBytes(capability);
        try {
            return await this.#serialize(() => this.#withLock(ticket, async () => {
                const metadata = await this.#readMetadata(ticket);
                this.#authenticate(metadata, secret);
                if (!TERMINAL.has(metadata.state)) {
                    fail("STATE_CONFLICT", "timed ticket is not terminal");
                }
                return publicSummary(await this.#purgePayload(ticket, metadata));
            }));
        } finally {
            if (secret !== WORKER_AUTHORITY) secret.fill(0);
        }
    }

    async cancel(id, capability) {
        const ticket = validId(id);
        const secret = capability === WORKER_AUTHORITY
            ? WORKER_AUTHORITY
            : capabilityBytes(capability);
        try {
            return await this.#serialize(() => this.#withLock(ticket, async () => {
                let metadata = await this.#readMetadata(ticket);
                this.#authenticate(metadata, secret);
                if (metadata.state === "REVEALED" || metadata.state === "MISSED") {
                    fail("STATE_CONFLICT", "terminal timed ticket cannot be cancelled");
                }
                if (metadata.state !== "CANCELLED") {
                    const now = this.#now();
                    metadata = {
                        ...metadata,
                        state: "CANCELLED",
                        revision: metadata.revision + 1,
                        updatedAtMs: now,
                        terminalAtMs: now,
                    };
                    validateMetadata(metadata, ticket);
                    await this.#writeMetadata(ticket, metadata);
                }
                metadata = await this.#purgePayload(ticket, metadata);
                return publicSummary(metadata);
            }));
        } finally {
            if (secret !== WORKER_AUTHORITY) secret.fill(0);
        }
    }

    async purgeExpired() {
        return this.#serialize(async () => {
            await this.initialize();
            const now = this.#now();
            const entries = await readdir(this.directory, {withFileTypes: true});
            const purged = [];
            for (const entry of entries) {
                if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
                await this.#withLock(entry.name, async () => {
                    const metadata = await this.#readMetadataIfPresent(entry.name);
                    if (
                        metadata
                        && TERMINAL.has(metadata.state)
                        && metadata.terminalAtMs + this.retentionMs <= now
                    ) {
                        await rm(this.#recordDirectory(entry.name), {recursive: true, force: true});
                        await syncDirectory(this.directory);
                        purged.push({ticketId: entry.name, state: "PURGED"});
                    }
                });
            }
            return purged;
        });
    }

    async #install(id, envelope, metadata) {
        const temporary = path.join(this.directory, `.stage-${randomUUID()}`);
        await mkdir(temporary, {mode: 0o700});
        await chmod(temporary, 0o700);
        try {
            await writeFileDurable(path.join(temporary, "envelope.bin"), envelope);
            await writeFileDurable(
                path.join(temporary, "metadata.json"),
                Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8"),
            );
            await syncDirectory(temporary);
            await rename(temporary, this.#recordDirectory(id));
            await syncDirectory(this.directory);
        } finally {
            await rm(temporary, {recursive: true, force: true});
        }
    }

    async #writeMetadata(id, metadata) {
        const directory = this.#recordDirectory(id);
        const temporary = path.join(directory, `.metadata-${randomUUID()}.tmp`);
        try {
            await writeFileDurable(
                temporary,
                Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8"),
            );
            await rename(temporary, this.#metadataFile(id));
            await chmod(this.#metadataFile(id), 0o600);
            await syncDirectory(directory);
        } finally {
            await rm(temporary, {force: true});
        }
    }

    async #readMetadata(id) {
        const metadata = await this.#readMetadataIfPresent(id);
        if (!metadata) fail("TICKET_MISSING", "timed ticket record is unavailable");
        return metadata;
    }

    async #readMetadataIfPresent(id) {
        const directory = this.#recordDirectory(validId(id));
        const file = this.#metadataFile(id);
        try {
            const directoryInfo = await lstat(directory);
            if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
                fail("STORE_CORRUPT", "timed ticket record path is invalid");
            }
            const info = await lstat(file);
            if (!info.isFile() || info.isSymbolicLink()) {
                fail("STORE_CORRUPT", "timed ticket metadata path is invalid");
            }
            return validateMetadata(JSON.parse(await readFile(file, "utf8")), id);
        } catch (error) {
            if (error?.code === "ENOENT") return null;
            if (error instanceof TimedTicketStoreError) throw error;
            fail("STORE_CORRUPT", "timed ticket metadata cannot be read");
        }
    }

    async #readEnvelope(id) {
        const directory = this.#recordDirectory(validId(id));
        const file = this.#envelopeFile(id);
        try {
            const directoryInfo = await lstat(directory);
            if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
                fail("STORE_CORRUPT", "timed ticket record path is invalid");
            }
            const info = await lstat(file);
            if (!info.isFile() || info.isSymbolicLink() || info.size !== TIMED_TICKET_SIZE) {
                fail("STORE_CORRUPT", "timed ticket envelope path is invalid");
            }
            return Buffer.from(await readFile(file));
        } catch (error) {
            if (error instanceof TimedTicketStoreError) throw error;
            fail("STORE_CORRUPT", "timed ticket envelope cannot be read");
        }
    }

    async #purgePayload(id, metadata) {
        if (!metadata.payloadPresent) return metadata;
        await rm(this.#envelopeFile(id), {force: true});
        await syncDirectory(this.#recordDirectory(id));
        const updated = {
            ...metadata,
            payloadPresent: false,
            revision: metadata.revision + 1,
            updatedAtMs: this.#now(),
        };
        validateMetadata(updated, id);
        await this.#writeMetadata(id, updated);
        return updated;
    }

    #authenticate(metadata, capability) {
        if (capability === WORKER_AUTHORITY) return;
        const actual = sha256(capability);
        if (!constantTextEqual(actual, metadata.capabilityHash)) {
            fail("CAPABILITY_REJECTED", "timed ticket capability was rejected");
        }
    }

    #now() {
        const value = this.nowMs();
        if (!Number.isSafeInteger(value) || value < 0) {
            fail("CLOCK_INVALID", "timed ticket store clock is invalid");
        }
        return value;
    }

    #serialize(operation) {
        const queued = this.queue.then(operation);
        this.queue = queued.catch(() => {});
        return queued;
    }

    async #withLock(id, operation) {
        validId(id);
        await this.initialize();
        const lockFile = path.join(this.directory, `.${id}.lock`);
        let handle;
        for (let attempt = 0; attempt < 200; attempt += 1) {
            try {
                handle = await open(lockFile, "wx", 0o600);
                await handle.writeFile(
                    `${JSON.stringify({pid: process.pid, createdAtMs: Date.now()})}\n`,
                    "utf8",
                );
                await handle.sync();
                break;
            } catch (error) {
                if (error?.code !== "EEXIST") throw error;
                try {
                    const info = await lstat(lockFile);
                    if (!info.isFile() || info.isSymbolicLink()) {
                        fail("STORE_BUSY", "timed ticket store lock is invalid");
                    }
                    if (Date.now() - info.mtimeMs > 120_000) {
                        await rm(lockFile, {force: true});
                        continue;
                    }
                } catch (inspectionError) {
                    if (inspectionError?.code !== "ENOENT") throw inspectionError;
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        }
        if (!handle) fail("STORE_BUSY", "timed ticket store is busy");
        try {
            return await operation();
        } finally {
            await handle.close();
            await rm(lockFile, {force: true});
            await syncDirectory(this.directory);
        }
    }

    #recordDirectory(id) {
        return path.join(this.directory, validId(id));
    }

    #metadataFile(id) {
        return path.join(this.#recordDirectory(id), "metadata.json");
    }

    #envelopeFile(id) {
        return path.join(this.#recordDirectory(id), "envelope.bin");
    }
}
