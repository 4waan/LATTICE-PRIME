import {canonicalizeContext} from "./context.mjs";

export const MANDATE_SCHEMA_VERSION = "lattice.agent.mandate.v1";

const TOP_LEVEL_KEYS = ["schemaVersion", "identity", "ticket", "limits", "time", "privacy", "control"];
const IDENTITY_KEYS = [
    "chainId",
    "executionAccount",
    "deploymentHash",
    "modelBundleHash",
    "policyHash",
    "mandateNonce",
];
const TICKET_KEYS = [
    "engine",
    "token",
    "side",
    "quantity",
    "limitPrice",
    "recoveryAddress",
    "permittedMethods",
];
const LIMIT_KEYS = [
    "newOrderLimit",
    "principalBudget",
    "bondBudget",
    "cancellationBudget",
    "feeReserve",
    "maxPendingOrders",
    "decisionSlots",
    "maxEvaluations",
];
const TIME_KEYS = ["validFrom", "lastNewEntryAt", "recoveryDeadline", "snapshotFreshnessSeconds"];
const PRIVACY_KEYS = [
    "mode",
    "excludedInputs",
    "releaseFunctionId",
    "receiptExportMode",
    "externalModelEndpoint",
];
const CONTROL_KEYS = ["activationId", "revocationGeneration", "paused", "completeOutstandingObligations"];

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const EXCLUDED_INPUTS = Object.freeze([
    "credentialMaterial",
    "offPlatformHoldings",
    "privatePreferences",
    "revealSalt",
    "signingKey",
]);
const PERMITTED_METHODS = Object.freeze(["commit", "reveal", "cancel", "expire", "withdraw"]);

export class MandateError extends TypeError {
    constructor(code, message) {
        super(message);
        this.name = "MandateError";
        this.code = code;
    }
}

function object(value, name, keys) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new MandateError("INVALID_OBJECT", `${name} must be an object`);
    }
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
        throw new MandateError("UNKNOWN_OR_MISSING_FIELD", `${name} has an unknown or missing field`);
    }
}

function decimal(value, name, bits, {nonzero = false} = {}) {
    if (typeof value !== "string" || !DECIMAL.test(value)) {
        throw new MandateError("INVALID_DECIMAL", `${name} must be a canonical decimal string`);
    }
    const parsed = BigInt(value);
    if ((nonzero && parsed === 0n) || parsed >= 1n << BigInt(bits)) {
        throw new MandateError("DECIMAL_OUT_OF_RANGE", `${name} does not fit uint${bits}`);
    }
    return parsed.toString();
}

function hex(value, name, pattern) {
    if (typeof value !== "string" || !pattern.test(value)) {
        throw new MandateError("INVALID_HEX", `${name} has an invalid hex encoding`);
    }
    return value.toLowerCase();
}

function integer(value, name, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new MandateError("INTEGER_OUT_OF_RANGE", `${name} must be from ${min} to ${max}`);
    }
    return value;
}

function exactStringArray(value, name, expected) {
    if (!Array.isArray(value) || value.length !== expected.length || value.some((item, i) => item !== expected[i])) {
        throw new MandateError("INVALID_ALLOWLIST", `${name} must equal the versioned allowlist`);
    }
    return [...value];
}

