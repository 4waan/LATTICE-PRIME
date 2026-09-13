import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {buildPrivateTradingBrowser} from "./build-private-trading-browser.mjs";

const marketRuntime = readFileSync(new URL("./venue-app.mjs", import.meta.url), "utf8");
const marketTemplate = readFileSync(
    new URL("../app/trade.template.html", import.meta.url),
    "utf8",
);
const proofWorker = readFileSync(
    new URL("../app/private-proof-worker.js", import.meta.url),
    "utf8",
);

test("private trading cryptography builds as a deterministic local browser bundle", async () => {
    const first = await buildPrivateTradingBrowser({write: false});
    const second = await buildPrivateTradingBrowser({write: false});
    assert.deepEqual(first, second);

    const source = Buffer.from(first).toString("utf8");
    assert.equal(/\bimport\s/.test(source), false);
    assert.equal(source.includes("/Users/"), false);
    const sandbox = {
        AbortSignal,
        BigInt,
        DataView,
        TextDecoder,
        TextEncoder,
        Uint8Array,
        atob: (value) => Buffer.from(value, "base64").toString("binary"),
        btoa: (value) => Buffer.from(value, "binary").toString("base64"),
        crypto: webcrypto,
        fetch: async () => {
            throw new Error("network disabled in browser bundle test");
        },
    };
    vm.runInNewContext(source, sandbox);
    const api = sandbox.PrivateTradingCrypto;
    assert.equal(api.TIMED_TICKET_SIZE, 2048);
    assert.equal(
        api.QUICKNET_CHAIN_HASH,
        "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
    );
    assert.equal(typeof api.createTimedTicketEnvelope, "function");
    assert.equal(typeof api.QuicknetLockedKeyProvider, "function");
    assert.equal(typeof api.timedTicketStoreId, "function");
    assert.match(await api.timedTicketStoreId(`0x${"ab".repeat(32)}`), /^[0-9a-f]{64}$/);
});

test("private proofs run through a disposable background worker", async () => {
    const start = marketRuntime.indexOf("Venue.runPrivateProof = function");
    const end = marketRuntime.indexOf("\nVenue.createOrRenewPrivateSession", start);
    assert.ok(start >= 0 && end > start);
    const calls = [];
    class Worker {
        constructor(url) {
            calls.push(["construct", url]);
        }

        postMessage(message) {
            calls.push(["post", message]);
            this.onmessage({
                data: {id: message.id, ok: true, result: {proof: "ready"}},
            });
        }

        terminate() {
            calls.push(["terminate"]);
        }
    }
    const Venue = {};
    vm.runInNewContext(marketRuntime.slice(start, end), {
        Venue,
        Worker,
        PRIVATE_PROOF_WORKER_URL: "private-proof-worker.js",
        PRIVATE_PROOF_TIMEOUT_MS: 60_000,
        PrivateTradingCrypto: {
            plonk: {},
            createPrivateRoutingProofs() {
                throw new Error("proof ran on the UI thread");
            },
        },
        clearTimeout,
        crypto: {randomUUID: () => "proof-1"},
        Error,
        Promise,
        setTimeout,
        String,
    });
    const result = await Venue.runPrivateProof("routing", {
        note: {commitment: "1"},
        plonk: {notCloneable: true},
    });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {proof: "ready"});
    assert.deepEqual(calls[0], ["construct", "private-proof-worker.js"]);
    assert.equal(calls[1][0], "post");
    assert.equal(calls[1][1].kind, "routing");
    assert.equal(Object.hasOwn(calls[1][1].request, "plonk"), false);
    assert.deepEqual(calls.at(-1), ["terminate"]);
});

