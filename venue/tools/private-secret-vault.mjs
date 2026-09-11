import {PRIVATE_SECRET_STORE} from "./ticket-vault.mjs";

export const PRIVATE_SECRET_VAULT_SCHEMA = 1;
export const PRIVATE_SECRET_PAYLOAD_SCHEMA = 1;
export const PRIVATE_SECRET_MAX_NOTES = 128;

const FIELD =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const PRIVATE_SECRET_ADDRESS = /^0x[0-9a-f]{40}$/;
const PRIVATE_SECRET_HASH = /^0x[0-9a-f]{64}$/;
const INTEGER = /^(0|[1-9][0-9]*)$/;

function fail(message) {
    throw new Error(`Private secret vault ${message}.`);
}

function cryptoApi(value = globalThis.crypto) {
    if (!value?.subtle || typeof value.getRandomValues !== "function") {
        fail("cryptography is unavailable");
    }
    return value;
}

function keyOk(key) {
    return !!(
        key
        && key.type === "secret"
        && key.extractable === false
        && String(key.algorithm?.name || "").toUpperCase() === "AES-GCM"
        && key.usages?.includes("encrypt")
        && key.usages?.includes("decrypt")
    );
}

function address(value, label) {
    const result = String(value || "").toLowerCase();
    if (!PRIVATE_SECRET_ADDRESS.test(result)) fail(`${label} is invalid`);
    return result;
}

function integer(value, label, {nonzero = false, maximum = null} = {}) {
    const text = String(value ?? "");
    if (!INTEGER.test(text)) fail(`${label} is invalid`);
    const result = BigInt(text);
    if ((nonzero && result === 0n) || (maximum !== null && result > maximum)) {
        fail(`${label} is invalid`);
    }
    return result.toString();
}

function field(value, label, nonzero = false) {
    const result = BigInt(integer(value, label, {nonzero}));
    if (result >= FIELD) fail(`${label} is invalid`);
    return result.toString();
}

function hash(value, label) {
    const result = String(value || "").toLowerCase();
    if (!PRIVATE_SECRET_HASH.test(result)) fail(`${label} is invalid`);
    return result;
}

function time(value, label) {
    const result = String(value || "");
    if (!Number.isFinite(Date.parse(result))) fail(`${label} is invalid`);
    return result;
}

function base64(value) {
    let binary = "";
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

function bytes(value, label) {
    const text = String(value || "");
    if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) fail(`${label} is invalid`);
    try {
        const binary = atob(text);
        return Uint8Array.from(binary, (item) => item.charCodeAt(0));
    } catch {
        fail(`${label} is invalid`);
    }
}

export function privateSecretScope(chainId, factory, wallet) {
    const chain = integer(chainId, "network", {nonzero: true});
    const canonicalFactory = address(factory, "factory");
    const owner = address(wallet, "owner");
    return {
        id: `${chain}.${canonicalFactory}.${owner}`,
        chainId: chain,
        factory: canonicalFactory,
        wallet: owner,
        aad: [
            "lattice.private-secret-vault.v1",
            `chainId:${chain}`,
            `factory:${canonicalFactory}`,
            `wallet:${owner}`,
        ].join("\n"),
    };
}

export function validatePrivateCredential(value) {
    if (value === null) return null;
    if (value === undefined || typeof value !== "object" || Array.isArray(value)) {
        fail("credential is invalid");
    }
    if (
        !Array.isArray(value.pathElements)
        || value.pathElements.length !== 16
        || !Array.isArray(value.pathIndices)
        || value.pathIndices.length !== 16
    ) {
        fail("credential path is invalid");
    }
    const pathElements = value.pathElements.map((item, index) =>
        field(item, `credential path element ${index}`));
    const pathIndices = value.pathIndices.map((item, index) => {
        const bit = integer(item, `credential path direction ${index}`, {maximum: 1n});
        return bit;
    });
    return {
        v: 1,
        holderSecret: field(value.holderSecret, "holder secret", true),
        credentialId: field(value.credentialId, "credential id"),
        jurisdiction: field(value.jurisdiction, "jurisdiction"),
        tier: field(value.tier, "tier"),
        validUntilEpoch: field(value.validUntilEpoch, "valid-until epoch"),
        holderSecretCommitment:
            field(value.holderSecretCommitment, "holder-secret commitment", true),
        credentialRoot: field(value.credentialRoot, "credential root", true),
        pathElements,
        pathIndices,
        issuedAt: time(value.issuedAt, "credential issue time"),
    };
}

