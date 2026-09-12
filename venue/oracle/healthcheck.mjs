import {existsSync, readFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {loadOracleConfig} from "./lib/config.mjs";

const DEFAULT_MAXIMUM_AGE_SECONDS = 120;
const POLL_INTERVAL_ALLOWANCE = 2;
const DEFAULT_MAXIMUM_EVIDENCE_ATTEMPTS = 2;

// Pending records in these states never advance on their own; the publisher
// keeps polling (so the journal still looks alive) but cannot answer again
// until an operator clears them.
const DEAD_END_MESSAGES = {
    FAILED: "publisher has a terminal transaction failure",
    BLOCKED: "publisher has a blocked pending record",
    EXPIRED: "publisher holds an expired answer it will not rebroadcast",
    HCS_EXPIRED: "publisher holds expired HCS evidence with an unknown chain position",
};

function positiveSeconds(value, label) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(`${label} must be a positive number`);
    }
    return seconds;
}

export function healthMaximumAgeSeconds(config, env = process.env) {
    const configured = positiveSeconds(
        env.ORACLE_HEALTH_MAX_AGE_SECONDS ?? DEFAULT_MAXIMUM_AGE_SECONDS,
        "ORACLE_HEALTH_MAX_AGE_SECONDS",
    );
    const pollSeconds = positiveSeconds(config.pollSeconds ?? 15, "pollSeconds");
    return Math.ceil(Math.max(configured, pollSeconds * POLL_INTERVAL_ALLOWANCE));
}

function coarsePending(record, kind = "answer") {
    if (!record) return null;
    return {
        kind,
        status: record.status ?? null,
    };
}

export function publisherHealth({config, env = process.env, now = Date.now()}) {
    const profile = env.ORACLE_PUBLISHER_ID;
    const root = resolve(env.ORACLE_STATE_ROOT ?? `oracle/state/${profile ?? ""}`);
    const path = join(root, "journal.json");
    const base = {
        ok: false,
        status: "stalled",
        message: "publisher journal is missing",
        publisher: profile ?? null,
        lastLoopAt: null,
        lastConfirmedRound: null,
        pending: null,
    };
    if (!profile || !existsSync(path)) {
        return base;
    }
    let journal;
    try {
        journal = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return {...base, message: "publisher journal is unreadable"};
    }
    const pending = coarsePending(journal.pending) ??
        coarsePending(journal.pendingStatus, "status");
    const current = {
        ...base,
        lastLoopAt: journal.updatedAt ?? null,
        lastConfirmedRound: journal.lastConfirmedRound ?? null,
        pending,
    };
    const updatedAt = Date.parse(journal.updatedAt);
    const maximumAgeMs = healthMaximumAgeSeconds(config, env) * 1000;
    if (!Number.isFinite(updatedAt) || now - updatedAt > maximumAgeMs) {
        return {
            ...current,
            message: "publisher journal has stopped advancing",
        };
    }
    for (const record of [journal.pending, journal.pendingStatus]) {
        const deadEnd = DEAD_END_MESSAGES[record?.status];
        if (deadEnd) {
            return {
                ...current,
                status: "dead-end",
                message: deadEnd,
            };
        }
    }
    const maximumAttempts = Math.max(
        1,
        Number(config.evidence?.maximumEvidenceAttempts ?? DEFAULT_MAXIMUM_EVIDENCE_ATTEMPTS),
    );
    for (const [record, label] of [[journal.pending, "answer"], [journal.pendingStatus, "status"]]) {
        if (record?.status === "EVIDENCE_PENDING" &&
            Number(record.evidenceAttempts ?? 0) >= maximumAttempts) {
            return {
                ...current,
                status: "recovery-exhausted",
                message: `${label} evidence exhausted its HCS attempts without a receipt`,
            };
        }
    }
    const windowSeconds = Number(config.evidence?.maximumBroadcastDelaySeconds ?? 600);
    const started = Date.parse(journal.pending?.preparedAt);
    const inFlight = ["PREPARED", "EVIDENCE_PENDING", "EVIDENCED", "BROADCAST"]
        .includes(journal.pending?.status);
    if (inFlight && Number.isFinite(started) && now - started > windowSeconds * 1000) {
        return {
            ...current,
            status: "recovery-overdue",
            message: "prepared transaction exceeded the broadcast window",
        };
    }
    return {
        ...current,
        ok: true,
        status: "ok",
        message: "publisher process is advancing",
    };
}

function main() {
    let config;
    try {
        config = loadOracleConfig();
    } catch {
        console.error("publisher config is unreadable");
        process.exitCode = 1;
        return;
    }
    let result;
    try {
        result = publisherHealth({config});
    } catch {
        console.error("publisher health configuration is invalid");
        process.exitCode = 1;
        return;
    }
    console[result.ok ? "log" : "error"](result.message);
    if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main();
}
