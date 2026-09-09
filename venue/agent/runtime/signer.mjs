import {randomBytes} from "node:crypto";
import {Transaction, Wallet, getAddress, hexlify} from "ethers";

import {contextId} from "./context.mjs";
import {validateMandate} from "./mandate.mjs";
import {
    createAuthorityState,
    mandateId,
    reserveApprovedBuy,
    reserveCancellation,
    reserveEvaluation as reservePolicyEvaluation,
    setAuthorityPaused,
} from "./policy.mjs";
import {
    ProjectionError,
    assertTransactionMatchesProjection,
    projectCancel,
    projectCommit,
    projectExpire,
    projectReveal,
    projectWithdraw,
} from "./transaction-projector.mjs";

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const ACTION_ID = /^sha256:[0-9a-f]{64}$/;
const OUTSTANDING_STAGES = new Set(["reveal", "cancel", "expire", "withdraw"]);

export class SignerError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "SignerError";
        this.code = code;
    }
}

function decimal(value, name, {nonzero = false} = {}) {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new SignerError("INVALID_DECIMAL", `${name} must be a canonical decimal string`);
    }
    const parsed = BigInt(value);
    if (nonzero && parsed === 0n) throw new SignerError("INVALID_DECIMAL", `${name} must be nonzero`);
    return parsed;
}

function nonce(value) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new SignerError("INVALID_NONCE", "nonce must be a nonnegative safe integer");
    }
    return value;
}

function feePolicy(value) {
    if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "gasLimit,maxFeePerGas,maxPriorityFeePerGas"
    ) {
        throw new SignerError("INVALID_FEE_POLICY", "fee policy has an unknown or missing field");
    }
    const normalized = {
        gasLimit: decimal(value.gasLimit, "gasLimit", {nonzero: true}),
        maxFeePerGas: decimal(value.maxFeePerGas, "maxFeePerGas", {nonzero: true}),
        maxPriorityFeePerGas: decimal(value.maxPriorityFeePerGas, "maxPriorityFeePerGas"),
    };
    if (normalized.maxPriorityFeePerGas > normalized.maxFeePerGas) {
        throw new SignerError("INVALID_FEE_POLICY", "priority fee exceeds the maximum fee");
    }
    return normalized;
}

function requestNonce(value) {
    if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "nonce"
    ) {
        throw new SignerError("INVALID_SIGN_REQUEST", "sign request permits only a nonce");
    }
    return nonce(value.nonce);
}

function outstandingRequest(value) {
    if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "actionId,nonce,stage" ||
        typeof value.actionId !== "string" ||
        !ACTION_ID.test(value.actionId) ||
        !OUTSTANDING_STAGES.has(value.stage)
    ) {
        throw new SignerError(
            "INVALID_SIGN_REQUEST",
            "outstanding action request requires actionId, nonce, and an approved stage"
        );
    }
    return {actionId: value.actionId, nonce: nonce(value.nonce), stage: value.stage};
}

function commitRequest(value) {
    if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "approval,nonce"
    ) {
        throw new SignerError("INVALID_SIGN_REQUEST", "commit request permits only approval and nonce");
    }
    return {nonce: nonce(value.nonce), approval: value.approval};
}

function assertNonceAvailable(state, requestedNonce, actionId, nonceField) {
    for (const [otherActionId, ticket] of Object.entries(state.tickets)) {
        for (const field of [
            "commitNonce",
            "revealNonce",
            "cancelNonce",
            "expireNonce",
            "withdrawNonce",
        ]) {
            if (
                ticket[field] === requestedNonce &&
                (otherActionId !== actionId || field !== nonceField)
            ) {
                throw new SignerError(
                    "NONCE_RESERVED",
                    "account nonce is already reserved by another typed action"
                );
            }
        }
    }
}

export class LocalTypedSigner {
    constructor({
        store,
        feePolicy: configuredFeePolicy,
        commitBondTinybar,
        cancelFeeTinybar,
    }) {
        if (store === null || typeof store !== "object") {
            throw new SignerError("STORE_REQUIRED", "typed signer requires an encrypted store");
        }
        this.store = store;
        this.fees = feePolicy(configuredFeePolicy);
        this.commitBond = decimal(commitBondTinybar, "commitBondTinybar", {nonzero: true}).toString();
        this.cancelFee = decimal(cancelFeeTinybar, "cancelFeeTinybar", {nonzero: true}).toString();
    }

