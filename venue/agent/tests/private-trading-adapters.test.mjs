import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {
    mkdtemp,
    readFile,
    stat,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    Interface,
    Transaction,
    Wallet,
} from "ethers";

import {
    QUICKNET_CHAIN_HASH,
    QUICKNET_GENESIS_TIME,
    computeTimedTicketEngineCommitment,
    createInsecureTestLockedKeyProvider,
    createTimedTicketEnvelope,
} from "../../tools/timed-ticket.mjs";
import {
    PRIVATE_TRADING_BODY_LIMITS,
    PRIVATE_TRADING_ROUTES,
    PrivateTradingController,
} from "../runtime/private-trading-controller.mjs";
import {
    PRIVATE_ROUTING_BODY_LIMIT,
    PrivateRoutingController,
} from "../runtime/private-routing-controller.mjs";
import {
    HederaTimedTicketChainAdapter,
    SESSION_ACCOUNT_ABI,
} from "../runtime/private-trading-chain.mjs";
import {
    EthersPrivateTradingRelayer as RuntimePrivateTradingRelayer,
    PRIVATE_TRADING_DEFAULT_GAS_LIMITS,
    PRIVATE_TRADING_GAS_LIMIT_CAPS,
    loadPrivateTradingRelayerKey,
} from "../runtime/private-trading-relayer.mjs";
import {
    DurablePrivateRelayStore,
    privateRelayHandle,
} from "../runtime/private-relay-store.mjs";
import {TimedTicketCustodyService} from "../runtime/timed-ticket-service.mjs";
import {DurableTimedTicketStore} from "../runtime/timed-ticket-store.mjs";
import {
    PrivateTradingWorkerRunner,
    privateTradingRuntimeConfig,
} from "../runtime/private-trading-worker.mjs";

const ENGINE = `0x${"11".repeat(20)}`;
const ACCOUNT = `0x${"22".repeat(20)}`;
const OTHER_ACCOUNT = `0x${"23".repeat(20)}`;
const ENVELOPE_ID = `0x${"33".repeat(32)}`;
const ENVELOPE_DIGEST = `0x${"44".repeat(32)}`;
const COMMITMENT = `0x${"55".repeat(32)}`;
const RANDOM_SALT = `0x${"66".repeat(32)}`;
const FEE_POLICY = `0x${"77".repeat(32)}`;
const CAPABILITY = `0x${"88".repeat(32)}`;
const TICKET_ID = "99".repeat(32);
const RELAYER_KEY = `0x${"00".repeat(31)}01`;
const FACTORY = `0x${"aa".repeat(20)}`;
const GATE = `0x${"a1".repeat(20)}`;
const REGISTRY = `0x${"a2".repeat(20)}`;
const SECURITY = `0x${"bb".repeat(20)}`;
const PARTITION = `0x${"cc".repeat(32)}`;
const SESSION_CREATION_CODE_HASH = `0x${"ca".repeat(32)}`;
const RECOVERY_ROUTER = `0x${"dd".repeat(20)}`;
const HBAR_POOL = `0x${"ee".repeat(20)}`;
const LPRC_POOL = `0x${"ff".repeat(20)}`;
const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
const LOW_SIGNATURE = new Wallet(RELAYER_KEY).signingKey
    .sign(COMMITMENT).serialized;
const RELAYER_RESERVE_WEI = 100n;
const SESSION_INTERFACE = new Interface(SESSION_ACCOUNT_ABI);

class EthersPrivateTradingRelayer extends RuntimePrivateTradingRelayer {
    constructor(options) {
        super({relayerReserveWei: RELAYER_RESERVE_WEI, ...options});
    }
}
const REVEAL_COMMITMENT = computeTimedTicketEngineCommitment({
    sessionAccount: ACCOUNT,
    engine: ENGINE,
    side: "BUY",
    price: 123456789n,
    quantity: 7n,
    randomSalt: RANDOM_SALT,
    envelopeDigest: ENVELOPE_DIGEST,
    targetRound: 15n,
    generation: 7n,
    feePolicyDigest: FEE_POLICY,
});

async function temporaryDirectory(prefix = "private-trading-test-") {
    return mkdtemp(path.join(os.tmpdir(), prefix));
}

function baseContext(overrides = {}) {
    return {
        chainId: "296",
        chainHash: QUICKNET_CHAIN_HASH,
        engine: ENGINE,
        sessionAccount: ACCOUNT,
        envelopeId: ENVELOPE_ID,
        envelopeDigest: ENVELOPE_DIGEST,
        engineCommitment: COMMITMENT,
        targetRound: "15",
        ...overrides,
    };
}

function verifiedContext(overrides = {}) {
    return {
        ...baseContext(),
        ticketId: TICKET_ID,
        generation: "7",
        feePolicyDigest: FEE_POLICY,
        ...overrides,
    };
}

function chainReleaseConfig() {
    return {
        factory: FACTORY,
        security: SECURITY,
        partition: PARTITION,
        recoveryRouter: RECOVERY_ROUTER,
        generation: "7",
        feePolicyDigest: FEE_POLICY,
    };
}

function chainPools() {
    return {
        HBAR: {
            address: HBAR_POOL,
            asset: ZERO_ADDRESS,
            denomination: "100000000",
        },
        LPRC: {
            address: LPRC_POOL,
            asset: SECURITY,
            denomination: "1000",
        },
    };
}

test("chain adapter pins chain, session getters, commitment owner, and timing to one block", async () => {
    const calls = [];
    let committer = ACCOUNT;
    let cancelled = false;
    let engineCredit = 0n;
    const provider = {
        async getNetwork() {
            return {chainId: 296n};
        },
        async send(method, params) {
            assert.equal(method, "eth_chainId");
            assert.deepEqual(params, []);
            return "0x128";
        },
        async getCode(address, blockTag) {
            calls.push(["code", address.toLowerCase(), blockTag ?? null]);
            return "0x60006000";
        },
        async getBlock(tag) {
            assert.equal(tag, "latest");
            return {number: 81, timestamp: 1_040};
        },
    };
    const atBlock = (name, args) => {
        calls.push([name, args.at(-1).blockTag]);
    };
    const engine = {
        async commitments(...args) {
            atBlock("commitments", args);
            return {
                committer,
                committedAt: 1_000n,
                revealed: false,
                cancelled,
                bond: cancelled ? 0n : 25n,
            };
        },
        async revealDelay(...args) {
            atBlock("revealDelay", args);
            return 30n;
        },
        async revealWindow(...args) {
            atBlock("revealWindow", args);
            return 270n;
        },
        async orders(...args) {
            atBlock("orders", args);
            return {
                trader: ACCOUNT,
                side: 0,
                price: 1n,
                qty: 1n,
                filled: 0n,
                revealedAt: 1_000n,
                firstRound: 1n,
                lastRound: 2n,
                retired: false,
            };
        },
        async credit(...args) {
            atBlock("credit", args);
            return engineCredit;
        },
        async currentRound(...args) {
            atBlock("currentRound", args);
            return 3n;
        },
    };
    const session = {
        async engine(...args) {
            atBlock("session.engine", args);
            return ENGINE;
        },
        async quicknetChainHash(...args) {
            atBlock("session.quicknetChainHash", args);
            return `0x${QUICKNET_CHAIN_HASH}`;
        },
        async generation(...args) {
            atBlock("session.generation", args);
            return 7n;
        },
        async feePolicyDigest(...args) {
            atBlock("session.feePolicyDigest", args);
            return FEE_POLICY;
        },
        async security(...args) {
            atBlock("session.security", args);
            return SECURITY;
        },
        async partition(...args) {
            atBlock("session.partition", args);
            return PARTITION;
        },
        async router(...args) {
            atBlock("session.router", args);
            return RECOVERY_ROUTER;
        },
    };
    let canonical = true;
    const factory = {
        async isSessionAccount(account, options) {
            assert.equal(account, ACCOUNT);
            atBlock("factory.isSessionAccount", [options]);
            return canonical;
        },
    };
    const router = (pool) => ({
        async asset() {
            return pool === HBAR_POOL ? ZERO_ADDRESS : SECURITY;
        },
        async denomination() {
            return pool === HBAR_POOL ? 100000000n : 1000n;
        },
        async deploymentChainId() {
            return 296n;
        },
        async sessionFactory() {
            return FACTORY;
        },
        async activeViewKeyEpoch() {
            return 1n;
        },
        async activeViewKeyX() {
            return 2n;
        },
        async activeViewKeyY() {
            return 3n;
        },
        async nullifierSpent() {
            return false;
        },
    });
    const adapter = new HederaTimedTicketChainAdapter({
        provider,
        engineAddress: ENGINE,
        releaseConfig: chainReleaseConfig(),
        pools: chainPools(),
        engineContract: engine,
        factoryContract: factory,
        sessionContractFactory: (account) => {
            assert.equal(account, ACCOUNT);
            return session;
        },
        routerContractFactory: router,
    });
    const placed = await adapter.observePlacement(baseContext());
    assert.deepEqual(placed, {
        status: "PLACED",
        commitment: COMMITMENT,
        commitTime: "1000",
        revealDelay: "30",
        revealWindow: "270",
    });
    assert.equal((await adapter.recheckBeforeReveal(baseContext())).status, "REVEALABLE");
    const verified = await adapter.verifySessionContext(verifiedContext());
    assert.equal(verified.generation, "7");
    assert.equal(verified.feePolicyDigest, FEE_POLICY);
    assert.ok(
        calls
            .filter(([name]) => name !== "code")
            .every((entry) => entry.at(-1) === 81),
    );
    assert.ok(calls.some(([name]) => name === "session.engine"));
    assert.ok(calls.some(([name]) => name === "session.quicknetChainHash"));
    assert.ok(calls.some(([name]) => name === "session.generation"));
    assert.ok(calls.some(([name]) => name === "session.feePolicyDigest"));

    await assert.rejects(
        adapter.verifySessionContext(verifiedContext({generation: "8"})),
        {code: "SESSION_CONTEXT_MISMATCH"},
    );
    canonical = false;
    await assert.rejects(
        adapter.verifySessionContext(verifiedContext()),
        {code: "SESSION_CONTEXT_MISMATCH"},
    );
    canonical = true;
    committer = OTHER_ACCOUNT;
    await assert.rejects(
        adapter.observePlacement(baseContext()),
        {code: "COMMITMENT_OWNER_MISMATCH"},
    );
    committer = ACCOUNT;
    cancelled = true;
    engineCredit = 25n;
    assert.deepEqual(await adapter.observeCancellation(baseContext()), {
        status: "CANCELLED",
        commitment: COMMITMENT,
        engineCredit: "25",
    });
    await assert.rejects(
        adapter.cancel(baseContext()),
        {code: "CHAIN_CANCELLATION_UNCONFIRMED"},
    );
    engineCredit = 0n;
    assert.deepEqual(await adapter.cancel(baseContext()), {status: "CONFIRMED"});

    const wrongChain = new HederaTimedTicketChainAdapter({
        provider: {
            ...provider,
            async send() {
                return "0x127";
            },
        },
        engineAddress: ENGINE,
        releaseConfig: chainReleaseConfig(),
        pools: chainPools(),
        engineContract: engine,
        factoryContract: factory,
        sessionContractFactory: () => session,
        routerContractFactory: router,
    });
    await assert.rejects(wrongChain.initialize(), {code: "CHAIN_MISMATCH"});
});

