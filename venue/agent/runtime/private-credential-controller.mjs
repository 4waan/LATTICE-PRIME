// Eligibility-linked holder credential claim.
//
// A wallet that holds a current grant in ZkKycRegistry has already proven
// eligibility. This route lets it obtain its private-session credential with
// one EIP-712 signature instead of a file import. The signature proves the
// claim comes from the wallet; the on-chain grant proves the wallet may hold a
// leaf; the store binds a pooled leaf from the tree the gate currently names.
//
// Errors carry a public code only. Neither the credential nor the signature is
// ever placed on an error, and nothing here logs.
import {getAddress, verifyTypedData} from "ethers";

import {
    PrivateCredentialStoreError,
    bindPrivateCredential,
    boundPrivateCredential,
    readPrivateCredentialStore,
    selectPrivateCredentialTree,
    writePrivateCredentialStore,
} from "./private-credential-store.mjs";

export const PRIVATE_CREDENTIAL_CLAIM_DOMAIN_NAME = "Lattice Prime Private Session";
export const PRIVATE_CREDENTIAL_CLAIM_DOMAIN_VERSION = "1";
export const PRIVATE_CREDENTIAL_CLAIM_TYPES = Object.freeze({
    CredentialClaim: Object.freeze([
        Object.freeze({name: "account", type: "address"}),
        Object.freeze({name: "factory", type: "address"}),
        Object.freeze({name: "issuedAt", type: "uint64"}),
    ]),
});
export const PRIVATE_CREDENTIAL_CLAIM_KEYS = Object.freeze([
    "account",
    "chainId",
    "factory",
    "gate",
    "issuedAt",
    "signature",
]);
export const PRIVATE_CREDENTIAL_CLAIM_WINDOW_SECONDS = 300n;
export const PRIVATE_CREDENTIAL_BODY_LIMIT = 2048;
export const PRIVATE_CREDENTIAL_CHAIN_ID = 296n;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const UINT64_LIMIT = 1n << 64n;

export class PrivateCredentialControllerError extends Error {
    constructor(code, status = 400) {
        super("private credential claim failed");
        this.name = "PrivateCredentialControllerError";
        this.code = code;
        this.status = status;
    }
}

function fail(code, status = 400) {
    throw new PrivateCredentialControllerError(code, status);
}

function plainObject(value) {
    return value !== null
        && typeof value === "object"
        && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function address(value, code = "CLAIM_SCHEMA_INVALID", status = 400) {
    try {
        const normalized = getAddress(value).toLowerCase();
        if (!ADDRESS.test(normalized) || normalized === ZERO_ADDRESS) throw new Error();
        return normalized;
    } catch {
        fail(code, status);
    }
}

function uint64(value, code = "CLAIM_SCHEMA_INVALID") {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 20) {
        fail(code);
    }
    const parsed = BigInt(value);
    if (parsed >= UINT64_LIMIT) fail(code);
    return parsed;
}

export function normalizePrivateCredentialAllowlist(value) {
    if (
        !plainObject(value)
        || Object.keys(value).sort().join(",") !== "chainId,factory,gate"
    ) {
        fail("CONTROLLER_CONFIG_INVALID", 500);
    }
    const chainId = typeof value.chainId === "bigint"
        ? value.chainId
        : uint64(String(value.chainId), "CONTROLLER_CONFIG_INVALID");
    if (chainId !== PRIVATE_CREDENTIAL_CHAIN_ID) fail("CONTROLLER_CONFIG_INVALID", 500);
    return Object.freeze({
        chainId: chainId.toString(),
        gate: address(value.gate, "CONTROLLER_CONFIG_INVALID", 500),
        factory: address(value.factory, "CONTROLLER_CONFIG_INVALID", 500),
    });
}

export function privateCredentialClaimDomain({chainId, gate}) {
    return Object.freeze({
        name: PRIVATE_CREDENTIAL_CLAIM_DOMAIN_NAME,
        version: PRIVATE_CREDENTIAL_CLAIM_DOMAIN_VERSION,
        chainId: Number(chainId),
        verifyingContract: gate,
    });
}

