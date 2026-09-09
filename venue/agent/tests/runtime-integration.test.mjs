import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, stat, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {Wallet} from "ethers";

import {verifyEvmBuildArtifacts} from "../packaging/evm-verifier-artifacts.mjs";
import {AgentRuntime} from "../runtime/agent-runtime.mjs";
import {AgentControlService} from "../runtime/control-service.mjs";
import {contextId} from "../runtime/context.mjs";
import {HederaProtocolAdapter} from "../runtime/hedera-protocol-adapter.mjs";
import {acquireLauncherLock} from "../runtime/launcher-lock.mjs";
import {LifecycleScheduler} from "../runtime/lifecycle-scheduler.mjs";
import {DeterministicProtocolAdapter} from "../runtime/protocol-adapter.mjs";
import {SanitizedReceiptStore} from "../runtime/receipt-store.mjs";
import {LocalTypedSigner} from "../runtime/signer.mjs";
import {SignerProcess} from "../runtime/signer-process.mjs";
import {EncryptedJournalStore} from "../runtime/store.mjs";
import {AgentSupervisor} from "../runtime/supervisor.mjs";
import {verifyReceiptBundle} from "../verify-receipt.mjs";

const PASSPHRASE = "correct horse battery staple";
const PRIVATE_KEY = `0x${"00".repeat(31)}01`;
const ACCOUNT = new Wallet(PRIVATE_KEY).address.toLowerCase();
const HASHES = {
    protocol: `0x${"01".repeat(32)}`,
    deployment: `0x${"02".repeat(32)}`,
    model: `0x${"03".repeat(32)}`,
    policy: `0x${"04".repeat(32)}`,
    nonce: `0x${"05".repeat(32)}`,
    snapshot: `0x${"06".repeat(32)}`,
    activation: `0x${"07".repeat(32)}`,
};
const ENGINE = "0x543e3c66d040e6f4fd7d066c6fd1e557d4b11dae";
const TOKEN = "0x5efb2ed7b36728d4893156b9ce41b7068fb52fe2";
const FEES = {
    gasLimit: "500000",
    maxFeePerGas: "1000000000",
    maxPriorityFeePerGas: "0",
};

function context() {
    return {
        protocolDomain: HASHES.protocol,
        chainId: "296",
        engine: ENGINE,
        executionAccount: ACCOUNT,
        token: TOKEN,
        side: "BUY",
        price: "2500000",
        quantity: "2",
        recoveryAddress: "0x2000000000000000000000000000000000000002",
        snapshotId: HASHES.snapshot,
        deploymentHash: HASHES.deployment,
        modelBundleHash: HASHES.model,
        policyHash: HASHES.policy,
        mandateNonce: HASHES.nonce,
        decisionSequence: 0,
        publicSlot: "1000",
        expiresAt: "1050",
        features: {
            limitRoomBps: 600,
            recentMoveOffsetBps: 1100,
            roundProgressBps: 5000,
            freshnessSeconds: 30,
            bufferCategory: 1,
            horizonCategory: 1,
        },
    };
}

function mandate() {
    const value = context();
    return {
        schemaVersion: "lattice.agent.mandate.v1",
        identity: {
            chainId: value.chainId,
            executionAccount: value.executionAccount,
            deploymentHash: value.deploymentHash,
            modelBundleHash: value.modelBundleHash,
            policyHash: value.policyHash,
            mandateNonce: value.mandateNonce,
        },
        ticket: {
            engine: value.engine,
            token: value.token,
            side: "BUY",
            quantity: value.quantity,
            limitPrice: value.price,
            recoveryAddress: value.recoveryAddress,
            permittedMethods: ["commit", "reveal", "cancel", "expire", "withdraw"],
        },
        limits: {
            newOrderLimit: 1,
            principalBudget: "5000000",
            bondBudget: "1000000",
            cancellationBudget: "100000",
            feeReserve: "2000000",
            maxPendingOrders: 1,
            decisionSlots: ["1000", "2000", "3000"],
            maxEvaluations: 3,
        },
        time: {
            validFrom: "900",
            lastNewEntryAt: "3100",
            recoveryDeadline: "4000",
            snapshotFreshnessSeconds: 60,
        },
        privacy: {
            mode: "excluded",
            excludedInputs: [
                "credentialMaterial",
                "offPlatformHoldings",
                "privatePreferences",
                "revealSalt",
                "signingKey",
            ],
            releaseFunctionId: "none",
            receiptExportMode: "sanitized",
            externalModelEndpoint: null,
        },
        control: {
            activationId: HASHES.activation,
            revocationGeneration: 0,
            paused: false,
            completeOutstandingObligations: true,
        },
    };
}

async function temporaryDirectory() {
    return mkdtemp(path.join(os.tmpdir(), "lattice-agent-test-"));
}

