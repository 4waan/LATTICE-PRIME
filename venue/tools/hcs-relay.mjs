// The relay: read the disclosure record off the chain, publish it to the topic.
//
//   node tools/hcs-relay.mjs --dry-run        # build every record, submit none
//   node tools/hcs-relay.mjs --once           # one pass, then stop
//   node tools/hcs-relay.mjs                  # poll until interrupted
//   node tools/hcs-relay.mjs --from 0         # rebuild from the venue's first block
//   node tools/hcs-relay.mjs --anchor-every 12  # epochs between anchors (default 12, an hour)
//
// `docs/HCS-SCOPE.md` is the argument. `HIP-478` is the pattern: a contract in
// the Hedera EVM cannot create a topic, submit to one, or read one, and the
// accepted proposal for making the two services interoperate is an oracle
// between them rather than a system contract. This is that oracle, for one
// application, and it is deliberately the smallest one that can be checked.
//
// ## What this is allowed to do, and what it is not
//
// It **cannot forge.** Every `charge` names a transaction hash and log index,
// and every ceiling refusal names custom-error bytes on a failed transaction.
// `tools/hcs-verify.mjs` fetches either fact back and compares it field for
// field. Every `silence` names a transaction that a third party can fetch and
// see succeeded with no charge on the row.
//
// It **cannot silently omit.** The per-epoch sum of published charges has to
// equal `spentBits(row, epoch)` read off the contract, which is a number this
// process does not write and cannot influence.
//
// It **can stall.** Nothing here forces liveness. Stop it and the topic stops;
// the gap shows in the sequence numbers and in the anchor series and cannot
// be prevented. That is inherent to the oracle pattern and is said out loud
// rather than papered over with a heartbeat that proves nothing.
//
// ## What the topic is, and is not
//
// The topic is an ordered record, not a database. `spentBits` on the contracts
// is the state; the topic carries what happened, in order, with a consensus
// timestamp, so that a third party can rebuild the state from the mirror node
// and compare. Nothing here or in any screen reads current state off the topic.
// That is also why the relay writes as little as the guarantee needs: one
// `checkpoint` per epoch that carried a record, so a reader can see the numbers
// for the epochs that matter, and one `anchor` an hour per source that hashes
// `spentBits` over every epoch that closed since the last one, so the verifier's
// omission check covers every epoch without a message for each. At $0.0008 a
// `ConsensusSubmitMessage` since January 2026, a checkpoint every five-minute
// epoch was 576 messages a day saying mostly nothing; the anchors say the same
// thing in 48.
//
// ## Why a silence is only ever claimed against an exhausted budget
//
// `DisclosureMeter.spend` is Rule A: an exhausted row withholds the event and
// lets the transaction succeed, so a withheld disclosure and a site that was
// never reached look identical in the log. Reading that ambiguity the wrong way
// would print a silence that did not happen, which is worse than printing none.
// So a silence is published only when all three hold: the entry point reaches
// `_emitUnder` unconditionally (`SITES[...].sure`), the row carries a budget,
// and the running total of that row's charges in that epoch already leaves no
// room for this one. Anything short of all three publishes nothing, which loses
// a record rather than inventing one.
import {writeFileSync, readFileSync, existsSync} from "node:fs";
import {join} from "node:path";
import {
    Client, PrivateKey, AccountId, TopicId, Hbar,
    TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";
import {keccak256} from "ethers";
import {
    ROOT, env, client, paged, tsKey, tsLess, epochAt, reader, readTopic,
    policyHistory, effectiveFrom,
} from "./hcs-chain.mjs";
import {bits} from "./lattice.mjs";
import {
    SITES, SOURCES, SOURCE_ADDRESS_KEY, TOPIC_CHARGED, ERROR_CEILING,
    SCHEMA_VERSION, MAX_ANCHOR_SPAN, encode, decode, keyOf, describe, decodeCeilingError,
    anchorPreimage, RecordError, assertSiteAddresses, assertSiteDeployments,
} from "./hcs.mjs";

const CURSOR = join(ROOT, "deployments/hcs-cursor.json");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
    const i = args.indexOf(f);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};