export function validatePrivateRoutingNote(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        fail("routing note is invalid");
    }
    const asset = String(value.asset || "").toUpperCase();
    if (!["HBAR", "LPRC"].includes(asset)) fail("routing note asset is invalid");
    const state = String(value.state || "");
    if (!["PREPARED", "DEPOSITED", "SPENT", "RECOVERED"].includes(state)) {
        fail("routing note state is invalid");
    }
    const deposited = state !== "PREPARED";
    const leafIndex = value.leafIndex === null || value.leafIndex === undefined
        ? null
        : integer(value.leafIndex, "routing note leaf", {maximum: (1n << 20n) - 1n});
    const depositRoot = value.depositRoot ? field(value.depositRoot, "routing root", true) : null;
    const depositTx = value.depositTx ? hash(value.depositTx, "routing receipt") : null;
    if (deposited && (leafIndex === null || depositRoot === null || depositTx === null)) {
        fail("deposited routing note metadata is incomplete");
    }
    if (!deposited && (leafIndex !== null || depositRoot !== null || depositTx !== null)) {
        fail("prepared routing note has deposit metadata");
    }
    return {
        v: 1,
        asset,
        state,
        pool: address(value.pool, "routing pool"),
        denomination: field(value.denomination, "routing denomination", true),
        commitment: field(value.commitment, "routing commitment", true),
        noteSecret: field(value.noteSecret, "routing note secret", true),
        noteNullifier: field(value.noteNullifier, "routing note nullifier", true),
        fundingTag: field(value.fundingTag, "routing funding tag"),
        leafIndex,
        depositRoot,
        depositTx,
        createdAt: time(value.createdAt, "routing note creation time"),
        spentAt: value.spentAt ? time(value.spentAt, "routing note spend time") : null,
    };
}

export function validatePrivateSecretPayload(value) {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || Number(value.v) !== PRIVATE_SECRET_PAYLOAD_SCHEMA
        || !Array.isArray(value.notes)
        || value.notes.length > PRIVATE_SECRET_MAX_NOTES
    ) {
        fail("payload is invalid");
    }
    const notes = value.notes.map(validatePrivateRoutingNote);
    const commitments = new Set();
    for (const note of notes) {
        if (commitments.has(note.commitment)) fail("contains duplicate routing notes");
        commitments.add(note.commitment);
    }
    return {
        v: PRIVATE_SECRET_PAYLOAD_SCHEMA,
        credential: validatePrivateCredential(value.credential ?? null),
        notes,
    };
}

export async function encryptPrivateSecrets(
    key,
    scope,
    payload,
    cryptoImpl = globalThis.crypto,
) {
    if (!keyOk(key)) fail("encryption key is unusable");
    const crypto = cryptoApi(cryptoImpl);
    const canonical = validatePrivateSecretPayload(payload);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt(
        {
            name: "AES-GCM",
            iv,
            additionalData: encoder.encode(scope.aad),
            tagLength: 128,
        },
        key,
        encoder.encode(JSON.stringify(canonical)),
    );
    return {
        v: PRIVATE_SECRET_VAULT_SCHEMA,
        chainId: scope.chainId,
        factory: scope.factory,
        wallet: scope.wallet,
        iv: base64(iv),
        ciphertext: base64(ciphertext),
    };
}

export async function decryptPrivateSecrets(
    key,
    scope,
    envelope,
    cryptoImpl = globalThis.crypto,
) {
    if (!keyOk(key)) fail("encryption key is unusable");
    if (
        envelope === null
        || typeof envelope !== "object"
        || Array.isArray(envelope)
        || Number(envelope.v) !== PRIVATE_SECRET_VAULT_SCHEMA
        || String(envelope.chainId) !== scope.chainId
        || String(envelope.factory || "").toLowerCase() !== scope.factory
        || String(envelope.wallet || "").toLowerCase() !== scope.wallet
    ) {
        fail("envelope belongs to another scope");
    }
    const iv = bytes(envelope.iv, "initialization vector");
    const ciphertext = bytes(envelope.ciphertext, "ciphertext");
    if (iv.length !== 12 || ciphertext.length < 17) fail("envelope dimensions are invalid");
    let clear;
    try {
        clear = await cryptoApi(cryptoImpl).subtle.decrypt(
            {
                name: "AES-GCM",
                iv,
                additionalData: new TextEncoder().encode(scope.aad),
                tagLength: 128,
            },
            key,
            ciphertext,
        );
    } catch {
        fail("envelope could not be authenticated");
    }
    try {
        return validatePrivateSecretPayload(
            JSON.parse(new TextDecoder().decode(clear)),
        );
    } catch {
        fail("payload is invalid");
    }
}

export async function savePrivateSecrets({
    key,
    scope,
    payload,
    read,
    write,
    cryptoImpl = globalThis.crypto,
}) {
    if (typeof read !== "function" || typeof write !== "function") {
        fail("storage adapters are unavailable");
    }
    const envelope = await encryptPrivateSecrets(key, scope, payload, cryptoImpl);
    await write(PRIVATE_SECRET_STORE, scope.id, envelope);
    const stored = await read(PRIVATE_SECRET_STORE, scope.id);
    const verified = await decryptPrivateSecrets(key, scope, stored, cryptoImpl);
    if (
        JSON.stringify(verified)
        !== JSON.stringify(validatePrivateSecretPayload(payload))
    ) {
        fail("readback did not verify");
    }
    return verified;
}
