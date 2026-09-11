import {
    Contract,
    JsonRpcProvider,
    getAddress,
} from "ethers";

import {
    QUICKNET_CHAIN_HASH,
    TIMED_TICKET_CHAIN_ID,
} from "../../tools/timed-ticket.mjs";

export const SESSION_ACCOUNT_ABI = Object.freeze([
    "function engine() view returns (address)",
    "function security() view returns (address)",
    "function partition() view returns (bytes32)",
    "function router() view returns (address)",
    "function quicknetChainHash() view returns (bytes32)",
    "function generation() view returns (uint64)",
    "function feePolicyDigest() view returns (bytes32)",
    "function placeSealed(bytes32 commitment,bytes32 envelopeDigest,uint64 quicknetRound,bytes signature)",
    "function cancelAuthorized(bytes32 commitment,bytes32 envelopeDigest,uint64 quicknetRound,bytes signature)",
    "function revealAuthorized(uint8 side,uint128 price,uint128 qty,bytes32 randomSalt,bytes32 envelopeDigest,uint64 quicknetRound) returns (bytes32)",
    "function expire(bytes32 id)",
    "function sweepEngineCredit()",
]);

export const MATCHING_ENGINE_TICKET_ABI = Object.freeze([
    "function commitments(bytes32 id) view returns (address committer,uint64 committedAt,bool revealed,bool cancelled,uint256 bond)",
    "function orders(bytes32 id) view returns (address trader,uint8 side,uint128 price,uint128 qty,uint128 filled,uint64 revealedAt,uint64 firstRound,uint64 lastRound,bool retired)",
    "function credit(address account) view returns (uint256)",
    "function currentRound() view returns (uint64)",
    "function revealDelay() view returns (uint64)",
    "function revealWindow() view returns (uint64)",
]);

export const SESSION_ACCOUNT_FACTORY_ABI = Object.freeze([
    "function isSessionAccount(address account) view returns (bool)",
]);

export const FIXED_ROUTER_RELAY_ABI = Object.freeze([
    "function asset() view returns (address)",
    "function denomination() view returns (uint256)",
    "function deploymentChainId() view returns (uint256)",
    "function sessionFactory() view returns (address)",
    "function activeViewKeyEpoch() view returns (uint64)",
    "function activeViewKeyX() view returns (uint256)",
    "function activeViewKeyY() view returns (uint256)",
    "function nullifierSpent(bytes32 nullifier) view returns (bool)",
]);

const BASE_CONTEXT_KEYS = Object.freeze([
    "chainHash",
    "chainId",
    "engine",
    "engineCommitment",
    "envelopeDigest",
    "envelopeId",
    "sessionAccount",
    "targetRound",
]);
const VERIFIED_CONTEXT_KEYS = Object.freeze([
    ...BASE_CONTEXT_KEYS,
    "feePolicyDigest",
    "generation",
    "ticketId",
]);
const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const TICKET_ID = /^[0-9a-f]{64}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const UINT64_LIMIT = 1n << 64n;
const RELEASE_CONFIG_KEYS = Object.freeze([
    "factory",
    "feePolicyDigest",
    "generation",
    "partition",
    "recoveryRouter",
    "security",
]);
const POOL_CONFIG_KEYS = Object.freeze(["HBAR", "LPRC"]);
const ASSET_POOL_KEYS = Object.freeze(["address", "asset", "denomination"]);
const ROUTING_CONTEXT_KEYS = Object.freeze([
    "asset",
    "assetAddress",
    "chainId",
    "denomination",
    "nullifier",
    "pool",
    "recipient",
    "root",
    "viewKeyEpoch",
    "viewKeyX",
    "viewKeyY",
]);

export class PrivateTradingChainError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "PrivateTradingChainError";
        this.code = code;
    }
}

function fail(code, message = "private trading chain validation failed") {
    throw new PrivateTradingChainError(code, message);
}

function exactObject(value, keys) {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
    ) {
        fail("CHAIN_REQUEST_INVALID");
    }
}

function normalizedAddress(value, code = "CHAIN_REQUEST_INVALID") {
    try {
        const result = getAddress(value).toLowerCase();
        if (!ADDRESS.test(result)) throw new Error();
        return result;
    } catch {
        fail(code);
    }
}

function bytes32(value, code = "CHAIN_REQUEST_INVALID") {
    if (typeof value !== "string" || !BYTES32.test(value.toLowerCase())) {
        fail(code);
    }
    return value.toLowerCase();
}

