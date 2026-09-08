// The record schema for the consensus topic, and nothing that touches a network.
//
// `docs/HCS-SCOPE.md` is the argument for the topic. This file is the part of it
// that both halves have to agree on: the relay writes these records, the
// verifier reads them back and checks them against the chain, and the Rulebook
// screen renders them. Three consumers, one grammar, no second copy.
//
// It is pure on purpose. `tools/hcs-relay.mjs` holds the operator key and
// `tools/hcs-verify.mjs` holds the chain reads; neither of those is inlined into
// a page and neither is imported here. This file is, which is why it may not
// import anything: `tools/gen-page.mjs` drops `import` lines and concatenates,
// so a dependency here would arrive in the browser as an undefined name.
//
// ## Why the decoder is paranoid about a stream we hold the submit key to
//
// The topic's submit key is the venue operator's, so in the ordinary case every
// message on it was written by `hcs-relay.mjs`. That is an argument for trusting
// the *author*, not the *bytes*: a mirror node response travels over a network,
// a submit key can be rotated by whoever holds it, and the six built pages parse
// these records in a browser with no server in front of them. So `decode`
// treats every message as hostile input. It rejects unknown keys rather than
// ignoring them, refuses `__proto__` and friends before they can reach an
// assignment, builds on a null prototype, and bounds every number by the
// Solidity width it came from. A record that does not survive that is dropped
// with a reason, never rendered "best effort".

/// The HCS single-chunk limit. A record over this would be split across several
/// sequence numbers, and a receipt that spans three sequence numbers is not one
/// receipt. `encode` refuses rather than letting the SDK chunk it silently.
export const MAX_CHUNK = 1024;

/// Bumped only when a field changes meaning. A consumer that does not know a
/// version must drop the record, not guess at it.
export const SCHEMA_VERSION = 1;

/// The contracts the relay publishes for, keyed by the short name a record
/// carries in `c`. Both are `DisclosureView`s with their own `DisclosureMeter`,
/// which is what makes the verifier's arithmetic check possible: `spentBits` is
/// per contract, so a record without `c` could not be reconciled against
/// anything.
export const SOURCES = ["engine", "vault"];

/// Which deployed contract each short name is.
export const SOURCE_ADDRESS_KEY = {engine: "MatchingEngine", vault: "RepoVault"};