test("the proof worker loads the pinned browser bundle and returns results", async () => {
    const posted = [];
    const loaded = [];
    const sandbox = {
        importScripts(path) { loaded.push(path); },
        self: {postMessage(message) { posted.push(message); }},
        PrivateTradingCrypto: {
            plonk: {name: "plonk"},
            async createPrivateRoutingProofs(request) {
                assert.equal(request.plonk.name, "plonk");
                return {nullifier: "7"};
            },
        },
        Object,
        String,
    };
    vm.runInNewContext(proofWorker, sandbox);
    assert.equal(sandbox.Worker, undefined);
    await sandbox.self.onmessage({
        data: {schemaVersion: 1, id: "proof-2", kind: "routing", request: {}},
    });
    assert.deepEqual(loaded, ["private-trading-crypto.bundle.mjs"]);
    assert.deepEqual(
        JSON.parse(JSON.stringify(posted)),
        [{id: "proof-2", ok: true, result: {nullifier: "7"}}],
    );
});

test("Shield Fast opens setup before resuming a deposited private route", async () => {
    const start = marketRuntime.indexOf("Venue.runPrivatePathClick = async function");
    const end = marketRuntime.indexOf("\nVenue.boot = async function", start);
    assert.ok(start >= 0 && end > start);
    const calls = [];
    const Venue = {
        account: "0x00000000000000000000000000000000000000aa",
        session: {account: "0x3333333333333333333333333333333333333333"},
        snap: {sessionKyc: 1},
        _privateSecretPayload: {credential: {holderSecret: "1"}},
        async requireAccount() { calls.push("require"); },
        capturePrivateOrderFlow(order) {
            calls.push("capture");
            const flow = {order, cancelled: false};
            Venue._privateOrderFlow = flow;
            return flow;
        },
        assertPrivateOrderFlow() { calls.push("assert"); },
        async openPrivateSetup() { calls.push("open"); },
        async ensurePrivateHolderCredential() { calls.push("credential"); return true; },
        privateFundingProgress() { return {ready: false}; },
        async fundPrivateSession() { calls.push("fund"); return {status: "waiting"}; },
    };
    vm.runInNewContext(marketRuntime.slice(start, end), {
        Venue,
        addrEq: (left, right) => String(left).toLowerCase() === String(right).toLowerCase(),
        Error,
    });
    await Venue.runPrivatePathClick({ok: true, side: 0}, "session-fund");
    assert.deepEqual(calls, [
        "require",
        "capture",
        "open",
        "assert",
        "credential",
        "fund",
    ]);
});

test("the final explicit funding action advances into placement automatically", async () => {
    const start = marketRuntime.indexOf("Venue.runPrivatePathClick = async function");
    const end = marketRuntime.indexOf("\nVenue.boot = async function", start);
    const calls = [];
    const flow = {order: {ok: true, side: 0}, cancelled: false};
    const Venue = {
        account: "0x00000000000000000000000000000000000000aa",
        session: {account: "0x3333333333333333333333333333333333333333"},
        snap: {sessionKyc: 1},
        _privateSecretPayload: {credential: {holderSecret: "1"}},
        async requireAccount() {},
        capturePrivateOrderFlow() { Venue._privateOrderFlow = flow; return flow; },
        assertPrivateOrderFlow() {},
        async openPrivateSetup() {},
        async ensurePrivateHolderCredential() { return true; },
        privateFundingProgress() { return {ready: false}; },
        async fundPrivateSession() { calls.push("fund"); return {status: "routed"}; },
        async advancePrivateOrderFlow(value) { calls.push(["advance", value]); return {status: "placed"}; },
    };
    vm.runInNewContext(marketRuntime.slice(start, end), {Venue, Error});
    const result = await Venue.runPrivatePathClick(flow.order, "session-fund");
    assert.equal(result.status, "placed");
    assert.deepEqual(calls, ["fund", ["advance", flow]]);
});

