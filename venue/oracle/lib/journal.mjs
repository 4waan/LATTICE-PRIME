import {
    appendFileSync,
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    writeSync,
} from "node:fs";
import {join} from "node:path";

export const JOURNAL_SCHEMA = "lattice.oracle.publisher.v1";

function json(value) {
    return JSON.stringify(value, (_, child) =>
        typeof child === "bigint" ? child.toString() : child, 1);
}

function fresh(profile, address) {
    return {
        schema: JOURNAL_SCHEMA,
        profile,
        address,
        createdAt: new Date().toISOString(),
        updatedAt: null,
        pending: null,
        pendingStatus: null,
        lastEvidenceHash: null,
        lastConfirmedRound: null,
        lastConfirmedSources: null,
        lastSourceBaseline: null,
        lastDecision: null,
        lastStatus: null,
        lastSchedulerArm: null,
        counters: {
            evidence: 0,
            broadcasts: 0,
            confirmed: 0,
            failed: 0,
            withheld: 0,
        },
    };
}

export class PublisherJournal {
    constructor(root, state) {
        this.root = root;
        this.state = state;
        this.snapshotPath = join(root, "journal.json");
        this.eventsPath = join(root, "events.jsonl");
    }

    static open(root, profile, address) {
        mkdirSync(root, {recursive: true, mode: 0o700});
        const path = join(root, "journal.json");
        const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fresh(profile, address);
        if (state.schema !== JOURNAL_SCHEMA) {
            throw new Error(`${path} has unsupported schema ${state.schema}`);
        }
        if (state.profile !== profile || state.address.toLowerCase() !== address.toLowerCase()) {
            throw new Error(`${path} belongs to another publisher identity`);
        }
        state.pendingStatus ??= null;
        state.lastConfirmedSources ??= null;
        state.lastSourceBaseline ??= state.lastConfirmedSources;
        const journal = new PublisherJournal(root, state);
        if (!existsSync(path)) journal.save();
        return journal;
    }

    save() {
        this.state.updatedAt = new Date().toISOString();
        const temporary = `${this.snapshotPath}.tmp`;
        const descriptor = openSync(temporary, "w", 0o600);
        try {
            writeSync(descriptor, json(this.state) + "\n");
            fsyncSync(descriptor);
        } finally {
            closeSync(descriptor);
        }
        renameSync(temporary, this.snapshotPath);
    }

    event(type, fields = {}) {
        const line = JSON.stringify({
            at: new Date().toISOString(),
            profile: this.state.profile,
            type,
            ...fields,
        }, (_, child) => typeof child === "bigint" ? child.toString() : child);
        appendFileSync(this.eventsPath, line + "\n", {mode: 0o600});
    }

    schedulerArm(record) {
        this.state.lastSchedulerArm = {
            at: Math.floor(Date.now() / 1000),
            ...record,
        };
        this.save();
        this.event("scheduler-arm", record);
    }

    decision(decision) {
        this.state.lastDecision = {
            at: new Date().toISOString(),
            ...decision,
        };
        if (!decision.publish) this.state.counters.withheld += 1;
        this.save();
        this.event("decision", decision);
    }

    sourceBaseline(sources) {
        if (this.state.lastSourceBaseline !== null) return;
        this.state.lastSourceBaseline = sources;
        this.save();
        this.event("source-baseline", {sources});
    }

    prepared(record) {
        if (this.state.pending) throw new Error("cannot prepare while a transaction is pending");
        if (this.state.pendingStatus) {
            throw new Error("cannot prepare while status evidence is pending");
        }
        for (const field of [
            "chainId",
            "oracle",
            "publisher",
            "topicId",
            "evidenceMessage",
            "evidenceHash",
            "txHash",
            "signedTransaction",
            "to",
            "round",
            "cleanPriceUsd8",
            "referenceRateBps",
            "sourceDigest",
            "observedAt",
            "expiresAt",
        ]) {
            if (record[field] === null || record[field] === undefined || record[field] === "") {
                throw new Error(`prepared transaction is missing ${field}`);
            }
        }
        this.state.pending = {
            status: "PREPARED",
            preparedAt: new Date().toISOString(),
            evidenceAttempts: 0,
            ...record,
        };
        this.save();
        this.event("prepared", {
            purpose: record.purpose,
            round: record.round,
            txHash: record.txHash,
        });
    }

