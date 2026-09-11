import {
    createHash,
    randomUUID,
    timingSafeEqual,
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
    TIMED_TICKET_CHAIN_ID,
} from "../../tools/timed-ticket.mjs";

export const PRIVATE_RELAY_STORE_SCHEMA = "hedera2026.private-relay-store.v1";

const RELAY_KINDS = Object.freeze([
    "place",
    "reveal",
    "cancel",
    "cancel-sweep",
    "expire",
    "sweep",
    "route",
    "registration",
    "recovery",
]);
const HANDLE =
    /^(?:place|reveal|cancel|cancel-sweep|expire|sweep|route|registration|recovery)_[0-9a-f]{64}$/;
const TICKET_ID = /^[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TRADING_CONTEXT_KEYS = [
    "chainHash",
    "chainId",
    "engine",
    "engineCommitment",
    "envelopeDigest",
    "envelopeId",
    "feePolicyDigest",
    "generation",
    "sessionAccount",
    "targetRound",
    "ticketId",
].sort().join(",");
const ROUTING_CONTEXT_KEYS = [
    "asset",
    "assetAddress",
    "chainId",
    "denomination",
    "id",
    "nullifier",
    "pool",
    "recipient",
    "root",
    "viewKeyEpoch",
    "viewKeyX",
    "viewKeyY",
].sort().join(",");
const REGISTRATION_CONTEXT_KEYS = [
    "account",
    "action",
    "chainId",
    "factory",
    "gate",
    "id",
    "registry",
    "requestDigest",
].sort().join(",");
const RECOVERY_CONTEXT_KEYS = [
    "account",
    "amount",
    "asset",
    "chainId",
    "factory",
    "generation",
    "id",
    "nonce",
    "pool",
    "router",
    "security",
].sort().join(",");
const METADATA_KEYS = [
    "byteDigest",
    "calldataBytes",
    "calldataDigest",
    "chainId",
    "context",
    "createdAtMs",
    "from",
    "gasLimit",
    "gasPrice",
    "handle",
    "kind",
    "nonce",
    "schemaVersion",
    "signedTransactionBytes",
    "simulationBlock",
    "to",
    "transactionHash",
].sort().join(",");
const MAX_CALLDATA_BYTES = 4_096;
const MAX_METADATA_BYTES = 8_192;
const MAX_SIGNED_TRANSACTION_BYTES = 16_384;
const UINT64_LIMIT = 1n << 64n;

export class PrivateRelayStoreError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "PrivateRelayStoreError";
        this.code = code;
    }
}

function fail(code, message = "private relay storage operation failed") {
    throw new PrivateRelayStoreError(code, message);
}

function sha256(value) {
    return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function decimal(value, {
    nonzero = false,
    limit = 1n << 256n,
} = {}) {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
        fail("RELAY_RECORD_INVALID");
    }
    const parsed = BigInt(value);
    if (parsed < 0n || parsed >= limit || (nonzero && parsed === 0n)) {
        fail("RELAY_RECORD_INVALID");
    }
    return value;
}

function privateDirectory(info) {
    return (
        info.isDirectory()
        && !info.isSymbolicLink()
        && (info.mode & 0o077) === 0
    );
}

function privateFile(info) {
    return (
        info.isFile()
        && !info.isSymbolicLink()
        && (info.mode & 0o077) === 0
    );
}

function tradingContext(value) {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== TRADING_CONTEXT_KEYS
        || value.chainId !== TIMED_TICKET_CHAIN_ID.toString()
        || value.chainHash !== QUICKNET_CHAIN_HASH
        || !ADDRESS.test(value.engine)
        || !ADDRESS.test(value.sessionAccount)
        || !BYTES32.test(value.engineCommitment)
        || !BYTES32.test(value.envelopeDigest)
        || !BYTES32.test(value.envelopeId)
        || !BYTES32.test(value.feePolicyDigest)
        || !TICKET_ID.test(value.ticketId)
    ) {
        fail("RELAY_RECORD_INVALID");
    }
    decimal(value.targetRound, {nonzero: true, limit: UINT64_LIMIT});
    decimal(value.generation, {limit: UINT64_LIMIT});
    return clone(value);
}

