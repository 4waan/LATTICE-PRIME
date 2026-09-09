import {createHash} from "node:crypto";

import {canonicalizeContext, contextId} from "./context.mjs";

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
        !["context,mandate,nonce", "context,mandate,nonce,snapshot"].includes(
            Object.keys(value).sort().join(",")
        )
    ) {
        throw new AgentRuntimeError("EVALUATION_SCHEMA", "evaluation request has an unknown or missing field");
    }
    if (!Number.isSafeInteger(value.nonce) || value.nonce < 0) {
        throw new AgentRuntimeError("NONCE_INVALID", "evaluation nonce is invalid");
    }
}

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function evidenceHash(value) {
    return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function exactContinueRequest(value) {
    if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "actionId,nonce,stage" ||
        typeof value.actionId !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(value.actionId) ||
        !["reveal", "cancel", "expire", "withdraw"].includes(value.stage) ||
        !Number.isSafeInteger(value.nonce) ||
        value.nonce < 0
    ) {
        throw new AgentRuntimeError(
            "CONTINUATION_SCHEMA",
            "continuation requires actionId, nonce, and an approved outstanding stage"
        );
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
        const {mandate, nonce} = request;
        const context = canonicalizeContext(request.context);
        if (typeof this.adapter.authenticateSnapshot === "function") {
            if (request.snapshot === undefined) {
                throw new AgentRuntimeError(
                    "SNAPSHOT_REQUIRED",
                    "live evaluation requires its complete authenticated market snapshot"
                );
            }
            const authenticated = await this.adapter.authenticateSnapshot(request.snapshot);
            if (
                authenticated.snapshotId !== context.snapshotId ||
                authenticated.publicSlot !== context.publicSlot ||
                authenticated.limitPrice !== context.price ||
                authenticated.quantity !== context.quantity ||
                canonical(authenticated.features) !== canonical(context.features)
            ) {
                throw new AgentRuntimeError(
                    "SNAPSHOT_MISMATCH",
                    "decision context does not match the authenticated market snapshot"
                );
            }
            const now = BigInt(Math.floor(Date.now() / 1000));
            const publicSlot = BigInt(context.publicSlot);
            const age = now > publicSlot ? now - publicSlot : 0n;
            if (age > BigInt(mandate.time.snapshotFreshnessSeconds)) {
                throw new AgentRuntimeError(
                    "STALE_SNAPSHOT",
                    "authenticated market snapshot exceeded the mandate freshness limit"
                );
            }
        }
        const preflight = await this.adapter.preflight({
            chainId: context.chainId,
            deploymentHash: context.deploymentHash,
            engine: context.engine,
            executionAccount: context.executionAccount,
            feeReserveTinybar: mandate.limits.feeReserve,
            price: context.price,
            quantity: context.quantity,
            stage: "commit",
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
                proofHash: evidenceHash(workerResult.proof),
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
            commitment: null,
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
        const broadcast = await this.#broadcast(receipt.actionId, "commit", signed);
        receipt.transaction = {
            status: broadcast.status,
            transactionHash: signed.transactionHash,
            method: "commit",
            confirmed: broadcast.status === "confirmed",
            blockNumber: broadcast.blockNumber,
            gasUsed: broadcast.gasUsed,
            logs: broadcast.logs ?? [],
            exactProjectionMatched: true,
        };
        receipt.commitment = signed.projection.commitment;
        return receipt;
    }

    async continueAction(request) {
        exactContinueRequest(request);
        const action = await this.signer.call("action", {actionId: request.actionId});
        let protocolPreflight = null;
        if (request.stage === "reveal") {
            protocolPreflight = await this.adapter.preflight({
                chainId: action.context.chainId,
                deploymentHash: action.context.deploymentHash,
                engine: action.context.engine,
                executionAccount: action.context.executionAccount,
                feeReserveTinybar: action.mandate.limits.feeReserve,
                price: action.context.price,
                quantity: action.context.quantity,
                stage: "reveal",
                token: action.context.token,
            });
            if (
                protocolPreflight.identityMatches !== true ||
                protocolPreflight.eligible !== true ||
                protocolPreflight.feeBalanceSufficient !== true
            ) {
                throw new AgentRuntimeError(
                    "REVEAL_PREFLIGHT_REFUSED",
                    "protocol identity, eligibility, or reveal funding changed after commitment"
                );
            }
            if (
                BigInt(protocolPreflight.checkedAtTimestamp) >
                BigInt(action.mandate.time.recoveryDeadline)
            ) {
                throw new AgentRuntimeError(
                    "RECOVERY_DEADLINE_EXPIRED",
                    "mandate recovery deadline passed before reveal"
                );
            }
        }
        const before = await this.adapter.readAction({
            commitment: action.commitment,
            account: action.context.executionAccount,
        });
        this.#assertStageAvailable(request.stage, before);
        const existing = action.transactions[request.stage];
        const signed =
            existing ??
            await this.signer.call("prepareOutstanding", {
                actionId: request.actionId,
                stage: request.stage,
                nonce: request.nonce,
            });
        if (existing !== null && existing.nonce !== request.nonce) {
            throw new AgentRuntimeError(
                "NONCE_CHANGE_REFUSED",
                "continuation retry must use the persisted transaction nonce"
            );
        }
        const broadcast = await this.#broadcast(request.actionId, request.stage, signed);
        const after = await this.adapter.readAction({
            commitment: action.commitment,
            account: action.context.executionAccount,
        });
        return {
            schemaVersion: "lattice.agent.lifecycle-step.v1",
            actionId: request.actionId,
            stage: request.stage,
            commitment: action.commitment,
            transaction: {
                transactionHash: signed.transactionHash,
                status: broadcast.status,
                blockNumber: broadcast.blockNumber,
                gasUsed: broadcast.gasUsed,
                logs: broadcast.logs ?? [],
                exactProjectionMatched: true,
            },
            before,
            after,
            protocolPreflight:
                protocolPreflight === null
                    ? null
                    : {
                        stage: protocolPreflight.stage,
                        checkedAtBlock: protocolPreflight.checkedAtBlock,
                        checkedAtTimestamp: protocolPreflight.checkedAtTimestamp,
                        identityMatches: protocolPreflight.identityMatches,
                        eligible: protocolPreflight.eligible,
                        halted: protocolPreflight.halted,
                        feeBalanceSufficient: protocolPreflight.feeBalanceSufficient,
                    },
        };
    }

    async recoverAction({actionId, nonce}) {
        if (
            typeof actionId !== "string" ||
            !/^sha256:[0-9a-f]{64}$/.test(actionId) ||
            !Number.isSafeInteger(nonce) ||
            nonce < 0
        ) {
            throw new AgentRuntimeError("RECOVERY_SCHEMA", "recovery request is invalid");
        }
        const action = await this.signer.call("action", {actionId});
        const state = await this.adapter.readAction({
            commitment: action.commitment,
            account: action.context.executionAccount,
        });
        if (state.lifecycle === "REVEALABLE") {
            return this.continueAction({actionId, stage: "reveal", nonce});
        }
        if (state.lifecycle === "EXPIREABLE") {
            return this.continueAction({actionId, stage: "expire", nonce});
        }
        if (BigInt(state.creditTinybar) > 0n && !["SEALED", "REVEALABLE"].includes(state.lifecycle)) {
            return this.continueAction({actionId, stage: "withdraw", nonce});
        }
        return {
            schemaVersion: "lattice.agent.lifecycle-wait.v1",
            actionId,
            commitment: action.commitment,
            state,
            nextAction: state.lifecycle === "SEALED" ? "wait-for-reveal" : "wait-for-auction-or-expiry",
        };
    }

    async #broadcast(actionId, stage, signed) {
        let broadcast;
        try {
            broadcast = await this.adapter.broadcast(signed);
        } catch (error) {
            if (error?.code !== "BROADCAST_UNKNOWN") throw error;
            const reconciled = await this.adapter.reconcile(signed.transactionHash);
            if (reconciled.known !== true) {
                await this.signer.call("recordBroadcast", {
                    actionId,
                    stage,
                    transactionHash: signed.transactionHash,
                    status: "unknown",
                });
                throw new AgentRuntimeError("RECOVERY_REQUIRED", "broadcast outcome remains unknown");
            }
            broadcast = reconciled;
        }
        const status =
            broadcast.status === "confirmed"
                ? "confirmed"
                : broadcast.status === "reverted"
                    ? "reverted"
                    : "unknown";
        await this.signer.call("recordBroadcast", {
            actionId,
            stage,
            transactionHash: signed.transactionHash,
            status,
        });
        if (status === "reverted") {
            throw new AgentRuntimeError("CHAIN_TRANSACTION_REVERTED", `${stage} transaction reverted`);
        }
        return broadcast;
    }

    #assertStageAvailable(stage, state) {
        const allowed =
            (stage === "reveal" && state.lifecycle === "REVEALABLE") ||
            (stage === "cancel" && state.lifecycle === "SEALED") ||
            (stage === "expire" && state.lifecycle === "EXPIREABLE") ||
            (stage === "withdraw" &&
                BigInt(state.creditTinybar) > 0n &&
                !["SEALED", "REVEALABLE", "IN_AUCTION"].includes(state.lifecycle));
        if (!allowed) {
            throw new AgentRuntimeError(
                "LIFECYCLE_STAGE_REFUSED",
                `${stage} is not available while the chain action is ${state.lifecycle}`
            );
        }
    }
}
