import {createHash} from "node:crypto";
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";

import {
    AbiCoder,
    Interface,
    getAddress,
    id,
    keccak256,
    toUtf8Bytes,
} from "ethers";

import {
    QUICKNET_GROUP_HASH,
    QUICKNET_ORIGINS,
    QUICKNET_PUBLIC_KEY,
    QUICKNET_SCHEME,
    verifyQuicknetBeacon,
} from "../agent/runtime/drand-client.mjs";
import {
    GAS_GATES,
    PRIVATE_RELEASE_SCHEMA,
    QUICKNET_CHAIN_HASH,
    privateReleaseEvidenceDigest,
    verifyPrivateRelease,
} from "./private-release.mjs";

export const PRIVATE_CANARY_INPUT_SCHEMA = "lattice.private-trading-canary-input.v1";
export const PRIVATE_ATS_CANARY_SCHEMA = "lattice.private-trading-ats-canary.v1";

const CHAIN_ID = 296n;
const QUICKNET_GENESIS = 1_692_803_367n;
const QUICKNET_PERIOD = 3n;
const MAX_MEASUREMENT_WINDOW_SECONDS = 3_600n;
const HEDERA_TIMESTAMP_TOLERANCE = 2n;
const REVEAL_GUARD = 12n;
const RETRY_MARGIN = 60n;
const MINIMUM_NOTES = 8;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const TIMESTAMP_PATTERN = /^(0|[1-9][0-9]*)\.[0-9]{1,9}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TICKET_PATTERN = /^[0-9a-f]{64}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

const RELEASE_CONTRACTS = Object.freeze([
    "SessionAccountFactory",
    "DualRegistrationGate",
    "HbarRouter",
    "LprcRouter",
    "SessionRecoveryRouter",
]);
const RUNTIME_CONTRACTS = Object.freeze([
    ...RELEASE_CONTRACTS,
    "CanarySessionAccount",
    "SessionEligibilityVerifier",
    "SessionComplianceVerifier",
    "FixedWithdrawalVerifier",
    "FixedWithdrawalComplianceVerifier",
]);
const ARTIFACT_FILES = Object.freeze({
    CanarySessionAccount: "SessionAccount.sol/SessionAccount.json",
    SessionAccountFactory: "SessionAccountFactory.sol/SessionAccountFactory.json",
    DualRegistrationGate: "DualRegistrationGate.sol/DualRegistrationGate.json",
    HbarRouter: "HbarFixedDenominationRouter.sol/HbarFixedDenominationRouter.json",
    LprcRouter: "LprcFixedDenominationRouter.sol/LprcFixedDenominationRouter.json",
    SessionRecoveryRouter: "SessionRecoveryRouter.sol/SessionRecoveryRouter.json",
    SessionEligibilityVerifier: "SessionEligibilityVerifier.sol/SessionEligibilityVerifier.json",
    SessionComplianceVerifier: "SessionComplianceVerifier.sol/SessionComplianceVerifier.json",
    FixedWithdrawalVerifier: "FixedWithdrawalVerifier.sol/FixedWithdrawalVerifier.json",
    FixedWithdrawalComplianceVerifier:
        "FixedWithdrawalComplianceVerifier.sol/FixedWithdrawalComplianceVerifier.json",
});

const FACTORY = new Interface([
    "function deploy((address sessionSigner,address recoverySigner,address engine,address security,bytes32 partition,address router,bytes32 quicknetChainHash,uint64 generation,bytes32 feePolicyDigest) config,bytes32 salt) payable returns (address)",
    "event SessionAccountDeployed(address indexed account,bytes32 indexed salt)",
    "event VenueConfigApproval(bytes32 indexed configDigest,bool approved)",
]);
const GATE = new Interface([
    "function registerSession(address account,(uint256 encryptedCredential,uint256 tag,uint256 ephemeralX,uint256 ephemeralY) ciphertext,uint256[24] eligibilityProof,uint256[12] eligibilityPublicSignals,uint256[24] complianceProof,uint256[17] compliancePublicSignals)",
    "event SessionRegistered(address indexed account,address indexed sessionSigner,uint64 indexed rotationEpoch,bytes32 sessionSlot,uint64 viewKeyEpoch)",
    "event SessionComplianceRecord(address indexed account,bytes32 indexed sessionSlot,uint256 encryptedCredential,uint256 tag,uint256 ephemeralX,uint256 ephemeralY)",
]);
const REGISTRY = new Interface([
    "event Granted(address indexed account,uint64 indexed epoch,bytes32 nullifier)",
]);
const SESSION = new Interface([
    "function placeSealed(bytes32 commitment,bytes32 envelopeDigest,uint64 quicknetRound,bytes signature)",
    "function revealAuthorized(uint8 side,uint128 price,uint128 qty,bytes32 randomSalt,bytes32 envelopeDigest,uint64 quicknetRound) returns (bytes32)",
]);
const ENGINE = new Interface([
    "function commit(bytes32 id)",
    "function reveal(uint8 side,uint128 price,uint128 qty,bytes32 salt,uint256 backing)",
    "event Committed(bytes32 indexed id,address indexed committer)",
    "event Revealed(bytes32 indexed id,uint8 side,uint128 price,uint128 qty)",
    "event Settled(bytes32 indexed sellId,bytes32 indexed buyId,uint256 amount,uint256 cost)",
]);
const ROUTER = new Interface([
    "function deposit(uint256 commitment) payable returns (uint256)",
    "function withdraw(address recipient,(uint256 encryptedCommitment,uint256 tag,uint256 ephemeralX,uint256 ephemeralY) ciphertext,(uint256[24] withdrawalProof,uint256[8] withdrawalPublicSignals,uint256[24] complianceProof,uint256[14] compliancePublicSignals) bundle)",
    "event Deposited(uint256 indexed commitment,uint32 indexed leafIndex,uint256 indexed root,address depositor,address asset,uint256 denomination,uint64 acceptedAt)",
    "event Withdrawn(bytes32 indexed nullifier,address indexed recipient,uint256 indexed root,address asset,uint256 denomination)",
    "event RouterComplianceRecord(bytes32 indexed nullifier,address indexed recipient,uint64 indexed viewKeyEpoch,uint256 encryptedCommitment,uint256 tag,uint256 ephemeralX,uint256 ephemeralY)",
]);
const LPRC = new Interface([
    "function activateAtsCanary(bytes32 evidenceHash)",
    "event AtsCanaryActivated(bytes32 indexed evidenceHash)",
]);
const ATS = new Interface([
    "event CouponSet(bytes32 indexed corporateActionId,uint256 indexed couponId,address indexed operator,(uint256 recordDate,uint256 executionDate,uint256 startDate,uint256 endDate,uint256 fixingDate,uint256 rate,uint8 rateDecimals,uint8 rateStatus) coupon)",
    "event SnapshotTriggered(uint256 snapshotId,bytes metadata)",
]);
const ATS_HOLDS = new Interface([
    "function createHoldByPartition(bytes32 partition,(uint256 amount,uint256 expirationTimestamp,address escrow,address to,bytes data) hold) returns (bool success,uint256 holdId)",
    "function createHoldFromByPartition(bytes32 partition,address from,(uint256 amount,uint256 expirationTimestamp,address escrow,address to,bytes data) hold,bytes operatorData) returns (bool success,uint256 holdId)",
    "function executeHoldByPartition((bytes32 partition,address tokenHolder,uint256 holdId) id,address to,uint256 amount) returns (bool success,bytes32 partition)",
]);

const NULLIFIER_REPLAY_SELECTOR = id("NullifierAlreadySpent(bytes32)").slice(0, 10);
const TIMED_RELEASE_SELECTOR = id("TimedReleasePending(uint64)").slice(0, 10);
const ALREADY_REVEALED_SELECTOR = id("AlreadyRevealed(bytes32)").slice(0, 10);
const ORDER_DOMAIN = id("hedera2026.orderbook.v1");
const MAX_GAS_TOTAL = (1n << 64n) - 1n;
const abiCoder = AbiCoder.defaultAbiCoder();

export class PrivateCanaryError extends Error {
    constructor(code, message, section = null) {
        super(message);
        this.name = "PrivateCanaryError";
        this.code = code;
        this.section = section;
    }
}

function fail(code, message, section = null) {
    throw new PrivateCanaryError(code, message, section);
}

function object(value, label, code = "INPUT_INVALID") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        fail(code, `${label} must be an object`);
    }
    return value;
}

function list(value, label, minimum = 0) {
    if (!Array.isArray(value) || value.length < minimum) {
        fail("INPUT_INVALID", `${label} must contain at least ${minimum} entries`);
    }
    return value;
}

function integer(value, label) {
    const text = String(value ?? "");
    if (!DECIMAL_PATTERN.test(text)) {
        fail("INPUT_INVALID", `${label} must be a canonical nonnegative integer`);
    }
    return BigInt(text);
}

function positive(value, label) {
    const result = integer(value, label);
    if (result === 0n) fail("INPUT_INVALID", `${label} must be positive`);
    return result;
}

function hash(value, label) {
    const text = String(value ?? "").toLowerCase();
    if (!HASH_PATTERN.test(text)) fail("INPUT_INVALID", `${label} must be bytes32`);
    return text;
}

function hex(value, label) {
    const text = String(value ?? "");
    const normalized = text.startsWith("0x") ? text : `0x${text}`;
    if (!HEX_PATTERN.test(normalized) || normalized.length % 2 !== 0) {
        fail("INPUT_INVALID", `${label} must be even-length hex`);
    }
    return normalized.toLowerCase();
}

function address(value, label) {
    try {
        const result = getAddress(value).toLowerCase();
        if (!ADDRESS_PATTERN.test(result)) throw new Error();
        return result;
    } catch {
        fail("INPUT_INVALID", `${label} must be an EVM address`);
    }
}

function sameAddress(left, right) {
    return address(left, "address") === address(right, "address");
}

function timestamp(value, label) {
    const text = String(value ?? "");
    if (!TIMESTAMP_PATTERN.test(text)) {
        fail("RECEIPT_INVALID", `${label} has an invalid consensus timestamp`);
    }
    const [seconds, fraction] = text.split(".");
    return {
        raw: text,
        seconds: BigInt(seconds),
        nanos: BigInt(fraction.padEnd(9, "0")),
    };
}

function timestampKey(value) {
    const parsed = timestamp(value, "receipt");
    return parsed.seconds * 1_000_000_000n + parsed.nanos;
}

