import {spawnSync} from "node:child_process";

const [
    address,
    contractIdentifier,
    profile = "default",
    creationTransactionHash,
    inputIdentifier = contractIdentifier,
] = process.argv.slice(2);
if (!/^0x[0-9a-fA-F]{40}$/.test(address || "") || !contractIdentifier) {
    throw new Error(
        "usage: node tools/sourcify-standard-json.mjs 0xADDRESS path:Contract " +
        "[profile] [creationTx] [deploymentScript:Contract]",
    );
}

const SERVER = (process.env.SOURCIFY_URL || "https://sourcify.dev/server").replace(/\/$/, "");
const lookupUrl = `${SERVER}/v2/contract/296/${address}`;
const headers = {
    "content-type": "application/json",
    "user-agent": "lattice-sourcify-verifier/1",
};

async function json(response) {
    const body = await response.text();
    let parsed;
    try {
        parsed = JSON.parse(body);
    } catch {
        throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
    }
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(parsed)}`);
    }
    return parsed;
}

const existing = await fetch(lookupUrl, {headers});
if (existing.ok) {
    const contract = await existing.json();
    console.log(`${contractIdentifier} already verified: ${contract.match}`);
    process.exit(0);
}
if (existing.status !== 404) await json(existing);

const shown = spawnSync(
    "forge",
    [
        "verify-contract",
        address,
        inputIdentifier,
        "--chain-id",
        "296",
        "--num-of-optimizations",
        profile === "financing" ? "1" : "200",
        "--show-standard-json-input",
    ],
    {
        cwd: process.cwd(),
        env: {...process.env, FOUNDRY_PROFILE: profile},
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    },
);
if (shown.status !== 0) {
    throw new Error(`forge standard JSON failed:\n${shown.stderr || shown.stdout}`);
}
const start = shown.stdout.indexOf("{");
if (start < 0) throw new Error("forge returned no standard JSON input");
const stdJsonInput = JSON.parse(shown.stdout.slice(start));

const payload = {
    stdJsonInput,
    compilerVersion: "0.8.24+commit.e11b9ed9",
    contractIdentifier,
};
if (/^0x[0-9a-fA-F]{64}$/.test(creationTransactionHash || "")) {
    payload.creationTransactionHash = creationTransactionHash;
}

const submitted = await json(await fetch(
    `${SERVER}/v2/verify/296/${address}`,
    {method: "POST", headers, body: JSON.stringify(payload)},
));
if (!submitted.verificationId) {
    throw new Error(`Sourcify returned no verification id: ${JSON.stringify(submitted)}`);
}

let job;
for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    job = await json(await fetch(
        `${SERVER}/v2/verify/${submitted.verificationId}`,
        {headers},
    ));
    if (job.isJobCompleted) break;
}
if (!job?.isJobCompleted) throw new Error("Sourcify verification timed out");
if (job.error) throw new Error(`Sourcify verification failed: ${JSON.stringify(job.error)}`);
if (!["match", "exact_match"].includes(job.contract?.match)) {
    throw new Error(`Sourcify returned no match: ${JSON.stringify(job.contract)}`);
}
console.log(`${contractIdentifier} verified: ${job.contract.match}`);
