#!/usr/bin/env node
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {AgentRuntime} from "../runtime/agent-runtime.mjs";
import {DeterministicProtocolAdapter} from "../runtime/protocol-adapter.mjs";
import {SignerProcess} from "../runtime/signer-process.mjs";
import {EzklVerifier} from "../runtime/verifier.mjs";
import {IsolatedProvingWorker} from "../runtime/worker.mjs";

const VENUE_ROOT = path.dirname(path.dirname(fileURLToPath(new URL(".", import.meta.url))));
const AGENT_ROOT = path.join(VENUE_ROOT, "agent");
const BUNDLE_DIR = path.join(AGENT_ROOT, "artifacts/proof");
const PASSPHRASE = "synthetic end to end test passphrase";

function sha256(value) {
    return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function mandateFor(context) {
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
            principalBudget: (BigInt(context.price) * BigInt(context.quantity)).toString(),
            bondBudget: "1000000",
            cancellationBudget: "100000",
            feeReserve: "2000000",
            maxPendingOrders: 1,
            decisionSlots: [context.publicSlot],
            maxEvaluations: 1,
        },
        time: {
            validFrom: (BigInt(context.publicSlot) - 1n).toString(),
            lastNewEntryAt: context.expiresAt,
            recoveryDeadline: (BigInt(context.expiresAt) + 600n).toString(),
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
            activationId: sha256("synthetic activation"),
            revocationGeneration: 0,
            paused: false,
            completeOutstandingObligations: true,
        },
    };
}

const deploymentBytes = await readFile(path.join(VENUE_ROOT, "deployments/client.json"));
const deployment = JSON.parse(deploymentBytes);
const verifierManifest = JSON.parse(
    await readFile(path.join(BUNDLE_DIR, "verifier-manifest.json"), "utf8")
);
const stateBase = path.join(os.homedir(), ".lattice-agent", "e2e-tests");
await mkdir(stateBase, {recursive: true, mode: 0o700});
const stateDir = await mkdtemp(path.join(stateBase, "state-"));
const signer = new SignerProcess({
    stateDir,
    commitBondTinybar: deployment.immutables.commitBond,
    feePolicy: {
        gasLimit: "500000",
        maxFeePerGas: "1000000000",
        maxPriorityFeePerGas: "0",
    },
    timeoutMilliseconds: 30_000,
});

try {
    await signer.call("initializeStore", {passphrase: PASSPHRASE});
    const {address} = await signer.call("initializeAccount", {passphrase: PASSPHRASE});
    const context = {
        protocolDomain: sha256("lattice.agent.decision-context.v1"),
        chainId: String(deployment.network.chainId),
        engine: deployment.addresses.MatchingEngine,
        executionAccount: address,
        token: deployment.addresses.token,
        side: "BUY",
        price: "2500000",
        quantity: "2",
        recoveryAddress: "0x2000000000000000000000000000000000000002",
        snapshotId: sha256("synthetic local e2e snapshot"),
        deploymentHash: sha256(deploymentBytes),
        modelBundleHash: verifierManifest.modelHash.replace("sha256:", "0x"),
        policyHash: sha256(await readFile(path.join(AGENT_ROOT, "formal/spec.json"))),
        mandateNonce: `0x${"11".repeat(32)}`,
        decisionSequence: 0,
        publicSlot: "1788950000",
        expiresAt: "1788950060",
        features: {
            limitRoomBps: 600,
            recentMoveOffsetBps: 1100,
            roundProgressBps: 5000,
            freshnessSeconds: 30,
            bufferCategory: 1,
            horizonCategory: 1,
        },
    };
    const mandate = mandateFor(context);
    await signer.call("activateMandate", {mandate});
    const adapter = new DeterministicProtocolAdapter({
        chainId: context.chainId,
        engine: context.engine,
        executionAccount: context.executionAccount,
        token: context.token,
        features: context.features,
    });
    adapter.setFailureMode("timeout-after-accept");
    const runtime = new AgentRuntime({
        signer,
        adapter,
        worker: new IsolatedProvingWorker({bundleDir: BUNDLE_DIR}),
        verifier: new EzklVerifier({
            bundleDir: BUNDLE_DIR,
            pythonPath: path.join(VENUE_ROOT, ".venv/bin/python"),
            timeoutMilliseconds: 30_000,
        }),
    });
    const started = performance.now();
    const receipt = await runtime.evaluate({mandate, context, nonce: 0});
    if (receipt.decision !== "EXECUTE" || receipt.transaction.confirmed !== true) {
        throw new Error("synthetic end to end context did not produce a confirmed commitment");
    }
    console.log(JSON.stringify({
        schemaVersion: "lattice.agent.e2e-test.v1",
        status: "passed",
        elapsedMilliseconds: Math.round(performance.now() - started),
        receipt,
    }, null, 2));
} finally {
    await signer.stop();
    await rm(stateDir, {recursive: true, force: true});
}
