import {Interface, getAddress} from "ethers";
import {commitmentOf, SIDE} from "../../tools/commitment.mjs";
import {buyEscrow, toWeibar} from "../../tools/units.mjs";
import {
    assertContextAuthorized,
    assertOutstandingAuthorized,
    MandateError,
} from "./mandate.mjs";

const ABI = [
    "function commit(bytes32 id) payable",
    "function reveal(uint8 side,uint128 price,uint128 qty,bytes32 salt,uint256 backing) payable",
    "function cancel(bytes32 id)",
    "function expire(bytes32 id)",
    "function withdraw()",
];

const iface = new Interface(ABI);
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

export class ProjectionError extends TypeError {
    constructor(code, message) {
        super(message);
        this.name = "ProjectionError";
        this.code = code;
    }
}

function salt(value) {
    if (typeof value !== "string" || !BYTES32.test(value)) {
        throw new ProjectionError("INVALID_SALT", "salt must be a 32-byte 0x-prefixed hex string");
    }
    return value.toLowerCase();
}

function decimal(value, name) {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new ProjectionError("INVALID_DECIMAL", `${name} must be a canonical decimal string`);
    }
    return BigInt(value);
}

function baseProjection(mandate, context, method, data, valueTinybar) {
    return {
        schemaVersion: "lattice.agent.transaction-projection.v1",
        chainId: context.chainId,
        from: context.executionAccount,
        to: mandate.ticket.engine,
        method,
        data,
        valueTinybar: valueTinybar.toString(),
        valueWeibar: toWeibar(valueTinybar).toString(),
    };
}

export function projectCommit(mandateValue, contextValue, request) {
    const {mandate, context} = assertContextAuthorized(mandateValue, contextValue);
    if (
        request === null ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        Object.keys(request).sort().join(",") !== "commitBond,salt"
    ) {
        throw new ProjectionError("INVALID_COMMIT_REQUEST", "commit request has an unknown or missing field");
    }
    const commitSalt = salt(request.salt);
    const commitBond = decimal(request.commitBond, "commitBond");
    if (commitBond > BigInt(mandate.limits.bondBudget)) {
        throw new ProjectionError("BOND_BUDGET", "commit bond exceeds the mandate budget");
    }
    const id = commitmentOf(
        context.executionAccount,
        SIDE.BUY,
        BigInt(context.price),
        BigInt(context.quantity),
        commitSalt
    );
    return {
        ...baseProjection(mandate, context, "commit", iface.encodeFunctionData("commit", [id]), commitBond),
        commitment: id,
    };
}

export function projectReveal(mandateValue, contextValue, request) {
    const {mandate, context} = assertOutstandingAuthorized(mandateValue, contextValue);
    if (
        request === null ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        Object.keys(request).sort().join(",") !== "salt"
    ) {
        throw new ProjectionError("INVALID_REVEAL_REQUEST", "reveal request has an unknown or missing field");
    }
    const revealSalt = salt(request.salt);
    const escrow = buyEscrow(BigInt(context.price), BigInt(context.quantity));
    return {
        ...baseProjection(
            mandate,
            context,
            "reveal",
            iface.encodeFunctionData("reveal", [
                SIDE.BUY,
                BigInt(context.price),
                BigInt(context.quantity),
                revealSalt,
                0n,
            ]),
            escrow
        ),
        commitment: commitmentOf(
            context.executionAccount,
            SIDE.BUY,
            BigInt(context.price),
            BigInt(context.quantity),
            revealSalt
        ),
    };
}

function projectCommitmentAction(mandateValue, contextValue, request, method) {
    const {mandate, context} = assertOutstandingAuthorized(mandateValue, contextValue);
    if (
        request === null ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        Object.keys(request).sort().join(",") !== "salt"
    ) {
        throw new ProjectionError(
            "INVALID_RECOVERY_REQUEST",
            `${method} request permits only the persisted salt`
        );
    }
    const persistedSalt = salt(request.salt);
    const commitment = commitmentOf(
        context.executionAccount,
        SIDE.BUY,
        BigInt(context.price),
        BigInt(context.quantity),
        persistedSalt
    );
    return {
        ...baseProjection(
            mandate,
            context,
            method,
            iface.encodeFunctionData(method, [commitment]),
            0n
        ),
        commitment,
    };
}

export function projectCancel(mandateValue, contextValue, request) {
    return projectCommitmentAction(mandateValue, contextValue, request, "cancel");
}

export function projectExpire(mandateValue, contextValue, request) {
    return projectCommitmentAction(mandateValue, contextValue, request, "expire");
}

export function projectWithdraw(mandateValue, contextValue, request) {
    const {mandate, context} = assertOutstandingAuthorized(mandateValue, contextValue);
    if (
        request === null ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        Object.keys(request).length !== 0
    ) {
        throw new ProjectionError("INVALID_WITHDRAW_REQUEST", "withdraw request must be empty");
    }
    return baseProjection(
        mandate,
        context,
        "withdraw",
        iface.encodeFunctionData("withdraw"),
        0n
    );
}

export function assertTransactionMatchesProjection(transaction, projection) {
    if (transaction === null || typeof transaction !== "object" || Array.isArray(transaction)) {
        throw new ProjectionError("INVALID_TRANSACTION", "decoded transaction must be an object");
    }
    let comparisons;
    try {
        comparisons = [
            [BigInt(transaction.chainId ?? -1).toString(), projection.chainId, "chainId"],
            [getAddress(transaction.from), getAddress(projection.from), "from"],
            [getAddress(transaction.to), getAddress(projection.to), "to"],
            [String(transaction.data).toLowerCase(), projection.data.toLowerCase(), "data"],
            [BigInt(transaction.value ?? -1).toString(), projection.valueWeibar, "value"],
        ];
    } catch {
        throw new ProjectionError("INVALID_TRANSACTION", "decoded transaction fields are malformed");
    }
    for (const [got, want, field] of comparisons) {
        if (got !== want) {
            throw new ProjectionError("TRANSACTION_MISMATCH", `transaction ${field} differs from the projection`);
        }
    }
    let parsed;
    try {
        parsed = iface.parseTransaction({data: transaction.data, value: transaction.value});
    } catch {
        throw new ProjectionError("INVALID_TRANSACTION", "transaction calldata cannot be decoded");
    }
    if (parsed === null || parsed.name !== projection.method) {
        throw new ProjectionError("METHOD_MISMATCH", "transaction method differs from the projection");
    }
    return true;
}

export function projectionForApproval(mandateValue, contextValue, stage, request) {
    try {
        if (stage === "commit") return projectCommit(mandateValue, contextValue, request);
        if (stage === "reveal") return projectReveal(mandateValue, contextValue, request);
        if (stage === "cancel") return projectCancel(mandateValue, contextValue, request);
        if (stage === "expire") return projectExpire(mandateValue, contextValue, request);
        if (stage === "withdraw") return projectWithdraw(mandateValue, contextValue, request);
    } catch (error) {
        if (error instanceof MandateError || error instanceof ProjectionError) throw error;
        throw new ProjectionError("PROJECTION_FAILED", "transaction projection failed");
    }
    throw new ProjectionError("UNSUPPORTED_STAGE", `unsupported transaction stage ${stage}`);
}
