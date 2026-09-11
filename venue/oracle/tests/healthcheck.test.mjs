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
