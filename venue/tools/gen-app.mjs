// Builds the live screens (and the door page) from templates.
// Reads deployments/client.json and deployments/abi/*; writes tools/client-bundle.mjs
// then inlines via tools/gen-page.mjs. Does not edit existing generators or Solidity.
//
// Every exported ABI is bundled, not a chosen subset. A client that binds to
// five of the thirteen deployed contracts cannot tell you the venue is
// suspended, and the missing shape is never the one you expected to miss.
import {readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "./gen-page.mjs";
import {compact} from "./hcs-project.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const abiDir = join(root, "deployments/abi");
const names = readdirSync(abiDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();

// `internalType` is documentation. ethers reads named tuple members off
// `components[].name`, so dropping it changes nothing a screen can observe and
// takes a quarter off the weight of carrying every ABI.
const strip = (x) =>
    Array.isArray(x) ? x.map(strip)
        : (x && typeof x === "object"
            ? Object.fromEntries(Object.entries(x)
                .filter(([k]) => k !== "internalType")
                .map(([k, v]) => [k, strip(v)]))
            : x);

const client = JSON.parse(readFileSync(join(root, "deployments/client.json"), "utf8"));

// The consensus topic, if one has been created. Optional on purpose: a checkout
// that has never run `make hcs-topic` still builds all six screens, and the
// Rulebook screen says the topic is not configured rather than throwing at boot.
// Only the three public fields a reader needs are carried; the operator block in
// deployments/hcs.json is not something a page has any use for.
const hcsPath = join(root, "deployments/hcs.json");
const hcs = existsSync(hcsPath)
    ? (({topicId, memo, createdAt}) => ({topicId, memo, createdAt}))(JSON.parse(readFileSync(hcsPath, "utf8")))
    : null;

// Per-publisher oracle evidence topics. Public metadata only. The page reads
// each live tail from Mirror Node, so failure reasons and source provenance do
// not depend on a private publisher journal or application server.
const oracleTopicDir = join(root, "oracle/deployments/topics");
const oracleTopics = existsSync(oracleTopicDir)
    ? readdirSync(oracleTopicDir)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => JSON.parse(readFileSync(join(oracleTopicDir, name), "utf8")))
        .filter((record) => record.schema === "lattice.oracle.topic.v1")
        .map((record) => ({
            topicId: record.topicId,
            profile: record.publisher.profile,
            publisher: record.publisher.evmAddress,
        }))
    : [];
const oracleSchedulerPath = join(root, "deployments/oracle-scheduler.json");
const oracleScheduler = existsSync(oracleSchedulerPath)
    ? JSON.parse(readFileSync(oracleSchedulerPath, "utf8"))
    : null;
const financingEvidence = Object.fromEntries(
    [
        ["automatic", "deployments/financing-hss-canary.json"],
        ["production", "deployments/financing-beat.json"],
        ["lifecycle", "deployments/financing-lifecycle.json"],
    ].map(([name, rel]) => {
        const full = join(root, rel);
        return [name, existsSync(full) ? JSON.parse(readFileSync(full, "utf8")) : null];
    }),
);
// Names a decoded tuple cannot carry, because `ethers` would hand back the
// method instead of the value.
//
// **This check exists because it happened.** `PrimeOracle.latest()` returned a
// member called `at`, which is a perfectly good Solidity name and is also
// `Array.prototype.at`. `ethers` v6 decodes a return tuple into a `Result` that
// is array-like, so `result.at` resolved to the array method, the Repo screen
// tried arithmetic on a function, and the failure surfaced as
// "Cannot convert function to a BigInt" with nothing pointing at the ABI. The
// contract was redeployed with the member renamed.
//
// A comment would not have prevented the next one. This does: a colliding name
// fails the build that would have shipped it, and it fails here rather than in
// a screen, because this is the file that hands the ABIs to the client.
const ARRAY_MEMBERS = new Set(Object.getOwnPropertyNames(Array.prototype));

function collisions(abi, contract) {
    const bad = [];
    const walk = (params, where) => {
        for (const p of params ?? []) {
            if (p.name && ARRAY_MEMBERS.has(p.name)) bad.push(`${where}.${p.name}`);
            if (p.components) walk(p.components, `${where}.${p.name || "tuple"}`);
        }
    };
    for (const e of abi) {
        const where = `${contract}.${e.name || e.type}`;
        walk(e.outputs, where);
        walk(e.inputs, where);
    }
    return bad;
}

const abis = {};
const nameClashes = [];
for (const name of names) {
    abis[name] = strip(JSON.parse(readFileSync(join(abiDir, name + ".json"), "utf8")));
    nameClashes.push(...collisions(abis[name], name));
}
if (nameClashes.length) {
    throw new Error(
        "ABI member names that ethers cannot decode by name, because Array.prototype " +
        "already defines them:\n  " + nameClashes.join("\n  ") +
        "\nRename the Solidity field or return value. See the note above this check.",
    );
}

// Every contract address the client can read history for, so a screen naming a
// contract can also name what that contract did. The mirror node takes an EVM
// address as the path segment, so no entity id table has to be kept in step.
// The issuer's live proofs, by KYC epoch, inlined so the first screen of a
// three-screen product is not a wall.
//
// `docs/EVIDENCE.md`: "A judge does not have a proof file. Generating one needs
// the circom toolchain, node 22, and about twenty-three seconds per address."
// These are the proofs `make prove-live` already produced for the three live
// addresses; they are real, they verify on chain, and shipping them costs a few
// kilobytes in a document that is already a quarter of a megabyte. Fetching them
// at run time was the alternative and it is worse: proof lookup and policy
// inspection must keep working if the sponsored-registration endpoint is down.
//
// Keyed by the epoch the proof pins in public signal 3. `register` refuses a
// proof for the wrong epoch, so the page has to pick by the registry's own
// answer rather than by whichever file was newest.
const proofFiles = {7: "deployments/proofs-live.json", 8: "deployments/proofs-live-epoch8.json"};
const demoProofs = {};
for (const [epoch, rel] of Object.entries(proofFiles)) {
    const full = join(root, rel);
    if (!existsSync(full)) continue;
    demoProofs[epoch] = JSON.parse(readFileSync(full, "utf8"));
}

const bundle =
    "// Generated by tools/gen-app.mjs. Do not hand edit.\n" +
    "const CLIENT = " + JSON.stringify(client) + ";\n" +
    "const ABI = " + JSON.stringify(abis) + ";\n" +
    "const HCS = " + JSON.stringify(hcs) + ";\n" +
    "const ORACLE_TOPICS = " + JSON.stringify(oracleTopics) + ";\n" +
    "const ORACLE_SCHEDULER = " + JSON.stringify(oracleScheduler) + ";\n" +
    "const FINANCING_EVIDENCE = " + JSON.stringify(financingEvidence) + ";\n" +
    "const DEMO_PROOFS = " + JSON.stringify(demoProofs) + ";\n";

writeFileSync(join(root, "tools/client-bundle.mjs"), bundle);

// The committed projection of the topic, compacted for the one screen that
// reads it. HCS is an ordered record and not a database: the Rulebook screen
// boots from this snapshot and asks the mirror node only for the messages after
// `throughSequence`, instead of replaying the topic from sequence one on every
// load. Its own bundle rather than a field of `client-bundle.mjs`, which every
// page inlines, because five of the six screens have no topic panel and would
// carry the weight for nothing. Optional like the topic: no index, no snapshot,
// and the screen reads the topic directly as it always could.
const indexPath = join(root, "deployments/hcs-index.json");
let hcsIndex = null;
if (hcs && existsSync(indexPath)) {
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    if (index.topicId === hcs.topicId) {
        hcsIndex = compact(index);
    } else {
        console.warn(`deployments/hcs-index.json names topic ${index.topicId}, not ${hcs.topicId}; the screen gets no snapshot`);
    }
}
writeFileSync(join(root, "tools/hcs-index-bundle.mjs"),
    "// Generated by tools/gen-app.mjs. Do not hand edit.\n" +
    "const HCS_INDEX = " + JSON.stringify(hcsIndex) + ";\n");
mkdirSync(join(root, "app"), {recursive: true});

for (const name of ["index", "prove", "trade", "position", "venue", "repo"]) {
    build("app/" + name + ".template.html", "app/" + name + ".html");
}
build("app/claw/index.template.html", "app/claw/index.html");
