// Same-origin local Markets server. Serves venue/app and forwards
// /api/private/* to the durable private-trading worker with the browser Host
// and Origin preserved so the worker's same-origin checks pass.

import http from "node:http";
import {createReadStream, existsSync, readFileSync, statSync} from "node:fs";
import {extname, join, normalize, relative, resolve, sep} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

import {
    buildPrivateCandidateOverlay,
    loadPrivateProvingArtifacts,
    provingArtifactFile,
} from "./private-candidate-overlay.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "../app");
const TYPES = Object.freeze({
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".woff2": "font/woff2",
});

export function localAppGatewayConfig(env = process.env) {
    const listenHost = String(env.LOCAL_APP_HOST || "127.0.0.1");
    const listenPort = Number(env.LOCAL_APP_PORT ?? 8765);
    const origin = String(
        env.PRIVATE_TRADING_ALLOWED_ORIGIN || `http://${listenHost}:${listenPort || 8765}`,
    );
    const parsed = new URL(origin);
    if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
        throw new Error("LOCAL_APP_PORT is invalid.");
    }
    return Object.freeze({
        listenHost,
        listenPort,
        origin,
        originHost: parsed.host.toLowerCase(),
        originHostAliases: loopbackHostAliases(parsed.host.toLowerCase()),
        root: resolve(env.LOCAL_APP_ROOT || DEFAULT_ROOT),
        privateUpstream: String(env.PRIVATE_TRADING_UPSTREAM || "http://127.0.0.1:8787"),
        holderCredentialsFile: env.PRIVATE_HOLDER_CREDENTIALS_FILE
            ? resolve(env.PRIVATE_HOLDER_CREDENTIALS_FILE)
            : resolve(HERE, "../agent/secrets/holder-credentials.json"),
        candidateFile: env.PRIVATE_TRADING_CANDIDATE_FILE
            ? resolve(env.PRIVATE_TRADING_CANDIDATE_FILE)
            : resolve(HERE, "../out/private-trading/private-trading-candidate-deployment.json"),
        notesFile: env.PRIVATE_TRADING_HBAR_NOTES_FILE
            ? resolve(env.PRIVATE_TRADING_HBAR_NOTES_FILE)
            : resolve(HERE, "../agent/secrets/hbar-seed-notes.json"),
        provingRoot: resolve(env.PRIVATE_TRADING_PROVING_ROOT || join(HERE, "..")),
    });
}

function loopbackHostAliases(originHost) {
    const host = String(originHost || "").toLowerCase();
    const split = host.lastIndexOf(":");
    if (split <= 0) return Object.freeze([host]);
    const name = host.slice(0, split);
    const port = host.slice(split + 1);
    if (!/^\d+$/.test(port)) return Object.freeze([host]);
    const aliases = new Set([host]);
    if (name === "127.0.0.1") aliases.add(`localhost:${port}`);
    if (name === "localhost") aliases.add(`127.0.0.1:${port}`);
    return Object.freeze([...aliases]);
}

function stripAppPrefix(pathname) {
    const path = String(pathname || "/");
    if (path === "/app" || path === "/app/") return "/";
    if (path.startsWith("/app/")) return path.slice(4) || "/";
    return path;
}

function requestHostAllowed(host, config, server) {
    const got = String(host || "").toLowerCase();
    if ((config.originHostAliases || [config.originHost]).includes(got)) return true;
    const address = server?.address?.();
    if (!address || typeof address === "string") return false;
    const bound = `${config.listenHost}:${address.port}`.toLowerCase();
    if (got === bound) return true;
    return loopbackHostAliases(bound).includes(got);
}

function send(response, status, headers, body) {
    response.writeHead(status, headers);
    response.end(body);
}

function refuse(response, status, message) {
    send(response, status, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
    }, message);
}

function safeFile(root, urlPath) {
    const decoded = decodeURIComponent((urlPath.split("?")[0] || "/"));
    const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    const candidate = resolve(root, relativePath);
    const rel = relative(root, candidate);
    if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || normalize(rel) !== rel) {
        return null;
    }
    if (!existsSync(candidate)) return null;
    const stats = statSync(candidate);
    if (stats.isDirectory()) {
        const index = join(candidate, "index.html");
        return existsSync(index) ? index : null;
    }
    return candidate;
}

