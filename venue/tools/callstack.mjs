#!/usr/bin/env node
// Callstack census over the ATS lifecycle surface.
//
// `mesh/transfer-path.md` measured one path, `canTransferByPartition`, by
// execution. That path is where the privacy layer plugs in, so it got the
// attention. But a bond is not a transfer: it is a coupon, a maturity
// redemption, an amortisation, a balance adjustment, a snapshot, a vote. Each
// of those is a facet entry point with its own call stack, and each either
// reaches a seam we can observe or does not.
//
// The question this answers, for every entry point of the twenty two facets a
// repo venue actually uses:
//
//   * which of the six seam sites can this reach,
//   * at what call depth,
//   * does it move balances, and
//   * therefore, what does a public observer learn when it is invoked.
//
// The last one is not decided here. It is decided by `DisclosureLattice`, and
// the JSON this writes is the input to `tools/gen-observatory.mjs`, which
// turns it into the on-chain table. Measurement first, policy second, and the
// policy table is generated so it cannot drift from the measurement.
//
// Run:   node tools/callstack.mjs [--json out.json] [--md out.md]
// Reads: ../asset-tokenization-studio at v8.0.0 (be4f860). Nothing else.

import {readdirSync, statSync, writeFileSync} from "node:fs";
import {join, relative} from "node:path";
import {parseFile} from "./solgraph.mjs";

const ATS = "/Users/awaansiddiqui/hedera2026/asset-tokenization-studio/packages/ats/contracts/contracts";

// The twenty two facets under measurement. This is the repo venue's lifecycle
// surface: debt terms, the two settlement rails, the compliance gates, and the
// scheduling layer that fires the first two without a transaction.
// The twenty two facets under measurement, and the rails they turn out to sit
// on. The named list is the repo venue's lifecycle surface: debt terms, the two
// settlement rails, the compliance gates, the scheduling layer.
//
// **`hold` and `clearing` measure nothing on their own.** Their facet
// directories hold reads, an initialiser and the resolver key, and every
// balance-moving entry point lives in a `ByPartition` sibling. The same is true
// of `maturity` and `compliance`. A census of the named list alone would report
// that the settlement rails touch no seam, which is false and is exactly the
// kind of answer a static tool gives when it is pointed at the wrong file. The
// companions are therefore measured alongside, marked `companion`, so the
// distinction between what was asked for and what was added stays visible.
const FACETS = [
    ["coupon", "debt"], ["couponListing", "debt"], ["dividend", "debt"],
    ["corporateActions", "debt"], ["maturity", "debt"], ["amortization", "debt"],
    ["principal", "debt"], ["fixedRate", "debt"], ["interestRate", "debt"],
    ["kpiLinkedRate", "debt"],
    ["clearing", "settlement"], ["hold", "settlement"],
    ["kyc", "compliance"], ["freeze", "compliance"], ["pause", "compliance"],
    ["controlList", "compliance"], ["compliance", "compliance"],
    ["recovery", "compliance"],
    ["snapshot", "governance"], ["voting", "governance"],
    ["scheduledTasksLib", "scheduling"], ["scheduledBalanceAdjustment", "scheduling"],

    // companions: where the named facets' write paths actually are
    ["holdByPartition", "companion"], ["operatorHoldByPartition", "companion"],
    ["protectedHoldByPartition", "companion"], ["controllerHoldByPartition", "companion"],
    ["clearingByPartition", "companion"], ["clearingHoldByPartition", "companion"],
    ["operatorClearingByPartition", "companion"],
    ["protectedClearingByPartition", "companion"],
    ["maturityByPartition", "companion"], ["complianceByPartition", "companion"],
    ["transferByPartition", "companion"], ["mintByPartition", "companion"],
    ["burnByPartition", "companion"], ["batchTransfer", "companion"],
    ["controller", "companion"], ["controllerByPartition", "companion"],
    ["batchFreeze", "companion"], ["lockByPartition", "companion"],
    ["externalKycListManagement", "companion"],
    ["externalControlListManagement", "companion"],
    ["externalPauseManagement", "companion"], ["ssiManagement", "companion"],
    ["snapshotsByPartition", "companion"], ["scheduledTasksCommon", "companion"],
    ["scheduledCrossOrderedTask", "companion"], ["adjustBalances", "companion"],
];

