import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
    PrivateTradingHttpServer,
    createPrivateTradingHttpServer,
    privateTradingHttpConfig,
} from "../runtime/private-trading-http.mjs";
import {
    openPrivateTradingServer,
} from "../runtime/private-trading-server.mjs";

const ORIGIN = "https://market.example";
const ROUTES = Object.freeze({
    tickets: "/api/private/tickets",
    orders: "/api/private/orders",
    routing: "/api/private/routing",
    sessions: "/api/private/sessions",
});
const CAPABILITY = `0x${"88".repeat(32)}`;
const TICKET_ID = "99".repeat(32);

function request({
    port,
    method = "GET",
    path = "/",
    headers = {},
    body = null,
    omitOrigin = false,
}) {
    return new Promise((resolve, reject) => {
        const value = body === null ? null : Buffer.from(body);
        const outgoing = http.request({
            host: "127.0.0.1",
            port,
            method,
            path,
            headers: {
                host: "market.example",
                ...(omitOrigin ? {} : {origin: ORIGIN}),
                ...(value === null ? {} : {"content-length": String(value.length)}),
                ...headers,
            },
        }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.on("end", () => {
                const bytes = Buffer.concat(chunks);
                resolve({
                    status: response.statusCode,
                    headers: response.headers,
                    bytes,
                    json: () => JSON.parse(bytes.toString("utf8")),
                });
            });
        });
        outgoing.on("error", reject);
        if (value !== null) outgoing.write(value);
        outgoing.end();
    });
}

async function harness({rateLimit = 30} = {}) {
    const calls = [];
    const events = [];
    const workerState = {starts: 0, stops: 0};
    const tradingController = {
        async handle(value) {
            calls.push({controller: "trading", value});
            return {
                status: 201,
                headers: {"content-type": "application/json; charset=utf-8"},
                body: {ok: true, result: {ticketId: TICKET_ID}},
            };
        },
    };
    const routingController = {
        async handle(value) {
            calls.push({controller: "routing", value});
            return {
                status: 200,
                headers: {"content-type": "application/json; charset=utf-8"},
                body: {
                    status: "CONFIRMED",
                    txHash: `0x${"aa".repeat(32)}`,
                },
            };
        },
    };
    const sessionController = {
        async handle(value) {
            calls.push({controller: "sessions", value});
            return {
                status: "CONFIRMED",
                txHash: `0x${"bb".repeat(32)}`,
            };
        },
    };
    const server = new PrivateTradingHttpServer({
        tradingController,
        routingController,
        sessionController,
        worker: {
            start() {
                workerState.starts += 1;
            },
            async stop() {
                workerState.stops += 1;
            },
        },
        routes: ROUTES,
        config: {
            origin: ORIGIN,
            originHost: "market.example",
            originAliases: [ORIGIN],
            originHostAliases: ["market.example"],
            host: "127.0.0.1",
            port: 0,
            rateLimit,
            rateWindowMilliseconds: 60_000,
            requestTimeoutMilliseconds: 5_000,
        },
        eventSink: (event) => events.push(event),
    });
    const address = await server.listen();
    return {
        server,
        port: address.port,
        calls,
        events,
        workerState,
    };
}

