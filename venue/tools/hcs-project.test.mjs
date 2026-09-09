// The projection is what the Issuer screen boots from and what `hcs-verify`
// rebuilds to check it, so its two promises are tested here rather than
// asserted: the fold is deterministic, and extending a projection with a tail
// is the same as projecting the whole listing.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {keccak256} from "ethers";
import {
    SCHEMA_VERSION, encode, anchorPreimage,
} from "./hcs.mjs";
import {
    DIGEST_SEED, COMPACT_ACTIONS, COMPACT_LIVENESS,
    project, extend, empty, digestOf, compact, comparable, same, toRanges, mergeRanges,
} from "./hcs-project.mjs";

const client = JSON.parse(readFileSync(new URL("../deployments/client.json", import.meta.url), "utf8"));
const ENGINE = client.addresses.MatchingEngine.toLowerCase();
const VAULT = client.addresses.RepoVault.toLowerCase();

const TX_A = "0xa7e2287bec0fadcdeccc3c3484acab1d081eae2a6eca219b20b76b80c41950f3";
const TX_B = "0x2885d8da867b1cab43863698895a2bf78fb35114743a33849ba5f771cc707594";

const charge = {v: SCHEMA_VERSION, k: "charge", c: "engine", a: ENGINE, tx: TX_A, li: 0, r: 15, e: 39, g: 1, cost: 1, after: 1};
const silence = {v: SCHEMA_VERSION, k: "silence", c: "engine", a: ENGINE, tx: TX_B, sel: "0xc4d252f5", fn: "cancel", r: 15, e: 39, spent: 1, budget: 1};
const checkpoint = (e) => ({v: SCHEMA_VERSION, k: "checkpoint", c: "engine", a: ENGINE, e, blk: 1000 + e, rows: {3: 0, 15: e === 39 ? 1 : 0}});
const vaultCheckpoint = (e) => ({v: SCHEMA_VERSION, k: "checkpoint", c: "vault", a: VAULT, e, blk: 1000 + e, rows: {7: 0, 14: 0, 16: 0}});
const rows = [3, 4, 12, 13, 15, 17];
const anchor = (from, to) => ({
    v: SCHEMA_VERSION, k: "anchor", c: "engine", a: ENGINE, from, to, blk: 5000 + to, rows,
    h: keccak256(anchorPreimage(from, to, rows, () => 0)),
});

let ts = 1788643884;
const message = (seq, rec, extra = {}) => ({
    sequence_number: seq,
    consensus_timestamp: `${ts++}.000000000`,
    message: Buffer.from(typeof rec === "string" ? rec : encode(rec)).toString("base64"),
    running_hash: Buffer.from(String(seq).padStart(48, "r")).toString("base64"),
    running_hash_version: 3,
    chunk_info: {number: 1, total: 1},
    ...extra,
});

const listing = [
    message(1, charge),
    message(2, silence),
    message(3, checkpoint(39)),
    message(4, vaultCheckpoint(39)),
    message(5, "not a record at all"),
    message(6, checkpoint(321)),
    message(7, anchor(943, 954)),
    message(8, anchor(955, 966)),
    message(9, anchor(980, 991)),
];

test("a listing folds into counts, actions, liveness and coverage", () => {
    const p = project("0.0.123", listing);
    assert.equal(p.topicId, "0.0.123");
    assert.equal(p.throughSequence, 9);
    assert.equal(p.messages, 9);
    assert.equal(p.throughConsensus, listing[8].consensus_timestamp);
    assert.equal(p.runningHash, listing[8].running_hash);
    assert.equal(p.runningHashVersion, 3);
    assert.deepEqual(p.kinds, {charge: 1, silence: 1, checkpoint: 3, anchor: 3});
    assert.deepEqual(p.unreadable.map((x) => x.seq), [5]);
    assert.match(p.unreadable[0].reason, /not JSON/);
    assert.deepEqual(p.actions.map((x) => x.seq), [1, 2]);
    assert.deepEqual(p.actions[0].rec, JSON.parse(encode(charge)));
    assert.deepEqual(Object.keys(p.actions[0].rec), ["v", "k", "c", "a", "tx", "li", "r", "e", "g", "cost", "after"]);
    assert.deepEqual(p.checkpoints.engine.map((x) => x.rec.e), [39, 321]);
    assert.deepEqual(p.checkpoints.vault.map((x) => x.rec.e), [39]);
    assert.deepEqual(p.anchors.engine.map((x) => [x.rec.from, x.rec.to]), [[943, 954], [955, 966], [980, 991]]);
    assert.deepEqual(p.coverage.engine, {
        checkpointEpochs: [[39, 39], [321, 321]],
        anchorRanges: [[943, 966], [980, 991]],
        anchoredThrough: 991,
        coveredThrough: 991,
    });
    assert.deepEqual(p.coverage.vault, {
        checkpointEpochs: [[39, 39]],
        anchorRanges: [],
        anchoredThrough: null,
        coveredThrough: 39,
    });
    assert.deepEqual(p.latest.engine, {seq: 9, at: listing[8].consensus_timestamp, kind: "anchor", epoch: 991});
    assert.deepEqual(p.latest.vault, {seq: 4, at: listing[3].consensus_timestamp, kind: "checkpoint", epoch: 39});
    assert.equal(p.digest, digestOf(listing));
    assert.notEqual(p.digest, DIGEST_SEED);
});