function relayHarness() {
    const receipts = new Map();
    const pending = new Map();
    const events = [];
    const calls = {
        receipt: 0,
        transaction: 0,
        placement: 0,
        reveal: 0,
        cancellation: 0,
        release: 0,
        routing: 0,
        balance: 0,
    };
    const state = {
        placement: "ABSENT",
        reveal: "REVEALABLE",
        cancellation: "CANCELLABLE",
        cancellationCredit: "0",
        cancelCreditOnCancel: "100",
        release: "RELEASABLE",
        routing: "UNSPENT",
        relayerBalance: 100_000_000n,
    };
    const provider = {
        async getNetwork() {
            return {chainId: 296n};
        },
        async send(method, params) {
            assert.equal(method, "eth_chainId");
            assert.deepEqual(params, []);
            return "0x128";
        },
        async getFeeData() {
            return {gasPrice: 10n, maxFeePerGas: null};
        },
        async getBalance(address, blockTag) {
            calls.balance += 1;
            assert.match(address, /^0x[0-9a-f]{40}$/);
            assert.equal(blockTag, 91);
            return state.relayerBalance;
        },
        async getTransactionCount(address, tag) {
            assert.match(address, /^0x[0-9a-f]{40}$/);
            assert.equal(tag, "pending");
            return 4;
        },
        async getTransactionReceipt(hash) {
            calls.receipt += 1;
            return receipts.get(hash) ?? null;
        },
        async getTransaction(hash) {
            calls.transaction += 1;
            return pending.get(hash) ?? null;
        },
        async getBlock(tag) {
            assert.equal(tag, "latest");
            return {number: 91, timestamp: 1_040};
        },
        async call(transaction) {
            events.push("simulate");
            assert.equal(transaction.blockTag, 91);
            assert.ok([ACCOUNT, HBAR_POOL, LPRC_POOL].includes(transaction.to));
            return "0x";
        },
        async broadcastTransaction(raw) {
            events.push("broadcast");
            const transaction = Transaction.from(raw);
            const selector = transaction.data.slice(0, 10);
            if (selector === SESSION_INTERFACE.getFunction("placeSealed").selector) {
                state.placement = "PLACED";
            } else if (
                selector
                === SESSION_INTERFACE.getFunction("revealAuthorized").selector
            ) {
                state.reveal = "REVEALED";
            } else if (
                selector
                === SESSION_INTERFACE.getFunction("cancelAuthorized").selector
            ) {
                state.cancellation = "CANCELLED";
                state.cancellationCredit = state.cancelCreditOnCancel;
            } else if (selector === SESSION_INTERFACE.getFunction("expire").selector) {
                state.release = "SWEEP_REQUIRED";
            } else if (
                selector
                === SESSION_INTERFACE.getFunction("sweepEngineCredit").selector
            ) {
                if (
                    state.cancellation === "CANCELLED"
                    && state.cancellationCredit !== "0"
                ) {
                    state.cancellationCredit = "0";
                } else {
                    state.release = "RELEASED";
                }
            } else {
                state.routing = "SPENT";
            }
            receipts.set(transaction.hash, {
                hash: transaction.hash,
                status: 1,
            });
            return {
                hash: transaction.hash,
                async wait() {
                    return receipts.get(transaction.hash);
                },
            };
        },
    };
    const chainAdapter = {
        async initialize() {},
        async verifySessionContext(request) {
            assert.equal(request.generation, "7");
            assert.equal(request.feePolicyDigest, FEE_POLICY);
            return {status: "VERIFIED"};
        },
        async querySessionContext() {
            return {
                generation: "7",
                feePolicyDigest: FEE_POLICY,
            };
        },
        async observePlacement() {
            calls.placement += 1;
            return state.placement === "PLACED"
                ? {
                    status: "PLACED",
                    commitment: COMMITMENT,
                    commitTime: "1000",
                    revealDelay: "30",
                    revealWindow: "270",
                }
                : {status: "ABSENT"};
        },
        async recheckBeforeReveal(request) {
            calls.reveal += 1;
            return {
                status: state.reveal,
                commitment: request.engineCommitment,
            };
        },
        async observeCancellation(request) {
            calls.cancellation += 1;
            return {
                status: state.cancellation,
                commitment: request.engineCommitment,
                engineCredit: state.cancellationCredit,
            };
        },
        async observeRelease(request) {
            calls.release += 1;
            return {
                status: state.release,
                commitment: request.engineCommitment,
                retired: ["SWEEP_REQUIRED", "RELEASED"].includes(state.release),
                currentRound: "3",
                lastRound: "2",
                engineCredit: state.release === "SWEEP_REQUIRED" ? "100" : "0",
            };
        },
        routingPool(asset) {
            const pool = chainPools()[asset];
            return {assetName: asset, ...pool};
        },
        async verifyRoutingContext(request) {
            calls.routing += 1;
            return {status: state.routing, nullifier: request.nullifier};
        },
        async observeRoutingWithdrawal(request) {
            calls.routing += 1;
            return {status: state.routing, nullifier: request.nullifier};
        },
    };
    return {provider, chainAdapter, receipts, pending, events, calls, state};
}

function revealRequest(overrides = {}) {
    return {
        ...verifiedContext({engineCommitment: REVEAL_COMMITMENT}),
        side: "BUY",
        price: "123456789",
        quantity: "7",
        randomSalt: RANDOM_SALT,
        ...overrides,
    };
}

function placeRequest(overrides = {}) {
    return {
        ...verifiedContext(),
        signature: LOW_SIGNATURE,
        ...overrides,
    };
}

function releaseRequest(overrides = {}) {
    const {
        generation: omittedGeneration,
        feePolicyDigest: omittedPolicy,
        ...request
    } = verifiedContext();
    return {...request, ...overrides};
}