test("private funding progress names every fixed HBAR step and exact shortfall", () => {
    const start = marketRuntime.indexOf("Venue.privateFundingProgress = function");
    const end = marketRuntime.indexOf("\nVenue.paintPrivateSetup", start);
    assert.ok(start >= 0 && end > start);
    const order = {side: 0, qty: 5n};
    const Venue = {
        _privateOrderFlow: {order},
        snap: {sessionTinybar: 100_000_000n, sessionFree: 0n},
        orderFunds: () => ({privateRequired: 561_600_000n}),
    };
    vm.runInNewContext(marketRuntime.slice(start, end), {
        Venue,
        CLIENT: {privateTrading: {routing: {HBAR: {denomination: "100000000"}}}},
        asBig: BigInt,
        readableHbar: (value) => {
            const whole = value / 100_000_000n;
            const fraction = String(value % 100_000_000n).padStart(8, "0").replace(/0+$/, "");
            return fraction ? whole + "." + fraction : String(whole);
        },
        formatQuantity: String,
    });
    const progress = Venue.privateFundingProgress(0);
    assert.equal(progress.label, "1 of 6 HBAR funded");
    assert.equal(progress.action, "Fund next 1 HBAR");
    assert.equal(progress.status, "4.616 HBAR still required. Fund the next 1 HBAR when ready.");
});

test("a funded private flow places once and directs the user to the new order", async () => {
    const start = marketRuntime.indexOf("Venue.advancePrivateOrderFlow = async function");
    const end = marketRuntime.indexOf("\nVenue.continuePrivateSetup", start);
    assert.ok(start >= 0 && end > start);
    const calls = [];
    const flow = {order: {side: 0}, placing: false, completed: false};
    const ticket = {id: "0x" + "ab".repeat(32)};
    const Venue = {
        _privateOrderFlow: flow,
        assertPrivateOrderFlow() { calls.push("assert"); },
        async refreshTrade() { calls.push("refresh"); },
        guidedOrderState() { return {mode: "private-commit"}; },
        paintPrivateSetup() { calls.push("paint-setup"); },
        status(id, message) { calls.push(["status", id, message]); },
        async placePrivateOrder() { calls.push("place"); return ticket; },
        async paintTickets() { calls.push("paint-tickets"); },
        closePrivateSetup(options) { calls.push(["close", options]); },
        showOrderStage(stage) { calls.push(["stage", stage]); },
        focusPlacedPrivateOrder(value) { calls.push(["focus", value.id]); },
    };
    vm.runInNewContext(marketRuntime.slice(start, end), {Venue, Error});
    const result = await Venue.advancePrivateOrderFlow(flow);
    assert.equal(result.status, "placed");
    assert.equal(calls.filter((item) => item === "place").length, 1);
    assert.equal(flow.completed, true);
    assert.deepEqual(calls.at(-2), ["status", "trade-status", "Order sealed and scheduled for automatic reveal. It will enter the public order book after reveal."]);
    assert.deepEqual(calls.at(-1), ["focus", ticket.id]);
});

test("an underfunded private flow stays in the modal without another wallet action", async () => {
    const start = marketRuntime.indexOf("Venue.advancePrivateOrderFlow = async function");
    const end = marketRuntime.indexOf("\nVenue.continuePrivateSetup", start);
    const calls = [];
    const flow = {order: {side: 0}, placing: false};
    const progress = {
        status: "4.616 HBAR still required. Fund the next 1 HBAR when ready.",
    };
    const Venue = {
        assertPrivateOrderFlow() {},
        async refreshTrade() { calls.push("refresh"); },
        guidedOrderState() { return {mode: "session-fund"}; },
        privateFundingProgress() { return progress; },
        status(id, message) { calls.push([id, message]); },
        paintPrivateSetup() { calls.push("paint"); },
        async placePrivateOrder() { calls.push("place"); },
    };
    vm.runInNewContext(marketRuntime.slice(start, end), {Venue, Error});
    const result = await Venue.advancePrivateOrderFlow(flow);
    assert.equal(result.status, "funding-required");
    assert.equal(calls.includes("place"), false);
    assert.deepEqual(calls.at(-2), ["private-setup-status", progress.status]);
    assert.equal(calls.at(-1), "paint");
});