    evidenceAttempted(at, transactionId = null) {
        if (!["PREPARED", "EVIDENCE_PENDING"].includes(this.state.pending?.status)) {
            throw new Error("only an unevidenced transaction can submit evidence");
        }
        this.state.pending.status = "EVIDENCE_PENDING";
        this.state.pending.evidenceAttempts =
            Number(this.state.pending.evidenceAttempts ?? 0) + 1;
        this.state.pending.lastEvidenceAttemptAt = Number(at);
        if (transactionId) this.state.pending.evidenceTransactionId = transactionId;
        this.save();
        this.event("evidence-attempted", {
            txHash: this.state.pending.txHash,
            evidenceHash: this.state.pending.evidenceHash,
            attempt: this.state.pending.evidenceAttempts,
            transactionId,
        });
    }

    evidenceTransactionId(transactionId) {
        if (this.state.pending?.status !== "EVIDENCE_PENDING") return;
        this.state.pending.evidenceTransactionId = transactionId;
        this.save();
    }

    evidenced(receipt, evidenceHash) {
        if (!["PREPARED", "EVIDENCE_PENDING", "HCS_EXPIRED"].includes(
            this.state.pending?.status,
        )) {
            throw new Error("only an unevidenced transaction can receive evidence");
        }
        if (this.state.pending.evidenceHash !== evidenceHash) {
            throw new Error("evidence hash does not match the prepared transaction");
        }
        if (String(receipt.topicId) !== String(this.state.pending.topicId)) {
            throw new Error("evidence receipt belongs to another topic");
        }
        this.state.pending.status = "EVIDENCED";
        this.state.pending.evidence = receipt;
        this.state.pending.evidenceHash = evidenceHash;
        this.state.lastEvidenceHash = evidenceHash;
        this.state.counters.evidence += 1;
        this.save();
        this.event("evidenced", {
            txHash: this.state.pending.txHash,
            topicId: receipt.topicId,
            sequenceNumber: receipt.sequenceNumber,
            evidenceHash,
        });
    }

    statusPrepared(record) {
        if (this.state.pendingStatus) {
            throw new Error("cannot prepare while status evidence is pending");
        }
        if (this.state.pending) {
            throw new Error("cannot prepare status while a transaction is pending");
        }
        for (const field of [
            "chainId",
            "oracle",
            "publisher",
            "topicId",
            "evidenceMessage",
            "evidenceHash",
            "round",
            "code",
            "observedAt",
        ]) {
            if (record[field] === null || record[field] === undefined || record[field] === "") {
                throw new Error(`prepared status is missing ${field}`);
            }
        }
        this.state.pendingStatus = {
            status: "PREPARED",
            preparedAt: new Date().toISOString(),
            evidenceAttempts: 0,
            ...record,
        };
        this.save();
        this.event("status-prepared", {
            code: record.code,
            evidenceHash: record.evidenceHash,
        });
    }

    statusEvidenceAttempted(at, transactionId = null) {
        if (!["PREPARED", "EVIDENCE_PENDING"].includes(
            this.state.pendingStatus?.status,
        )) {
            throw new Error("only an unevidenced status can submit evidence");
        }
        this.state.pendingStatus.status = "EVIDENCE_PENDING";
        this.state.pendingStatus.evidenceAttempts =
            Number(this.state.pendingStatus.evidenceAttempts ?? 0) + 1;
        this.state.pendingStatus.lastEvidenceAttemptAt = Number(at);
        if (transactionId) {
            this.state.pendingStatus.evidenceTransactionId = transactionId;
        }
        this.save();
        this.event("status-evidence-attempted", {
            code: this.state.pendingStatus.code,
            evidenceHash: this.state.pendingStatus.evidenceHash,
            attempt: this.state.pendingStatus.evidenceAttempts,
            transactionId,
        });
    }

    statusEvidenceTransactionId(transactionId) {
        if (this.state.pendingStatus?.status !== "EVIDENCE_PENDING") return;
        this.state.pendingStatus.evidenceTransactionId = transactionId;
        this.save();
    }

    statusEvidenced(receipt, hash, code, observedAt) {
        if (!["PREPARED", "EVIDENCE_PENDING"].includes(
            this.state.pendingStatus?.status,
        )) {
            throw new Error("no pending status can receive evidence");
        }
        if (this.state.pendingStatus.evidenceHash !== hash) {
            throw new Error("status evidence hash does not match its pending record");
        }
        if (String(receipt.topicId) !== String(this.state.pendingStatus.topicId)) {
            throw new Error("status evidence receipt belongs to another topic");
        }
        this.state.lastEvidenceHash = hash;
        this.state.lastStatus = {
            code,
            observedAt,
            publishedAt: new Date().toISOString(),
            topicId: receipt.topicId,
            sequenceNumber: receipt.sequenceNumber,
            evidenceHash: hash,
        };
        this.state.counters.evidence += 1;
        this.state.pendingStatus = null;
        this.save();
        this.event("status-evidenced", {
            code,
            topicId: receipt.topicId,
            sequenceNumber: receipt.sequenceNumber,
            evidenceHash: hash,
        });
    }

