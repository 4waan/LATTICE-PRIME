// Read the topic back and check every record against the chain.
//
//   node tools/hcs-verify.mjs             # the table, and a non-zero exit on a mismatch
//   node tools/hcs-verify.mjs --json      # the same result as JSON
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
//
// What it cannot check is liveness. A relay that stops publishes nothing false;
// it publishes nothing. The checkpoint series makes the gap visible and no test
// here can close it, which is stated in `docs/HCS-SCOPE.md` rather than hidden
// behind a passing table.
import {
    client, mirror, paged, epochAt, reader, readTopic, policyHistory, effectiveFrom,
} from "./hcs-chain.mjs";
import {bits} from "./lattice.mjs";
import {
    SITES, SOURCE_ADDRESS_KEY, MAX_CHUNK,
    auditRecord, decode, encode, keyOf, RecordError,
} from "./hcs.mjs";

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");

const c = client();
const topic = readTopic();
if (!topic || !topic.topicId) {
    console.error("no deployments/hcs.json. Run `make hcs-topic` first.");
    process.exit(1);
}

const EPOCH_ORIGIN = Number(c.clocks.disclosure.origin);
const EPOCH_PERIOD = Number(c.clocks.disclosure.period);

const chain = reader(c.network.rpc, c.network.chainId);
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

// The record against the transaction, through `hcs.mjs`'s `auditRecord`. The
// comparison lives there rather than here so the Rulebook screen's tick and this
// table's `pass` are the same function, checked by the same vectors.
for (const {seq, rec} of records) {
    if (rec.k === "checkpoint") continue;
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
for (const {rec} of records) {
    if (rec.k === "checkpoint") {
        checkpoints.set(`${rec.c}:${addressOf(rec)}:${rec.e}`, rec);
    }
}

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
    note(`${src} row ${row} epoch ${epoch}: the running totals chain from zero`, chained,
        chained ? `${list.length} charge${list.length === 1 ? "" : "s"}, ${running} bits` : "a charge is missing");

    const onChain =
        Number(await meterAt(src, address).spentBits(Number(row), Number(epoch)));
    const cp = checkpoints.get(`${src}:${address}:${epoch}`);
    if (cp) {
        // The omission check. A closed epoch the topic checkpointed has to add
        // up, exactly, against a number the relay does not write.
        note(`${src} row ${row} epoch ${epoch}: published charges equal spentBits`,
            running === onChain, `published ${running}, spentBits ${onChain}`);
        note(`${src} row ${row} epoch ${epoch}: the checkpoint agrees with spentBits`,
            Number(cp.rows[row] || 0) === onChain, `checkpoint ${cp.rows[row]}, spentBits ${onChain}`);
    } else {
        // An epoch still open, or one the relay has not checkpointed yet. It can
        // still not have published more than the chain shows.
        note(`${src} row ${row} epoch ${epoch}: published charges do not exceed spentBits`,
            running <= onChain, `published ${running}, spentBits ${onChain}`);
    }
}

// Every checkpoint, including the epochs no charge landed in: a checkpoint that
// claims a row was quiet when the meter says otherwise is the same omission
// dressed differently.
for (const cp of checkpoints.values()) {
    for (const row of Object.keys(cp.rows)) {
        const onChain =
            Number(await meterAt(cp.c, addressOf(cp)).spentBits(Number(row), cp.e));
        note(`${cp.c} checkpoint epoch ${cp.e} row ${row}`, Number(cp.rows[row]) === onChain,
            `checkpoint ${cp.rows[row]}, spentBits ${onChain}`);
    }
}

// -------------------------------------------------------------------- report

chain.close();

const failed = checks.filter((x) => !x.pass);
const kinds = {};
for (const {rec} of records) kinds[rec.k] = (kinds[rec.k] || 0) + 1;

if (JSON_OUT) {
    console.log(JSON.stringify({
        topicId: topic.topicId,
        checkedAt: new Date().toISOString(),
        messages: raw.length,
        records: records.length,
        kinds,
        assertions: checks.length,
        failures: failed.length,
        checks,
    }, null, 1));
} else {
    const w = Math.min(78, checks.reduce((m, x) => Math.max(m, x.name.length), 0));
    console.log(`\ntopic ${topic.topicId}  ${topic.memo}`);
    console.log(`${raw.length} message${raw.length === 1 ? "" : "s"}, ` +
        Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing on it yet");
    console.log("-".repeat(w + 12));
    for (const x of checks) {
        console.log(`${x.pass ? "pass" : "FAIL"}  ${x.name.padEnd(w)}${x.detail ? "  " + x.detail : ""}`);
    }
    console.log("-".repeat(w + 12));
    console.log(`${checks.length - failed.length} of ${checks.length} assertions passed`);
    if (failed.length) console.log(`\n${failed.length} failed. The topic does not reconcile against the chain.`);
}

process.exit(failed.length ? 1 : 0);
