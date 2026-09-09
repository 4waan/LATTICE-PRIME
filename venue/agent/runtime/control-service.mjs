import {createHash, randomBytes} from "node:crypto";

import {mandateId} from "./policy.mjs";

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const MAX_PREVIEWS = 8;

export class AgentControlError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "AgentControlError";
        this.code = code;
    }
}

function hash(bytes) {
    return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function decimal(value, name, {nonzero = false} = {}) {
    if (typeof value !== "string" || !DECIMAL.test(value)) {
        throw new AgentControlError("CONTROL_INVALID", `${name} must be a canonical decimal string`);
    }
    const parsed = BigInt(value);
    if ((nonzero && parsed === 0n) || parsed >= 1n << 128n) {
        throw new AgentControlError("CONTROL_INVALID", `${name} must be nonzero and fit uint128`);
    }
    return value;
}

function exact(value, keys, name) {
    if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
    ) {
        throw new AgentControlError("CONTROL_INVALID", `${name} has an unknown or missing field`);
    }
}

export class AgentControlService {
    constructor({
        signer,
        adapter,
        runtime,
        modelHash,
        policyHash,
        feePolicy,
    }) {
        if (
            typeof modelHash !== "string" ||
            !/^sha256:[0-9a-f]{64}$/.test(modelHash) ||
            typeof policyHash !== "string" ||
            !/^0x[0-9a-f]{64}$/.test(policyHash)
        ) {
            throw new AgentControlError("CONTROL_CONFIG_INVALID", "agent release hashes are invalid");
        }
        this.signer = signer;
        this.adapter = adapter;
        this.runtime = runtime;
        this.modelHash = modelHash;
        this.policyHash = policyHash;
        this.feePolicy = feePolicy;
        this.previews = new Map();
    }

    async preview(request) {
        exact(request, ["limitPrice", "quantity"], "agent preview request");
        const limitPrice = decimal(request.limitPrice, "limitPrice", {nonzero: true});
        const quantity = decimal(request.quantity, "quantity", {nonzero: true});
        const snapshot = await this.adapter.snapshot({limitPrice, quantity});
        const feeReserve = this.#feeReserve();
        const context = {
            protocolDomain: hash(Buffer.from("lattice.agent.decision-context.v1")),
            chainId: this.adapter.manifest.network.chainId,
            engine: this.adapter.engineAddress,
            executionAccount: this.adapter.executionAccount,
            token: this.adapter.tokenAddress,
            side: "BUY",
            price: limitPrice,
            quantity,
            recoveryAddress: this.adapter.executionAccount,
            snapshotId: snapshot.snapshotId,
            deploymentHash: this.adapter.deploymentHash,
            modelBundleHash: this.modelHash.replace("sha256:", "0x"),
            policyHash: this.policyHash,
            mandateNonce: hash(randomBytes(32)),
            decisionSequence: 0,
            publicSlot: snapshot.publicSlot,
            expiresAt: (BigInt(snapshot.publicSlot) + 60n).toString(),
            features: snapshot.features,
        };
        const mandate = {
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
                bondBudget: this.adapter.manifest.immutables.commitBondTinybar,
                cancellationBudget: this.adapter.manifest.immutables.cancelFeeTinybar,
                feeReserve,
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
        const preflight = await this.adapter.preflight({
            chainId: context.chainId,
            deploymentHash: context.deploymentHash,
            engine: context.engine,
            executionAccount: context.executionAccount,
            feeReserveTinybar: feeReserve,
            price: context.price,
            quantity: context.quantity,
            stage: "commit",
            token: context.token,
        });
        const previewId = randomBytes(32).toString("base64url");
        while (this.previews.size >= MAX_PREVIEWS) {
            this.previews.delete(this.previews.keys().next().value);
        }
        this.previews.set(previewId, {snapshot, context, mandate});
        return {
            schemaVersion: "lattice.agent.mandate-preview.v1",
            previewId,
            mandateId: mandateId(mandate),
            account: context.executionAccount,
            side: "BUY",
            limitPrice,
            quantity,
            principalBudget: mandate.limits.principalBudget,
            bondBudget: mandate.limits.bondBudget,
            cancellationBudget: mandate.limits.cancellationBudget,
            feeReserve: mandate.limits.feeReserve,
            validUntil: mandate.time.lastNewEntryAt,
            recoveryDeadline: mandate.time.recoveryDeadline,
            preflight: {
                checkedAtBlock: preflight.checkedAtBlock,
                eligible: preflight.eligible,
                halted: preflight.halted,
                feeBalanceSufficient: preflight.feeBalanceSufficient,
            },
            privacy:
                "No signing key, reveal salt, proof body, credential material, or off-platform holding enters this preview.",
        };
    }

    async execute(request) {
        exact(request, ["previewId"], "agent execution request");
        if (typeof request.previewId !== "string") {
            throw new AgentControlError("PREVIEW_INVALID", "agent preview identifier is invalid");
        }
        const prepared = this.previews.get(request.previewId);
        this.previews.delete(request.previewId);
        if (prepared === undefined) {
            throw new AgentControlError("PREVIEW_MISSING", "agent preview is missing, expired, or already used");
        }
        if (BigInt(Math.floor(Date.now() / 1000)) > BigInt(prepared.context.expiresAt)) {
            throw new AgentControlError("PREVIEW_EXPIRED", "agent preview expired before confirmation");
        }
        const activation = await this.signer.call("activateMandate", {mandate: prepared.mandate});
        const nonce = await this.adapter.nextNonce();
        const receipt = await this.runtime.evaluate({
            context: prepared.context,
            mandate: prepared.mandate,
            nonce,
            snapshot: prepared.snapshot,
        });
        return {
            schemaVersion: "lattice.agent.control-result.v1",
            mandateId: activation.mandateId,
            receipt,
        };
    }

    #feeReserve() {
        const weibarPerTinybar = 10_000_000_000n;
        const maximumFee =
            (BigInt(this.feePolicy.gasLimit) * BigInt(this.feePolicy.maxFeePerGas) +
                weibarPerTinybar - 1n) /
            weibarPerTinybar;
        return (maximumFee * 6n).toString();
    }
}