    blockPending(code, message) {
        if (!this.state.pending) return;
        this.state.pending.status = "BLOCKED";
        this.state.pending.lastError = {
            at: new Date().toISOString(),
            code,
            message,
        };
        this.state.counters.failed += 1;
        this.save();
        this.event("blocked", {
            txHash: this.state.pending.txHash,
            code,
            message,
        });
    }

    blockStatus(code, message) {
        if (!this.state.pendingStatus) return;
        this.state.pendingStatus.status = "BLOCKED";
        this.state.pendingStatus.lastError = {
            at: new Date().toISOString(),
            code,
            message,
        };
        this.state.counters.failed += 1;
        this.save();
        this.event("status-blocked", {
            evidenceHash: this.state.pendingStatus.evidenceHash,
            code,
            message,
        });
    }

    expirePendingEvidence(code, message) {
        if (this.state.pending?.status !== "EVIDENCE_PENDING" &&
            this.state.pending?.status !== "HCS_EXPIRED") {
            throw new Error("only unresolved HCS evidence can expire");
        }
        const first = this.state.pending.status !== "HCS_EXPIRED";
        this.state.pending.status = "HCS_EXPIRED";
        this.state.pending.lastError = {
            at: new Date().toISOString(),
            code,
            message,
        };
        if (first) this.state.counters.failed += 1;
        this.save();
        if (first) {
            this.event("hcs-evidence-expired", {
                txHash: this.state.pending.txHash,
                evidenceHash: this.state.pending.evidenceHash,
                code,
                message,
            });
        }
    }

    expireBroadcast(code, message) {
        if (this.state.pending?.status !== "BROADCAST" &&
            this.state.pending?.status !== "EXPIRED") {
            throw new Error("only a broadcast transaction can expire unresolved");
        }
        const first = this.state.pending.status !== "EXPIRED";
        this.state.pending.status = "EXPIRED";
        this.state.pending.lastError = {
            at: new Date().toISOString(),
            code,
            message,
        };
        if (first) this.state.counters.failed += 1;
        this.save();
        if (first) {
            this.event("broadcast-expired", {
                txHash: this.state.pending.txHash,
                code,
                message,
            });
        }
    }

    broadcast() {
        if (this.state.pending?.status !== "EVIDENCED") {
            throw new Error("transaction cannot broadcast before HCS evidence");
        }
        this.state.pending.status = "BROADCAST";
        this.state.pending.broadcastAt = new Date().toISOString();
        this.state.counters.broadcasts += 1;
        this.save();
        this.event("broadcast", {txHash: this.state.pending.txHash});
    }

    confirmed(receipt) {
        if (!this.state.pending) throw new Error("no pending transaction to confirm");
        const round = this.state.pending.round;
        const confirmedSources = this.state.pending.confirmedSources ?? null;
        this.state.lastConfirmedRound = round;
        this.state.lastConfirmedSources = confirmedSources;
        this.state.lastSourceBaseline = confirmedSources;
        this.state.counters.confirmed += 1;
        this.event("confirmed", {txHash: this.state.pending.txHash, round, receipt});
        this.state.pending = null;
        this.save();
    }

    failed(code, message, {terminal = false} = {}) {
        this.state.counters.failed += 1;
        if (this.state.pending) {
            this.state.pending.lastError = {
                at: new Date().toISOString(),
                code,
                message,
            };
            if (terminal) this.state.pending.status = "FAILED";
        }
        this.save();
        this.event("failed", {code, message, terminal});
    }

    clearFailed() {
        if (this.state.pending?.status !== "FAILED") return;
        this.event("cleared", {txHash: this.state.pending.txHash});
        this.state.pending = null;
        this.save();
    }

    abandon(code, message) {
        if (!this.state.pending) return;
        this.event("abandoned", {
            txHash: this.state.pending.txHash,
            status: this.state.pending.status,
            code,
            message,
        });
        this.state.pending = null;
        this.state.counters.failed += 1;
        this.save();
    }

    abandonStatus(code, message) {
        if (!this.state.pendingStatus) return;
        this.event("status-abandoned", {
            evidenceHash: this.state.pendingStatus.evidenceHash,
            status: this.state.pendingStatus.status,
            code,
            message,
        });
        this.state.pendingStatus = null;
        this.state.counters.failed += 1;
        this.save();
    }
}
