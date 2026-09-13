// Holder credential store for the eligibility-linked claim.
//
// One file, several trees. The on-chain session root is write-once per
// rotation epoch, so a leaf cannot be appended when a wallet asks for one.
// Instead each tree is issued ahead of time with a pool of unbound leaves, and
// the worker binds a leaf to a wallet at claim time. The tree is chosen by the
// root the gate publishes for the current epoch, which is why the store keeps
// the epoch-8 tree next to the pooled one rather than replacing it.
//
// Only node built-ins here: the worker image copies agent/runtime/private-*.mjs
// and nothing from tools/.
import {chmod, mkdir, readFile, rename, unlink, writeFile} from "node:fs/promises";
import path from "node:path";

export const PRIVATE_CREDENTIAL_STORE_VERSION = 2;
export const PRIVATE_CREDENTIAL_DEPTH = 16;

const FIELD =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const CREDENTIAL_KEYS = Object.freeze([
    "credentialId",
    "credentialRoot",
    "holderSecret",
    "holderSecretCommitment",
    "issuedAt",
    "jurisdiction",
    "pathElements",
    "pathIndices",
    "tier",
    "v",
    "validUntilEpoch",
]);

export class PrivateCredentialStoreError extends Error {
    constructor(code, status = 500) {
        super("private credential store operation failed");
        this.name = "PrivateCredentialStoreError";
        this.code = code;
        this.status = status;
    }
}

function fail(code, status = 500) {
    throw new PrivateCredentialStoreError(code, status);
}

function plainObject(value) {
    return value !== null
        && typeof value === "object"
        && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function decimal(value, {nonzero = false, limit = null} = {}) {
    if (typeof value !== "string" || !DECIMAL.test(value)) {
        fail("CREDENTIAL_STORE_INVALID");
    }
    const parsed = BigInt(value);
    if ((nonzero && parsed === 0n) || (limit !== null && parsed >= limit)) {
        fail("CREDENTIAL_STORE_INVALID");
    }
    return value;
}

function field(value, nonzero = false) {
    return decimal(value, {nonzero, limit: FIELD});
}

function isoTime(value) {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
        fail("CREDENTIAL_STORE_INVALID");
    }
    return value;
}

function wallet(value) {
    if (typeof value !== "string" || !ADDRESS.test(value)) {
        fail("CREDENTIAL_STORE_INVALID");
    }
    return value;
}

function root(value) {
    return field(value, true);
}

// The issued shape carries `wallet` for bound holders; the store drops it
// because the binding lives in the tree, keyed by wallet, not in the leaf.
export function normalizePrivateCredential(value) {
    if (!plainObject(value)) fail("CREDENTIAL_STORE_INVALID");
    const keys = Object.keys(value).filter((key) => key !== "wallet").sort();
    if (keys.join(",") !== CREDENTIAL_KEYS.join(",")) fail("CREDENTIAL_STORE_INVALID");
    if (value.v !== 1) fail("CREDENTIAL_STORE_INVALID");
    if (
        !Array.isArray(value.pathElements)
        || value.pathElements.length !== PRIVATE_CREDENTIAL_DEPTH
        || !Array.isArray(value.pathIndices)
        || value.pathIndices.length !== PRIVATE_CREDENTIAL_DEPTH
    ) {
        fail("CREDENTIAL_STORE_INVALID");
    }
    return Object.freeze({
        v: 1,
        holderSecret: field(value.holderSecret, true),
        credentialId: field(value.credentialId),
        jurisdiction: field(value.jurisdiction),
        tier: field(value.tier),
        validUntilEpoch: field(value.validUntilEpoch),
        holderSecretCommitment: field(value.holderSecretCommitment, true),
        credentialRoot: root(value.credentialRoot),
        pathElements: Object.freeze(value.pathElements.map((item) => field(item))),
        pathIndices: Object.freeze(value.pathIndices.map((item) =>
            decimal(item, {limit: 2n}))),
        issuedAt: isoTime(value.issuedAt),
    });
}