function routingContext(value) {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== ROUTING_CONTEXT_KEYS
        || value.chainId !== TIMED_TICKET_CHAIN_ID.toString()
        || !["HBAR", "LPRC"].includes(value.asset)
        || !ADDRESS.test(value.assetAddress)
        || !TICKET_ID.test(value.id)
        || !ADDRESS.test(value.pool)
        || !ADDRESS.test(value.recipient)
        || !BYTES32.test(value.nullifier)
    ) {
        fail("RELAY_RECORD_INVALID");
    }
    decimal(value.denomination, {nonzero: true});
    decimal(value.root);
    decimal(value.viewKeyEpoch);
    decimal(value.viewKeyX);
    decimal(value.viewKeyY);
    if (value.id !== value.nullifier.slice(2)) fail("RELAY_RECORD_INVALID");
    return clone(value);
}

function registrationContext(value) {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== REGISTRATION_CONTEXT_KEYS
        || value.chainId !== TIMED_TICKET_CHAIN_ID.toString()
        || !["deploy-and-register", "register"].includes(value.action)
        || !ADDRESS.test(value.account)
        || !ADDRESS.test(value.factory)
        || !ADDRESS.test(value.gate)
        || !ADDRESS.test(value.registry)
        || !TICKET_ID.test(value.id)
        || !DIGEST.test(value.requestDigest)
    ) {
        fail("RELAY_RECORD_INVALID");
    }
    return clone(value);
}

function recoveryContext(value) {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== RECOVERY_CONTEXT_KEYS
        || value.chainId !== TIMED_TICKET_CHAIN_ID.toString()
        || !["HBAR", "LPRC"].includes(value.asset)
        || !ADDRESS.test(value.account)
        || !ADDRESS.test(value.factory)
        || !ADDRESS.test(value.pool)
        || !ADDRESS.test(value.router)
        || !ADDRESS.test(value.security)
        || !TICKET_ID.test(value.id)
    ) {
        fail("RELAY_RECORD_INVALID");
    }
    decimal(value.amount, {nonzero: true});
    decimal(value.generation, {limit: UINT64_LIMIT});
    decimal(value.nonce);
    return clone(value);
}

function context(value, kind) {
    if (kind === "route") return routingContext(value);
    if (kind === "registration") return registrationContext(value);
    if (kind === "recovery") return recoveryContext(value);
    return tradingContext(value);
}

function contextIdentifier(value, kind) {
    return ["route", "registration", "recovery"].includes(kind)
        ? value.id
        : value.ticketId;
}

function validHandle(value) {
    if (typeof value !== "string" || !HANDLE.test(value)) {
        fail("RELAY_HANDLE_INVALID");
    }
    return value;
}

function validKind(value) {
    if (!RELAY_KINDS.includes(value)) fail("RELAY_RECORD_INVALID");
    return value;
}

function validateMetadata(value, expectedHandle) {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== METADATA_KEYS
        || value.schemaVersion !== PRIVATE_RELAY_STORE_SCHEMA
        || value.handle !== expectedHandle
        || !HANDLE.test(value.handle)
        || !RELAY_KINDS.includes(value.kind)
        || value.handle !== `${value.kind}_${contextIdentifier(
            value.context ?? {},
            value.kind,
        )}`
        || value.chainId !== TIMED_TICKET_CHAIN_ID.toString()
        || !ADDRESS.test(value.from)
        || !ADDRESS.test(value.to)
        || !BYTES32.test(value.transactionHash)
        || !DIGEST.test(value.byteDigest)
        || !DIGEST.test(value.calldataDigest)
        || !Number.isSafeInteger(value.nonce)
        || value.nonce < 0
        || !Number.isSafeInteger(value.createdAtMs)
        || value.createdAtMs < 0
        || !Number.isSafeInteger(value.calldataBytes)
        || value.calldataBytes < 1
        || value.calldataBytes > MAX_CALLDATA_BYTES
        || !Number.isSafeInteger(value.signedTransactionBytes)
        || value.signedTransactionBytes < 1
        || value.signedTransactionBytes > MAX_SIGNED_TRANSACTION_BYTES
        || (
            value.simulationBlock !== null
            && (!Number.isSafeInteger(value.simulationBlock) || value.simulationBlock < 0)
        )
        || (value.kind !== "reveal" && value.simulationBlock === null)
        || (value.kind === "reveal" && value.simulationBlock !== null)
    ) {
        fail("RELAY_STORE_CORRUPT");
    }
    decimal(value.gasPrice, {nonzero: true});
    decimal(value.gasLimit, {nonzero: true});
    context(value.context, value.kind);
    return value;
}

