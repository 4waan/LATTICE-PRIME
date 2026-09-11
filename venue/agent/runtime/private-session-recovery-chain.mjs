import {createHash} from "node:crypto";

import {
    Contract,
    Interface,
    Transaction,
    Wallet,
    getAddress,
    keccak256,
    recoverAddress,
} from "ethers";

import {
    PRIVATE_SESSION_RECOVERY_CHAIN_ID,
    PrivateSessionRecoveryError,
    normalizePrivateSessionRecoveryAllowlist,
    normalizePrivateSessionRecoveryRequest,
    privateSessionRecoveryFail,
} from "./private-session-recovery-controller.mjs";
import {privateRelayHandle} from "./private-relay-store.mjs";

export const PRIVATE_SESSION_RECOVERY_ACCOUNT_ABI = Object.freeze([
    "function recoverySigner() view returns (address)",
    "function router() view returns (address)",
    "function security() view returns (address)",
    "function generation() view returns (uint64)",
    "function recoveryNonce() view returns (uint256)",
    "function recoveryAuthorizationDigest(address asset,uint256 amount,uint256 noteCommitment,uint256 nonce) view returns (bytes32)",
    "function recoverToRouter(address asset,uint256 amount,uint256 noteCommitment,uint256 nonce,bytes signature)",
]);
export const PRIVATE_SESSION_RECOVERY_FACTORY_ABI = Object.freeze([
    "function isSessionAccount(address account) view returns (bool)",
    "function deployedCodeHash(address account) view returns (bytes32)",
]);
export const PRIVATE_SESSION_RECOVERY_ROUTER_ABI = Object.freeze([
    "function factory() view returns (address)",
    "function security() view returns (address)",
    "function hbarPool() view returns (address)",
    "function lprcPool() view returns (address)",
]);
export const PRIVATE_SESSION_RECOVERY_POOL_ABI = Object.freeze([
    "function asset() view returns (address)",
    "function denomination() view returns (uint256)",
    "function commitmentSeen(uint256 commitment) view returns (bool)",
]);
export const PRIVATE_SESSION_RECOVERY_GAS_LIMIT = 4_500_000n;
export const PRIVATE_SESSION_RECOVERY_GAS_LIMIT_CAP = 5_000_000n;

const ACCOUNT_INTERFACE = new Interface(PRIVATE_SESSION_RECOVERY_ACCOUNT_ABI);
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const UINT256_LIMIT = 1n << 256n;

function fail(code, status = 400) {
    privateSessionRecoveryFail(code, status);
}

function wrap(error, fallback, status = 500) {
    if (error instanceof PrivateSessionRecoveryError) throw error;
    fail(fallback, status);
}

function address(value, code = "RECOVERY_CHAIN_OBSERVATION_INVALID") {
    try {
        const normalized = getAddress(value).toLowerCase();
        if (!ADDRESS.test(normalized)) throw new Error();
        return normalized;
    } catch {
        fail(code, 503);
    }
}

function bytes32(value, code = "RECOVERY_CHAIN_OBSERVATION_INVALID") {
    if (typeof value !== "string" || !BYTES32.test(value.toLowerCase())) {
        fail(code, 503);
    }
    return value.toLowerCase();
}

function uint(value, limit = UINT256_LIMIT) {
    let parsed;
    try {
        parsed = BigInt(value);
    } catch {
        fail("RECOVERY_CHAIN_OBSERVATION_INVALID", 503);
    }
    if (parsed < 0n || parsed >= limit) {
        fail("RECOVERY_CHAIN_OBSERVATION_INVALID", 503);
    }
    return parsed;
}

function bool(value) {
    if (value !== true && value !== false) {
        fail("RECOVERY_CHAIN_OBSERVATION_INVALID", 503);
    }
    return value;
}

function deployedCode(value) {
    if (
        typeof value !== "string"
        || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)
    ) {
        fail("RECOVERY_REQUIRED_CODE_MISSING", 503);
    }
    return value;
}