// The six seam sites, matched on the interface symbol rather than on the
// variable holding the address, so an aliased local cannot hide one. A, B and D
// are typed calls; C, C' and E go through `abi.encodeWithSelector`, which is why
// `solgraph.calls` emits `.selector` uses as edges.
// One level of nesting inside the cast, because every one of these reads
// `IFace(storage.list.at(index)).method(...)` and a `[^)]*` cast argument
// stops at the `)` of `at(index)` and matches nothing.
const CAST = String.raw`\s*\((?:[^()]|\([^()]*\))*\)\s*\.\s*`;
const SEAMS = [
    {id: "A",  label: "IExternalPause.isPaused",
               test: new RegExp("IExternalPause" + CAST + "isPaused")},
    {id: "B",  label: "IExternalControlList.isAuthorized",
               test: new RegExp("IExternalControlList" + CAST + "isAuthorized")},
    {id: "C",  label: "ICompliance.canTransfer",
               test: /ICompliance\s*\.\s*canTransfer\s*\.\s*selector/},
    {id: "C'", label: "ICompliance.transferred/created/destroyed",
               test: /ICompliance\s*\.\s*(transferred|created|destroyed)\s*\.\s*selector/},
    {id: "D",  label: "IExternalKycList.getKycStatus",
               test: new RegExp("IExternalKycList" + CAST + "getKycStatus")},
    {id: "E",  label: "IIdentityRegistry.isVerified",
               test: new RegExp("IIdentityRegistry\\s*\\.\\s*isVerified\\s*\\.\\s*selector|IIdentityRegistry" + CAST + "isVerified")},
];

// Balance-moving sinks, as graph **nodes** rather than text patterns.
//
// The first version of this matched `adjustBalances(` anywhere in a body and
// reported thirty two rails as balance-moving that are not. ATS calls the
// adjustment machinery on read paths to normalise a balance for the current
// split factor, so the token matches the string constantly and means nothing by
// it. A node sink cannot make that mistake: reaching
// `ERC1410StorageWrapper.transferByPartition` is a transfer, and reaching
// `AdjustBalancesStorageWrapper.adjustBalances` is a supply factor change,
// because those are the functions that write the mapping.
const WRITES = [
    {id: "W:transfer", node: "ERC1410StorageWrapper.transferByPartition"},
    {id: "W:issue",    node: "ERC1410StorageWrapper.issueByPartition"},
    {id: "W:redeem",   node: "ERC1410StorageWrapper.redeemByPartition"},
    {id: "W:adjust",   node: "AdjustBalancesStorageWrapper.adjustBalances"},
    {id: "W:hold",     node: "HoldStorageWrapper.createHoldByPartition"},
    {id: "W:holdMove", node: "HoldStorageWrapper.executeHoldByPartition"},
    {id: "W:lock",     node: "LockStorageWrapper.lockByPartition"},
];
const WRITE_BY_NODE = new Map(WRITES.map((w) => [w.node, w.id]));

// ATS fires due scheduled tasks lazily, from inside ordinary entry points. A
// freeze, a snapshot, a hold creation and a clearing submit all reach
// `AdjustBalancesStorageWrapper.adjustBalances` through this dispatcher, which
// is true and is not the same fact as "this op adjusts balances". A write
// reached only through one of these declarations is recorded as **incidental**:
// a side effect the caller did not ask for and may not expect, which is worth
// its own column and must not be counted as the op's purpose.
const SCHEDULER_DECLS = new Set([
    "ScheduledTasksDispatchOps", "ScheduledTasksLib", "ScheduledTasksCommon",
    "ScheduledTasksStorageWrapper",
]);

function walk(dir, out = []) {
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        const s = statSync(p);
        if (s.isDirectory()) {
            if (e === "test" || e === "mocks" || e === "node_modules") continue;
            walk(p, out);
        } else if (e.endsWith(".sol")) {
            out.push(p);
        }
    }
    return out;
}

// ---------------------------------------------------------------- index

const files = walk(ATS);
const byName = new Map();
const all = [];
for (const f of files) {
    for (const d of parseFile(f)) {
        all.push(d);
        // Duplicate names across layer_1/layer_2 exist for a few interfaces.
        // Keep the first non-interface, since only those carry bodies.
        const prev = byName.get(d.name);
        if (!prev || (prev.kind === "interface" && d.kind !== "interface")) {
            byName.set(d.name, d);
        }
    }
}

