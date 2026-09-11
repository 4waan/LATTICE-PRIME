import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {AbiCoder, Interface} from "ethers";

import {
    PRIVATE_CANARY_ACKNOWLEDGEMENT,
    PRIVATE_CANARY_ENGINE_ABI,
    PRIVATE_CANARY_RUN_SCHEMA,
    PRIVATE_CANARY_TRANSACTION_PLAN,
    PrivateCanaryRunnerError,
    assertDirectControlKycStatuses,
    planPrivateCanaryRun,
    privateCanaryCrashInstruction,
    runPrivateCanary,
    selectPrivateCanarySchedule,
    stagePrivateCanaryTicket,
} from "./private-canary-runner.mjs";
import {PRIVATE_CANARY_INPUT_SCHEMA} from "./private-canary-evidence.mjs";
import {assertSafeTargetRound} from "./timed-ticket.mjs";

const word = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const account = (value) => `0x${BigInt(value).toString(16).padStart(40, "0")}`;
const runtimeNames = [
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
];

function fixture() {
    const addresses = Object.fromEntries(
        runtimeNames.map((name, index) => [name, account(100 + index)]),
    );
    const candidate = {
        candidateOnly: true,
        network: {chainId: 296},
        roles: {
            deployer: account(1),
            admin: account(2),
            issuer: account(3),
            relayer: account(4),
            sessionSigner: account(5),
            recoverySigner: account(6),
        },
        addresses,
        runtimeCodeHashes: Object.fromEntries(
            runtimeNames.map((name, index) => [name, word(1_000 + index)]),
        ),
        context: {
            engine: account(20),
            security: account(21),
            registry: account(22),
            poseidon2: account(23),
            partition: word(24),
            feePolicyDigest: word(25),
            quicknetChainHash:
                "0x52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
            generation: 1,
        },
    };
    const routing = (offset) => ({
        deposits: Array.from({length: 8}, (_, index) => ({
            from: account(offset + index),
        })),
        withdrawal: {},
        preReleaseRefusal: {},
        nullifierReplay: {},
    });
    const baseEvidence = {
        schemaVersion: PRIVATE_CANARY_INPUT_SCHEMA,
        deployment: {
            candidateOnly: true,
            network: {chainId: 296},
            roles: candidate.roles,
            addresses: candidate.addresses,
            contracts: Object.fromEntries(runtimeNames.map((name) => [
                name,
                {runtimeCodeHash: candidate.runtimeCodeHashes[name]},
            ])),
            context: candidate.context,
        },
        session: {registrationReceipt: {}},
        routing: {
            HBAR: routing(200),
            LPRC: routing(300),
        },
        lprcLifecycle: {
            activationReceipt: {},
            atsCanaryEvidence: {},
            coupon: {},
        },
        service: {
            paths: {
                tickets: "/v1/private-trading/tickets",
                orders: "/v1/private-trading/orders",
            },
        },
        provingArtifacts: Object.fromEntries([
            "sessionEligibility",
            "sessionCompliance",
            "routingWithdrawal",
            "routingCompliance",
        ].map((name) => [name, {}])),
    };
    const config = {
        schemaVersion: PRIVATE_CANARY_RUN_SCHEMA,
        acknowledgement: "",
        connectedWallet: account(50),
        minimumGasReserveWeibar: "1000000000000000000",
        service: {
            url: "https://canary.example",
            origin: "https://canary.example",
            crashReadyFile: "/tmp/private-canary-crash-ready.json",
            crashInstructionFile: "/tmp/private-canary-crash-instruction.json",
            crashEvidenceFile: "/tmp/private-canary-crash-evidence.json",
        },
        orders: {
            buy: {
                fresh: {price: "100", quantity: "10"},
                repeated: {price: "100", quantity: "10"},
            },
            sell: {
                fresh: {price: "100", quantity: "10"},
                repeated: {price: "100", quantity: "10"},
            },
        },
    };
    return {candidate, baseEvidence, config};
}

test("dry plan reports guards and performs no network or transaction work", () => {
    const {candidate, baseEvidence, config} = fixture();
    let environmentRead = 0;
    const env = new Proxy({}, {
        get(target, property) {
            environmentRead += 1;
            return target[property];
        },
    });
    const plan = planPrivateCanaryRun({
        candidate,
        baseEvidence,
        config,
        env,
        mode: "plan",
    });
    assert.equal(plan.chainId, 296n);
    assert.equal(plan.candidateOnly, true);
    assert.equal(plan.writesFinalRelease, false);
    assert.equal(plan.transactionsPlanned, 24);
    assert.equal(plan.missingEnvironment.length, 7);
    assert.ok(environmentRead >= 7);
    assert.match(
        plan.externalRequirements.join("\n"),
        /8 notes from 8 distinct funded addresses/,
    );
    assert.match(plan.externalRequirements.join("\n"), /crash coordinator/);
});

