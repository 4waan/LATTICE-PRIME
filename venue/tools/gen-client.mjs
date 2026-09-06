// The one file a frontend loads. Generated, never hand written, because the
// failure mode this defends against is an address book that drifted.
//
// `deployments/abi/` already carries the shapes, exported out of `out/` by
// `script/live/export-abis.sh`, so a client cannot bind to an interface the
// chain does not have. It does not carry the addresses, the immutables, or a way
// to turn a revert back into a sentence, and each of those is a place where a
// client can hold a stale number and render a screen that lies.
//
// This writes `deployments/client.json`, which holds four things:
//
//   addresses    every contract, and the four network parameters
//   immutables   read back off chain 296 in this run, not copied from a record
//   clocks       three origins and two periods, each read from its own getter
//   errors       every custom error in every exported ABI, keyed by selector
//
// **Every number here is a read.** The point is not convenience, it is that a
// generated file has a provenance and a hand-maintained one has a history of
// edits. `checkedAt` records when, and `wiring` records the seven assertions the
// client is told to run at load, with the answers this run got.
//
// The generator only ever sends `eth_call`, so every request is safe to retry and
// a dropped socket is retried rather than allowed to leave the previous bundle in
// place. A stale bundle nobody noticed is the failure this file exists to prevent.
//
//   node tools/gen-client.mjs [--rpc URL] [--out PATH]
import {readFileSync, writeFileSync, readdirSync} from "fs";
import {keccak_256} from "./keccak.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => {
    const i = argv.indexOf(k);
    return i === -1 ? d : argv[i + 1];
};
const RPC = arg("--rpc", process.env.HEDERA_TESTNET_RPC ?? "https://testnet.hashio.io/api");
const OUT = arg("--out", "deployments/client.json");

const venue = JSON.parse(readFileSync("deployments/296-venue.json", "utf8"));
const kyc = JSON.parse(readFileSync("deployments/296-kyc.json", "utf8"));

// ------------------------------------------------------------------ the wire

const hex = (b) => "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const selector = (sig) => hex(keccak_256(new TextEncoder().encode(sig))).slice(0, 10);

let id = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// **Retried, because the public relay drops connections and this generator makes
// forty sequential calls.** A run that dies two thirds of the way through leaves
// the previous `client.json` on disk, and the failure mode that produces is the
// exact one this file exists to prevent: a client compiled against a bundle
// nobody noticed was stale. So a transient failure is retried and a permanent
// one throws. HashIO also rate limits, which is why the backoff is real seconds
// rather than milliseconds and why `429` is on the retry list.
const RETRIES = 5;
const RETRYABLE = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network/i;

async function call(to, sig, args = []) {
    // `eth_call` and nothing else. This script never sends, and a generator that
    // could send is a generator somebody will run against mainnet by accident.
    const data = selector(sig) + args.map(word).join("");
    const body = JSON.stringify({
        jsonrpc: "2.0", id: ++id, method: "eth_call",
        params: [{to, data}, "latest"],
    });

    let last;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
        if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
        let res;
        try {
            res = await fetch(RPC, {
                method: "POST",
                headers: {"content-type": "application/json"},
                body,
            });
        } catch (e) {
            // A dropped socket. Nothing reached the node, so retrying is safe:
            // every call here is a `view`.
            last = e;
            if (!RETRYABLE.test(`${e.message} ${e.cause?.code ?? ""}`)) throw e;
            continue;
        }
        if (res.status === 429 || res.status >= 500) {
            last = new Error(`${sig} on ${to}: HTTP ${res.status}`);
            continue;
        }
        const j = await res.json();
        // A revert or a bad selector is the caller's mistake and will not fix
        // itself, so it throws on the first answer rather than five times.
        if (j.error) throw new Error(`${sig} on ${to}: ${j.error.message}`);
        return j.result;
    }
    throw new Error(`${sig} on ${to}: gave up after ${RETRIES} attempts. ${last?.message ?? ""}`);
}

function word(v) {
    if (typeof v === "string" && v.startsWith("0x")) {
        return v.slice(2).toLowerCase().padStart(64, "0");
    }
    return BigInt(v).toString(16).padStart(64, "0");
}

const asUint = (r) => BigInt(r).toString();
const asAddr = (r) => "0x" + r.slice(-40);
const asBool = (r) => BigInt(r) === 1n;

// ------------------------------------------------------------- the addresses

const addresses = {
    MatchingEngine: venue.venue.MatchingEngine,
    SeamJournal: venue.venue.SeamJournal,
    RepoVault: venue.venue.RepoVault,
    MarginWatch: venue.venue.MarginWatch,
    VolumeCap: venue.venue.VolumeCap,
    TradingHalt: venue.venue.TradingHalt,
    Rulebook: venue.venue.Rulebook,
    ParameterRoot: venue.policy.ParameterRoot,
    EpochClock: venue.policy.EpochClock,
    Regime: venue.policy.Regime,
    ZkKycRegistry: venue.kyc.ZkKycRegistry,
    RegistrationGate: venue.kyc.RegistrationGate,
    KycVerifier: venue.kyc.KycVerifier,
    token: venue.token.address,
};

