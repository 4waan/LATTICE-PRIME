import {randomBytes, timingSafeEqual} from "node:crypto";
import {access, readFile, rename, writeFile} from "node:fs/promises";
import {constants as fsConstants} from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";

import {
    Contract,
    Interface,
    JsonRpcProvider,
    Wallet,
    getAddress,
    hexlify,
    keccak256,
} from "ethers";

import {
    QUICKNET_GROUP_HASH,
    QUICKNET_ORIGINS,
    QUICKNET_PUBLIC_KEY,
    QUICKNET_SCHEME,
    verifyQuicknetBeacon,
} from "../agent/runtime/drand-client.mjs";
import {
    QuicknetLockedKeyProvider,
} from "../agent/runtime/drand-client.mjs";
import {
    QUICKNET_CHAIN_HASH,
    TIMED_TICKET_GUARD_SECONDS,
    TIMED_TICKET_MARGIN_SECONDS,
    TIMED_TICKET_SIZE,
    assertSafeTargetRound,
    createTimedTicketEnvelope,
    generateTimedTicketCapability,
    selectSafeTargetRound,
} from "./timed-ticket.mjs";
import {
    PRIVATE_CANARY_INPUT_SCHEMA,
    buildPrivateCanaryEvidence,
    loadPrivateContractArtifacts,
} from "./private-canary-evidence.mjs";

export const PRIVATE_CANARY_RUN_SCHEMA = "lattice.private-trading-canary-run.v1";
export const PRIVATE_CANARY_ACKNOWLEDGEMENT =
    "EXECUTE PRIVATE TRADING TESTNET CANARY";
export const PRIVATE_CANARY_CHAIN_ID = 296n;
export const PRIVATE_CANARY_FINAL_RELEASE =
    "deployments/private-trading-release.json";

const WEIBAR_PER_TINYBAR = 10_000_000_000n;
const MINIMUM_NOTES = 8;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const INTEGER = /^(0|[1-9][0-9]*)$/;
const ORDER_KINDS = Object.freeze(["fresh", "repeated"]);
const SIDES = Object.freeze(["buy", "sell"]);
const RUNTIME_NAMES = Object.freeze([
    "SessionAccountFactory",
    "DualRegistrationGate",
    "SessionEligibilityVerifier",
    "SessionComplianceVerifier",
    "FixedWithdrawalVerifier",
    "FixedWithdrawalComplianceVerifier",
    "HbarRouter",
    "LprcRouter",
    "SessionRecoveryRouter",
    "CanarySessionAccount",
]);
const REQUIRED_ENVIRONMENT = Object.freeze([
    "HEDERA_TESTNET_RPC",
    "PRIVATE_TRADING_RELAYER_KEY",
    "PRIVATE_CANARY_SESSION_KEY",
    "PRIVATE_CANARY_RECOVERY_KEY",
    "PRIVATE_CANARY_DIRECT_BUY_KEY",
    "PRIVATE_CANARY_DIRECT_SELL_KEY",
    "PRIVATE_CANARY_SETTLER_KEY",
]);
const EXTERNAL_REQUIREMENTS = Object.freeze([
    "factory approval and factory-created session Mirror Node results",
    "dual session registration ZK proof result with exact public signals",
    "HBAR pool evidence for at least 8 notes from 8 distinct funded addresses",
    "LPRC pool evidence for at least 8 notes from 8 distinct funded addresses",
    "HBAR and LPRC withdrawal, pre-release refusal, and nullifier replay results",
    "LPRC ATS activation, hold execution, coupon, and snapshot evidence",
    "an external crash coordinator that watches the instruction file, crashes and restarts the worker during repeated BUY, then writes the requested evidence file",
    "redacted worker log capture with secret sentinels in the crash evidence file",
    "all four proving artifact descriptors and local artifact files",
    "current-epoch ZK KYC grants for both dedicated direct-control addresses",
]);

const SESSION_ABI = Object.freeze([
    "function sessionSigner() view returns (address)",
    "function recoverySigner() view returns (address)",
    "function engine() view returns (address)",
    "function security() view returns (address)",
    "function partition() view returns (bytes32)",
    "function router() view returns (address)",
    "function quicknetChainHash() view returns (bytes32)",
    "function generation() view returns (uint64)",
    "function feePolicyDigest() view returns (bytes32)",
    "function engineCommitBond() view returns (uint256)",
    "function engineRevealDelay() view returns (uint64)",
    "function engineRevealWindow() view returns (uint64)",
    "function engineRoundLength() view returns (uint64)",
    "function engineGenesis() view returns (uint64)",
    "function placeAuthorizationDigest(bytes32 commitment,bytes32 envelopeDigest,uint64 quicknetRound) view returns (bytes32)",
    "function placeSealed(bytes32 commitment,bytes32 envelopeDigest,uint64 quicknetRound,bytes signature)",
    "function revealAuthorized(uint8 side,uint128 price,uint128 qty,bytes32 randomSalt,bytes32 envelopeDigest,uint64 quicknetRound) returns (bytes32)",
]);
export const PRIVATE_CANARY_ENGINE_ABI = Object.freeze([
    "function commit(bytes32 id) payable",
    "function reveal(uint8 side,uint128 price,uint128 qty,bytes32 salt,uint256 backing) payable",
    "function commitmentOf(address committer,uint8 side,uint128 price,uint128 qty,bytes32 salt) pure returns (bytes32)",
    "function commitments(bytes32 id) view returns (address committer,uint64 committedAt,bool revealed,bool cancelled,uint256 bond)",
    "function commitBond() view returns (uint256)",
    "function currentRound() view returns (uint64)",
    "function roundEnd(uint64 round) view returns (uint64)",
    "function revealedCount() view returns (uint256)",
    "function crossRound(uint64 round)",
]);
const ENGINE_ABI = PRIVATE_CANARY_ENGINE_ABI;
const SECURITY_ABI = Object.freeze([
    "function balanceOfByPartition(bytes32 partition,address holder) view returns (uint256)",
    "function getHeldAmountForByPartition(bytes32 partition,address holder) view returns (uint256)",
    "function createHoldByPartition(bytes32 partition,(uint256 amount,uint256 expirationTimestamp,address escrow,address to,bytes data) hold) returns (bool success,uint256 holdId)",
]);
const REGISTRY_ABI = Object.freeze([
    "function getKycStatus(address account) view returns (uint8)",
]);
const SESSION_INTERFACE = new Interface(SESSION_ABI);
const ENGINE_INTERFACE = new Interface(ENGINE_ABI);
const SECURITY_INTERFACE = new Interface(SECURITY_ABI);
export const PRIVATE_CANARY_TRANSACTION_PLAN = Object.freeze({
    directCommits: 4,
    privatePlacements: 4,
    failedEarlyReveals: 4,
    automaticReveals: 4,
    directSellHolds: 2,
    directReveals: 4,
    failedSellRollback: 1,
    settlement: 1,
    total: 24,
});
export const PRIVATE_CANARY_PLACEMENT_SLIPPAGE_SECONDS = 30n;

export class PrivateCanaryRunnerError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "PrivateCanaryRunnerError";
        this.code = code;
    }
}

function fail(code, message) {
    throw new PrivateCanaryRunnerError(code, message);
}

