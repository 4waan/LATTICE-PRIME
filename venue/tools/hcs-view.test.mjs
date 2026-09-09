import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

const source = readFileSync(new URL("./hcs-view.mjs", import.meta.url), "utf8");
const topicId = "0.0.123";
const base = "/api/v1/topics/0.0.123/messages";
const first = base + "?order=desc&limit=100";
const second = base + "?order=desc&limit=100&sequencenumber=lt:34";
const tailFrom = (seq) => base + "?order=asc&limit=100&sequencenumber=gte:" + seq;

/// Values made inside the page's realm carry that realm's prototypes, which a
/// strict deep equality refuses; this brings them across as plain data.
const plain = (x) => JSON.parse(JSON.stringify(x));

const message = (seq, kind) => ({
    sequence_number: seq,
    consensus_timestamp: `${seq}.000000000`,
    message: Buffer.from(JSON.stringify({k: kind})).toString("base64"),
});

/// `pages` maps a mirror node path to its answer; a function answers with a
/// throw. `index` is the committed snapshot the build would inline as
/// `HCS_INDEX`; left out, the global is undefined, which is what a build with
/// no `deployments/hcs-index.json` looks like to the page.
function harness(pages, {index} = {}) {
    const requests = [];
    const Venue = {
        mirror: async (path) => {
            requests.push(path);
            if (!Object.prototype.hasOwnProperty.call(pages, path)) {
                throw new Error("unexpected path " + path);
            }
            const answer = pages[path];
            return typeof answer === "function" ? answer() : answer;
        },
    };
    const context = {
        Venue,
        HCS: {topicId},
        decode: JSON.parse,
        validate: (rec) => {
            if (!rec || typeof rec !== "object" || typeof rec.k !== "string") throw new Error("not a record");
            return rec;
        },
        LIVENESS_KINDS: ["checkpoint", "anchor"],
        TextDecoder,
        Uint8Array,
        atob,
        encodeURIComponent,
    };
    if (index !== undefined) context.HCS_INDEX = index;
    runInNewContext(source, context);
    return {Venue, requests};
}

const snapshot = (over = {}) => ({
    topicId,
    throughSequence: 3,
    runningHash: "rh3",
    messages: 3,
    unreadable: 0,
    digest: "0xd1",
    builtAt: "2026-09-10T00:00:00.000Z",
    actions: [{seq: 1, at: "1.0", rec: {k: "charge"}}, {seq: 2, at: "2.0", rec: {k: "silence"}}],
    liveness: [{seq: 3, at: "3.0", rec: {k: "checkpoint"}}],
    ...over,
});

// ------------------------------------------------------ straight off the topic

test("checkpoint traffic cannot push action receipts out of the topic panel", async () => {
    const newest = [];
    for (let seq = 133; seq >= 34; seq--) newest.push(message(seq, "checkpoint"));
    const oldest = [];
    for (let seq = 33; seq >= 3; seq--) oldest.push(message(seq, "checkpoint"));
    oldest.push(message(2, "silence"), message(1, "charge"));

    const {Venue, requests} = harness({
        [first]: {messages: newest, links: {next: second}},
        [second]: {messages: oldest, links: {next: null}},
    });
    const state = await Venue.readTopic();

    assert.deepEqual(requests, [first, second]);
    assert.equal(state.total, 133);
    assert.equal(state.records.filter((row) => row.rec.k === "checkpoint").length, 16);
    assert.deepEqual(
        Array.from(
            state.records.filter((row) => row.rec.k !== "checkpoint"),
            (row) => row.seq,
        ),
        [2, 1],
    );
    assert.equal(state.snapshot, null);
    assert.equal(state.fallback, null);
    assert.equal(state.live, 133);
});

test("anchors share the liveness bound with checkpoints", async () => {
    const messages = [];
    for (let seq = 60; seq >= 1; seq--) {
        messages.push(message(seq, seq % 3 === 0 ? "anchor" : seq % 3 === 1 ? "checkpoint" : "charge"));
    }
    const {Venue} = harness({[first]: {messages, links: {next: null}}});
    const state = await Venue.readTopic();
    const kinds = state.records.map((row) => row.rec.k);
    assert.equal(kinds.filter((k) => k === "charge").length, 20);
    assert.equal(kinds.filter((k) => k === "anchor" || k === "checkpoint").length, 16);
    assert.ok(kinds.includes("anchor") && kinds.includes("checkpoint"));
    const seqs = plain(state.records.map((row) => row.seq));
    assert.deepEqual(seqs, [...seqs].sort((a, b) => b - a));
});

test("a repeated mirror cursor is refused", async () => {
    const {Venue} = harness({
        [first]: {messages: [], links: {next: first}},
    });
    await assert.rejects(Venue.readTopic(), /invalid topic cursor/);
});

// ------------------------------------------------- the snapshot plus its tail