test("a staged ticket remains visible when private placement fails", async () => {
    const start = marketRuntime.indexOf("Venue.advancePrivateOrderFlow = async function");
    const end = marketRuntime.indexOf("\nVenue.continuePrivateSetup", start);
    const calls = [];
    const flow = {order: {side: 0}, placing: false};
    const Venue = {
        assertPrivateOrderFlow() {},
        async refreshTrade() {},
        guidedOrderState() { return {mode: "private-commit"}; },
        paintPrivateSetup() { calls.push("paint-setup"); },
        status() {},
        async placePrivateOrder() { throw new Error("relay unavailable"); },
        async paintTickets() { calls.push("paint-tickets"); },
    };
    vm.runInNewContext(marketRuntime.slice(start, end), {Venue, Error});
    await assert.rejects(Venue.advancePrivateOrderFlow(flow), /relay unavailable/);
    assert.equal(flow.placing, false);
    assert.deepEqual(calls.slice(-2), ["paint-tickets", "paint-setup"]);
});

test("private continuation is bound to its wallet, session, and reviewed order", () => {
    const start = marketRuntime.indexOf("Venue.privateOrderFingerprint = function");
    const end = marketRuntime.indexOf("\nVenue.focusPlacedPrivateOrder", start);
    assert.ok(start >= 0 && end > start);
    const owner = "0x00000000000000000000000000000000000000aa";
    const session = "0x00000000000000000000000000000000000000bb";
    const original = {side: 0, price: 7n, qty: 5n, salt: "0x" + "11".repeat(32)};
    const Venue = {
        account: owner,
        session: {account: session},
        readOrder: () => original,
    };
    vm.runInNewContext(marketRuntime.slice(start, end), {
        Venue,
        Object,
        String,
        Number,
        asBig: BigInt,
        addrEq: (left, right) => String(left).toLowerCase() === String(right).toLowerCase(),
        Error,
    });
    const flow = Venue.capturePrivateOrderFlow({...original, ok: true});
    assert.equal(Venue.assertPrivateOrderFlow(flow), flow);
    Venue.readOrder = () => ({...original, qty: 6n});
    assert.throws(() => Venue.assertPrivateOrderFlow(flow), /reviewed order changed/);
    Venue.readOrder = () => original;
    Venue.account = "0x00000000000000000000000000000000000000cc";
    assert.throws(() => Venue.assertPrivateOrderFlow(flow), /connected wallet changed/);
});

test("closing private setup cancels placement continuation but keeps routed state", () => {
    const start = marketRuntime.indexOf("Venue.closePrivateSetup = function");
    const end = marketRuntime.indexOf("\nVenue.privateSessionConfig", start);
    assert.ok(start >= 0 && end > start);
    const flow = {cancelled: false, completed: false};
    const modal = {hidden: false};
    const Venue = {_privateOrderFlow: flow, _privateFundingTimer: 1};
    vm.runInNewContext(marketRuntime.slice(start, end), {
        Venue,
        clearTimeout() {},
        $: (id) => id === "private-setup-modal" ? modal : {hidden: true},
        document: {body: {classList: {remove() {}}}},
    });
    Venue.closePrivateSetup();
    assert.equal(flow.cancelled, true);
    assert.equal(modal.hidden, true);
});

