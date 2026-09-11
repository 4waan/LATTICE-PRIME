import {commitmentOf, word} from "./commitment.mjs";
import {keccak_256} from "./keccak.mjs";

export const TIMED_TICKET_SIZE = 2048;
export const TIMED_TICKET_HEADER_SIZE = 256;
export const TIMED_TICKET_SECRET_SIZE = 1524;
export const TIMED_TICKET_CHAIN_ID = 296n;
export const TIMED_TICKET_GUARD_SECONDS = 12n;
export const TIMED_TICKET_MARGIN_SECONDS = 60n;
export const QUICKNET_CHAIN_HASH =
    "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
export const QUICKNET_GENESIS_TIME = 1692803367n;
export const QUICKNET_PERIOD_SECONDS = 3n;

const ENVELOPE_MAGIC = Uint8Array.of(0x48, 0x54, 0x54, 0x4b, 0x54, 0x30, 0x31, 0x00);
const SECRET_MAGIC = Uint8Array.of(0x48, 0x54, 0x53, 0x45, 0x43, 0x30, 0x31, 0x00);
const ENVELOPE_SCHEMA = 1;
const SECRET_SCHEMA = 1;
const UINT128_LIMIT = 1n << 128n;
const UINT64_LIMIT = 1n << 64n;
const CIPHERTEXT_OFFSET = TIMED_TICKET_HEADER_SIZE;
const CIPHERTEXT_LENGTH = TIMED_TICKET_SECRET_SIZE;
const TAG_OFFSET = CIPHERTEXT_OFFSET + CIPHERTEXT_LENGTH;
const TAG_LENGTH = 16;
const LOCKED_KEY_OFFSET = TAG_OFFSET + TAG_LENGTH;
export const TIMED_TICKET_LOCKED_KEY_SIZE = TIMED_TICKET_SIZE - LOCKED_KEY_OFFSET;
const DIGEST_OFFSET = 144;
const COMMITMENT_OFFSET = 176;
const IV_OFFSET = 208;
const HEADER_RESERVED_OFFSET = 236;
const SIDE_NAME = Object.freeze(["BUY", "SELL"]);
const AUTOMATION_DOMAIN = keccak_256(
    new TextEncoder().encode("hedera2026.session.automation-metadata.v1"),
);

export const TIMED_TICKET_OFFSETS = Object.freeze({
    magic: 0,
    schema: 8,
    headerSize: 10,
    envelopeSize: 12,
    secretSize: 14,
    flags: 16,
    chainId: 20,
    guard: 24,
    margin: 28,
    targetRound: 32,
    engine: 40,
    sessionAccount: 60,
    envelopeId: 80,
    quicknetChainHash: 112,
    envelopeDigest: DIGEST_OFFSET,
    engineCommitment: COMMITMENT_OFFSET,
    aesIv: IV_OFFSET,
    lockedSchema: 220,
    lockedLength: 222,
    ciphertextOffset: 224,
    ciphertextLength: 226,
    tagOffset: 228,
    tagLength: 230,
    lockedOffset: 232,
    cipherAlgorithm: 234,
    tlockAlgorithm: 235,
    ciphertext: CIPHERTEXT_OFFSET,
    authenticationTag: TAG_OFFSET,
    lockedKey: LOCKED_KEY_OFFSET,
});
export const TIMED_TICKET_SECRET_OFFSETS = Object.freeze({
    magic: 0,
    schema: 8,
    side: 10,
    price: 16,
    quantity: 32,
    randomSalt: 48,
    envelopeId: 80,
    generation: 112,
    feePolicyDigest: 120,
    randomPadding: 152,
});

export class TimedTicketError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "TimedTicketError";
        this.code = code;
    }
}

function fail(code, message) {
    throw new TimedTicketError(code, message);
}

function bytes(value, length, code = "BYTES_INVALID") {
    if (!(value instanceof Uint8Array) || value.byteLength !== length) {
        fail(code, "timed ticket data has invalid dimensions");
    }
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function cryptoApi(value = globalThis.crypto) {
    if (!value?.subtle || typeof value.getRandomValues !== "function") {
        fail("CRYPTO_UNAVAILABLE", "WebCrypto is required for timed tickets");
    }
    return value;
}

function dataView(value) {
    return new DataView(value.buffer, value.byteOffset, value.byteLength);
}

function equal(left, right) {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) {
        difference |= left[index] ^ right[index];
    }
    return difference === 0;
}

function allZero(value) {
    let combined = 0;
    for (const item of value) combined |= item;
    return combined === 0;
}