function object(value, label) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        fail("INPUT_INVALID", `${label} must be an object`);
    }
    return value;
}

function address(value, label) {
    try {
        const result = getAddress(value).toLowerCase();
        if (!ADDRESS.test(result) || result === ZERO_ADDRESS) throw new Error();
        return result;
    } catch {
        fail("INPUT_INVALID", `${label} must be a nonzero EVM address`);
    }
}

function bytes32(value, label) {
    const result = String(value ?? "").toLowerCase();
    if (!HASH.test(result)) fail("INPUT_INVALID", `${label} must be bytes32`);
    return result;
}

function integer(value, label, {positive = false} = {}) {
    const text = String(value ?? "");
    if (!INTEGER.test(text)) fail("INPUT_INVALID", `${label} must be a canonical integer`);
    const result = BigInt(text);
    if (positive && result === 0n) fail("INPUT_INVALID", `${label} must be positive`);
    return result;
}

function privateKey(value, label) {
    if (typeof value !== "string" || !PRIVATE_KEY.test(value)) {
        fail("CREDENTIAL_REQUIRED", `${label} is missing or invalid`);
    }
    return value;
}

function sameAddress(left, right) {
    return String(left).toLowerCase() === String(right).toLowerCase();
}

function orderSpec(value, label) {
    const row = object(value, label);
    const keys = Object.keys(row).sort().join(",");
    if (keys !== "price,quantity") {
        fail("INPUT_INVALID", `${label} must contain only price and quantity`);
    }
    const price = integer(row.price, `${label}.price`, {positive: true});
    const quantity = integer(row.quantity, `${label}.quantity`, {positive: true});
    if (price >= 1n << 128n || quantity >= 1n << 128n) {
        fail("INPUT_INVALID", `${label} values exceed uint128`);
    }
    return Object.freeze({price, quantity});
}

function candidateContract(candidate, name) {
    const candidateAddress = address(candidate.addresses?.[name], `candidate ${name}`);
    const hash = bytes32(
        candidate.runtimeCodeHashes?.[name],
        `candidate ${name} runtime hash`,
    );
    return Object.freeze({address: candidateAddress, hash});
}

function requireExternalEvidence(base) {
    if (base.schemaVersion !== PRIVATE_CANARY_INPUT_SCHEMA) {
        fail("BASE_EVIDENCE_REQUIRED", "base evidence has the wrong schema");
    }
    for (const name of [
        "deployment",
        "session",
        "routing",
        "lprcLifecycle",
        "service",
        "provingArtifacts",
    ]) object(base[name], `base.${name}`);
    if (base.canaries !== undefined) {
        fail("BASE_EVIDENCE_INVALID", "base evidence must not contain caller-supplied canaries");
    }
    for (const asset of ["HBAR", "LPRC"]) {
        const routing = object(base.routing[asset], `base.routing.${asset}`);
        if (!Array.isArray(routing.deposits) || routing.deposits.length < MINIMUM_NOTES) {
            fail(
                "BASE_EVIDENCE_REQUIRED",
                `${asset} requires at least ${MINIMUM_NOTES} real deposit results`,
            );
        }
        const funders = new Set(routing.deposits.map((row) =>
            address(row.from, `${asset} deposit funder`)));
        if (funders.size < MINIMUM_NOTES) {
            fail(
                "BASE_EVIDENCE_REQUIRED",
                `${asset} requires ${MINIMUM_NOTES} distinct funding addresses`,
            );
        }
        object(routing.withdrawal, `${asset} withdrawal`);
        object(routing.preReleaseRefusal, `${asset} pre-release refusal`);
        object(routing.nullifierReplay, `${asset} nullifier replay`);
    }
    object(base.session.registrationReceipt, "session registration receipt");
    object(base.lprcLifecycle.activationReceipt, "LPRC activation receipt");
    object(base.lprcLifecycle.atsCanaryEvidence, "LPRC ATS canary evidence");
    object(base.lprcLifecycle.coupon, "LPRC coupon evidence");
    for (const name of [
        "sessionEligibility",
        "sessionCompliance",
        "routingWithdrawal",
        "routingCompliance",
    ]) object(base.provingArtifacts[name], `${name} proving artifacts`);
}

function requireCandidateEvidenceMatch(candidate, base) {
    const deployment = object(base.deployment, "base deployment");
    if (
        deployment.candidateOnly !== true
        || BigInt(deployment.network?.chainId ?? 0) !== PRIVATE_CANARY_CHAIN_ID
    ) fail("BASE_EVIDENCE_INVALID", "base deployment is not a chain 296 candidate");
    for (const name of RUNTIME_NAMES) {
        if (!sameAddress(
            address(deployment.addresses?.[name], `base deployment ${name}`),
            address(candidate.addresses?.[name], `candidate ${name}`),
        )) fail("BASE_EVIDENCE_INVALID", `base deployment ${name} does not match candidate`);
        const endpoint = object(
            deployment.contracts?.[name],
            `base deployment contract ${name}`,
        );
        const runtime = String(endpoint.runtime_bytecode ?? "");
        const observedHash = /^0x(?:[0-9a-fA-F]{2})+$/.test(runtime)
            ? keccak256(runtime).toLowerCase()
            : String(endpoint.runtimeCodeHash
                ?? deployment.runtimeCodeHashes?.[name] ?? "").toLowerCase();
        if (observedHash !== String(candidate.runtimeCodeHashes?.[name] ?? "").toLowerCase()) {
            fail("BASE_EVIDENCE_INVALID", `base deployment ${name} hash does not match candidate`);
        }
    }
    for (const role of ["deployer", "admin", "issuer", "relayer"]) {
        if (!sameAddress(
            address(deployment.roles?.[role], `base deployment ${role}`),
            address(candidate.roles?.[role], `candidate ${role}`),
        )) fail("BASE_EVIDENCE_INVALID", `base deployment ${role} does not match candidate`);
    }
    for (const name of [
        "engine",
        "security",
        "registry",
        "poseidon2",
    ]) {
        if (!sameAddress(
            address(deployment.context?.[name], `base deployment ${name}`),
            address(candidate.context?.[name], `candidate ${name}`),
        )) fail("BASE_EVIDENCE_INVALID", `base deployment ${name} does not match candidate`);
    }
    for (const name of [
        "partition",
        "feePolicyDigest",
        "quicknetChainHash",
    ]) {
        if (
            bytes32(deployment.context?.[name], `base deployment ${name}`)
            !== bytes32(candidate.context?.[name], `candidate ${name}`)
        ) fail("BASE_EVIDENCE_INVALID", `base deployment ${name} does not match candidate`);
    }
}