/// The disclosing entry points, and the rows each one charges.
///
/// `sure` is the field silence detection turns on. A site is `sure: true` only
/// when reaching the function body guarantees reaching `_emitUnder`: every
/// earlier guard reverts, so a transaction with status SUCCESS and no charge on
/// that row is a withheld disclosure and nothing else. A site behind an `if`
/// inside the body is `sure: false` and is excluded, because "no charge" there
/// is ambiguous between silence and a branch not taken. Getting this wrong in
/// the `false` direction costs a missed silence; getting it wrong in the `true`
/// direction would print a silence that did not happen, which is the failure
/// this venue cannot have. `tools/hcs.test.mjs` pins every selector against the
/// deployed ABI so a rename cannot drift the table.
export const SITES = {
    // MatchingEngine, which is OrderBook plus the auction.
    "0xf14fcbc8": {src: "engine", fn: "commit", rows: [{row: 17, g: 4, sure: true}]},
    "0x59c94e62": {
        src: "engine",
        fn: "reveal",
        rows: [{row: 4, g: 4, sure: true}, {row: 3, g: 4, sure: true}],
    },
    "0xc4d252f5": {src: "engine", fn: "cancel", rows: [{row: 15, g: 1, sure: true}]},
    // Row 13 is unconditional after the halt check; row 12 is per settlement and
    // so is charged zero or many times in one transaction, which is why it is
    // not a silence site.
    "0x92986d97": {
        src: "engine",
        fn: "crossRound",
        rows: [{row: 13, g: 1, sure: true}, {row: 12, g: 4, sure: false}],
    },

    // RepoVault.
    "0x778ae762": {src: "vault", fn: "open", rows: [{row: 7, g: 4, sure: true}]},
    "0x39c79e0c": {src: "vault", fn: "close", rows: [{row: 14, g: 1, sure: true}]},
    "0x9fcdeba6": {src: "vault", fn: "cure", rows: [{row: 14, g: 1, sure: true}]},
    "0xb3dc49a0": {src: "vault", fn: "markFailing", rows: [{row: 14, g: 1, sure: true}]},
    "0xdaf79598": {src: "vault", fn: "declareDefault", rows: [{row: 14, g: 1, sure: true}]},
    // **`sure` flipped to false here, and the selector moved, in the same
    // change.** `noteCoupon` used to take the commitment as an argument and
    // every guard in it reverted, so a SUCCESS with no row 14 charge could only
    // be a withheld disclosure. Deriving the commitment brought an idempotence
    // guard with it: a second call for a coupon already noted *returns zero*
    // rather than reverting, because `docs/BUILD-REMAINING.md` §3 puts this
    // behind the dispatcher a HIP-1215 `scheduleCall` targets. A scheduled
    // call that fires after somebody already made it by hand has to be a no-op.
    //
    // That is a successful transaction that reaches no `_emitUnder` and is not
    // a silence. Leaving this `true` would print one every time a scheduled
    // coupon call landed second, which under HIP-1215 scheduling is the
    // ordinary case and not the rare one. The cost of `false` is a missed
    // silence at this site; the cost of `true` is a silence that did not
    // happen, and this file's header says which of those the venue cannot have.
    "0x2bae2cde": {src: "vault", fn: "noteCoupon", rows: [{row: 14, g: 1, sure: false}]},
    // One obligation id can dispatch to a fail or a coupon, and both can no-op
    // after a manual call or a terminal repo transition. Its charged events are
    // still relayed, but absence of one can never prove a withheld disclosure.
    "0x987757dd": {src: "vault", fn: "settle", rows: [{row: 14, g: 1, sure: false}]},
    "0x1c6a825c": {src: "vault", fn: "payThrough", rows: [{row: 14, g: 1, sure: true}]},
    "0xe68a8171": {src: "vault", fn: "settleAuction", rows: [{row: 14, g: 1, sure: true}]},
    // Row 16 always; row 14 only when `breach` and the repo was OPEN. The second
    // is the one conditional metered site in the venue and it is excluded by
    // name rather than by omission, so a reader can see the hole.
    "0x8dcf2bd0": {
        src: "vault",
        fn: "postMark",
        rows: [{row: 16, g: 4, sure: true}, {row: 14, g: 1, sure: false}],
    },
};

/// `keccak256("DisclosureCharged(uint16,uint64,uint8,uint32,uint32)")`.
export const TOPIC_CHARGED =
    "0xc2c92b58279430965bba4609e31c0ecd1ce733209db3c64f1a61e9b6dc9e0709";
/// `keccak256("DisclosureRefused(bytes32,uint16,uint32)")`.
export const TOPIC_REFUSED =
    "0x4e9fd7bd9893a596148f01db9643366d229c0852b59efefa78e291c3a8c0730f";

/// The record kinds, and the exact field order each one is serialised in.
///
/// Order is part of the format rather than an implementation detail. The
/// verifier re-encodes what it read and compares bytes, so two encoders that
/// agreed on content but not on key order would fail against each other, and a
/// record whose bytes are reproducible is one a third party can hash.
export const FIELDS = {
    charge: ["v", "k", "c", "tx", "li", "r", "e", "g", "cost", "after"],
    refusal: ["v", "k", "c", "tx", "li", "id", "r", "x"],
    silence: ["v", "k", "c", "tx", "sel", "fn", "r", "e", "spent", "budget"],
    checkpoint: ["v", "k", "c", "e", "blk", "rows"],
};

export const KINDS = Object.keys(FIELDS);

export class RecordError extends Error {
    constructor(message) {
        super(message);
        this.name = "RecordError";
    }
}