test("run refuses missing acknowledgement before provider or writes", async () => {
    const {candidate, baseEvidence, config} = fixture();
    let providerUsed = false;
    await assert.rejects(
        runPrivateCanary({
            candidate,
            baseEvidence,
            config,
            env: {},
            outputInput: "/tmp/private-canary-input-never-written.json",
            outputEvidence: "/tmp/private-canary-evidence-never-written.json",
            artifactRoot: "/tmp",
            dependencies: {
                provider: new Proxy({}, {
                    get() {
                        providerUsed = true;
                        throw new Error("provider must not be used");
                    },
                }),
            },
        }),
        (error) =>
            error instanceof PrivateCanaryRunnerError
            && error.code === "ACKNOWLEDGEMENT_REQUIRED",
    );
    assert.equal(providerUsed, false);
});

test("run refuses final release output before provider or transactions", async () => {
    const {candidate, baseEvidence, config} = fixture();
    config.acknowledgement = PRIVATE_CANARY_ACKNOWLEDGEMENT;
    const env = Object.fromEntries([
        "HEDERA_TESTNET_RPC",
        "PRIVATE_TRADING_RELAYER_KEY",
        "PRIVATE_CANARY_SESSION_KEY",
        "PRIVATE_CANARY_RECOVERY_KEY",
        "PRIVATE_CANARY_DIRECT_BUY_KEY",
        "PRIVATE_CANARY_DIRECT_SELL_KEY",
        "PRIVATE_CANARY_SETTLER_KEY",
    ].map((name, index) => [
        name,
        name === "HEDERA_TESTNET_RPC"
            ? "https://rpc.example"
            : word(index + 1),
    ]));
    let providerUsed = false;
    await assert.rejects(
        runPrivateCanary({
            candidate,
            baseEvidence,
            config,
            env,
            outputInput:
                "/Users/awaansiddiqui/hedera2026/venue/deployments/private-trading-release.json",
            outputEvidence: "/tmp/private-canary-evidence-never-written.json",
            artifactRoot: "/tmp",
            dependencies: {
                provider: new Proxy({}, {
                    get() {
                        providerUsed = true;
                        throw new Error("provider must not be used");
                    },
                }),
            },
        }),
        (error) =>
            error instanceof PrivateCanaryRunnerError
            && error.code === "FINAL_RELEASE_REFUSED",
    );
    assert.equal(providerUsed, false);
});

test("plan rejects pooled funding identities", () => {
    const {candidate, baseEvidence, config} = fixture();
    for (const deposit of baseEvidence.routing.HBAR.deposits) {
        deposit.from = account(200);
    }
    assert.throws(
        () => planPrivateCanaryRun({candidate, baseEvidence, config}),
        (error) =>
            error instanceof PrivateCanaryRunnerError
            && error.code === "BASE_EVIDENCE_REQUIRED"
            && /distinct funding addresses/.test(error.message),
    );
});

test("engine commitments ABI decodes the actual OrderBook tuple order", () => {
    const iface = new Interface(PRIVATE_CANARY_ENGINE_ABI);
    const canonical = AbiCoder.defaultAbiCoder().encode(
        ["address", "uint64", "bool", "bool", "uint256"],
        [account(9), 17, true, false, 23],
    );
    const decoded = iface.decodeFunctionResult("commitments", canonical);
    assert.equal(decoded.committer.toLowerCase(), account(9));
    assert.equal(decoded.committedAt, 17n);
    assert.equal(decoded.revealed, true);
    assert.equal(decoded.cancelled, false);
    assert.equal(decoded.bond, 23n);
});

test("ticket custody uploads, captures digest, and exact-byte reads back", async () => {
    const {candidate, baseEvidence, config} = fixture();
    const plan = planPrivateCanaryRun({candidate, baseEvidence, config});
    const envelope = Buffer.alloc(2_048, 0x5a);
    const expected = {
        ticketId: "11".repeat(32),
        envelopeDigest: word(12),
        engineCommitment: word(13),
        targetRound: "14",
    };
    const byteDigest = `sha256:${"15".repeat(32)}`;
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({url, options});
        if (calls.length === 1) {
            return {
                ok: true,
                status: 201,
                json: async () => ({
                    ok: true,
                    result: {...expected, byteDigest},
                }),
            };
        }
        return {
            ok: true,
            status: 200,
            arrayBuffer: async () => envelope.buffer.slice(
                envelope.byteOffset,
                envelope.byteOffset + envelope.byteLength,
            ),
        };
    };
    const custody = await stagePrivateCanaryTicket({
        plan,
        capability: word(16),
        envelope,
        expected,
        fetchImpl,
    });
    assert.equal(custody.byteDigest, byteDigest);
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, new RegExp(`${expected.ticketId}/envelope$`));
    for (const {options} of calls) {
        assert.equal(options.credentials, "omit");
        assert.equal(options.cache, "no-store");
        assert.equal(options.headers["cache-control"], "no-store");
        assert.equal(options.referrerPolicy, "no-referrer");
        assert.equal(options.redirect, "error");
    }
    const instruction = privateCanaryCrashInstruction(plan, {
        id: expected.ticketId,
        byteDigest: custody.byteDigest,
    });
    assert.equal(instruction.byteDigest, byteDigest);
    assert.notEqual(instruction.byteDigest, expected.envelopeDigest);
});

