import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
    healthMaximumAgeSeconds,
    publisherHealth,
} from "../healthcheck.mjs";

test("health age always covers two configured publisher polls", () => {
    assert.equal(
        healthMaximumAgeSeconds(
            {pollSeconds: 300},
            {ORACLE_HEALTH_MAX_AGE_SECONDS: "120"},
        ),
        600,
    );
    assert.equal(
        healthMaximumAgeSeconds(
            {pollSeconds: 300},
            {ORACLE_HEALTH_MAX_AGE_SECONDS: "900"},
        ),
        900,
    );
});

test("a five minute publisher remains healthy at the old two minute threshold", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-health-"));
    try {
        const now = Date.parse("2027-01-01T00:05:00Z");
        writeFileSync(
            join(root, "journal.json"),
            JSON.stringify({
                updatedAt: "2027-01-01T00:00:00Z",
                pending: null,
            }),
        );
        const result = publisherHealth({
            config: {pollSeconds: 300},
            env: {
                ORACLE_PUBLISHER_ID: "publisher-a",
                ORACLE_STATE_ROOT: root,
                ORACLE_HEALTH_MAX_AGE_SECONDS: "120",
            },
            now,
        });
        assert.equal(result.ok, true);
        assert.equal(result.status, "ok");
        assert.equal(result.message, "publisher process is advancing");
        assert.equal(result.publisher, "publisher-a");
        assert.equal(result.lastLoopAt, "2027-01-01T00:00:00Z");
        assert.equal(result.pending, null);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("health is stalled when the journal stops and overdue when a prepare is stuck", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-health-stuck-"));
    try {
        writeFileSync(
            join(root, "journal.json"),
            JSON.stringify({
                updatedAt: "2027-01-01T00:00:00Z",
                lastConfirmedRound: 4,
                pending: {
                    status: "PREPARED",
                    preparedAt: "2026-12-31T23:40:00Z",
                },
            }),
        );
        const env = {
            ORACLE_PUBLISHER_ID: "publisher-a",
            ORACLE_STATE_ROOT: root,
            ORACLE_HEALTH_MAX_AGE_SECONDS: "900",
        };
        const overdue = publisherHealth({
            config: {pollSeconds: 300, evidence: {maximumBroadcastDelaySeconds: 600}},
            env,
            now: Date.parse("2027-01-01T00:00:00Z"),
        });
        assert.equal(overdue.ok, false);
        assert.equal(overdue.status, "recovery-overdue");
        assert.deepEqual(overdue.pending, {kind: "answer", status: "PREPARED"});
        assert.equal(overdue.lastConfirmedRound, 4);

        writeFileSync(
            join(root, "journal.json"),
            JSON.stringify({
                updatedAt: "2026-12-31T23:00:00Z",
                pending: null,
            }),
        );
        const stalled = publisherHealth({
            config: {pollSeconds: 300},
            env,
            now: Date.parse("2027-01-01T00:00:00Z"),
        });
        assert.equal(stalled.ok, false);
        assert.equal(stalled.status, "stalled");
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("dead-end pending records fail health even while the journal keeps advancing", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-health-dead-end-"));
    try {
        const env = {
            ORACLE_PUBLISHER_ID: "publisher-a",
            ORACLE_STATE_ROOT: root,
            ORACLE_HEALTH_MAX_AGE_SECONDS: "120",
        };
        const now = Date.parse("2027-01-01T00:01:00Z");
        const expectations = [
            ["pending", "EXPIRED", "publisher holds an expired answer it will not rebroadcast"],
            ["pending", "HCS_EXPIRED", "publisher holds expired HCS evidence with an unknown chain position"],
            ["pending", "BLOCKED", "publisher has a blocked pending record"],
            ["pending", "FAILED", "publisher has a terminal transaction failure"],
            ["pendingStatus", "BLOCKED", "publisher has a blocked pending record"],
        ];
        for (const [field, status, message] of expectations) {
            writeFileSync(
                join(root, "journal.json"),
                JSON.stringify({
                    updatedAt: "2027-01-01T00:00:30Z",
                    lastConfirmedRound: 7,
                    pending: null,
                    pendingStatus: null,
                    [field]: {status, preparedAt: "2027-01-01T00:00:00Z"},
                }),
            );
            const result = publisherHealth({config: {pollSeconds: 300}, env, now});
            assert.equal(result.ok, false, `${field} ${status} must not be healthy`);
            assert.equal(result.status, "dead-end");
            assert.equal(result.message, message);
            assert.deepEqual(result.pending, {
                kind: field === "pending" ? "answer" : "status",
                status,
            });
        }
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("exhausted HCS attempts fail health for answers and status heartbeats", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-health-exhausted-"));
    try {
        const env = {
            ORACLE_PUBLISHER_ID: "publisher-a",
            ORACLE_STATE_ROOT: root,
            ORACLE_HEALTH_MAX_AGE_SECONDS: "120",
        };
        const now = Date.parse("2027-01-01T00:01:00Z");
        const config = {pollSeconds: 300, evidence: {maximumEvidenceAttempts: 2}};
        writeFileSync(
            join(root, "journal.json"),
            JSON.stringify({
                updatedAt: "2027-01-01T00:00:30Z",
                pending: null,
                pendingStatus: {
                    status: "EVIDENCE_PENDING",
                    evidenceAttempts: 2,
                    preparedAt: "2027-01-01T00:00:00Z",
                },
            }),
        );
        const status = publisherHealth({config, env, now});
        assert.equal(status.ok, false);
        assert.equal(status.status, "recovery-exhausted");
        assert.equal(status.message, "status evidence exhausted its HCS attempts without a receipt");
        assert.deepEqual(status.pending, {kind: "status", status: "EVIDENCE_PENDING"});

        writeFileSync(
            join(root, "journal.json"),
            JSON.stringify({
                updatedAt: "2027-01-01T00:00:30Z",
                pending: {
                    status: "EVIDENCE_PENDING",
                    evidenceAttempts: 2,
                    preparedAt: "2027-01-01T00:00:50Z",
                },
                pendingStatus: null,
            }),
        );
        const answer = publisherHealth({config, env, now});
        assert.equal(answer.ok, false);
        assert.equal(answer.status, "recovery-exhausted");
        assert.equal(answer.message, "answer evidence exhausted its HCS attempts without a receipt");

        writeFileSync(
            join(root, "journal.json"),
            JSON.stringify({
                updatedAt: "2027-01-01T00:00:30Z",
                pending: null,
                pendingStatus: {
                    status: "EVIDENCE_PENDING",
                    evidenceAttempts: 1,
                    preparedAt: "2027-01-01T00:00:50Z",
                },
            }),
        );
        const retrying = publisherHealth({config, env, now});
        assert.equal(retrying.ok, true);
        assert.equal(retrying.status, "ok");
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});