const U16 = 0xffff;
const U32 = 0xffffffff;
// uint64 exceeds what a double holds exactly. Epochs are seconds since a fixed
// origin divided by 300, so the venue's live values are around 6e6 and will not
// reach 2^53 for longer than the sun lasts; bounding at MAX_SAFE_INTEGER keeps
// the arithmetic honest rather than pretending the field is 64 bits wide here.
const U64_SAFE = Number.MAX_SAFE_INTEGER;

const DANGEROUS = new Set(["__proto__", "constructor", "prototype"]);

const isPlainKey = (k) => typeof k === "string" && k.length > 0 && !DANGEROUS.has(k);

function uintField(name, value, max) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
        throw new RecordError(`${name} must be an integer in [0, ${max}], got ${JSON.stringify(value)}`);
    }
    return value;
}

function hexField(name, value, bytes) {
    const want = 2 + bytes * 2;
    if (typeof value !== "string" || value.length !== want || !/^0x[0-9a-f]+$/.test(value)) {
        throw new RecordError(`${name} must be ${bytes} lowercase hex bytes, got ${JSON.stringify(value)}`);
    }
    return value;
}

function sourceField(value) {
    if (!SOURCES.includes(value)) {
        throw new RecordError(`c must be one of ${SOURCES.join(", ")}, got ${JSON.stringify(value)}`);
    }
    return value;
}

/// The per-row map a checkpoint carries. Keys are decimal row numbers as
/// strings, values are `spentBits`. Built on a null prototype and rejected
/// outright if a key is not a plain small integer, because this is the one field
/// whose key set is not fixed by the schema.
function rowsMap(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new RecordError("rows must be an object");
    }
    const out = Object.create(null);
    const keys = Object.keys(value);
    if (keys.length > 64) throw new RecordError("rows carries more than 64 entries");
    for (const k of keys) {
        if (!isPlainKey(k) || !/^(0|[1-9][0-9]{0,4})$/.test(k)) {
            throw new RecordError(`rows key ${JSON.stringify(k)} is not a row number`);
        }
        uintField("rows." + k + " (row)", Number(k), U16);
        out[k] = uintField("rows." + k, value[k], U32);
    }
    return out;
}

/// Validate one decoded object against its kind. Returns a fresh null-prototype
/// record carrying exactly the schema's fields and nothing else.
export function validate(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new RecordError("a record must be a JSON object");
    }
    if (raw.v !== SCHEMA_VERSION) {
        throw new RecordError(`unknown schema version ${JSON.stringify(raw.v)}`);
    }
    const kind = raw.k;
    if (!KINDS.includes(kind)) throw new RecordError(`unknown kind ${JSON.stringify(kind)}`);

    const want = FIELDS[kind];
    const got = Object.keys(raw);
    for (const k of got) {
        if (!isPlainKey(k)) throw new RecordError(`refusing key ${JSON.stringify(k)}`);
        if (!want.includes(k)) throw new RecordError(`${kind} carries unexpected field ${k}`);
    }
    for (const k of want) {
        if (!Object.prototype.hasOwnProperty.call(raw, k)) {
            throw new RecordError(`${kind} is missing field ${k}`);
        }
    }

    const r = Object.create(null);
    r.v = SCHEMA_VERSION;
    r.k = kind;
    r.c = sourceField(raw.c);

    if (kind === "charge") {
        r.tx = hexField("tx", raw.tx, 32);
        r.li = uintField("li", raw.li, U32);
        r.r = uintField("r", raw.r, U16);
        r.e = uintField("e", raw.e, U64_SAFE);
        r.g = uintField("g", raw.g, 4);
        r.cost = uintField("cost", raw.cost, U32);
        r.after = uintField("after", raw.after, U32);
        if (r.after < r.cost) throw new RecordError("after is below the charge it follows");
    } else if (kind === "refusal") {
        r.tx = hexField("tx", raw.tx, 32);
        r.li = uintField("li", raw.li, U32);
        r.id = hexField("id", raw.id, 32);
        r.r = uintField("r", raw.r, U16);
        r.x = uintField("x", raw.x, U32);
    } else if (kind === "silence") {
        r.tx = hexField("tx", raw.tx, 32);
        r.sel = hexField("sel", raw.sel, 4);
        if (!Object.prototype.hasOwnProperty.call(SITES, r.sel)) {
            throw new RecordError(`sel ${r.sel} is not a disclosing entry point`);
        }
        const site = SITES[r.sel];
        if (site.src !== r.c) throw new RecordError(`sel ${r.sel} does not belong to ${r.c}`);
        r.fn = raw.fn;
        if (r.fn !== site.fn) throw new RecordError(`fn ${JSON.stringify(raw.fn)} does not match ${r.sel}`);
        r.r = uintField("r", raw.r, U16);
        const row = site.rows.find((x) => x.row === r.r);
        if (!row) throw new RecordError(`${site.fn} does not charge row ${r.r}`);
        if (!row.sure) throw new RecordError(`${site.fn} row ${r.r} is a conditional site and cannot be a silence`);
        r.e = uintField("e", raw.e, U64_SAFE);
        r.spent = uintField("spent", raw.spent, U32);
        r.budget = uintField("budget", raw.budget, U32);
        // The whole claim of a silence record: the row was metered and there was
        // not room left. A record that does not say that is not evidence of
        // anything and is refused rather than displayed.
        if (r.budget === 0) throw new RecordError("a silence on an unmetered row is not a silence");
        if (r.spent < r.budget) throw new RecordError("a silence must name an exhausted budget");
    } else {
        r.e = uintField("e", raw.e, U64_SAFE);
        r.blk = uintField("blk", raw.blk, U64_SAFE);
        r.rows = rowsMap(raw.rows);
    }
    return r;
}

