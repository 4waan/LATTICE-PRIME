// Read the topic back and check every record against the chain.
//
//   node tools/hcs-verify.mjs             # the table, and a non-zero exit on a mismatch
//   node tools/hcs-verify.mjs --json      # the same result as JSON
//   node tools/hcs-verify.mjs --since 900 # skip anchors and checkpoints that close before epoch 900
//
// This is the piece that makes the topic evidence rather than decoration.
// `tools/hcs-relay.mjs` holds the submit key, so a reader has no reason to take
// its word for anything; this takes nothing on its word. It fetches every
// record's transaction back from the mirror node, decodes the log itself, and
// re-derives every number the record printed. Nothing here reads the relay's
// cursor, its logs, or its state.
//
// Four assertions, and the third is the one that matters.
//
//   1. **Shape.** Every message is one chunk, parses under `tools/hcs.mjs`, and
//      is byte for byte the canonical encoding of what it decodes to. A record
//      that cannot be reproduced is not a receipt.
//   2. **A charge names a real log.** Row, epoch, granularity, cost and running
//      total have to match the log at that transaction and index, emitted by the
//      contract the record names. **The relay cannot forge.**
//   3. **The sums reconcile.** For every closed epoch the topic checkpointed,
//      the published charges on a row have to add up to `spentBits(row, epoch)`
//      read off the contract. That number is written by the venue and not by the
//      relay, so a dropped charge breaks arithmetic the relay does not control.
//      **The relay cannot silently omit.**
//   4. **A silence is a real silence.** The transaction succeeded, its calldata
//      carries the selector the record names, the row it claims was withheld
//      carries no charge in that transaction, and the budget it names is the one
//      `ParameterRoot` publishes.
//   5. **An anchor is the chain's own hash.** Anchors tile the epochs without a
//      gap or an overlap, none reaches into an epoch that was still open when it
//      was written, and every `spentBits` cell in the range, read back off the
//      contract, hashes to the `h` the record carries. Inside an anchored range
//      every cell also has to equal the charges the topic published for it, so
//      the omission check in (3) holds for every epoch and not only for the
//      epochs the relay printed a checkpoint for.
//   6. **The index is the topic.** If `deployments/hcs-index.json` exists, its
//      digest, its `running_hash` and its projection are rebuilt from the topic
//      and compared. That is the "rebuild the state from the mirror node and
//      compare it against what your application believes" test, run against the
//      one artefact the app boots from.
//
// What it cannot check is liveness. A relay that stops publishes nothing false;
// it publishes nothing. The anchor series makes the gap visible and no test
// here can close it, which is stated in `docs/HCS-SCOPE.md` rather than hidden
// behind a passing table.
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {keccak256} from "ethers";
import {
    ROOT, client, mirror, paged, epochAt, reader, readTopic, policyHistory, effectiveFrom,
} from "./hcs-chain.mjs";
import {bits} from "./lattice.mjs";
import {
    SITES, SOURCE_ADDRESS_KEY, MAX_CHUNK,
    auditRecord, auditAnchor, decode, encode, keyOf, RecordError,
    assertSiteAddresses, assertSiteDeployments,
} from "./hcs.mjs";
import {project, digestOf, same, comparable} from "./hcs-project.mjs";

const INDEX_PATH = join(ROOT, "deployments/hcs-index.json");

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
// Anchors and checkpoints that close before this epoch are listed but not read
// back. Every anchored epoch costs one `eth_call` per row to re-derive, so a
// long history is bounded here rather than by giving up on the check.
const SINCE = (() => {
    const i = args.indexOf("--since");
    const v = i >= 0 ? Number(args[i + 1]) : 0;
    return Number.isInteger(v) && v >= 0 ? v : 0;
})();

const c = client();
assertSiteAddresses(c.addresses);
const topic = readTopic();
if (!topic || !topic.topicId) {
    console.error("no deployments/hcs.json. Run `make hcs-topic` first.");
    process.exit(1);
}

const EPOCH_ORIGIN = Number(c.clocks.disclosure.origin);
const EPOCH_PERIOD = Number(c.clocks.disclosure.period);

const chain = reader(c.network.rpc, c.network.chainId);
await assertSiteDeployments(c.addresses, (address) => chain.provider.getCode(address), keccak256);
const meterCache = new Map();
function meterAt(src, address) {
    const key = `${src}:${String(address).toLowerCase()}`;
    if (!meterCache.has(key)) {
        meterCache.set(
            key,
            chain.at(address, SOURCE_ADDRESS_KEY[src]),
        );
    }
    return meterCache.get(key);
}
const params = chain.at(c.addresses.ParameterRoot, "ParameterRoot");