async function syncDirectory(directory) {
    const handle = await open(directory, "r");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function writeDurable(file, bytes) {
    const handle = await open(file, "wx", 0o600);
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    } finally {
        await handle.close();
    }
}

export function privateRelayHandle(kind, identifier) {
    validKind(kind);
    if (typeof identifier !== "string" || !TICKET_ID.test(identifier)) {
        fail("RELAY_HANDLE_INVALID");
    }
    return `${kind}_${identifier}`;
}

export class DurablePrivateRelayStore {
    constructor({
        directory,
        nowMs = () => Date.now(),
    }) {
        if (typeof directory !== "string" || !path.isAbsolute(directory)) {
            fail("RELAY_DIRECTORY_INVALID");
        }
        if (typeof nowMs !== "function") fail("RELAY_STORE_CONFIG_INVALID");
        this.directory = path.resolve(directory);
        this.nowMs = nowMs;
        this.queue = Promise.resolve();
    }

    async initialize() {
        try {
            const existing = await lstat(this.directory);
            if (!existing.isDirectory() || existing.isSymbolicLink()) {
                fail("RELAY_DIRECTORY_INVALID");
            }
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
            await mkdir(this.directory, {recursive: true, mode: 0o700});
        }
        await chmod(this.directory, 0o700);
    }

