import {Contract, JsonRpcProvider} from "ethers";
import {existsSync, readFileSync, readdirSync} from "node:fs";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {loadOracleConfig} from "./lib/config.mjs";
import {verifyEvidenceTopic} from "./lib/evidence-verifier.mjs";
import {readDeployment, VENUE_ROOT} from "./lib/terms-source.mjs";

function value(args, flag, fallback = null) {
    const index = args.indexOf(flag);
    return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

function topicFiles(args) {
    const topicDirectory = resolve(value(args, "--topics", "oracle/deployments/topics"));
    return value(args, "--topic")
        ? [resolve(value(args, "--topic"))]
        : existsSync(topicDirectory)
            ? readdirSync(topicDirectory)
                .filter((name) => name.endsWith(".json"))
                .sort()
                .map((name) => join(topicDirectory, name))
            : [];
}

function oracleReader(provider, abi) {
    const contracts = new Map();
    const contract = (address) => {
        const key = String(address).toLowerCase();
        if (!contracts.has(key)) {
            contracts.set(key, new Contract(address, abi, provider));
        }
        return contracts.get(key);
    };
    return {
        async openRound(address) {
            return contract(address).openRound();
        },
        async panelOf(address, round) {
            return contract(address).panelOf(round);
        },
    };
}

function failedTopic(topic, error) {
    return {
        topicId: topic.topicId,
        publisher: topic.publisher,
        messages: 0,
        verified: 0,
        currentVerified: 0,
        historicalVerified: 0,
        pending: 0,
        expired: 0,
        statuses: 0,
        excluded: 0,
        invalid: 1,
        missingPanelEvidence: 0,
        mirrorErrors: 1,
        panelErrors: 0,
        panelAnswers: 0,
        records: [],
        missing: [],
        errors: [{type: "verifier", message: error.message}],
    };
}

export function summarizeEvidence(results, oracle) {
    const sum = (field) => results.reduce(
        (total, result) => total + Number(result[field] ?? 0),
        0,
    );
    return {
        generatedAt: new Date().toISOString(),
        oracle,
        topics: results.length,
        messages: sum("messages"),
        verified: sum("verified"),
        currentVerified: sum("currentVerified"),
        historicalVerified: sum("historicalVerified"),
        pending: sum("pending"),
        expired: sum("expired"),
        statuses: sum("statuses"),
        excluded: sum("excluded"),
        invalid: sum("invalid"),
        missingPanelEvidence: sum("missingPanelEvidence"),
        mirrorErrors: sum("mirrorErrors"),
        panelErrors: sum("panelErrors"),
        panelAnswers: sum("panelAnswers"),
    };
}

export function summaryFailsClosed(summary) {
    return [
        "pending",
        "expired",
        "invalid",
        "missingPanelEvidence",
        "mirrorErrors",
        "panelErrors",
    ].some((field) => Number(summary[field] ?? 0) > 0);
}

export async function runEvidenceVerifier(
    args = process.argv.slice(2),
    {
        loadConfigFn = loadOracleConfig,
        readDeploymentFn = readDeployment,
        providerFactory = (rpcUrl, chainId) => new JsonRpcProvider(
            rpcUrl,
            chainId,
            {staticNetwork: true, batchMaxCount: 20},
        ),
        verifyTopicFn = verifyEvidenceTopic,
    } = {},
) {
    const config = loadConfigFn(value(args, "--config") ?? undefined, {allowExample: true});
    const deployment = readDeploymentFn().client;
    const abi = JSON.parse(readFileSync(
        join(VENUE_ROOT, "deployments/abi/PrimeOracle.json"),
        "utf8",
    ));
    const files = topicFiles(args);
    if (files.length === 0) throw new Error("no oracle evidence topic records found");

    const configuredHistory = config.evidence?.oracleHistory ?? [];
    const superseded = deployment.superseded?.repoVaultBeforeFinancingV5?.PrimeOracle;
    const history = [...configuredHistory];
    if (superseded && !history.some((entry) =>
        String(typeof entry === "string" ? entry : entry?.address).toLowerCase() ===
        String(superseded).toLowerCase())) {
        history.push(superseded);
    }

    const provider = providerFactory(
        config.rpcUrl ?? deployment.network.rpc,
        Number(config.chainId),
    );
    const reader = oracleReader(provider, abi);
    const results = [];
    try {
        for (const file of files) {
            const topic = JSON.parse(readFileSync(file, "utf8"));
            if (topic.schema !== "lattice.oracle.topic.v1") {
                throw new Error(`${file} is not an oracle topic record`);
            }
            try {
                results.push(await verifyTopicFn({
                    mirrorUrl: config.mirrorUrl ?? deployment.network.mirror,
                    topic,
                    oracle: deployment.addresses.PrimeOracle,
                    oracleHistory: history,
                    currentFromRound: config.evidence?.currentFromRound ?? 1,
                    chainId: config.chainId,
                    oracleAbi: abi,
                    oracleReader: reader,
                    maximumDelaySeconds:
                        config.evidence?.maximumVerificationDelaySeconds ?? 900,
                    maximumPanelRounds: config.evidence?.maximumPanelRounds ?? 10_000,
                }));
            } catch (error) {
                results.push(failedTopic(topic, error));
            }
        }
    } finally {
        provider.destroy?.();
    }

    const summary = summarizeEvidence(results, deployment.addresses.PrimeOracle);
    return {
        summary,
        results,
        exitCode: summaryFailsClosed(summary) ? 1 : 0,
    };
}

async function main() {
    const args = process.argv.slice(2);
    const report = await runEvidenceVerifier(args);
    if (args.includes("--json")) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        const summary = report.summary;
        console.log(
            `oracle ${summary.oracle}: ${summary.currentVerified} current verified, ` +
            `${summary.historicalVerified} historical verified, ${summary.statuses} statuses, ` +
            `${summary.pending} pending, ${summary.expired} expired, ` +
            `${summary.invalid} invalid, ${summary.missingPanelEvidence} missing panel evidence, ` +
            `${summary.mirrorErrors} mirror errors, ${summary.panelErrors} panel errors`,
        );
        for (const result of report.results) {
            console.log(
                `${result.topicId} ${result.publisher.profile}: ` +
                `${result.currentVerified} current verified, ` +
                `${result.historicalVerified} historical verified, ` +
                `${result.pending} pending, ${result.expired} expired, ` +
                `${result.invalid} invalid, ` +
                `${result.missingPanelEvidence} missing panel evidence`,
            );
        }
    }
    process.exitCode = report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