const DRY = has("--dry-run");
const ONCE = has("--once") || DRY;
const INTERVAL = Math.max(5, Number(val("--interval", "15"))) * 1000;
// The mirror node indexes a few seconds behind consensus. Publishing right up to
// `now` would leave a window whose last records arrive after the cursor has
// already moved past them, so the cursor stops short of the head and the next
// pass picks the rest up.
const LAG_SECONDS = Number(val("--lag", "10"));
// How many epochs have to close before the next anchor. Twelve five-minute
// epochs is an hour. Never below one: an anchor covers closed epochs only, and
// zero would ask for one before any had.
const ANCHOR_EVERY = Math.max(1, Math.min(MAX_ANCHOR_SPAN, Number(val("--anchor-every", "12")) || 12));

const c = client();
assertSiteAddresses(c.addresses);
const topic = readTopic();
if (!topic || !topic.topicId) {
    console.error("no deployments/hcs.json. Run `make hcs-topic` first.");
    process.exit(1);
}

const CLOCK = c.clocks.disclosure;
const EPOCH_ORIGIN = Number(CLOCK.origin);
const EPOCH_PERIOD = Number(CLOCK.period);

const chain = reader(c.network.rpc, c.network.chainId);
await assertSiteDeployments(c.addresses, (address) => chain.provider.getCode(address), keccak256);
const params = chain.at(c.addresses.ParameterRoot, "ParameterRoot");
const meters = {
    engine: chain.at(c.addresses.MatchingEngine, "MatchingEngine"),
    vault: chain.at(c.addresses.RepoVault, "RepoVault"),
};

// ------------------------------------------------------------------ budgets

/// `budgetFor(row)` off `ParameterRoot`, once per run. The relay never invents a
/// budget: the number a silence record prints is the governed one, and the
/// verifier reads it back from the same getter.
const budgets = new Map();
async function budgetOf(row) {
    if (!budgets.has(row)) {
        const b = await params.budgetFor(row);
        budgets.set(row, {
            domainBits: Number(b.domainBits),
            aggBits: Number(b.aggBits),
            bucketBits: Number(b.bucketBits),
            budgetBits: Number(b.budgetBits),
        });
    }
    return budgets.get(row);
}

/// The epoch from which today's budgets have been the budgets.
///
/// `budgetFor` is a read of current state, so it answers for now and not for
/// epoch four. The venue's first parameter set metered nothing, which means
/// every call before the second adoption charged nothing and emitted nothing,
/// entirely legitimately. Judging those against today's bound would print a
/// silence for each of them, so the relay does not judge a silence before this
/// epoch at all. It still publishes the charges and the checkpoints for those
/// epochs: those are log-backed and need no policy to read.
let POLICY_FROM = 0;
let skippedBeforePolicy = 0;

/// Every row any watched entry point can charge, so a checkpoint covers the
/// venue's whole disclosing surface rather than the rows that happened to move.
const ROWS_OF = {};
for (const site of Object.values(SITES)) {
    ROWS_OF[site.src] = ROWS_OF[site.src] || new Set();
    for (const r of site.rows) ROWS_OF[site.src].add(r.row);
}

// ------------------------------------------------------------------- cursor

const blank = () => ({
    note: "Generated by tools/hcs-relay.mjs. Where the last pass stopped, per contract. Runtime state, not evidence: every published record carries tx and log index, so a consumer dedupes without this file.",
    topicId: topic.topicId,
    sources: Object.fromEntries(SOURCES.map((s) => [s, {
        address: String(c.addresses[SOURCE_ADDRESS_KEY[s]]).toLowerCase(),
        throughTs: "0.0",
        // The last epoch an anchor covers. Null until the topic has been read
        // back: the topic, not this file, says where anchoring resumes.
        anchoredThrough: null,
        // Epochs that carried a record while still open. Each gets its
        // checkpoint on the first pass after it closes.
        pendingCheckpoints: [],
    }])),
    published: 0,
    lastRun: null,
});

