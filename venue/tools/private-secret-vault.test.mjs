import assert from "node:assert/strict";
import {randomBytes, webcrypto} from "node:crypto";
import test from "node:test";

import {PRIVATE_SECRET_STORE} from "./ticket-vault.mjs";
import {
    decryptPrivateSecrets,
    encryptPrivateSecrets,
    privateSecretScope,
    savePrivateSecrets,
    validatePrivateSecretPayload,
} from "./private-secret-vault.mjs";

const FACTORY = `0x${"11".repeat(20)}`;
const WALLET = `0x${"22".repeat(20)}`;

async function key() {
    return webcrypto.subtle.importKey(
        "raw",
        randomBytes(32),
        {name: "AES-GCM"},
        false,
        ["encrypt", "decrypt"],
    );
}

function payload() {
    return {
        v: 1,
        credential: {
            v: 1,
            holderSecret: "12345678901234567890",
            credentialId: "73",
            jurisdiction: "3",
            tier: "4",
            validUntilEpoch: "50",
            holderSecretCommitment: "456",
            credentialRoot: "789",
            pathElements: Array(16).fill("0"),
            pathIndices: Array(16).fill("0"),
            issuedAt: "2026-09-10T12:00:00.000Z",
        },
        notes: [{
            v: 1,
            asset: "HBAR",
            state: "PREPARED",
            pool: `0x${"33".repeat(20)}`,
            denomination: "100000000",
            commitment: "901",
            noteSecret: "902",
            noteNullifier: "903",
            fundingTag: "904",
            leafIndex: null,
            depositRoot: null,
            depositTx: null,
            createdAt: "2026-09-10T12:01:00.000Z",
            spentAt: null,
        }],
    };
}

test("holder credentials and routing notes stay inside authenticated device storage", async () => {
    const vaultKey = await key();
    const scope = privateSecretScope(296, FACTORY, WALLET);
    const clear = validatePrivateSecretPayload(payload());
    const envelope = await encryptPrivateSecrets(vaultKey, scope, clear, webcrypto);
    const serialized = JSON.stringify(envelope);
    assert.equal(serialized.includes(clear.credential.holderSecret), false);
    assert.equal(serialized.includes(clear.notes[0].noteSecret), false);
    assert.deepEqual(
        await decryptPrivateSecrets(vaultKey, scope, envelope, webcrypto),
        clear,
    );

    const tampered = structuredClone(envelope);
    const bytes = Buffer.from(tampered.ciphertext, "base64");
    bytes[1] ^= 1;
    tampered.ciphertext = bytes.toString("base64");
    await assert.rejects(
        decryptPrivateSecrets(vaultKey, scope, tampered, webcrypto),
        /could not be authenticated/,
    );
});

test("private secret save verifies durable readback", async () => {
    const vaultKey = await key();
    const scope = privateSecretScope(296, FACTORY, WALLET);
    const storage = new Map();
    const saved = await savePrivateSecrets({
        key: vaultKey,
        scope,
        payload: payload(),
        read: async (store, id) => storage.get(`${store}:${id}`),
        write: async (store, id, value) => {
            storage.set(`${store}:${id}`, structuredClone(value));
        },
        cryptoImpl: webcrypto,
    });
    assert.equal(saved.notes.length, 1);
    assert.ok(storage.has(`${PRIVATE_SECRET_STORE}:${scope.id}`));
});

test("malformed and duplicate private secret records fail closed", () => {
    const duplicate = payload();
    duplicate.notes.push(structuredClone(duplicate.notes[0]));
    assert.throws(
        () => validatePrivateSecretPayload(duplicate),
        /duplicate routing notes/,
    );
    const exposed = payload();
    exposed.notes[0].state = "DEPOSITED";
    assert.throws(
        () => validatePrivateSecretPayload(exposed),
        /metadata is incomplete/,
    );
});
