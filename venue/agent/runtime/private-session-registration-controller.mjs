import {createHash} from "node:crypto";

import {getAddress} from "ethers";

export const PRIVATE_SESSION_REGISTRATION_CHAIN_ID = 296n;
export const PRIVATE_SESSION_REGISTRATION_REQUEST_KEYS = Object.freeze([
    "account",
    "action",
    "chainId",
    "ciphertext",
    "compliance",
    "config",
    "deploymentSalt",
    "eligibility",
    "factory",
    "gate",
    "registry",
]);

const ALLOWLIST_KEYS = Object.freeze([
    "creationCodeHash",
    "engine",
    "factory",
    "feePolicyDigest",
    "gate",
    "partition",
    "quicknetChainHash",
    "registry",
    "router",
    "security",
]);
const CONFIG_KEYS = Object.freeze([
    "engine",
    "feePolicyDigest",
    "generation",
    "partition",
    "quicknetChainHash",
    "recoverySigner",
    "router",
    "security",
    "sessionSigner",
]);
const CIPHERTEXT_KEYS = Object.freeze([
    "encryptedCredential",
    "ephemeralX",
    "ephemeralY",
    "tag",
]);
const PROOF_KEYS = Object.freeze(["proof", "publicSignals"]);
const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const UINT256_WORD = /^0x[0-9a-fA-F]{64}$/;
const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const UINT64_LIMIT = 1n << 64n;
const UINT256_LIMIT = 1n << 256n;
const SNARK_SCALAR_FIELD =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const PUBLIC_STATUSES = new Set([
    "ALREADY_CONFIRMED",
    "CONFIRMED",
    "PENDING",
    "REJECTED",
    "UNKNOWN",
]);

export class PrivateSessionRegistrationError extends Error {
    constructor(code, status = 400) {
        super("private session registration failed");
        this.name = "PrivateSessionRegistrationError";
        this.code = code;
        this.status = status;
    }
}

export function privateSessionRegistrationFail(code, status = 400) {
    throw new PrivateSessionRegistrationError(code, status);
}

function exactObject(value, keys, code = "REQUEST_SCHEMA_INVALID") {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
    ) {
        privateSessionRegistrationFail(code);
    }
}

function address(value, code = "REQUEST_SCHEMA_INVALID") {
    try {
        const normalized = getAddress(value).toLowerCase();
        if (!ADDRESS.test(normalized) || normalized === ZERO_ADDRESS) throw new Error();
        return normalized;
    } catch {
        privateSessionRegistrationFail(code);
    }
}

function bytes32(value, code = "REQUEST_SCHEMA_INVALID") {
    if (typeof value !== "string" || !BYTES32.test(value.toLowerCase())) {
        privateSessionRegistrationFail(code);
    }
    return value.toLowerCase();
}

function decimal(
    value,
    {
        code = "REQUEST_SCHEMA_INVALID",
        limit = UINT256_LIMIT,
    } = {},
) {
    if (
        typeof value !== "string"
        || value.length > (limit - 1n).toString().length
        || !/^(0|[1-9][0-9]*)$/.test(value)
    ) {
        privateSessionRegistrationFail(code);
    }
    let parsed;
    try {
        parsed = BigInt(value);
    } catch {
        privateSessionRegistrationFail(code);
    }
    if (parsed < 0n || parsed >= limit) privateSessionRegistrationFail(code);
    return value;
}

function uintString(value, options = {}) {
    if (typeof value === "string" && UINT256_WORD.test(value)) {
        const parsed = BigInt(value);
        const limit = options.limit ?? UINT256_LIMIT;
        if (parsed >= limit) privateSessionRegistrationFail(
            options.code ?? "REQUEST_SCHEMA_INVALID",
        );
        return parsed.toString();
    }
    return decimal(value, options);
}

function generation(value) {
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value < 0) {
            privateSessionRegistrationFail("REQUEST_SCHEMA_INVALID");
        }
        return decimal(String(value), {limit: UINT64_LIMIT});
    }
    return decimal(value, {limit: UINT64_LIMIT});
}

function fixedUintArray(value, length, {field = false} = {}) {
    if (
        !Array.isArray(value)
        || value.length !== length
        || Object.keys(value).join(",")
            !== Array.from({length}, (_, index) => String(index)).join(",")
    ) {
        privateSessionRegistrationFail("REQUEST_SCHEMA_INVALID");
    }
    return Object.freeze(Array.from(value, (item) => uintString(item, {
        limit: field ? SNARK_SCALAR_FIELD : UINT256_LIMIT,
    })));
}

