#!/usr/bin/env node
import assert from "node:assert/strict";
import {execFile as execFileCallback} from "node:child_process";
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";

import {
    ContractFactory,
    Interface,
    JsonRpcProvider,
    Wallet,
    getBytes,
    hexlify,
    keccak256,
} from "ethers";

import {env as baseEnvironment} from "../../tools/hcs-chain.mjs";
import {verifyEvmBuildArtifacts} from "./evm-verifier-artifacts.mjs";

const execFile = promisify(execFileCallback);
const VENUE_ROOT = path.dirname(path.dirname(fileURLToPath(new URL(".", import.meta.url))));
const REPO_ROOT = path.dirname(VENUE_ROOT);
const BUNDLE_DIR = path.join(VENUE_ROOT, "agent/artifacts/proof");

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

async function compiledBytecode() {
    const {stdout} = await execFile(
        "forge",
        [
            "inspect",
            "--root",
            BUNDLE_DIR,
            "--contracts",
            ".",
            "--via-ir",
            "--optimize",
            "true",
            "Verifier.sol:Halo2Verifier",
            "bytecode",
        ],
        {maxBuffer: 5 * 1024 * 1024}
    );
    const bytecode = stdout.trim();
    if (!/^0x[0-9a-f]+$/i.test(bytecode)) {
        throw new Error("Forge emitted malformed verifier bytecode");
    }
    return bytecode;
}

async function main() {
    if (process.env.LATTICE_AGENT_LIVE_RUN !== "1") {
        throw new Error("set LATTICE_AGENT_LIVE_RUN=1 to deploy the optional verifier");
    }
    const base = baseEnvironment(["HEDERA_TESTNET_RPC"]);
    const actors = await actorEnvironment();
    const provider = new JsonRpcProvider(base.HEDERA_TESTNET_RPC, 296, {
        staticNetwork: true,
        batchMaxCount: 10,
    });
    const wallet = new Wallet(actors.BUYER_PRIVATE_KEY, provider);
    assert.equal(wallet.address.toLowerCase(), actors.BUYER_ADDRESS.toLowerCase());
    const abiBytes = await readFile(path.join(BUNDLE_DIR, "Verifier.abi.json"));
    const verifierBytes = await readFile(path.join(BUNDLE_DIR, "Verifier.sol"));
    const proofBytes = await readFile(path.join(BUNDLE_DIR, "proof.json"));
    const calldataBytes = await readFile(path.join(BUNDLE_DIR, "evm-calldata.bin"));
    const abi = JSON.parse(abiBytes.toString("utf8"));
    const build = JSON.parse(
        await readFile(path.join(VENUE_ROOT, "agent/artifacts/evidence/evm-verifier-build.json"), "utf8")
    );
    const artifactHashes = verifyEvmBuildArtifacts({
        abiBytes,
        verifierBytes,
        proofBytes,
        calldataBytes,
        build,
    });
    const bytecode = await compiledBytecode();
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
    if (gasPrice === null) throw new Error("testnet RPC did not return a gas price");
    const feePolicy = {
        type: 2,
        maxFeePerGas: gasPrice * 2n,
        maxPriorityFeePerGas: 0n,
    };
    try {
        const factory = new ContractFactory(abi, bytecode, wallet);
        const verifier = await factory.deploy({...feePolicy, gasLimit: 5_000_000n});
        const deployment = verifier.deploymentTransaction();
        if (deployment === null) throw new Error("verifier deployment transaction is unavailable");
        const deploymentReceipt = await deployment.wait(1, 180_000);
        if (deploymentReceipt === null || deploymentReceipt.status !== 1) {
            throw new Error("verifier deployment failed");
        }
        const verifierAddress = await verifier.getAddress();
        const runtimeCode = await provider.getCode(verifierAddress);
        const calldata = hexlify(calldataBytes);
        const iface = new Interface(abi);
        const validRaw = await provider.call({to: verifierAddress, data: calldata});
        assert.equal(iface.decodeFunctionResult("verifyProof", validRaw)[0], true);

        const decoded = iface.decodeFunctionData("verifyProof", calldata);
        const alteredProof = getBytes(decoded[0]);
        alteredProof[Math.floor(alteredProof.length / 2)] ^= 1;
        const alteredCalldata = iface.encodeFunctionData("verifyProof", [
            alteredProof,
            decoded[1],
        ]);
        let alteredProofRefused = false;
        try {
            const alteredRaw = await provider.call({
                to: verifierAddress,
                data: alteredCalldata,
            });
            alteredProofRefused =
                iface.decodeFunctionResult("verifyProof", alteredRaw)[0] === false;
        } catch {
            alteredProofRefused = true;
        }
        assert.equal(alteredProofRefused, true);

        const estimatedGas = await provider.estimateGas({
            from: wallet.address,
            to: verifierAddress,
            data: calldata,
        });
        const transaction = await wallet.sendTransaction({
            ...feePolicy,
            to: verifierAddress,
            data: calldata,
            gasLimit: estimatedGas * 2n,
        });
        const verificationReceipt = await transaction.wait(1, 180_000);
        if (verificationReceipt === null || verificationReceipt.status !== 1) {
            throw new Error("on-chain proof verification failed");
        }
        const report = {
            schemaVersion: "lattice.agent.ezkl-evm-verifier-evidence.v1",
            status: "passed",
            checkedAt: new Date().toISOString(),
            chainId: "296",
            verifier: {
                address: verifierAddress.toLowerCase(),
                deploymentTransaction: deploymentReceipt.hash,
                runtimeCodeKeccak256: keccak256(runtimeCode),
                runtimeBytes: (runtimeCode.length - 2) / 2,
                deploymentGasUsed: deploymentReceipt.gasUsed.toString(),
            },
            proof: {
                hash: artifactHashes.proofHash,
                calldataHash: artifactHashes.calldataHash,
                calldataBytes: artifactHashes.calldataBytes,
                artifactHashesRecomputed: true,
                validEthCallAccepted: true,
                alteredProofRefused: true,
                verificationTransaction: verificationReceipt.hash,
                estimatedGas: estimatedGas.toString(),
                gasUsed: verificationReceipt.gasUsed.toString(),
            },
            role:
                "Optional evidence sidecar. MatchingEngine does not call this verifier and does not depend on it for authorization, matching, or settlement.",
            scope:
                "This deployment probe used the released synthetic proof bundle. Per-order post-reveal publication remains disabled until a revealed order proof is retained and explicitly selected for publication.",
        };
        await writeFile(
            path.join(VENUE_ROOT, "deployments/agent-ezkl-verifier.json"),
            `${JSON.stringify(report, null, 2)}\n`,
            "utf8"
        );
        console.log(JSON.stringify(report, null, 2));
    } finally {
        provider.destroy();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({
        ok: false,
        code: typeof error?.code === "string" ? error.code : "EZKL_EVM_TEST_FAILED",
        message: error?.message ?? "optional EVM verifier test failed",
    }));
    process.exitCode = 1;
});