function routingRequest(overrides = {}) {
    const root = "1234";
    const bridge = "4321";
    const recipient = BigInt(ACCOUNT).toString();
    const pool = BigInt(HBAR_POOL).toString();
    const ciphertext = {
        encryptedCommitment: "9001",
        tag: "9002",
        ephemeralX: "9003",
        ephemeralY: "9004",
    };
    const withdrawalSignals = [
        "7001",
        bridge,
        root,
        recipient,
        pool,
        "0",
        "100000000",
        "296",
    ];
    const complianceSignals = [
        ciphertext.encryptedCommitment,
        ciphertext.tag,
        ciphertext.ephemeralX,
        ciphertext.ephemeralY,
        bridge,
        root,
        recipient,
        pool,
        "0",
        "100000000",
        "296",
        "1",
        "2",
        "3",
    ];
    return {
        action: "route-withdrawal",
        chainId: "296",
        pool: HBAR_POOL,
        recipient: ACCOUNT,
        asset: "HBAR",
        denomination: "100000000",
        root,
        ciphertext,
        withdrawal: {
            proof: Array(24).fill("5"),
            publicSignals: withdrawalSignals,
        },
        compliance: {
            proof: Array(24).fill("6"),
            publicSignals: complianceSignals,
        },
        ...overrides,
    };
}

test("relayer durably signs exact reveal bytes, reuses them, and enforces gas caps", async () => {
    const root = await temporaryDirectory();
    const relay = relayHarness();
    const store = new DurablePrivateRelayStore({directory: root});
    const signer = new Wallet(RELAYER_KEY);
    const relayer = new EthersPrivateTradingRelayer({
        provider: relay.provider,
        signer,
        transactionStore: store,
        chainAdapter: relay.chainAdapter,
        maxGasPriceWei: 20n,
    });
    const prepared = await relayer.prepareReveal(revealRequest());
    assert.equal(prepared.handle, privateRelayHandle("reveal", TICKET_ID));
    assert.match(prepared.byteDigest, /^sha256:[0-9a-f]{64}$/);

    const persisted = await store.read(prepared.handle);
    const signed = Transaction.from(
        `0x${persisted.signedTransaction.toString("hex")}`,
    );
    assert.equal(signed.chainId, 296n);
    assert.equal(signed.to.toLowerCase(), ACCOUNT);
    assert.equal(signed.gasPrice, 10n);
    assert.equal(signed.gasLimit, PRIVATE_TRADING_DEFAULT_GAS_LIMITS.buy);
    const decoded = SESSION_INTERFACE.decodeFunctionData(
        "revealAuthorized",
        signed.data,
    );
    assert.equal(decoded.side, 0n);
    assert.equal(decoded.price, 123456789n);
    assert.equal(decoded.qty, 7n);
    assert.equal(decoded.randomSalt, RANDOM_SALT);
    assert.equal(
        (await stat(path.join(root, prepared.handle, "transaction.bin"))).mode & 0o777,
        0o600,
    );
    const metadata = await readFile(
        path.join(root, prepared.handle, "record.json"),
        "utf8",
    );
    assert.equal(metadata.includes(RANDOM_SALT.slice(2)), false);
    assert.equal(metadata.includes("123456789"), false);
    const originalBytes = Buffer.from(persisted.signedTransaction);
    persisted.calldata.fill(0);
    persisted.signedTransaction.fill(0);

    const restarted = new EthersPrivateTradingRelayer({
        provider: relay.provider,
        signer,
        transactionStore: new DurablePrivateRelayStore({directory: root}),
        chainAdapter: relay.chainAdapter,
        maxGasPriceWei: 20n,
    });
    const retry = await restarted.prepareReveal(revealRequest());
    assert.deepEqual(retry, prepared);
    const retriedRecord = await store.read(prepared.handle);
    assert.deepEqual(retriedRecord.signedTransaction, originalBytes);
    retriedRecord.calldata.fill(0);
    retriedRecord.signedTransaction.fill(0);

    const result = await restarted.broadcastPrepared({
        ticketId: TICKET_ID,
        handle: prepared.handle,
        byteDigest: prepared.byteDigest,
    });
    assert.equal(result.status, "CONFIRMED");
    assert.match(result.transactionHash, /^0x[0-9a-f]{64}$/);
    assert.ok(relay.calls.receipt > 0);
    assert.ok(relay.calls.reveal > 0);
    assert.ok(relay.calls.balance >= 2);

    assert.throws(
        () => new EthersPrivateTradingRelayer({
            provider: relay.provider,
            signer,
            transactionStore: store,
            chainAdapter: relay.chainAdapter,
            maxGasPriceWei: 20n,
            gasLimits: {
                ...PRIVATE_TRADING_DEFAULT_GAS_LIMITS,
                sell: PRIVATE_TRADING_GAS_LIMIT_CAPS.sell + 1n,
            },
        }),
        {code: "GAS_LIMIT_CAP_EXCEEDED"},
    );

    const transactionFile = path.join(root, prepared.handle, "transaction.bin");
    const tampered = await readFile(transactionFile);
    tampered[10] ^= 1;
    await writeFile(transactionFile, tampered, {mode: 0o600});
    await assert.rejects(store.read(prepared.handle), {code: "RELAY_STORE_CORRUPT"});
});

test("place relay accepts only the fixed call and simulates before any submission", async () => {
    const root = await temporaryDirectory();
    const relay = relayHarness();
    const store = new DurablePrivateRelayStore({directory: root});
    const relayer = new EthersPrivateTradingRelayer({
        provider: relay.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: store,
        chainAdapter: relay.chainAdapter,
        maxGasPriceWei: 20n,
    });
    const result = await relayer.relayPlace(placeRequest());
    assert.equal(result.status, "CONFIRMED");
    assert.deepEqual(relay.events, ["simulate", "broadcast"]);
    assert.equal(relay.calls.balance, 2);
    const record = await store.read(privateRelayHandle("place", TICKET_ID));
    const transaction = Transaction.from(
        `0x${record.signedTransaction.toString("hex")}`,
    );
    assert.equal(transaction.to.toLowerCase(), ACCOUNT);
    assert.equal(transaction.value, 0n);
    assert.equal(transaction.gasLimit, PRIVATE_TRADING_DEFAULT_GAS_LIMITS.place);
    const decoded = SESSION_INTERFACE.decodeFunctionData("placeSealed", transaction.data);
    assert.equal(decoded.commitment, COMMITMENT);
    assert.equal(decoded.envelopeDigest, ENVELOPE_DIGEST);
    assert.equal(decoded.quicknetRound, 15n);
    assert.equal(decoded.signature, placeRequest().signature);
    record.calldata.fill(0);
    record.signedTransaction.fill(0);

    await assert.rejects(
        relayer.relayPlace({...placeRequest(), extra: true}),
        {code: "RELAY_REQUEST_INVALID"},
    );

    const refusingRelay = relayHarness();
    refusingRelay.provider.call = async () => {
        refusingRelay.events.push("simulate");
        throw new Error("private revert detail");
    };
    const refusingStore = new DurablePrivateRelayStore({
        directory: await temporaryDirectory(),
    });
    const refusingRelayer = new EthersPrivateTradingRelayer({
        provider: refusingRelay.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: refusingStore,
        chainAdapter: refusingRelay.chainAdapter,
        maxGasPriceWei: 20n,
    });
    await assert.rejects(
        refusingRelayer.relayPlace(placeRequest({ticketId: "ab".repeat(32)})),
        {code: "SIMULATION_REFUSED"},
    );
    assert.deepEqual(refusingRelay.events, ["simulate"]);
    assert.deepEqual(await refusingStore.list(), []);
});

test("place relay resumes exact prepared bytes after a crash and rechecks session context", async () => {
    const root = await temporaryDirectory();
    const relay = relayHarness();
    const firstStore = new DurablePrivateRelayStore({directory: root});
    const first = new EthersPrivateTradingRelayer({
        provider: relay.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: firstStore,
        chainAdapter: relay.chainAdapter,
        maxGasPriceWei: 20n,
    });
    const prepared = await first.preparePlace(placeRequest());
    const before = await firstStore.read(prepared.handle);
    const exactBytes = Buffer.from(before.signedTransaction);
    before.calldata.fill(0);
    before.signedTransaction.fill(0);
    assert.deepEqual(relay.events, ["simulate"]);

    const restarted = new EthersPrivateTradingRelayer({
        provider: relay.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: new DurablePrivateRelayStore({directory: root}),
        chainAdapter: relay.chainAdapter,
        maxGasPriceWei: 20n,
    });
    const result = await restarted.broadcastPlacePrepared({
        ticketId: TICKET_ID,
        handle: prepared.handle,
        byteDigest: prepared.byteDigest,
    });
    assert.equal(result.status, "CONFIRMED");
    assert.deepEqual(relay.events, ["simulate", "broadcast"]);
    const after = await firstStore.read(prepared.handle);
    assert.deepEqual(after.signedTransaction, exactBytes);
    after.calldata.fill(0);
    after.signedTransaction.fill(0);
    exactBytes.fill(0);

    const mismatchedRelay = relayHarness();
    mismatchedRelay.state.placement = "PLACED";
    mismatchedRelay.chainAdapter.verifySessionContext = async () => {
        throw Object.assign(new Error("private chain detail"), {
            code: "SESSION_CONTEXT_MISMATCH",
        });
    };
    const mismatched = new EthersPrivateTradingRelayer({
        provider: mismatchedRelay.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: new DurablePrivateRelayStore({
            directory: await temporaryDirectory(),
        }),
        chainAdapter: mismatchedRelay.chainAdapter,
        maxGasPriceWei: 20n,
    });
    await assert.rejects(
        mismatched.relayPlace(placeRequest()),
        {code: "SESSION_CONTEXT_MISMATCH"},
    );
    assert.deepEqual(mismatchedRelay.events, []);
});

