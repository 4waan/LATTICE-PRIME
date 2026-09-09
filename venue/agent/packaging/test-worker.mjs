#!/usr/bin/env node
import {readFile} from "node:fs/promises";
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
console.log(
    JSON.stringify(
        {
            schemaVersion: "lattice.agent.worker-test.v1",
            status: "passed",
            elapsedMilliseconds: Math.round(performance.now() - started),
            verification,
            evidence: result.evidence,
        },
        null,
        2
    )
);
