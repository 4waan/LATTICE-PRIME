import {PRIVATE_SESSION_STORE} from "./ticket-vault.mjs";

export const PRIVATE_SESSION_VAULT_SCHEMA = 1;
export const PRIVATE_SESSION_PAYLOAD_SCHEMA = 1;
export const PRIVATE_SESSION_MAX_HISTORY = 8;

const PRIVATE_SESSION_ADDRESS = /^0x[0-9a-f]{40}$/;
const PRIVATE_SESSION_HASH = /^0x[0-9a-f]{64}$/;
const PRIVATE_SESSION_PRIVATE_KEY = /^0x[0-9a-f]{64}$/;

function sessionCrypto(cryptoImpl = globalThis.crypto) {
    if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== "function") {
        throw new Error("Private session storage is unavailable in this browser.");
    }
    return cryptoImpl;
}

function privateSessionAddress(value, name) {
    const result = String(value || "").toLowerCase();
    if (!PRIVATE_SESSION_ADDRESS.test(result)) throw new Error(`Private session ${name} is invalid.`);
    return result;
}

function privateSessionChainId(value) {
    const result = String(value ?? "");
    if (!/^[1-9][0-9]*$/.test(result)) {
        throw new Error("Private session network is invalid.");
    }
    return result;
}

function privateSessionBase64(bytes) {
    let binary = "";
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let offset = 0; offset < view.length; offset += 0x8000) {
        binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

function privateSessionBytes(value, name) {
    const text = String(value || "");
    if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
        throw new Error(`Encrypted private session ${name} is invalid.`);
    }
    try {
        const binary = atob(text);
        return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    } catch {
        throw new Error(`Encrypted private session ${name} is invalid.`);
    }
}

function privateSessionVaultKey(key) {
    if (
        !key
        || key.type !== "secret"
        || key.extractable !== false
        || String(key.algorithm?.name || "").toUpperCase() !== "AES-GCM"
        || !key.usages?.includes("encrypt")
        || !key.usages?.includes("decrypt")
    ) {
        throw new Error("Private session encryption key is unusable.");
    }
    return key;
}

function privateSessionWallet(privateKey, ethersImpl) {
    if (!ethersImpl?.Wallet) throw new Error("Private session signer support is unavailable.");
    try {
        return new ethersImpl.Wallet(privateKey);
    } catch {
        throw new Error("Private session key material is invalid.");
    }
}

function privateSessionTime(value, name) {
    const result = String(value || "");
    if (!result || !Number.isFinite(Date.parse(result))) {
        throw new Error(`Private session ${name} is invalid.`);
    }
    return result;
}

export function privateSessionScope(network, factory, wallet) {
    const chain = privateSessionChainId(network);
    const canonicalFactory = privateSessionAddress(factory, "factory");
    const localWallet = privateSessionAddress(wallet, "local vault owner");
    return {
        id: `${chain}.${canonicalFactory}.${localWallet}`,
        chainId: chain,
        factory: canonicalFactory,
        wallet: localWallet,
        aad: [
            "lattice.private-session-vault.v1",
            `chainId:${chain}`,
            `factory:${canonicalFactory}`,
            `wallet:${localWallet}`,
        ].join("\n"),
    };
}

export function validatePrivateSession(record, ethersImpl = globalThis.ethers) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
        throw new Error("Private session record is invalid.");
    }
    const generation = Number(record.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new Error("Private session generation is invalid.");
    }
    const state = String(record.state || "");
    if (!["PENDING", "ACTIVE", "RETIRING", "RECOVERED"].includes(state)) {
        throw new Error("Private session state is invalid.");
    }
    const sessionPrivateKey = String(record.sessionPrivateKey || "").toLowerCase();
    const recoveryPrivateKey = String(record.recoveryPrivateKey || "").toLowerCase();
    if (!PRIVATE_SESSION_PRIVATE_KEY.test(sessionPrivateKey) || !PRIVATE_SESSION_PRIVATE_KEY.test(recoveryPrivateKey)) {
        throw new Error("Private session key material is invalid.");
    }
    const sessionWallet = privateSessionWallet(sessionPrivateKey, ethersImpl);
    const recoveryWallet = privateSessionWallet(recoveryPrivateKey, ethersImpl);
    const signer = privateSessionAddress(record.signer, "signer");
    const recovery = privateSessionAddress(record.recovery, "recovery signer");
    if (sessionWallet.address.toLowerCase() !== signer) {
        throw new Error("Private session signer does not match its key.");
    }
    if (recoveryWallet.address.toLowerCase() !== recovery) {
        throw new Error("Private session recovery signer does not match its key.");
    }
    if (signer === recovery) {
        throw new Error("Private session and recovery signers must differ.");
    }
    const account = privateSessionAddress(record.account, "account");
    const deploymentSalt = String(record.deploymentSalt || "").toLowerCase();
    if (!PRIVATE_SESSION_HASH.test(deploymentSalt)) throw new Error("Private session deployment salt is invalid.");
    return {
        v: PRIVATE_SESSION_PAYLOAD_SCHEMA,
        generation,
        state,
        account,
        signer,
        recovery,
        sessionPrivateKey,
        recoveryPrivateKey,
        deploymentSalt,
        createdAt: privateSessionTime(record.createdAt, "creation time"),
        retiredAt: record.retiredAt ? privateSessionTime(record.retiredAt, "retirement time") : null,
    };
}