const E = addresses.MatchingEngine;

// --------------------------------------------------------- the error table

// Every custom error in every exported ABI, keyed by four byte selector. A
// client decodes a revert against this rather than against a guess, and the
// arguments are the message: `WrongBond(sent, want)` says exactly how far off the
// value was.
//
// `InvalidKycStatus()` is the one entry that is **not** ours. It comes from ATS
// and is what a transfer to a non granted address looks like from the token's
// side, so a client that cannot name it will report a venue failure for a
// compliance refusal. Added by hand because it is not in any ABI we export.
function errorTable() {
    const table = {};
    const add = (name, inputs, from) => {
        const sig = `${name}(${inputs.map((i) => i.type).join(",")})`;
        const sel = selector(sig);
        if (table[sel] && table[sel].signature !== sig) {
            throw new Error(`selector collision ${sel}: ${table[sel].signature} and ${sig}`);
        }
        table[sel] ??= {signature: sig, args: inputs.map((i) => i.name ?? ""), from: []};
        if (!table[sel].from.includes(from)) table[sel].from.push(from);
    };
    for (const f of readdirSync("deployments/abi").sort()) {
        const abi = JSON.parse(readFileSync(`deployments/abi/${f}`, "utf8"));
        for (const e of abi) {
            if (e.type === "error") add(e.name, e.inputs ?? [], f.replace(/\.json$/, ""));
        }
    }
    add("InvalidKycStatus", [], "ATS");
    return table;
}

// --------------------------------------------------------------- the reads

const out = {
    note:
        "Generated by tools/gen-client.mjs. Every value below was read off chain in the " +
        "run recorded at checkedAt. Do not hand edit: regenerate with `make client`.",
    checkedAt: new Date().toISOString(),
    network: {
        chainId: venue.chainId,
        chainIdHex: "0x" + venue.chainId.toString(16),
        rpc: "https://testnet.hashio.io/api",
        mirror: "https://testnet.mirrornode.hedera.com",
        explorer: "https://hashscan.io/testnet",
        keyType: "ECDSA secp256k1. An ED25519 Hedera key cannot sign an EVM transaction.",
    },
    addresses,
    superseded: {
        note:
            "These have code and will answer calls. A client that reads them renders a " +
            "screen about a venue nobody is trading on.",
        ...venue.superseded,
    },
    units: {
        note: "See tools/units.mjs. Three quantities, two of them denominations.",
        tinybarPerHbar: "100000000",
        weibarPerTinybar: "10000000000",
        contractSide: "tinybar",
        valueFieldSide: "weibar",
        bondDecimals: venue.token.decimals,
        priceTwice:
            "MatchingEngine.quote returns twice the clearing price. notional is " +
            "priceTwice * qty / 2. Divide by two to display, never for arithmetic.",
    },
};

out.immutables = {
    commitBond: asUint(await call(E, "commitBond()")),
    cancelFee: asUint(await call(E, "cancelFee()")),
    revealDelay: asUint(await call(E, "revealDelay()")),
    revealWindow: asUint(await call(E, "revealWindow()")),
    roundLength: asUint(await call(E, "roundLength()")),
    restRounds: asUint(await call(E, "restRounds()")),
    genesis: asUint(await call(E, "genesis()")),
    partition: await call(E, "partition()"),
    DOMAIN_ORDER: await call(E, "DOMAIN_ORDER()"),
    MAX_USES_PER_EPOCH: asUint(await call(addresses.ZkKycRegistry, "MAX_USES_PER_EPOCH()")),
    minTier: asUint(await call(addresses.RegistrationGate, "minTier()")),
    jurisdictionMask: asUint(await call(addresses.RegistrationGate, "jurisdictionMask()")),
};

// Three clocks, each read from its own getter. **Never derive one from
// another.** Two of them share a period of 300 seconds and none of them shares
// an origin, so `epoch = round + 3` is true today and is an artefact of two
// deploy transactions landing 970 seconds apart.
out.clocks = {
    note:
        "Three clocks, two periods, three origins. Call the getter; do not derive one " +
        "clock from another. A receipt's epoch comes from the action's own block " +
        "timestamp, not from currentEpoch() at render time.",
    round: {
        origin: out.immutables.genesis,
        period: out.immutables.roundLength,
        readFrom: "MatchingEngine.currentRound()",
        governs: "reveal, resting, crossing",
    },
    disclosure: {
        origin: asUint(await call(addresses.EpochClock, "epochZero()")),
        period: asUint(await call(addresses.EpochClock, "epochLength()")),
        readFrom: "ParameterRoot.currentEpoch()",
        governs: "budgets, spentBits, governance",
    },
    kyc: {
        origin: asUint(await call(addresses.ZkKycRegistry, "epochZero()")),
        period: asUint(await call(addresses.ZkKycRegistry, "epochLength()")),
        readFrom: "ZkKycRegistry.currentEpoch()",
        governs: "grants, nullifiers, proof signal 3",
    },
};

