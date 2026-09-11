import assert from "node:assert/strict";
import {mkdtempSync} from "node:fs";
import {readdir, readFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    Interface,
    Transaction,
    Wallet,
    keccak256,
} from "ethers";

import {QUICKNET_CHAIN_HASH} from "../../tools/timed-ticket.mjs";
import {
    EthersPrivateSessionRecoveryAdapter,
    PRIVATE_SESSION_RECOVERY_ACCOUNT_ABI,
    PRIVATE_SESSION_RECOVERY_GAS_LIMIT,
} from "../runtime/private-session-recovery-chain.mjs";
import {
    PrivateSessionRecoveryController,
} from "../runtime/private-session-recovery-controller.mjs";
import {PrivateSessionController} from "../runtime/private-session-controller.mjs";
import {
    DurablePrivateRelayStore,
    privateRelayHandle,
} from "../runtime/private-relay-store.mjs";

const FACTORY = `0x${"11".repeat(20)}`;
const ROUTER = `0x${"22".repeat(20)}`;
const SECURITY = `0x${"33".repeat(20)}`;
const HBAR_POOL = `0x${"44".repeat(20)}`;
const LPRC_POOL = `0x${"55".repeat(20)}`;
const ACCOUNT = `0x${"66".repeat(20)}`;
const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
const RELAYER_KEY = `0x${"00".repeat(31)}01`;
const RECOVERY_KEY = `0x${"00".repeat(31)}02`;
const RECOVERY_SIGNER = new Wallet(RECOVERY_KEY).address.toLowerCase();
const DIGEST = keccak256("0x1234");
const SIGNATURE = new Wallet(RECOVERY_KEY).signingKey.sign(DIGEST).serialized;
const ACCOUNT_CODE = "0x6001600155";
const ACCOUNT_CODE_HASH = keccak256(ACCOUNT_CODE);
const CORE_CODE = "0x60006000";
const NOTE_COMMITMENT = "123456789";
const HBAR_DENOMINATION = "100000000";
const LPRC_DENOMINATION = "1000";
const ACCOUNT_INTERFACE = new Interface(PRIVATE_SESSION_RECOVERY_ACCOUNT_ABI);

const allowlist = Object.freeze({
    factory: FACTORY,
    generation: "7",
    pools: Object.freeze({
        HBAR: Object.freeze({
            address: HBAR_POOL,
            asset: ZERO_ADDRESS,
            denomination: HBAR_DENOMINATION,
        }),
        LPRC: Object.freeze({
            address: LPRC_POOL,
            asset: SECURITY,
            denomination: LPRC_DENOMINATION,
        }),
    }),
    router: ROUTER,
    security: SECURITY,
});

function request(overrides = {}) {
    return {
        action: "recover-to-router",
        chainId: "296",
        account: ACCOUNT,
        asset: "HBAR",
        amount: HBAR_DENOMINATION,
        noteCommitment: NOTE_COMMITMENT,
        nonce: "3",
        signature: SIGNATURE,
        ...overrides,
    };
}

