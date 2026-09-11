import test from "node:test";
import assert from "node:assert/strict";
import {createDecipheriv, randomBytes, webcrypto} from "node:crypto";
import {Wallet} from "ethers";

import {PRIVATE_SESSION_STORE} from "./ticket-vault.mjs";
import {
    decryptPrivateSessions,
    encryptPrivateSessions,
    generatePrivateSessionKeys,
    privateSessionScope,
    publicPrivateSession,
    savePrivateSessions,
    validatePrivateSession,
} from "./private-session-vault.mjs";

const ethersImpl = {Wallet};
const FACTORY = "0x" + "11".repeat(20);
const ACCOUNT = "0x" + "22".repeat(20);
const LOCAL_WALLET = "0x" + "33".repeat(20);

async function keyFrom(raw) {
    return webcrypto.subtle.importKey(
        "raw",
        raw,
        {name: "AES-GCM", length: 256},
        false,
        ["encrypt", "decrypt"],
    );
}

async function fixture() {
    const keys = await generatePrivateSessionKeys(ethersImpl, webcrypto);
    const record = {
        v: 1,
        generation: 1,
        state: "ACTIVE",
        account: ACCOUNT,
        signer: keys.signer,
        recovery: keys.recovery,
        sessionPrivateKey: keys.sessionPrivateKey,
        recoveryPrivateKey: keys.recoveryPrivateKey,
        deploymentSalt: "0x" + "44".repeat(32),
        createdAt: "2026-09-10T12:00:00.000Z",
        retiredAt: null,
    };
    return {
        record,
        payload: {v: 1, sessions: [record]},
        scope: privateSessionScope(296, FACTORY, LOCAL_WALLET),
    };
}

test("browser-generated session and recovery keys are distinct and self-verifying", async () => {
    const {record} = await fixture();
    const checked = validatePrivateSession(record, ethersImpl);
    assert.equal(checked.signer, new Wallet(record.sessionPrivateKey).address.toLowerCase());
    assert.equal(checked.recovery, new Wallet(record.recoveryPrivateKey).address.toLowerCase());
    assert.notEqual(checked.signer, checked.recovery);
    const visible = publicPrivateSession(record, ethersImpl);
    assert.equal(visible.account, ACCOUNT);
    assert.equal("sessionPrivateKey" in visible, false);
    assert.equal("recoveryPrivateKey" in visible, false);
});

test("session history is authenticated to network, factory, and local wallet", async () => {
    const {payload, scope, record} = await fixture();
    const key = await keyFrom(randomBytes(32));
    const envelope = await encryptPrivateSessions(key, scope, payload, webcrypto, ethersImpl);
    assert.deepEqual(
        await decryptPrivateSessions(key, scope, envelope, webcrypto, ethersImpl),
        {v: 1, sessions: [validatePrivateSession(record, ethersImpl)]},
    );
    assert.doesNotMatch(JSON.stringify(envelope), new RegExp(record.sessionPrivateKey.slice(2), "i"));
    assert.doesNotMatch(JSON.stringify(envelope), new RegExp(record.recoveryPrivateKey.slice(2), "i"));

    const wrongWallet = privateSessionScope(296, FACTORY, "0x" + "55".repeat(20));
    await assert.rejects(
        decryptPrivateSessions(key, wrongWallet, envelope, webcrypto, ethersImpl),
        /another scope/,
    );
    const tampered = structuredClone(envelope);
    const bytes = Buffer.from(tampered.ciphertext, "base64");
    bytes[0] ^= 1;
    tampered.ciphertext = bytes.toString("base64");
    await assert.rejects(
        decryptPrivateSessions(key, scope, tampered, webcrypto, ethersImpl),
        /could not be authenticated/,
    );
});

test("Node AES-GCM independently decrypts the private session envelope", async () => {
    const raw = randomBytes(32);
    const key = await keyFrom(raw);
    const {payload, scope, record} = await fixture();
    const envelope = await encryptPrivateSessions(key, scope, payload, webcrypto, ethersImpl);
    const sealed = Buffer.from(envelope.ciphertext, "base64");
    const decipher = createDecipheriv("aes-256-gcm", raw, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(scope.aad));
    decipher.setAuthTag(sealed.subarray(-16));
    const clear = Buffer.concat([
        decipher.update(sealed.subarray(0, -16)),
        decipher.final(),
    ]);
    const decoded = JSON.parse(clear.toString("utf8"));
    assert.equal(decoded.sessions[0].account, ACCOUNT);
    assert.equal(decoded.sessions[0].sessionPrivateKey, record.sessionPrivateKey);
});

test("durable session save reads back and authenticates before success", async () => {
    const raw = randomBytes(32);
    const key = await keyFrom(raw);
    const {payload, scope} = await fixture();
    const stored = new Map();
    const read = async (store, id) => stored.get(`${store}:${id}`);
    const write = async (store, id, value) => {
        stored.set(`${store}:${id}`, structuredClone(value));
    };
    const result = await savePrivateSessions({
        key,
        scope,
        payload,
        read,
        write,
        cryptoImpl: webcrypto,
        ethersImpl,
    });
    assert.equal(result.sessions.length, 1);
    assert.ok(stored.has(`${PRIVATE_SESSION_STORE}:${scope.id}`));
});

test("duplicate history, wrong key ownership, and multiple active sessions are refused", async () => {
    const {record, payload, scope} = await fixture();
    const key = await keyFrom(randomBytes(32));
    const wrongSigner = {...record, signer: Wallet.createRandom().address};
    assert.throws(
        () => validatePrivateSession(wrongSigner, ethersImpl),
        /does not match/,
    );
    await assert.rejects(
        encryptPrivateSessions(
            key,
            scope,
            {v: 1, sessions: [record, record]},
            webcrypto,
            ethersImpl,
        ),
        /duplicate history/,
    );
    const second = {
        ...payload.sessions[0],
        ...(await generatePrivateSessionKeys(ethersImpl, webcrypto)),
        account: "0x" + "66".repeat(20),
        generation: 2,
        deploymentSalt: "0x" + "77".repeat(32),
    };
    await assert.rejects(
        encryptPrivateSessions(
            key,
            scope,
            {v: 1, sessions: [record, second]},
            webcrypto,
            ethersImpl,
        ),
        /multiple active(?: or pending)? sessions/,
    );
});
