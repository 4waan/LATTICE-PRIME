import {timingSafeEqual} from "node:crypto";

import {
    Interface,
    Transaction,
    Wallet,
    getAddress,
    toBeHex,
} from "ethers";

import {
    QUICKNET_CHAIN_HASH,
    TIMED_TICKET_CHAIN_ID,
    computeTimedTicketEngineCommitment,
} from "../../tools/timed-ticket.mjs";
import {SESSION_ACCOUNT_ABI} from "./private-trading-chain.mjs";
import {privateRelayHandle} from "./private-relay-store.mjs";

export const PRIVATE_TRADING_GAS_LIMIT_CAPS = Object.freeze({
    place: 400_000n,
    buy: 384_666n,
    sell: 828_046n,
    cancel: 400_000n,
    expire: 500_000n,
    sweep: 300_000n,
    route: 2_500_000n,
});

export const PRIVATE_TRADING_DEFAULT_GAS_LIMITS = Object.freeze({
    place: 300_000n,
    buy: 367_941n,
    sell: 792_044n,
    cancel: 300_000n,
    expire: 350_000n,
    sweep: 200_000n,
    route: 2_000_000n,
});

const SESSION_INTERFACE = new Interface(SESSION_ACCOUNT_ABI);
const ROUTER_INTERFACE = new Interface([
    "function withdraw(address recipient,(uint256 encryptedCommitment,uint256 tag,uint256 ephemeralX,uint256 ephemeralY) ciphertext,(uint256[24] withdrawalProof,uint256[8] withdrawalPublicSignals,uint256[24] complianceProof,uint256[14] compliancePublicSignals) bundle)",
]);
const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const TICKET_ID = /^[0-9a-f]{64}$/;
const UINT64_LIMIT = 1n << 64n;
const UINT128_LIMIT = 1n << 128n;
const UINT256_LIMIT = 1n << 256n;
const SECP256K1_N =
    0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N =
    0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const SNARK_SCALAR_FIELD =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const REVEAL_KEYS = Object.freeze([
    "chainHash",
    "chainId",
    "engine",
    "engineCommitment",
    "envelopeDigest",
    "envelopeId",
    "feePolicyDigest",
    "generation",
    "price",
    "quantity",
    "randomSalt",
    "sessionAccount",
    "side",
    "targetRound",
    "ticketId",
]);
const PLACE_KEYS = Object.freeze([
    "chainHash",
    "chainId",
    "engine",
    "engineCommitment",
    "envelopeDigest",
    "envelopeId",
    "feePolicyDigest",
    "generation",
    "sessionAccount",
    "signature",
    "targetRound",
    "ticketId",
]);
const RELEASE_KEYS = Object.freeze([
    "chainHash",
    "chainId",
    "engine",
    "engineCommitment",
    "envelopeDigest",
    "envelopeId",
    "sessionAccount",
    "targetRound",
    "ticketId",
]);
const ROUTING_KEYS = Object.freeze([
    "action",
    "asset",
    "chainId",
    "ciphertext",
    "compliance",
    "denomination",
    "pool",
    "recipient",
    "root",
    "withdrawal",
]);
const CIPHERTEXT_KEYS = Object.freeze([
    "encryptedCommitment",
    "ephemeralX",
    "ephemeralY",
    "tag",
]);
const PROOF_KEYS = Object.freeze(["proof", "publicSignals"]);
const PREPARED_KEYS = Object.freeze(["byteDigest", "handle", "ticketId"]);
const UNKNOWN_BROADCAST_CODES = new Set([
    "NETWORK_ERROR",
    "SERVER_ERROR",
    "TIMEOUT",
    "UNKNOWN_ERROR",
]);

export class PrivateTradingRelayerError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "PrivateTradingRelayerError";
        this.code = code;
    }
}

function fail(code, message = "private trading relay operation failed") {
    throw new PrivateTradingRelayerError(code, message);
}

function wrap(error, fallback) {
    if (error instanceof PrivateTradingRelayerError) throw error;
    const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
        ? error.code
        : fallback;
    fail(code);
}

function exactObject(value, keys, code = "RELAY_REQUEST_INVALID") {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
    ) {
        fail(code);
    }
}

function address(value) {
    try {
        const normalized = getAddress(value).toLowerCase();
        if (!ADDRESS.test(normalized)) throw new Error();
        return normalized;
    } catch {
        fail("RELAY_REQUEST_INVALID");
    }
}

function bytes32(value) {
    if (typeof value !== "string" || !BYTES32.test(value.toLowerCase())) {
        fail("RELAY_REQUEST_INVALID");
    }
    return value.toLowerCase();
}

function decimal(value, limit, {nonzero = false} = {}) {
    if (
        !(
            typeof value === "bigint"
            || (typeof value === "number" && Number.isSafeInteger(value))
            || (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value))
        )
    ) {
        fail("RELAY_REQUEST_INVALID");
    }
    let result;
    try {
        result = BigInt(value);
    } catch {
        fail("RELAY_REQUEST_INVALID");
    }
    if (result < 0n || result >= limit || (nonzero && result === 0n)) {
        fail("RELAY_REQUEST_INVALID");
    }
    return result;
}

function positiveConfigInteger(value, code) {
    let result;
    try {
        if (
            !(
                typeof value === "bigint"
                || (typeof value === "number" && Number.isSafeInteger(value))
                || (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value))
            )
        ) {
            throw new Error();
        }
        result = BigInt(value);
    } catch {
        fail(code);
    }
    if (result <= 0n || result >= 1n << 256n) fail(code);
    return result;
}

function nonnegativeConfigInteger(value, code) {
    let result;
    try {
        if (
            !(
                typeof value === "bigint"
                || (typeof value === "number" && Number.isSafeInteger(value))
                || (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value))
            )
        ) {
            throw new Error();
        }
        result = BigInt(value);
    } catch {
        fail(code);
    }
    if (result < 0n || result >= UINT256_LIMIT) fail(code);
    return result;
}

function baseContext(value) {
    return Object.freeze({
        chainId: value.chainId,
        chainHash: value.chainHash,
        engine: value.engine,
        sessionAccount: value.sessionAccount,
        envelopeId: value.envelopeId,
        envelopeDigest: value.envelopeDigest,
        engineCommitment: value.engineCommitment,
        targetRound: value.targetRound,
    });
}

function normalizeContext(request) {
    const chainId = decimal(request.chainId, 1n << 32n);
    if (
        chainId !== TIMED_TICKET_CHAIN_ID
        || typeof request.chainHash !== "string"
        || request.chainHash.toLowerCase().replace(/^0x/, "") !== QUICKNET_CHAIN_HASH
        || typeof request.ticketId !== "string"
        || !TICKET_ID.test(request.ticketId)
    ) {
        fail("RELAY_CONTEXT_MISMATCH");
    }
    return Object.freeze({
        chainId: chainId.toString(),
        chainHash: QUICKNET_CHAIN_HASH,
        engine: address(request.engine),
        sessionAccount: address(request.sessionAccount),
        envelopeId: bytes32(request.envelopeId),
        envelopeDigest: bytes32(request.envelopeDigest),
        engineCommitment: bytes32(request.engineCommitment),
        targetRound: decimal(request.targetRound, UINT64_LIMIT, {nonzero: true}).toString(),
        ticketId: request.ticketId,
        generation: decimal(request.generation, UINT64_LIMIT).toString(),
        feePolicyDigest: bytes32(request.feePolicyDigest),
    });
}