const asEpochList = (v) => (Array.isArray(v) ? v : [])
    .map(Number).filter((e) => Number.isInteger(e) && e >= 0);
const asEpochOrNull = (v) => (Number.isInteger(Number(v)) && v !== null && v !== undefined ? Number(v) : null);

function loadCursor() {
    if (!existsSync(CURSOR)) return blank();
    const j = JSON.parse(readFileSync(CURSOR, "utf8"));
    // A cursor written against a different topic is not this topic's cursor.
    // Resuming from it would skip everything the new topic has never seen.
    if (j.topicId !== topic.topicId) {
        console.error(`the cursor names topic ${j.topicId}, the record names ${topic.topicId}. Refusing to resume.`);
        process.exit(1);
    }
    const base = blank();
    for (const s of SOURCES) {
        const old = j.sources && j.sources[s];
        const oldAddress = old?.address || topic.publishes?.[s];
        if (!old || String(oldAddress || "").toLowerCase() !== base.sources[s].address) {
            continue;
        }
        base.sources[s] = {
            ...base.sources[s],
            throughTs: old.throughTs || base.sources[s].throughTs,
            anchoredThrough: asEpochOrNull(old.anchoredThrough),
            pendingCheckpoints: asEpochList(old.pendingCheckpoints),
        };
    }
    base.published = Number(j.published) || 0;
    return base;
}

const cursor = loadCursor();
if (has("--from")) {
    const from = val("--from", "0");
    for (const s of SOURCES) {
        cursor.sources[s] = {
            ...cursor.sources[s],
            throughTs: from + ".0",
            anchoredThrough: null,
            pendingCheckpoints: [],
        };
    }
    console.log(`rebuilding from consensus timestamp ${from}`);
}

// ------------------------------------------------------------ what is on it

/// Everything the topic already carries, as dedupe keys, and how far each
/// source's anchors and checkpoints reach.
///
/// The cursor alone would do in the ordinary case. This is the belt: a lost or
/// hand-edited cursor would otherwise republish an epoch, and a receipt stream
/// with the same charge on two sequence numbers is a stream a reader has to
/// clean before they can count. Reading the topic back is one paged listing at
/// startup and it makes double publication impossible rather than unlikely.
///
/// `covered[src]` is where anchoring resumes: the last epoch an anchor on the
/// topic reaches, or, on a topic that predates anchors, the last epoch a
/// checkpoint printed. Two anchors over the same epoch would be two claims
/// about one fact, and the topic rather than a file is what rules them out.
async function alreadyPublished() {
    const seen = new Set();
    let dropped = 0;
    const anchoredTo = {};
    const checkpointedAt = {};
    const rows = await paged(
        c.network.mirror,
        `/api/v1/topics/${encodeURIComponent(topic.topicId)}/messages?order=asc&limit=100`,
        "messages");
    for (const m of rows) {
        let rec;
        try {
            rec = decode(Buffer.from(m.message, "base64").toString("utf8"));
        } catch (e) {
            // A message this relay cannot parse is still on the topic, and
            // saying so is the point: it means either an older schema or
            // somebody else's write, and a reader deserves the count.
            dropped++;
            continue;
        }
        seen.add(keyOf(rec));
        if (rec.k === "anchor") {
            anchoredTo[rec.c] = Math.max(anchoredTo[rec.c] ?? -1, rec.to);
        } else if (rec.k === "checkpoint") {
            checkpointedAt[rec.c] = Math.max(checkpointedAt[rec.c] ?? -1, rec.e);
        }
    }
    const covered = {};
    for (const s of SOURCES) {
        covered[s] = anchoredTo[s] !== undefined ? anchoredTo[s]
            : checkpointedAt[s] !== undefined ? checkpointedAt[s] : null;
    }
    return {seen, count: rows.length, dropped, covered};
}