function harness({
    mode = "confirmed",
    gasPrice = 10n,
    balance = 100_000_000n,
    canonical = true,
    generation = 7n,
    asset = "HBAR",
    poolAsset = asset === "HBAR" ? ZERO_ADDRESS : SECURITY,
    poolDenomination = asset === "HBAR"
        ? HBAR_DENOMINATION
        : LPRC_DENOMINATION,
    recoverySigner = RECOVERY_SIGNER,
    preflightError = null,
    broadcastBarrier = null,
    transactionDirectory = mkdtempSync(
        path.join(os.tmpdir(), "private-recovery-test-"),
    ),
} = {}) {
    const events = [];
    const blockTags = [];
    const receipts = new Map();
    const pending = new Map();
    const state = {
        mode,
        recoveryNonce: 3n,
        commitmentSeen: false,
        balance,
        balanceChecks: 0,
    };
    const requestedPoolAsset = asset === "HBAR" ? ZERO_ADDRESS : SECURITY;
    const requestedDenomination = asset === "HBAR"
        ? HBAR_DENOMINATION
        : LPRC_DENOMINATION;
    const atBlock = (args) => {
        assert.deepEqual(args.at(-1), {blockTag: 91});
        blockTags.push(91);
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
        async getBlock(tag) {
            assert.equal(tag, "latest");
            return {number: 91};
        },
        async getCode(address, blockTag) {
            assert.equal(blockTag, 91);
            return address.toLowerCase() === ACCOUNT ? ACCOUNT_CODE : CORE_CODE;
        },
        async call(transaction) {
            events.push({kind: "preflight", transaction});
            if (preflightError) throw preflightError;
            return "0x";
        },
        async getFeeData() {
            return {gasPrice};
        },
        async getBalance(address, blockTag) {
            assert.match(address, /^0x[0-9a-f]{40}$/);
            assert.equal(blockTag, 91);
            const configured = state.balance;
            const selected = Array.isArray(configured)
                ? configured[Math.min(
                    state.balanceChecks,
                    configured.length - 1,
                )]
                : configured;
            state.balanceChecks += 1;
            return selected;
        },
        async getTransactionCount(address, tag) {
            assert.match(address, /^0x[0-9a-f]{40}$/);
            assert.equal(tag, "pending");
            return 5;
        },
        async getTransactionReceipt(hash) {
            events.push({kind: "receipt", hash});
            return receipts.get(hash) ?? null;
        },
        async getTransaction(hash) {
            events.push({kind: "pending", hash});
            return pending.get(hash) ?? null;
        },
        async broadcastTransaction(raw) {
            const transaction = Transaction.from(raw);
            events.push({kind: "broadcast", transaction});
            if (broadcastBarrier !== null) await broadcastBarrier;
            if (state.mode === "pending") {
                pending.set(transaction.hash, {hash: transaction.hash});
                return {hash: transaction.hash};
            }
            state.recoveryNonce = 4n;
            state.commitmentSeen = true;
            receipts.set(transaction.hash, {
                hash: transaction.hash,
                status: 1,
            });
            if (state.mode === "throws-confirmed") {
                throw new Error(`private revert ${SIGNATURE}`);
            }
            return {
                hash: transaction.hash,
                async wait() {
                    return receipts.get(transaction.hash);
                },
            };
        },
    };
    const factoryContract = {
        async isSessionAccount(...args) {
            atBlock(args);
            return canonical;
        },
        async deployedCodeHash(...args) {
            atBlock(args);
            return canonical ? ACCOUNT_CODE_HASH : `0x${"00".repeat(32)}`;
        },
    };
    const routerContract = {
        async factory(...args) {
            atBlock(args);
            return FACTORY;
        },
        async security(...args) {
            atBlock(args);
            return SECURITY;
        },
        async hbarPool(...args) {
            atBlock(args);
            return HBAR_POOL;
        },
        async lprcPool(...args) {
            atBlock(args);
            return LPRC_POOL;
        },
    };
    const pool = {
        async asset(...args) {
            atBlock(args);
            return poolAsset;
        },
        async denomination(...args) {
            atBlock(args);
            return BigInt(poolDenomination);
        },
        async commitmentSeen(...args) {
            atBlock(args);
            return state.commitmentSeen;
        },
    };
    const session = {
        async recoverySigner(...args) {
            atBlock(args);
            return recoverySigner;
        },
        async router(...args) {
            atBlock(args);
            return ROUTER;
        },
        async security(...args) {
            atBlock(args);
            return SECURITY;
        },
        async generation(...args) {
            atBlock(args);
            return generation;
        },
        async recoveryNonce(...args) {
            atBlock(args);
            return state.recoveryNonce;
        },
        async recoveryAuthorizationDigest(
            asset,
            amount,
            noteCommitment,
            nonce,
            ...args
        ) {
            atBlock(args);
            assert.equal(
                asset,
                requestedPoolAsset,
            );
            assert.equal(amount, requestedDenomination);
            assert.equal(noteCommitment, NOTE_COMMITMENT);
            assert.equal(nonce, "3");
            return DIGEST;
        },
    };
    const createAdapter = () => new EthersPrivateSessionRecoveryAdapter({
        provider,
        env: {PRIVATE_TRADING_RELAYER_KEY: RELAYER_KEY},
        allowlist,
        transactionStore: new DurablePrivateRelayStore({
            directory: transactionDirectory,
        }),
        maxGasPriceWei: 20n,
        relayerReserveWei: 100n,
        confirmations: 1,
        transactionTimeoutMilliseconds: 1_000,
        factoryContract,
        routerContract,
        poolContracts: {HBAR: pool, LPRC: pool},
        sessionContractFactory: (address) => {
            assert.equal(address, ACCOUNT);
            return session;
        },
    });
    const adapter = createAdapter();
    return {
        adapter,
        controller: new PrivateSessionRecoveryController({
            chainAdapter: adapter,
        }),
        createAdapter,
        events,
        blockTags,
        pending,
        receipts,
        state,
        transactionDirectory,
    };
}

