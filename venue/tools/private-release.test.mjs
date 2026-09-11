import test from "node:test";
import assert from "node:assert/strict";

import {
    GAS_GATES,
    PRIVATE_RELEASE_SCHEMA,
    PrivateReleaseError,
    QUICKNET_CHAIN_HASH,
    privateReleaseEvidenceDigest,
    verifyPrivateRelease,
} from "./private-release.mjs";

const address = (digit) => `0x${digit.repeat(40)}`;

function evidence() {
    const value = {
        schemaVersion: PRIVATE_RELEASE_SCHEMA,
        network: {chainId: 296},
        addresses: {
            SessionAccountFactory: address("2"),
            DualRegistrationGate: address("3"),
            HbarRouter: address("4"),
            LprcRouter: address("5"),
            SessionRecoveryRouter: address("6"),
        },
        runtimeCodeHashes: Object.fromEntries(
            ["SessionAccountFactory", "DualRegistrationGate", "HbarRouter", "LprcRouter",
                "SessionRecoveryRouter"].map((name, index) =>
                [name, `0x${String(index + 1).repeat(64)}`]),
        ),
        quicknet: {
            chainHash: QUICKNET_CHAIN_HASH,
            publicKeyHash: `0x${"12".repeat(32)}`,
            beaconVerified: true,
            preReleaseRefused: true,
            crashRecoveryPassed: true,
            redactedLogsPassed: true,
            multipleRelaysPassed: true,
        },
        routing: {
            HBAR: {
                independentNotes: 8,
                independentFunders: 8,
                denomination: "100000000",
                nullifierReplayRefused: true,
                conservationPassed: true,
            },
            LPRC: {
                independentNotes: 8,
                independentFunders: 8,
                denomination: "100000000",
                nullifierReplayRefused: true,
                conservationPassed: true,
                couponSnapshotPassed: true,
                corporateActionPassed: true,
                atsCanaryEvidenceHash: `0x${"34".repeat(32)}`,
            },
        },
        session: {
            canonicalFactoryPassed: true,
            restrictedSurfacePassed: true,
            holderSecretPassed: true,
            complianceMappingPassed: true,
            factoryVenueConfigApproved: true,
            eip712VectorPassed: true,
            relayerKeySeparated: true,
            creationCodeHash: `0x${"45".repeat(32)}`,
            feePolicyDigest: `0x${"56".repeat(32)}`,
        },
        services: {
            tickets: "/api/private/tickets",
            orders: "/api/private/orders",
            routing: "/api/private/routing",
            sessions: "/api/private/sessions",
            durableWorkerPassed: true,
        },
        artifacts: Object.fromEntries(
            ["sessionEligibility", "sessionCompliance",
                "routingWithdrawal", "routingCompliance"].map((name, index) => [
                name,
                {
                    wasm: {
                        url: `/private-artifacts/${name}.wasm`,
                        bytes: 1024 + index,
                        sha256: `0x${"78".repeat(32)}`,
                    },
                    zkey: {
                        url: `/private-artifacts/${name}.zkey`,
                        bytes: 2048 + index,
                        sha256: `0x${"9a".repeat(32)}`,
                    },
                    verificationKey: {protocol: "plonk", curve: "bn128"},
                },
            ]),
        ),
        gas: {
            buy: {
                directFresh: GAS_GATES.buy.direct.toString(),
                directWarm: GAS_GATES.buy.direct.toString(),
                privateFresh: GAS_GATES.buy.cap.toString(),
                privateWarm: GAS_GATES.buy.target.toString(),
                samePeriod: true,
            },
            sell: {
                directFresh: GAS_GATES.sell.direct.toString(),
                directWarm: GAS_GATES.sell.direct.toString(),
                privateFresh: GAS_GATES.sell.cap.toString(),
                privateWarm: GAS_GATES.sell.target.toString(),
                samePeriod: true,
            },
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
    };
    value.evidenceDigest = privateReleaseEvidenceDigest(value);
    return value;
}

function resign(value) {
    value.evidenceDigest = privateReleaseEvidenceDigest(value);
    return value;
}

test("complete evidence enables both private sides", () => {
    const result = verifyPrivateRelease(evidence());
    assert.equal(result.enabled, true);
    assert.equal(result.buyEnabled, true);
    assert.equal(result.sellEnabled, true);
    assert.deepEqual(result.gasObserved, {
        buy: GAS_GATES.buy.target.toString(),
        sell: GAS_GATES.sell.target.toString(),
    });
    assert.deepEqual(result.gasDirectObserved, {
        buy: GAS_GATES.buy.direct.toString(),
        sell: GAS_GATES.sell.direct.toString(),
    });
    assert.deepEqual(result.routingNotes, {HBAR: 8, LPRC: 8});
});

test("gas hard caps are inclusive and checked without averaging", () => {
    const atCap = evidence();
    atCap.gas.buy.privateFresh = GAS_GATES.buy.cap.toString();
    atCap.gas.buy.privateWarm = GAS_GATES.buy.cap.toString();
    resign(atCap);
    assert.equal(verifyPrivateRelease(atCap).enabled, true);

    for (const sample of ["privateFresh", "privateWarm"]) {
        const over = evidence();
        over.gas.buy[sample] = (GAS_GATES.buy.cap + 1n).toString();
        resign(over);
        assert.throws(
            () => verifyPrivateRelease(over),
            (error) => error instanceof PrivateReleaseError
                && error.code === "GAS_HARD_CAP"
                && error.side === "buy",
        );
    }
});

test("buy and sell gates use their own nonzero same-period controls", () => {
    const wrongSell = evidence();
    wrongSell.gas.sell.samePeriod = false;
    resign(wrongSell);
    assert.throws(
        () => verifyPrivateRelease(wrongSell),
        (error) => error.code === "GAS_CONTROL_MISMATCH" && error.side === "sell",
    );

    const wrongBuyControl = evidence();
    wrongBuyControl.gas.buy.directWarm = "0";
    resign(wrongBuyControl);
    assert.throws(
        () => verifyPrivateRelease(wrongBuyControl),
        (error) => error.code === "GAS_CONTROL_INVALID" && error.side === "buy",
    );

    const dynamic = evidence();
    dynamic.gas.buy.directFresh = "500000";
    dynamic.gas.buy.directWarm = "500000";
    dynamic.gas.buy.privateFresh = "550000";
    dynamic.gas.buy.privateWarm = "550000";
    resign(dynamic);
    const verified = verifyPrivateRelease(dynamic);
    assert.equal(verified.gasDirectObserved.buy, "500000");
    assert.equal(verified.gasTarget.buy, "550000");
    assert.equal(verified.gasCap.buy, "575000");
});

test("privacy release refuses low anonymity and every missing canary", () => {
    const low = evidence();
    low.routing.LPRC.independentNotes = 7;
    resign(low);
    assert.throws(
        () => verifyPrivateRelease(low),
        (error) => error.code === "ANONYMITY_THRESHOLD",
    );

    const cases = [
        ["quicknet", "beaconVerified", "QUICKNET_BEACON_FAILED"],
        ["session", "holderSecretPassed", "SESSION_HOLDER_SECRET_FAILED"],
    ];
    for (const [section, field, code] of cases) {
        const input = evidence();
        input[section][field] = false;
        resign(input);
        assert.throws(() => verifyPrivateRelease(input), (error) => error.code === code);
    }

    const leaked = evidence();
    leaked.canaries.sell.noWalletInSettlement = false;
    resign(leaked);
    assert.throws(
        () => verifyPrivateRelease(leaked),
        (error) => error.code === "PRIVACY_SETTLEMENT_FAILED" && error.side === "sell",
    );
});

test("chain, addresses, Quicknet pins, and sell rollback fail closed", () => {
    const cases = [
        [(input) => { input.network.chainId = 295; }, "CHAIN_INVALID"],
        [(input) => { input.addresses.SessionAccountFactory = address("0").slice(0, -1); }, "ADDRESS_INVALID"],
        [(input) => { input.addresses.SessionAccountFactory = address("0"); }, "ADDRESS_INVALID"],
        [(input) => { input.addresses.LprcRouter = input.addresses.HbarRouter; }, "ADDRESS_INVALID"],
        [(input) => { input.runtimeCodeHashes.HbarRouter = `0x${"0".repeat(64)}`; }, "RUNTIME_HASH_INVALID"],
        [(input) => { input.quicknet.chainHash = "00".repeat(32); }, "QUICKNET_CHAIN_INVALID"],
        [(input) => { delete input.session.creationCodeHash; }, "SESSION_CREATION_HASH_INVALID"],
        [(input) => { delete input.services.routing; }, "SERVICE_PATH_INVALID"],
        [(input) => { input.canaries.sell.atomicHoldRollback = false; }, "SELL_ROLLBACK_FAILED"],
    ];
    for (const [mutate, code] of cases) {
        const input = evidence();
        mutate(input);
        resign(input);
        assert.throws(() => verifyPrivateRelease(input), (error) => error.code === code);
    }
});

test("evidence digest detects any unsigned release mutation", () => {
    const input = evidence();
    input.routing.HBAR.independentNotes = 999;
    assert.throws(
        () => verifyPrivateRelease(input),
        (error) => error.code === "EVIDENCE_DIGEST_MISMATCH",
    );
});
