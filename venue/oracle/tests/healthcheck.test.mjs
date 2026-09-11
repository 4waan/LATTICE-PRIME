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
        assert.deepEqual(result, {ok: true, message: "publisher process is advancing"});
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});
