import {createHash, randomUUID} from "node:crypto";
import {chmod, mkdir, open, readFile, rename, rm} from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = "lattice.agent.receipt-store.v1";
const RECEIPT_VERSION = "lattice.agent.durable-receipt.v1";
const EMPTY_HEAD = `sha256:${"0".repeat(64)}`;
const ACTION_ID = /^sha256:[0-9a-f]{64}$/;
const FORBIDDEN_KEYS = new Set([
    "authenticationtag",
    "csrftoken",
    "pairingtoken",
    "passphrase",
    "privatekey",
    "recoveryphrase",
    "recoveryseed",
    "revealsalt",
    "salt",
    "sessiontoken",
    "signingkey",
    "signedbytes",
    "signedtransaction",
    "witness",
]);
const PUBLIC_PROOF_KEYS = new Set(["proofhash", "proofverified"]);

export class ReceiptStoreError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "ReceiptStoreError";
        this.code = code;
    }
}

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function digest(value) {
    return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function sanitized(value, at = "receipt", depth = 0) {
    if (depth > 12) {
        throw new ReceiptStoreError("RECEIPT_TOO_DEEP", `${at} exceeds the durable receipt depth limit`);
    }
    if (Array.isArray(value)) {
        if (value.length > 256) {
            throw new ReceiptStoreError("RECEIPT_TOO_LARGE", `${at} exceeds the durable receipt array limit`);
        }
        value.forEach((item, index) => sanitized(item, `${at}[${index}]`, depth + 1));
        return;
    }
    if (typeof value === "string") {
        if (value.length > 4096) {
            throw new ReceiptStoreError("RECEIPT_TOO_LARGE", `${at} exceeds the durable receipt string limit`);
        }
        return;
    }
    if (
        value === null ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
    ) {
        return;
    }
    if (typeof value !== "object") {
        throw new ReceiptStoreError("RECEIPT_VALUE_INVALID", `${at} is not JSON receipt data`);
    }
    for (const [key, item] of Object.entries(value)) {
        if (key.length === 0 || key.length > 128) {
            throw new ReceiptStoreError("RECEIPT_KEY_INVALID", `${at} has an invalid field name`);
        }
        const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
        if (
            FORBIDDEN_KEYS.has(normalizedKey) ||
            normalizedKey.includes("privatekey") ||
            normalizedKey.includes("signingkey") ||
            (normalizedKey.includes("proof") && !PUBLIC_PROOF_KEYS.has(normalizedKey))
        ) {
            throw new ReceiptStoreError("PRIVATE_FIELD_REFUSED", `${at}.${key} is not durable receipt data`);
        }
        sanitized(item, `${at}.${key}`, depth + 1);
    }
}

function publicSnapshot(snapshot) {
    if (snapshot === undefined || snapshot === null) return null;
    return {
        snapshotId: snapshot.snapshotId,
        blockNumber: Number(snapshot.blockNumber),
        blockHash: snapshot.blockHash,
        publicSlot: snapshot.publicSlot,
        currentRound: snapshot.currentRound,
        limitPrice: snapshot.limitPrice,
        quantity: snapshot.quantity,
        features: structuredClone(snapshot.features),
        authenticatedAgainstChain: snapshot.authenticatedAgainstChain === true,
    };
}

function emptyState() {
    return {
        schemaVersion: STORE_VERSION,
        sequence: 0,
        head: EMPTY_HEAD,
        events: [],
        records: {},
    };
}

function validateState(state) {
    if (
        state === null ||
        typeof state !== "object" ||
        Array.isArray(state) ||
        Object.keys(state).sort().join(",") !== "events,head,records,schemaVersion,sequence" ||
        state.schemaVersion !== STORE_VERSION ||
        !Number.isSafeInteger(state.sequence) ||
        state.sequence < 0 ||
        !Array.isArray(state.events) ||
        state.events.length !== state.sequence ||
        state.records === null ||
        typeof state.records !== "object" ||
        Array.isArray(state.records)
    ) {
        throw new ReceiptStoreError("STORE_INVALID", "durable receipt store schema is invalid");
    }
    let previousHash = EMPTY_HEAD;
    const latestRecordHashes = new Map();
    for (let index = 0; index < state.events.length; index += 1) {
        const event = state.events[index];
        const {hash, ...unsigned} = event;
        if (
            event.sequence !== index + 1 ||
            event.previousHash !== previousHash ||
            !ACTION_ID.test(event.actionId ?? "") ||
            hash !== digest(unsigned)
        ) {
            throw new ReceiptStoreError("STORE_CHAIN_INVALID", "durable receipt event chain is invalid");
        }
        sanitized(event);
        previousHash = hash;
        latestRecordHashes.set(event.actionId, event.recordHash);
    }
    if (state.head !== previousHash) {
        throw new ReceiptStoreError("STORE_CHAIN_INVALID", "durable receipt head is invalid");
    }
    for (const [actionId, record] of Object.entries(state.records)) {
        if (
            !ACTION_ID.test(actionId) ||
            record?.schemaVersion !== RECEIPT_VERSION ||
            record.actionId !== actionId ||
            latestRecordHashes.get(actionId) !== digest(record)
        ) {
            throw new ReceiptStoreError("STORE_RECORD_INVALID", "durable receipt record is invalid");
        }
        sanitized(record);
    }
    if (
        latestRecordHashes.size !== Object.keys(state.records).length ||
        [...latestRecordHashes].some(([actionId]) => state.records[actionId] === undefined)
    ) {
        throw new ReceiptStoreError("STORE_RECORD_INVALID", "durable receipt records do not match the event chain");
    }
    return state;
}

export class SanitizedReceiptStore {
    constructor({directory, now = () => new Date().toISOString()}) {
        if (typeof directory !== "string" || !path.isAbsolute(directory)) {
            throw new ReceiptStoreError("DIRECTORY_INVALID", "receipt directory must be absolute");
        }
        if (typeof now !== "function") {
            throw new ReceiptStoreError("CLOCK_INVALID", "receipt clock must be a function");
        }
        this.directory = path.resolve(directory);
        this.file = path.join(this.directory, "receipts.json");
        this.now = now;
        this.queue = Promise.resolve();
    }

    async initialize() {
        await mkdir(this.directory, {recursive: true, mode: 0o700});
        await chmod(this.directory, 0o700);
        try {
            await this.#read();
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
            await this.#write(emptyState());
        }
    }

    async recordEvaluation({receipt, mandateId, snapshot = null}) {
        if (
            !ACTION_ID.test(receipt?.actionId ?? "") ||
            !ACTION_ID.test(mandateId ?? "") ||
            !["WAIT", "EXECUTE"].includes(receipt?.decision)
        ) {
            throw new ReceiptStoreError("EVALUATION_INVALID", "durable decision receipt is invalid");
        }
        return this.#update("evaluation", receipt.actionId, (existing, at) => {
            const lifecycle = structuredClone(
                existing?.lifecycle ?? {steps: [], latestState: null, lastError: null}
            );
            if (receipt.transaction?.transactionHash !== null && receipt.transaction?.transactionHash !== undefined) {
                lifecycle.steps = lifecycle.steps.filter((item) => item.stage !== "commit");
                lifecycle.steps.push({
                    stage: "commit",
                    commitment: receipt.commitment,
                    transaction: structuredClone(receipt.transaction),
                    before: null,
                    after: null,
                    protocolPreflight: null,
                });
            }
            return {
                schemaVersion: RECEIPT_VERSION,
                actionId: receipt.actionId,
                mandateId,
                commitment: receipt.commitment ?? existing?.commitment ?? null,
                decision: {
                    decision: receipt.decision,
                    inference: structuredClone(receipt.inference),
                    worker: structuredClone(receipt.worker),
                    limitations: structuredClone(receipt.limitations),
                },
                snapshot: publicSnapshot(snapshot) ?? existing?.snapshot ?? null,
                lifecycle,
                createdAt: existing?.createdAt ?? at,
                updatedAt: at,
            };
        });
    }

    async ensureAction(action) {
        const {actionId, mandateId, commitment} = action ?? {};
        if (
            !ACTION_ID.test(actionId ?? "") ||
            !ACTION_ID.test(mandateId ?? "") ||
            typeof commitment !== "string" ||
            !/^0x[0-9a-fA-F]{64}$/.test(commitment)
        ) {
            throw new ReceiptStoreError("ACTION_INVALID", "persisted action identity is invalid");
        }
        return this.#update("recovered-action", actionId, (existing, at) => {
            const signerSteps = Object.entries(action.transactions ?? {})
                .filter(([stage, transaction]) =>
                    ["commit", "reveal", "cancel", "expire", "withdraw"].includes(stage) &&
                    transaction !== null &&
                    /^0x[0-9a-fA-F]{64}$/.test(transaction.transactionHash ?? "") &&
                    Number.isSafeInteger(transaction.nonce) &&
                    transaction.nonce >= 0
                )
                .map(([stage, transaction]) => ({
                    stage,
                    commitment: commitment.toLowerCase(),
                    transaction: {
                        transactionHash: transaction.transactionHash.toLowerCase(),
                        nonce: transaction.nonce,
                        status: ["confirmed", "reverted", "unknown"].includes(transaction.broadcastStatus)
                            ? transaction.broadcastStatus
                            : "persisted",
                        blockNumber: null,
                        gasUsed: null,
                        logs: [],
                        exactProjectionMatched: true,
                        recoveredFromSigner: true,
                    },
                    before: null,
                    after: null,
                    protocolPreflight: null,
                }));
            if (existing !== undefined) {
                const signerByKey = new Map(signerSteps.map(
                    (step) => [
                        `${step.stage}:${step.transaction.transactionHash}`,
                        step,
                    ]
                ));
                const merged = existing.lifecycle.steps.map((step) => {
                    const key = `${step.stage}:${step.transaction?.transactionHash ?? "none"}`;
                    const recovered = signerByKey.get(key);
                    if (
                        recovered !== undefined &&
                        step.transaction?.recoveredFromSigner === true &&
                        step.transaction.status === "persisted" &&
                        recovered.transaction.status !== "persisted"
                    ) {
                        return recovered;
                    }
                    return step;
                });
                const keys = new Set(merged.map(
                    (step) => `${step.stage}:${step.transaction?.transactionHash ?? "none"}`
                ));
                const additions = signerSteps.filter(
                    (step) => !keys.has(`${step.stage}:${step.transaction.transactionHash}`)
                );
                if (
                    additions.length === 0 &&
                    canonical(merged) === canonical(existing.lifecycle.steps)
                ) {
                    return existing;
                }
                return {
                    ...existing,
                    lifecycle: {
                        ...existing.lifecycle,
                        steps: [...merged, ...additions],
                    },
                    updatedAt: at,
                };
            }
            return {
                schemaVersion: RECEIPT_VERSION,
                actionId,
                mandateId,
                commitment: commitment.toLowerCase(),
                decision: {
                    decision: "UNAVAILABLE",
                    inference: null,
                    worker: null,
                    limitations: [
                        "This action predates durable sanitized decision receipts. Its encrypted signer ticket remains authoritative.",
                    ],
                },
                snapshot: null,
                lifecycle: {steps: [], latestState: null, lastError: null},
                createdAt: at,
                updatedAt: at,
                ...(signerSteps.length === 0
                    ? {}
                    : {lifecycle: {steps: signerSteps, latestState: null, lastError: null}}),
            };
        }, {skipUnchanged: true});
    }

    async recordStep(step) {
        if (!ACTION_ID.test(step?.actionId ?? "") || typeof step?.stage !== "string") {
            throw new ReceiptStoreError("STEP_INVALID", "durable lifecycle step is invalid");
        }
        return this.#update("lifecycle-step", step.actionId, (existing, at) => {
            if (existing === undefined) {
                throw new ReceiptStoreError("RECEIPT_MISSING", "lifecycle step has no durable decision receipt");
            }
            const publicStep = {
                stage: step.stage,
                commitment: step.commitment,
                transaction: structuredClone(step.transaction),
                before: structuredClone(step.before),
                after: structuredClone(step.after),
                protocolPreflight: structuredClone(step.protocolPreflight ?? null),
            };
            const key = `${publicStep.stage}:${publicStep.transaction?.transactionHash ?? "none"}`;
            const steps = existing.lifecycle.steps.filter(
                (item) => `${item.stage}:${item.transaction?.transactionHash ?? "none"}` !== key
            );
            steps.push(publicStep);
            return {
                ...existing,
                commitment: step.commitment ?? existing.commitment,
                lifecycle: {
                    steps,
                    latestState: structuredClone(step.after),
                    lastError: null,
                },
                updatedAt: at,
            };
        });
    }

    async recordObservation(actionId, state) {
        return this.#update("chain-observation", actionId, (existing, at) => {
            if (existing === undefined) {
                throw new ReceiptStoreError("RECEIPT_MISSING", "chain observation has no durable decision receipt");
            }
            if (canonical(existing.lifecycle.latestState) === canonical(state)) return existing;
            return {
                ...existing,
                lifecycle: {
                    ...existing.lifecycle,
                    latestState: structuredClone(state),
                },
                updatedAt: at,
            };
        }, {skipUnchanged: true});
    }

    async recordError(actionId, error) {
        const code =
            typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
                ? error.code
                : "LIFECYCLE_FAILED";
        const reported = {
            code,
            message: "lifecycle action failed; inspect local diagnostics before retrying",
        };
        return this.#update("lifecycle-error", actionId, (existing, at) => {
            if (existing === undefined) {
                throw new ReceiptStoreError("RECEIPT_MISSING", "lifecycle error has no durable decision receipt");
            }
            if (canonical(existing.lifecycle.lastError) === canonical(reported)) return existing;
            return {
                ...existing,
                lifecycle: {
                    ...existing.lifecycle,
                    lastError: reported,
                },
                updatedAt: at,
            };
        }, {skipUnchanged: true});
    }

    async list() {
        const state = await this.#read();
        return Object.values(state.records)
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            .map((record) => structuredClone(record));
    }

    async get(actionId) {
        if (!ACTION_ID.test(actionId ?? "")) {
            throw new ReceiptStoreError("ACTION_ID_INVALID", "receipt action identifier is invalid");
        }
        const state = await this.#read();
        return state.records[actionId] === undefined ? null : structuredClone(state.records[actionId]);
    }

    async #update(type, actionId, update, {skipUnchanged = false} = {}) {
        if (!ACTION_ID.test(actionId ?? "")) {
            throw new ReceiptStoreError("ACTION_ID_INVALID", "receipt action identifier is invalid");
        }
        const operation = this.queue.then(async () => {
            const state = await this.#read();
            const existing = state.records[actionId];
            const record = update(existing === undefined ? undefined : structuredClone(existing), this.now());
            sanitized(record);
            if (skipUnchanged && existing !== undefined && canonical(record) === canonical(existing)) {
                return structuredClone(existing);
            }
            const unsigned = {
                sequence: state.sequence + 1,
                type,
                actionId,
                at: this.now(),
                recordHash: digest(record),
                previousHash: state.head,
            };
            const event = {...unsigned, hash: digest(unsigned)};
            state.sequence = event.sequence;
            state.head = event.hash;
            state.events.push(event);
            state.records[actionId] = record;
            validateState(state);
            await this.#write(state);
            return structuredClone(record);
        });
        this.queue = operation.catch(() => {});
        return operation;
    }

    async #read() {
        return validateState(JSON.parse(await readFile(this.file, "utf8")));
    }

    async #write(state) {
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
            const handle = await open(temporary, "wx", 0o600);
            try {
                await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
                await handle.sync();
            } finally {
                await handle.close();
            }
            await rename(temporary, this.file);
            const directory = await open(this.directory, "r");
            try {
                await directory.sync();
            } finally {
                await directory.close();
            }
        } finally {
            await rm(temporary, {force: true});
        }
    }
}