function absoluteDifference(left, right) {
    return left >= right ? left - right : right - left;
}

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) =>
            `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

export function privateAtsCanaryDigest(value) {
    const evidence = object(value, "ATS canary evidence");
    if (evidence.schemaVersion !== PRIVATE_ATS_CANARY_SCHEMA) {
        fail("ATS_EVIDENCE_INVALID", "ATS canary evidence schema is unsupported", "LPRC");
    }
    verifyAtsCanaryEvidence(evidence, new Map());
    return keccak256(toUtf8Bytes(canonical(evidence)));
}

function successful(result) {
    const status = String(result.status ?? "").toLowerCase();
    return result.result === "SUCCESS"
        && (status === "" || ["1", "0x1"].includes(status));
}

function reverted(result) {
    const status = String(result.status ?? "").toLowerCase();
    return result.result !== "SUCCESS"
        && status !== "1"
        && status !== "0x1";
}

function normalizeLog(value, label) {
    const log = object(value, label, "RECEIPT_INVALID");
    return {
        address: address(log.address, `${label}.address`),
        topics: list(log.topics, `${label}.topics`, 1).map((topic, index) =>
            hash(topic, `${label}.topics[${index}]`)),
        data: hex(log.data ?? "0x", `${label}.data`),
    };
}

function normalizeResult(value, label, registry) {
    const result = object(value, label, "RECEIPT_INVALID");
    const normalized = {
        hash: hash(result.hash, `${label}.hash`),
        address: address(result.address, `${label}.address`),
        from: address(result.from, `${label}.from`),
        result: String(result.result ?? ""),
        status: String(result.status ?? "").toLowerCase(),
        amount: integer(result.amount, `${label}.amount`),
        gasUsed: positive(result.gas_used, `${label}.gas_used`),
        blockNumber: Number(integer(result.block_number, `${label}.block_number`)),
        timestamp: timestamp(result.timestamp, `${label}.timestamp`),
        functionParameters: hex(
            result.function_parameters ?? "0x",
            `${label}.function_parameters`,
        ),
        callResult: hex(result.call_result ?? "0x", `${label}.call_result`),
        errorMessage: hex(result.error_message ?? "0x", `${label}.error_message`),
        logs: list(result.logs ?? [], `${label}.logs`).map((log, index) =>
            normalizeLog(log, `${label}.logs[${index}]`)),
        raw: result,
    };
    if (
        !Number.isSafeInteger(normalized.blockNumber)
        || normalized.blockNumber <= 0
        || normalized.amount < 0n
        || (!successful(result) && !reverted(result))
    ) {
        fail("RECEIPT_INVALID", `${label} is not a final EVM contract result`);
    }
    const prior = registry.get(normalized.hash);
    const fingerprint = canonical({
        address: normalized.address,
        from: normalized.from,
        result: normalized.result,
        status: normalized.status,
        amount: normalized.amount.toString(),
        gasUsed: normalized.gasUsed.toString(),
        blockNumber: normalized.blockNumber,
        timestamp: normalized.timestamp.raw,
        functionParameters: normalized.functionParameters,
        errorMessage: normalized.errorMessage,
        logs: normalized.logs,
    });
    if (prior !== undefined && prior !== fingerprint) {
        fail("RECEIPT_CONFLICT", `${label} conflicts with another copy of its transaction`);
    }
    registry.set(normalized.hash, fingerprint);
    return normalized;
}

function requireSuccess(result, label) {
    if (!successful(result.raw)) fail("RECEIPT_FAILED", `${label} did not succeed`);
}

function requireRevert(result, label, selector) {
    if (!reverted(result.raw)) fail("REFUSAL_MISSING", `${label} did not revert`);
    if (!result.errorMessage.startsWith(selector)) {
        fail("REFUSAL_REASON_INVALID", `${label} reverted for another reason`);
    }
}

function parseTransaction(iface, result, expected, label) {
    let parsed;
    try {
        parsed = iface.parseTransaction({data: result.functionParameters});
    } catch {
        parsed = null;
    }
    if (parsed?.name !== expected) {
        fail("CALLDATA_INVALID", `${label} is not ${expected}`);
    }
    return parsed;
}

function decodedEvents(iface, result, expected, expectedAddress) {
    const output = [];
    for (const log of result.logs) {
        if (expectedAddress && !sameAddress(log.address, expectedAddress)) continue;
        try {
            const parsed = iface.parseLog({topics: log.topics, data: log.data});
            if (parsed?.name === expected) output.push(parsed);
        } catch {
            continue;
        }
    }
    return output;
}

function oneEvent(iface, result, expected, expectedAddress, label) {
    const events = decodedEvents(iface, result, expected, expectedAddress);
    if (events.length !== 1) {
        fail("EVENT_INVALID", `${label} must contain exactly one ${expected} event`);
    }
    return events[0];
}

function endpointRuntime(value, expectedAddress, label) {
    const endpoint = object(value, label);
    const endpointAddress = address(
        endpoint.evm_address ?? endpoint.address,
        `${label}.evm_address`,
    );
    if (endpointAddress !== expectedAddress) {
        fail("RUNTIME_CONTEXT_MISMATCH", `${label} belongs to another address`);
    }
    if (endpoint.deleted !== false) {
        fail("RUNTIME_CODE_MISSING", `${label} is deleted or deletion is unproven`);
    }
    if (!/^\d+\.\d+\.\d+$/.test(String(endpoint.contract_id ?? ""))) {
        fail("RUNTIME_CONTEXT_MISMATCH", `${label} has no Hedera contract ID`);
    }
    const code = hex(endpoint.runtime_bytecode, `${label}.runtime_bytecode`);
    if (code === "0x") fail("RUNTIME_CODE_MISSING", `${label} has no runtime code`);
    return code;
}

function bytecodeObject(artifact, label) {
    const deployed = artifact?.deployedBytecode;
    const code = typeof deployed === "string" ? deployed : deployed?.object;
    const normalized = hex(code, `${label}.deployedBytecode`);
    if (normalized === "0x") fail("ARTIFACT_INVALID", `${label} has empty deployed bytecode`);
    return {
        code: normalized,
        immutableReferences:
            typeof deployed === "object" && deployed !== null
                ? deployed.immutableReferences ?? {}
                : {},
    };
}

function creationCodeHash(artifact, label) {
    const bytecode = artifact?.bytecode;
    const code = typeof bytecode === "string" ? bytecode : bytecode?.object;
    const normalized = hex(code, `${label}.bytecode`);
    if (normalized === "0x") {
        fail("ARTIFACT_INVALID", `${label} has empty creation bytecode`);
    }
    return keccak256(normalized);
}

function maskedBytecode(runtimeCode, artifact, label) {
    const template = bytecodeObject(artifact, label);
    const runtime = Buffer.from(runtimeCode.slice(2), "hex");
    const expected = Buffer.from(template.code.slice(2), "hex");
    if (runtime.length !== expected.length) {
        fail("RUNTIME_ARTIFACT_MISMATCH", `${label} runtime length differs from the artifact`);
    }
    for (const locations of Object.values(template.immutableReferences)) {
        for (const location of locations) {
            const start = Number(location.start);
            const length = Number(location.length);
            if (
                !Number.isSafeInteger(start)
                || !Number.isSafeInteger(length)
                || start < 0
                || length < 1
                || start + length > runtime.length
            ) {
                fail("ARTIFACT_INVALID", `${label} has an invalid immutable reference`);
            }
            runtime.fill(0, start, start + length);
            expected.fill(0, start, start + length);
        }
    }
    if (!runtime.equals(expected)) {
        fail("RUNTIME_ARTIFACT_MISMATCH", `${label} runtime differs outside immutables`);
    }
}

function verifySessionSurface(artifact) {
    const abi = list(artifact?.abi, "SessionAccount artifact ABI");
    const allowedWrites = new Set([
        "cancelAuthorized",
        "claimCoupon",
        "expire",
        "placeSealed",
        "recoverToRouter",
        "revealAuthorized",
        "sweepEngineCredit",
    ]);
    const observedWrites = new Set();
    for (const entry of abi) {
        if (entry.type === "fallback") {
            fail("SESSION_SURFACE_INVALID", "SessionAccount exposes a fallback function");
        }
        if (
            entry.type === "function"
            && !["view", "pure"].includes(entry.stateMutability)
        ) {
            if (!allowedWrites.has(entry.name)) {
                fail(
                    "SESSION_SURFACE_INVALID",
                    `SessionAccount exposes unexpected write function ${entry.name}`,
                );
            }
            observedWrites.add(entry.name);
        }
    }
    for (const name of allowedWrites) {
        if (!observedWrites.has(name)) {
            fail("SESSION_SURFACE_INVALID", `SessionAccount is missing write function ${name}`);
        }
    }
}

function verifyRuntime(input, artifacts) {
    const deployment = object(input.deployment, "deployment");
    if (deployment.candidateOnly !== true) {
        fail("DEPLOYMENT_INVALID", "deployment is not marked candidate-only");
    }
    if (integer(deployment.network?.chainId, "deployment.network.chainId") !== CHAIN_ID) {
        fail("CHAIN_INVALID", "deployment is not Hedera testnet");
    }
    const addresses = object(deployment.addresses, "deployment.addresses");
    const endpoints = object(deployment.contracts, "deployment.contracts");
    const normalizedAddresses = {};
    const runtimeCodeHashes = {};
    for (const name of RUNTIME_CONTRACTS) {
        const deployedAddress = address(addresses[name], `deployment.addresses.${name}`);
        const runtime = endpointRuntime(
            endpoints[name],
            deployedAddress,
            `deployment.contracts.${name}`,
        );
        const artifact = object(artifacts[name], `artifact ${name}`);
        maskedBytecode(runtime, artifact, name);
        normalizedAddresses[name] = deployedAddress;
        runtimeCodeHashes[name] = keccak256(runtime);
    }
    if (new Set(Object.values(normalizedAddresses)).size !== RUNTIME_CONTRACTS.length) {
        fail("DEPLOYMENT_INVALID", "private deployment reuses a contract address");
    }
    verifySessionSurface(artifacts.CanarySessionAccount);
    const sessionCreationCodeHash = creationCodeHash(
        artifacts.CanarySessionAccount,
        "CanarySessionAccount",
    );

    const context = object(deployment.context, "deployment.context");
    const poseidon = address(context.poseidon2, "deployment.context.poseidon2");
    const poseidonCode = endpointRuntime(
        deployment.poseidonContract,
        poseidon,
        "deployment.poseidonContract",
    );
    if (
        keccak256(poseidonCode)
        !== hash(context.poseidon2RuntimeCodeHash, "poseidon2RuntimeCodeHash")
    ) {
        fail("RUNTIME_HASH_MISMATCH", "Poseidon2 runtime hash does not match the deployment");
    }
    return {
        deployment,
        addresses: normalizedAddresses,
        runtimeCodeHashes,
        sessionCreationCodeHash,
        context: {
            engine: address(context.engine, "context.engine"),
            security: address(context.security, "context.security"),
            registry: address(context.registry, "context.registry"),
            poseidon,
            partition: hash(context.partition, "context.partition"),
            feePolicyDigest: hash(context.feePolicyDigest, "context.feePolicyDigest"),
            quicknetChainHash: hash(
                context.quicknetChainHash,
                "context.quicknetChainHash",
            ),
            generation: positive(context.generation, "context.generation"),
            activationEpoch: positive(
                context.activationEpoch,
                "context.activationEpoch",
            ),
            sessionRoot: positive(context.sessionRoot, "context.sessionRoot"),
            minTier: integer(context.minTier, "context.minTier"),
            jurisdictionMask: integer(
                context.jurisdictionMask,
                "context.jurisdictionMask",
            ),
            hbarDenomination: positive(
                context.hbarDenominationTinybar,
                "context.hbarDenominationTinybar",
            ),
            lprcDenomination: positive(
                context.lprcDenomination,
                "context.lprcDenomination",
            ),
            minimumWithdrawalDelay: positive(
                context.minimumWithdrawalDelay,
                "context.minimumWithdrawalDelay",
            ),
            maximumRootAge: positive(context.maximumRootAge, "context.maximumRootAge"),
            minimumRealNotes: Number(
                positive(context.minimumRealNotes, "context.minimumRealNotes"),
            ),
            viewKeyEpoch: integer(context.viewKeyEpoch, "context.viewKeyEpoch"),
            viewKeyX: integer(context.viewKeyX, "context.viewKeyX"),
            viewKeyY: integer(context.viewKeyY, "context.viewKeyY"),
            engineRevealDelay: positive(
                context.engineRevealDelay,
                "context.engineRevealDelay",
            ),
            engineRevealWindow: positive(
                context.engineRevealWindow,
                "context.engineRevealWindow",
            ),
        },
    };
}

function verifyFactory(runtime, input, resultRegistry) {
    const receipts = object(runtime.deployment.receipts, "deployment.receipts");
    const approval = normalizeResult(
        receipts.factoryApproval,
        "factory approval receipt",
        resultRegistry,
    );
    requireSuccess(approval, "factory approval receipt");
    const deployer = address(
        runtime.deployment.roles.deployer,
        "deployment.roles.deployer",
    );
    if (
        approval.address !== runtime.addresses.SessionAccountFactory
        || approval.from !== deployer
        || approval.amount !== 0n
    ) {
        fail("FACTORY_CONTEXT_MISMATCH", "factory approval targeted another contract");
    }
    const expectedDigest = keccak256(abiCoder.encode(
        ["address", "address", "bytes32", "address", "bytes32", "bytes32"],
        [
            runtime.context.engine,
            runtime.context.security,
            runtime.context.partition,
            runtime.addresses.SessionRecoveryRouter,
            runtime.context.quicknetChainHash,
            runtime.context.feePolicyDigest,
        ],
    ));
    const approvalEvent = oneEvent(
        FACTORY,
        approval,
        "VenueConfigApproval",
        runtime.addresses.SessionAccountFactory,
        "factory approval receipt",
    );
    if (
        String(approvalEvent.args.configDigest).toLowerCase() !== expectedDigest
        || approvalEvent.args.approved !== true
    ) {
        fail("FACTORY_APPROVAL_INVALID", "factory approved another venue configuration");
    }

    const deployed = normalizeResult(
        receipts.sessionDeployment,
        "session deployment receipt",
        resultRegistry,
    );
    requireSuccess(deployed, "session deployment receipt");
    if (
        deployed.address !== runtime.addresses.SessionAccountFactory
        || deployed.from !== deployer
        || deployed.amount !== 0n
    ) {
        fail("FACTORY_CONTEXT_MISMATCH", "session deployment targeted another factory");
    }
    const transaction = parseTransaction(
        FACTORY,
        deployed,
        "deploy",
        "session deployment receipt",
    );
    const config = transaction.args.config ?? transaction.args[0];
    const session = object(input.session, "session");
    const expected = {
        sessionSigner: address(session.sessionSigner, "session.sessionSigner"),
        recoverySigner: address(session.recoverySigner, "session.recoverySigner"),
    };
    const configChecks = [
        [config.sessionSigner ?? config[0], expected.sessionSigner],
        [config.recoverySigner ?? config[1], expected.recoverySigner],
        [config.engine ?? config[2], runtime.context.engine],
        [config.security ?? config[3], runtime.context.security],
        [config.router ?? config[5], runtime.addresses.SessionRecoveryRouter],
    ];
    for (const [actual, wanted] of configChecks) {
        if (!sameAddress(actual, wanted)) {
            fail("SESSION_CONTEXT_MISMATCH", "factory session configuration is mismatched");
        }
    }
    if (
        String(config.partition ?? config[4]).toLowerCase() !== runtime.context.partition
        || String(config.quicknetChainHash ?? config[6]).toLowerCase()
            !== runtime.context.quicknetChainHash
        || BigInt(config.generation ?? config[7]) !== runtime.context.generation
        || String(config.feePolicyDigest ?? config[8]).toLowerCase()
            !== runtime.context.feePolicyDigest
    ) {
        fail("SESSION_CONTEXT_MISMATCH", "factory session configuration is mismatched");
    }
    const event = oneEvent(
        FACTORY,
        deployed,
        "SessionAccountDeployed",
        runtime.addresses.SessionAccountFactory,
        "session deployment receipt",
    );
    if (!sameAddress(event.args.account, runtime.addresses.CanarySessionAccount)) {
        fail("SESSION_CANONICAL_INVALID", "factory deployed another session account");
    }
    return {
        sessionSigner: expected.sessionSigner,
        recoverySigner: expected.recoverySigner,
        venueConfigDigest: expectedDigest,
        approvalReceipt: approval,
        deploymentReceipt: deployed,
    };
}

function verifyRegistration(runtime, input, sessionState, resultRegistry) {
    const registration = normalizeResult(
        input.session.registrationReceipt,
        "session registration receipt",
        resultRegistry,
    );
    requireSuccess(registration, "session registration receipt");
    if (
        registration.address !== runtime.addresses.DualRegistrationGate
        || registration.from
            !== address(runtime.deployment.roles.relayer, "deployment.roles.relayer")
        || registration.amount !== 0n
    ) {
        fail("SESSION_REGISTRATION_INVALID", "registration targeted another gate");
    }
    const transaction = parseTransaction(
        GATE,
        registration,
        "registerSession",
        "session registration receipt",
    );
    if (!sameAddress(transaction.args.account ?? transaction.args[0],
        runtime.addresses.CanarySessionAccount)) {
        fail("SESSION_REGISTRATION_INVALID", "registration names another session");
    }
    const ciphertext = transaction.args.ciphertext ?? transaction.args[1];
    const eligibility = transaction.args.eligibilityPublicSignals ?? transaction.args[3];
    const complianceSignals =
        transaction.args.compliancePublicSignals ?? transaction.args[5];
    if (
        !Array.isArray(eligibility)
        || eligibility.length !== 12
        || !Array.isArray(complianceSignals)
        || complianceSignals.length !== 17
    ) {
        fail("SESSION_REGISTRATION_INVALID", "registration proof signals are unavailable");
    }
    const codeHash = BigInt(runtime.sessionCreationCodeHash);
    const expectedEligibility = [
        null,
        1n,
        null,
        runtime.context.sessionRoot,
        runtime.context.activationEpoch,
        BigInt(runtime.addresses.CanarySessionAccount),
        BigInt(sessionState.sessionSigner),
        BigInt(runtime.addresses.SessionAccountFactory),
        codeHash & ((1n << 128n) - 1n),
        codeHash >> 128n,
        runtime.context.minTier,
        runtime.context.jurisdictionMask,
    ];
    for (let index = 0; index < expectedEligibility.length; index += 1) {
        if (
            expectedEligibility[index] !== null
            && BigInt(eligibility[index]) !== expectedEligibility[index]
        ) {
            fail("SESSION_REGISTRATION_INVALID", "eligibility context is mismatched");
        }
    }
    const expectedCompliance = [
        BigInt(tupleValue(ciphertext, "encryptedCredential", 0)),
        BigInt(tupleValue(ciphertext, "tag", 1)),
        BigInt(tupleValue(ciphertext, "ephemeralX", 2)),
        BigInt(tupleValue(ciphertext, "ephemeralY", 3)),
        BigInt(eligibility[2]),
        runtime.context.sessionRoot,
        runtime.context.activationEpoch,
        BigInt(runtime.addresses.CanarySessionAccount),
        BigInt(sessionState.sessionSigner),
        BigInt(runtime.addresses.SessionAccountFactory),
        codeHash & ((1n << 128n) - 1n),
        codeHash >> 128n,
        runtime.context.minTier,
        runtime.context.jurisdictionMask,
        runtime.context.viewKeyEpoch,
        runtime.context.viewKeyX,
        runtime.context.viewKeyY,
    ];
    if (expectedCompliance.some((wanted, index) =>
        BigInt(complianceSignals[index]) !== wanted)) {
        fail("SESSION_REGISTRATION_INVALID", "compliance context is mismatched");
    }
    const registered = oneEvent(
        GATE,
        registration,
        "SessionRegistered",
        runtime.addresses.DualRegistrationGate,
        "session registration receipt",
    );
    const compliance = oneEvent(
        GATE,
        registration,
        "SessionComplianceRecord",
        runtime.addresses.DualRegistrationGate,
        "session registration receipt",
    );
    const grant = oneEvent(
        REGISTRY,
        registration,
        "Granted",
        runtime.context.registry,
        "session registration receipt",
    );
    const account = runtime.addresses.CanarySessionAccount;
    if (
        !sameAddress(registered.args.account, account)
        || !sameAddress(registered.args.sessionSigner, sessionState.sessionSigner)
        || !sameAddress(compliance.args.account, account)
        || !sameAddress(grant.args.account, account)
        || String(registered.args.sessionSlot).toLowerCase()
            !== String(compliance.args.sessionSlot).toLowerCase()
        || String(registered.args.sessionSlot).toLowerCase()
            !== String(grant.args.nullifier).toLowerCase()
        || BigInt(registered.args.sessionSlot) !== BigInt(eligibility[0])
        || BigInt(registered.args.rotationEpoch) !== runtime.context.activationEpoch
        || BigInt(grant.args.epoch) !== runtime.context.activationEpoch
        || BigInt(registered.args.viewKeyEpoch) !== runtime.context.viewKeyEpoch
    ) {
        fail("SESSION_REGISTRATION_INVALID", "session proof events do not agree");
    }
    return registration;
}

function tupleValue(tuple, name, index) {
    return tuple?.[name] ?? tuple?.[index];
}

function verifyAccounting(accounting, receipts, deposits, withdrawals, denomination, label) {
    const evidence = object(accounting, `${label}.accounting`);
    const before = object(evidence.before, `${label}.accounting.before`);
    const after = object(evidence.after, `${label}.accounting.after`);
    const beforeValues = {
        block: Number(integer(before.blockNumber, `${label}.before.blockNumber`)),
        deposited: integer(before.totalDeposited, `${label}.before.totalDeposited`),
        withdrawn: integer(before.totalWithdrawn, `${label}.before.totalWithdrawn`),
        balance: integer(before.assetBalance, `${label}.before.assetBalance`),
    };
    const afterValues = {
        block: Number(integer(after.blockNumber, `${label}.after.blockNumber`)),
        deposited: integer(after.totalDeposited, `${label}.after.totalDeposited`),
        withdrawn: integer(after.totalWithdrawn, `${label}.after.totalWithdrawn`),
        balance: integer(after.assetBalance, `${label}.after.assetBalance`),
    };
    const blocks = receipts.map((receipt) => receipt.blockNumber);
    if (
        !Number.isSafeInteger(beforeValues.block)
        || !Number.isSafeInteger(afterValues.block)
        || beforeValues.block >= Math.min(...blocks)
        || afterValues.block < Math.max(...blocks)
        || beforeValues.withdrawn > beforeValues.deposited
        || afterValues.withdrawn > afterValues.deposited
        || beforeValues.balance
            < beforeValues.deposited - beforeValues.withdrawn
        || afterValues.deposited
            !== beforeValues.deposited + BigInt(deposits) * denomination
        || afterValues.withdrawn
            !== beforeValues.withdrawn + BigInt(withdrawals) * denomination
        || afterValues.balance
            !== beforeValues.balance
                + BigInt(deposits - withdrawals) * denomination
        || afterValues.balance
            < afterValues.deposited - afterValues.withdrawn
    ) {
        fail("ROUTER_CONSERVATION_FAILED", `${label} accounting does not reconcile`, label);
    }
}

function verifyRoutingAsset(name, runtime, evidence, resultRegistry) {
    const label = `routing.${name}`;
    const pool = name === "HBAR"
        ? runtime.addresses.HbarRouter
        : runtime.addresses.LprcRouter;
    const asset = name === "HBAR"
        ? "0x0000000000000000000000000000000000000000"
        : runtime.context.security;
    const denomination = name === "HBAR"
        ? runtime.context.hbarDenomination
        : runtime.context.lprcDenomination;
    const deposits = list(evidence.deposits, `${label}.deposits`, MINIMUM_NOTES)
        .map((value, index) => normalizeResult(
            value,
            `${label}.deposits[${index}]`,
            resultRegistry,
        ));
    const depositEvents = [];
    for (const [index, receipt] of deposits.entries()) {
        requireSuccess(receipt, `${label}.deposits[${index}]`);
        if (
            receipt.address !== pool
            || receipt.amount !== (name === "HBAR" ? denomination : 0n)
        ) {
            fail("ROUTER_CONTEXT_MISMATCH", `${label} deposit targets another pool`, name);
        }
        const depositTx =
            parseTransaction(ROUTER, receipt, "deposit", `${label}.deposits[${index}]`);
        const event = oneEvent(
            ROUTER,
            receipt,
            "Deposited",
            pool,
            `${label}.deposits[${index}]`,
        );
        if (
            !sameAddress(event.args.depositor, receipt.from)
            || !sameAddress(event.args.asset, asset)
            || BigInt(event.args.denomination) !== denomination
            || BigInt(event.args.commitment)
                !== BigInt(depositTx.args.commitment ?? depositTx.args[0])
            || absoluteDifference(
                BigInt(event.args.acceptedAt),
                receipt.timestamp.seconds,
            ) > HEDERA_TIMESTAMP_TOLERANCE
        ) {
            fail("ROUTER_CONTEXT_MISMATCH", `${label} deposit event is mismatched`, name);
        }
        depositEvents.push(event);
    }
    const commitments = new Set(depositEvents.map((event) =>
        BigInt(event.args.commitment).toString()));
    const funders = new Set(depositEvents.map((event) =>
        address(event.args.depositor, `${label}.depositor`)));
    const leafIndexes = new Set(depositEvents.map((event) =>
        BigInt(event.args.leafIndex).toString()));
    const receiptHashes = new Set(deposits.map((receipt) => receipt.hash));
    if (
        commitments.size < MINIMUM_NOTES
        || funders.size < MINIMUM_NOTES
        || leafIndexes.size < MINIMUM_NOTES
        || receiptHashes.size < MINIMUM_NOTES
    ) {
        fail("ANONYMITY_THRESHOLD", `${name} needs eight notes from distinct funders`, name);
    }

    const withdrawal = normalizeResult(
        evidence.withdrawal,
        `${label}.withdrawal`,
        resultRegistry,
    );
    requireSuccess(withdrawal, `${label}.withdrawal`);
    if (withdrawal.address !== pool || withdrawal.amount !== 0n) {
        fail("ROUTER_CONTEXT_MISMATCH", `${label} withdrawal targets another pool`, name);
    }
    if (deposits.some((deposit) =>
        timestampKey(deposit.timestamp.raw) >= timestampKey(withdrawal.timestamp.raw))) {
        fail("ROUTER_CONTEXT_MISMATCH", `${label} notes were not funded before withdrawal`, name);
    }
    const withdrawalTx = parseTransaction(
        ROUTER,
        withdrawal,
        "withdraw",
        `${label}.withdrawal`,
    );
    const recipient = address(
        withdrawalTx.args.recipient ?? withdrawalTx.args[0],
        `${label}.recipient`,
    );
    if (recipient !== runtime.addresses.CanarySessionAccount) {
        fail("ROUTER_CONTEXT_MISMATCH", `${label} withdrawal names another session`, name);
    }
    const bundle = withdrawalTx.args.bundle ?? withdrawalTx.args[2];
    const withdrawalSignals = tupleValue(bundle, "withdrawalPublicSignals", 1);
    const complianceSignals = tupleValue(bundle, "compliancePublicSignals", 3);
    if (!Array.isArray(withdrawalSignals) || !Array.isArray(complianceSignals)) {
        fail("ROUTER_CONTEXT_MISMATCH", `${label} proof signals are unavailable`, name);
    }
    const expectedSignals = [
        [withdrawalSignals[2], null],
        [withdrawalSignals[3], BigInt(recipient)],
        [withdrawalSignals[4], BigInt(pool)],
        [withdrawalSignals[5], BigInt(asset)],
        [withdrawalSignals[6], denomination],
        [withdrawalSignals[7], CHAIN_ID],
        [complianceSignals[5], null],
        [complianceSignals[6], BigInt(recipient)],
        [complianceSignals[7], BigInt(pool)],
        [complianceSignals[8], BigInt(asset)],
        [complianceSignals[9], denomination],
        [complianceSignals[10], CHAIN_ID],
        [complianceSignals[11], runtime.context.viewKeyEpoch],
        [complianceSignals[12], runtime.context.viewKeyX],
        [complianceSignals[13], runtime.context.viewKeyY],
    ];
    if (expectedSignals.some(([actual, expected]) =>
        expected !== null && BigInt(actual) !== expected)) {
        fail("ROUTER_CONTEXT_MISMATCH", `${label} proof context is mismatched`, name);
    }
    const withdrawalEvent = oneEvent(
        ROUTER,
        withdrawal,
        "Withdrawn",
        pool,
        `${label}.withdrawal`,
    );
    if (
        !sameAddress(withdrawalEvent.args.recipient, recipient)
        || !sameAddress(withdrawalEvent.args.asset, asset)
        || BigInt(withdrawalEvent.args.denomination) !== denomination
        || BigInt(withdrawalEvent.args.nullifier) !== BigInt(withdrawalSignals[0])
    ) {
        fail("ROUTER_CONTEXT_MISMATCH", `${label} withdrawal event is mismatched`, name);
    }
    const root = BigInt(withdrawalEvent.args.root);
    const ciphertext = withdrawalTx.args.ciphertext ?? withdrawalTx.args[1];
    if (
        BigInt(withdrawalSignals[2]) !== root
        || BigInt(complianceSignals[5]) !== root
        || BigInt(withdrawalSignals[1]) !== BigInt(complianceSignals[4])
        || BigInt(tupleValue(ciphertext, "encryptedCommitment", 0))
            !== BigInt(complianceSignals[0])
        || BigInt(tupleValue(ciphertext, "tag", 1)) !== BigInt(complianceSignals[1])
        || BigInt(tupleValue(ciphertext, "ephemeralX", 2))
            !== BigInt(complianceSignals[2])
        || BigInt(tupleValue(ciphertext, "ephemeralY", 3))
            !== BigInt(complianceSignals[3])
    ) {
        fail("ROUTER_CONTEXT_MISMATCH", `${label} split proof is mismatched`, name);
    }
    const complianceRecord = oneEvent(
        ROUTER,
        withdrawal,
        "RouterComplianceRecord",
        pool,
        `${label}.withdrawal`,
    );
    if (
        String(complianceRecord.args.nullifier).toLowerCase()
            !== String(withdrawalEvent.args.nullifier).toLowerCase()
        || !sameAddress(complianceRecord.args.recipient, recipient)
        || BigInt(complianceRecord.args.viewKeyEpoch) !== runtime.context.viewKeyEpoch
        || BigInt(complianceRecord.args.encryptedCommitment)
            !== BigInt(complianceSignals[0])
        || BigInt(complianceRecord.args.tag) !== BigInt(complianceSignals[1])
        || BigInt(complianceRecord.args.ephemeralX) !== BigInt(complianceSignals[2])
        || BigInt(complianceRecord.args.ephemeralY) !== BigInt(complianceSignals[3])
    ) {
        fail("ROUTER_CONTEXT_MISMATCH", `${label} compliance event is mismatched`, name);
    }
    const rootDeposit = depositEvents.find((event) => BigInt(event.args.root) === root);
    if (!rootDeposit) {
        fail("ROUTER_CONTEXT_MISMATCH", `${label} withdrawal uses an unevidenced root`, name);
    }
    if (BigInt(rootDeposit.args.leafIndex) + 1n < BigInt(MINIMUM_NOTES)) {
        fail("ANONYMITY_THRESHOLD", `${label} withdrawal root predates eight notes`, name);
    }
    const acceptedAt = BigInt(rootDeposit.args.acceptedAt);
    if (
        withdrawal.timestamp.seconds + HEDERA_TIMESTAMP_TOLERANCE
            < acceptedAt + runtime.context.minimumWithdrawalDelay
        || withdrawal.timestamp.seconds
            > acceptedAt + runtime.context.maximumRootAge
                + HEDERA_TIMESTAMP_TOLERANCE
    ) {
        fail("ROUTER_DELAY_INVALID", `${label} withdrawal violated the root time bounds`, name);
    }

    const replay = normalizeResult(
        evidence.replay,
        `${label}.replay`,
        resultRegistry,
    );
    if (
        replay.address !== pool
        || replay.functionParameters !== withdrawal.functionParameters
        || replay.amount !== withdrawal.amount
        || timestampKey(replay.timestamp.raw) <= timestampKey(withdrawal.timestamp.raw)
    ) {
        fail("ROUTER_REPLAY_FAILED", `${label} replay is not the same later withdrawal`, name);
    }
    requireRevert(replay, `${label}.replay`, NULLIFIER_REPLAY_SELECTOR);
    if (
        replay.errorMessage.length < 74
        || BigInt(`0x${replay.errorMessage.slice(10, 74)}`)
            !== BigInt(withdrawalEvent.args.nullifier)
    ) {
        fail("ROUTER_REPLAY_FAILED", `${label} replay names another nullifier`, name);
    }
    verifyAccounting(
        evidence.accounting,
        [...deposits, withdrawal, replay],
        deposits.length,
        1,
        denomination,
        label,
    );
    return {
        independentNotes: commitments.size,
        independentFunders: funders.size,
        denomination: denomination.toString(),
        receipts: [...deposits, withdrawal, replay],
        lastDepositTimestamp: deposits.reduce(
            (latest, item) => latest > item.timestamp.seconds
                ? latest
                : item.timestamp.seconds,
            0n,
        ),
    };
}

function decodeFunctionResult(iface, name, result, label) {
    try {
        return iface.decodeFunctionResult(name, result.callResult);
    } catch {
        fail("ATS_EVIDENCE_INVALID", `${label} has invalid returned data`, "LPRC");
    }
}

function verifyAtsCanaryEvidence(value, resultRegistry) {
    const evidence = object(value, "ATS canary evidence");
    if (
        evidence.schemaVersion !== PRIVATE_ATS_CANARY_SCHEMA
        || integer(evidence.chainId, "ATS canary chainId") !== CHAIN_ID
    ) {
        fail("ATS_EVIDENCE_INVALID", "ATS canary evidence context is unsupported", "LPRC");
    }
    const security = address(evidence.security, "ATS canary security");
    const pool = address(evidence.pool, "ATS canary pool");
    const partition = hash(evidence.partition, "ATS canary partition");
    const source = address(evidence.source, "ATS canary source");
    const operator = address(evidence.operator, "ATS canary operator");
    const outboundHolder = address(
        evidence.outboundHolder,
        "ATS canary outboundHolder",
    );
    const outboundRecipient = address(
        evidence.outboundRecipient,
        "ATS canary outboundRecipient",
    );
    if (
        new Set([
            security,
            pool,
            source,
            operator,
            outboundHolder,
            outboundRecipient,
        ]).size !== 6
    ) {
        fail("ATS_EVIDENCE_INVALID", "ATS canary actors must be distinct", "LPRC");
    }
    const amount = positive(evidence.amount, "ATS canary amount");
    const holdFrom = normalizeResult(
        evidence.holdFromReceipt,
        "ATS hold-from receipt",
        resultRegistry,
    );
    const inboundExecution = normalizeResult(
        evidence.inboundExecutionReceipt,
        "ATS inbound execution receipt",
        resultRegistry,
    );
    const outboundHold = normalizeResult(
        evidence.outboundHoldReceipt,
        "ATS outbound hold receipt",
        resultRegistry,
    );
    const outboundExecution = normalizeResult(
        evidence.outboundExecutionReceipt,
        "ATS outbound execution receipt",
        resultRegistry,
    );
    const receipts = [
        holdFrom,
        inboundExecution,
        outboundHold,
        outboundExecution,
    ];
    for (const [index, result] of receipts.entries()) {
        requireSuccess(result, `ATS canary receipt ${index}`);
        if (result.address !== security || result.amount !== 0n) {
            fail("ATS_EVIDENCE_INVALID", "ATS canary targeted another token", "LPRC");
        }
    }
    if (
        new Set(receipts.map((result) => result.hash)).size !== receipts.length
        || timestampKey(holdFrom.timestamp.raw)
            >= timestampKey(inboundExecution.timestamp.raw)
        || timestampKey(outboundHold.timestamp.raw)
            >= timestampKey(outboundExecution.timestamp.raw)
    ) {
        fail("ATS_EVIDENCE_INVALID", "ATS canary receipts are repeated or unordered", "LPRC");
    }

    const holdFromTx = parseTransaction(
        ATS_HOLDS,
        holdFrom,
        "createHoldFromByPartition",
        "ATS hold-from receipt",
    );
    const inboundHold = holdFromTx.args.hold ?? holdFromTx.args[2];
    if (
        holdFrom.from !== operator
        || String(holdFromTx.args.partition ?? holdFromTx.args[0]).toLowerCase()
            !== partition
        || !sameAddress(holdFromTx.args.from ?? holdFromTx.args[1], source)
        || BigInt(tupleValue(inboundHold, "amount", 0)) !== amount
        || BigInt(tupleValue(inboundHold, "expirationTimestamp", 1))
            <= holdFrom.timestamp.seconds
        || !sameAddress(tupleValue(inboundHold, "escrow", 2), operator)
        || !sameAddress(tupleValue(inboundHold, "to", 3), pool)
    ) {
        fail("ATS_EVIDENCE_INVALID", "ATS hold-from context is mismatched", "LPRC");
    }
    const holdFromResult = decodeFunctionResult(
        ATS_HOLDS,
        "createHoldFromByPartition",
        holdFrom,
        "ATS hold-from receipt",
    );
    const inboundHoldId = BigInt(holdFromResult.holdId ?? holdFromResult[1]);
    if ((holdFromResult.success ?? holdFromResult[0]) !== true || inboundHoldId === 0n) {
        fail("ATS_EVIDENCE_INVALID", "ATS hold-from did not create a hold", "LPRC");
    }

    const inboundTx = parseTransaction(
        ATS_HOLDS,
        inboundExecution,
        "executeHoldByPartition",
        "ATS inbound execution receipt",
    );
    const inboundId = inboundTx.args.id ?? inboundTx.args[0];
    if (
        inboundExecution.from !== operator
        || String(tupleValue(inboundId, "partition", 0)).toLowerCase() !== partition
        || !sameAddress(tupleValue(inboundId, "tokenHolder", 1), source)
        || BigInt(tupleValue(inboundId, "holdId", 2)) !== inboundHoldId
        || !sameAddress(inboundTx.args.to ?? inboundTx.args[1], pool)
        || BigInt(inboundTx.args.amount ?? inboundTx.args[2]) !== amount
    ) {
        fail("ATS_EVIDENCE_INVALID", "ATS inbound execution is mismatched", "LPRC");
    }
    const inboundResult = decodeFunctionResult(
        ATS_HOLDS,
        "executeHoldByPartition",
        inboundExecution,
        "ATS inbound execution receipt",
    );
    if (
        (inboundResult.success ?? inboundResult[0]) !== true
        || String(inboundResult.partition ?? inboundResult[1]).toLowerCase()
            !== partition
    ) {
        fail("ATS_EVIDENCE_INVALID", "ATS inbound execution did not complete", "LPRC");
    }

    const outboundHoldTx = parseTransaction(
        ATS_HOLDS,
        outboundHold,
        "createHoldByPartition",
        "ATS outbound hold receipt",
    );
    const outboundTerms = outboundHoldTx.args.hold ?? outboundHoldTx.args[1];
    if (
        outboundHold.from !== outboundHolder
        || String(outboundHoldTx.args.partition ?? outboundHoldTx.args[0]).toLowerCase()
            !== partition
        || BigInt(tupleValue(outboundTerms, "amount", 0)) !== amount
        || BigInt(tupleValue(outboundTerms, "expirationTimestamp", 1))
            <= outboundHold.timestamp.seconds
        || !sameAddress(tupleValue(outboundTerms, "escrow", 2), outboundHolder)
        || !sameAddress(
            tupleValue(outboundTerms, "to", 3),
            outboundRecipient,
        )
    ) {
        fail("ATS_EVIDENCE_INVALID", "ATS outbound hold context is mismatched", "LPRC");
    }
    const outboundHoldResult = decodeFunctionResult(
        ATS_HOLDS,
        "createHoldByPartition",
        outboundHold,
        "ATS outbound hold receipt",
    );
    const outboundHoldId =
        BigInt(outboundHoldResult.holdId ?? outboundHoldResult[1]);
    if (
        (outboundHoldResult.success ?? outboundHoldResult[0]) !== true
        || outboundHoldId === 0n
    ) {
        fail("ATS_EVIDENCE_INVALID", "ATS outbound hold was not created", "LPRC");
    }

    const outboundTx = parseTransaction(
        ATS_HOLDS,
        outboundExecution,
        "executeHoldByPartition",
        "ATS outbound execution receipt",
    );
    const outboundId = outboundTx.args.id ?? outboundTx.args[0];
    if (
        outboundExecution.from !== outboundHolder
        || String(tupleValue(outboundId, "partition", 0)).toLowerCase() !== partition
        || !sameAddress(tupleValue(outboundId, "tokenHolder", 1), outboundHolder)
        || BigInt(tupleValue(outboundId, "holdId", 2)) !== outboundHoldId
        || !sameAddress(outboundTx.args.to ?? outboundTx.args[1], outboundRecipient)
        || BigInt(outboundTx.args.amount ?? outboundTx.args[2]) !== amount
    ) {
        fail("ATS_EVIDENCE_INVALID", "ATS outbound execution is mismatched", "LPRC");
    }
    const outboundResult = decodeFunctionResult(
        ATS_HOLDS,
        "executeHoldByPartition",
        outboundExecution,
        "ATS outbound execution receipt",
    );
    if (
        (outboundResult.success ?? outboundResult[0]) !== true
        || String(outboundResult.partition ?? outboundResult[1]).toLowerCase()
            !== partition
    ) {
        fail("ATS_EVIDENCE_INVALID", "ATS outbound execution did not complete", "LPRC");
    }
    return {
        security,
        pool,
        partition,
        receipts,
    };
}

function verifyLprcLifecycle(runtime, routing, evidence, resultRegistry) {
    const atsCanary = verifyAtsCanaryEvidence(
        evidence.atsCanaryEvidence,
        resultRegistry,
    );
    if (
        atsCanary.security !== runtime.context.security
        || atsCanary.pool !== runtime.addresses.LprcRouter
        || atsCanary.partition !== runtime.context.partition
    ) {
        fail("ATS_CANARY_INVALID", "ATS canary used another venue context", "LPRC");
    }
    const activation = normalizeResult(
        evidence.activationReceipt,
        "LPRC activation receipt",
        resultRegistry,
    );
    requireSuccess(activation, "LPRC activation receipt");
    if (
        activation.address !== runtime.addresses.LprcRouter
        || activation.from
            !== address(runtime.deployment.roles.admin, "deployment.roles.admin")
        || activation.amount !== 0n
        || atsCanary.receipts.some((result) =>
            timestampKey(result.timestamp.raw) >= timestampKey(activation.timestamp.raw))
    ) {
        fail("ATS_CANARY_INVALID", "LPRC activation targeted another router", "LPRC");
    }
    const activationTx = parseTransaction(
        LPRC,
        activation,
        "activateAtsCanary",
        "LPRC activation receipt",
    );
    const atsEvidenceHash = keccak256(
        toUtf8Bytes(canonical(evidence.atsCanaryEvidence)),
    );
    if (String(activationTx.args.evidenceHash ?? activationTx.args[0]).toLowerCase()
        !== atsEvidenceHash) {
        fail("ATS_CANARY_INVALID", "LPRC activation hash does not match its evidence", "LPRC");
    }
    const activated = oneEvent(
        LPRC,
        activation,
        "AtsCanaryActivated",
        runtime.addresses.LprcRouter,
        "LPRC activation receipt",
    );
    if (String(activated.args.evidenceHash).toLowerCase() !== atsEvidenceHash) {
        fail("ATS_CANARY_INVALID", "LPRC activation event hash is mismatched", "LPRC");
    }

    const coupon = object(evidence.coupon, "LPRC coupon evidence");
    const couponSet = normalizeResult(
        coupon.couponSetReceipt,
        "LPRC coupon-set receipt",
        resultRegistry,
    );
    const snapshot = normalizeResult(
        coupon.snapshotReceipt,
        "LPRC coupon snapshot receipt",
        resultRegistry,
    );
    requireSuccess(couponSet, "LPRC coupon-set receipt");
    requireSuccess(snapshot, "LPRC coupon snapshot receipt");
    const issuer = address(runtime.deployment.roles.issuer, "deployment.roles.issuer");
    if (
        couponSet.address !== runtime.context.security
        || snapshot.address !== runtime.context.security
        || couponSet.from !== issuer
        || snapshot.from !== issuer
        || couponSet.amount !== 0n
        || snapshot.amount !== 0n
        || timestampKey(couponSet.timestamp.raw) >= timestampKey(snapshot.timestamp.raw)
        || snapshot.timestamp.seconds < routing.lastDepositTimestamp
    ) {
        fail("LPRC_COUPON_INVALID", "LPRC coupon receipts have the wrong context", "LPRC");
    }
    const couponSetEvent = oneEvent(
        ATS,
        couponSet,
        "CouponSet",
        runtime.context.security,
        "LPRC coupon-set receipt",
    );
    const snapshotEvent = oneEvent(
        ATS,
        snapshot,
        "SnapshotTriggered",
        runtime.context.security,
        "LPRC coupon snapshot receipt",
    );
    const observation = object(coupon.observation, "LPRC coupon observation");
    const couponTerms = couponSetEvent.args.coupon;
    const recordDate = BigInt(tupleValue(couponTerms, "recordDate", 0));
    const executionDate = BigInt(tupleValue(couponTerms, "executionDate", 1));
    const startDate = BigInt(tupleValue(couponTerms, "startDate", 2));
    const endDate = BigInt(tupleValue(couponTerms, "endDate", 3));
    if (
        BigInt(couponSetEvent.args.corporateActionId) === 0n
        || BigInt(couponSetEvent.args.couponId) === 0n
        || recordDate + HEDERA_TIMESTAMP_TOLERANCE < routing.lastDepositTimestamp
        || snapshot.timestamp.seconds + HEDERA_TIMESTAMP_TOLERANCE < recordDate
        || executionDate < recordDate
        || endDate < startDate
        || BigInt(tupleValue(couponTerms, "rate", 5)) === 0n
        || !sameAddress(observation.holder, runtime.addresses.LprcRouter)
        || positive(observation.balanceAtRecord, "LPRC balanceAtRecord")
            < runtime.context.lprcDenomination
        || positive(observation.couponAmount, "LPRC couponAmount") < 1n
        || BigInt(observation.couponId) !== BigInt(couponSetEvent.args.couponId)
        || BigInt(observation.snapshotId) !== BigInt(snapshotEvent.args.snapshotId)
    ) {
        fail("LPRC_COUPON_INVALID", "LPRC coupon observation is mismatched", "LPRC");
    }
    return {
        atsEvidenceHash,
        receipts: [...atsCanary.receipts, activation, couponSet, snapshot],
    };
}

function quicknetReleaseTime(round) {
    if (round === 0n) fail("QUICKNET_INVALID", "Quicknet round must be positive");
    return QUICKNET_GENESIS + (round - 1n) * QUICKNET_PERIOD;
}

function wordsContainAddress(value, wallet) {
    const needle = wallet.slice(2).toLowerCase();
    return String(value ?? "").toLowerCase().replace(/^0x/, "").includes(needle);
}

function logsContainAddress(logs, wallet, filterAddress = null) {
    return logs
        .filter((log) => filterAddress === null || log.address === filterAddress)
        .some((log) =>
            log.topics.some((topic) => wordsContainAddress(topic, wallet))
            || wordsContainAddress(log.data, wallet));
}

function verifySettlement(result, side, orderId, runtime, wallet) {
    requireSuccess(result, `${side} settlement`);
    if (
        result.address !== runtime.context.engine
        || result.from === wallet
        || result.amount !== 0n
    ) {
        fail("PRIVACY_SETTLEMENT_FAILED", `${side} settlement has the wrong context`, side);
    }
    const settlements = decodedEvents(
        ENGINE,
        result,
        "Settled",
        runtime.context.engine,
    );
    const matched = settlements.some((event) => {
        const expected = side === "buy" ? event.args.buyId : event.args.sellId;
        return String(expected).toLowerCase() === orderId;
    });
    if (
        !matched
        || wordsContainAddress(result.functionParameters, wallet)
        || logsContainAddress(result.logs, wallet)
    ) {
        fail("PRIVACY_SETTLEMENT_FAILED", `${side} settlement identifies the wallet`, side);
    }
}

function verifyPrivatePath(
    side,
    kind,
    value,
    runtime,
    canary,
    beacons,
    resultRegistry,
) {
    const label = `${side}.${kind}`;
    const expectedSide = side === "buy" ? 0n : 1n;
    const place = normalizeResult(value.place, `${label}.place`, resultRegistry);
    const early = normalizeResult(value.earlyReveal, `${label}.earlyReveal`, resultRegistry);
    const reveal = normalizeResult(value.reveal, `${label}.reveal`, resultRegistry);
    const settlement = normalizeResult(
        value.settlement,
        `${label}.settlement`,
        resultRegistry,
    );
    for (const [name, receipt] of [["place", place], ["reveal", reveal]]) {
        requireSuccess(receipt, `${label}.${name}`);
        if (
            receipt.address !== runtime.addresses.CanarySessionAccount
            || receipt.from !== canary.relayer
            || receipt.amount !== 0n
        ) {
            fail("SESSION_CONTEXT_MISMATCH", `${label}.${name} has the wrong relayer context`);
        }
    }
    if (
        early.address !== runtime.addresses.CanarySessionAccount
        || early.from !== canary.relayer
        || early.amount !== 0n
    ) {
        fail("SESSION_CONTEXT_MISMATCH", `${label}.earlyReveal has the wrong context`);
    }
    requireRevert(early, `${label}.earlyReveal`, TIMED_RELEASE_SELECTOR);

    const placeTx = parseTransaction(SESSION, place, "placeSealed", `${label}.place`);
    const earlyTx = parseTransaction(
        SESSION,
        early,
        "revealAuthorized",
        `${label}.earlyReveal`,
    );
    const revealTx = parseTransaction(
        SESSION,
        reveal,
        "revealAuthorized",
        `${label}.reveal`,
    );
    if (early.functionParameters !== reveal.functionParameters) {
        fail("TIMED_RELEASE_INVALID", `${label} early and released calldata differ`);
    }
    if (BigInt(revealTx.args.side ?? revealTx.args[0]) !== expectedSide) {
        fail("ORDER_SIDE_INVALID", `${label} has the wrong side`, side);
    }
    const round = BigInt(revealTx.args.quicknetRound ?? revealTx.args[5]);
    if (
        BigInt(earlyTx.args.quicknetRound ?? earlyTx.args[5]) !== round
        || BigInt(placeTx.args.quicknetRound ?? placeTx.args[2]) !== round
        || String(placeTx.args.envelopeDigest ?? placeTx.args[1]).toLowerCase()
            !== String(revealTx.args.envelopeDigest ?? revealTx.args[4]).toLowerCase()
    ) {
        fail("ORDER_CONTEXT_INVALID", `${label} placement and reveal do not agree`, side);
    }
    if (!beacons.has(round.toString())) {
        fail("QUICKNET_BEACON_MISSING", `${label} has no verified target beacon`, side);
    }
    const releaseAt = quicknetReleaseTime(round);
    const placeTime = timestampKey(place.timestamp.raw);
    const earlyTime = timestampKey(early.timestamp.raw);
    const revealTime = timestampKey(reveal.timestamp.raw);
    const settlementTime = timestampKey(settlement.timestamp.raw);
    const earliestRelease =
        place.timestamp.seconds + canary.engineRevealDelay + REVEAL_GUARD;
    if (canary.engineRevealWindow < RETRY_MARGIN) {
        fail("TIMED_RELEASE_INVALID", `${label} engine reveal window is unsafe`);
    }
    const latestRelease = place.timestamp.seconds
        + canary.engineRevealDelay
        + canary.engineRevealWindow
        - RETRY_MARGIN;
    if (
        placeTime >= earlyTime
        || earlyTime >= revealTime
        || revealTime >= settlementTime
        || place.timestamp.seconds >= releaseAt
        || early.timestamp.seconds >= releaseAt
        || reveal.timestamp.seconds < releaseAt
        || releaseAt + HEDERA_TIMESTAMP_TOLERANCE < earliestRelease
        || releaseAt > latestRelease + HEDERA_TIMESTAMP_TOLERANCE
        || reveal.timestamp.seconds
            > place.timestamp.seconds
                + canary.engineRevealDelay
                + canary.engineRevealWindow
                + HEDERA_TIMESTAMP_TOLERANCE
    ) {
        fail("TIMED_RELEASE_INVALID", `${label} receipt timing is outside its release window`);
    }
    if (early.errorMessage.length < 10 + 64) {
        fail("TIMED_RELEASE_INVALID", `${label} early refusal has no encoded release time`);
    }
    const encodedRelease = BigInt(`0x${early.errorMessage.slice(10, 74)}`);
    if (encodedRelease !== releaseAt) {
        fail("TIMED_RELEASE_INVALID", `${label} early refusal names another release time`);
    }

    const commitment = String(placeTx.args.commitment ?? placeTx.args[0]).toLowerCase();
    const committed = oneEvent(
        ENGINE,
        place,
        "Committed",
        runtime.context.engine,
        `${label}.place`,
    );
    if (
        String(committed.args.id).toLowerCase() !== commitment
        || !sameAddress(
            committed.args.committer,
            runtime.addresses.CanarySessionAccount,
        )
    ) {
        fail("ORDER_CONTEXT_INVALID", `${label} commitment event is mismatched`, side);
    }
    const revealed = oneEvent(
        ENGINE,
        reveal,
        "Revealed",
        runtime.context.engine,
        `${label}.reveal`,
    );
    const orderId = String(revealed.args.id).toLowerCase();
    if (
        BigInt(orderId) === 0n
        || orderId !== commitment
        || BigInt(revealed.args.side) !== expectedSide
        || BigInt(revealed.args.price)
            !== BigInt(revealTx.args.price ?? revealTx.args[1])
        || BigInt(revealed.args.qty)
            !== BigInt(revealTx.args.qty ?? revealTx.args[2])
    ) {
        fail("ORDER_SIDE_INVALID", `${label} reveal event has the wrong side`, side);
    }
    verifySettlement(settlement, side, orderId, runtime, canary.wallet);
    if (
        [place, early, reveal].some((receipt) =>
            wordsContainAddress(receipt.functionParameters, canary.wallet))
    ) {
        fail("PRIVACY_CALLDATA_FAILED", `${label} calldata identifies the wallet`, side);
    }
    if (
        [place, reveal].some((receipt) =>
            logsContainAddress(receipt.logs, canary.wallet, runtime.context.engine))
    ) {
        fail("PRIVACY_ENGINE_FAILED", `${label} engine events identify the wallet`, side);
    }
    return {
        place,
        early,
        reveal,
        settlement,
        gasReceipts: [place, reveal],
        gasTotal: checkedGasTotal([place, reveal], label, side),
        orderId,
        round,
    };
}

function checkedGasTotal(receipts, label, side) {
    let total = 0n;
    for (const receipt of receipts) {
        total += receipt.gasUsed;
        if (total > MAX_GAS_TOTAL) {
            fail("GAS_CONTROL_MISMATCH", `${label} gas total overflows uint64`, side);
        }
    }
    return total;
}

function verifyDirectControl(side, kind, value, runtime, canary, resultRegistry) {
    const label = `${side}.direct${kind}`;
    const expectedSide = side === "buy" ? 0n : 1n;
    const path = object(value, label);
    const caller = side === "buy" ? canary.directBuyer : canary.directSeller;
    const commit = normalizeResult(path.commit, `${label}.commit`, resultRegistry);
    const reveal = normalizeResult(path.reveal, `${label}.reveal`, resultRegistry);
    const reservation = side === "sell"
        ? normalizeResult(path.reservation, `${label}.reservation`, resultRegistry)
        : null;
    const components = reservation === null
        ? [commit, reveal]
        : [reservation, commit, reveal];
    for (const [name, receipt] of [
        ["commit", commit],
        ["reveal", reveal],
        ...(reservation === null ? [] : [["reservation", reservation]]),
    ]) {
        requireSuccess(receipt, `${label}.${name}`);
        if (receipt.from !== caller) {
            fail("GAS_CONTROL_MISMATCH", `${label}.${name} has the wrong caller`, side);
        }
    }
    if (
        commit.address !== runtime.context.engine
        || reveal.address !== runtime.context.engine
        || commit.amount !== canary.engineCommitBond
    ) {
        fail("GAS_CONTROL_MISMATCH", `${label} has the wrong engine or bond`, side);
    }
    const commitTx = parseTransaction(ENGINE, commit, "commit", `${label}.commit`);
    const transaction = parseTransaction(ENGINE, reveal, "reveal", `${label}.reveal`);
    const price = BigInt(transaction.args.price ?? transaction.args[1]);
    const quantity = BigInt(transaction.args.qty ?? transaction.args[2]);
    const salt = String(transaction.args.salt ?? transaction.args[3]).toLowerCase();
    const backing = BigInt(transaction.args.backing ?? transaction.args[4]);
    const expectedAmount = side === "buy" ? price * quantity : 0n;
    const expectedOrderId = keccak256(abiCoder.encode(
        ["bytes32", "address", "uint8", "uint128", "uint128", "bytes32"],
        [ORDER_DOMAIN, caller, expectedSide, price, quantity, salt],
    )).toLowerCase();
    const committedId = String(commitTx.args.id ?? commitTx.args[0]).toLowerCase();
    if (
        BigInt(transaction.args.side ?? transaction.args[0]) !== expectedSide
        || reveal.amount !== expectedAmount
        || (side === "buy" ? backing !== 0n : backing === 0n)
        || committedId !== expectedOrderId
    ) {
        fail("GAS_CONTROL_MISMATCH", `${label} has the wrong side`, side);
    }
    const committed = oneEvent(
        ENGINE,
        commit,
        "Committed",
        runtime.context.engine,
        `${label}.commit`,
    );
    if (
        String(committed.args.id).toLowerCase() !== expectedOrderId
        || !sameAddress(committed.args.committer, caller)
    ) fail("GAS_CONTROL_MISMATCH", `${label} commitment identity is mismatched`, side);
    if (reservation !== null) {
        if (
            reservation.address !== runtime.context.security
            || reservation.amount !== 0n
            || timestampKey(reservation.timestamp.raw) >= timestampKey(commit.timestamp.raw)
            || timestampKey(commit.timestamp.raw) >= timestampKey(reveal.timestamp.raw)
        ) fail("GAS_CONTROL_MISMATCH", `${label} reservation context is mismatched`, side);
        const reservationTx = parseTransaction(
            ATS_HOLDS,
            reservation,
            "createHoldByPartition",
            `${label}.reservation`,
        );
        const partition = String(reservationTx.args.partition ?? reservationTx.args[0])
            .toLowerCase();
        const hold = reservationTx.args.hold ?? reservationTx.args[1];
        let returned;
        try {
            returned = ATS_HOLDS.decodeFunctionResult(
                "createHoldByPartition",
                reservation.callResult,
            );
        } catch {
            fail("GAS_CONTROL_MISMATCH", `${label} reservation result is invalid`, side);
        }
        if (
            partition !== runtime.context.partition
            || BigInt(tupleValue(hold, "amount", 0)) !== quantity
            || !sameAddress(tupleValue(hold, "escrow", 2), runtime.context.engine)
            || !sameAddress(tupleValue(hold, "to", 3), ZERO_ADDRESS)
            || String(tupleValue(hold, "data", 4)) !== "0x"
            || (returned.success ?? returned[0]) !== true
            || BigInt(returned.holdId ?? returned[1]) !== backing
        ) fail("GAS_CONTROL_MISMATCH", `${label} reservation does not back its order`, side);
    } else if (timestampKey(commit.timestamp.raw) >= timestampKey(reveal.timestamp.raw)) {
        fail("GAS_CONTROL_MISMATCH", `${label} reveal does not follow commit`, side);
    }
    const events = decodedEvents(ENGINE, reveal, "Revealed", runtime.context.engine);
    if (
        events.length !== 1
        || String(events[0].args.id).toLowerCase() !== expectedOrderId
        || BigInt(events[0].args.side) !== expectedSide
        || BigInt(events[0].args.price) !== price
        || BigInt(events[0].args.qty) !== quantity
    ) {
        fail("GAS_CONTROL_MISMATCH", `${label} lacks its reveal event`, side);
    }
    return {
        components: {commit, reveal, ...(reservation === null ? {} : {reservation})},
        receipts: components,
        gasTotal: checkedGasTotal(components, label, side),
        orderId: expectedOrderId,
    };
}

function verifyGasPeriod(side, evidence, samples) {
    const window = object(evidence.measurementWindow, `${side}.measurementWindow`);
    const startsAt = positive(window.startsAt, `${side}.measurementWindow.startsAt`);
    const endsAt = positive(window.endsAt, `${side}.measurementWindow.endsAt`);
    if (
        endsAt < startsAt
        || endsAt - startsAt > MAX_MEASUREMENT_WINDOW_SECONDS
        || samples.some((sample) =>
            sample.timestamp.seconds < startsAt || sample.timestamp.seconds > endsAt)
    ) {
        fail("GAS_CONTROL_MISMATCH", `${side} samples are not in one bounded period`, side);
    }
}

function verifyRollback(runtime, rollback, successfulSell, resultRegistry) {
    const failed = normalizeResult(
        rollback.failedReveal,
        "sell rollback receipt",
        resultRegistry,
    );
    if (
        failed.address !== runtime.addresses.CanarySessionAccount
        || failed.from !== successfulSell.reveal.from
        || failed.amount !== successfulSell.reveal.amount
        || failed.functionParameters !== successfulSell.reveal.functionParameters
        || failed.logs.length !== 0
        || timestampKey(failed.timestamp.raw)
            <= timestampKey(successfulSell.reveal.timestamp.raw)
    ) {
        fail("SELL_ROLLBACK_FAILED", "failed sell is not an exact reverted replay", "sell");
    }
    requireRevert(failed, "sell rollback receipt", ALREADY_REVEALED_SELECTOR);
    if (
        failed.errorMessage.length < 74
        || BigInt(`0x${failed.errorMessage.slice(10, 74)}`)
            !== BigInt(successfulSell.orderId)
    ) {
        fail("SELL_ROLLBACK_FAILED", "failed sell names another order", "sell");
    }
    const before = object(rollback.before, "sell rollback before snapshot");
    const after = object(rollback.after, "sell rollback after snapshot");
    const fields = [
        "sessionTokenBalance",
        "engineRevealedCount",
        "tokenTotalHolds",
        "nextHoldId",
    ];
    const beforeBlock = Number(integer(before.blockNumber, "rollback.before.blockNumber"));
    const afterBlock = Number(integer(after.blockNumber, "rollback.after.blockNumber"));
    if (
        beforeBlock !== failed.blockNumber - 1
        || afterBlock !== failed.blockNumber
    ) {
        fail("SELL_ROLLBACK_FAILED", "rollback snapshots do not bracket the failed sell", "sell");
    }
    for (const field of fields) {
        if (integer(before[field], `rollback.before.${field}`)
            !== integer(after[field], `rollback.after.${field}`)) {
            fail("SELL_ROLLBACK_FAILED", `sell rollback changed ${field}`, "sell");
        }
    }
    return failed;
}

function verifyQuicknet(service, requiredRounds) {
    const quicknet = object(service.quicknet, "service.quicknet");
    const info = object(quicknet.info, "service.quicknet.info");
    if (
        String(info.hash ?? "").toLowerCase().replace(/^0x/, "") !== QUICKNET_CHAIN_HASH
        || String(info.public_key ?? "").toLowerCase() !== QUICKNET_PUBLIC_KEY
        || String(info.groupHash ?? "").toLowerCase() !== QUICKNET_GROUP_HASH
        || String(info.schemeID ?? "") !== QUICKNET_SCHEME
        || Number(info.period) !== Number(QUICKNET_PERIOD)
        || Number(info.genesis_time) !== Number(QUICKNET_GENESIS)
    ) {
        fail("QUICKNET_INFO_INVALID", "Quicknet info is not the pinned chain");
    }
    const verified = new Map();
    for (const [index, beacon] of list(quicknet.beacons, "service.quicknet.beacons", 1).entries()) {
        const round = positive(beacon.round, `service.quicknet.beacons[${index}].round`);
        try {
            verifyQuicknetBeacon(beacon, round);
        } catch {
            fail("QUICKNET_BEACON_INVALID", `Quicknet beacon ${round} did not verify`);
        }
        verified.set(round.toString(), beacon);
    }
    for (const round of requiredRounds) {
        if (!verified.has(round.toString())) {
            fail("QUICKNET_BEACON_MISSING", `Quicknet round ${round} is unevidenced`);
        }
    }
    const attempts = list(
        quicknet.relayAttempts,
        "service.quicknet.relayAttempts",
        2,
    );
    const origins = new Set();
    let sawFailure = false;
    let sawSuccessAfterFailure = false;
    for (const attempt of attempts) {
        const row = object(attempt, "Quicknet relay attempt");
        let url;
        try {
            url = new URL(String(row.url ?? ""));
        } catch {
            fail("QUICKNET_RELAY_INVALID", "Quicknet relay attempt URL is invalid");
        }
        const origin = `${url.protocol}//${url.host}`;
        if (!QUICKNET_ORIGINS.includes(origin)) {
            fail("QUICKNET_RELAY_INVALID", "Quicknet relay attempt used an unpinned origin");
        }
        if (!url.pathname.includes(QUICKNET_CHAIN_HASH)) {
            fail("QUICKNET_RELAY_INVALID", "Quicknet relay attempt used another chain");
        }
        if (row.outcome === "FAILED") sawFailure = true;
        else if (row.outcome === "SUCCESS" && sawFailure) sawSuccessAfterFailure = true;
        else if (row.outcome !== "SUCCESS") {
            fail("QUICKNET_RELAY_INVALID", "Quicknet relay outcome is invalid");
        }
        origins.add(origin);
    }
    if (origins.size < 2 || !sawSuccessAfterFailure) {
        fail("QUICKNET_RELAY_INVALID", "Quicknet relay failover is not demonstrated");
    }
    const keyBytes = Buffer.from(QUICKNET_PUBLIC_KEY, "hex");
    return {
        verified,
        publicKeyHash: `0x${createHash("sha256").update(keyBytes).digest("hex")}`,
    };
}