function deployedCode(value) {
    return typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(value);
}

function rpcEndpoint(value) {
    if (typeof value !== "string") fail("RPC_CONFIG_INVALID");
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        fail("RPC_CONFIG_INVALID");
    }
    if (
        parsed.protocol !== "https:"
        || parsed.username !== ""
        || parsed.password !== ""
        || parsed.hash !== ""
    ) {
        fail("RPC_CONFIG_INVALID");
    }
    return parsed.href;
}

function decimal(value, {nonzero = false} = {}) {
    if (
        !(
            typeof value === "bigint"
            || (typeof value === "number" && Number.isSafeInteger(value))
            || (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value))
        )
    ) {
        fail("CHAIN_REQUEST_INVALID");
    }
    let result;
    try {
        result = BigInt(value);
    } catch {
        fail("CHAIN_REQUEST_INVALID");
    }
    if (result < 0n || result >= UINT64_LIMIT || (nonzero && result === 0n)) {
        fail("CHAIN_REQUEST_INVALID");
    }
    return result;
}

function chainHash(value) {
    if (
        typeof value !== "string"
        || value.toLowerCase().replace(/^0x/, "") !== QUICKNET_CHAIN_HASH
    ) {
        fail("QUICKNET_CONTEXT_MISMATCH");
    }
    return QUICKNET_CHAIN_HASH;
}

function normalizeBaseContext(request) {
    exactObject(request, BASE_CONTEXT_KEYS);
    const chainId = decimal(request.chainId);
    if (chainId !== TIMED_TICKET_CHAIN_ID) fail("CHAIN_MISMATCH");
    return Object.freeze({
        chainId: chainId.toString(),
        chainHash: chainHash(request.chainHash),
        engine: normalizedAddress(request.engine),
        sessionAccount: normalizedAddress(request.sessionAccount),
        envelopeId: bytes32(request.envelopeId),
        envelopeDigest: bytes32(request.envelopeDigest),
        engineCommitment: bytes32(request.engineCommitment),
        targetRound: decimal(request.targetRound, {nonzero: true}).toString(),
    });
}

function normalizeVerifiedContext(request) {
    exactObject(request, VERIFIED_CONTEXT_KEYS);
    if (typeof request.ticketId !== "string" || !TICKET_ID.test(request.ticketId)) {
        fail("CHAIN_REQUEST_INVALID");
    }
    const base = normalizeBaseContext(Object.fromEntries(
        BASE_CONTEXT_KEYS.map((key) => [key, request[key]]),
    ));
    return Object.freeze({
        ...base,
        ticketId: request.ticketId,
        generation: decimal(request.generation).toString(),
        feePolicyDigest: bytes32(request.feePolicyDigest),
    });
}

function tupleValue(value, key, index) {
    return value?.[key] ?? value?.[index];
}

function bool(value) {
    if (value !== true && value !== false) fail("CHAIN_OBSERVATION_INVALID");
    return value;
}

function observedUint64(value) {
    let result;
    try {
        result = BigInt(value);
    } catch {
        fail("CHAIN_OBSERVATION_INVALID");
    }
    if (result < 0n || result >= UINT64_LIMIT) fail("CHAIN_OBSERVATION_INVALID");
    return result;
}

function observedUint(value) {
    let result;
    try {
        result = BigInt(value);
    } catch {
        fail("CHAIN_OBSERVATION_INVALID");
    }
    if (result < 0n || result >= 1n << 256n) fail("CHAIN_OBSERVATION_INVALID");
    return result;
}

function normalizeCommitment(value) {
    if (value === null || typeof value !== "object") {
        fail("CHAIN_OBSERVATION_INVALID");
    }
    const result = {
        committer: normalizedAddress(
            tupleValue(value, "committer", 0),
            "CHAIN_OBSERVATION_INVALID",
        ),
        committedAt: observedUint64(tupleValue(value, "committedAt", 1)),
        revealed: bool(tupleValue(value, "revealed", 2)),
        cancelled: bool(tupleValue(value, "cancelled", 3)),
        bond: observedUint(tupleValue(value, "bond", 4)),
    };
    if (
        result.revealed && result.cancelled
        || result.committer !== ZERO_ADDRESS && result.committedAt === 0n
    ) {
        fail("CHAIN_OBSERVATION_INVALID");
    }
    return Object.freeze(result);
}