function normalizeProofBundle(value, signalLength) {
    exactObject(value, PROOF_KEYS);
    return Object.freeze({
        proof: fixedUintArray(value.proof, 24),
        publicSignals: fixedUintArray(value.publicSignals, signalLength, {
            field: true,
        }),
    });
}

export function normalizePrivateSessionRegistrationAllowlist(value) {
    exactObject(value, ALLOWLIST_KEYS, "CONTROLLER_CONFIG_INVALID");
    const creationCodeHash = bytes32(
        value.creationCodeHash,
        "CONTROLLER_CONFIG_INVALID",
    );
    if (creationCodeHash === ZERO_BYTES32) {
        privateSessionRegistrationFail("CONTROLLER_CONFIG_INVALID", 500);
    }
    return Object.freeze({
        creationCodeHash,
        factory: address(value.factory, "CONTROLLER_CONFIG_INVALID"),
        gate: address(value.gate, "CONTROLLER_CONFIG_INVALID"),
        registry: address(value.registry, "CONTROLLER_CONFIG_INVALID"),
        engine: address(value.engine, "CONTROLLER_CONFIG_INVALID"),
        security: address(value.security, "CONTROLLER_CONFIG_INVALID"),
        partition: bytes32(value.partition, "CONTROLLER_CONFIG_INVALID"),
        router: address(value.router, "CONTROLLER_CONFIG_INVALID"),
        quicknetChainHash: bytes32(
            value.quicknetChainHash,
            "CONTROLLER_CONFIG_INVALID",
        ),
        feePolicyDigest: bytes32(
            value.feePolicyDigest,
            "CONTROLLER_CONFIG_INVALID",
        ),
    });
}

function requireEqual(left, right, code = "PUBLIC_SIGNAL_CONTEXT_MISMATCH") {
    if (left !== right) privateSessionRegistrationFail(code);
}

function pinPublicSignals(request) {
    const eligibility = request.eligibility.publicSignals;
    const compliance = request.compliance.publicSignals;
    const accountField = BigInt(request.account).toString();
    const signerField = BigInt(request.config.sessionSigner).toString();
    const factoryField = BigInt(request.factory).toString();

    decimal(eligibility[4], {limit: UINT64_LIMIT});
    decimal(compliance[14], {limit: UINT64_LIMIT});
    requireEqual(eligibility[1], "1");
    requireEqual(eligibility[5], accountField);
    requireEqual(eligibility[6], signerField);
    requireEqual(eligibility[7], factoryField);
    requireEqual(compliance[7], accountField);
    requireEqual(compliance[8], signerField);
    requireEqual(compliance[9], factoryField);

    for (const [eligibilityIndex, complianceIndex] of [
        [2, 4],
        [3, 5],
        [4, 6],
        [5, 7],
        [6, 8],
        [7, 9],
        [8, 10],
        [9, 11],
        [10, 12],
        [11, 13],
    ]) {
        requireEqual(
            eligibility[eligibilityIndex],
            compliance[complianceIndex],
        );
    }

    requireEqual(
        request.ciphertext.encryptedCredential,
        compliance[0],
        "CIPHERTEXT_CONTEXT_MISMATCH",
    );
    requireEqual(
        request.ciphertext.tag,
        compliance[1],
        "CIPHERTEXT_CONTEXT_MISMATCH",
    );
    requireEqual(
        request.ciphertext.ephemeralX,
        compliance[2],
        "CIPHERTEXT_CONTEXT_MISMATCH",
    );
    requireEqual(
        request.ciphertext.ephemeralY,
        compliance[3],
        "CIPHERTEXT_CONTEXT_MISMATCH",
    );
}

function requireAllowlisted(request, allowlist) {
    if (
        request.factory !== allowlist.factory
        || request.gate !== allowlist.gate
        || request.registry !== allowlist.registry
        || request.config.engine !== allowlist.engine
        || request.config.security !== allowlist.security
        || request.config.partition !== allowlist.partition
        || request.config.router !== allowlist.router
        || request.config.quicknetChainHash !== allowlist.quicknetChainHash
        || request.config.feePolicyDigest !== allowlist.feePolicyDigest
    ) {
        privateSessionRegistrationFail("REQUEST_CONTEXT_MISMATCH");
    }
}