export function planPrivateCanaryRun({
    config,
    candidate,
    baseEvidence,
    env = process.env,
    mode = "plan",
}) {
    const input = object(config, "canary run config");
    if (input.schemaVersion !== PRIVATE_CANARY_RUN_SCHEMA) {
        fail("SCHEMA_INVALID", "canary run config schema is unsupported");
    }
    const deployment = object(candidate, "candidate deployment");
    if (
        deployment.candidateOnly !== true
        || BigInt(deployment.network?.chainId ?? 0) !== PRIVATE_CANARY_CHAIN_ID
    ) {
        fail("CANDIDATE_INVALID", "deployment is not a Hedera testnet candidate");
    }
    const contracts = Object.fromEntries(
        RUNTIME_NAMES.map((name) => [name, candidateContract(deployment, name)]),
    );
    requireExternalEvidence(baseEvidence);
    requireCandidateEvidenceMatch(deployment, baseEvidence);
    const orders = {};
    for (const side of SIDES) {
        const sideInput = object(input.orders?.[side], `orders.${side}`);
        orders[side] = Object.fromEntries(ORDER_KINDS.map((kind) => [
            kind,
            orderSpec(sideInput[kind], `orders.${side}.${kind}`),
        ]));
    }
    for (const kind of ORDER_KINDS) {
        if (
            orders.buy[kind].price !== orders.sell[kind].price
            || orders.buy[kind].quantity !== orders.sell[kind].quantity
        ) {
            fail(
                "INPUT_INVALID",
                `${kind} BUY and SELL must use the same price and quantity for settlement`,
            );
        }
    }
    const service = object(input.service, "service");
    let serviceUrl;
    try {
        serviceUrl = new URL(service.url);
    } catch {
        fail("INPUT_INVALID", "service.url must be an absolute URL");
    }
    const loopback = serviceUrl.hostname === "localhost"
        || /^127\./.test(serviceUrl.hostname)
        || serviceUrl.hostname === "[::1]";
    if (
        !["http:", "https:"].includes(serviceUrl.protocol)
        || (serviceUrl.protocol === "http:" && !loopback)
        || serviceUrl.search
        || serviceUrl.hash
    ) {
        fail("INPUT_INVALID", "service.url must be a plain HTTP or HTTPS origin");
    }
    const paths = object(baseEvidence.service.paths, "base service paths");
    for (const name of ["tickets", "orders"]) {
        if (!/^\/[A-Za-z0-9/_-]+$/.test(paths[name]) || paths[name].endsWith("/")) {
            fail("INPUT_INVALID", `service ${name} path is invalid`);
        }
    }
    for (const name of ["crashReadyFile", "crashInstructionFile", "crashEvidenceFile"]) {
        if (typeof service[name] !== "string" || !path.isAbsolute(service[name])) {
            fail("INPUT_INVALID", `service.${name} must be an absolute path`);
        }
        if (path.resolve(service[name]).endsWith(path.normalize(PRIVATE_CANARY_FINAL_RELEASE))) {
            fail("FINAL_RELEASE_REFUSED", "crash coordination must not use the release path");
        }
    }
    const connectedWallet = address(input.connectedWallet, "connected wallet");
    const minimumGasReserveWeibar = integer(
        input.minimumGasReserveWeibar,
        "minimumGasReserveWeibar",
        {positive: true},
    );
    const missingEnvironment = REQUIRED_ENVIRONMENT.filter((name) => !env[name]);
    if (mode === "run") {
        if (input.acknowledgement !== PRIVATE_CANARY_ACKNOWLEDGEMENT) {
            fail(
                "ACKNOWLEDGEMENT_REQUIRED",
                `set acknowledgement to "${PRIVATE_CANARY_ACKNOWLEDGEMENT}"`,
            );
        }
        if (missingEnvironment.length > 0) {
            fail(
                "CREDENTIAL_REQUIRED",
                `missing environment variables: ${missingEnvironment.join(", ")}`,
            );
        }
    }
    return Object.freeze({
        chainId: PRIVATE_CANARY_CHAIN_ID,
        candidateOnly: true,
        contracts,
        orders,
        service: Object.freeze({
            url: serviceUrl.origin,
            origin: String(service.origin ?? serviceUrl.origin),
            ticketsPath: paths.tickets,
            ordersPath: paths.orders,
            crashReadyFile: service.crashReadyFile,
            crashInstructionFile: service.crashInstructionFile,
            crashEvidenceFile: service.crashEvidenceFile,
        }),
        connectedWallet,
        minimumGasReserveWeibar,
        missingEnvironment,
        externalRequirements: EXTERNAL_REQUIREMENTS,
        transactionPlan: PRIVATE_CANARY_TRANSACTION_PLAN,
        transactionsPlanned: PRIVATE_CANARY_TRANSACTION_PLAN.total,
        writesFinalRelease: false,
    });
}

function roleWallets(plan, candidate, env, provider) {
    const entries = {
        relayer: ["PRIVATE_TRADING_RELAYER_KEY", candidate.roles?.relayer],
        session: ["PRIVATE_CANARY_SESSION_KEY", candidate.roles?.sessionSigner],
        recovery: ["PRIVATE_CANARY_RECOVERY_KEY", candidate.roles?.recoverySigner],
        directBuy: ["PRIVATE_CANARY_DIRECT_BUY_KEY", null],
        directSell: ["PRIVATE_CANARY_DIRECT_SELL_KEY", null],
        settler: ["PRIVATE_CANARY_SETTLER_KEY", null],
    };
    const wallets = Object.fromEntries(Object.entries(entries).map(([role, [name, expected]]) => {
        const wallet = new Wallet(privateKey(env[name], name), provider);
        const actual = wallet.address.toLowerCase();
        if (expected && !sameAddress(actual, address(expected, `candidate ${role}`))) {
            fail("ROLE_MISMATCH", `${name} does not match the candidate ${role} address`);
        }
        return [role, wallet];
    }));
    const addresses = Object.values(wallets).map((wallet) => wallet.address.toLowerCase());
    if (new Set(addresses).size !== addresses.length) {
        fail("ROLE_COLLISION", "all canary, session, recovery, relayer, and settler keys must differ");
    }
    const forbidden = [
        candidate.roles?.deployer,
        candidate.roles?.admin,
        candidate.roles?.issuer,
        candidate.context?.operator,
        candidate.context?.venueOperator,
        plan.connectedWallet,
    ].filter(Boolean).map((value) => address(value, "forbidden venue role"));
    for (const [role, wallet] of Object.entries(wallets)) {
        if (forbidden.some((value) => sameAddress(value, wallet.address))) {
            fail("ROLE_COLLISION", `${role} must not use an administrator, operator, or wallet key`);
        }
    }
    return wallets;
}

async function verifyRuntime(plan, provider) {
    for (const [name, contract] of Object.entries(plan.contracts)) {
        const code = await provider.getCode(contract.address);
        if (code === "0x" || keccak256(code).toLowerCase() !== contract.hash) {
            fail("RUNTIME_MISMATCH", `${name} runtime code does not match the candidate`);
        }
    }
}

async function verifyBaseMirrorEvidence(base, fetchMirror) {
    const results = [];
    const walk = (value) => {
        if (Array.isArray(value)) {
            for (const item of value) walk(item);
        } else if (value && typeof value === "object") {
            if (
                HASH.test(String(value.hash ?? ""))
                && typeof value.function_parameters === "string"
                && value.timestamp !== undefined
            ) results.push(value);
            for (const item of Object.values(value)) walk(item);
        }
    };
    walk(base);
    if (results.length < 20) {
        fail("BASE_EVIDENCE_REQUIRED", "base evidence lacks sufficient Mirror Node results");
    }
    for (const supplied of results) {
        const observed = await fetchMirror(supplied.hash);
        if (
            String(observed.hash).toLowerCase() !== String(supplied.hash).toLowerCase()
            || String(observed.function_parameters).toLowerCase()
                !== String(supplied.function_parameters).toLowerCase()
            || String(observed.result).toUpperCase() !== String(supplied.result).toUpperCase()
        ) {
            fail("MIRROR_EVIDENCE_MISMATCH", `base result ${supplied.hash} is not authentic`);
        }
    }
}