test("strict recovery controller and composite dispatch reject extra identity", async () => {
    let recoveryCalls = 0;
    let registrationCalls = 0;
    const recovery = new PrivateSessionRecoveryController({
        chainAdapter: {
            async relayRecovery(value) {
                recoveryCalls += 1;
                assert.equal(value.nonce, "3");
                return {status: "CONFIRMED", txHash: `0x${"aa".repeat(32)}`};
            },
        },
    });
    const composite = new PrivateSessionController({
        registrationController: {
            async handle() {
                registrationCalls += 1;
                return {status: "ALREADY_CONFIRMED"};
            },
        },
        recoveryController: recovery,
    });
    assert.equal((await composite.handle(request())).status, "CONFIRMED");
    assert.equal(
        (await composite.handle({action: "register"})).status,
        "ALREADY_CONFIRMED",
    );
    await assert.rejects(
        composite.handle({...request(), wallet: ACCOUNT}),
        {code: "RECOVERY_REQUEST_SCHEMA_INVALID"},
    );
    await assert.rejects(
        composite.handle({...request(), amount: "010"}),
        {code: "RECOVERY_REQUEST_SCHEMA_INVALID"},
    );
    await assert.rejects(
        composite.handle({...request(), signature: "0x1234"}),
        {code: "RECOVERY_SIGNATURE_INVALID"},
    );
    assert.equal(recoveryCalls, 1);
    assert.equal(registrationCalls, 1);
});

test("recovery pins policy, relays zero value, and persists no secrets", async () => {
    const relay = harness();
    const result = await relay.controller.handle(request());
    assert.equal(result.status, "CONFIRMED");
    assert.match(result.txHash, /^0x[0-9a-f]{64}$/);
    const preflight = relay.events.find((event) => event.kind === "preflight");
    const broadcast = relay.events.find((event) => event.kind === "broadcast");
    assert.equal(preflight.transaction.blockTag, 91);
    assert.equal(preflight.transaction.value, 0n);
    assert.equal(broadcast.transaction.value, 0n);
    assert.equal(broadcast.transaction.gasLimit, PRIVATE_SESSION_RECOVERY_GAS_LIMIT);
    const decoded = ACCOUNT_INTERFACE.decodeFunctionData(
        "recoverToRouter",
        broadcast.transaction.data,
    );
    assert.equal(decoded.asset.toLowerCase(), ZERO_ADDRESS);
    assert.equal(decoded.amount, BigInt(HBAR_DENOMINATION));
    assert.equal(decoded.noteCommitment, BigInt(NOTE_COMMITMENT));
    assert.equal(decoded.nonce, 3n);
    assert.equal(decoded.signature.toLowerCase(), SIGNATURE.toLowerCase());
    assert.ok(relay.blockTags.every((block) => block === 91));

    const store = new DurablePrivateRelayStore({
        directory: relay.transactionDirectory,
    });
    const records = await store.list();
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, "recovery");
    const recordDirectory = path.join(
        relay.transactionDirectory,
        records[0].handle,
    );
    assert.deepEqual(await readdir(recordDirectory), ["record.json"]);
    const persisted = await readFile(
        path.join(recordDirectory, "record.json"),
        "utf8",
    );
    assert.equal(persisted.includes(SIGNATURE.slice(2)), false);
    assert.equal(persisted.includes(NOTE_COMMITMENT), false);
});