export function validateMandate(value) {
    object(value, "mandate", TOP_LEVEL_KEYS);
    object(value.identity, "mandate.identity", IDENTITY_KEYS);
    object(value.ticket, "mandate.ticket", TICKET_KEYS);
    object(value.limits, "mandate.limits", LIMIT_KEYS);
    object(value.time, "mandate.time", TIME_KEYS);
    object(value.privacy, "mandate.privacy", PRIVACY_KEYS);
    object(value.control, "mandate.control", CONTROL_KEYS);

    if (value.schemaVersion !== MANDATE_SCHEMA_VERSION) {
        throw new MandateError("SCHEMA_VERSION", `unsupported mandate schema ${value.schemaVersion}`);
    }
    if (value.ticket.side !== "BUY") {
        throw new MandateError("UNSUPPORTED_SIDE", "the first agent capability permits BUY only");
    }
    if (value.privacy.mode !== "excluded" || value.privacy.releaseFunctionId !== "none") {
        throw new MandateError("PRIVACY_MODE_DISABLED", "optional private preferences are not enabled");
    }
    if (value.privacy.externalModelEndpoint !== null) {
        throw new MandateError("EXTERNAL_MODEL_FORBIDDEN", "an external model endpoint is not permitted");
    }
    if (value.privacy.receiptExportMode !== "sanitized") {
        throw new MandateError("UNSAFE_EXPORT_MODE", "the first agent capability exports sanitized receipts only");
    }
    if (typeof value.control.paused !== "boolean" || typeof value.control.completeOutstandingObligations !== "boolean") {
        throw new MandateError("INVALID_CONTROL", "mandate control flags must be booleans");
    }

    const decisionSlots = value.limits.decisionSlots;
    if (!Array.isArray(decisionSlots) || decisionSlots.length < 1 || decisionSlots.length > 3) {
        throw new MandateError("INVALID_SLOTS", "decisionSlots must contain one to three public slots");
    }
    const normalizedSlots = decisionSlots.map((slot, i) => decimal(slot, `decisionSlots[${i}]`, 64));
    if (new Set(normalizedSlots).size !== normalizedSlots.length) {
        throw new MandateError("DUPLICATE_SLOT", "decisionSlots must be unique");
    }
    for (let i = 1; i < normalizedSlots.length; i++) {
        if (BigInt(normalizedSlots[i - 1]) >= BigInt(normalizedSlots[i])) {
            throw new MandateError("SLOTS_NOT_ASCENDING", "decisionSlots must be strictly ascending");
        }
    }

    const newOrderLimit = integer(value.limits.newOrderLimit, "newOrderLimit", 1, 1);
    const maxPendingOrders = integer(value.limits.maxPendingOrders, "maxPendingOrders", 1, 1);
    const maxEvaluations = integer(value.limits.maxEvaluations, "maxEvaluations", 1, 3);
    if (maxEvaluations > normalizedSlots.length) {
        throw new MandateError("EVALUATION_LIMIT", "maxEvaluations cannot exceed the number of decision slots");
    }

    const validFrom = decimal(value.time.validFrom, "validFrom", 64);
    const lastNewEntryAt = decimal(value.time.lastNewEntryAt, "lastNewEntryAt", 64);
    const recoveryDeadline = decimal(value.time.recoveryDeadline, "recoveryDeadline", 64);
    if (!(BigInt(validFrom) <= BigInt(lastNewEntryAt) && BigInt(lastNewEntryAt) < BigInt(recoveryDeadline))) {
        throw new MandateError("INVALID_TIME_ORDER", "mandate times are not ordered");
    }

    return {
        schemaVersion: MANDATE_SCHEMA_VERSION,
        identity: {
            chainId: decimal(value.identity.chainId, "identity.chainId", 64),
            executionAccount: hex(value.identity.executionAccount, "identity.executionAccount", ADDRESS),
            deploymentHash: hex(value.identity.deploymentHash, "identity.deploymentHash", BYTES32),
            modelBundleHash: hex(value.identity.modelBundleHash, "identity.modelBundleHash", BYTES32),
            policyHash: hex(value.identity.policyHash, "identity.policyHash", BYTES32),
            mandateNonce: hex(value.identity.mandateNonce, "identity.mandateNonce", BYTES32),
        },
        ticket: {
            engine: hex(value.ticket.engine, "ticket.engine", ADDRESS),
            token: hex(value.ticket.token, "ticket.token", ADDRESS),
            side: "BUY",
            quantity: decimal(value.ticket.quantity, "ticket.quantity", 128, {nonzero: true}),
            limitPrice: decimal(value.ticket.limitPrice, "ticket.limitPrice", 128, {nonzero: true}),
            recoveryAddress: hex(value.ticket.recoveryAddress, "ticket.recoveryAddress", ADDRESS),
            permittedMethods: exactStringArray(
                value.ticket.permittedMethods,
                "ticket.permittedMethods",
                PERMITTED_METHODS
            ),
        },
        limits: {
            newOrderLimit,
            principalBudget: decimal(value.limits.principalBudget, "limits.principalBudget", 256),
            bondBudget: decimal(value.limits.bondBudget, "limits.bondBudget", 256),
            cancellationBudget: decimal(value.limits.cancellationBudget, "limits.cancellationBudget", 256),
            feeReserve: decimal(value.limits.feeReserve, "limits.feeReserve", 256),
            maxPendingOrders,
            decisionSlots: normalizedSlots,
            maxEvaluations,
        },
        time: {
            validFrom,
            lastNewEntryAt,
            recoveryDeadline,
            snapshotFreshnessSeconds: integer(
                value.time.snapshotFreshnessSeconds,
                "snapshotFreshnessSeconds",
                1,
                300
            ),
        },
        privacy: {
            mode: "excluded",
            excludedInputs: exactStringArray(value.privacy.excludedInputs, "excludedInputs", EXCLUDED_INPUTS),
            releaseFunctionId: "none",
            receiptExportMode: "sanitized",
            externalModelEndpoint: null,
        },
        control: {
            activationId: hex(value.control.activationId, "control.activationId", BYTES32),
            revocationGeneration: integer(
                value.control.revocationGeneration,
                "control.revocationGeneration",
                0,
                0xffff_ffff
            ),
            paused: value.control.paused,
            completeOutstandingObligations: value.control.completeOutstandingObligations,
        },
    };
}

