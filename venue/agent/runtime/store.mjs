import {promisify} from "node:util";
import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
    scrypt as scryptCallback,
} from "node:crypto";
import {
    chmod,
    mkdir,
    open,
    readFile,
    rename,
    rm,
    stat,
} from "node:fs/promises";
import path from "node:path";

const scrypt = promisify(scryptCallback);
const STORE_VERSION = "lattice.agent.encrypted-store.v1";
const JOURNAL_VERSION = "lattice.agent.journal.v1";
const AAD = Buffer.from(STORE_VERSION, "utf8");

export class StoreError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "StoreError";
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

function initialData() {
    return {
        mandates: {},
        authority: {},
        tickets: {},
        signedTransactions: {},
        receipts: {},
        signer: {},
    };
}

function initialJournal() {
    return {
        schemaVersion: JOURNAL_VERSION,
        entries: [
            {
                sequence: 0,
                operation: "initialize",
                previousHash: null,
                data: initialData(),
                entryHash: null,
            },
        ],
    };
}

function hashEntry(entry) {
    return digest({
        sequence: entry.sequence,
        operation: entry.operation,
        previousHash: entry.previousHash,
        data: entry.data,
    });
}

function validateJournal(journal) {
    if (
        journal === null ||
        typeof journal !== "object" ||
        Array.isArray(journal) ||
        journal.schemaVersion !== JOURNAL_VERSION ||
        !Array.isArray(journal.entries) ||
        journal.entries.length === 0
    ) {
        throw new StoreError("JOURNAL_INVALID", "encrypted journal structure is invalid");
    }
    let previousHash = null;
    for (let index = 0; index < journal.entries.length; index++) {
        const entry = journal.entries[index];
        if (
            entry === null ||
            typeof entry !== "object" ||
            Array.isArray(entry) ||
            Object.keys(entry).sort().join(",") !== "data,entryHash,operation,previousHash,sequence" ||
            entry.sequence !== index ||
            entry.previousHash !== previousHash ||
            typeof entry.operation !== "string" ||
            !/^[a-z][a-z0-9-]{0,63}$/.test(entry.operation) ||
            entry.data === null ||
            typeof entry.data !== "object" ||
            Array.isArray(entry.data)
        ) {
            throw new StoreError("JOURNAL_INVALID", `journal entry ${index} is invalid`);
        }
        const expected = hashEntry(entry);
        if (entry.entryHash !== expected) {
            throw new StoreError("JOURNAL_HASH_MISMATCH", `journal entry ${index} failed its hash check`);
        }
        previousHash = expected;
    }
    return journal;
}

function finishInitialJournal(journal) {
    journal.entries[0].entryHash = hashEntry(journal.entries[0]);
    return journal;
}

async function deriveKey(passphrase, salt) {
    if (typeof passphrase !== "string" || passphrase.length < 12 || passphrase.length > 1024) {
        throw new StoreError("PASSPHRASE_INVALID", "store passphrase must contain 12 to 1024 characters");
    }
    return scrypt(passphrase, salt, 32, {N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024});
}

async function encrypt(journal, passphrase) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await deriveKey(passphrase, salt);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([
        cipher.update(canonical(journal), "utf8"),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    key.fill(0);
    return {
        schemaVersion: STORE_VERSION,
        kdf: {name: "scrypt", N: 32768, r: 8, p: 1, salt: salt.toString("base64")},
        cipher: {
            name: "aes-256-gcm",
            iv: iv.toString("base64"),
            tag: tag.toString("base64"),
        },
        ciphertext: ciphertext.toString("base64"),
    };
}

function requireEnvelope(envelope) {
    if (
        envelope === null ||
        typeof envelope !== "object" ||
        Array.isArray(envelope) ||
        Object.keys(envelope).sort().join(",") !== "cipher,ciphertext,kdf,schemaVersion" ||
        envelope.schemaVersion !== STORE_VERSION ||
        envelope.kdf?.name !== "scrypt" ||
        envelope.kdf?.N !== 32768 ||
        envelope.kdf?.r !== 8 ||
        envelope.kdf?.p !== 1 ||
        envelope.cipher?.name !== "aes-256-gcm"
    ) {
        throw new StoreError("ENVELOPE_INVALID", "encrypted store envelope is invalid");
    }
}

async function decrypt(envelope, passphrase) {
    requireEnvelope(envelope);
    try {
        const salt = Buffer.from(envelope.kdf.salt, "base64");
        const iv = Buffer.from(envelope.cipher.iv, "base64");
        const tag = Buffer.from(envelope.cipher.tag, "base64");
        if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) {
            throw new StoreError("ENVELOPE_INVALID", "encrypted store parameters have invalid lengths");
        }
        const key = await deriveKey(passphrase, salt);
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(AAD);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([
            decipher.update(Buffer.from(envelope.ciphertext, "base64")),
            decipher.final(),
        ]);
        key.fill(0);
        return validateJournal(JSON.parse(plaintext.toString("utf8")));
    } catch (error) {
        if (error instanceof StoreError && error.code !== "PASSPHRASE_INVALID") throw error;
        throw new StoreError("STORE_UNLOCK_FAILED", "store passphrase or ciphertext is invalid");
    }
}