async function verifySession(plan, candidate, wallets, provider) {
    const session = new Contract(
        plan.contracts.CanarySessionAccount.address,
        SESSION_ABI,
        provider,
    );
    const values = await Promise.all([
        session.sessionSigner(),
        session.recoverySigner(),
        session.engine(),
        session.security(),
        session.partition(),
        session.router(),
        session.quicknetChainHash(),
        session.generation(),
        session.feePolicyDigest(),
        session.engineCommitBond(),
        session.engineRevealDelay(),
        session.engineRevealWindow(),
        session.engineRoundLength(),
        session.engineGenesis(),
    ]);
    const expected = candidate.context;
    const addressChecks = [
        [values[0], wallets.session.address, "session signer"],
        [values[1], wallets.recovery.address, "recovery signer"],
        [values[2], expected.engine, "engine"],
        [values[3], expected.security, "security"],
        [values[5], plan.contracts.SessionRecoveryRouter.address, "recovery router"],
    ];
    for (const [actual, wanted, label] of addressChecks) {
        if (!sameAddress(actual, wanted)) fail("SESSION_MISMATCH", `${label} mismatch`);
    }
    if (
        String(values[4]).toLowerCase() !== String(expected.partition).toLowerCase()
        || String(values[6]).toLowerCase() !== `0x${QUICKNET_CHAIN_HASH}`
        || values[7] !== BigInt(expected.generation)
        || String(values[8]).toLowerCase() !== String(expected.feePolicyDigest).toLowerCase()
    ) fail("SESSION_MISMATCH", "session context does not match the candidate");
    return Object.freeze({
        contract: session,
        engine: address(values[2], "session engine"),
        security: address(values[3], "session security"),
        registry: address(expected.registry, "candidate registry"),
        partition: bytes32(values[4], "session partition"),
        generation: values[7],
        feePolicyDigest: bytes32(values[8], "session fee policy"),
        commitBond: values[9],
        revealDelay: values[10],
        revealWindow: values[11],
        roundLength: values[12],
        genesis: values[13],
    });
}

export function assertDirectControlKycStatuses(statuses) {
    const values = object(statuses, "direct-control KYC statuses");
    for (const role of ["directBuy", "directSell"]) {
        if (BigInt(values[role] ?? 0) !== 1n) {
            fail(
                "DIRECT_KYC_REQUIRED",
                `${role} must have a current-epoch ZK KYC grant before any canary write`,
            );
        }
    }
}

async function verifyBalances(plan, sessionContext, wallets, provider) {
    const security = new Contract(sessionContext.security, SECURITY_ABI, provider);
    const registry = new Contract(sessionContext.registry, REGISTRY_ABI, provider);
    const privateBuyCost = ORDER_KINDS.reduce(
        (sum, kind) => sum
            + plan.orders.buy[kind].price * plan.orders.buy[kind].quantity,
        0n,
    );
    const directBuyCost = privateBuyCost;
    const privateSellQuantity = ORDER_KINDS.reduce(
        (sum, kind) => sum + plan.orders.sell[kind].quantity,
        0n,
    );
    const directSellQuantity = privateSellQuantity;
    const required = {
        session: (
            4n * sessionContext.commitBond + privateBuyCost
        ) * WEIBAR_PER_TINYBAR + plan.minimumGasReserveWeibar,
        relayer: plan.minimumGasReserveWeibar,
        directBuy: (
            2n * sessionContext.commitBond + directBuyCost
        ) * WEIBAR_PER_TINYBAR + plan.minimumGasReserveWeibar,
        directSell: (
            2n * sessionContext.commitBond
        ) * WEIBAR_PER_TINYBAR + plan.minimumGasReserveWeibar,
        settler: plan.minimumGasReserveWeibar,
    };
    const balances = await Promise.all([
        provider.getBalance(plan.contracts.CanarySessionAccount.address),
        provider.getBalance(wallets.relayer.address),
        provider.getBalance(wallets.directBuy.address),
        provider.getBalance(wallets.directSell.address),
        provider.getBalance(wallets.settler.address),
        security.balanceOfByPartition(
            sessionContext.partition,
            plan.contracts.CanarySessionAccount.address,
        ),
        security.balanceOfByPartition(sessionContext.partition, wallets.directSell.address),
        registry.getKycStatus(wallets.directBuy.address),
        registry.getKycStatus(wallets.directSell.address),
    ]);
    for (const [index, role] of ["session", "relayer", "directBuy", "directSell", "settler"].entries()) {
        if (balances[index] < required[role]) {
            fail("BALANCE_INADEQUATE", `${role} has inadequate HBAR for the fixed canary`);
        }
    }
    if (balances[5] < privateSellQuantity || balances[6] < directSellQuantity) {
        fail("BALANCE_INADEQUATE", "session or direct seller has inadequate free LPRC");
    }
    assertDirectControlKycStatuses({
        directBuy: balances[7],
        directSell: balances[8],
    });
    return security;
}

function resultHash(value, label) {
    const hash = String(value?.transactionHash ?? value?.txHash ?? "");
    if (!HASH.test(hash)) fail("SERVICE_RESULT_INVALID", `${label} lacks a transaction hash`);
    return hash.toLowerCase();
}

function serviceFetchOptions(plan, {
    capability,
    method = "GET",
    body,
    contentType,
}) {
    const headers = {
        authorization: `Bearer ${capability}`,
        "cache-control": "no-store",
        origin: plan.service.origin,
    };
    if (contentType) headers["content-type"] = contentType;
    return {
        method,
        headers,
        body,
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        redirect: "error",
    };
}

async function httpRequest(plan, requestPath, request, fetchImpl = fetch) {
    const response = await fetchImpl(
        `${plan.service.url}${requestPath}`,
        serviceFetchOptions(plan, request),
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true) {
        fail(
            "SERVICE_REQUEST_FAILED",
            `${method} ${requestPath} failed with ${response.status} `
                + `${payload?.error?.code ?? "UNKNOWN"}`,
        );
    }
    return payload.result;
}

