import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {
    PRIVATE_PROVING_ARTIFACT_LAYOUT,
    buildPrivateCandidateOverlay,
    loadPrivateProvingArtifacts,
    provingArtifactFile,
} from "./private-candidate-overlay.mjs";

const CANDIDATE = {
    schemaVersion: "lattice.private-trading-candidate-deployment.v1",
    candidateOnly: true,
    network: {chainId: 296},
    addresses: {
        SessionAccountFactory: "0x" + "11".repeat(20),
        DualRegistrationGate: "0x" + "22".repeat(20),
        HbarRouter: "0x" + "33".repeat(20),
        LprcRouter: "0x" + "44".repeat(20),
        SessionRecoveryRouter: "0x" + "55".repeat(20),
    },
    context: {
        activationEpoch: 8,
        feePolicyDigest: "0x" + "66".repeat(32),
        hbarDenominationTinybar: "100000000",
        lprcDenomination: "1",
    },
};

function writeProvingTree(root) {
    for (const layout of Object.values(PRIVATE_PROVING_ARTIFACT_LAYOUT)) {
        mkdirSync(join(root, layout.wasm, ".."), {recursive: true});
        writeFileSync(join(root, layout.wasm), "wasm");
        writeFileSync(join(root, layout.zkey), "zkey-bytes");
        writeFileSync(
            join(root, layout.vkey),
            JSON.stringify({protocol: "plonk", curve: "bn128"}),
        );
    }
}

test("candidate overlay binds addresses and keeps sells closed", () => {
    const overlay = buildPrivateCandidateOverlay({
        candidate: CANDIDATE,
        notes: {afterFunders: 8, afterLeaves: 8},
        workerOk: true,
        artifacts: {
            sessionEligibility: {wasm: {}, zkey: {}, verificationKey: {protocol: "plonk"}},
            sessionCompliance: {wasm: {}, zkey: {}, verificationKey: {protocol: "plonk"}},
            routingWithdrawal: {wasm: {}, zkey: {}, verificationKey: {protocol: "plonk"}},
            routingCompliance: {wasm: {}, zkey: {}, verificationKey: {protocol: "plonk"}},
        },
    });
    assert.equal(overlay.overlay, true);
    assert.equal(overlay.enabled, true);
    assert.equal(overlay.buyEnabled, true);
    assert.equal(overlay.sellEnabled, false);
    assert.equal(overlay.timedReleaseVerified, false);
    assert.equal(overlay.routingNotes.HBAR, 8);
    assert.equal(overlay.routing.HBAR.denomination, "100000000");
    assert.equal(overlay.provingReady, true);
    assert.equal(overlay.services.sessions, "/api/private/sessions");
});

test("candidate overlay refuses a commercial-looking candidate file", () => {
    assert.equal(buildPrivateCandidateOverlay({
        candidate: {...CANDIDATE, candidateOnly: false},
    }), null);
    assert.equal(buildPrivateCandidateOverlay({
        candidate: {...CANDIDATE, schemaVersion: "lattice.private-trading-release.v3"},
    }), null);
    assert.equal(buildPrivateCandidateOverlay({
        candidate: {
            ...CANDIDATE,
            addresses: {...CANDIDATE.addresses, HbarRouter: CANDIDATE.addresses.LprcRouter},
        },
    }), null);
});

test("proving artifact loader hashes local circuit files and allowlists URLs", () => {
    const root = mkdtempSync(join(tmpdir(), "private-proving-"));
    writeProvingTree(root);
    const loaded = loadPrivateProvingArtifacts(root);
    assert.equal(loaded.missing.length, 0);
    assert.ok(loaded.artifacts.sessionEligibility.wasm.sha256.startsWith("0x"));
    assert.equal(loaded.artifacts.sessionEligibility.wasm.bytes, 4);
    const wasm = provingArtifactFile(loaded.files, "/private-artifacts/sessionEligibility.wasm");
    assert.ok(wasm.path.endsWith("session_eligibility.wasm"));
    assert.equal(provingArtifactFile(loaded.files, "/private-artifacts/../secret.zkey"), null);
});