test("reconciliation uses transaction hash and chain state before retry", async () => {
    const root = await temporaryDirectory();
    const relay = relayHarness();
    const store = new DurablePrivateRelayStore({directory: root});
    const relayer = new EthersPrivateTradingRelayer({
        provider: relay.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: store,
        chainAdapter: relay.chainAdapter,
        maxGasPriceWei: 20n,
    });
    const request = revealRequest({ticketId: "aa".repeat(32)});
    const prepared = await relayer.prepareReveal(request);
    relay.state.reveal = "REVEALED";
    const result = await relayer.reconcilePrepared({
        ticketId: request.ticketId,
        handle: prepared.handle,
        byteDigest: prepared.byteDigest,
    });
    assert.deepEqual(result, {status: "CONFIRMED", transactionHash: null});
    assert.equal(relay.events.includes("broadcast"), false);
    assert.ok(relay.calls.receipt > 0);
    assert.ok(relay.calls.transaction > 0);
    assert.ok(relay.calls.reveal > 0);
});

test("signed cancellation is durable across response loss and rejects high-s signatures", async () => {
    const root = await temporaryDirectory();
    const relay = relayHarness();
    const store = new DurablePrivateRelayStore({directory: root});
    const relayer = new EthersPrivateTradingRelayer({
        provider: relay.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: store,
        chainAdapter: relay.chainAdapter,
        maxGasPriceWei: 20n,
    });
    const request = placeRequest({ticketId: "ca".repeat(32)});
    const first = await relayer.relayCancel(request);
    assert.equal(first.status, "CONFIRMED");
    assert.match(first.transactionHash, /^0x[0-9a-f]{64}$/);
    assert.match(first.sweepTransactionHash, /^0x[0-9a-f]{64}$/);
    assert.deepEqual(
        relay.events,
        ["simulate", "broadcast", "simulate", "broadcast"],
    );
    assert.equal(relay.calls.balance, 4);

    const record = await store.read(privateRelayHandle("cancel", request.ticketId));
    const transaction = Transaction.from(
        `0x${record.signedTransaction.toString("hex")}`,
    );
    assert.equal(transaction.to.toLowerCase(), ACCOUNT);
    assert.equal(transaction.gasLimit, PRIVATE_TRADING_DEFAULT_GAS_LIMITS.cancel);
    const decoded = SESSION_INTERFACE.decodeFunctionData(
        "cancelAuthorized",
        transaction.data,
    );
    assert.equal(decoded.commitment, COMMITMENT);
    assert.equal(decoded.envelopeDigest, ENVELOPE_DIGEST);
    assert.equal(decoded.quicknetRound, 15n);
    assert.equal(decoded.signature, LOW_SIGNATURE);
    record.calldata.fill(0);
    record.signedTransaction.fill(0);
    const sweepRecord = await store.read(
        privateRelayHandle("cancel-sweep", request.ticketId),
    );
    const sweepTransaction = Transaction.from(
        `0x${sweepRecord.signedTransaction.toString("hex")}`,
    );
    assert.equal(
        SESSION_INTERFACE.parseTransaction({data: sweepTransaction.data}).name,
        "sweepEngineCredit",
    );
    assert.equal(
        sweepTransaction.gasLimit,
        PRIVATE_TRADING_DEFAULT_GAS_LIMITS.sweep,
    );
    sweepRecord.calldata.fill(0);
    sweepRecord.signedTransaction.fill(0);

    const restarted = new EthersPrivateTradingRelayer({
        provider: relay.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: new DurablePrivateRelayStore({directory: root}),
        chainAdapter: relay.chainAdapter,
        maxGasPriceWei: 20n,
    });
    const retry = await restarted.relayCancel(request);
    assert.deepEqual(retry, first);
    assert.deepEqual(
        relay.events,
        ["simulate", "broadcast", "simulate", "broadcast"],
    );
    assert.equal(relay.calls.balance, 4);

    const highS = `0x${"01".padStart(64, "0")}${
        (0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a1n)
            .toString(16).padStart(64, "0")
    }1b`;
    await assert.rejects(
        relayer.relayCancel(placeRequest({
            ticketId: "cb".repeat(32),
            signature: highS,
        })),
        {code: "SIGNATURE_INVALID"},
    );

    const noCreditRelay = relayHarness();
    noCreditRelay.state.cancelCreditOnCancel = "0";
    const noCredit = new EthersPrivateTradingRelayer({
        provider: noCreditRelay.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: new DurablePrivateRelayStore({
            directory: await temporaryDirectory(),
        }),
        chainAdapter: noCreditRelay.chainAdapter,
        maxGasPriceWei: 20n,
    });
    const noCreditResult = await noCredit.relayCancel(
        placeRequest({ticketId: "ce".repeat(32)}),
    );
    assert.equal(noCreditResult.status, "CONFIRMED");
    assert.equal(noCreditResult.sweepTransactionHash, null);
    assert.deepEqual(noCreditRelay.events, ["simulate", "broadcast"]);
});

test("cancellation restart reconciles cancel before independently sweeping credit", async () => {
    const root = await temporaryDirectory();
    const relay = relayHarness();
    const call = relay.provider.call.bind(relay.provider);
    let simulations = 0;
    relay.provider.call = async (transaction) => {
        simulations += 1;
        if (simulations === 2) {
            relay.events.push("simulate");
            throw new Error("lost before sweep broadcast");
        }
        return call(transaction);
    };
    const request = placeRequest({ticketId: "cf".repeat(32)});
    const first = new EthersPrivateTradingRelayer({
        provider: relay.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: new DurablePrivateRelayStore({directory: root}),
        chainAdapter: relay.chainAdapter,
        maxGasPriceWei: 20n,
    });
    await assert.rejects(
        first.relayCancel(request),
        {code: "SIMULATION_REFUSED"},
    );
    assert.equal(relay.state.cancellation, "CANCELLED");
    assert.equal(relay.state.cancellationCredit, "100");
    assert.deepEqual(relay.events, ["simulate", "broadcast", "simulate"]);

    relay.provider.call = call;
    const restarted = new EthersPrivateTradingRelayer({
        provider: relay.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: new DurablePrivateRelayStore({directory: root}),
        chainAdapter: relay.chainAdapter,
        maxGasPriceWei: 20n,
    });
    const recovered = await restarted.relayCancel(request);
    assert.equal(recovered.status, "CONFIRMED");
    assert.match(recovered.transactionHash, /^0x[0-9a-f]{64}$/);
    assert.match(recovered.sweepTransactionHash, /^0x[0-9a-f]{64}$/);
    assert.equal(relay.state.cancellationCredit, "0");
    assert.deepEqual(
        relay.events,
        ["simulate", "broadcast", "simulate", "simulate", "broadcast"],
    );
});