function normalizeReveal(request) {
    exactObject(request, REVEAL_KEYS);
    const context = normalizeContext(request);
    let side;
    if (request.side === "BUY" || request.side === 0 || request.side === 0n) side = "BUY";
    else if (request.side === "SELL" || request.side === 1 || request.side === 1n) side = "SELL";
    else fail("RELAY_REQUEST_INVALID");
    const result = {
        context,
        side,
        sideCode: side === "BUY" ? 0 : 1,
        price: decimal(request.price, UINT128_LIMIT, {nonzero: true}),
        quantity: decimal(request.quantity, UINT128_LIMIT, {nonzero: true}),
        randomSalt: bytes32(request.randomSalt),
    };
    let expectedCommitment;
    try {
        expectedCommitment = computeTimedTicketEngineCommitment({
            sessionAccount: context.sessionAccount,
            engine: context.engine,
            side: result.sideCode,
            price: result.price,
            quantity: result.quantity,
            randomSalt: result.randomSalt,
            envelopeDigest: context.envelopeDigest,
            targetRound: context.targetRound,
            generation: context.generation,
            feePolicyDigest: context.feePolicyDigest,
        });
    } catch {
        fail("RELAY_REQUEST_INVALID");
    }
    if (expectedCommitment !== context.engineCommitment) {
        fail("COMMITMENT_MISMATCH");
    }
    return Object.freeze(result);
}

function normalizePlace(request) {
    exactObject(request, PLACE_KEYS);
    const context = normalizeContext(request);
    return Object.freeze({
        context,
        signature: lowSignature(request.signature),
    });
}

function lowSignature(value) {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(value)) {
        fail("RELAY_REQUEST_INVALID");
    }
    const normalized = value.toLowerCase();
    const r = BigInt(`0x${normalized.slice(2, 66)}`);
    const s = BigInt(`0x${normalized.slice(66, 130)}`);
    const v = Number.parseInt(normalized.slice(130, 132), 16);
    if (
        r === 0n
        || r >= SECP256K1_N
        || s === 0n
        || s > SECP256K1_HALF_N
        || ![27, 28].includes(v)
    ) {
        fail("SIGNATURE_INVALID");
    }
    return normalized;
}

function normalizeRelease(request) {
    exactObject(request, RELEASE_KEYS);
    const chainId = decimal(request.chainId, 1n << 32n);
    if (
        chainId !== TIMED_TICKET_CHAIN_ID
        || typeof request.chainHash !== "string"
        || request.chainHash.toLowerCase().replace(/^0x/, "") !== QUICKNET_CHAIN_HASH
        || typeof request.ticketId !== "string"
        || !TICKET_ID.test(request.ticketId)
    ) {
        fail("RELAY_CONTEXT_MISMATCH");
    }
    return Object.freeze({
        chainId: chainId.toString(),
        chainHash: QUICKNET_CHAIN_HASH,
        engine: address(request.engine),
        sessionAccount: address(request.sessionAccount),
        envelopeId: bytes32(request.envelopeId),
        envelopeDigest: bytes32(request.envelopeDigest),
        engineCommitment: bytes32(request.engineCommitment),
        targetRound: decimal(
            request.targetRound,
            UINT64_LIMIT,
            {nonzero: true},
        ).toString(),
        ticketId: request.ticketId,
    });
}

function canonicalInteger(value, limit = UINT256_LIMIT) {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
        fail("ROUTING_REQUEST_INVALID");
    }
    const parsed = BigInt(value);
    if (parsed < 0n || parsed >= limit) fail("ROUTING_REQUEST_INVALID");
    return parsed;
}

function fixedArray(value, length, limit = UINT256_LIMIT) {
    if (!Array.isArray(value) || value.length !== length) {
        fail("ROUTING_REQUEST_INVALID");
    }
    return Object.freeze(value.map((item) =>
        canonicalInteger(item, limit).toString()));
}

function normalizeRouting(request, poolConfig) {
    exactObject(request, ROUTING_KEYS, "ROUTING_REQUEST_INVALID");
    exactObject(request.ciphertext, CIPHERTEXT_KEYS, "ROUTING_REQUEST_INVALID");
    exactObject(request.withdrawal, PROOF_KEYS, "ROUTING_REQUEST_INVALID");
    exactObject(request.compliance, PROOF_KEYS, "ROUTING_REQUEST_INVALID");
    if (
        request.action !== "route-withdrawal"
        || request.chainId !== TIMED_TICKET_CHAIN_ID.toString()
        || !["HBAR", "LPRC"].includes(request.asset)
        || poolConfig?.assetName !== request.asset
    ) {
        fail("ROUTING_REQUEST_INVALID");
    }
    const pool = address(request.pool);
    const recipient = address(request.recipient);
    const denomination = canonicalInteger(request.denomination);
    const root = canonicalInteger(request.root, SNARK_SCALAR_FIELD);
    if (
        pool !== poolConfig.address
        || denomination.toString() !== poolConfig.denomination
    ) {
        fail("ROUTING_CONTEXT_MISMATCH");
    }
    const ciphertext = Object.freeze({
        encryptedCommitment: canonicalInteger(
            request.ciphertext.encryptedCommitment,
            SNARK_SCALAR_FIELD,
        ).toString(),
        tag: canonicalInteger(
            request.ciphertext.tag,
            SNARK_SCALAR_FIELD,
        ).toString(),
        ephemeralX: canonicalInteger(
            request.ciphertext.ephemeralX,
            SNARK_SCALAR_FIELD,
        ).toString(),
        ephemeralY: canonicalInteger(
            request.ciphertext.ephemeralY,
            SNARK_SCALAR_FIELD,
        ).toString(),
    });
    const withdrawalProof = fixedArray(request.withdrawal.proof, 24);
    const withdrawalSignals = fixedArray(
        request.withdrawal.publicSignals,
        8,
        SNARK_SCALAR_FIELD,
    );
    const complianceProof = fixedArray(request.compliance.proof, 24);
    const complianceSignals = fixedArray(
        request.compliance.publicSignals,
        14,
        SNARK_SCALAR_FIELD,
    );
    const recipientSignal = BigInt(recipient).toString();
    const poolSignal = BigInt(pool).toString();
    const assetSignal = BigInt(poolConfig.asset).toString();
    if (
        withdrawalSignals[0] === "0"
        || withdrawalSignals[2] !== root.toString()
        || withdrawalSignals[3] !== recipientSignal
        || withdrawalSignals[4] !== poolSignal
        || withdrawalSignals[5] !== assetSignal
        || withdrawalSignals[6] !== denomination.toString()
        || withdrawalSignals[7] !== TIMED_TICKET_CHAIN_ID.toString()
        || complianceSignals[0] !== ciphertext.encryptedCommitment
        || complianceSignals[1] !== ciphertext.tag
        || complianceSignals[2] !== ciphertext.ephemeralX
        || complianceSignals[3] !== ciphertext.ephemeralY
        || complianceSignals[4] !== withdrawalSignals[1]
        || complianceSignals[5] !== root.toString()
        || complianceSignals[6] !== recipientSignal
        || complianceSignals[7] !== poolSignal
        || complianceSignals[8] !== assetSignal
        || complianceSignals[9] !== denomination.toString()
        || complianceSignals[10] !== TIMED_TICKET_CHAIN_ID.toString()
    ) {
        fail("ROUTING_SIGNAL_MISMATCH");
    }
    const nullifier = toBeHex(BigInt(withdrawalSignals[0]), 32).toLowerCase();
    return Object.freeze({
        context: Object.freeze({
            id: nullifier.slice(2),
            asset: request.asset,
            assetAddress: poolConfig.asset,
            chainId: TIMED_TICKET_CHAIN_ID.toString(),
            pool,
            recipient,
            denomination: denomination.toString(),
            root: root.toString(),
            nullifier,
            viewKeyEpoch: complianceSignals[11],
            viewKeyX: complianceSignals[12],
            viewKeyY: complianceSignals[13],
        }),
        ciphertext,
        withdrawalProof,
        withdrawalSignals,
        complianceProof,
        complianceSignals,
    });
}

