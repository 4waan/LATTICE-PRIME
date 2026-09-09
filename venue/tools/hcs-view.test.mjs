import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

const source = readFileSync(new URL("./hcs-view.mjs", import.meta.url), "utf8");
const topicId = "0.0.123";
const first = "/api/v1/topics/0.0.123/messages?order=desc&limit=100";
const second = "/api/v1/topics/0.0.123/messages?order=desc&limit=100&sequencenumber=lt:34";

const message = (seq, kind) => ({
    sequence_number: seq,
    consensus_timestamp: `${seq}.000000000`,
    message: Buffer.from(JSON.stringify({k: kind})).toString("base64"),
});

function harness(pages) {
    const requests = [];
    const Venue = {
        mirror: async (path) => {
            requests.push(path);
            if (!Object.prototype.hasOwnProperty.call(pages, path)) {
                throw new Error("unexpected path " + path);
            }
            return pages[path];
        },
    };
    runInNewContext(source, {
        Venue,
        HCS: {topicId},
        decode: JSON.parse,
        TextDecoder,
        Uint8Array,
        atob,
        encodeURIComponent,
    });
    return {Venue, requests};
}

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
});

test("a repeated mirror cursor is refused", async () => {
    const {Venue} = harness({
        [first]: {messages: [], links: {next: first}},
    });
    await assert.rejects(Venue.readTopic(), /invalid topic cursor/);
});