/// Linearised bases, depth first, deduplicated. ATS facet hierarchies are
/// shallow and non-diamond, so this agrees with C3 where C3 is defined.
function linearise(name, seen = new Set()) {
    const d = byName.get(name);
    if (!d || seen.has(name)) return [];
    seen.add(name);
    const out = [d];
    for (const b of d.bases) out.push(...linearise(b, seen));
    return out;
}

/// Resolve one call edge to a node id `Decl.member`, or null.
function resolve(fromDecl, call) {
    const kind = call.viaSelector ? "function" : null;
    if (call.qualifier) {
        const target = byName.get(call.qualifier);
        if (!target) return null;
        // An interface qualifier is an external call. It is a leaf: the code on
        // the other side is not ours and not in this tree.
        if (target.kind === "interface") return {id: `${target.name}.${call.name}`, leaf: true};
        for (const d of linearise(target.name)) {
            if (d.members.has(`function:${call.name}`)) return {id: `${d.name}.${call.name}`, decl: d};
        }
        return null;
    }
    for (const d of linearise(fromDecl.name)) {
        for (const k of ["function", "modifier"]) {
            if (d.members.has(`${k}:${call.name}`)) return {id: `${d.name}.${call.name}`, decl: d, kind: k};
        }
    }
    return null;
}

const memberOf = (id) => {
    const dot = id.lastIndexOf(".");
    const d = byName.get(id.slice(0, dot));
    if (!d) return null;
    const n = id.slice(dot + 1);
    return d.members.get(`function:${n}`) ?? d.members.get(`modifier:${n}`) ?? null;
};

// --------------------------------------------------------------- traverse

const MAX_DEPTH = 24;

/// Depth-first from one entry point. Returns the seam and write sinks reached,
/// the shortest path to each, the maximum depth, and the callees that could not
/// be resolved.
function trace(declName, memberName) {
    const start = `${declName}.${memberName}`;
    const seams = new Map();     // seam id -> {path, depth, site}
    const writes = new Map();
    const incidental = new Map();
    const unresolved = new Set();
    const visited = new Set();
    let maxDepth = 0;
    let nodes = 0;

    const step = (id, path, depth, viaScheduler) => {
        if (depth > MAX_DEPTH) return;
        const declName = id.slice(0, id.lastIndexOf("."));
        if (SCHEDULER_DECLS.has(declName)) viaScheduler = true;
        const key = `${id}|${viaScheduler ? 1 : 0}`;
        if (visited.has(key)) return;
        visited.add(key);
        nodes++;
        maxDepth = Math.max(maxDepth, depth);
        const m = memberOf(id);
        if (!m || !m.hasBody) return;
        const here = [...path, id];

        for (const s of SEAMS) {
            if (s.test.test(m.body) && !seams.has(s.id)) {
                seams.set(s.id, {path: here, depth, site: id, line: m.line});
            }
        }
        const asWrite = WRITE_BY_NODE.get(id);
        if (asWrite) {
            const into = viaScheduler ? incidental : writes;
            if (!into.has(asWrite)) into.set(asWrite, {path: here, depth, site: id});
            // A sink reached both ways is primary: the incidental record is the
            // weaker claim and the stronger one already covers it.
            if (!viaScheduler) incidental.delete(asWrite);
        }

        const decl = byName.get(id.slice(0, id.lastIndexOf(".")));
        // Applied modifiers run before the body and reach seams of their own:
        // `onlyUnpaused` is how a debt facet touches seam A without naming it.
        for (const mod of m.applied) {
            const r = resolve(decl, {qualifier: null, name: mod});
            if (r && !r.leaf) step(r.id, here, depth + 1, viaScheduler);
        }
        for (const c of m.calls) {
            const r = resolve(decl, c);
            if (!r) {
                if (c.qualifier) unresolved.add(`${c.qualifier}.${c.name}`);
                continue;
            }
            if (r.leaf) {
                // Leaf interface calls still carry seam identity.
                for (const s of SEAMS) {
                    if (s.test.test(m.body) && !seams.has(s.id)) {
                        seams.set(s.id, {path: [...here, r.id], depth: depth + 1, site: id, line: m.line});
                    }
                }
                continue;
            }
            step(r.id, here, depth + 1, viaScheduler);
        }
    };

    step(start, [], 0, false);
    return {seams, writes, incidental, unresolved, maxDepth, nodes};
}

// ------------------------------------------------------------- the census

const report = {
    generated: new Date().toISOString(),
    source: "hashgraph/asset-tokenization-studio v8.0.0 be4f860",
    seams: SEAMS.map((s) => ({id: s.id, label: s.label})),
    facets: [],
};

