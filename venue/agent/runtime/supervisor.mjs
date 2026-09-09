import {randomBytes, timingSafeEqual} from "node:crypto";
import {readFile} from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_PAIRING_TOKENS = 16;
const MAX_SESSIONS = 16;
const PAIRING_TOKEN_TTL_MILLISECONDS = 60_000;
const SESSION_TTL_MILLISECONDS = 4 * 60 * 60 * 1_000;
const STATIC_FILES = new Map([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/prove.html", "prove.html"],
    ["/trade.html", "trade.html"],
    ["/position.html", "position.html"],
    ["/venue.html", "venue.html"],
    ["/repo.html", "repo.html"],
    ["/claw", "claw/index.html"],
    ["/claw/", "claw/index.html"],
    ["/claw/index.html", "claw/index.html"],
    ["/logo.svg", "logo.svg"],
    ["/vendor/ethers-6.13.5.umd.min.js", "vendor/ethers-6.13.5.umd.min.js"],
]);
const STATIC_CONTENT_TYPES = new Map([
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".svg", "image/svg+xml; charset=utf-8"],
]);

export class SupervisorError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = "SupervisorError";
        this.code = code;
        this.status = status;
    }
}

function token() {
    return randomBytes(32).toString("base64url");
}

function bootstrapScript(origin, pairingToken, nonce) {
    const payload = JSON.stringify({
        schemaVersion: "lattice.agent.browser-bootstrap.v1",
        origin,
        pairingToken,
    }).replaceAll("<", "\\u003c");
    return `<script nonce="${nonce}">globalThis.__LATTICE_AGENT_BOOTSTRAP__=${payload};</script>\n`;
}

function equalToken(got, expected) {
    if (typeof got !== "string" || typeof expected !== "string") return false;
    const left = Buffer.from(got);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
}

function exactObject(value, keys, name) {
    if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
    ) {
        throw new SupervisorError("REQUEST_SCHEMA", `${name} has an unknown or missing field`);
    }
}

async function readJson(request) {
    if (request.headers["content-type"] !== "application/json") {
        throw new SupervisorError("CONTENT_TYPE", "content type must be application/json", 415);
    }
    const declared = Number(request.headers["content-length"] ?? 0);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_BODY_BYTES) {
        throw new SupervisorError("BODY_TOO_LARGE", "request body is too large", 413);
    }
    const chunks = [];
    let received = 0;
    for await (const chunk of request) {
        received += chunk.length;
        if (received > MAX_BODY_BYTES) {
            request.destroy();
            throw new SupervisorError("BODY_TOO_LARGE", "request body is too large", 413);
        }
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new SupervisorError("JSON_INVALID", "request body is not valid JSON");
    }
}