function normalizeTree(value, expectedRoot) {
    if (
        !plainObject(value)
        || Object.keys(value).sort().join(",") !== "bound,depth,issuedAt,pool"
        || value.depth !== PRIVATE_CREDENTIAL_DEPTH
        || !plainObject(value.bound)
        || !Array.isArray(value.pool)
    ) {
        fail("CREDENTIAL_STORE_INVALID");
    }
    const bound = {};
    for (const [owner, entry] of Object.entries(value.bound)) {
        if (
            !plainObject(entry)
            || Object.keys(entry).sort().join(",") !== "boundAt,credential"
        ) {
            fail("CREDENTIAL_STORE_INVALID");
        }
        const credential = normalizePrivateCredential(entry.credential);
        if (credential.credentialRoot !== expectedRoot) fail("CREDENTIAL_STORE_INVALID");
        bound[wallet(owner)] = Object.freeze({
            credential,
            boundAt: isoTime(entry.boundAt),
        });
    }
    const pool = value.pool.map((entry) => {
        if (
            !plainObject(entry)
            || Object.keys(entry).join(",") !== "credential"
        ) {
            fail("CREDENTIAL_STORE_INVALID");
        }
        const credential = normalizePrivateCredential(entry.credential);
        if (credential.credentialRoot !== expectedRoot) fail("CREDENTIAL_STORE_INVALID");
        return Object.freeze({credential});
    });
    const secrets = [
        ...Object.values(bound).map((entry) => entry.credential.holderSecret),
        ...pool.map((entry) => entry.credential.holderSecret),
    ];
    if (new Set(secrets).size !== secrets.length) fail("CREDENTIAL_STORE_INVALID");
    return Object.freeze({
        depth: PRIVATE_CREDENTIAL_DEPTH,
        issuedAt: isoTime(value.issuedAt),
        bound: Object.freeze(bound),
        pool: Object.freeze(pool),
    });
}

// v1 was a flat `{wallet: {credential}}` written by the bootstrap. It becomes
// one tree per root with an empty pool, so the epoch-8 bindings keep serving.
function normalizeLegacy(value) {
    const trees = {};
    for (const [owner, entry] of Object.entries(value)) {
        if (
            !plainObject(entry)
            || Object.keys(entry).join(",") !== "credential"
        ) {
            fail("CREDENTIAL_STORE_INVALID");
        }
        const credential = normalizePrivateCredential(entry.credential);
        const key = credential.credentialRoot;
        const tree = trees[key] ?? {
            depth: PRIVATE_CREDENTIAL_DEPTH,
            issuedAt: credential.issuedAt,
            bound: {},
            pool: [],
        };
        tree.bound[wallet(owner)] = {credential, boundAt: credential.issuedAt};
        trees[key] = tree;
    }
    return {v: PRIVATE_CREDENTIAL_STORE_VERSION, trees};
}

export function normalizePrivateCredentialStore(value) {
    if (!plainObject(value)) fail("CREDENTIAL_STORE_INVALID");
    const shaped = value.v === PRIVATE_CREDENTIAL_STORE_VERSION
        ? value
        : normalizeLegacy(value);
    if (
        Object.keys(shaped).sort().join(",") !== "trees,v"
        || !plainObject(shaped.trees)
    ) {
        fail("CREDENTIAL_STORE_INVALID");
    }
    const trees = {};
    for (const [key, tree] of Object.entries(shaped.trees)) {
        trees[root(key)] = normalizeTree(tree, key);
    }
    return Object.freeze({
        v: PRIVATE_CREDENTIAL_STORE_VERSION,
        trees: Object.freeze(trees),
    });
}

export function selectPrivateCredentialTree(store, liveRoot) {
    let key;
    try {
        key = BigInt(liveRoot).toString();
    } catch {
        return null;
    }
    if (key === "0") return null;
    return store?.trees?.[key] ?? null;
}