function hex(value) {
    return `0x${[...value].map((item) => item.toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(value, length, code) {
    if (
        typeof value !== "string"
        || !new RegExp(`^0x[0-9a-fA-F]{${length * 2}}$`).test(value)
    ) {
        fail(code, "timed ticket public identity is invalid");
    }
    return Uint8Array.from(
        {length},
        (_, index) => Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16),
    );
}

function address(value) {
    const result = parseHex(value, 20, "ADDRESS_INVALID");
    if (allZero(result)) fail("ADDRESS_INVALID", "timed ticket public identity is invalid");
    return result;
}

function uint(value, limit, code) {
    let parsed;
    try {
        if (
            typeof value === "bigint"
            || (typeof value === "number" && Number.isSafeInteger(value))
            || (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value))
        ) {
            parsed = BigInt(value);
        }
    } catch {
        parsed = undefined;
    }
    if (parsed === undefined || parsed < 0n || parsed >= limit) {
        fail(code, "timed ticket numeric input is invalid");
    }
    return parsed;
}

function positiveUint128(value) {
    const parsed = uint(value, UINT128_LIMIT, "SECRET_INVALID");
    if (parsed === 0n) fail("SECRET_INVALID", "timed ticket secret record is invalid");
    return parsed;
}

function round(value) {
    const parsed = uint(value, UINT64_LIMIT, "ROUND_INVALID");
    if (parsed === 0n) fail("ROUND_INVALID", "timed ticket round is invalid");
    return parsed;
}

function writeBigEndian(target, offset, length, value) {
    let remaining = value;
    for (let index = offset + length - 1; index >= offset; index -= 1) {
        target[index] = Number(remaining & 0xffn);
        remaining >>= 8n;
    }
}

function readBigEndian(source, offset, length) {
    let result = 0n;
    for (let index = offset; index < offset + length; index += 1) {
        result = (result << 8n) | BigInt(source[index]);
    }
    return result;
}

function normalizedHeader(header) {
    const aad = header.slice(0, TIMED_TICKET_HEADER_SIZE);
    aad.fill(0, DIGEST_OFFSET, DIGEST_OFFSET + 32);
    aad.fill(0, COMMITMENT_OFFSET, COMMITMENT_OFFSET + 32);
    return aad;
}

async function sha256(value, cryptoImpl) {
    return new Uint8Array(await cryptoApi(cryptoImpl).subtle.digest("SHA-256", value));
}

function normalizeSide(value) {
    if (value === "BUY" || value === 0 || value === 0n) return 0;
    if (value === "SELL" || value === 1 || value === 1n) return 1;
    fail("SECRET_INVALID", "timed ticket secret record is invalid");
}

export function generateTimedTicketCapability(cryptoImpl = globalThis.crypto) {
    return hex(cryptoApi(cryptoImpl).getRandomValues(new Uint8Array(32)));
}

function createSecretRecord(secret, envelopeId, generation, feePolicyDigest, cryptoImpl) {
    const record = new Uint8Array(TIMED_TICKET_SECRET_SIZE);
    record.set(SECRET_MAGIC, 0);
    const view = dataView(record);
    view.setUint16(8, SECRET_SCHEMA, false);
    record[10] = normalizeSide(secret?.side);
    writeBigEndian(record, 16, 16, positiveUint128(secret?.price));
    writeBigEndian(record, 32, 16, positiveUint128(secret?.quantity ?? secret?.qty));
    const salt = secret?.randomSalt === undefined
        ? cryptoApi(cryptoImpl).getRandomValues(new Uint8Array(32))
        : parseHex(secret.randomSalt, 32, "SECRET_INVALID");
    record.set(salt, 48);
    record.set(envelopeId, 80);
    writeBigEndian(record, 112, 8, generation);
    record.set(feePolicyDigest, 120);
    cryptoApi(cryptoImpl).getRandomValues(record.subarray(152));
    return record;
}

function decodeSecretRecord(record, expectedEnvelopeId) {
    try {
        bytes(record, TIMED_TICKET_SECRET_SIZE, "SECRET_INVALID");
        const view = dataView(record);
        if (
            !equal(record.subarray(0, 8), SECRET_MAGIC)
            || view.getUint16(8, false) !== SECRET_SCHEMA
            || record[10] > 1
            || !allZero(record.subarray(11, 16))
            || !equal(record.subarray(80, 112), expectedEnvelopeId)
        ) {
            fail("SECRET_INVALID", "timed ticket secret record is invalid");
        }
        const price = readBigEndian(record, 16, 16);
        const quantity = readBigEndian(record, 32, 16);
        if (price === 0n || quantity === 0n) {
            fail("SECRET_INVALID", "timed ticket secret record is invalid");
        }
        return {
            side: SIDE_NAME[record[10]],
            sideCode: record[10],
            price,
            quantity,
            randomSalt: record.slice(48, 80),
            generation: readBigEndian(record, 112, 8),
            feePolicyDigest: record.slice(120, 152),
        };
    } catch (error) {
        if (error instanceof TimedTicketError) throw error;
        fail("SECRET_INVALID", "timed ticket secret record is invalid");
    }
}

function initializeHeader({engine, sessionAccount, envelopeId, targetRound, aesIv}) {
    const header = new Uint8Array(TIMED_TICKET_HEADER_SIZE);
    const view = dataView(header);
    header.set(ENVELOPE_MAGIC, 0);
    view.setUint16(8, ENVELOPE_SCHEMA, false);
    view.setUint16(10, TIMED_TICKET_HEADER_SIZE, false);
    view.setUint16(12, TIMED_TICKET_SIZE, false);
    view.setUint16(14, TIMED_TICKET_SECRET_SIZE, false);
    view.setUint32(20, Number(TIMED_TICKET_CHAIN_ID), false);
    view.setUint32(24, Number(TIMED_TICKET_GUARD_SECONDS), false);
    view.setUint32(28, Number(TIMED_TICKET_MARGIN_SECONDS), false);
    writeBigEndian(header, 32, 8, targetRound);
    header.set(engine, 40);
    header.set(sessionAccount, 60);
    header.set(envelopeId, 80);
    header.set(parseHex(`0x${QUICKNET_CHAIN_HASH}`, 32, "CHAIN_INVALID"), 112);
    header.set(aesIv, IV_OFFSET);
    view.setUint16(220, 1, false);
    view.setUint16(222, TIMED_TICKET_LOCKED_KEY_SIZE, false);
    view.setUint16(224, CIPHERTEXT_OFFSET, false);
    view.setUint16(226, CIPHERTEXT_LENGTH, false);
    view.setUint16(228, TAG_OFFSET, false);
    view.setUint16(230, TAG_LENGTH, false);
    view.setUint16(232, LOCKED_KEY_OFFSET, false);
    header[234] = 1;
    header[235] = 1;
    return header;
}

function structuralParse(envelope, {allowUncommitted = false} = {}) {
    const input = bytes(envelope, TIMED_TICKET_SIZE, "SIZE_INVALID");
    const view = dataView(input);
    const chainHash = parseHex(`0x${QUICKNET_CHAIN_HASH}`, 32, "CHAIN_INVALID");
    if (
        !equal(input.subarray(0, 8), ENVELOPE_MAGIC)
        || view.getUint16(8, false) !== ENVELOPE_SCHEMA
        || view.getUint16(10, false) !== TIMED_TICKET_HEADER_SIZE
        || view.getUint16(12, false) !== TIMED_TICKET_SIZE
        || view.getUint16(14, false) !== TIMED_TICKET_SECRET_SIZE
        || view.getUint32(16, false) !== 0
        || BigInt(view.getUint32(20, false)) !== TIMED_TICKET_CHAIN_ID
        || BigInt(view.getUint32(24, false)) !== TIMED_TICKET_GUARD_SECONDS
        || BigInt(view.getUint32(28, false)) !== TIMED_TICKET_MARGIN_SECONDS
        || view.getUint16(220, false) !== 1
        || view.getUint16(222, false) !== TIMED_TICKET_LOCKED_KEY_SIZE
        || view.getUint16(224, false) !== CIPHERTEXT_OFFSET
        || view.getUint16(226, false) !== CIPHERTEXT_LENGTH
        || view.getUint16(228, false) !== TAG_OFFSET
        || view.getUint16(230, false) !== TAG_LENGTH
        || view.getUint16(232, false) !== LOCKED_KEY_OFFSET
        || input[234] !== 1
        || input[235] !== 1
        || !allZero(input.subarray(HEADER_RESERVED_OFFSET, TIMED_TICKET_HEADER_SIZE))
        || !equal(input.subarray(112, 144), chainHash)
    ) {
        fail("HEADER_INVALID", "timed ticket public header is invalid");
    }
    const targetRound = readBigEndian(input, 32, 8);
    if (
        targetRound === 0n
        || allZero(input.subarray(40, 60))
        || allZero(input.subarray(60, 80))
        || allZero(input.subarray(80, 112))
        || allZero(input.subarray(DIGEST_OFFSET, DIGEST_OFFSET + 32))
        || (!allowUncommitted && allZero(input.subarray(COMMITMENT_OFFSET, COMMITMENT_OFFSET + 32)))
        || allZero(input.subarray(IV_OFFSET, IV_OFFSET + 12))
        || allZero(input.subarray(LOCKED_KEY_OFFSET))
    ) {
        fail("HEADER_INVALID", "timed ticket public header is invalid");
    }
    return {
        bytes: input,
        chainId: TIMED_TICKET_CHAIN_ID,
        engine: hex(input.subarray(40, 60)),
        sessionAccount: hex(input.subarray(60, 80)),
        envelopeId: hex(input.subarray(80, 112)),
        chainHash: QUICKNET_CHAIN_HASH,
        targetRound,
        targetTime: roundTime(targetRound),
        guardSeconds: TIMED_TICKET_GUARD_SECONDS,
        marginSeconds: TIMED_TICKET_MARGIN_SECONDS,
        envelopeDigest: hex(input.subarray(DIGEST_OFFSET, DIGEST_OFFSET + 32)),
        engineCommitment: hex(input.subarray(COMMITMENT_OFFSET, COMMITMENT_OFFSET + 32)),
    };
}

function expectedPublic(parsed, expected) {
    if (expected === undefined) return;
    if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
        fail("EXPECTED_CONTEXT_INVALID", "timed ticket expected context is invalid");
    }
    const comparisons = [
        ["chainId", parsed.chainId, (value) => uint(value, 1n << 32n, "EXPECTED_CONTEXT_INVALID")],
        ["engine", parsed.engine, (value) => hex(address(value))],
        ["sessionAccount", parsed.sessionAccount, (value) => hex(address(value))],
        ["envelopeId", parsed.envelopeId, (value) =>
            hex(parseHex(value, 32, "EXPECTED_CONTEXT_INVALID"))],
        ["engineCommitment", parsed.engineCommitment, (value) =>
            hex(parseHex(value, 32, "EXPECTED_CONTEXT_INVALID"))],
        ["targetRound", parsed.targetRound, round],
    ];
    for (const [key, actual, convert] of comparisons) {
        if (expected[key] !== undefined && convert(expected[key]) !== actual) {
            fail("CONTEXT_MISMATCH", "timed ticket does not match the required public context");
        }
    }
    if (
        expected.chainHash !== undefined
        && (
            typeof expected.chainHash !== "string"
            || expected.chainHash.toLowerCase() !== QUICKNET_CHAIN_HASH
        )
    ) {
        fail("CONTEXT_MISMATCH", "timed ticket does not match the required public context");
    }
}

export function roundTime(roundNumber) {
    const targetRound = round(roundNumber);
    return QUICKNET_GENESIS_TIME + (targetRound - 1n) * QUICKNET_PERIOD_SECONDS;
}

export function roundAtOrAfter(timestamp) {
    const target = uint(timestamp, UINT64_LIMIT, "TIME_INVALID");
    if (target < QUICKNET_GENESIS_TIME) {
        fail("TIME_INVALID", "timed ticket target precedes Quicknet genesis");
    }
    const elapsed = target - QUICKNET_GENESIS_TIME;
    return 1n + (elapsed + QUICKNET_PERIOD_SECONDS - 1n) / QUICKNET_PERIOD_SECONDS;
}

export function safeRevealInterval({
    commitTime,
    revealDelay,
    revealWindow,
    guard = TIMED_TICKET_GUARD_SECONDS,
    margin = TIMED_TICKET_MARGIN_SECONDS,
}) {
    const c = uint(commitTime, UINT64_LIMIT, "INTERVAL_INVALID");
    const d = uint(revealDelay, UINT64_LIMIT, "INTERVAL_INVALID");
    const w = uint(revealWindow, UINT64_LIMIT, "INTERVAL_INVALID");
    const g = uint(guard, UINT64_LIMIT, "INTERVAL_INVALID");
    const m = uint(margin, UINT64_LIMIT, "INTERVAL_INVALID");
    if (
        g !== TIMED_TICKET_GUARD_SECONDS
        || m !== TIMED_TICKET_MARGIN_SECONDS
        || w < m
    ) {
        fail("INTERVAL_INVALID", "timed ticket reveal interval is unsafe");
    }
    const earliest = c + d + g;
    const latest = c + d + w - m;
    if (earliest > latest || latest >= UINT64_LIMIT) {
        fail("INTERVAL_INVALID", "timed ticket reveal interval is unsafe");
    }
    return Object.freeze({earliest, latest});
}

export function selectSafeTargetRound(values) {
    const interval = safeRevealInterval(values);
    const targetRound = roundAtOrAfter(interval.earliest);
    const targetTime = roundTime(targetRound);
    if (targetTime < interval.earliest || targetTime > interval.latest) {
        fail("NO_SAFE_ROUND", "no Quicknet round fits the reveal interval");
    }
    return Object.freeze({...interval, targetRound, targetTime});
}

export function assertSafeTargetRound(targetRound, values) {
    const interval = safeRevealInterval(values);
    const selectedRound = round(targetRound);
    const targetTime = roundTime(selectedRound);
    if (targetTime < interval.earliest || targetTime > interval.latest) {
        fail("ROUND_OUTSIDE_INTERVAL", "timed ticket round is outside the safe reveal interval");
    }
    return Object.freeze({...interval, targetRound: selectedRound, targetTime});
}

function concatWords(values) {
    const output = new Uint8Array(values.length * 32);
    values.forEach((value, index) => output.set(value, index * 32));
    return output;
}

export function computeTimedTicketAutomationMetadata({
    sessionAccount,
    engine,
    envelopeDigest,
    targetRound,
    generation,
    feePolicyDigest,
    chainHash = QUICKNET_CHAIN_HASH,
}) {
    const chain = typeof chainHash === "string"
        ? parseHex(`0x${chainHash.replace(/^0x/, "")}`, 32, "CHAIN_INVALID")
        : bytes(chainHash, 32, "CHAIN_INVALID");
    if (hex(chain).slice(2) !== QUICKNET_CHAIN_HASH) {
        fail("CHAIN_INVALID", "timed tickets require the pinned Quicknet chain");
    }
    const digest = typeof envelopeDigest === "string"
        ? parseHex(envelopeDigest, 32, "DIGEST_INVALID")
        : bytes(envelopeDigest, 32, "DIGEST_INVALID");
    const feePolicy = typeof feePolicyDigest === "string"
        ? parseHex(feePolicyDigest, 32, "FEE_POLICY_INVALID")
        : bytes(feePolicyDigest, 32, "FEE_POLICY_INVALID");
    return keccak_256(concatWords([
        AUTOMATION_DOMAIN,
        chain,
        word(BigInt(hex(address(sessionAccount)))),
        word(uint(generation, UINT64_LIMIT, "GENERATION_INVALID")),
        word(BigInt(hex(address(engine)))),
        digest,
        word(round(targetRound)),
        feePolicy,
    ]));
}

export function deriveTimedTicketRevealSalt(randomSalt, automation) {
    const random = typeof randomSalt === "string"
        ? parseHex(randomSalt, 32, "SECRET_INVALID")
        : bytes(randomSalt, 32, "SECRET_INVALID");
    const metadata = computeTimedTicketAutomationMetadata(automation);
    return keccak_256(concatWords([metadata, random]));
}

export function computeTimedTicketEngineCommitment({
    sessionAccount,
    engine,
    side,
    price,
    quantity,
    randomSalt,
    envelopeDigest,
    targetRound,
    generation,
    feePolicyDigest,
}) {
    const revealSalt = deriveTimedTicketRevealSalt(randomSalt, {
        sessionAccount,
        engine,
        envelopeDigest,
        targetRound,
        generation,
        feePolicyDigest,
    });
    return commitmentOf(
        hex(address(sessionAccount)),
        normalizeSide(side),
        positiveUint128(price),
        positiveUint128(quantity),
        hex(revealSalt),
    ).toLowerCase();
}

export function setTimedTicketCommitment(envelope, engineCommitment) {
    const parsed = structuralParse(envelope, {allowUncommitted: true});
    const commitment = typeof engineCommitment === "string"
        ? parseHex(engineCommitment, 32, "COMMITMENT_INVALID")
        : bytes(engineCommitment, 32, "COMMITMENT_INVALID");
    if (allZero(commitment)) {
        fail("COMMITMENT_INVALID", "timed ticket engine commitment is invalid");
    }
    const result = parsed.bytes.slice();
    result.set(commitment, COMMITMENT_OFFSET);
    return result;
}

export async function timedTicketCoreDigest(envelope, cryptoImpl = globalThis.crypto) {
    const input = bytes(envelope, TIMED_TICKET_SIZE, "SIZE_INVALID");
    const core = input.slice(0, LOCKED_KEY_OFFSET);
    core.fill(0, DIGEST_OFFSET, DIGEST_OFFSET + 32);
    core.fill(0, COMMITMENT_OFFSET, COMMITMENT_OFFSET + 32);
    return sha256(core, cryptoImpl);
}

export async function timedTicketEnvelopeDigest(envelope, cryptoImpl = globalThis.crypto) {
    const input = bytes(envelope, TIMED_TICKET_SIZE, "SIZE_INVALID").slice();
    input.fill(0, DIGEST_OFFSET, DIGEST_OFFSET + 32);
    input.fill(0, COMMITMENT_OFFSET, COMMITMENT_OFFSET + 32);
    return sha256(input, cryptoImpl);
}

export async function parseTimedTicketEnvelope(
    envelope,
    {
        crypto: cryptoImpl = globalThis.crypto,
        expected,
        allowUncommitted = false,
    } = {},
) {
    const parsed = structuralParse(envelope, {allowUncommitted});
    const digest = await timedTicketEnvelopeDigest(parsed.bytes, cryptoImpl);
    if (!equal(digest, parsed.bytes.subarray(DIGEST_OFFSET, DIGEST_OFFSET + 32))) {
        fail("DIGEST_MISMATCH", "timed ticket envelope digest is invalid");
    }
    expectedPublic(parsed, expected);
    const {bytes: omitted, ...publicHeader} = parsed;
    return Object.freeze(publicHeader);
}

function requireLockedKeyProvider(provider, allowInsecureTestProvider) {
    if (
        provider === null
        || typeof provider !== "object"
        || typeof provider.lock !== "function"
        || typeof provider.unlock !== "function"
        || typeof provider.verifyTarget !== "function"
    ) {
        fail("TLOCK_PROVIDER_INVALID", "timed ticket locked-key provider is invalid");
    }
    if (provider.securityLevel !== "production" && allowInsecureTestProvider !== true) {
        fail("TLOCK_PROVIDER_INSECURE", "production timed tickets require a verified tlock provider");
    }
    return provider;
}

export async function createTimedTicketEnvelope({
    engine,
    sessionAccount,
    targetRound,
    secret,
    generation,
    feePolicyDigest,
    envelopeId,
    lockedKeyProvider,
    crypto: cryptoImpl = globalThis.crypto,
    allowInsecureTestProvider = false,
    chainId = TIMED_TICKET_CHAIN_ID,
    chainHash = QUICKNET_CHAIN_HASH,
}) {
    const api = cryptoApi(cryptoImpl);
    if (
        uint(chainId, 1n << 32n, "CHAIN_INVALID") !== TIMED_TICKET_CHAIN_ID
        || typeof chainHash !== "string"
        || chainHash.toLowerCase() !== QUICKNET_CHAIN_HASH
    ) {
        fail("CHAIN_INVALID", "timed tickets require the pinned Quicknet chain");
    }
    const provider = requireLockedKeyProvider(lockedKeyProvider, allowInsecureTestProvider);
    const engineBytes = address(engine);
    const accountBytes = address(sessionAccount);
    const idBytes = envelopeId === undefined
        ? api.getRandomValues(new Uint8Array(32))
        : parseHex(envelopeId, 32, "ENVELOPE_ID_INVALID");
    if (allZero(idBytes)) fail("ENVELOPE_ID_INVALID", "timed ticket envelope id is invalid");
    const target = round(targetRound);
    const sessionGeneration = uint(generation, UINT64_LIMIT, "GENERATION_INVALID");
    const feePolicy = typeof feePolicyDigest === "string"
        ? parseHex(feePolicyDigest, 32, "FEE_POLICY_INVALID")
        : bytes(feePolicyDigest, 32, "FEE_POLICY_INVALID");
    const iv = api.getRandomValues(new Uint8Array(12));
    const header = initializeHeader({
        engine: engineBytes,
        sessionAccount: accountBytes,
        envelopeId: idBytes,
        targetRound: target,
        aesIv: iv,
    });
    const envelope = new Uint8Array(TIMED_TICKET_SIZE);
    envelope.set(header, 0);
    const plaintext = createSecretRecord(
        secret,
        idBytes,
        sessionGeneration,
        feePolicy,
        api,
    );
    const rawKey = api.getRandomValues(new Uint8Array(32));
    const lockedPayload = new Uint8Array(64);
    try {
        const key = await api.subtle.importKey("raw", rawKey, {name: "AES-GCM"}, false, ["encrypt"]);
        const sealed = new Uint8Array(await api.subtle.encrypt(
            {
                name: "AES-GCM",
                iv,
                additionalData: normalizedHeader(header),
                tagLength: 128,
            },
            key,
            plaintext,
        ));
        if (sealed.length !== CIPHERTEXT_LENGTH + TAG_LENGTH) {
            fail("CRYPTO_FAILED", "timed ticket encryption returned invalid dimensions");
        }
        envelope.set(sealed.subarray(0, CIPHERTEXT_LENGTH), CIPHERTEXT_OFFSET);
        envelope.set(sealed.subarray(CIPHERTEXT_LENGTH), TAG_OFFSET);
        const coreDigest = await timedTicketCoreDigest(envelope, api);
        lockedPayload.set(rawKey, 0);
        lockedPayload.set(coreDigest, 32);
        let locked;
        try {
            locked = await provider.lock(lockedPayload, {
                chainHash: QUICKNET_CHAIN_HASH,
                round: target,
                bindingDigest: coreDigest.slice(),
            });
        } catch {
            fail("TLOCK_LOCK_FAILED", "timed ticket key could not be timelocked");
        }
        envelope.set(bytes(locked, TIMED_TICKET_LOCKED_KEY_SIZE, "TLOCK_LOCK_FAILED"), LOCKED_KEY_OFFSET);
        const digest = await timedTicketEnvelopeDigest(envelope, api);
        envelope.set(digest, DIGEST_OFFSET);
        const decoded = decodeSecretRecord(plaintext, idBytes);
        const engineCommitment = computeTimedTicketEngineCommitment({
            sessionAccount: hex(accountBytes),
            engine: hex(engineBytes),
            side: decoded.sideCode,
            price: decoded.price,
            quantity: decoded.quantity,
            randomSalt: decoded.randomSalt,
            envelopeDigest: digest,
            targetRound: target,
            generation: decoded.generation,
            feePolicyDigest: decoded.feePolicyDigest,
        });
        const finalEnvelope = setTimedTicketCommitment(envelope, engineCommitment);
        await parseTimedTicketEnvelope(finalEnvelope, {
            crypto: api,
            expected: {
                engine: hex(engineBytes),
                sessionAccount: hex(accountBytes),
                envelopeId: hex(idBytes),
                engineCommitment,
                targetRound: target,
            },
        });
        return Object.freeze({
            envelope: finalEnvelope,
            envelopeDigest: hex(digest),
            engineCommitment,
            envelopeId: hex(idBytes),
            targetRound: target,
            targetTime: roundTime(target),
            generation: sessionGeneration,
            feePolicyDigest: hex(feePolicy),
        });
    } finally {
        plaintext.fill(0);
        rawKey.fill(0);
        lockedPayload.fill(0);
    }
}

export async function decryptTimedTicketEnvelope(
    envelope,
    {
        lockedKeyProvider,
        verifiedBeacon,
        crypto: cryptoImpl = globalThis.crypto,
        expected,
        allowInsecureTestProvider = false,
    } = {},
) {
    const api = cryptoApi(cryptoImpl);
    const provider = requireLockedKeyProvider(lockedKeyProvider, allowInsecureTestProvider);
    const parsed = await parseTimedTicketEnvelope(envelope, {crypto: api, expected});
    const input = bytes(envelope, TIMED_TICKET_SIZE, "SIZE_INVALID");
    const envelopeDigest = input.slice(DIGEST_OFFSET, DIGEST_OFFSET + 32);
    const coreDigest = await timedTicketCoreDigest(input, api);
    let unlocked;
    try {
        unlocked = await provider.unlock(
            input.slice(LOCKED_KEY_OFFSET),
            {
                chainHash: QUICKNET_CHAIN_HASH,
                round: parsed.targetRound,
                bindingDigest: coreDigest.slice(),
            },
            verifiedBeacon,
        );
    } catch {
        fail("TLOCK_UNLOCK_FAILED", "timed ticket key is not available");
    }
    const material = bytes(unlocked, 64, "TLOCK_UNLOCK_FAILED");
    let plaintext;
    try {
        if (!equal(material.subarray(32), coreDigest)) {
            fail("TLOCK_BINDING_MISMATCH", "timed ticket key binding is invalid");
        }
        const key = await api.subtle.importKey(
            "raw",
            material.subarray(0, 32),
            {name: "AES-GCM"},
            false,
            ["decrypt"],
        );
        const sealed = new Uint8Array(CIPHERTEXT_LENGTH + TAG_LENGTH);
        sealed.set(input.subarray(CIPHERTEXT_OFFSET, TAG_OFFSET), 0);
        sealed.set(input.subarray(TAG_OFFSET, LOCKED_KEY_OFFSET), CIPHERTEXT_LENGTH);
        try {
            plaintext = new Uint8Array(await api.subtle.decrypt(
                {
                    name: "AES-GCM",
                    iv: input.subarray(IV_OFFSET, IV_OFFSET + 12),
                    additionalData: normalizedHeader(input.subarray(0, TIMED_TICKET_HEADER_SIZE)),
                    tagLength: 128,
                },
                key,
                sealed,
            ));
        } catch {
            fail("PAYLOAD_AUTHENTICATION_FAILED", "timed ticket payload authentication failed");
        } finally {
            sealed.fill(0);
        }
        const secret = decodeSecretRecord(plaintext, input.subarray(80, 112));
        if (
            expected?.generation !== undefined
            && uint(expected.generation, UINT64_LIMIT, "EXPECTED_CONTEXT_INVALID")
                !== secret.generation
        ) {
            fail("CONTEXT_MISMATCH", "timed ticket does not match the required public context");
        }
        if (
            expected?.feePolicyDigest !== undefined
            && !equal(
                parseHex(expected.feePolicyDigest, 32, "EXPECTED_CONTEXT_INVALID"),
                secret.feePolicyDigest,
            )
        ) {
            fail("CONTEXT_MISMATCH", "timed ticket does not match the required public context");
        }
        const revealSalt = deriveTimedTicketRevealSalt(secret.randomSalt, {
            sessionAccount: parsed.sessionAccount,
            engine: parsed.engine,
            envelopeDigest,
            targetRound: parsed.targetRound,
            generation: secret.generation,
            feePolicyDigest: secret.feePolicyDigest,
        });
        const commitment = computeTimedTicketEngineCommitment({
            sessionAccount: parsed.sessionAccount,
            engine: parsed.engine,
            side: secret.sideCode,
            price: secret.price,
            quantity: secret.quantity,
            randomSalt: secret.randomSalt,
            envelopeDigest,
            targetRound: parsed.targetRound,
            generation: secret.generation,
            feePolicyDigest: secret.feePolicyDigest,
        });
        if (commitment !== parsed.engineCommitment) {
            secret.randomSalt.fill(0);
            revealSalt.fill(0);
            fail("COMMITMENT_MISMATCH", "timed ticket engine commitment is invalid");
        }
        return Object.freeze({
            side: secret.side,
            price: secret.price,
            quantity: secret.quantity,
            randomSalt: secret.randomSalt,
            revealSalt,
            generation: secret.generation,
            feePolicyDigest: hex(secret.feePolicyDigest),
        });
    } finally {
        material.fill(0);
        if (plaintext) plaintext.fill(0);
    }
}

export function createInsecureTestLockedKeyProvider({
    crypto: cryptoImpl = globalThis.crypto,
    available = true,
} = {}) {
    const api = cryptoApi(cryptoImpl);
    const keyByLock = new Map();
    const verified = new WeakSet();
    return Object.freeze({
        securityLevel: "test-only",
        async lock(payload) {
            const value = bytes(payload, 64, "TLOCK_LOCK_FAILED");
            const locked = api.getRandomValues(new Uint8Array(TIMED_TICKET_LOCKED_KEY_SIZE));
            keyByLock.set(hex(await sha256(locked, api)), value.slice());
            return locked;
        },
        async verifyTarget(roundNumber) {
            if (!available) fail("BEACON_UNAVAILABLE", "test beacon is unavailable");
            const token = Object.freeze({
                chainHash: QUICKNET_CHAIN_HASH,
                round: round(roundNumber),
            });
            verified.add(token);
            return token;
        },
        async unlock(locked, context, token) {
            if (
                !verified.has(token)
                || token.chainHash !== QUICKNET_CHAIN_HASH
                || token.round !== round(context?.round)
            ) {
                fail("BEACON_INVALID", "test beacon is invalid");
            }
            const value = keyByLock.get(hex(await sha256(
                bytes(locked, TIMED_TICKET_LOCKED_KEY_SIZE, "TLOCK_UNLOCK_FAILED"),
                api,
            )));
            if (!value) fail("TLOCK_UNLOCK_FAILED", "test locked key is unavailable");
            return value.slice();
        },
    });
}
