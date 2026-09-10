import {test} from "node:test";
import assert from "node:assert/strict";
import {createDecipheriv, randomBytes, webcrypto} from "node:crypto";
import {
    TICKET_VAULT_DATA_STORE,
    decryptTicketVault,
    encryptTicketVault,
    generateTicketVaultKey,
    loadDeviceTicketVault,
    migrateLegacyTicketVault,
    saveDeviceTicketVault,
    ticketVaultScope,
} from "./ticket-vault.mjs";

const ENGINE = "0x00000000000000000000000000000000000000bb";
const ACCOUNT = "0x00000000000000000000000000000000000000aa";

function memoryStorage() {
    const values = new Map();
    return {
        values,
        read: async (store, id) => values.get(store + ":" + id),
        write: async (store, id, value) => {
            values.set(store + ":" + id, value);
        },
    };
}

test("AES-GCM ticket vault round trips with a unique IV", async () => {
    const scope = ticketVaultScope(296, ENGINE, ACCOUNT);
    const key = await generateTicketVaultKey(webcrypto);
    const tickets = [{
        id: "0x" + "11".repeat(32),
        salt: "0x" + "22".repeat(32),
        price: "100",
        qty: "25",
    }];
    const first = await encryptTicketVault(key, scope, tickets, webcrypto);
    const second = await encryptTicketVault(key, scope, tickets, webcrypto);

    assert.notEqual(first.iv, second.iv);
    assert.notEqual(first.ciphertext, second.ciphertext);
    assert.deepEqual(
        await decryptTicketVault(key, scope, first, webcrypto),
        tickets,
    );
    assert.equal(key.extractable, false);
    assert.deepEqual([...key.usages].sort(), ["decrypt", "encrypt"]);
});

test("authenticated scope rejects AAD changes, tampering, and another account", async () => {
    const scope = ticketVaultScope(296, ENGINE, ACCOUNT);
    const key = await generateTicketVaultKey(webcrypto);
    const envelope = await encryptTicketVault(key, scope, [{id: "order-a"}], webcrypto);

    await assert.rejects(
        decryptTicketVault(key, {...scope, aad: scope.aad + "\nchanged"}, envelope, webcrypto),
        /could not be authenticated/,
    );

    const damaged = Buffer.from(envelope.ciphertext, "base64");
    damaged[0] ^= 1;
    await assert.rejects(
        decryptTicketVault(
            key,
            scope,
            {...envelope, ciphertext: damaged.toString("base64")},
            webcrypto,
        ),
        /could not be authenticated/,
    );

    const other = ticketVaultScope(
        296,
        ENGINE,
        "0x00000000000000000000000000000000000000cc",
    );
    await assert.rejects(
        decryptTicketVault(key, other, envelope, webcrypto),
        /another account or market/,
    );
});

test("Node AES-GCM independently decrypts the browser envelope", async () => {
    const scope = ticketVaultScope(296, ENGINE, ACCOUNT);
    const raw = randomBytes(32);
    const key = await webcrypto.subtle.importKey(
        "raw",
        raw,
        {name: "AES-GCM"},
        false,
        ["encrypt", "decrypt"],
    );
    const tickets = [{id: "order-a", salt: "private"}];
    const envelope = await encryptTicketVault(key, scope, tickets, webcrypto);
    const sealed = Buffer.from(envelope.ciphertext, "base64");
    const ciphertext = sealed.subarray(0, -16);
    const tag = sealed.subarray(-16);
    const decipher = createDecipheriv(
        "aes-256-gcm",
        raw,
        Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(scope.aad));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    assert.deepEqual(JSON.parse(plaintext.toString()), {v: 1, tickets});
});

test("device storage confirms encrypted persistence before returning", async () => {
    const scope = ticketVaultScope(296, ENGINE, ACCOUNT);
    const storage = memoryStorage();
    const loaded = await loadDeviceTicketVault(scope, {
        crypto: webcrypto,
        read: storage.read,
        write: storage.write,
    });
    assert.deepEqual(loaded.tickets, []);
    const tickets = [{id: "order-a"}, {id: "order-b"}];
    await saveDeviceTicketVault(scope, loaded.key, tickets, {
        crypto: webcrypto,
        read: storage.read,
        write: storage.write,
    });
    const reopened = await loadDeviceTicketVault(scope, {
        crypto: webcrypto,
        read: storage.read,
        write: storage.write,
    });

    assert.deepEqual(reopened.tickets, tickets);
    const envelope = storage.values.get(TICKET_VAULT_DATA_STORE + ":" + scope.id);
    assert.ok(envelope.ciphertext);
    assert.doesNotMatch(JSON.stringify(envelope), /order-a|order-b/);
});

test("storage write failure prevents a vault from becoming ready", async () => {
    const scope = ticketVaultScope(296, ENGINE, ACCOUNT);
    await assert.rejects(
        loadDeviceTicketVault(scope, {
            crypto: webcrypto,
            read: async () => undefined,
            write: async () => {
                throw new Error("quota denied");
            },
        }),
        /quota denied/,
    );
});

test("plaintext migration removes legacy data only after verified encryption", async () => {
    const scope = ticketVaultScope(296, ENGINE, ACCOUNT);
    const key = await generateTicketVaultKey(webcrypto);
    const storage = memoryStorage();
    let removed = false;
    const merged = await migrateLegacyTicketVault(
        scope,
        key,
        [{id: "order-a", state: "encrypted"}],
        [{id: "order-a", state: "legacy"}, {id: "order-b"}],
        {
            saveOptions: {
                crypto: webcrypto,
                read: storage.read,
                write: storage.write,
            },
            removeLegacy: async () => {
                removed = true;
            },
        },
    );
    const envelope = storage.values.get(TICKET_VAULT_DATA_STORE + ":" + scope.id);

    assert.equal(removed, true);
    assert.deepEqual(merged, [
        {id: "order-a", state: "legacy"},
        {id: "order-b"},
    ]);
    assert.deepEqual(
        await decryptTicketVault(key, scope, envelope, webcrypto),
        merged,
    );

    removed = false;
    await assert.rejects(
        migrateLegacyTicketVault(scope, key, [], [{id: "order-c"}], {
            save: async () => {
                throw new Error("verification failed");
            },
            removeLegacy: async () => {
                removed = true;
            },
        }),
        /verification failed/,
    );
    assert.equal(removed, false);
});
