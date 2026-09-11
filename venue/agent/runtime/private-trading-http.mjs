import http from "node:http";

import {
    PRIVATE_TRADING_BODY_LIMITS,
} from "./private-trading-controller.mjs";
import {
    PRIVATE_ROUTING_BODY_LIMIT,
} from "./private-routing-controller.mjs";

export const PRIVATE_SESSION_BODY_LIMIT = 32_768;
export const PRIVATE_HTTP_DEFAULT_RATE_LIMIT = 60;
export const PRIVATE_HTTP_DEFAULT_RATE_WINDOW_MS = 60_000;

const PUBLIC_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const SECURITY_HEADERS = Object.freeze({
    "cache-control": "no-store",
    "content-security-policy":
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
});

export class PrivateTradingHttpError extends Error {
    constructor(code, status = 400) {
        super("private trading HTTP request failed");
        this.name = "PrivateTradingHttpError";
        this.code = code;
        this.status = status;
    }
}

function fail(code, status = 400) {
    throw new PrivateTradingHttpError(code, status);
}

function positiveInteger(value, fallback, code) {
    const selected = value === undefined || value === "" ? fallback : value;
    if (
        !(
            typeof selected === "number" && Number.isSafeInteger(selected)
            || typeof selected === "string" && /^[1-9][0-9]*$/.test(selected)
        )
    ) {
        fail(code, 500);
    }
    const result = Number(selected);
    if (!Number.isSafeInteger(result) || result < 1) fail(code, 500);
    return result;
}

