#!/usr/bin/env node
import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {Transaction} from "ethers";

import {projectCommit, projectReveal, assertTransactionMatchesProjection} from "./runtime/transaction-projector.mjs";
import {EzklVerifier} from "./runtime/verifier.mjs";

const AGENT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED_KEYS = [
    "schemaVersion",
    "stage",
    "mandate",
    "context",
    "proof",
    "salt",
    "commitBondTinybar",
    "signedTransaction",
];

export class ReceiptVerificationError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "ReceiptVerificationError";
        this.code = code;
    }
}

function requireBundle(value) {
    if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== [...EXPECTED_KEYS].sort().join(",") ||
        value.schemaVersion !== "lattice.agent.post-reveal-bundle.v1" ||
        !["commit", "reveal"].includes(value.stage)
    ) {
        throw new ReceiptVerificationError("BUNDLE_SCHEMA", "receipt bundle has an unknown or missing field");
    }
}

export async function verifyReceiptBundle(value, verifier) {
    requireBundle(value);
    const inference = await verifier.verify({proof: value.proof, context: value.context});
    const projection =
        value.stage === "commit"
            ? projectCommit(value.mandate, value.context, {
                salt: value.salt,
                commitBond: value.commitBondTinybar,
            })
            : projectReveal(value.mandate, value.context, {salt: value.salt});
    const transaction = Transaction.from(value.signedTransaction);
    assertTransactionMatchesProjection(transaction, projection);
    return {
        schemaVersion: "lattice.agent.receipt-verification.v1",
        inference: {
            status: "verified",
            decision: inference.decision,
            modelHash: inference.modelHash,
            expectedContextMatched: true,
        },
        transaction: {
            status: "checked locally",
            transactionHash: transaction.hash,
            stage: value.stage,
            exactProjectionMatched: true,
            commitmentMatched: projection.commitment,
        },
        runtime: {
            status: "not checked",
        },
        scope: [
            "Inference validity under the pinned local verification bundle.",
            "Exact correspondence of the decoded signed transaction to the permitted projection.",
            "No claim about other processes or host-wide network activity.",
        ],
    };
}

async function main() {
    const inputPath = process.argv[2];
    if (typeof inputPath !== "string") {
        throw new ReceiptVerificationError("USAGE", "usage: node agent/verify-receipt.mjs BUNDLE.json");
    }
    const absolute = path.resolve(inputPath);
    const contents = await readFile(absolute);
    if (contents.length > 1024 * 1024) {
        throw new ReceiptVerificationError("BUNDLE_TOO_LARGE", "receipt bundle exceeds one mebibyte");
    }
    const verifier = new EzklVerifier({
        bundleDir: path.join(AGENT_ROOT, "artifacts/proof"),
        pythonPath: path.join(path.dirname(AGENT_ROOT), ".venv/bin/python"),
    });
    const result = await verifyReceiptBundle(JSON.parse(contents.toString("utf8")), verifier);
    console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(JSON.stringify({
            ok: false,
            error: {
                code: typeof error?.code === "string" ? error.code : "RECEIPT_REFUSED",
                message: typeof error?.message === "string" ? error.message : "receipt verification failed",
            },
        }));
        process.exitCode = 1;
    });
}
