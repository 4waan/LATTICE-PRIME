// Device-local encryption for private order preimages.
// The browser build inlines this file before venue-app.mjs.

export const TICKET_VAULT_DB = "seamme.vault";
export const TICKET_VAULT_DB_VERSION = 4;
export const TICKET_VAULT_HANDLE_STORE = "handles";
export const TICKET_VAULT_KEY_STORE = "keys";
export const TICKET_VAULT_DATA_STORE = "tickets";
export const PRIVATE_SESSION_STORE = "private-sessions";
export const PRIVATE_SECRET_STORE = "private-secrets";
export const TICKET_VAULT_SCHEMA = 2;
const TICKET_VAULT_PAYLOAD_SCHEMA = 1;
const TICKET_VAULT_MAX_RECORDS = 500;

function ticketVaultCrypto(cryptoImpl = globalThis.crypto) {
    if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== "function") {
        throw new Error("Encrypted device storage is unavailable in this browser.");
    }
    return cryptoImpl;
}

function ticketVaultAddress(value, label) {
    const address = String(value || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
        throw new Error("The ticket vault has an invalid " + label + ".");
    }
    return address;
}

export function ticketVaultScope(chainId, engine, account) {
    const chain = String(chainId);
    if (!/^\d+$/.test(chain)) throw new Error("The ticket vault has an invalid network.");
    const market = ticketVaultAddress(engine, "market contract");
    const owner = ticketVaultAddress(account, "account");
    return {
        id: chain + "." + market + "." + owner,
        chainId: chain,
        engine: market,
        account: owner,
        aad: [
            "seamme.ticket-vault.v2",
            "chainId:" + chain,
            "engine:" + market,
            "account:" + owner,
        ].join("\n"),
    };
}

function ticketVaultBase64(bytes) {
    let binary = "";
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let offset = 0; offset < view.length; offset += 0x8000) {
        binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

function ticketVaultBytes(value, label) {
    const text = String(value || "");
    if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
        throw new Error("The encrypted ticket vault has invalid " + label + ".");
    }
    try {
        const binary = atob(text);
        return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    } catch {
        throw new Error("The encrypted ticket vault has invalid " + label + ".");
    }
}

function ticketVaultKeyOk(key) {
    return !!(
        key
        && key.type === "secret"
        && key.extractable === false
        && String(key.algorithm?.name || "").toUpperCase() === "AES-GCM"
        && key.usages?.includes("encrypt")
        && key.usages?.includes("decrypt")
    );
}

export async function generateTicketVaultKey(cryptoImpl = globalThis.crypto) {
    const cryptoApi = ticketVaultCrypto(cryptoImpl);
    return cryptoApi.subtle.generateKey(
        {name: "AES-GCM", length: 256},
        false,
        ["encrypt", "decrypt"],
    );
}

export async function encryptTicketVault(key, scope, tickets, cryptoImpl = globalThis.crypto) {
    const cryptoApi = ticketVaultCrypto(cryptoImpl);
    if (!ticketVaultKeyOk(key)) throw new Error("The ticket vault key is not usable.");
    if (!Array.isArray(tickets) || tickets.length > TICKET_VAULT_MAX_RECORDS) {
        throw new Error("The ticket vault contains an invalid order list.");
    }
    const iv = cryptoApi.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder();
    const plaintext = encoded.encode(JSON.stringify({
        v: TICKET_VAULT_PAYLOAD_SCHEMA,
        tickets,
    }));
    const ciphertext = await cryptoApi.subtle.encrypt(
        {
            name: "AES-GCM",
            iv,
            additionalData: encoded.encode(scope.aad),
            tagLength: 128,
        },
        key,
        plaintext,
    );
    return {
        v: TICKET_VAULT_SCHEMA,
        chainId: scope.chainId,
        engine: scope.engine,
        account: scope.account,
        iv: ticketVaultBase64(iv),
        ciphertext: ticketVaultBase64(ciphertext),
    };
}

