// The vectors for `tools/hcs.mjs`, in the two kinds `units.test.mjs` uses.
//
// **The pinned vectors are the deployed contracts' own numbers.** Every selector
// in `SITES`, the charge topic, and the ceiling-error selector are recomputed here from
// `deployments/abi/*.json`, which `script/live/export-abis.sh` writes out of
// `out/`. So the silence table cannot drift from the chain by a rename, an
// argument reorder, or a stale copy: rebuilding the ABIs and running `make
// vectors` fails before anything is published.
//
// **The refusal vectors** are the messages the decoder must not accept. They
// carry no contract twin because the point of each is that it never becomes a
// receipt: a prototype-polluting key, a record whose bytes are not canonical, a
// silence claimed on a row with no budget to exhaust, a silence claimed at a
// site that sits behind an `if`.
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {Interface, id as keccakId} from "ethers";
import {
    MAX_CHUNK, SCHEMA_VERSION, SITES, SOURCES, SOURCE_ADDRESS_KEY,
    TOPIC_CHARGED, TOPIC_REFUSED, ERROR_CEILING, FIELDS, LEGACY_FIELDS,
    encode, decode, validate, keyOf, describe, auditRecord,
    decodeChargeLog, decodeRefusalLog, decodeCeilingError, RecordError,
} from "./hcs.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const abi = (name) => JSON.parse(readFileSync(join(root, "deployments/abi", name + ".json"), "utf8"));
const client = JSON.parse(readFileSync(join(root, "deployments/client.json"), "utf8"));
const ENGINE = client.addresses.MatchingEngine.toLowerCase();
const VAULT = client.addresses.RepoVault.toLowerCase();

let bad = 0;
const eq = (what, got, want) => {
    if (got !== want) {
        console.error(`FAIL ${what}\n  got  ${got}\n  want ${want}`);
        bad++;
    }
};
const ok = (what, cond) => {
    if (!cond) {
        console.error(`FAIL ${what}`);
        bad++;
    }
};
const refuses = (what, fn, match) => {
    try {
        fn();
    } catch (e) {
        if (!(e instanceof RecordError)) {
            console.error(`FAIL ${what}: threw ${e.constructor.name}, want RecordError`);
            bad++;
        } else if (match && !e.message.includes(match)) {
            console.error(`FAIL ${what}: message missing ${JSON.stringify(match)}\n  ${e.message}`);
            bad++;
        }
        return;
    }
    console.error(`FAIL ${what}: did not throw`);
    bad++;
};

// ---------------------------------------------------------------- the chain

// Event and error selectors, off the deployed ABIs rather than off a comment.
{
    const seen = {};
    let ceilingError = null;
    for (const name of ["MatchingEngine", "RepoVault"]) {
        const i = new Interface(abi(name));
        i.forEachEvent((ev) => { seen[ev.name] = ev.topicHash; });
        if (name === "RepoVault") {
            ceilingError = i.getError("DisclosureExceedsCeiling").selector;
        }
    }
    eq("DisclosureCharged topic hash", seen.DisclosureCharged, TOPIC_CHARGED);
    eq("DisclosureExceedsCeiling selector", ceilingError, ERROR_CEILING);
    eq("TOPIC_CHARGED is the signature it claims", TOPIC_CHARGED,
        keccakId("DisclosureCharged(uint16,uint64,uint8,uint32,uint32)"));
    eq("ERROR_CEILING is the signature it claims", ERROR_CEILING,
        keccakId("DisclosureExceedsCeiling(uint16,uint32)").slice(0, 10));
    eq("TOPIC_REFUSED retains its legacy signature", TOPIC_REFUSED,
        keccakId("DisclosureRefused(bytes32,uint16,uint32)"));
}

