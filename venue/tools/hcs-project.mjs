// The projection: the topic, replayed in order, folded into the shape a reader
// asks questions of.
//
// The topic is an ordered record and not a database. It has no query, no index
// and no "current value": to know what the venue has said, a reader replays the
// messages in sequence and derives it. That replay is this file, and it is pure
// on purpose. `tools/hcs-index.mjs` feeds it messages off the mirror node and
// writes the result to `deployments/hcs-index.json`; `tools/hcs-verify.mjs`
// feeds it the same messages and demands the same result; the vectors feed it
// fixtures. Three callers, one fold, so "what the index says" and "what the
// topic says" cannot drift apart without a table saying so.
//
// Two properties the fold keeps, because they are what make a projection worth
// committing to a repository:
//
// **Deterministic.** Same messages in, same bytes out. Nothing here reads a
// clock, and `builtAt`, the one field that does, is stamped by the caller and
// left out of every comparison. `extend(project(a), b)` equals `project(a ++ b)`
// byte for byte, which is what lets the index catch up from where it stopped
// instead of re-reading the topic from sequence one.
//
// **Self-describing.** The projection carries `throughSequence`, the mirror
// node's `running_hash` at that sequence, and its own chained `digest` over the
// message bytes. A reader with the topic can rebuild the digest; a reader with
// only the mirror node can compare the running hash; and neither has to trust
// the file to know whether it is the topic.
import {keccak256, toUtf8Bytes} from "ethers";
import {LIVENESS_KINDS, decode, encode} from "./hcs.mjs";

export const PROJECTION_SCHEMA = 1;

/// How many of the newest records the page-side snapshot carries. The Rulebook
/// screen shows 44 action receipts and 16 liveness records; the snapshot carries
/// more than that so a tail of anchors cannot push a silence off the page before
/// the screen has applied its own selection.
export const COMPACT_ACTIONS = 200;
export const COMPACT_LIVENESS = 32;

/// The digest starts from a fixed string rather than from zero so that a digest
/// over no messages is still a value nobody could have produced by accident.
export const DIGEST_SEED = keccak256(toUtf8Bytes("lattice-prime hcs-index digest v1"));

const LIVENESS = new Set(LIVENESS_KINDS);

const hex = (buf) => Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
const bytesOf = (m) => Buffer.from(String(m.message || ""), "base64");
const u64 = (n) => BigInt(n).toString(16).padStart(16, "0");

/// One step of the chained digest: keccak256(previous || seq as uint64 || bytes).
/// Sequence number in the preimage so two messages with the same bytes at two
/// positions, which the topic permits and the relay never writes, digest apart.
export function digestStep(previous, seq, messageBytes) {
    return keccak256("0x" + String(previous).replace(/^0x/, "") + u64(seq) + hex(messageBytes));
}

/// The digest of a whole listing, from the seed. `hcs-verify` uses this against
/// the messages it fetched itself; the index never calls it, because the index
/// extends rather than recomputes, and the two agreeing is the test.
export function digestOf(messages) {
    let d = DIGEST_SEED;
    for (const m of messages) d = digestStep(d, m.sequence_number, bytesOf(m));
    return d;
}

/// A projection with nothing in it.
export function empty(topicId) {
    const perSource = () => ({});
    return {
        schema: PROJECTION_SCHEMA,
        topicId: String(topicId),
        throughSequence: 0,
        throughConsensus: null,
        runningHash: null,
        runningHashVersion: null,
        digest: DIGEST_SEED,
        messages: 0,
        kinds: {},
        unreadable: [],
        actions: [],
        checkpoints: perSource(),
        anchors: perSource(),
        coverage: perSource(),
        latest: perSource(),
    };
}

/// Fold `messages`, which must continue exactly where `prev` stopped, into a
/// new projection. `prev` is not mutated.
///
/// The mirror node hands back sequence numbers that are dense and ascending,
/// so a tail that does not start at `throughSequence + 1`, or that skips or
/// repeats a number, is a listing this fold refuses rather than absorbs: a
/// projection with a hole in it would digest fine and mean nothing.
export function extend(prev, messages) {
    const out = clone(prev);
    for (const m of messages) {
        const seq = Number(m.sequence_number);
        if (!Number.isInteger(seq) || seq !== out.throughSequence + 1) {
            throw new Error(`topic messages must be contiguous: got sequence ${m.sequence_number} after ${out.throughSequence}`);
        }
        const chunked = m.chunk_info && Number(m.chunk_info.total || 1) !== 1;
        const bytes = bytesOf(m);
        out.digest = digestStep(out.digest, seq, bytes);
        out.throughSequence = seq;
        out.throughConsensus = String(m.consensus_timestamp);
        out.runningHash = m.running_hash === undefined ? null : m.running_hash;
        out.runningHashVersion = m.running_hash_version === undefined ? null : Number(m.running_hash_version);
        out.messages++;

        let rec;
        try {
            if (chunked) throw new Error("a chunked message is not one receipt");
            rec = decode(bytes.toString("utf8"));
        } catch (e) {
            out.unreadable.push({seq, reason: String(e && e.message || e)});
            continue;
        }
        out.kinds[rec.k] = (out.kinds[rec.k] || 0) + 1;
        // A plain object in canonical field order, off the canonical bytes, so
        // the projection serialises the same way the topic does.
        const plain = JSON.parse(encode(rec));
        const row = {seq, at: out.throughConsensus, rec: plain};
        if (!LIVENESS.has(rec.k)) {
            out.actions.push(row);
            continue;
        }
        const src = rec.c;
        if (rec.k === "checkpoint") {
            (out.checkpoints[src] = out.checkpoints[src] || []).push(row);
        } else {
            (out.anchors[src] = out.anchors[src] || []).push(row);
        }
        out.latest[src] = {
            seq, at: out.throughConsensus, kind: rec.k,
            epoch: rec.k === "checkpoint" ? rec.e : rec.to,
        };
    }
    for (const src of new Set([...Object.keys(out.checkpoints), ...Object.keys(out.anchors)])) {
        out.coverage[src] = coverageOf(out.checkpoints[src] || [], out.anchors[src] || []);
    }
    return out;
}