/// Canonical JSON for one record: schema field order, no whitespace, one chunk.
export function encode(record) {
    const r = validate(record);
    const parts = [];
    for (const k of FIELDS[r.k]) {
        let v = r[k];
        if (k === "rows") {
            // Rows ascending and numeric, so two relays over the same epoch
            // produce the same bytes.
            const keys = Object.keys(v).sort((a, b) => Number(a) - Number(b));
            v = keys.reduce((o, key) => ((o[key] = v[key]), o), {});
        }
        parts.push(JSON.stringify(k) + ":" + JSON.stringify(v));
    }
    const s = "{" + parts.join(",") + "}";
    const bytes = new TextEncoder().encode(s).length;
    if (bytes > MAX_CHUNK) {
        throw new RecordError(`record is ${bytes} bytes, over the ${MAX_CHUNK} byte single-chunk limit`);
    }
    return s;
}

/// Parse one message off the topic. Throws `RecordError` on anything it cannot
/// vouch for. The caller decides whether to drop the record or fail the run;
/// the relay fails, the page drops and says how many it dropped.
export function decode(text) {
    if (typeof text !== "string") throw new RecordError("a message must be a string");
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > MAX_CHUNK) throw new RecordError(`message is ${bytes} bytes, over the single-chunk limit`);
    let raw;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        throw new RecordError("message is not JSON: " + e.message);
    }
    const r = validate(raw);
    // A record whose canonical form differs from the bytes on the topic was not
    // written by this encoder. That is not automatically an attack, but it means
    // the record cannot be reproduced, and a receipt nobody can reproduce is
    // decoration.
    if (encode(r) !== text) throw new RecordError("message is not in canonical form");
    return r;
}

/// The dedupe key. Every record names something that happened exactly once, so
/// a consumer can drop a repeat without keeping a cursor of its own.
export function keyOf(r) {
    if (r.k === "charge" || r.k === "refusal") return `${r.k}:${r.c}:${r.tx}:${r.li}`;
    if (r.k === "silence") return `silence:${r.c}:${r.tx}:${r.r}`;
    return `checkpoint:${r.c}:${r.e}`;
}