    async prepare({handle, minimumNonce, build}) {
        const recordHandle = validHandle(handle);
        if (
            !Number.isSafeInteger(minimumNonce)
            || minimumNonce < 0
            || typeof build !== "function"
        ) {
            fail("RELAY_PREPARATION_INVALID");
        }
        return this.#serialize(async () => {
            await this.initialize();
            return this.#withRootLock(async () => {
                const existing = await this.#readIfPresent(recordHandle);
                if (existing !== null) return existing;
                const records = await this.#listMetadata();
                let nonce = minimumNonce;
                for (const metadata of records) {
                    nonce = Math.max(nonce, metadata.nonce + 1);
                }
                if (!Number.isSafeInteger(nonce)) fail("RELAY_NONCE_INVALID");
                let built;
                try {
                    built = await build(nonce);
                } catch (error) {
                    throw error;
                }
                let normalized;
                try {
                    normalized = this.#normalizeInput({
                        ...built,
                        handle: recordHandle,
                        nonce,
                    });
                } finally {
                    built?.calldata?.fill?.(0);
                    built?.signedTransaction?.fill?.(0);
                }
                return this.#install(normalized);
            });
        });
    }

    async prepareRedacted({handle, minimumNonce, build}) {
        const recordHandle = validHandle(handle);
        if (
            !Number.isSafeInteger(minimumNonce)
            || minimumNonce < 0
            || typeof build !== "function"
        ) {
            fail("RELAY_PREPARATION_INVALID");
        }
        return this.#serialize(async () => {
            await this.initialize();
            return this.#withRootLock(async () => {
                const existing = await this.#readIfPresent(recordHandle);
                if (existing !== null) return existing;
                const records = await this.#listMetadata();
                let nonce = minimumNonce;
                for (const metadata of records) {
                    nonce = Math.max(nonce, metadata.nonce + 1);
                }
                if (!Number.isSafeInteger(nonce)) fail("RELAY_NONCE_INVALID");
                const built = await build(nonce);
                const metadata = this.#normalizeRedacted({
                    ...built,
                    handle: recordHandle,
                    nonce,
                });
                return this.#installRedacted(metadata);
            });
        });
    }

    async stage(input) {
        const normalized = this.#normalizeInput(input);
        return this.#serialize(async () => {
            await this.initialize();
            try {
                return await this.#withRootLock(async () => {
                    const existing = await this.#readIfPresent(normalized.metadata.handle);
                    if (existing !== null) {
                        this.#assertSame(existing, normalized);
                        return existing;
                    }
                    return this.#install(normalized);
                });
            } finally {
                normalized.calldata.fill(0);
                normalized.signedTransaction.fill(0);
            }
        });
    }

    async read(handle) {
        const recordHandle = validHandle(handle);
        return this.#serialize(async () => {
            await this.initialize();
            const value = await this.#readIfPresent(recordHandle);
            if (value === null) fail("RELAY_RECORD_MISSING");
            return value;
        });
    }

    async readIfPresent(handle) {
        const recordHandle = validHandle(handle);
        return this.#serialize(async () => {
            await this.initialize();
            return this.#readIfPresent(recordHandle);
        });
    }

    async list() {
        return this.#serialize(async () => {
            await this.initialize();
            return this.#listMetadata().then((records) => records.map(clone));
        });
    }

    #normalizeInput(input) {
        if (input === null || typeof input !== "object" || Array.isArray(input)) {
            fail("RELAY_RECORD_INVALID");
        }
        const handle = validHandle(input.handle);
        const kind = validKind(input.kind);
        const recordContext = context(input.context, kind);
        if (
            kind === "recovery"
            || handle !== privateRelayHandle(
                kind,
                contextIdentifier(recordContext, kind),
            )
            || !Number.isSafeInteger(input.nonce)
            || input.nonce < 0
            || typeof input.from !== "string"
            || !ADDRESS.test(input.from)
            || typeof input.to !== "string"
            || !ADDRESS.test(input.to)
            || typeof input.transactionHash !== "string"
            || !BYTES32.test(input.transactionHash)
            || (
                input.simulationBlock !== null
                && input.simulationBlock !== undefined
                && (!Number.isSafeInteger(input.simulationBlock) || input.simulationBlock < 0)
            )
        ) {
            fail("RELAY_RECORD_INVALID");
        }
        const calldata = Buffer.from(
            input.calldata instanceof Uint8Array ? input.calldata : new Uint8Array(),
        );
        const signedTransaction = Buffer.from(
            input.signedTransaction instanceof Uint8Array
                ? input.signedTransaction
                : new Uint8Array(),
        );
        if (
            calldata.length < 1
            || calldata.length > MAX_CALLDATA_BYTES
            || signedTransaction.length < 1
            || signedTransaction.length > MAX_SIGNED_TRANSACTION_BYTES
        ) {
            calldata.fill(0);
            signedTransaction.fill(0);
            fail("RELAY_RECORD_INVALID");
        }
        const now = this.#now();
        const metadata = {
            schemaVersion: PRIVATE_RELAY_STORE_SCHEMA,
            handle,
            kind,
            chainId: TIMED_TICKET_CHAIN_ID.toString(),
            context: recordContext,
            from: input.from,
            to: input.to,
            nonce: input.nonce,
            gasPrice: decimal(String(input.gasPrice), {nonzero: true}),
            gasLimit: decimal(String(input.gasLimit), {nonzero: true}),
            transactionHash: input.transactionHash,
            byteDigest: sha256(signedTransaction),
            calldataDigest: sha256(calldata),
            calldataBytes: calldata.length,
            signedTransactionBytes: signedTransaction.length,
            simulationBlock: input.simulationBlock ?? null,
            createdAtMs: now,
        };
        validateMetadata(metadata, handle);
        return {metadata, calldata, signedTransaction};
    }

    #normalizeRedacted(input) {
        if (
            input === null
            || typeof input !== "object"
            || Array.isArray(input)
        ) {
            fail("RELAY_RECORD_INVALID");
        }
        const handle = validHandle(input.handle);
        const kind = validKind(input.kind);
        const recordContext = context(input.context, kind);
        if (
            kind !== "recovery"
            || handle !== privateRelayHandle(
                kind,
                contextIdentifier(recordContext, kind),
            )
            || !Number.isSafeInteger(input.nonce)
            || input.nonce < 0
            || !ADDRESS.test(input.from)
            || !ADDRESS.test(input.to)
            || !BYTES32.test(input.transactionHash)
            || !DIGEST.test(input.byteDigest)
            || !DIGEST.test(input.calldataDigest)
            || !Number.isSafeInteger(input.calldataBytes)
            || input.calldataBytes < 1
            || input.calldataBytes > MAX_CALLDATA_BYTES
            || !Number.isSafeInteger(input.signedTransactionBytes)
            || input.signedTransactionBytes < 1
            || input.signedTransactionBytes > MAX_SIGNED_TRANSACTION_BYTES
            || !Number.isSafeInteger(input.simulationBlock)
            || input.simulationBlock < 0
        ) {
            fail("RELAY_RECORD_INVALID");
        }
        const metadata = {
            schemaVersion: PRIVATE_RELAY_STORE_SCHEMA,
            handle,
            kind,
            chainId: TIMED_TICKET_CHAIN_ID.toString(),
            context: recordContext,
            from: input.from,
            to: input.to,
            nonce: input.nonce,
            gasPrice: decimal(String(input.gasPrice), {nonzero: true}),
            gasLimit: decimal(String(input.gasLimit), {nonzero: true}),
            transactionHash: input.transactionHash,
            byteDigest: input.byteDigest,
            calldataDigest: input.calldataDigest,
            calldataBytes: input.calldataBytes,
            signedTransactionBytes: input.signedTransactionBytes,
            simulationBlock: input.simulationBlock,
            createdAtMs: this.#now(),
        };
        validateMetadata(metadata, handle);
        return metadata;
    }

    async #install(normalized) {
        const {metadata, calldata, signedTransaction} = normalized;
        const temporary = path.join(this.directory, `.stage-${randomUUID()}`);
        await mkdir(temporary, {mode: 0o700});
        await chmod(temporary, 0o700);
        try {
            await writeDurable(path.join(temporary, "calldata.bin"), calldata);
            await writeDurable(path.join(temporary, "transaction.bin"), signedTransaction);
            await writeDurable(
                path.join(temporary, "record.json"),
                Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8"),
            );
            await syncDirectory(temporary);
            await rename(temporary, this.#recordDirectory(metadata.handle));
            await syncDirectory(this.directory);
            const persisted = await this.#readIfPresent(metadata.handle);
            if (persisted === null) fail("RELAY_READBACK_FAILED");
            this.#assertSame(persisted, normalized);
            return persisted;
        } finally {
            calldata.fill(0);
            signedTransaction.fill(0);
            await rm(temporary, {recursive: true, force: true});
        }
    }

    async #installRedacted(metadata) {
        const temporary = path.join(this.directory, `.stage-${randomUUID()}`);
        await mkdir(temporary, {mode: 0o700});
        await chmod(temporary, 0o700);
        try {
            await writeDurable(
                path.join(temporary, "record.json"),
                Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8"),
            );
            await syncDirectory(temporary);
            await rename(temporary, this.#recordDirectory(metadata.handle));
            await syncDirectory(this.directory);
            const persisted = await this.#readIfPresent(metadata.handle);
            if (
                persisted === null
                || JSON.stringify(persisted.metadata)
                    !== JSON.stringify(metadata)
            ) {
                fail("RELAY_READBACK_FAILED");
            }
            return persisted;
        } finally {
            await rm(temporary, {recursive: true, force: true});
        }
    }

    #assertSame(existing, expected) {
        const expectedMetadata = expected.metadata;
        const comparableExisting = {
            ...existing.metadata,
            createdAtMs: expectedMetadata.createdAtMs,
        };
        if (
            JSON.stringify(comparableExisting) !== JSON.stringify(expectedMetadata)
            || existing.calldata.length !== expected.calldata.length
            || existing.signedTransaction.length !== expected.signedTransaction.length
            || !timingSafeEqual(existing.calldata, expected.calldata)
            || !timingSafeEqual(existing.signedTransaction, expected.signedTransaction)
        ) {
            existing.calldata.fill(0);
            existing.signedTransaction.fill(0);
            fail("RELAY_RECORD_CONFLICT");
        }
    }

    async #readIfPresent(handle) {
        const directory = this.#recordDirectory(handle);
        try {
            const directoryInfo = await lstat(directory);
            if (!privateDirectory(directoryInfo)) {
                fail("RELAY_STORE_CORRUPT");
            }
            const metadataFile = path.join(directory, "record.json");
            const metadataInfo = await lstat(metadataFile);
            if (
                !privateFile(metadataInfo)
                || metadataInfo.size < 1
                || metadataInfo.size > MAX_METADATA_BYTES
            ) {
                fail("RELAY_STORE_CORRUPT");
            }
            const metadata = validateMetadata(
                JSON.parse(await readFile(metadataFile, "utf8")),
                handle,
            );
            if (metadata.kind === "recovery") {
                const entries = await readdir(directory);
                if (
                    entries.length !== 1
                    || entries[0] !== "record.json"
                ) {
                    fail("RELAY_STORE_CORRUPT");
                }
                return {
                    metadata: clone(metadata),
                    calldata: null,
                    signedTransaction: null,
                };
            }
            const calldataFile = path.join(directory, "calldata.bin");
            const transactionFile = path.join(directory, "transaction.bin");
            const [calldataInfo, transactionInfo] = await Promise.all([
                lstat(calldataFile),
                lstat(transactionFile),
            ]);
            if (
                !privateFile(calldataInfo)
                || !privateFile(transactionInfo)
                || calldataInfo.size !== metadata.calldataBytes
                || transactionInfo.size !== metadata.signedTransactionBytes
            ) {
                fail("RELAY_STORE_CORRUPT");
            }
            const [calldata, signedTransaction] = await Promise.all([
                readFile(calldataFile),
                readFile(transactionFile),
            ]);
            if (
                sha256(calldata) !== metadata.calldataDigest
                || sha256(signedTransaction) !== metadata.byteDigest
            ) {
                calldata.fill(0);
                signedTransaction.fill(0);
                fail("RELAY_STORE_CORRUPT");
            }
            return {
                metadata: clone(metadata),
                calldata,
                signedTransaction,
            };
        } catch (error) {
            if (error?.code === "ENOENT") return null;
            if (error instanceof PrivateRelayStoreError) throw error;
            fail("RELAY_STORE_CORRUPT");
        }
    }

    async #listMetadata() {
        const entries = await readdir(this.directory, {withFileTypes: true});
        const output = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || !HANDLE.test(entry.name)) continue;
            const record = await this.#readIfPresent(entry.name);
            if (record === null) continue;
            output.push(record.metadata);
            record.calldata?.fill(0);
            record.signedTransaction?.fill(0);
        }
        return output.sort((left, right) => left.nonce - right.nonce);
    }

    async #withRootLock(operation) {
        const lockFile = path.join(this.directory, ".prepare.lock");
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
                        fail("RELAY_STORE_BUSY");
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
        if (!handle) fail("RELAY_STORE_BUSY");
        try {
            return await operation();
        } finally {
            await handle.close();
            await rm(lockFile, {force: true});
            await syncDirectory(this.directory);
        }
    }

    #recordDirectory(handle) {
        return path.join(this.directory, validHandle(handle));
    }

    #now() {
        const value = this.nowMs();
        if (!Number.isSafeInteger(value) || value < 0) fail("RELAY_CLOCK_INVALID");
        return value;
    }

    #serialize(operation) {
        const queued = this.queue.then(operation);
        this.queue = queued.catch(() => {});
        return queued;
    }
}
