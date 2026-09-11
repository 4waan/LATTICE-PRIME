import {
    AbiCoder,
    Contract,
    Interface,
    JsonRpcProvider,
    Transaction,
    Wallet,
    getAddress,
    keccak256,
    toBeHex,
} from "ethers";

import {
    PRIVATE_SESSION_REGISTRATION_CHAIN_ID,
    PrivateSessionRegistrationError,
    normalizePrivateSessionRegistrationAllowlist,
    normalizePrivateSessionRegistrationRequest,
    privateSessionRegistrationFail,
    privateSessionRegistrationRequestDigest,
} from "./private-session-registration-controller.mjs";
import {privateRelayHandle} from "./private-relay-store.mjs";

const CONFIG_TUPLE =
    "(address sessionSigner,address recoverySigner,address engine,address security,"
    + "bytes32 partition,address router,bytes32 quicknetChainHash,uint64 generation,"
    + "bytes32 feePolicyDigest)";
const CIPHERTEXT_TUPLE =
    "(uint256 encryptedCredential,uint256 tag,uint256 ephemeralX,uint256 ephemeralY)";

export const PRIVATE_SESSION_REGISTRATION_FACTORY_ABI = Object.freeze([
    "function creationCodeHash() pure returns (bytes32)",
    `function accountAddress(${CONFIG_TUPLE} config,bytes32 salt) view returns (address)`,
    `function accountVenueConfigDigest(${CONFIG_TUPLE} config) pure returns (bytes32)`,
    "function approvedVenueConfig(bytes32 digest) view returns (bool)",
    `function isCanonical(address account,${CONFIG_TUPLE} config,bytes32 salt) view returns (bool)`,
    "function isSessionAccount(address account) view returns (bool)",
    "function deployedCodeHash(address account) view returns (bytes32)",
    `function deployAndRegister(${CONFIG_TUPLE} config,bytes32 salt,address hook,bytes registrationData) payable returns (address account)`,
]);

export const PRIVATE_SESSION_REGISTRATION_GATE_ABI = Object.freeze([
    "function registry() view returns (address)",
    "function sessionFactory() view returns (address)",
    "function sessionImplementationCodeHash() view returns (bytes32)",
    "function sessionRootForEpoch(uint64 epoch) view returns (uint256)",
    "function viewKeyEpochForRotationEpoch(uint64 epoch) view returns (uint64)",
    "function viewKeyForEpoch(uint64 epoch) view returns (uint256 x,uint256 y,bool published)",
    "function sessionImplementationCodeHashLow() view returns (uint256)",
    "function sessionImplementationCodeHashHigh() view returns (uint256)",
    "function minTier() view returns (uint256)",
    "function jurisdictionMask() view returns (uint256)",
    "function sessionSlotUsed(bytes32 slot) view returns (bool)",
    `function registerSession(address account,${CIPHERTEXT_TUPLE} ciphertext,uint256[24] eligibilityProof,uint256[12] eligibilityPublicSignals,uint256[24] complianceProof,uint256[17] compliancePublicSignals)`,
]);

export const PRIVATE_SESSION_REGISTRATION_REGISTRY_ABI = Object.freeze([
    "function gate() view returns (address)",
    "function pendingGate() view returns (address)",
    "function currentEpoch() view returns (uint64)",
    "function getKycStatus(address account) view returns (uint8)",
    "function usesThisEpoch(bytes32 nullifier) view returns (uint16)",
]);

export const PRIVATE_SESSION_REGISTRATION_ACCOUNT_ABI = Object.freeze([
    "function sessionSigner() view returns (address)",
    "function recoverySigner() view returns (address)",
    "function engine() view returns (address)",
    "function security() view returns (address)",
    "function partition() view returns (bytes32)",
    "function router() view returns (address)",
    "function quicknetChainHash() view returns (bytes32)",
    "function generation() view returns (uint64)",
    "function feePolicyDigest() view returns (bytes32)",
]);

export const PRIVATE_SESSION_REGISTRATION_GAS_LIMIT_CAPS = Object.freeze({
    deployAndRegister: 6_000_000n,
    register: 4_500_000n,
});

export const PRIVATE_SESSION_REGISTRATION_DEFAULT_GAS_LIMITS = Object.freeze({
    deployAndRegister: 5_500_000n,
    register: 4_000_000n,
});

const FACTORY_INTERFACE = new Interface(
    PRIVATE_SESSION_REGISTRATION_FACTORY_ABI,
);
const GATE_INTERFACE = new Interface(PRIVATE_SESSION_REGISTRATION_GATE_ABI);
const REGISTRATION_CODER = AbiCoder.defaultAbiCoder();
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const SIGNED_TRANSACTION = /^0x(?:[0-9a-fA-F]{2})+$/;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const UINT64_LIMIT = 1n << 64n;

function fail(code, status = 400) {
    privateSessionRegistrationFail(code, status);
}

function wrap(error, fallback, status = 500) {
    if (error instanceof PrivateSessionRegistrationError) throw error;
    fail(fallback, status);
}

function exactObject(value, keys, code) {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
    ) {
        fail(code, 500);
    }
}

