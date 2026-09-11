import assert from "node:assert/strict";
import {createHash, webcrypto} from "node:crypto";
import {mkdtemp, readFile, stat, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    QUICKNET_GENESIS_TIME,
    createInsecureTestLockedKeyProvider,
    createTimedTicketEnvelope,
    decryptTimedTicketEnvelope,
    setTimedTicketCommitment,
} from "../../tools/timed-ticket.mjs";
import {
    PinnedQuicknetClient,
    QUICKNET_GROUP_HASH,
    QUICKNET_ORIGINS,
    QUICKNET_PUBLIC_KEY,
    QUICKNET_SCHEME,
    QuicknetLockedKeyProvider,
    verifyQuicknetBeacon,
} from "../runtime/drand-client.mjs";
import {
    DurableTimedTicketStore,
    TIMED_TICKET_TERMINAL_RETENTION_MS,
} from "../runtime/timed-ticket-store.mjs";
import {TimedTicketCustodyService} from "../runtime/timed-ticket-service.mjs";

const ENGINE = `0x${"11".repeat(20)}`;
const ACCOUNT = `0x${"22".repeat(20)}`;
const SALT = `0x${"33".repeat(32)}`;
const FEE_POLICY =
    "0xd74242b49f657e09305d83d2f31d1f2437e492538673004b14e948ba7a701037";
const GENERATION = 7n;
const CAPABILITY = `0x${"c1".repeat(32)}`;
const CHAIN_HASH = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
const INFO = {
    public_key: QUICKNET_PUBLIC_KEY,
    period: 3,
    genesis_time: Number(QUICKNET_GENESIS_TIME),
    hash: CHAIN_HASH,
    groupHash: QUICKNET_GROUP_HASH,
    schemeID: QUICKNET_SCHEME,
    metadata: {beaconID: "quicknet"},
};
const ROUND_ONE_BEACON = {
    round: 1,
    randomness: "1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a",
    signature: "b55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b",
};
const COMMIT_TIME = QUICKNET_GENESIS_TIME;
const TARGET_ROUND = 15n;
const TARGET_TIME = QUICKNET_GENESIS_TIME + 42n;

function response(value) {
    return {
        ok: true,
        headers: {get: () => null},
        text: async () => JSON.stringify(value),
    };
}

async function temporaryDirectory() {
    return mkdtemp(path.join(os.tmpdir(), "timed-ticket-test-"));
}

