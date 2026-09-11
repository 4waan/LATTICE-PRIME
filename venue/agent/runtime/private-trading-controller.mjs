import {createHash} from "node:crypto";

import {
    QUICKNET_CHAIN_HASH,
    TIMED_TICKET_SIZE,
} from "../../tools/timed-ticket.mjs";

export const PRIVATE_TRADING_BODY_LIMITS = Object.freeze({
    envelope: TIMED_TICKET_SIZE,
    json: 1_024,
    empty: 0,
});

export const PRIVATE_TRADING_ROUTES = Object.freeze({
    tickets: "/v1/private-trading/tickets",
    orders: "/v1/private-trading/orders",
});

const CAPABILITY = /^0x[0-9a-fA-F]{64}$/;
const TICKET_ID = /^[0-9a-f]{64}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/;
const UINT64_LIMIT = 1n << 64n;
const PLACEMENT_STATUSES = new Set([
    "ABSENT",
    "CONFIRMED",
    "PENDING",
    "REJECTED",
    "UNKNOWN",
]);
const PLACE_BODY_KEYS = Object.freeze([
    "commitment",
    "envelopeDigest",
    "feePolicyDigest",
    "generation",
    "quicknetRound",
    "signature",
]);
const CANCEL_BODY_KEYS = PLACE_BODY_KEYS;
const TERMINAL = new Set(["REVEALED", "CANCELLED", "MISSED"]);

export class PrivateTradingControllerError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = "PrivateTradingControllerError";
        this.code = code;
        this.status = status;
    }
}

function fail(code, status = 400, message = "private trading request failed") {
    throw new PrivateTradingControllerError(code, message, status);
}

function exactObject(value, keys) {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
    ) {
        fail("REQUEST_SCHEMA_INVALID");
    }
}

function capability(value) {
    if (typeof value !== "string" || !CAPABILITY.test(value)) {
        fail("CAPABILITY_REQUIRED", 401);
    }
    return value.toLowerCase();
}

function ticketId(value) {
    if (typeof value !== "string" || !TICKET_ID.test(value)) {
        fail("TICKET_ID_INVALID");
    }
    return value;
}

function bytes32(value) {
    if (typeof value !== "string" || !BYTES32.test(value.toLowerCase())) {
        fail("REQUEST_SCHEMA_INVALID");
    }
    return value.toLowerCase();
}

function decimal(value) {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
        fail("REQUEST_SCHEMA_INVALID");
    }
    if (BigInt(value) >= UINT64_LIMIT) fail("REQUEST_SCHEMA_INVALID");
    return value;
}

function normalizeHeaders(value) {
    if (typeof Headers !== "undefined" && value instanceof Headers) {
        return Object.fromEntries([...value.entries()].map(([key, item]) => [
            key.toLowerCase(),
            item,
        ]));
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        fail("HEADERS_INVALID");
    }
    const normalized = {};
    for (const [key, item] of Object.entries(value)) {
        const name = key.toLowerCase();
        if (
            !/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name)
            || typeof item !== "string"
            || Object.hasOwn(normalized, name)
        ) {
            fail("HEADERS_INVALID");
        }
        normalized[name] = item;
    }
    return normalized;
}

function bearer(headers) {
    const value = headers.authorization;
    if (typeof value !== "string" || !value.startsWith("Bearer ")) {
        fail("CAPABILITY_REQUIRED", 401);
    }
    return capability(value.slice(7));
}

function bodyBytes(value, maximum = PRIVATE_TRADING_BODY_LIMITS.envelope) {
    if (!(value instanceof Uint8Array)) fail("BODY_INVALID");
    if (value.byteLength > maximum) fail("BODY_TOO_LARGE", 413);
    return Buffer.from(value);
}

function checkDeclaredLength(headers, actual) {
    const declared = headers["content-length"];
    if (declared === undefined) return;
    if (
        !/^(0|[1-9][0-9]*)$/.test(declared)
        || Number(declared) !== actual
    ) {
        fail("CONTENT_LENGTH_INVALID");
    }
}

