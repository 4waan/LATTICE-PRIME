import assert from "node:assert/strict";
import test from "node:test";

import {
    LocalAgentClientError,
    pairLocalAgent,
} from "./agent-client.mjs";

function response(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    };
}

function bootstrap(pairingToken = "p".repeat(43)) {
    return {
        schemaVersion: "lattice.agent.browser-bootstrap.v1",
        origin: "http://127.0.0.1:4567",
        pairingToken,
    };
}

test("browser bridge keeps capabilities in memory and constrains every request", async () => {
    const calls = [];
    const initial = bootstrap();
    const client = await pairLocalAgent({
        bootstrap: initial,
        locationOrigin: initial.origin,
        fetchImpl: async (url, options) => {
            calls.push({url, options});
            if (url.endsWith("/v1/pair")) {
                return response({
                    ok: true,
                    sessionToken: "s".repeat(43),
                    csrfToken: "c".repeat(43),
                });
            }
            if (url.endsWith("/v1/status")) {
                return response({ok: true, status: {runtime: "ready"}});
            }
            return response({ok: true, result: {paused: true}});
        },
    });

    assert.equal(initial.pairingToken, "");
    assert.deepEqual(await client.status(), {runtime: "ready"});
    assert.deepEqual(await client.pauseMandate("sha256:test", true), {paused: true});

    assert.equal(calls[0].options.headers.Authorization, `Bearer ${"p".repeat(43)}`);
    assert.equal(calls[0].options.headers["X-CSRF-Token"], undefined);
    assert.equal(calls[1].options.method, "GET");
    assert.equal(calls[1].options.headers.Authorization, `Bearer ${"s".repeat(43)}`);
    assert.equal(calls[1].options.headers["X-CSRF-Token"], undefined);
    assert.equal(calls[2].options.method, "POST");
    assert.equal(calls[2].options.headers["X-CSRF-Token"], "c".repeat(43));
    assert.deepEqual(JSON.parse(calls[2].options.body), {
        mandateId: "sha256:test",
        paused: true,
    });
    assert.equal(JSON.stringify(calls).includes("pairingToken"), false);
});

test("browser bridge refuses another origin before pairing", async () => {
    let called = false;
    await assert.rejects(
        () => pairLocalAgent({
            bootstrap: bootstrap(),
            locationOrigin: "http://127.0.0.1:9999",
            fetchImpl: async () => {
                called = true;
                return response({});
            },
        }),
        {code: "ORIGIN_MISMATCH"}
    );
    assert.equal(called, false);
});

test("browser bridge exposes bounded server errors and refuses arbitrary routes", async () => {
    const client = await pairLocalAgent({
        bootstrap: bootstrap(),
        locationOrigin: "http://127.0.0.1:4567",
        fetchImpl: async (url) => (
            url.endsWith("/v1/pair")
                ? response({
                    ok: true,
                    sessionToken: "s".repeat(43),
                    csrfToken: "c".repeat(43),
                })
                : response({
                    ok: false,
                    error: {code: "MANDATE_PAUSED", message: "mandate is paused"},
                }, 400)
        ),
    });
    await assert.rejects(() => client.summary(), (error) => {
        assert.equal(error instanceof LocalAgentClientError, true);
        assert.equal(error.code, "MANDATE_PAUSED");
        assert.equal(error.status, 400);
        return true;
    });
    await assert.rejects(() => client.request("/private-key"), {code: "ROUTE_REFUSED"});
});