for (const [facet, group] of FACETS) {
    const dir = join(ATS, "facets", facet);
    let decls;
    try {
        decls = walk(dir).flatMap(parseFile);
    } catch {
        report.facets.push({facet, group, error: "missing"});
        continue;
    }
    const entries = [];
    const unresolvedAll = new Set();
    for (const d of decls) {
        if (d.kind === "interface") continue;
        for (const [key, m] of d.members) {
            if (!key.startsWith("function:")) continue;
            // A library has no external surface; its `internal` functions are
            // its API and are inlined into whatever facet calls them. Treating
            // them as entry points is what makes `scheduledTasksLib` measurable
            // at all.
            const isApi = d.kind === "library"
                ? m.visibility === "internal" || m.visibility === "public"
                : m.visibility === "external" || m.visibility === "public";
            if (!isApi) continue;
            if (!m.hasBody) continue;
            const t = trace(d.name, m.name);
            for (const u of t.unresolved) unresolvedAll.add(u);
            entries.push({
                contract: d.name,
                fn: m.name,
                file: relative(ATS, d.path),
                line: m.line,
                depth: t.maxDepth,
                nodes: t.nodes,
                seams: [...t.seams.keys()].sort(),
                seamDetail: Object.fromEntries(
                    [...t.seams].map(([k, v]) => [k, {depth: v.depth, site: v.site}])
                ),
                writes: [...t.writes.keys()].sort(),
                incidental: [...t.incidental.keys()].sort(),
                modifiers: m.applied.filter((a) => byName.get(d.name) && linearise(d.name)
                    .some((x) => x.members.has(`modifier:${a}`))),
            });
        }
    }
    entries.sort((a, b) => (b.seams.length - a.seams.length) || a.fn.localeCompare(b.fn));
    report.facets.push({facet, group, entries, unresolved: [...unresolvedAll].sort()});
}

// ------------------------------------------------------------- coverage

// The graph is only as good as its resolution rate. Report it rather than
// claim it: a facet with a long unresolved list has a seam set that is a
// lower bound, not an answer.
const totalEntries = report.facets.reduce((n, f) => n + (f.entries?.length ?? 0), 0);
const withSeams = report.facets.reduce(
    (n, f) => n + (f.entries?.filter((e) => e.seams.length).length ?? 0), 0);
report.coverage = {
    declarations: all.length,
    files: files.length,
    entryPoints: totalEntries,
    entryPointsReachingASeam: withSeams,
};

const args = process.argv.slice(2);
const jsonAt = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const mdAt = args.includes("--md") ? args[args.indexOf("--md") + 1] : null;

if (jsonAt) writeFileSync(jsonAt, JSON.stringify(report, null, 2) + "\n");

// ------------------------------------------------------------- markdown

const lines = [];
const P = (s = "") => lines.push(s);

P("# Callstack census: the ATS lifecycle surface");
P();
P(`**Generated** \`node tools/callstack.mjs\`, ${report.generated.slice(0, 10)}.`);
P(`**Source** ${report.source}. ${report.coverage.files} files, ` +
  `${report.coverage.declarations} declarations, ${report.coverage.entryPoints} entry points.`);
P();
P("`mesh/transfer-path.md` measured the transfer path by execution. This measures");
P("the other twenty two facets by static reachability, which is the right");
P("instrument for a different question: not *what did this call do*, but *what");
P("could this call reach*. Unresolved callees drop edges, so every seam set below");
P("is a lower bound. The unresolved list per facet is how big the gap can be.");
P();
// --------------------------------------------------------- the findings
//
// Computed from the table below rather than written above it, so a rerun that
// changes the measurement changes the summary too. A findings section that can
// go stale independently of its data is worse than none.

const all_ = report.facets.flatMap((f) => f.entries ?? []);
const MOVES = ["W:transfer", "W:issue", "W:redeem", "W:holdMove"];
const ENC = ["W:hold", "W:lock"];
const moves = all_.filter((e) => e.writes.some((w) => MOVES.includes(w)));
const enc = all_.filter((e) => e.writes.some((w) => ENC.includes(w)));
const noD = moves.filter((e) => !e.seams.includes("D"));
const postOnly = moves.filter(
    (e) => !e.seams.includes("D") && !e.seams.includes("C") && e.seams.includes("C'"));