export function normalizePrivateSessionRegistrationRequest(value, configuredAllowlist) {
    const allowlist = normalizePrivateSessionRegistrationAllowlist(configuredAllowlist);
    exactObject(value, PRIVATE_SESSION_REGISTRATION_REQUEST_KEYS);
    if (!["deploy-and-register", "register"].includes(value.action)) {
        privateSessionRegistrationFail("REQUEST_SCHEMA_INVALID");
    }
    if (value.chainId !== PRIVATE_SESSION_REGISTRATION_CHAIN_ID.toString()) {
        privateSessionRegistrationFail("CHAIN_MISMATCH");
    }

    exactObject(value.config, CONFIG_KEYS);
    exactObject(value.ciphertext, CIPHERTEXT_KEYS);
    const config = Object.freeze({
        sessionSigner: address(value.config.sessionSigner),
        recoverySigner: address(value.config.recoverySigner),
        engine: address(value.config.engine),
        security: address(value.config.security),
        partition: bytes32(value.config.partition),
        router: address(value.config.router),
        quicknetChainHash: bytes32(value.config.quicknetChainHash),
        generation: generation(value.config.generation),
        feePolicyDigest: bytes32(value.config.feePolicyDigest),
    });
    if (config.sessionSigner === config.recoverySigner) {
        privateSessionRegistrationFail("REQUEST_SCHEMA_INVALID");
    }
    const ciphertext = Object.freeze({
        encryptedCredential: uintString(value.ciphertext.encryptedCredential, {
            limit: SNARK_SCALAR_FIELD,
        }),
        tag: uintString(value.ciphertext.tag, {limit: SNARK_SCALAR_FIELD}),
        ephemeralX: uintString(value.ciphertext.ephemeralX, {
            limit: SNARK_SCALAR_FIELD,
        }),
        ephemeralY: uintString(value.ciphertext.ephemeralY, {
            limit: SNARK_SCALAR_FIELD,
        }),
    });
    const normalized = Object.freeze({
        action: value.action,
        chainId: PRIVATE_SESSION_REGISTRATION_CHAIN_ID.toString(),
        factory: address(value.factory),
        gate: address(value.gate),
        registry: address(value.registry),
        account: address(value.account),
        config,
        deploymentSalt: bytes32(value.deploymentSalt),
        ciphertext,
        eligibility: normalizeProofBundle(value.eligibility, 12),
        compliance: normalizeProofBundle(value.compliance, 17),
    });
    requireAllowlisted(normalized, allowlist);
    pinPublicSignals(normalized);
    return normalized;
}

export function privateSessionRegistrationRequestDigest(value) {
    return `sha256:${createHash("sha256")
        .update(JSON.stringify(value), "utf8")
        .digest("hex")}`;
}

function publicResult(value) {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || !PUBLIC_STATUSES.has(value.status)
    ) {
        privateSessionRegistrationFail("REGISTRATION_RESULT_INVALID", 502);
    }
    const keys = Object.keys(value).sort().join(",");
    if (keys === "status") {
        if (value.status !== "ALREADY_CONFIRMED") {
            privateSessionRegistrationFail("REGISTRATION_RESULT_INVALID", 502);
        }
        return Object.freeze({status: value.status});
    }
    if (
        keys !== "status,txHash"
        || value.status === "ALREADY_CONFIRMED"
        || typeof value.txHash !== "string"
        || !TRANSACTION_HASH.test(value.txHash.toLowerCase())
    ) {
        privateSessionRegistrationFail("REGISTRATION_RESULT_INVALID", 502);
    }
    return Object.freeze({
        status: value.status,
        txHash: value.txHash.toLowerCase(),
    });
}

export class PrivateSessionRegistrationController {
    constructor({chainAdapter, allowlist}) {
        if (
            chainAdapter === null
            || typeof chainAdapter !== "object"
            || typeof chainAdapter.relayRegistration !== "function"
        ) {
            privateSessionRegistrationFail("CONTROLLER_CONFIG_INVALID", 500);
        }
        this.chainAdapter = chainAdapter;
        this.allowlist = normalizePrivateSessionRegistrationAllowlist(allowlist);
    }

    async handle(body) {
        try {
            const request = normalizePrivateSessionRegistrationRequest(
                body,
                this.allowlist,
            );
            return publicResult(
                await this.chainAdapter.relayRegistration(request),
            );
        } catch (error) {
            if (error instanceof PrivateSessionRegistrationError) throw error;
            privateSessionRegistrationFail("REGISTRATION_FAILED", 500);
        }
    }
}