function sha256(bytes) {
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

test("encrypted journal is atomic, chained, restrictive, and rejects tampering", async () => {
    const rootDir = await temporaryDirectory();
    const store = new EncryptedJournalStore({rootDir});
    assert.equal(await store.initialize(PASSPHRASE), true);
    await Promise.all([
        store.transact(PASSPHRASE, "set-first", (state) => {
            state.receipts.first = {ok: true};
        }),
        store.transact(PASSPHRASE, "set-second", (state) => {
            state.receipts.second = {ok: true};
        }),
    ]);
    const state = await store.read(PASSPHRASE);
    assert.deepEqual(state.receipts, {first: {ok: true}, second: {ok: true}});
    assert.equal((await stat(path.join(rootDir, "journal.enc.json"))).mode & 0o777, 0o600);

    const ciphertext = await readFile(path.join(rootDir, "journal.enc.json"), "utf8");
    assert.equal(ciphertext.includes("first"), false);
    await assert.rejects(() => store.read("this is the wrong password"), {code: "STORE_UNLOCK_FAILED"});

    const envelope = JSON.parse(ciphertext);
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    await writeFile(path.join(rootDir, "journal.enc.json"), JSON.stringify(envelope), {mode: 0o600});
    await assert.rejects(() => store.read(PASSPHRASE), {code: "STORE_UNLOCK_FAILED"});
});

test("typed signer persists tickets before signing and retries exact bytes", async () => {
    const rootDir = await temporaryDirectory();
    const store = new EncryptedJournalStore({rootDir});
    await store.initialize(PASSPHRASE);
    const signer = new LocalTypedSigner({
        store,
        feePolicy: FEES,
        commitBondTinybar: "1000000",
        cancelFeeTinybar: "100000",
    });
    assert.equal(await signer.initializeAccount(PASSPHRASE, PRIVATE_KEY), ACCOUNT);
    const m = mandate();
    const c = context();
    const underfunded = structuredClone(m);
    underfunded.limits.feeReserve = "199999";
    await assert.rejects(
        () => signer.activateMandate(PASSPHRASE, underfunded),
        {code: "FEE_RESERVE_INSUFFICIENT"}
    );
    await signer.activateMandate(PASSPHRASE, m);
    await signer.reserveEvaluation(PASSPHRASE, m, c);
    const approval = {
        actionId: contextId(c),
        commitBond: "1000000",
        decision: "EXECUTE",
        proofVerified: true,
    };
    const commit = await signer.prepareCommit(PASSPHRASE, m, c, {nonce: 0, approval});
    const retry = await signer.prepareCommit(PASSPHRASE, m, c, {nonce: 0, approval});
    assert.equal(retry.signedTransaction, commit.signedTransaction);
    const summary = await signer.summary(PASSPHRASE);
    assert.equal(summary.schemaVersion, "lattice.agent.signer-summary.v2");
    assert.equal(summary.mandates[0].pendingOrders, 1);
    await assert.rejects(
        () => signer.prepareCommit(PASSPHRASE, m, c, {nonce: 2, approval}),
        {code: "NONCE_CHANGE_REFUSED"}
    );

    const reveal = await signer.prepareReveal(PASSPHRASE, m, c, {nonce: 1});
    assert.equal(reveal.projection.commitment, commit.projection.commitment);
    const ticket = (await store.read(PASSPHRASE)).tickets[contextId(c)];
    const receiptCheck = await verifyReceiptBundle(
        {
            schemaVersion: "lattice.agent.post-reveal-bundle.v1",
            stage: "commit",
            mandate: m,
            context: c,
            proof: {test: true},
            salt: ticket.salt,
            commitBondTinybar: "1000000",
            signedTransaction: commit.signedTransaction,
        },
        {
            async verify() {
                return {verified: true, decision: "EXECUTE", modelHash: HASHES.model};
            },
        }
    );
    assert.equal(receiptCheck.transaction.exactProjectionMatched, true);
    const recoveredSigner = new LocalTypedSigner({
        store: new EncryptedJournalStore({rootDir}),
        feePolicy: FEES,
        commitBondTinybar: "1000000",
        cancelFeeTinybar: "100000",
    });
    const recovered = await recoveredSigner.prepareReveal(PASSPHRASE, m, c, {nonce: 1});
    assert.equal(recovered.signedTransaction, reveal.signedTransaction);
});

test("Phase 1 authority and ticket state migrate before journal use", async () => {
    const rootDir = await temporaryDirectory();
    const store = new EncryptedJournalStore({rootDir});
    await store.initialize(PASSPHRASE);
    const signer = new LocalTypedSigner({
        store,
        feePolicy: FEES,
        commitBondTinybar: "1000000",
        cancelFeeTinybar: "100000",
    });
    await signer.initializeAccount(PASSPHRASE, PRIVATE_KEY);
    const m = mandate();
    const c = context();
    const activation = await signer.activateMandate(PASSPHRASE, m);
    await signer.reserveEvaluation(PASSPHRASE, m, c);
    await signer.prepareCommit(PASSPHRASE, m, c, {
        nonce: 0,
        approval: {
            actionId: contextId(c),
            commitBond: "1000000",
            decision: "EXECUTE",
            proofVerified: true,
        },
    });
    await store.transact(PASSPHRASE, "install-phase1-fixture", (state) => {
        const authority = state.authority[activation.mandateId];
        authority.schemaVersion = "lattice.agent.authority-state.v1";
        delete authority.paused;
        const ticket = state.tickets[contextId(c)];
        ticket.schemaVersion = "lattice.agent.ticket.v1";
        delete ticket.cancelNonce;
        delete ticket.cancelFeeReserved;
        delete ticket.expireNonce;
        delete ticket.withdrawNonce;
    });

    const restarted = new LocalTypedSigner({
        store: new EncryptedJournalStore({rootDir}),
        feePolicy: FEES,
        commitBondTinybar: "1000000",
        cancelFeeTinybar: "100000",
    });
    const migration = await restarted.migrateState(PASSPHRASE);
    assert.deepEqual(migration, {migrated: true, authorities: 1, tickets: 1});
    const migrated = await store.read(PASSPHRASE);
    assert.equal(
        migrated.authority[activation.mandateId].schemaVersion,
        "lattice.agent.authority-state.v2"
    );
    assert.equal(migrated.authority[activation.mandateId].paused, false);
    assert.equal(migrated.tickets[contextId(c)].schemaVersion, "lattice.agent.ticket.v2");
    assert.equal(migrated.tickets[contextId(c)].cancelNonce, null);
    assert.equal(migrated.tickets[contextId(c)].cancelFeeReserved, false);
    const reveal = await restarted.prepareReveal(PASSPHRASE, m, c, {nonce: 1});
    assert.equal(reveal.stage, "reveal");
    assert.deepEqual(
        await restarted.migrateState(PASSPHRASE),
        {migrated: false, authorities: 0, tickets: 0}
    );
});

test("local pause refuses new work and preserves outstanding recovery", async () => {
    const rootDir = await temporaryDirectory();
    const store = new EncryptedJournalStore({rootDir});
    await store.initialize(PASSPHRASE);
    const signer = new LocalTypedSigner({
        store,
        feePolicy: FEES,
        commitBondTinybar: "1000000",
        cancelFeeTinybar: "100000",
    });
    await signer.initializeAccount(PASSPHRASE, PRIVATE_KEY);
    const m = mandate();
    const c = context();
    const activation = await signer.activateMandate(PASSPHRASE, m);
    await signer.pauseMandate(PASSPHRASE, {
        mandateId: activation.mandateId,
        paused: true,
    });
    await assert.rejects(
        () => signer.reserveEvaluation(PASSPHRASE, m, c),
        {code: "MANDATE_PAUSED"}
    );
    await signer.pauseMandate(PASSPHRASE, {
        mandateId: activation.mandateId,
        paused: false,
    });
    await signer.reserveEvaluation(PASSPHRASE, m, c);
    await signer.prepareCommit(PASSPHRASE, m, c, {
        nonce: 0,
        approval: {
            actionId: contextId(c),
            commitBond: "1000000",
            decision: "EXECUTE",
            proofVerified: true,
        },
    });
    await signer.pauseMandate(PASSPHRASE, {
        mandateId: activation.mandateId,
        paused: true,
    });
    const reveal = await signer.prepareOutstanding(PASSPHRASE, {
        actionId: contextId(c),
        stage: "reveal",
        nonce: 1,
    });
    assert.equal(reveal.stage, "reveal");
});

test("typed cancel reserves the pinned fee within the mandate budget", async () => {
    const rootDir = await temporaryDirectory();
    const store = new EncryptedJournalStore({rootDir});
    await store.initialize(PASSPHRASE);
    const signer = new LocalTypedSigner({
        store,
        feePolicy: FEES,
        commitBondTinybar: "1000000",
        cancelFeeTinybar: "100000",
    });
    await signer.initializeAccount(PASSPHRASE, PRIVATE_KEY);
    const underfunded = mandate();
    underfunded.limits.cancellationBudget = "99999";
    await assert.rejects(
        () => signer.activateMandate(PASSPHRASE, underfunded),
        {code: "CANCELLATION_BUDGET"}
    );
    const m = mandate();
    const c = context();
    await signer.activateMandate(PASSPHRASE, m);
    await signer.reserveEvaluation(PASSPHRASE, m, c);
    await signer.prepareCommit(PASSPHRASE, m, c, {
        nonce: 0,
        approval: {
            actionId: contextId(c),
            commitBond: "1000000",
            decision: "EXECUTE",
            proofVerified: true,
        },
    });
    await assert.rejects(
        () => signer.prepareOutstanding(PASSPHRASE, {
            actionId: contextId(c),
            stage: "cancel",
            nonce: 0,
        }),
        {code: "NONCE_RESERVED"}
    );
    const cancel = await signer.prepareOutstanding(PASSPHRASE, {
        actionId: contextId(c),
        stage: "cancel",
        nonce: 1,
    });
    const retry = await signer.prepareOutstanding(PASSPHRASE, {
        actionId: contextId(c),
        stage: "cancel",
        nonce: 1,
    });
    assert.equal(retry.signedTransaction, cancel.signedTransaction);
    const state = await store.read(PASSPHRASE);
    assert.equal(
        state.authority[state.tickets[contextId(c)].mandateId].cumulativeCancellationSpent,
        "100000"
    );
});

test("deterministic adapter distinguishes unknown broadcast from rejection", async () => {
    const rootDir = await temporaryDirectory();
    const store = new EncryptedJournalStore({rootDir});
    await store.initialize(PASSPHRASE);
    const signer = new LocalTypedSigner({
        store,
        feePolicy: FEES,
        commitBondTinybar: "1000000",
        cancelFeeTinybar: "100000",
    });
    await signer.initializeAccount(PASSPHRASE, PRIVATE_KEY);
    const m = mandate();
    const c = context();
    await signer.activateMandate(PASSPHRASE, m);
    await signer.reserveEvaluation(PASSPHRASE, m, c);
    const commit = await signer.prepareCommit(PASSPHRASE, m, c, {
        nonce: 0,
        approval: {
            actionId: contextId(c),
            commitBond: "1000000",
            decision: "EXECUTE",
            proofVerified: true,
        },
    });
    const reveal = await signer.prepareReveal(PASSPHRASE, m, c, {nonce: 1});
    const adapter = new DeterministicProtocolAdapter({
        chainId: "296",
        engine: ENGINE,
        executionAccount: ACCOUNT,
        token: TOKEN,
        features: c.features,
    });
    await assert.rejects(() => adapter.broadcast(reveal), {code: "COMMITMENT_MISSING"});
    assert.equal((await adapter.reconcile(reveal.transactionHash)).known, false);
    adapter.setFailureMode("timeout-after-accept");
    await assert.rejects(() => adapter.broadcast(commit), {code: "BROADCAST_UNKNOWN"});
    assert.equal((await adapter.reconcile(commit.transactionHash)).status, "confirmed");
    adapter.setFailureMode("none");
    assert.equal((await adapter.broadcast(commit)).status, "confirmed");
    assert.equal((await adapter.broadcast(reveal)).status, "confirmed");
});

test("headless runtime completes verified decision to reconciled commitment", async () => {
    const rootDir = await temporaryDirectory();
    const store = new EncryptedJournalStore({rootDir});
    await store.initialize(PASSPHRASE);
    const typedSigner = new LocalTypedSigner({
        store,
        feePolicy: FEES,
        commitBondTinybar: "1000000",
        cancelFeeTinybar: "100000",
    });
    await typedSigner.initializeAccount(PASSPHRASE, PRIVATE_KEY);
    const m = mandate();
    const c = context();
    await typedSigner.activateMandate(PASSPHRASE, m);
    const signer = {
        call(method, params) {
            if (method === "reserveEvaluation") {
                return typedSigner.reserveEvaluation(PASSPHRASE, params.mandate, params.context);
            }
            if (method === "prepareCommit") {
                return typedSigner.prepareCommit(
                    PASSPHRASE,
                    params.mandate,
                    params.context,
                    params.request
                );
            }
            if (method === "recordBroadcast") {
                return typedSigner.recordBroadcast(PASSPHRASE, params);
            }
            throw new Error("unexpected test signer method");
        },
    };
    const adapter = new DeterministicProtocolAdapter({
        chainId: "296",
        engine: ENGINE,
        executionAccount: ACCOUNT,
        token: TOKEN,
        features: c.features,
    });
    adapter.setFailureMode("timeout-after-accept");
    const runtime = new AgentRuntime({
        signer,
        adapter,
        worker: {
            async prove() {
                return {
                    proof: {synthetic: true},
                    evidence: {
                        networking: "test-double",
                        readOnlyRoot: true,
                        hostSecretsMounted: false,
                    },
                };
            },
        },
        verifier: {
            async verify() {
                return {
                    verified: true,
                    decision: "EXECUTE",
                    modelHash: HASHES.model,
                    settingsHash: `sha256:${"08".repeat(32)}`,
                    verificationKeyHash: `sha256:${"09".repeat(32)}`,
                };
            },
        },
    });
    const receipt = await runtime.evaluate({mandate: m, context: c, nonce: 0});
    assert.equal(receipt.decision, "EXECUTE");
    assert.equal(receipt.transaction.confirmed, true);
    assert.equal(receipt.transaction.exactProjectionMatched, true);
    assert.match(receipt.transaction.transactionHash, /^0x[0-9a-f]{64}$/);
    assert.equal((await typedSigner.summary(PASSPHRASE)).tickets[0].lifecycle, "SEALED");
});

test("runtime refuses a caller nonce that differs from pending chain state", async () => {
    const c = context();
    let signerCalled = false;
    const runtime = new AgentRuntime({
        signer: {
            async call() {
                signerCalled = true;
                throw new Error("signer must not be reached");
            },
        },
        adapter: new DeterministicProtocolAdapter({
            chainId: "296",
            engine: ENGINE,
            executionAccount: ACCOUNT,
            token: TOKEN,
            features: c.features,
        }),
        worker: {},
        verifier: {},
    });
    await assert.rejects(
        () => runtime.evaluate({mandate: mandate(), context: c, nonce: 1}),
        {code: "NONCE_MISMATCH"}
    );
    assert.equal(signerCalled, false);
});

test("runtime rechecks authorization after proving and before commit signing", async () => {
    const c = context();
    let preflights = 0;
    let prepareCalled = false;
    const adapter = new DeterministicProtocolAdapter({
        chainId: "296",
        engine: ENGINE,
        executionAccount: ACCOUNT,
        token: TOKEN,
        features: c.features,
    });
    adapter.preflight = async () => ({
        checkedAtTimestamp: preflights++ === 0 ? c.publicSlot : "1051",
        identityMatches: true,
        eligible: true,
        halted: false,
        feeBalanceSufficient: true,
    });
    const runtime = new AgentRuntime({
        signer: {
            async call(method) {
                if (method === "reserveEvaluation") return {};
                if (method === "prepareCommit") prepareCalled = true;
                throw new Error("unexpected signer method");
            },
        },
        adapter,
        worker: {
            async prove() {
                return {proof: {synthetic: true}, evidence: {}};
            },
        },
        verifier: {
            async verify() {
                return {
                    verified: true,
                    decision: "EXECUTE",
                    modelHash: HASHES.model,
                    settingsHash: `sha256:${"08".repeat(32)}`,
                    verificationKeyHash: `sha256:${"09".repeat(32)}`,
                };
            },
        },
    });
    await assert.rejects(
        () => runtime.evaluate({mandate: mandate(), context: c, nonce: 0}),
        {code: "AUTHORIZATION_EXPIRED"}
    );
    assert.equal(preflights, 2);
    assert.equal(prepareCalled, false);
});

test("runtime recovers an unresolved first commit by rebroadcasting persisted bytes", async () => {
    const rootDir = await temporaryDirectory();
    const store = new EncryptedJournalStore({rootDir});
    await store.initialize(PASSPHRASE);
    const typedSigner = new LocalTypedSigner({
        store,
        feePolicy: FEES,
        commitBondTinybar: "1000000",
        cancelFeeTinybar: "100000",
    });
    await typedSigner.initializeAccount(PASSPHRASE, PRIVATE_KEY);
    const m = mandate();
    const c = context();
    await typedSigner.activateMandate(PASSPHRASE, m);
    const signer = {
        call(method, params) {
            if (method === "reserveEvaluation") {
                return typedSigner.reserveEvaluation(PASSPHRASE, params.mandate, params.context);
            }
            if (method === "prepareCommit") {
                return typedSigner.prepareCommit(
                    PASSPHRASE,
                    params.mandate,
                    params.context,
                    params.request
                );
            }
            if (method === "recordBroadcast") {
                return typedSigner.recordBroadcast(PASSPHRASE, params);
            }
            if (method === "action") {
                return typedSigner.action(PASSPHRASE, params.actionId);
            }
            throw new Error("unexpected test signer method");
        },
    };
    const adapter = new DeterministicProtocolAdapter({
        chainId: "296",
        engine: ENGINE,
        executionAccount: ACCOUNT,
        token: TOKEN,
        features: c.features,
    });
    adapter.setFailureMode("timeout-before-accept");
    const runtime = new AgentRuntime({
        signer,
        adapter,
        worker: {
            async prove() {
                return {proof: {synthetic: true}, evidence: {}};
            },
        },
        verifier: {
            async verify() {
                return {
                    verified: true,
                    decision: "EXECUTE",
                    modelHash: HASHES.model,
                    settingsHash: `sha256:${"08".repeat(32)}`,
                    verificationKeyHash: `sha256:${"09".repeat(32)}`,
                };
            },
        },
    });
    await assert.rejects(
        () => runtime.evaluate({mandate: m, context: c, nonce: 0}),
        {code: "RECOVERY_REQUIRED"}
    );
    const persisted = await typedSigner.action(PASSPHRASE, contextId(c));
    adapter.setFailureMode("none");
    const accountNonces = adapter.accountNonces.bind(adapter);
    adapter.accountNonces = undefined;
    await assert.rejects(
        () => runtime.recoverAction({actionId: contextId(c), nonce: 1}),
        {code: "NONCE_STATE_UNAVAILABLE"}
    );
    adapter.accountNonces = accountNonces;
    const recovered = await runtime.recoverAction({actionId: contextId(c), nonce: 1});
    assert.equal(recovered.stage, "commit");
    assert.equal(recovered.after.lifecycle, "REVEALABLE");
    assert.equal(
        recovered.transaction.transactionHash,
        persisted.transactions.commit.transactionHash
    );
    assert.equal((await typedSigner.summary(PASSPHRASE)).tickets[0].lifecycle, "SEALED");
});

test("runtime completes a commit ticket left unsigned by a signer crash", async () => {
    const rootDir = await temporaryDirectory();
    const durableStore = new EncryptedJournalStore({rootDir});
    await durableStore.initialize(PASSPHRASE);
    let failCommitPersistence = false;
    const crashingStore = {
        read: durableStore.read.bind(durableStore),
        async transact(passphrase, operation, update) {
            if (operation === "persist-commit" && failCommitPersistence) {
                failCommitPersistence = false;
                throw Object.assign(new Error("simulated signer crash"), {code: "SIMULATED_CRASH"});
            }
            return durableStore.transact(passphrase, operation, update);
        },
    };
    const crashingSigner = new LocalTypedSigner({
        store: crashingStore,
        feePolicy: FEES,
        commitBondTinybar: "1000000",
        cancelFeeTinybar: "100000",
    });
    await crashingSigner.initializeAccount(PASSPHRASE, PRIVATE_KEY);
    const m = mandate();
    const c = context();
    await crashingSigner.activateMandate(PASSPHRASE, m);
    await crashingSigner.reserveEvaluation(PASSPHRASE, m, c);
    failCommitPersistence = true;
    await assert.rejects(
        () => crashingSigner.prepareCommit(PASSPHRASE, m, c, {
            nonce: 0,
            approval: {
                actionId: contextId(c),
                commitBond: "1000000",
                decision: "EXECUTE",
                proofVerified: true,
            },
        }),
        {code: "SIMULATED_CRASH"}
    );
    const interrupted = await durableStore.read(PASSPHRASE);
    assert.equal(interrupted.tickets[contextId(c)].lifecycle, "TICKET_SAVED");
    assert.equal(interrupted.signedTransactions[`${contextId(c)}:commit`], undefined);

    const recoveredSigner = new LocalTypedSigner({
        store: new EncryptedJournalStore({rootDir}),
        feePolicy: FEES,
        commitBondTinybar: "1000000",
        cancelFeeTinybar: "100000",
    });
    const signer = {
        call(method, params) {
            if (method === "action") {
                return recoveredSigner.action(PASSPHRASE, params.actionId);
            }
            if (method === "preparePersistedCommit") {
                return recoveredSigner.preparePersistedCommit(PASSPHRASE, params.actionId);
            }
            if (method === "recordBroadcast") {
                return recoveredSigner.recordBroadcast(PASSPHRASE, params);
            }
            throw new Error(`unexpected test signer method ${method}`);
        },
    };
    const adapter = new DeterministicProtocolAdapter({
        chainId: "296",
        engine: ENGINE,
        executionAccount: ACCOUNT,
        token: TOKEN,
        features: c.features,
    });
    const runtime = new AgentRuntime({signer, adapter, worker: {}, verifier: {}});
    const recovered = await runtime.recoverAction({actionId: contextId(c), nonce: 0});
    assert.equal(recovered.stage, "commit");
    assert.equal(recovered.after.lifecycle, "REVEALABLE");
    const action = await recoveredSigner.action(PASSPHRASE, contextId(c));
    assert.equal(action.transactions.commit.broadcastStatus, "confirmed");
    assert.equal(action.lifecycle, "SEALED");
});

test("expired unsigned commit is abandoned even while protocol preflight is refused", async () => {
    const c = context();
    const actionId = contextId(c);
    let abandoned = false;
    const runtime = new AgentRuntime({
        signer: {
            async call(method) {
                if (method === "action") {
                    return {
                        actionId,
                        mandate: mandate(),
                        authority: {paused: false},
                        context: c,
                        commitment: `0x${"21".repeat(32)}`,
                        reservedNonces: {commit: 0},
                        transactions: {
                            commit: null,
                            reveal: null,
                            cancel: null,
                            expire: null,
                            withdraw: null,
                        },
                    };
                }
                if (method === "abandonUnsignedCommit") {
                    abandoned = true;
                    return {actionId, lifecycle: "ABANDONED_UNSIGNED", nonceReleased: true};
                }
                throw new Error(`unexpected signer method ${method}`);
            },
        },
        adapter: {
            async readAction() {
                return {lifecycle: "UNKNOWN", creditTinybar: "0"};
            },
            async preflight() {
                return {
                    checkedAtTimestamp: "1051",
                    liveChainChecked: false,
                    identityMatches: true,
                    eligible: false,
                    halted: true,
                    feeBalanceSufficient: false,
                };
            },
        },
        worker: {},
        verifier: {},
    });
    const result = await runtime.recoverAction({actionId, nonce: 0});
    assert.equal(result.state.lifecycle, "ABANDONED_UNSIGNED");
    assert.equal(result.nextAction, "none");
    assert.equal(abandoned, true);
});

test("commit persistence refuses an abandonment race and leaves the nonce released", async () => {
    const rootDir = await temporaryDirectory();
    const durableStore = new EncryptedJournalStore({rootDir});
    await durableStore.initialize(PASSPHRASE);
    let persistenceMode = "crash";
    let abandoningSigner = null;
    const interceptedStore = {
        read: durableStore.read.bind(durableStore),
        async transact(passphrase, operation, update) {
            if (operation === "persist-commit" && persistenceMode === "crash") {
                persistenceMode = "normal";
                throw Object.assign(new Error("simulated crash"), {code: "SIMULATED_CRASH"});
            }
            if (operation === "persist-commit" && persistenceMode === "abandon") {
                persistenceMode = "normal";
                await abandoningSigner.abandonUnsignedCommit(passphrase, contextId(context()));
            }
            return durableStore.transact(passphrase, operation, update);
        },
    };
    const signer = new LocalTypedSigner({
        store: interceptedStore,
        feePolicy: FEES,
        commitBondTinybar: "1000000",
        cancelFeeTinybar: "100000",
    });
    await signer.initializeAccount(PASSPHRASE, PRIVATE_KEY);
    const m = mandate();
    const c = context();
    await signer.activateMandate(PASSPHRASE, m);
    await signer.reserveEvaluation(PASSPHRASE, m, c);
    await assert.rejects(
        () => signer.prepareCommit(PASSPHRASE, m, c, {
            nonce: 0,
            approval: {
                actionId: contextId(c),
                commitBond: "1000000",
                decision: "EXECUTE",
                proofVerified: true,
            },
        }),
        {code: "SIMULATED_CRASH"}
    );

    abandoningSigner = new LocalTypedSigner({
        store: durableStore,
        feePolicy: FEES,
        commitBondTinybar: "1000000",
        cancelFeeTinybar: "100000",
    });
    persistenceMode = "abandon";
    await assert.rejects(
        () => signer.preparePersistedCommit(PASSPHRASE, contextId(c)),
        {code: "SIGNING_RESERVATION_CHANGED"}
    );
    const state = await durableStore.read(PASSPHRASE);
    assert.equal(state.tickets[contextId(c)].lifecycle, "ABANDONED_UNSIGNED");
    assert.equal(state.tickets[contextId(c)].commitNonce, null);
    assert.equal(state.signedTransactions[`${contextId(c)}:commit`], undefined);
});

test("recovery waits rather than withdrawing account credit during an active auction", async () => {
    const c = context();
    let reads = 0;
    const runtime = new AgentRuntime({
        signer: {
            async call(method) {
                assert.equal(method, "action");
                return {
                    actionId: contextId(c),
                    mandate: mandate(),
                    context: c,
                    commitment: `0x${"11".repeat(32)}`,
                    transactions: {commit: {}, reveal: {}, cancel: null, expire: null, withdraw: null},
                };
            },
        },
        adapter: {
            async readAction() {
                reads += 1;
                return {lifecycle: "IN_AUCTION", creditTinybar: "1"};
            },
        },
        worker: {},
        verifier: {},
    });
    const result = await runtime.recoverAction({actionId: contextId(c), nonce: 2});
    assert.equal(result.schemaVersion, "lattice.agent.lifecycle-wait.v1");
    assert.equal(result.nextAction, "wait-for-auction-or-expiry");
    assert.equal(reads, 1);
});

test("recovery cancels a sealed action after its mandate is paused", async () => {
    const c = context();
    const runtime = new AgentRuntime({
        signer: {
            async call(method) {
                assert.equal(method, "action");
                return {
                    actionId: contextId(c),
                    mandate: mandate(),
                    authority: {paused: true, revocationGeneration: 0},
                    context: c,
                    commitment: `0x${"17".repeat(32)}`,
                    transactions: {commit: {}, reveal: null, cancel: null, expire: null, withdraw: null},
                };
            },
        },
        adapter: {
            async readAction() {
                return {lifecycle: "SEALED", creditTinybar: "0"};
            },
        },
        worker: {},
        verifier: {},
    });
    runtime.continueAction = async (request) => request;
    const result = await runtime.recoverAction({actionId: contextId(c), nonce: 12});
    assert.deepEqual(result, {
        actionId: contextId(c),
        stage: "cancel",
        nonce: 12,
    });
});

test("live action accounting reads every contract value at one block", async () => {
    const blockTags = [];
    const atBlock = (...args) => {
        blockTags.push(args.at(-1).blockTag);
    };
    const adapter = Object.create(HederaProtocolAdapter.prototype);
    adapter.executionAccount = ACCOUNT;
    adapter.manifest = {
        immutables: {
            revealDelaySeconds: 5,
            revealWindowSeconds: 60,
        },
    };
    adapter.provider = {
        async getBlock(tag) {
            assert.equal(tag, "latest");
            return {number: 77, timestamp: 1100};
        },
    };
    adapter.engine = {
        async commitments(...args) {
            atBlock(...args);
            return {
                committer: ACCOUNT,
                committedAt: 1000n,
                revealed: true,
                cancelled: false,
                bond: 1000000n,
            };
        },
        async orders(...args) {
            atBlock(...args);
            return {
                trader: ACCOUNT,
                side: 0n,
                price: 2500000n,
                qty: 2n,
                filled: 0n,
                revealedAt: 1070n,
                firstRound: 1n,
                lastRound: 1n,
                retired: false,
            };
        },
        async backingOf(...args) {
            atBlock(...args);
            return {holdId: 0n, snapshot: 5000000n, escrow: 5000000n};
        },
        async credit(...args) {
            atBlock(...args);
            return 123n;
        },
        async currentRound(...args) {
            atBlock(...args);
            return 1n;
        },
        async isLive(...args) {
            atBlock(...args);
            return true;
        },
        async roundEnd(...args) {
            atBlock(...args);
            return 1200n;
        },
    };
    const result = await adapter.readAction({
        commitment: `0x${"11".repeat(32)}`,
        account: ACCOUNT,
    });
    assert.equal(result.observedAtBlock, 77);
    assert.equal(result.observedAtTimestamp, "1100");
    assert.equal(result.retireAfter, "1200");
    assert.deepEqual(blockTags, [77, 77, 77, 77, 77, 77, 77]);
});

test("live protocol preflight reads eligibility and funding at one block", async () => {
    const reads = [];
    const adapter = Object.create(HederaProtocolAdapter.prototype);
    adapter.executionAccount = ACCOUNT;
    adapter.engineAddress = ENGINE;
    adapter.tokenAddress = TOKEN;
    adapter.deploymentHash = HASHES.deployment;
    adapter.lastDeploymentEvidence = {status: "passed"};
    adapter.manifest = {
        network: {chainId: "296"},
        immutables: {commitBondTinybar: "1000000"},
    };
    adapter.provider = {
        async getBlock(tag) {
            assert.equal(tag, "latest");
            return {number: 88, timestamp: 1200};
        },
        async getBalance(account, blockTag) {
            assert.equal(account, ACCOUNT);
            reads.push(["balance", blockTag]);
            return 10n ** 30n;
        },
    };
    const pinned = (name, args) => {
        reads.push([name, args.at(-1).blockTag]);
    };
    adapter.registry = {
        async getKycStatus(...args) {
            pinned("kycStatus", args);
            return 1n;
        },
        async currentEpoch(...args) {
            pinned("kycEpoch", args);
            return 3n;
        },
    };
    adapter.halt = {
        async haltedNow(...args) {
            pinned("halted", args);
            return false;
        },
    };
    adapter.parameterRoot = {
        async currentEpoch(...args) {
            pinned("policyEpoch", args);
            return 4n;
        },
    };
    const result = await adapter.preflight({
        chainId: "296",
        deploymentHash: HASHES.deployment,
        engine: ENGINE,
        executionAccount: ACCOUNT,
        feeReserveTinybar: "1",
        price: "1",
        quantity: "1",
        stage: "commit",
        token: TOKEN,
    });
    assert.equal(result.checkedAtBlock, 88);
    assert.equal(result.checkedAtTimestamp, "1200");
    assert.equal(result.eligible, true);
    assert.equal(result.halted, false);
    assert.equal(result.feeBalanceSufficient, true);
    assert.deepEqual(reads, [
        ["kycStatus", 88],
        ["halted", 88],
        ["balance", 88],
        ["policyEpoch", 88],
        ["kycEpoch", 88],
    ]);
});

test("EVM verifier evidence recomputes hashes from deployed artifacts", () => {
    const artifacts = {
        abiBytes: Buffer.from("[{\"type\":\"function\"}]"),
        verifierBytes: Buffer.from("contract Halo2Verifier {}"),
        proofBytes: Buffer.from("{\"proof\":\"0x01\"}"),
        calldataBytes: Buffer.from("010203", "hex"),
    };
    const build = {
        verifierSolidityHash: sha256(artifacts.verifierBytes),
        verifierAbiHash: sha256(artifacts.abiBytes),
        proofHash: sha256(artifacts.proofBytes),
        calldataHash: sha256(artifacts.calldataBytes),
        calldataBytes: artifacts.calldataBytes.length,
    };
    assert.deepEqual(verifyEvmBuildArtifacts({...artifacts, build}), build);
    assert.throws(
        () => verifyEvmBuildArtifacts({
            ...artifacts,
            proofBytes: Buffer.from("{\"proof\":\"0x02\"}"),
            build,
        }),
        {code: "EVM_ARTIFACT_MISMATCH"}
    );
});

test("reveal rechecks protocol eligibility before signing", async () => {
    const m = mandate();
    const c = context();
    let signingRequested = false;
    const runtime = new AgentRuntime({
        signer: {
            async call(method) {
                if (method === "action") {
                    return {
                        actionId: contextId(c),
                        mandate: m,
                        context: c,
                        commitment: `0x${"11".repeat(32)}`,
                        transactions: {reveal: null},
                    };
                }
                signingRequested = true;
                throw new Error("signing must not be reached");
            },
        },
        adapter: {
            async preflight() {
                return {
                    checkedAtTimestamp: c.publicSlot,
                    identityMatches: true,
                    eligible: false,
                    halted: false,
                    feeBalanceSufficient: true,
                };
            },
        },
        worker: {},
        verifier: {},
    });
    await assert.rejects(
        () => runtime.continueAction({
            actionId: contextId(c),
            stage: "reveal",
            nonce: 1,
        }),
        {code: "REVEAL_PREFLIGHT_REFUSED"}
    );
    assert.equal(signingRequested, false);
});

test("native control service previews one bounded mandate and consumes confirmation once", async () => {
    let activated = null;
    let evaluated = null;
    const snapshot = {
        snapshotId: `0x${"11".repeat(32)}`,
        blockNumber: 200,
        blockHash: `0x${"12".repeat(32)}`,
        publicSlot: String(Math.floor(Date.now() / 1000)),
        currentRound: "4",
        limitPrice: "119",
        quantity: "10",
        features: context().features,
        authenticatedAgainstChain: true,
        authenticationTag: `hmac-sha256:${"13".repeat(32)}`,
    };
    const adapter = {
        manifest: {
            network: {chainId: "296"},
            immutables: {
                commitBondTinybar: "1000000",
                cancelFeeTinybar: "100000",
            },
        },
        engineAddress: ENGINE,
        executionAccount: ACCOUNT,
        tokenAddress: TOKEN,
        deploymentHash: HASHES.deployment,
        snapshot: async () => structuredClone(snapshot),
        preflight: async () => ({
            checkedAtBlock: 200,
            eligible: true,
            halted: false,
            feeBalanceSufficient: true,
        }),
        nextNonce: async () => 9,
    };
    const signer = {
        async call(method, params) {
            assert.equal(method, "activateMandate");
            activated = params.mandate;
            return {mandateId: `sha256:${"14".repeat(32)}`};
        },
    };
    const runtime = {
        async evaluate(request) {
            evaluated = request;
            return {
                schemaVersion: "lattice.agent.decision-receipt.v1",
                actionId: contextId(request.context),
                decision: "WAIT",
            };
        },
    };
    const control = new AgentControlService({
        signer,
        adapter,
        runtime,
        modelHash: `sha256:${"15".repeat(32)}`,
        policyHash: `0x${"16".repeat(32)}`,
        feePolicy: FEES,
    });
    const preview = await control.preview({limitPrice: "119", quantity: "10"});
    assert.equal(preview.side, "BUY");
    assert.equal(preview.principalBudget, "1190");
    assert.equal(preview.preflight.eligible, true);
    assert.equal(JSON.stringify(preview).includes("authenticationTag"), false);
    assert.equal(JSON.stringify(preview).includes("mandateNonce"), false);

    const execution = await control.execute({previewId: preview.previewId});
    assert.equal(execution.receipt.decision, "WAIT");
    assert.equal(activated.ticket.limitPrice, "119");
    assert.deepEqual(activated.limits.decisionSlots, [snapshot.publicSlot]);
    assert.equal(evaluated.nonce, 9);
    assert.equal(evaluated.snapshot.authenticationTag, snapshot.authenticationTag);
    await assert.rejects(
        () => control.execute({previewId: preview.previewId}),
        {code: "PREVIEW_MISSING"}
    );
});

test("sanitized receipt store survives restart and rejects private fields or tampering", async () => {
    const rootDir = await temporaryDirectory();
    const actionId = `sha256:${"a".repeat(64)}`;
    const mandateId = `sha256:${"b".repeat(64)}`;
    const receiptStore = new SanitizedReceiptStore({
        directory: path.join(rootDir, "receipts"),
        now: () => "2026-09-09T09:00:00.000Z",
    });
    await receiptStore.initialize();
    await receiptStore.recordEvaluation({
        receipt: {
            schemaVersion: "lattice.agent.decision-receipt.v1",
            actionId,
            decision: "EXECUTE",
            inference: {
                status: "verified",
                proofHash: `sha256:${"c".repeat(64)}`,
            },
            worker: {networking: "docker-none"},
            transaction: {transactionHash: null},
            commitment: null,
            limitations: [],
        },
        mandateId,
        snapshot: {
            snapshotId: `0x${"01".repeat(32)}`,
            blockNumber: 100,
            blockHash: `0x${"02".repeat(32)}`,
            publicSlot: "1000",
            currentRound: "3",
            limitPrice: "119",
            quantity: "10",
            features: context().features,
            authenticatedAgainstChain: true,
            authenticationTag: `hmac-sha256:${"03".repeat(32)}`,
        },
    });
    await receiptStore.recordStep({
        schemaVersion: "lattice.agent.lifecycle-step.v1",
        actionId,
        stage: "commit",
        commitment: `0x${"04".repeat(32)}`,
        transaction: {
            transactionHash: `0x${"05".repeat(32)}`,
            status: "confirmed",
            blockNumber: 101,
            gasUsed: "40000",
            logs: [],
            exactProjectionMatched: true,
        },
        before: {lifecycle: "UNKNOWN"},
        after: {lifecycle: "SEALED"},
        protocolPreflight: null,
    });

    const restarted = new SanitizedReceiptStore({directory: path.join(rootDir, "receipts")});
    const records = await restarted.list();
    assert.equal(records.length, 1);
    assert.equal(records[0].lifecycle.steps[0].stage, "commit");
    assert.equal(JSON.stringify(records).includes("authenticationTag"), false);
    assert.equal(JSON.stringify(records).includes("hmac-sha256"), false);
    assert.equal((await stat(path.join(rootDir, "receipts", "receipts.json"))).mode & 0o777, 0o600);
    await assert.rejects(
        () => restarted.recordStep({
            actionId,
            stage: "reveal",
            commitment: `0x${"04".repeat(32)}`,
            transaction: {proofBody: "private"},
            before: {},
            after: {},
        }),
        {code: "PRIVATE_FIELD_REFUSED"}
    );
    await assert.rejects(
        () => restarted.recordStep({
            actionId,
            stage: "reveal",
            commitment: `0x${"04".repeat(32)}`,
            transaction: {private_key: "private"},
            before: {},
            after: {},
        }),
        {code: "PRIVATE_FIELD_REFUSED"}
    );
    await restarted.recordError(actionId, {
        code: "RPC_FAILED",
        message: "private diagnostic material must not be persisted",
    });
    assert.equal(
        JSON.stringify(await restarted.list()).includes("private diagnostic material"),
        false
    );

    const file = path.join(rootDir, "receipts", "receipts.json");
    const tampered = JSON.parse(await readFile(file, "utf8"));
    tampered.records[actionId].commitment = `0x${"ff".repeat(32)}`;
    await writeFile(file, JSON.stringify(tampered), "utf8");
    await assert.rejects(() => restarted.list(), {code: "STORE_RECORD_INVALID"});
});

test("lifecycle scheduler serializes recovery and persists each public step", async () => {
    const rootDir = await temporaryDirectory();
    const actionId = `sha256:${"d".repeat(64)}`;
    const mandateId = `sha256:${"e".repeat(64)}`;
    const commitment = `0x${"06".repeat(32)}`;
    const receiptStore = new SanitizedReceiptStore({directory: path.join(rootDir, "receipts")});
    await receiptStore.initialize();
    await receiptStore.ensureAction({actionId, mandateId, commitment});

    const signer = {
        async call(method) {
            if (method === "summary") return {tickets: [{actionId}]};
            if (method === "action") return {actionId, mandateId, commitment};
            throw new Error(`unexpected signer method ${method}`);
        },
    };
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    let recoveryCalls = 0;
    const runtime = {
        receiptStore: null,
        async recoverAction({nonce}) {
            recoveryCalls += 1;
            assert.equal(nonce, 7);
            await gate;
            return {
                schemaVersion: "lattice.agent.lifecycle-step.v1",
                actionId,
                stage: "reveal",
                commitment,
                transaction: {
                    transactionHash: `0x${"07".repeat(32)}`,
                    status: "confirmed",
                    blockNumber: 102,
                    gasUsed: "50000",
                    logs: [],
                    exactProjectionMatched: true,
                },
                before: {lifecycle: "REVEALABLE"},
                after: {lifecycle: "IN_AUCTION"},
                protocolPreflight: {eligible: true},
            };
        },
    };
    const scheduler = new LifecycleScheduler({
        signer,
        adapter: {accountNonces: async () => ({latest: 7, pending: 7})},
        runtime,
        receiptStore,
        intervalMilliseconds: 1_000,
    });
    const active = scheduler.runOnce();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await scheduler.runOnce()).skipped, true);
    release();
    const run = await active;
    assert.equal(run.stepsCompleted, 1);
    assert.equal(recoveryCalls, 1);
    assert.equal(scheduler.status().stepsCompleted, 1);
    const [record] = await receiptStore.list();
    assert.equal(record.lifecycle.steps[0].stage, "reveal");
    assert.equal(record.lifecycle.latestState.lifecycle, "IN_AUCTION");
});

