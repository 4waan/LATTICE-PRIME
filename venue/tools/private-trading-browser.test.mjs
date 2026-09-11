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
