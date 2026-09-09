#!/usr/bin/env node
import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdir, readFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {JsonRpcProvider} from "ethers";

import {AgentRuntime} from "./runtime/agent-runtime.mjs";
import {AgentControlService} from "./runtime/control-service.mjs";
import {HederaProtocolAdapter} from "./runtime/hedera-protocol-adapter.mjs";
import {acquireLauncherLock} from "./runtime/launcher-lock.mjs";
import {LifecycleScheduler} from "./runtime/lifecycle-scheduler.mjs";
import {SanitizedReceiptStore} from "./runtime/receipt-store.mjs";
import {SignerProcess} from "./runtime/signer-process.mjs";
import {AgentSupervisor} from "./runtime/supervisor.mjs";
import {EzklVerifier} from "./runtime/verifier.mjs";
import {IsolatedProvingWorker} from "./runtime/worker.mjs";

const AGENT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const VENUE_ROOT = path.dirname(AGENT_ROOT);
const APP_ROOT = path.join(VENUE_ROOT, "app");
const BUNDLE_DIR = path.join(AGENT_ROOT, "artifacts", "proof");
const MANIFEST_PATH = path.join(AGENT_ROOT, "protocol", "manifest.json");
const PYTHON_PATH = path.join(VENUE_ROOT, ".venv", "bin", "python");
const STATE_DIR = path.join(os.homedir(), ".lattice-agent", "state");

function assertArguments(argv) {
    if (argv.length !== 0 && !(argv.length === 1 && argv[0] === "--no-open")) {
        throw new Error("usage: node agent/launch.mjs [--no-open]");
    }
}

async function feePolicy(rpcUrl, chainId) {
    const provider = new JsonRpcProvider(rpcUrl, Number(chainId), {
        staticNetwork: true,
        batchMaxCount: 1,
    });
    try {
        const data = await provider.getFeeData();
        const observed = data.gasPrice ?? data.maxFeePerGas;
        if (observed === null) throw new Error("testnet RPC did not return a gas price");
        return {
            gasLimit: "1200000",
            maxFeePerGas: (observed * 2n).toString(),
            maxPriorityFeePerGas: "0",
        };
    } finally {
        provider.destroy();
    }
}

function openBrowser(url) {
    const child = spawn("open", [url], {
        detached: true,
        stdio: "ignore",
    });
    child.unref();
}

async function main() {
    assertArguments(process.argv.slice(2));
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
    const verifierManifest = JSON.parse(
        await readFile(path.join(BUNDLE_DIR, "verifier-manifest.json"), "utf8")
    );
    const policyHash =
        `0x${createHash("sha256")
            .update(await readFile(path.join(AGENT_ROOT, "formal", "spec.json")))
            .digest("hex")}`;
    await mkdir(STATE_DIR, {recursive: true, mode: 0o700});
    const releaseLauncherLock = await acquireLauncherLock(STATE_DIR);
    let signer = null;
    let supervisor = null;
    let stopping = false;
    const stop = async () => {
        if (stopping) return;
        stopping = true;
        try {
            if (supervisor !== null) await supervisor.stop();
        } finally {
            try {
                if (signer !== null) await signer.stop();
            } finally {
                await releaseLauncherLock();
            }
        }
    };

    try {
        const fees = await feePolicy(manifest.network.rpc, manifest.network.chainId);
        let receiptStore = new SanitizedReceiptStore({
            directory: path.join(STATE_DIR, "receipts"),
        });
        try {
            await receiptStore.initialize();
        } catch {
            receiptStore = null;
            process.stderr.write(
                "Warning: durable receipts are unavailable; signer and lifecycle recovery remain enabled.\n"
            );
        }
        const worker = new IsolatedProvingWorker({bundleDir: BUNDLE_DIR});
        const verifier = new EzklVerifier({
            bundleDir: BUNDLE_DIR,
            pythonPath: PYTHON_PATH,
            timeoutMilliseconds: 30_000,
        });
        signer = new SignerProcess({
            stateDir: STATE_DIR,
            feePolicy: fees,
            commitBondTinybar: manifest.immutables.commitBondTinybar,
            cancelFeeTinybar: manifest.immutables.cancelFeeTinybar,
            timeoutMilliseconds: 60_000,
        });
        supervisor = new AgentSupervisor({
            signer,
            appRoot: APP_ROOT,
            receiptStore,
            runtimeFactory: async (executionAccount) => {
                let adapter = null;
                try {
                    adapter = await HederaProtocolAdapter.open({
                        executionAccount,
                        rpcUrl: manifest.network.rpc,
                        manifestPath: MANIFEST_PATH,
                    });
                    const runtime = new AgentRuntime({
                        signer,
                        adapter,
                        worker,
                        verifier,
                        receiptStore,
                    });
                    const scheduler = new LifecycleScheduler({
                        signer,
                        adapter,
                        runtime,
                        receiptStore,
                    });
                    const control = new AgentControlService({
                        signer,
                        adapter,
                        runtime,
                        modelHash: verifierManifest.modelHash,
                        policyHash,
                        feePolicy: fees,
                    });
                    return {
                        adapter,
                        runtime,
                        receiptStore,
                        scheduler,
                        control,
                        close: async () => {
                            let failure = null;
                            try {
                                await scheduler.stop();
                            } catch (error) {
                                failure = error;
                            }
                            try {
                                await adapter.close();
                            } catch (error) {
                                failure ??= error;
                            }
                            if (failure !== null) throw failure;
                        },
                    };
                } catch (error) {
                    if (adapter !== null) {
                        try {
                            await adapter.close();
                        } catch {
                            // Preserve the runtime construction error.
                        }
                    }
                    throw error;
                }
            },
        });

        for (const signal of ["SIGINT", "SIGTERM"]) {
            process.once(signal, () => {
                stop().then(
                    () => process.exit(0),
                    () => process.exit(1)
                );
            });
        }
        const launch = await supervisor.start();
        const url = `${launch.origin}/claw/`;
        process.stdout.write(`Lattice Claw preview is ready at ${url}\n`);
        process.stdout.write("The execution backend remains local and is not connected to the coming-soon chat.\n");
        if (!process.argv.includes("--no-open")) openBrowser(url);
    } catch (error) {
        await stop();
        throw error;
    }
}

main().catch((error) => {
    process.stderr.write(`Lattice Claw launch failed: ${error.message}\n`);
    process.exitCode = 1;
});
