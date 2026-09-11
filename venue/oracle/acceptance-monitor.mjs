import {Contract, JsonRpcProvider, Network} from "ethers";
import {readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";

const root = resolve(import.meta.dirname, "..");
const clientPath = resolve(root, "deployments/client.json");
const schedulerRecordPath = resolve(root, "deployments/oracle-scheduler.json");
const client = JSON.parse(readFileSync(clientPath, "utf8"));
const schedulerRecord = JSON.parse(readFileSync(schedulerRecordPath, "utf8"));
const network = new Network("hedera-testnet", client.network.chainId);
const provider = new JsonRpcProvider(client.network.rpc, network, {staticNetwork: network});
const oracle = new Contract(client.addresses.PrimeOracle, [
    "function latest() view returns (uint128 cleanPrice,uint64 refRateBps,uint64 publishedAt,uint64 round)",
    "function heartbeat() view returns (uint64)",
    "function openRound() view returns (uint64)",
    "function panelOf(uint64) view returns ((uint128 price,uint64 rate,address by)[])",
], provider);
const watch = new Contract(client.addresses.MarginWatch, [
    "function feed() view returns ((address oracle,bool dark,bool ourLegDark,bool cashLegDark,uint128 cleanPrice,uint64 refRateBps,uint64 publishedAt,uint64 round,uint256 usdPerHbar,uint256 markPerUnitTinybar,address cashFeed))",
], provider);
const scheduler = new Contract(schedulerRecord.address, [
    "function oracle() view returns (address)",
    "function activeSchedule() view returns (address)",
    "function nextCheckAt() view returns (uint64)",
    "function lastFinalizedRound() view returns (uint64)",
    "function checksThisRound() view returns (uint8)",
], provider);

const output = resolve(root, "oracle/state/acceptance-monitor.json");
const intervalSeconds = Number(process.env.ACCEPTANCE_POLL_SECONDS ?? 300);
if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 5) {
    throw new Error("ACCEPTANCE_POLL_SECONDS must be an integer of at least five seconds");
}
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
const sameAddress = (left, right) =>
    String(left).toLowerCase() === String(right).toLowerCase();
const expectedOracle = client.addresses.PrimeOracle;
if (!sameAddress(schedulerRecord.oracle, expectedOracle)) {
    throw new Error(
        `scheduler deployment record targets ${schedulerRecord.oracle}, expected ${expectedOracle}`,
    );
}
const schedulerOracle = String(await scheduler.oracle());
if (!sameAddress(schedulerOracle, expectedOracle)) {
    throw new Error(
        `onchain scheduler targets ${schedulerOracle}, expected ${expectedOracle}`,
    );
}

const latestAtStart = await oracle.latest();
const latestRoundAtStart = Number(latestAtStart.round);
const initialRound = Number(process.env.ACCEPTANCE_BASELINE_ROUND ?? latestRoundAtStart);
if (!Number.isSafeInteger(initialRound) || initialRound !== latestRoundAtStart) {
    throw new Error(
        `acceptance must start from current round ${latestRoundAtStart}, not historical round ${initialRound}`,
    );
}
const initial = latestAtStart;
const heartbeat = Number(await oracle.heartbeat());
const firstPublishedAt = Number(initial.publishedAt);
const deadline = firstPublishedAt + heartbeat + 60;
const report = {
    schema: "lattice.oracle.sustained-acceptance.v1",
    startedAt: new Date().toISOString(),
    initialRound,
    initialPublishedAt: firstPublishedAt,
    latestRoundAtStart,
    heartbeatSeconds: heartbeat,
    requiredThrough: deadline,
    pollSeconds: intervalSeconds,
    oracle: expectedOracle,
    marginWatch: client.addresses.MarginWatch,
    scheduler: {
        address: schedulerRecord.address,
        oracle: schedulerOracle,
    },
    observations: [],
    transitions: [],
    violations: [],
    observationErrors: [],
};
let previousRound = latestRoundAtStart;

