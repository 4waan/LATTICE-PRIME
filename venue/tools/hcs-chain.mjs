// What the relay and the verifier both need from outside the process: the
// environment, the mirror node, and one `eth_call`.
//
// Node side only. Never inlined into a page: `tools/gen-app.mjs` inlines a fixed
// list and this file is not on it, which is the property that keeps the six
// built screens free of both a key and a dependency.
//
// Two hosts on purpose. Logs, results and topic messages come from the mirror
// node's REST index; `spentBits` comes from an `eth_call` over the JSON-RPC
// relay. The verifier's whole claim is that it checks the relay's story against
// something the relay does not control, so asking two different services and
// requiring them to agree is worth the extra client.
import {readFileSync, existsSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {JsonRpcProvider, Contract} from "ethers";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "..");

/// `.env` as `script/live/*.sh` reads it, without a dependency and without
/// putting anything into `process.env`. A value stays in the object the caller
/// asked for, so a stray `console.log(process.env)` in some other tool cannot
/// print the operator key.
export function env(required = []) {
    const path = join(REPO, ".env");
    if (!existsSync(path)) throw new Error(`no .env at ${path}. Copy .env.example and fill it in.`);
    const out = Object.create(null);
    for (const line of readFileSync(path, "utf8").split("\n")) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
        }
        out[m[1]] = v;
    }
    for (const k of required) {
        if (!out[k]) throw new Error(`set ${k} in .env`);
    }
    return out;
}

export const client = () => JSON.parse(readFileSync(join(ROOT, "deployments/client.json"), "utf8"));
export const abi = (name) => JSON.parse(readFileSync(join(ROOT, "deployments/abi", name + ".json"), "utf8"));

/// Where the topic record lives, and its memo.
///
/// Here rather than in `tools/hcs-topic.mjs` because that file creates a topic
/// when it is run, and a module with that side effect must never be something
/// another tool imports for a constant.
export const TOPIC_RECORD = join(ROOT, "deployments/hcs.json");
export const TOPIC_MEMO = "seamme venue chain 296 disclosure receipts";
export const readTopic = () =>
    (existsSync(TOPIC_RECORD) ? JSON.parse(readFileSync(TOPIC_RECORD, "utf8")) : null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// GET one mirror node path, with the backoff the public endpoint needs.
///
/// 429 and 5xx are retried with exponential backoff and a cap; a 4xx that is not
/// 429 is the caller's mistake and is thrown straight away, because retrying a
/// malformed path just spends the rate limit that the next real call needs.
export async function mirror(base, path, {attempts = 6, timeoutMs = 20000} = {}) {
    if (!path.startsWith("/api/v1/")) throw new Error(`refusing a mirror path outside /api/v1/: ${path}`);
    let wait = 700;
    for (let i = 1; ; i++) {
        let res;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        try {
            res = await fetch(base + path, {headers: {accept: "application/json"}, signal: ctl.signal});
        } catch (e) {
            if (i >= attempts) throw new Error(`mirror node unreachable for ${path}: ${e.message}`);
            await sleep(wait);
            wait = Math.min(wait * 2, 20000);
            continue;
        } finally {
            clearTimeout(timer);
        }
        if (res.ok) return res.json();
        if (res.status !== 429 && res.status < 500) {
            throw new Error(`mirror node answered ${res.status} for ${path}`);
        }
        if (i >= attempts) throw new Error(`mirror node answered ${res.status} for ${path} after ${attempts} attempts`);
        // Respect Retry-After when the endpoint sends one; it is the only number
        // here that is not a guess.
        const after = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 30000) : wait);
        wait = Math.min(wait * 2, 20000);
    }
}

