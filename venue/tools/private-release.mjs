import {createHash} from "node:crypto";
import {readFile, writeFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";

export const PRIVATE_RELEASE_SCHEMA = "lattice.private-trading-release.v3";
export const QUICKNET_CHAIN_HASH =
    "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";

export const GAS_GATES = Object.freeze({
    buy: Object.freeze({direct: 334_492n, target: 367_941n, cap: 384_666n}),
    sell: Object.freeze({direct: 720_040n, target: 792_044n, cap: 828_046n}),
});

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^(?:0x)?[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const zeroHash = (value) => String(value || "").toLowerCase().replace(/^0x/, "")
    === "0".repeat(64);
const SIDE_NAMES = ["buy", "sell"];
const REQUIRED_ADDRESSES = [
    "SessionAccountFactory",
    "DualRegistrationGate",
    "HbarRouter",
    "LprcRouter",
    "SessionRecoveryRouter",
];
const REQUIRED_ARTIFACTS = [
    "sessionEligibility",
    "sessionCompliance",
    "routingWithdrawal",
    "routingCompliance",
];
const MAX_ARTIFACT_BYTES = 160 * 1024 * 1024;

export class PrivateReleaseError extends Error {
    constructor(code, message, side = null) {
        super(message);
        this.name = "PrivateReleaseError";
        this.code = code;
        this.side = side;
    }
}

function object(value, name) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new PrivateReleaseError("EVIDENCE_INVALID", `${name} must be an object`);
    }
    return value;
}

function bool(value, name, side = null) {
    if (value !== true && value !== false) {
        throw new PrivateReleaseError("EVIDENCE_INVALID", `${name} must be boolean`, side);
    }
    return value;
}

function integer(value, name, side = null) {
    const text = String(value ?? "");
    if (!/^(0|[1-9][0-9]*)$/.test(text)) {
        throw new PrivateReleaseError("EVIDENCE_INVALID", `${name} must be a canonical integer`, side);
    }
    return BigInt(text);
}