function verifyCrashRecovery(service, revealHashes) {
    const evidence = object(service.crashRecovery, "service.crashRecovery");
    const before = object(evidence.before, "crashRecovery.before");
    const crash = object(evidence.crash, "crashRecovery.crash");
    const after = object(evidence.after, "crashRecovery.after");
    const ticketId = String(before.ticketId ?? "");
    const byteDigest = String(before.byteDigest ?? "");
    if (
        !TICKET_PATTERN.test(ticketId)
        || !DIGEST_PATTERN.test(byteDigest)
        || crash.ticketId !== ticketId
        || after.ticketId !== ticketId
        || crash.byteDigest !== byteDigest
        || after.byteDigest !== byteDigest
        || typeof before.instanceId !== "string"
        || before.instanceId.length < 8
        || typeof after.instanceId !== "string"
        || after.instanceId.length < 8
        || before.instanceId === after.instanceId
        || crash.instanceId !== before.instanceId
        || !["PLACED", "WAITING_BEACON", "DECRYPTING", "REVEALING",
            "BROADCAST_UNKNOWN"].includes(before.state)
        || crash.state !== before.state
        || crash.code !== "SIMULATED_CRASH"
        || after.state !== "REVEALED"
        || integer(crash.revision, "crashRecovery.crash.revision")
            !== integer(before.revision, "crashRecovery.before.revision")
        || integer(after.revision, "crashRecovery.after.revision")
            <= integer(before.revision, "crashRecovery.before.revision")
        || !revealHashes.has(hash(after.transactionHash, "crashRecovery.after.transactionHash"))
    ) {
        fail("CRASH_RECOVERY_INVALID", "durable crash recovery trace is inconsistent");
    }
}

