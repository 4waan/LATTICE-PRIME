import {contextId} from "./context.mjs";

export class AgentRuntimeError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "AgentRuntimeError";
        this.code = code;
    }
}

function exactRequest(value) {
    if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "context,mandate,nonce"
    ) {
        throw new AgentRuntimeError("EVALUATION_SCHEMA", "evaluation request has an unknown or missing field");
    }
    if (!Number.isSafeInteger(value.nonce) || value.nonce < 0) {
        throw new AgentRuntimeError("NONCE_INVALID", "evaluation nonce is invalid");
    }
}

export class AgentRuntime {
    constructor({signer, adapter, worker, verifier}) {
        this.signer = signer;
        this.adapter = adapter;
        this.worker = worker;
        this.verifier = verifier;
    }

    async evaluate(request) {
        exactRequest(request);
        const {mandate, context, nonce} = request;
        const preflight = await this.adapter.preflight({
            chainId: context.chainId,
            engine: context.engine,
            executionAccount: context.executionAccount,
            token: context.token,
        });
        if (
            preflight.identityMatches !== true ||
            preflight.eligible !== true ||
            preflight.halted !== false ||
            preflight.feeBalanceSufficient !== true
        ) {
            throw new AgentRuntimeError("PREFLIGHT_REFUSED", "protocol preflight refused the evaluation");
        }

        await this.signer.call("reserveEvaluation", {mandate, context});
        const workerResult = await this.worker.prove(context);
        const verification = await this.verifier.verify({
            proof: workerResult.proof,
            context,
        });
        if (verification.verified !== true || !["WAIT", "EXECUTE"].includes(verification.decision)) {
            throw new AgentRuntimeError("PROOF_REFUSED", "decision proof or public instances were refused");
        }

        const receipt = {
            schemaVersion: "lattice.agent.decision-receipt.v1",
            actionId: contextId(context),
            decision: verification.decision,
            inference: {
                status: "verified",
                modelHash: verification.modelHash,
                settingsHash: verification.settingsHash,
                verificationKeyHash: verification.verificationKeyHash,
                expectedContextMatched: true,
            },
            worker: {
                status: "checked locally",
                ...workerResult.evidence,
            },
            transaction: {
                status: "not checked",
                transactionHash: null,
                method: null,
            },
            limitations: [
                "The supplied market snapshot is checked separately from inference validity.",
                "Worker isolation evidence is local and is not remote attestation.",
            ],
        };
        if (verification.decision === "WAIT") return receipt;

        const signed = await this.signer.call("prepareCommit", {
            mandate,
            context,
            request: {
                nonce,
                approval: {
                    actionId: receipt.actionId,
                    commitBond: mandate.limits.bondBudget,
                    decision: "EXECUTE",
                    proofVerified: true,
                },
            },
        });
        let broadcast;
        try {
            broadcast = await this.adapter.broadcast(signed);
        } catch (error) {
            if (error?.code !== "BROADCAST_UNKNOWN") throw error;
            const reconciled = await this.adapter.reconcile(signed.transactionHash);
            if (reconciled.known !== true) {
                await this.signer.call("recordBroadcast", {
                    actionId: receipt.actionId,
                    stage: "commit",
                    transactionHash: signed.transactionHash,
                    status: "unknown",
                });
                throw new AgentRuntimeError("RECOVERY_REQUIRED", "broadcast outcome remains unknown");
            }
            broadcast = reconciled;
        }
        await this.signer.call("recordBroadcast", {
            actionId: receipt.actionId,
            stage: "commit",
            transactionHash: signed.transactionHash,
            status: broadcast.status === "confirmed" ? "confirmed" : "unknown",
        });
        receipt.transaction = {
            status: "checked locally",
            transactionHash: signed.transactionHash,
            method: "commit",
            confirmed: broadcast.status === "confirmed",
            exactProjectionMatched: true,
        };
        return receipt;
    }
}
