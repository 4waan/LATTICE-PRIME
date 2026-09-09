import {createHash} from "node:crypto";
import {Interface, getAddress} from "ethers";

import {contextId} from "./context.mjs";

const FORBIDDEN_KEYS = new Set([
    "privateKey",
    "proof",
    "salt",
    "signedTransaction",
    "witness",
]);

export class OrderReceiptError extends TypeError {
    constructor(code, message) {
        super(message);
        this.name = "OrderReceiptError";
        this.code = code;
    }
}

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

export function evidenceHash(value) {
    return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function plain(value, name) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new OrderReceiptError("RECEIPT_INPUT_INVALID", `${name} must be an object`);
    }
    return value;
}

function bytes32(value, name) {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new OrderReceiptError("RECEIPT_INPUT_INVALID", `${name} must be bytes32`);
    }
    return value.toLowerCase();
}

function transactionHash(value, name) {
    return bytes32(value, name);
}

function serialize(value) {
    if (typeof value === "bigint") return value.toString();
    if (Array.isArray(value)) return value.map(serialize);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialize(item)]));
    }
    return value;
}

function assertSanitized(value, path = "receipt") {
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertSanitized(item, `${path}[${index}]`));
        return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(key)) {
            throw new OrderReceiptError("PRIVATE_FIELD_REFUSED", `${path}.${key} is not exportable`);
        }
        assertSanitized(item, `${path}.${key}`);
    }
}

export function disclosureEvidence(transactions, engineAbi, engineAddress) {
    if (!Array.isArray(transactions)) {
        throw new OrderReceiptError("RECEIPT_INPUT_INVALID", "transactions must be an array");
    }
    const iface = new Interface(engineAbi);
    const expectedAddress = getAddress(engineAddress).toLowerCase();
    const entries = [];
    for (const transaction of transactions) {
        plain(transaction, "transaction");
        const hash = transactionHash(transaction.transactionHash, "transaction.transactionHash");
        for (const log of transaction.logs ?? []) {
            if (String(log.address ?? "").toLowerCase() !== expectedAddress) continue;
            try {
                const parsed = iface.parseLog({topics: log.topics, data: log.data});
                if (parsed === null) continue;
                entries.push({
                    transactionHash: hash,
                    logIndex: Number(log.index),
                    event: parsed.name,
                    args: serialize(parsed.args.toObject()),
                });
            } catch {
                entries.push({
                    transactionHash: hash,
                    logIndex: Number(log.index),
                    event: "UNDECODED_ENGINE_LOG",
                    args: {},
                });
            }
        }
    }
    return {
        source: "existing MatchingEngine receipt logs",
        events: entries,
        hcs: {
            submitted: false,
            reason:
                "Agent inference evidence remains a local sidecar. Existing venue disclosure records may be relayed independently.",
        },
        scope:
            "This section reports venue publication and chain events. It does not establish inference validity.",
    };
}

export function buildOrderReceipt({
    context,
    mandateId,
    commitment,
    decision,
    inference,
    worker,
    snapshot,
    transactions,
    actionState,
    roundState = null,
    venueDisclosure,
    proofHash,
}) {
    plain(context, "context");
    plain(inference, "inference");
    plain(worker, "worker");
    plain(snapshot, "snapshot");
    plain(actionState, "actionState");
    plain(venueDisclosure, "venueDisclosure");
    if (!["WAIT", "EXECUTE"].includes(decision)) {
        throw new OrderReceiptError("RECEIPT_INPUT_INVALID", "decision must be WAIT or EXECUTE");
    }
    if (typeof mandateId !== "string" || !/^sha256:[0-9a-f]{64}$/.test(mandateId)) {
        throw new OrderReceiptError("RECEIPT_INPUT_INVALID", "mandateId is invalid");
    }
    if (!Array.isArray(transactions)) {
        throw new OrderReceiptError("RECEIPT_INPUT_INVALID", "transactions must be an array");
    }
    if (typeof proofHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(proofHash)) {
        throw new OrderReceiptError("RECEIPT_INPUT_INVALID", "proofHash is invalid");
    }
    const orderIdentifier = bytes32(commitment, "commitment");
    const transactionEntries = transactions.map((entry) => ({
        stage: String(entry.stage),
        transactionHash: transactionHash(entry.transactionHash, "transactionHash"),
        status: String(entry.status),
        blockNumber: Number(entry.blockNumber),
        gasUsed: String(entry.gasUsed),
        exactProjectionMatched: entry.exactProjectionMatched === true,
    }));
    const receipt = {
        schemaVersion: "lattice.order-receipt.v1",
        orderIdentifier,
        executionSource: "local-agent",
        mandateId,
        agentDecision: {
            label: "local verified inference evidence",
            actionId: contextId(context),
            decision,
            snapshotId: context.snapshotId,
            contextHash: evidenceHash(context),
            proofHash,
            modelHash: inference.modelHash,
            settingsHash: inference.settingsHash,
            verificationKeyHash: inference.verificationKeyHash,
            expectedContextMatched: inference.expectedContextMatched === true,
            proofIncluded: false,
            claim:
                "The pinned local verifier accepted the decision and its bound context. This is not a profitability claim.",
        },
        chain: {
            label: "authoritative protocol state",
            network: "hedera-testnet",
            chainId: context.chainId,
            engine: context.engine,
            token: context.token,
            executionAccount: context.executionAccount,
            transactions: transactionEntries,
            actionState: serialize(actionState),
            roundState: roundState === null ? null : serialize(roundState),
            claim:
                "Eligibility, backing, fills, credit, balances, and retirement come from the existing deployed protocol.",
        },
        venueDisclosure: serialize(venueDisclosure),
        localRuntime: {
            label: "local runtime observation",
            worker: serialize(worker),
            snapshot: {
                blockNumber: Number(snapshot.blockNumber),
                blockHash: snapshot.blockHash,
                publicSlot: snapshot.publicSlot,
                currentRound: snapshot.currentRound,
                features: serialize(snapshot.features),
                authenticatedAgainstChain: snapshot.authenticatedAgainstChain === true,
            },
            claim:
                "Isolation fields are local observations. They are not remote attestation or a claim about every host process.",
        },
        privacy: {
            exportMode: "sanitized",
            omitted: ["proof body", "reveal salt", "signed transaction bytes", "private key", "witness"],
            hcs:
                "No private witness, proof package, reveal salt, or unrevealed ticket is included in HCS.",
        },
    };
    assertSanitized(receipt);
    return receipt;
}

export function verifyOrderReceiptShape(receipt) {
    plain(receipt, "receipt");
    if (
        receipt.schemaVersion !== "lattice.order-receipt.v1" ||
        receipt.executionSource !== "local-agent" ||
        !/^0x[0-9a-f]{64}$/.test(receipt.orderIdentifier ?? "") ||
        !/^sha256:[0-9a-f]{64}$/.test(receipt.agentDecision?.actionId ?? "") ||
        receipt.agentDecision?.proofIncluded !== false ||
        receipt.venueDisclosure?.hcs?.submitted !== false
    ) {
        throw new OrderReceiptError("RECEIPT_SHAPE_INVALID", "combined receipt shape is invalid");
    }
    for (const transaction of receipt.chain?.transactions ?? []) {
        transactionHash(transaction.transactionHash, "receipt transaction hash");
        if (transaction.exactProjectionMatched !== true) {
            throw new OrderReceiptError(
                "RECEIPT_SHAPE_INVALID",
                "combined receipt contains an unchecked transaction projection"
            );
        }
    }
    assertSanitized(receipt);
    return true;
}