for (;;) {
    try {
        const [feed, latest, openRound, activeSchedule, nextCheckAt, finalizedRound, checks] =
            await Promise.all([
                watch.feed(),
                oracle.latest(),
                oracle.openRound(),
                scheduler.activeSchedule(),
                scheduler.nextCheckAt(),
                scheduler.lastFinalizedRound(),
                scheduler.checksThisRound(),
            ]);
        const panel = await oracle.panelOf(openRound);
        const observation = {
            observedAt: Math.floor(Date.now() / 1000),
            round: Number(latest.round),
            publishedAt: Number(latest.publishedAt),
            cleanPriceUsd8: latest.cleanPrice.toString(),
            referenceRateBps: latest.refRateBps.toString(),
            feedOracle: String(feed.oracle),
            dark: Boolean(feed.dark),
            ourLegDark: Boolean(feed.ourLegDark),
            cashLegDark: Boolean(feed.cashLegDark),
            openRound: Number(openRound),
            openAnswers: panel.length,
            schedulerActive: String(activeSchedule),
            schedulerNextCheckAt: Number(nextCheckAt),
            schedulerFinalizedRound: Number(finalizedRound),
            schedulerChecksThisRound: Number(checks),
        };
        report.observations.push(observation);
        if (observation.dark) {
            report.violations.push({
                observedAt: observation.observedAt,
                code: "FEED_DARK",
                ourLegDark: observation.ourLegDark,
                cashLegDark: observation.cashLegDark,
            });
        }
        if (!sameAddress(observation.feedOracle, expectedOracle)) {
            report.violations.push({
                observedAt: observation.observedAt,
                code: "MARGIN_WATCH_ORACLE_MISMATCH",
                actual: observation.feedOracle,
                expected: expectedOracle,
            });
        }
        if (observation.round !== previousRound) {
            report.transitions.push({
                observedAt: observation.observedAt,
                fromRound: previousRound,
                toRound: observation.round,
                publishedAt: observation.publishedAt,
            });
            previousRound = observation.round;
        }
        writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
        console.log(JSON.stringify({
            type: "acceptance-sample",
            observedAt: observation.observedAt,
            round: observation.round,
            dark: observation.dark,
            openAnswers: observation.openAnswers,
            schedulerActive: observation.schedulerActive,
        }));
        if (observation.observedAt >= deadline) break;
    } catch (error) {
        report.observationErrors.push({
            observedAt: Math.floor(Date.now() / 1000),
            message: error.message,
        });
        writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
        console.error(JSON.stringify({type: "acceptance-error", message: error.message}));
    }
    await sleep(intervalSeconds * 1000);
}

const final = report.observations.at(-1);
if (!final) throw new Error("acceptance ended without a successful observation");
const firstTransition = report.transitions[0];
const finalClient = JSON.parse(readFileSync(clientPath, "utf8"));
const finalSchedulerRecord = JSON.parse(readFileSync(schedulerRecordPath, "utf8"));
report.completedAt = new Date().toISOString();
report.criteria = {
    observedBeyondInitialHeartbeat: final.observedAt > firstPublishedAt + heartbeat,
    laterRoundObserved: final.round >= report.initialRound + 1,
    replacementRoundBeforeExpiry: Boolean(
        firstTransition && firstTransition.publishedAt <= firstPublishedAt + heartbeat
    ),
    feedLiveAtEnd: !final.dark,
    marginWatchBoundToOracle: sameAddress(final.feedOracle, expectedOracle),
    addressBookStable:
        sameAddress(finalClient.addresses.PrimeOracle, expectedOracle) &&
        sameAddress(finalClient.addresses.MarginWatch, client.addresses.MarginWatch),
    schedulerRecordStable:
        sameAddress(finalSchedulerRecord.address, schedulerRecord.address) &&
        sameAddress(finalSchedulerRecord.oracle, expectedOracle),
    schedulerBoundToOracle: sameAddress(schedulerOracle, expectedOracle),
    schedulerFinalizedLatestRound: final.schedulerFinalizedRound >= final.round,
    noObservedDarkIntervals: report.violations.length === 0,
    noObservationErrors: report.observationErrors.length === 0,
};
report.passed = Object.values(report.criteria).every(Boolean);
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({
    type: "acceptance-complete",
    passed: report.passed,
    criteria: report.criteria,
    output,
}));
provider.destroy();
process.exitCode = report.passed ? 0 : 1;