/// A projection over a whole listing: `extend` from nothing.
export function project(topicId, messages) {
    return extend(empty(topicId), messages);
}

/// What one source's liveness records add up to: the epochs its checkpoints
/// print, as ranges; the epochs its anchors cover, as ranges, so a gap between
/// two anchors is visible as two ranges and not as a number that quietly grew;
/// and the last epoch anything covers.
function coverageOf(checkpoints, anchors) {
    const cpEpochs = [...new Set(checkpoints.map((x) => x.rec.e))].sort((a, b) => a - b);
    const anchorRanges = mergeRanges(anchors.map((x) => [x.rec.from, x.rec.to]));
    const lastAnchor = anchors.reduce((m, x) => (x.rec.to > m ? x.rec.to : m), -1);
    const lastCheckpoint = cpEpochs.length ? cpEpochs[cpEpochs.length - 1] : -1;
    const through = Math.max(lastAnchor, lastCheckpoint);
    return {
        checkpointEpochs: toRanges(cpEpochs),
        anchorRanges,
        anchoredThrough: lastAnchor >= 0 ? lastAnchor : null,
        coveredThrough: through >= 0 ? through : null,
    };
}

/// Sorted distinct integers to `[from, to]` runs.
export function toRanges(sorted) {
    const out = [];
    for (const e of sorted) {
        const last = out[out.length - 1];
        if (last && e === last[1] + 1) last[1] = e;
        else if (!last || e > last[1]) out.push([e, e]);
    }
    return out;
}

/// Merge touching or overlapping `[from, to]` ranges, sorted by start.
export function mergeRanges(ranges) {
    const sorted = ranges.map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const out = [];
    for (const r of sorted) {
        const last = out[out.length - 1];
        if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
        else out.push(r);
    }
    return out;
}

/// The subset of a projection a page boots from. Counts and coverage in full,
/// records bounded, `unreadable` as a count. The page merges the live tail on
/// top and applies its own selection.
export function compact(p) {
    const liveness = [];
    for (const src of Object.keys(p.checkpoints)) liveness.push(...p.checkpoints[src]);
    for (const src of Object.keys(p.anchors)) liveness.push(...p.anchors[src]);
    liveness.sort((a, b) => a.seq - b.seq);
    return {
        schema: p.schema,
        topicId: p.topicId,
        builtAt: p.builtAt === undefined ? null : p.builtAt,
        throughSequence: p.throughSequence,
        throughConsensus: p.throughConsensus,
        runningHash: p.runningHash,
        digest: p.digest,
        messages: p.messages,
        kinds: p.kinds,
        unreadable: p.unreadable.length,
        actions: p.actions.slice(-COMPACT_ACTIONS),
        liveness: liveness.slice(-COMPACT_LIVENESS),
        coverage: p.coverage,
        latest: p.latest,
    };
}

/// Everything a comparison should ignore: the build timestamp and the note.
export function comparable(p) {
    const {builtAt, note, ...rest} = p;
    return rest;
}

/// Two projections say the same thing when their comparable halves serialise to
/// the same bytes. JSON, so a null-prototype record and a plain one agree.
export function same(a, b) {
    return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
}

function clone(p) {
    const j = JSON.parse(JSON.stringify(p));
    // Field defaults, so a projection written by an older build still extends.
    j.kinds = j.kinds || {};
    j.unreadable = j.unreadable || [];
    j.actions = j.actions || [];
    j.checkpoints = j.checkpoints || {};
    j.anchors = j.anchors || {};
    j.coverage = j.coverage || {};
    j.latest = j.latest || {};
    j.throughSequence = Number(j.throughSequence) || 0;
    j.messages = Number(j.messages) || 0;
    j.digest = j.digest || DIGEST_SEED;
    return j;
}