test("ticket custody rejects a nonidentical 2048-byte readback", async () => {
    const {candidate, baseEvidence, config} = fixture();
    const plan = planPrivateCanaryRun({candidate, baseEvidence, config});
    const envelope = Buffer.alloc(2_048, 0x41);
    const changed = Buffer.from(envelope);
    changed[2_047] ^= 1;
    const expected = {
        ticketId: "21".repeat(32),
        envelopeDigest: word(22),
        engineCommitment: word(23),
        targetRound: "24",
    };
    let call = 0;
    await assert.rejects(
        stagePrivateCanaryTicket({
            plan,
            capability: word(25),
            envelope,
            expected,
            fetchImpl: async () => {
                call += 1;
                return call === 1
                    ? {
                        ok: true,
                        status: 201,
                        json: async () => ({
                            ok: true,
                            result: {
                                ...expected,
                                byteDigest: `sha256:${"26".repeat(32)}`,
                            },
                        }),
                    }
                    : {
                        ok: true,
                        status: 200,
                        arrayBuffer: async () => changed.buffer.slice(
                            changed.byteOffset,
                            changed.byteOffset + changed.byteLength,
                        ),
                    };
            },
        }),
        (error) => error.code === "TICKET_CUSTODY_FAILED",
    );
});

test("conservative target is safe for immediate and last allowed placement", () => {
    const values = {
        latestTimestamp: 1_800_000_000n,
        revealDelay: 30n,
        revealWindow: 270n,
    };
    const selected = selectPrivateCanarySchedule(values);
    assert.doesNotThrow(() => assertSafeTargetRound(selected.targetRound, {
        commitTime: values.latestTimestamp,
        revealDelay: values.revealDelay,
        revealWindow: values.revealWindow,
    }));
    assert.doesNotThrow(() => assertSafeTargetRound(selected.targetRound, {
        commitTime: values.latestTimestamp + 30n,
        revealDelay: values.revealDelay,
        revealWindow: values.revealWindow,
    }));
    assert.throws(
        () => selectPrivateCanarySchedule({...values, revealWindow: 72n}),
        (error) => error.code === "PLACEMENT_SCHEDULE_INVALID",
    );
});

test("runner places each private ticket before direct commit phase", async () => {
    const source = await readFile(new URL("./private-canary-runner.mjs", import.meta.url), "utf8");
    const preflight = source.indexOf("await verifyBalances(plan, sessionContext, wallets, provider)");
    const prepare = source.indexOf("const ticket = await prepareTicket");
    const place = source.indexOf("const placeHash = await placeTicket", prepare);
    const direct = source.indexOf("const direct = {};", place);
    const hold = source.indexOf("await createDirectHold", direct);
    const commit = source.indexOf("await directCommit", hold);
    const wait = source.indexOf("await waitUntil(latestRelease)", commit);
    assert.ok(preflight >= 0 && prepare > preflight && place > prepare && direct > place);
    assert.ok(hold > direct && commit > hold && wait > commit);
    assert.doesNotMatch(source, /tickets\.push\(await prepareTicket/);
});

test("transaction plan accounts for every submitted and automatic result", () => {
    assert.deepEqual(PRIVATE_CANARY_TRANSACTION_PLAN, {
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
    assert.equal(
        Object.entries(PRIVATE_CANARY_TRANSACTION_PLAN)
            .filter(([name]) => name !== "total")
            .reduce((sum, [, count]) => sum + count, 0),
        PRIVATE_CANARY_TRANSACTION_PLAN.total,
    );
});

test("plain HTTP service is allowed only on loopback", () => {
    const external = fixture();
    external.config.service.url = "http://canary.example";
    assert.throws(
        () => planPrivateCanaryRun(external),
        (error) => error.code === "INPUT_INVALID",
    );
    const local = fixture();
    local.config.service.url = "http://127.0.0.1:8787";
    assert.doesNotThrow(() => planPrivateCanaryRun(local));
});

test("direct controls require current-epoch KYC before writes", () => {
    assert.doesNotThrow(() => assertDirectControlKycStatuses({
        directBuy: 1n,
        directSell: 1n,
    }));
    assert.throws(
        () => assertDirectControlKycStatuses({directBuy: 1n, directSell: 0n}),
        (error) => error.code === "DIRECT_KYC_REQUIRED",
    );
    const {candidate, baseEvidence, config} = fixture();
    const plan = planPrivateCanaryRun({candidate, baseEvidence, config});
    assert.match(plan.externalRequirements.join("\n"), /current-epoch ZK KYC grants/);
});