// The epoch the parameter set in force took effect. `budgetFor` reads current
// state, so a silence claimed before this boundary was measured against a bound
// that was not in force when the transaction ran, and neither half of this
// system is allowed to publish or accept one.
const POLICY_FROM = effectiveFrom(
    await policyHistory(c.network.mirror, c.addresses.ParameterRoot), await params.root());

const checks = [];
const note = (name, passed, detail) => {
    checks.push({name, pass: !!passed, detail: detail || ""});
    return !!passed;
};

// ------------------------------------------------------------- the messages

const raw = await paged(
    c.network.mirror,
    `/api/v1/topics/${encodeURIComponent(topic.topicId)}/messages?order=asc&limit=100`,
    "messages");

const records = [];
let lastSeq = 0;
for (const m of raw) {
    const seq = Number(m.sequence_number);
    const where = `sequence ${seq}`;
    // A chunked record would carry one logical receipt under several sequence
    // numbers, and a receipt a reader has to reassemble is not one they can
    // cite. `hcs.mjs` refuses to encode one; this refuses to accept one.
    const chunked = m.chunk_info && (Number(m.chunk_info.total || 1) !== 1);
    if (!note(`${where} is a single chunk`, !chunked)) continue;
    let text;
    try {
        text = Buffer.from(m.message, "base64").toString("utf8");
    } catch (e) {
        note(`${where} decodes from base64`, false, e.message);
        continue;
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (!note(`${where} is under ${MAX_CHUNK} bytes`, bytes <= MAX_CHUNK, `${bytes} bytes`)) continue;
    let rec;
    try {
        rec = decode(text);
    } catch (e) {
        note(`${where} parses and is canonical`, false,
            e instanceof RecordError ? e.message : String(e));
        continue;
    }
    note(`${where} parses and is canonical`, encode(rec) === text);
    note(`${where} follows ${lastSeq}`, seq > lastSeq, `got ${seq}`);
    lastSeq = seq;
    records.push({seq, rec, consensus: m.consensus_timestamp});
}

// A record written twice is not a forgery, but a reader counting charges would
// double count it, so the topic has to be free of them.
{
    const seen = new Map();
    let dupes = 0;
    for (const {seq, rec} of records) {
        const k = keyOf(rec);
        if (seen.has(k)) { dupes++; note(`sequence ${seq} repeats ${k}`, false, `first at ${seen.get(k)}`); }
        else seen.set(k, seq);
    }
    note("no record appears twice", dupes === 0, `${records.length} records`);
}

// ---------------------------------------------------- the transactions again

/// Every transaction a record names, fetched once, from the mirror node's own
/// index rather than from anything the relay wrote down.
const txCache = new Map();
async function resultOf(hash) {
    if (!txCache.has(hash)) {
        txCache.set(hash, mirror(c.network.mirror, `/api/v1/contracts/results/${encodeURIComponent(hash)}`)
            .catch((e) => ({__error: e.message})));
    }
    return txCache.get(hash);
}
await Promise.all([...new Set(records
    .filter(({rec}) =>
        rec.k === "charge" || rec.k === "refusal"
            || rec.k === "ceiling" || rec.k === "silence")
    .map(({rec}) => rec.tx))].map(resultOf));

const addressOf = (rec) =>
    String(rec.a || c.addresses[SOURCE_ADDRESS_KEY[rec.c]]).toLowerCase();

const budgetCache = new Map();
async function budgetOf(row) {
    if (!budgetCache.has(row)) {
        const b = await params.budgetFor(row);
        budgetCache.set(row, {
            domainBits: Number(b.domainBits), aggBits: Number(b.aggBits),
            bucketBits: Number(b.bucketBits), budgetBits: Number(b.budgetBits),
        });
    }
    return budgetCache.get(row);
}

const spentCache = new Map();
async function spentOf(src, address, row, epoch) {
    const at = String(address).toLowerCase();
    const key = `${src}:${at}:${row}:${epoch}`;
    if (!spentCache.has(key)) {
        spentCache.set(
            key,
            meterAt(src, at).spentBits(Number(row), Number(epoch)).then(Number),
        );
    }
    return spentCache.get(key);
}

// The record against the transaction, through `hcs.mjs`'s `auditRecord`. The
// comparison lives there rather than here so the Rulebook screen's tick and this
// table's `pass` are the same function, checked by the same vectors.
for (const {seq, rec} of records) {
    if (rec.k === "checkpoint" || rec.k === "anchor") continue;
    const where = `sequence ${seq} (${rec.k})`;
    const res = await resultOf(rec.tx);
    if (res.__error) {
        note(`${where} names a transaction the mirror node has`, false, res.__error);
        continue;
    }
    const ctx = {address: addressOf(rec)};
    if (rec.k !== "ceiling") {
        ctx.epoch = epochAt(res.timestamp, EPOCH_ORIGIN, EPOCH_PERIOD);
    }
    if (rec.k === "silence") {
        const b = await budgetOf(rec.r);
        ctx.budgetBits = b.budgetBits;
        ctx.cost = bits(b, SITES[rec.sel].rows.find((x) => x.row === rec.r).g);
        // A silence claimed before the parameter set in force took effect is
        // measured against a bound that was not in force. `hcs-relay.mjs`
        // refuses to publish one; this refuses to accept one.
        note(`${where} is not before the parameter set took effect`, rec.e >= POLICY_FROM,
            `adopted at epoch ${POLICY_FROM}`);
    }
    for (const x of auditRecord(rec, res, ctx)) note(`${where} ${x.name}`, x.pass, x.detail);
}

// ------------------------------------------------------- the arithmetic check

/// Charges grouped by the meter they were charged against. `spentBits` is per
/// contract, which is why a record carries `c`: a sum over both contracts would
/// reconcile against neither.
const byMeter = new Map();
for (const {seq, rec} of records) {
    if (rec.k !== "charge") continue;
    const k = `${rec.c}:${addressOf(rec)}:${rec.r}:${rec.e}`;
    if (!byMeter.has(k)) byMeter.set(k, []);
    byMeter.get(k).push({seq, ...rec});
}

const checkpoints = new Map();
const anchorsBySource = new Map();
for (const {seq, rec, consensus} of records) {
    if (rec.k === "checkpoint") {
        checkpoints.set(`${rec.c}:${addressOf(rec)}:${rec.e}`, rec);
    } else if (rec.k === "anchor") {
        const k = `${rec.c}:${addressOf(rec)}`;
        if (!anchorsBySource.has(k)) anchorsBySource.set(k, []);
        anchorsBySource.get(k).push({seq, rec, consensus});
    }
}

/// Whether an epoch sits inside a range some anchor on the topic covers. An
/// anchored epoch is held to the same exact equality a checkpointed one is.
const anchored = (src, address, epoch) =>
    (anchorsBySource.get(`${src}:${address}`) || [])
        .some(({rec}) => rec.from <= Number(epoch) && Number(epoch) <= rec.to);

/// What the topic says each cell spent: the end of the chained running totals
/// for every `(source, address, row, epoch)` that has at least one charge on
/// the topic. Cells absent from this map had nothing published for them.
const publishedTotal = new Map();

for (const [k, list] of byMeter) {
    const [src, address, row, epoch] = k.split(":");
    list.sort((a, b) => a.after - b.after);
    // The running totals in the logs themselves have to form an unbroken chain
    // from zero. A gap is a charge the topic does not carry.
    let running = 0;
    let chained = true;
    for (const x of list) {
        if (running + x.cost !== x.after) { chained = false; break; }
        running = x.after;
    }
    publishedTotal.set(k, running);
    note(`${src} row ${row} epoch ${epoch}: the running totals chain from zero`, chained,
        chained ? `${list.length} charge${list.length === 1 ? "" : "s"}, ${running} bits` : "a charge is missing");

    const onChain = await spentOf(src, address, row, epoch);
    const cp = checkpoints.get(`${src}:${address}:${epoch}`);
    if (cp || anchored(src, address, epoch)) {
        // The omission check. A closed epoch the topic checkpointed or anchored
        // has to add up, exactly, against a number the relay does not write.
        note(`${src} row ${row} epoch ${epoch}: published charges equal spentBits`,
            running === onChain, `published ${running}, spentBits ${onChain}`);
    } else {
        // An epoch still open, or one the relay has not anchored yet. It can
        // still not have published more than the chain shows.
        note(`${src} row ${row} epoch ${epoch}: published charges do not exceed spentBits`,
            running <= onChain, `published ${running}, spentBits ${onChain}`);
    }
    if (cp) {
        note(`${src} row ${row} epoch ${epoch}: the checkpoint agrees with spentBits`,
            Number(cp.rows[row] || 0) === onChain, `checkpoint ${cp.rows[row]}, spentBits ${onChain}`);
    }
}

// Every checkpoint, including the epochs no charge landed in: a checkpoint that
// claims a row was quiet when the meter says otherwise is the same omission
// dressed differently.
const checkpointReads = [];
let skippedCheckpoints = 0;
for (const cp of checkpoints.values()) {
    if (cp.e < SINCE) { skippedCheckpoints++; continue; }
    for (const row of Object.keys(cp.rows)) {
        checkpointReads.push({cp, row});
    }
}
// Keep each wave within the JSON-RPC reader's batch size. This is the same set
// of independent eth_calls as the serial verifier, but one network round trip
// per wave instead of one per row.
for (let i = 0; i < checkpointReads.length; i += 50) {
    const wave = checkpointReads.slice(i, i + 50);
    const values = await Promise.all(
        wave.map(({cp, row}) => spentOf(cp.c, addressOf(cp), row, cp.e))
    );
    for (let j = 0; j < wave.length; ++j) {
        const {cp, row} = wave[j];
        const onChain = values[j];
        note(
            `${cp.c} checkpoint epoch ${cp.e} row ${row}`,
            Number(cp.rows[row]) === onChain,
            `checkpoint ${cp.rows[row]}, spentBits ${onChain}`,
        );
    }
}

// ------------------------------------------------------------------ anchors
//
// An anchor is one hash over every `spentBits` cell in a closed range of
// epochs. Three things have to hold. The anchors on the topic tile: each one
// starts the epoch after the previous one ended, so no epoch is covered twice
// and no epoch between the first anchor and the last is covered by nothing.
// None reaches into an epoch that was still open at its consensus timestamp,
// because an open epoch's cells can still move. And the cells, read back off
// the contract, hash to the `h` the record carries, which is `auditAnchor`, the
// same function the vectors in `tools/hcs.test.mjs` hold to fixture cells.
//
// Reading the cells back also answers the omission question for every epoch in
// the range: a cell the contract says was charged must have exactly that much
// published for it on the topic, and a cell with nothing published must be
// zero. That is one assertion per anchor here, with the mismatching cells named
// in the detail, rather than one per cell, because a day's anchor is 2,592
// cells and a table of 2,592 identical passes hides the one that failed.
let skippedAnchors = 0;
for (const [k, list] of anchorsBySource) {
    const [src, address] = k.split(":");
    list.sort((a, b) => a.rec.from - b.rec.from || a.seq - b.seq);
    for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1].rec;
        const cur = list[i].rec;
        note(`${src} anchor ${cur.from}-${cur.to} follows ${prev.from}-${prev.to} without gap or overlap`,
            cur.from === prev.to + 1,
            cur.from === prev.to + 1 ? "" : `starts at ${cur.from}, the previous ended at ${prev.to}`);
    }
    for (const {seq, rec, consensus} of list) {
        const where = `sequence ${seq} (${src} anchor ${rec.from}-${rec.to})`;
        if (rec.to < SINCE) { skippedAnchors++; continue; }
        const cells = new Map();
        const wanted = [];
        for (let e = rec.from; e <= rec.to; e++) for (const row of rec.rows) wanted.push({row, e});
        for (let i = 0; i < wanted.length; i += 50) {
            const wave = wanted.slice(i, i + 50);
            const values = await Promise.all(wave.map(({row, e}) => spentOf(src, address, row, e)));
            wave.forEach(({row, e}, j) => cells.set(row + ":" + e, values[j]));
        }
        const ctx = {
            address,
            closedEpoch: epochAt(consensus, EPOCH_ORIGIN, EPOCH_PERIOD) - 1,
            valueAt: (row, e) => cells.get(row + ":" + e),
            hash: keccak256,
        };
        for (const x of auditAnchor(rec, ctx)) note(`${where} ${x.name}`, x.pass, x.detail);

        const mismatches = [];
        let charged = 0;
        for (const {row, e} of wanted) {
            const onChain = cells.get(row + ":" + e);
            const published = publishedTotal.get(`${src}:${address}:${row}:${e}`) || 0;
            if (onChain > 0) charged++;
            if (published !== onChain) mismatches.push(`row ${row} epoch ${e}: published ${published}, spentBits ${onChain}`);
        }
        note(`${where} published charges equal spentBits in every cell`, mismatches.length === 0,
            mismatches.length
                ? mismatches.slice(0, 5).join("; ") + (mismatches.length > 5 ? `; and ${mismatches.length - 5} more` : "")
                : `${wanted.length} cells, ${charged} charged`);
    }
}