export async function stagePrivateCanaryTicket({
    plan,
    capability,
    envelope,
    expected,
    fetchImpl = fetch,
}) {
    if (!(envelope instanceof Uint8Array) || envelope.byteLength !== TIMED_TICKET_SIZE) {
        fail("TICKET_CUSTODY_FAILED", "ticket upload must contain exactly 2048 bytes");
    }
    const uploaded = await httpRequest(plan, plan.service.ticketsPath, {
        capability,
        method: "POST",
        contentType: "application/octet-stream",
        body: envelope,
    }, fetchImpl);
    const byteDigest = String(uploaded?.byteDigest ?? "");
    if (
        !/^sha256:[0-9a-f]{64}$/.test(byteDigest)
        || String(uploaded.ticketId ?? "") !== expected.ticketId
        || String(uploaded.envelopeDigest ?? "").toLowerCase()
            !== expected.envelopeDigest.toLowerCase()
        || String(uploaded.engineCommitment ?? "").toLowerCase()
            !== expected.engineCommitment.toLowerCase()
        || String(uploaded.targetRound ?? "") !== String(expected.targetRound)
    ) fail("TICKET_CUSTODY_FAILED", "ticket upload response has mismatched custody context");
    const response = await fetchImpl(
        `${plan.service.url}${plan.service.ticketsPath}/${expected.ticketId}/envelope`,
        serviceFetchOptions(plan, {capability}),
    );
    if (!response.ok) {
        fail(
            "TICKET_CUSTODY_FAILED",
            `ticket readback failed with ${response.status}`,
        );
    }
    const readback = Buffer.from(await response.arrayBuffer());
    try {
        if (
            readback.byteLength !== TIMED_TICKET_SIZE
            || !timingSafeEqual(readback, Buffer.from(envelope))
        ) fail("TICKET_CUSTODY_FAILED", "ticket readback bytes differ from upload");
    } finally {
        readback.fill(0);
    }
    return Object.freeze({uploaded, byteDigest});
}

async function fixedTransaction(wallet, request, label) {
    const provider = wallet.provider;
    const fee = await provider.getFeeData();
    const gasPrice = fee.gasPrice ?? fee.maxFeePerGas;
    if (gasPrice === null) fail("RPC_FEE_UNAVAILABLE", `${label} gas price is unavailable`);
    const tx = await wallet.sendTransaction({
        ...request,
        type: 0,
        gasPrice,
    });
    try {
        const receipt = await tx.wait(1, 180_000);
        if (!receipt) fail("RECEIPT_TIMEOUT", `${label} receipt timed out`);
        return receipt;
    } catch (error) {
        if (error?.receipt) return error.receipt;
        throw error;
    }
}

async function waitUntil(timestamp, now = () => Math.floor(Date.now() / 1000)) {
    while (now() < Number(timestamp)) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
}

export function selectPrivateCanarySchedule({
    latestTimestamp,
    revealDelay,
    revealWindow,
}) {
    const latest = BigInt(latestTimestamp);
    if (
        BigInt(revealWindow)
        < TIMED_TICKET_MARGIN_SECONDS
            + TIMED_TICKET_GUARD_SECONDS
            + PRIVATE_CANARY_PLACEMENT_SLIPPAGE_SECONDS
    ) {
        fail(
            "PLACEMENT_SCHEDULE_INVALID",
            "engine reveal window lacks 30 seconds of conservative placement slack",
        );
    }
    const selected = selectSafeTargetRound({
        commitTime: latest + PRIVATE_CANARY_PLACEMENT_SLIPPAGE_SECONDS,
        revealDelay,
        revealWindow,
    });
    assertSafeTargetRound(selected.targetRound, {
        commitTime: latest,
        revealDelay,
        revealWindow,
    });
    assertSafeTargetRound(selected.targetRound, {
        commitTime: latest + PRIVATE_CANARY_PLACEMENT_SLIPPAGE_SECONDS,
        revealDelay,
        revealWindow,
    });
    return selected;
}

async function prepareTicket(plan, sessionContext, side, kind) {
    const spec = plan.orders[side][kind];
    const randomSalt = hexlify(randomBytes(32));
    const block = await sessionContext.contract.runner.getBlock("latest");
    const selected = selectPrivateCanarySchedule({
        latestTimestamp: BigInt(block.timestamp),
        revealDelay: sessionContext.revealDelay,
        revealWindow: sessionContext.revealWindow,
    });
    const made = await createTimedTicketEnvelope({
        engine: sessionContext.engine,
        sessionAccount: plan.contracts.CanarySessionAccount.address,
        targetRound: selected.targetRound,
        secret: {
            side: side === "buy" ? 0 : 1,
            price: spec.price,
            quantity: spec.quantity,
            randomSalt,
        },
        generation: sessionContext.generation,
        feePolicyDigest: sessionContext.feePolicyDigest,
        lockedKeyProvider: new QuicknetLockedKeyProvider(),
    });
    const capability = generateTimedTicketCapability();
    const id = made.envelopeId.slice(2).toLowerCase();
    let custody;
    try {
        custody = await stagePrivateCanaryTicket({
            plan,
            capability,
            envelope: made.envelope,
            expected: {
                ticketId: id,
                envelopeDigest: made.envelopeDigest,
                engineCommitment: made.engineCommitment,
                targetRound: made.targetRound,
            },
        });
    } finally {
        made.envelope.fill(0);
    }
    return {
        side,
        kind,
        spec,
        capability,
        id,
        commitment: made.engineCommitment,
        envelopeDigest: made.envelopeDigest,
        round: made.targetRound,
        releaseAt: made.targetTime,
        randomSalt,
        byteDigest: custody.byteDigest,
    };
}

async function placeTicket(plan, sessionContext, wallets, ticket) {
    const digest = await sessionContext.contract.placeAuthorizationDigest(
        ticket.commitment,
        ticket.envelopeDigest,
        ticket.round,
    );
    const signature = wallets.session.signingKey.sign(digest).serialized;
    const result = await httpRequest(
        plan,
        `${plan.service.ordersPath}/${ticket.id}/place`,
        {
            capability: ticket.capability,
            method: "POST",
            contentType: "application/json",
            body: JSON.stringify({
                commitment: ticket.commitment,
                envelopeDigest: ticket.envelopeDigest,
                feePolicyDigest: sessionContext.feePolicyDigest,
                generation: sessionContext.generation.toString(),
                quicknetRound: ticket.round.toString(),
                signature,
            }),
        },
    );
    return resultHash(result, `${ticket.side}.${ticket.kind} placement`);
}

async function verifyPlacementSchedule(provider, hash, ticket, sessionContext) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (!receipt || Number(receipt.status) !== 1) {
        fail("PLACEMENT_RECEIPT_INVALID", `${ticket.side}.${ticket.kind} placement is unconfirmed`);
    }
    const block = await provider.getBlock(receipt.blockNumber);
    if (!block) fail("PLACEMENT_RECEIPT_INVALID", "placement block is unavailable");
    try {
        return assertSafeTargetRound(ticket.round, {
            commitTime: BigInt(block.timestamp),
            revealDelay: sessionContext.revealDelay,
            revealWindow: sessionContext.revealWindow,
        });
    } catch {
        fail(
            "PLACEMENT_SCHEDULE_INVALID",
            `${ticket.side}.${ticket.kind} target is outside actual SessionAccount bounds`,
        );
    }
}

export function privateCanaryCrashInstruction(plan, ticket) {
    if (!/^sha256:[0-9a-f]{64}$/.test(String(ticket.byteDigest ?? ""))) {
        fail("TICKET_CUSTODY_FAILED", "crash instruction requires the returned byteDigest");
    }
    return Object.freeze({
        schemaVersion: "lattice.private-trading-crash-instruction.v1",
        chainId: Number(PRIVATE_CANARY_CHAIN_ID),
        candidateOnly: true,
        ticketId: ticket.id,
        byteDigest: ticket.byteDigest,
        requiredTransition: "DECRYPTING_TO_REVEALED_AFTER_PROCESS_RESTART",
        evidenceFile: plan.service.crashEvidenceFile,
        secretsIncluded: false,
    });
}

