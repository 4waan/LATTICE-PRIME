const AGENT_ROUTES = new Set([
    "/v1/status",
    "/v1/signer/summary",
    "/v1/setup",
    "/v1/unlock",
    "/v1/mandates/activate",
    "/v1/mandates/pause",
    "/v1/evaluate",
    "/v1/actions/continue",
    "/v1/actions/recover",
    "/v1/receipts",
    "/v1/scheduler/status",
    "/v1/scheduler/run",
    "/v1/agent/preview",
    "/v1/agent/execute",
]);

export class LocalAgentClientError extends Error {
    constructor(code, message, status = 0) {
        super(message);
        this.name = "LocalAgentClientError";
        this.code = code;
        this.status = status;
    }
}

function exactBootstrap(value) {
    const keys = value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value).sort().join(",")
        : "";
    if (
        keys !== "origin,pairingToken,schemaVersion" ||
        value.schemaVersion !== "lattice.agent.browser-bootstrap.v1" ||
        typeof value.origin !== "string" ||
        !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.origin) ||
        typeof value.pairingToken !== "string" ||
        value.pairingToken.length < 32
    ) {
        throw new LocalAgentClientError("BOOTSTRAP_INVALID", "local agent bootstrap is invalid");
    }
    return value;
}

async function responseJson(response) {
    let body;
    try {
        body = await response.json();
    } catch {
        throw new LocalAgentClientError(
            "AGENT_RESPONSE_INVALID",
            "local agent returned an invalid response",
            response.status
        );
    }
    if (!response.ok || body?.ok !== true) {
        throw new LocalAgentClientError(
            typeof body?.error?.code === "string" ? body.error.code : "AGENT_REQUEST_FAILED",
            typeof body?.error?.message === "string" ? body.error.message : "local agent request failed",
            response.status
        );
    }
    return body;
}

export class LocalAgentClient {
    #origin;
    #sessionToken;
    #csrfToken;
    #fetch;

    constructor({origin, sessionToken, csrfToken, fetchImpl = globalThis.fetch}) {
        if (
            typeof origin !== "string" ||
            typeof sessionToken !== "string" ||
            typeof csrfToken !== "string" ||
            typeof fetchImpl !== "function"
        ) {
            throw new LocalAgentClientError("SESSION_INVALID", "local agent session is invalid");
        }
        this.#origin = origin;
        this.#sessionToken = sessionToken;
        this.#csrfToken = csrfToken;
        this.#fetch = fetchImpl;
    }

    async request(path, body = undefined) {
        if (!AGENT_ROUTES.has(path)) {
            throw new LocalAgentClientError("ROUTE_REFUSED", "local agent route is not allowed");
        }
        const method = body === undefined ? "GET" : "POST";
        const headers = {
            Accept: "application/json",
            Authorization: `Bearer ${this.#sessionToken}`,
        };
        const options = {
            method,
            cache: "no-store",
            credentials: "omit",
            headers,
            redirect: "error",
            referrerPolicy: "no-referrer",
        };
        if (method === "POST") {
            headers["Content-Type"] = "application/json";
            headers["X-CSRF-Token"] = this.#csrfToken;
            options.body = JSON.stringify(body);
        }
        const response = await this.#fetch(`${this.#origin}${path}`, options);
        const responseBody = await responseJson(response);
        return path === "/v1/status" ? responseBody.status : responseBody.result;
    }

    status() {
        return this.request("/v1/status");
    }

    summary() {
        return this.request("/v1/signer/summary");
    }

    setup(passphrase) {
        return this.request("/v1/setup", {passphrase});
    }

    unlock(passphrase) {
        return this.request("/v1/unlock", {passphrase});
    }

    activateMandate(mandate) {
        return this.request("/v1/mandates/activate", {mandate});
    }

    pauseMandate(mandateId, paused) {
        return this.request("/v1/mandates/pause", {mandateId, paused});
    }

    evaluate(request) {
        return this.request("/v1/evaluate", request);
    }

    continueAction(request) {
        return this.request("/v1/actions/continue", request);
    }

    recoverAction(actionId, nonce) {
        return this.request("/v1/actions/recover", {actionId, nonce});
    }

    receipts() {
        return this.request("/v1/receipts");
    }

    schedulerStatus() {
        return this.request("/v1/scheduler/status");
    }

    runScheduler() {
        return this.request("/v1/scheduler/run", {});
    }

    previewOrder(limitPrice, quantity) {
        return this.request("/v1/agent/preview", {limitPrice, quantity});
    }

    executePreview(previewId) {
        return this.request("/v1/agent/execute", {previewId});
    }
}

export async function pairLocalAgent({
    bootstrap = globalThis.__LATTICE_AGENT_BOOTSTRAP__,
    fetchImpl = globalThis.fetch,
    locationOrigin = globalThis.location?.origin,
} = {}) {
    const checked = exactBootstrap(bootstrap);
    if (locationOrigin !== undefined && checked.origin !== locationOrigin) {
        throw new LocalAgentClientError("ORIGIN_MISMATCH", "local agent origin does not match this page");
    }
    const pairingToken = checked.pairingToken;
    checked.pairingToken = "";
    try {
        delete globalThis.__LATTICE_AGENT_BOOTSTRAP__;
    } catch {
        globalThis.__LATTICE_AGENT_BOOTSTRAP__ = undefined;
    }
    const response = await fetchImpl(`${checked.origin}/v1/pair`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${pairingToken}`,
            "Content-Type": "application/json",
        },
        body: "{}",
        redirect: "error",
        referrerPolicy: "no-referrer",
    });
    const body = await responseJson(response);
    if (typeof body.sessionToken !== "string" || typeof body.csrfToken !== "string") {
        throw new LocalAgentClientError("PAIR_RESPONSE_INVALID", "local agent pairing response is invalid");
    }
    return new LocalAgentClient({
        origin: checked.origin,
        sessionToken: body.sessionToken,
        csrfToken: body.csrfToken,
        fetchImpl,
    });
}

if (typeof globalThis.window === "object" && globalThis.__LATTICE_AGENT_BOOTSTRAP__ !== undefined) {
    const state = {
        client: null,
        error: null,
        ready: null,
    };
    state.ready = pairLocalAgent()
        .then((client) => {
            state.client = client;
            globalThis.dispatchEvent(new CustomEvent("lattice-agent-ready"));
            return client;
        })
        .catch((error) => {
            state.error = error;
            globalThis.dispatchEvent(new CustomEvent("lattice-agent-error"));
            return null;
        });
    globalThis.LatticeAgent = Object.seal(state);
}
