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
        lastEvidenceHash: null,
        lastConfirmedRound: null,
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

    prepared(record) {
        if (this.state.pending) throw new Error("cannot prepare while a transaction is pending");
        this.state.pending = {
            status: "PREPARED",
            preparedAt: new Date().toISOString(),
            ...record,
        };
        this.save();
        this.event("prepared", {
            purpose: record.purpose,
            round: record.round,
            txHash: record.txHash,
        });
    }

    evidenced(receipt, evidenceHash) {
        if (this.state.pending?.status !== "PREPARED") {
            throw new Error("only a prepared transaction can receive evidence");
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

    statusEvidenced(receipt, hash, code, observedAt) {
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
        this.save();
        this.event("status-evidenced", {
            code,
            topicId: receipt.topicId,
            sequenceNumber: receipt.sequenceNumber,
            evidenceHash: hash,
        });
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
        this.state.lastConfirmedRound = round;
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
}