test("release expires then sweeps and recovers both confirmed hashes after response loss", async () => {
    const root = await temporaryDirectory();
    const relay = relayHarness();
    const store = new DurablePrivateRelayStore({directory: root});
    const relayer = new EthersPrivateTradingRelayer({
        provider: relay.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: store,
        chainAdapter: relay.chainAdapter,
        maxGasPriceWei: 20n,
    });
    const request = releaseRequest({ticketId: "cc".repeat(32)});
    const first = await relayer.relayRelease(request);
    assert.equal(first.status, "CONFIRMED");
    assert.match(first.transactionHash, /^0x[0-9a-f]{64}$/);
    assert.match(first.sweepTransactionHash, /^0x[0-9a-f]{64}$/);
    assert.deepEqual(
        relay.events,
        ["simulate", "broadcast", "simulate", "broadcast"],
    );
    assert.equal(relay.calls.balance, 4);
    for (const [kind, functionName, gasLimit] of [
        ["expire", "expire", PRIVATE_TRADING_DEFAULT_GAS_LIMITS.expire],
        ["sweep", "sweepEngineCredit", PRIVATE_TRADING_DEFAULT_GAS_LIMITS.sweep],
    ]) {
        const record = await store.read(privateRelayHandle(kind, request.ticketId));
        const transaction = Transaction.from(
            `0x${record.signedTransaction.toString("hex")}`,
        );
        assert.equal(transaction.gasLimit, gasLimit);
        assert.equal(
            SESSION_INTERFACE.parseTransaction({data: transaction.data}).name,
            functionName,
        );
        record.calldata.fill(0);
        record.signedTransaction.fill(0);
    }

    const restarted = new EthersPrivateTradingRelayer({
        provider: relay.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: new DurablePrivateRelayStore({directory: root}),
        chainAdapter: relay.chainAdapter,
        maxGasPriceWei: 20n,
    });
    assert.deepEqual(await restarted.relayRelease(request), first);
    assert.deepEqual(
        relay.events,
        ["simulate", "broadcast", "simulate", "broadcast"],
    );

    const resting = relayHarness();
    resting.state.release = "RESTING";
    const refusing = new EthersPrivateTradingRelayer({
        provider: resting.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: new DurablePrivateRelayStore({
            directory: await temporaryDirectory(),
        }),
        chainAdapter: resting.chainAdapter,
        maxGasPriceWei: 20n,
    });
    await assert.rejects(
        refusing.relayRelease(releaseRequest({ticketId: "cd".repeat(32)})),
        {code: "RELEASE_STATE_REFUSED"},
    );
    assert.deepEqual(resting.events, []);
});

test("routing pins every public signal and durably relays only allowlisted withdraw", async () => {
    const root = await temporaryDirectory();
    const relay = relayHarness();
    const store = new DurablePrivateRelayStore({directory: root});
    const relayer = new EthersPrivateTradingRelayer({
        provider: relay.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: store,
        chainAdapter: relay.chainAdapter,
        maxGasPriceWei: 20n,
    });
    const request = routingRequest();
    const first = await relayer.relayRoutingWithdrawal(request);
    assert.equal(first.status, "CONFIRMED");
    assert.match(first.txHash, /^0x[0-9a-f]{64}$/);
    assert.deepEqual(relay.events, ["simulate", "broadcast"]);
    assert.equal(relay.calls.balance, 2);

    const routeId = BigInt(request.withdrawal.publicSignals[0])
        .toString(16).padStart(64, "0");
    const record = await store.read(privateRelayHandle("route", routeId));
    const transaction = Transaction.from(
        `0x${record.signedTransaction.toString("hex")}`,
    );
    assert.equal(transaction.to.toLowerCase(), HBAR_POOL);
    assert.equal(transaction.gasLimit, PRIVATE_TRADING_DEFAULT_GAS_LIMITS.route);
    const metadata = await readFile(
        path.join(root, privateRelayHandle("route", routeId), "record.json"),
        "utf8",
    );
    assert.equal(metadata.includes(request.ciphertext.encryptedCommitment), false);
    assert.equal(metadata.includes(request.withdrawal.proof.join(",")), false);
    record.calldata.fill(0);
    record.signedTransaction.fill(0);

    const restarted = new EthersPrivateTradingRelayer({
        provider: relay.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: new DurablePrivateRelayStore({directory: root}),
        chainAdapter: relay.chainAdapter,
        maxGasPriceWei: 20n,
    });
    assert.deepEqual(await restarted.relayRoutingWithdrawal(request), first);
    assert.deepEqual(relay.events, ["simulate", "broadcast"]);

    const tampered = routingRequest();
    tampered.compliance.publicSignals[5] = "1235";
    await assert.rejects(
        relayer.relayRoutingWithdrawal(tampered),
        {code: "ROUTING_SIGNAL_MISMATCH"},
    );
});

test("rebroadcast fails closed unless receipt and pending lookups complete", async () => {
    const relay = relayHarness();
    const store = new DurablePrivateRelayStore({
        directory: await temporaryDirectory(),
    });
    const relayer = new EthersPrivateTradingRelayer({
        provider: relay.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: store,
        chainAdapter: relay.chainAdapter,
        maxGasPriceWei: 20n,
    });
    const prepared = await relayer.prepareReveal(
        revealRequest({ticketId: "ac".repeat(32)}),
    );
    relay.provider.getTransactionReceipt = async () => {
        throw new Error(`private receipt detail ${RANDOM_SALT}`);
    };
    await assert.rejects(
        relayer.broadcastPrepared({
            ticketId: "ac".repeat(32),
            handle: prepared.handle,
            byteDigest: prepared.byteDigest,
        }),
        (error) => {
            assert.equal(error.code, "RECONCILIATION_FAILED");
            assert.equal(error.message.includes(RANDOM_SALT), false);
            return true;
        },
    );
    assert.equal(relay.events.includes("broadcast"), false);
});

test("dedicated relayer key never falls back and errors stay secret-free", async () => {
    assert.throws(
        () => loadPrivateTradingRelayerKey({
            HEDERA_PRIVATE_KEY: RELAYER_KEY,
            OPERATOR_PRIVATE_KEY: RELAYER_KEY,
        }),
        {code: "RELAYER_KEY_REQUIRED"},
    );
    assert.equal(
        loadPrivateTradingRelayerKey({PRIVATE_TRADING_RELAYER_KEY: RELAYER_KEY}),
        RELAYER_KEY,
    );

    const root = await temporaryDirectory();
    const relay = relayHarness();
    relay.provider.getFeeData = async () => ({gasPrice: 21n});
    const relayer = new EthersPrivateTradingRelayer({
        provider: relay.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: new DurablePrivateRelayStore({directory: root}),
        chainAdapter: relay.chainAdapter,
        maxGasPriceWei: 20n,
    });
    let caught;
    try {
        await relayer.prepareReveal(revealRequest());
    } catch (error) {
        caught = error;
    }
    assert.equal(caught.code, "GAS_PRICE_CAP_EXCEEDED");
    assert.equal(caught.message.includes(RANDOM_SALT.slice(2)), false);
    assert.equal(caught.message.includes("123456789"), false);
    assert.deepEqual(await new DurablePrivateRelayStore({directory: root}).list(), []);
});

