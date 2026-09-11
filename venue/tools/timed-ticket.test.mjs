import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import test from "node:test";

import {
    QUICKNET_CHAIN_HASH,
    QUICKNET_GENESIS_TIME,
    TIMED_TICKET_OFFSETS,
    TIMED_TICKET_SIZE,
    assertSafeTargetRound,
    computeTimedTicketAutomationMetadata,
    computeTimedTicketEngineCommitment,
    createInsecureTestLockedKeyProvider,
    createTimedTicketEnvelope,
    decryptTimedTicketEnvelope,
    deriveTimedTicketRevealSalt,
    generateTimedTicketCapability,
    parseTimedTicketEnvelope,
    roundAtOrAfter,
    roundTime,
    safeRevealInterval,
    selectSafeTargetRound,
    setTimedTicketCommitment,
    timedTicketCoreDigest,
    timedTicketEnvelopeDigest,
} from "./timed-ticket.mjs";

const ENGINE = `0x${"11".repeat(20)}`;
const ACCOUNT = `0x${"22".repeat(20)}`;
const OTHER_ENGINE = `0x${"44".repeat(20)}`;
const SALT = `0x${"33".repeat(32)}`;
const FEE_POLICY =
    "0xd74242b49f657e09305d83d2f31d1f2437e492538673004b14e948ba7a701037";
const GENERATION = 7n;
const MAX_UINT128 = (1n << 128n) - 1n;

function provider() {
    return createInsecureTestLockedKeyProvider({crypto: webcrypto});
}

async function make(overrides = {}) {
    const lockedKeyProvider = overrides.lockedKeyProvider ?? provider();
    const result = await createTimedTicketEnvelope({
        engine: ENGINE,
        sessionAccount: ACCOUNT,
        targetRound: 1n,
        secret: {
            side: "BUY",
            price: 1n,
            quantity: 2n,
            randomSalt: SALT,
        },
        generation: GENERATION,
        feePolicyDigest: FEE_POLICY,
        crypto: webcrypto,
        allowInsecureTestProvider: true,
        ...overrides,
        lockedKeyProvider,
    });
    return {result, lockedKeyProvider};
}

test("browser WebCrypto creates an exact 2048 byte BUY envelope", async () => {
    assert.match(generateTimedTicketCapability(webcrypto), /^0x[0-9a-f]{64}$/);
    const {result, lockedKeyProvider} = await make();
    assert.equal(result.envelope.byteLength, TIMED_TICKET_SIZE);
    const header = await parseTimedTicketEnvelope(result.envelope, {crypto: webcrypto});
    assert.equal(header.chainId, 296n);
    assert.equal(header.chainHash, QUICKNET_CHAIN_HASH);
    assert.equal(header.engine, ENGINE);
    assert.equal(header.sessionAccount, ACCOUNT);
    assert.equal(header.targetRound, 1n);
    assert.equal(header.targetTime, QUICKNET_GENESIS_TIME);
    assert.equal(header.guardSeconds, 12n);
    assert.equal(header.marginSeconds, 60n);

    const verified = await lockedKeyProvider.verifyTarget(1n);
    const secret = await decryptTimedTicketEnvelope(result.envelope, {
        lockedKeyProvider,
        verifiedBeacon: verified,
        crypto: webcrypto,
        allowInsecureTestProvider: true,
    });
    assert.equal(secret.side, "BUY");
    assert.equal(secret.price, 1n);
    assert.equal(secret.quantity, 2n);
    assert.equal(
        `0x${Buffer.from(secret.randomSalt).toString("hex")}`,
        SALT,
    );
    assert.notEqual(
        Buffer.from(secret.revealSalt).toString("hex"),
        SALT.slice(2),
    );
    secret.randomSalt.fill(0);
    secret.revealSalt.fill(0);
});

test("SELL record supports canonical uint128 maxima", async () => {
    const lockedKeyProvider = provider();
    const {envelope} = await createTimedTicketEnvelope({
        engine: ENGINE,
        sessionAccount: ACCOUNT,
        targetRound: 2n,
        secret: {
            side: "SELL",
            price: MAX_UINT128,
            quantity: MAX_UINT128,
            randomSalt: SALT,
        },
        generation: GENERATION,
        feePolicyDigest: FEE_POLICY,
        lockedKeyProvider,
        crypto: webcrypto,
        allowInsecureTestProvider: true,
    });
    const secret = await decryptTimedTicketEnvelope(envelope, {
        lockedKeyProvider,
        verifiedBeacon: await lockedKeyProvider.verifyTarget(2n),
        crypto: webcrypto,
        allowInsecureTestProvider: true,
    });
    assert.equal(secret.side, "SELL");
    assert.equal(secret.price, MAX_UINT128);
    assert.equal(secret.quantity, MAX_UINT128);
    secret.randomSalt.fill(0);
    secret.revealSalt.fill(0);
});

