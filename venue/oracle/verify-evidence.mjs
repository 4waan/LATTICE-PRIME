import {existsSync, readFileSync, readdirSync} from "node:fs";
import {join, resolve} from "node:path";
import {loadOracleConfig} from "./lib/config.mjs";
import {verifyEvidenceTopic} from "./lib/evidence-verifier.mjs";
import {readDeployment, VENUE_ROOT} from "./lib/terms-source.mjs";

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
    const index = args.indexOf(flag);
    return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const config = loadOracleConfig(value("--config") ?? undefined, {allowExample: true});
const deployment = readDeployment().client;
const abi = JSON.parse(readFileSync(
    join(VENUE_ROOT, "deployments/abi/PrimeOracle.json"),
    "utf8",
));
const topicDirectory = resolve(value("--topics", "oracle/deployments/topics"));
const files = value("--topic")
    ? [resolve(value("--topic"))]
    : existsSync(topicDirectory)
        ? readdirSync(topicDirectory)
            .filter((name) => name.endsWith(".json"))
            .sort()
            .map((name) => join(topicDirectory, name))
        : [];
if (files.length === 0) throw new Error("no oracle evidence topic records found");

const results = [];
for (const file of files) {
    const topic = JSON.parse(readFileSync(file, "utf8"));
    if (topic.schema !== "lattice.oracle.topic.v1") {
        throw new Error(`${file} is not an oracle topic record`);
    }
    results.push(await verifyEvidenceTopic({
        mirrorUrl: config.mirrorUrl ?? deployment.network.mirror,
        topic,
        oracle: deployment.addresses.PrimeOracle,
        oracleHistory: [
            deployment.superseded?.repoVaultBeforeFinancingV5?.PrimeOracle,
        ].filter(Boolean),
        chainId: config.chainId,
        oracleAbi: abi,
        maximumDelaySeconds: config.evidence?.maximumVerificationDelaySeconds ?? 900,
    }));
}

const summary = {
    generatedAt: new Date().toISOString(),
    oracle: deployment.addresses.PrimeOracle,
    topics: results.length,
    messages: results.reduce((sum, result) => sum + result.messages, 0),
    verified: results.reduce((sum, result) => sum + result.verified, 0),
    pending: results.reduce((sum, result) => sum + result.pending, 0),
    expired: results.reduce((sum, result) => sum + result.expired, 0),
    statuses: results.reduce((sum, result) => sum + result.statuses, 0),
    invalid: results.reduce((sum, result) => sum + result.invalid, 0),
};
if (args.includes("--json")) {
    console.log(JSON.stringify({summary, results}, null, 2));
} else {
    console.log(
        `oracle ${summary.oracle}: ${summary.verified} verified, ` +
        `${summary.statuses} statuses, ${summary.pending} pending, ` +
        `${summary.expired} expired, ${summary.invalid} invalid`,
    );
    for (const result of results) {
        console.log(
            `${result.topicId} ${result.publisher.profile}: ` +
            `${result.verified} verified, ${result.statuses} statuses, ${result.pending} pending, ` +
            `${result.expired} expired, ${result.invalid} invalid`,
        );
    }
}
if (summary.invalid > 0) process.exitCode = 1;