test("private browser flow reads exact custody bytes before relayed placement", () => {
    const stage = marketRuntime.indexOf("Venue.stagePrivateTicket = async function");
    const create = marketRuntime.indexOf("Venue.createPrivateTicket = async function");
    const relay = marketRuntime.indexOf("Venue.relayPrivatePlacement = async function");
    const place = marketRuntime.indexOf("Venue.placePrivateOrder = async function");
    assert.ok(stage >= 0 && stage < create && create < relay && relay < place);

    const stageSource = marketRuntime.slice(stage, create);
    assert.match(stageSource, /application\/octet-stream/);
    assert.match(stageSource, /privateTicketUrl\(ticket\.timedTicketId, "envelope"\)/);
    // The service addresses tickets by its own derived id; the envelope id is
    // what the readback is parsed against.
    assert.match(stageSource, /envelopeId: ticket\.envelopeId/);
    const createSource = marketRuntime.slice(create, relay);
    assert.match(createSource, /envelopeId: made\.envelopeId\.toLowerCase\(\)/);
    assert.match(
        createSource,
        /timedTicketId: await PrivateTradingCrypto\.timedTicketStoreId\(made\.envelopeId\)/,
    );
    assert.match(
        marketRuntime.slice(marketRuntime.indexOf("Venue.assertPrivateTicketSummary = function"), stage),
        /summary\?\.envelopeId/,
    );
    assert.match(stageSource, /readback\.some\(\(value, index\) => value !== envelope\[index\]\)/);
    assert.ok(
        stageSource.indexOf("readback.some") < stageSource.indexOf("Venue.upsertTicket"),
    );

    const privateFlow = marketRuntime.slice(stage, marketRuntime.indexOf(
        "\nVenue.continuePrivateSetup",
        place,
    ));
    assert.doesNotMatch(privateFlow, /estimateGas|eth_estimateGas/);
    assert.match(marketRuntime, /value: toWeibar\(context\.denomination\)/);
    assert.match(marketRuntime, /PRIVATE_HBAR_DEPOSIT_GAS = 1_100_000n/);
    assert.match(marketRuntime, /credentials: "omit"/);
});

test("private cancellation does not finish while engine credit remains", () => {
    const start = marketRuntime.indexOf("Venue.cancelPrivateOrder = async function");
    const end = marketRuntime.indexOf("\nVenue.releasePrivateOrder", start);
    assert.ok(start >= 0 && end > start);
    const source = marketRuntime.slice(start, end);
    assert.match(source, /Venue\.c\.engine\.credit\(ticket\.committer\)/);
    assert.match(
        source,
        /chainBefore\.cancelled && asBig\(creditBefore\) === 0n/,
    );
    assert.match(source, /!chain\.cancelled \|\| asBig\(credit\) !== 0n/);
    assert.ok(
        source.indexOf("asBig(creditBefore) === 0n")
        < source.indexOf("Venue.privateTicketRequest"),
    );
});