function requireContentType(headers, expected) {
    const value = headers["content-type"];
    if (
        typeof value !== "string"
        || value.toLowerCase().split(";", 1)[0].trim() !== expected
    ) {
        fail("CONTENT_TYPE_INVALID", 415);
    }
}

function parseJson(bytes, headers) {
    requireContentType(headers, "application/json");
    checkDeclaredLength(headers, bytes.length);
    try {
        return JSON.parse(bytes.toString("utf8"));
    } catch {
        fail("JSON_INVALID");
    }
}

function publicError(error, fallback = "REQUEST_FAILED") {
    if (error instanceof PrivateTradingControllerError) throw error;
    const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
        ? error.code
        : fallback;
    if (["CAPABILITY_REJECTED", "TICKET_MISSING"].includes(code)) {
        fail("CAPABILITY_REJECTED", 401);
    }
    fail(code);
}

function securityHeaders(contentType) {
    return Object.freeze({
        "cache-control": "no-store",
        "content-security-policy":
            "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        "content-type": contentType,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
    });
}

function jsonResponse(status, body) {
    return Object.freeze({
        status,
        headers: securityHeaders("application/json; charset=utf-8"),
        body: Object.freeze(body),
    });
}

function emptyBody(requestBody, headers) {
    checkDeclaredLength(headers, requestBody.length);
    if (requestBody.length !== 0) fail("BODY_TOO_LARGE", 413);
}

function routeBase(value) {
    if (
        typeof value !== "string"
        || !/^\/[A-Za-z0-9/_-]+$/.test(value)
        || value.includes("//")
        || value.endsWith("/")
    ) {
        fail("CONTROLLER_ROUTE_INVALID", 500);
    }
    return value;
}

function pathParts(pathname, base) {
    if (typeof pathname !== "string" || pathname.includes("?") || pathname.includes("#")) {
        fail("PATH_INVALID");
    }
    const prefix = `${base}/`;
    if (!pathname.startsWith(prefix)) return null;
    const remaining = pathname.slice(prefix.length).split("/");
    if (remaining.some((part) => part.length === 0)) return null;
    return remaining;
}

function mutationBody(body, keys) {
    exactObject(body, keys);
    return Object.freeze({
        commitment: bytes32(body.commitment),
        envelopeDigest: bytes32(body.envelopeDigest),
        feePolicyDigest: bytes32(body.feePolicyDigest),
        generation: decimal(body.generation),
        quicknetRound: decimal(body.quicknetRound),
        signature: typeof body.signature === "string"
            && /^0x[0-9a-fA-F]{130}$/.test(body.signature)
            ? body.signature.toLowerCase()
            : fail("REQUEST_SCHEMA_INVALID"),
    });
}

function placementResult(value) {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== "status,transactionHash"
        || !PLACEMENT_STATUSES.has(value.status)
        || (
            value.transactionHash !== null
            && (
                typeof value.transactionHash !== "string"
                || !TRANSACTION_HASH.test(value.transactionHash)
            )
        )
    ) {
        fail("PLACE_RELAY_RESULT_INVALID", 502);
    }
    return Object.freeze({
        status: value.status,
        transactionHash: value.transactionHash,
    });
}

export class PrivateTradingController {
    constructor({
        service,
        placeRelayer = null,
        ticketsBase = PRIVATE_TRADING_ROUTES.tickets,
        ordersBase = PRIVATE_TRADING_ROUTES.orders,
    }) {
        if (
            service === null
            || typeof service !== "object"
            || typeof service.prearm !== "function"
            || typeof service.readback !== "function"
            || typeof service.summary !== "function"
            || typeof service.cancel !== "function"
            || typeof service.manualRecovery !== "function"
            || (
                placeRelayer !== null
                && (
                    typeof placeRelayer !== "object"
                    || typeof placeRelayer.relayPlace !== "function"
                    || typeof placeRelayer.relayCancel !== "function"
                    || typeof placeRelayer.relayRelease !== "function"
                )
            )
        ) {
            fail("CONTROLLER_CONFIG_INVALID", 500);
        }
        this.service = service;
        this.placeRelayer = placeRelayer;
        this.ticketsBase = routeBase(ticketsBase);
        this.ordersBase = routeBase(ordersBase);
        if (this.ticketsBase === this.ordersBase) {
            fail("CONTROLLER_ROUTE_INVALID", 500);
        }
    }

