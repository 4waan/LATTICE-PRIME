#!/usr/bin/env node
import assert from "node:assert/strict";
import {createHash, randomBytes} from "node:crypto";
import {mkdir, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {Contract, Wallet} from "ethers";

import {commitmentOf, SIDE} from "../../tools/commitment.mjs";
import {toWeibar} from "../../tools/units.mjs";
import {AgentRuntime} from "../runtime/agent-runtime.mjs";
import {HederaProtocolAdapter} from "../runtime/hedera-protocol-adapter.mjs";
import {
    buildOrderReceipt,
    disclosureEvidence,
    verifyOrderReceiptShape,
} from "../runtime/order-receipt.mjs";
import {SignerProcess} from "../runtime/signer-process.mjs";
import {EzklVerifier} from "../runtime/verifier.mjs";
import {IsolatedProvingWorker} from "../runtime/worker.mjs";

const VENUE_ROOT = path.dirname(path.dirname(fileURLToPath(new URL(".", import.meta.url))));
const REPO_ROOT = path.dirname(VENUE_ROOT);
const AGENT_ROOT = path.join(VENUE_ROOT, "agent");
const BUNDLE_DIR = path.join(AGENT_ROOT, "artifacts/proof");
const EVIDENCE_DIR = path.join(AGENT_ROOT, "artifacts/evidence");
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const LIVE = process.env.LATTICE_AGENT_LIVE_RUN === "1";

function hash(bytes) {
    return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function loadEnvironmentFile(contents, destination) {
    for (const line of contents.split("\n")) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (match === null) continue;
        let value = match[2].trim();
        if (
            (value.startsWith("\"") && value.endsWith("\"")) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        destination[match[1]] = value;
    }
}

async function environment() {
    const values = Object.create(null);
    loadEnvironmentFile(await readFile(path.join(REPO_ROOT, ".env"), "utf8"), values);
    loadEnvironmentFile(await readFile(path.join(REPO_ROOT, ".env.venue-actors"), "utf8"), values);
    for (const name of [
        "HEDERA_TESTNET_RPC",
        "BUYER_ADDRESS",
        "BUYER_PRIVATE_KEY",
        "SELLER_ADDRESS",
        "SELLER_PRIVATE_KEY",
    ]) {
        if (!values[name]) throw new Error(`set ${name} in the local environment files`);
    }
    return values;
}

function transactionOptions(feePolicy, value = 0n, gasLimit = null) {
    return {
        type: 2,
        value,
        gasLimit: gasLimit ?? BigInt(feePolicy.gasLimit),
        maxFeePerGas: BigInt(feePolicy.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(feePolicy.maxPriorityFeePerGas),
    };
}

function receiptRecord(stage, receipt) {
    return {
        stage,
        transactionHash: receipt.hash,
        status: receipt.status === 1 ? "confirmed" : "reverted",
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        exactProjectionMatched: true,
        logs: receipt.logs.map((log) => ({
            address: log.address,
            topics: [...log.topics],
            data: log.data,
            index: log.index,
            transactionHash: log.transactionHash,
        })),
    };
}

async function send(contract, method, args, options, stage) {
    const transaction = await contract[method](...args, options);
    const receipt = await transaction.wait(1, 180_000);
    if (receipt === null || receipt.status !== 1) {
        throw new Error(`${stage} did not confirm successfully`);
    }
    return receiptRecord(stage, receipt);
}

async function waitForTimestamp(provider, target, label) {
    for (;;) {
        const block = await provider.getBlock("latest");
        if (block !== null && BigInt(block.timestamp) >= BigInt(target)) return block;
        const now = block === null ? 0n : BigInt(block.timestamp);
        const left = BigInt(target) > now ? BigInt(target) - now : 0n;
        console.log(`${label}: waiting ${left}s of chain time`);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
}

async function waitForRevealHeadroom(engine, provider, minimumSeconds = 30n) {
    for (;;) {
        const block = await provider.getBlock("latest");
        const round = await engine.currentRound();
        const end = await engine.roundEnd(round);
        if (block !== null && end - BigInt(block.timestamp) >= minimumSeconds) return round;
        await waitForTimestamp(provider, end + 2n, "next auction round");
    }
}

function mandateFor(context, feeReserveTinybar) {
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
            feeReserve: feeReserveTinybar,
            maxPendingOrders: 1,
            decisionSlots: [context.publicSlot],
            maxEvaluations: 1,
        },
        time: {
            validFrom: context.publicSlot,
            lastNewEntryAt: (BigInt(context.publicSlot) + 240n).toString(),
            recoveryDeadline: (BigInt(context.publicSlot) + 1_800n).toString(),
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

function contextFor({adapter, snapshot, buyer, price, quantity, modelHash, policyHash}) {
    return {
        protocolDomain: hash(Buffer.from("lattice.agent.decision-context.v1")),
        chainId: adapter.manifest.network.chainId,
        engine: adapter.engineAddress,
        executionAccount: buyer.toLowerCase(),
        token: adapter.tokenAddress,
        side: "BUY",
        price: String(price),
        quantity: String(quantity),
        recoveryAddress: buyer.toLowerCase(),
        snapshotId: snapshot.snapshotId,
        deploymentHash: adapter.deploymentHash,
        modelBundleHash: modelHash.replace("sha256:", "0x"),
        policyHash,
        mandateNonce: hash(randomBytes(32)),
        decisionSequence: 0,
        publicSlot: snapshot.publicSlot,
        expiresAt: (BigInt(snapshot.publicSlot) + 60n).toString(),
        features: snapshot.features,
    };
}

async function signerProcess({
    stateDir,
    feePolicy,
    commitBondTinybar,
    cancelFeeTinybar,
    privateKey,
    passphrase,
    initialize,
}) {
    const signer = new SignerProcess({
        stateDir,
        feePolicy,
        commitBondTinybar,
        cancelFeeTinybar,
        timeoutMilliseconds: 60_000,
    });
    if (initialize) {
        await signer.call("initializeStore", {passphrase});
        const account = await signer.call("initializeAccount", {passphrase, privateKey});
        return {signer, account: account.address};
    }
    const account = await signer.call("unlock", {passphrase});
    return {signer, account: account.address};
}

async function main() {
    const env = await environment();
    const adapter = await HederaProtocolAdapter.open({
        executionAccount: env.BUYER_ADDRESS,
        rpcUrl: env.HEDERA_TESTNET_RPC,
    });
    const provider = adapter.provider;
    const engineAbi = JSON.parse(
        await readFile(path.join(VENUE_ROOT, "deployments/abi/MatchingEngine.json"), "utf8")
    );
    const holdAbi = JSON.parse(
        await readFile(path.join(VENUE_ROOT, "deployments/abi/IHoldByPartition.json"), "utf8")
    );
    const tokenAbi = JSON.parse(
        await readFile(path.join(VENUE_ROOT, "deployments/abi/IAtsToken.json"), "utf8")
    );
    const verifierManifest = JSON.parse(
        await readFile(path.join(BUNDLE_DIR, "verifier-manifest.json"), "utf8")
    );
    const policyHash = hash(await readFile(path.join(AGENT_ROOT, "formal/spec.json")));
    const feeData = await provider.getFeeData();
    const observedGasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
    if (observedGasPrice === null) throw new Error("testnet RPC did not return a gas price");
    const feePolicy = {
        gasLimit: "1200000",
        maxFeePerGas: (observedGasPrice * 2n).toString(),
        maxPriorityFeePerGas: "0",
    };
    const feeReserveTinybar =
        (BigInt(feePolicy.gasLimit) * BigInt(feePolicy.maxFeePerGas) * 6n / 10_000_000_000n)
            .toString();
    const readinessSnapshot = await adapter.snapshot({limitPrice: "119", quantity: "10"});
    const alteredSnapshot = structuredClone(readinessSnapshot);
    alteredSnapshot.features.freshnessSeconds += 1;
    await assert.rejects(
        () => adapter.authenticateSnapshot(alteredSnapshot),
        {code: "SNAPSHOT_AUTHENTICATION_FAILED"}
    );
    const readiness = await adapter.preflight({
        chainId: adapter.manifest.network.chainId,
        deploymentHash: adapter.deploymentHash,
        engine: adapter.engineAddress,
        executionAccount: env.BUYER_ADDRESS,
        feeReserveTinybar,
        price: "119",
        quantity: "10",
        stage: "commit",
        token: adapter.tokenAddress,
    });
    console.log(JSON.stringify({
        mode: LIVE ? "live" : "plan",
        chainId: readiness.chainId,
        deploymentHash: adapter.deploymentHash,
        eligible: readiness.eligible,
        halted: readiness.halted,
        feeBalanceSufficient: readiness.feeBalanceSufficient,
        snapshotId: readinessSnapshot.snapshotId,
        features: readinessSnapshot.features,
    }, null, 2));
    if (!LIVE) {
        console.log("Read-only plan passed. Set LATTICE_AGENT_LIVE_RUN=1 to execute testnet orders.");
        adapter.close();
        return;
    }
    assert.equal(readiness.identityMatches, true);
    assert.equal(readiness.eligible, true);
    assert.equal(readiness.halted, false);
    assert.equal(readiness.feeBalanceSufficient, true);

    const buyerWallet = new Wallet(env.BUYER_PRIVATE_KEY, provider);
    const sellerWallet = new Wallet(env.SELLER_PRIVATE_KEY, provider);
    assert.equal(buyerWallet.address.toLowerCase(), env.BUYER_ADDRESS.toLowerCase());
    assert.equal(sellerWallet.address.toLowerCase(), env.SELLER_ADDRESS.toLowerCase());
    const engine = new Contract(adapter.engineAddress, engineAbi, sellerWallet);
    const token = new Contract(adapter.tokenAddress, tokenAbi, provider);
    const holds = new Contract(adapter.tokenAddress, holdAbi, sellerWallet);
    const partition = adapter.manifest.immutables.partition;
    const bond = BigInt(adapter.manifest.immutables.commitBondTinybar);
    const passphrase = `phase2-${randomBytes(32).toString("base64url")}`;
    const stateDir = path.join(
        os.homedir(),
        ".lattice-agent",
        "phase2-live",
        `state-${Date.now()}-${randomBytes(4).toString("hex")}`
    );
    await mkdir(stateDir, {recursive: true, mode: 0o700});
    let processRecord = await signerProcess({
        stateDir,
        feePolicy,
        commitBondTinybar: adapter.manifest.immutables.commitBondTinybar,
        cancelFeeTinybar: adapter.manifest.immutables.cancelFeeTinybar,
        privateKey: env.BUYER_PRIVATE_KEY,
        passphrase,
        initialize: true,
    });
    let signer = processRecord.signer;
    assert.equal(processRecord.account.toLowerCase(), env.BUYER_ADDRESS.toLowerCase());
    const worker = new IsolatedProvingWorker({bundleDir: BUNDLE_DIR});
    const verifier = new EzklVerifier({
        bundleDir: BUNDLE_DIR,
        pythonPath: path.join(VENUE_ROOT, ".venv/bin/python"),
        timeoutMilliseconds: 60_000,
    });
    let runtime = new AgentRuntime({signer, adapter, worker, verifier});
    const started = new Date().toISOString();
    const receipts = [];
    const selection = process.env.LATTICE_AGENT_PHASE2_CASES ?? "all";
    if (!["all", "partial"].includes(selection)) {
        throw new Error("LATTICE_AGENT_PHASE2_CASES must be all or partial");
    }
    const checks = {
        forgedSnapshotRefused: true,
        restartedFromEncryptedJournal: false,
        changedProjectionRefusedBeforeBroadcast: false,
        cancelAfterRevealRefusedBeforeSigning: false,
        filledPathSettled: false,
        filledPathCreditsRecovered: false,
        partialFillObserved: false,
        partialFillExpired: false,
        partialFillCreditsRecovered: false,
        noFillObserved: false,
        noFillExpired: false,
        noFillCreditsRecovered: false,
        sameProtocolPositionVisible: false,
        receiptsAreSanitized: false,
    };

    async function runCase({
        name,
        buyerPrice,
        sellerPrice,
        quantity,
        sellerQuantity = quantity,
        expectedOutcome,
    }) {
        console.log(`${name}: preparing seller hold`);
        const balancesBefore = {
            buyer: (await token.balanceOfByPartition(partition, env.BUYER_ADDRESS)).toString(),
            seller: (await token.balanceOfByPartition(partition, env.SELLER_ADDRESS)).toString(),
        };
        const creditsBefore = {
            buyer: (await adapter.engine.credit(env.BUYER_ADDRESS)).toString(),
            seller: (await adapter.engine.credit(env.SELLER_ADDRESS)).toString(),
        };
        const block = await provider.getBlock("latest");
        if (block === null) throw new Error("latest block unavailable");
        const hold = {
            amount: BigInt(sellerQuantity),
            expirationTimestamp: BigInt(block.timestamp) + 3_600n,
            escrow: adapter.engineAddress,
            to: ZERO_ADDRESS,
            data: "0x",
        };
        const predicted = await holds.createHoldByPartition.staticCall(partition, hold);
        assert.equal(predicted.success, true);
        const sellerTransactions = [];
        sellerTransactions.push(
            await send(
                holds,
                "createHoldByPartition",
                [partition, hold],
                transactionOptions(feePolicy),
                `${name}-seller-hold`
            )
        );
        const holdId = predicted.holdId;
        const sellSalt = hash(randomBytes(32));
        const sellCommitment = commitmentOf(
            env.SELLER_ADDRESS,
            SIDE.SELL,
            BigInt(sellerPrice),
            BigInt(sellerQuantity),
            sellSalt
        );

        const snapshot = await adapter.snapshot({
            limitPrice: String(buyerPrice),
            quantity: String(quantity),
        });
        const context = contextFor({
            adapter,
            snapshot,
            buyer: env.BUYER_ADDRESS,
            price: buyerPrice,
            quantity,
            modelHash: verifierManifest.modelHash,
            policyHash,
        });
        const mandate = mandateFor(context, feeReserveTinybar);
        const activation = await signer.call("activateMandate", {mandate});
        const commitNonce = await adapter.nextNonce();
        const evaluation = await runtime.evaluate({
            mandate,
            context,
            nonce: commitNonce,
            snapshot,
        });
        assert.equal(evaluation.decision, "EXECUTE");
        assert.equal(evaluation.transaction.confirmed, true);
        console.log(`${name}: agent commitment ${evaluation.commitment}`);

        sellerTransactions.push(
            await send(
                engine,
                "commit",
                [sellCommitment],
                transactionOptions(feePolicy, toWeibar(bond)),
                `${name}-seller-commit`
            )
        );

        const persistedBeforeRestart = await signer.call("action", {
            actionId: evaluation.actionId,
        });
        const changed = structuredClone(persistedBeforeRestart.transactions.commit);
        changed.projection.data =
            `${changed.projection.data.slice(0, -1)}${changed.projection.data.endsWith("0") ? "1" : "0"}`;
        await assert.rejects(
            () => adapter.broadcast(changed),
            {code: "SIGNED_TRANSACTION_REFUSED"}
        );
        checks.changedProjectionRefusedBeforeBroadcast = true;

        await signer.stop();
        processRecord = await signerProcess({
            stateDir,
            feePolicy,
            commitBondTinybar: adapter.manifest.immutables.commitBondTinybar,
            cancelFeeTinybar: adapter.manifest.immutables.cancelFeeTinybar,
            passphrase,
            initialize: false,
        });
        signer = processRecord.signer;
        runtime = new AgentRuntime({signer, adapter, worker, verifier});
        const persistedAfterRestart = await signer.call("action", {
            actionId: evaluation.actionId,
        });
        assert.equal(persistedAfterRestart.commitment, evaluation.commitment);
        assert.equal(
            persistedAfterRestart.transactions.commit.signedTransaction,
            persistedBeforeRestart.transactions.commit.signedTransaction
        );
        checks.restartedFromEncryptedJournal = true;

        const buyerSealed = await adapter.readAction({
            commitment: evaluation.commitment,
            account: env.BUYER_ADDRESS,
        });
        const sellerCommitmentState = await adapter.engine.commitments(sellCommitment);
        const sellerOpensAt =
            sellerCommitmentState.committedAt +
            BigInt(adapter.manifest.immutables.revealDelaySeconds);
        await waitForTimestamp(
            provider,
            BigInt(buyerSealed.opensAt) > sellerOpensAt
                ? BigInt(buyerSealed.opensAt)
                : sellerOpensAt,
            `${name} reveal window`
        );
        await waitForRevealHeadroom(adapter.engine, provider);

        const reveal = await runtime.continueAction({
            actionId: evaluation.actionId,
            stage: "reveal",
            nonce: await adapter.nextNonce(),
        });
        sellerTransactions.push(
            await send(
                engine,
                "reveal",
                [SIDE.SELL, BigInt(sellerPrice), BigInt(sellerQuantity), sellSalt, holdId],
                transactionOptions(feePolicy),
                `${name}-seller-reveal`
            )
        );
        await assert.rejects(
            async () => {
                const cancelNonce = await adapter.nextNonce();
                return signer.call("prepareOutstanding", {
                    actionId: evaluation.actionId,
                    stage: "cancel",
                    nonce: cancelNonce,
                });
            },
            {code: "CANCEL_AFTER_REVEAL_REFUSED"}
        );
        checks.cancelAfterRevealRefusedBeforeSigning = true;

        const buyerOpen = await adapter.readAction({
            commitment: evaluation.commitment,
            account: env.BUYER_ADDRESS,
        });
        const sellerOrder = await adapter.engine.orders(sellCommitment);
        assert.equal(buyerOpen.order.firstRound, sellerOrder.firstRound.toString());
        const round = buyerOpen.order.firstRound;
        const roundEnd = await adapter.engine.roundEnd(round);
        await waitForTimestamp(provider, roundEnd, `${name} auction close`);
        const cross = await send(
            engine,
            "crossRound",
            [BigInt(round)],
            transactionOptions(feePolicy, 0n, 3_000_000n),
            `${name}-cross`
        );
        const roundState = await adapter.readRound(round);
        let finalState = await adapter.readAction({
            commitment: evaluation.commitment,
            account: env.BUYER_ADDRESS,
        });
        const sellerAfterCross = await adapter.engine.orders(sellCommitment);
        const agentTransactions = [
            {
                stage: "commit",
                ...evaluation.transaction,
            },
            {stage: "reveal", ...reveal.transaction},
        ];

        if (expectedOutcome === "filled") {
            assert.equal(finalState.order.filled, String(quantity));
            assert.equal(sellerAfterCross.filled.toString(), String(sellerQuantity));
            checks.filledPathSettled = true;
        } else if (expectedOutcome === "partial") {
            assert.equal(finalState.order.filled, String(sellerQuantity));
            assert.equal(sellerAfterCross.filled.toString(), String(sellerQuantity));
            checks.partialFillObserved = true;
            await waitForTimestamp(
                provider,
                BigInt(finalState.retireAfter),
                `${name} resting window expiry`
            );
            const expire = await runtime.continueAction({
                actionId: evaluation.actionId,
                stage: "expire",
                nonce: await adapter.nextNonce(),
            });
            agentTransactions.push({stage: "expire", ...expire.transaction});
            finalState = await adapter.readAction({
                commitment: evaluation.commitment,
                account: env.BUYER_ADDRESS,
            });
            assert.equal(finalState.lifecycle, "RETIRED_PARTIAL");
            checks.partialFillExpired = true;
        } else {
            assert.equal(finalState.order.filled, "0");
            assert.equal(sellerAfterCross.filled.toString(), "0");
            checks.noFillObserved = true;
            await waitForTimestamp(
                provider,
                BigInt(finalState.retireAfter),
                `${name} resting window expiry`
            );
            const expire = await runtime.continueAction({
                actionId: evaluation.actionId,
                stage: "expire",
                nonce: await adapter.nextNonce(),
            });
            agentTransactions.push({stage: "expire", ...expire.transaction});
            sellerTransactions.push(
                await send(
                    engine,
                    "expire",
                    [sellCommitment],
                    transactionOptions(feePolicy),
                    `${name}-seller-expire`
                )
            );
            finalState = await adapter.readAction({
                commitment: evaluation.commitment,
                account: env.BUYER_ADDRESS,
            });
            assert.equal(finalState.lifecycle, "RETIRED_NO_FILL");
            checks.noFillExpired = true;
        }

        const creditBeforeWithdraw = BigInt(finalState.creditTinybar);
        const buyerCreditDelta = creditBeforeWithdraw - BigInt(creditsBefore.buyer);
        assert.ok(buyerCreditDelta > 0n);
        const withdraw = await runtime.continueAction({
            actionId: evaluation.actionId,
            stage: "withdraw",
            nonce: await adapter.nextNonce(),
        });
        agentTransactions.push({stage: "withdraw", ...withdraw.transaction});
        const sellerCredit = await adapter.engine.credit(env.SELLER_ADDRESS);
        const sellerCreditDelta = sellerCredit - BigInt(creditsBefore.seller);
        assert.ok(sellerCreditDelta > 0n);
        if (expectedOutcome !== "no-fill") {
            const settlementCost = sellerCreditDelta - bond;
            assert.equal(
                buyerCreditDelta,
                bond + BigInt(buyerPrice) * BigInt(quantity) - settlementCost
            );
        } else {
            assert.equal(buyerCreditDelta, bond + BigInt(buyerPrice) * BigInt(quantity));
            assert.equal(sellerCreditDelta, bond);
        }
        sellerTransactions.push(
            await send(
                engine,
                "withdraw",
                [],
                transactionOptions(feePolicy),
                `${name}-seller-withdraw`
            )
        );
        finalState = await adapter.readAction({
            commitment: evaluation.commitment,
            account: env.BUYER_ADDRESS,
        });
        assert.equal(finalState.creditTinybar, "0");
        assert.equal((await adapter.engine.credit(env.SELLER_ADDRESS)).toString(), "0");
        if (expectedOutcome === "filled") checks.filledPathCreditsRecovered = true;
        else if (expectedOutcome === "partial") checks.partialFillCreditsRecovered = true;
        else checks.noFillCreditsRecovered = true;

        const balancesAfter = {
            buyer: (await token.balanceOfByPartition(partition, env.BUYER_ADDRESS)).toString(),
            seller: (await token.balanceOfByPartition(partition, env.SELLER_ADDRESS)).toString(),
        };
        if (expectedOutcome !== "no-fill") {
            assert.equal(
                BigInt(balancesAfter.buyer) - BigInt(balancesBefore.buyer),
                BigInt(sellerQuantity)
            );
            assert.equal(
                BigInt(balancesBefore.seller) - BigInt(balancesAfter.seller),
                BigInt(sellerQuantity)
            );
        } else {
            assert.deepEqual(balancesAfter, balancesBefore);
        }
        checks.sameProtocolPositionVisible = true;

        const disclosureTransactions = [
            ...agentTransactions,
            ...sellerTransactions,
            cross,
        ];
        const venueDisclosure = disclosureEvidence(
            disclosureTransactions,
            engineAbi,
            adapter.engineAddress
        );
        const receipt = buildOrderReceipt({
            context,
            mandateId: activation.mandateId,
            commitment: evaluation.commitment,
            decision: evaluation.decision,
            inference: evaluation.inference,
            worker: evaluation.worker,
            snapshot,
            transactions: agentTransactions,
            actionState: finalState,
            roundState,
            venueDisclosure,
            proofHash: evaluation.inference.proofHash,
        });
        assert.equal(verifyOrderReceiptShape(receipt), true);
        assert.equal(JSON.stringify(receipt).includes(sellSalt), false);
        assert.equal(JSON.stringify(receipt).includes(env.BUYER_PRIVATE_KEY), false);
        checks.receiptsAreSanitized = true;
        receipts.push({name, receipt});
        await writeFile(
            path.join(EVIDENCE_DIR, `phase2-${name}-receipt.json`),
            `${JSON.stringify(receipt, null, 2)}\n`,
            "utf8"
        );
        return {
            name,
            agentOrder: evaluation.commitment,
            sellerOrder: sellCommitment,
            round,
            expectedOutcome,
            finalLifecycle: finalState.lifecycle,
            creditsBefore,
            creditBeforeWithdrawTotalTinybar: creditBeforeWithdraw.toString(),
            agentCreditDeltaTinybar: buyerCreditDelta.toString(),
            sellerCreditDeltaTinybar: sellerCreditDelta.toString(),
            balancesBefore,
            balancesAfter,
            agentTransactions: Object.fromEntries(
                agentTransactions.map((entry) => [entry.stage, entry.transactionHash])
            ),
            sellerTransactions: Object.fromEntries(
                sellerTransactions.map((entry) => [entry.stage, entry.transactionHash])
            ),
            crossTransaction: cross.transactionHash,
            receiptHash: hash(Buffer.from(JSON.stringify(receipt))),
        };
    }

    try {
        await mkdir(EVIDENCE_DIR, {recursive: true});
        const cases = [];
        if (selection === "all") {
            cases.push(
                await runCase({
                    name: "filled",
                    buyerPrice: 119,
                    sellerPrice: 81,
                    quantity: 10,
                    expectedOutcome: "filled",
                })
            );
        }
        cases.push(
            await runCase({
                name: "partial",
                buyerPrice: 119,
                sellerPrice: 81,
                quantity: 10,
                sellerQuantity: 4,
                expectedOutcome: "partial",
            })
        );
        if (selection === "all") {
            cases.push(
                await runCase({
                    name: "no-fill",
                    buyerPrice: 119,
                    sellerPrice: 120,
                    quantity: 7,
                    expectedOutcome: "no-fill",
                })
            );
        }
        const requiredChecks =
            selection === "all"
                ? Object.keys(checks)
                : [
                    "restartedFromEncryptedJournal",
                    "changedProjectionRefusedBeforeBroadcast",
                    "cancelAfterRevealRefusedBeforeSigning",
                    "partialFillObserved",
                    "partialFillExpired",
                    "partialFillCreditsRecovered",
                    "sameProtocolPositionVisible",
                    "receiptsAreSanitized",
                ];
        assert.ok(requiredChecks.every((name) => checks[name] === true));
        const report = {
            schemaVersion: "lattice.agent.phase2-testnet-evidence.v1",
            status: "passed",
            startedAt: started,
            completedAt: new Date().toISOString(),
            network: {
                chainId: adapter.manifest.network.chainId,
                rpc: adapter.manifest.network.rpc,
            },
            deployment: adapter.lastDeploymentEvidence,
            actors: {
                agentBuyer: env.BUYER_ADDRESS.toLowerCase(),
                preparedSeller: env.SELLER_ADDRESS.toLowerCase(),
            },
            modelHash: verifierManifest.modelHash,
            policyHash,
            feePolicy,
            selection,
            checks,
            cases,
            privacy:
                "Sanitized evidence contains no signing key, reveal salt, proof body, signed bytes, or private witness. No agent evidence was submitted to HCS.",
        };
        const rendered = `${JSON.stringify(report, null, 2)}\n`;
        const evidenceName =
            selection === "all" ? "phase2-testnet.json" : "phase2-partial-testnet.json";
        const deploymentName =
            selection === "all" ? "agent-phase2.json" : "agent-phase2-partial.json";
        await writeFile(path.join(EVIDENCE_DIR, evidenceName), rendered, "utf8");
        await writeFile(
            path.join(VENUE_ROOT, "deployments", deploymentName),
            rendered,
            "utf8"
        );
        console.log(rendered);
    } finally {
        await signer.stop();
        await rm(stateDir, {recursive: true, force: true});
        adapter.close();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({
        ok: false,
        code: typeof error?.code === "string" ? error.code : "PHASE2_LIVE_FAILED",
        message: error?.message ?? "Phase 2 live test failed",
    }));
    process.exitCode = 1;
});