async function syncDirectory(directory) {
    const handle = await open(directory, "r");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function sleep(milliseconds) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class EncryptedJournalStore {
    constructor({rootDir}) {
        if (typeof rootDir !== "string" || !path.isAbsolute(rootDir)) {
            throw new StoreError("ROOT_INVALID", "store root must be an absolute path");
        }
        this.rootDir = path.resolve(rootDir);
        this.storePath = path.join(this.rootDir, "journal.enc.json");
        this.lockPath = path.join(this.rootDir, "journal.lock");
    }

    async initialize(passphrase) {
        await mkdir(this.rootDir, {recursive: true, mode: 0o700});
        await chmod(this.rootDir, 0o700);
        try {
            await readFile(this.storePath);
            return false;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        const journal = finishInitialJournal(initialJournal());
        await this.#write(journal, passphrase);
        return true;
    }

    async read(passphrase) {
        let envelope;
        try {
            envelope = JSON.parse(await readFile(this.storePath, "utf8"));
        } catch (error) {
            if (error.code === "ENOENT") throw new StoreError("STORE_MISSING", "encrypted store is not initialized");
            throw new StoreError("ENVELOPE_INVALID", "encrypted store cannot be parsed");
        }
        const journal = await decrypt(envelope, passphrase);
        return structuredClone(journal.entries.at(-1).data);
    }

    async transact(passphrase, operation, update) {
        if (typeof update !== "function") {
            throw new StoreError("UPDATE_INVALID", "store transaction requires an update function");
        }
        if (typeof operation !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(operation)) {
            throw new StoreError("OPERATION_INVALID", "store operation name is invalid");
        }
        const lock = await this.#lock();
        try {
            const envelope = JSON.parse(await readFile(this.storePath, "utf8"));
            const journal = await decrypt(envelope, passphrase);
            const current = structuredClone(journal.entries.at(-1).data);
            const returned = await update(current);
            const nextData = returned === undefined ? current : returned;
            if (nextData === null || typeof nextData !== "object" || Array.isArray(nextData)) {
                throw new StoreError("UPDATE_INVALID", "store transaction must produce an object");
            }
            const previous = journal.entries.at(-1);
            const entry = {
                sequence: previous.sequence + 1,
                operation,
                previousHash: previous.entryHash,
                data: structuredClone(nextData),
                entryHash: null,
            };
            entry.entryHash = hashEntry(entry);
            journal.entries.push(entry);
            await this.#write(journal, passphrase);
            return structuredClone(nextData);
        } finally {
            await lock.close();
            await rm(this.lockPath, {force: true});
        }
    }

    async #write(journal, passphrase) {
        validateJournal(journal);
        const envelope = await encrypt(journal, passphrase);
        const temporary = path.join(
            this.rootDir,
            `.journal.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
        );
        const handle = await open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(`${JSON.stringify(envelope)}\n`, "utf8");
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(temporary, this.storePath);
        await chmod(this.storePath, 0o600);
        await syncDirectory(this.rootDir);
    }

    async #lock() {
        for (let attempt = 0; attempt < 100; attempt++) {
            try {
                const handle = await open(this.lockPath, "wx", 0o600);
                await handle.writeFile(
                    JSON.stringify({pid: process.pid, createdAt: Date.now()}),
                    "utf8"
                );
                await handle.sync();
                return handle;
            } catch (error) {
                if (error.code !== "EEXIST") throw error;
                try {
                    const lockStat = await stat(this.lockPath);
                    if (Date.now() - lockStat.mtimeMs > 120_000) {
                        await rm(this.lockPath, {force: true});
                        continue;
                    }
                } catch (inspectionError) {
                    if (inspectionError.code !== "ENOENT") throw inspectionError;
                }
                await sleep(10);
            }
        }
        throw new StoreError("STORE_BUSY", "encrypted store is busy");
    }
}