test("HTTP service runs the worker and dispatches bounded ticket, routing, and session bodies", async () => {
    const running = await harness();
    try {
        assert.equal(running.workerState.starts, 1);
        const envelope = Buffer.alloc(2_048, 0x42);
        const ticket = await request({
            port: running.port,
            method: "POST",
            path: ROUTES.tickets,
            headers: {
                authorization: `Bearer ${CAPABILITY}`,
                "content-type": "application/octet-stream",
            },
            body: envelope,
        });
        assert.equal(ticket.status, 201);
        assert.equal(ticket.headers["cache-control"], "no-store");
        assert.equal(ticket.json().result.ticketId, TICKET_ID);

        const browserGet = await request({
            port: running.port,
            path: ROUTES.tickets + `/${TICKET_ID}`,
            headers: {
                authorization: `Bearer ${CAPABILITY}`,
                "sec-fetch-site": "same-origin",
            },
            omitOrigin: true,
        });
        assert.equal(browserGet.status, 201);

        const routingBody = Buffer.from(JSON.stringify({route: "proof"}));
        const routing = await request({
            port: running.port,
            method: "POST",
            path: ROUTES.routing,
            headers: {"content-type": "application/json"},
            body: routingBody,
        });
        assert.equal(routing.status, 200);
        assert.equal(routing.json().status, "CONFIRMED");

        const sessionBody = Buffer.from(JSON.stringify({action: "register"}));
        const session = await request({
            port: running.port,
            method: "POST",
            path: ROUTES.sessions,
            headers: {"content-type": "application/json"},
            body: sessionBody,
        });
        assert.equal(session.status, 200);
        assert.equal(session.json().status, "CONFIRMED");
        assert.deepEqual(
            running.calls.map((call) => call.controller),
            ["trading", "trading", "routing", "sessions"],
        );
        assert.deepEqual(running.calls[3].value, {action: "register"});
    } finally {
        await running.server.close();
    }
    assert.equal(running.workerState.stops, 1);
});

test("HTTP service rejects foreign origins, cookies, oversized bodies, and excess requests", async () => {
    const secret = "private-ticket-secret";
    const running = await harness({rateLimit: 2});
    try {
        const foreign = await request({
            port: running.port,
            method: "POST",
            path: ROUTES.sessions,
            headers: {
                origin: "https://attacker.example",
                "content-type": "application/json",
            },
            body: Buffer.from(JSON.stringify({secret})),
        });
        assert.equal(foreign.status, 403);
        assert.deepEqual(foreign.json(), {error: {code: "ORIGIN_REFUSED"}});

        const cookie = await request({
            port: running.port,
            method: "POST",
            path: ROUTES.routing,
            headers: {
                cookie: `session=${secret}`,
                "content-type": "application/json",
            },
            body: Buffer.from("{}"),
        });
        assert.equal(cookie.status, 403);
        assert.deepEqual(cookie.json(), {error: {code: "COOKIES_REFUSED"}});

        const oversized = await request({
            port: running.port,
            method: "POST",
            path: ROUTES.orders + `/${TICKET_ID}/place`,
            headers: {
                authorization: `Bearer ${CAPABILITY}`,
                "content-type": "application/json",
            },
            body: Buffer.alloc(1_025, 0x20),
        });
        assert.equal(oversized.status, 413);
        assert.deepEqual(oversized.json(), {error: {code: "BODY_TOO_LARGE"}});

        for (let index = 0; index < 2; index += 1) {
            const accepted = await request({
                port: running.port,
                method: "POST",
                path: ROUTES.sessions,
                headers: {"content-type": "application/json"},
                body: Buffer.from("{}"),
            });
            assert.equal(accepted.status, 200);
        }
        const limited = await request({
            port: running.port,
            method: "POST",
            path: ROUTES.sessions,
            headers: {"content-type": "application/json"},
            body: Buffer.from("{}"),
        });
        assert.equal(limited.status, 429);
        assert.deepEqual(limited.json(), {error: {code: "RATE_LIMITED"}});

        const serialized = JSON.stringify({
            events: running.events,
            foreign: foreign.bytes.toString("utf8"),
            cookie: cookie.bytes.toString("utf8"),
        });
        assert.equal(serialized.includes(secret), false);
        assert.equal(serialized.includes(TICKET_ID), false);
        assert.equal(running.calls.length, 2);
    } finally {
        await running.server.close();
    }
});

