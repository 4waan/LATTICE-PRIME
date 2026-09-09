#!/usr/bin/env node
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";

import {IsolatedProvingWorker} from "../runtime/worker.mjs";
import {EzklVerifier} from "../runtime/verifier.mjs";

const venueRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const bundleDir = path.join(venueRoot, "agent/artifacts/proof");
const context = JSON.parse(
    await readFile(path.join(bundleDir, "expected-context.json"), "utf8")
);
const worker = new IsolatedProvingWorker({
    bundleDir,
    diagnosticOutput: process.env.LATTICE_AGENT_WORKER_DIAGNOSTICS === "1",
});
const verifier = new EzklVerifier({
    bundleDir,
    pythonPath: path.join(venueRoot, ".venv/bin/python"),
});

const started = performance.now();
const result = await worker.prove(context);
const verification = await verifier.verify({proof: result.proof, context});
const report = {
    schemaVersion: "lattice.agent.worker-test.v1",
    status: "passed",
    elapsedMilliseconds: Math.round(performance.now() - started),
    processMaxRssKiB: process.resourceUsage().maxRSS,
    verification,
    evidence: result.evidence,
};
const evidenceDir = path.join(venueRoot, "agent/artifacts/evidence");
await mkdir(evidenceDir, {recursive: true});
const rendered = `${JSON.stringify(report, null, 2)}\n`;
await writeFile(path.join(evidenceDir, "worker-test.json"), rendered, "utf8");
console.log(rendered);