// ------------------------------------------------------------- the chain read

const selectorOf = (params_) =>
    typeof params_ === "string" && params_.length >= 10 ? params_.slice(0, 10).toLowerCase() : null;

/// One source's window: every contract result and every log after `fromTs`, in
/// consensus order, correlated by transaction hash.
///
/// Both feeds are fetched over the same open window rather than per transaction.
/// The logs feed answers "did this transaction charge", which is the question a
/// silence turns on, and one listing per pass answers it for every transaction
/// in the pass. Asking per transaction would be the same answer at N times the
/// rate limit.
async function window_(address, fromTs, toTs) {
    // Half open, `[fromTs, toTs)`. The lower bound is inclusive and the upper is
    // exclusive so consecutive windows tile the timeline exactly: the cursor is
    // set to this pass's `toTs`, which becomes the next pass's `fromTs`, and a
    // record landing on that instant belongs to exactly one of them. Two
    // exclusive bounds would drop it and two inclusive ones would publish it
    // twice.
    const q = `timestamp=gte:${encodeURIComponent(fromTs)}&timestamp=lt:${encodeURIComponent(toTs)}`;
    const base = `/api/v1/contracts/${address}`;
    const [results, logs] = await Promise.all([
        paged(c.network.mirror, `${base}/results?order=asc&limit=100&${q}`, "results"),
        paged(c.network.mirror, `${base}/results/logs?order=asc&limit=100&${q}`, "logs"),
    ]);
    const byTx = new Map();
    for (const l of logs) {
        const k = String(l.transaction_hash).toLowerCase();
        if (!byTx.has(k)) byTx.set(k, []);
        byTx.get(k).push(l);
    }
    results.sort((a, b) => (tsKey(a.timestamp) < tsKey(b.timestamp) ? -1 : 1));
    return {results, byTx, logs};
}

const num = (hex32) => Number(BigInt(hex32));

/// Decode `DisclosureCharged(uint16 indexed row, uint64 indexed epoch, uint8 g,
/// uint32 cost, uint32 spentAfter)` without an ABI round trip: two indexed
/// topics and three thirty-two byte words. The shapes are asserted rather than
/// assumed, so a log that is not this event fails here instead of becoming a
/// record with plausible looking numbers in it.
function decodeCharge(log) {
    if (log.topics.length !== 3) throw new Error("DisclosureCharged wants two indexed fields");
    const data = String(log.data).replace(/^0x/, "");
    if (data.length !== 192) throw new Error(`DisclosureCharged data is ${data.length / 2} bytes, want 96`);
    return {
        row: num("0x" + log.topics[1].replace(/^0x/, "")),
        epoch: num("0x" + log.topics[2].replace(/^0x/, "")),
        g: num("0x" + data.slice(0, 64)),
        cost: num("0x" + data.slice(64, 128)),
        after: num("0x" + data.slice(128, 192)),
    };
}

/// The running total on `(row, epoch)` as the published charges leave it.
///
/// Seeded from the chain rather than from zero. A relay started mid-epoch has
/// not seen that epoch's earlier charges, and a silence judged against a running
/// total of zero would be judged against a budget that looked full. So the seed
/// is `spentBits(row, epoch)` at the last timestamp the relay is caught up to,
/// and every charge the pass sees is checked against it: `spentAfter` in the log
/// has to be what this arithmetic predicts, or the pass stops.
class Running {
    constructor(meter) {
        this.meter = meter;
        this.at = new Map();
    }
    key(row, epoch) { return row + ":" + epoch; }
    async get(row, epoch) {
        const k = this.key(row, epoch);
        if (!this.at.has(k)) this.at.set(k, Number(await this.meter.spentBits(row, epoch)));
        return this.at.get(k);
    }
    set(row, epoch, v) { this.at.set(this.key(row, epoch), v); }
}

