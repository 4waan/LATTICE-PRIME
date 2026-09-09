import {randomBytes, timingSafeEqual} from "node:crypto";
import http from "node:http";

const MAX_BODY_BYTES = 64 * 1024;

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
    constructor({signer, adapter, runtime = null, host = "127.0.0.1", port = 0}) {
        if (host !== "127.0.0.1") {
            throw new SupervisorError("BIND_REFUSED", "supervisor binds only to IPv4 loopback");
        }
        if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
            throw new SupervisorError("PORT_INVALID", "supervisor port is invalid");
        }
        this.signer = signer;
        this.adapter = adapter;
        this.runtime = runtime;
        this.host = host;
        this.port = port;
        this.pairingToken = token();
        this.sessionToken = null;
        this.csrfToken = null;
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
            pairingToken: this.pairingToken,
        };
    }

    async stop() {
        if (this.server === null) return;
        await new Promise((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
        this.server = null;
        this.sessionToken = null;
        this.csrfToken = null;
    }

    #headers(response) {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("X-Frame-Options", "DENY");
    }

    #send(response, status, body) {
        if (response.headersSent || response.destroyed) return;
        this.#headers(response);
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

    #authorizeRequest(request) {
        if (request.headers.host !== this.expectedHost) {
            throw new SupervisorError("HOST_REFUSED", "request Host is not the paired loopback service", 403);
        }
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
        if (!equalToken(this.#bearer(request), this.sessionToken)) {
            throw new SupervisorError("SESSION_REQUIRED", "valid paired session is required", 401);
        }
        if (csrf && !equalToken(request.headers["x-csrf-token"], this.csrfToken)) {
            throw new SupervisorError("CSRF_REFUSED", "valid CSRF token is required", 403);
        }
    }

    async #handle(request, response) {
        this.#authorizeRequest(request);
        const url = new URL(request.url, this.origin);
        if (url.search !== "") {
            throw new SupervisorError("QUERY_REFUSED", "local API does not accept query parameters");
        }
        if (request.method === "POST" && url.pathname === "/v1/pair") {
            if (!equalToken(this.#bearer(request), this.pairingToken)) {
                throw new SupervisorError("PAIRING_REFUSED", "pairing capability is invalid", 401);
            }
            exactObject(await readJson(request), [], "pair request");
            this.sessionToken = token();
            this.csrfToken = token();
            this.pairingToken = null;
            this.#send(response, 200, {
                ok: true,
                sessionToken: this.sessionToken,
                csrfToken: this.csrfToken,
            });
            return;
        }

        if (request.method === "GET" && url.pathname === "/v1/status") {
            this.#requireSession(request);
            this.#send(response, 200, {
                ok: true,
                status: {
                    schemaVersion: "lattice.agent.supervisor-status.v1",
                    runtime: "ready",
                    paired: true,
                    adapter: "deterministic-harness",
                    liveChainChecked: false,
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

        this.#requireSession(request, {csrf: true});
        const body = await readJson(request);
        let result;
        if (request.method === "POST" && url.pathname === "/v1/setup") {
            exactObject(body, ["passphrase"], "setup request");
            await this.signer.call("initializeStore", {passphrase: body.passphrase});
            result = await this.signer.call("initializeAccount", {passphrase: body.passphrase});
        } else if (request.method === "POST" && url.pathname === "/v1/unlock") {
            exactObject(body, ["passphrase"], "unlock request");
            result = await this.signer.call("unlock", {passphrase: body.passphrase});
        } else if (request.method === "POST" && url.pathname === "/v1/mandates/activate") {
            exactObject(body, ["mandate"], "activate request");
            result = await this.signer.call("activateMandate", {mandate: body.mandate});
        } else if (request.method === "POST" && url.pathname === "/v1/evaluations/reserve") {
            exactObject(body, ["context", "mandate"], "evaluation request");
            result = await this.signer.call("reserveEvaluation", {
                mandate: body.mandate,
                context: body.context,
            });
        } else if (request.method === "POST" && url.pathname === "/v1/evaluate") {
            if (this.runtime === null) {
                throw new SupervisorError("RUNTIME_UNAVAILABLE", "proof runtime is not configured", 503);
            }
            exactObject(body, ["context", "mandate", "nonce"], "evaluation request");
            result = await this.runtime.evaluate(body);
        } else {
            throw new SupervisorError("ROUTE_REFUSED", "local API route is not allowed", 404);
        }
        this.#send(response, 200, {ok: true, result});
    }
}
