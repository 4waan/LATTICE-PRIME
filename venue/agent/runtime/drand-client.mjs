import {bls12_381} from "@noble/curves/bls12-381";
import {sha256} from "@noble/hashes/sha256";

import {
    QUICKNET_CHAIN_HASH,
    QUICKNET_GENESIS_TIME,
    QUICKNET_PERIOD_SECONDS,
    TIMED_TICKET_LOCKED_KEY_SIZE,
    TimedTicketError,
    roundTime,
} from "../../tools/timed-ticket.mjs";

export const QUICKNET_PUBLIC_KEY =
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
export const QUICKNET_GROUP_HASH =
    "f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e";
export const QUICKNET_SCHEME = "bls-unchained-g1-rfc9380";
export const QUICKNET_ORIGINS = Object.freeze([
    "https://api.drand.sh",
    "https://drand.cloudflare.com",
    "https://api2.drand.sh",
    "https://api3.drand.sh",
]);
const QUICKNET_PATH = `/${QUICKNET_CHAIN_HASH}`;
const QUICKNET_FETCH_TIMEOUT_MS = 5_000;
const BLS_DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";
const IBE_H2 = new TextEncoder().encode("IBE-H2");
const IBE_H3 = new TextEncoder().encode("IBE-H3");
const IBE_H4 = new TextEncoder().encode("IBE-H4");
const WRAP_DOMAIN = new TextEncoder().encode("hedera2026.timed-ticket.tlock-wrap.v1");
const U_LENGTH = 96;
const IBE_MESSAGE_LENGTH = 32;
const IBE_LENGTH = U_LENGTH + IBE_MESSAGE_LENGTH * 2;
const WRAP_IV_OFFSET = IBE_LENGTH;
const WRAP_CIPHERTEXT_OFFSET = WRAP_IV_OFFSET + 12;
const WRAP_TAG_OFFSET = WRAP_CIPHERTEXT_OFFSET + 64;
const MAX_JSON_BYTES = 4096;
const verifiedTokens = new WeakMap();

export class DrandVerificationError extends TimedTicketError {
    constructor(code, message) {
        super(code, message);
        this.name = "DrandVerificationError";
    }
}

function fail(code, message) {
    throw new DrandVerificationError(code, message);
}

