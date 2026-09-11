import {createHash} from "node:crypto";
import {existsSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";

export const PRIVATE_CANDIDATE_SCHEMA =
    "lattice.private-trading-candidate-deployment.v1";
export const PRIVATE_OVERLAY_SCHEMA = "lattice.private-trading-client-overlay.v1";

export const PRIVATE_OVERLAY_SERVICES = Object.freeze({
    tickets: "/api/private/tickets",
    orders: "/api/private/orders",
    routing: "/api/private/routing",
    sessions: "/api/private/sessions",
});

export const PRIVATE_PROVING_ARTIFACT_LAYOUT = Object.freeze({
    sessionEligibility: Object.freeze({
        wasm: "circuits/session/session_eligibility_js/session_eligibility.wasm",
        zkey: "circuits/session/session_eligibility.zkey",
        vkey: "circuits/session/session_eligibility_vkey.json",
    }),
    sessionCompliance: Object.freeze({
        wasm: "circuits/session/session_compliance_js/session_compliance.wasm",
        zkey: "circuits/session/session_compliance.zkey",
        vkey: "circuits/session/session_compliance_vkey.json",
    }),
    routingWithdrawal: Object.freeze({
        wasm: "circuits/router/fixed_withdrawal_js/fixed_withdrawal.wasm",
        zkey: "circuits/router/fixed_withdrawal.zkey",
        vkey: "circuits/router/fixed_withdrawal_vkey.json",
    }),
    routingCompliance: Object.freeze({
        wasm: "circuits/router/fixed_withdrawal_compliance_js/fixed_withdrawal_compliance.wasm",
        zkey: "circuits/router/fixed_withdrawal_compliance.zkey",
        vkey: "circuits/router/fixed_withdrawal_compliance_vkey.json",
    }),
});

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const REQUIRED_ADDRESSES = Object.freeze([
    "SessionAccountFactory",
    "DualRegistrationGate",
    "HbarRouter",
    "LprcRouter",
    "SessionRecoveryRouter",
]);

function address(value) {
    const got = String(value || "");
    return ADDRESS.test(got) ? got.toLowerCase() : null;
}

function digestFile(path) {
    const bytes = readFileSync(path);
    return Object.freeze({
        bytes: bytes.length,
        sha256: "0x" + createHash("sha256").update(bytes).digest("hex"),
        path,
    });
}

export function loadPrivateProvingArtifacts(root) {
    const base = String(root || "");
    const files = {};
    const artifacts = {};
    const missing = [];
    if (!base) {
        return Object.freeze({
            artifacts: null,
            files: Object.freeze({}),
            missing: Object.freeze(["proving root"]),
        });
    }
    for (const [name, layout] of Object.entries(PRIVATE_PROVING_ARTIFACT_LAYOUT)) {
        const wasmPath = join(base, layout.wasm);
        const zkeyPath = join(base, layout.zkey);
        const vkeyPath = join(base, layout.vkey);
        if (!existsSync(wasmPath) || !existsSync(zkeyPath) || !existsSync(vkeyPath)) {
            missing.push(name);
            continue;
        }
        let verificationKey;
        try {
            verificationKey = JSON.parse(readFileSync(vkeyPath, "utf8"));
        } catch {
            missing.push(name);
            continue;
        }
        if (
            !verificationKey
            || typeof verificationKey !== "object"
            || verificationKey.protocol !== "plonk"
        ) {
            missing.push(name);
            continue;
        }
        const wasm = digestFile(wasmPath);
        const zkey = digestFile(zkeyPath);
        if (wasm.bytes < 1 || zkey.bytes < 1) {
            missing.push(name);
            continue;
        }
        files[`${name}.wasm`] = Object.freeze({
            path: wasm.path,
            bytes: wasm.bytes,
        });
        files[`${name}.zkey`] = Object.freeze({
            path: zkey.path,
            bytes: zkey.bytes,
        });
        artifacts[name] = Object.freeze({
            wasm: Object.freeze({
                url: `/private-artifacts/${name}.wasm`,
                bytes: wasm.bytes,
                sha256: wasm.sha256,
            }),
            zkey: Object.freeze({
                url: `/private-artifacts/${name}.zkey`,
                bytes: zkey.bytes,
                sha256: zkey.sha256,
            }),
            verificationKey,
        });
    }
    const complete = missing.length === 0
        && Object.keys(artifacts).length === Object.keys(PRIVATE_PROVING_ARTIFACT_LAYOUT).length;
    return Object.freeze({
        artifacts: complete ? Object.freeze(artifacts) : null,
        files: Object.freeze(files),
        missing: Object.freeze(missing),
    });
}

export function provingArtifactFile(files, urlPath) {
    const name = String(urlPath || "").replace(/^\/private-artifacts\//, "");
    if (!/^[A-Za-z]+\.(wasm|zkey)$/.test(name)) return null;
    const record = files?.[name];
    if (!record?.path || !existsSync(record.path)) return null;
    try {
        if (statSync(record.path).isFile() !== true) return null;
    } catch {
        return null;
    }
    return record;
}

export function buildPrivateCandidateOverlay({
    candidate = null,
    notes = null,
    workerOk = false,
    artifacts = null,
} = {}) {
    if (
        !candidate
        || candidate.schemaVersion !== PRIVATE_CANDIDATE_SCHEMA
        || candidate.candidateOnly !== true
        || Number(candidate.network?.chainId) !== 296
    ) {
        return null;
    }
    const addresses = {};
    const seen = new Set();
    for (const name of REQUIRED_ADDRESSES) {
        const value = address(candidate.addresses?.[name]);
        if (!value || seen.has(value)) return null;
        seen.add(value);
        addresses[name] = value;
    }
    const feePolicyDigest = String(candidate.context?.feePolicyDigest || "").toLowerCase();
    const hbarDenomination = String(candidate.context?.hbarDenominationTinybar || "");
    const lprcDenomination = String(candidate.context?.lprcDenomination || "");
    if (!HASH.test(feePolicyDigest) || feePolicyDigest === `0x${"0".repeat(64)}`) {
        return null;
    }
    if (!/^[1-9][0-9]*$/.test(hbarDenomination) || !/^[1-9][0-9]*$/.test(lprcDenomination)) {
        return null;
    }
    const hbarNotes = Number(notes?.afterFunders ?? notes?.afterLeaves ?? 0);
    const provingReady = Boolean(
        artifacts?.sessionEligibility
        && artifacts?.sessionCompliance
        && artifacts?.routingWithdrawal
        && artifacts?.routingCompliance,
    );
    const activationEpoch = Number(candidate.context?.activationEpoch || 0);
    return Object.freeze({
        schemaVersion: PRIVATE_OVERLAY_SCHEMA,
        overlay: true,
        enabled: true,
        buyEnabled: true,
        sellEnabled: false,
        timedReleaseVerified: false,
        privacyCanaryPassed: false,
        rollbackCanaryPassed: false,
        activationEpoch: Number.isInteger(activationEpoch) ? activationEpoch : null,
        workerOk: workerOk === true,
        provingReady,
        addresses: Object.freeze(addresses),
        session: Object.freeze({
            creationCodeHash: "",
            feePolicyDigest,
        }),
        routing: Object.freeze({
            HBAR: Object.freeze({denomination: hbarDenomination}),
            LPRC: Object.freeze({denomination: lprcDenomination}),
        }),
        routingNotes: Object.freeze({
            HBAR: Number.isFinite(hbarNotes) ? hbarNotes : 0,
            LPRC: 0,
        }),
        services: PRIVATE_OVERLAY_SERVICES,
        artifacts: provingReady ? artifacts : null,
        reason:
            "Candidate overlay. Buys wait for DualRegistrationGate to be the live KYC gate. "
            + "Sells wait on LPRC ATS canary and eight LPRC notes.",
    });
}