/// One line of English per record, for a screen and for the verifier's table.
/// Kept here rather than in the page so the two cannot describe the same record
/// differently.
export function describe(r) {
    if (r.k === "charge") {
        return `charged ${r.cost} bit${r.cost === 1 ? "" : "s"} to row ${r.r} in epoch ${r.e}, ${r.after} spent after`;
    }
    if (r.k === "refusal") {
        return `refused a disclosure on row ${r.r}: over the ceiling by ${r.x}`;
    }
    if (r.k === "silence") {
        return `${r.fn} completed and said nothing on row ${r.r}: ${r.spent} of ${r.budget} bits were already gone in epoch ${r.e}`;
    }
    const rows = Object.keys(r.rows).sort((a, b) => Number(a) - Number(b));
    return `epoch ${r.e} closed at block ${r.blk}: ${rows.map((k) => `row ${k} spent ${r.rows[k]}`).join(", ")}`;
}

// ---------------------------------------------------------------- the audit

// Everything below is the check the verifier runs and the Rulebook screen
// renders. It is here, in the pure module, for the reason the arithmetic copies
// are: a page that showed a green tick next to a record using its own private
// idea of what "matches the chain" means could show a tick the verifier would
// not. One implementation, two callers, and `tools/hcs.test.mjs` holds it to
// fixtures captured off the mirror node.

const strip = (h) => String(h == null ? "" : h).replace(/^0x/, "").toLowerCase();
const wordAt = (data, i) => strip(data).slice(i * 64, (i + 1) * 64);
const uintOf = (h) => Number(BigInt("0x" + (h || "0")));

/// `DisclosureCharged(uint16 indexed row, uint64 indexed epoch, uint8 g,
/// uint32 cost, uint32 spentAfter)`, decoded from a mirror node log without an
/// ABI. The shape is asserted rather than assumed: a log that is not this event
/// throws here instead of becoming five plausible looking numbers.
export function decodeChargeLog(log) {
    if (!log || !Array.isArray(log.topics) || log.topics.length !== 3) {
        throw new RecordError("DisclosureCharged carries two indexed fields");
    }
    const data = strip(log.data);
    if (data.length !== 192) {
        throw new RecordError(`DisclosureCharged data is ${data.length / 2} bytes, want 96`);
    }
    return {
        row: uintOf(strip(log.topics[1])),
        epoch: uintOf(strip(log.topics[2])),
        g: uintOf(wordAt(data, 0)),
        cost: uintOf(wordAt(data, 1)),
        after: uintOf(wordAt(data, 2)),
    };
}

/// `DisclosureRefused(bytes32 indexed id, uint16 row, uint32 excess)`.
export function decodeRefusalLog(log) {
    if (!log || !Array.isArray(log.topics) || log.topics.length !== 2) {
        throw new RecordError("DisclosureRefused carries one indexed field");
    }
    const data = strip(log.data);
    if (data.length !== 128) {
        throw new RecordError(`DisclosureRefused data is ${data.length / 2} bytes, want 64`);
    }
    return {id: "0x" + strip(log.topics[1]), row: uintOf(wordAt(data, 0)), x: uintOf(wordAt(data, 1))};
}