test("HTTP config requires an exact HTTPS origin and bounded numeric settings", () => {
    const config = privateTradingHttpConfig({
        PRIVATE_TRADING_ALLOWED_ORIGIN: ORIGIN,
        PRIVATE_TRADING_HTTP_HOST: "0.0.0.0",
        PRIVATE_TRADING_HTTP_PORT: "8788",
        PRIVATE_TRADING_RATE_LIMIT: "12",
        PRIVATE_TRADING_RATE_WINDOW_MS: "30000",
    });
    assert.equal(config.origin, ORIGIN);
    assert.equal(config.originHost, "market.example");
    assert.equal(config.port, 8788);
    assert.equal(config.rateLimit, 12);
    const loopback = privateTradingHttpConfig({
        PRIVATE_TRADING_ALLOWED_ORIGIN: "http://127.0.0.1:8765",
        PRIVATE_TRADING_HTTP_HOST: "127.0.0.1",
        PRIVATE_TRADING_HTTP_PORT: "8787",
    });
    assert.equal(loopback.origin, "http://127.0.0.1:8765");
    assert.equal(loopback.originHost, "127.0.0.1:8765");
    assert.deepEqual(loopback.originHostAliases, ["127.0.0.1:8765", "localhost:8765"]);
    const namedLoopback = privateTradingHttpConfig({
        PRIVATE_TRADING_ALLOWED_ORIGIN: "http://localhost:8765",
        PRIVATE_TRADING_HTTP_HOST: "127.0.0.1",
        PRIVATE_TRADING_HTTP_PORT: "8787",
    });
    assert.equal(namedLoopback.origin, "http://localhost:8765");
    assert.throws(
        () => privateTradingHttpConfig({
            PRIVATE_TRADING_ALLOWED_ORIGIN: "http://market.example",
        }),
        {code: "HTTP_ORIGIN_CONFIG_INVALID"},
    );
    assert.throws(
        () => privateTradingHttpConfig({
            PRIVATE_TRADING_ALLOWED_ORIGIN: `${ORIGIN}/private`,
        }),
        {code: "HTTP_ORIGIN_CONFIG_INVALID"},
    );
});

test("HTTP entrypoint binds the unified runtime session controller", () => {
    const runtime = {
        controller: {async handle() {}},
        routingController: {async handle() {}},
        sessionController: {async handle() {}},
        worker: {start() {}, async stop() {}},
        config: {routes: ROUTES},
    };
    const server = createPrivateTradingHttpServer({
        runtime,
        env: {
            PRIVATE_TRADING_ALLOWED_ORIGIN: ORIGIN,
            PRIVATE_TRADING_HTTP_HOST: "127.0.0.1",
            PRIVATE_TRADING_HTTP_PORT: "8788",
            PRIVATE_TRADING_RATE_LIMIT: "12",
            PRIVATE_TRADING_RATE_WINDOW_MS: "30000",
            PRIVATE_TRADING_REQUEST_TIMEOUT_MS: "5000",
        },
    });
    assert.equal(server.sessionController, runtime.sessionController);
    assert.equal(server.tradingController, runtime.controller);
    assert.deepEqual(server.routes, ROUTES);
});

test("server entrypoint opens and closes the unified runtime contract", async () => {
    let runtimeClosed = 0;
    let workerStops = 0;
    const runtime = {
        controller: {async handle() {}},
        routingController: {async handle() {}},
        sessionController: {async handle() {}},
        worker: {
            start() {},
            async stop() {
                workerStops += 1;
            },
        },
        config: {routes: ROUTES},
        async close() {
            runtimeClosed += 1;
        },
    };
    const service = await openPrivateTradingServer({
        env: {
            PRIVATE_TRADING_ALLOWED_ORIGIN: ORIGIN,
            PRIVATE_TRADING_HTTP_HOST: "127.0.0.1",
            PRIVATE_TRADING_HTTP_PORT: "8788",
            PRIVATE_TRADING_RATE_LIMIT: "12",
            PRIVATE_TRADING_RATE_WINDOW_MS: "30000",
            PRIVATE_TRADING_REQUEST_TIMEOUT_MS: "5000",
        },
        runtimeFactory: async () => runtime,
    });
    assert.equal(service.runtime.sessionController, runtime.sessionController);
    assert.equal(service.server.sessionController, runtime.sessionController);
    await service.close();
    assert.equal(workerStops, 1);
    assert.equal(runtimeClosed, 1);
});
