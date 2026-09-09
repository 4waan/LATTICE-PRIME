import {createHash} from "node:crypto";

export const CONTEXT_SCHEMA_VERSION = "lattice.agent.context.v1";
export const CONTEXT_LIMBS = 173;
export const LIMB_BITS = 16n;
const LIMB_BASE = 1n << LIMB_BITS;

const FEATURE_KEYS = Object.freeze([
    "limitRoomBps",
    "recentMoveOffsetBps",
    "roundProgressBps",
    "freshnessSeconds",
    "bufferCategory",
    "horizonCategory",
]);

const CONTEXT_KEYS = Object.freeze([
    "protocolDomain",
    "chainId",
    "engine",
    "executionAccount",
    "token",
    "side",
    "price",
    "quantity",
    "recoveryAddress",
    "snapshotId",
    "deploymentHash",
    "modelBundleHash",
    "policyHash",
    "mandateNonce",
    "decisionSequence",
    "publicSlot",
    "expiresAt",
    "features",
]);

export class ContextError extends TypeError {
    constructor(code, message) {
        super(message);
        this.name = "ContextError";
        this.code = code;
    }
}

function requirePlainObject(value, name) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new ContextError("INVALID_OBJECT", `${name} must be an object`);
    }
}

function requireExactKeys(value, expected, name) {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) {
        throw new ContextError(
            "UNKNOWN_OR_MISSING_FIELD",
            `${name} fields must be exactly ${wanted.join(", ")}`
        );
    }
}

function integer(value, name, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new ContextError("INTEGER_OUT_OF_RANGE", `${name} must be an integer from ${min} to ${max}`);
    }
    return value;
}

function decimal(value, name, bits, {nonzero = false} = {}) {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new ContextError("INVALID_DECIMAL", `${name} must be a canonical unsigned decimal string`);
    }
    const parsed = BigInt(value);
    if ((nonzero && parsed === 0n) || parsed >= 1n << BigInt(bits)) {
        throw new ContextError("DECIMAL_OUT_OF_RANGE", `${name} does not fit uint${bits}`);
    }
    return parsed.toString();
}

function hex(value, name, bytes) {
    const pattern = new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`);
    if (typeof value !== "string" || !pattern.test(value)) {
        throw new ContextError("INVALID_HEX", `${name} must be a ${bytes}-byte 0x-prefixed hex string`);
    }
    return value.toLowerCase();
}

export function canonicalizeContext(value) {
    requirePlainObject(value, "context");
    requireExactKeys(value, CONTEXT_KEYS, "context");
    requirePlainObject(value.features, "context.features");
    requireExactKeys(value.features, FEATURE_KEYS, "context.features");

    if (value.side !== "BUY") {
        throw new ContextError("UNSUPPORTED_SIDE", "the first agent capability permits BUY only");
    }

    return {
        protocolDomain: hex(value.protocolDomain, "protocolDomain", 32),
        chainId: decimal(value.chainId, "chainId", 64),
        engine: hex(value.engine, "engine", 20),
        executionAccount: hex(value.executionAccount, "executionAccount", 20),
        token: hex(value.token, "token", 20),
        side: "BUY",
        price: decimal(value.price, "price", 128, {nonzero: true}),
        quantity: decimal(value.quantity, "quantity", 128, {nonzero: true}),
        recoveryAddress: hex(value.recoveryAddress, "recoveryAddress", 20),
        snapshotId: hex(value.snapshotId, "snapshotId", 32),
        deploymentHash: hex(value.deploymentHash, "deploymentHash", 32),
        modelBundleHash: hex(value.modelBundleHash, "modelBundleHash", 32),
        policyHash: hex(value.policyHash, "policyHash", 32),
        mandateNonce: hex(value.mandateNonce, "mandateNonce", 32),
        decisionSequence: integer(value.decisionSequence, "decisionSequence", 0, 0xffff_ffff),
        publicSlot: decimal(value.publicSlot, "publicSlot", 64),
        expiresAt: decimal(value.expiresAt, "expiresAt", 64),
        features: {
            limitRoomBps: integer(value.features.limitRoomBps, "features.limitRoomBps", 0, 2000),
            recentMoveOffsetBps: integer(
                value.features.recentMoveOffsetBps,
                "features.recentMoveOffsetBps",
                0,
                2000
            ),
            roundProgressBps: integer(
                value.features.roundProgressBps,
                "features.roundProgressBps",
                0,
                10_000
            ),
            freshnessSeconds: integer(
                value.features.freshnessSeconds,
                "features.freshnessSeconds",
                0,
                300
            ),
            bufferCategory: integer(value.features.bufferCategory, "features.bufferCategory", 0, 2),
            horizonCategory: integer(value.features.horizonCategory, "features.horizonCategory", 0, 2),
        },
    };
}

function limbsOf(value, count) {
    let remaining = BigInt(value);
    const limbs = new Array(count);
    for (let i = count - 1; i >= 0; i--) {
        limbs[i] = Number(remaining % LIMB_BASE);
        remaining /= LIMB_BASE;
    }
    if (remaining !== 0n) {
        throw new ContextError("LIMB_OVERFLOW", `value does not fit ${count} limbs`);
    }
    return limbs;
}

function hexLimbs(value, count) {
    return limbsOf(BigInt(value), count);
}

export function encodeContext(value) {
    const context = canonicalizeContext(value);
    const f = context.features;
    const encoded = [
        f.limitRoomBps,
        f.recentMoveOffsetBps,
        f.roundProgressBps,
        f.freshnessSeconds,
        f.bufferCategory,
        f.horizonCategory,
        ...hexLimbs(context.protocolDomain, 16),
        ...limbsOf(context.chainId, 4),
        ...hexLimbs(context.engine, 10),
        ...hexLimbs(context.executionAccount, 10),
        ...hexLimbs(context.token, 10),
        0,
        ...limbsOf(context.price, 8),
        ...limbsOf(context.quantity, 8),
        ...hexLimbs(context.recoveryAddress, 10),
        ...hexLimbs(context.snapshotId, 16),
        ...hexLimbs(context.deploymentHash, 16),
        ...hexLimbs(context.modelBundleHash, 16),
        ...hexLimbs(context.policyHash, 16),
        ...hexLimbs(context.mandateNonce, 16),
        ...limbsOf(context.decisionSequence, 2),
        ...limbsOf(context.publicSlot, 4),
        ...limbsOf(context.expiresAt, 4),
    ];
    if (encoded.length !== CONTEXT_LIMBS) {
        throw new ContextError("INTERNAL_LAYOUT", `encoded ${encoded.length} limbs, expected ${CONTEXT_LIMBS}`);
    }
    return encoded;
}

export function canonicalContextJson(value) {
    return JSON.stringify(canonicalizeContext(value));
}

export function contextId(value) {
    return `sha256:${createHash("sha256").update(canonicalContextJson(value)).digest("hex")}`;
}