test("scheduler continues after one action fails and receipt writes cannot block recovery", async () => {
    const firstActionId = `sha256:${"1".repeat(64)}`;
    const secondActionId = `sha256:${"2".repeat(64)}`;
    const visited = [];
    const signer = {
        async call(method, params) {
            if (method === "summary") {
                return {tickets: [{actionId: firstActionId}, {actionId: secondActionId}]};
            }
            if (method === "action") {
                return {
                    actionId: params.actionId,
                    mandateId: `sha256:${"3".repeat(64)}`,
                    commitment: `0x${"04".repeat(32)}`,
                };
            }
            throw new Error(`unexpected signer method ${method}`);
        },
    };
    const runtime = {
        receiptStore: null,
        async recoverAction({actionId}) {
            visited.push(actionId);
            if (actionId === firstActionId) {
                throw Object.assign(new Error("first action failed"), {code: "FIRST_FAILED"});
            }
            return {
                schemaVersion: "lattice.agent.lifecycle-step.v1",
                actionId,
                stage: "withdraw",
            };
        },
    };
    const failingReceiptStore = new Proxy({}, {
        get() {
            return async () => {
                throw new Error("receipt store unavailable");
            };
        },
    });
    const scheduler = new LifecycleScheduler({
        signer,
        adapter: {accountNonces: async () => ({latest: 4, pending: 4})},
        runtime,
        receiptStore: failingReceiptStore,
    });
    const result = await scheduler.runOnce();
    assert.deepEqual(visited, [firstActionId, secondActionId]);
    assert.equal(result.actionsVisited, 2);
    assert.equal(result.stepsCompleted, 1);
    assert.deepEqual(result.failures, [{actionId: firstActionId, code: "FIRST_FAILED"}]);
});