export async function decryptTicketVault(key, scope, envelope, cryptoImpl = globalThis.crypto) {
    const cryptoApi = ticketVaultCrypto(cryptoImpl);
    if (!ticketVaultKeyOk(key)) throw new Error("The ticket vault key is not usable.");
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
        throw new Error("The encrypted ticket vault is invalid.");
    }
    if (
        Number(envelope.v) !== TICKET_VAULT_SCHEMA
        || String(envelope.chainId) !== scope.chainId
        || String(envelope.engine || "").toLowerCase() !== scope.engine
        || String(envelope.account || "").toLowerCase() !== scope.account
    ) {
        throw new Error("The encrypted ticket vault belongs to another account or market.");
    }
    const iv = ticketVaultBytes(envelope.iv, "initialization vector");
    const ciphertext = ticketVaultBytes(envelope.ciphertext, "ciphertext");
    if (iv.length !== 12 || ciphertext.length < 16) {
        throw new Error("The encrypted ticket vault has invalid dimensions.");
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
        throw new Error("The encrypted ticket vault could not be authenticated.");
    }
    let payload;
    try {
        payload = JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
        throw new Error("The encrypted ticket vault contains invalid data.");
    }
    if (
        Number(payload?.v) !== TICKET_VAULT_PAYLOAD_SCHEMA
        || !Array.isArray(payload?.tickets)
        || payload.tickets.length > TICKET_VAULT_MAX_RECORDS
    ) {
        throw new Error("The encrypted ticket vault contains an invalid order list.");
    }
    return payload.tickets;
}

export function openTicketVaultDb(factory = globalThis.indexedDB) {
    if (!factory?.open) {
        return Promise.reject(new Error("Encrypted device storage is unavailable in this browser."));
    }
    return new Promise((resolve, reject) => {
        let request;
        try {
            request = factory.open(TICKET_VAULT_DB, TICKET_VAULT_DB_VERSION);
        } catch {
            reject(new Error("Encrypted device storage could not be opened."));
            return;
        }
        request.onupgradeneeded = () => {
            const db = request.result;
            for (const name of [
                TICKET_VAULT_HANDLE_STORE,
                TICKET_VAULT_KEY_STORE,
                TICKET_VAULT_DATA_STORE,
                PRIVATE_SESSION_STORE,
                PRIVATE_SECRET_STORE,
            ]) {
                if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Encrypted device storage could not be opened."));
        request.onblocked = () => reject(new Error("Encrypted device storage is blocked by another tab."));
    });
}

function ticketVaultRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Encrypted device storage failed."));
    });
}

async function readTicketVaultState(id, factory) {
    const db = await openTicketVaultDb(factory);
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction(
                [TICKET_VAULT_KEY_STORE, TICKET_VAULT_DATA_STORE],
                "readonly",
            );
            const keyRequest = transaction.objectStore(TICKET_VAULT_KEY_STORE).get(id);
            const dataRequest = transaction.objectStore(TICKET_VAULT_DATA_STORE).get(id);
            let key;
            let envelope;
            keyRequest.onsuccess = () => {
                key = keyRequest.result;
            };
            dataRequest.onsuccess = () => {
                envelope = dataRequest.result;
            };
            transaction.oncomplete = () => resolve({key, envelope});
            transaction.onerror = () =>
                reject(transaction.error || new Error("Encrypted device storage failed."));
            transaction.onabort = () =>
                reject(transaction.error || new Error("Encrypted device storage was interrupted."));
        });
    } finally {
        db.close();
    }
}

async function installTicketVaultKey(id, candidate, factory) {
    const db = await openTicketVaultDb(factory);
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction(
                [TICKET_VAULT_KEY_STORE, TICKET_VAULT_DATA_STORE],
                "readwrite",
            );
            const keyStore = transaction.objectStore(TICKET_VAULT_KEY_STORE);
            const dataStore = transaction.objectStore(TICKET_VAULT_DATA_STORE);
            const keyRequest = keyStore.get(id);
            const dataRequest = dataStore.get(id);
            let key;
            let envelope;
            let reads = 0;
            let problem = null;
            const ready = () => {
                reads++;
                if (reads !== 2) return;
                if (!key && envelope) {
                    problem = new Error("The encrypted ticket vault key is missing.");
                    transaction.abort();
                    return;
                }
                if (!key) {
                    key = candidate;
                    keyStore.add(candidate, id);
                }
            };
            keyRequest.onsuccess = () => {
                key = keyRequest.result;
                ready();
            };
            dataRequest.onsuccess = () => {
                envelope = dataRequest.result;
                ready();
            };
            transaction.oncomplete = () => resolve({key, envelope});
            transaction.onerror = () =>
                reject(problem || transaction.error || new Error("Encrypted device storage failed."));
            transaction.onabort = () =>
                reject(problem || transaction.error || new Error("Encrypted device storage was interrupted."));
        });
    } finally {
        db.close();
    }
}

export async function readTicketVaultStore(store, id, factory = globalThis.indexedDB) {
    const db = await openTicketVaultDb(factory);
    try {
        return await ticketVaultRequest(
            db.transaction(store, "readonly").objectStore(store).get(id),
        );
    } finally {
        db.close();
    }
}