test("the fold is deterministic", () => {
    assert.equal(JSON.stringify(project("0.0.123", listing)), JSON.stringify(project("0.0.123", listing)));
});

test("extending a projection with a tail equals projecting the whole listing", () => {
    for (const cut of [0, 1, 4, 5, 8, 9]) {
        const head = project("0.0.123", listing.slice(0, cut));
        const whole = extend(head, listing.slice(cut));
        assert.ok(same(whole, project("0.0.123", listing)), `cut at ${cut}`);
        assert.equal(JSON.stringify(whole), JSON.stringify(project("0.0.123", listing)), `bytes at ${cut}`);
    }
});

test("extend does not mutate the projection it was given", () => {
    const head = project("0.0.123", listing.slice(0, 3));
    const before = JSON.stringify(head);
    extend(head, listing.slice(3));
    assert.equal(JSON.stringify(head), before);
});

test("a tail that does not continue the sequence is refused", () => {
    const head = project("0.0.123", listing.slice(0, 3));
    assert.throws(() => extend(head, listing.slice(4)), /contiguous: got sequence 5 after 3/);
    assert.throws(() => extend(head, listing.slice(2)), /contiguous: got sequence 3 after 3/);
    assert.throws(() => project("0.0.123", [listing[1]]), /contiguous: got sequence 2 after 0/);
});

test("an unreadable message is counted, digested, and never rendered", () => {
    const p = project("0.0.123", [message(1, charge), message(2, "{}")]);
    assert.equal(p.messages, 2);
    assert.equal(p.unreadable.length, 1);
    assert.deepEqual(p.kinds, {charge: 1});
    assert.equal(p.digest, digestOf([message(1, charge), message(2, "{}")]));
    assert.notEqual(p.digest, digestOf([message(1, charge)]));
});

test("a chunked message is unreadable even when its bytes parse", () => {
    const p = project("0.0.123", [message(1, charge, {chunk_info: {number: 1, total: 2}})]);
    assert.equal(p.unreadable.length, 1);
    assert.match(p.unreadable[0].reason, /chunked/);
    assert.deepEqual(p.kinds, {});
});

test("the digest chains over sequence number and bytes", () => {
    const a = [message(1, charge), message(2, silence)];
    const b = [message(1, silence), message(2, charge)];
    assert.notEqual(digestOf(a), digestOf(b));
    assert.equal(digestOf([]), DIGEST_SEED);
    assert.equal(project("0.0.123", []).digest, DIGEST_SEED);
});

test("the compact snapshot is bounded and carries counts, coverage and the latest liveness", () => {
    const many = [];
    let seq = 1;
    for (let i = 0; i < COMPACT_ACTIONS + 10; i++) {
        many.push(message(seq++, {...charge, li: i}));
    }
    for (let i = 0; i < COMPACT_LIVENESS + 5; i++) many.push(message(seq++, checkpoint(400 + i)));
    many.push(message(seq++, "garbage"));
    const p = project("0.0.123", many);
    p.builtAt = "2026-09-10T00:00:00.000Z";
    const c = compact(p);
    assert.equal(c.actions.length, COMPACT_ACTIONS);
    assert.equal(c.actions[c.actions.length - 1].rec.li, COMPACT_ACTIONS + 9);
    assert.equal(c.liveness.length, COMPACT_LIVENESS);
    assert.equal(c.liveness[c.liveness.length - 1].rec.e, 400 + COMPACT_LIVENESS + 4);
    assert.equal(c.unreadable, 1);
    assert.equal(c.throughSequence, seq - 1);
    assert.equal(c.builtAt, "2026-09-10T00:00:00.000Z");
    assert.equal(c.digest, p.digest);
    assert.equal(c.runningHash, p.runningHash);
    assert.deepEqual(c.coverage.engine.checkpointEpochs, [[400, 400 + COMPACT_LIVENESS + 4]]);
    assert.equal(c.latest.engine.kind, "checkpoint");
    assert.equal(compact(empty("0.0.1")).builtAt, null);
});

test("comparison ignores the build time and the note", () => {
    const a = project("0.0.123", listing);
    const b = {...project("0.0.123", listing), builtAt: "later", note: "generated"};
    assert.ok(same(a, b));
    assert.equal(comparable(b).builtAt, undefined);
    assert.equal(comparable(b).note, undefined);
    const c = extend(a, [message(10, checkpoint(322))]);
    assert.ok(!same(a, c));
});

test("ranges", () => {
    assert.deepEqual(toRanges([]), []);
    assert.deepEqual(toRanges([1, 2, 3, 7, 9, 10]), [[1, 3], [7, 7], [9, 10]]);
    assert.deepEqual(mergeRanges([[5, 6], [1, 2], [3, 4], [10, 12], [11, 15]]), [[1, 6], [10, 15]]);
    assert.deepEqual(mergeRanges([]), []);
});
