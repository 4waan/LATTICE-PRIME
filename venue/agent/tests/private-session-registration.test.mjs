import assert from "node:assert/strict";
import {mkdtempSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    AbiCoder,
    Interface,
    Transaction,
    Wallet,
    keccak256,
    toBeHex,
} from "ethers";

import {QUICKNET_CHAIN_HASH} from "../../tools/timed-ticket.mjs";
import {
    EthersPrivateSessionRegistrationAdapter,
    PRIVATE_SESSION_REGISTRATION_DEFAULT_GAS_LIMITS,
    PRIVATE_SESSION_REGISTRATION_FACTORY_ABI,
    PRIVATE_SESSION_REGISTRATION_GATE_ABI,
    PRIVATE_SESSION_REGISTRATION_GAS_LIMIT_CAPS,
    loadPrivateSessionRegistrationRelayerKey,
} from "../runtime/private-session-registration-chain.mjs";
import {
    PrivateSessionRegistrationController,
} from "../runtime/private-session-registration-controller.mjs";
import {
    DurablePrivateRelayStore,
    privateRelayHandle,
} from "../runtime/private-relay-store.mjs";

const FACTORY = `0x${"11".repeat(20)}`;
const GATE = `0x${"22".repeat(20)}`;
const REGISTRY = `0x${"33".repeat(20)}`;
const ENGINE = `0x${"44".repeat(20)}`;
const SECURITY = `0x${"55".repeat(20)}`;
const ROUTER = `0x${"66".repeat(20)}`;
const ACCOUNT = `0x${"77".repeat(20)}`;
const SESSION_SIGNER = `0x${"88".repeat(20)}`;
const RECOVERY_SIGNER = `0x${"99".repeat(20)}`;
const OTHER = `0x${"aa".repeat(20)}`;
const PARTITION = `0x${"00".repeat(31)}01`;
const QUICKNET_HASH = `0x${"ab".repeat(32)}`;
const FEE_POLICY = `0x${"bc".repeat(32)}`;
const CREATION_CODE_HASH = `0x${"45".repeat(32)}`;
const DEPLOYMENT_SALT = `0x${"cd".repeat(32)}`;
const VENUE_DIGEST = `0x${"de".repeat(32)}`;
const ACCOUNT_CODE = "0x6001600155";
const ACCOUNT_CODE_HASH = keccak256(ACCOUNT_CODE);
const CORE_CODE = "0x60006000";
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const RELAYER_KEY = `0x${"00".repeat(31)}01`;
const ROOT = "902";
const CODE_HASH_LOW = (
    BigInt(CREATION_CODE_HASH) & ((1n << 128n) - 1n)
).toString();
const CODE_HASH_HIGH = (BigInt(CREATION_CODE_HASH) >> 128n).toString();
const MIN_TIER = "3";
const MASK = "255";
const VIEW_EPOCH = "4";
const VIEW_X = "905";
const VIEW_Y = "906";
const SLOT = "900";
const BRIDGE = "901";

const FACTORY_INTERFACE = new Interface(
    PRIVATE_SESSION_REGISTRATION_FACTORY_ABI,
);
const GATE_INTERFACE = new Interface(PRIVATE_SESSION_REGISTRATION_GATE_ABI);
const CODER = AbiCoder.defaultAbiCoder();
const word = (value) => toBeHex(BigInt(value), 32);

const allowlist = Object.freeze({
    creationCodeHash: CREATION_CODE_HASH,
    factory: FACTORY,
    gate: GATE,
    registry: REGISTRY,
    engine: ENGINE,
    security: SECURITY,
    partition: PARTITION,
    router: ROUTER,
    quicknetChainHash: QUICKNET_HASH,
    feePolicyDigest: FEE_POLICY,
});