function loopbackHttpOrigin(parsed) {
    return parsed.protocol === "http:"
        && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
        && parsed.port !== "";
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

function loopbackOriginAliases(origin) {
    let parsed;
    try {
        parsed = new URL(origin);
    } catch {
        return Object.freeze([]);
    }
    const aliases = new Set([parsed.origin]);
    if (parsed.hostname === "127.0.0.1" && parsed.port) {
        aliases.add(`http://localhost:${parsed.port}`);
    }
    if (parsed.hostname === "localhost" && parsed.port) {
        aliases.add(`http://127.0.0.1:${parsed.port}`);
    }
    return Object.freeze([...aliases]);
}

function normalizedOrigin(value) {
    let parsed;
    try {
        parsed = new URL(String(value));
    } catch {
        fail("HTTP_ORIGIN_CONFIG_INVALID", 500);
    }
    const httpsOrigin = parsed.protocol === "https:";
    if (
        (!httpsOrigin && !loopbackHttpOrigin(parsed))
        || parsed.username !== ""
        || parsed.password !== ""
        || parsed.pathname !== "/"
        || parsed.search !== ""
        || parsed.hash !== ""
        || parsed.origin !== String(value)
    ) {
        fail("HTTP_ORIGIN_CONFIG_INVALID", 500);
    }
    return parsed.origin;
}

function listenHost(value) {
    const selected = value === undefined || value === "" ? "127.0.0.1" : value;
    if (
        typeof selected !== "string"
        || !/^(?:127\.0\.0\.1|::1|0\.0\.0\.0|::)$/.test(selected)
    ) {
        fail("HTTP_HOST_CONFIG_INVALID", 500);
    }
    return selected;
}

function servicePath(value, code) {
    if (
        typeof value !== "string"
        || !/^\/[A-Za-z0-9/_-]+$/.test(value)
        || value.includes("//")
        || value.endsWith("/")
    ) {
        fail(code, 500);
    }
    return value;
}

function publicCode(error, fallback = "REQUEST_FAILED") {
    return typeof error?.code === "string" && PUBLIC_CODE.test(error.code)
        ? error.code
        : fallback;
}

function publicStatus(error) {
    return Number.isSafeInteger(error?.status)
        && error.status >= 400
        && error.status <= 599
        ? error.status
        : 500;
}

function exactHeader(headers, name) {
    const value = headers[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string") fail("HEADER_INVALID");
    return value;
}

function contentType(headers, expected) {
    const value = exactHeader(headers, "content-type");
    if (
        typeof value !== "string"
        || value.toLowerCase().split(";", 1)[0].trim() !== expected
    ) {
        fail("CONTENT_TYPE_INVALID", 415);
    }
}

function declaredLength(headers, maximum) {
    const value = exactHeader(headers, "content-length");
    if (value === undefined) return null;
    if (!/^(0|[1-9][0-9]*)$/.test(value)) fail("CONTENT_LENGTH_INVALID");
    const length = Number(value);
    if (!Number.isSafeInteger(length)) fail("CONTENT_LENGTH_INVALID");
    if (length > maximum) fail("BODY_TOO_LARGE", 413);
    return length;
}

function parseJson(bytes) {
    try {
        return JSON.parse(bytes.toString("utf8"));
    } catch {
        fail("JSON_INVALID");
    }
}

function routeParts(pathname, base) {
    if (pathname === base) return [];
    if (!pathname.startsWith(`${base}/`)) return null;
    const parts = pathname.slice(base.length + 1).split("/");
    return parts.some((part) => part.length === 0) ? null : parts;
}

function routeDescriptor(pathname, method, routes) {
    const tickets = routeParts(pathname, routes.tickets);
    if (tickets !== null) {
        if (tickets.length === 0 && method === "POST") {
            return {
                category: "tickets",
                limit: PRIVATE_TRADING_BODY_LIMITS.envelope,
                contentType: "application/octet-stream",
                controller: "trading",
            };
        }
        return {
            category: "tickets",
            limit: 0,
            contentType: null,
            controller: "trading",
        };
    }
    const orders = routeParts(pathname, routes.orders);
    if (orders !== null) {
        const action = orders.length === 2 ? orders[1] : "";
        const json = method === "POST" && ["place", "cancel"].includes(action);
        return {
            category: "orders",
            limit: json ? PRIVATE_TRADING_BODY_LIMITS.json : 0,
            contentType: json ? "application/json" : null,
            controller: "trading",
        };
    }
    if (pathname === routes.routing) {
        return {
            category: "routing",
            limit: PRIVATE_ROUTING_BODY_LIMIT,
            contentType: "application/json",
            controller: "routing",
        };
    }
    if (pathname === routes.sessions) {
        return {
            category: "sessions",
            limit: PRIVATE_SESSION_BODY_LIMIT,
            contentType: "application/json",
            controller: "sessions",
        };
    }
    return {
        category: "unknown",
        limit: 0,
        contentType: null,
        controller: null,
    };
}

async function readBody(request, maximum, expectedLength) {
    const chunks = [];
    let length = 0;
    try {
        for await (const chunk of request) {
            const bytes = Buffer.from(chunk);
            length += bytes.length;
            if (length > maximum) fail("BODY_TOO_LARGE", 413);
            chunks.push(bytes);
        }
        if (expectedLength !== null && length !== expectedLength) {
            fail("CONTENT_LENGTH_INVALID");
        }
        return Buffer.concat(chunks, length);
    } finally {
        for (const chunk of chunks) chunk.fill(0);
    }
}

function sendJson(response, status, body) {
    const bytes = Buffer.from(JSON.stringify(body), "utf8");
    response.writeHead(status, {
        ...SECURITY_HEADERS,
        "content-type": JSON_CONTENT_TYPE,
        "content-length": String(bytes.length),
    });
    response.end(bytes);
}

function sendControllerResponse(response, result) {
    if (
        result === null
        || typeof result !== "object"
        || Array.isArray(result)
        || !Number.isSafeInteger(result.status)
        || result.status < 100
        || result.status > 599
        || result.headers === null
        || typeof result.headers !== "object"
        || Array.isArray(result.headers)
    ) {
        fail("CONTROLLER_RESPONSE_INVALID", 500);
    }
    const body = result.body instanceof Uint8Array
        ? Buffer.from(result.body)
        : Buffer.from(JSON.stringify(result.body), "utf8");
    try {
        response.writeHead(result.status, {
            ...result.headers,
            ...SECURITY_HEADERS,
            "content-length": String(body.length),
        });
        response.end(body);
    } finally {
        body.fill(0);
        result.body?.fill?.(0);
    }
}

class FixedWindowRateLimiter {
    constructor({limit, windowMilliseconds, nowMs = () => Date.now()}) {
        this.limit = limit;
        this.windowMilliseconds = windowMilliseconds;
        this.nowMs = nowMs;
        this.entries = new Map();
    }

    take(key) {
        const now = this.nowMs();
        if (!Number.isSafeInteger(now) || now < 0) fail("HTTP_CLOCK_INVALID", 500);
        const existing = this.entries.get(key);
        const entry = existing && now - existing.openedAt < this.windowMilliseconds
            ? existing
            : {openedAt: now, count: 0};
        entry.count += 1;
        this.entries.set(key, entry);
        if (entry.count > this.limit) fail("RATE_LIMITED", 429);
        if (this.entries.size > 10_000) {
            for (const [candidate, value] of this.entries) {
                if (now - value.openedAt >= this.windowMilliseconds) {
                    this.entries.delete(candidate);
                }
            }
        }
    }
}

export function privateTradingHttpConfig(env = process.env) {
    const origin = normalizedOrigin(env.PRIVATE_TRADING_ALLOWED_ORIGIN);
    const originHost = new URL(origin).host.toLowerCase();
    return Object.freeze({
        origin,
        originHost,
        originAliases: loopbackOriginAliases(origin),
        originHostAliases: loopbackHostAliases(originHost),
        host: listenHost(env.PRIVATE_TRADING_HTTP_HOST),
        port: positiveInteger(
            env.PRIVATE_TRADING_HTTP_PORT,
            8787,
            "HTTP_PORT_CONFIG_INVALID",
        ),
        rateLimit: positiveInteger(
            env.PRIVATE_TRADING_RATE_LIMIT,
            PRIVATE_HTTP_DEFAULT_RATE_LIMIT,
            "HTTP_RATE_LIMIT_CONFIG_INVALID",
        ),
        rateWindowMilliseconds: positiveInteger(
            env.PRIVATE_TRADING_RATE_WINDOW_MS,
            PRIVATE_HTTP_DEFAULT_RATE_WINDOW_MS,
            "HTTP_RATE_WINDOW_CONFIG_INVALID",
        ),
        requestTimeoutMilliseconds: positiveInteger(
            env.PRIVATE_TRADING_REQUEST_TIMEOUT_MS,
            15_000,
            "HTTP_TIMEOUT_CONFIG_INVALID",
        ),
    });
}

export class PrivateTradingHttpServer {
    constructor({
        tradingController,
        routingController,
        sessionController,
        worker,
        routes,
        config,
        nowMs = () => Date.now(),
        eventSink = () => {},
    }) {
        if (
            typeof tradingController?.handle !== "function"
            || typeof routingController?.handle !== "function"
            || typeof sessionController?.handle !== "function"
            || typeof worker?.start !== "function"
            || typeof worker?.stop !== "function"
            || typeof eventSink !== "function"
        ) {
            fail("HTTP_SERVER_CONFIG_INVALID", 500);
        }
        this.routes = Object.freeze({
            tickets: servicePath(routes?.tickets, "TICKETS_BASE_REQUIRED"),
            orders: servicePath(routes?.orders, "ORDERS_BASE_REQUIRED"),
            routing: servicePath(routes?.routing, "ROUTING_PATH_REQUIRED"),
            sessions: servicePath(routes?.sessions, "SESSIONS_PATH_REQUIRED"),
        });
        if (new Set(Object.values(this.routes)).size !== 4) {
            fail("SERVICE_PATHS_CONFLICT", 500);
        }
        this.config = Object.freeze({...config});
        if (
            typeof this.config.origin !== "string"
            || typeof this.config.originHost !== "string"
            || !Array.isArray(this.config.originAliases)
            || !Array.isArray(this.config.originHostAliases)
            || typeof this.config.host !== "string"
            || !Number.isSafeInteger(this.config.port)
            || !Number.isSafeInteger(this.config.rateLimit)
            || !Number.isSafeInteger(this.config.rateWindowMilliseconds)
            || !Number.isSafeInteger(this.config.requestTimeoutMilliseconds)
        ) {
            fail("HTTP_SERVER_CONFIG_INVALID", 500);
        }
        this.tradingController = tradingController;
        this.routingController = routingController;
        this.sessionController = sessionController;
        this.worker = worker;
        this.eventSink = eventSink;
        this.rateLimiter = new FixedWindowRateLimiter({
            limit: this.config.rateLimit,
            windowMilliseconds: this.config.rateWindowMilliseconds,
            nowMs,
        });
        this.server = http.createServer({
            headersTimeout: this.config.requestTimeoutMilliseconds,
            requestTimeout: this.config.requestTimeoutMilliseconds,
            keepAliveTimeout: 5_000,
            maxHeaderSize: 16_384,
        }, (request, response) => {
            this.#handle(request, response).catch((error) => {
                if (response.headersSent) {
                    response.destroy();
                    return;
                }
                const code = publicCode(error);
                const status = publicStatus(error);
                try {
                    Promise.resolve(this.eventSink(Object.freeze({
                        code,
                        category: "request",
                        method: /^(?:GET|POST)$/.test(request.method ?? "")
                            ? request.method
                            : "OTHER",
                        status,
                    }))).catch(() => {});
                } catch {
                    // Observability must not change the secret-free response.
                }
                sendJson(response, status, {error: {code}});
            });
        });
        this.server.maxHeadersCount = 32;
        this.server.maxRequestsPerSocket = 100;
        this.started = false;
    }

    async listen() {
        if (this.started) fail("HTTP_SERVER_ALREADY_STARTED", 500);
        await new Promise((resolve, reject) => {
            const onError = (error) => {
                this.server.off("listening", onListening);
                reject(error);
            };
            const onListening = () => {
                this.server.off("error", onError);
                resolve();
            };
            this.server.once("error", onError);
            this.server.once("listening", onListening);
            this.server.listen(this.config.port, this.config.host);
        });
        this.started = true;
        this.worker.start();
        return this.server.address();
    }

    async close() {
        const closing = this.started
            ? new Promise((resolve, reject) => {
                this.server.close((error) => error ? reject(error) : resolve());
                this.server.closeIdleConnections();
            })
            : Promise.resolve();
        await this.worker.stop();
        await closing;
        this.started = false;
    }

    async #handle(request, response) {
        if (!request.url?.startsWith("/") || request.url.startsWith("//")) {
            fail("PATH_INVALID");
        }
        if (!["GET", "POST"].includes(request.method ?? "")) {
            fail("METHOD_NOT_ALLOWED", 405);
        }
        if (Object.hasOwn(request.headers, "cookie")) fail("COOKIES_REFUSED", 403);
        const host = exactHeader(request.headers, "host")?.toLowerCase();
        const origin = exactHeader(request.headers, "origin");
        const fetchSite = exactHeader(request.headers, "sec-fetch-site");
        const browserSameOriginGet = (
            request.method === "GET"
            && origin === undefined
            && fetchSite === "same-origin"
        );
        if (
            !this.config.originHostAliases.includes(host)
            || (
                !this.config.originAliases.includes(origin)
                && !browserSameOriginGet
            )
            || (fetchSite !== undefined && fetchSite !== "same-origin")
        ) {
            fail("ORIGIN_REFUSED", 403);
        }
        const url = new URL(request.url, this.config.origin);
        if (url.search !== "" || url.hash !== "") fail("PATH_INVALID");
        const descriptor = routeDescriptor(url.pathname, request.method, this.routes);
        const remote = request.socket?.remoteAddress;
        if (typeof remote !== "string" || remote.length < 1 || remote.length > 128) {
            fail("CLIENT_ADDRESS_INVALID", 400);
        }
        this.rateLimiter.take(`${remote}:${descriptor.category}`);
        if (descriptor.controller === null) fail("ROUTE_NOT_FOUND", 404);
        if (descriptor.contentType !== null) {
            contentType(request.headers, descriptor.contentType);
        }
        const expectedLength = declaredLength(request.headers, descriptor.limit);
        const body = await readBody(request, descriptor.limit, expectedLength);
        try {
            if (descriptor.controller === "trading") {
                return sendControllerResponse(response, await this.tradingController.handle({
                    method: request.method,
                    path: url.pathname,
                    headers: request.headers,
                    body,
                }));
            }
            if (descriptor.controller === "routing") {
                return sendControllerResponse(response, await this.routingController.handle({
                    method: request.method,
                    path: url.pathname,
                    headers: request.headers,
                    body,
                }));
            }
            const result = await this.sessionController.handle(parseJson(body));
            sendJson(response, 200, result);
        } finally {
            body.fill(0);
        }
    }
}

export function createPrivateTradingHttpServer({
    runtime,
    env = process.env,
    nowMs = () => Date.now(),
    eventSink = () => {},
} = {}) {
    return new PrivateTradingHttpServer({
        tradingController: runtime?.controller,
        routingController: runtime?.routingController,
        sessionController: runtime?.sessionController,
        worker: runtime?.worker,
        routes: runtime?.config?.routes,
        config: privateTradingHttpConfig(env),
        nowMs,
        eventSink,
    });
}