function preparedRequest(value, kind) {
    exactObject(value, PREPARED_KEYS);
    if (
        typeof value.ticketId !== "string"
        || !TICKET_ID.test(value.ticketId)
        || value.handle !== privateRelayHandle(kind, value.ticketId)
        || typeof value.byteDigest !== "string"
        || !DIGEST.test(value.byteDigest)
    ) {
        fail("PREPARED_RELAY_INVALID");
    }
    return value;
}

function dataBytes(data) {
    if (typeof data !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(data)) {
        fail("CALLDATA_INVALID");
    }
    return Buffer.from(data.slice(2), "hex");
}

function signedBytes(value) {
    if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
        fail("SIGNED_TRANSACTION_INVALID");
    }
    return Buffer.from(value.slice(2), "hex");
}

function sameBytes(left, right) {
    return left.length === right.length && timingSafeEqual(left, right);
}

function canonicalJson(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (value !== null && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) =>
            `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function normalizeReceiptStatus(receipt) {
    if (receipt?.status === null || receipt?.status === undefined) {
        fail("RECEIPT_INVALID");
    }
    try {
        const status = BigInt(receipt?.status);
        if (status === 1n) return "CONFIRMED";
        if (status === 0n) return "REJECTED";
    } catch {
        // The generic invalid result below is intentionally secret-free.
    }
    fail("RECEIPT_INVALID");
}

export function loadPrivateTradingRelayerKey(env = process.env) {
    const value = env?.PRIVATE_TRADING_RELAYER_KEY;
    if (typeof value !== "string" || !PRIVATE_KEY.test(value)) {
        fail("RELAYER_KEY_REQUIRED");
    }
    try {
        new Wallet(value);
    } catch {
        fail("RELAYER_KEY_INVALID");
    }
    return value;
}

export function createPrivateTradingRelayerSigner({
    env = process.env,
    provider,
} = {}) {
    return new Wallet(loadPrivateTradingRelayerKey(env), provider);
}

export class EthersPrivateTradingRelayer {
    constructor({
        provider,
        signer,
        transactionStore,
        chainAdapter,
        maxGasPriceWei,
        relayerReserveWei,
        gasLimits = PRIVATE_TRADING_DEFAULT_GAS_LIMITS,
        confirmations = 1,
        transactionTimeoutMilliseconds = 120_000,
    }) {
        if (
            provider === null
            || typeof provider !== "object"
            || typeof provider.getNetwork !== "function"
            || typeof provider.send !== "function"
            || typeof provider.getFeeData !== "function"
            || typeof provider.getBalance !== "function"
            || typeof provider.getTransactionCount !== "function"
            || typeof provider.getTransactionReceipt !== "function"
            || typeof provider.getTransaction !== "function"
            || typeof provider.broadcastTransaction !== "function"
            || typeof provider.call !== "function"
            || typeof provider.getBlock !== "function"
            || signer === null
            || typeof signer !== "object"
            || typeof signer.getAddress !== "function"
            || typeof signer.signTransaction !== "function"
            || transactionStore === null
            || typeof transactionStore !== "object"
            || typeof transactionStore.prepare !== "function"
            || typeof transactionStore.read !== "function"
            || typeof transactionStore.readIfPresent !== "function"
            || chainAdapter === null
            || typeof chainAdapter !== "object"
            || typeof chainAdapter.observePlacement !== "function"
            || typeof chainAdapter.recheckBeforeReveal !== "function"
            || typeof chainAdapter.observeCancellation !== "function"
            || typeof chainAdapter.observeRelease !== "function"
            || typeof chainAdapter.observeRoutingWithdrawal !== "function"
            || typeof chainAdapter.verifyRoutingContext !== "function"
            || typeof chainAdapter.querySessionContext !== "function"
            || typeof chainAdapter.routingPool !== "function"
            || typeof chainAdapter.verifySessionContext !== "function"
        ) {
            fail("RELAYER_CONFIG_INVALID");
        }
        if (
            !Number.isSafeInteger(confirmations)
            || confirmations < 1
            || confirmations > 20
            || !Number.isSafeInteger(transactionTimeoutMilliseconds)
            || transactionTimeoutMilliseconds < 1_000
        ) {
            fail("RELAYER_CONFIG_INVALID");
        }
        this.provider = provider;
        this.signer = signer;
        this.transactionStore = transactionStore;
        this.chainAdapter = chainAdapter;
        this.maxGasPriceWei = positiveConfigInteger(maxGasPriceWei, "GAS_POLICY_INVALID");
        this.relayerReserveWei = nonnegativeConfigInteger(
            relayerReserveWei,
            "RELAYER_RESERVE_INVALID",
        );
        exactObject(
            gasLimits,
            ["buy", "cancel", "expire", "place", "route", "sell", "sweep"],
            "GAS_POLICY_INVALID",
        );
        this.gasLimits = Object.freeze({
            place: positiveConfigInteger(gasLimits?.place, "GAS_POLICY_INVALID"),
            buy: positiveConfigInteger(gasLimits?.buy, "GAS_POLICY_INVALID"),
            sell: positiveConfigInteger(gasLimits?.sell, "GAS_POLICY_INVALID"),
            cancel: positiveConfigInteger(gasLimits?.cancel, "GAS_POLICY_INVALID"),
            expire: positiveConfigInteger(gasLimits?.expire, "GAS_POLICY_INVALID"),
            sweep: positiveConfigInteger(gasLimits?.sweep, "GAS_POLICY_INVALID"),
            route: positiveConfigInteger(gasLimits?.route, "GAS_POLICY_INVALID"),
        });
        for (const key of Object.keys(this.gasLimits)) {
            if (this.gasLimits[key] > PRIVATE_TRADING_GAS_LIMIT_CAPS[key]) {
                fail("GAS_LIMIT_CAP_EXCEEDED");
            }
        }
        this.confirmations = confirmations;
        this.transactionTimeoutMilliseconds = transactionTimeoutMilliseconds;
        this.initialization = null;
        this.relayerAddress = null;
    }

    async initialize() {
        if (this.initialization === null) {
            this.initialization = this.#initialize().catch((error) => {
                this.initialization = null;
                throw error;
            });
        }
        return this.initialization;
    }

    async prepareReveal(request) {
        const reveal = normalizeReveal(request);
        await this.#verifySession(reveal.context);
        let observation;
        try {
            observation = await this.chainAdapter.recheckBeforeReveal(
                baseContext(reveal.context),
            );
        } catch (error) {
            wrap(error, "REVEAL_STATE_UNAVAILABLE");
        }
        if (
            observation?.status !== "REVEALABLE"
            || observation.commitment !== reveal.context.engineCommitment
        ) {
            fail("REVEAL_STATE_REFUSED");
        }
        let data;
        try {
            data = SESSION_INTERFACE.encodeFunctionData("revealAuthorized", [
                reveal.sideCode,
                reveal.price,
                reveal.quantity,
                reveal.randomSalt,
                reveal.context.envelopeDigest,
                reveal.context.targetRound,
            ]);
        } catch {
            fail("CALLDATA_ENCODING_FAILED");
        }
        return this.#prepare({
            kind: "reveal",
            context: reveal.context,
            data,
            gasLimit: this.gasLimits[reveal.side.toLowerCase()],
            simulationBlock: null,
        });
    }

    async preparePlace(request) {
        const place = normalizePlace(request);
        await this.#verifySession(place.context);
        let data;
        try {
            data = SESSION_INTERFACE.encodeFunctionData("placeSealed", [
                place.context.engineCommitment,
                place.context.envelopeDigest,
                place.context.targetRound,
                place.signature,
            ]);
        } catch {
            fail("CALLDATA_ENCODING_FAILED");
        }
        const handle = privateRelayHandle("place", place.context.ticketId);
        const existing = await this.transactionStore.readIfPresent(handle);
        if (existing !== null) {
            try {
                this.#assertRecord(existing, {
                    kind: "place",
                    context: place.context,
                    data,
                    gasLimit: this.gasLimits.place,
                });
                return Object.freeze({
                    handle,
                    byteDigest: existing.metadata.byteDigest,
                });
            } finally {
                existing.calldata.fill(0);
                existing.signedTransaction.fill(0);
            }
        }
        const simulationBlock = await this.#simulateCall(
            place.context.sessionAccount,
            data,
            this.gasLimits.place,
        );
        return this.#prepare({
            kind: "place",
            context: place.context,
            data,
            gasLimit: this.gasLimits.place,
            simulationBlock,
        });
    }

    async relayPlace(request) {
        const place = normalizePlace(request);
        await this.#verifySession(place.context);
        let observed;
        try {
            observed = await this.chainAdapter.observePlacement(baseContext(place.context));
        } catch (error) {
            wrap(error, "PLACEMENT_STATE_UNAVAILABLE");
        }
        if (observed?.status === "PLACED") {
            let data;
            try {
                data = SESSION_INTERFACE.encodeFunctionData("placeSealed", [
                    place.context.engineCommitment,
                    place.context.envelopeDigest,
                    place.context.targetRound,
                    place.signature,
                ]);
            } catch {
                fail("CALLDATA_ENCODING_FAILED");
            }
            const recovered = await this.#reconcileExisting({
                kind: "place",
                context: place.context,
                data,
                gasLimit: this.gasLimits.place,
            });
            if (
                recovered?.status !== "CONFIRMED"
                || recovered.transactionHash === null
            ) {
                fail("PLACEMENT_RECEIPT_UNAVAILABLE");
            }
            return recovered;
        }
        if (observed?.status !== "ABSENT") fail("PLACEMENT_STATE_REFUSED");
        const prepared = await this.preparePlace(request);
        return this.#broadcastPrepared({
            ticketId: place.context.ticketId,
            handle: prepared.handle,
            byteDigest: prepared.byteDigest,
        }, "place");
    }

    async relayCancel(request) {
        const cancellation = normalizePlace(request);
        await this.#verifySession(cancellation.context);
        const observe = async () => {
            try {
                return await this.chainAdapter.observeCancellation(
                    baseContext(cancellation.context),
                );
            } catch (error) {
                wrap(error, "CANCELLATION_STATE_UNAVAILABLE");
            }
        };
        let observed = await observe();
        let data;
        let sweepData;
        try {
            data = SESSION_INTERFACE.encodeFunctionData("cancelAuthorized", [
                cancellation.context.engineCommitment,
                cancellation.context.envelopeDigest,
                cancellation.context.targetRound,
                cancellation.signature,
            ]);
            sweepData = SESSION_INTERFACE.encodeFunctionData(
                "sweepEngineCredit",
                [],
            );
        } catch {
            fail("CALLDATA_ENCODING_FAILED");
        }
        let transactionHash = null;
        let sweepTransactionHash = null;
        if (observed?.status === "CANCELLED") {
            const recovered = await this.#reconcileExisting({
                kind: "cancel",
                context: cancellation.context,
                data,
                gasLimit: this.gasLimits.cancel,
            });
            if (
                recovered?.status !== "CONFIRMED"
                || recovered.transactionHash === null
            ) {
                fail("CANCELLATION_RECEIPT_UNAVAILABLE");
            }
            transactionHash = recovered.transactionHash;
        } else if (observed?.status === "CANCELLABLE") {
            const result = await this.#relayFixed({
                kind: "cancel",
                context: cancellation.context,
                data,
                gasLimit: this.gasLimits.cancel,
            });
            if (
                result.status !== "CONFIRMED"
                || result.transactionHash === null
            ) {
                return Object.freeze({
                    status: result.status,
                    transactionHash: result.transactionHash,
                    sweepTransactionHash: null,
                });
            }
            transactionHash = result.transactionHash;
            observed = await observe();
        } else {
            fail("CANCELLATION_STATE_REFUSED");
        }
        if (observed.status !== "CANCELLED") {
            fail("CANCELLATION_RECONCILIATION_FAILED");
        }
        if (observed.engineCredit !== "0") {
            const sweep = await this.#relayFixed({
                kind: "cancel-sweep",
                context: cancellation.context,
                data: sweepData,
                gasLimit: this.gasLimits.sweep,
            });
            if (
                sweep.status !== "CONFIRMED"
                || sweep.transactionHash === null
            ) {
                if (sweep.status === "CONFIRMED") {
                    fail("CANCELLATION_SWEEP_RECEIPT_UNAVAILABLE");
                }
                return Object.freeze({
                    status: sweep.status,
                    transactionHash,
                    sweepTransactionHash: sweep.transactionHash,
                });
            }
            sweepTransactionHash = sweep.transactionHash;
        } else {
            const recovered = await this.#reconcileExisting({
                kind: "cancel-sweep",
                context: cancellation.context,
                data: sweepData,
                gasLimit: this.gasLimits.sweep,
            });
            sweepTransactionHash = recovered?.status === "CONFIRMED"
                ? recovered.transactionHash
                : null;
        }
        const finalState = await observe();
        if (
            finalState.status !== "CANCELLED"
            || finalState.engineCredit !== "0"
            || transactionHash === null
        ) {
            fail("CANCELLATION_RECONCILIATION_FAILED");
        }
        return Object.freeze({
            status: "CONFIRMED",
            transactionHash,
            sweepTransactionHash,
        });
    }

    async relayRelease(request) {
        const release = normalizeRelease(request);
        let session;
        try {
            session = await this.chainAdapter.querySessionContext(
                baseContext(release),
            );
        } catch (error) {
            wrap(error, "SESSION_CONTEXT_MISMATCH");
        }
        const context = normalizeContext({
            ...release,
            generation: session?.generation,
            feePolicyDigest: session?.feePolicyDigest,
        });
        await this.#verifySession(context);
        const expireData = SESSION_INTERFACE.encodeFunctionData("expire", [
            context.engineCommitment,
        ]);
        const sweepData = SESSION_INTERFACE.encodeFunctionData(
            "sweepEngineCredit",
            [],
        );
        let observation = await this.#observeRelease(context);
        if (observation.status === "RESTING") fail("RELEASE_STATE_REFUSED");
        let transactionHash = null;
        let sweepTransactionHash = null;
        if (observation.status === "RELEASABLE") {
            const result = await this.#relayFixed({
                kind: "expire",
                context,
                data: expireData,
                gasLimit: this.gasLimits.expire,
            });
            if (result.status !== "CONFIRMED") return Object.freeze({
                status: result.status,
                transactionHash: result.transactionHash,
                sweepTransactionHash: null,
            });
            transactionHash = result.transactionHash;
            observation = await this.#observeRelease(context);
        } else {
            const recovered = await this.#reconcileExisting({
                kind: "expire",
                context,
                data: expireData,
                gasLimit: this.gasLimits.expire,
            });
            transactionHash = recovered?.status === "CONFIRMED"
                ? recovered.transactionHash
                : null;
        }
        if (observation.status === "SWEEP_REQUIRED") {
            const result = await this.#relayFixed({
                kind: "sweep",
                context,
                data: sweepData,
                gasLimit: this.gasLimits.sweep,
            });
            if (result.status !== "CONFIRMED") return Object.freeze({
                status: result.status,
                transactionHash,
                sweepTransactionHash: result.transactionHash,
            });
            sweepTransactionHash = result.transactionHash;
        } else if (observation.status === "RELEASED") {
            const recovered = await this.#reconcileExisting({
                kind: "sweep",
                context,
                data: sweepData,
                gasLimit: this.gasLimits.sweep,
            });
            sweepTransactionHash = recovered?.status === "CONFIRMED"
                ? recovered.transactionHash
                : null;
        } else {
            fail("RELEASE_RECONCILIATION_FAILED");
        }
        const finalState = await this.#observeRelease(context);
        if (
            finalState.status !== "RELEASED"
            || (transactionHash === null && sweepTransactionHash === null)
        ) {
            fail("RELEASE_RECONCILIATION_FAILED");
        }
        return Object.freeze({
            status: "CONFIRMED",
            transactionHash,
            sweepTransactionHash,
        });
    }

    async relayRoutingWithdrawal(request) {
        await this.initialize();
        const asset = request?.asset;
        let poolConfig;
        try {
            poolConfig = this.chainAdapter.routingPool(asset);
        } catch (error) {
            wrap(error, "ROUTING_REQUEST_INVALID");
        }
        const routing = normalizeRouting(request, poolConfig);
        let observed;
        try {
            observed = await this.chainAdapter.observeRoutingWithdrawal(
                routing.context,
            );
        } catch (error) {
            wrap(error, "ROUTING_CONTEXT_MISMATCH");
        }
        let data;
        try {
            data = ROUTER_INTERFACE.encodeFunctionData("withdraw", [
                routing.context.recipient,
                routing.ciphertext,
                {
                    withdrawalProof: routing.withdrawalProof,
                    withdrawalPublicSignals: routing.withdrawalSignals,
                    complianceProof: routing.complianceProof,
                    compliancePublicSignals: routing.complianceSignals,
                },
            ]);
        } catch {
            fail("CALLDATA_ENCODING_FAILED");
        }
        if (observed?.status === "SPENT") {
            const recovered = await this.#reconcileExisting({
                kind: "route",
                context: routing.context,
                data,
                gasLimit: this.gasLimits.route,
                to: routing.context.pool,
            });
            if (
                recovered?.status !== "CONFIRMED"
                || recovered.transactionHash === null
            ) {
                fail("ROUTING_RECEIPT_UNAVAILABLE");
            }
            return Object.freeze({
                status: "CONFIRMED",
                txHash: recovered.transactionHash,
            });
        }
        if (observed?.status !== "UNSPENT") fail("ROUTING_STATE_REFUSED");
        try {
            await this.chainAdapter.verifyRoutingContext(routing.context);
        } catch (error) {
            wrap(error, "ROUTING_CONTEXT_MISMATCH");
        }
        const result = await this.#relayFixed({
            kind: "route",
            context: routing.context,
            data,
            gasLimit: this.gasLimits.route,
            to: routing.context.pool,
        });
        return Object.freeze({
            status: result.status,
            txHash: result.transactionHash,
        });
    }

    async broadcastPrepared(request) {
        return this.#broadcastPrepared(preparedRequest(request, "reveal"), "reveal");
    }

    async reconcilePrepared(request) {
        return this.#reconcilePrepared(preparedRequest(request, "reveal"), "reveal");
    }

    async reconcilePlacePrepared(request) {
        return this.#reconcilePrepared(preparedRequest(request, "place"), "place");
    }

    async broadcastPlacePrepared(request) {
        return this.#broadcastPrepared(preparedRequest(request, "place"), "place");
    }

    async #initialize() {
        let network;
        let reportedChainId;
        let relayer;
        try {
            [network, reportedChainId, relayer] = await Promise.all([
                this.provider.getNetwork(),
                this.provider.send("eth_chainId", []),
                this.signer.getAddress(),
                typeof this.chainAdapter.initialize === "function"
                    ? this.chainAdapter.initialize()
                    : Promise.resolve(),
                typeof this.transactionStore.initialize === "function"
                    ? this.transactionStore.initialize()
                    : Promise.resolve(),
            ]);
        } catch (error) {
            wrap(error, "RELAYER_INITIALIZATION_FAILED");
        }
        let configuredChainId;
        let remoteChainId;
        try {
            configuredChainId = BigInt(network?.chainId);
            remoteChainId = BigInt(reportedChainId);
        } catch {
            fail("CHAIN_MISMATCH");
        }
        if (
            configuredChainId !== TIMED_TICKET_CHAIN_ID
            || remoteChainId !== TIMED_TICKET_CHAIN_ID
        ) {
            fail("CHAIN_MISMATCH");
        }
        this.relayerAddress = address(relayer);
        return Object.freeze({
            chainId: TIMED_TICKET_CHAIN_ID.toString(),
            relayer: this.relayerAddress,
        });
    }

    async #verifySession(context) {
        await this.initialize();
        try {
            await this.chainAdapter.verifySessionContext(context);
        } catch (error) {
            wrap(error, "SESSION_CONTEXT_MISMATCH");
        }
    }

    async #observeRelease(context) {
        try {
            return await this.chainAdapter.observeRelease(baseContext(context));
        } catch (error) {
            wrap(error, "RELEASE_STATE_UNAVAILABLE");
        }
    }

    async #relayFixed({
        kind,
        context,
        data,
        gasLimit,
        to = null,
    }) {
        const target = to ?? context.sessionAccount;
        const simulationBlock = await this.#simulateCall(
            target,
            data,
            gasLimit,
        );
        const prepared = await this.#prepare({
            kind,
            context,
            data,
            gasLimit,
            simulationBlock,
            to: target,
        });
        return this.#broadcastPrepared({
            ticketId: kind === "route" ? context.id : context.ticketId,
            handle: prepared.handle,
            byteDigest: prepared.byteDigest,
        }, kind);
    }

    async #reconcileExisting({
        kind,
        context,
        data,
        gasLimit,
        to = null,
    }) {
        const identifier = kind === "route" ? context.id : context.ticketId;
        const handle = privateRelayHandle(kind, identifier);
        const existing = await this.transactionStore.readIfPresent(handle);
        if (existing === null) return null;
        let request;
        try {
            this.#assertRecord(existing, {
                kind,
                context,
                data,
                gasLimit,
                to: to ?? context.sessionAccount,
            });
            request = {
                ticketId: identifier,
                handle,
                byteDigest: existing.metadata.byteDigest,
            };
        } finally {
            existing.calldata.fill(0);
            existing.signedTransaction.fill(0);
        }
        return this.#reconcilePrepared(request, kind);
    }

    async #prepare({
        kind,
        context,
        data,
        gasLimit,
        simulationBlock,
        to = null,
    }) {
        await this.initialize();
        const identifier = kind === "route" ? context.id : context.ticketId;
        const target = to ?? context.sessionAccount;
        const handle = privateRelayHandle(kind, identifier);
        const existing = await this.transactionStore.readIfPresent(handle);
        if (existing !== null) {
            try {
                this.#assertRecord(existing, {
                    kind,
                    context,
                    data,
                    gasLimit,
                    to: target,
                });
                return Object.freeze({
                    handle,
                    byteDigest: existing.metadata.byteDigest,
                });
            } finally {
                existing.calldata.fill(0);
                existing.signedTransaction.fill(0);
            }
        }
        let pendingNonce;
        let gasPrice;
        try {
            const [nonce, feeData] = await Promise.all([
                this.provider.getTransactionCount(this.relayerAddress, "pending"),
                this.provider.getFeeData(),
            ]);
            if (!Number.isSafeInteger(nonce) || nonce < 0) fail("RELAYER_NONCE_INVALID");
            pendingNonce = nonce;
            gasPrice = this.#gasPrice(feeData);
        } catch (error) {
            wrap(error, "RELAYER_STATE_UNAVAILABLE");
        }
        await this.#requireRelayerBalance(gasLimit, gasPrice);
        let persisted;
        try {
            persisted = await this.transactionStore.prepare({
                handle,
                minimumNonce: pendingNonce,
                build: async (nonce) => {
                    const transactionRequest = {
                        type: 0,
                        chainId: TIMED_TICKET_CHAIN_ID,
                        nonce,
                        to: target,
                        value: 0n,
                        data,
                        gasLimit,
                        gasPrice,
                    };
                    let signed;
                    try {
                        signed = await this.signer.signTransaction(transactionRequest);
                    } catch {
                        fail("TRANSACTION_SIGNING_FAILED");
                    }
                    const raw = signedBytes(signed);
                    let transaction;
                    try {
                        transaction = Transaction.from(signed);
                    } catch {
                        raw.fill(0);
                        fail("SIGNED_TRANSACTION_INVALID");
                    }
                    const calldata = dataBytes(data);
                    return {
                        kind,
                        context,
                        from: this.relayerAddress,
                        to: target,
                        gasPrice: gasPrice.toString(),
                        gasLimit: gasLimit.toString(),
                        transactionHash: String(transaction.hash).toLowerCase(),
                        calldata,
                        signedTransaction: raw,
                        simulationBlock,
                    };
                },
            });
            this.#assertRecord(persisted, {
                kind,
                context,
                data,
                gasLimit,
                to: target,
            });
            return Object.freeze({
                handle,
                byteDigest: persisted.metadata.byteDigest,
            });
        } catch (error) {
            wrap(error, "RELAY_PREPARATION_FAILED");
        } finally {
            persisted?.calldata?.fill(0);
            persisted?.signedTransaction?.fill(0);
        }
    }

    async #simulateCall(to, data, gasLimit) {
        let block;
        try {
            block = await this.provider.getBlock("latest");
        } catch {
            fail("SIMULATION_UNAVAILABLE");
        }
        if (
            block === null
            || !Number.isSafeInteger(block.number)
            || block.number < 0
        ) {
            fail("SIMULATION_UNAVAILABLE");
        }
        try {
            await this.provider.call({
                from: this.relayerAddress,
                to,
                data,
                value: 0n,
                gasLimit,
                blockTag: block.number,
            });
        } catch {
            fail("SIMULATION_REFUSED");
        }
        return block.number;
    }

    #gasPrice(feeData) {
        const quoted = feeData?.gasPrice ?? feeData?.maxFeePerGas;
        let gasPrice;
        try {
            gasPrice = BigInt(quoted);
        } catch {
            fail("GAS_PRICE_UNAVAILABLE");
        }
        if (gasPrice <= 0n) fail("GAS_PRICE_UNAVAILABLE");
        if (gasPrice > this.maxGasPriceWei) fail("GAS_PRICE_CAP_EXCEEDED");
        return gasPrice;
    }

    async #requireRelayerBalance(gasLimit, gasPrice) {
        const required = this.relayerReserveWei + gasLimit * gasPrice;
        let block;
        try {
            block = await this.provider.getBlock("latest");
        } catch {
            fail("RELAYER_BALANCE_UNAVAILABLE");
        }
        if (
            block === null
            || !Number.isSafeInteger(block.number)
            || block.number < 0
        ) {
            fail("RELAYER_BALANCE_INVALID");
        }
        let observed;
        try {
            observed = await this.provider.getBalance(
                this.relayerAddress,
                block.number,
            );
        } catch {
            fail("RELAYER_BALANCE_UNAVAILABLE");
        }
        if (
            !(
                typeof observed === "bigint"
                || (typeof observed === "number" && Number.isSafeInteger(observed))
                || (
                    typeof observed === "string"
                    && /^(0|[1-9][0-9]*)$/.test(observed)
                )
            )
        ) {
            fail("RELAYER_BALANCE_INVALID");
        }
        const balance = BigInt(observed);
        if (balance < 0n || balance >= UINT256_LIMIT) {
            fail("RELAYER_BALANCE_INVALID");
        }
        if (required >= UINT256_LIMIT || balance < required) {
            fail("RELAYER_BALANCE_TOO_LOW");
        }
    }

    #assertRecord(record, expected) {
        const metadata = record?.metadata;
        const expectedData = dataBytes(expected.data);
        const identifier = expected.kind === "route"
            ? expected.context.id
            : expected.context.ticketId;
        const target = expected.to ?? expected.context.sessionAccount;
        try {
            if (
                metadata?.kind !== expected.kind
                || metadata?.handle !== privateRelayHandle(expected.kind, identifier)
                || metadata?.from !== this.relayerAddress
                || metadata?.to !== target
                || metadata?.chainId !== TIMED_TICKET_CHAIN_ID.toString()
                || metadata?.gasLimit !== expected.gasLimit.toString()
                || BigInt(metadata?.gasPrice ?? 0) > this.maxGasPriceWei
                || canonicalJson(metadata?.context) !== canonicalJson(expected.context)
                || !sameBytes(record.calldata, expectedData)
            ) {
                fail("PREPARED_TRANSACTION_MISMATCH");
            }
            let transaction;
            try {
                transaction = Transaction.from(
                    `0x${Buffer.from(record.signedTransaction).toString("hex")}`,
                );
            } catch {
                fail("PREPARED_TRANSACTION_MISMATCH");
            }
            if (
                transaction.hash?.toLowerCase() !== metadata.transactionHash
                || address(transaction.from) !== metadata.from
                || address(transaction.to) !== metadata.to
                || transaction.chainId !== TIMED_TICKET_CHAIN_ID
                || transaction.type !== 0
                || transaction.nonce !== metadata.nonce
                || transaction.value !== 0n
                || transaction.data.toLowerCase() !== expected.data.toLowerCase()
                || transaction.gasLimit.toString() !== metadata.gasLimit
                || typeof transaction.gasPrice !== "bigint"
                || transaction.gasPrice.toString() !== metadata.gasPrice
            ) {
                fail("PREPARED_TRANSACTION_MISMATCH");
            }
        } finally {
            expectedData.fill(0);
        }
    }

    async #loadPrepared(request, kind) {
        await this.initialize();
        let record;
        try {
            record = await this.transactionStore.read(request.handle);
        } catch (error) {
            wrap(error, "PREPARED_TRANSACTION_MISSING");
        }
        if (
            record.metadata.kind !== kind
            || (
                kind === "route"
                    ? record.metadata.context.id
                    : record.metadata.context.ticketId
            ) !== request.ticketId
            || record.metadata.byteDigest !== request.byteDigest
            || record.metadata.handle !== request.handle
        ) {
            record.calldata.fill(0);
            record.signedTransaction.fill(0);
            fail("PREPARED_TRANSACTION_MISMATCH");
        }
        try {
            this.#validateStoredRecord(record);
        } catch (error) {
            record.calldata.fill(0);
            record.signedTransaction.fill(0);
            throw error;
        }
        return record;
    }

    #validateStoredRecord(record) {
        const metadata = record.metadata;
        let transaction;
        try {
            transaction = Transaction.from(
                `0x${record.signedTransaction.toString("hex")}`,
            );
        } catch {
            fail("PREPARED_TRANSACTION_MISMATCH");
        }
        const transactionData = dataBytes(transaction.data);
        try {
            if (
                transaction.hash?.toLowerCase() !== metadata.transactionHash
                || address(transaction.from) !== this.relayerAddress
                || address(transaction.to) !== metadata.to
                || metadata.from !== this.relayerAddress
                || transaction.type !== 0
                || transaction.chainId !== TIMED_TICKET_CHAIN_ID
                || transaction.nonce !== metadata.nonce
                || transaction.value !== 0n
                || transaction.gasLimit.toString() !== metadata.gasLimit
                || typeof transaction.gasPrice !== "bigint"
                || transaction.gasPrice.toString() !== metadata.gasPrice
                || transaction.gasPrice > this.maxGasPriceWei
                || !sameBytes(transactionData, record.calldata)
            ) {
                fail("PREPARED_TRANSACTION_MISMATCH");
            }
            let decoded;
            let fragment;
            try {
                const transactionInterface = metadata.kind === "route"
                    ? ROUTER_INTERFACE
                    : SESSION_INTERFACE;
                fragment = transactionInterface.parseTransaction({
                    data: transaction.data,
                    value: transaction.value,
                });
                decoded = fragment?.args;
            } catch {
                fail("PREPARED_TRANSACTION_MISMATCH");
            }
            if (metadata.kind === "place") {
                if (
                    fragment?.name !== "placeSealed"
                    || transaction.gasLimit > PRIVATE_TRADING_GAS_LIMIT_CAPS.place
                    || decoded.commitment.toLowerCase() !== metadata.context.engineCommitment
                    || decoded.envelopeDigest.toLowerCase() !== metadata.context.envelopeDigest
                    || decoded.quicknetRound.toString() !== metadata.context.targetRound
                ) {
                    fail("PREPARED_TRANSACTION_MISMATCH");
                }
                lowSignature(decoded.signature);
                return;
            }
            if (metadata.kind === "cancel") {
                if (
                    fragment?.name !== "cancelAuthorized"
                    || transaction.gasLimit > PRIVATE_TRADING_GAS_LIMIT_CAPS.cancel
                    || decoded.commitment.toLowerCase()
                        !== metadata.context.engineCommitment
                    || decoded.envelopeDigest.toLowerCase()
                        !== metadata.context.envelopeDigest
                    || decoded.quicknetRound.toString()
                        !== metadata.context.targetRound
                ) {
                    fail("PREPARED_TRANSACTION_MISMATCH");
                }
                lowSignature(decoded.signature);
                return;
            }
            if (metadata.kind === "expire") {
                if (
                    fragment?.name !== "expire"
                    || transaction.gasLimit > PRIVATE_TRADING_GAS_LIMIT_CAPS.expire
                    || decoded.id.toLowerCase() !== metadata.context.engineCommitment
                ) {
                    fail("PREPARED_TRANSACTION_MISMATCH");
                }
                return;
            }
            if (["sweep", "cancel-sweep"].includes(metadata.kind)) {
                if (
                    fragment?.name !== "sweepEngineCredit"
                    || transaction.gasLimit > PRIVATE_TRADING_GAS_LIMIT_CAPS.sweep
                    || decoded.length !== 0
                ) {
                    fail("PREPARED_TRANSACTION_MISMATCH");
                }
                return;
            }
            if (metadata.kind === "route") {
                const withdrawal = decoded?.bundle?.withdrawalPublicSignals;
                const compliance = decoded?.bundle?.compliancePublicSignals;
                const ciphertext = decoded?.ciphertext;
                if (
                    fragment?.name !== "withdraw"
                    || metadata.to !== metadata.context.pool
                    || transaction.gasLimit > PRIVATE_TRADING_GAS_LIMIT_CAPS.route
                    || address(decoded?.recipient) !== metadata.context.recipient
                    || withdrawal?.length !== 8
                    || compliance?.length !== 14
                    || toBeHex(withdrawal[0], 32).toLowerCase()
                        !== metadata.context.nullifier
                    || withdrawal[2].toString() !== metadata.context.root
                    || withdrawal[3].toString() !== BigInt(
                        metadata.context.recipient,
                    ).toString()
                    || withdrawal[4].toString() !== BigInt(
                        metadata.context.pool,
                    ).toString()
                    || withdrawal[5].toString() !== BigInt(
                        metadata.context.assetAddress,
                    ).toString()
                    || withdrawal[6].toString() !== metadata.context.denomination
                    || withdrawal[7].toString() !== metadata.context.chainId
                    || compliance[0].toString()
                        !== ciphertext.encryptedCommitment.toString()
                    || compliance[1].toString() !== ciphertext.tag.toString()
                    || compliance[2].toString() !== ciphertext.ephemeralX.toString()
                    || compliance[3].toString() !== ciphertext.ephemeralY.toString()
                    || compliance[4].toString() !== withdrawal[1].toString()
                    || compliance[5].toString() !== metadata.context.root
                    || compliance[6].toString() !== withdrawal[3].toString()
                    || compliance[7].toString() !== withdrawal[4].toString()
                    || compliance[8].toString() !== withdrawal[5].toString()
                    || compliance[9].toString() !== metadata.context.denomination
                    || compliance[10].toString() !== metadata.context.chainId
                    || compliance[11].toString() !== metadata.context.viewKeyEpoch
                    || compliance[12].toString() !== metadata.context.viewKeyX
                    || compliance[13].toString() !== metadata.context.viewKeyY
                ) {
                    fail("PREPARED_TRANSACTION_MISMATCH");
                }
                return;
            }
            if (metadata.kind !== "reveal") {
                fail("PREPARED_TRANSACTION_MISMATCH");
            }
            const side = Number(decoded?.side);
            if (
                fragment?.name !== "revealAuthorized"
                || ![0, 1].includes(side)
                || transaction.gasLimit > (
                    side === 0
                        ? PRIVATE_TRADING_GAS_LIMIT_CAPS.buy
                        : PRIVATE_TRADING_GAS_LIMIT_CAPS.sell
                )
                || decoded.envelopeDigest.toLowerCase() !== metadata.context.envelopeDigest
                || decoded.quicknetRound.toString() !== metadata.context.targetRound
            ) {
                fail("PREPARED_TRANSACTION_MISMATCH");
            }
            let commitment;
            try {
                commitment = computeTimedTicketEngineCommitment({
                    sessionAccount: metadata.context.sessionAccount,
                    engine: metadata.context.engine,
                    side,
                    price: decoded.price,
                    quantity: decoded.qty,
                    randomSalt: decoded.randomSalt,
                    envelopeDigest: metadata.context.envelopeDigest,
                    targetRound: metadata.context.targetRound,
                    generation: metadata.context.generation,
                    feePolicyDigest: metadata.context.feePolicyDigest,
                });
            } catch {
                fail("PREPARED_TRANSACTION_MISMATCH");
            }
            if (commitment !== metadata.context.engineCommitment) {
                fail("PREPARED_TRANSACTION_MISMATCH");
            }
        } finally {
            transactionData.fill(0);
        }
    }

    async #reconcilePrepared(request, kind) {
        const record = await this.#loadPrepared(request, kind);
        try {
            return await this.#reconcileRecord(record);
        } finally {
            record.calldata.fill(0);
            record.signedTransaction.fill(0);
        }
    }

    async #reconcileRecord(record) {
        if (record.metadata.kind === "route") {
            try {
                await this.chainAdapter.observeRoutingWithdrawal(
                    record.metadata.context,
                );
            } catch (error) {
                wrap(error, "RECONCILIATION_FAILED");
            }
        } else {
            await this.#verifySession(record.metadata.context);
        }
        const hash = record.metadata.transactionHash;
        let receipt = null;
        let pending = null;
        const [receiptResult, pendingResult] = await Promise.allSettled([
            this.provider.getTransactionReceipt(hash),
            this.provider.getTransaction(hash),
        ]);
        if (
            receiptResult.status !== "fulfilled"
            || pendingResult.status !== "fulfilled"
        ) {
            fail("RECONCILIATION_FAILED");
        }
        receipt = receiptResult.value;
        pending = pendingResult.value;
        if (
            receipt !== null
            && String(receipt.hash ?? receipt.transactionHash ?? "").toLowerCase() !== hash
        ) {
            fail("RECEIPT_INVALID");
        }
        if (
            pending !== null
            && String(pending.hash ?? "").toLowerCase() !== hash
        ) {
            fail("PENDING_TRANSACTION_INVALID");
        }
        let observation;
        try {
            switch (record.metadata.kind) {
            case "reveal":
                observation = await this.chainAdapter.recheckBeforeReveal(
                    baseContext(record.metadata.context),
                );
                break;
            case "place":
                observation = await this.chainAdapter.observePlacement(
                    baseContext(record.metadata.context),
                );
                break;
            case "cancel":
            case "cancel-sweep":
                observation = await this.chainAdapter.observeCancellation(
                    baseContext(record.metadata.context),
                );
                break;
            case "expire":
            case "sweep":
                observation = await this.chainAdapter.observeRelease(
                    baseContext(record.metadata.context),
                );
                break;
            case "route":
                observation = await this.chainAdapter.observeRoutingWithdrawal(
                    record.metadata.context,
                );
                break;
            default:
                fail("PREPARED_TRANSACTION_MISMATCH");
            }
        } catch (error) {
            if (error?.code === "REVEAL_WINDOW_CLOSED") {
                return Object.freeze({status: "REJECTED", transactionHash: hash});
            }
            wrap(error, "RECONCILIATION_FAILED");
        }
        if (
            record.metadata.kind !== "route"
            && ["PLACED", "REVEALABLE", "REVEALED", "CANCELLED"].includes(
                observation?.status,
            )
            && observation.commitment !== record.metadata.context.engineCommitment
        ) {
            fail("RECONCILIATION_FAILED");
        }
        const confirmedByChain = (
            record.metadata.kind === "reveal"
                ? observation?.status === "REVEALED"
                : record.metadata.kind === "place"
                    ? observation?.status === "PLACED"
                    : record.metadata.kind === "cancel"
                        ? observation?.status === "CANCELLED"
                        : record.metadata.kind === "expire"
                            ? ["SWEEP_REQUIRED", "RELEASED"].includes(
                                observation?.status,
                            )
                            : record.metadata.kind === "sweep"
                                ? observation?.status === "RELEASED"
                                : record.metadata.kind === "cancel-sweep"
                                    ? (
                                        observation?.status === "CANCELLED"
                                        && observation.engineCredit === "0"
                                    )
                                    : observation?.status === "SPENT"
        );
        const receiptStatus = receipt === null ? null : normalizeReceiptStatus(receipt);
        if (confirmedByChain) {
            return Object.freeze({
                status: "CONFIRMED",
                transactionHash: receiptStatus === "CONFIRMED" ? hash : null,
            });
        }
        if (receiptStatus !== null) {
            if (receiptStatus === "REJECTED") {
                return Object.freeze({status: receiptStatus, transactionHash: hash});
            }
            return Object.freeze({status: "UNKNOWN", transactionHash: hash});
        }
        if (pending !== null) {
            return Object.freeze({status: "PENDING", transactionHash: hash});
        }
        if (
            (
                record.metadata.kind === "place"
                && observation?.status === "CANCELLED"
            )
            || (
                record.metadata.kind === "reveal"
                && ["ABSENT", "CANCELLED"].includes(observation?.status)
            )
            || (
                record.metadata.kind === "cancel"
                && ["ABSENT", "REVEALED", "CLOSED"].includes(observation?.status)
            )
            || (
                record.metadata.kind === "cancel-sweep"
                && observation?.status !== "CANCELLED"
            )
            || (
                record.metadata.kind === "expire"
                && observation?.status === "RESTING"
            )
        ) {
            return Object.freeze({status: "REJECTED", transactionHash: hash});
        }
        return Object.freeze({status: "ABSENT", transactionHash: hash});
    }

    async #broadcastPrepared(request, kind) {
        const normalized = preparedRequest(request, kind);
        const record = await this.#loadPrepared(normalized, kind);
        try {
            const before = await this.#reconcileRecord(record);
            if (before.status !== "ABSENT") return before;
            await this.#requireRelayerBalance(
                BigInt(record.metadata.gasLimit),
                BigInt(record.metadata.gasPrice),
            );
            let response;
            try {
                response = await this.provider.broadcastTransaction(
                    `0x${record.signedTransaction.toString("hex")}`,
                );
            } catch (error) {
                const reconciled = await this.#reconcileRecord(record);
                if (reconciled.status !== "ABSENT") return reconciled;
                return Object.freeze({
                    status: UNKNOWN_BROADCAST_CODES.has(String(error?.code ?? ""))
                        ? "UNKNOWN"
                        : "REJECTED",
                    transactionHash: record.metadata.transactionHash,
                });
            }
            if (
                response?.hash !== undefined
                && String(response.hash).toLowerCase() !== record.metadata.transactionHash
            ) {
                fail("BROADCAST_HASH_MISMATCH");
            }
            if (typeof response?.wait === "function") {
                try {
                    await response.wait(
                        this.confirmations,
                        this.transactionTimeoutMilliseconds,
                    );
                } catch {
                    // Reconciliation below is authoritative.
                }
            }
            const after = await this.#reconcileRecord(record);
            return after.status === "ABSENT"
                ? Object.freeze({
                    status: "UNKNOWN",
                    transactionHash: record.metadata.transactionHash,
                })
                : after;
        } finally {
            record.calldata.fill(0);
            record.signedTransaction.fill(0);
        }
    }
}
