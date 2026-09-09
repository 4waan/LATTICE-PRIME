import {createHash} from "node:crypto";
import {assertContextAuthorized, validateMandate, MandateError} from "./mandate.mjs";

export const AUTHORITY_STATE_VERSION = "lattice.agent.authority-state.v2";

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

export function mandateId(mandateValue) {
    const mandate = validateMandate(mandateValue);
    return `sha256:${createHash("sha256").update(canonicalJson(mandate)).digest("hex")}`;
}

export function createAuthorityState(mandateValue) {
    const mandate = validateMandate(mandateValue);
    return {
        schemaVersion: AUTHORITY_STATE_VERSION,
        mandateId: mandateId(mandate),
        revocationGeneration: mandate.control.revocationGeneration,
        paused: mandate.control.paused,
        evaluationsUsed: 0,
        evaluatedSlots: [],
        newOrdersUsed: 0,
        pendingActionIds: [],
        cumulativePrincipalReserved: "0",
        cumulativeBondReserved: "0",
        cumulativeCancellationSpent: "0",
    };
}

function assertState(mandate, state) {
    if (state === null || typeof state !== "object" || Array.isArray(state)) {
        throw new MandateError("INVALID_AUTHORITY_STATE", "authority state must be an object");
    }
    const expectedKeys = [
        "schemaVersion",
        "mandateId",
        "revocationGeneration",
        "paused",
        "evaluationsUsed",
        "evaluatedSlots",
        "newOrdersUsed",
        "pendingActionIds",
        "cumulativePrincipalReserved",
        "cumulativeBondReserved",
        "cumulativeCancellationSpent",
    ].sort();
    const actualKeys = Object.keys(state).sort();
    if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, i) => key !== expectedKeys[i])) {
        throw new MandateError("INVALID_AUTHORITY_STATE", "authority state has an unknown or missing field");
    }
    if (state.schemaVersion !== AUTHORITY_STATE_VERSION || state.mandateId !== mandateId(mandate)) {
        throw new MandateError("AUTHORITY_STATE_MISMATCH", "authority state does not belong to this mandate");
    }
    if (state.revocationGeneration !== mandate.control.revocationGeneration) {
        throw new MandateError("MANDATE_REVOKED", "authority state has an obsolete revocation generation");
    }
    if (
        !Number.isSafeInteger(state.evaluationsUsed) ||
        state.evaluationsUsed < 0 ||
        !Number.isSafeInteger(state.newOrdersUsed) ||
        state.newOrdersUsed < 0 ||
        typeof state.paused !== "boolean" ||
        !Array.isArray(state.evaluatedSlots) ||
        !Array.isArray(state.pendingActionIds)
    ) {
        throw new MandateError("INVALID_AUTHORITY_STATE", "authority counters are malformed");
    }
    if (
        state.evaluatedSlots.some((slot) => typeof slot !== "string" || !/^(0|[1-9][0-9]*)$/.test(slot)) ||
        new Set(state.evaluatedSlots).size !== state.evaluatedSlots.length ||
        state.pendingActionIds.some((id) => typeof id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(id)) ||
        new Set(state.pendingActionIds).size !== state.pendingActionIds.length
    ) {
        throw new MandateError("INVALID_AUTHORITY_STATE", "authority reservations are malformed");
    }
    for (const field of [
        "cumulativePrincipalReserved",
        "cumulativeBondReserved",
        "cumulativeCancellationSpent",
    ]) {
        if (typeof state[field] !== "string" || !/^(0|[1-9][0-9]*)$/.test(state[field])) {
            throw new MandateError("INVALID_AUTHORITY_STATE", `${field} must be a canonical decimal string`);
        }
    }
}

export function reserveEvaluation(mandateValue, state, contextValue) {
    const {mandate, context} = assertContextAuthorized(mandateValue, contextValue);
    assertState(mandate, state);
    if (state.paused) {
        throw new MandateError("MANDATE_PAUSED", "authority is paused for new evaluations");
    }
    if (state.evaluationsUsed >= mandate.limits.maxEvaluations) {
        throw new MandateError("EVALUATIONS_EXHAUSTED", "the mandate has no decision evaluations left");
    }
    if (context.decisionSequence !== state.evaluationsUsed) {
        throw new MandateError("DECISION_REPLAY", "decision sequence is not the next unused sequence");
    }
    if (state.evaluatedSlots.includes(context.publicSlot)) {
        throw new MandateError("SLOT_REPLAY", "the public slot was already evaluated");
    }
    return {
        ...state,
        evaluationsUsed: state.evaluationsUsed + 1,
        evaluatedSlots: [...state.evaluatedSlots, context.publicSlot],
    };
}