async function pollReleased(plan, ticket) {
    const deadline = Number(ticket.releaseAt + 180n) * 1_000;
    while (Date.now() < deadline) {
        const summary = await httpRequest(
            plan,
            `${plan.service.ticketsPath}/${ticket.id}`,
            {capability: ticket.capability},
        );
        if (summary.state === "REVEALED") {
            return resultHash(summary.broadcast, `${ticket.side}.${ticket.kind} reveal`);
        }
        if (["MISSED", "CANCELLED"].includes(summary.state)) {
            fail("AUTOMATION_FAILED", `${ticket.side}.${ticket.kind} became ${summary.state}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    fail("AUTOMATION_TIMEOUT", `${ticket.side}.${ticket.kind} was not revealed`);
}

function directSalt() {
    return hexlify(randomBytes(32));
}

async function directCommit(engine, wallet, side, spec, salt, bond) {
    const id = await engine.commitmentOf(
        wallet.address,
        side === "buy" ? 0 : 1,
        spec.price,
        spec.quantity,
        salt,
    );
    const receipt = await fixedTransaction(wallet, {
        to: await engine.getAddress(),
        data: ENGINE_INTERFACE.encodeFunctionData("commit", [id]),
        value: bond * WEIBAR_PER_TINYBAR,
        gasLimit: 250_000n,
    }, `${side} direct commit`);
    if (!receiptSucceeded(receipt)) fail("DIRECT_COMMIT_FAILED", `${side} direct commit failed`);
    return {id, commitHash: receipt.hash};
}

async function createDirectHold(security, engineAddress, wallet, partition, quantity, expiry) {
    const hold = [quantity, expiry, engineAddress, ZERO_ADDRESS, "0x"];
    const predicted = await security.connect(wallet).createHoldByPartition.staticCall(
        partition,
        hold,
    );
    if (predicted[0] !== true || predicted[1] === 0n) {
        fail("DIRECT_HOLD_FAILED", "direct SELL hold prediction failed");
    }
    const receipt = await fixedTransaction(wallet, {
        to: await security.getAddress(),
        data: SECURITY_INTERFACE.encodeFunctionData(
            "createHoldByPartition",
            [partition, hold],
        ),
        gasLimit: 500_000n,
    }, "direct SELL hold");
    if (Number(receipt.status) !== 1) fail("DIRECT_HOLD_FAILED", "direct SELL hold failed");
    return {holdId: predicted[1], reservationHash: receipt.hash};
}

function receiptSucceeded(receipt) {
    return Number(receipt.status) === 1;
}

async function fetchQuicknetEvidence(requiredRounds) {
    const chain = QUICKNET_CHAIN_HASH;
    const infoUrl = `${QUICKNET_ORIGINS[1]}/${chain}/info`;
    const infoResponse = await fetch(infoUrl);
    if (!infoResponse.ok) fail("QUICKNET_UNAVAILABLE", "pinned Quicknet info is unavailable");
    const info = await infoResponse.json();
    if (
        String(info.hash).toLowerCase() !== chain
        || String(info.public_key).toLowerCase() !== QUICKNET_PUBLIC_KEY
        || String(info.groupHash).toLowerCase() !== QUICKNET_GROUP_HASH
        || String(info.schemeID) !== QUICKNET_SCHEME
    ) fail("QUICKNET_MISMATCH", "Quicknet info does not match the pinned chain");
    const attempts = [];
    const beacons = [];
    for (const round of requiredRounds) {
        const primary = `${QUICKNET_ORIGINS[0]}/${chain}/public/${round}`;
        try {
            await fetch(primary, {signal: AbortSignal.timeout(1)});
            fail("QUICKNET_FAILOVER_NOT_EXERCISED", "primary Quicknet refusal did not occur");
        } catch (error) {
            if (error instanceof PrivateCanaryRunnerError) throw error;
            attempts.push({url: primary, outcome: "FAILED"});
        }
        const fallback = `${QUICKNET_ORIGINS[1]}/${chain}/public/${round}`;
        const response = await fetch(fallback);
        if (!response.ok) fail("QUICKNET_UNAVAILABLE", `Quicknet round ${round} is unavailable`);
        const beacon = await response.json();
        verifyQuicknetBeacon(beacon, BigInt(round));
        beacons.push(beacon);
        attempts.push({url: fallback, outcome: "SUCCESS"});
    }
    return {info, beacons, relayAttempts: attempts};
}

async function atomicWrite(file, value, {exclusive = false} = {}) {
    const resolved = path.resolve(file);
    if (resolved.endsWith(path.normalize(PRIVATE_CANARY_FINAL_RELEASE))) {
        fail("FINAL_RELEASE_REFUSED", "runner never writes the final release file");
    }
    const temporary = `${resolved}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
        flag: exclusive ? "wx" : "w",
    });
    await rename(temporary, resolved);
}

function mirrorClient(baseUrl) {
    const root = new URL(baseUrl);
    if (root.protocol !== "https:") fail("MIRROR_URL_INVALID", "Mirror Node URL must use HTTPS");
    return async (hash) => {
        const endpoint = new URL(`/api/v1/contracts/results/${hash}`, root);
        for (let attempt = 0; attempt < 60; attempt += 1) {
            const response = await fetch(endpoint);
            if (response.status === 404) {
                await new Promise((resolve) => setTimeout(resolve, 2_000));
                continue;
            }
            if (!response.ok) {
                fail("MIRROR_UNAVAILABLE", `Mirror Node returned ${response.status}`);
            }
            return response.json();
        }
        fail("MIRROR_TIMEOUT", `Mirror Node did not finalize ${hash}`);
    };
}

async function rollbackSnapshot(provider, security, sessionContext, sessionAddress, blockTag) {
    const engine = new Contract(sessionContext.engine, ENGINE_ABI, provider);
    const held = await security.getHeldAmountForByPartition(
        sessionContext.partition,
        sessionAddress,
        {blockTag},
    );
    const simulation = await provider.call({
        from: sessionAddress,
        to: sessionContext.security,
        blockTag,
        data: SECURITY_INTERFACE.encodeFunctionData("createHoldByPartition", [
            sessionContext.partition,
            [1n, BigInt(Math.floor(Date.now() / 1000) + 86_400), sessionContext.engine,
                ZERO_ADDRESS, "0x"],
        ]),
    });
    const next = SECURITY_INTERFACE.decodeFunctionResult(
        "createHoldByPartition",
        simulation,
    );
    return {
        blockNumber: blockTag,
        sessionTokenBalance: String(await security.balanceOfByPartition(
            sessionContext.partition,
            sessionAddress,
            {blockTag},
        )),
        engineRevealedCount: String(await engine.revealedCount({blockTag})),
        tokenTotalHolds: String(held),
        nextHoldId: String(next[1]),
    };
}

export async function runPrivateCanary({
    config,
    candidate,
    baseEvidence,
    outputInput,
    outputEvidence,
    artifactRoot,
    mirrorUrl = "https://testnet.mirrornode.hedera.com",
    env = process.env,
    dependencies = {},
}) {
    const plan = planPrivateCanaryRun({
        config,
        candidate,
        baseEvidence,
        env,
        mode: "run",
    });
    if (
        path.resolve(outputInput).endsWith(path.normalize(PRIVATE_CANARY_FINAL_RELEASE))
        || path.resolve(outputEvidence).endsWith(path.normalize(PRIVATE_CANARY_FINAL_RELEASE))
    ) fail("FINAL_RELEASE_REFUSED", "runner never writes the final release file");
    for (const file of [outputInput, outputEvidence]) {
        try {
            await access(file, fsConstants.F_OK);
            fail("OUTPUT_EXISTS", `refusing to overwrite ${file}`);
        } catch (error) {
            if (error instanceof PrivateCanaryRunnerError) throw error;
            if (error.code !== "ENOENT") throw error;
        }
    }
    let crashReady;
    try {
        crashReady = JSON.parse(await readFile(plan.service.crashReadyFile, "utf8"));
    } catch (error) {
        fail(
            "CRASH_COORDINATOR_REQUIRED",
            `crash coordinator readiness is unavailable: ${error.message}`,
        );
    }
    if (
        crashReady.schemaVersion !== "lattice.private-trading-crash-ready.v1"
        || crashReady.chainId !== Number(PRIVATE_CANARY_CHAIN_ID)
        || crashReady.ready !== true
        || !sameAddress(
            address(crashReady.sessionAccount, "crash coordinator session"),
            plan.contracts.CanarySessionAccount.address,
        )
    ) fail("CRASH_COORDINATOR_REQUIRED", "crash coordinator readiness is mismatched");
    for (const [label, file] of [
        ["crash instruction", plan.service.crashInstructionFile],
        ["crash evidence", plan.service.crashEvidenceFile],
    ]) {
        try {
            await access(file, fsConstants.F_OK);
            fail("OUTPUT_EXISTS", `${label} file already exists: ${file}`);
        } catch (error) {
            if (error instanceof PrivateCanaryRunnerError) throw error;
            if (error.code !== "ENOENT") throw error;
        }
        await access(path.dirname(file), fsConstants.W_OK);
    }
    const provider = dependencies.provider
        ?? new JsonRpcProvider(env.HEDERA_TESTNET_RPC, Number(PRIVATE_CANARY_CHAIN_ID), {
            staticNetwork: true,
        });
    const network = await provider.getNetwork();
    if (network.chainId !== PRIVATE_CANARY_CHAIN_ID) {
        fail("CHAIN_REFUSED", `refusing chain ${network.chainId}; expected 296`);
    }
    const fetchMirror = dependencies.fetchMirror ?? mirrorClient(mirrorUrl);
    const wallets = roleWallets(plan, candidate, env, provider);
    await verifyRuntime(plan, provider);
    const sessionContext = await verifySession(plan, candidate, wallets, provider);
    const security = await verifyBalances(plan, sessionContext, wallets, provider);
    await verifyBaseMirrorEvidence(baseEvidence, fetchMirror);
    const artifacts = await loadPrivateContractArtifacts(artifactRoot);

    const engine = new Contract(sessionContext.engine, ENGINE_ABI, provider);
    const tickets = [];
    const receiptHashes = {};
    for (const side of SIDES) {
        for (const kind of ORDER_KINDS) {
            const ticket = await prepareTicket(plan, sessionContext, side, kind);
            tickets.push(ticket);
            if (side === "buy" && kind === "repeated") {
                await atomicWrite(
                    plan.service.crashInstructionFile,
                    privateCanaryCrashInstruction(plan, ticket),
                    {exclusive: true},
                );
            }
            const label = `${ticket.side}.${ticket.kind}`;
            const placeHash = await placeTicket(plan, sessionContext, wallets, ticket);
            await verifyPlacementSchedule(provider, placeHash, ticket, sessionContext);
            const revealData = SESSION_INTERFACE.encodeFunctionData("revealAuthorized", [
                ticket.side === "buy" ? 0 : 1,
                ticket.spec.price,
                ticket.spec.quantity,
                ticket.randomSalt,
                ticket.envelopeDigest,
                ticket.round,
            ]);
            const early = await fixedTransaction(wallets.relayer, {
                to: plan.contracts.CanarySessionAccount.address,
                data: revealData,
                gasLimit: ticket.side === "buy" ? 384_666n : 828_046n,
            }, `${label} early reveal`);
            if (receiptSucceeded(early)) {
                fail("EARLY_REVEAL_ACCEPTED", `${label} revealed before Quicknet release`);
            }
            receiptHashes[label] = {
                place: placeHash,
                earlyReveal: early.hash,
                revealData,
            };
        }
    }
    const crashTicket = tickets.find((ticket) =>
        ticket.side === "buy" && ticket.kind === "repeated");
    const direct = {};
    for (const side of SIDES) {
        direct[side] = {};
        for (const kind of ORDER_KINDS) {
            const spec = plan.orders[side][kind];
            const salt = directSalt();
            const wallet = side === "buy" ? wallets.directBuy : wallets.directSell;
            let holdId = 0n;
            let reservationHash;
            if (side === "sell") {
                const round = await engine.currentRound();
                const expiry = await engine.roundEnd(round + 10n);
                const reserved = await createDirectHold(
                    security,
                    sessionContext.engine,
                    wallet,
                    sessionContext.partition,
                    spec.quantity,
                    expiry,
                );
                holdId = reserved.holdId;
                reservationHash = reserved.reservationHash;
            }
            const committed = await directCommit(
                engine,
                wallet,
                side,
                spec,
                salt,
                sessionContext.commitBond,
            );
            direct[side][kind] = {
                spec,
                salt,
                ...committed,
                wallet,
                holdId,
                reservationHash,
            };
        }
    }

    const latestRelease = tickets.reduce(
        (latest, ticket) => ticket.releaseAt > latest ? ticket.releaseAt : latest,
        0n,
    );
    await waitUntil(latestRelease);
    for (const ticket of tickets) {
        receiptHashes[`${ticket.side}.${ticket.kind}`].reveal =
            await pollReleased(plan, ticket);
    }

    for (const side of SIDES) {
        for (const kind of ORDER_KINDS) {
            const row = direct[side][kind];
            let backing = 0n;
            if (side === "sell") {
                if (row.holdId === 0n || !row.reservationHash) {
                    fail("DIRECT_HOLD_FAILED", `${side}.${kind} hold was missing before commit`);
                }
                backing = row.holdId;
            }
            const receipt = await fixedTransaction(row.wallet, {
                to: sessionContext.engine,
                data: ENGINE_INTERFACE.encodeFunctionData("reveal", [
                    side === "buy" ? 0 : 1,
                    row.spec.price,
                    row.spec.quantity,
                    row.salt,
                    backing,
                ]),
                value: side === "buy"
                    ? row.spec.price * row.spec.quantity * WEIBAR_PER_TINYBAR
                    : 0n,
                gasLimit: side === "buy" ? 384_666n : 828_046n,
            }, `${side}.${kind} direct reveal`);
            if (!receiptSucceeded(receipt)) {
                fail("DIRECT_CONTROL_FAILED", `${side}.${kind} direct reveal failed`);
            }
            row.revealHash = receipt.hash;
        }
    }

    const repeatedSell = receiptHashes["sell.repeated"];
    const failedSell = await fixedTransaction(wallets.relayer, {
        to: plan.contracts.CanarySessionAccount.address,
        data: repeatedSell.revealData,
        gasLimit: 828_046n,
    }, "failed private SELL replay");
    if (receiptSucceeded(failedSell)) {
        fail("ROLLBACK_REPLAY_ACCEPTED", "repeated private SELL replay did not revert");
    }
    const rollback = {
        failedReveal: await fetchMirror(failedSell.hash),
        before: await rollbackSnapshot(
            provider,
            security,
            sessionContext,
            plan.contracts.CanarySessionAccount.address,
            failedSell.blockNumber - 1,
        ),
        after: await rollbackSnapshot(
            provider,
            security,
            sessionContext,
            plan.contracts.CanarySessionAccount.address,
            failedSell.blockNumber,
        ),
    };

    const crossedRound = await engine.currentRound();
    const end = await engine.roundEnd(crossedRound);
    await waitUntil(end + 1n);
    const settlement = await fixedTransaction(wallets.settler, {
        to: sessionContext.engine,
        data: ENGINE_INTERFACE.encodeFunctionData("crossRound", [crossedRound]),
        gasLimit: 4_000_000n,
    }, "same-period settlement");
    if (!receiptSucceeded(settlement)) fail("SETTLEMENT_FAILED", "canary settlement failed");
    const settlementResult = await fetchMirror(settlement.hash);
    const quicknet = await fetchQuicknetEvidence(
        [...new Set(tickets.map((ticket) => ticket.round.toString()))],
    );

    const canaries = {
        connectedWallet: plan.connectedWallet,
        relayer: wallets.relayer.address.toLowerCase(),
        directBuyer: wallets.directBuy.address.toLowerCase(),
        directSeller: wallets.directSell.address.toLowerCase(),
        engineCommitBond: sessionContext.commitBond.toString(),
        engineRevealDelay: sessionContext.revealDelay.toString(),
        engineRevealWindow: sessionContext.revealWindow.toString(),
    };
    for (const side of SIDES) {
        const results = {};
        for (const kind of ORDER_KINDS) {
            const hashes = receiptHashes[`${side}.${kind}`];
            results[kind] = {
                place: await fetchMirror(hashes.place),
                earlyReveal: await fetchMirror(hashes.earlyReveal),
                reveal: await fetchMirror(hashes.reveal),
                settlement: settlementResult,
            };
            const directRow = direct[side][kind];
            results[`direct${kind[0].toUpperCase()}${kind.slice(1)}`] = {
                commit: await fetchMirror(directRow.commitHash),
                ...(side === "sell"
                    ? {reservation: await fetchMirror(directRow.reservationHash)}
                    : {}),
                reveal: await fetchMirror(directRow.revealHash),
            };
        }
        const timestamps = [
            results.fresh.place,
            results.fresh.reveal,
            results.repeated.place,
            results.repeated.reveal,
            ...Object.values(results.directFresh),
            ...Object.values(results.directRepeated),
        ].map((row) => String(row.timestamp).split(".")[0]);
        results.measurementWindow = {
            startsAt: timestamps.reduce((left, right) =>
                BigInt(left) < BigInt(right) ? left : right),
            endsAt: timestamps.reduce((left, right) =>
                BigInt(left) > BigInt(right) ? left : right),
        };
        if (side === "sell") results.rollback = rollback;
        canaries[side] = results;
    }

    const input = structuredClone(baseEvidence);
    input.canaries = canaries;
    input.service.quicknet = quicknet;
    let crashEvidence;
    try {
        crashEvidence = JSON.parse(await readFile(plan.service.crashEvidenceFile, "utf8"));
    } catch (error) {
        fail(
            "CRASH_EVIDENCE_REQUIRED",
            `external crash coordinator did not write valid evidence: ${error.message}`,
        );
    }
    const crashRecovery = object(crashEvidence.crashRecovery, "crash recovery evidence");
    const logCapture = object(crashEvidence.logCapture, "crash log capture");
    const crashHash = String(crashRecovery.after?.transactionHash ?? "");
    if (crashHash.toLowerCase() !== receiptHashes["buy.repeated"].reveal) {
        fail(
            "CRASH_EVIDENCE_MISMATCH",
            "external crash recovery evidence must be captured during repeated BUY reveal",
        );
    }
    if (
        String(crashRecovery.before?.ticketId ?? "") !== crashTicket.id
        || String(crashRecovery.crash?.ticketId ?? "") !== crashTicket.id
        || String(crashRecovery.after?.ticketId ?? "") !== crashTicket.id
    ) fail("CRASH_EVIDENCE_MISMATCH", "crash evidence identifies another ticket");
    input.service.crashRecovery = crashRecovery;
    input.service.logCapture = logCapture;
    await atomicWrite(outputInput, input, {exclusive: true});
    const evidence = buildPrivateCanaryEvidence(input, {contractArtifacts: artifacts});
    await atomicWrite(outputEvidence, evidence, {exclusive: true});
    return {input, evidence};
}

function argumentsOf(argv) {
    const [mode, ...rest] = argv;
    if (!["plan", "run"].includes(mode)) {
        fail(
            "USAGE",
            "usage: node tools/private-canary-runner.mjs plan|run "
                + "--config FILE --candidate FILE --base FILE "
                + "[--input-out FILE --evidence-out FILE --artifact-root DIR]",
        );
    }
    const values = {mode};
    for (let index = 0; index < rest.length; index += 2) {
        const key = rest[index];
        const value = rest[index + 1];
        if (!key?.startsWith("--") || value === undefined) fail("USAGE", "invalid arguments");
        values[key.slice(2)] = value;
    }
    for (const key of ["config", "candidate", "base"]) {
        if (!values[key]) fail("USAGE", `--${key} is required`);
    }
    return values;
}

async function main(argv) {
    const args = argumentsOf(argv);
    const [config, candidate, baseEvidence] = await Promise.all(
        [args.config, args.candidate, args.base].map((file) =>
            readFile(file, "utf8").then(JSON.parse)),
    );
    if (args.mode === "plan") {
        const plan = planPrivateCanaryRun({config, candidate, baseEvidence});
        process.stdout.write(`${JSON.stringify({
            chainId: Number(plan.chainId),
            candidateOnly: plan.candidateOnly,
            missingEnvironment: plan.missingEnvironment,
            externalRequirements: plan.externalRequirements,
            transactionsPlanned: plan.transactionsPlanned,
            writesFinalRelease: plan.writesFinalRelease,
        }, null, 2)}\n`);
        return;
    }
    for (const key of ["input-out", "evidence-out", "artifact-root"]) {
        if (!args[key]) fail("USAGE", `--${key} is required in run mode`);
    }
    await runPrivateCanary({
        config,
        candidate,
        baseEvidence,
        outputInput: args["input-out"],
        outputEvidence: args["evidence-out"],
        artifactRoot: args["artifact-root"],
        mirrorUrl: args["mirror-url"],
    });
    process.stdout.write(`candidate input ${args["input-out"]}\n`);
    process.stdout.write(`candidate evidence ${args["evidence-out"]}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`${error.code ?? "PRIVATE_CANARY_RUN_FAILED"}: ${error.message}\n`);
        process.exitCode = 1;
    });
}