function bytes(value, length, code) {
    if (!(value instanceof Uint8Array) || value.byteLength !== length) {
        fail(code, "Quicknet cryptographic data has invalid dimensions");
    }
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function hexBytes(value, length, code) {
    if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${length * 2}}$`).test(value)) {
        fail(code, "Quicknet response data is invalid");
    }
    return Uint8Array.from(
        {length},
        (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
    );
}

function hex(value) {
    return [...value].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function equal(left, right) {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) {
        difference |= left[index] ^ right[index];
    }
    return difference === 0;
}

function concat(...values) {
    const output = new Uint8Array(values.reduce((size, value) => size + value.length, 0));
    let offset = 0;
    for (const value of values) {
        output.set(value, offset);
        offset += value.length;
    }
    return output;
}

function xor(left, right) {
    if (left.length !== right.length) fail("TLOCK_INVALID", "tlock ciphertext is invalid");
    return Uint8Array.from(left, (item, index) => item ^ right[index]);
}

function roundValue(value) {
    let parsed;
    try {
        parsed = BigInt(value);
    } catch {
        fail("ROUND_INVALID", "Quicknet round is invalid");
    }
    if (parsed < 1n || parsed >= 1n << 64n) {
        fail("ROUND_INVALID", "Quicknet round is invalid");
    }
    return parsed;
}

function roundBytes(value) {
    let remaining = roundValue(value);
    const output = new Uint8Array(8);
    for (let index = 7; index >= 0; index -= 1) {
        output[index] = Number(remaining & 0xffn);
        remaining >>= 8n;
    }
    return output;
}

export function quicknetRoundIdentity(value) {
    return sha256(roundBytes(value));
}

function fpToBytes(value) {
    const valueHex = value.toString(16).padStart(96, "0");
    return Uint8Array.from(
        {length: 48},
        (_, index) => Number.parseInt(valueHex.slice(index * 2, index * 2 + 2), 16),
    );
}

function fp2ToBytes(value) {
    return concat(fpToBytes(value.c1), fpToBytes(value.c0));
}

function fp6ToBytes(value) {
    return concat(fp2ToBytes(value.c2), fp2ToBytes(value.c1), fp2ToBytes(value.c0));
}

function fp12ToBytes(value) {
    return concat(fp6ToBytes(value.c1), fp6ToBytes(value.c0));
}

function gtHash(value, length) {
    return sha256.create().update(IBE_H2).update(fp12ToBytes(value)).digest().slice(0, length);
}

function h4(sigma, length) {
    return sha256.create().update(IBE_H4).update(sigma).digest().slice(0, length);
}

function h3(sigma, message) {
    const seed = sha256.create().update(IBE_H3).update(sigma).update(message).digest();
    for (let counter = 1; counter < 65535; counter += 1) {
        const prefix = Uint8Array.of(counter & 0xff, counter >>> 8);
        const candidate = sha256.create().update(prefix).update(seed).digest();
        candidate[0] >>= 1;
        const scalar = BigInt(`0x${hex(candidate)}`);
        if (scalar < bls12_381.fields.Fr.ORDER) return scalar;
    }
    fail("TLOCK_INVALID", "tlock scalar derivation failed");
}

function context(value) {
    if (
        value === null
        || typeof value !== "object"
        || value.chainHash !== QUICKNET_CHAIN_HASH
    ) {
        fail("CHAIN_MISMATCH", "tlock context does not use pinned Quicknet");
    }
    return {
        round: roundValue(value.round),
        bindingDigest: bytes(value.bindingDigest, 32, "BINDING_INVALID"),
    };
}

function wrapAad(value) {
    return concat(
        WRAP_DOMAIN,
        hexBytes(QUICKNET_CHAIN_HASH, 32, "CHAIN_MISMATCH"),
        roundBytes(value.round),
        value.bindingDigest,
    );
}

function webCrypto(value = globalThis.crypto) {
    if (!value?.subtle || typeof value.getRandomValues !== "function") {
        fail("CRYPTO_UNAVAILABLE", "WebCrypto is required for Quicknet tlock");
    }
    return value;
}

export function validateQuicknetChainInfo(info) {
    if (
        info === null
        || typeof info !== "object"
        || Array.isArray(info)
        || info.public_key !== QUICKNET_PUBLIC_KEY
        || info.period !== Number(QUICKNET_PERIOD_SECONDS)
        || info.genesis_time !== Number(QUICKNET_GENESIS_TIME)
        || info.hash !== QUICKNET_CHAIN_HASH
        || info.groupHash !== QUICKNET_GROUP_HASH
        || info.schemeID !== QUICKNET_SCHEME
        || info.metadata?.beaconID !== "quicknet"
    ) {
        fail("CHAIN_INFO_MISMATCH", "drand chain info does not match pinned Quicknet");
    }
    try {
        const publicKey = bls12_381.G2.ProjectivePoint.fromHex(
            hexBytes(info.public_key, 96, "CHAIN_INFO_MISMATCH"),
        );
        if (publicKey.equals(bls12_381.G2.ProjectivePoint.ZERO)) {
            fail("CHAIN_INFO_MISMATCH", "drand chain info does not match pinned Quicknet");
        }
    } catch (error) {
        if (error instanceof DrandVerificationError) throw error;
        fail("CHAIN_INFO_MISMATCH", "drand chain info does not match pinned Quicknet");
    }
    return Object.freeze({
        public_key: QUICKNET_PUBLIC_KEY,
        period: Number(QUICKNET_PERIOD_SECONDS),
        genesis_time: Number(QUICKNET_GENESIS_TIME),
        hash: QUICKNET_CHAIN_HASH,
        groupHash: QUICKNET_GROUP_HASH,
        schemeID: QUICKNET_SCHEME,
        metadata: Object.freeze({beaconID: "quicknet"}),
    });
}

export function verifyQuicknetBeacon(beacon, expectedRound) {
    const targetRound = roundValue(expectedRound);
    if (
        targetRound > BigInt(Number.MAX_SAFE_INTEGER)
        || beacon === null
        || typeof beacon !== "object"
        || Array.isArray(beacon)
        || Object.keys(beacon).sort().join(",") !== "randomness,round,signature"
        || beacon.round !== Number(targetRound)
    ) {
        fail("BEACON_INVALID", "drand beacon is invalid");
    }
    const signature = hexBytes(beacon.signature, 48, "BEACON_INVALID");
    const randomness = hexBytes(beacon.randomness, 32, "BEACON_INVALID");
    if (!equal(sha256(signature), randomness)) {
        fail("BEACON_INVALID", "drand beacon is invalid");
    }
    try {
        const publicKey = bls12_381.G2.ProjectivePoint.fromHex(
            hexBytes(QUICKNET_PUBLIC_KEY, 96, "BEACON_INVALID"),
        );
        const signaturePoint = bls12_381.G1.ProjectivePoint.fromHex(signature);
        const messagePoint = bls12_381.G1.hashToCurve(quicknetRoundIdentity(targetRound), {
            DST: BLS_DST,
        });
        if (
            signaturePoint.equals(bls12_381.G1.ProjectivePoint.ZERO)
            || !bls12_381.fields.Fp12.eql(
                bls12_381.fields.Fp12.mul(
                    bls12_381.pairing(signaturePoint, bls12_381.G2.ProjectivePoint.BASE, true),
                    bls12_381.pairing(messagePoint, publicKey.negate(), true),
                ),
                bls12_381.fields.Fp12.ONE,
            )
        ) {
            fail("BEACON_INVALID", "drand beacon signature is invalid");
        }
    } catch (error) {
        if (error instanceof DrandVerificationError) throw error;
        fail("BEACON_INVALID", "drand beacon signature is invalid");
    }
    return Object.freeze({
        round: targetRound,
        randomness: beacon.randomness,
        signature: beacon.signature,
    });
}

async function readJsonResponse(response, code) {
    if (!response?.ok) fail(code, "Quicknet request failed");
    const declared = response.headers?.get?.("content-length");
    if (declared !== null && declared !== undefined && Number(declared) > MAX_JSON_BYTES) {
        fail(code, "Quicknet response is invalid");
    }
    let text;
    try {
        text = await response.text();
    } catch {
        fail(code, "Quicknet response is invalid");
    }
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_JSON_BYTES) {
        fail(code, "Quicknet response is invalid");
    }
    try {
        return JSON.parse(text);
    } catch {
        fail(code, "Quicknet response is invalid");
    }
}

export class PinnedQuicknetClient {
    constructor({fetchImpl = globalThis.fetch} = {}) {
        if (typeof fetchImpl !== "function") {
            fail("FETCH_UNAVAILABLE", "fetch is required for Quicknet");
        }
        this.fetchImpl = fetchImpl;
    }

    async info() {
        let lastValidationError = null;
        for (const origin of QUICKNET_ORIGINS) {
            try {
                const response = await this.#request(`${origin}${QUICKNET_PATH}/info`);
                return validateQuicknetChainInfo(
                    await readJsonResponse(response, "CHAIN_INFO_UNAVAILABLE"),
                );
            } catch (error) {
                if (error instanceof DrandVerificationError
                    && error.code === "CHAIN_INFO_MISMATCH") {
                    lastValidationError = error;
                }
            }
        }
        if (lastValidationError) throw lastValidationError;
        fail("CHAIN_INFO_UNAVAILABLE", "pinned Quicknet chain info is unavailable");
    }

    async beacon(roundNumber) {
        const targetRound = roundValue(roundNumber);
        if (targetRound > BigInt(Number.MAX_SAFE_INTEGER)) {
            fail("ROUND_INVALID", "Quicknet round is invalid");
        }
        let lastValidationError = null;
        for (const origin of QUICKNET_ORIGINS) {
            try {
                const response = await this.#request(
                    `${origin}${QUICKNET_PATH}/public/${targetRound.toString()}`,
                );
                return verifyQuicknetBeacon(
                    await readJsonResponse(response, "BEACON_UNAVAILABLE"),
                    targetRound,
                );
            } catch (error) {
                if (error instanceof DrandVerificationError
                    && error.code === "BEACON_INVALID") {
                    lastValidationError = error;
                }
            }
        }
        if (lastValidationError) throw lastValidationError;
        fail("BEACON_UNAVAILABLE", "target Quicknet beacon is unavailable");
    }

    async #request(url) {
        return this.fetchImpl(url, {
            method: "GET",
            cache: "no-store",
            credentials: "omit",
            redirect: "error",
            referrerPolicy: "no-referrer",
            signal: AbortSignal.timeout(QUICKNET_FETCH_TIMEOUT_MS),
            headers: {Accept: "application/json"},
        });
    }
}

function encryptIbe(message, roundNumber, cryptoImpl) {
    const plaintext = bytes(message, IBE_MESSAGE_LENGTH, "TLOCK_INPUT_INVALID");
    const publicKey = bls12_381.G2.ProjectivePoint.fromHex(
        hexBytes(QUICKNET_PUBLIC_KEY, 96, "CHAIN_INFO_MISMATCH"),
    );
    const identity = bls12_381.G1.hashToCurve(quicknetRoundIdentity(roundNumber), {DST: BLS_DST});
    const pairing = bls12_381.pairing(identity, publicKey);
    const sigma = webCrypto(cryptoImpl).getRandomValues(new Uint8Array(IBE_MESSAGE_LENGTH));
    try {
        const scalar = h3(sigma, plaintext);
        const point = bls12_381.G2.ProjectivePoint.BASE.multiply(scalar);
        const encodedPoint = point.toRawBytes(true);
        if (encodedPoint.length !== U_LENGTH) {
            fail("TLOCK_INVALID", "tlock point encoding is invalid");
        }
        const paired = bls12_381.fields.Fp12.pow(pairing, scalar);
        const v = xor(sigma, gtHash(paired, IBE_MESSAGE_LENGTH));
        const w = xor(plaintext, h4(sigma, IBE_MESSAGE_LENGTH));
        return concat(encodedPoint, v, w);
    } finally {
        sigma.fill(0);
    }
}

function decryptIbe(ciphertext, beaconSignature) {
    const encrypted = bytes(ciphertext, IBE_LENGTH, "TLOCK_INVALID");
    const signature = bls12_381.G1.ProjectivePoint.fromHex(
        hexBytes(beaconSignature, 48, "BEACON_INVALID"),
    );
    const point = bls12_381.G2.ProjectivePoint.fromHex(encrypted.subarray(0, U_LENGTH));
    const v = encrypted.subarray(U_LENGTH, U_LENGTH + IBE_MESSAGE_LENGTH);
    const w = encrypted.subarray(U_LENGTH + IBE_MESSAGE_LENGTH);
    const paired = bls12_381.pairing(signature, point);
    const sigma = xor(v, gtHash(paired, IBE_MESSAGE_LENGTH));
    try {
        const message = xor(w, h4(sigma, IBE_MESSAGE_LENGTH));
        const expectedPoint = bls12_381.G2.ProjectivePoint.BASE.multiply(h3(sigma, message));
        if (!expectedPoint.equals(point)) {
            message.fill(0);
            fail("TLOCK_INVALID", "tlock ciphertext proof is invalid");
        }
        return message;
    } finally {
        sigma.fill(0);
    }
}

export class QuicknetLockedKeyProvider {
    constructor({
        client = new PinnedQuicknetClient(),
        crypto: cryptoImpl = globalThis.crypto,
        nowSeconds = () => BigInt(Math.floor(Date.now() / 1000)),
    } = {}) {
        if (
            client === null
            || typeof client.info !== "function"
            || typeof client.beacon !== "function"
            || typeof nowSeconds !== "function"
        ) {
            fail("PROVIDER_INVALID", "Quicknet provider configuration is invalid");
        }
        this.client = client;
        this.crypto = webCrypto(cryptoImpl);
        this.nowSeconds = nowSeconds;
        this.securityLevel = "production";
        verifiedTokens.set(this, new WeakSet());
    }

    async lock(payload, suppliedContext) {
        const value = bytes(payload, 64, "TLOCK_INPUT_INVALID");
        const lockContext = context(suppliedContext);
        await this.client.info();
        const wrappingKey = this.crypto.getRandomValues(new Uint8Array(32));
        const iv = this.crypto.getRandomValues(new Uint8Array(12));
        try {
            const ibe = encryptIbe(wrappingKey, lockContext.round, this.crypto);
            const key = await this.crypto.subtle.importKey(
                "raw",
                wrappingKey,
                {name: "AES-GCM"},
                false,
                ["encrypt"],
            );
            const wrapped = new Uint8Array(await this.crypto.subtle.encrypt(
                {
                    name: "AES-GCM",
                    iv,
                    additionalData: wrapAad(lockContext),
                    tagLength: 128,
                },
                key,
                value,
            ));
            if (wrapped.length !== 80) fail("TLOCK_INVALID", "tlock wrapping failed");
            const output = new Uint8Array(TIMED_TICKET_LOCKED_KEY_SIZE);
            output.set(ibe, 0);
            output.set(iv, WRAP_IV_OFFSET);
            output.set(wrapped.subarray(0, 64), WRAP_CIPHERTEXT_OFFSET);
            output.set(wrapped.subarray(64), WRAP_TAG_OFFSET);
            return output;
        } catch (error) {
            if (error instanceof DrandVerificationError) throw error;
            fail("TLOCK_INVALID", "tlock wrapping failed");
        } finally {
            wrappingKey.fill(0);
        }
    }

    async verifyTarget(roundNumber) {
        const targetRound = roundValue(roundNumber);
        await this.client.info();
        let now;
        try {
            now = BigInt(await this.nowSeconds());
        } catch {
            fail("CLOCK_INVALID", "Quicknet provider clock is invalid");
        }
        if (now < roundTime(targetRound)) {
            fail("EARLY_DECRYPT_REFUSED", "target Quicknet beacon is not due");
        }
        const beacon = await this.client.beacon(targetRound);
        const token = Object.freeze({
            chainHash: QUICKNET_CHAIN_HASH,
            round: targetRound,
            beacon,
        });
        verifiedTokens.get(this).add(token);
        return token;
    }

    async unlock(locked, suppliedContext, token) {
        const ciphertext = bytes(locked, TIMED_TICKET_LOCKED_KEY_SIZE, "TLOCK_INVALID");
        const lockContext = context(suppliedContext);
        if (
            token === null
            || typeof token !== "object"
            || !verifiedTokens.get(this).has(token)
            || token.chainHash !== QUICKNET_CHAIN_HASH
            || token.round !== lockContext.round
        ) {
            fail("BEACON_INVALID", "verified target Quicknet beacon is required");
        }
        let wrappingKey;
        let plaintext;
        try {
            wrappingKey = decryptIbe(ciphertext.subarray(0, IBE_LENGTH), token.beacon.signature);
            const key = await this.crypto.subtle.importKey(
                "raw",
                wrappingKey,
                {name: "AES-GCM"},
                false,
                ["decrypt"],
            );
            const sealed = concat(
                ciphertext.subarray(WRAP_CIPHERTEXT_OFFSET, WRAP_TAG_OFFSET),
                ciphertext.subarray(WRAP_TAG_OFFSET),
            );
            try {
                plaintext = new Uint8Array(await this.crypto.subtle.decrypt(
                    {
                        name: "AES-GCM",
                        iv: ciphertext.subarray(WRAP_IV_OFFSET, WRAP_CIPHERTEXT_OFFSET),
                        additionalData: wrapAad(lockContext),
                        tagLength: 128,
                    },
                    key,
                    sealed,
                ));
            } finally {
                sealed.fill(0);
            }
            if (
                plaintext.length !== 64
                || !equal(plaintext.subarray(32), lockContext.bindingDigest)
            ) {
                fail("BINDING_INVALID", "tlock binding digest is invalid");
            }
            return plaintext;
        } catch (error) {
            if (plaintext) plaintext.fill(0);
            if (error instanceof DrandVerificationError) throw error;
            fail("TLOCK_INVALID", "tlock ciphertext could not be authenticated");
        } finally {
            if (wrappingKey) wrappingKey.fill(0);
        }
    }
}

export function createQuicknetLockedKeyProvider(options) {
    return new QuicknetLockedKeyProvider(options);
}