export function assertContextAuthorized(mandateValue, contextValue) {
    const mandate = validateMandate(mandateValue);
    const context = canonicalizeContext(contextValue);
    const checks = [
        [context.chainId, mandate.identity.chainId, "chain"],
        [context.engine, mandate.ticket.engine, "engine"],
        [context.executionAccount, mandate.identity.executionAccount, "execution account"],
        [context.token, mandate.ticket.token, "token"],
        [context.side, mandate.ticket.side, "side"],
        [context.price, mandate.ticket.limitPrice, "price"],
        [context.quantity, mandate.ticket.quantity, "quantity"],
        [context.recoveryAddress, mandate.ticket.recoveryAddress, "recovery address"],
        [context.deploymentHash, mandate.identity.deploymentHash, "deployment"],
        [context.modelBundleHash, mandate.identity.modelBundleHash, "model bundle"],
        [context.policyHash, mandate.identity.policyHash, "policy"],
        [context.mandateNonce, mandate.identity.mandateNonce, "mandate nonce"],
    ];
    for (const [got, want, label] of checks) {
        if (got !== want) {
            throw new MandateError("CONTEXT_MISMATCH", `decision context ${label} does not match the mandate`);
        }
    }
    if (!mandate.limits.decisionSlots.includes(context.publicSlot)) {
        throw new MandateError("SLOT_NOT_AUTHORIZED", "decision context uses an unauthorized public slot");
    }
    if (context.decisionSequence >= mandate.limits.maxEvaluations) {
        throw new MandateError("SEQUENCE_EXHAUSTED", "decision sequence exceeds the mandate limit");
    }
    if (context.features.freshnessSeconds > mandate.time.snapshotFreshnessSeconds) {
        throw new MandateError("STALE_SNAPSHOT", "market snapshot is too old for the mandate");
    }
    if (context.features.bufferCategory !== 1 || context.features.horizonCategory !== 1) {
        throw new MandateError(
            "PRIVATE_CONTEXT_EXCLUDED",
            "default mode requires neutral category constants and accepts no private preferences"
        );
    }
    if (
        BigInt(context.publicSlot) < BigInt(mandate.time.validFrom) ||
        BigInt(context.publicSlot) > BigInt(mandate.time.lastNewEntryAt) ||
        BigInt(context.expiresAt) > BigInt(mandate.time.lastNewEntryAt) ||
        BigInt(context.expiresAt) <= BigInt(context.publicSlot)
    ) {
        throw new MandateError("CONTEXT_TIME", "decision context is outside the new-entry window");
    }
    if (mandate.control.paused) {
        throw new MandateError("MANDATE_PAUSED", "the mandate is paused for new orders");
    }
    return {mandate, context};
}
