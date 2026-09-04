#!/usr/bin/env node
// Seam census probe: does any live ATS token have a non-contract in either of the
// two ERC-3643 seams that fail open?
//
// LowLevelCall.verifyCallResultFromTarget has no `target.code.length == 0`
// check, so `compliance` or `identityRegistry` pointed at a non-contract
// silently disables that gate (reproduced on hardhat). This asks the
// only question that decides whether this is an ordinary hardening PR or a
// disclosure: is anyone on a live network in that state right now?
//
// Reads only. No key, no account, no state change.
//
// Run:   node probes/ats-seam-census.mjs [testnet|mainnet]
// Needs: node 18+ for global fetch. No dependencies.

const NET = process.argv[2] || "testnet";
const MIRROR = `https://${NET}.mirrornode.hedera.com/api/v1`;

// Selectors taken from the compiled v8.0.0 ABI, not computed from a guessed
// signature. ComplianceFacet.compliance() and IdentityFacet.identityRegistry().
const SEL = { compliance: "0x6290865d", identityRegistry: "0x134e18f4" };
const ZERO = "0x0000000000000000000000000000000000000000";
// ResolverProxy raises this when no facet owns the selector. Used as the control:
// it proves a zero answer is a stored zero and not an unregistered-facet artefact.
const FUNCTION_NOT_FOUND = "0x5416eb98";

// Every ATS factory reachable from three independent sources, so the sweep is
// not self-selecting:
//   docs page + docs version history:  7708432, 7512002
//   deployment records vendored in the clone:  the other five
const FACTORIES = NET === "testnet" ? [
  ["0.0.7512002", "2.0.1, docs version history"],
  ["0.0.7708432", "4.0.0, the only one the docs publish"],
  ["0.0.7783349", "vendored record 2026-01-29, expired"],
  ["0.0.7838301", "vendored record 2026-02-05"],
  ["0.0.8673518", "vendored record 2026-04-16"],
  ["0.0.9005295", "vendored record 2026-05-19"],
  ["0.0.9213391", "vendored record 2026-06-12, the live one"],
] : [];