function validatePrivateSessionPayload(payload, ethersImpl) {
    if (
        payload === null
        || typeof payload !== "object"
        || Array.isArray(payload)
        || Number(payload.v) !== PRIVATE_SESSION_PAYLOAD_SCHEMA
        || !Array.isArray(payload.sessions)
        || payload.sessions.length > PRIVATE_SESSION_MAX_HISTORY
    ) {
        throw new Error("Private session vault payload is invalid.");
    }
    const sessions = payload.sessions.map((record) => validatePrivateSession(record, ethersImpl));
    const accounts = new Set();
    const generations = new Set();
    for (const session of sessions) {
        if (accounts.has(session.account) || generations.has(session.generation)) {
            throw new Error("Private session vault has duplicate history.");
        }
        accounts.add(session.account);
        generations.add(session.generation);
    }
    const live = sessions.filter((session) =>
        session.state === "PENDING" || session.state === "ACTIVE");
    if (live.length > 1) {
        throw new Error("Private session vault has multiple active or pending sessions.");
    }
    return {v: PRIVATE_SESSION_PAYLOAD_SCHEMA, sessions};
}

export async function generatePrivateSessionKeys(
    ethersImpl = globalThis.ethers,
    cryptoImpl = globalThis.crypto,
) {
    const cryptoApi = sessionCrypto(cryptoImpl);
    const next = () => {
        for (let attempt = 0; attempt < 128; attempt++) {
            const candidate = cryptoApi.getRandomValues(new Uint8Array(32));
            const privateKey = `0x${[...candidate]
                .map((value) => value.toString(16).padStart(2, "0"))
                .join("")}`;
            try {
                const wallet = privateSessionWallet(privateKey, ethersImpl);
                return {privateKey, address: wallet.address.toLowerCase()};
            } catch {
                continue;
            }
        }
        throw new Error("Private session key generation failed.");
    };
    const session = next();
    let recovery = next();
    while (recovery.address === session.address) recovery = next();
    return {
        sessionPrivateKey: session.privateKey,
        signer: session.address,
        recoveryPrivateKey: recovery.privateKey,
        recovery: recovery.address,
    };
}

export async function encryptPrivateSessions(
    key,
    scope,
    payload,
    cryptoImpl = globalThis.crypto,
    ethersImpl = globalThis.ethers,
) {
    const cryptoApi = sessionCrypto(cryptoImpl);
    privateSessionVaultKey(key);
    const canonical = validatePrivateSessionPayload(payload, ethersImpl);
    const iv = cryptoApi.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder();
    const ciphertext = await cryptoApi.subtle.encrypt(
        {
            name: "AES-GCM",
            iv,
            additionalData: encoded.encode(scope.aad),
            tagLength: 128,
        },
        key,
        encoded.encode(JSON.stringify(canonical)),
    );
    return {
        v: PRIVATE_SESSION_VAULT_SCHEMA,
        chainId: scope.chainId,
        factory: scope.factory,
        wallet: scope.wallet,
        iv: privateSessionBase64(iv),
        ciphertext: privateSessionBase64(ciphertext),
    };
}

export async function decryptPrivateSessions(
    key,
    scope,
    envelope,
    cryptoImpl = globalThis.crypto,
    ethersImpl = globalThis.ethers,
) {
    const cryptoApi = sessionCrypto(cryptoImpl);
    privateSessionVaultKey(key);
    if (
        envelope === null
        || typeof envelope !== "object"
        || Array.isArray(envelope)
        || Number(envelope.v) !== PRIVATE_SESSION_VAULT_SCHEMA
        || String(envelope.chainId) !== scope.chainId
        || String(envelope.factory || "").toLowerCase() !== scope.factory
        || String(envelope.wallet || "").toLowerCase() !== scope.wallet
    ) {
        throw new Error("Encrypted private session belongs to another scope.");
    }
    const iv = privateSessionBytes(envelope.iv, "initialization vector");
    const ciphertext = privateSessionBytes(envelope.ciphertext, "ciphertext");
    if (iv.length !== 12 || ciphertext.length < 17) {
        throw new Error("Encrypted private session dimensions are invalid.");
    }
    let plaintext;
    try {
        plaintext = await cryptoApi.subtle.decrypt(
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
        throw new Error("Encrypted private session could not be authenticated.");
    }
    try {
        return validatePrivateSessionPayload(
            JSON.parse(new TextDecoder().decode(plaintext)),
            ethersImpl,
        );
    } catch (error) {
        if (/could not be authenticated/.test(String(error?.message || ""))) throw error;
        throw new Error("Encrypted private session payload is invalid.");
    }
}

export async function savePrivateSessions({
    key,
    scope,
    payload,
    read,
    write,
    cryptoImpl = globalThis.crypto,
    ethersImpl = globalThis.ethers,
}) {
    if (typeof read !== "function" || typeof write !== "function") {
        throw new Error("Private session storage adapters are required.");
    }
    const envelope = await encryptPrivateSessions(key, scope, payload, cryptoImpl, ethersImpl);
    await write(PRIVATE_SESSION_STORE, scope.id, envelope);
    const stored = await read(PRIVATE_SESSION_STORE, scope.id);
    const verified = await decryptPrivateSessions(key, scope, stored, cryptoImpl, ethersImpl);
    if (JSON.stringify(verified) !== JSON.stringify(validatePrivateSessionPayload(payload, ethersImpl))) {
        throw new Error("Encrypted private session did not verify after saving.");
    }
    return verified;
}

export function publicPrivateSession(record, ethersImpl = globalThis.ethers) {
    const session = validatePrivateSession(record, ethersImpl);
    return {
        generation: session.generation,
        state: session.state,
        account: session.account,
        signer: session.signer,
        recovery: session.recovery,
        deploymentSalt: session.deploymentSalt,
        createdAt: session.createdAt,
        retiredAt: session.retiredAt,
    };
}