function verifyRedactedLogs(service) {
    const capture = object(service.logCapture, "service.logCapture");
    const lines = list(capture.lines, "service.logCapture.lines", 3);
    const sentinels = list(capture.sentinels, "service.logCapture.sentinels", 3);
    const text = lines.map((line) => {
        if (typeof line !== "string") {
            fail("REDACTED_LOG_INVALID", "captured log lines must be strings");
        }
        return line;
    }).join("\n");
    if (
        !text.includes("SIMULATED_CRASH")
        || !text.includes("REVEALED")
        || Number(capture.lineCount) !== lines.length
        || new Set(sentinels.map((sentinel) => String(sentinel).toLowerCase())).size
            !== sentinels.length
    ) {
        fail("REDACTED_LOG_INVALID", "log capture does not cover crash recovery");
    }
    for (const sentinel of sentinels) {
        if (
            typeof sentinel !== "string"
            || sentinel.length < 16
            || text.toLowerCase().includes(sentinel.toLowerCase())
        ) {
            fail("REDACTED_LOG_INVALID", "a private sentinel leaked into captured logs");
        }
    }
}

function verifyCanaries(runtime, input, quicknet, resultRegistry) {
    const evidence = object(input.canaries, "canaries");
    const wallet = address(evidence.connectedWallet, "canaries.connectedWallet");
    const relayer = address(evidence.relayer, "canaries.relayer");
    const directBuyer = address(evidence.directBuyer, "canaries.directBuyer");
    const directSeller = address(evidence.directSeller, "canaries.directSeller");
    const engineCommitBond = positive(
        evidence.engineCommitBond,
        "canaries.engineCommitBond",
    );
    const sessionSigner = address(input.session.sessionSigner, "session.sessionSigner");
    const recoverySigner = address(input.session.recoverySigner, "session.recoverySigner");
    const governedRoles = [
        wallet,
        relayer,
        address(runtime.deployment.roles.deployer, "deployment.roles.deployer"),
        address(runtime.deployment.roles.admin, "deployment.roles.admin"),
        address(runtime.deployment.roles.issuer, "deployment.roles.issuer"),
        sessionSigner,
        recoverySigner,
        directBuyer,
        directSeller,
    ];
    if (
        new Set(governedRoles).size !== governedRoles.length
        || relayer !== address(runtime.deployment.roles.relayer, "deployment.roles.relayer")
    ) {
        fail("ROLE_SEPARATION_INVALID", "private trading roles are not distinct");
    }
    const engineRevealDelay = positive(
        evidence.engineRevealDelay,
        "canaries.engineRevealDelay",
    );
    const engineRevealWindow = positive(
        evidence.engineRevealWindow,
        "canaries.engineRevealWindow",
    );
    if (
        engineRevealDelay !== runtime.context.engineRevealDelay
        || engineRevealWindow !== runtime.context.engineRevealWindow
    ) {
        fail("SESSION_CONTEXT_MISMATCH", "canary engine timing differs from deployment");
    }
    const state = {
        wallet,
        relayer,
        directBuyer,
        directSeller,
        engineCommitBond,
        engineRevealDelay,
        engineRevealWindow,
    };

    const output = {};
    const requiredRounds = [];
    const revealHashes = new Set();
    const allOrderIds = new Set();
    const allGasSamples = [];
    for (const side of ["buy", "sell"]) {
        const sideEvidence = object(evidence[side], `canaries.${side}`);
        const fresh = verifyPrivatePath(
            side,
            "fresh",
            object(sideEvidence.fresh, `${side}.fresh`),
            runtime,
            state,
            quicknet.verified,
            resultRegistry,
        );
        const repeated = verifyPrivatePath(
            side,
            "repeated",
            object(sideEvidence.repeated, `${side}.repeated`),
            runtime,
            state,
            quicknet.verified,
            resultRegistry,
        );
        const directFresh = verifyDirectControl(
            side,
            "Fresh",
            sideEvidence.directFresh,
            runtime,
            state,
            resultRegistry,
        );
        const directRepeated = verifyDirectControl(
            side,
            "Repeated",
            sideEvidence.directRepeated,
            runtime,
            state,
            resultRegistry,
        );
        verifyGasPeriod(
            side,
            sideEvidence,
            [
                ...fresh.gasReceipts,
                ...repeated.gasReceipts,
                ...directFresh.receipts,
                ...directRepeated.receipts,
            ],
        );
        const samples = [
            ...fresh.gasReceipts,
            ...repeated.gasReceipts,
            ...directFresh.receipts,
            ...directRepeated.receipts,
        ];
        allGasSamples.push(...samples);
        const orderIds = [
            fresh.orderId,
            repeated.orderId,
            directFresh.orderId,
            directRepeated.orderId,
        ];
        if (
            new Set(samples.map((sample) => sample.hash)).size !== samples.length
            || new Set(orderIds).size !== orderIds.length
            || orderIds.some((orderId) => allOrderIds.has(orderId))
        ) {
            fail("GAS_CONTROL_MISMATCH", `${side} samples are not independent`, side);
        }
        orderIds.forEach((orderId) => allOrderIds.add(orderId));
        const gate = GAS_GATES[side];
        if (
            directFresh.gasTotal !== gate.direct
            || directRepeated.gasTotal !== gate.direct
        ) {
            fail("GAS_BASELINE_MISMATCH", `${side} direct controls miss the fixed baseline`, side);
        }
        if (fresh.gasTotal > gate.cap || repeated.gasTotal > gate.cap) {
            fail("GAS_HARD_CAP", `${side} private path exceeds its fixed cap`, side);
        }
        requiredRounds.push(fresh.round, repeated.round);
        revealHashes.add(fresh.reveal.hash);
        revealHashes.add(repeated.reveal.hash);
        output[side] = {
            paths: {fresh, repeated},
            gas: {
                directFresh: directFresh.gasTotal.toString(),
                directWarm: directRepeated.gasTotal.toString(),
                privateFresh: fresh.gasTotal.toString(),
                privateWarm: repeated.gasTotal.toString(),
                samePeriod: true,
            },
            excludedGas: {
                earlyRefusalFresh: fresh.early.gasUsed.toString(),
                earlyRefusalRepeated: repeated.early.gasUsed.toString(),
                settlementFresh: fresh.settlement.gasUsed.toString(),
                settlementRepeated: repeated.settlement.gasUsed.toString(),
            },
            excludedReceipts: {
                earlyRefusal: [fresh.early, repeated.early],
                settlement: [fresh.settlement, repeated.settlement],
            },
        };
    }
    const gasTimes = allGasSamples.map((sample) => sample.timestamp.seconds);
    if (new Set(allGasSamples.map((sample) => sample.hash)).size !== allGasSamples.length) {
        fail("GAS_CONTROL_MISMATCH", "BUY and SELL path components are duplicated");
    }
    const earliestGas = gasTimes.reduce((earliest, value) =>
        value < earliest ? value : earliest);
    const latestGas = gasTimes.reduce((latest, value) =>
        value > latest ? value : latest);
    if (latestGas - earliestGas > MAX_MEASUREMENT_WINDOW_SECONDS) {
        fail("GAS_CONTROL_MISMATCH", "BUY and SELL samples are not from one period");
    }
    for (const round of requiredRounds) {
        if (!quicknet.verified.has(round.toString())) {
            fail("QUICKNET_BEACON_MISSING", `Quicknet round ${round} is unevidenced`);
        }
    }
    const rollback = verifyRollback(
        runtime,
        object(evidence.sell.rollback, "canaries.sell.rollback"),
        output.sell.paths.repeated,
        resultRegistry,
    );
    output.sell.excludedGas.failedSellRollback = rollback.gasUsed.toString();
    output.sell.excludedReceipts.recovery = [rollback];
    verifyCrashRecovery(input.service, revealHashes);
    verifyRedactedLogs(input.service);
    return output;
}