    async initializeAccount(passphrase, suppliedPrivateKey = null) {
        const privateKey = suppliedPrivateKey ?? Wallet.createRandom().privateKey;
        if (typeof privateKey !== "string" || !PRIVATE_KEY.test(privateKey)) {
            throw new SignerError("PRIVATE_KEY_INVALID", "private key must be a 32-byte hex value");
        }
        const wallet = new Wallet(privateKey);
        await this.store.transact(passphrase, "create-signer", (state) => {
            if (Object.keys(state.signer).length !== 0) {
                throw new SignerError("ACCOUNT_EXISTS", "the dedicated signer account already exists");
            }
            state.signer = {
                schemaVersion: "lattice.agent.signer-key.v1",
                address: wallet.address.toLowerCase(),
                privateKey: privateKey.toLowerCase(),
            };
        });
        return wallet.address.toLowerCase();
    }

    async account(passphrase) {
        const wallet = await this.#wallet(passphrase);
        return wallet.address.toLowerCase();
    }

    async summary(passphrase) {
        const state = await this.store.read(passphrase);
        return {
            schemaVersion: "lattice.agent.signer-summary.v1",
            address: state.signer.address,
            mandateIds: Object.keys(state.mandates).sort(),
            tickets: Object.values(state.tickets).map((ticket) => ({
                actionId: ticket.actionId,
                mandateId: ticket.mandateId,
                commitment: projectCommit(
                    state.mandates[ticket.mandateId],
                    ticket.context,
                    {salt: ticket.salt, commitBond: this.commitBond}
                ).commitment,
                lifecycle: ticket.lifecycle,
                commitTransactionHash:
                    state.signedTransactions[`${ticket.actionId}:commit`]?.transactionHash ?? null,
                revealTransactionHash:
                    state.signedTransactions[`${ticket.actionId}:reveal`]?.transactionHash ?? null,
            })),
        };
    }

    async action(passphrase, actionId) {
        if (typeof actionId !== "string" || !ACTION_ID.test(actionId)) {
            throw new SignerError("ACTION_ID_INVALID", "action identifier is invalid");
        }
        const state = await this.store.read(passphrase);
        const ticket = state.tickets[actionId];
        if (ticket === undefined) {
            throw new SignerError("TICKET_MISSING", "action has no persisted ticket");
        }
        const mandate = state.mandates[ticket.mandateId];
        const commitment = projectCommit(mandate, ticket.context, {
            salt: ticket.salt,
            commitBond: this.commitBond,
        }).commitment;
        return {
            schemaVersion: "lattice.agent.persisted-action.v1",
            actionId,
            mandateId: ticket.mandateId,
            mandate: structuredClone(mandate),
            context: structuredClone(ticket.context),
            commitment,
            lifecycle: ticket.lifecycle,
            transactions: Object.fromEntries(
                ["commit", "reveal", "cancel", "expire", "withdraw"]
                    .map((stage) => [stage, state.signedTransactions[`${actionId}:${stage}`] ?? null])
            ),
        };
    }

