#!/usr/bin/env node
import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {SanitizedReceiptStore} from "../runtime/receipt-store.mjs";
import {AgentSupervisor} from "../runtime/supervisor.mjs";

const AGENT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VENUE_ROOT = path.dirname(AGENT_ROOT);
const APP_ROOT = path.join(VENUE_ROOT, "app");
const EVIDENCE_DIR = path.join(AGENT_ROOT, "artifacts", "evidence");
const ACCOUNT = "0x0000000000000000000000000000000000000001";

async function main() {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "lattice-claw-phase3-"));
    const receiptStore = new SanitizedReceiptStore({
        directory: path.join(temporary, "receipts"),
    });
    await receiptStore.initialize();
    let schedulerStarted = false;
    const signer = {
        async call(method) {
            if (method === "initializeStore") return {initialized: true};
            if (method === "initializeAccount") return {address: ACCOUNT};
            throw new Error(`unexpected signer method ${method}`);
        },
    };
    const supervisor = new AgentSupervisor({
        signer,
        appRoot: APP_ROOT,
        receiptStore,
        runtimeFactory: async () => ({
            adapter: {lastDeploymentEvidence: {accepted: true}},
            runtime: {},
            receiptStore,
            scheduler: {
                start() {
                    schedulerStarted = true;
                },
                status() {
                    return {running: schedulerStarted};
                },
                async runOnce() {
                    return {skipped: false, actionsVisited: 0, stepsCompleted: 0, failures: []};
                },
            },
            control: {
                preview: async () => ({previewId: "local-test-preview"}),
                execute: async () => ({decision: "WAIT"}),
            },
            close: async () => {},
        }),
    });
    const checks = {};
    const launch = await supervisor.start();
    try {
        const page = await fetch(`${launch.origin}/claw/`);
        const html = await page.text();
        const policy = page.headers.get("content-security-policy");
        checks.randomLoopbackOrigin = /^http:\/\/127\.0\.0\.1:\d+$/.test(launch.origin);
        checks.noStore = page.headers.get("cache-control") === "no-store";
        checks.clawStrictPolicy =
            policy.includes("default-src 'none'") &&
            policy.includes("connect-src 'none'") &&
            policy.includes("font-src 'none'") &&
            policy.includes("form-action 'none'") &&
            /style-src 'nonce-[A-Za-z0-9+/=]+'/.test(policy) &&
            !policy.includes("unsafe-inline") &&
            !policy.includes("script-src");
        checks.clawComingSoon = html.includes(">COMING SOON<");
        checks.clawChatDisabled =
            /id="claw-prompt"[\s\S]+?readonly/.test(html) &&
            /aria-label="Send message, coming soon" disabled/.test(html);
        checks.clawReturnsToPrime =
            html.includes('href="../index.html" aria-label="Switch to Lattice Prime"');
        checks.clawHasNoPairingBootstrap =
            !html.includes("__LATTICE_AGENT_BOOTSTRAP__") &&
            !html.includes(launch.pairingToken) &&
            !/<script\b/.test(html);
        checks.clawHasNoRemoteResources =
            !/<(?:link|script|img|iframe)\b[^>]+(?:href|src)="https?:/i.test(html);
        const aliases = await Promise.all([
            fetch(`${launch.origin}/claw`),
            fetch(`${launch.origin}/claw/index.html`),
        ]);
        checks.clawStaticAliases = aliases.every((response) => response.status === 200);

        const paired = await fetch(`${launch.origin}/v1/pair`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Origin: launch.origin,
                Authorization: `Bearer ${launch.pairingToken}`,
            },
            body: "{}",
        });
        const session = await paired.json();
        checks.pairingAcceptedOnce = paired.status === 200;
        const replay = await fetch(`${launch.origin}/v1/pair`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Origin: launch.origin,
                Authorization: `Bearer ${launch.pairingToken}`,
            },
            body: "{}",
        });
        checks.pairingReplayRefused = replay.status === 401;
        const setup = await fetch(`${launch.origin}/v1/setup`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Origin: launch.origin,
                Authorization: `Bearer ${session.sessionToken}`,
                "X-CSRF-Token": session.csrfToken,
            },
            body: JSON.stringify({passphrase: "local test passphrase"}),
        });
        checks.runtimeConfiguredAfterSigner = setup.status === 200 && schedulerStarted;
        const receipts = await fetch(`${launch.origin}/v1/receipts`, {
            headers: {Authorization: `Bearer ${session.sessionToken}`},
        });
        checks.browserSafeGetWithoutOrigin = receipts.status === 200;
        const privateAction = await fetch(`${launch.origin}/v1/actions/read`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Origin: launch.origin,
                Authorization: `Bearer ${session.sessionToken}`,
                "X-CSRF-Token": session.csrfToken,
            },
            body: JSON.stringify({actionId: `sha256:${"00".repeat(32)}`}),
        });
        checks.privateSignerActionRouteAbsent = privateAction.status === 404;
        assert.equal(Object.values(checks).every(Boolean), true);
    } finally {
        await supervisor.stop();
        await rm(temporary, {recursive: true, force: true});
    }

    const [marketsSource, portfolioSource] = await Promise.all([
        readFile(path.join(VENUE_ROOT, "tools", "agent-ui.mjs"), "utf8"),
        readFile(path.join(VENUE_ROOT, "tools", "agent-receipts-ui.mjs"), "utf8"),
    ]);
    checks.browserStorageUnused =
        !/localStorage|sessionStorage/.test(`${marketsSource}\n${portfolioSource}`);
    checks.receiptRenderingAvoidsInnerHtml = !/innerHTML/.test(portfolioSource);
    assert.equal(Object.values(checks).every(Boolean), true);

    const report = {
        schemaVersion: "lattice.agent.phase3-local-evidence.v1",
        product: "Lattice Claw",
        status: "passed",
        scope:
            "Coming-soon Claw shell, direct API capability boundary, scheduler attachment, and dormant sanitized receipt read model. The page cannot send a live transaction.",
        checks,
    };
    await mkdir(EVIDENCE_DIR, {recursive: true});
    await writeFile(
        path.join(EVIDENCE_DIR, "phase3-local.json"),
        `${JSON.stringify(report, null, 2)}\n`,
        "utf8"
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
});