export function boundPrivateCredential(store, liveRoot, owner) {
    const tree = selectPrivateCredentialTree(store, liveRoot);
    return tree?.bound?.[wallet(owner)]?.credential ?? null;
}

// Pops the first pool leaf for `owner`, or returns the existing binding. The
// caller decides whether the wallet is entitled before calling this; the
// store only keeps the bookkeeping honest.
export function bindPrivateCredential(store, liveRoot, owner, nowIso) {
    const normalized = normalizePrivateCredentialStore(store);
    const account = wallet(owner);
    const key = BigInt(liveRoot).toString();
    const tree = selectPrivateCredentialTree(normalized, key);
    if (tree === null) fail("ROOT_NOT_ACTIVE", 409);
    const existing = tree.bound[account];
    if (existing) {
        return Object.freeze({
            store: normalized,
            credential: existing.credential,
            changed: false,
        });
    }
    if (tree.pool.length === 0) fail("POOL_EXHAUSTED", 409);
    const [first, ...rest] = tree.pool;
    const next = normalizePrivateCredentialStore({
        v: PRIVATE_CREDENTIAL_STORE_VERSION,
        trees: {
            ...normalized.trees,
            [key]: {
                depth: tree.depth,
                issuedAt: tree.issuedAt,
                bound: {
                    ...tree.bound,
                    [account]: {credential: first.credential, boundAt: isoTime(nowIso)},
                },
                pool: rest,
            },
        },
    });
    return Object.freeze({
        store: next,
        credential: first.credential,
        changed: true,
    });
}

// From the issuer's output (`issuePrivateSessionCredentials`): entries with a
// wallet are bound from the start, the rest form the pool.
export function buildPrivateCredentialTree(issued) {
    if (
        !plainObject(issued)
        || issued.depth !== PRIVATE_CREDENTIAL_DEPTH
        || !Array.isArray(issued.credentials)
        || issued.credentials.length === 0
    ) {
        fail("CREDENTIAL_STORE_INVALID");
    }
    const bound = {};
    const pool = [];
    for (const item of issued.credentials) {
        if (!plainObject(item)) fail("CREDENTIAL_STORE_INVALID");
        const credential = normalizePrivateCredential(item);
        if (credential.credentialRoot !== root(issued.root)) {
            fail("CREDENTIAL_STORE_INVALID");
        }
        const owner = item.wallet === undefined || item.wallet === ""
            ? null
            : wallet(String(item.wallet).toLowerCase());
        if (owner === null) {
            pool.push({credential});
        } else {
            if (bound[owner]) fail("CREDENTIAL_STORE_INVALID");
            bound[owner] = {credential, boundAt: credential.issuedAt};
        }
    }
    return normalizeTree({
        depth: PRIVATE_CREDENTIAL_DEPTH,
        issuedAt: issued.credentials[0].issuedAt,
        bound,
        pool,
    }, root(issued.root));
}

export async function readPrivateCredentialStore(filePath) {
    let text;
    try {
        text = await readFile(filePath, "utf8");
    } catch {
        fail("CREDENTIAL_STORE_UNAVAILABLE", 503);
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        fail("CREDENTIAL_STORE_INVALID");
    }
    return normalizePrivateCredentialStore(parsed);
}

export async function writePrivateCredentialStore(filePath, store) {
    const normalized = normalizePrivateCredentialStore(store);
    const target = path.resolve(filePath);
    const temporary = `${target}.tmp`;
    try {
        await mkdir(path.dirname(target), {recursive: true, mode: 0o700});
        await writeFile(
            temporary,
            `${JSON.stringify(normalized, null, 2)}\n`,
            {mode: 0o600, flag: "w"},
        );
        await chmod(temporary, 0o600);
        await rename(temporary, target);
    } catch {
        await unlink(temporary).catch(() => {});
        fail("CREDENTIAL_STORE_UNAVAILABLE", 503);
    }
    return normalized;
}