    async prearm({envelope, capability: suppliedCapability}) {
        const auth = capability(suppliedCapability);
        const bytes = bodyBytes(envelope);
        if (bytes.length !== TIMED_TICKET_SIZE) {
            bytes.fill(0);
            fail("ENVELOPE_SIZE_INVALID", 413);
        }
        try {
            const staged = await this.service.prearm(bytes, {capability: auth});
            const {capability: omitted, ...summary} = staged;
            return Object.freeze(summary);
        } catch (error) {
            publicError(error, "PREARM_FAILED");
        } finally {
            bytes.fill(0);
        }
    }

    async readback({ticketId: suppliedTicketId, capability: suppliedCapability}) {
        const id = ticketId(suppliedTicketId);
        const auth = capability(suppliedCapability);
        let result;
        try {
            result = await this.service.readback(id, auth);
        } catch (error) {
            publicError(error, "READBACK_FAILED");
        }
        if (
            result === null
            || typeof result !== "object"
            || !(result.envelope instanceof Uint8Array)
            || result.summary === null
            || typeof result.summary !== "object"
        ) {
            result?.envelope?.fill?.(0);
            fail("READBACK_FAILED", 500);
        }
        const envelope = Buffer.from(result.envelope);
        result.envelope.fill(0);
        const digest = `sha256:${createHash("sha256").update(envelope).digest("hex")}`;
        if (
            envelope.length !== TIMED_TICKET_SIZE
            || result.summary.byteDigest !== digest
        ) {
            envelope.fill(0);
            fail("READBACK_FAILED", 500);
        }
        return Object.freeze({
            summary: result.summary,
            envelope,
        });
    }

    async summary({ticketId: suppliedTicketId, capability: suppliedCapability}) {
        try {
            return Object.freeze(await this.service.summary(
                ticketId(suppliedTicketId),
                capability(suppliedCapability),
            ));
        } catch (error) {
            publicError(error, "SUMMARY_FAILED");
        }
    }

    async cancelAuthorized({
        ticketId: suppliedTicketId,
        capability: suppliedCapability,
        body,
    }) {
        if (this.placeRelayer === null) fail("CANCEL_RELAY_UNAVAILABLE", 503);
        const id = ticketId(suppliedTicketId);
        const auth = capability(suppliedCapability);
        const normalized = mutationBody(body, CANCEL_BODY_KEYS);
        let summary;
        try {
            summary = await this.service.summary(id, auth);
        } catch (error) {
            publicError(error, "CANCELLATION_FAILED");
        }
        if (
            ["REVEALED", "MISSED"].includes(summary.state)
            || normalized.commitment !== summary.engineCommitment
            || normalized.envelopeDigest !== summary.envelopeDigest
            || normalized.quicknetRound !== summary.targetRound
        ) {
            fail("TICKET_CONTEXT_MISMATCH");
        }
        let relayed;
        try {
            relayed = await this.placeRelayer.relayCancel({
                chainId: summary.chainId,
                chainHash: QUICKNET_CHAIN_HASH,
                engine: summary.engine,
                sessionAccount: summary.sessionAccount,
                envelopeId: summary.envelopeId,
                envelopeDigest: summary.envelopeDigest,
                engineCommitment: summary.engineCommitment,
                targetRound: summary.targetRound,
                ticketId: id,
                generation: normalized.generation,
                feePolicyDigest: normalized.feePolicyDigest,
                signature: normalized.signature,
            });
        } catch (error) {
            publicError(error, "CANCELLATION_FAILED");
        }
        if (
            relayed?.status !== "CONFIRMED"
            || typeof relayed.transactionHash !== "string"
            || !TRANSACTION_HASH.test(relayed.transactionHash)
            || (
                relayed.sweepTransactionHash !== null
                && (
                    typeof relayed.sweepTransactionHash !== "string"
                    || !TRANSACTION_HASH.test(relayed.sweepTransactionHash)
                )
            )
        ) {
            fail("CANCELLATION_UNCONFIRMED", 502);
        }
        try {
            await this.service.cancel(id, auth);
        } catch (error) {
            publicError(error, "CANCELLATION_FINALIZATION_FAILED");
        }
        return Object.freeze({
            status: "CONFIRMED",
            transactionHash: relayed.transactionHash,
            sweepTransactionHash: relayed.sweepTransactionHash,
        });
    }