test("with a snapshot the panel fetches its head back and then only the tail", async () => {
    const {Venue, requests} = harness({
        [base + "/3"]: {sequence_number: 3, running_hash: "rh3"},
        [tailFrom(4)]: {messages: [message(4, "anchor"), message(5, "charge")], links: {next: null}},
    }, {index: snapshot()});
    const state = await Venue.readTopic();
    assert.deepEqual(requests, [base + "/3", tailFrom(4)]);
    assert.deepEqual(plain(state.records.map((row) => row.seq)), [5, 4, 3, 2, 1]);
    assert.deepEqual(plain(state.records.map((row) => row.rec.k)), ["charge", "anchor", "checkpoint", "silence", "charge"]);
    assert.deepEqual(plain(state.snapshot), {through: 3, builtAt: "2026-09-10T00:00:00.000Z", digest: "0xd1"});
    assert.equal(state.live, 2);
    assert.equal(state.total, 5);
    assert.equal(state.unreadable, 0);
    assert.equal(state.truncated, false);
    assert.equal(state.fallback, null);
});

test("a snapshot whose running hash the topic does not carry is set aside for a full read", async () => {
    const {Venue, requests} = harness({
        [base + "/3"]: {sequence_number: 3, running_hash: "somebody else's"},
        [first]: {messages: [message(9, "charge"), message(8, "checkpoint")], links: {next: null}},
    }, {index: snapshot()});
    const state = await Venue.readTopic();
    assert.deepEqual(requests, [base + "/3", first]);
    assert.deepEqual(plain(state.records.map((row) => row.seq)), [9, 8]);
    assert.equal(state.snapshot, null);
    assert.match(state.fallback, /running hash at #3 is not the snapshot's/);
});

test("a snapshot whose head the mirror node lacks is set aside too", async () => {
    const {Venue, requests} = harness({
        [base + "/3"]: () => { throw new Error("Mirror node answered 404 for " + base + "/3"); },
        [first]: {messages: [message(1, "charge")], links: {next: null}},
    }, {index: snapshot()});
    const state = await Venue.readTopic();
    assert.deepEqual(requests, [base + "/3", first]);
    assert.match(state.fallback, /404/);
});

test("a snapshot for another topic is not consulted", async () => {
    const {Venue, requests} = harness({
        [first]: {messages: [message(1, "charge")], links: {next: null}},
    }, {index: snapshot({topicId: "0.0.9"})});
    const state = await Venue.readTopic();
    assert.deepEqual(requests, [first]);
    assert.equal(state.snapshot, null);
    assert.equal(state.fallback, null);
});

test("a null snapshot is the no-snapshot path", async () => {
    const {Venue, requests} = harness({
        [first]: {messages: [], links: {next: null}},
    }, {index: null});
    await Venue.readTopic();
    assert.deepEqual(requests, [first]);
});

test("snapshot records that fail validation are counted, not rendered", async () => {
    const {Venue} = harness({
        [base + "/3"]: {sequence_number: 3, running_hash: "rh3"},
        [tailFrom(4)]: {messages: [], links: {next: null}},
    }, {index: snapshot({
        actions: [{seq: 1, at: "1.0", rec: {k: "charge"}}, {seq: 2, at: "2.0", rec: "junk"}],
        unreadable: 4,
    })});
    const state = await Venue.readTopic();
    assert.deepEqual(plain(state.records.map((row) => row.seq)), [3, 1]);
    assert.equal(state.unreadable, 5);
    assert.equal(state.live, 0);
});

test("a tail past the scan limit is cut short and says so rather than failing the panel", async () => {
    const pages = {[base + "/3"]: {sequence_number: 3, running_hash: "rh3"}};
    for (let page = 0; page < 12; page++) {
        pages[tailFrom(4 + page)] = {
            messages: [message(4 + page, "checkpoint")],
            links: {next: tailFrom(5 + page)},
        };
    }
    const {Venue, requests} = harness(pages, {index: snapshot()});
    const state = await Venue.readTopic();
    assert.equal(requests.length, 11);
    assert.equal(state.truncated, true);
    assert.equal(state.live, 10);
    assert.equal(state.snapshot.through, 3);
});

test("the selection applies across snapshot and tail together", async () => {
    const actions = [];
    for (let seq = 1; seq <= 50; seq++) actions.push({seq, at: seq + ".0", rec: {k: "charge"}});
    const {Venue} = harness({
        [base + "/50"]: {sequence_number: 50, running_hash: "rh50"},
        [tailFrom(51)]: {messages: [message(51, "charge"), message(52, "anchor")], links: {next: null}},
    }, {index: snapshot({throughSequence: 50, runningHash: "rh50", messages: 50, actions, liveness: []})});
    const state = await Venue.readTopic();
    const seqs = plain(state.records.map((row) => row.seq));
    assert.equal(seqs.length, 45);
    assert.deepEqual(seqs.slice(0, 2), [52, 51]);
    assert.equal(seqs[seqs.length - 1], 8);
    assert.equal(state.total, 52);
});