test("relayer balance reserve gates signing and broadcasting across every path", async () => {
    const relayerFor = async (relay) => new EthersPrivateTradingRelayer({
        provider: relay.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: new DurablePrivateRelayStore({
            directory: await temporaryDirectory(),
        }),
        chainAdapter: relay.chainAdapter,
        maxGasPriceWei: 20n,
    });
    const tooLow = (gasLimit) =>
        RELAYER_RESERVE_WEI + gasLimit * 10n - 1n;

    const placement = relayHarness();
    placement.state.relayerBalance = tooLow(
        PRIVATE_TRADING_DEFAULT_GAS_LIMITS.place,
    );
    const placementRelayer = await relayerFor(placement);
    await assert.rejects(
        placementRelayer.relayPlace(
            placeRequest({ticketId: "d0".repeat(32)}),
        ),
        {code: "RELAYER_BALANCE_TOO_LOW"},
    );
    assert.deepEqual(placement.events, ["simulate"]);

    const reveal = relayHarness();
    reveal.state.relayerBalance = tooLow(
        PRIVATE_TRADING_DEFAULT_GAS_LIMITS.buy,
    );
    await assert.rejects(
        (await relayerFor(reveal)).prepareReveal(
            revealRequest({ticketId: "d1".repeat(32)}),
        ),
        {code: "RELAYER_BALANCE_TOO_LOW"},
    );
    assert.deepEqual(reveal.events, []);

    const cancellation = relayHarness();
    cancellation.state.relayerBalance = tooLow(
        PRIVATE_TRADING_DEFAULT_GAS_LIMITS.cancel,
    );
    await assert.rejects(
        (await relayerFor(cancellation)).relayCancel(
            placeRequest({ticketId: "d2".repeat(32)}),
        ),
        {code: "RELAYER_BALANCE_TOO_LOW"},
    );
    assert.deepEqual(cancellation.events, ["simulate"]);

    const cancellationSweep = relayHarness();
    let cancellationBalanceReads = 0;
    cancellationSweep.provider.getBalance = async (address, blockTag) => {
        assert.match(address, /^0x[0-9a-f]{40}$/);
        assert.equal(blockTag, 91);
        cancellationBalanceReads += 1;
        return cancellationBalanceReads <= 2
            ? 100_000_000n
            : tooLow(PRIVATE_TRADING_DEFAULT_GAS_LIMITS.sweep);
    };
    await assert.rejects(
        (await relayerFor(cancellationSweep)).relayCancel(
            placeRequest({ticketId: "d3".repeat(32)}),
        ),
        {code: "RELAYER_BALANCE_TOO_LOW"},
    );
    assert.equal(cancellationSweep.state.cancellation, "CANCELLED");
    assert.equal(cancellationSweep.state.cancellationCredit, "100");
    assert.deepEqual(
        cancellationSweep.events,
        ["simulate", "broadcast", "simulate"],
    );

    const expiry = relayHarness();
    expiry.state.relayerBalance = tooLow(
        PRIVATE_TRADING_DEFAULT_GAS_LIMITS.expire,
    );
    await assert.rejects(
        (await relayerFor(expiry)).relayRelease(
            releaseRequest({ticketId: "d4".repeat(32)}),
        ),
        {code: "RELAYER_BALANCE_TOO_LOW"},
    );
    assert.deepEqual(expiry.events, ["simulate"]);

    const releaseSweep = relayHarness();
    let releaseBalanceReads = 0;
    releaseSweep.provider.getBalance = async (address, blockTag) => {
        assert.match(address, /^0x[0-9a-f]{40}$/);
        assert.equal(blockTag, 91);
        releaseBalanceReads += 1;
        return releaseBalanceReads <= 2
            ? 100_000_000n
            : tooLow(PRIVATE_TRADING_DEFAULT_GAS_LIMITS.sweep);
    };
    await assert.rejects(
        (await relayerFor(releaseSweep)).relayRelease(
            releaseRequest({ticketId: "d5".repeat(32)}),
        ),
        {code: "RELAYER_BALANCE_TOO_LOW"},
    );
    assert.equal(releaseSweep.state.release, "SWEEP_REQUIRED");
    assert.deepEqual(
        releaseSweep.events,
        ["simulate", "broadcast", "simulate"],
    );

    const routing = relayHarness();
    routing.state.relayerBalance = tooLow(
        PRIVATE_TRADING_DEFAULT_GAS_LIMITS.route,
    );
    await assert.rejects(
        (await relayerFor(routing)).relayRoutingWithdrawal(routingRequest()),
        {code: "RELAYER_BALANCE_TOO_LOW"},
    );
    assert.deepEqual(routing.events, ["simulate"]);

    const signedThenDrained = relayHarness();
    const signedStore = new DurablePrivateRelayStore({
        directory: await temporaryDirectory(),
    });
    const signedRelayer = new EthersPrivateTradingRelayer({
        provider: signedThenDrained.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: signedStore,
        chainAdapter: signedThenDrained.chainAdapter,
        maxGasPriceWei: 20n,
    });
    const signedRequest = placeRequest({ticketId: "d6".repeat(32)});
    const prepared = await signedRelayer.preparePlace(signedRequest);
    signedThenDrained.state.relayerBalance = tooLow(
        PRIVATE_TRADING_DEFAULT_GAS_LIMITS.place,
    );
    await assert.rejects(
        signedRelayer.broadcastPlacePrepared({
            ticketId: signedRequest.ticketId,
            handle: prepared.handle,
            byteDigest: prepared.byteDigest,
        }),
        {code: "RELAYER_BALANCE_TOO_LOW"},
    );
    assert.deepEqual(signedThenDrained.events, ["simulate"]);
});

test("relayer balance observations are pinned, validated, and secret-free", async () => {
    const relay = relayHarness();
    const options = {
        provider: relay.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: new DurablePrivateRelayStore({
            directory: await temporaryDirectory(),
        }),
        chainAdapter: relay.chainAdapter,
        maxGasPriceWei: 20n,
    };
    assert.throws(
        () => new RuntimePrivateTradingRelayer(options),
        {code: "RELAYER_RESERVE_INVALID"},
    );

    const invalid = new EthersPrivateTradingRelayer(options);
    invalid.provider.getBalance = async () => "not-a-balance";
    await assert.rejects(
        invalid.prepareReveal(revealRequest({ticketId: "d7".repeat(32)})),
        {code: "RELAYER_BALANCE_INVALID"},
    );

    const secret = RANDOM_SALT.slice(2);
    const unavailableRelay = relayHarness();
    unavailableRelay.provider.getBalance = async () => {
        throw new Error(secret);
    };
    const unavailable = new EthersPrivateTradingRelayer({
        provider: unavailableRelay.provider,
        signer: new Wallet(RELAYER_KEY),
        transactionStore: new DurablePrivateRelayStore({
            directory: await temporaryDirectory(),
        }),
        chainAdapter: unavailableRelay.chainAdapter,
        maxGasPriceWei: 20n,
    });
    let caught;
    try {
        await unavailable.prepareReveal(
            revealRequest({ticketId: "d8".repeat(32)}),
        );
    } catch (error) {
        caught = error;
    }
    assert.equal(caught.code, "RELAYER_BALANCE_UNAVAILABLE");
    assert.equal(caught.message.includes(secret), false);
});

async function controllerHarness() {
    const root = await temporaryDirectory();
    const lockedKeyProvider = createInsecureTestLockedKeyProvider({crypto: webcrypto});
    const made = await createTimedTicketEnvelope({
        engine: ENGINE,
        sessionAccount: ACCOUNT,
        envelopeId: ENVELOPE_ID,
        targetRound: 1n,
        secret: {
            side: "BUY",
            price: 9n,
            quantity: 2n,
            randomSalt: RANDOM_SALT,
        },
        generation: 7n,
        feePolicyDigest: FEE_POLICY,
        lockedKeyProvider,
        crypto: webcrypto,
        allowInsecureTestProvider: true,
    });
    const store = new DurableTimedTicketStore({
        directory: path.join(root, "tickets"),
        crypto: webcrypto,
    });
    const contextChecks = [];
    let placement = "ABSENT";
    const chainAdapter = {
        async observePlacement(request) {
            return placement === "ABSENT"
                ? {status: "ABSENT"}
                : {
                    status: "PLACED",
                    commitment: request.engineCommitment,
                    commitTime: QUICKNET_GENESIS_TIME.toString(),
                    revealDelay: "0",
                    revealWindow: "270",
                };
        },
        async verifySessionContext(request) {
            contextChecks.push(request);
            assert.equal(request.generation, "7");
            assert.equal(request.feePolicyDigest, FEE_POLICY);
            return {status: "VERIFIED"};
        },
        async recheckBeforeReveal(request) {
            return {
                status: "REVEALABLE",
                commitment: request.engineCommitment,
            };
        },
        async cancel() {
            return {status: "CONFIRMED"};
        },
    };
    const revealAdapter = {
        async prepareReveal() {
            throw new Error("not used");
        },
        async broadcastPrepared() {
            throw new Error("not used");
        },
        async reconcilePrepared() {
            throw new Error("not used");
        },
    };
    const service = new TimedTicketCustodyService({
        store,
        lockedKeyProvider,
        chainAdapter,
        revealAdapter,
        nowSeconds: () => QUICKNET_GENESIS_TIME,
        crypto: webcrypto,
        allowInsecureTestProvider: true,
    });
    const placeCalls = [];
    const controller = new PrivateTradingController({
        service,
        placeRelayer: {
            async relayPlace(request) {
                placeCalls.push(request);
                placement = "PLACED";
                return {
                    status: "CONFIRMED",
                    transactionHash: `0x${"bb".repeat(32)}`,
                };
            },
            async relayCancel(request) {
                assert.equal(request.signature, LOW_SIGNATURE);
                placement = "PLACED";
                return {
                    status: "CONFIRMED",
                    transactionHash: `0x${"bd".repeat(32)}`,
                    sweepTransactionHash: `0x${"c0".repeat(32)}`,
                };
            },
            async relayRelease() {
                return {
                    status: "CONFIRMED",
                    transactionHash: `0x${"be".repeat(32)}`,
                    sweepTransactionHash: `0x${"bf".repeat(32)}`,
                };
            },
        },
    });
    return {controller, made, placeCalls, contextChecks};
}