export function normalizePrivateCredentialClaim(value, allowlist, nowSeconds) {
    if (
        !plainObject(value)
        || Object.keys(value).sort().join(",") !== PRIVATE_CREDENTIAL_CLAIM_KEYS.join(",")
    ) {
        fail("CLAIM_SCHEMA_INVALID");
    }
    const account = address(value.account);
    const gate = address(value.gate);
    const factory = address(value.factory);
    if (
        typeof value.chainId !== "string"
        || !/^(0|[1-9][0-9]*)$/.test(value.chainId)
        || typeof value.signature !== "string"
        || !SIGNATURE.test(value.signature)
    ) {
        fail("CLAIM_SCHEMA_INVALID");
    }
    const issuedAt = uint64(value.issuedAt);
    if (
        value.chainId !== allowlist.chainId
        || gate !== allowlist.gate
        || factory !== allowlist.factory
    ) {
        fail("CLAIM_CONTEXT_INVALID");
    }
    const now = typeof nowSeconds === "bigint" ? nowSeconds : BigInt(nowSeconds);
    const skew = now >= issuedAt ? now - issuedAt : issuedAt - now;
    if (skew > PRIVATE_CREDENTIAL_CLAIM_WINDOW_SECONDS) fail("CLAIM_STALE");
    return Object.freeze({
        account,
        chainId: allowlist.chainId,
        factory,
        gate,
        issuedAt: issuedAt.toString(),
        signature: value.signature,
    });
}

export function recoverPrivateCredentialClaimSigner(claim) {
    let signer;
    try {
        signer = verifyTypedData(
            privateCredentialClaimDomain(claim),
            PRIVATE_CREDENTIAL_CLAIM_TYPES,
            {
                account: claim.account,
                factory: claim.factory,
                issuedAt: claim.issuedAt,
            },
            claim.signature,
        );
    } catch {
        fail("SIGNATURE_INVALID", 401);
    }
    return address(signer, "SIGNATURE_INVALID", 401);
}

function observedUint(value, code = "CHAIN_UNAVAILABLE") {
    try {
        const parsed = BigInt(value);
        if (parsed < 0n) throw new Error();
        return parsed;
    } catch {
        fail(code, 503);
    }
}

export class PrivateCredentialController {
    constructor({
        registry,
        gate,
        allowlist,
        storePath,
        nowSeconds = () => BigInt(Math.floor(Date.now() / 1_000)),
    }) {
        if (
            registry === null
            || typeof registry !== "object"
            || typeof registry.currentEpoch !== "function"
            || typeof registry.getKycStatus !== "function"
            || gate === null
            || typeof gate !== "object"
            || typeof gate.sessionRootForEpoch !== "function"
            || typeof storePath !== "string"
            || storePath.length === 0
            || typeof nowSeconds !== "function"
        ) {
            fail("CONTROLLER_CONFIG_INVALID", 500);
        }
        this.registry = registry;
        this.gate = gate;
        this.allowlist = normalizePrivateCredentialAllowlist(allowlist);
        this.storePath = storePath;
        this.nowSeconds = nowSeconds;
        this.queue = Promise.resolve();
    }

    async initialize() {
        await this.#store();
    }

    async handle(body) {
        const claim = normalizePrivateCredentialClaim(
            body,
            this.allowlist,
            this.nowSeconds(),
        );
        if (recoverPrivateCredentialClaimSigner(claim) !== claim.account) {
            fail("SIGNATURE_INVALID", 401);
        }
        return this.#enqueue(() => this.#claim(claim.account));
    }

    #enqueue(task) {
        const run = this.queue.then(task, task);
        this.queue = run.then(() => {}, () => {});
        return run;
    }

    async #store() {
        try {
            return await readPrivateCredentialStore(this.storePath);
        } catch (error) {
            if (error instanceof PrivateCredentialStoreError) {
                fail(error.code, error.status);
            }
            fail("CREDENTIAL_STORE_UNAVAILABLE", 503);
        }
    }

    async #chain(account) {
        let epoch;
        let status;
        let root;
        try {
            [epoch, status] = await Promise.all([
                this.registry.currentEpoch(),
                this.registry.getKycStatus(account),
            ]);
            root = await this.gate.sessionRootForEpoch(observedUint(epoch));
        } catch (error) {
            if (error instanceof PrivateCredentialControllerError) throw error;
            fail("CHAIN_UNAVAILABLE", 503);
        }
        return Object.freeze({
            granted: observedUint(status) === 1n,
            root: observedUint(root).toString(),
        });
    }

    async #claim(account) {
        const chain = await this.#chain(account);
        const store = await this.#store();
        if (selectPrivateCredentialTree(store, chain.root) === null) {
            fail("ROOT_NOT_ACTIVE", 409);
        }
        const existing = boundPrivateCredential(store, chain.root, account);
        if (existing !== null) {
            return Object.freeze({credential: {...existing, wallet: account}});
        }
        if (!chain.granted) fail("NOT_ELIGIBLE", 403);
        let bound;
        try {
            bound = bindPrivateCredential(
                store,
                chain.root,
                account,
                new Date(Number(this.nowSeconds()) * 1_000).toISOString(),
            );
            await writePrivateCredentialStore(this.storePath, bound.store);
        } catch (error) {
            if (error instanceof PrivateCredentialStoreError) {
                fail(error.code, error.status);
            }
            fail("CREDENTIAL_STORE_UNAVAILABLE", 503);
        }
        return Object.freeze({credential: {...bound.credential, wallet: account}});
    }
}