// Every silence site is a real external function on the contract it names, and
// every disclosing external function the venue has is either in the table or
// deliberately absent from it. The second half is what stops a new entry point
// from being silently unwatched.
{
    const ifaces = {
        engine: new Interface(abi("MatchingEngine")),
        vault: new Interface(abi("RepoVault")),
    };
    for (const [sel, site] of Object.entries(SITES)) {
        ok(`${site.fn} names a known source`, SOURCES.includes(site.src));
        let fn = null;
        ifaces[site.src].forEachFunction((f) => { if (f.selector === sel) fn = f; });
        ok(`${sel} is a function on ${site.src}`, fn !== null);
        if (fn) {
            eq(`${sel} is ${site.fn}`, fn.name, site.fn);
            ok(`${site.fn} is not a view`, fn.stateMutability !== "view" && fn.stateMutability !== "pure");
        }
        ok(`${site.fn} charges at least one row`, site.rows.length > 0);
        for (const r of site.rows) {
            ok(`${site.fn} row ${r.row} is a uint16`, Number.isInteger(r.row) && r.row >= 0 && r.row <= 0xffff);
            ok(`${site.fn} row ${r.row} names a granularity`, r.g >= 0 && r.g <= 4);
            ok(`${site.fn} row ${r.row} states whether it is unconditional`, typeof r.sure === "boolean");
        }
    }
    // Selectors are unique by construction, but a copied line in the table would
    // silently overwrite one, and an overwritten site is an unwatched one.
    eq("no selector is written twice", Object.keys(SITES).length, new Set(Object.keys(SITES)).size);
}

// The short names resolve to contracts the client actually holds an address for.
for (const s of SOURCES) {
    ok(`${s} names a deployed contract`, !!client.addresses[SOURCE_ADDRESS_KEY[s]]);
}

// Every row the table calls metered carries a budget in the deployed set, and
// every row it calls unmetered carries none. This is the join between the
// silence rule and the governance parameters, and it is the one that decides
// whether a silence record can exist at all.
{
    const metered = new Set();
    for (const [k, v] of Object.entries(client.disclosure)) {
        if (v && v.metered) metered.add(Number(k.replace("row", "")));
    }
    eq("the deployed set meters three rows", [...metered].sort((a, b) => a - b).join(","), "13,14,15");
    for (const site of Object.values(SITES)) {
        for (const r of site.rows) {
            if (r.sure && metered.has(r.row)) continue;
            // Nothing to assert about an unmetered or conditional site beyond
            // its being unable to produce a silence, which `validate` enforces.
        }
    }
}

// ------------------------------------------------------------ the round trip

const CHARGE = {
    v: 1, k: "charge", c: "engine",
    tx: "0xa7e2287bec0fadcdeccc3c3484acab1d081eae2a6eca219b20b76b80c41950f3",
    li: 0, r: 15, e: 39, g: 1, cost: 1, after: 1,
};
const SILENCE = {
    v: 1, k: "silence", c: "engine",
    tx: "0x2885d8da867b1cab43863698895a2bf78fb35114743a33849ba5f771cc707594",
    sel: "0xc4d252f5", fn: "cancel", r: 15, e: 39, spent: 1, budget: 1,
};
const REFUSAL = {
    v: 1, k: "refusal", c: "vault",
    tx: "0x" + "11".repeat(32), li: 3,
    id: "0x" + "22".repeat(32), r: 14, x: 2,
};
const CEILING = {
    v: SCHEMA_VERSION, k: "ceiling", c: "vault", a: VAULT,
    tx: "0x" + "11".repeat(32),
    sel: "0x778ae762", fn: "open", r: 7, x: 2,
};
const CHECKPOINT = {
    v: 1, k: "checkpoint", c: "engine", e: 39, blk: 40154879,
    rows: {3: 0, 4: 0, 5: 0, 7: 0, 12: 0, 13: 0, 14: 0, 15: 1, 16: 0, 17: 0},
};
const CHARGE_V2 = {...CHARGE, v: SCHEMA_VERSION, a: ENGINE};

eq("a charge encodes to its canonical bytes", encode(CHARGE),
    '{"v":1,"k":"charge","c":"engine","tx":"0xa7e2287bec0fadcdeccc3c3484acab1d081eae2a6eca219b20b76b80c41950f3",'
    + '"li":0,"r":15,"e":39,"g":1,"cost":1,"after":1}');
eq("a silence encodes to its canonical bytes", encode(SILENCE),
    '{"v":1,"k":"silence","c":"engine","tx":"0x2885d8da867b1cab43863698895a2bf78fb35114743a33849ba5f771cc707594",'
    + '"sel":"0xc4d252f5","fn":"cancel","r":15,"e":39,"spent":1,"budget":1}');
eq("a legacy refusal keeps its canonical bytes", encode(REFUSAL),
    '{"v":1,"k":"refusal","c":"vault","tx":"0x1111111111111111111111111111111111111111111111111111111111111111",'
    + '"li":3,"id":"0x2222222222222222222222222222222222222222222222222222222222222222","r":14,"x":2}');