export async function loadPrivateContractArtifacts(artifactRoot) {
    const root = path.resolve(artifactRoot);
    return Object.fromEntries(await Promise.all(
        Object.entries(ARTIFACT_FILES).map(async ([name, relative]) => {
            const file = path.join(root, relative);
            return [name, JSON.parse(await readFile(file, "utf8"))];
        }),
    ));
}

function excludedGasReport(receipts, label) {
    const unique = [...new Map(receipts.map((receipt) => [receipt.hash, receipt])).values()];
    return {
        total: checkedGasTotal(unique, `${label} excluded gas`, null).toString(),
        components: unique.map((receipt) => ({
            transactionHash: receipt.hash,
            gasUsed: receipt.gasUsed.toString(),
        })),
    };
}

export function buildPrivateCanaryEvidence(input, {contractArtifacts} = {}) {
    const evidence = object(input, "private canary input");
    if (evidence.schemaVersion !== PRIVATE_CANARY_INPUT_SCHEMA) {
        fail("SCHEMA_INVALID", "private canary input schema is unsupported");
    }
    const artifacts = object(contractArtifacts, "contract artifacts");
    const resultRegistry = new Map();
    const runtime = verifyRuntime(evidence, artifacts);
    if (runtime.context.quicknetChainHash.slice(2) !== QUICKNET_CHAIN_HASH) {
        fail("QUICKNET_INFO_INVALID", "deployment uses another Quicknet chain");
    }
    if (
        runtime.context.maximumRootAge <= runtime.context.minimumWithdrawalDelay
        || runtime.context.minimumRealNotes < MINIMUM_NOTES
    ) {
        fail("ROUTER_CONTEXT_MISMATCH", "deployment router timing or threshold is invalid");
    }
    const sessionState = verifyFactory(runtime, evidence, resultRegistry);
    const registrationReceipt =
        verifyRegistration(runtime, evidence, sessionState, resultRegistry);

    const routingInput = object(evidence.routing, "routing");
    const hbarRouting = verifyRoutingAsset(
        "HBAR",
        runtime,
        object(routingInput.HBAR, "routing.HBAR"),
        resultRegistry,
    );
    const lprcRouting = verifyRoutingAsset(
        "LPRC",
        runtime,
        object(routingInput.LPRC, "routing.LPRC"),
        resultRegistry,
    );
    const lifecycle = verifyLprcLifecycle(
        runtime,
        lprcRouting,
        object(evidence.lprcLifecycle, "lprcLifecycle"),
        resultRegistry,
    );

    const service = object(evidence.service, "service");
    const requiredRounds = ["buy", "sell"].flatMap((side) =>
        ["fresh", "repeated"].map((kind) =>
            BigInt(
                parseTransaction(
                    SESSION,
                    {
                        functionParameters: hex(
                            evidence.canaries?.[side]?.[kind]?.reveal
                                ?.function_parameters,
                            `${side}.${kind}.reveal.function_parameters`,
                        ),
                    },
                    "revealAuthorized",
                    `${side}.${kind}.reveal`,
                ).args[5],
            )),
    );
    const quicknet = verifyQuicknet(service, requiredRounds);
    const canaries = verifyCanaries(runtime, evidence, quicknet, resultRegistry);

    const output = {
        schemaVersion: PRIVATE_RELEASE_SCHEMA,
        candidateOnly: true,
        network: {
            chainId: Number(CHAIN_ID),
            receiptCount: resultRegistry.size,
        },
        addresses: Object.fromEntries(
            RELEASE_CONTRACTS.map((name) => [name, runtime.addresses[name]]),
        ),
        runtimeCodeHashes: Object.fromEntries(
            RELEASE_CONTRACTS.map((name) => [name, runtime.runtimeCodeHashes[name]]),
        ),
        quicknet: {
            chainHash: QUICKNET_CHAIN_HASH,
            publicKeyHash: quicknet.publicKeyHash,
            beaconVerified: true,
            preReleaseRefused: true,
            crashRecoveryPassed: true,
            redactedLogsPassed: true,
            multipleRelaysPassed: true,
        },
        routing: {
            HBAR: {
                independentNotes: hbarRouting.independentNotes,
                independentFunders: hbarRouting.independentFunders,
                denomination: hbarRouting.denomination,
                nullifierReplayRefused: true,
                conservationPassed: true,
            },
            LPRC: {
                independentNotes: lprcRouting.independentNotes,
                independentFunders: lprcRouting.independentFunders,
                denomination: lprcRouting.denomination,
                nullifierReplayRefused: true,
                conservationPassed: true,
                couponSnapshotPassed: true,
                corporateActionPassed: true,
                atsCanaryEvidenceHash: lifecycle.atsEvidenceHash,
            },
        },
        session: {
            canaryAccount: runtime.addresses.CanarySessionAccount,
            canaryRuntimeCodeHash: runtime.runtimeCodeHashes.CanarySessionAccount,
            canonicalFactoryPassed: true,
            restrictedSurfacePassed: true,
            holderSecretPassed: true,
            complianceMappingPassed: true,
            factoryVenueConfigApproved: true,
            eip712VectorPassed: true,
            relayerKeySeparated: true,
            creationCodeHash: runtime.sessionCreationCodeHash,
            feePolicyDigest: runtime.context.feePolicyDigest,
        },
        services: {
            tickets: service.paths?.tickets,
            orders: service.paths?.orders,
            routing: service.paths?.routing,
            sessions: service.paths?.sessions,
            durableWorkerPassed: true,
        },
        artifacts: evidence.provingArtifacts,
        gas: {
            buy: canaries.buy.gas,
            sell: canaries.sell.gas,
        },
        gasExcluded: {
            setup: excludedGasReport([
                sessionState.approvalReceipt,
                sessionState.deploymentReceipt,
                ...lifecycle.receipts,
            ], "setup"),
            routing: excludedGasReport([
                ...hbarRouting.receipts,
                ...lprcRouting.receipts,
            ], "routing"),
            rotation: excludedGasReport([registrationReceipt], "rotation"),
            recovery: excludedGasReport(
                canaries.sell.excludedReceipts.recovery,
                "recovery",
            ),
            earlyRefusal: excludedGasReport([
                ...canaries.buy.excludedReceipts.earlyRefusal,
                ...canaries.sell.excludedReceipts.earlyRefusal,
            ], "early refusal"),
            settlement: excludedGasReport([
                ...canaries.buy.excludedReceipts.settlement,
                ...canaries.sell.excludedReceipts.settlement,
            ], "settlement"),
        },
        canaries: {
            buy: {
                fresh: true,
                repeated: true,
                directControl: true,
                noWalletInCalldata: true,
                noWalletInEngineEvents: true,
                noWalletInSettlement: true,
            },
            sell: {
                fresh: true,
                repeated: true,
                directControl: true,
                noWalletInCalldata: true,
                noWalletInEngineEvents: true,
                noWalletInSettlement: true,
                atomicHoldRollback: true,
            },
        },
        provenance: {
            inputSchemaVersion: PRIVATE_CANARY_INPUT_SCHEMA,
            receiptDigest: `0x${createHash("sha256")
                .update(canonical([...resultRegistry.entries()].sort()))
                .digest("hex")}`,
            runtimeContractsChecked: RUNTIME_CONTRACTS.length,
            receiptCount: resultRegistry.size,
            gasSource: "mirror-node-contract-results",
            contractValueUnit: "tinybar",
            jsonRpcValueUnit: "weibar",
        },
    };
    output.evidenceDigest = privateReleaseEvidenceDigest(output);
    verifyPrivateRelease(output);
    return output;
}