function address(value, code = "CHAIN_OBSERVATION_INVALID") {
    try {
        const normalized = getAddress(value).toLowerCase();
        if (!ADDRESS.test(normalized)) throw new Error();
        return normalized;
    } catch {
        fail(code, 503);
    }
}

function bytes32(value, code = "CHAIN_OBSERVATION_INVALID") {
    if (typeof value !== "string" || !BYTES32.test(value.toLowerCase())) {
        fail(code, 503);
    }
    return value.toLowerCase();
}

function observedUint(value, limit = 1n << 256n) {
    let parsed;
    try {
        parsed = BigInt(value);
    } catch {
        fail("CHAIN_OBSERVATION_INVALID", 503);
    }
    if (parsed < 0n || parsed >= limit) {
        fail("CHAIN_OBSERVATION_INVALID", 503);
    }
    return parsed;
}

function observedBoolean(value) {
    if (value !== true && value !== false) {
        fail("CHAIN_OBSERVATION_INVALID", 503);
    }
    return value;
}

function deployedCode(value) {
    if (typeof value !== "string") fail("CHAIN_OBSERVATION_INVALID", 503);
    if (value === "0x") return false;
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
        fail("CHAIN_OBSERVATION_INVALID", 503);
    }
    return true;
}

function positiveConfigInteger(value, code) {
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
        fail(code, 500);
    }
    if (parsed <= 0n || parsed >= 1n << 256n) fail(code, 500);
    return parsed;
}

function nonnegativeConfigInteger(value, code) {
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
        fail(code, 500);
    }
    if (parsed < 0n || parsed >= 1n << 256n) fail(code, 500);
    return parsed;
}

function normalizeGasLimits(value) {
    exactObject(
        value,
        ["deployAndRegister", "register"],
        "GAS_POLICY_INVALID",
    );
    const result = Object.freeze({
        deployAndRegister: positiveConfigInteger(
            value.deployAndRegister,
            "GAS_POLICY_INVALID",
        ),
        register: positiveConfigInteger(value.register, "GAS_POLICY_INVALID"),
    });
    for (const kind of Object.keys(result)) {
        if (result[kind] > PRIVATE_SESSION_REGISTRATION_GAS_LIMIT_CAPS[kind]) {
            fail("GAS_LIMIT_CAP_EXCEEDED", 500);
        }
    }
    return result;
}

function rpcEndpoint(value) {
    if (typeof value !== "string") fail("RPC_CONFIG_INVALID", 500);
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        fail("RPC_CONFIG_INVALID", 500);
    }
    if (
        parsed.protocol !== "https:"
        || parsed.username !== ""
        || parsed.password !== ""
        || parsed.hash !== ""
    ) {
        fail("RPC_CONFIG_INVALID", 500);
    }
    return parsed.href;
}

function transactionHash(value, code = "TRANSACTION_HASH_INVALID") {
    if (typeof value !== "string" || !BYTES32.test(value.toLowerCase())) {
        fail(code, 502);
    }
    return value.toLowerCase();
}

function tupleValue(value, key, index) {
    return value?.[key] ?? value?.[index];
}

function receiptStatus(receipt) {
    if (receipt === null) return null;
    const status = observedUint(receipt?.status, 2n);
    return status === 1n ? "CONFIRMED" : "REJECTED";
}

function configValues(request) {
    const config = request.config;
    return [
        config.sessionSigner,
        config.recoverySigner,
        config.engine,
        config.security,
        config.partition,
        config.router,
        config.quicknetChainHash,
        config.generation,
        config.feePolicyDigest,
    ];
}

function ciphertextValues(request) {
    const ciphertext = request.ciphertext;
    return [
        ciphertext.encryptedCredential,
        ciphertext.tag,
        ciphertext.ephemeralX,
        ciphertext.ephemeralY,
    ];
}

export function loadPrivateSessionRegistrationRelayerKey(env = process.env) {
    const value = env?.PRIVATE_TRADING_RELAYER_KEY;
    if (typeof value !== "string" || !PRIVATE_KEY.test(value)) {
        fail("RELAYER_KEY_REQUIRED", 500);
    }
    try {
        new Wallet(value);
    } catch {
        fail("RELAYER_KEY_INVALID", 500);
    }
    return value;
}

export function createPrivateSessionRegistrationRelayerSigner({
    env = process.env,
} = {}) {
    return new Wallet(loadPrivateSessionRegistrationRelayerKey(env));
}

export class EthersPrivateSessionRegistrationAdapter {
    static async open({
        rpcUrl,
        providerOptions = {},
        ...options
    }) {
        const provider = new JsonRpcProvider(
            rpcEndpoint(rpcUrl),
            Number(PRIVATE_SESSION_REGISTRATION_CHAIN_ID),
            {
                ...providerOptions,
                staticNetwork: true,
                batchMaxCount: 20,
            },
        );
        const adapter = new EthersPrivateSessionRegistrationAdapter({
            ...options,
            provider,
            ownsProvider: true,
        });
        try {
            await adapter.initialize();
            return adapter;
        } catch (error) {
            provider.destroy();
            throw error;
        }
    }