function validateAbsent(commitment) {
    if (
        commitment.committedAt !== 0n
        || commitment.revealed
        || commitment.cancelled
        || commitment.bond !== 0n
    ) {
        fail("CHAIN_OBSERVATION_INVALID");
    }
}

function canonicalDecimal(value, code = "CHAIN_ADAPTER_CONFIG_INVALID") {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
        fail(code);
    }
    const parsed = BigInt(value);
    if (parsed < 0n || parsed >= 1n << 256n) fail(code);
    return parsed;
}

function normalizeReleaseConfig(value) {
    try {
        exactObject(value, RELEASE_CONFIG_KEYS);
    } catch {
        fail("CHAIN_ADAPTER_CONFIG_INVALID");
    }
    const generation = canonicalDecimal(
        String(value.generation),
        "CHAIN_ADAPTER_CONFIG_INVALID",
    );
    if (generation >= UINT64_LIMIT) fail("CHAIN_ADAPTER_CONFIG_INVALID");
    return Object.freeze({
        factory: normalizedAddress(value.factory, "CHAIN_ADAPTER_CONFIG_INVALID"),
        security: normalizedAddress(value.security, "CHAIN_ADAPTER_CONFIG_INVALID"),
        partition: bytes32(value.partition, "CHAIN_ADAPTER_CONFIG_INVALID"),
        recoveryRouter: normalizedAddress(
            value.recoveryRouter,
            "CHAIN_ADAPTER_CONFIG_INVALID",
        ),
        generation: generation.toString(),
        feePolicyDigest: bytes32(
            value.feePolicyDigest,
            "CHAIN_ADAPTER_CONFIG_INVALID",
        ),
    });
}

function normalizePools(value, releaseConfig) {
    try {
        exactObject(value, POOL_CONFIG_KEYS);
    } catch {
        fail("CHAIN_ADAPTER_CONFIG_INVALID");
    }
    const output = {};
    for (const assetName of POOL_CONFIG_KEYS) {
        try {
            exactObject(value[assetName], ASSET_POOL_KEYS);
        } catch {
            fail("CHAIN_ADAPTER_CONFIG_INVALID");
        }
        const asset = normalizedAddress(
            value[assetName].asset,
            "CHAIN_ADAPTER_CONFIG_INVALID",
        );
        const denomination = canonicalDecimal(
            String(value[assetName].denomination),
            "CHAIN_ADAPTER_CONFIG_INVALID",
        );
        if (
            denomination === 0n
            || (assetName === "HBAR" && asset !== ZERO_ADDRESS)
            || (assetName === "LPRC" && asset !== releaseConfig.security)
        ) {
            fail("CHAIN_ADAPTER_CONFIG_INVALID");
        }
        output[assetName] = Object.freeze({
            address: normalizedAddress(
                value[assetName].address,
                "CHAIN_ADAPTER_CONFIG_INVALID",
            ),
            asset,
            denomination: denomination.toString(),
        });
    }
    if (output.HBAR.address === output.LPRC.address) {
        fail("CHAIN_ADAPTER_CONFIG_INVALID");
    }
    return Object.freeze(output);
}

function normalizeOrder(value) {
    if (value === null || typeof value !== "object") {
        fail("CHAIN_OBSERVATION_INVALID");
    }
    const side = Number(tupleValue(value, "side", 1));
    const retired = tupleValue(value, "retired", 8);
    if (![0, 1].includes(side) || (retired !== true && retired !== false)) {
        fail("CHAIN_OBSERVATION_INVALID");
    }
    return Object.freeze({
        trader: normalizedAddress(
            tupleValue(value, "trader", 0),
            "CHAIN_OBSERVATION_INVALID",
        ),
        side,
        price: observedUint(tupleValue(value, "price", 2)),
        quantity: observedUint(tupleValue(value, "qty", 3)),
        filled: observedUint(tupleValue(value, "filled", 4)),
        revealedAt: observedUint64(tupleValue(value, "revealedAt", 5)),
        firstRound: observedUint64(tupleValue(value, "firstRound", 6)),
        lastRound: observedUint64(tupleValue(value, "lastRound", 7)),
        retired,
    });
}