test("operating-system launcher lock refuses a duplicate and releases cleanly", async (t) => {
    const rootDir = await temporaryDirectory();
    const release = await acquireLauncherLock(rootDir);
    t.after(release);
    await assert.rejects(
        () => acquireLauncherLock(rootDir),
        /local agent launcher is already running/
    );
    assert.equal((await stat(path.join(rootDir, "launcher.lock"))).mode & 0o777, 0o600);
    await release();

    const contenders = await Promise.all(
        Array.from({length: 20}, () =>
            acquireLauncherLock(rootDir).then(
                (releaseContender) => ({release: releaseContender}),
                (error) => ({error})
            )
        )
    );
    const owners = contenders.filter((result) => result.release !== undefined);
    for (const owner of owners) t.after(owner.release);
    assert.equal(owners.length, 1);
    assert.equal(
        contenders.filter((result) => /already running/.test(result.error?.message ?? "")).length,
        19
    );
    await owners[0].release();
    await assert.rejects(() => stat(path.join(rootDir, "launcher.lock")), {code: "ENOENT"});
});

test("loopback supervisor requires exact origin, pairing, session, and CSRF", async () => {
    const rootDir = await temporaryDirectory();
    const appRoot = path.join(rootDir, "app");
    await mkdir(path.join(appRoot, "vendor"), {recursive: true});
    await mkdir(path.join(appRoot, "claw"), {recursive: true});
    await writeFile(
        path.join(appRoot, "trade.html"),
        "<title>Local Markets</title><script src=\"vendor/ethers-6.13.5.umd.min.js\"></script>",
        "utf8"
    );
    await writeFile(
        path.join(appRoot, "vendor", "ethers-6.13.5.umd.min.js"),
        "globalThis.ethers = Object.freeze({});",
        "utf8"
    );
    await writeFile(
        path.join(appRoot, "claw", "index.html"),
        "<title>Lattice Claw</title><p>COMING SOON</p>",
        "utf8"
    );
    const signer = new SignerProcess({
        stateDir: rootDir,
        feePolicy: FEES,
        commitBondTinybar: "1000000",
        cancelFeeTinybar: "100000",
    });
    const adapter = new DeterministicProtocolAdapter({
        chainId: "296",
        engine: ENGINE,
        executionAccount: ACCOUNT,
        token: TOKEN,
        features: context().features,
    });
    const supervisor = new AgentSupervisor({signer, adapter, appRoot});
    const launch = await supervisor.start();
    try {
        const clawPage = await fetch(`${launch.origin}/claw/`);
        assert.equal(clawPage.status, 200);
        assert.equal(clawPage.headers.get("cache-control"), "no-store");
        assert.match(clawPage.headers.get("content-security-policy"), /default-src 'none'/);
        assert.match(clawPage.headers.get("content-security-policy"), /connect-src 'none'/);
        assert.match(
            clawPage.headers.get("content-security-policy"),
            /style-src 'nonce-[A-Za-z0-9+/=]+'/
        );
        assert.doesNotMatch(clawPage.headers.get("content-security-policy"), /unsafe-inline/);
        assert.doesNotMatch(await clawPage.text(), /__LATTICE_AGENT_BOOTSTRAP__|<script\b/);

        const page = await fetch(`${launch.origin}/trade.html`);
        assert.equal(page.status, 200);
        assert.equal(page.headers.get("cache-control"), "no-store");
        assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);
        assert.doesNotMatch(page.headers.get("content-security-policy"), /fonts\.googleapis/);
        assert.match(page.headers.get("content-security-policy"), /script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
        assert.doesNotMatch(
            /script-src[^;]+/.exec(page.headers.get("content-security-policy"))[0],
            /unsafe-inline/
        );
        const pageBody = await page.text();
        const bootstrapMatch = /__LATTICE_AGENT_BOOTSTRAP__=(\{[^<]+\});<\/script>/.exec(pageBody);
        assert.notEqual(bootstrapMatch, null);
        const browserBootstrap = JSON.parse(bootstrapMatch[1]);
        assert.equal(browserBootstrap.origin, launch.origin);
        assert.notEqual(browserBootstrap.pairingToken, launch.pairingToken);
        assert.equal(page.url.includes(browserBootstrap.pairingToken), false);

        const browserPair = await fetch(`${launch.origin}/v1/pair`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Origin: launch.origin,
                Authorization: `Bearer ${browserBootstrap.pairingToken}`,
            },
            body: "{}",
        });
        assert.equal(browserPair.status, 200);
        const browserSession = await browserPair.json();
        const browserStatus = await fetch(`${launch.origin}/v1/status`, {
            headers: {
                Authorization: `Bearer ${browserSession.sessionToken}`,
            },
        });
        assert.equal(browserStatus.status, 200);

        const queryCapability = await fetch(`${launch.origin}/trade.html?pair=${launch.pairingToken}`);
        assert.equal(queryCapability.status, 400);

        const hostile = await fetch(`${launch.origin}/v1/pair`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Origin: "https://hostile.example",
                Authorization: `Bearer ${launch.pairingToken}`,
            },
            body: "{}",
        });
        assert.equal(hostile.status, 403);

        const paired = await fetch(`${launch.origin}/v1/pair`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Origin: launch.origin,
                Authorization: `Bearer ${launch.pairingToken}`,
            },
            body: "{}",
        });
        assert.equal(paired.status, 200);
        const session = await paired.json();
        assert.equal(typeof session.sessionToken, "string");
        assert.equal(typeof session.csrfToken, "string");

        const missingCsrf = await fetch(`${launch.origin}/v1/setup`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Origin: launch.origin,
                Authorization: `Bearer ${session.sessionToken}`,
            },
            body: JSON.stringify({passphrase: PASSPHRASE}),
        });
        assert.equal(missingCsrf.status, 403);

        const setup = await fetch(`${launch.origin}/v1/setup`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Origin: launch.origin,
                Authorization: `Bearer ${session.sessionToken}`,
                "X-CSRF-Token": session.csrfToken,
            },
            body: JSON.stringify({passphrase: PASSPHRASE}),
        });
        assert.equal(setup.status, 200);
        const setupBody = await setup.json();
        assert.match(setupBody.result.address, /^0x[0-9a-f]{40}$/);

        const summary = await fetch(`${launch.origin}/v1/signer/summary`, {
            headers: {
                Origin: launch.origin,
                Authorization: `Bearer ${session.sessionToken}`,
            },
        });
        assert.equal(summary.status, 200);
        assert.equal((await summary.json()).result.tickets.length, 0);

        const privateActionRoute = await fetch(`${launch.origin}/v1/actions/read`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Origin: launch.origin,
                Authorization: `Bearer ${session.sessionToken}`,
                "X-CSRF-Token": session.csrfToken,
            },
            body: JSON.stringify({actionId: `sha256:${"aa".repeat(32)}`}),
        });
        assert.equal(privateActionRoute.status, 404);
    } finally {
        await supervisor.stop();
        await signer.stop();
    }
});