function registrationRequest(action = "deploy-and-register", overrides = {}) {
    const ciphertext = {
        encryptedCredential: word(801),
        tag: word(802),
        ephemeralX: word(803),
        ephemeralY: word(804),
    };
    const eligibilitySignals = [
        SLOT,
        "1",
        BRIDGE,
        ROOT,
        "7",
        BigInt(ACCOUNT).toString(),
        BigInt(SESSION_SIGNER).toString(),
        BigInt(FACTORY).toString(),
        CODE_HASH_LOW,
        CODE_HASH_HIGH,
        MIN_TIER,
        MASK,
    ].map(word);
    const complianceSignals = [
        801,
        802,
        803,
        804,
        BRIDGE,
        ROOT,
        7,
        BigInt(ACCOUNT),
        BigInt(SESSION_SIGNER),
        BigInt(FACTORY),
        CODE_HASH_LOW,
        CODE_HASH_HIGH,
        MIN_TIER,
        MASK,
        VIEW_EPOCH,
        VIEW_X,
        VIEW_Y,
    ].map(word);
    return {
        action,
        chainId: "296",
        factory: FACTORY,
        gate: GATE,
        registry: REGISTRY,
        account: ACCOUNT,
        config: {
            sessionSigner: SESSION_SIGNER,
            recoverySigner: RECOVERY_SIGNER,
            engine: ENGINE,
            security: SECURITY,
            partition: PARTITION,
            router: ROUTER,
            quicknetChainHash: QUICKNET_HASH,
            generation: 7,
            feePolicyDigest: FEE_POLICY,
        },
        deploymentSalt: DEPLOYMENT_SALT,
        ciphertext,
        eligibility: {
            proof: Array.from({length: 24}, (_, index) => word(1_000 + index)),
            publicSignals: eligibilitySignals,
        },
        compliance: {
            proof: Array.from({length: 24}, (_, index) => word(2_000 + index)),
            publicSignals: complianceSignals,
        },
        ...overrides,
    };
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return {promise, resolve};
}