function normalizeRoutingContext(value) {
    exactObject(value, ROUTING_CONTEXT_KEYS);
    if (!POOL_CONFIG_KEYS.includes(value.asset)) fail("CHAIN_REQUEST_INVALID");
    const chainId = canonicalDecimal(value.chainId, "CHAIN_REQUEST_INVALID");
    if (chainId !== TIMED_TICKET_CHAIN_ID) fail("CHAIN_MISMATCH");
    return Object.freeze({
        asset: value.asset,
        assetAddress: normalizedAddress(value.assetAddress),
        chainId: chainId.toString(),
        pool: normalizedAddress(value.pool),
        recipient: normalizedAddress(value.recipient),
        denomination: canonicalDecimal(
            value.denomination,
            "CHAIN_REQUEST_INVALID",
        ).toString(),
        root: canonicalDecimal(value.root, "CHAIN_REQUEST_INVALID").toString(),
        nullifier: bytes32(value.nullifier),
        viewKeyEpoch: canonicalDecimal(
            value.viewKeyEpoch,
            "CHAIN_REQUEST_INVALID",
        ).toString(),
        viewKeyX: canonicalDecimal(
            value.viewKeyX,
            "CHAIN_REQUEST_INVALID",
        ).toString(),
        viewKeyY: canonicalDecimal(
            value.viewKeyY,
            "CHAIN_REQUEST_INVALID",
        ).toString(),
    });
}

