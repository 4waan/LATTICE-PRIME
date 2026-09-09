import {createHash} from "node:crypto";
import {Interface, Transaction, getAddress} from "ethers";

const ABI = [
    "function commit(bytes32 id) payable",
    "function reveal(uint8 side,uint128 price,uint128 qty,bytes32 salt,uint256 backing) payable",
    "function cancel(bytes32 id)",
    "function expire(bytes32 id)",
    "function withdraw()",
];
const iface = new Interface(ABI);

export class AdapterError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "AdapterError";
        this.code = code;
    }
}

function hash(value) {
    return `0x${createHash("sha256").update(value).digest("hex")}`;
}

export class DeterministicProtocolAdapter {
    constructor({chainId, engine, executionAccount, token, features}) {
        this.identity = {
            chainId: BigInt(chainId).toString(),
            engine: getAddress(engine).toLowerCase(),
            executionAccount: getAddress(executionAccount).toLowerCase(),
            token: getAddress(token).toLowerCase(),
        };
        this.features = structuredClone(features);
        this.transactions = new Map();
        this.commitments = new Map();
        this.creditTinybar = "0";
        this.failureMode = "none";
        this.accountNonce = 0;
    }

    setFailureMode(mode) {
        if (!["none", "timeout-before-accept", "timeout-after-accept"].includes(mode)) {
            throw new AdapterError("FAILURE_MODE_INVALID", "adapter failure mode is invalid");
        }
        this.failureMode = mode;
    }

    async preflight(request) {
        const matches =
            BigInt(request.chainId).toString() === this.identity.chainId &&
            getAddress(request.engine).toLowerCase() === this.identity.engine &&
            getAddress(request.executionAccount).toLowerCase() === this.identity.executionAccount &&
            getAddress(request.token).toLowerCase() === this.identity.token;
        return {
            schemaVersion: "lattice.agent.adapter-preflight.v1",
            adapter: "deterministic-harness",
            stage: request.stage,
            checkedAtBlock: 0,
            checkedAtTimestamp: "0",
            identityMatches: matches,
            eligible: true,
            halted: false,
            feeBalanceSufficient: true,
            liveChainChecked: false,
        };
    }

    async snapshot({publicSlot}) {
        if (typeof publicSlot !== "string" || !/^(0|[1-9][0-9]*)$/.test(publicSlot)) {
            throw new AdapterError("SLOT_INVALID", "snapshot public slot is invalid");
        }
        return {
            schemaVersion: "lattice.agent.snapshot.v1",
            adapter: "deterministic-harness",
            publicSlot,
            snapshotId: hash(`deterministic-harness:${publicSlot}:${JSON.stringify(this.features)}`),
            features: structuredClone(this.features),
            authenticatedAgainstChain: false,
        };
    }

    async nextNonce() {
        return this.accountNonce;
    }

    async accountNonces() {
        return {latest: this.accountNonce, pending: this.accountNonce};
    }

    async broadcast(record) {
        if (this.failureMode === "timeout-before-accept") {
            throw new AdapterError("BROADCAST_UNKNOWN", "deterministic timeout before acceptance");
        }
        const transaction = Transaction.from(record.signedTransaction);
        if (transaction.hash !== record.transactionHash) {
            throw new AdapterError("TRANSACTION_HASH_MISMATCH", "signed transaction hash does not match its record");
        }
        const parsed = iface.parseTransaction({data: transaction.data, value: transaction.value});
        if (
            parsed === null ||
            !["commit", "reveal", "cancel", "expire", "withdraw"].includes(parsed.name)
        ) {
            throw new AdapterError("METHOD_REFUSED", "adapter harness received an unsupported method");
        }
        const actionCommitment =
            ["reveal", "cancel", "expire"].includes(parsed.name)
                ? record.projection.commitment.toLowerCase()
                : null;
        if (actionCommitment !== null && !this.commitments.has(actionCommitment)) {
            throw new AdapterError("COMMITMENT_MISSING", `${parsed.name} has no accepted commitment`);
        }
        if (!this.transactions.has(transaction.hash)) {
            this.transactions.set(transaction.hash, {
                transactionHash: transaction.hash,
                status: "confirmed",
                method: parsed.name,
                nonce: transaction.nonce,
            });
            this.accountNonce = Math.max(this.accountNonce, transaction.nonce + 1);
            if (parsed.name === "commit") {
                this.commitments.set(parsed.args.id.toLowerCase(), {
                    sealed: true,
                    revealed: false,
                    lifecycle: "REVEALABLE",
                    context: record.projection,
                });
            } else if (parsed.name === "reveal") {
                const state = this.commitments.get(actionCommitment);
                state.revealed = true;
                state.lifecycle = "IN_AUCTION";
            } else if (parsed.name === "cancel" || parsed.name === "expire") {
                const state = this.commitments.get(actionCommitment);
                state.lifecycle = parsed.name === "cancel" ? "CANCELLED" : "RETIRED_NO_FILL";
                this.creditTinybar = "1000000";
            } else {
                this.creditTinybar = "0";
            }
        }
        if (this.failureMode === "timeout-after-accept") {
            throw new AdapterError("BROADCAST_UNKNOWN", "deterministic timeout after acceptance");
        }
        return structuredClone(this.transactions.get(transaction.hash));
    }

    async reconcile(transactionHash) {
        const record = this.transactions.get(transactionHash);
        return record === undefined
            ? {known: false, status: "unknown"}
            : {known: true, ...structuredClone(record)};
    }

    async readAction({commitment, account}) {
        if (getAddress(account).toLowerCase() !== this.identity.executionAccount) {
            throw new AdapterError("ACCOUNT_MISMATCH", "action account is not the harness account");
        }
        const state = this.commitments.get(commitment.toLowerCase());
        return {
            schemaVersion: "lattice.agent.chain-action-state.v1",
            commitment: commitment.toLowerCase(),
            lifecycle: state?.lifecycle ?? "UNKNOWN",
            creditTinybar: this.creditTinybar,
            opensAt: "0",
            closesAt: "0",
            retireAfter: "0",
            order: {
                filled: "0",
                qty: state?.context === undefined ? "0" : "1",
                lastRound: "0",
                retired: state?.lifecycle?.startsWith("RETIRED") ?? false,
            },
        };
    }
}