test("LPRC recovery pins the security asset and fixed denomination", async () => {
    const relay = harness({asset: "LPRC"});
    const result = await relay.controller.handle(request({
        asset: "LPRC",
        amount: LPRC_DENOMINATION,
    }));
    assert.equal(result.status, "CONFIRMED");
    const broadcast = relay.events.find((event) => event.kind === "broadcast");
    const decoded = ACCOUNT_INTERFACE.decodeFunctionData(
        "recoverToRouter",
        broadcast.transaction.data,
    );
    assert.equal(decoded.asset.toLowerCase(), SECURITY);
    assert.equal(decoded.amount, BigInt(LPRC_DENOMINATION));
});

test("recovery refuses policy, signature, nonce, preflight, gas, and reserve drift", async () => {
    for (const [options, code] of [
        [{canonical: false}, "RECOVERY_SESSION_NOT_CANONICAL"],
        [{generation: 8n}, "RECOVERY_POLICY_CONTEXT_MISMATCH"],
        [{poolAsset: SECURITY}, "RECOVERY_POLICY_CONTEXT_MISMATCH"],
        [{poolDenomination: "1"}, "RECOVERY_POLICY_CONTEXT_MISMATCH"],
        [{recoverySigner: ACCOUNT}, "RECOVERY_SIGNATURE_INVALID"],
        [{
            preflightError: new Error(`revert ${SIGNATURE}`),
        }, "RECOVERY_PREFLIGHT_REFUSED"],
        [{gasPrice: 21n}, "RECOVERY_GAS_PRICE_CAP_EXCEEDED"],
        [{balance: 100n}, "RECOVERY_RELAYER_BALANCE_TOO_LOW"],
    ]) {
        const relay = harness(options);
        await assert.rejects(relay.controller.handle(request()), (error) => {
            assert.equal(error.code, code);
            assert.equal(error.message.includes(SIGNATURE), false);
            return true;
        });
        assert.equal(
            relay.events.some((event) => event.kind === "broadcast"),
            false,
        );
    }
    const nonce = harness();
    nonce.state.recoveryNonce = 5n;
    nonce.state.commitmentSeen = true;
    await assert.rejects(
        nonce.controller.handle(request()),
        {code: "RECOVERY_STATE_MISMATCH"},
    );
    assert.equal(Object.hasOwn(nonce.adapter.provider, "estimateGas"), false);
});

test("new recovery records recheck pinned balance immediately before broadcast", async () => {
    const relay = harness({balance: [100_000_000n, 100n]});
    await assert.rejects(
        relay.controller.handle(request()),
        {code: "RECOVERY_RELAYER_BALANCE_TOO_LOW"},
    );
    assert.equal(relay.state.balanceChecks, 2);
    assert.equal(
        relay.events.some((event) => event.kind === "broadcast"),
        false,
    );
    const records = await new DurablePrivateRelayStore({
        directory: relay.transactionDirectory,
    }).list();
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, "recovery");
});

test("restart reconciles then rebroadcasts the exact redacted recovery record", async () => {
    const relay = harness({mode: "pending"});
    await assert.rejects(
        relay.controller.handle(request()),
        {code: "RECOVERY_TRANSACTION_PENDING"},
    );
    const firstBroadcast = relay.events.find(
        (event) => event.kind === "broadcast",
    ).transaction;

    const restarted = new PrivateSessionRecoveryController({
        chainAdapter: relay.createAdapter(),
    });
    await assert.rejects(
        restarted.handle(request()),
        {code: "RECOVERY_TRANSACTION_PENDING"},
    );
    assert.equal(
        relay.events.filter((event) => event.kind === "broadcast").length,
        1,
    );

    relay.pending.delete(firstBroadcast.hash);
    relay.state.balance = 100n;
    await assert.rejects(
        new PrivateSessionRecoveryController({
            chainAdapter: relay.createAdapter(),
        }).handle(request()),
        {code: "RECOVERY_RELAYER_BALANCE_TOO_LOW"},
    );
    assert.equal(
        relay.events.filter((event) => event.kind === "broadcast").length,
        1,
    );
    relay.state.balance = 100_000_000n;
    relay.state.mode = "confirmed";
    const recovered = await new PrivateSessionRecoveryController({
        chainAdapter: relay.createAdapter(),
    }).handle(request());
    assert.deepEqual(recovered, {
        status: "CONFIRMED",
        txHash: firstBroadcast.hash,
    });
    const broadcasts = relay.events.filter(
        (event) => event.kind === "broadcast",
    );
    assert.equal(broadcasts.length, 2);
    assert.equal(broadcasts[1].transaction.hash, firstBroadcast.hash);
    assert.equal(broadcasts[1].transaction.nonce, firstBroadcast.nonce);
});