/// Build every record one source owes for one window. Pure with respect to the
/// topic: nothing here submits, so `--dry-run` runs the whole decision path.
async function recordsFor(src, fromTs, toTs) {
    const address = String(c.addresses[SOURCE_ADDRESS_KEY[src]]).toLowerCase();
    const {results, byTx} = await window_(address, fromTs, toTs);
    const out = [];

    // The running total has to be seeded from before the window, not from
    // inside it. `spentBits` at head already carries every charge in the window,
    // so seeding from head and then adding the window's charges would double
    // count. Seed instead by subtracting the window's own charges from head.
    const running = new Running(meters[src]);
    const windowCharges = new Map();
    for (const logs of byTx.values()) {
        for (const l of logs) {
            if (String(l.topics[0]).toLowerCase() !== TOPIC_CHARGED) continue;
            const ch = decodeCharge(l);
            const k = ch.row + ":" + ch.epoch;
            windowCharges.set(k, (windowCharges.get(k) || 0) + ch.cost);
        }
    }
    const seeded = new Set();
    const seed = async (row, epoch) => {
        const k = row + ":" + epoch;
        if (seeded.has(k)) return;
        seeded.add(k);
        const head = Number(await meters[src].spentBits(row, epoch));
        running.set(row, epoch, head - (windowCharges.get(k) || 0));
    };

    for (const r of results) {
        const sel = selectorOf(r.function_parameters);
        const site = sel && Object.prototype.hasOwnProperty.call(SITES, sel) ? SITES[sel] : null;
        const logs = byTx.get(String(r.hash).toLowerCase()) || [];
        const tx = String(r.hash).toLowerCase();

        // Reverted logs are discarded by the EVM. A ceiling refusal is instead
        // the typed custom error retained on the failed contract result.
        const errorMessage = String(r.error_message || "").toLowerCase();
        if (errorMessage.replace(/^0x/, "").startsWith(ERROR_CEILING.slice(2))) {
            if (!site) {
                throw new Error(
                    `${src} transaction ${tx} returned DisclosureExceedsCeiling, ` +
                    `but selector ${sel || "unknown"} is absent from SITES.`);
            }
            const d = decodeCeilingError(errorMessage);
            if (!site.rows.some((row) => row.row === d.row)) {
                throw new Error(
                    `${src}.${site.fn} at ${tx} refused row ${d.row}, ` +
                    `which that selector does not disclose.`);
            }
            out.push({
                v: SCHEMA_VERSION, k: "ceiling", c: src, a: address,
                tx, sel, fn: site.fn, r: d.row, x: d.x,
            });
        }

        const charged = new Map();
        for (const l of logs) {
            if (String(l.topics[0]).toLowerCase() !== TOPIC_CHARGED) continue;
            const d = decodeCharge(l);
            charged.set(d.row, d);
            await seed(d.row, d.epoch);
            const before = await running.get(d.row, d.epoch);
            // The one place the relay checks the chain against itself. If the
            // log's own running total is not what the previous charges predict,
            // this process has missed a charge or is reading a window out of
            // order, and publishing anything more would be publishing a story.
            if (before + d.cost !== d.after) {
                throw new Error(
                    `${src} row ${d.row} epoch ${d.epoch}: log says spentAfter ${d.after}, ` +
                    `the charges before it sum to ${before} and this one costs ${d.cost}. ` +
                    `Stopping at ${tx} rather than publishing a total nobody can reproduce.`);
            }
            running.set(d.row, d.epoch, d.after);
            out.push({
                v: SCHEMA_VERSION, k: "charge", c: src, a: address,
                tx, li: Number(l.index),
                r: d.row, e: d.epoch, g: d.g, cost: d.cost, after: d.after,
            });
        }

        // Silences. Only for a call that succeeded, only at an unconditional
        // site, only on a metered row, and only when the running total already
        // left no room.
        if (!site || r.error_message) continue;
        const epoch = epochAt(r.timestamp, EPOCH_ORIGIN, EPOCH_PERIOD);
        if (epoch < POLICY_FROM) { skippedBeforePolicy++; continue; }
        for (const row of site.rows) {
            if (!row.sure || charged.has(row.row)) continue;
            const b = await budgetOf(row.row);
            if (b.budgetBits === 0) continue;          // unmetered: nothing was ever owed
            await seed(row.row, epoch);
            const spent = await running.get(row.row, epoch);
            const cost = bits(b, row.g);
            if (spent + cost <= b.budgetBits) {
                // `_emitUnder` reverts on a ceiling breach and charges
                // otherwise, so a successful call at an unconditional site with
                // room left must have produced a log. It did not, which means
                // this relay's model of the contract is wrong and every record
                // after it would be guesswork.
                throw new Error(
                    `${src}.${site.fn} at ${tx} succeeded, charged nothing on row ${row.row}, ` +
                    `and the row had ${b.budgetBits - spent} of ${b.budgetBits} bits left. ` +
                    `Either SITES marks a conditional site as unconditional or its site model ` +
                    `does not describe the bound runtime. Refusing to publish a silence.`);
            }
            out.push({
                v: SCHEMA_VERSION, k: "silence", c: src, a: address,
                tx, sel, fn: site.fn,
                r: row.row, e: epoch, spent, budget: b.budgetBits,
            });
        }
    }
    return out;
}