export class AgentSupervisor {
    constructor({
        signer,
        adapter = null,
        runtime = null,
        runtimeFactory = null,
        receiptStore = null,
        scheduler = null,
        control = null,
        appRoot = null,
        host = "127.0.0.1",
        port = 0,
    }) {
        if (host !== "127.0.0.1") {
            throw new SupervisorError("BIND_REFUSED", "supervisor binds only to IPv4 loopback");
        }
        if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
            throw new SupervisorError("PORT_INVALID", "supervisor port is invalid");
        }
        if (runtimeFactory !== null && typeof runtimeFactory !== "function") {
            throw new SupervisorError("RUNTIME_FACTORY_INVALID", "runtime factory must be a function");
        }
        if (appRoot !== null && (!path.isAbsolute(appRoot) || path.normalize(appRoot) !== appRoot)) {
            throw new SupervisorError("APP_ROOT_INVALID", "app root must be an absolute normalized path");
        }
        this.signer = signer;
        this.adapter = adapter;
        this.runtime = runtime;
        this.runtimeFactory = runtimeFactory;
        this.runtimeClose = null;
        this.receiptStore = receiptStore;
        this.scheduler = scheduler;
        this.control = control;
        this.appRoot = appRoot;
        this.host = host;
        this.port = port;
        this.pairingTokens = new Map();
        this.sessions = new Map();
        this.server = null;
        this.origin = null;
        this.expectedHost = null;
    }

    async start() {
        if (this.server !== null) throw new SupervisorError("ALREADY_RUNNING", "supervisor is already running");
        this.server = http.createServer((request, response) => {
            this.#handle(request, response).catch((error) => this.#error(response, error));
        });
        await new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(this.port, this.host, () => {
                this.server.off("error", reject);
                resolve();
            });
        });
        const address = this.server.address();
        this.expectedHost = `${this.host}:${address.port}`;
        this.origin = `http://${this.expectedHost}`;
        return {
            origin: this.origin,
            pairingToken: this.#issuePairingToken(),
        };
    }

    async stop() {
        let failure = null;
        if (this.server !== null) {
            try {
                await new Promise((resolve, reject) =>
                    this.server.close((error) => (error ? reject(error) : resolve()))
                );
            } catch (error) {
                failure = error;
            } finally {
                this.server = null;
                this.pairingTokens.clear();
                this.sessions.clear();
            }
        }
        if (this.runtimeClose !== null) {
            try {
                await this.runtimeClose();
            } catch (error) {
                failure ??= error;
            } finally {
                this.runtimeClose = null;
            }
        }
        if (failure !== null) throw failure;
    }

    #securityHeaders(response) {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("X-Frame-Options", "DENY");
    }

    #send(response, status, body) {
        if (response.headersSent || response.destroyed) return;
        this.#securityHeaders(response);
        response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.statusCode = status;
        response.end(`${JSON.stringify(body)}\n`);
    }

    #error(response, error) {
        const known = error instanceof SupervisorError || typeof error?.code === "string";
        this.#send(response, error?.status ?? 400, {
            ok: false,
            error: {
                code: known ? error.code : "REQUEST_FAILED",
                message: known ? error.message : "request failed",
            },
        });
    }

    #requireHost(request) {
        if (request.headers.host !== this.expectedHost) {
            throw new SupervisorError("HOST_REFUSED", "request Host is not the paired loopback service", 403);
        }
    }

    #authorizeApiRequest(request) {
        this.#requireHost(request);
        if (request.method === "GET" && request.headers.origin === undefined) return;
        if (request.headers.origin !== this.origin) {
            throw new SupervisorError("ORIGIN_REFUSED", "request Origin is not allowed", 403);
        }
    }

    #bearer(request) {
        const authorization = request.headers.authorization;
        return typeof authorization === "string" && authorization.startsWith("Bearer ")
            ? authorization.slice(7)
            : null;
    }

    #requireSession(request, {csrf = false} = {}) {
        this.#pruneCapabilities();
        const sessionToken = this.#bearer(request);
        const session = [...this.sessions.entries()].find(([candidate]) => equalToken(sessionToken, candidate))?.[1];
        if (session === undefined) {
            throw new SupervisorError("SESSION_REQUIRED", "valid paired session is required", 401);
        }
        if (csrf && !equalToken(request.headers["x-csrf-token"], session.csrfToken)) {
            throw new SupervisorError("CSRF_REFUSED", "valid CSRF token is required", 403);
        }
    }

    async #handle(request, response) {
        this.#requireHost(request);
        const url = new URL(request.url, this.origin);
        if (url.search !== "") {
            throw new SupervisorError("QUERY_REFUSED", "local API does not accept query parameters");
        }
        if (request.method === "GET" && STATIC_FILES.has(url.pathname)) {
            await this.#serveStatic(url.pathname, response);
            return;
        }
        this.#authorizeApiRequest(request);
        if (request.method === "POST" && url.pathname === "/v1/pair") {
            this.#pruneCapabilities();
            const pairingToken = [...this.pairingTokens.keys()].find((candidate) =>
                equalToken(this.#bearer(request), candidate)
            );
            if (pairingToken === undefined) {
                throw new SupervisorError("PAIRING_REFUSED", "pairing capability is invalid", 401);
            }
            exactObject(await readJson(request), [], "pair request");
            this.pairingTokens.delete(pairingToken);
            const sessionToken = token();
            const csrfToken = token();
            while (this.sessions.size >= MAX_SESSIONS) {
                this.sessions.delete(this.sessions.keys().next().value);
            }
            this.sessions.set(sessionToken, {
                csrfToken,
                expiresAt: Date.now() + SESSION_TTL_MILLISECONDS,
            });
            this.#send(response, 200, {
                ok: true,
                sessionToken,
                csrfToken,
            });
            return;
        }

        if (request.method === "GET" && url.pathname === "/v1/status") {
            this.#requireSession(request);
            this.#send(response, 200, {
                ok: true,
                status: {
                    schemaVersion: "lattice.agent.supervisor-status.v1",
                    runtime: this.runtime === null ? "locked" : "ready",
                    paired: true,
                    adapter: this.adapter?.lastDeploymentEvidence
                        ? "hedera-testnet"
                        : (this.adapter === null ? "not-configured" : "deterministic-harness"),
                    liveChainChecked: Boolean(this.adapter?.lastDeploymentEvidence),
                    scheduler: this.scheduler?.status() ?? null,
                },
            });
            return;
        }
        if (request.method === "GET" && url.pathname === "/v1/signer/summary") {
            this.#requireSession(request);
            const result = await this.signer.call("summary", {});
            this.#send(response, 200, {ok: true, result});
            return;
        }
        if (request.method === "GET" && url.pathname === "/v1/receipts") {
            this.#requireSession(request);
            if (this.receiptStore === null) {
                throw new SupervisorError("RECEIPTS_UNAVAILABLE", "durable receipts are not configured", 503);
            }
            this.#send(response, 200, {ok: true, result: await this.receiptStore.list()});
            return;
        }
        if (request.method === "GET" && url.pathname === "/v1/scheduler/status") {
            this.#requireSession(request);
            if (this.scheduler === null) {
                throw new SupervisorError("SCHEDULER_UNAVAILABLE", "lifecycle scheduler is not configured", 503);
            }
            this.#send(response, 200, {ok: true, result: this.scheduler.status()});
            return;
        }

        this.#requireSession(request, {csrf: true});
        const body = await readJson(request);
        let result;
        if (request.method === "POST" && url.pathname === "/v1/setup") {
            exactObject(body, ["passphrase"], "setup request");
            await this.signer.call("initializeStore", {passphrase: body.passphrase});
            result = await this.signer.call("initializeAccount", {passphrase: body.passphrase});
            await this.#configureRuntime(result.address);
        } else if (request.method === "POST" && url.pathname === "/v1/unlock") {
            exactObject(body, ["passphrase"], "unlock request");
            result = await this.signer.call("unlock", {passphrase: body.passphrase});
            await this.#configureRuntime(result.address);
        } else if (request.method === "POST" && url.pathname === "/v1/mandates/activate") {
            exactObject(body, ["mandate"], "activate request");
            result = await this.signer.call("activateMandate", {mandate: body.mandate});
        } else if (request.method === "POST" && url.pathname === "/v1/mandates/pause") {
            exactObject(body, ["mandateId", "paused"], "pause request");
            result = await this.signer.call("pauseMandate", body);
        } else if (request.method === "POST" && url.pathname === "/v1/evaluate") {
            if (this.runtime === null) {
                throw new SupervisorError("RUNTIME_UNAVAILABLE", "proof runtime is not configured", 503);
            }
            exactObject(
                body,
                body.snapshot === undefined
                    ? ["context", "mandate", "nonce"]
                    : ["context", "mandate", "nonce", "snapshot"],
                "evaluation request"
            );
            result = await this.runtime.evaluate(body);
        } else if (request.method === "POST" && url.pathname === "/v1/actions/continue") {
            if (this.runtime === null) {
                throw new SupervisorError("RUNTIME_UNAVAILABLE", "proof runtime is not configured", 503);
            }
            exactObject(body, ["actionId", "nonce", "stage"], "continuation request");
            result = await this.runtime.continueAction(body);
        } else if (request.method === "POST" && url.pathname === "/v1/actions/recover") {
            if (this.runtime === null) {
                throw new SupervisorError("RUNTIME_UNAVAILABLE", "proof runtime is not configured", 503);
            }
            exactObject(body, ["actionId", "nonce"], "recovery request");
            result = await this.runtime.recoverAction(body);
        } else if (request.method === "POST" && url.pathname === "/v1/scheduler/run") {
            if (this.scheduler === null) {
                throw new SupervisorError("SCHEDULER_UNAVAILABLE", "lifecycle scheduler is not configured", 503);
            }
            exactObject(body, [], "scheduler run request");
            result = await this.scheduler.runOnce();
        } else if (request.method === "POST" && url.pathname === "/v1/agent/preview") {
            if (this.control === null) {
                throw new SupervisorError("CONTROL_UNAVAILABLE", "agent controls are not configured", 503);
            }
            result = await this.control.preview(body);
        } else if (request.method === "POST" && url.pathname === "/v1/agent/execute") {
            if (this.control === null) {
                throw new SupervisorError("CONTROL_UNAVAILABLE", "agent controls are not configured", 503);
            }
            result = await this.control.execute(body);
        } else {
            throw new SupervisorError("ROUTE_REFUSED", "local API route is not allowed", 404);
        }
        this.#send(response, 200, {ok: true, result});
    }

    #issuePairingToken() {
        this.#pruneCapabilities();
        while (this.pairingTokens.size >= MAX_PAIRING_TOKENS) {
            this.pairingTokens.delete(this.pairingTokens.keys().next().value);
        }
        const pairingToken = token();
        this.pairingTokens.set(pairingToken, Date.now() + PAIRING_TOKEN_TTL_MILLISECONDS);
        return pairingToken;
    }

    async #serveStatic(pathname, response) {
        if (this.appRoot === null) {
            throw new SupervisorError("ROUTE_REFUSED", "local application is not configured", 404);
        }
        const relativePath = STATIC_FILES.get(pathname);
        const fullPath = path.join(this.appRoot, relativePath);
        let content;
        try {
            content = await readFile(fullPath);
        } catch (error) {
            if (error?.code === "ENOENT") {
                throw new SupervisorError("STATIC_FILE_MISSING", "local application file is missing", 404);
            }
            throw error;
        }
        if (path.extname(relativePath) === ".html") {
            if (relativePath === "claw/index.html") {
                const nonce = randomBytes(18).toString("base64");
                content = Buffer.from(
                    content.toString("utf8").replaceAll("<style", `<style nonce="${nonce}"`),
                    "utf8"
                );
                response.setHeader(
                    "Content-Security-Policy",
                    `default-src 'none'; img-src 'self' data:; style-src 'nonce-${nonce}'; ` +
                        "font-src 'none'; connect-src 'none'; object-src 'none'; " +
                        "frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
                );
            } else {
                const pairingToken = this.#issuePairingToken();
                const nonce = randomBytes(18).toString("base64");
                const html = content
                    .toString("utf8")
                    .replaceAll("<script", `<script nonce="${nonce}"`);
                content = Buffer.concat([
                    Buffer.from(bootstrapScript(this.origin, pairingToken, nonce), "utf8"),
                    Buffer.from(html, "utf8"),
                ]);
                response.setHeader(
                    "Content-Security-Policy",
                    `default-src 'self'; connect-src 'self' https://testnet.hashio.io https://testnet.mirrornode.hedera.com; ` +
                        `img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-${nonce}'; ` +
                        "font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
                );
            }
        }
        this.#securityHeaders(response);
        if (!response.hasHeader("Content-Security-Policy")) {
            response.setHeader(
                "Content-Security-Policy",
                "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"
            );
        }
        response.setHeader(
            "Content-Type",
            STATIC_CONTENT_TYPES.get(path.extname(relativePath)) ?? "application/octet-stream"
        );
        response.statusCode = 200;
        response.end(content);
    }

    #pruneCapabilities() {
        const now = Date.now();
        for (const [pairingToken, expiresAt] of this.pairingTokens) {
            if (expiresAt <= now) this.pairingTokens.delete(pairingToken);
        }
        for (const [sessionToken, session] of this.sessions) {
            if (session.expiresAt <= now) this.sessions.delete(sessionToken);
        }
    }

    async #configureRuntime(address) {
        if (this.runtimeFactory === null) return;
        const configured = await this.runtimeFactory(address);
        if (
            configured === null ||
            typeof configured !== "object" ||
            configured.adapter === null ||
            typeof configured.adapter !== "object" ||
            configured.runtime === null ||
            typeof configured.runtime !== "object" ||
            (configured.receiptStore !== undefined &&
                (configured.receiptStore === null || typeof configured.receiptStore !== "object")) ||
            (configured.scheduler !== undefined &&
                (configured.scheduler === null || typeof configured.scheduler !== "object")) ||
            (configured.control !== undefined &&
                (configured.control === null || typeof configured.control !== "object")) ||
            typeof configured.close !== "function"
        ) {
            if (typeof configured?.close === "function") {
                try {
                    await configured.close();
                } catch {
                    // Preserve the configuration error as the primary failure.
                }
            }
            throw new SupervisorError("RUNTIME_CONFIGURATION_INVALID", "runtime factory returned an invalid result", 500);
        }
        if (this.runtimeClose !== null) {
            try {
                await this.runtimeClose();
            } catch (error) {
                if (typeof configured.close === "function") {
                    try {
                        await configured.close();
                    } catch {
                        // Preserve the existing runtime close failure.
                    }
                }
                throw error;
            }
        }
        this.adapter = configured.adapter;
        this.runtime = configured.runtime;
        this.receiptStore = configured.receiptStore ?? this.receiptStore;
        this.scheduler = configured.scheduler ?? this.scheduler;
        this.control = configured.control ?? this.control;
        this.runtimeClose = configured.close ?? null;
        try {
            if (configured.scheduler !== undefined) configured.scheduler.start();
        } catch (error) {
            try {
                if (this.runtimeClose !== null) await this.runtimeClose();
            } finally {
                this.adapter = null;
                this.runtime = null;
                this.scheduler = null;
                this.control = null;
                this.runtimeClose = null;
            }
            throw error;
        }
    }
}