export class HederaTimedTicketChainAdapter {
    static async open({
        rpcUrl,
        engineAddress,
        providerOptions = {},
        ...options
    }) {
        const provider = new JsonRpcProvider(
            rpcEndpoint(rpcUrl),
            Number(TIMED_TICKET_CHAIN_ID),
            {
                ...providerOptions,
                staticNetwork: true,
                batchMaxCount: 20,
            },
        );
        const adapter = new HederaTimedTicketChainAdapter({
            ...options,
            provider,
            engineAddress,
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
        engineAddress,
        releaseConfig,
        pools,
        engineContract,
        factoryContract,
        sessionContractFactory,
        routerContractFactory,
        ownsProvider = false,
    }) {
        if (
            provider === null
            || typeof provider !== "object"
            || typeof provider.getNetwork !== "function"
            || typeof provider.send !== "function"
            || typeof provider.getBlock !== "function"
            || typeof provider.getCode !== "function"
        ) {
            fail("CHAIN_ADAPTER_CONFIG_INVALID");
        }
        this.provider = provider;
        this.engineAddress = normalizedAddress(engineAddress);
        this.releaseConfig = normalizeReleaseConfig(releaseConfig);
        this.pools = normalizePools(pools, this.releaseConfig);
        this.engine = engineContract
            ?? new Contract(this.engineAddress, MATCHING_ENGINE_TICKET_ABI, provider);
        if (
            typeof this.engine?.commitments !== "function"
            || typeof this.engine?.orders !== "function"
            || typeof this.engine?.credit !== "function"
            || typeof this.engine?.currentRound !== "function"
            || typeof this.engine?.revealDelay !== "function"
            || typeof this.engine?.revealWindow !== "function"
        ) {
            fail("CHAIN_ADAPTER_CONFIG_INVALID");
        }
        this.factory = factoryContract
            ?? new Contract(
                this.releaseConfig.factory,
                SESSION_ACCOUNT_FACTORY_ABI,
                provider,
            );
        if (typeof this.factory?.isSessionAccount !== "function") {
            fail("CHAIN_ADAPTER_CONFIG_INVALID");
        }
        this.sessionContractFactory = sessionContractFactory
            ?? ((account) => new Contract(account, SESSION_ACCOUNT_ABI, provider));
        if (typeof this.sessionContractFactory !== "function") {
            fail("CHAIN_ADAPTER_CONFIG_INVALID");
        }
        this.routerContractFactory = routerContractFactory
            ?? ((account) => new Contract(account, FIXED_ROUTER_RELAY_ABI, provider));
        if (typeof this.routerContractFactory !== "function") {
            fail("CHAIN_ADAPTER_CONFIG_INVALID");
        }
        this.routers = Object.fromEntries(POOL_CONFIG_KEYS.map((asset) => [
            asset,
            this.routerContractFactory(this.pools[asset].address),
        ]));
        for (const router of Object.values(this.routers)) {
            if (
                router === null
                || typeof router !== "object"
                || typeof router.asset !== "function"
                || typeof router.denomination !== "function"
                || typeof router.deploymentChainId !== "function"
                || typeof router.sessionFactory !== "function"
                || typeof router.activeViewKeyEpoch !== "function"
                || typeof router.activeViewKeyX !== "function"
                || typeof router.activeViewKeyY !== "function"
                || typeof router.nullifierSpent !== "function"
            ) {
                fail("CHAIN_ADAPTER_CONFIG_INVALID");
            }
        }
        this.ownsProvider = ownsProvider;
        this.initialization = null;
        this.sessionPins = new Map();
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

    async querySessionContext(request) {
        const context = normalizeBaseContext(request);
        this.#requireEngine(context);
        const block = await this.#latestBlock();
        const session = await this.#sessionAt(context, block);
        return Object.freeze({
            schemaVersion: "hedera2026.private-session-context.v1",
            chainId: context.chainId,
            observedAtBlock: block.number,
            observedAtTimestamp: block.timestamp.toString(),
            sessionAccount: context.sessionAccount,
            engine: session.engine,
            security: session.security,
            partition: session.partition,
            recoveryRouter: session.recoveryRouter,
            quicknetChainHash: session.quicknetChainHash,
            generation: session.generation,
            feePolicyDigest: session.feePolicyDigest,
        });
    }

    async verifySessionContext(request) {
        const context = normalizeVerifiedContext(request);
        this.#requireEngine(context);
        const block = await this.#latestBlock();
        const session = await this.#sessionAt(context, block);
        if (
            session.generation !== context.generation
            || session.feePolicyDigest !== context.feePolicyDigest
        ) {
            fail("SESSION_CONTEXT_MISMATCH");
        }
        return Object.freeze({
            status: "VERIFIED",
            observedAtBlock: block.number,
            observedAtTimestamp: block.timestamp.toString(),
            engine: session.engine,
            security: session.security,
            partition: session.partition,
            recoveryRouter: session.recoveryRouter,
            quicknetChainHash: session.quicknetChainHash,
            generation: session.generation,
            feePolicyDigest: session.feePolicyDigest,
        });
    }

    async observePlacement(request) {
        const context = normalizeBaseContext(request);
        this.#requireEngine(context);
        const block = await this.#latestBlock();
        const atBlock = {blockTag: block.number};
        let commitment;
        let revealDelay;
        let revealWindow;
        try {
            [commitment, revealDelay, revealWindow] = await Promise.all([
                this.engine.commitments(context.engineCommitment, atBlock),
                this.engine.revealDelay(atBlock),
                this.engine.revealWindow(atBlock),
                this.#sessionAt(context, block),
            ]);
        } catch (error) {
            if (error instanceof PrivateTradingChainError) throw error;
            fail("CHAIN_UNAVAILABLE");
        }
        const observed = normalizeCommitment(commitment);
        if (observed.committer === ZERO_ADDRESS) {
            validateAbsent(observed);
            return Object.freeze({status: "ABSENT"});
        }
        if (observed.committer !== context.sessionAccount) {
            fail("COMMITMENT_OWNER_MISMATCH");
        }
        return Object.freeze({
            status: "PLACED",
            commitment: context.engineCommitment,
            commitTime: observed.committedAt.toString(),
            revealDelay: observedUint64(revealDelay).toString(),
            revealWindow: observedUint64(revealWindow).toString(),
        });
    }

    async recheckBeforeReveal(request) {
        const context = normalizeBaseContext(request);
        this.#requireEngine(context);
        const block = await this.#latestBlock();
        const atBlock = {blockTag: block.number};
        let commitment;
        let revealDelay;
        let revealWindow;
        try {
            [commitment, revealDelay, revealWindow] = await Promise.all([
                this.engine.commitments(context.engineCommitment, atBlock),
                this.engine.revealDelay(atBlock),
                this.engine.revealWindow(atBlock),
                this.#sessionAt(context, block),
            ]);
        } catch (error) {
            if (error instanceof PrivateTradingChainError) throw error;
            fail("CHAIN_UNAVAILABLE");
        }
        const observed = normalizeCommitment(commitment);
        if (observed.committer === ZERO_ADDRESS) {
            validateAbsent(observed);
            return Object.freeze({status: "ABSENT"});
        }
        if (observed.committer !== context.sessionAccount) {
            fail("COMMITMENT_OWNER_MISMATCH");
        }
        if (observed.cancelled) {
            return Object.freeze({
                status: "CANCELLED",
                commitment: context.engineCommitment,
            });
        }
        if (observed.revealed) {
            return Object.freeze({
                status: "REVEALED",
                commitment: context.engineCommitment,
            });
        }
        const opensAt = observed.committedAt + observedUint64(revealDelay);
        const closesAt = opensAt + observedUint64(revealWindow);
        const now = BigInt(block.timestamp);
        if (now < opensAt) fail("REVEAL_NOT_OPEN");
        if (now > closesAt) fail("REVEAL_WINDOW_CLOSED");
        return Object.freeze({
            status: "REVEALABLE",
            commitment: context.engineCommitment,
        });
    }

    async observeCancellation(request) {
        const context = normalizeBaseContext(request);
        this.#requireEngine(context);
        const block = await this.#latestBlock();
        const atBlock = {blockTag: block.number};
        let rawCommitment;
        let revealDelay;
        let rawCredit;
        try {
            [rawCommitment, revealDelay, rawCredit] = await Promise.all([
                this.engine.commitments(context.engineCommitment, atBlock),
                this.engine.revealDelay(atBlock),
                this.engine.credit(context.sessionAccount, atBlock),
                this.#sessionAt(context, block),
            ]);
        } catch (error) {
            if (error instanceof PrivateTradingChainError) throw error;
            fail("CHAIN_UNAVAILABLE");
        }
        const observed = normalizeCommitment(rawCommitment);
        const engineCredit = observedUint(rawCredit).toString();
        if (observed.committer === ZERO_ADDRESS) {
            validateAbsent(observed);
            return Object.freeze({status: "ABSENT", engineCredit});
        }
        if (observed.committer !== context.sessionAccount) {
            fail("COMMITMENT_OWNER_MISMATCH");
        }
        if (observed.cancelled) {
            return Object.freeze({
                status: "CANCELLED",
                commitment: context.engineCommitment,
                engineCredit,
            });
        }
        if (observed.revealed) {
            return Object.freeze({
                status: "REVEALED",
                commitment: context.engineCommitment,
                engineCredit,
            });
        }
        const closesAt = observed.committedAt + observedUint64(revealDelay);
        return Object.freeze({
            status: block.timestamp < closesAt ? "CANCELLABLE" : "CLOSED",
            commitment: context.engineCommitment,
            engineCredit,
        });
    }

    async cancel(request) {
        const observed = await this.observeCancellation(request);
        if (
            observed.status !== "CANCELLED"
            || observed.engineCredit !== "0"
        ) {
            fail("CHAIN_CANCELLATION_UNCONFIRMED");
        }
        return Object.freeze({status: "CONFIRMED"});
    }

    async observeRelease(request) {
        const context = normalizeBaseContext(request);
        this.#requireEngine(context);
        const block = await this.#latestBlock();
        const atBlock = {blockTag: block.number};
        let rawCommitment;
        let rawOrder;
        let currentRound;
        let credit;
        try {
            [rawCommitment, rawOrder, currentRound, credit] = await Promise.all([
                this.engine.commitments(context.engineCommitment, atBlock),
                this.engine.orders(context.engineCommitment, atBlock),
                this.engine.currentRound(atBlock),
                this.engine.credit(context.sessionAccount, atBlock),
                this.#sessionAt(context, block),
            ]);
        } catch (error) {
            if (error instanceof PrivateTradingChainError) throw error;
            fail("CHAIN_UNAVAILABLE");
        }
        const commitment = normalizeCommitment(rawCommitment);
        const order = normalizeOrder(rawOrder);
        const round = observedUint64(currentRound);
        const engineCredit = observedUint(credit);
        if (
            commitment.committer !== context.sessionAccount
            || !commitment.revealed
            || commitment.cancelled
            || order.trader !== context.sessionAccount
            || order.revealedAt === 0n
        ) {
            fail("RELEASE_CONTEXT_MISMATCH");
        }
        let status;
        if (!order.retired) {
            status = round > order.lastRound ? "RELEASABLE" : "RESTING";
        } else {
            status = engineCredit === 0n ? "RELEASED" : "SWEEP_REQUIRED";
        }
        return Object.freeze({
            status,
            commitment: context.engineCommitment,
            retired: order.retired,
            currentRound: round.toString(),
            lastRound: order.lastRound.toString(),
            engineCredit: engineCredit.toString(),
        });
    }

    async verifyRoutingContext(request) {
        const context = normalizeRoutingContext(request);
        const pool = this.pools[context.asset];
        if (
            context.pool !== pool.address
            || context.assetAddress !== pool.asset
            || context.denomination !== pool.denomination
        ) {
            fail("ROUTING_CONTEXT_MISMATCH");
        }
        const block = await this.#latestBlock();
        const atBlock = {blockTag: block.number};
        const router = this.routers[context.asset];
        let values;
        try {
            values = await Promise.all([
                router.asset(atBlock),
                router.denomination(atBlock),
                router.deploymentChainId(atBlock),
                router.sessionFactory(atBlock),
                router.activeViewKeyEpoch(atBlock),
                router.activeViewKeyX(atBlock),
                router.activeViewKeyY(atBlock),
                router.nullifierSpent(context.nullifier, atBlock),
                this.#sessionAt({
                    engine: this.engineAddress,
                    sessionAccount: context.recipient,
                }, block),
            ]);
        } catch (error) {
            if (error instanceof PrivateTradingChainError) throw error;
            fail("CHAIN_UNAVAILABLE");
        }
        if (
            normalizedAddress(values[0], "CHAIN_OBSERVATION_INVALID") !== pool.asset
            || observedUint(values[1]).toString() !== pool.denomination
            || observedUint(values[2]) !== TIMED_TICKET_CHAIN_ID
            || normalizedAddress(values[3], "CHAIN_OBSERVATION_INVALID")
                !== this.releaseConfig.factory
            || observedUint64(values[4]).toString() !== context.viewKeyEpoch
            || observedUint(values[5]).toString() !== context.viewKeyX
            || observedUint(values[6]).toString() !== context.viewKeyY
            || (values[7] !== true && values[7] !== false)
        ) {
            fail("ROUTING_CONTEXT_MISMATCH");
        }
        return Object.freeze({
            status: values[7] ? "SPENT" : "UNSPENT",
            nullifier: context.nullifier,
            observedAtBlock: block.number,
        });
    }