function digest(value) {
    return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function makeEnvelope(lockedKeyProvider, overrides = {}) {
    return createTimedTicketEnvelope({
        engine: ENGINE,
        sessionAccount: ACCOUNT,
        targetRound: TARGET_ROUND,
        secret: {
            side: "BUY",
            price: 98765432123456789n,
            quantity: 77n,
            randomSalt: SALT,
        },
        generation: GENERATION,
        feePolicyDigest: FEE_POLICY,
        lockedKeyProvider,
        crypto: webcrypto,
        allowInsecureTestProvider: lockedKeyProvider.securityLevel !== "production",
        ...overrides,
    });
}

function revealAdapter() {
    const preparedBytes = new Map();
    const broadcasts = [];
    let nextBroadcast = "CONFIRMED";
    let nextReconcile = "PENDING";
    return {
        preparedBytes,
        broadcasts,
        setBroadcast(value) {
            nextBroadcast = value;
        },
        setReconcile(value) {
            nextReconcile = value;
        },
        async prepareReveal(request) {
            const handle = `reveal_${request.ticketId}`;
            const bytes = Buffer.from(JSON.stringify({
                ticketId: request.ticketId,
                commitment: request.engineCommitment,
                side: request.side,
                price: request.price,
                quantity: request.quantity,
                randomSalt: request.randomSalt,
            }));
            const existing = preparedBytes.get(handle);
            if (existing) assert.deepEqual(existing, bytes);
            else preparedBytes.set(handle, bytes);
            return {handle, byteDigest: digest(bytes)};
        },
        async broadcastPrepared(request) {
            const exact = preparedBytes.get(request.handle);
            assert.ok(exact);
            assert.equal(digest(exact), request.byteDigest);
            broadcasts.push({handle: request.handle, bytes: Buffer.from(exact)});
            return {
                status: nextBroadcast,
                transactionHash: nextBroadcast === "CONFIRMED" ? `0x${"aa".repeat(32)}` : null,
            };
        },
        async reconcilePrepared() {
            return {
                status: nextReconcile,
                transactionHash: nextReconcile === "CONFIRMED" ? `0x${"aa".repeat(32)}` : null,
            };
        },
    };
}

function chainAdapter({wrongCommitment = false} = {}) {
    return {
        async observePlacement(request) {
            return {
                status: "PLACED",
                commitment: wrongCommitment ? `0x${"ff".repeat(32)}` : request.engineCommitment,
                commitTime: COMMIT_TIME.toString(),
                revealDelay: "30",
                revealWindow: "270",
            };
        },
        async recheckBeforeReveal(request) {
            return {status: "REVEALABLE", commitment: request.engineCommitment};
        },
        async cancel() {
            return {status: "CONFIRMED"};
        },
    };
}

test("production Quicknet adapter pins info and verifies a live round vector", async () => {
    const requested = [];
    const fetchImpl = async (url, options) => {
        requested.push({url, options});
        return response(url.endsWith("/info") ? INFO : ROUND_ONE_BEACON);
    };
    const provider = new QuicknetLockedKeyProvider({
        client: new PinnedQuicknetClient({fetchImpl}),
        crypto: webcrypto,
        nowSeconds: () => QUICKNET_GENESIS_TIME + 100n,
    });
    const made = await createTimedTicketEnvelope({
        engine: ENGINE,
        sessionAccount: ACCOUNT,
        targetRound: 1n,
        secret: {side: "SELL", price: 5n, quantity: 9n, randomSalt: SALT},
        generation: GENERATION,
        feePolicyDigest: FEE_POLICY,
        lockedKeyProvider: provider,
        crypto: webcrypto,
    });
    const verified = await provider.verifyTarget(1n);
    const secret = await decryptTimedTicketEnvelope(made.envelope, {
        lockedKeyProvider: provider,
        verifiedBeacon: verified,
        crypto: webcrypto,
    });
    assert.equal(secret.side, "SELL");
    assert.equal(secret.price, 5n);
    assert.equal(secret.quantity, 9n);
    assert.ok(requested.every(({url}) =>
        url.startsWith(`https://api.drand.sh/${CHAIN_HASH}/`)));
    assert.ok(requested.every(({options}) =>
        options.redirect === "error" && options.credentials === "omit"));
    secret.randomSalt.fill(0);
    secret.revealSalt.fill(0);
});

test("Quicknet verification refuses early access, altered beacons, and chain drift", async () => {
    assert.equal(verifyQuicknetBeacon(ROUND_ONE_BEACON, 1n).round, 1n);
    assert.throws(
        () => verifyQuicknetBeacon({...ROUND_ONE_BEACON, randomness: "00".repeat(32)}, 1n),
        {code: "BEACON_INVALID"},
    );
    assert.throws(
        () => verifyQuicknetBeacon({...ROUND_ONE_BEACON, round: 2}, 1n),
        {code: "BEACON_INVALID"},
    );

    let beaconFetched = false;
    const early = new QuicknetLockedKeyProvider({
        client: new PinnedQuicknetClient({
            fetchImpl: async (url) => {
                if (!url.endsWith("/info")) beaconFetched = true;
                return response(url.endsWith("/info") ? INFO : ROUND_ONE_BEACON);
            },
        }),
        crypto: webcrypto,
        nowSeconds: () => QUICKNET_GENESIS_TIME - 1n,
    });
    await assert.rejects(early.verifyTarget(1n), {code: "EARLY_DECRYPT_REFUSED"});
    assert.equal(beaconFetched, false);

    const wrongInfo = new PinnedQuicknetClient({
        fetchImpl: async () => response({...INFO, hash: "00".repeat(32)}),
    });
    await assert.rejects(wrongInfo.info(), {code: "CHAIN_INFO_MISMATCH"});
});

test("Quicknet client fails over between pinned relays and rejects caller URLs", async () => {
    const requested = [];
    const client = new PinnedQuicknetClient({
        fetchImpl: async (url) => {
            requested.push(url);
            if (url.startsWith(QUICKNET_ORIGINS[0])) {
                return {ok: false, headers: {get: () => null}, text: async () => ""};
            }
            return response(INFO);
        },
    });
    assert.equal((await client.info()).hash, CHAIN_HASH);
    assert.equal(requested.length, 2);
    assert.ok(requested[0].startsWith(QUICKNET_ORIGINS[0]));
    assert.ok(requested[1].startsWith(QUICKNET_ORIGINS[1]));
    assert.ok(QUICKNET_ORIGINS.every((origin) => origin.startsWith("https://")));
    assert.throws(() => QUICKNET_ORIGINS.push("https://attacker.invalid"), TypeError);
});

test("staging atomically reads back exact bytes and enforces capability conflicts", async () => {
    const root = await temporaryDirectory();
    const lockedKeyProvider = createInsecureTestLockedKeyProvider({crypto: webcrypto});
    const made = await makeEnvelope(lockedKeyProvider);
    const store = new DurableTimedTicketStore({directory: root, crypto: webcrypto});
    const staged = await store.stage(made.envelope, {capability: CAPABILITY});
    assert.equal(staged.state, "PREARMED");
    assert.equal(staged.capability, CAPABILITY);
    assert.equal(staged.byteDigest, digest(made.envelope));
    const persisted = await store.read(staged.ticketId, CAPABILITY);
    assert.deepEqual(persisted.envelope, Buffer.from(made.envelope));
    assert.equal(
        (await stat(path.join(root, staged.ticketId, "envelope.bin"))).mode & 0o777,
        0o600,
    );
    assert.equal(
        (await stat(path.join(root, staged.ticketId, "metadata.json"))).mode & 0o777,
        0o600,
    );
    assert.equal((await store.stage(made.envelope, {capability: CAPABILITY})).ticketId, staged.ticketId);
    await assert.rejects(
        store.read(staged.ticketId, `0x${"dd".repeat(32)}`),
        {code: "CAPABILITY_REJECTED"},
    );

    const changed = setTimedTicketCommitment(made.envelope, `0x${"ee".repeat(32)}`);
    await assert.rejects(
        store.stage(changed, {capability: CAPABILITY}),
        {code: "ENVELOPE_CONFLICT"},
    );
    persisted.envelope.fill(0);
});

async function serviceHarness({
    at = TARGET_TIME,
    chain = chainAdapter(),
    reveal = revealAdapter(),
    transitionHook,
    provider: suppliedProvider,
} = {}) {
    let now = at;
    const lockedKeyProvider = suppliedProvider
        ?? createInsecureTestLockedKeyProvider({crypto: webcrypto});
    const made = await makeEnvelope(lockedKeyProvider);
    const root = await temporaryDirectory();
    const store = new DurableTimedTicketStore({
        directory: root,
        crypto: webcrypto,
        nowMs: () => Number(now * 1000n),
    });
    const staged = await store.stage(made.envelope, {capability: CAPABILITY});
    const service = new TimedTicketCustodyService({
        store,
        lockedKeyProvider,
        chainAdapter: chain,
        revealAdapter: reveal,
        nowSeconds: () => now,
        transitionHook,
        crypto: webcrypto,
        allowInsecureTestProvider: true,
    });
    return {
        root,
        store,
        staged,
        made,
        service,
        reveal,
        lockedKeyProvider,
        setNow(value) {
            now = value;
        },
    };
}

test("worker observes placement, decrypts after beacon, rechecks, and reveals idempotently", async () => {
    const harness = await serviceHarness();
    const result = await harness.service.run(harness.staged.ticketId);
    assert.equal(result.state, "REVEALED");
    assert.equal(result.payloadPresent, false);
    assert.equal(result.broadcast.status, "CONFIRMED");
    assert.equal(harness.reveal.broadcasts.length, 1);
    const retry = await harness.service.run(harness.staged.ticketId);
    assert.equal(retry.state, "REVEALED");
    assert.equal(harness.reveal.broadcasts.length, 1);
    const summaryText = JSON.stringify(retry);
    assert.equal(summaryText.includes(SALT.slice(2)), false);
    assert.equal(summaryText.includes("98765432123456789"), false);
    assert.equal(summaryText.includes(CAPABILITY.slice(2)), false);
});

test("worker waits before target and refuses a mismatched placed commitment", async () => {
    const early = await serviceHarness({at: TARGET_TIME - 1n});
    const waiting = await early.service.run(early.staged.ticketId, CAPABILITY);
    assert.equal(waiting.state, "WAITING_BEACON");
    assert.equal(early.reveal.broadcasts.length, 0);

    const wrong = await serviceHarness({chain: chainAdapter({wrongCommitment: true})});
    await assert.rejects(
        wrong.service.run(wrong.staged.ticketId, CAPABILITY),
        {code: "COMMITMENT_MISMATCH"},
    );
    assert.equal(
        (await wrong.service.summary(wrong.staged.ticketId, CAPABILITY)).state,
        "PREARMED",
    );
});

test("invalid target beacon leaves the ticket waiting and secret unopened", async () => {
    const baseProvider = createInsecureTestLockedKeyProvider({crypto: webcrypto});
    const failingProvider = {
        securityLevel: "test-only",
        lock: baseProvider.lock,
        unlock: baseProvider.unlock,
        async verifyTarget() {
            throw Object.assign(new Error("invalid beacon with private diagnostic"), {
                code: "BEACON_INVALID",
            });
        },
    };
    const harness = await serviceHarness({provider: failingProvider});
    await assert.rejects(
        harness.service.run(harness.staged.ticketId, CAPABILITY),
        {code: "BEACON_INVALID"},
    );
    const summary = await harness.service.summary(harness.staged.ticketId, CAPABILITY);
    assert.equal(summary.state, "WAITING_BEACON");
    assert.equal(harness.reveal.preparedBytes.size, 0);
});

function restartedService(harness, options = {}) {
    return new TimedTicketCustodyService({
        store: harness.store,
        lockedKeyProvider: harness.lockedKeyProvider,
        chainAdapter: options.chain ?? chainAdapter(),
        revealAdapter: harness.reveal,
        nowSeconds: () => TARGET_TIME,
        transitionHook: options.transitionHook,
        crypto: webcrypto,
        allowInsecureTestProvider: true,
    });
}

test("durable state resumes after crashes at every transition boundary", async () => {
    for (const crashState of [
        "PLACED",
        "WAITING_BEACON",
        "DECRYPTING",
        "REVEALING",
        "REVEALED",
    ]) {
        let crashed = false;
        const harness = await serviceHarness({
            transitionHook: async (state) => {
                if (!crashed && state === crashState) {
                    crashed = true;
                    throw Object.assign(new Error("simulated crash"), {code: "SIMULATED_CRASH"});
                }
            },
        });
        await assert.rejects(
            harness.service.run(harness.staged.ticketId, CAPABILITY),
            {code: "SIMULATED_CRASH"},
        );
        assert.equal(
            (await harness.service.summary(harness.staged.ticketId, CAPABILITY)).state,
            crashState,
        );
        const recovered = await restartedService(harness).run(harness.staged.ticketId, CAPABILITY);
        assert.equal(recovered.state, "REVEALED");
    }
});

test("an interrupted reveal preparation is regenerated identically", async () => {
    const reveal = revealAdapter();
    const prepare = reveal.prepareReveal.bind(reveal);
    let failOnce = true;
    reveal.prepareReveal = async (request) => {
        const result = await prepare(request);
        if (failOnce) {
            failOnce = false;
            throw Object.assign(new Error("simulated crash"), {code: "SIMULATED_CRASH"});
        }
        return result;
    };
    const harness = await serviceHarness({reveal});
    await assert.rejects(
        harness.service.run(harness.staged.ticketId, CAPABILITY),
        {code: "SIMULATED_CRASH"},
    );
    assert.equal(
        (await harness.service.summary(harness.staged.ticketId, CAPABILITY)).state,
        "DECRYPTING",
    );
    const recovered = await restartedService(harness).run(harness.staged.ticketId, CAPABILITY);
    assert.equal(recovered.state, "REVEALED");
    assert.equal(reveal.preparedBytes.size, 1);
});

test("unknown broadcast reconciles before an exact-byte retry", async () => {
    const reveal = revealAdapter();
    reveal.setBroadcast("UNKNOWN");
    reveal.setReconcile("ABSENT");
    const harness = await serviceHarness({
        reveal,
        transitionHook: async (state) => {
            if (state === "BROADCAST_UNKNOWN") {
                throw Object.assign(new Error("simulated crash"), {code: "SIMULATED_CRASH"});
            }
        },
    });
    await assert.rejects(
        harness.service.run(harness.staged.ticketId, CAPABILITY),
        {code: "SIMULATED_CRASH"},
    );
    assert.equal(
        (await harness.service.summary(harness.staged.ticketId, CAPABILITY)).state,
        "BROADCAST_UNKNOWN",
    );
    assert.equal(reveal.broadcasts.length, 1);
    const firstBytes = reveal.broadcasts[0].bytes;

    reveal.setBroadcast("CONFIRMED");
    const recovered = await restartedService(harness).run(harness.staged.ticketId, CAPABILITY);
    assert.equal(recovered.state, "REVEALED");
    assert.equal(reveal.broadcasts.length, 2);
    assert.deepEqual(reveal.broadcasts[1].bytes, firstBytes);
    assert.equal(reveal.broadcasts[1].handle, reveal.broadcasts[0].handle);
});

test("late workers mark tickets missed without decrypting or broadcasting", async () => {
    const harness = await serviceHarness({at: COMMIT_TIME + 301n});
    const result = await harness.service.run(harness.staged.ticketId, CAPABILITY);
    assert.equal(result.state, "MISSED");
    assert.equal(harness.reveal.preparedBytes.size, 0);
    assert.equal(harness.reveal.broadcasts.length, 0);
});

test("adapter failures cannot echo reveal secrets or write logs", async () => {
    const messages = [];
    const originalLog = console.log;
    const originalError = console.error;
    const reveal = revealAdapter();
    let privateReveal;
    reveal.prepareReveal = async (request) => {
        privateReveal = request.randomSalt;
        throw Object.assign(new Error(`private ${request.randomSalt}`), {code: "PREP_FAILED"});
    };
    console.log = (...values) => messages.push(values.join(" "));
    console.error = (...values) => messages.push(values.join(" "));
    try {
        const harness = await serviceHarness({reveal});
        let caught;
        try {
            await harness.service.run(harness.staged.ticketId, CAPABILITY);
        } catch (error) {
            caught = error;
        }
        assert.equal(caught.code, "PREP_FAILED");
        assert.ok(privateReveal);
        assert.equal(caught.message.includes(privateReveal), false);
        assert.equal(messages.some((message) => message.includes(privateReveal)), false);
        const summary = await harness.service.summary(harness.staged.ticketId, CAPABILITY);
        assert.equal(JSON.stringify(summary).includes(privateReveal), false);
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
});

test("cancellation purges ciphertext and terminal metadata expires after 24 hours", async () => {
    const harness = await serviceHarness({at: TARGET_TIME - 1n});
    await harness.service.run(harness.staged.ticketId, CAPABILITY);
    const cancelled = await harness.service.cancel(harness.staged.ticketId, CAPABILITY);
    assert.equal(cancelled.state, "CANCELLED");
    assert.equal(cancelled.payloadPresent, false);
    assert.equal(
        (await harness.service.cancel(harness.staged.ticketId, CAPABILITY)).state,
        "CANCELLED",
    );
    await assert.rejects(
        stat(path.join(harness.root, harness.staged.ticketId, "envelope.bin")),
        {code: "ENOENT"},
    );

    harness.setNow(TARGET_TIME - 1n + BigInt(TIMED_TICKET_TERMINAL_RETENTION_MS / 1000));
    assert.deepEqual(await harness.service.purgeExpired(), [{
        ticketId: harness.staged.ticketId,
        state: "PURGED",
    }]);
    await assert.rejects(
        harness.store.read(harness.staged.ticketId, CAPABILITY),
        {code: "TICKET_MISSING"},
    );
});

test("worker finishes ciphertext purge after a cancellation crash", async () => {
    const harness = await serviceHarness({at: TARGET_TIME - 1n});
    const metadataFile = path.join(
        harness.root,
        harness.staged.ticketId,
        "metadata.json",
    );
    const interrupted = JSON.parse(await readFile(metadataFile, "utf8"));
    interrupted.state = "CANCELLED";
    interrupted.revision += 1;
    interrupted.updatedAtMs += 1;
    interrupted.terminalAtMs = interrupted.updatedAtMs;
    await writeFile(metadataFile, `${JSON.stringify(interrupted)}\n`, {mode: 0o600});
    assert.equal(
        (await harness.store.read(harness.staged.ticketId, CAPABILITY, {
            includeEnvelope: false,
        })).summary.payloadPresent,
        true,
    );
    const recovered = await harness.service.run(harness.staged.ticketId);
    assert.equal(recovered.state, "CANCELLED");
    assert.equal(recovered.payloadPresent, false);
});

test("worker discovery resumes every durable nonterminal ticket", async () => {
    const harness = await serviceHarness();
    const results = await harness.service.runPending();
    assert.equal(results.length, 1);
    assert.equal(results[0].ticketId, harness.staged.ticketId);
    assert.equal(results[0].status, "OK");
    assert.equal(results[0].summary.state, "REVEALED");
    assert.equal(results[0].summary.payloadPresent, false);
    assert.deepEqual(await harness.service.runPending(), []);
});

test("manual recovery returns the derived reveal only in caller memory", async () => {
    const harness = await serviceHarness();
    const recovery = await harness.service.manualRecovery(harness.staged.ticketId, CAPABILITY);
    assert.equal(recovery.side, "BUY");
    assert.equal(recovery.price, "98765432123456789");
    assert.equal(recovery.quantity, "77");
    assert.match(recovery.randomSalt, /^0x[0-9a-f]{64}$/);
    const metadata = await readFile(
        path.join(harness.root, harness.staged.ticketId, "metadata.json"),
        "utf8",
    );
    assert.equal(metadata.includes(recovery.randomSalt.slice(2)), false);
    assert.equal(metadata.includes(SALT.slice(2)), false);
    assert.equal(metadata.includes(recovery.price), false);
    assert.equal(
        (await harness.service.summary(harness.staged.ticketId, CAPABILITY)).state,
        "PREARMED",
    );
});
