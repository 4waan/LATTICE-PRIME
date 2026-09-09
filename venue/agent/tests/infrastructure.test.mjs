import assert from "node:assert/strict";
import test from "node:test";

import {encodeContext, contextId, ContextError} from "../runtime/context.mjs";
import {assertContextAuthorized, validateMandate, MandateError} from "../runtime/mandate.mjs";
import {
    createAuthorityState,
    reserveApprovedBuy,
    reserveEvaluation,
} from "../runtime/policy.mjs";
import {
    assertTransactionMatchesProjection,
    projectCommit,
    projectReveal,
    ProjectionError,
} from "../runtime/transaction-projector.mjs";

const H = {
    protocol: `0x${"01".repeat(32)}`,
    deployment: `0x${"02".repeat(32)}`,
    model: `0x${"03".repeat(32)}`,
    policy: `0x${"04".repeat(32)}`,
    nonce: `0x${"05".repeat(32)}`,
    snapshot: `0x${"06".repeat(32)}`,
    activation: `0x${"07".repeat(32)}`,
    salt: `0x${"08".repeat(32)}`,
};

function context() {
    return {
        protocolDomain: H.protocol,
        chainId: "296",
        engine: "0x543e3c66d040e6f4fd7d066c6fd1e557d4b11dae",
        executionAccount: "0x1000000000000000000000000000000000000001",
        token: "0x5efb2ed7b36728d4893156b9ce41b7068fb52fe2",
        side: "BUY",
        price: "2500000",
        quantity: "2",
        recoveryAddress: "0x2000000000000000000000000000000000000002",
        snapshotId: H.snapshot,
        deploymentHash: H.deployment,
        modelBundleHash: H.model,
        policyHash: H.policy,
        mandateNonce: H.nonce,
        decisionSequence: 0,
        publicSlot: "1000",
        expiresAt: "1050",
        features: {
            limitRoomBps: 600,
            recentMoveOffsetBps: 1100,
            roundProgressBps: 5000,
            freshnessSeconds: 30,
            bufferCategory: 1,
            horizonCategory: 1,
        },
    };
}