    constructor({
        provider,
        env = process.env,
        allowlist,
        transactionStore,
        maxGasPriceWei,
        relayerReserveWei,
        gasLimits = PRIVATE_SESSION_REGISTRATION_DEFAULT_GAS_LIMITS,
        confirmations = 1,
        transactionTimeoutMilliseconds = 120_000,
        factoryContract = null,
        gateContract = null,
        registryContract = null,
        sessionContractFactory = null,
        ownsProvider = false,
    }) {
        if (
            provider === null
            || typeof provider !== "object"
            || typeof provider.getNetwork !== "function"
            || typeof provider.send !== "function"
            || typeof provider.getBlock !== "function"
            || typeof provider.getCode !== "function"
            || typeof provider.call !== "function"
            || typeof provider.getFeeData !== "function"
            || typeof provider.getBalance !== "function"
            || typeof provider.getTransactionCount !== "function"
            || typeof provider.getTransactionReceipt !== "function"
            || typeof provider.getTransaction !== "function"
            || typeof provider.broadcastTransaction !== "function"
            || transactionStore === null
            || typeof transactionStore !== "object"
            || typeof transactionStore.prepare !== "function"
            || typeof transactionStore.readIfPresent !== "function"
        ) {
            fail("CHAIN_ADAPTER_CONFIG_INVALID", 500);
        }
        if (
            !Number.isSafeInteger(confirmations)
            || confirmations < 1
            || confirmations > 20
            || !Number.isSafeInteger(transactionTimeoutMilliseconds)
            || transactionTimeoutMilliseconds < 1_000
        ) {
            fail("CHAIN_ADAPTER_CONFIG_INVALID", 500);
        }

        this.provider = provider;
        this.transactionStore = transactionStore;
        this.allowlist = normalizePrivateSessionRegistrationAllowlist(allowlist);
        this.maxGasPriceWei = positiveConfigInteger(
            maxGasPriceWei,
            "GAS_POLICY_INVALID",
        );
        this.relayerReserveWei = nonnegativeConfigInteger(
            relayerReserveWei,
            "RELAYER_RESERVE_INVALID",
        );
        this.gasLimits = normalizeGasLimits(gasLimits);
        this.signer = createPrivateSessionRegistrationRelayerSigner({env});
        this.confirmations = confirmations;
        this.transactionTimeoutMilliseconds = transactionTimeoutMilliseconds;
        this.factory = factoryContract
            ?? new Contract(
                this.allowlist.factory,
                PRIVATE_SESSION_REGISTRATION_FACTORY_ABI,
                provider,
            );
        this.gate = gateContract
            ?? new Contract(
                this.allowlist.gate,
                PRIVATE_SESSION_REGISTRATION_GATE_ABI,
                provider,
            );
        this.registry = registryContract
            ?? new Contract(
                this.allowlist.registry,
                PRIVATE_SESSION_REGISTRATION_REGISTRY_ABI,
                provider,
            );
        this.sessionContractFactory = sessionContractFactory
            ?? ((account) => new Contract(
                account,
                PRIVATE_SESSION_REGISTRATION_ACCOUNT_ABI,
                provider,
            ));
        this.#validateContracts();

        this.ownsProvider = ownsProvider;
        this.initialization = null;
        this.relayerAddress = null;
        this.inFlight = new Map();
        this.submissionQueue = Promise.resolve();
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

    async relayRegistration(value) {
        const request = normalizePrivateSessionRegistrationRequest(
            value,
            this.allowlist,
        );
        const digest = privateSessionRegistrationRequestDigest(request);
        const active = this.inFlight.get(request.account);
        if (active !== undefined) {
            if (active.digest !== digest) fail("REGISTRATION_IN_FLIGHT", 409);
            return active.promise;
        }

        const promise = this.#serializeSubmission(
            () => this.#execute(request, digest),
        );
        this.inFlight.set(request.account, {digest, promise});
        try {
            return await promise;
        } finally {
            const current = this.inFlight.get(request.account);
            if (current?.promise === promise) this.inFlight.delete(request.account);
        }
    }

    close() {
        if (this.ownsProvider && typeof this.provider.destroy === "function") {
            this.provider.destroy();
        }
    }

