import {Contract, JsonRpcProvider, Network} from "ethers";
import {createHash} from "node:crypto";
import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {evaluateSourceDrivenRounds} from "./lib/acceptance-evaluator.mjs";
import {
    runEvidenceVerifier,
    summaryFailsClosed,
} from "./verify-evidence.mjs";

const root = resolve(import.meta.dirname, "..");

function readJson(path, label) {
    if (!existsSync(path)) throw new Error(`${label} does not exist at ${path}`);
    return JSON.parse(readFileSync(path, "utf8"));
}

function sameAddress(left, right) {
    return String(left).toLowerCase() === String(right).toLowerCase();
}

function sha256(path) {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function uniqueVerifiedPublishers(results, round) {
    const rows = results.flatMap((result) => result.records ?? []).filter((record) =>
        record.state === "verified" &&
        record.scope?.current &&
        record.evidence?.k === "oracle-answer" &&
        Number(record.evidence.round) === Number(round));
    return {
        count: new Set(rows.map((row) =>
            String(row.evidence.publisher).toLowerCase())).size,
        configurationDigests: [...new Set(rows.map((row) =>
            row.evidence.configurationDigest).filter(Boolean))],
        triggers: [...new Set(rows.map((row) =>
            row.evidence.trigger).filter(Boolean))],
    };
}

export function monitoringCoverage(monitor) {
    const observations = [...(monitor.observations ?? [])]
        .sort((left, right) => Number(left.observedAt) - Number(right.observedAt));
    const expected = Number(monitor.pollSeconds);
    const heartbeat = Number(monitor.heartbeatSeconds);
    const gaps = [];
    let maximumGapSeconds = 0;
    for (let index = 1; index < observations.length; index++) {
        const before = observations[index - 1];
        const after = observations[index];
        const seconds = Number(after.observedAt) - Number(before.observedAt);
        maximumGapSeconds = Math.max(maximumGapSeconds, seconds);
        if (seconds <= expected * 2) continue;
        const sameFinalizedState =
            Number(before.round) === Number(after.round) &&
            Number(before.publishedAt) === Number(after.publishedAt);
        const expiresAt = Number(before.publishedAt) + heartbeat;
        const deterministicPanelCoverage =
            sameFinalizedState &&
            !before.ourLegDark &&
            !after.ourLegDark &&
            Number(after.observedAt) <= expiresAt;
        const hederaRateIsBlockCurrent =
            !before.cashLegDark &&
            !after.cashLegDark;
        gaps.push({
            from: Number(before.observedAt),
            through: Number(after.observedAt),
            seconds,
            round: Number(before.round),
            publishedAt: Number(before.publishedAt),
            expiresAt,
            deterministicPanelCoverage,
            hederaRateIsBlockCurrent,
            explanation: deterministicPanelCoverage
                ? "The finalized round and publishedAt are identical on both sides, and the entire gap ends before the immutable heartbeat expiry. HederaRateFeed reads the network fee conversion rate as current block state rather than carrying a timestamped quote."
                : "The gap is not covered by one unchanged finalized round inside its heartbeat.",
        });
    }
    return {
        samples: observations.length,
        expectedPollSeconds: expected,
        maximumGapSeconds,
        longGaps: gaps,
        allLongGapsAccountedFor: gaps.every((gap) =>
            gap.deterministicPanelCoverage && gap.hederaRateIsBlockCurrent),
    };
}

export async function finalizeAcceptance({
    monitorPath = resolve(root, "oracle/state/acceptance-monitor.json"),
    outputPath = resolve(root, "deployments/oracle-acceptance.json"),
    configPath = resolve(root, "oracle/config.json"),
} = {}) {
    const clientPath = resolve(root, "deployments/client.json");
    const schedulerPath = resolve(root, "deployments/oracle-scheduler.json");
    const numericPath = resolve(root, "deployments/oracle-numeric-verification.json");
    const client = readJson(clientPath, "client deployment");
    const schedulerRecord = readJson(schedulerPath, "scheduler deployment");
    const numeric = readJson(numericPath, "independent numeric verification");
    const monitor = readJson(monitorPath, "acceptance monitor");
    const numericHashes = Object.fromEntries(
        Object.entries(numeric.subject?.sourceSha256 ?? {}).map(
            ([relativePath, expected]) => [
                relativePath,
                {
                    expected,
                    actual: sha256(resolve(root, relativePath)),
                },
            ],
        ),
    );
    const numericVerified =
        numeric.status === "passed" &&
        Number(numeric.coverage?.exactStructuredComparisonsAcrossNormalAndOptimized) >=
            18_006 &&
        Object.values(numericHashes).length > 0 &&
        Object.values(numericHashes).every((row) => row.actual === row.expected);
    const network = new Network("hedera-testnet", client.network.chainId);
    const provider = new JsonRpcProvider(
        client.network.rpc,
        network,
        {staticNetwork: network, batchMaxCount: 20},
    );
    const oracle = new Contract(client.addresses.PrimeOracle, [
        "function latest() view returns (uint128 cleanPrice,uint64 refRateBps,uint64 publishedAt,uint64 round)",
        "function quorum() view returns (uint256)",
        "function panelOf(uint64) view returns ((uint128 price,uint64 rate,address by)[])",
    ], provider);
    const scheduler = new Contract(schedulerRecord.address, [
        "function oracle() view returns (address)",
        "function activeSchedule() view returns (address)",
        "function lastFinalizedRound() view returns (uint64)",
    ], provider);

    try {
        const [latest, quorumValue, schedulerOracle, activeSchedule, finalizedRound] =
            await Promise.all([
                oracle.latest(),
                oracle.quorum(),
                scheduler.oracle(),
                scheduler.activeSchedule(),
                scheduler.lastFinalizedRound(),
            ]);
        const latestRound = Number(latest.round);
        const quorum = Number(quorumValue);
        const panel = await oracle.panelOf(latestRound);
        const evidence = await runEvidenceVerifier([
            "--config",
            configPath,
            "--topics",
            resolve(root, "oracle/deployments/topics"),
        ]);
        const sourceDriven = evaluateSourceDrivenRounds(evidence.results, {
            initialRound: monitor.initialRound,
            quorum,
        });
        const latestEvidence = uniqueVerifiedPublishers(
            evidence.results,
            latestRound,
        );
        const coverage = monitoringCoverage(monitor);
        const finalObservation = monitor.observations?.at(-1) ?? null;
        const monitorCriteria = {...(monitor.criteria ?? {})};
        delete monitorCriteria.multipleSourceDrivenRounds;
        monitorCriteria.laterRoundObserved =
            Number(finalObservation?.round ?? 0) >= Number(monitor.initialRound) + 1;
        const firstReplacement = (monitor.transitions ?? []).find((transition) =>
            Number(transition.toRound) > Number(monitor.initialRound));
        const criteria = {
            strictCurrentBaseline:
                Number(monitor.initialRound) === Number(monitor.latestRoundAtStart),
            observedBeyondInitialHeartbeat: Boolean(
                finalObservation &&
                Number(finalObservation.observedAt) >= Number(monitor.requiredThrough),
            ),
            replacementRoundBeforeExpiry: Boolean(
                firstReplacement &&
                Number(firstReplacement.publishedAt) <=
                    Number(monitor.initialPublishedAt) + Number(monitor.heartbeatSeconds),
            ),
            laterUpstreamSourceRound: sourceDriven.passed,
            feedLiveAtEnd: Boolean(finalObservation && !finalObservation.dark),
            noObservedDarkIntervals: (monitor.violations ?? []).length === 0,
            noObservationErrors: (monitor.observationErrors ?? []).length === 0,
            monitoringGapsAccountedFor: coverage.allLongGapsAccountedFor,
            addressBookStable:
                sameAddress(monitor.oracle, client.addresses.PrimeOracle) &&
                sameAddress(monitor.marginWatch, client.addresses.MarginWatch),
            schedulerRecordStable:
                sameAddress(monitor.scheduler?.address, schedulerRecord.address) &&
                sameAddress(schedulerRecord.oracle, client.addresses.PrimeOracle),
            schedulerBoundToOracle:
                sameAddress(schedulerOracle, client.addresses.PrimeOracle),
            schedulerFinalizedLatestRound:
                Number(finalizedRound) >= latestRound &&
                String(activeSchedule).toLowerCase() ===
                    "0x0000000000000000000000000000000000000000",
            evidenceFailsClosedClean:
                evidence.exitCode === 0 && !summaryFailsClosed(evidence.summary),
            independentNumericVerification: numericVerified,
            latestPanelHasQuorum: panel.length >= quorum,
            latestRoundEvidenceHasQuorum: latestEvidence.count >= quorum,
            distinctPublisherConfigurations:
                latestEvidence.configurationDigests.length >= quorum,
        };
        const record = {
            schema: "lattice.oracle.acceptance.v1",
            generatedAt: new Date().toISOString(),
            network: "hedera-testnet",
            chainId: Number(client.network.chainId),
            oracle: client.addresses.PrimeOracle,
            marginWatch: client.addresses.MarginWatch,
            scheduler: {
                address: schedulerRecord.address,
                contractId: schedulerRecord.contractId,
                oracle: String(schedulerOracle),
                lastFinalizedRound: Number(finalizedRound),
                activeSchedule: String(activeSchedule),
                measuredCost: schedulerRecord.officialSourceCanary?.cost ??
                    schedulerRecord.productionCanary?.cost ??
                    null,
            },
            liveState: {
                round: latestRound,
                publishedAt: Number(latest.publishedAt),
                cleanPriceUsd8: latest.cleanPrice.toString(),
                referenceRateBps: latest.refRateBps.toString(),
                quorum,
                panelAnswers: panel.length,
            },
            monitor: {
                ...monitor,
                criteria: monitorCriteria,
            },
            monitoringCoverage: coverage,
            numericVerification: {
                schema: numeric.schema,
                generatedAt: numeric.generatedAt,
                status: numeric.status,
                exactComparisons:
                    numeric.coverage?.exactStructuredComparisonsAcrossNormalAndOptimized,
                sourceSha256: numericHashes,
            },
            evidence: {
                summary: evidence.summary,
                latestRound: latestEvidence,
                sourceDriven,
            },
            criteria,
            passed: Object.values(criteria).every(Boolean),
        };
        writeFileSync(outputPath, JSON.stringify(record, null, 2) + "\n");
        return {record, outputPath};
    } finally {
        provider.destroy();
    }
}

async function main() {
    const {record, outputPath} = await finalizeAcceptance();
    console.log(JSON.stringify({
        passed: record.passed,
        output: outputPath,
        criteria: record.criteria,
    }));
    process.exitCode = record.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