for (const [name, rec] of [["charge", CHARGE], ["silence", SILENCE],
                           ["legacy refusal", REFUSAL], ["ceiling", CEILING],
                           ["checkpoint", CHECKPOINT],
                           ["address-bound charge", CHARGE_V2]]) {
    const text = encode(rec);
    const back = decode(text);
    eq(`${name} survives a round trip`, encode(back), text);
    ok(`${name} fits one chunk`, new TextEncoder().encode(text).length <= MAX_CHUNK);
    ok(`${name} has a dedupe key`, typeof keyOf(back) === "string" && keyOf(back).length > 0);
    ok(`${name} describes itself`, describe(back).length > 10);
    eq(`${name} decodes onto a null prototype`, Object.getPrototypeOf(back), null);
}

// The widest checkpoint the venue can produce: every published row, each at the
// largest `spentBits` a uint32 holds. The scope claims headroom; this is the
// assertion behind the claim rather than the claim.
{
    const rows = {};
    for (const r of [3, 4, 5, 7, 12, 13, 14, 15, 16, 17]) rows[r] = 0xffffffff;
    const wide = encode({
        v: SCHEMA_VERSION, k: "checkpoint", c: "vault", a: VAULT,
        e: 9007199254740991, blk: 9007199254740991, rows,
    });
    const size = new TextEncoder().encode(wide).length;
    ok(`the widest checkpoint is one chunk (${size} bytes)`, size <= MAX_CHUNK);
}

eq("the current record order binds its address", FIELDS.charge.join(","),
    "v,k,c,a,tx,li,r,e,g,cost,after");
eq("the legacy record order stays decodable", LEGACY_FIELDS.charge.join(","),
    "v,k,c,tx,li,r,e,g,cost,after");
eq("the legacy refusal shape stays decodable", LEGACY_FIELDS.refusal.join(","),
    "v,k,c,tx,li,id,r,x");
eq("the schema version is 2", SCHEMA_VERSION, 2);

// ------------------------------------------------------------- the refusals

refuses("a bare string is not a record", () => decode("hello"), "not JSON");
refuses("an array is not a record", () => decode("[1,2,3]"), "must be a JSON object");
refuses("null is not a record", () => decode("null"), "must be a JSON object");
refuses("an unknown version is refused", () => decode('{"v":3,"k":"charge"}'), "unknown schema version");
refuses("a current record without its source address is refused",
    () => validate({...CHARGE, v: SCHEMA_VERSION}), "missing field a");
refuses("an unknown kind is refused", () => validate({...CHARGE, k: "shout"}), "unknown kind");
refuses("a legacy ceiling kind is refused",
    () => validate({...CEILING, v: 1, a: undefined}), "unknown kind");
refuses("a current refusal kind is refused",
    () => validate({...REFUSAL, v: SCHEMA_VERSION, a: VAULT}), "unknown kind");

refuses("an extra field is refused, not ignored",
    () => validate({...CHARGE, extra: 1}), "unexpected field");
refuses("a missing field is refused",
    () => { const c = {...CHARGE}; delete c.cost; validate(c); }, "missing field");

// Prototype pollution, twice: once through a top level key and once through the
// one field whose key set is open.
refuses("__proto__ at the top level is refused",
    () => decode('{"v":1,"k":"charge","c":"engine","tx":"0x' + "00".repeat(32)
        + '","li":0,"r":15,"e":1,"g":1,"cost":1,"after":1,"__proto__":{"polluted":1}}'));
refuses("__proto__ inside rows is refused",
    () => decode('{"v":1,"k":"checkpoint","c":"engine","e":1,"blk":1,"rows":{"__proto__":1}}'));
ok("nothing was polluted", ({}).polluted === undefined && ({}).x === undefined);

refuses("a short transaction hash is refused",
    () => validate({...CHARGE, tx: "0xdeadbeef"}), "32 lowercase hex bytes");
refuses("an upper case transaction hash is refused",
    () => validate({...CHARGE, tx: "0xA7" + "00".repeat(31)}), "lowercase");
refuses("a negative cost is refused", () => validate({...CHARGE, cost: -1}), "integer in");
refuses("a fractional row is refused", () => validate({...CHARGE, r: 15.5}), "integer in");
refuses("a granularity above the lattice is refused", () => validate({...CHARGE, g: 5}), "g must");
refuses("a charge whose running total is below its own cost is refused",
    () => validate({...CHARGE, cost: 2, after: 1}), "below the charge");