// -------------------------------------------------------------------- index
//
// The committed projection is what the Issuer screen boots from, so it gets the
// article's closing test in full: rebuild it from the mirror node and compare it
// against what the app believes. Four assertions. The index claims no message
// the topic lacks; its digest is the digest of the topic's bytes to that
// sequence; its running hash is the network's at that sequence; and the fold
// over those messages is, field for field, the file. A stale index passes (it
// is a true statement about a prefix); a wrong one does not.
let indexChecked = null;
if (existsSync(INDEX_PATH)) {
    const committed = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
    indexChecked = {throughSequence: Number(committed.throughSequence) || 0, head: raw.length};
    if (committed.topicId !== topic.topicId) {
        note("the committed index names this topic", false, `index ${committed.topicId}, topic ${topic.topicId}`);
    } else {
        const through = indexChecked.throughSequence;
        const head = raw.length ? Number(raw[raw.length - 1].sequence_number) : 0;
        note("the committed index claims no message the topic lacks", through <= head,
            `index through ${through}, topic head ${head}`);
        const prefix = raw.slice(0, Math.min(through, raw.length));
        note("the committed digest is the digest of the topic's bytes", digestOf(prefix) === committed.digest,
            `topic ${digestOf(prefix)}, index ${committed.digest}`);
        const last = prefix[prefix.length - 1];
        note("the committed running hash is the mirror node's at that sequence",
            (last ? last.running_hash : null) === committed.runningHash,
            last ? `mirror ${last.running_hash}` : "no messages");
        try {
            const rebuilt = project(topic.topicId, prefix);
            const agree = same(rebuilt, committed);
            let detail = `${rebuilt.messages} messages, ${Object.entries(rebuilt.kinds).map(([k, n]) => `${n} ${k}`).join(", ")}`;
            if (!agree) {
                const a = comparable(rebuilt);
                const b = comparable(committed);
                const k = [...new Set([...Object.keys(a), ...Object.keys(b)])]
                    .find((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
                detail = `first difference at ${k}`;
            }
            note("the committed projection is the projection of the topic", agree, detail);
        } catch (e) {
            note("the committed projection is the projection of the topic", false, e.message);
        }
    }
}

// -------------------------------------------------------------------- report

chain.close();

const failed = checks.filter((x) => !x.pass);
const kinds = {};
for (const {rec} of records) kinds[rec.k] = (kinds[rec.k] || 0) + 1;

const skipped = {since: SINCE, anchors: skippedAnchors, checkpoints: skippedCheckpoints};

if (JSON_OUT) {
    console.log(JSON.stringify({
        topicId: topic.topicId,
        checkedAt: new Date().toISOString(),
        messages: raw.length,
        records: records.length,
        kinds,
        skipped,
        index: indexChecked,
        assertions: checks.length,
        failures: failed.length,
        checks,
    }, null, 1));
} else {
    const w = Math.min(78, checks.reduce((m, x) => Math.max(m, x.name.length), 0));
    console.log(`\ntopic ${topic.topicId}  ${topic.memo}`);
    console.log(`${raw.length} message${raw.length === 1 ? "" : "s"}, ` +
        Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing on it yet");
    if (SINCE) {
        console.log(`--since ${SINCE}: ${skippedAnchors} anchor${skippedAnchors === 1 ? "" : "s"} and ` +
            `${skippedCheckpoints} checkpoint${skippedCheckpoints === 1 ? "" : "s"} closing before it were not read back`);
    }
    console.log("-".repeat(w + 12));
    for (const x of checks) {
        console.log(`${x.pass ? "pass" : "FAIL"}  ${x.name.padEnd(w)}${x.detail ? "  " + x.detail : ""}`);
    }
    console.log("-".repeat(w + 12));
    console.log(`${checks.length - failed.length} of ${checks.length} assertions passed`);
    if (failed.length) console.log(`\n${failed.length} failed. The topic does not reconcile against the chain.`);
}

process.exit(failed.length ? 1 : 0);