    async activateMandate(passphrase, mandateValue) {
        const mandate = validateMandate(mandateValue);
        if (
            mandate.ticket.permittedMethods.includes("cancel") &&
            BigInt(mandate.limits.cancellationBudget) < BigInt(this.cancelFee)
        ) {
            throw new SignerError(
                "CANCELLATION_BUDGET",
                "mandate cancellation budget is below the pinned protocol fee"
            );
        }
        const weibarPerTinybar = 10_000_000_000n;
        const maximumFeePerTransaction =
            (this.fees.gasLimit * this.fees.maxFeePerGas + weibarPerTinybar - 1n) /
            weibarPerTinybar;
        const methods = new Set(mandate.ticket.permittedMethods);
        const commonTransactions =
            Number(methods.has("commit")) + Number(methods.has("withdraw"));
        const cancellationTransactions =
            commonTransactions + Number(methods.has("cancel"));
        const revealedTransactions =
            commonTransactions + Number(methods.has("reveal")) + Number(methods.has("expire"));
        const requiredFeeReserve =
            maximumFeePerTransaction * BigInt(Math.max(cancellationTransactions, revealedTransactions));
        if (BigInt(mandate.limits.feeReserve) < requiredFeeReserve) {
            throw new SignerError(
                "FEE_RESERVE_INSUFFICIENT",
                "mandate fee reserve is below the configured transaction fee ceiling"
            );
        }
        const id = mandateId(mandate);
        const state = await this.store.transact(passphrase, "activate-mandate", (current) => {
            const existing = current.mandates[id];
            if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(mandate)) {
                throw new SignerError("MANDATE_CONFLICT", "mandate identifier already names different content");
            }
            current.mandates[id] = mandate;
            if (current.authority[id] === undefined) {
                current.authority[id] = createAuthorityState(mandate);
            }
        });
        return {mandateId: id, authority: structuredClone(state.authority[id])};
    }

    async reserveEvaluation(passphrase, mandateValue, context) {
        const mandate = validateMandate(mandateValue);
        const id = mandateId(mandate);
        const state = await this.store.transact(passphrase, "reserve-evaluation", (current) => {
            if (current.mandates[id] === undefined || current.authority[id] === undefined) {
                throw new SignerError("MANDATE_INACTIVE", "mandate is not active in the signer");
            }
            current.authority[id] = reservePolicyEvaluation(mandate, current.authority[id], context);
        });
        return structuredClone(state.authority[id]);
    }

    async pauseMandate(passphrase, request) {
        if (
            request === null ||
            typeof request !== "object" ||
            Array.isArray(request) ||
            Object.keys(request).sort().join(",") !== "mandateId,paused" ||
            typeof request.mandateId !== "string" ||
            !ACTION_ID.test(request.mandateId) ||
            typeof request.paused !== "boolean"
        ) {
            throw new SignerError("PAUSE_REQUEST_INVALID", "pause request is invalid");
        }
        const state = await this.store.transact(passphrase, "set-mandate-pause", (current) => {
            const mandate = current.mandates[request.mandateId];
            const authority = current.authority[request.mandateId];
            if (mandate === undefined || authority === undefined) {
                throw new SignerError("MANDATE_INACTIVE", "mandate is not active in the signer");
            }
            if (!request.paused && mandate.control.paused) {
                throw new SignerError(
                    "MANDATE_PAUSED",
                    "a mandate activated as paused cannot be unpaused without new authorization"
                );
            }
            current.authority[request.mandateId] = setAuthorityPaused(
                mandate,
                authority,
                request.paused
            );
        });
        return {
            mandateId: request.mandateId,
            paused: state.authority[request.mandateId].paused,
            outstandingActionsContinue:
                state.mandates[request.mandateId].control.completeOutstandingObligations,
        };
    }

    async prepareCommit(passphrase, mandate, context, request) {
        const parsedRequest = commitRequest(request);
        const requestedNonce = parsedRequest.nonce;
        if (parsedRequest.approval?.commitBond !== this.commitBond) {
            throw new SignerError("BOND_MISMATCH", "verified approval does not name the configured commit bond");
        }
        const actionId = contextId(context);
        const existingState = await this.store.read(passphrase);
        const existingSigned = existingState.signedTransactions[`${actionId}:commit`];
        if (existingSigned !== undefined) {
            if (existingSigned.nonce !== requestedNonce) {
                throw new SignerError("NONCE_CHANGE_REFUSED", "commit retry must use the reserved account nonce");
            }
            return structuredClone(existingSigned);
        }
        const id = mandateId(mandate);
        const state = await this.store.transact(passphrase, "save-commit-ticket", (current) => {
            assertNonceAvailable(current, requestedNonce, actionId, "commitNonce");
            let ticket = current.tickets[actionId];
            if (ticket === undefined) {
                if (current.mandates[id] === undefined || current.authority[id] === undefined) {
                    throw new SignerError("MANDATE_INACTIVE", "mandate is not active in the signer");
                }
                current.authority[id] = reserveApprovedBuy(
                    mandate,
                    current.authority[id],
                    context,
                    parsedRequest.approval
                );
                ticket = {
                    schemaVersion: "lattice.agent.ticket.v1",
                    actionId,
                    mandateId: id,
                    context,
                    salt: hexlify(randomBytes(32)),
                    commitNonce: requestedNonce,
                    revealNonce: null,
                    cancelNonce: null,
                    cancelFeeReserved: false,
                    expireNonce: null,
                    withdrawNonce: null,
                    lifecycle: "TICKET_SAVED",
                };
                current.tickets[actionId] = ticket;
            } else if (ticket.commitNonce !== requestedNonce) {
                throw new SignerError("NONCE_CHANGE_REFUSED", "commit retry must use the reserved account nonce");
            }
        });
        const ticket = state.tickets[actionId];
        const projection = projectCommit(mandate, context, {
            salt: ticket.salt,
            commitBond: this.commitBond,
        });
        return this.#signAndPersist(passphrase, actionId, "commit", requestedNonce, projection);
    }

    async prepareReveal(passphrase, mandate, context, request) {
        const requestedNonce = requestNonce(request);
        const actionId = contextId(context);
        const state = await this.store.transact(passphrase, "reserve-reveal-nonce", (current) => {
            const ticket = current.tickets[actionId];
            if (ticket === undefined) {
                throw new SignerError("TICKET_MISSING", "cannot reveal without the persisted commit ticket");
            }
            if (current.signedTransactions[`${actionId}:commit`] === undefined) {
                throw new SignerError("COMMIT_UNSIGNED", "cannot reveal before the commit transaction is persisted");
            }
            assertNonceAvailable(current, requestedNonce, actionId, "revealNonce");
            if (ticket.revealNonce === null) ticket.revealNonce = requestedNonce;
            if (ticket.revealNonce !== requestedNonce) {
                throw new SignerError("NONCE_CHANGE_REFUSED", "reveal retry must use the reserved account nonce");
            }
            ticket.lifecycle = "REVEAL_PENDING";
        });
        const projection = projectReveal(mandate, context, {salt: state.tickets[actionId].salt});
        return this.#signAndPersist(passphrase, actionId, "reveal", requestedNonce, projection);
    }

    async prepareOutstanding(passphrase, request) {
        const parsed = outstandingRequest(request);
        const state = await this.store.read(passphrase);
        const ticket = state.tickets[parsed.actionId];
        if (ticket === undefined) {
            throw new SignerError("TICKET_MISSING", "cannot continue an action without its persisted ticket");
        }
        const mandate = state.mandates[ticket.mandateId];
        if (mandate === undefined) {
            throw new SignerError("MANDATE_INACTIVE", "persisted action has no active mandate");
        }
        if (state.signedTransactions[`${parsed.actionId}:commit`] === undefined) {
            throw new SignerError("COMMIT_UNSIGNED", "cannot continue before the commit transaction is persisted");
        }
        if (
            ["expire"].includes(parsed.stage) &&
            state.signedTransactions[`${parsed.actionId}:reveal`] === undefined
        ) {
            throw new SignerError("REVEAL_UNSIGNED", "cannot expire before the reveal transaction is persisted");
        }
        if (
            parsed.stage === "cancel" &&
            state.signedTransactions[`${parsed.actionId}:reveal`] !== undefined
        ) {
            throw new SignerError("CANCEL_AFTER_REVEAL_REFUSED", "cannot cancel after a reveal was signed");
        }
        const nonceField = `${parsed.stage}Nonce`;
        const reserved = await this.store.transact(
            passphrase,
            `reserve-${parsed.stage}-nonce`,
            (current) => {
                const currentTicket = current.tickets[parsed.actionId];
                assertNonceAvailable(current, parsed.nonce, parsed.actionId, nonceField);
                if (parsed.stage === "cancel" && currentTicket.cancelFeeReserved !== true) {
                    current.authority[currentTicket.mandateId] = reserveCancellation(
                        mandate,
                        current.authority[currentTicket.mandateId],
                        this.cancelFee
                    );
                    currentTicket.cancelFeeReserved = true;
                }
                if (currentTicket[nonceField] === null) currentTicket[nonceField] = parsed.nonce;
                if (currentTicket[nonceField] !== parsed.nonce) {
                    throw new SignerError(
                        "NONCE_CHANGE_REFUSED",
                        `${parsed.stage} retry must use the reserved account nonce`
                    );
                }
                currentTicket.lifecycle = `${parsed.stage.toUpperCase()}_PENDING`;
            }
        );
        const currentTicket = reserved.tickets[parsed.actionId];
        const projection =
            parsed.stage === "reveal"
                ? projectReveal(mandate, currentTicket.context, {salt: currentTicket.salt})
                : parsed.stage === "cancel"
                    ? projectCancel(mandate, currentTicket.context, {salt: currentTicket.salt})
                    : parsed.stage === "expire"
                        ? projectExpire(mandate, currentTicket.context, {salt: currentTicket.salt})
                        : projectWithdraw(mandate, currentTicket.context, {});
        return this.#signAndPersist(
            passphrase,
            parsed.actionId,
            parsed.stage,
            parsed.nonce,
            projection
        );
    }

    async recordBroadcast(passphrase, request) {
        if (
            request === null ||
            typeof request !== "object" ||
            Array.isArray(request) ||
            Object.keys(request).sort().join(",") !== "actionId,stage,status,transactionHash" ||
            !["commit", "reveal", "cancel", "expire", "withdraw"].includes(request.stage) ||
            !["confirmed", "reverted", "unknown"].includes(request.status) ||
            typeof request.actionId !== "string" ||
            !/^sha256:[0-9a-f]{64}$/.test(request.actionId) ||
            typeof request.transactionHash !== "string" ||
            !/^0x[0-9a-f]{64}$/.test(request.transactionHash)
        ) {
            throw new SignerError("BROADCAST_RECORD_INVALID", "broadcast record is invalid");
        }
        const state = await this.store.transact(passphrase, "record-broadcast", (current) => {
            const signed = current.signedTransactions[`${request.actionId}:${request.stage}`];
            const ticket = current.tickets[request.actionId];
            if (
                signed === undefined ||
                ticket === undefined ||
                signed.transactionHash !== request.transactionHash
            ) {
                throw new SignerError("BROADCAST_RECORD_MISMATCH", "broadcast record does not match persisted bytes");
            }
            ticket.lifecycle =
                request.status !== "confirmed"
                    ? "RECOVERY_REQUIRED"
                    : request.stage === "commit"
                        ? "SEALED"
                        : request.stage === "reveal"
                            ? "IN_AUCTION"
                            : request.stage === "cancel"
                                ? "CANCELLED"
                                : request.stage === "expire"
                                    ? "EXPIRED"
                                    : "WITHDRAWN";
        });
        return structuredClone(state.tickets[request.actionId]);
    }

    async #wallet(passphrase) {
        const state = await this.store.read(passphrase);
        const key = state.signer?.privateKey;
        if (typeof key !== "string" || !PRIVATE_KEY.test(key)) {
            throw new SignerError("ACCOUNT_MISSING", "the dedicated signer account is not initialized");
        }
        return new Wallet(key);
    }

    async #signAndPersist(passphrase, actionId, stage, requestedNonce, projection) {
        const recordId = `${actionId}:${stage}`;
        const before = await this.store.read(passphrase);
        const existing = before.signedTransactions[recordId];
        if (existing !== undefined) {
            return structuredClone(existing);
        }
        const wallet = await this.#wallet(passphrase);
        if (getAddress(wallet.address) !== getAddress(projection.from)) {
            throw new SignerError("ACCOUNT_MISMATCH", "mandate execution account is not the signer account");
        }
        const unsigned = {
            type: 2,
            chainId: BigInt(projection.chainId),
            nonce: requestedNonce,
            to: projection.to,
            data: projection.data,
            value: BigInt(projection.valueWeibar),
            gasLimit: this.fees.gasLimit,
            maxFeePerGas: this.fees.maxFeePerGas,
            maxPriorityFeePerGas: this.fees.maxPriorityFeePerGas,
        };
        const signedTransaction = await wallet.signTransaction(unsigned);
        const decoded = Transaction.from(signedTransaction);
        try {
            assertTransactionMatchesProjection(decoded, projection);
        } catch (error) {
            if (error instanceof ProjectionError) {
                throw new SignerError("SIGNED_TRANSACTION_REFUSED", "signed transaction failed exact projection");
            }
            throw error;
        }
        if (
            decoded.type !== 2 ||
            decoded.nonce !== requestedNonce ||
            decoded.gasLimit !== this.fees.gasLimit ||
            decoded.maxFeePerGas !== this.fees.maxFeePerGas ||
            decoded.maxPriorityFeePerGas !== this.fees.maxPriorityFeePerGas
        ) {
            throw new SignerError(
                "SIGNED_TRANSACTION_REFUSED",
                "signed transaction differs from the configured nonce or fee envelope"
            );
        }
        const record = {
            schemaVersion: "lattice.agent.signed-transaction.v1",
            actionId,
            stage,
            nonce: requestedNonce,
            transactionHash: decoded.hash,
            signedTransaction,
            projection,
        };
        const saved = await this.store.transact(passphrase, `persist-${stage}`, (state) => {
            const already = state.signedTransactions[recordId];
            if (already !== undefined && already.signedTransaction !== signedTransaction) {
                throw new SignerError("SIGNED_TRANSACTION_CONFLICT", "a different signed transaction already exists");
            }
            state.signedTransactions[recordId] = record;
            state.tickets[actionId].lifecycle = `${stage.toUpperCase()}_PENDING`;
        });
        return structuredClone(saved.signedTransactions[recordId]);
    }
}