/// The checkpoints one pass owes: one per closed epoch that carried a record.
///
/// That is the epoch a reader wants the numbers for. Without it a dropped charge
/// is only "fewer records than you expected"; with it the published charges have
/// to add up to a number the relay does not write. An epoch whose record landed
/// while it was still open waits in `pendingCheckpoints` until it closes, so
/// its `spentBits` is final when printed.
///
/// Quiet epochs get no checkpoint. They used to get one each as a heartbeat,
/// which at a five-minute epoch was 576 messages a day that said nothing, and
/// which buried the gap a stalled relay leaves under identical zero rows. The
/// anchors below cover them instead: every epoch, one hash, once an hour.
async function checkpointsFor(src, epochs, blk) {
    const address = String(c.addresses[SOURCE_ADDRESS_KEY[src]]).toLowerCase();
    const rowsWanted = [...(ROWS_OF[src] || [])].sort((a, b) => a - b);
    const out = [];
    for (const e of [...new Set(epochs)].sort((a, b) => a - b)) {
        if (e < 0) continue;
        const rows = {};
        for (const row of rowsWanted) rows[row] = Number(await meters[src].spentBits(row, e));
        out.push({v: SCHEMA_VERSION, k: "checkpoint", c: src, a: address, e, blk, rows});
    }
    return out;
}

/// Every `spentBits(row, epoch)` cell in a closed range, read in waves that fit
/// the provider's batch size. A closed epoch's cells are final, so when they are
/// read does not matter; that they are all read does, and `anchorPreimage`
/// refuses a missing one rather than hashing a zero in its place.
async function cellsFor(src, rows, from, to) {
    const wanted = [];
    for (let e = from; e <= to; e++) for (const row of rows) wanted.push({row, e});
    const cells = new Map();
    for (let i = 0; i < wanted.length; i += 50) {
        const wave = wanted.slice(i, i + 50);
        const values = await Promise.all(wave.map(({row, e}) => meters[src].spentBits(row, e)));
        wave.forEach(({row, e}, j) => cells.set(row + ":" + e, Number(values[j])));
    }
    return cells;
}

