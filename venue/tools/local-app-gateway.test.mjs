import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdirSync, writeFileSync} from "node:fs";
import {mkdtemp, writeFile} from "node:fs/promises";
import http from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {
    createLocalAppGateway,
    localAppGatewayConfig,
} from "./local-app-gateway.mjs";
import {
    PRIVATE_PROVING_ARTIFACT_LAYOUT,
    loadPrivateProvingArtifacts,
} from "./private-candidate-overlay.mjs";

function request(options, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
                resolve({
                    status: response.statusCode,
                    headers: response.headers,
                    body: Buffer.concat(chunks).toString("utf8"),
                });
            });
        });
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

test("gateway config defaults to 127.0.0.1:8765", () => {
    const config = localAppGatewayConfig({});
    assert.equal(config.listenHost, "127.0.0.1");
    assert.equal(config.listenPort, 8765);
    assert.equal(config.origin, "http://127.0.0.1:8765");
    assert.equal(config.originHost, "127.0.0.1:8765");
    assert.equal(config.privateUpstream, "http://127.0.0.1:8787");
});

test("gateway serves Markets files and proxies /api/private with origin Host", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-app-"));
    await writeFile(join(root, "trade.html"), "<html>markets</html>");
    const credentials = join(root, "holder-credentials.json");
    await writeFile(credentials, JSON.stringify({
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": {
            credentialId: "73",
            holderSecret: "1",
        },
    }));

    let seen;
    const upstream = http.createServer((incoming, response) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () => {
            seen = {
                method: incoming.method,
                url: incoming.url,
                host: incoming.headers.host,
                origin: incoming.headers.origin,
                site: incoming.headers["sec-fetch-site"],
                body: Buffer.concat(chunks).toString("utf8"),
            };
            response.writeHead(200, {"content-type": "application/json"});
            response.end(JSON.stringify({ok: true}));
        });
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = upstream.address().port;

    const gateway = createLocalAppGateway({
        config: localAppGatewayConfig({
            LOCAL_APP_HOST: "127.0.0.1",
            LOCAL_APP_PORT: "0",
            LOCAL_APP_ROOT: root,
            PRIVATE_TRADING_ALLOWED_ORIGIN: "http://127.0.0.1:8765",
            PRIVATE_TRADING_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
            PRIVATE_HOLDER_CREDENTIALS_FILE: credentials,
        }),
    });
    await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
    const port = gateway.server.address().port;

    const page = await request({
        hostname: "127.0.0.1",
        port,
        path: "/trade.html",
        headers: {host: "127.0.0.1:8765"},
    });
    assert.equal(page.status, 200);
    assert.equal(page.body, "<html>markets</html>");

    const nested = await request({
        hostname: "127.0.0.1",
        port,
        path: "/app/trade.html",
        headers: {host: "127.0.0.1:8765"},
    });
    assert.equal(nested.status, 200);
    assert.equal(nested.body, "<html>markets</html>");

    const proxied = await request({
        hostname: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/private/tickets",
        headers: {
            host: "127.0.0.1:8765",
            origin: "http://127.0.0.1:8765",
            "content-type": "application/json",
            "sec-fetch-site": "same-origin",
        },
    }, JSON.stringify({ticket: "demo"}));
    assert.equal(proxied.status, 200);
    assert.deepEqual(JSON.parse(proxied.body), {ok: true});
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/api/private/tickets");
    assert.equal(seen.host, "127.0.0.1:8765");
    assert.equal(seen.origin, "http://127.0.0.1:8765");
    assert.equal(seen.site, "same-origin");
    assert.equal(seen.body, JSON.stringify({ticket: "demo"}));

    const issued = await request({
        hostname: "127.0.0.1",
        port,
        path: "/api/private/holder-credential",
        headers: {
            host: "127.0.0.1:8765",
            "x-lattice-account": "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
        },
    });
    assert.equal(issued.status, 200);
    assert.equal(JSON.parse(issued.body).credential.credentialId, "73");

    const missing = await request({
        hostname: "127.0.0.1",
        port,
        path: "/api/private/holder-credential",
        headers: {
            host: "127.0.0.1:8765",
            "x-lattice-account": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
    });
    assert.equal(missing.status, 404);

    const localhost = await request({
        hostname: "127.0.0.1",
        port,
        path: "/trade.html",
        headers: {host: "localhost:8765"},
    });
    assert.equal(localhost.status, 200);

    const candidate = join(root, "candidate.json");
    await writeFile(candidate, JSON.stringify({
        schemaVersion: "lattice.private-trading-candidate-deployment.v1",
        candidateOnly: true,
        network: {chainId: 296},
        context: {
            activationEpoch: 8,
            feePolicyDigest: "0x" + "66".repeat(32),
            hbarDenominationTinybar: "100000000",
            lprcDenomination: "1",
        },
        addresses: {
            SessionAccountFactory: "0x" + "11".repeat(20),
            DualRegistrationGate: "0x" + "22".repeat(20),
            HbarRouter: "0x" + "33".repeat(20),
            LprcRouter: "0x" + "44".repeat(20),
            SessionRecoveryRouter: "0x" + "55".repeat(20),
        },
        verification: {lprcCanaryActivated: false},
    }));
    const notes = join(root, "notes.json");
    await writeFile(notes, JSON.stringify({afterFunders: 8, afterLeaves: 8}));
    await gateway.close();
    const statusGateway = createLocalAppGateway({
        config: localAppGatewayConfig({
            LOCAL_APP_HOST: "127.0.0.1",
            LOCAL_APP_PORT: "0",
            LOCAL_APP_ROOT: root,
            PRIVATE_TRADING_ALLOWED_ORIGIN: "http://127.0.0.1:8765",
            PRIVATE_TRADING_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
            PRIVATE_HOLDER_CREDENTIALS_FILE: credentials,
            PRIVATE_TRADING_CANDIDATE_FILE: candidate,
            PRIVATE_TRADING_HBAR_NOTES_FILE: notes,
        }),
    });
    await new Promise((resolve) => statusGateway.server.listen(0, "127.0.0.1", resolve));
    const statusPort = statusGateway.server.address().port;
    const status = await request({
        hostname: "127.0.0.1",
        port: statusPort,
        path: "/api/private/status",
        headers: {host: "127.0.0.1:8765"},
    });
    assert.equal(status.status, 200);
    const payload = JSON.parse(status.body);
    assert.equal(payload.bound, false);
    assert.equal(payload.candidateOnly, true);
    assert.equal(payload.activationEpoch, 8);
    assert.equal(payload.routingNotes.HBAR, 8);
    assert.equal(payload.lprcCanaryActivated, false);
    assert.equal(payload.worker.ok, true);
    assert.equal(payload.overlay.overlay, true);
    assert.equal(payload.overlay.enabled, true);
    assert.equal(payload.overlay.sellEnabled, false);
    assert.equal(payload.overlay.routingNotes.HBAR, 8);

    const provingRoot = join(root, "proving");
    for (const layout of Object.values(PRIVATE_PROVING_ARTIFACT_LAYOUT)) {
        mkdirSync(join(provingRoot, layout.wasm, ".."), {recursive: true});
        writeFileSync(join(provingRoot, layout.wasm), "wasm");
        writeFileSync(join(provingRoot, layout.zkey), "zkey-bytes");
        writeFileSync(
            join(provingRoot, layout.vkey),
            JSON.stringify({protocol: "plonk", curve: "bn128"}),
        );
    }
    await statusGateway.close();
    const artifactGateway = createLocalAppGateway({
        config: localAppGatewayConfig({
            LOCAL_APP_HOST: "127.0.0.1",
            LOCAL_APP_PORT: "0",
            LOCAL_APP_ROOT: root,
            PRIVATE_TRADING_ALLOWED_ORIGIN: "http://127.0.0.1:8765",
            PRIVATE_TRADING_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
            PRIVATE_HOLDER_CREDENTIALS_FILE: credentials,
            PRIVATE_TRADING_CANDIDATE_FILE: candidate,
            PRIVATE_TRADING_HBAR_NOTES_FILE: notes,
            PRIVATE_TRADING_PROVING_ROOT: provingRoot,
        }),
        provingArtifacts: loadPrivateProvingArtifacts(provingRoot),
    });
    await new Promise((resolve) => artifactGateway.server.listen(0, "127.0.0.1", resolve));
    const artifactPort = artifactGateway.server.address().port;
    const wasm = await request({
        hostname: "127.0.0.1",
        port: artifactPort,
        path: "/private-artifacts/sessionEligibility.wasm",
        headers: {host: "127.0.0.1:8765"},
    });
    assert.equal(wasm.status, 200);
    assert.equal(wasm.body, "wasm");
    const readyStatus = await request({
        hostname: "127.0.0.1",
        port: artifactPort,
        path: "/api/private/status",
        headers: {host: "127.0.0.1:8765"},
    });
    assert.equal(JSON.parse(readyStatus.body).provingReady, true);

    await artifactGateway.close();
    await new Promise((resolve) => upstream.close(resolve));
});