export function createLocalAppGateway({
    config = localAppGatewayConfig(),
    fetchImpl,
    provingArtifacts = {artifacts: null, files: {}, missing: ["not loaded"]},
} = {}) {
    const server = http.createServer((request, response) => {
        handle(request, response).catch(() => {
            if (!response.headersSent) refuse(response, 500, "gateway failed");
            else response.end();
        });
    });

    async function handle(request, response) {
        const host = String(request.headers.host || "").toLowerCase();
        if (!requestHostAllowed(host, config, server)) {
            refuse(response, 403, "origin refused");
            return;
        }
        const url = new URL(request.url || "/", config.origin);
        const pagePath = stripAppPrefix(url.pathname);
        if (url.pathname === "/api/private/status") {
            await servePrivateStatus(request, response);
            return;
        }
        if (url.pathname === "/api/private/holder-credential") {
            serveHolderCredential(request, response);
            return;
        }
        if (url.pathname.startsWith("/api/private/")) {
            await proxyPrivate(request, response, url);
            return;
        }
        if (
            (request.method === "GET" || request.method === "HEAD")
            && url.pathname.startsWith("/private-artifacts/")
        ) {
            serveProvingArtifact(request, response, url.pathname);
            return;
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
            refuse(response, 405, "method not allowed");
            return;
        }
        const file = safeFile(config.root, pagePath);
        if (!file) {
            refuse(response, 404, "not found");
            return;
        }
        const type = TYPES[extname(file)] || "application/octet-stream";
        response.writeHead(200, {
            "content-type": type,
            "cache-control": "no-store",
        });
        if (request.method === "HEAD") {
            response.end();
            return;
        }
        createReadStream(file).pipe(response);
    }

    function readJsonFile(path) {
        if (!path || !existsSync(path)) return null;
        try {
            return JSON.parse(readFileSync(path, "utf8"));
        } catch {
            return null;
        }
    }

    function pingWorker() {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            let target;
            try {
                target = new URL(config.privateUpstream);
            } catch {
                finish(false);
                return;
            }
            const outgoing = http.request({
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port,
                path: "/api/private/sessions",
                method: "GET",
                timeout: 1500,
                headers: {
                    host: config.originHost,
                    origin: config.origin,
                    "sec-fetch-site": "same-origin",
                },
            }, (incoming) => {
                incoming.resume();
                finish(Number(incoming.statusCode) >= 100);
            });
            outgoing.on("error", () => finish(false));
            outgoing.on("timeout", () => {
                outgoing.destroy();
                finish(false);
            });
            outgoing.end();
        });
    }

    async function servePrivateStatus(request, response) {
        if (request.method !== "GET" && request.method !== "HEAD") {
            refuse(response, 405, "method not allowed");
            return;
        }
        const candidate = readJsonFile(config.candidateFile);
        const notes = readJsonFile(config.notesFile);
        const workerOk = await pingWorker();
        const hbarNotes = Number(
            notes?.afterFunders
            ?? notes?.afterLeaves
            ?? 0,
        );
        const overlay = buildPrivateCandidateOverlay({
            candidate,
            notes,
            workerOk,
            artifacts: provingArtifacts?.artifacts || null,
        });
        const body = {
            schemaVersion: "lattice.private-trading-status.v1",
            bound: false,
            candidateOnly: !!candidate,
            activationEpoch: candidate?.context?.activationEpoch ?? overlay?.activationEpoch ?? null,
            addresses: candidate?.addresses || null,
            routingNotes: {
                HBAR: Number.isFinite(hbarNotes) ? hbarNotes : 0,
                LPRC: 0,
            },
            lprcCanaryActivated: candidate?.verification?.lprcCanaryActivated === true,
            worker: {ok: workerOk},
            provingReady: overlay?.provingReady === true,
            overlay,
        };
        send(response, 200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
        }, request.method === "HEAD" ? "" : JSON.stringify(body));
    }

    function serveProvingArtifact(request, response, pathname) {
        const record = provingArtifactFile(provingArtifacts?.files, pathname);
        if (!record) {
            refuse(response, 404, "not found");
            return;
        }
        response.writeHead(200, {
            "content-type": "application/octet-stream",
            "cache-control": "no-store",
            "content-length": String(record.bytes),
        });
        if (request.method === "HEAD") {
            response.end();
            return;
        }
        createReadStream(record.path).pipe(response);
    }

    function serveHolderCredential(request, response) {
        if (request.method !== "GET" && request.method !== "HEAD") {
            refuse(response, 405, "method not allowed");
            return;
        }
        const account = String(request.headers["x-lattice-account"] || "").toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(account)) {
            refuse(response, 400, "account required");
            return;
        }
        if (!existsSync(config.holderCredentialsFile)) {
            refuse(response, 404, "holder credential not issued");
            return;
        }
        let store;
        try {
            store = JSON.parse(readFileSync(config.holderCredentialsFile, "utf8"));
        } catch {
            refuse(response, 500, "holder credential store unreadable");
            return;
        }
        const pack = store?.[account]
            || store?.credentials?.[account]
            || store?.holders?.[account];
        if (!pack) {
            refuse(response, 404, "holder credential not issued");
            return;
        }
        const body = JSON.stringify({credential: pack.credential || pack});
        send(response, 200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
        }, request.method === "HEAD" ? "" : body);
    }

    async function proxyPrivate(request, response, url) {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const target = new URL(url.pathname + url.search, config.privateUpstream);
        const headers = {
            host: config.originHost,
            origin: config.origin,
            "sec-fetch-site": "same-origin",
            "content-type": request.headers["content-type"] || "application/json",
            "content-length": String(body.length),
            accept: request.headers.accept || "application/json",
        };
        if (request.headers.authorization) {
            headers.authorization = request.headers.authorization;
        }
        if (fetchImpl) {
            try {
                const proxied = await fetchImpl(target, {
                    method: request.method,
                    headers,
                    body: body.length ? body : undefined,
                });
                const bytes = Buffer.from(await proxied.arrayBuffer());
                const outHeaders = {"cache-control": "no-store"};
                const contentType = proxied.headers.get("content-type");
                if (contentType) outHeaders["content-type"] = contentType;
                send(response, proxied.status, outHeaders, bytes);
            } catch {
                refuse(response, 502, "private trading service unavailable");
            }
            return;
        }
        await new Promise((resolve) => {
            const outgoing = http.request({
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port,
                path: target.pathname + target.search,
                method: request.method,
                headers,
            }, (incoming) => {
                const outChunks = [];
                incoming.on("data", (chunk) => outChunks.push(chunk));
                incoming.on("end", () => {
                    const outHeaders = {"cache-control": "no-store"};
                    if (incoming.headers["content-type"]) {
                        outHeaders["content-type"] = incoming.headers["content-type"];
                    }
                    send(
                        response,
                        incoming.statusCode || 502,
                        outHeaders,
                        Buffer.concat(outChunks),
                    );
                    resolve();
                });
            });
            outgoing.on("error", () => {
                if (!response.headersSent) {
                    refuse(response, 502, "private trading service unavailable");
                }
                resolve();
            });
            if (body.length) outgoing.write(body);
            outgoing.end();
        });
    }

    return Object.freeze({
        config,
        server,
        listen() {
            return new Promise((resolve, reject) => {
                server.once("error", reject);
                server.listen(config.listenPort, config.listenHost, () => {
                    server.removeListener("error", reject);
                    resolve({
                        host: config.listenHost,
                        port: config.listenPort,
                        origin: config.origin,
                    });
                });
            });
        },
        close() {
            return new Promise((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            });
        },
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const config = localAppGatewayConfig();
    const provingArtifacts = loadPrivateProvingArtifacts(config.provingRoot);
    const gateway = createLocalAppGateway({config, provingArtifacts});
    gateway.listen().then((bound) => {
        process.stdout.write(`local app ${bound.origin} -> ${gateway.config.root}\n`);
        process.stdout.write(`private API proxy ${gateway.config.privateUpstream}\n`);
        if (provingArtifacts.artifacts) {
            process.stdout.write("private proving artifacts ready\n");
        } else {
            process.stdout.write("private proving artifacts missing\n");
        }
    }).catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
    const stop = async () => {
        await gateway.close().catch(() => {});
        process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
}