/// The anchors one source owes, and the two things an anchor is for.
///
/// **Coverage.** Every closed epoch after `anchoredThrough` ends up inside
/// exactly one anchor, in spans of at most `MAX_ANCHOR_SPAN`. The verifier
/// reads the same cells back off the contract and recomputes the hash, so a
/// charge the relay never published breaks a hash the relay did not write.
/// That is the omission check, for every epoch, at one message an hour.
///
/// **A heartbeat that says something.** The anchor series is where a stalled
/// relay shows: the range an anchor covers is compared with the epoch it reached
/// consensus in, and a relay that publishes an hour's anchor two days late has
/// published a record of its own outage.
///
/// Nothing is published until `ANCHOR_EVERY` epochs have closed since the last
/// anchor, and a range is never extended into the open epoch: its cells could
/// still move, and an anchor over them would be a hash of a guess.
async function anchorsFor(src, anchoredThrough, closedEpoch) {
    const address = String(c.addresses[SOURCE_ADDRESS_KEY[src]]).toLowerCase();
    const rows = [...(ROWS_OF[src] || [])].sort((a, b) => a - b);
    const out = [];
    let through = anchoredThrough;
    while (rows.length && closedEpoch - through >= ANCHOR_EVERY) {
        const from = through + 1;
        const to = Math.min(closedEpoch, from + MAX_ANCHOR_SPAN - 1);
        const cells = await cellsFor(src, rows, from, to);
        const h = keccak256(anchorPreimage(from, to, rows, (row, e) => cells.get(row + ":" + e)));
        const blk = await chain.provider.getBlockNumber();
        out.push({v: SCHEMA_VERSION, k: "anchor", c: src, a: address, from, to, blk, rows, h});
        through = to;
    }
    return {records: out, through};
}

// ------------------------------------------------------------------- publish

let hedera = null;
function hederaClient() {
    if (hedera) return hedera;
    const e = env(["HEDERA_ACCOUNT_ID", "HEDERA_PRIVATE_KEY"]);
    const key = PrivateKey.fromStringECDSA(e.HEDERA_PRIVATE_KEY);
    hedera = Client.forName(c.network.chainId === 295 ? "mainnet" : "testnet")
        .setOperator(AccountId.fromString(e.HEDERA_ACCOUNT_ID), key);
    return hedera;
}

async function submit(text) {
    const receipt = await (await new TopicMessageSubmitTransaction()
        .setTopicId(TopicId.fromString(topic.topicId))
        .setMessage(text)
        .setMaxTransactionFee(new Hbar(2))
        .execute(hederaClient()))
        .getReceipt(hederaClient());
    return receipt.topicSequenceNumber ? receipt.topicSequenceNumber.toString() : "?";
}

// ---------------------------------------------------------------------- pass

const state = {seen: new Set(), startedAt: Date.now()};

async function pass() {
    const nowSeconds = Math.floor(Date.now() / 1000) - LAG_SECONDS;
    const toTs = nowSeconds + ".0";
    let published = 0;
    let skipped = 0;

    for (const src of SOURCES) {
        const cur = cursor.sources[src];
        if (!tsLess(cur.throughTs, toTs)) continue;
        const records = await recordsFor(src, cur.throughTs, toTs);

        const closedEpoch = epochAt(nowSeconds, EPOCH_ORIGIN, EPOCH_PERIOD) - 1;

        // Checkpoints: every epoch that carried a record, once it has closed.
        const epochsWithRecords = records.filter((r) => r.e !== undefined).map((r) => r.e);
        const due = [...new Set([...cur.pendingCheckpoints, ...epochsWithRecords])];
        const wanted = due.filter((e) => e <= closedEpoch);
        const stillOpen = due.filter((e) => e > closedEpoch);
        if (wanted.length) {
            const blk = await chain.provider.getBlockNumber();
            records.push(...await checkpointsFor(src, wanted, blk));
        }

        // Anchors: every closed epoch since the last one, once an hour's worth
        // has closed. On a topic with nothing for this source yet, anchoring
        // starts at the epoch the relay's own window starts in.
        if (cur.anchoredThrough === null) {
            cur.anchoredThrough = epochAt(cur.throughTs, EPOCH_ORIGIN, EPOCH_PERIOD) - 1;
        }
        const anchored = await anchorsFor(src, cur.anchoredThrough, closedEpoch);
        records.push(...anchored.records);

        for (const rec of records) {
            let text;
            try {
                text = encode(rec);
            } catch (e) {
                if (e instanceof RecordError) {
                    // A record this process built and cannot encode is a bug
                    // here, not bad input. Stopping is the honest answer.
                    throw new Error(`refusing to publish a malformed ${rec.k}: ${e.message}`);
                }
                throw e;
            }
            const key = keyOf(rec);
            if (state.seen.has(key)) { skipped++; continue; }
            if (DRY) {
                console.log(`  would publish  ${text}`);
                console.log(`                 ${describe(rec)}`);
            } else {
                const seq = await submit(text);
                console.log(`  #${seq}  ${describe(rec)}`);
            }
            state.seen.add(key);
            published++;
        }

        // The whole window was fetched and processed, so the cursor moves to its
        // upper bound whether or not anything was in it. Advancing only to the
        // last record seen would leave a relay on a quiet venue re-scanning the
        // same widening window on every pass, forever.
        cur.throughTs = toTs;
        cur.pendingCheckpoints = stillOpen.sort((a, b) => a - b);
        cur.anchoredThrough = anchored.through;
    }

    cursor.published += published;
    cursor.lastRun = new Date().toISOString();
    if (!DRY) writeFileSync(CURSOR, JSON.stringify(cursor, null, 1) + "\n");
    return {published, skipped};
}