test("HTTP-neutral controller requires capabilities, exact envelopes, strict bodies, and no wallet auth", async () => {
    const {controller, made, placeCalls, contextChecks} = await controllerHarness();
    const prearmed = await controller.handle({
        method: "POST",
        path: PRIVATE_TRADING_ROUTES.tickets,
        headers: {
            authorization: `Bearer ${CAPABILITY}`,
            "content-type": "application/octet-stream",
            "content-length": String(made.envelope.length),
        },
        body: made.envelope,
    });
    assert.equal(prearmed.status, 201);
    const id = prearmed.body.result.ticketId;
    assert.equal(prearmed.body.result.capability, undefined);

    const readback = await controller.handle({
        method: "GET",
        path: `${PRIVATE_TRADING_ROUTES.tickets}/${id}/envelope`,
        headers: {authorization: `Bearer ${CAPABILITY}`},
        body: new Uint8Array(),
    });
    assert.equal(readback.status, 200);
    assert.deepEqual(readback.body, Buffer.from(made.envelope));
    assert.equal(
        readback.headers.etag,
        `"${prearmed.body.result.byteDigest}"`,
    );
    readback.body.fill(0);

    await assert.rejects(
        controller.handle({
            method: "GET",
            path: `${PRIVATE_TRADING_ROUTES.tickets}/${id}`,
            headers: {},
            body: new Uint8Array(),
        }),
        {code: "CAPABILITY_REQUIRED", status: 401},
    );
    await assert.rejects(
        controller.handle({
            method: "GET",
            path: `${PRIVATE_TRADING_ROUTES.tickets}/${id}`,
            headers: {authorization: [`Bearer ${CAPABILITY}`]},
            body: new Uint8Array(),
        }),
        {code: "HEADERS_INVALID"},
    );
    await assert.rejects(
        controller.handle({
            method: "POST",
            path: PRIVATE_TRADING_ROUTES.tickets,
            headers: {
                authorization: `Bearer ${CAPABILITY}`,
                "content-type": "application/octet-stream",
            },
            body: made.envelope.slice(1),
        }),
        {code: "ENVELOPE_SIZE_INVALID", status: 413},
    );

    const placeBody = {
        commitment: made.engineCommitment,
        envelopeDigest: made.envelopeDigest,
        feePolicyDigest: FEE_POLICY,
        generation: "7",
        quicknetRound: "1",
        signature: LOW_SIGNATURE,
    };
    const encoded = Buffer.from(JSON.stringify(placeBody), "utf8");
    const placed = await controller.handle({
        method: "POST",
        path: `${PRIVATE_TRADING_ROUTES.orders}/${id}/place`,
        headers: {
            authorization: `Bearer ${CAPABILITY}`,
            "content-type": "application/json",
            "content-length": String(encoded.length),
        },
        body: encoded,
    });
    assert.equal(placed.body.result.status, "CONFIRMED");
    assert.equal(placeCalls.length, 1);
    assert.equal(placeCalls[0].ticketId, id);
    assert.equal(Object.hasOwn(placeCalls[0], "wallet"), false);
    await assert.rejects(
        controller.placeSealed({
            ticketId: id,
            capability: CAPABILITY,
            body: {...placeBody, wallet: OTHER_ACCOUNT},
        }),
        {code: "REQUEST_SCHEMA_INVALID"},
    );
    assert.equal(placeCalls.length, 1);

    const oversized = Buffer.alloc(PRIVATE_TRADING_BODY_LIMITS.json + 1, 0x20);
    await assert.rejects(
        controller.handle({
            method: "POST",
            path: `${PRIVATE_TRADING_ROUTES.orders}/${id}/place`,
            headers: {
                authorization: `Bearer ${CAPABILITY}`,
                "content-type": "application/json",
            },
            body: oversized,
        }),
        {code: "BODY_TOO_LARGE", status: 413},
    );

    const recovery = await controller.handle({
        method: "POST",
        path: `${PRIVATE_TRADING_ROUTES.tickets}/${id}/recover`,
        headers: {authorization: `Bearer ${CAPABILITY}`},
        body: new Uint8Array(),
    });
    assert.equal(recovery.body.result.price, "9");
    assert.equal(recovery.body.result.quantity, "2");

    const cancelEncoded = Buffer.from(JSON.stringify(placeBody));
    const cancelled = await controller.handle({
        method: "POST",
        path: `${PRIVATE_TRADING_ROUTES.orders}/${id}/cancel`,
        headers: {
            authorization: `Bearer ${CAPABILITY}`,
            "content-type": "application/json",
        },
        body: cancelEncoded,
    });
    assert.equal(cancelled.body.result.status, "CONFIRMED");
    assert.match(cancelled.body.result.transactionHash, /^0x[0-9a-f]{64}$/);
    assert.match(
        cancelled.body.result.sweepTransactionHash,
        /^0x[0-9a-f]{64}$/,
    );
    const cancellationRetry = await controller.handle({
        method: "POST",
        path: `${PRIVATE_TRADING_ROUTES.orders}/${id}/cancel`,
        headers: {
            authorization: `Bearer ${CAPABILITY}`,
            "content-type": "application/json",
        },
        body: cancelEncoded,
    });
    assert.deepEqual(cancellationRetry.body.result, cancelled.body.result);
    assert.equal(contextChecks.length, 1);
});

test("controller uses split configurable route bases and exposes release only for revealed tickets", async () => {
    let state = "REVEALED";
    let cancellations = 0;
    let cancelRelays = 0;
    const summary = {
        state,
        chainId: "296",
        engine: ENGINE,
        sessionAccount: ACCOUNT,
        envelopeId: ENVELOPE_ID,
        envelopeDigest: ENVELOPE_DIGEST,
        engineCommitment: COMMITMENT,
        targetRound: "15",
    };
    const service = {
        async prearm() {
            throw new Error("not used");
        },
        async readback() {
            throw new Error("not used");
        },
        async summary() {
            return {...summary, state};
        },
        async cancel() {
            cancellations += 1;
            return {state: "CANCELLED"};
        },
        async manualRecovery() {
            throw new Error("not used");
        },
    };
    const relayer = {
        async relayPlace() {
            throw new Error("not used");
        },
        async relayCancel() {
            cancelRelays += 1;
            return {
                status: "UNKNOWN",
                transactionHash: `0x${"a1".repeat(32)}`,
            };
        },
        async relayRelease() {
            return {
                status: "CONFIRMED",
                transactionHash: `0x${"a2".repeat(32)}`,
                sweepTransactionHash: `0x${"a3".repeat(32)}`,
            };
        },
    };
    const controller = new PrivateTradingController({
        service,
        placeRelayer: relayer,
        ticketsBase: "/api/private/tickets",
        ordersBase: "/api/private/orders",
    });
    const status = await controller.handle({
        method: "GET",
        path: `/api/private/tickets/${TICKET_ID}`,
        headers: {authorization: `Bearer ${CAPABILITY}`},
        body: new Uint8Array(),
    });
    assert.equal(status.body.ok, true);
    assert.equal(status.body.result.state, "REVEALED");

    const released = await controller.handle({
        method: "POST",
        path: `/api/private/orders/${TICKET_ID}/release`,
        headers: {authorization: `Bearer ${CAPABILITY}`},
        body: new Uint8Array(),
    });
    assert.deepEqual(released.body, {
        ok: true,
        result: {
            status: "CONFIRMED",
            transactionHash: `0x${"a2".repeat(32)}`,
            sweepTransactionHash: `0x${"a3".repeat(32)}`,
        },
    });
    const releaseRetry = await controller.handle({
        method: "POST",
        path: `/api/private/orders/${TICKET_ID}/release`,
        headers: {authorization: `Bearer ${CAPABILITY}`},
        body: new Uint8Array(),
    });
    assert.deepEqual(releaseRetry.body, released.body);
    await assert.rejects(
        controller.handle({
            method: "POST",
            path: `${PRIVATE_TRADING_ROUTES.tickets}/${TICKET_ID}/place`,
            headers: {authorization: `Bearer ${CAPABILITY}`},
            body: new Uint8Array(),
        }),
        {code: "ROUTE_NOT_FOUND", status: 404},
    );

    state = "PLACED";
    await assert.rejects(
        controller.handle({
            method: "POST",
            path: `/api/private/orders/${TICKET_ID}/cancel`,
            headers: {
                authorization: `Bearer ${CAPABILITY}`,
                "content-type": "application/json",
            },
            body: new Uint8Array(),
        }),
        {code: "JSON_INVALID"},
    );
    const mismatched = {
        ...placeRequest(),
        commitment: `0x${"01".repeat(32)}`,
    };
    const mismatchedBytes = Buffer.from(JSON.stringify({
        commitment: mismatched.commitment,
        envelopeDigest: mismatched.envelopeDigest,
        feePolicyDigest: mismatched.feePolicyDigest,
        generation: mismatched.generation,
        quicknetRound: mismatched.targetRound,
        signature: mismatched.signature,
    }));
    await assert.rejects(
        controller.handle({
            method: "POST",
            path: `/api/private/orders/${TICKET_ID}/cancel`,
            headers: {
                authorization: `Bearer ${CAPABILITY}`,
                "content-type": "application/json",
            },
            body: mismatchedBytes,
        }),
        {code: "TICKET_CONTEXT_MISMATCH"},
    );
    assert.equal(cancelRelays, 0);
    assert.equal(cancellations, 0);

    const cancelBody = Buffer.from(JSON.stringify({
        commitment: COMMITMENT,
        envelopeDigest: ENVELOPE_DIGEST,
        feePolicyDigest: FEE_POLICY,
        generation: "7",
        quicknetRound: "15",
        signature: LOW_SIGNATURE,
    }));
    await assert.rejects(
        controller.handle({
            method: "POST",
            path: `/api/private/orders/${TICKET_ID}/cancel`,
            headers: {
                authorization: `Bearer ${CAPABILITY}`,
                "content-type": "application/json",
            },
            body: cancelBody,
        }),
        {code: "CANCELLATION_UNCONFIRMED", status: 502},
    );
    assert.equal(cancelRelays, 1);
    assert.equal(cancellations, 0);
});