export function reserveApprovedBuy(mandateValue, state, contextValue, approval) {
    const {mandate, context} = assertContextAuthorized(mandateValue, contextValue);
    assertState(mandate, state);
    if (state.paused) {
        throw new MandateError("MANDATE_PAUSED", "authority is paused for new orders");
    }
    if (
        approval === null ||
        typeof approval !== "object" ||
        Array.isArray(approval) ||
        Object.keys(approval).sort().join(",") !== "actionId,commitBond,decision,proofVerified"
    ) {
        throw new MandateError("INVALID_APPROVAL", "approval has an unknown or missing field");
    }
    if (approval.decision !== "EXECUTE" || approval.proofVerified !== true) {
        throw new MandateError("DECISION_NOT_APPROVED", "a verified EXECUTE decision is required");
    }
    if (typeof approval.actionId !== "string" || !/^sha256:[0-9a-f]{64}$/.test(approval.actionId)) {
        throw new MandateError("INVALID_ACTION_ID", "actionId must be a lowercase sha256 identifier");
    }
    if (typeof approval.commitBond !== "string" || !/^(0|[1-9][0-9]*)$/.test(approval.commitBond)) {
        throw new MandateError("INVALID_DECIMAL", "commitBond must be a canonical decimal string");
    }
    if (state.pendingActionIds.includes(approval.actionId)) {
        throw new MandateError("ACTION_REPLAY", "the action is already reserved");
    }
    if (
        !state.evaluatedSlots.includes(context.publicSlot) ||
        context.decisionSequence >= state.evaluationsUsed
    ) {
        throw new MandateError("DECISION_NOT_RESERVED", "the verified decision was not reserved in authority state");
    }
    if (state.newOrdersUsed >= mandate.limits.newOrderLimit) {
        throw new MandateError("ORDER_LIMIT", "the mandate has no new orders left");
    }
    if (state.pendingActionIds.length >= mandate.limits.maxPendingOrders) {
        throw new MandateError("PENDING_LIMIT", "the mandate already has its maximum pending orders");
    }

    const principal = BigInt(context.price) * BigInt(context.quantity);
    const nextPrincipal = BigInt(state.cumulativePrincipalReserved) + principal;
    const nextBond = BigInt(state.cumulativeBondReserved) + BigInt(approval.commitBond);
    if (nextPrincipal > BigInt(mandate.limits.principalBudget)) {
        throw new MandateError("PRINCIPAL_BUDGET", "the action exceeds the cumulative principal budget");
    }
    if (nextBond > BigInt(mandate.limits.bondBudget)) {
        throw new MandateError("BOND_BUDGET", "the action exceeds the cumulative bond budget");
    }

    return {
        ...state,
        newOrdersUsed: state.newOrdersUsed + 1,
        pendingActionIds: [...state.pendingActionIds, approval.actionId],
        cumulativePrincipalReserved: nextPrincipal.toString(),
        cumulativeBondReserved: nextBond.toString(),
    };
}

export function setAuthorityPaused(mandateValue, state, paused) {
    const mandate = validateMandate(mandateValue);
    assertState(mandate, state);
    if (typeof paused !== "boolean") {
        throw new MandateError("INVALID_CONTROL", "paused state must be boolean");
    }
    return {...state, paused};
}

export function reserveCancellation(mandateValue, state, feeTinybar) {
    const mandate = validateMandate(mandateValue);
    assertState(mandate, state);
    if (typeof feeTinybar !== "string" || !/^(0|[1-9][0-9]*)$/.test(feeTinybar)) {
        throw new MandateError("INVALID_CANCELLATION_FEE", "cancellation fee must be a decimal string");
    }
    const next = BigInt(state.cumulativeCancellationSpent) + BigInt(feeTinybar);
    if (next > BigInt(mandate.limits.cancellationBudget)) {
        throw new MandateError(
            "CANCELLATION_BUDGET",
            "cancellation would exceed the mandate budget"
        );
    }
    return {...state, cumulativeCancellationSpent: next.toString()};
}