export async function writeTicketVaultStore(store, id, value, factory = globalThis.indexedDB) {
    const db = await openTicketVaultDb(factory);
    try {
        await new Promise((resolve, reject) => {
            const transaction = db.transaction(store, "readwrite");
            transaction.objectStore(store).put(value, id);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () =>
                reject(transaction.error || new Error("Encrypted device storage failed."));
            transaction.onabort = () =>
                reject(transaction.error || new Error("Encrypted device storage was interrupted."));
        });
    } finally {
        db.close();
    }
}

export async function deleteTicketVaultStore(store, id, factory = globalThis.indexedDB) {
    const db = await openTicketVaultDb(factory);
    try {
        await new Promise((resolve, reject) => {
            const transaction = db.transaction(store, "readwrite");
            transaction.objectStore(store).delete(id);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () =>
                reject(transaction.error || new Error("Encrypted device storage failed."));
            transaction.onabort = () =>
                reject(transaction.error || new Error("Encrypted device storage was interrupted."));
        });
    } finally {
        db.close();
    }
}

export async function loadDeviceTicketVault(scope, options = {}) {
    const factory = options.indexedDB || globalThis.indexedDB;
    const cryptoImpl = options.crypto || globalThis.crypto;
    const customStorage = !!(options.read || options.write);
    if (customStorage && (!options.read || !options.write)) {
        throw new Error("Ticket vault storage adapters require read and write.");
    }
    const read = options.read || ((store, id) => readTicketVaultStore(store, id, factory));
    const write = options.write || ((store, id, value) =>
        writeTicketVaultStore(store, id, value, factory));
    let {key: storedKey, envelope} = customStorage
        ? {
            key: await read(TICKET_VAULT_KEY_STORE, scope.id),
            envelope: await read(TICKET_VAULT_DATA_STORE, scope.id),
        }
        : await readTicketVaultState(scope.id, factory);
    if (envelope && !storedKey) {
        throw new Error("The encrypted ticket vault key is missing.");
    }
    let key = storedKey;
    if (!key) {
        const candidate = await generateTicketVaultKey(cryptoImpl);
        if (customStorage) {
            await write(TICKET_VAULT_KEY_STORE, scope.id, candidate);
            key = await read(TICKET_VAULT_KEY_STORE, scope.id);
        } else {
            const installed = await installTicketVaultKey(scope.id, candidate, factory);
            key = installed.key;
            envelope = installed.envelope;
        }
    }
    if (!ticketVaultKeyOk(key)) throw new Error("The encrypted ticket vault key is invalid.");
    const tickets = envelope
        ? await decryptTicketVault(key, scope, envelope, cryptoImpl)
        : [];
    return {key, tickets, created: !envelope};
}

export async function saveDeviceTicketVault(scope, key, tickets, options = {}) {
    const factory = options.indexedDB || globalThis.indexedDB;
    const cryptoImpl = options.crypto || globalThis.crypto;
    const read = options.read || ((store, id) => readTicketVaultStore(store, id, factory));
    const write = options.write || ((store, id, value) =>
        writeTicketVaultStore(store, id, value, factory));
    const envelope = await encryptTicketVault(key, scope, tickets, cryptoImpl);
    await write(TICKET_VAULT_DATA_STORE, scope.id, envelope);
    const stored = await read(TICKET_VAULT_DATA_STORE, scope.id);
    const roundTrip = await decryptTicketVault(key, scope, stored, cryptoImpl);
    if (JSON.stringify(roundTrip) !== JSON.stringify(tickets)) {
        throw new Error("The encrypted ticket vault did not verify after saving.");
    }
    return envelope;
}

export function mergeTicketVaultRecords(first, second) {
    if (!Array.isArray(first) || !Array.isArray(second)) {
        throw new Error("Ticket vault migration requires two order lists.");
    }
    const merged = [];
    const positions = new Map();
    for (const ticket of [...first, ...second]) {
        const id = String(ticket?.id || "").toLowerCase();
        if (!id) throw new Error("Ticket vault migration found an order without an id.");
        const at = positions.get(id);
        if (at === undefined) {
            positions.set(id, merged.length);
            merged.push(ticket);
        } else {
            merged[at] = {...merged[at], ...ticket};
        }
    }
    return merged;
}

export async function migrateLegacyTicketVault(scope, key, encrypted, legacy, options = {}) {
    const merged = mergeTicketVaultRecords(encrypted, legacy);
    const save = options.save || saveDeviceTicketVault;
    await save(scope, key, merged, options.saveOptions || {});
    if (options.removeLegacy) await options.removeLegacy();
    return merged;
}

export async function requestPersistentTicketStorage(storage = globalThis.navigator?.storage) {
    if (!storage?.persist) return false;
    try {
        if (storage.persisted && await storage.persisted()) return true;
        return !!(await storage.persist());
    } catch {
        return false;
    }
}