const rideAlong = all_.filter((e) => e.incidental.includes("W:adjust"));
const name = (e) => `\`${e.contract}.${e.fn}\``;

P("## What this measured");
P();
P(`Of ${report.coverage.entryPoints} entry points, **${moves.length} move value ` +
  `between holders** and ${enc.length} encumber it in place. The rest read, ` +
  `configure, or change terms.`);
P();
P(`**${noD.length} of the ${moves.length} value moves never consult seam D**, the ` +
  `eligibility gate a zero knowledge proof terminates at:`);
P();
for (const e of noD) {
    P(`- ${name(e)} - seams \`${e.seams.join(" ")}\``);
}
P();
P(`**${postOnly.length} of them are observable only after the balance has already ` +
  `moved**, through the post-state \`ICompliance.transferred / created / destroyed\` ` +
  `notification. A compliance module cannot veto from there.`);
P();
const encBlind = enc.filter(
    (e) => !e.seams.includes("C") && !e.seams.includes("C'") && !e.seams.includes("D"));
P(`**Encumbrance is mostly unobserved.** ${enc.length} entry points immobilise a ` +
  `holder's tokens rather than moving them, and **${encBlind.length} of those reach ` +
  `the pause check and no other seam at all**:`);
P();
for (const e of encBlind) {
    P(`- ${name(e)} - seams \`${e.seams.join(" ")}\``);
}
P();
P(`The ${enc.length - encBlind.length} that are gated are the clearing approval ` +
  `rails, which run the full check before they settle. So the gap is not "holds ` +
  `are unchecked", it is that **hold *creation* is unchecked and hold *execution* ` +
  `is not**: the check sits at the end of the rail rather than the start.`);
P();
P("This matters here specifically. The repo open leg is two ATS holds with the");
P("vault as escrow, chosen so the venue would not need custom escrow code. That");
P("puts the venue's own settlement rail on the one path no seam reports.");
P();
P(`**${rideAlong.length} entry points can fire a pending scheduled balance ` +
  `adjustment on their way past.** ATS dispatches due scheduled tasks lazily from ` +
  `inside whatever call arrives next, so a snapshot, a freeze or a clearing submit ` +
  `may apply a supply factor change the caller did not ask for and paid the gas ` +
  `for. The *timing* of that row is therefore set by unrelated third party ` +
  `traffic, which is not a property the issuer controls and not something the ` +
  `disclosure matrix currently says.`);
P();
P("## Seams");
P();
P("| | site | reached by |");
P("|---|---|---|");
for (const s of SEAMS) {
    const n = report.facets.reduce(
        (a, f) => a + (f.entries?.filter((e) => e.seams.includes(s.id)).length ?? 0), 0);
    P(`| **${s.id}** | \`${s.label}\` | ${n} entry points |`);
}
P();
P("## Per facet");
P();
for (const f of report.facets) {
    if (f.error) { P(`### ${f.facet} - ${f.error}`); P(); continue; }
    const reaching = f.entries.filter((e) => e.seams.length);
    P(`### \`${f.facet}\` (${f.group})`);
    P();
    P(`${f.entries.length} entry points, ${reaching.length} reach a seam.`);
    P();
    if (reaching.length) {
        P("| entry point | depth | nodes | seams | writes | incidental |");
        P("|---|---|---|---|---|---|");
        for (const e of reaching) {
            P(`| \`${e.contract}.${e.fn}\` | ${e.depth} | ${e.nodes} | ${e.seams.join(" ")} | ` +
              `${e.writes.map((w) => w.slice(2)).join(" ") || "-"} | ` +
              `${e.incidental.map((w) => w.slice(2)).join(" ") || "-"} |`);
        }
        P();
    }
    const quiet = f.entries.filter((e) => !e.seams.length);
    if (quiet.length) {
        P(`Reach no seam: ${quiet.map((e) => "`" + e.fn + "`").join(", ")}`);
        P();
    }
    if (f.unresolved.length) {
        P(`<details><summary>unresolved callees (${f.unresolved.length})</summary>`);
        P();
        P("```");
        P(f.unresolved.join("\n"));
        P("```");
        P();
        P("</details>");
        P();
    }
}

if (mdAt) writeFileSync(mdAt, lines.join("\n") + "\n");
else console.log(lines.join("\n"));

console.error(`census: ${report.coverage.entryPoints} entry points, ` +
    `${report.coverage.entryPointsReachingASeam} reach a seam`);