test("session rotation preserves old keys and relays fixed-note recovery", () => {
    assert.match(marketTemplate, /id="private-session-management"/);
    assert.match(marketTemplate, /id="private-session-rotate"/);
    assert.match(marketTemplate, /id="private-session-history"/);

    const rotateStart = marketRuntime.indexOf("Venue.rotatePrivateSession = async function");
    const recoverStart = marketRuntime.indexOf(
        "Venue.recoverRetiringSessionAsset = async function",
        rotateStart,
    );
    const recoverEnd = marketRuntime.indexOf(
        "\nVenue.privateFundingAsset",
        recoverStart,
    );
    assert.ok(rotateStart >= 0 && recoverStart > rotateStart && recoverEnd > recoverStart);
    const rotation = marketRuntime.slice(rotateStart, recoverStart);
    assert.match(rotation, /state\.openOrders > 0/);
    assert.match(rotation, /state\.credit > 0n/);
    assert.match(rotation, /state: "RETIRING"/);
    assert.match(rotation, /Venue\.createOrRenewPrivateSession\(\)/);

    const renewalStart = marketRuntime.indexOf(
        "Venue.renewRetiringPrivateSession = async function",
        rotateStart,
    );
    assert.ok(renewalStart > rotateStart && renewalStart < recoverStart);
    const renewal = marketRuntime.slice(renewalStart, recoverStart);
    assert.match(renewal, /item\.state === "RETIRING"/);
    assert.match(renewal, /recordAccount: record\.account/);
    assert.match(marketRuntime, /if \(historical\)[\s\S]*state: "RETIRING"/);

    const recovery = marketRuntime.slice(recoverStart, recoverEnd);
    assert.match(recovery, /record\.recoveryPrivateKey/);
    assert.match(recovery, /recoveryAuthorizationDigest/);
    assert.match(recovery, /action: "recover-to-router"/);
    assert.match(recovery, /Venue\.privatePost/);
    assert.match(recovery, /state: "RECOVERED"/);
    assert.match(recovery, /Renew this previous session before recovering LPRC/);
    assert.doesNotMatch(recovery, /Venue\.send\(/);

    const paintStart = marketRuntime.indexOf(
        "Venue.refreshPrivateSessionRecovery = async function",
    );
    assert.ok(paintStart >= 0 && paintStart < rotateStart);
    const paint = marketRuntime.slice(paintStart, rotateStart);
    assert.match(paint, /const canRecoverAssets = state\.openOrders === 0 && state\.credit === 0n/);
    assert.match(paint, /canRecoverAssets && state\.hbarNotes > 0n/);
    assert.match(paint, /canRecoverAssets && state\.lprcNotes > 0n && state\.kyc === 1/);
    assert.match(paint, /Renew session eligibility/);
});

test("session rotation waits for every locally managed on-chain order to finish", async () => {
    const start = marketRuntime.indexOf("Venue.privateSessionOpenOrderCount = async function");
    const end = marketRuntime.indexOf("\nVenue.privateSessionRetirementState", start);
    assert.ok(start >= 0 && end > start);
    const account = "0x00000000000000000000000000000000000000aa";
    const tickets = [
        {id: "open", path: "private", committer: account, committedAt: "1"},
        {id: "done", path: "private", committer: account, committedAt: "2"},
        {
            id: "cancelled",
            path: "private",
            committer: account,
            committedAt: "3",
            cancelled: true,
        },
        {
            id: "other",
            path: "private",
            committer: "0x00000000000000000000000000000000000000bb",
            committedAt: "4",
        },
    ];
    const Venue = {
        account,
        ticketList: () => tickets,
        c: {
            engine: {
                commitments: async (id) => ({
                    cancelled: false,
                    committer: account,
                    revealed: id === "done",
                }),
                orders: async () => ({retired: true}),
            },
        },
    };
    vm.runInNewContext(marketRuntime.slice(start, end), {
        Venue,
        ZERO: "0x0000000000000000000000000000000000000000",
        addrEq: (left, right) => String(left).toLowerCase() === String(right).toLowerCase(),
    });
    assert.equal(
        await Venue.privateSessionOpenOrderCount({account}),
        1,
    );
});

test("routing root selection chooses the newest mature root containing the note", async () => {
    const start = marketRuntime.indexOf("Venue.selectPrivateRoutingRoot = async function");
    const end = marketRuntime.indexOf("\nVenue.completePrivateRoutingNote", start);
    assert.ok(start >= 0 && end > start);
    const Venue = {};
    let now = 195n;
    vm.runInNewContext(marketRuntime.slice(start, end), {
        Venue,
        asBig: BigInt,
        nowSec: () => now,
    });
    const context = {
        router: {
            nextLeafIndex: async () => 10n,
            minimumRealNotes: async () => 8n,
            minimumWithdrawalDelay: async () => 100n,
            rootAtNoteCount: async (count) => BigInt(count * 100),
            rootMetadata: async (root) => {
                const count = Number(BigInt(root) / 100n);
                return {
                    acceptedAt: BigInt(count * 10),
                    realNotes: BigInt(count),
                    independentFunders: BigInt(count),
                    known: true,
                };
            },
        },
    };

    const mature = await Venue.selectPrivateRoutingRoot({leafIndex: "0"}, context);
    assert.equal(mature.ready, true);
    assert.equal(mature.root, 900n);

    now = 175n;
    const waiting = await Venue.selectPrivateRoutingRoot({leafIndex: "0"}, context);
    assert.equal(waiting.ready, false);
    assert.equal(waiting.availableAt, 180n);

    now = 195n;
    context.router.rootMetadata = async (root) => {
        const count = Number(BigInt(root) / 100n);
        return {
            acceptedAt: BigInt(count * 10),
            realNotes: BigInt(count),
            independentFunders: 7n,
            known: true,
        };
    };
    await assert.rejects(
        Venue.selectPrivateRoutingRoot({leafIndex: "0"}, context),
        /released privacy set/,
    );
});