refuses("an unknown contract is refused", () => validate({...CHARGE, c: "axeboard"}), "c must be one of");

refuses("a ceiling record at an unknown selector is refused",
    () => validate({...CEILING, sel: "0xdeadbeef"}), "not a disclosing entry point");
refuses("a ceiling record whose name does not match is refused",
    () => validate({...CEILING, fn: "close"}), "does not match");
refuses("a ceiling record on another row is refused",
    () => validate({...CEILING, r: 13}), "does not disclose row");
refuses("a ceiling record with zero excess is refused",
    () => validate({...CEILING, x: 0}), "non-zero excess");

refuses("a silence at an unknown selector is refused",
    () => validate({...SILENCE, sel: "0xdeadbeef"}), "not a disclosing entry point");
refuses("a silence whose name does not match its selector is refused",
    () => validate({...SILENCE, fn: "commit"}), "does not match");
refuses("a silence on a row the function does not charge is refused",
    () => validate({...SILENCE, r: 3}), "does not charge row");
refuses("a silence on an unmetered row is refused",
    () => validate({...SILENCE, r: 17, sel: "0xf14fcbc8", fn: "commit", spent: 0, budget: 0}),
    "not a silence");
refuses("a silence with no budget to exhaust is refused",
    () => validate({...SILENCE, budget: 0}), "not a silence");
refuses("a silence with budget left is refused",
    () => validate({...SILENCE, spent: 0, budget: 1}), "exhausted budget");
refuses("a silence at a conditional site is refused",
    () => validate({v: 1, k: "silence", c: "vault", tx: "0x" + "33".repeat(32),
        sel: "0x8dcf2bd0", fn: "postMark", r: 14, e: 1, spent: 2, budget: 2}),
    "conditional site");
refuses("a silence naming the wrong contract is refused",
    () => validate({...SILENCE, c: "vault"}), "does not belong to");

// Canonical form. Same content, different key order, and it is refused: a
// verifier that re-encodes and compares bytes has to be able to.
refuses("a reordered record is refused",
    () => decode('{"k":"charge","v":1,"c":"engine","tx":"0x' + "00".repeat(32)
        + '","li":0,"r":15,"e":1,"g":1,"cost":1,"after":1}'), "canonical");
refuses("a pretty printed record is refused",
    () => decode(JSON.stringify(CHARGE, null, 1)), "canonical");

refuses("a message over the chunk limit is refused",
    () => decode("x".repeat(MAX_CHUNK + 1)), "single-chunk limit");
refuses("a checkpoint too wide to encode is refused", () => {
    const rows = {};
    for (let i = 0; i < 64; i++) rows[10000 + i] = 0xffffffff;
    encode({v: 1, k: "checkpoint", c: "engine", e: 1, blk: 1, rows});
}, "single-chunk limit");
refuses("a checkpoint with more than 64 rows is refused", () => {
    const rows = {};
    for (let i = 0; i < 65; i++) rows[i] = 0;
    validate({v: 1, k: "checkpoint", c: "engine", e: 1, blk: 1, rows});
}, "more than 64");

// ------------------------------------------------------------- the forgeries
//
// The schema vectors above say what the decoder will not parse. These say what
// the chain check will not believe, which is the claim `docs/HCS-SCOPE.md` rests
// the whole design on: **the relay cannot forge.** Each case is the real
// transaction with one field moved, and the audit has to fail on exactly that
// field. Two mirror node results, captured off testnet and trimmed to the fields
// `auditRecord` reads, so the vectors run offline and cannot pass because a
// network call quietly returned nothing.

/// `cancel` that charged row 15. HashScan carries it under this hash.
const RES_CHARGE = {
    hash: "0xa7e2287bec0fadcdeccc3c3484acab1d081eae2a6eca219b20b76b80c41950f3",
    address: ENGINE,
    result: "SUCCESS",
    timestamp: "1788643884.069755616",
    function_parameters: "0xc4d252f5921cb97387854a45927f5f822e62b34680d09ae7b58121f8583ec479ea6fbdf0",
    logs: [
        {
            index: 0, address: ENGINE,
            topics: [
                TOPIC_CHARGED,
                "0x000000000000000000000000000000000000000000000000000000000000000f",
                "0x0000000000000000000000000000000000000000000000000000000000000027",
            ],
            data: "0x" + "0".repeat(63) + "1" + "0".repeat(63) + "1" + "0".repeat(63) + "1",
        },
        {
            index: 1, address: ENGINE,
            topics: ["0xbaa1eb22f2a492ba1a5fea61b8df4d27c6c8b5f3971e63bb58fa14ff72eedb70",
                     "0x921cb97387854a45927f5f822e62b34680d09ae7b58121f8583ec479ea6fbdf0"],
            data: "0x",
        },
    ],
};