// ---------------------------------------------------------------------- main

let stop = false;
process.on("SIGINT", () => { stop = true; console.log("\nstopping after this pass"); });

try {
    const adoptions = await policyHistory(c.network.mirror, c.addresses.ParameterRoot);
    POLICY_FROM = effectiveFrom(adoptions, await params.root());
    console.log(`the parameter set in force was adopted at disclosure epoch ${POLICY_FROM}` +
        (adoptions.length > 1 ? `, after ${adoptions.length - 1} earlier set${adoptions.length === 2 ? "" : "s"}` : "") +
        ". No silence is judged before it.");

    const on = await alreadyPublished();
    state.seen = on.seen;
    console.log(`topic ${topic.topicId}: ${on.count} message${on.count === 1 ? "" : "s"} already on it` +
        (on.dropped ? `, ${on.dropped} this relay could not parse` : "") +
        (DRY ? "  (dry run, nothing will be submitted)" : ""));

    // Anchoring resumes from the later of what the topic shows and what the
    // cursor remembers. The topic wins over a stale cursor, which is what stops
    // two anchors covering one epoch; the cursor wins over a mirror node that
    // has not yet indexed the anchor this process submitted seconds ago.
    for (const src of SOURCES) {
        const cur = cursor.sources[src];
        const onTopic = on.covered[src];
        if (onTopic !== null) {
            cur.anchoredThrough = cur.anchoredThrough === null ? onTopic : Math.max(cur.anchoredThrough, onTopic);
        }
        console.log(`  ${src}: ` + (cur.anchoredThrough === null
            ? "nothing anchored or checkpointed yet; anchoring starts with the relay's window"
            : `anchored through epoch ${cur.anchoredThrough}, one anchor per ${ANCHOR_EVERY} closed epoch${ANCHOR_EVERY === 1 ? "" : "s"}`));
    }

    for (let n = 1; !stop; n++) {
        const t0 = Date.now();
        const {published, skipped} = await pass();
        console.log(`pass ${n}: ${published} published, ${skipped} already on the topic, ` +
            `${skippedBeforePolicy} call${skippedBeforePolicy === 1 ? "" : "s"} under an earlier parameter set, ` +
            `${Date.now() - t0}ms`);
        if (ONCE) break;
        await new Promise((r) => setTimeout(r, INTERVAL));
    }
} catch (e) {
    console.error("\n" + e.message);
    process.exitCode = 1;
} finally {
    chain.close();
    if (hedera) hedera.close();
}