    async manualRecovery({
        ticketId: suppliedTicketId,
        capability: suppliedCapability,
    }) {
        try {
            return Object.freeze(await this.service.manualRecovery(
                ticketId(suppliedTicketId),
                capability(suppliedCapability),
            ));
        } catch (error) {
            publicError(error, "RECOVERY_FAILED");
        }
    }

    async placeSealed({
        ticketId: suppliedTicketId,
        capability: suppliedCapability,
        body,
    }) {
        if (this.placeRelayer === null) fail("PLACE_RELAY_UNAVAILABLE", 503);
        const id = ticketId(suppliedTicketId);
        const auth = capability(suppliedCapability);
        const normalized = mutationBody(body, PLACE_BODY_KEYS);
        let summary;
        try {
            summary = await this.service.summary(id, auth);
        } catch (error) {
            publicError(error, "PLACE_RELAY_FAILED");
        }
        if (
            TERMINAL.has(summary.state)
            || normalized.commitment !== summary.engineCommitment
            || normalized.envelopeDigest !== summary.envelopeDigest
            || normalized.quicknetRound !== summary.targetRound
        ) {
            fail("TICKET_CONTEXT_MISMATCH");
        }
        let result;
        try {
            result = placementResult(await this.placeRelayer.relayPlace({
                chainId: summary.chainId,
                chainHash: QUICKNET_CHAIN_HASH,
                engine: summary.engine,
                sessionAccount: summary.sessionAccount,
                envelopeId: summary.envelopeId,
                envelopeDigest: summary.envelopeDigest,
                engineCommitment: summary.engineCommitment,
                targetRound: summary.targetRound,
                ticketId: id,
                generation: normalized.generation,
                feePolicyDigest: normalized.feePolicyDigest,
                signature: normalized.signature,
            }));
        } catch (error) {
            publicError(error, "PLACE_RELAY_FAILED");
        }
        return Object.freeze({
            schemaVersion: "hedera2026.private-place-result.v1",
            ticketId: id,
            status: result.status,
            transactionHash: result.transactionHash ?? null,
        });
    }

    async releaseOrder({
        ticketId: suppliedTicketId,
        capability: suppliedCapability,
    }) {
        if (this.placeRelayer === null) fail("RELEASE_RELAY_UNAVAILABLE", 503);
        const id = ticketId(suppliedTicketId);
        const auth = capability(suppliedCapability);
        let summary;
        try {
            summary = await this.service.summary(id, auth);
        } catch (error) {
            publicError(error, "RELEASE_FAILED");
        }
        if (summary.state !== "REVEALED") fail("RELEASE_STATE_REFUSED");
        let result;
        try {
            result = await this.placeRelayer.relayRelease({
                chainId: summary.chainId,
                chainHash: QUICKNET_CHAIN_HASH,
                engine: summary.engine,
                sessionAccount: summary.sessionAccount,
                envelopeId: summary.envelopeId,
                envelopeDigest: summary.envelopeDigest,
                engineCommitment: summary.engineCommitment,
                targetRound: summary.targetRound,
                ticketId: id,
            });
        } catch (error) {
            publicError(error, "RELEASE_FAILED");
        }
        const hashes = [result?.transactionHash, result?.sweepTransactionHash]
            .filter((value) => value !== null);
        if (
            result?.status !== "CONFIRMED"
            || !hashes.some((value) =>
                typeof value === "string" && TRANSACTION_HASH.test(value))
            || hashes.some((value) =>
                typeof value !== "string" || !TRANSACTION_HASH.test(value))
        ) {
            fail("RELEASE_RESULT_INVALID", 502);
        }
        return Object.freeze({
            status: "CONFIRMED",
            transactionHash: result.transactionHash ?? null,
            sweepTransactionHash: result.sweepTransactionHash ?? null,
        });
    }