test("secret encoding rejects zero, overflow, and noncanonical side", async () => {
    for (const secret of [
        {side: "BUY", price: 0n, quantity: 1n, randomSalt: SALT},
        {side: "BUY", price: 1n << 128n, quantity: 1n, randomSalt: SALT},
        {side: "BUY", price: 1n, quantity: 1n << 128n, randomSalt: SALT},
        {side: "HOLD", price: 1n, quantity: 1n, randomSalt: SALT},
    ]) {
        await assert.rejects(
            createTimedTicketEnvelope({
                engine: ENGINE,
                sessionAccount: ACCOUNT,
                targetRound: 1n,
                secret,
                generation: GENERATION,
                feePolicyDigest: FEE_POLICY,
                lockedKeyProvider: provider(),
                crypto: webcrypto,
                allowInsecureTestProvider: true,
            }),
            {code: "SECRET_INVALID"},
        );
    }
});

test("strict parser detects altered header, payload, digest, and context", async () => {
    const {result} = await make();
    const alterations = [
        TIMED_TICKET_OFFSETS.engine,
        TIMED_TICKET_OFFSETS.ciphertext + 200,
        TIMED_TICKET_OFFSETS.envelopeDigest,
    ];
    for (const offset of alterations) {
        const altered = result.envelope.slice();
        altered[offset] ^= 1;
        await assert.rejects(
            parseTimedTicketEnvelope(altered, {crypto: webcrypto}),
            (error) => ["DIGEST_MISMATCH", "HEADER_INVALID"].includes(error.code),
        );
    }
    await assert.rejects(
        parseTimedTicketEnvelope(result.envelope, {
            crypto: webcrypto,
            expected: {engine: OTHER_ENGINE},
        }),
        {code: "CONTEXT_MISMATCH"},
    );
    await assert.rejects(
        parseTimedTicketEnvelope(result.envelope, {
            crypto: webcrypto,
            expected: {sessionAccount: `0x${"55".repeat(20)}`},
        }),
        {code: "CONTEXT_MISMATCH"},
    );
    await assert.rejects(
        parseTimedTicketEnvelope(result.envelope, {
            crypto: webcrypto,
            expected: {chainId: 295},
        }),
        {code: "CONTEXT_MISMATCH"},
    );
});

test("final digest binds the locked key while commitment remains fillable", async () => {
    const {result, lockedKeyProvider} = await make();
    const originalDigest = await timedTicketEnvelopeDigest(result.envelope, webcrypto);
    const originalCoreDigest = await timedTicketCoreDigest(result.envelope, webcrypto);
    const changedCommitment = setTimedTicketCommitment(
        result.envelope,
        `0x${"77".repeat(32)}`,
    );
    assert.deepEqual(
        await timedTicketEnvelopeDigest(changedCommitment, webcrypto),
        originalDigest,
    );
    await assert.rejects(
        parseTimedTicketEnvelope(changedCommitment, {
            crypto: webcrypto,
            expected: {engineCommitment: result.engineCommitment},
        }),
        {code: "CONTEXT_MISMATCH"},
    );
    await assert.rejects(
        decryptTimedTicketEnvelope(changedCommitment, {
            lockedKeyProvider,
            verifiedBeacon: await lockedKeyProvider.verifyTarget(1n),
            crypto: webcrypto,
            allowInsecureTestProvider: true,
        }),
        {code: "COMMITMENT_MISMATCH"},
    );

    const changedLock = result.envelope.slice();
    changedLock[TIMED_TICKET_OFFSETS.lockedKey + 10] ^= 1;
    assert.deepEqual(
        await timedTicketCoreDigest(changedLock, webcrypto),
        originalCoreDigest,
    );
    assert.notDeepEqual(
        await timedTicketEnvelopeDigest(changedLock, webcrypto),
        originalDigest,
    );
    await assert.rejects(
        parseTimedTicketEnvelope(changedLock, {crypto: webcrypto}),
        {code: "DIGEST_MISMATCH"},
    );
});