/// Follow `links.next` to the end of a listing.
///
/// The mirror node hands back the next page as a path on its own host. It is
/// still a string off the network, so it is checked against the same prefix rule
/// every other path goes through rather than concatenated onto the base host and
/// fetched. `pages` bounds a run that would otherwise be unbounded if the index
/// ever handed back a cursor that did not advance.
export async function paged(base, path, key, {pages = 200} = {}) {
    const out = [];
    let next = path;
    const seen = new Set();
    for (let i = 0; next && i < pages; i++) {
        if (seen.has(next)) throw new Error(`the mirror node repeated a cursor at ${next}`);
        seen.add(next);
        const j = await mirror(base, next);
        for (const row of j[key] || []) out.push(row);
        next = j.links && j.links.next ? j.links.next : null;
    }
    if (next) throw new Error(`listing did not end within ${pages} pages: ${path}`);
    return out;
}

/// Consensus timestamps are `seconds.nanos` decimal strings and the mirror node
/// orders by them. Compared as strings they sort wrongly across a digit
/// boundary, so every comparison goes through this.
export function tsKey(t) {
    const [s, n = "0"] = String(t).split(".");
    return s.padStart(12, "0") + "." + n.padEnd(9, "0");
}
export const tsLess = (a, b) => tsKey(a) < tsKey(b);

/// The disclosure epoch a consensus timestamp falls in, by the same arithmetic
/// `EpochClock` uses: floor((t - origin) / period), and zero before the origin.
export function epochAt(ts, origin, period) {
    const s = Math.floor(Number(String(ts).split(".")[0]));
    if (s < origin) return 0;
    return Math.floor((s - origin) / period);
}

/// One `eth_call` client per run, bound to the ABIs the venue publishes.
export function reader(rpcUrl, chainId) {
    const provider = new JsonRpcProvider(rpcUrl, chainId, {staticNetwork: true, batchMaxCount: 50});
    const cache = new Map();
    return {
        provider,
        at(address, abiName) {
            const k = address + ":" + abiName;
            if (!cache.has(k)) cache.set(k, new Contract(address, abi(abiName), provider));
            return cache.get(k);
        },
        close() { provider.destroy(); },
    };
}


/// `keccak256("Adopted(bytes32,uint64,uint256)")`, emitted by `ParameterRoot`
/// when a proposed parameter set becomes the one in force.
export const TOPIC_ADOPTED =
    "0x4a59fe9254a2f5d1676ab717dad3074cddd94b80faa18089137d0e42cdba33fc";

/// The disclosure epoch from which the parameter set now in force has been in
/// force, and every adoption before it.
///
/// This is the boundary a silence claim cannot cross. `budgetFor(row)` is a read
/// of current state: it answers what the bound is now, not what it was in epoch
/// four. The venue's first parameter set carried no budget on any row, so before
/// the second adoption `DisclosureMeter.spend` returned early and emitted
/// nothing on every call, and a relay that judged those calls against today's
/// budget would print a silence for every one of them. That is the false
/// positive the whole design refuses, so the relay does not judge a silence
/// before this epoch and the verifier fails one that claims to.
export async function policyHistory(base, address) {
    const logs = await paged(
        base, `/api/v1/contracts/${address}/results/logs?order=asc&limit=100`, "logs");
    const adoptions = [];
    for (const l of logs) {
        if (String(l.topics[0]).toLowerCase() !== TOPIC_ADOPTED) continue;
        const data = String(l.data).replace(/^0x/, "");
        adoptions.push({
            root: String(l.topics[1]).toLowerCase(),
            epoch: Number(BigInt("0x" + data.slice(0, 64))),
            count: Number(BigInt("0x" + data.slice(64, 128))),
            timestamp: l.timestamp,
        });
    }
    adoptions.sort((a, b) => a.epoch - b.epoch);
    return adoptions;
}

/// The epoch the root currently in force took effect. Zero when the contract has
/// never adopted, which cannot happen on a live venue but is the safe answer.
export function effectiveFrom(adoptions, currentRoot) {
    const root = String(currentRoot).toLowerCase();
    for (let i = adoptions.length - 1; i >= 0; i--) {
        if (adoptions[i].root === root) return adoptions[i].epoch;
    }
    return adoptions.length ? adoptions[adoptions.length - 1].epoch : 0;
}