/// Check one record against the transaction it names.
///
/// `res` is a mirror node contract result, the shape
/// `/api/v1/contracts/results/{hash}` returns, with its `logs`. `ctx` carries
/// the three things this module cannot read for itself: the address the record's
/// contract actually has, the disclosure epoch the transaction's timestamp falls
/// in, and, for a silence, the governed budget and what one disclosure at that
/// site costs.
///
/// Returns one row per assertion rather than a boolean, because "it failed" is
/// not a receipt either: a reader is owed which claim broke and what the chain
/// said instead.
export function auditRecord(rec, res, ctx) {
    const out = [];
    const say = (name, pass, detail) => out.push({name, pass: !!pass, detail: detail || ""});

    // Every comparison below is against something in `ctx`, so a `ctx` missing a
    // field would compare undefined to undefined and report a pass. An audit that
    // can be made to succeed by handing it less is not an audit, so the inputs
    // are checked before the record is.
    if (!ctx || typeof ctx.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(ctx.address)) {
        say("the audit was given an address to check against", false, `got ${ctx && ctx.address}`);
        return out;
    }
    if (!Number.isInteger(ctx.epoch) || ctx.epoch < 0) {
        say("the audit was given an epoch to check against", false, `got ${ctx.epoch}`);
        return out;
    }
    if (rec.k === "silence" &&
        (!Number.isInteger(ctx.budgetBits) || !Number.isInteger(ctx.cost))) {
        say("the audit was given the governed budget to check against", false,
            `got budget ${ctx.budgetBits}, cost ${ctx.cost}`);
        return out;
    }

    if (!res || !res.hash) {
        say("the mirror node has this transaction", false, res && res.error ? res.error : "not found");
        return out;
    }
    // The caller fetched this by hash, so a mismatch is the caller's wiring
    // rather than the chain's answer. Checked anyway: an audit that can be handed
    // the wrong transaction is an audit that can be made to pass.
    if (strip(res.hash) !== strip(rec.tx)) {
        say("the result is the transaction the record names", false, `got ${res.hash}`);
        return out;
    }
    const logs = Array.isArray(res.logs) ? res.logs : [];

    if (rec.k === "silence") {
        say("the transaction succeeded", res.result === "SUCCESS", `result ${res.result}`);
        say("the calldata carries the selector the record names",
            strip(res.function_parameters).slice(0, 8) === strip(rec.sel),
            "calldata 0x" + strip(res.function_parameters).slice(0, 8));
        say(`it was sent to ${rec.c}`, strip(res.address) === strip(ctx.address), `to ${res.address}`);
        say("the epoch is the one its timestamp falls in", ctx.epoch === rec.e,
            `timestamp is epoch ${ctx.epoch}`);
        let charged = [];
        try {
            charged = logs.filter((l) => strip(l.topics && l.topics[0]) === strip(TOPIC_CHARGED))
                .map((l) => decodeChargeLog(l).row);
        } catch (e) {
            say("its logs decode", false, e.message);
            return out;
        }
        say(`row ${rec.r} was not charged in it`, !charged.includes(rec.r),
            charged.length ? `charged ${charged.join(", ")}` : "charged nothing");
        say(`the budget is the one governance published for row ${rec.r}`,
            ctx.budgetBits === rec.budget, `budgetFor says ${ctx.budgetBits}`);
        say("the budget it names had no room left", rec.spent + ctx.cost > rec.budget,
            `${rec.spent} of ${rec.budget} spent, this one costs ${ctx.cost}`);
        return out;
    }

    const log = logs.find((l) => Number(l.index) === rec.li);
    if (!log) {
        say(`log ${rec.li} exists in that transaction`, false, `${logs.length} logs`);
        return out;
    }
    say(`it was emitted by ${rec.c}`, strip(log.address) === strip(ctx.address), `emitted by ${log.address}`);

    const want = rec.k === "charge" ? TOPIC_CHARGED : TOPIC_REFUSED;
    if (strip(log.topics && log.topics[0]) !== strip(want)) {
        say(`log ${rec.li} is a ${rec.k === "charge" ? "DisclosureCharged" : "DisclosureRefused"}`,
            false, String(log.topics && log.topics[0]));
        return out;
    }
    say(`log ${rec.li} is a ${rec.k === "charge" ? "DisclosureCharged" : "DisclosureRefused"}`, true);

    try {
        if (rec.k === "charge") {
            const d = decodeChargeLog(log);
            const same = d.row === rec.r && d.epoch === rec.e && d.g === rec.g
                && d.cost === rec.cost && d.after === rec.after;
            say("every field matches the log", same, same ? ""
                : `log says row ${d.row} epoch ${d.epoch} g ${d.g} cost ${d.cost} after ${d.after}`);
        } else {
            const d = decodeRefusalLog(log);
            const same = d.row === rec.r && d.x === rec.x && d.id === rec.id;
            say("every field matches the log", same, same ? ""
                : `log says id ${d.id} row ${d.row} excess ${d.x}`);
        }
    } catch (e) {
        say("the log decodes", false, e.message);
    }
    return out;
}
