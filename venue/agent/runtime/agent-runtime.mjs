import {createHash} from "node:crypto";

import {canonicalizeContext, contextId} from "./context.mjs";
import {mandateId} from "./policy.mjs";

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
    constructor({signer, adapter, worker, verifier, receiptStore = null}) {
        this.signer = signer;
        this.adapter = adapter;
        this.worker = worker;
        this.verifier = verifier;
        this.receiptStore = receiptStore;
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
        const preflight = await this.#commitPreflight(mandate, context);
        this.#assertCommitPreflight(preflight, mandate, context);
        const expectedNonce = await this.adapter.nextNonce();
        if (expectedNonce !== nonce) {
            throw new AgentRuntimeError(
                "NONCE_MISMATCH",
                "requested commit nonce does not match the pending chain nonce"
            );
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
        await this.#recordEvaluation(receipt, mandate, request.snapshot ?? null);
        if (verification.decision === "WAIT") return receipt;

        const finalPreflight = await this.#commitPreflight(mandate, context);
        this.#assertCommitPreflight(finalPreflight, mandate, context);
        const finalNonce = await this.adapter.nextNonce();
        if (finalNonce !== nonce) {
            throw new AgentRuntimeError(
                "NONCE_CHANGED",
                "account nonce changed while the decision proof was generated"
            );
        }
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
        await this.#recordEvaluation(receipt, mandate, request.snapshot ?? null);
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
        const result = {
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
        await this.#recordReceipt("recordStep", result);
        return result;
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
        await this.#recordReceipt("ensureAction", action);
        if (state.lifecycle === "UNKNOWN") {
            const result = action.transactions.commit === null
                ? await this.#recoverUnsignedCommit(action, state)
                : await this.#recoverCommit(action, state);
            if (result.schemaVersion === "lattice.agent.lifecycle-step.v1") {
                await this.#recordReceipt("recordStep", result);
            } else {
                await this.#recordReceipt("recordObservation", actionId, result.state);
            }
            return result;
        }
        if (state.lifecycle === "SEALED" && action.authority?.paused === true) {
            return this.continueAction({
                actionId,
                stage: "cancel",
                nonce: action.transactions.cancel?.nonce ?? nonce,
            });
        }
        if (state.lifecycle === "REVEALABLE") {
            return this.continueAction({
                actionId,
                stage: "reveal",
                nonce: action.transactions.reveal?.nonce ?? nonce,
            });
        }
        if (state.lifecycle === "EXPIREABLE") {
            return this.continueAction({
                actionId,
                stage: "expire",
                nonce: action.transactions.expire?.nonce ?? nonce,
            });
        }
        if (
            BigInt(state.creditTinybar) > 0n &&
            !["SEALED", "REVEALABLE", "IN_AUCTION"].includes(state.lifecycle)
        ) {
            return this.continueAction({
                actionId,
                stage: "withdraw",
                nonce: action.transactions.withdraw?.nonce ?? nonce,
            });
        }
        const result = {
            schemaVersion: "lattice.agent.lifecycle-wait.v1",
            actionId,
            commitment: action.commitment,
            state,
            nextAction: state.lifecycle === "SEALED" ? "wait-for-reveal" : "wait-for-auction-or-expiry",
        };
        await this.#recordReceipt("recordObservation", actionId, state);
        return result;
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

    async #commitPreflight(mandate, context) {
        return this.adapter.preflight({
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
    }

    #assertCommitPreflight(preflight, mandate, context) {
        const checkedAt = BigInt(preflight.checkedAtTimestamp);
        const wallClock =
            preflight.liveChainChecked === true
                ? BigInt(Math.floor(Date.now() / 1000))
                : checkedAt;
        const authorizationTime = checkedAt > wallClock ? checkedAt : wallClock;
        const publicSlot = BigInt(context.publicSlot);
        if (
            authorizationTime > BigInt(context.expiresAt) ||
            authorizationTime > BigInt(mandate.time.lastNewEntryAt)
        ) {
            throw new AgentRuntimeError(
                "AUTHORIZATION_EXPIRED",
                "decision context expired before commit authorization completed"
            );
        }
        if (
            authorizationTime > publicSlot &&
            authorizationTime - publicSlot > BigInt(mandate.time.snapshotFreshnessSeconds)
        ) {
            throw new AgentRuntimeError(
                "STALE_SNAPSHOT",
                "market snapshot became stale before commit authorization completed"
            );
        }
        if (
            preflight.identityMatches !== true ||
            preflight.eligible !== true ||
            preflight.halted !== false ||
            preflight.feeBalanceSufficient !== true
        ) {
            throw new AgentRuntimeError("PREFLIGHT_REFUSED", "protocol preflight refused the evaluation");
        }
    }

    async #recoverCommit(action, before) {
        const signed = action.transactions.commit;
        const reconciled = await this.adapter.reconcile(signed.transactionHash);
        let outcome = reconciled;
        if (reconciled.known !== true) {
            if (typeof this.adapter.accountNonces !== "function") {
                throw new AgentRuntimeError(
                    "NONCE_STATE_UNAVAILABLE",
                    "commit recovery requires separate latest and pending account nonces"
                );
            }
            const nonces = await this.adapter.accountNonces();
            if (
                !Number.isSafeInteger(nonces?.latest) ||
                nonces.latest < 0 ||
                !Number.isSafeInteger(nonces?.pending) ||
                nonces.pending < nonces.latest
            ) {
                throw new AgentRuntimeError(
                    "NONCE_STATE_INVALID",
                    "adapter returned invalid account nonce state"
                );
            }
            if (nonces.latest > signed.nonce) {
                throw new AgentRuntimeError(
                    "COMMIT_NONCE_CONSUMED",
                    "commit nonce was consumed but the persisted transaction is not on chain"
                );
            }
            if (nonces.pending < signed.nonce) {
                throw new AgentRuntimeError(
                    "COMMIT_NONCE_GAP",
                    "commit recovery is waiting for an earlier account nonce"
                );
            }
            outcome = await this.#broadcast(action.actionId, "commit", signed);
        } else {
            const status = reconciled.status === "confirmed" ? "confirmed" : "reverted";
            await this.signer.call("recordBroadcast", {
                actionId: action.actionId,
                stage: "commit",
                transactionHash: signed.transactionHash,
                status,
            });
            if (status === "reverted") {
                throw new AgentRuntimeError(
                    "CHAIN_TRANSACTION_REVERTED",
                    "commit transaction reverted"
                );
            }
        }
        const after = await this.adapter.readAction({
            commitment: action.commitment,
            account: action.context.executionAccount,
        });
        return {
            schemaVersion: "lattice.agent.lifecycle-step.v1",
            actionId: action.actionId,
            stage: "commit",
            commitment: action.commitment,
            transaction: {
                transactionHash: signed.transactionHash,
                status: outcome.status,
                blockNumber: outcome.blockNumber,
                gasUsed: outcome.gasUsed,
                logs: outcome.logs ?? [],
                exactProjectionMatched: true,
            },
            before,
            after,
            protocolPreflight: null,
            recovery: "persisted commit transaction reconciled or rebroadcast without re-signing",
        };
    }

    async #recoverUnsignedCommit(action, before) {
        if (action.authority?.paused === true) {
            return this.#abandonUnsignedCommit(action, before, "mandate-paused");
        }
        const preflight = await this.#commitPreflight(action.mandate, action.context);
        try {
            this.#assertCommitPreflight(preflight, action.mandate, action.context);
        } catch (error) {
            if (["AUTHORIZATION_EXPIRED", "STALE_SNAPSHOT"].includes(error?.code)) {
                return this.#abandonUnsignedCommit(action, before, error.code.toLowerCase());
            }
            throw error;
        }
        const reservedNonce = action.reservedNonces?.commit;
        const nonces = await this.adapter.accountNonces();
        if (
            !Number.isSafeInteger(reservedNonce) ||
            reservedNonce < 0 ||
            !Number.isSafeInteger(nonces?.latest) ||
            nonces.latest < 0 ||
            !Number.isSafeInteger(nonces?.pending) ||
            nonces.pending < nonces.latest
        ) {
            throw new AgentRuntimeError(
                "NONCE_STATE_INVALID",
                "unsigned commit recovery received invalid persisted or chain nonce state"
            );
        }
        if (nonces.latest > reservedNonce || nonces.pending > reservedNonce) {
            return this.#abandonUnsignedCommit(action, before, "nonce-consumed");
        }
        if (nonces.pending < reservedNonce) {
            throw new AgentRuntimeError(
                "COMMIT_NONCE_GAP",
                "unsigned commit recovery is waiting for an earlier account nonce"
            );
        }
        const signed = await this.signer.call("preparePersistedCommit", {
            actionId: action.actionId,
        });
        return this.#recoverCommit(
            {
                ...action,
                transactions: {...action.transactions, commit: signed},
            },
            before
        );
    }

    async #abandonUnsignedCommit(action, before, reason) {
        await this.signer.call("abandonUnsignedCommit", {actionId: action.actionId});
        return {
            schemaVersion: "lattice.agent.lifecycle-wait.v1",
            actionId: action.actionId,
            commitment: action.commitment,
            state: {
                ...before,
                lifecycle: "ABANDONED_UNSIGNED",
            },
            nextAction: "none",
            recovery: `unsigned commit ticket abandoned: ${reason}`,
        };
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

    async #recordEvaluation(receipt, mandate, snapshot) {
        await this.#recordReceipt("recordEvaluation", {
            receipt,
            mandateId: mandateId(mandate),
            snapshot,
        });
    }

    async #recordReceipt(method, ...args) {
        if (this.receiptStore === null || typeof this.receiptStore?.[method] !== "function") {
            return false;
        }
        try {
            await this.receiptStore[method](...args);
            return true;
        } catch {
            return false;
        }
    }
}