const kycOrigin = BigInt(out.clocks.kyc.origin);
const kycPeriod = BigInt(out.clocks.kyc.period);
const kycEpoch = BigInt(asUint(await call(addresses.ZkKycRegistry, "currentEpoch()")));
out.clocks.kyc.currentEpoch = kycEpoch.toString();
// The one deadline on this venue that arrives with no transaction from anyone.
out.clocks.kyc.currentEpochEndsAt = (kycOrigin + (kycEpoch + 1n) * kycPeriod).toString();
out.clocks.kyc.warning =
    "Grants expire at this instant with no transaction from anyone and nothing warns. " +
    "Put the countdown on screen and check rootForEpoch(currentEpoch + 1) is published.";
out.clocks.kyc.nextRootPublished =
    BigInt(await call(addresses.RegistrationGate,
        "rootForEpoch(uint64)", [kycEpoch + 1n])) !== 0n;

// The seven assertions the client runs at load, with the answers this run got.
// A client that finds a different answer is holding a stale address book and
// should refuse to render rather than draw a screen about the wrong venue.
const wiring = {
    "engine.security() == token":
        asAddr(await call(E, "security()")).toLowerCase() === addresses.token.toLowerCase(),
    "engine.compliance() == SeamJournal":
        asAddr(await call(E, "compliance()")).toLowerCase()
            === addresses.SeamJournal.toLowerCase(),
    "engine.policy() == ParameterRoot":
        asAddr(await call(E, "policy()")).toLowerCase()
            === addresses.ParameterRoot.toLowerCase(),
    "engine.volumeCap() != 0": asAddr(await call(E, "volumeCap()")) !== "0x" + "0".repeat(40),
    "engine.tradingHalt() != 0": asAddr(await call(E, "tradingHalt()")) !== "0x" + "0".repeat(40),
    "token.compliance() == SeamJournal":
        asAddr(await call(addresses.token, "compliance()")).toLowerCase()
            === addresses.SeamJournal.toLowerCase(),
    "token.isExternalKycList(registry)":
        asBool(await call(addresses.token, "isExternalKycList(address)",
            [addresses.ZkKycRegistry])),
};
out.wiring = wiring;

// The metered rows, read back rather than asserted, because the whole point of
// the budgets is that a client can tell a silenced row from a quiet one.
out.disclosure = {note: "budgetFor(row), read off ParameterRoot. budgetBits 0 is unmetered."};
for (const row of [3, 4, 5, 7, 12, 13, 14, 15, 16, 17]) {
    const ceiling = BigInt(await call(addresses.ParameterRoot, "ceilingFor(uint16)", [row]));
    const packed = await call(addresses.ParameterRoot, "budgetFor(uint16)", [row]);
    // A four field struct of uint16 comes back as four words.
    const f = (i) => Number(BigInt("0x" + packed.slice(2 + i * 64, 66 + i * 64)));
    out.disclosure[`row${row}`] = {
        ceiling: ceiling.toString(),
        domainBits: f(0), aggBits: f(1), bucketBits: f(2), budgetBits: f(3),
        metered: f(3) !== 0,
    };
}

out.errors = errorTable();
out.abi = {
    directory: "deployments/abi",
    files: readdirSync("deployments/abi").sort(),
    note:
        "Compile against these and not against src/, so the client cannot bind to an " +
        "interface the chain does not have. IHoldByPartition and IAtsToken are the ATS " +
        "subset the venue touches; the full diamond is 108 facets.",
};

writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");

const failed = Object.entries(wiring).filter(([, v]) => !v).map(([k]) => k);
console.log(`wrote ${OUT}`);
console.log(`  ${Object.keys(out.errors).length} error selectors from ${out.abi.files.length} ABIs`);
console.log(`  wiring: ${Object.keys(wiring).length - failed.length}/${Object.keys(wiring).length} hold`);
for (const f of failed) console.error(`  FAILED  ${f}`);
console.log(`  kyc epoch ${out.clocks.kyc.currentEpoch} ends at ${out.clocks.kyc.currentEpochEndsAt}` +
    `, next root ${out.clocks.kyc.nextRootPublished ? "published" : "NOT PUBLISHED"}`);
if (failed.length) process.exit(1);