function requirePass(value, code, message, side = null) {
    if (!bool(value, message, side)) {
        throw new PrivateReleaseError(code, message, side);
    }
}

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) =>
            `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

export function privateReleaseEvidenceDigest(input) {
    const evidence = object(input, "private release evidence");
    const unsigned = Object.fromEntries(
        Object.entries(evidence).filter(([key]) => key !== "evidenceDigest"),
    );
    return `0x${createHash("sha256").update(canonical(unsigned)).digest("hex")}`;
}

function sameOriginPath(value, name) {
    const text = String(value || "");
    if (!/^\/api\/[a-z0-9/_-]+$/.test(text) || text.includes("//")) {
        throw new PrivateReleaseError("SERVICE_PATH_INVALID", `${name} is invalid`);
    }
    return text;
}

function artifactFile(value, name) {
    const descriptor = object(value, name);
    const url = String(descriptor.url || "");
    if (
        !(url.startsWith("/") && !url.startsWith("//"))
        && !/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\//.test(url)
    ) {
        throw new PrivateReleaseError("ARTIFACT_URL_INVALID", `${name} URL is invalid`);
    }
    const bytes = Number(integer(descriptor.bytes, `${name}.bytes`));
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_ARTIFACT_BYTES) {
        throw new PrivateReleaseError("ARTIFACT_SIZE_INVALID", `${name} size is invalid`);
    }
    if (!HASH.test(String(descriptor.sha256 || ""))) {
        throw new PrivateReleaseError("ARTIFACT_DIGEST_INVALID", `${name} digest is invalid`);
    }
    if (zeroHash(descriptor.sha256)) {
        throw new PrivateReleaseError("ARTIFACT_DIGEST_INVALID", `${name} digest is invalid`);
    }
    return {
        url,
        bytes,
        sha256: String(descriptor.sha256).toLowerCase(),
    };
}

function provingArtifact(value, name) {
    const artifact = object(value, name);
    return {
        wasm: artifactFile(artifact.wasm, `${name}.wasm`),
        zkey: artifactFile(artifact.zkey, `${name}.zkey`),
        verificationKey: object(artifact.verificationKey, `${name}.verificationKey`),
    };
}

function verifyGas(side, evidence) {
    const gas = object(evidence.gas?.[side], `${side} gas evidence`);
    const directFresh = integer(gas.directFresh, `${side}.directFresh`, side);
    const directWarm = integer(gas.directWarm, `${side}.directWarm`, side);
    const privateFresh = integer(gas.privateFresh, `${side}.privateFresh`, side);
    const privateWarm = integer(gas.privateWarm, `${side}.privateWarm`, side);
    const samePeriod = bool(gas.samePeriod, `${side}.samePeriod`, side);
    if (!samePeriod) {
        throw new PrivateReleaseError(
            "GAS_CONTROL_MISMATCH",
            `${side} gas samples were not measured in the same period`,
            side,
        );
    }
    if (directFresh === 0n || directWarm === 0n) {
        throw new PrivateReleaseError(
            "GAS_CONTROL_INVALID",
            `${side} direct controls must be nonzero`,
            side,
        );
    }
    const targetFresh = directFresh * 110n / 100n;
    const targetWarm = directWarm * 110n / 100n;
    const capFresh = (directFresh * 115n + 99n) / 100n;
    const capWarm = (directWarm * 115n + 99n) / 100n;
    if (privateFresh > capFresh || privateWarm > capWarm) {
        throw new PrivateReleaseError(
            "GAS_HARD_CAP",
            `${side} private gas exceeds its 15 percent hard cap`,
            side,
        );
    }
    return {
        directFresh: directFresh.toString(),
        directWarm: directWarm.toString(),
        privateFresh: privateFresh.toString(),
        privateWarm: privateWarm.toString(),
        targetFresh: targetFresh.toString(),
        targetWarm: targetWarm.toString(),
        capFresh: capFresh.toString(),
        capWarm: capWarm.toString(),
        withinTarget: privateFresh <= targetFresh && privateWarm <= targetWarm,
    };
}

function verifySide(side, evidence) {
    const gas = verifyGas(side, evidence);
    const canary = object(evidence.canaries?.[side], `${side} canary`);
    requirePass(canary.fresh, "CANARY_FRESH_FAILED", `${side} fresh canary did not pass`, side);
    requirePass(canary.repeated, "CANARY_REPEAT_FAILED", `${side} repeated canary did not pass`, side);
    requirePass(
        canary.directControl,
        "CANARY_CONTROL_FAILED",
        `${side} direct control did not pass`,
        side,
    );
    requirePass(
        canary.noWalletInCalldata,
        "PRIVACY_CALLDATA_FAILED",
        `${side} calldata still identifies the connected wallet`,
        side,
    );
    requirePass(
        canary.noWalletInEngineEvents,
        "PRIVACY_ENGINE_FAILED",
        `${side} engine events still identify the connected wallet`,
        side,
    );
    requirePass(
        canary.noWalletInSettlement,
        "PRIVACY_SETTLEMENT_FAILED",
        `${side} settlement still identifies the connected wallet`,
        side,
    );
    if (side === "sell") {
        requirePass(
            canary.atomicHoldRollback,
            "SELL_ROLLBACK_FAILED",
            "sell hold did not roll back with a failed reveal",
            side,
        );
    }
    return {gas, canary: {...canary}};
}

export function verifyPrivateRelease(input) {
    const evidence = object(input, "private release evidence");
    if (evidence.schemaVersion !== PRIVATE_RELEASE_SCHEMA) {
        throw new PrivateReleaseError("SCHEMA_INVALID", "private release schema is unsupported");
    }
    if (!HASH.test(String(evidence.evidenceDigest || ""))) {
        throw new PrivateReleaseError(
            "EVIDENCE_DIGEST_INVALID",
            "private release evidence digest is invalid",
        );
    }
    const expectedEvidenceDigest = privateReleaseEvidenceDigest(evidence);
    if (String(evidence.evidenceDigest).toLowerCase() !== expectedEvidenceDigest) {
        throw new PrivateReleaseError(
            "EVIDENCE_DIGEST_MISMATCH",
            "private release evidence digest does not match its contents",
        );
    }
    if (integer(evidence.network?.chainId, "network.chainId") !== 296n) {
        throw new PrivateReleaseError("CHAIN_INVALID", "private release is not bound to Hedera testnet");
    }
    const addresses = object(evidence.addresses, "addresses");
    const seenAddresses = new Set();
    for (const name of REQUIRED_ADDRESSES) {
        const deployed = String(addresses[name] || "").toLowerCase();
        if (
            !ADDRESS.test(deployed)
            || deployed === ZERO_ADDRESS
            || seenAddresses.has(deployed)
        ) {
            throw new PrivateReleaseError("ADDRESS_INVALID", `${name} is not a deployed address`);
        }
        seenAddresses.add(deployed);
    }
    const runtimeCodeHashes = object(evidence.runtimeCodeHashes, "runtimeCodeHashes");
    for (const name of REQUIRED_ADDRESSES) {
        if (
            !HASH.test(String(runtimeCodeHashes[name] || ""))
            || zeroHash(runtimeCodeHashes[name])
        ) {
            throw new PrivateReleaseError(
                "RUNTIME_HASH_INVALID",
                `${name} runtime hash is invalid`,
            );
        }
    }
    const quicknet = object(evidence.quicknet, "quicknet");
    if (String(quicknet.chainHash || "").toLowerCase().replace(/^0x/, "") !== QUICKNET_CHAIN_HASH) {
        throw new PrivateReleaseError("QUICKNET_CHAIN_INVALID", "Quicknet chain hash is not pinned");
    }
    if (!HASH.test(String(quicknet.publicKeyHash || "")) || zeroHash(quicknet.publicKeyHash)) {
        throw new PrivateReleaseError("QUICKNET_KEY_INVALID", "Quicknet public key hash is invalid");
    }
    requirePass(
        quicknet.beaconVerified,
        "QUICKNET_BEACON_FAILED",
        "Quicknet beacon verification did not pass",
    );
    requirePass(
        quicknet.preReleaseRefused,
        "TLOCK_EARLY_FAILED",
        "pre-release tlock decryption was not refused",
    );
    requirePass(
        quicknet.crashRecoveryPassed,
        "TICKET_RECOVERY_FAILED",
        "timed-ticket crash recovery did not pass",
    );
    requirePass(
        quicknet.redactedLogsPassed,
        "TICKET_LOGGING_FAILED",
        "timed-ticket redacted logging did not pass",
    );
    requirePass(
        quicknet.multipleRelaysPassed,
        "QUICKNET_RELAY_FAILED",
        "Quicknet relay failover did not pass",
    );

    const routing = object(evidence.routing, "routing");
    for (const asset of ["HBAR", "LPRC"]) {
        const assetEvidence = object(routing[asset], `routing.${asset}`);
        if (integer(assetEvidence.independentNotes, `${asset}.independentNotes`) < 8n) {
            throw new PrivateReleaseError(
                "ANONYMITY_THRESHOLD",
                `${asset} has fewer than eight fixed notes`,
            );
        }
        if (integer(assetEvidence.independentFunders, `${asset}.independentFunders`) < 8n) {
            throw new PrivateReleaseError(
                "INDEPENDENT_FUNDER_THRESHOLD",
                `${asset} has fewer than eight distinct funding addresses`,
            );
        }
        if (integer(assetEvidence.denomination, `${asset}.denomination`) === 0n) {
            throw new PrivateReleaseError(
                "DENOMINATION_INVALID",
                `${asset} denomination is invalid`,
            );
        }
        requirePass(
            assetEvidence.nullifierReplayRefused,
            "ROUTER_REPLAY_FAILED",
            `${asset} router accepted a nullifier replay`,
        );
        requirePass(
            assetEvidence.conservationPassed,
            "ROUTER_CONSERVATION_FAILED",
            `${asset} router conservation check failed`,
        );
    }
    requirePass(
        routing.LPRC.couponSnapshotPassed,
        "LPRC_COUPON_FAILED",
        "LPRC routing coupon treatment did not pass",
    );
    requirePass(
        routing.LPRC.corporateActionPassed,
        "LPRC_CORPORATE_ACTION_FAILED",
        "LPRC routing corporate-action handling did not pass",
    );
    if (
        !HASH.test(String(routing.LPRC.atsCanaryEvidenceHash || ""))
        || zeroHash(routing.LPRC.atsCanaryEvidenceHash)
    ) {
        throw new PrivateReleaseError(
            "LPRC_ATS_CANARY_INVALID",
            "LPRC ATS canary evidence hash is invalid",
        );
    }
    requirePass(
        evidence.session?.canonicalFactoryPassed,
        "SESSION_FACTORY_FAILED",
        "canonical session factory check failed",
    );
    requirePass(
        evidence.session?.restrictedSurfacePassed,
        "SESSION_SURFACE_FAILED",
        "restricted session surface check failed",
    );
    requirePass(
        evidence.session?.holderSecretPassed,
        "SESSION_HOLDER_SECRET_FAILED",
        "holder-secret eligibility check failed",
    );
    requirePass(
        evidence.session?.complianceMappingPassed,
        "SESSION_COMPLIANCE_FAILED",
        "compliance mapping check failed",
    );
    requirePass(
        evidence.session?.factoryVenueConfigApproved,
        "SESSION_CONFIG_FAILED",
        "session factory venue configuration was not approved",
    );
    requirePass(
        evidence.session?.eip712VectorPassed,
        "SESSION_SIGNATURE_VECTOR_FAILED",
        "session EIP-712 vector did not pass",
    );
    requirePass(
        evidence.session?.relayerKeySeparated,
        "RELAYER_KEY_SEPARATION_FAILED",
        "private relayer key separation did not pass",
    );
    if (
        !HASH.test(String(evidence.session?.creationCodeHash || ""))
        || zeroHash(evidence.session.creationCodeHash)
    ) {
        throw new PrivateReleaseError(
            "SESSION_CREATION_HASH_INVALID",
            "session creation-code hash is invalid",
        );
    }
    if (
        !HASH.test(String(evidence.session?.feePolicyDigest || ""))
        || zeroHash(evidence.session.feePolicyDigest)
    ) {
        throw new PrivateReleaseError(
            "FEE_POLICY_INVALID",
            "session fee policy digest is invalid",
        );
    }

    const services = object(evidence.services, "services");
    const servicePaths = {
        tickets: sameOriginPath(services.tickets, "ticket service path"),
        orders: sameOriginPath(services.orders, "order relay path"),
        routing: sameOriginPath(services.routing, "routing relay path"),
        sessions: sameOriginPath(services.sessions, "session relay path"),
    };
    requirePass(
        services.durableWorkerPassed,
        "DURABLE_WORKER_FAILED",
        "durable reveal worker did not pass",
    );

    const artifactInput = object(evidence.artifacts, "artifacts");
    const artifacts = Object.fromEntries(
        REQUIRED_ARTIFACTS.map((name) => [
            name,
            provingArtifact(artifactInput[name], `artifacts.${name}`),
        ]),
    );

    const sides = Object.fromEntries(SIDE_NAMES.map((side) => [side, verifySide(side, evidence)]));
    return {
        schemaVersion: "lattice.private-trading-client-gate.v2",
        verifiedAt: new Date().toISOString(),
        evidenceDigest: String(evidence.evidenceDigest || ""),
        addresses: Object.fromEntries(
            REQUIRED_ADDRESSES.map((name) => [name, addresses[name]]),
        ),
        runtimeCodeHashes: Object.fromEntries(
            REQUIRED_ADDRESSES.map((name) => [name, runtimeCodeHashes[name]]),
        ),
        services: servicePaths,
        artifacts,
        session: {
            creationCodeHash: String(evidence.session.creationCodeHash).toLowerCase(),
            feePolicyDigest: String(evidence.session.feePolicyDigest).toLowerCase(),
        },
        routing: {
            HBAR: {
                denomination: integer(routing.HBAR.denomination, "HBAR.denomination").toString(),
            },
            LPRC: {
                denomination: integer(routing.LPRC.denomination, "LPRC.denomination").toString(),
                atsCanaryEvidenceHash:
                    String(routing.LPRC.atsCanaryEvidenceHash).toLowerCase(),
            },
        },
        routingNotes: {
            HBAR: Number(integer(routing.HBAR.independentNotes, "HBAR.independentNotes")),
            LPRC: Number(integer(routing.LPRC.independentNotes, "LPRC.independentNotes")),
        },
        gasObserved: {
            buy: sides.buy.gas.privateWarm,
            sell: sides.sell.gas.privateWarm,
        },
        gasDirectObserved: {
            buy: sides.buy.gas.directWarm,
            sell: sides.sell.gas.directWarm,
        },
        gasTarget: {
            buy: sides.buy.gas.targetWarm,
            sell: sides.sell.gas.targetWarm,
        },
        gasCap: {
            buy: sides.buy.gas.capWarm,
            sell: sides.sell.gas.capWarm,
        },
        buyEnabled: true,
        sellEnabled: true,
        enabled: true,
        timedReleaseVerified: true,
        privacyCanaryPassed: true,
        rollbackCanaryPassed: true,
        quicknet: {
            chainHash: QUICKNET_CHAIN_HASH,
            publicKeyHash: quicknet.publicKeyHash,
        },
    };
}

async function main(argv) {
    if (argv.length !== 2 || argv[0] !== "--out") {
        throw new PrivateReleaseError(
            "USAGE",
            "usage: node tools/private-release.mjs evidence.json --out client-gate.json",
        );
    }
    const evidencePath = process.argv[2];
    const outputPath = argv[1];
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    const gate = verifyPrivateRelease(evidence);
    await writeFile(outputPath, `${JSON.stringify(gate, null, 2)}\n`, {mode: 0o600, flag: "wx"});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(3)).catch((error) => {
        process.stderr.write(`${error.code || "PRIVATE_RELEASE_FAILED"}: ${error.message}\n`);
        process.exitCode = 1;
    });
}