function chainHarness({
    deployed = false,
    kycGranted = false,
    canonical = true,
    predictedAccount = ACCOUNT,
    preflightError = null,
    gasPrice = 10n,
    balance = 100_000_000n,
    relayerReserveWei = 100n,
    broadcastMode = "confirmed",
    broadcastBarrier = null,
    receiptError = null,
    maxGasPriceWei = 20n,
    gasLimits = PRIVATE_SESSION_REGISTRATION_DEFAULT_GAS_LIMITS,
    factoryCreationCodeHash = CREATION_CODE_HASH,
    gateCreationCodeHash = CREATION_CODE_HASH,
    gateRegistry = REGISTRY,
    gateFactory = FACTORY,
    registryGate = GATE,
    registryPendingGate = `0x${"00".repeat(20)}`,
    missingCodeAddress = null,
    pendingNonce = 4,
    transactionDirectory = mkdtempSync(
        path.join(os.tmpdir(), "private-registration-test-"),
    ),
} = {}) {
    const events = [];
    const contractBlocks = [];
    const codeChecks = [];
    const receipts = new Map();
    const pending = new Map();
    const state = {
        deployed,
        kycGranted,
        canonical,
        slotUsed: kycGranted,
        slotUses: kycGranted ? 1n : 0n,
        balance,
        balanceChecks: 0,
    };
    const core = new Set([
        FACTORY,
        GATE,
        REGISTRY,
        ENGINE,
        SECURITY,
        ROUTER,
    ]);
    const atBlock = (args) => {
        const options = args.at(-1);
        assert.deepEqual(options, {blockTag: 91});
        contractBlocks.push(options.blockTag);
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
            return {number: 91, timestamp: 1_000};
        },
        async getCode(account, blockTag) {
            assert.equal(blockTag, 91);
            codeChecks.push(account.toLowerCase());
            if (account.toLowerCase() === missingCodeAddress?.toLowerCase()) {
                return "0x";
            }
            if (account.toLowerCase() === ACCOUNT) {
                return state.deployed ? ACCOUNT_CODE : "0x";
            }
            assert.ok(core.has(account.toLowerCase()));
            return CORE_CODE;
        },
        async call(transaction) {
            events.push({kind: "preflight", transaction});
            assert.equal(transaction.blockTag, 91);
            assert.equal(transaction.value, 0n);
            if (preflightError) throw preflightError;
            return "0x";
        },
        async getFeeData() {
            return {gasPrice, maxFeePerGas: null};
        },
        async getBalance(account, blockTag) {
            assert.match(account, /^0x[0-9a-f]{40}$/);
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
        async getTransactionCount(account, tag) {
            assert.match(account, /^0x[0-9a-f]{40}$/);
            assert.equal(tag, "pending");
            return pendingNonce;
        },
        async getTransactionReceipt(hash) {
            events.push({kind: "receipt", hash});
            if (receiptError) throw receiptError;
            return receipts.get(hash) ?? null;
        },
        async getTransaction(hash) {
            events.push({kind: "pending", hash});
            return pending.get(hash) ?? null;
        },
        async broadcastTransaction(raw) {
            const transaction = Transaction.from(raw);
            events.push({kind: "broadcast", transaction});
            if (broadcastBarrier) await broadcastBarrier.promise;
            if (broadcastMode === "throws-confirmed") {
                state.deployed = true;
                state.kycGranted = true;
                state.slotUsed = true;
                state.slotUses = 1n;
                receipts.set(transaction.hash, {
                    hash: transaction.hash,
                    status: 1,
                });
                throw new Error(`private broadcast detail ${SLOT}`);
            }
            if (broadcastMode === "pending") {
                pending.set(transaction.hash, {hash: transaction.hash});
                return {hash: transaction.hash};
            }
            state.deployed = true;
            state.kycGranted = true;
            state.slotUsed = true;
            state.slotUses = 1n;
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
    const factoryContract = {
        async creationCodeHash(...args) {
            atBlock(args);
            return factoryCreationCodeHash;
        },
        async accountAddress(...args) {
            atBlock(args);
            return predictedAccount;
        },
        async accountVenueConfigDigest(...args) {
            atBlock(args);
            return VENUE_DIGEST;
        },
        async approvedVenueConfig(...args) {
            atBlock(args);
            return true;
        },
        async isCanonical(...args) {
            atBlock(args);
            return state.deployed && state.canonical;
        },
        async isSessionAccount(...args) {
            atBlock(args);
            return state.deployed;
        },
        async deployedCodeHash(...args) {
            atBlock(args);
            return state.deployed ? ACCOUNT_CODE_HASH : ZERO_BYTES32;
        },
    };
    const gateContract = {
        async sessionImplementationCodeHash(...args) {
            atBlock(args);
            return gateCreationCodeHash;
        },
        async registry(...args) {
            atBlock(args);
            return gateRegistry;
        },
        async sessionFactory(...args) {
            atBlock(args);
            return gateFactory;
        },
        async sessionRootForEpoch(...args) {
            atBlock(args);
            return BigInt(ROOT);
        },
        async viewKeyEpochForRotationEpoch(...args) {
            atBlock(args);
            return BigInt(VIEW_EPOCH);
        },
        async viewKeyForEpoch(...args) {
            atBlock(args);
            return {
                x: BigInt(VIEW_X),
                y: BigInt(VIEW_Y),
                published: true,
            };
        },
        async sessionImplementationCodeHashLow(...args) {
            atBlock(args);
            return BigInt(CODE_HASH_LOW);
        },
        async sessionImplementationCodeHashHigh(...args) {
            atBlock(args);
            return BigInt(CODE_HASH_HIGH);
        },
        async minTier(...args) {
            atBlock(args);
            return BigInt(MIN_TIER);
        },
        async jurisdictionMask(...args) {
            atBlock(args);
            return BigInt(MASK);
        },
        async sessionSlotUsed(...args) {
            atBlock(args);
            return state.slotUsed;
        },
    };
    const registryContract = {
        async gate(...args) {
            atBlock(args);
            return registryGate;
        },
        async pendingGate(...args) {
            atBlock(args);
            return registryPendingGate;
        },
        async currentEpoch(...args) {
            atBlock(args);
            return 7n;
        },
        async getKycStatus(...args) {
            atBlock(args);
            return state.kycGranted ? 1n : 0n;
        },
        async usesThisEpoch(...args) {
            atBlock(args);
            return state.slotUses;
        },
    };
    const session = {
        async sessionSigner(...args) {
            atBlock(args);
            return SESSION_SIGNER;
        },
        async recoverySigner(...args) {
            atBlock(args);
            return RECOVERY_SIGNER;
        },
        async engine(...args) {
            atBlock(args);
            return ENGINE;
        },
        async security(...args) {
            atBlock(args);
            return SECURITY;
        },
        async partition(...args) {
            atBlock(args);
            return PARTITION;
        },
        async router(...args) {
            atBlock(args);
            return ROUTER;
        },
        async quicknetChainHash(...args) {
            atBlock(args);
            return QUICKNET_HASH;
        },
        async generation(...args) {
            atBlock(args);
            return 7n;
        },
        async feePolicyDigest(...args) {
            atBlock(args);
            return FEE_POLICY;
        },
    };
    const createAdapter = (transactionStore = new DurablePrivateRelayStore({
        directory: transactionDirectory,
    })) => new EthersPrivateSessionRegistrationAdapter({
        provider,
        env: {PRIVATE_TRADING_RELAYER_KEY: RELAYER_KEY},
        allowlist,
        transactionStore,
        maxGasPriceWei,
        relayerReserveWei,
        gasLimits,
        confirmations: 1,
        transactionTimeoutMilliseconds: 1_000,
        factoryContract,
        gateContract,
        registryContract,
        sessionContractFactory: (account) => {
            assert.equal(account, ACCOUNT);
            return session;
        },
    });
    const adapter = createAdapter();
    const controller = new PrivateSessionRegistrationController({
        chainAdapter: adapter,
        allowlist,
    });
    return {
        adapter,
        controller,
        provider,
        events,
        contractBlocks,
        codeChecks,
        receipts,
        pending,
        state,
        transactionDirectory,
        createAdapter,
    };
}

test("deploy-and-register encodes the atomic factory call with zero value", async () => {
    const relay = chainHarness();
    const result = await relay.controller.handle(registrationRequest());
    assert.equal(result.status, "CONFIRMED");
    assert.match(result.txHash, /^0x[0-9a-f]{64}$/);

    const preflight = relay.events.find((event) => event.kind === "preflight");
    const broadcast = relay.events.find((event) => event.kind === "broadcast");
    assert.ok(preflight);
    assert.ok(broadcast);
    assert.equal(preflight.transaction.to, FACTORY);
    assert.equal(
        preflight.transaction.gasLimit,
        PRIVATE_SESSION_REGISTRATION_DEFAULT_GAS_LIMITS.deployAndRegister,
    );
    assert.equal(broadcast.transaction.to.toLowerCase(), FACTORY);
    assert.equal(broadcast.transaction.value, 0n);
    assert.equal(
        broadcast.transaction.gasLimit,
        PRIVATE_SESSION_REGISTRATION_DEFAULT_GAS_LIMITS.deployAndRegister,
    );

    const decoded = FACTORY_INTERFACE.decodeFunctionData(
        "deployAndRegister",
        broadcast.transaction.data,
    );
    assert.equal(decoded.config.sessionSigner.toLowerCase(), SESSION_SIGNER);
    assert.equal(decoded.config.generation, 7n);
    assert.equal(decoded.salt, DEPLOYMENT_SALT);
    assert.equal(decoded.hook.toLowerCase(), GATE);
    const registration = CODER.decode(
        [
            "(uint256 encryptedCredential,uint256 tag,uint256 ephemeralX,uint256 ephemeralY)",
            "uint256[24]",
            "uint256[12]",
            "uint256[24]",
            "uint256[17]",
        ],
        decoded.registrationData,
    );
    assert.equal(registration[0].encryptedCredential, 801n);
    assert.equal(registration[1].length, 24);
    assert.equal(registration[2].length, 12);
    assert.equal(registration[3].length, 24);
    assert.equal(registration[4].length, 17);
    assert.ok(relay.contractBlocks.every((block) => block === 91));
    assert.ok(relay.codeChecks.includes(ROUTER));
});

test("initialization pins release hashes, required code, and cross-pointers", async () => {
    const relay = chainHarness();
    const initialized = await relay.adapter.initialize();
    assert.equal(initialized.observedAtBlock, 91);
    for (const required of [
        FACTORY,
        GATE,
        REGISTRY,
        ENGINE,
        SECURITY,
        ROUTER,
    ]) {
        assert.ok(relay.codeChecks.includes(required));
    }
    assert.ok(relay.contractBlocks.every((block) => block === 91));

    for (const options of [
        {factoryCreationCodeHash: FEE_POLICY},
        {gateCreationCodeHash: FEE_POLICY},
    ]) {
        await assert.rejects(
            chainHarness(options).adapter.initialize(),
            {code: "SESSION_CREATION_CODE_HASH_MISMATCH"},
        );
    }
    await assert.rejects(
        chainHarness({missingCodeAddress: ROUTER}).adapter.initialize(),
        {code: "ALLOWLISTED_CODE_MISSING"},
    );
    for (const options of [
        {gateRegistry: OTHER},
        {gateFactory: OTHER},
        {registryGate: OTHER},
    ]) {
        await assert.rejects(
            chainHarness(options).adapter.initialize(),
            {code: "CHAIN_WIRING_MISMATCH"},
        );
    }
});

test("initialization accepts DualRegistrationGate while it is still the pending registry gate", async () => {
    const relay = chainHarness({
        deployed: true,
        registryGate: OTHER,
        registryPendingGate: GATE,
    });
    const initialized = await relay.adapter.initialize();
    assert.equal(initialized.observedAtBlock, 91);
    await assert.rejects(
        relay.controller.handle(registrationRequest("register")),
        {code: "CHAIN_WIRING_MISMATCH"},
    );
});

test("register requires a deployed canonical account and calls only the gate", async () => {
    const relay = chainHarness({deployed: true});
    const result = await relay.controller.handle(registrationRequest("register"));
    assert.equal(result.status, "CONFIRMED");

    const preflight = relay.events.find((event) => event.kind === "preflight");
    const broadcast = relay.events.find((event) => event.kind === "broadcast");
    assert.equal(preflight.transaction.to, GATE);
    assert.equal(broadcast.transaction.to.toLowerCase(), GATE);
    assert.equal(
        broadcast.transaction.gasLimit,
        PRIVATE_SESSION_REGISTRATION_DEFAULT_GAS_LIMITS.register,
    );
    const decoded = GATE_INTERFACE.decodeFunctionData(
        "registerSession",
        broadcast.transaction.data,
    );
    assert.equal(decoded.account.toLowerCase(), ACCOUNT);
    assert.equal(decoded.ciphertext.tag, 802n);
    assert.equal(decoded.eligibilityProof.length, 24);
    assert.equal(decoded.eligibilityPublicSignals.length, 12);
    assert.equal(decoded.complianceProof.length, 24);
    assert.equal(decoded.compliancePublicSignals.length, 17);

    const noncanonical = chainHarness({deployed: true, canonical: false});
    await assert.rejects(
        noncanonical.controller.handle(registrationRequest("register")),
        {code: "ACCOUNT_NOT_CANONICAL"},
    );
    assert.equal(
        noncanonical.events.some((event) => event.kind === "preflight"),
        false,
    );
});

test("controller accepts the exact browser body and rejects malformed uint schemas", async () => {
    let calls = 0;
    let normalized;
    const controller = new PrivateSessionRegistrationController({
        allowlist,
        chainAdapter: {
            async relayRegistration(request) {
                calls += 1;
                normalized = request;
                return {status: "ALREADY_CONFIRMED"};
            },
        },
    });
    const browserBody = registrationRequest();
    assert.equal(Object.hasOwn(browserBody, "credentials"), false);
    assert.equal(Object.hasOwn(browserBody, "creationCodeHash"), false);
    assert.deepEqual(
        await controller.handle(browserBody),
        {status: "ALREADY_CONFIRMED"},
    );
    assert.equal(normalized.config.generation, "7");
    assert.equal(normalized.eligibility.proof[0], "1000");
    assert.equal(normalized.ciphertext.tag, "802");

    await assert.rejects(
        controller.handle({...registrationRequest(), wallet: OTHER}),
        {code: "REQUEST_SCHEMA_INVALID"},
    );
    await assert.rejects(
        controller.handle({...registrationRequest(), credentials: "omit"}),
        {code: "REQUEST_SCHEMA_INVALID"},
    );
    await assert.rejects(
        controller.handle({
            ...registrationRequest(),
            eligibility: {
                ...registrationRequest().eligibility,
                proof: registrationRequest().eligibility.proof.slice(1),
            },
        }),
        {code: "REQUEST_SCHEMA_INVALID"},
    );
    await assert.rejects(
        controller.handle({
            ...registrationRequest(),
            compliance: {
                ...registrationRequest().compliance,
                proof: [
                    "0x01",
                    ...registrationRequest().compliance.proof.slice(1),
                ],
            },
        }),
        {code: "REQUEST_SCHEMA_INVALID"},
    );
    await assert.rejects(
        controller.handle({
            ...registrationRequest(),
            config: {...registrationRequest().config, generation: "07"},
        }),
        {code: "REQUEST_SCHEMA_INVALID"},
    );
    await assert.rejects(
        controller.handle({
            ...registrationRequest(),
            config: {...registrationRequest().config, wallet: OTHER},
        }),
        {code: "REQUEST_SCHEMA_INVALID"},
    );
    assert.throws(
        () => new PrivateSessionRegistrationController({
            chainAdapter: {async relayRegistration() {}},
            allowlist: {...allowlist, creationCodeHash: ZERO_BYTES32},
        }),
        {code: "CONTROLLER_CONFIG_INVALID"},
    );
    assert.equal(calls, 1);
});

test("controller pins allowlists, signer, split policy context, and ciphertext", async () => {
    let calls = 0;
    const controller = new PrivateSessionRegistrationController({
        allowlist,
        chainAdapter: {
            async relayRegistration() {
                calls += 1;
                return {status: "ALREADY_CONFIRMED"};
            },
        },
    });
    await assert.rejects(
        controller.handle({
            ...registrationRequest(),
            config: {...registrationRequest().config, engine: OTHER},
        }),
        {code: "REQUEST_CONTEXT_MISMATCH"},
    );

    const signerMismatch = registrationRequest();
    signerMismatch.eligibility.publicSignals[6] = BigInt(OTHER).toString();
    await assert.rejects(
        controller.handle(signerMismatch),
        {code: "PUBLIC_SIGNAL_CONTEXT_MISMATCH"},
    );

    const splitMismatch = registrationRequest();
    splitMismatch.compliance.publicSignals[12] = "4";
    await assert.rejects(
        controller.handle(splitMismatch),
        {code: "PUBLIC_SIGNAL_CONTEXT_MISMATCH"},
    );

    const ciphertextMismatch = registrationRequest();
    ciphertextMismatch.ciphertext.tag = "805";
    await assert.rejects(
        controller.handle(ciphertextMismatch),
        {code: "CIPHERTEXT_CONTEXT_MISMATCH"},
    );
    assert.equal(calls, 0);
});

test("wrong CREATE2 result refuses before simulation or submission", async () => {
    const relay = chainHarness({predictedAccount: OTHER});
    await assert.rejects(
        relay.controller.handle(registrationRequest()),
        {code: "ACCOUNT_ADDRESS_MISMATCH"},
    );
    assert.equal(
        relay.events.some((event) => event.kind === "preflight"),
        false,
    );
    assert.equal(
        relay.events.some((event) => event.kind === "broadcast"),
        false,
    );
});

test("pinned preflight refusal is redacted and never broadcasts", async () => {
    const privateDetail = registrationRequest().eligibility.proof[0];
    const relay = chainHarness({
        preflightError: new Error(`revert 0xdead ${privateDetail}`),
    });
    await assert.rejects(
        relay.controller.handle(registrationRequest()),
        (error) => {
            assert.equal(error.code, "PREFLIGHT_REFUSED");
            assert.equal(error.message.includes("0xdead"), false);
            assert.equal(error.message.includes(privateDetail), false);
            return true;
        },
    );
    assert.equal(
        relay.events.some((event) => event.kind === "broadcast"),
        false,
    );
});

test("gas ceiling and fixed gas caps fail closed without estimation", async () => {
    const relay = chainHarness({gasPrice: 21n});
    assert.throws(
        () => relay.createAdapter(null),
        {code: "CHAIN_ADAPTER_CONFIG_INVALID"},
    );
    await assert.rejects(
        relay.controller.handle(registrationRequest()),
        {code: "GAS_PRICE_CAP_EXCEEDED"},
    );
    assert.equal(
        relay.events.some((event) => event.kind === "preflight"),
        true,
    );
    assert.equal(
        relay.events.some((event) => event.kind === "broadcast"),
        false,
    );
    assert.equal(Object.hasOwn(relay.provider, "estimateGas"), false);

    assert.throws(
        () => chainHarness({
            gasLimits: {
                ...PRIVATE_SESSION_REGISTRATION_DEFAULT_GAS_LIMITS,
                register: PRIVATE_SESSION_REGISTRATION_GAS_LIMIT_CAPS.register + 1n,
            },
        }),
        {code: "GAS_LIMIT_CAP_EXCEEDED"},
    );
    assert.throws(
        () => loadPrivateSessionRegistrationRelayerKey({
            HEDERA_PRIVATE_KEY: RELAYER_KEY,
            OPERATOR_PRIVATE_KEY: RELAYER_KEY,
        }),
        {code: "RELAYER_KEY_REQUIRED"},
    );
    assert.equal(
        loadPrivateSessionRegistrationRelayerKey({
            PRIVATE_TRADING_RELAYER_KEY: RELAYER_KEY,
        }),
        RELAYER_KEY,
    );
});

test("registration requires reserve plus gas before signing and initial broadcast", async () => {
    const beforeSigning = chainHarness({balance: 100n});
    await assert.rejects(
        beforeSigning.controller.handle(registrationRequest()),
        (error) => {
            assert.equal(error.code, "RELAYER_BALANCE_TOO_LOW");
            assert.equal(
                error.message.includes(
                    registrationRequest().eligibility.proof[0],
                ),
                false,
            );
            return true;
        },
    );
    assert.deepEqual(
        await new DurablePrivateRelayStore({
            directory: beforeSigning.transactionDirectory,
        }).list(),
        [],
    );
    assert.equal(
        beforeSigning.events.some((event) => event.kind === "broadcast"),
        false,
    );

    const beforeBroadcast = chainHarness({
        balance: [100_000_000n, 100n],
    });
    await assert.rejects(
        beforeBroadcast.controller.handle(registrationRequest()),
        {code: "RELAYER_BALANCE_TOO_LOW"},
    );
    assert.equal(
        beforeBroadcast.events.some((event) => event.kind === "broadcast"),
        false,
    );
    assert.equal(
        (await new DurablePrivateRelayStore({
            directory: beforeBroadcast.transactionDirectory,
        }).list()).length,
        1,
    );
});

test("confirmed state is idempotent and duplicate in-flight work is shared", async () => {
    const confirmed = chainHarness({deployed: true, kycGranted: true});
    assert.deepEqual(
        await confirmed.controller.handle(registrationRequest("register")),
        {status: "ALREADY_CONFIRMED"},
    );
    assert.equal(
        confirmed.events.some((event) => event.kind === "preflight"),
        false,
    );
    assert.equal(
        confirmed.events.some((event) => event.kind === "broadcast"),
        false,
    );

    const barrier = deferred();
    const relay = chainHarness({broadcastBarrier: barrier});
    const first = relay.controller.handle(registrationRequest());
    while (!relay.events.some((event) => event.kind === "broadcast")) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    const second = relay.controller.handle(registrationRequest());
    barrier.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(secondResult, firstResult);
    assert.equal(
        relay.events.filter((event) => event.kind === "broadcast").length,
        1,
    );
});

test("pending attempts reconcile receipt and chain state before any retry", async () => {
    const relay = chainHarness({broadcastMode: "pending"});
    const request = registrationRequest();
    const pendingResult = await relay.controller.handle(request);
    assert.equal(pendingResult.status, "PENDING");
    assert.match(pendingResult.txHash, /^0x[0-9a-f]{64}$/);
    assert.equal(
        relay.events.filter((event) => event.kind === "broadcast").length,
        1,
    );

    relay.pending.delete(pendingResult.txHash);
    relay.receipts.set(pendingResult.txHash, {
        hash: pendingResult.txHash,
        status: 1,
    });
    relay.state.deployed = true;
    relay.state.kycGranted = true;
    relay.state.slotUsed = true;
    relay.state.slotUses = 1n;
    const retried = await relay.controller.handle(request);
    assert.deepEqual(retried, {status: "ALREADY_CONFIRMED"});
    assert.equal(
        relay.events.filter((event) => event.kind === "broadcast").length,
        1,
    );
    assert.ok(relay.events.some((event) => event.kind === "receipt"));
    assert.ok(relay.events.some((event) => event.kind === "pending"));
});

test("reconciliation errors expose only a stable public code", async () => {
    const relay = chainHarness({broadcastMode: "pending"});
    const request = registrationRequest();
    const first = await relay.controller.handle(request);
    assert.equal(first.status, "PENDING");
    const secret = request.compliance.proof[3];
    relay.provider.getTransactionReceipt = async () => {
        throw new Error(`secret receipt ${secret} 0xbeef`);
    };
    await assert.rejects(
        relay.controller.handle(request),
        (error) => {
            assert.equal(error.code, "RECONCILIATION_FAILED");
            assert.equal(error.message.includes(secret), false);
            assert.equal(error.message.includes("0xbeef"), false);
            return true;
        },
    );
    assert.equal(
        relay.events.filter((event) => event.kind === "broadcast").length,
        1,
    );
});

test("order and registration preparation share one durable nonce lock", async () => {
    const relay = chainHarness({broadcastMode: "pending", pendingNonce: 4});
    const store = new DurablePrivateRelayStore({
        directory: relay.transactionDirectory,
    });
    const buildStarted = deferred();
    const releaseBuild = deferred();
    const ticketId = "ef".repeat(32);
    const wallet = new Wallet(RELAYER_KEY);
    const orderPreparation = store.prepare({
        handle: privateRelayHandle("place", ticketId),
        minimumNonce: 4,
        build: async (nonce) => {
            buildStarted.resolve();
            await releaseBuild.promise;
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
            const transaction = Transaction.from(signed);
            return {
                kind: "place",
                context: {
                    chainHash: QUICKNET_CHAIN_HASH,
                    chainId: "296",
                    engine: ENGINE,
                    engineCommitment: `0x${"31".repeat(32)}`,
                    envelopeDigest: `0x${"32".repeat(32)}`,
                    envelopeId: `0x${"33".repeat(32)}`,
                    feePolicyDigest: FEE_POLICY,
                    generation: "7",
                    sessionAccount: ACCOUNT,
                    targetRound: "1",
                    ticketId,
                },
                from: wallet.address.toLowerCase(),
                to: ACCOUNT,
                gasPrice: "10",
                gasLimit: "100000",
                transactionHash: transaction.hash.toLowerCase(),
                calldata: Buffer.from(data.slice(2), "hex"),
                signedTransaction: Buffer.from(signed.slice(2), "hex"),
                simulationBlock: 91,
            };
        },
    });
    await buildStarted.promise;
    const registration = relay.controller.handle(registrationRequest());
    releaseBuild.resolve();
    const orderRecord = await orderPreparation;
    orderRecord.calldata.fill(0);
    orderRecord.signedTransaction.fill(0);
    const registrationResult = await registration;
    assert.equal(registrationResult.status, "PENDING");

    const records = await store.list();
    assert.deepEqual(records.map((record) => record.nonce), [4, 5]);
    assert.deepEqual(
        records.map((record) => record.kind),
        ["place", "registration"],
    );
    const submitted = relay.events.find((event) => event.kind === "broadcast");
    assert.equal(submitted.transaction.nonce, 5);
});

test("restart reconciles and rebroadcasts only the durable registration bytes", async () => {
    const relay = chainHarness({broadcastMode: "pending"});
    const request = registrationRequest();
    const first = await relay.controller.handle(request);
    assert.equal(first.status, "PENDING");
    const firstBroadcast = relay.events.find(
        (event) => event.kind === "broadcast",
    ).transaction;

    const restartedController = new PrivateSessionRegistrationController({
        chainAdapter: relay.createAdapter(),
        allowlist,
    });
    assert.deepEqual(await restartedController.handle(request), first);
    assert.equal(
        relay.events.filter((event) => event.kind === "broadcast").length,
        1,
    );

    relay.pending.delete(first.txHash);
    const unknownRestart = new PrivateSessionRegistrationController({
        chainAdapter: relay.createAdapter(),
        allowlist,
    });
    const rebroadcast = await unknownRestart.handle(request);
    assert.equal(rebroadcast.status, "PENDING");
    assert.equal(rebroadcast.txHash, first.txHash);
    const broadcasts = relay.events.filter(
        (event) => event.kind === "broadcast",
    );
    assert.equal(broadcasts.length, 2);
    assert.equal(broadcasts[1].transaction.hash, firstBroadcast.hash);
    assert.equal(broadcasts[1].transaction.nonce, firstBroadcast.nonce);

    const records = await new DurablePrivateRelayStore({
        directory: relay.transactionDirectory,
    }).list();
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, "registration");
    assert.equal(records[0].transactionHash, first.txHash);
    assert.equal(JSON.stringify(records).includes(request.compliance.proof[0]), false);
});

test("registration balance loss refuses an exact-byte retry broadcast", async () => {
    const relay = chainHarness({broadcastMode: "pending"});
    const request = registrationRequest();
    const first = await relay.controller.handle(request);
    assert.equal(first.status, "PENDING");
    relay.pending.delete(first.txHash);
    relay.state.balance = 100n;

    const restarted = new PrivateSessionRegistrationController({
        chainAdapter: relay.createAdapter(),
        allowlist,
    });
    await assert.rejects(
        restarted.handle(request),
        {code: "RELAYER_BALANCE_TOO_LOW"},
    );
    assert.equal(
        relay.events.filter((event) => event.kind === "broadcast").length,
        1,
    );
});
