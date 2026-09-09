#!/usr/bin/env node
import assert from "node:assert/strict";
import {createHash, randomBytes} from "node:crypto";
import {mkdir, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {Wallet} from "ethers";

import {env as baseEnvironment} from "../../tools/hcs-chain.mjs";
import {AgentRuntime} from "../runtime/agent-runtime.mjs";
import {HederaProtocolAdapter} from "../runtime/hedera-protocol-adapter.mjs";
import {SignerProcess} from "../runtime/signer-process.mjs";
import {EzklVerifier} from "../runtime/verifier.mjs";
import {IsolatedProvingWorker} from "../runtime/worker.mjs";

const VENUE_ROOT = path.dirname(path.dirname(fileURLToPath(new URL(".", import.meta.url))));
const REPO_ROOT = path.dirname(VENUE_ROOT);
const AGENT_ROOT = path.join(VENUE_ROOT, "agent");
const BUNDLE_DIR = path.join(AGENT_ROOT, "artifacts/proof");

function hash(value) {
    return `0x${createHash("sha256").update(value).digest("hex")}`;
}

async function actorEnvironment() {
    const values = Object.create(null);
    for (const line of (await readFile(path.join(REPO_ROOT, ".env.venue-actors"), "utf8")).split("\n")) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (match === null) continue;
        let value = match[2].trim();
        if (
            (value.startsWith("\"") && value.endsWith("\"")) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        values[match[1]] = value;
    }
    if (!values.BUYER_ADDRESS || !values.BUYER_PRIVATE_KEY) {
        throw new Error("buyer actor is not configured");
    }
    return values;
}

function mandateFor(context, feeReserve) {
    return {
        schemaVersion: "lattice.agent.mandate.v1",
        identity: {
            chainId: context.chainId,
            executionAccount: context.executionAccount,
            deploymentHash: context.deploymentHash,
            modelBundleHash: context.modelBundleHash,
            policyHash: context.policyHash,
            mandateNonce: context.mandateNonce,
        },
        ticket: {
            engine: context.engine,
            token: context.token,
            side: "BUY",
            quantity: context.quantity,
            limitPrice: context.price,
            recoveryAddress: context.recoveryAddress,
            permittedMethods: ["commit", "reveal", "cancel", "expire", "withdraw"],
        },
        limits: {
            newOrderLimit: 1,
            principalBudget: context.price,
            bondBudget: "1000000",
            cancellationBudget: "100000",
            feeReserve,
            maxPendingOrders: 1,
            decisionSlots: [context.publicSlot],
            maxEvaluations: 1,
        },
        time: {
            validFrom: context.publicSlot,
            lastNewEntryAt: (BigInt(context.publicSlot) + 240n).toString(),
            recoveryDeadline: (BigInt(context.publicSlot) + 600n).toString(),
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
            activationId: hash(randomBytes(32)),
            revocationGeneration: 0,
            paused: false,
            completeOutstandingObligations: true,
        },
    };
}

async function main() {
    if (process.env.LATTICE_AGENT_LIVE_RUN !== "1") {
        throw new Error("set LATTICE_AGENT_LIVE_RUN=1 to execute the pause recovery test");
    }
    const base = baseEnvironment(["HEDERA_TESTNET_RPC"]);
    const actors = await actorEnvironment();
    const wallet = new Wallet(actors.BUYER_PRIVATE_KEY);
    assert.equal(wallet.address.toLowerCase(), actors.BUYER_ADDRESS.toLowerCase());
    const adapter = await HederaProtocolAdapter.open({
        executionAccount: actors.BUYER_ADDRESS,
        rpcUrl: base.HEDERA_TESTNET_RPC,
    });
    const verifierManifest = JSON.parse(
        await readFile(path.join(BUNDLE_DIR, "verifier-manifest.json"), "utf8")
    );
    const feeData = await adapter.provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
    if (gasPrice === null) throw new Error("testnet RPC did not return a gas price");
    const feePolicy = {
        gasLimit: "1200000",
        maxFeePerGas: (gasPrice * 2n).toString(),
        maxPriorityFeePerGas: "0",
    };
    const weibarPerTinybar = 10_000_000_000n;
    const maximumFeePerTransaction = (
        (
            BigInt(feePolicy.gasLimit) * BigInt(feePolicy.maxFeePerGas) +
            weibarPerTinybar -
            1n
        ) /
        weibarPerTinybar
    );
    const feeReserve = (maximumFeePerTransaction * 4n).toString();
    const snapshot = await adapter.snapshot({limitPrice: "119", quantity: "1"});
    const context = {
        protocolDomain: hash(Buffer.from("lattice.agent.decision-context.v1")),
        chainId: adapter.manifest.network.chainId,
        engine: adapter.engineAddress,
        executionAccount: actors.BUYER_ADDRESS.toLowerCase(),
        token: adapter.tokenAddress,
        side: "BUY",
        price: "119",
        quantity: "1",
        recoveryAddress: actors.BUYER_ADDRESS.toLowerCase(),
        snapshotId: snapshot.snapshotId,
        deploymentHash: adapter.deploymentHash,
        modelBundleHash: verifierManifest.modelHash.replace("sha256:", "0x"),
        policyHash: hash(await readFile(path.join(AGENT_ROOT, "formal/spec.json"))),
        mandateNonce: hash(randomBytes(32)),
        decisionSequence: 0,
        publicSlot: snapshot.publicSlot,
        expiresAt: (BigInt(snapshot.publicSlot) + 60n).toString(),
        features: snapshot.features,
    };
    const mandate = mandateFor(context, feeReserve);
    const stateDir = path.join(
        os.homedir(),
        ".lattice-agent",
        "phase2-live",
        `pause-${Date.now()}-${randomBytes(4).toString("hex")}`
    );
    const passphrase = `phase2-pause-${randomBytes(32).toString("base64url")}`;
    await mkdir(stateDir, {recursive: true, mode: 0o700});
    const signer = new SignerProcess({
        stateDir,
        feePolicy,
        commitBondTinybar: adapter.manifest.immutables.commitBondTinybar,
        cancelFeeTinybar: adapter.manifest.immutables.cancelFeeTinybar,
        timeoutMilliseconds: 60_000,
    });
    const runtime = new AgentRuntime({
        signer,
        adapter,
        worker: new IsolatedProvingWorker({bundleDir: BUNDLE_DIR}),
        verifier: new EzklVerifier({
            bundleDir: BUNDLE_DIR,
            pythonPath: path.join(VENUE_ROOT, ".venv/bin/python"),
            timeoutMilliseconds: 60_000,
        }),
    });
    try {
        await signer.call("initializeStore", {passphrase});
        const initialized = await signer.call("initializeAccount", {
            passphrase,
            privateKey: actors.BUYER_PRIVATE_KEY,
        });
        assert.equal(initialized.address, actors.BUYER_ADDRESS.toLowerCase());
        const activation = await signer.call("activateMandate", {mandate});
        const creditBefore = await adapter.engine.credit(actors.BUYER_ADDRESS);
        const evaluation = await runtime.evaluate({
            mandate,
            context,
            nonce: await adapter.nextNonce(),
            snapshot,
        });
        assert.equal(evaluation.decision, "EXECUTE");
        assert.equal(evaluation.transaction.confirmed, true);

        const paused = await signer.call("pauseMandate", {
            mandateId: activation.mandateId,
            paused: true,
        });
        assert.equal(paused.paused, true);
        assert.equal(paused.outstandingActionsContinue, true);
        await assert.rejects(
            () => signer.call("reserveEvaluation", {mandate, context}),
            {code: "MANDATE_PAUSED"}
        );

        const cancelled = await runtime.continueAction({
            actionId: evaluation.actionId,
            stage: "cancel",
            nonce: await adapter.nextNonce(),
        });
        assert.equal(cancelled.transaction.status, "confirmed");
        assert.equal(cancelled.after.lifecycle, "CANCELLED");
        const creditAfterCancel = BigInt(cancelled.after.creditTinybar);
        assert.equal(creditAfterCancel - creditBefore, 900000n);
        const withdrawn = await runtime.continueAction({
            actionId: evaluation.actionId,
            stage: "withdraw",
            nonce: await adapter.nextNonce(),
        });
        assert.equal(withdrawn.transaction.status, "confirmed");
        assert.equal(withdrawn.after.creditTinybar, "0");

        const report = {
            schemaVersion: "lattice.agent.phase2-pause-evidence.v1",
            status: "passed",
            checkedAt: new Date().toISOString(),
            chainId: adapter.manifest.network.chainId,
            orderIdentifier: evaluation.commitment,
            mandateId: activation.mandateId,
            checks: {
                executeDecisionVerified: true,
                commitmentConfirmed: true,
                localPauseActivated: true,
                newEvaluationRefusedWhilePaused: true,
                outstandingCancelConfirmedWhilePaused: true,
                cancelRefundDeltaTinybar: "900000",
                creditWithdrawn: true,
            },
            transactions: {
                commit: evaluation.transaction.transactionHash,
                cancel: cancelled.transaction.transactionHash,
                withdraw: withdrawn.transaction.transactionHash,
            },
            privacy:
                "No proof body, reveal salt, signed bytes, key, witness, or agent evidence was submitted to HCS.",
        };
        await writeFile(
            path.join(VENUE_ROOT, "deployments/agent-phase2-pause.json"),
            `${JSON.stringify(report, null, 2)}\n`,
            "utf8"
        );
        console.log(JSON.stringify(report, null, 2));
    } finally {
        await signer.stop();
        await rm(stateDir, {recursive: true, force: true});
        adapter.close();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({
        ok: false,
        code: typeof error?.code === "string" ? error.code : "PHASE2_PAUSE_FAILED",
        message: error?.message ?? "Phase 2 pause test failed",
    }));
    process.exitCode = 1;
});