    async handle(request) {
        exactObject(request, ["body", "headers", "method", "path"]);
        const headers = normalizeHeaders(request.headers);
        const auth = bearer(headers);
        if (
            typeof request.method !== "string"
            || !/^[A-Za-z]+$/.test(request.method)
            || typeof request.path !== "string"
        ) {
            fail("REQUEST_SCHEMA_INVALID");
        }
        const method = request.method.toUpperCase();
        const maximumBody = (
            method === "POST"
            && (
                request.path.endsWith("/place")
                || request.path.endsWith("/cancel")
            )
        )
            ? PRIVATE_TRADING_BODY_LIMITS.json
            : PRIVATE_TRADING_BODY_LIMITS.envelope;
        const bytes = bodyBytes(request.body, maximumBody);
        try {
            if (request.path === this.ticketsBase) {
                if (method !== "POST") fail("ROUTE_NOT_FOUND", 404);
                requireContentType(headers, "application/octet-stream");
                checkDeclaredLength(headers, bytes.length);
                if (bytes.length !== TIMED_TICKET_SIZE) {
                    fail("ENVELOPE_SIZE_INVALID", 413);
                }
                const result = await this.prearm({envelope: bytes, capability: auth});
                return jsonResponse(201, {ok: true, result});
            }
            const ticketParts = pathParts(request.path, this.ticketsBase);
            if (
                ticketParts !== null
                && TICKET_ID.test(ticketParts[0])
                && method === "GET"
                && ticketParts.length === 1
            ) {
                emptyBody(bytes, headers);
                return jsonResponse(200, {
                    ok: true,
                    result: await this.summary({
                        ticketId: ticketParts[0],
                        capability: auth,
                    }),
                });
            }
            if (
                ticketParts !== null
                && TICKET_ID.test(ticketParts[0])
                && method === "GET"
                && ticketParts.length === 2
                && ticketParts[1] === "envelope"
            ) {
                emptyBody(bytes, headers);
                const result = await this.readback({
                    ticketId: ticketParts[0],
                    capability: auth,
                });
                return Object.freeze({
                    status: 200,
                    headers: Object.freeze({
                        ...securityHeaders("application/octet-stream"),
                        "content-length": String(result.envelope.length),
                        etag: `"${result.summary.byteDigest}"`,
                    }),
                    body: result.envelope,
                });
            }
            if (
                ticketParts !== null
                && TICKET_ID.test(ticketParts[0])
                && method === "POST"
                && ticketParts.length === 2
                && ticketParts[1] === "recover"
            ) {
                emptyBody(bytes, headers);
                return jsonResponse(200, {
                    ok: true,
                    result: await this.manualRecovery({
                        ticketId: ticketParts[0],
                        capability: auth,
                    }),
                });
            }
            const orderParts = pathParts(request.path, this.ordersBase);
            if (
                orderParts === null
                || !TICKET_ID.test(orderParts[0])
                || orderParts.length !== 2
            ) {
                fail("ROUTE_NOT_FOUND", 404);
            }
            const id = orderParts[0];
            if (method === "POST" && orderParts[1] === "cancel") {
                const parsed = parseJson(bytes, headers);
                return jsonResponse(200, {
                    ok: true,
                    result: await this.cancelAuthorized({
                        ticketId: id,
                        capability: auth,
                        body: parsed,
                    }),
                });
            }
            if (method === "POST" && orderParts[1] === "release") {
                emptyBody(bytes, headers);
                return jsonResponse(200, {
                    ok: true,
                    result: await this.releaseOrder({
                        ticketId: id,
                        capability: auth,
                    }),
                });
            }
            if (method === "POST" && orderParts[1] === "place") {
                const parsed = parseJson(bytes, headers);
                return jsonResponse(200, {
                    ok: true,
                    result: await this.placeSealed({
                        ticketId: id,
                        capability: auth,
                        body: parsed,
                    }),
                });
            }
            fail("ROUTE_NOT_FOUND", 404);
        } finally {
            bytes.fill(0);
        }
    }
}