test("supervisor configures runtime services only after signer setup", async () => {
    let configuredAddress = null;
    let schedulerStarted = false;
    let runtimeClosed = false;
    const signer = {
        async call(method) {
            if (method === "initializeStore") return {initialized: true};
            if (method === "initializeAccount") return {address: ACCOUNT};
            throw new Error(`unexpected signer method ${method}`);
        },
    };
    const supervisor = new AgentSupervisor({
        signer,
        runtimeFactory: async (address) => {
            configuredAddress = address;
            const scheduler = {
                start() {
                    schedulerStarted = true;
                },
                status() {
                    return {running: schedulerStarted};
                },
                async runOnce() {
                    return {skipped: false, actionsVisited: 0, stepsCompleted: 0, failures: []};
                },
            };
            return {
                adapter: {lastDeploymentEvidence: {accepted: true}},
                runtime: {},
                receiptStore: {list: async () => [{actionId: `sha256:${"f".repeat(64)}`}]},
                scheduler,
                control: {
                    preview: async (body) => ({...body, previewId: "preview"}),
                    execute: async () => ({decision: "WAIT"}),
                },
                close: async () => {
                    runtimeClosed = true;
                },
            };
        },
    });
    const launch = await supervisor.start();
    try {
        const pair = await fetch(`${launch.origin}/v1/pair`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Origin: launch.origin,
                Authorization: `Bearer ${launch.pairingToken}`,
            },
            body: "{}",
        });
        const session = await pair.json();
        const headers = {
            "Content-Type": "application/json",
            Origin: launch.origin,
            Authorization: `Bearer ${session.sessionToken}`,
            "X-CSRF-Token": session.csrfToken,
        };
        const setup = await fetch(`${launch.origin}/v1/setup`, {
            method: "POST",
            headers,
            body: JSON.stringify({passphrase: PASSPHRASE}),
        });
        assert.equal(setup.status, 200);
        assert.equal(configuredAddress, ACCOUNT);
        assert.equal(schedulerStarted, true);

        const receipts = await fetch(`${launch.origin}/v1/receipts`, {
            headers: {Origin: launch.origin, Authorization: `Bearer ${session.sessionToken}`},
        });
        assert.equal((await receipts.json()).result.length, 1);
        const preview = await fetch(`${launch.origin}/v1/agent/preview`, {
            method: "POST",
            headers,
            body: JSON.stringify({limitPrice: "119", quantity: "10"}),
        });
        assert.equal((await preview.json()).result.previewId, "preview");
        const status = await fetch(`${launch.origin}/v1/status`, {
            headers: {Origin: launch.origin, Authorization: `Bearer ${session.sessionToken}`},
        });
        const statusBody = await status.json();
        assert.equal(statusBody.status.runtime, "ready");
        assert.equal(statusBody.status.liveChainChecked, true);
        assert.equal(statusBody.status.scheduler.running, true);
    } finally {
        await supervisor.stop();
    }
    assert.equal(runtimeClosed, true);
});