/// The second `cancel` of the same epoch: it succeeded, refunded the same bond,
/// and emitted nothing at all. This is the transaction the venue exists to be
/// able to describe.
const RES_SILENCE = {
    hash: "0x2885d8da867b1cab43863698895a2bf78fb35114743a33849ba5f771cc707594",
    address: ENGINE,
    result: "SUCCESS",
    timestamp: "1788643906.107383104",
    function_parameters: "0xc4d252f5b2f1c4161fd5365052b9e12c6883d8af5e3b137fbf42214cc2314f33ab86560a",
    logs: [],
};

const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const RES_CEILING = {
    hash: CEILING.tx,
    address: VAULT,
    result: "CONTRACT_REVERT_EXECUTED",
    error_message: ERROR_CEILING + word(7) + word(2),
    timestamp: "1788643907.000000000",
    function_parameters: CEILING.sel + "00".repeat(128),
    logs: [],
};

const CTX_CHARGE = {address: ENGINE, epoch: 39};
const CTX_SILENCE = {address: ENGINE, epoch: 39, budgetBits: 1, cost: 1};
const CTX_CEILING = {address: VAULT};

const audits = (what, rec, res, ctx, wantPass) => {
    const rows = auditRecord(rec, res, ctx);
    const failed = rows.filter((x) => !x.pass);
    if (wantPass && failed.length) {
        console.error(`FAIL ${what}: expected a clean audit, got\n  ` +
            failed.map((x) => x.name + " :: " + x.detail).join("\n  "));
        bad++;
    } else if (!wantPass && failed.length === 0) {
        console.error(`FAIL ${what}: the audit passed a record it should have caught`);
        bad++;
    }
    return rows;
};

// The two real records audit clean against the two real transactions. Without
// this the refusals below would pass for the wrong reason.
audits("the real charge audits clean", decode(encode(CHARGE)), RES_CHARGE, CTX_CHARGE, true);
audits("an address-bound charge audits clean",
    decode(encode(CHARGE_V2)), RES_CHARGE, CTX_CHARGE, true);
audits("the real silence audits clean", decode(encode(SILENCE)), RES_SILENCE, CTX_SILENCE, true);
audits("a typed ceiling refusal audits clean",
    decode(encode(CEILING)), RES_CEILING, CTX_CEILING, true);

// One field at a time, against the log that says otherwise.
for (const [field, value] of [["r", 13], ["e", 40], ["g", 4], ["cost", 2], ["after", 3]]) {
    audits(`a charge with ${field} changed is caught`,
        validate({...CHARGE, [field]: value, ...(field === "cost" ? {after: 2} : {})}),
        RES_CHARGE, CTX_CHARGE, false);
}
audits("a charge pointing at a log index that is not a charge is caught",
    validate({...CHARGE, li: 1}), RES_CHARGE, CTX_CHARGE, false);
audits("a charge pointing at a log index that does not exist is caught",
    validate({...CHARGE, li: 9}), RES_CHARGE, CTX_CHARGE, false);
audits("a charge attributed to the wrong contract is caught",
    validate(CHARGE), RES_CHARGE, {...CTX_CHARGE, address: "0x" + "ab".repeat(20)}, false);
audits("an address-bound record cannot be audited against a replacement",
    validate(CHARGE_V2), RES_CHARGE,
    {...CTX_CHARGE, address: "0x" + "ab".repeat(20)}, false);

// An audit handed less than it needs must fail, not pass vacuously. Without
// these, comparing an absent address to an absent address reads as a match, and
// the tick on the Rulebook screen would mean "nothing was checked".
audits("an audit with no address to check against is caught",
    validate(CHARGE), RES_CHARGE, {epoch: 39}, false);
audits("an audit with no epoch to check against is caught",
    validate(SILENCE), RES_SILENCE, {address: ENGINE, budgetBits: 1, cost: 1}, false);