    #validateContracts() {
        const required = [
            [this.factory, [
                "creationCodeHash",
                "accountAddress",
                "accountVenueConfigDigest",
                "approvedVenueConfig",
                "isCanonical",
                "isSessionAccount",
                "deployedCodeHash",
            ]],
            [this.gate, [
                "registry",
                "sessionFactory",
                "sessionImplementationCodeHash",
                "sessionRootForEpoch",
                "viewKeyEpochForRotationEpoch",
                "viewKeyForEpoch",
                "sessionImplementationCodeHashLow",
                "sessionImplementationCodeHashHigh",
                "minTier",
                "jurisdictionMask",
                "sessionSlotUsed",
            ]],
            [this.registry, [
                "gate",
                "currentEpoch",
                "getKycStatus",
                "usesThisEpoch",
            ]],
        ];
        if (typeof this.sessionContractFactory !== "function") {
            fail("CHAIN_ADAPTER_CONFIG_INVALID", 500);
        }
        for (const [contract, methods] of required) {
            if (
                contract === null
                || typeof contract !== "object"
                || methods.some((method) => typeof contract[method] !== "function")
            ) {
                fail("CHAIN_ADAPTER_CONFIG_INVALID", 500);
            }
        }
    }

    async #initialize() {
        let network;
        let remoteChainId;
        let relayer;
        try {
            [network, remoteChainId, relayer] = await Promise.all([
                this.provider.getNetwork(),
                this.provider.send("eth_chainId", []),
                this.signer.getAddress(),
                typeof this.transactionStore.initialize === "function"
                    ? this.transactionStore.initialize()
                    : Promise.resolve(),
            ]);
        } catch (error) {
            wrap(error, "RELAYER_INITIALIZATION_FAILED", 503);
        }
        let configured;
        let remote;
        try {
            configured = BigInt(network?.chainId);
            remote = BigInt(remoteChainId);
        } catch {
            fail("CHAIN_MISMATCH", 503);
        }
        if (
            configured !== PRIVATE_SESSION_REGISTRATION_CHAIN_ID
            || remote !== PRIVATE_SESSION_REGISTRATION_CHAIN_ID
        ) {
            fail("CHAIN_MISMATCH", 503);
        }
        this.relayerAddress = address(relayer, "RELAYER_ADDRESS_INVALID");
        let block;
        try {
            block = await this.provider.getBlock("latest");
        } catch {
            fail("CHAIN_UNAVAILABLE", 503);
        }
        if (
            block === null
            || !Number.isSafeInteger(block.number)
            || block.number < 0
        ) {
            fail("CHAIN_OBSERVATION_INVALID", 503);
        }
        const atBlock = {blockTag: block.number};
        let release;
        try {
            release = await Promise.all([
                this.provider.getCode(this.allowlist.factory, block.number),
                this.provider.getCode(this.allowlist.gate, block.number),
                this.provider.getCode(this.allowlist.registry, block.number),
                this.provider.getCode(this.allowlist.engine, block.number),
                this.provider.getCode(this.allowlist.security, block.number),
                this.provider.getCode(this.allowlist.router, block.number),
                this.factory.creationCodeHash(atBlock),
                this.gate.sessionImplementationCodeHash(atBlock),
                this.gate.registry(atBlock),
                this.gate.sessionFactory(atBlock),
                this.registry.gate(atBlock),
                this.registry.pendingGate(atBlock),
            ]);
        } catch (error) {
            wrap(error, "CHAIN_UNAVAILABLE", 503);
        }
        for (const code of release.slice(0, 6)) {
            if (!deployedCode(code)) fail("ALLOWLISTED_CODE_MISSING", 503);
        }
        if (
            bytes32(release[6]) !== this.allowlist.creationCodeHash
            || bytes32(release[7]) !== this.allowlist.creationCodeHash
        ) {
            fail("SESSION_CREATION_CODE_HASH_MISMATCH", 503);
        }
        const activeGate = address(release[10]);
        const pendingGate = address(release[11]);
        if (
            address(release[8]) !== this.allowlist.registry
            || address(release[9]) !== this.allowlist.factory
            || (
                activeGate !== this.allowlist.gate
                && pendingGate !== this.allowlist.gate
            )
        ) {
            fail("CHAIN_WIRING_MISMATCH", 503);
        }
        return Object.freeze({
            chainId: PRIVATE_SESSION_REGISTRATION_CHAIN_ID.toString(),
            relayer: this.relayerAddress,
            observedAtBlock: block.number,
        });
    }

    async #execute(request, digest) {
        await this.initialize();
        const call = this.#buildCall(request);
        const context = this.#registrationContext(request, digest);
        const handle = privateRelayHandle("registration", context.id);
        let record = await this.transactionStore.readIfPresent(handle);
        try {
            if (record !== null) {
                const reconciled = await this.#reconcile(request, {
                    txHash: record.metadata.transactionHash,
                });
                if (reconciled.kind === "CONFIRMED") {
                    return Object.freeze({status: "ALREADY_CONFIRMED"});
                }
                this.#assertStoredRecord(record, context, call);
                if (reconciled.kind !== "ABSENT") {
                    return this.#resultAfterBroadcast(
                        reconciled,
                        record.metadata.transactionHash,
                    );
                }
            }

            const pinned = await this.#readPinned(request);
            if (pinned.kycGranted) {
                this.#requireCanonicalConfirmed(pinned);
                return Object.freeze({status: "ALREADY_CONFIRMED"});
            }
            this.#requireActionState(request, pinned);
            await this.#preflight(call, pinned.blockNumber);

            if (record === null) {
                record = await this.#prepareStored(
                    handle,
                    context,
                    call,
                    pinned.blockNumber,
                );
            }
            const broadcastBlock = await this.#latestBlock();
            await this.#requireRelayerBalance(
                broadcastBlock.number,
                BigInt(record.metadata.gasPrice),
                call.gasLimit,
            );
            return await this.#broadcastStored(request, record);
        } finally {
            record?.calldata?.fill(0);
            record?.signedTransaction?.fill(0);
        }
    }

    async #broadcastStored(request, record) {
        const txHash = record.metadata.transactionHash;
        const raw = `0x${record.signedTransaction.toString("hex")}`;
        let response = null;
        try {
            response = await this.provider.broadcastTransaction(raw);
        } catch {
            const reconciled = await this.#reconcile(request, {txHash});
            return this.#resultAfterBroadcast(reconciled, txHash);
        }
        if (
            response?.hash !== undefined
            && transactionHash(response.hash, "BROADCAST_HASH_MISMATCH")
                !== txHash
        ) {
            fail("BROADCAST_HASH_MISMATCH", 502);
        }
        if (typeof response?.wait === "function") {
            try {
                await response.wait(
                    this.confirmations,
                    this.transactionTimeoutMilliseconds,
                );
            } catch {
                // Receipt and on-chain state below are authoritative.
            }
        }
        const reconciled = await this.#reconcile(request, {txHash});
        return this.#resultAfterBroadcast(reconciled, txHash);
    }

    #resultAfterBroadcast(reconciled, txHash) {
        if (reconciled.kind === "CONFIRMED") {
            return Object.freeze({status: "CONFIRMED", txHash});
        }
        if (reconciled.kind === "REJECTED") {
            return Object.freeze({status: "REJECTED", txHash});
        }
        if (reconciled.kind === "PENDING") {
            return Object.freeze({status: "PENDING", txHash});
        }
        return Object.freeze({status: "UNKNOWN", txHash});
    }

    async #latestBlock() {
        await this.initialize();
        let block;
        try {
            block = await this.provider.getBlock("latest");
        } catch {
            fail("CHAIN_UNAVAILABLE", 503);
        }
        if (
            block === null
            || !Number.isSafeInteger(block.number)
            || block.number < 0
        ) {
            fail("CHAIN_OBSERVATION_INVALID", 503);
        }
        return Object.freeze({number: block.number});
    }

    async #readPinned(request) {
        const block = await this.#latestBlock();
        const atBlock = {blockTag: block.number};
        const signal = request.eligibility.publicSignals;
        const slot = toBeHex(BigInt(signal[0]), 32);
        let primary;
        try {
            primary = await Promise.all([
                this.provider.getCode(request.factory, block.number),
                this.provider.getCode(request.gate, block.number),
                this.provider.getCode(request.registry, block.number),
                this.provider.getCode(request.config.engine, block.number),
                this.provider.getCode(request.config.security, block.number),
                this.provider.getCode(request.config.router, block.number),
                this.provider.getCode(request.account, block.number),
                this.factory.accountAddress(
                    request.config,
                    request.deploymentSalt,
                    atBlock,
                ),
                this.factory.accountVenueConfigDigest(request.config, atBlock),
                this.gate.registry(atBlock),
                this.gate.sessionFactory(atBlock),
                this.registry.gate(atBlock),
                this.registry.currentEpoch(atBlock),
                this.registry.getKycStatus(request.account, atBlock),
            ]);
        } catch (error) {
            wrap(error, "CHAIN_UNAVAILABLE", 503);
        }

        for (const code of primary.slice(0, 6)) {
            if (!deployedCode(code)) fail("ALLOWLISTED_CODE_MISSING", 503);
        }
        const accountDeployed = deployedCode(primary[6]);
        if (address(primary[7]) !== request.account) {
            fail("ACCOUNT_ADDRESS_MISMATCH");
        }
        const venueDigest = bytes32(primary[8]);
        if (
            address(primary[9]) !== request.registry
            || address(primary[10]) !== request.factory
            || address(primary[11]) !== request.gate
        ) {
            fail("CHAIN_WIRING_MISMATCH", 503);
        }
        const epoch = observedUint(primary[12], UINT64_LIMIT);
        const kyc = observedUint(primary[13], 2n);

        let secondary;
        try {
            secondary = await Promise.all([
                this.factory.approvedVenueConfig(venueDigest, atBlock),
                this.gate.sessionRootForEpoch(epoch, atBlock),
                this.gate.viewKeyEpochForRotationEpoch(epoch, atBlock),
                this.gate.sessionImplementationCodeHashLow(atBlock),
                this.gate.sessionImplementationCodeHashHigh(atBlock),
                this.gate.minTier(atBlock),
                this.gate.jurisdictionMask(atBlock),
                this.gate.sessionSlotUsed(slot, atBlock),
                this.registry.usesThisEpoch(slot, atBlock),
                this.factory.isSessionAccount(request.account, atBlock),
                accountDeployed
                    ? this.factory.isCanonical(
                        request.account,
                        request.config,
                        request.deploymentSalt,
                        atBlock,
                    )
                    : Promise.resolve(false),
                this.factory.deployedCodeHash(request.account, atBlock),
            ]);
        } catch (error) {
            wrap(error, "CHAIN_UNAVAILABLE", 503);
        }
        const approved = observedBoolean(secondary[0]);
        const root = observedUint(secondary[1]);
        const viewEpoch = observedUint(secondary[2], UINT64_LIMIT);
        const codeHashLow = observedUint(secondary[3]);
        const codeHashHigh = observedUint(secondary[4]);
        const releasedCreationCodeHash = BigInt(
            this.allowlist.creationCodeHash,
        );
        const releasedCodeHashLow =
            releasedCreationCodeHash & ((1n << 128n) - 1n);
        const releasedCodeHashHigh = releasedCreationCodeHash >> 128n;
        const minTier = observedUint(secondary[5]);
        const jurisdictionMask = observedUint(secondary[6]);
        const slotUsed = observedBoolean(secondary[7]);
        const slotUses = observedUint(secondary[8], 1n << 16n);
        const isSessionAccount = observedBoolean(secondary[9]);
        const factoryCanonical = observedBoolean(secondary[10]);
        const recordedCodeHash = bytes32(secondary[11]);

        let viewKey;
        try {
            viewKey = await this.gate.viewKeyForEpoch(viewEpoch, atBlock);
        } catch (error) {
            wrap(error, "CHAIN_UNAVAILABLE", 503);
        }
        const viewX = observedUint(tupleValue(viewKey, "x", 0));
        const viewY = observedUint(tupleValue(viewKey, "y", 1));
        const viewPublished = observedBoolean(
            tupleValue(viewKey, "published", 2),
        );
        if (
            !approved
            || root.toString() !== signal[3]
            || epoch.toString() !== signal[4]
            || codeHashLow !== releasedCodeHashLow
            || codeHashHigh !== releasedCodeHashHigh
            || codeHashLow.toString() !== signal[8]
            || codeHashHigh.toString() !== signal[9]
            || minTier.toString() !== signal[10]
            || jurisdictionMask.toString() !== signal[11]
            || viewEpoch.toString() !== request.compliance.publicSignals[14]
            || viewX.toString() !== request.compliance.publicSignals[15]
            || viewY.toString() !== request.compliance.publicSignals[16]
            || !viewPublished
        ) {
            fail("PROOF_POLICY_CONTEXT_MISMATCH");
        }

        if (
            !accountDeployed
            && (isSessionAccount || recordedCodeHash !== ZERO_BYTES32)
        ) {
            fail("ACCOUNT_STATE_INVALID", 503);
        }
        let canonical = false;
        if (accountDeployed) {
            const actualCodeHash = keccak256(primary[6]);
            canonical = (
                isSessionAccount
                && factoryCanonical
                && recordedCodeHash !== ZERO_BYTES32
                && recordedCodeHash === actualCodeHash
            );
            if (canonical) await this.#verifySessionConfig(request, atBlock);
        }
        return Object.freeze({
            blockNumber: block.number,
            accountDeployed,
            canonical,
            kycGranted: kyc === 1n,
            slotUsed,
            slotUses,
        });
    }

    async #verifySessionConfig(request, atBlock) {
        let session;
        try {
            session = this.sessionContractFactory(request.account);
        } catch {
            fail("CHAIN_ADAPTER_CONFIG_INVALID", 500);
        }
        const methods = [
            "sessionSigner",
            "recoverySigner",
            "engine",
            "security",
            "partition",
            "router",
            "quicknetChainHash",
            "generation",
            "feePolicyDigest",
        ];
        if (
            session === null
            || typeof session !== "object"
            || methods.some((method) => typeof session[method] !== "function")
        ) {
            fail("CHAIN_ADAPTER_CONFIG_INVALID", 500);
        }
        let observed;
        try {
            observed = await Promise.all(methods.map(
                (method) => session[method](atBlock),
            ));
        } catch (error) {
            wrap(error, "CHAIN_UNAVAILABLE", 503);
        }
        if (
            address(observed[0]) !== request.config.sessionSigner
            || address(observed[1]) !== request.config.recoverySigner
            || address(observed[2]) !== request.config.engine
            || address(observed[3]) !== request.config.security
            || bytes32(observed[4]) !== request.config.partition
            || address(observed[5]) !== request.config.router
            || bytes32(observed[6]) !== request.config.quicknetChainHash
            || observedUint(observed[7], UINT64_LIMIT).toString()
                !== request.config.generation
            || bytes32(observed[8]) !== request.config.feePolicyDigest
        ) {
            fail("SESSION_CONFIG_MISMATCH");
        }
    }

    #requireCanonicalConfirmed(state) {
        if (!state.accountDeployed || !state.canonical) {
            fail("ACCOUNT_NOT_CANONICAL");
        }
    }

    #requireActionState(request, state) {
        if (request.action === "deploy-and-register") {
            if (state.accountDeployed) fail("ACTION_STATE_MISMATCH", 409);
        } else {
            if (!state.accountDeployed) fail("SESSION_CODE_MISSING");
            if (!state.canonical) fail("ACCOUNT_NOT_CANONICAL");
        }
        if (state.slotUsed || state.slotUses !== 0n) {
            fail("SESSION_SLOT_ALREADY_USED", 409);
        }
    }

    #buildCall(request) {
        try {
            if (request.action === "deploy-and-register") {
                const registrationData = REGISTRATION_CODER.encode(
                    [
                        CIPHERTEXT_TUPLE,
                        "uint256[24]",
                        "uint256[12]",
                        "uint256[24]",
                        "uint256[17]",
                    ],
                    [
                        ciphertextValues(request),
                        request.eligibility.proof,
                        request.eligibility.publicSignals,
                        request.compliance.proof,
                        request.compliance.publicSignals,
                    ],
                );
                return Object.freeze({
                    kind: "deployAndRegister",
                    to: request.factory,
                    gasLimit: this.gasLimits.deployAndRegister,
                    data: FACTORY_INTERFACE.encodeFunctionData(
                        "deployAndRegister",
                        [
                            configValues(request),
                            request.deploymentSalt,
                            request.gate,
                            registrationData,
                        ],
                    ),
                });
            }
            return Object.freeze({
                kind: "register",
                to: request.gate,
                gasLimit: this.gasLimits.register,
                data: GATE_INTERFACE.encodeFunctionData("registerSession", [
                    request.account,
                    ciphertextValues(request),
                    request.eligibility.proof,
                    request.eligibility.publicSignals,
                    request.compliance.proof,
                    request.compliance.publicSignals,
                ]),
            });
        } catch {
            fail("CALLDATA_ENCODING_FAILED", 500);
        }
    }

    async #preflight(call, blockNumber) {
        try {
            await this.provider.call({
                from: this.relayerAddress,
                to: call.to,
                value: 0n,
                data: call.data,
                gasLimit: call.gasLimit,
                blockTag: blockNumber,
            });
        } catch {
            fail("PREFLIGHT_REFUSED");
        }
    }

    async #relayState(blockNumber, gasLimit) {
        let nonce;
        let feeData;
        let balance;
        try {
            [nonce, feeData, balance] = await Promise.all([
                this.provider.getTransactionCount(
                    this.relayerAddress,
                    "pending",
                ),
                this.provider.getFeeData(),
                this.provider.getBalance(this.relayerAddress, blockNumber),
            ]);
        } catch {
            fail("RELAYER_STATE_UNAVAILABLE", 503);
        }
        if (!Number.isSafeInteger(nonce) || nonce < 0) {
            fail("RELAYER_NONCE_INVALID", 503);
        }
        const quoted = feeData?.gasPrice ?? feeData?.maxFeePerGas;
        let gasPrice;
        try {
            gasPrice = BigInt(quoted);
        } catch {
            fail("GAS_PRICE_UNAVAILABLE", 503);
        }
        if (gasPrice <= 0n) fail("GAS_PRICE_UNAVAILABLE", 503);
        if (gasPrice > this.maxGasPriceWei) {
            fail("GAS_PRICE_CAP_EXCEEDED", 503);
        }
        this.#assertRelayerBalance(observedUint(balance), gasPrice, gasLimit);
        return Object.freeze({nonce, gasPrice});
    }

    async #requireRelayerBalance(blockNumber, gasPrice, gasLimit) {
        let balance;
        try {
            balance = observedUint(await this.provider.getBalance(
                this.relayerAddress,
                blockNumber,
            ));
        } catch (error) {
            wrap(error, "RELAYER_BALANCE_UNAVAILABLE", 503);
        }
        this.#assertRelayerBalance(balance, gasPrice, gasLimit);
    }

    #assertRelayerBalance(balance, gasPrice, gasLimit) {
        const required = this.relayerReserveWei + gasPrice * gasLimit;
        if (required >= 1n << 256n || balance < required) {
            fail("RELAYER_BALANCE_TOO_LOW", 503);
        }
    }

    #registrationContext(request, digest) {
        return Object.freeze({
            account: request.account,
            action: request.action,
            chainId: PRIVATE_SESSION_REGISTRATION_CHAIN_ID.toString(),
            factory: request.factory,
            gate: request.gate,
            id: toBeHex(
                BigInt(request.eligibility.publicSignals[0]),
                32,
            ).slice(2).toLowerCase(),
            registry: request.registry,
            requestDigest: digest,
        });
    }

    async #prepareStored(handle, context, call, simulationBlock) {
        const {gasPrice, nonce} = await this.#relayState(
            simulationBlock,
            call.gasLimit,
        );
        let record;
        try {
            record = await this.transactionStore.prepare({
                handle,
                minimumNonce: nonce,
                build: async (reservedNonce) => {
                    const raw = await this.#sign(
                        call,
                        gasPrice,
                        reservedNonce,
                    );
                    const transaction = this.#validateSignedTransaction(
                        raw,
                        call,
                        gasPrice,
                        reservedNonce,
                    );
                    return {
                        kind: "registration",
                        context,
                        from: this.relayerAddress,
                        to: call.to,
                        gasPrice: gasPrice.toString(),
                        gasLimit: call.gasLimit.toString(),
                        transactionHash: transactionHash(
                            transaction.hash,
                            "SIGNED_TRANSACTION_INVALID",
                        ),
                        calldata: Buffer.from(call.data.slice(2), "hex"),
                        signedTransaction: Buffer.from(raw.slice(2), "hex"),
                        simulationBlock,
                    };
                },
            });
            this.#assertStoredRecord(record, context, call);
            return record;
        } catch (error) {
            record?.calldata?.fill(0);
            record?.signedTransaction?.fill(0);
            wrap(error, "RELAY_PREPARATION_FAILED", 500);
        }
    }

    #assertStoredRecord(record, context, call) {
        const metadata = record?.metadata;
        const expectedData = Buffer.from(call.data.slice(2), "hex");
        try {
            if (
                metadata?.kind !== "registration"
                || metadata.handle
                    !== privateRelayHandle("registration", context.id)
                || metadata.chainId
                    !== PRIVATE_SESSION_REGISTRATION_CHAIN_ID.toString()
                || metadata.from !== this.relayerAddress
                || metadata.to !== call.to
                || metadata.gasLimit !== call.gasLimit.toString()
                || BigInt(metadata.gasPrice ?? 0) > this.maxGasPriceWei
                || JSON.stringify(metadata.context) !== JSON.stringify(context)
                || !Buffer.from(record.calldata).equals(expectedData)
            ) {
                fail("PREPARED_TRANSACTION_MISMATCH", 500);
            }
            const raw = `0x${record.signedTransaction.toString("hex")}`;
            const transaction = this.#validateSignedTransaction(
                raw,
                call,
                BigInt(metadata.gasPrice),
                metadata.nonce,
            );
            if (
                transactionHash(
                    transaction.hash,
                    "PREPARED_TRANSACTION_MISMATCH",
                ) !== metadata.transactionHash
            ) {
                fail("PREPARED_TRANSACTION_MISMATCH", 500);
            }
        } finally {
            expectedData.fill(0);
        }
    }

    async #sign(call, gasPrice, nonce) {
        try {
            const raw = await this.signer.signTransaction({
                type: 0,
                chainId: PRIVATE_SESSION_REGISTRATION_CHAIN_ID,
                nonce,
                to: call.to,
                value: 0n,
                data: call.data,
                gasLimit: call.gasLimit,
                gasPrice,
            });
            if (typeof raw !== "string" || !SIGNED_TRANSACTION.test(raw)) {
                fail("SIGNED_TRANSACTION_INVALID", 500);
            }
            return raw;
        } catch (error) {
            wrap(error, "TRANSACTION_SIGNING_FAILED", 500);
        }
    }

    #validateSignedTransaction(raw, call, gasPrice, nonce) {
        let transaction;
        try {
            transaction = Transaction.from(raw);
        } catch {
            fail("SIGNED_TRANSACTION_INVALID", 500);
        }
        if (
            typeof transaction.hash !== "string"
            || !BYTES32.test(transaction.hash.toLowerCase())
            || address(transaction.from, "SIGNED_TRANSACTION_INVALID")
                !== this.relayerAddress
            || address(transaction.to, "SIGNED_TRANSACTION_INVALID") !== call.to
            || transaction.type !== 0
            || transaction.chainId !== PRIVATE_SESSION_REGISTRATION_CHAIN_ID
            || transaction.nonce !== nonce
            || transaction.value !== 0n
            || transaction.data.toLowerCase() !== call.data.toLowerCase()
            || transaction.gasLimit !== call.gasLimit
            || transaction.gasPrice !== gasPrice
            || transaction.gasLimit
                > PRIVATE_SESSION_REGISTRATION_GAS_LIMIT_CAPS[call.kind]
        ) {
            fail("SIGNED_TRANSACTION_INVALID", 500);
        }
        return transaction;
    }

    async #reconcile(request, attempt) {
        let receipt;
        let pending;
        let state;
        try {
            [receipt, pending, state] = await Promise.all([
                this.provider.getTransactionReceipt(attempt.txHash),
                this.provider.getTransaction(attempt.txHash),
                this.#readPinned(request),
            ]);
        } catch (error) {
            wrap(error, "RECONCILIATION_FAILED", 503);
        }
        if (
            receipt !== null
            && transactionHash(
                receipt.hash ?? receipt.transactionHash,
                "RECEIPT_INVALID",
            ) !== attempt.txHash
        ) {
            fail("RECEIPT_INVALID", 502);
        }
        if (
            pending !== null
            && transactionHash(pending.hash, "PENDING_TRANSACTION_INVALID")
                !== attempt.txHash
        ) {
            fail("PENDING_TRANSACTION_INVALID", 502);
        }
        const status = receiptStatus(receipt);
        if (state.kycGranted) {
            this.#requireCanonicalConfirmed(state);
            return Object.freeze({
                kind: "CONFIRMED",
                includeHash: status === "CONFIRMED",
            });
        }
        if (status === "CONFIRMED") {
            return Object.freeze({kind: "UNKNOWN", includeHash: true});
        }
        if (status === "REJECTED") {
            return Object.freeze({kind: "REJECTED", includeHash: true});
        }
        if (pending !== null) {
            return Object.freeze({kind: "PENDING", includeHash: true});
        }
        return Object.freeze({kind: "ABSENT", includeHash: false});
    }

    #serializeSubmission(operation) {
        const run = this.submissionQueue.then(operation, operation);
        this.submissionQueue = run.catch(() => {});
        return run;
    }
}
