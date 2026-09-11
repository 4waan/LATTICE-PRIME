import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {Wallet} from "ethers";
import {PublisherJournal} from "../lib/journal.mjs";
import {
    attachPublisherShutdown,
    startPublisherHealthServer,
} from "../publisher.mjs";
import {publisherHealth} from "../healthcheck.mjs";

const here = dirname(fileURLToPath(import.meta.url));

if (process.env.ORACLE_SHUTDOWN_PROBE) {
    const shutdown = attachPublisherShutdown();
    process.stdout.write("ready\n");
    await shutdown.wait(60_000);
    process.exit(shutdown.isStopping() ? 0 : 2);
}

test("health HTTP returns 200 while advancing and 503 when stalled", async () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-health-http-"));
    try {
        writeFileSync(join(root, "journal.json"), JSON.stringify({
            updatedAt: new Date().toISOString(),
            lastConfirmedRound: 4,
            pending: null,
        }));
        const env = {
            ORACLE_PUBLISHER_ID: "publisher-a",
            ORACLE_STATE_ROOT: root,
            ORACLE_HEALTH_MAX_AGE_SECONDS: "120",
            PORT: "0",
        };
        const config = {pollSeconds: 15};
        const server = startPublisherHealthServer({
            config,
            env,
            identity: {profile: "publisher-a"},
        });
        if (!server.listening) await once(server, "listening");
        const port = server.address().port;
        try {
            const ok = await fetch(`http://127.0.0.1:${port}/healthz`);
            assert.equal(ok.status, 200);
            const body = await ok.json();
            assert.equal(body.status, "ok");
            assert.equal(body.publisher, "publisher-a");
            assert.equal(body.lastConfirmedRound, 4);
            assert.equal(body.pending, null);
            assert.equal(body.config, undefined);
            assert.equal(body.rpcUrl, undefined);

            writeFileSync(join(root, "journal.json"), JSON.stringify({
                updatedAt: "2020-01-01T00:00:00Z",
                pending: null,
            }));
            const stalled = await fetch(`http://127.0.0.1:${port}/healthz`);
            assert.equal(stalled.status, 503);
            const stalledBody = await stalled.json();
            assert.equal(stalledBody.status, "stalled");
            const missing = await fetch(`http://127.0.0.1:${port}/readyz`);
            assert.equal(missing.status, 404);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
        assert.equal(publisherHealth({config, env}).ok, false);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("prepared journal survives reopen without a second broadcast record", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-journal-reopen-"));
    const wallet = new Wallet("0x" + "31".repeat(32));
    try {
        const first = PublisherJournal.open(root, "publisher-a", wallet.address);
        first.prepared({
            chainId: 296,
            oracle: "0x4fdFf36036e13eFA7D1fB07408cE69F546c082b8",
            publisher: wallet.address,
            topicId: "0.0.1",
            evidenceMessage: "{}",
            evidenceHash: "0x" + "11".repeat(32),
            txHash: "0x" + "22".repeat(32),
            signedTransaction: "0xabc",
            to: "0x4fdFf36036e13eFA7D1fB07408cE69F546c082b8",
            round: 5,
            cleanPriceUsd8: "10000000000",
            referenceRateBps: "364",
            sourceDigest: "0x" + "33".repeat(32),
            observedAt: 1_800_000_000,
            expiresAt: 1_800_000_600,
        });
        const reopened = PublisherJournal.open(root, "publisher-a", wallet.address);
        assert.equal(reopened.state.pending.status, "PREPARED");
        assert.equal(reopened.state.pending.txHash, "0x" + "22".repeat(32));
        assert.equal(reopened.state.counters.broadcasts, 0);
        reopened.evidenced({topicId: "0.0.1", sequenceNumber: 3}, "0x" + "11".repeat(32));
        reopened.broadcast();
        assert.equal(reopened.state.counters.broadcasts, 1);
        const again = PublisherJournal.open(root, "publisher-a", wallet.address);
        assert.equal(again.state.pending.status, "BROADCAST");
        assert.equal(again.state.counters.broadcasts, 1);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test("both termination signals exit the publisher wait within 10 seconds", async () => {
    for (const signal of ["SIGTERM", "SIGINT"]) {
        const started = Date.now();
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
            cwd: here,
            env: {
                ...process.env,
                ORACLE_SHUTDOWN_PROBE: signal,
            },
            stdio: ["ignore", "pipe", "ignore"],
        });
        await new Promise((resolve, reject) => {
            child.stdout.on("data", (chunk) => {
                if (String(chunk).includes("ready")) resolve();
            });
            child.once("exit", () => reject(new Error(`${signal} probe exited before ready`)));
            setTimeout(() => reject(new Error(`${signal} probe did not become ready`)), 5_000);
        });
        child.kill(signal);
        const code = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                reject(new Error(`${signal} did not exit in time`));
            }, 9_000);
            child.once("exit", (exitCode) => {
                clearTimeout(timer);
                resolve(exitCode);
            });
            child.once("error", reject);
        });
        assert.equal(code, 0, signal);
        assert.ok(Date.now() - started < 10_000, signal);
    }
});