function mandate() {
    const c = context();
    return {
        schemaVersion: "lattice.agent.mandate.v1",
        identity: {
            chainId: c.chainId,
            executionAccount: c.executionAccount,
            deploymentHash: c.deploymentHash,
            modelBundleHash: c.modelBundleHash,
            policyHash: c.policyHash,
            mandateNonce: c.mandateNonce,
        },
        ticket: {
            engine: c.engine,
            token: c.token,
            side: "BUY",
            quantity: c.quantity,
            limitPrice: c.price,
            recoveryAddress: c.recoveryAddress,
            permittedMethods: ["commit", "reveal", "cancel", "expire", "withdraw"],
        },
        limits: {
            newOrderLimit: 1,
            principalBudget: "5000000",
            bondBudget: "1000000",
            cancellationBudget: "100000",
            feeReserve: "2000000",
            maxPendingOrders: 1,
            decisionSlots: ["1000", "2000", "3000"],
            maxEvaluations: 3,
        },
        time: {
            validFrom: "900",
            lastNewEntryAt: "3100",
            recoveryDeadline: "4000",
            snapshotFreshnessSeconds: 60,
        },
        privacy: {
            mode: "excluded",
            excludedInputs: [
                "credentialMaterial",
                "offPlatformHoldings",
                "privatePreferences",
                "revealSalt",
                "signingKey",
            ],
            releaseFunctionId: "none",
            receiptExportMode: "sanitized",
            externalModelEndpoint: null,
        },
        control: {
            activationId: H.activation,
            revocationGeneration: 0,
            paused: false,
            completeOutstandingObligations: true,
        },
    };
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

test("context encoding is fixed width and deterministic", () => {
    const encoded = encodeContext(context());
    assert.equal(encoded.length, 173);
    assert.deepEqual(encoded.slice(0, 6), [600, 1100, 5000, 30, 1, 1]);
    assert.deepEqual(encoded.slice(22, 26), [0, 0, 0, 296]);
    assert.equal(contextId(context()), contextId(context()));
});

test("context rejects unknown fields and unsupported values", () => {
    const extra = context();
    extra.privateNote = "must never reach the graph";
    assert.throws(() => encodeContext(extra), (error) => {
        assert.equal(error.code, "UNKNOWN_OR_MISSING_FIELD");
        return error instanceof ContextError;
    });
    const sell = context();
    sell.side = "SELL";
    assert.throws(() => encodeContext(sell), {code: "UNSUPPORTED_SIDE"});
    const wide = context();
    wide.features.freshnessSeconds = 301;
    assert.throws(() => encodeContext(wide), {code: "INTEGER_OUT_OF_RANGE"});
});

test("mandate schema is closed and excludes private context", () => {
    assert.equal(validateMandate(mandate()).privacy.mode, "excluded");
    const external = mandate();
    external.privacy.externalModelEndpoint = "https://example.invalid";
    assert.throws(() => validateMandate(external), {code: "EXTERNAL_MODEL_FORBIDDEN"});
    const category = context();
    category.features.bufferCategory = 2;
    assert.throws(() => assertContextAuthorized(mandate(), category), {
        code: "PRIVATE_CONTEXT_EXCLUDED",
    });
});

test("authority counters refuse replay and cumulative overspend", () => {
    const m = mandate();
    const c = context();
    const initial = createAuthorityState(m);
    assert.throws(
        () =>
            reserveApprovedBuy(m, initial, c, {
                actionId: `sha256:${"09".repeat(32)}`,
                commitBond: "1000000",
                decision: "EXECUTE",
                proofVerified: true,
            }),
        {code: "DECISION_NOT_RESERVED"}
    );
    const evaluated = reserveEvaluation(m, initial, c);
    assert.equal(evaluated.evaluationsUsed, 1);
    assert.throws(() => reserveEvaluation(m, evaluated, c), {code: "DECISION_REPLAY"});

    const reserved = reserveApprovedBuy(m, evaluated, c, {
        actionId: `sha256:${"0a".repeat(32)}`,
        commitBond: "1000000",
        decision: "EXECUTE",
        proofVerified: true,
    });
    assert.equal(reserved.cumulativePrincipalReserved, "5000000");
    assert.equal(reserved.newOrdersUsed, 1);
    const tampered = {...reserved, unexpected: true};
    assert.throws(
        () =>
            reserveApprovedBuy(m, tampered, c, {
                actionId: `sha256:${"0b".repeat(32)}`,
                commitBond: "1",
                decision: "EXECUTE",
                proofVerified: true,
            }),
        {code: "INVALID_AUTHORITY_STATE"}
    );
    assert.throws(
        () =>
            reserveApprovedBuy(m, reserved, c, {
                actionId: `sha256:${"0b".repeat(32)}`,
                commitBond: "1",
                decision: "EXECUTE",
                proofVerified: true,
            }),
        {code: "ORDER_LIMIT"}
    );
});

test("commit and reveal projection permit only the approved transaction bytes", () => {
    const m = mandate();
    const c = context();
    const commit = projectCommit(m, c, {salt: H.salt, commitBond: "1000000"});
    assert.equal(commit.method, "commit");
    assert.equal(commit.data.length, 10 + 64);
    assert.equal(commit.valueTinybar, "1000000");
    assert.equal(commit.valueWeibar, "10000000000000000");

    assert.equal(
        assertTransactionMatchesProjection(
            {
                chainId: 296n,
                from: c.executionAccount,
                to: c.engine,
                data: commit.data,
                value: 10000000000000000n,
            },
            commit
        ),
        true
    );
    assert.throws(
        () =>
            assertTransactionMatchesProjection(
                {
                    chainId: 296n,
                    from: c.executionAccount,
                    to: c.engine,
                    data: commit.data,
                    value: 10000000000000001n,
                },
                commit
            ),
        {code: "TRANSACTION_MISMATCH"}
    );

    const reveal = projectReveal(m, c, {salt: H.salt});
    assert.equal(reveal.method, "reveal");
    assert.equal(reveal.valueTinybar, "5000000");
    assert.equal(reveal.valueWeibar, "50000000000000000");
});

test("projector rejects arbitrary stages and malformed requests", async () => {
    const module = await import("../runtime/transaction-projector.mjs");
    assert.throws(() => module.projectionForApproval(mandate(), context(), "transfer", {}), {
        code: "UNSUPPORTED_STAGE",
    });
    assert.throws(() => projectCommit(mandate(), context(), {salt: H.salt, commitBond: "1", data: "0x"}), {
        code: "INVALID_COMMIT_REQUEST",
    });
    assert.ok(MandateError);
    assert.ok(ProjectionError);
});