test("production defaults reject test tlock and every nonpinned chain", async () => {
    const lockedKeyProvider = provider();
    const request = {
        engine: ENGINE,
        sessionAccount: ACCOUNT,
        targetRound: 1n,
        secret: {side: "BUY", price: 1n, quantity: 1n, randomSalt: SALT},
        generation: GENERATION,
        feePolicyDigest: FEE_POLICY,
        lockedKeyProvider,
        crypto: webcrypto,
    };
    await assert.rejects(createTimedTicketEnvelope(request), {
        code: "TLOCK_PROVIDER_INSECURE",
    });
    await assert.rejects(
        createTimedTicketEnvelope({
            ...request,
            allowInsecureTestProvider: true,
            chainId: 295,
        }),
        {code: "CHAIN_INVALID"},
    );
    await assert.rejects(
        createTimedTicketEnvelope({
            ...request,
            allowInsecureTestProvider: true,
            chainHash: "00".repeat(32),
        }),
        {code: "CHAIN_INVALID"},
    );
});

test("round ceiling and safe reveal interval use exact BigInt arithmetic", () => {
    assert.equal(roundAtOrAfter(QUICKNET_GENESIS_TIME), 1n);
    assert.equal(roundAtOrAfter(QUICKNET_GENESIS_TIME + 1n), 2n);
    assert.equal(roundAtOrAfter(QUICKNET_GENESIS_TIME + 3n), 2n);
    assert.equal(roundAtOrAfter(QUICKNET_GENESIS_TIME + 4n), 3n);
    assert.equal(roundTime(3n), QUICKNET_GENESIS_TIME + 6n);

    const values = {
        commitTime: QUICKNET_GENESIS_TIME,
        revealDelay: 30n,
        revealWindow: 270n,
    };
    assert.deepEqual(safeRevealInterval(values), {
        earliest: QUICKNET_GENESIS_TIME + 42n,
        latest: QUICKNET_GENESIS_TIME + 240n,
    });
    assert.deepEqual(selectSafeTargetRound(values), {
        earliest: QUICKNET_GENESIS_TIME + 42n,
        latest: QUICKNET_GENESIS_TIME + 240n,
        targetRound: 15n,
        targetTime: QUICKNET_GENESIS_TIME + 42n,
    });
    assert.equal(assertSafeTargetRound(15n, values).targetTime, QUICKNET_GENESIS_TIME + 42n);
    assert.throws(() => assertSafeTargetRound(14n, values), {
        code: "ROUND_OUTSIDE_INTERVAL",
    });
    assert.throws(
        () => safeRevealInterval({...values, revealWindow: 70n}),
        {code: "INTERVAL_INVALID"},
    );
});

test("automation metadata and commitment match the SessionAccount vectors", () => {
    const values = {
        sessionAccount: "0x1111111111111111111111111111111111111111",
        engine: "0x2222222222222222222222222222222222222222",
        envelopeDigest: `0x${"aa".repeat(32)}`,
        targetRound: 123_456_789n,
        generation: 7n,
        feePolicyDigest: FEE_POLICY,
    };
    assert.equal(
        `0x${Buffer.from(computeTimedTicketAutomationMetadata(values)).toString("hex")}`,
        "0x307c197bc1f0c3d6db7538008016e4c3c041b627c10ed296cb3840b36ba9ff74",
    );
    assert.equal(
        `0x${Buffer.from(deriveTimedTicketRevealSalt(
            `0x${"bb".repeat(32)}`,
            values,
        )).toString("hex")}`,
        "0x6ba205bd2d0525c5630be8ef7b16d4b41ee0892a5433172f91d5ccaefb2791c8",
    );
    assert.equal(
        computeTimedTicketEngineCommitment({
            ...values,
            side: "SELL",
            price: 1_000_000n,
            quantity: 500n,
            randomSalt: `0x${"bb".repeat(32)}`,
        }),
        "0x2c052fc599b1c3abbcfaa2fbe165d92b1fa99596f5ce8ced537b2c8af4628680",
    );
});

test("errors and public summaries never contain order secrets", async () => {
    const secretPrice = "98765432123456789";
    const secretSalt = `0x${"ab".repeat(32)}`;
    let error;
    try {
        await createTimedTicketEnvelope({
            engine: ENGINE,
            sessionAccount: ACCOUNT,
            targetRound: 1n,
            secret: {
                side: "BUY",
                price: secretPrice,
                quantity: 0n,
                randomSalt: secretSalt,
            },
            generation: GENERATION,
            feePolicyDigest: FEE_POLICY,
            lockedKeyProvider: provider(),
            crypto: webcrypto,
            allowInsecureTestProvider: true,
        });
    } catch (caught) {
        error = caught;
    }
    assert.ok(error);
    assert.doesNotMatch(`${error.code}:${error.message}`, new RegExp(secretPrice));
    assert.equal(`${error.code}:${error.message}`.includes(secretSalt.slice(2)), false);
});