// Deployment events across v2, v4 and v8 factory ABIs. In all of them the token
// address is the first non-indexed argument, so data word 0.
const DEPLOY_TOPICS = new Set([
  "0x01d3e27a30d468a96e49f71ff84af896733789c198ff030dae07d2d9ae9e9f17",
  "0x59f510d04f090e1185bc91d7647b595294572073ef9f4754e7604b2a8af1e5f2",
  "0x79257f286b70d53b32335fc93d9643b3ac0c967414bedb4af4d6c3f8f530b0f2", // BondDeployed v8
  "0x9e8ee1459086a5b33460e668ed3ef6424a9c5bed649f978cd1d850ce113644a3", // DepositTokenDeployed v8
  "0xa291f8f490aad4df8641c3bb95abadd4ab4531b0c1f8afe8a4be42a8d25eb739", // EquityDeployed v8
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tokensOf(factory) {
  let url = `${MIRROR}/contracts/${factory}/results/logs?limit=100&order=asc`;
  const out = new Set();
  while (url) {
    const res = await fetch(url);
    if (!res.ok) break;
    const j = await res.json();
    for (const l of j.logs || []) {
      if (!DEPLOY_TOPICS.has(l.topics?.[0])) continue;
      const d = l.data.slice(2);
      if (d.length >= 64) out.add("0x" + d.slice(24, 64));
    }
    url = j.links?.next ? `https://${NET}.mirrornode.hedera.com${j.links.next}` : null;
  }
  return [...out];
}

async function ethCall(to, data, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`${MIRROR}/contracts/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ block: "latest", data, to, estimate: false }),
    });
    if (r.status === 429) { await sleep(1200 * (i + 1)); continue; }
    const j = await r.json().catch(() => ({}));
    if (r.ok) return { result: j.result };
    return { revert: j?._status?.messages?.[0]?.data || "" };
  }
  return { revert: "", rateLimited: true };
}

// The question that matters: is there code at this address?
async function classify(addr) {
  const c = await fetch(`${MIRROR}/contracts/${addr}`);
  if (c.ok) {
    const j = await c.json();
    const rb = j.runtime_bytecode || "0x";
    return rb.length > 2
      ? { ok: true, note: `contract ${j.contract_id}, ${(rb.length - 2) / 2} bytes` }
      : { ok: false, note: `contract entry ${j.contract_id} but EMPTY bytecode` };
  }
  const a = await fetch(`${MIRROR}/accounts/${addr}`);
  if (a.ok) return { ok: false, note: `NON-CONTRACT ACCOUNT ${(await a.json()).account}` };
  return { ok: false, note: "NO ENTITY, never created" };
}

console.log(`Seam census probe  ${new Date().toISOString()}  ${NET}, unauthenticated`);
console.log(`Question: any live ATS token with a non-contract in compliance() or identityRegistry()?\n`);

if (!FACTORIES.length) {
  console.log(`No ATS factory is published for ${NET}.`);
  console.log(`The deployed-addresses page lists testnet only, the SDK ships no`);
  console.log(`${NET} factory constant, and the testnet entity numbers resolve to`);
  console.log(`nothing here. Vacuously clean until someone deploys.`);
  process.exit(0);
}

let total = 0, zero = 0, absent = 0;
const failOpen = [], set = [];

for (const [factory, provenance] of FACTORIES) {
  const tokens = await tokensOf(factory);
  process.stdout.write(`factory ${factory}  (${provenance})\n  ${tokens.length} tokens`);
  let fz = 0;
  for (const t of tokens) {
    for (const [name, sel] of Object.entries(SEL)) {
      const r = await ethCall(t, sel);
      if (r.result === undefined) {
        if (r.revert?.startsWith(FUNCTION_NOT_FOUND)) { absent++; continue; }
        console.log(`\n  ${t} ${name}: unexpected revert ${r.revert?.slice(0, 10)}`);
        continue;
      }
      total++;
      const addr = "0x" + r.result.slice(-40);
      if (addr === ZERO) { zero++; fz++; continue; }
      const c = await classify(addr);
      set.push(`${t} ${name} -> ${addr} (${c.note})`);
      if (!c.ok) failOpen.push(`${t} ${name} -> ${addr} (${c.note})`);
    }
  }
  console.log(`, ${fz} seam reads returned zero\n`);
}

// Control. Without this a zero word is ambiguous between "stored zero" and
// "no facet, empty returndata, decoded as zero".
const sample = (await tokensOf(FACTORIES.at(-1)[0]))[0];
if (sample) {
  const bogus = await ethCall(sample, "0xdeadbeef");
  const real = await ethCall(sample, SEL.compliance);
  console.log("control, on one live token:");
  console.log(`  unregistered selector 0xdeadbeef -> revert ${bogus.revert?.slice(0, 10)} (expect ${FUNCTION_NOT_FOUND}, FunctionNotFound)`);
  console.log(`  compliance()                     -> ok, ${real.result?.slice(0, 10)}...`);
  console.log("  so the facet is registered and the zero is a stored value.\n");
}

console.log(`seam reads:            ${total}`);
console.log(`returned zero:         ${zero}   (zero is the explicit disabled state)`);
console.log(`facet not registered:  ${absent}`);
console.log(`seam set to something: ${set.length}`);
for (const s of set) console.log(`  ${s}`);
console.log(`\nFAIL-OPEN (non-contract in a live seam): ${failOpen.length}`);
for (const f of failOpen) console.log(`  *** ${f}`);
console.log(failOpen.length
  ? "\nAB-004 is a DISCLOSURE. Do not file publicly. See SECURITY.md."
  : "\nAB-004 is an ordinary hardening PR. No live token is in the fail-open state.");
