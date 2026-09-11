import {getAddress} from "ethers";

export const PRIVATE_SESSION_RECOVERY_CHAIN_ID = 296n;
export const PRIVATE_SESSION_RECOVERY_REQUEST_KEYS = Object.freeze([
    "account",
    "action",
    "amount",
    "asset",
    "chainId",
    "nonce",
    "noteCommitment",
    "signature",
]);

const ALLOWLIST_KEYS = Object.freeze([
    "factory",
    "generation",
    "pools",
    "router",
    "security",
]);
const POOL_KEYS = Object.freeze(["HBAR", "LPRC"]);
const POOL_CONFIG_KEYS = Object.freeze(["address", "asset", "denomination"]);
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/;
const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
const UINT64_LIMIT = 1n << 64n;
const UINT256_LIMIT = 1n << 256n;
const SNARK_SCALAR_FIELD =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const SECP256K1_HALF_N =
    0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export class PrivateSessionRecoveryError extends Error {
    constructor(code, status = 400) {
        super("private session recovery failed");
        this.name = "PrivateSessionRecoveryError";
        this.code = code;
        this.status = status;
    }
}

export function privateSessionRecoveryFail(code, status = 400) {
    throw new PrivateSessionRecoveryError(code, status);
}

function exactObject(value, keys, code = "RECOVERY_REQUEST_SCHEMA_INVALID") {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
    ) {
        privateSessionRecoveryFail(code);
    }
}

function address(value, {zero = false, code = "RECOVERY_REQUEST_SCHEMA_INVALID"} = {}) {
    try {
        const normalized = getAddress(value).toLowerCase();
        if (!ADDRESS.test(normalized) || (!zero && normalized === ZERO_ADDRESS)) {
            throw new Error();
        }
        return normalized;
    } catch {
        privateSessionRecoveryFail(code);
    }
}

function decimal(value, {
    code = "RECOVERY_REQUEST_SCHEMA_INVALID",
    limit = UINT256_LIMIT,
    nonzero = false,
} = {}) {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
        privateSessionRecoveryFail(code);
    }
    const parsed = BigInt(value);
    if (parsed >= limit || (nonzero && parsed === 0n)) {
        privateSessionRecoveryFail(code);
    }
    return value;
}

function signature(value) {
    if (!SIGNATURE.test(value ?? "")) {
        privateSessionRecoveryFail("RECOVERY_SIGNATURE_INVALID");
    }
    const normalized = value.toLowerCase();
    const s = BigInt(`0x${normalized.slice(66, 130)}`);
    const v = Number.parseInt(normalized.slice(130, 132), 16);
    if (s === 0n || s > SECP256K1_HALF_N || ![27, 28].includes(v)) {
        privateSessionRecoveryFail("RECOVERY_SIGNATURE_INVALID");
    }
    return normalized;
}

export function normalizePrivateSessionRecoveryAllowlist(value) {
    exactObject(value, ALLOWLIST_KEYS, "RECOVERY_CONTROLLER_CONFIG_INVALID");
    exactObject(value.pools, POOL_KEYS, "RECOVERY_CONTROLLER_CONFIG_INVALID");
    const security = address(value.security, {
        code: "RECOVERY_CONTROLLER_CONFIG_INVALID",
    });
    const pools = {};
    for (const asset of POOL_KEYS) {
        const configured = value.pools[asset];
        exactObject(
            configured,
            POOL_CONFIG_KEYS,
            "RECOVERY_CONTROLLER_CONFIG_INVALID",
        );
        const poolAsset = address(configured.asset, {
            zero: asset === "HBAR",
            code: "RECOVERY_CONTROLLER_CONFIG_INVALID",
        });
        if (
            (asset === "HBAR" && poolAsset !== ZERO_ADDRESS)
            || (asset === "LPRC" && poolAsset !== security)
        ) {
            privateSessionRecoveryFail(
                "RECOVERY_CONTROLLER_CONFIG_INVALID",
                500,
            );
        }
        pools[asset] = Object.freeze({
            address: address(configured.address, {
                code: "RECOVERY_CONTROLLER_CONFIG_INVALID",
            }),
            asset: poolAsset,
            denomination: decimal(configured.denomination, {
                code: "RECOVERY_CONTROLLER_CONFIG_INVALID",
                nonzero: true,
            }),
        });
    }
    return Object.freeze({
        factory: address(value.factory, {
            code: "RECOVERY_CONTROLLER_CONFIG_INVALID",
        }),
        generation: decimal(value.generation, {
            code: "RECOVERY_CONTROLLER_CONFIG_INVALID",
            limit: UINT64_LIMIT,
        }),
        pools: Object.freeze(pools),
        router: address(value.router, {
            code: "RECOVERY_CONTROLLER_CONFIG_INVALID",
        }),
        security,
    });
}

export function normalizePrivateSessionRecoveryRequest(value) {
    exactObject(value, PRIVATE_SESSION_RECOVERY_REQUEST_KEYS);
    if (
        value.action !== "recover-to-router"
        || value.chainId !== PRIVATE_SESSION_RECOVERY_CHAIN_ID.toString()
        || !POOL_KEYS.includes(value.asset)
    ) {
        privateSessionRecoveryFail("RECOVERY_REQUEST_SCHEMA_INVALID");
    }
    return Object.freeze({
        action: value.action,
        chainId: value.chainId,
        account: address(value.account),
        asset: value.asset,
        amount: decimal(value.amount, {nonzero: true}),
        noteCommitment: decimal(value.noteCommitment, {
            limit: SNARK_SCALAR_FIELD,
            nonzero: true,
        }),
        nonce: decimal(value.nonce),
        signature: signature(value.signature),
    });
}

function publicResult(value) {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== "status,txHash"
        || value.status !== "CONFIRMED"
        || typeof value.txHash !== "string"
        || !TRANSACTION_HASH.test(value.txHash.toLowerCase())
    ) {
        privateSessionRecoveryFail("RECOVERY_RESULT_INVALID", 502);
    }
    return Object.freeze({
        status: "CONFIRMED",
        txHash: value.txHash.toLowerCase(),
    });
}

export class PrivateSessionRecoveryController {
    constructor({chainAdapter}) {
        if (typeof chainAdapter?.relayRecovery !== "function") {
            privateSessionRecoveryFail(
                "RECOVERY_CONTROLLER_CONFIG_INVALID",
                500,
            );
        }
        this.chainAdapter = chainAdapter;
    }

    async handle(body) {
        try {
            return publicResult(await this.chainAdapter.relayRecovery(
                normalizePrivateSessionRecoveryRequest(body),
            ));
        } catch (error) {
            if (error instanceof PrivateSessionRecoveryError) throw error;
            privateSessionRecoveryFail("RECOVERY_FAILED", 500);
        }
    }
}
