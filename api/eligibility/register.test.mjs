import test from "node:test";
import assert from "node:assert/strict";
import {
    createEligibilityRelay,
    validateEligibilityRequest,
} from "../_lib/eligibility-relay.mjs";

const account = "0x00000000000000000000000000000000000000aa";
const gate = "0x00000000000000000000000000000000000000bb";
const registry = "0x00000000000000000000000000000000000000cc";
const origin = "https://lattice-prime.vercel.app";

const config = {
    chainId: 296,
    gate,
    registry,
    allowedOrigins: [origin],
    accountRequestsPerWindow: 20,
    ipRequestsPerWindow: 20,
    sponsoredSubmissionsPerWindow: 20,
};

function body(overrides = {}) {
    return {
        chainId: 296,
        gate,
        registry,
        account,
        proof: Array.from({length: 24}, (_, index) => String(index + 1)),
        pub: [
            "91",
            "1",
            "42",
            "8",
            BigInt(account).toString(),
            "2",
            "3",
        ],
        ...overrides,
    };
}

function request(value = body(), overrides = {}) {
    return {
        method: "POST",
        headers: {
            origin,
            "content-type": "application/json",
            "x-forwarded-for": "203.0.113.7",
        },
        body: value,
        ...overrides,
    };
}

function response() {
    return {
        statusCode: 0,
        headers: {},
        text: "",
        setHeader(name, value) {
            this.headers[name.toLowerCase()] = String(value);
        },
        end(value) {
            this.text = String(value || "");
        },
        json() {
            return JSON.parse(this.text);
        },
    };
}

function chain(overrides = {}) {
    const calls = {status: 0, wouldAccept: 0, simulate: 0, submit: 0};
    return {
        calls,
        async status() {
            calls.status += 1;
            return 0;
        },
        async wouldAccept() {
            calls.wouldAccept += 1;
            return [true, ""];
        },
        async simulate() {
            calls.simulate += 1;
        },
        async submit() {
            calls.submit += 1;
            return {txHash: "0x" + "11".repeat(32)};
        },
        ...overrides,
    };
}

async function invoke(handler, supplied = request()) {
    const res = response();
    await handler(supplied, res);
    return res;
}

test("Vercel entrypoint loads with the pinned server dependency", async () => {
    const entrypoint = await import("./register.mjs");
    assert.equal(typeof entrypoint.default, "function");
});

test("request validation pins account, network, and fixed proof shapes", () => {
    const parsed = validateEligibilityRequest(body(), config);
    assert.equal(parsed.account, account);
    assert.equal(parsed.proof.length, 24);
    assert.equal(parsed.pub.length, 7);

    assert.throws(
        () => validateEligibilityRequest(body({chainId: 295}), config),
        /wrong network/,
    );
    assert.throws(
        () => validateEligibilityRequest(body({proof: ["1"]}), config),
        /24 values/,
    );
    assert.throws(
        () => validateEligibilityRequest(body({
            pub: ["91", "1", "42", "8", "1", "2", "3"],
        }), config),
        /another account/,
    );
});

test("relay refuses non-JSON and foreign-origin requests before chain reads", async () => {
    const adapter = chain();
    const handler = createEligibilityRelay({config, chain: adapter});

    const wrongType = await invoke(handler, request(body(), {
        headers: {origin, "content-type": "text/plain"},
    }));
    assert.equal(wrongType.statusCode, 415);

    const wrongOrigin = await invoke(handler, request(body(), {
        headers: {origin: "https://attacker.example", "content-type": "application/json"},
    }));
    assert.equal(wrongOrigin.statusCode, 403);
    assert.deepEqual(adapter.calls, {status: 0, wouldAccept: 0, simulate: 0, submit: 0});
});

test("an existing grant returns without verification or sponsor spend", async () => {
    const adapter = chain({
        async status() {
            adapter.calls.status += 1;
            return 1;
        },
    });
    const handler = createEligibilityRelay({config, chain: adapter});
    const res = await invoke(handler);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {status: "already_granted"});
    assert.equal(adapter.calls.simulate, 0);
    assert.equal(adapter.calls.submit, 0);
});

test("a public-pin refusal never reaches cryptographic simulation or submission", async () => {
    const adapter = chain({
        async wouldAccept() {
            adapter.calls.wouldAccept += 1;
            return [false, "wrong epoch"];
        },
    });
    const handler = createEligibilityRelay({config, chain: adapter});
    const res = await invoke(handler);

    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /wrong epoch/);
    assert.equal(adapter.calls.simulate, 0);
    assert.equal(adapter.calls.submit, 0);
});

test("an invalid cryptographic proof never spends sponsor funds", async () => {
    const adapter = chain({
        async simulate() {
            adapter.calls.simulate += 1;
            throw new Error("ProofInvalid");
        },
    });
    const handler = createEligibilityRelay({config, chain: adapter});
    const res = await invoke(handler);

    assert.equal(res.statusCode, 422);
    assert.match(res.json().error, /verification failed/);
    assert.equal(adapter.calls.submit, 0);
});

test("a valid request is simulated before one sponsored submission", async () => {
    const order = [];
    const adapter = chain({
        async simulate() {
            adapter.calls.simulate += 1;
            order.push("simulate");
        },
        async submit() {
            adapter.calls.submit += 1;
            order.push("submit");
            return {txHash: "0x" + "22".repeat(32)};
        },
    });
    const handler = createEligibilityRelay({config, chain: adapter});
    const res = await invoke(handler);

    assert.equal(res.statusCode, 202);
    assert.equal(res.json().status, "submitted");
    assert.equal(res.json().txHash, "0x" + "22".repeat(32));
    assert.deepEqual(order, ["simulate", "submit"]);
});

test("matching concurrent requests share one in-flight submission", async () => {
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const adapter = chain({
        async submit() {
            adapter.calls.submit += 1;
            await blocked;
            return {txHash: "0x" + "33".repeat(32)};
        },
    });
    const handler = createEligibilityRelay({config, chain: adapter});
    const first = invoke(handler);
    await new Promise((resolve) => setImmediate(resolve));
    const second = invoke(handler);
    release();
    const [a, b] = await Promise.all([first, second]);

    assert.equal(a.statusCode, 202);
    assert.equal(b.statusCode, 202);
    assert.equal(adapter.calls.submit, 1);
    assert.equal(a.json().txHash, b.json().txHash);
});