    async observeRoutingWithdrawal(request) {
        const context = normalizeRoutingContext(request);
        const pool = this.pools[context.asset];
        if (
            context.pool !== pool.address
            || context.assetAddress !== pool.asset
            || context.denomination !== pool.denomination
        ) {
            fail("ROUTING_CONTEXT_MISMATCH");
        }
        const block = await this.#latestBlock();
        const atBlock = {blockTag: block.number};
        const router = this.routers[context.asset];
        let values;
        try {
            values = await Promise.all([
                router.asset(atBlock),
                router.denomination(atBlock),
                router.deploymentChainId(atBlock),
                router.sessionFactory(atBlock),
                router.nullifierSpent(context.nullifier, atBlock),
                this.#sessionAt({
                    engine: this.engineAddress,
                    sessionAccount: context.recipient,
                }, block),
            ]);
        } catch (error) {
            if (error instanceof PrivateTradingChainError) throw error;
            fail("CHAIN_UNAVAILABLE");
        }
        if (
            normalizedAddress(values[0], "CHAIN_OBSERVATION_INVALID") !== pool.asset
            || observedUint(values[1]).toString() !== pool.denomination
            || observedUint(values[2]) !== TIMED_TICKET_CHAIN_ID
            || normalizedAddress(values[3], "CHAIN_OBSERVATION_INVALID")
                !== this.releaseConfig.factory
            || (values[4] !== true && values[4] !== false)
        ) {
            fail("ROUTING_CONTEXT_MISMATCH");
        }
        return Object.freeze({
            status: values[4] ? "SPENT" : "UNSPENT",
            nullifier: context.nullifier,
            observedAtBlock: block.number,
        });
    }

    routingPool(asset) {
        if (!POOL_CONFIG_KEYS.includes(asset)) fail("CHAIN_REQUEST_INVALID");
        return Object.freeze({
            assetName: asset,
            ...this.pools[asset],
        });
    }

    close() {
        if (this.ownsProvider && typeof this.provider.destroy === "function") {
            this.provider.destroy();
        }
    }

    async #initialize() {
        let network;
        let reportedChainId;
        try {
            [network, reportedChainId] = await Promise.all([
                this.provider.getNetwork(),
                this.provider.send("eth_chainId", []),
            ]);
        } catch {
            fail("CHAIN_UNAVAILABLE");
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
        let code;
        try {
            code = await Promise.all([
                this.provider.getCode(this.engineAddress),
                this.provider.getCode(this.releaseConfig.factory),
                this.provider.getCode(this.releaseConfig.security),
                this.provider.getCode(this.releaseConfig.recoveryRouter),
                this.provider.getCode(this.pools.HBAR.address),
                this.provider.getCode(this.pools.LPRC.address),
            ]);
        } catch {
            fail("CHAIN_UNAVAILABLE");
        }
        if (!code.every(deployedCode)) fail("RELEASE_CODE_MISSING");
        return Object.freeze({
            chainId: TIMED_TICKET_CHAIN_ID.toString(),
            engine: this.engineAddress,
        });
    }

    async #latestBlock() {
        await this.initialize();
        let block;
        try {
            block = await this.provider.getBlock("latest");
        } catch {
            fail("CHAIN_UNAVAILABLE");
        }
        if (
            block === null
            || !Number.isSafeInteger(block.number)
            || block.number < 0
        ) {
            fail("CHAIN_OBSERVATION_INVALID");
        }
        const timestamp = observedUint64(block.timestamp);
        return Object.freeze({number: block.number, timestamp});
    }

    async #sessionAt(context, block) {
        let code;
        try {
            code = await this.provider.getCode(context.sessionAccount, block.number);
        } catch {
            fail("CHAIN_UNAVAILABLE");
        }
        if (!deployedCode(code)) {
            fail("SESSION_CODE_MISSING");
        }
        let session;
        try {
            session = this.sessionContractFactory(context.sessionAccount);
        } catch {
            fail("CHAIN_ADAPTER_CONFIG_INVALID");
        }
        if (
            session === null
            || typeof session !== "object"
            || typeof session.engine !== "function"
            || typeof session.security !== "function"
            || typeof session.partition !== "function"
            || typeof session.router !== "function"
            || typeof session.quicknetChainHash !== "function"
            || typeof session.generation !== "function"
            || typeof session.feePolicyDigest !== "function"
        ) {
            fail("CHAIN_ADAPTER_CONFIG_INVALID");
        }
        const atBlock = {blockTag: block.number};
        let values;
        try {
            values = await Promise.all([
                this.factory.isSessionAccount(context.sessionAccount, atBlock),
                session.engine(atBlock),
                session.security(atBlock),
                session.partition(atBlock),
                session.router(atBlock),
                session.quicknetChainHash(atBlock),
                session.generation(atBlock),
                session.feePolicyDigest(atBlock),
            ]);
        } catch {
            fail("CHAIN_UNAVAILABLE");
        }
        const observed = Object.freeze({
            canonical: bool(values[0]),
            engine: normalizedAddress(values[1], "CHAIN_OBSERVATION_INVALID"),
            security: normalizedAddress(values[2], "CHAIN_OBSERVATION_INVALID"),
            partition: bytes32(values[3], "CHAIN_OBSERVATION_INVALID"),
            recoveryRouter: normalizedAddress(
                values[4],
                "CHAIN_OBSERVATION_INVALID",
            ),
            quicknetChainHash: bytes32(values[5], "CHAIN_OBSERVATION_INVALID"),
            generation: observedUint64(values[6]).toString(),
            feePolicyDigest: bytes32(values[7], "CHAIN_OBSERVATION_INVALID"),
        });
        if (
            !observed.canonical
            || observed.engine !== context.engine
            || observed.security !== this.releaseConfig.security
            || observed.partition !== this.releaseConfig.partition
            || observed.recoveryRouter !== this.releaseConfig.recoveryRouter
            || observed.quicknetChainHash.slice(2) !== QUICKNET_CHAIN_HASH
            || observed.generation !== this.releaseConfig.generation
            || observed.feePolicyDigest !== this.releaseConfig.feePolicyDigest
        ) {
            fail("SESSION_CONTEXT_MISMATCH");
        }
        const previous = this.sessionPins.get(context.sessionAccount);
        if (
            previous !== undefined
            && (
                previous.engine !== observed.engine
                || previous.canonical !== observed.canonical
                || previous.security !== observed.security
                || previous.partition !== observed.partition
                || previous.recoveryRouter !== observed.recoveryRouter
                || previous.quicknetChainHash !== observed.quicknetChainHash
                || previous.generation !== observed.generation
                || previous.feePolicyDigest !== observed.feePolicyDigest
            )
        ) {
            fail("SESSION_CONTEXT_MISMATCH");
        }
        this.sessionPins.set(context.sessionAccount, observed);
        return observed;
    }

    #requireEngine(context) {
        if (context.engine !== this.engineAddress) fail("ENGINE_MISMATCH");
    }
}
