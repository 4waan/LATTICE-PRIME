export const PRIVATE_ROUTING_BODY_LIMIT = 16_384;
export const PRIVATE_ROUTING_ROUTE = "/v1/private-trading/routing";

const PUBLIC_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/;

export class PrivateRoutingControllerError extends Error {
    constructor(code, status = 400) {
        super("private routing request failed");
        this.name = "PrivateRoutingControllerError";
        this.code = code;
        this.status = status;
    }
}

function fail(code, status = 400) {
    throw new PrivateRoutingControllerError(code, status);
}

function exactObject(value, keys) {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
    ) {
        fail("ROUTING_REQUEST_SCHEMA_INVALID");
    }
}

function routePath(value) {
    if (
        typeof value !== "string"
        || !/^\/[A-Za-z0-9/_-]+$/.test(value)
        || value.includes("//")
        || value.endsWith("/")
    ) {
        fail("ROUTING_CONTROLLER_CONFIG_INVALID", 500);
    }
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

function bodyBytes(value) {
    if (!(value instanceof Uint8Array)) fail("BODY_INVALID");
    if (value.byteLength > PRIVATE_ROUTING_BODY_LIMIT) fail("BODY_TOO_LARGE", 413);
    return Buffer.from(value);
}

function parseJson(bytes, headers) {
    const contentType = headers["content-type"];
    if (
        typeof contentType !== "string"
        || contentType.toLowerCase().split(";", 1)[0].trim() !== "application/json"
    ) {
        fail("CONTENT_TYPE_INVALID", 415);
    }
    const declared = headers["content-length"];
    if (
        declared !== undefined
        && (
            !/^(0|[1-9][0-9]*)$/.test(declared)
            || Number(declared) !== bytes.length
        )
    ) {
        fail("CONTENT_LENGTH_INVALID");
    }
    try {
        return JSON.parse(bytes.toString("utf8"));
    } catch {
        fail("JSON_INVALID");
    }
}

function publicError(error) {
    if (error instanceof PrivateRoutingControllerError) throw error;
    const code = typeof error?.code === "string" && PUBLIC_CODE.test(error.code)
        ? error.code
        : "ROUTING_REQUEST_FAILED";
    fail(code);
}

function response(result) {
    if (
        result === null
        || typeof result !== "object"
        || Array.isArray(result)
        || Object.keys(result).sort().join(",") !== "status,txHash"
        || !["CONFIRMED", "PENDING", "REJECTED", "UNKNOWN"].includes(result.status)
        || typeof result.txHash !== "string"
        || !TRANSACTION_HASH.test(result.txHash)
    ) {
        fail("ROUTING_RESULT_INVALID", 502);
    }
    return Object.freeze({
        status: 200,
        headers: Object.freeze({
            "cache-control": "no-store",
            "content-security-policy":
                "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
            "content-type": "application/json; charset=utf-8",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
        }),
        body: Object.freeze({
            status: result.status,
            txHash: result.txHash,
        }),
    });
}

export class PrivateRoutingController {
    constructor({
        relayer,
        path = PRIVATE_ROUTING_ROUTE,
    }) {
        if (
            relayer === null
            || typeof relayer !== "object"
            || typeof relayer.relayRoutingWithdrawal !== "function"
        ) {
            fail("ROUTING_CONTROLLER_CONFIG_INVALID", 500);
        }
        this.relayer = relayer;
        this.path = routePath(path);
    }

    async handle(request) {
        exactObject(request, ["body", "headers", "method", "path"]);
        if (
            request.method !== "POST"
            || request.path !== this.path
        ) {
            fail("ROUTE_NOT_FOUND", 404);
        }
        const headers = normalizeHeaders(request.headers);
        const bytes = bodyBytes(request.body);
        try {
            const parsed = parseJson(bytes, headers);
            let result;
            try {
                result = await this.relayer.relayRoutingWithdrawal(parsed);
            } catch (error) {
                publicError(error);
            }
            return response(result);
        } finally {
            bytes.fill(0);
        }
    }
}