audits("a silence audit with no governed budget is caught",
    validate(SILENCE), RES_SILENCE, {address: ENGINE, epoch: 39}, false);
audits("a charge invented out of nothing is caught",
    validate({...CHARGE, tx: "0x" + "cd".repeat(32)}), {hash: null}, CTX_CHARGE, false);

// A silence is the record with the most to gain from being invented, so it gets
// the most refusals: a transaction that reverted, a different entry point, the
// wrong epoch, a row that was in fact charged, and a budget with room in it.
audits("a silence on a reverted transaction is caught",
    validate(SILENCE), {...RES_SILENCE, result: "CONTRACT_REVERT_EXECUTED"}, CTX_SILENCE, false);
audits("a silence whose selector is not the calldata's is caught",
    validate(SILENCE), {...RES_SILENCE, function_parameters: "0xf14fcbc8" + "00".repeat(32)},
    CTX_SILENCE, false);
audits("a silence in the wrong epoch is caught",
    validate(SILENCE), RES_SILENCE, {...CTX_SILENCE, epoch: 40}, false);
audits("a silence claimed on a row the transaction did charge is caught",
    validate({...SILENCE, tx: RES_CHARGE.hash}), RES_CHARGE, CTX_SILENCE, false);
audits("an audit handed the wrong transaction is caught",
    validate(SILENCE), RES_CHARGE, CTX_SILENCE, false);
audits("a silence measured against a budget the venue does not publish is caught",
    validate(SILENCE), RES_SILENCE, {...CTX_SILENCE, budgetBits: 3}, false);
audits("a silence with room left in the row is caught",
    validate({...SILENCE, spent: 4, budget: 4}), RES_SILENCE,
    {...CTX_SILENCE, budgetBits: 4, cost: 0}, false);

audits("a ceiling record on a successful transaction is caught",
    validate(CEILING), {...RES_CEILING, result: "SUCCESS"}, CTX_CEILING, false);
audits("a ceiling record whose selector is not the calldata's is caught",
    validate(CEILING), {...RES_CEILING, function_parameters: "0x39c79e0c"},
    CTX_CEILING, false);
audits("a ceiling record with a changed row is caught",
    validate(CEILING),
    {...RES_CEILING, error_message: ERROR_CEILING + word(13) + word(2)},
    CTX_CEILING, false);
audits("a ceiling record without the typed revert data is caught",
    validate(CEILING), {...RES_CEILING, error_message: "0x"}, CTX_CEILING, false);

// The log decoders refuse a shape that is not the event, rather than reading
// five numbers out of whatever is there.
refuses("a charge log with one indexed field is refused",
    () => decodeChargeLog({topics: [TOPIC_CHARGED, "0x00"], data: "0x"}), "two indexed fields");
refuses("a charge log with short data is refused",
    () => decodeChargeLog({topics: [TOPIC_CHARGED, "0x0f", "0x27"], data: "0x00"}), "want 96");
refuses("a legacy refusal log with short data is refused",
    () => decodeRefusalLog({topics: [TOPIC_REFUSED, REFUSAL.id], data: "0x00"}), "want 64");
refuses("a short ceiling error is refused",
    () => decodeCeilingError(ERROR_CEILING), "want 68");
refuses("another custom error is not a ceiling refusal",
    () => decodeCeilingError("0xdeadbeef" + word(14) + word(2)),
    "not DisclosureExceedsCeiling");

eq("a charge log decodes to the event it carries",
    JSON.stringify(decodeChargeLog(RES_CHARGE.logs[0])),
    JSON.stringify({row: 15, epoch: 39, g: 1, cost: 1, after: 1}));
eq("a legacy refusal log decodes to the event it carries",
    JSON.stringify(decodeRefusalLog({
        topics: [TOPIC_REFUSED, REFUSAL.id],
        data: "0x" + word(14) + word(2),
    })),
    JSON.stringify({id: REFUSAL.id, row: 14, x: 2}));
eq("a ceiling error decodes to the refusal it carries",
    JSON.stringify(decodeCeilingError(RES_CEILING.error_message)),
    JSON.stringify({row: 7, x: 2}));

// ------------------------------------------------------------------ verdict

if (bad) {
    console.error(`\n${bad} hcs vector${bad === 1 ? "" : "s"} failed`);
    process.exit(1);
}
console.log("hcs.mjs: schema, silence table and ceiling errors agree with the deployed ABIs");