test("lost broadcast response reconciles receipt and exact chain effects", async () => {
    const relay = harness({mode: "throws-confirmed"});
    const result = await relay.controller.handle(request());
    assert.equal(result.status, "CONFIRMED");
    assert.match(result.txHash, /^0x[0-9a-f]{64}$/);
    assert.equal(relay.state.recoveryNonce, 4n);
    assert.equal(relay.state.commitmentSeen, true);
    assert.equal(
        relay.events.filter((event) => event.kind === "broadcast").length,
        1,
    );
});

test("different recovery request cannot join an in-flight nonce", async () => {
    let release;
    const barrier = new Promise((resolve) => {
        release = resolve;
    });
    const relay = harness({broadcastBarrier: barrier});
    const first = relay.controller.handle(request());
    while (!relay.events.some((event) => event.kind === "broadcast")) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    await assert.rejects(
        relay.controller.handle(request({noteCommitment: "123456790"})),
        {code: "RECOVERY_IN_FLIGHT"},
    );
    release();
    assert.equal((await first).status, "CONFIRMED");
    assert.equal(
        relay.events.filter((event) => event.kind === "broadcast").length,
        1,
    );
});

test("recovery allocation follows existing order records in the shared store", async () => {
    const relay = harness({mode: "pending"});
    const store = new DurablePrivateRelayStore({
        directory: relay.transactionDirectory,
    });
    const ticketId = "ef".repeat(32);
    const wallet = new Wallet(RELAYER_KEY);
    await store.prepare({
        handle: privateRelayHandle("place", ticketId),
        minimumNonce: 5,
        build: async (nonce) => {
            const data = "0x1234";
            const signed = await wallet.signTransaction({
                type: 0,
                chainId: 296n,
                nonce,
                to: ACCOUNT,
                value: 0n,
                data,
                gasLimit: 100_000n,
                gasPrice: 10n,
            });
            return {
                kind: "place",
                context: {
                    chainHash: QUICKNET_CHAIN_HASH,
                    chainId: "296",
                    engine: FACTORY,
                    engineCommitment: `0x${"31".repeat(32)}`,
                    envelopeDigest: `0x${"32".repeat(32)}`,
                    envelopeId: `0x${"33".repeat(32)}`,
                    feePolicyDigest: `0x${"34".repeat(32)}`,
                    generation: "7",
                    sessionAccount: ACCOUNT,
                    targetRound: "1",
                    ticketId,
                },
                from: wallet.address.toLowerCase(),
                to: ACCOUNT,
                gasPrice: "10",
                gasLimit: "100000",
                transactionHash: Transaction.from(signed).hash.toLowerCase(),
                calldata: Buffer.from(data.slice(2), "hex"),
                signedTransaction: Buffer.from(signed.slice(2), "hex"),
                simulationBlock: 91,
            };
        },
    }).then((record) => {
        record.calldata.fill(0);
        record.signedTransaction.fill(0);
    });
    await assert.rejects(
        relay.controller.handle(request()),
        {code: "RECOVERY_TRANSACTION_PENDING"},
    );
    const recovery = relay.events.find(
        (event) => event.kind === "broadcast",
    ).transaction;
    assert.equal(recovery.nonce, 6);
});