test("routing controller enforces body bounds and returns direct secret-free results", async () => {
    const request = routingRequest();
    const encoded = Buffer.from(JSON.stringify(request));
    const controller = new PrivateRoutingController({
        path: "/api/private/routing",
        relayer: {
            async relayRoutingWithdrawal(value) {
                assert.deepEqual(value, request);
                return {
                    status: "CONFIRMED",
                    txHash: `0x${"a4".repeat(32)}`,
                };
            },
        },
    });
    const response = await controller.handle({
        method: "POST",
        path: "/api/private/routing",
        headers: {
            "content-type": "application/json",
            "content-length": String(encoded.length),
        },
        body: encoded,
    });
    assert.deepEqual(response.body, {
        status: "CONFIRMED",
        txHash: `0x${"a4".repeat(32)}`,
    });
    await assert.rejects(
        controller.handle({
            method: "POST",
            path: "/api/private/routing",
            headers: {"content-type": "application/json"},
            body: Buffer.alloc(PRIVATE_ROUTING_BODY_LIMIT + 1),
        }),
        {code: "BODY_TOO_LARGE", status: 413},
    );

    const secret = request.compliance.proof.join(",");
    const refusing = new PrivateRoutingController({
        relayer: {
            async relayRoutingWithdrawal() {
                throw new Error(secret);
            },
        },
    });
    await assert.rejects(
        refusing.handle({
            method: "POST",
            path: "/v1/private-trading/routing",
            headers: {"content-type": "application/json"},
            body: encoded,
        }),
        (error) => {
            assert.equal(error.code, "ROUTING_REQUEST_FAILED");
            assert.equal(error.message.includes(secret), false);
            return true;
        },
    );
});

test("runtime config requires canonical release addresses, denominations, and split paths", () => {
    const env = {
        PRIVATE_TRADING_STATE_DIR: "/tmp/private-trading-runtime-test",
        PRIVATE_TRADING_RPC_URL: "https://testnet.hashio.io/api",
        PRIVATE_TRADING_ENGINE_ADDRESS: ENGINE,
        PRIVATE_TRADING_FACTORY_ADDRESS: FACTORY,
        PRIVATE_TRADING_GATE_ADDRESS: GATE,
        PRIVATE_TRADING_REGISTRY_ADDRESS: REGISTRY,
        PRIVATE_TRADING_SECURITY_ADDRESS: SECURITY,
        PRIVATE_TRADING_PARTITION: PARTITION,
        PRIVATE_TRADING_RECOVERY_ROUTER_ADDRESS: RECOVERY_ROUTER,
        PRIVATE_TRADING_QUICKNET_CHAIN_HASH: `0x${QUICKNET_CHAIN_HASH}`,
        PRIVATE_TRADING_SESSION_CREATION_CODE_HASH:
            SESSION_CREATION_CODE_HASH,
        PRIVATE_TRADING_GENERATION: "7",
        PRIVATE_TRADING_FEE_POLICY_DIGEST: FEE_POLICY,
        PRIVATE_TRADING_HBAR_POOL_ADDRESS: HBAR_POOL,
        PRIVATE_TRADING_HBAR_DENOMINATION_TINYBAR: "100000000",
        PRIVATE_TRADING_LPRC_POOL_ADDRESS: LPRC_POOL,
        PRIVATE_TRADING_LPRC_DENOMINATION: "1000",
        PRIVATE_TRADING_TICKETS_BASE: "/api/private/tickets",
        PRIVATE_TRADING_ORDERS_BASE: "/api/private/orders",
        PRIVATE_TRADING_ROUTING_PATH: "/api/private/routing",
        PRIVATE_TRADING_SESSIONS_PATH: "/api/private/sessions",
        PRIVATE_TRADING_MAX_GAS_PRICE_WEI: "20",
        PRIVATE_TRADING_RELAYER_RESERVE_WEI: "0",
    };
    const config = privateTradingRuntimeConfig(env);
    assert.equal(config.releaseConfig.factory, FACTORY);
    assert.equal(config.relayerReserveWei, "0");
    assert.equal(config.pools.LPRC.asset, SECURITY);
    assert.deepEqual(config.routes, {
        tickets: "/api/private/tickets",
        orders: "/api/private/orders",
        routing: "/api/private/routing",
        sessions: "/api/private/sessions",
    });
    assert.deepEqual(config.registration.allowlist, {
        creationCodeHash: SESSION_CREATION_CODE_HASH,
        factory: FACTORY,
        gate: GATE,
        registry: REGISTRY,
        engine: ENGINE,
        security: SECURITY,
        partition: PARTITION,
        router: RECOVERY_ROUTER,
        quicknetChainHash: `0x${QUICKNET_CHAIN_HASH}`,
        feePolicyDigest: FEE_POLICY,
    });
    assert.deepEqual(config.recovery.allowlist, {
        factory: FACTORY,
        generation: "7",
        pools: {
            HBAR: {
                address: HBAR_POOL,
                asset: ZERO_ADDRESS,
                denomination: "100000000",
            },
            LPRC: {
                address: LPRC_POOL,
                asset: SECURITY,
                denomination: "1000",
            },
        },
        router: RECOVERY_ROUTER,
        security: SECURITY,
    });
    assert.equal(config.recovery.gasLimit, "4500000");
    assert.throws(
        () => privateTradingRuntimeConfig({
            ...env,
            PRIVATE_TRADING_FACTORY_ADDRESS: "",
        }),
        {code: "FACTORY_ADDRESS_REQUIRED"},
    );
    assert.throws(
        () => privateTradingRuntimeConfig({
            ...env,
            PRIVATE_TRADING_ROUTING_PATH: env.PRIVATE_TRADING_ORDERS_BASE,
        }),
        {code: "SERVICE_PATHS_CONFLICT"},
    );
    assert.throws(
        () => privateTradingRuntimeConfig({
            ...env,
            PRIVATE_TRADING_RELAYER_RESERVE_WEI: "-1",
        }),
        {code: "RELAYER_RESERVE_REQUIRED"},
    );
    assert.throws(
        () => privateTradingRuntimeConfig({
            ...env,
            PRIVATE_TRADING_RELAYER_RESERVE_WEI: (1n << 256n).toString(),
        }),
        {code: "RELAYER_RESERVE_REQUIRED"},
    );
});

test("worker entry pass rediscovers durable work and reports only public failure codes", async () => {
    let passes = 0;
    let purges = 0;
    const errors = [];
    const service = {
        async runPending() {
            passes += 1;
            return passes === 1
                ? [{
                    ticketId: TICKET_ID,
                    status: "ERROR",
                    code: "BEACON_UNAVAILABLE",
                }]
                : [{
                    ticketId: TICKET_ID,
                    status: "OK",
                    summary: {state: "REVEALED"},
                }];
        },
        async purgeExpired() {
            purges += 1;
            return [];
        },
    };
    const first = new PrivateTradingWorkerRunner({
        service,
        intervalMilliseconds: 250,
        errorSink: (error) => errors.push(error),
        unrefTimers: true,
    });
    const failedPass = await first.runOnce();
    assert.deepEqual(failedPass.failures, [{
        ticketId: TICKET_ID,
        code: "BEACON_UNAVAILABLE",
    }]);

    const restarted = new PrivateTradingWorkerRunner({
        service,
        intervalMilliseconds: 250,
        errorSink: (error) => errors.push(error),
        unrefTimers: true,
    });
    const recoveredPass = await restarted.runOnce();
    assert.equal(recoveredPass.ticketsVisited, 1);
    assert.deepEqual(recoveredPass.failures, []);
    assert.equal(passes, 2);
    assert.equal(purges, 2);
    assert.deepEqual(errors, []);
});

test("worker sanitizes fatal codes and ignores logging failures", async () => {
    const privateCode = `SECRET_${RANDOM_SALT}`;
    const observed = [];
    const runner = new PrivateTradingWorkerRunner({
        service: {
            async runPending() {
                throw Object.assign(new Error("private worker detail"), {
                    code: privateCode,
                });
            },
            async purgeExpired() {
                return [];
            },
        },
        errorSink: (value) => {
            observed.push(value);
            throw new Error("logger unavailable");
        },
    });
    await assert.rejects(
        runner.runOnce(),
        (error) => {
            assert.equal(error.code, "WORKER_RUN_FAILED");
            assert.equal(error.message.includes(RANDOM_SALT), false);
            return true;
        },
    );
    assert.deepEqual(observed, [{code: "WORKER_RUN_FAILED"}]);
});