async function main(argv) {
    if (argv.length === 2 && argv[0] === "--ats-digest") {
        const evidence = JSON.parse(await readFile(argv[1], "utf8"));
        process.stdout.write(`${privateAtsCanaryDigest(evidence)}\n`);
        return;
    }
    const outIndex = argv.indexOf("--out");
    const artifactIndex = argv.indexOf("--artifact-root");
    if (
        argv.length !== 5
        || outIndex !== 1
        || artifactIndex !== 3
        || !argv[0]
        || !argv[2]
        || !argv[4]
    ) {
        fail(
            "USAGE",
            "usage: node tools/private-canary-evidence.mjs input.json " +
                "--out candidate-evidence.json --artifact-root out",
        );
    }
    const [inputPath, , outputPath, , artifactRoot] = argv;
    const resolvedOutput = path.resolve(outputPath);
    const forbidden = path.resolve("deployments/private-trading-release.json");
    if (
        resolvedOutput === forbidden
        || !path.basename(resolvedOutput).toLowerCase().includes("candidate")
    ) {
        fail("OUTPUT_INVALID", "output must be a candidate evidence file");
    }
    const [input, contractArtifacts] = await Promise.all([
        readFile(inputPath, "utf8").then(JSON.parse),
        loadPrivateContractArtifacts(artifactRoot),
    ]);
    const result = buildPrivateCanaryEvidence(input, {contractArtifacts});
    await writeFile(resolvedOutput, `${JSON.stringify(result, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`${error.code || "PRIVATE_CANARY_FAILED"}: ${error.message}\n`);
        process.exitCode = 1;
    });
}