function configInteger(value, {nonzero = false, code} = {}) {
    let parsed;
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
        parsed = BigInt(value);
    } catch {
        fail(code ?? "RECOVERY_CHAIN_CONFIG_INVALID", 500);
    }
    if (
        parsed < 0n
        || parsed >= UINT256_LIMIT
        || (nonzero && parsed === 0n)
    ) {
        fail(code ?? "RECOVERY_CHAIN_CONFIG_INVALID", 500);
    }
    return parsed;
}

function sha256(value) {
    return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function receiptStatus(receipt) {
    if (receipt === null) return null;
    const status = uint(receipt.status, 2n);
    return status === 1n ? "CONFIRMED" : "REJECTED";
}

export function loadPrivateSessionRecoveryRelayerKey(env = process.env) {
    const value = env?.PRIVATE_TRADING_RELAYER_KEY;
    if (!PRIVATE_KEY.test(value ?? "")) {
        fail("RECOVERY_RELAYER_KEY_REQUIRED", 500);
    }
    try {
        new Wallet(value);
    } catch {
        fail("RECOVERY_RELAYER_KEY_INVALID", 500);
    }
    return value;
}

export class EthersPrivateSessionRecoveryAdapter {
    constructor({
        provider,
        env = process.env,
        allowlist,
        transactionStore,
        maxGasPriceWei,
        relayerReserveWei,
        gasLimit = PRIVATE_SESSION_RECOVERY_GAS_LIMIT,
        confirmations = 1,
        transactionTimeoutMilliseconds = 120_000,
        factoryContract = null,
        routerContract = null,
        poolContracts = null,
        sessionContractFactory = null,
    }) {
        if (
            typeof provider?.getNetwork !== "function"
            || typeof provider?.send !== "function"
            || typeof provider?.getBlock !== "function"
            || typeof provider?.getCode !== "function"
            || typeof provider?.call !== "function"
            || typeof provider?.getFeeData !== "function"
            || typeof provider?.getBalance !== "function"
            || typeof provider?.getTransactionCount !== "function"
            || typeof provider?.getTransactionReceipt !== "function"
            || typeof provider?.getTransaction !== "function"
            || typeof provider?.broadcastTransaction !== "function"
            || typeof transactionStore?.prepareRedacted !== "function"
            || typeof transactionStore?.readIfPresent !== "function"
        ) {
            fail("RECOVERY_CHAIN_CONFIG_INVALID", 500);
        }
        if (
            !Number.isSafeInteger(confirmations)
            || confirmations < 1
            || confirmations > 20
            || !Number.isSafeInteger(transactionTimeoutMilliseconds)
            || transactionTimeoutMilliseconds < 1_000
        ) {
            fail("RECOVERY_CHAIN_CONFIG_INVALID", 500);
        }
        this.provider = provider;
        this.allowlist = normalizePrivateSessionRecoveryAllowlist(allowlist);
        this.transactionStore = transactionStore;
        this.maxGasPriceWei = configInteger(maxGasPriceWei, {
            nonzero: true,
            code: "RECOVERY_GAS_POLICY_INVALID",
        });
        this.relayerReserveWei = configInteger(relayerReserveWei, {
            code: "RECOVERY_RELAYER_RESERVE_INVALID",
        });
        this.gasLimit = configInteger(gasLimit, {
            nonzero: true,
            code: "RECOVERY_GAS_POLICY_INVALID",
        });
        if (this.gasLimit > PRIVATE_SESSION_RECOVERY_GAS_LIMIT_CAP) {
            fail("RECOVERY_GAS_LIMIT_CAP_EXCEEDED", 500);
        }
        this.confirmations = confirmations;
        this.transactionTimeoutMilliseconds = transactionTimeoutMilliseconds;
        this.signer = new Wallet(loadPrivateSessionRecoveryRelayerKey(env));
        this.factory = factoryContract ?? new Contract(
            this.allowlist.factory,
            PRIVATE_SESSION_RECOVERY_FACTORY_ABI,
            provider,
        );
        this.router = routerContract ?? new Contract(
            this.allowlist.router,
            PRIVATE_SESSION_RECOVERY_ROUTER_ABI,
            provider,
        );
        this.pools = poolContracts ?? Object.freeze({
            HBAR: new Contract(
                this.allowlist.pools.HBAR.address,
                PRIVATE_SESSION_RECOVERY_POOL_ABI,
                provider,
            ),
            LPRC: new Contract(
                this.allowlist.pools.LPRC.address,
                PRIVATE_SESSION_RECOVERY_POOL_ABI,
                provider,
            ),
        });
        this.sessionContractFactory = sessionContractFactory
            ?? ((account) => new Contract(
                account,
                PRIVATE_SESSION_RECOVERY_ACCOUNT_ABI,
                provider,
            ));
        this.#validateContracts();
        this.initialization = null;
        this.relayerAddress = null;
        this.inFlight = new Map();
    }

    #validateContracts() {
        const required = [
            [this.factory, ["isSessionAccount", "deployedCodeHash"]],
            [this.router, ["factory", "security", "hbarPool", "lprcPool"]],
            [this.pools?.HBAR, ["asset", "denomination", "commitmentSeen"]],
            [this.pools?.LPRC, ["asset", "denomination", "commitmentSeen"]],
        ];
        if (
            typeof this.sessionContractFactory !== "function"
            || required.some(([contract, methods]) =>
                methods.some((method) => typeof contract?.[method] !== "function"))
        ) {
            fail("RECOVERY_CHAIN_CONFIG_INVALID", 500);
        }
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

    async #initialize() {
        let values;
        try {
            values = await Promise.all([
                this.provider.getNetwork(),
                this.provider.send("eth_chainId", []),
                this.signer.getAddress(),
                typeof this.transactionStore.initialize === "function"
                    ? this.transactionStore.initialize()
                    : Promise.resolve(),
            ]);
        } catch (error) {
            wrap(error, "RECOVERY_INITIALIZATION_FAILED", 503);
        }
        if (
            uint(values[0]?.chainId) !== PRIVATE_SESSION_RECOVERY_CHAIN_ID
            || uint(values[1]) !== PRIVATE_SESSION_RECOVERY_CHAIN_ID
        ) {
            fail("RECOVERY_CHAIN_MISMATCH", 503);
        }
        this.relayerAddress = address(
            values[2],
            "RECOVERY_RELAYER_ADDRESS_INVALID",
        );
        return Object.freeze({
            chainId: PRIVATE_SESSION_RECOVERY_CHAIN_ID.toString(),
            relayer: this.relayerAddress,
        });
    }

    async relayRecovery(value) {
        const request = normalizePrivateSessionRecoveryRequest(value);
        const id = createHash("sha256")
            .update(`${request.account}:${request.nonce}`)
            .digest("hex");
        const fingerprint = sha256(JSON.stringify(request));
        const active = this.inFlight.get(id);
        if (active !== undefined) {
            if (active.fingerprint !== fingerprint) {
                fail("RECOVERY_IN_FLIGHT", 409);
            }
            return active.promise;
        }
        const promise = this.#execute(request, id);
        this.inFlight.set(id, {fingerprint, promise});
        try {
            return await promise;
        } finally {
            if (this.inFlight.get(id)?.promise === promise) {
                this.inFlight.delete(id);
            }
        }
    }

    async #execute(request, id) {
        await this.initialize();
        const policy = this.#policy(request, id);
        const handle = privateRelayHandle("recovery", id);
        let record = await this.transactionStore.readIfPresent(handle);
        const before = await this.#readPinned(request);

        if (before.status === "CONFIRMED") {
            if (record === null) {
                fail("RECOVERY_RECEIPT_UNAVAILABLE", 409);
            }
            await this.#reconstruct(record, request, policy);
            const outcome = await this.#transactionOutcome(
                record.metadata.transactionHash,
            );
            if (outcome.receiptStatus !== "CONFIRMED") {
                fail("RECOVERY_RECEIPT_UNAVAILABLE", 503);
            }
            return Object.freeze({
                status: "CONFIRMED",
                txHash: record.metadata.transactionHash,
            });
        }

        let raw;
        if (record !== null) {
            raw = await this.#reconstruct(record, request, policy);
            const outcome = await this.#transactionOutcome(
                record.metadata.transactionHash,
            );
            if (outcome.receiptStatus === "REJECTED") {
                fail("RECOVERY_TRANSACTION_REJECTED", 409);
            }
            if (outcome.receiptStatus === "CONFIRMED") {
                fail("RECOVERY_STATE_UNCONFIRMED", 503);
            }
            if (outcome.pending) fail("RECOVERY_TRANSACTION_PENDING", 409);
        }

        await this.#preflight(policy, before.blockNumber);
        if (record === null) {
            const relay = await this.#relayState(
                before.blockNumber,
                policy.gasLimit,
            );
            record = await this.transactionStore.prepareRedacted({
                handle,
                minimumNonce: relay.nonce,
                build: async (reservedNonce) => {
                    const materialized = await this.#materialize(
                        request,
                        policy,
                        relay.gasPrice,
                        reservedNonce,
                    );
                    raw = materialized.raw;
                    return {
                        kind: "recovery",
                        context: policy.context,
                        from: this.relayerAddress,
                        to: request.account,
                        gasPrice: relay.gasPrice.toString(),
                        gasLimit: policy.gasLimit.toString(),
                        transactionHash: materialized.transactionHash,
                        byteDigest: materialized.byteDigest,
                        calldataDigest: materialized.calldataDigest,
                        calldataBytes: materialized.calldataBytes,
                        signedTransactionBytes:
                            materialized.signedTransactionBytes,
                        simulationBlock: before.blockNumber,
                    };
                },
            });
            raw ??= await this.#reconstruct(record, request, policy);
        }
        const broadcastBlock = await this.#latestBlock();
        await this.#requireRelayerBalance(
            broadcastBlock.number,
            BigInt(record.metadata.gasPrice),
            policy.gasLimit,
        );
        return this.#broadcastAndConfirm(record, raw, request);
    }

    #policy(request, id) {
        const pool = this.allowlist.pools[request.asset];
        if (request.amount !== pool.denomination) {
            fail("RECOVERY_AMOUNT_MISMATCH");
        }
        const context = Object.freeze({
            account: request.account,
            amount: request.amount,
            asset: request.asset,
            chainId: request.chainId,
            factory: this.allowlist.factory,
            generation: this.allowlist.generation,
            id,
            nonce: request.nonce,
            pool: pool.address,
            router: this.allowlist.router,
            security: this.allowlist.security,
        });
        let data;
        try {
            data = ACCOUNT_INTERFACE.encodeFunctionData("recoverToRouter", [
                pool.asset,
                request.amount,
                request.noteCommitment,
                request.nonce,
                request.signature,
            ]);
        } catch {
            fail("RECOVERY_CALLDATA_INVALID");
        }
        return Object.freeze({
            context,
            data,
            gasLimit: this.gasLimit,
            pool,
        });
    }

    async #latestBlock() {
        let block;
        try {
            block = await this.provider.getBlock("latest");
        } catch {
            fail("RECOVERY_CHAIN_UNAVAILABLE", 503);
        }
        if (
            block === null
            || !Number.isSafeInteger(block.number)
            || block.number < 0
        ) {
            fail("RECOVERY_CHAIN_OBSERVATION_INVALID", 503);
        }
        return block;
    }

    async #readPinned(request) {
        const block = await this.#latestBlock();
        const atBlock = {blockTag: block.number};
        const poolConfig = this.allowlist.pools[request.asset];
        const pool = this.pools[request.asset];
        let session;
        try {
            session = this.sessionContractFactory(request.account);
        } catch {
            fail("RECOVERY_CHAIN_CONFIG_INVALID", 500);
        }
        const sessionMethods = [
            "recoverySigner",
            "router",
            "security",
            "generation",
            "recoveryNonce",
            "recoveryAuthorizationDigest",
        ];
        if (sessionMethods.some((method) => typeof session?.[method] !== "function")) {
            fail("RECOVERY_CHAIN_CONFIG_INVALID", 500);
        }
        let observed;
        try {
            observed = await Promise.all([
                this.provider.getCode(this.allowlist.factory, block.number),
                this.provider.getCode(this.allowlist.router, block.number),
                this.provider.getCode(this.allowlist.security, block.number),
                this.provider.getCode(this.allowlist.pools.HBAR.address, block.number),
                this.provider.getCode(this.allowlist.pools.LPRC.address, block.number),
                this.provider.getCode(request.account, block.number),
                this.factory.isSessionAccount(request.account, atBlock),
                this.factory.deployedCodeHash(request.account, atBlock),
                session.recoverySigner(atBlock),
                session.router(atBlock),
                session.security(atBlock),
                session.generation(atBlock),
                session.recoveryNonce(atBlock),
                session.recoveryAuthorizationDigest(
                    poolConfig.asset,
                    request.amount,
                    request.noteCommitment,
                    request.nonce,
                    atBlock,
                ),
                pool.asset(atBlock),
                pool.denomination(atBlock),
                pool.commitmentSeen(request.noteCommitment, atBlock),
                this.router.factory(atBlock),
                this.router.security(atBlock),
                this.router.hbarPool(atBlock),
                this.router.lprcPool(atBlock),
            ]);
        } catch (error) {
            wrap(error, "RECOVERY_CHAIN_UNAVAILABLE", 503);
        }
        const code = observed.slice(0, 6).map(deployedCode);
        const recordedCodeHash = bytes32(observed[7]);
        if (
            !bool(observed[6])
            || recordedCodeHash === ZERO_BYTES32
            || recordedCodeHash !== keccak256(code[5])
        ) {
            fail("RECOVERY_SESSION_NOT_CANONICAL");
        }
        const recoverySigner = address(observed[8]);
        if (
            address(observed[9]) !== this.allowlist.router
            || address(observed[10]) !== this.allowlist.security
            || uint(observed[11], 1n << 64n).toString()
                !== this.allowlist.generation
            || address(observed[14]) !== poolConfig.asset
            || uint(observed[15]).toString() !== poolConfig.denomination
            || address(observed[17]) !== this.allowlist.factory
            || address(observed[18]) !== this.allowlist.security
            || address(observed[19]) !== this.allowlist.pools.HBAR.address
            || address(observed[20]) !== this.allowlist.pools.LPRC.address
        ) {
            fail("RECOVERY_POLICY_CONTEXT_MISMATCH");
        }
        const digest = bytes32(observed[13]);
        try {
            if (address(recoverAddress(digest, request.signature))
                !== recoverySigner) {
                fail("RECOVERY_SIGNATURE_INVALID");
            }
        } catch (error) {
            wrap(error, "RECOVERY_SIGNATURE_INVALID");
        }
        const currentNonce = uint(observed[12]);
        const requestedNonce = BigInt(request.nonce);
        const commitmentSeen = bool(observed[16]);
        let status;
        if (currentNonce === requestedNonce && !commitmentSeen) {
            status = "AVAILABLE";
        } else if (
            currentNonce === requestedNonce + 1n
            && commitmentSeen
        ) {
            status = "CONFIRMED";
        } else {
            fail("RECOVERY_STATE_MISMATCH", 409);
        }
        return Object.freeze({blockNumber: block.number, status});
    }

    async #preflight(policy, blockNumber) {
        try {
            await this.provider.call({
                from: this.relayerAddress,
                to: policy.context.account,
                value: 0n,
                data: policy.data,
                gasLimit: policy.gasLimit,
                blockTag: blockNumber,
            });
        } catch {
            fail("RECOVERY_PREFLIGHT_REFUSED");
        }
    }

    async #relayState(blockNumber, gasLimit) {
        let values;
        try {
            values = await Promise.all([
                this.provider.getTransactionCount(
                    this.relayerAddress,
                    "pending",
                ),
                this.provider.getFeeData(),
                this.provider.getBalance(this.relayerAddress, blockNumber),
            ]);
        } catch {
            fail("RECOVERY_RELAYER_STATE_UNAVAILABLE", 503);
        }
        if (!Number.isSafeInteger(values[0]) || values[0] < 0) {
            fail("RECOVERY_RELAYER_NONCE_INVALID", 503);
        }
        const gasPrice = configInteger(
            values[1]?.gasPrice ?? values[1]?.maxFeePerGas,
            {nonzero: true, code: "RECOVERY_GAS_PRICE_UNAVAILABLE"},
        );
        if (gasPrice > this.maxGasPriceWei) {
            fail("RECOVERY_GAS_PRICE_CAP_EXCEEDED", 503);
        }
        const balance = uint(values[2]);
        this.#assertRelayerBalance(balance, gasPrice, gasLimit);
        return Object.freeze({nonce: values[0], gasPrice});
    }

    async #requireRelayerBalance(blockNumber, gasPrice, gasLimit) {
        let balance;
        try {
            balance = uint(await this.provider.getBalance(
                this.relayerAddress,
                blockNumber,
            ));
        } catch (error) {
            wrap(error, "RECOVERY_RELAYER_STATE_UNAVAILABLE", 503);
        }
        this.#assertRelayerBalance(balance, gasPrice, gasLimit);
    }

    #assertRelayerBalance(balance, gasPrice, gasLimit) {
        const required = this.relayerReserveWei + gasLimit * gasPrice;
        if (required >= UINT256_LIMIT || balance < required) {
            fail("RECOVERY_RELAYER_BALANCE_TOO_LOW", 503);
        }
    }

    async #materialize(request, policy, gasPrice, nonce) {
        let raw;
        try {
            raw = await this.signer.signTransaction({
                type: 0,
                chainId: PRIVATE_SESSION_RECOVERY_CHAIN_ID,
                nonce,
                to: request.account,
                value: 0n,
                data: policy.data,
                gasLimit: policy.gasLimit,
                gasPrice,
            });
        } catch {
            fail("RECOVERY_TRANSACTION_SIGNING_FAILED", 500);
        }
        let transaction;
        try {
            transaction = Transaction.from(raw);
        } catch {
            fail("RECOVERY_SIGNED_TRANSACTION_INVALID", 500);
        }
        if (
            address(transaction.from, "RECOVERY_SIGNED_TRANSACTION_INVALID")
                !== this.relayerAddress
            || address(transaction.to, "RECOVERY_SIGNED_TRANSACTION_INVALID")
                !== request.account
            || transaction.type !== 0
            || transaction.chainId !== PRIVATE_SESSION_RECOVERY_CHAIN_ID
            || transaction.nonce !== nonce
            || transaction.value !== 0n
            || transaction.data.toLowerCase() !== policy.data.toLowerCase()
            || transaction.gasLimit !== policy.gasLimit
            || transaction.gasPrice !== gasPrice
            || policy.gasLimit > PRIVATE_SESSION_RECOVERY_GAS_LIMIT_CAP
        ) {
            fail("RECOVERY_SIGNED_TRANSACTION_INVALID", 500);
        }
        const calldata = Buffer.from(policy.data.slice(2), "hex");
        const signed = Buffer.from(raw.slice(2), "hex");
        try {
            return Object.freeze({
                raw,
                transactionHash: bytes32(
                    transaction.hash,
                    "RECOVERY_SIGNED_TRANSACTION_INVALID",
                ),
                calldataDigest: sha256(calldata),
                byteDigest: sha256(signed),
                calldataBytes: calldata.length,
                signedTransactionBytes: signed.length,
            });
        } finally {
            calldata.fill(0);
            signed.fill(0);
        }
    }

    async #reconstruct(record, request, policy) {
        const metadata = record?.metadata;
        if (
            metadata?.kind !== "recovery"
            || metadata.handle
                !== privateRelayHandle("recovery", policy.context.id)
            || JSON.stringify(metadata.context)
                !== JSON.stringify(policy.context)
            || metadata.from !== this.relayerAddress
            || metadata.to !== request.account
            || metadata.chainId
                !== PRIVATE_SESSION_RECOVERY_CHAIN_ID.toString()
            || metadata.gasLimit !== policy.gasLimit.toString()
            || BigInt(metadata.gasPrice ?? 0) > this.maxGasPriceWei
            || record.calldata !== null
            || record.signedTransaction !== null
        ) {
            fail("RECOVERY_PREPARED_TRANSACTION_MISMATCH", 500);
        }
        const materialized = await this.#materialize(
            request,
            policy,
            BigInt(metadata.gasPrice),
            metadata.nonce,
        );
        if (
            materialized.transactionHash !== metadata.transactionHash
            || materialized.byteDigest !== metadata.byteDigest
            || materialized.calldataDigest !== metadata.calldataDigest
            || materialized.calldataBytes !== metadata.calldataBytes
            || materialized.signedTransactionBytes
                !== metadata.signedTransactionBytes
        ) {
            fail("RECOVERY_PREPARED_TRANSACTION_MISMATCH", 500);
        }
        return materialized.raw;
    }

    async #transactionOutcome(hash) {
        const results = await Promise.allSettled([
            this.provider.getTransactionReceipt(hash),
            this.provider.getTransaction(hash),
        ]);
        if (results.some((result) => result.status !== "fulfilled")) {
            fail("RECOVERY_RECONCILIATION_FAILED", 503);
        }
        const receipt = results[0].value;
        const pending = results[1].value;
        if (
            receipt !== null
            && bytes32(
                receipt.hash ?? receipt.transactionHash,
                "RECOVERY_RECEIPT_INVALID",
            ) !== hash
        ) {
            fail("RECOVERY_RECEIPT_INVALID", 502);
        }
        if (
            pending !== null
            && bytes32(pending.hash, "RECOVERY_PENDING_TRANSACTION_INVALID")
                !== hash
        ) {
            fail("RECOVERY_PENDING_TRANSACTION_INVALID", 502);
        }
        return Object.freeze({
            receiptStatus: receiptStatus(receipt),
            pending: pending !== null,
        });
    }

    async #broadcastAndConfirm(record, raw, request) {
        const txHash = record.metadata.transactionHash;
        let response = null;
        try {
            response = await this.provider.broadcastTransaction(raw);
        } catch {
            // Receipt and pinned chain state below decide the public result.
        }
        if (
            response?.hash !== undefined
            && bytes32(response.hash, "RECOVERY_BROADCAST_HASH_MISMATCH")
                !== txHash
        ) {
            fail("RECOVERY_BROADCAST_HASH_MISMATCH", 502);
        }
        if (typeof response?.wait === "function") {
            try {
                await response.wait(
                    this.confirmations,
                    this.transactionTimeoutMilliseconds,
                );
            } catch {
                // Receipt and pinned chain state below remain authoritative.
            }
        }
        const [outcome, state] = await Promise.all([
            this.#transactionOutcome(txHash),
            this.#readPinned(request),
        ]);
        if (
            outcome.receiptStatus === "CONFIRMED"
            && state.status === "CONFIRMED"
        ) {
            return Object.freeze({status: "CONFIRMED", txHash});
        }
        if (outcome.receiptStatus === "REJECTED") {
            fail("RECOVERY_TRANSACTION_REJECTED", 409);
        }
        if (outcome.pending) fail("RECOVERY_TRANSACTION_PENDING", 409);
        fail("RECOVERY_OUTCOME_UNKNOWN", 503);
    }
}
