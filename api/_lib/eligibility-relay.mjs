const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const INTEGER = /^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/;
const UINT256_MAX = (1n << 256n) - 1n;
const DEFAULT_BODY_LIMIT = 24 * 1024;

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function asAddress(value, label) {
    const text = String(value || "");
    if (!ADDRESS.test(text)) throw new HttpError(400, `${label} is not an EVM address.`);
    return text.toLowerCase();
}

function asUint(value, label) {
    if (typeof value !== "string" || !INTEGER.test(value)) {
        throw new HttpError(400, `${label} is not an unsigned integer string.`);
    }
    const parsed = BigInt(value);
    if (parsed > UINT256_MAX) throw new HttpError(400, `${label} exceeds uint256.`);
    return parsed;
}

function asUintArray(value, length, label) {
    if (!Array.isArray(value) || value.length !== length) {
        throw new HttpError(400, `${label} must contain ${length} values.`);
    }
    return value.map((item, index) => asUint(item, `${label}[${index}]`));
}

function bodyBytes(request) {
    const declared = Number(request.headers?.["content-length"] || 0);
    const actual = typeof request.body === "string"
        ? Buffer.byteLength(request.body)
        : Buffer.isBuffer(request.body)
            ? request.body.length
            : Buffer.byteLength(JSON.stringify(request.body ?? null));
    return Number.isFinite(declared) && declared > 0 ? Math.max(declared, actual) : actual;
}

function parseBody(request, maximumBytes) {
    if (bodyBytes(request) > maximumBytes) {
        throw new HttpError(413, "Eligibility request is too large.");
    }
    if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
        return request.body;
    }
    try {
        return JSON.parse(Buffer.isBuffer(request.body)
            ? request.body.toString("utf8")
            : String(request.body || ""));
    } catch {
        throw new HttpError(400, "Eligibility request is not valid JSON.");
    }
}

function normalizedOrigin(value) {
    try {
        return new URL(String(value)).origin.toLowerCase();
    } catch {
        return "";
    }
}

function requestIp(request) {
    const forwarded = String(
        request.headers?.["x-forwarded-for"]
        || request.headers?.["x-real-ip"]
        || request.socket?.remoteAddress
        || "unknown",
    );
    return forwarded.split(",")[0].trim().slice(0, 128);
}

function consume(bucket, key, maximum, windowMs, now) {
    if (bucket.size > 4096) {
        for (const [candidate, value] of bucket) {
            if (value.until <= now) bucket.delete(candidate);
        }
        if (bucket.size > 4096) {
            throw new HttpError(503, "Eligibility request capacity is temporarily exhausted.");
        }
    }
    const previous = bucket.get(key);
    if (!previous || previous.until <= now) {
        bucket.set(key, {count: 1, until: now + windowMs});
        return;
    }
    if (previous.count >= maximum) {
        throw new HttpError(429, "Too many eligibility requests. Wait before trying again.");
    }
    previous.count += 1;
}

function send(response, status, value) {
    response.statusCode = status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store, max-age=0");
    response.setHeader("x-content-type-options", "nosniff");
    response.end(JSON.stringify(value));
}

export function validateEligibilityRequest(body, config) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new HttpError(400, "Eligibility request must be a JSON object.");
    }
    const chainId = Number(body.chainId);
    if (!Number.isSafeInteger(chainId) || chainId !== config.chainId) {
        throw new HttpError(400, "Eligibility request names the wrong network.");
    }

    const gate = asAddress(body.gate, "gate");
    const registry = asAddress(body.registry, "registry");
    const account = asAddress(body.account, "account");
    if (gate !== config.gate) throw new HttpError(400, "Eligibility request names the wrong gate.");
    if (registry !== config.registry) {
        throw new HttpError(400, "Eligibility request names the wrong registry.");
    }

    const proof = asUintArray(body.proof, 24, "proof");
    const pub = asUintArray(body.pub, 7, "pub");
    if (pub[4] !== BigInt(account)) {
        throw new HttpError(400, "Eligibility proof is bound to another account.");
    }
    return {account, proof, pub};
}

export function createEligibilityRelay({
    config,
    chain,
    now = () => Date.now(),
}) {
    if (!config || !chain) throw new TypeError("Eligibility relay needs config and chain adapters.");
    const allowedOrigins = new Set((config.allowedOrigins || []).map(normalizedOrigin).filter(Boolean));
    if (!allowedOrigins.size) throw new TypeError("Eligibility relay needs at least one allowed origin.");

    const bodyLimit = config.maximumBodyBytes || DEFAULT_BODY_LIMIT;
    const requestWindowMs = config.requestWindowMs || 60_000;
    const accountLimit = config.accountRequestsPerWindow || 3;
    const ipLimit = config.ipRequestsPerWindow || 12;
    const sponsorWindowMs = config.sponsorWindowMs || 60 * 60_000;
    const sponsorLimit = config.sponsoredSubmissionsPerWindow || 30;
    const accountRequests = new Map();
    const ipRequests = new Map();
    const sponsorRequests = new Map();
    const inflight = new Map();

    async function process(input) {
        let granted;
        try {
            granted = await chain.status(input.account);
        } catch {
            throw new HttpError(503, "Eligibility registry is temporarily unavailable.");
        }
        if (Number(granted) === 1) return {status: "already_granted"};

        let accepted;
        let reason;
        try {
            [accepted, reason] = await chain.wouldAccept(input.account, input.pub);
        } catch {
            throw new HttpError(503, "Eligibility gate is temporarily unavailable.");
        }
        if (!accepted) {
            throw new HttpError(409, String(reason || "Eligibility requirements are not met."));
        }

        // `wouldAccept` checks the public pins but deliberately skips the
        // expensive verifier. Simulating `register` is what prevents an invalid
        // cryptographic proof from spending sponsor funds on a reverting call.
        try {
            await chain.simulate(input.account, input.proof, input.pub);
        } catch {
            throw new HttpError(422, "Cryptographic eligibility verification failed.");
        }

        // A parallel request may have landed while verification ran.
        if (Number(await chain.status(input.account)) === 1) {
            return {status: "already_granted"};
        }
        consume(sponsorRequests, "global", sponsorLimit, sponsorWindowMs, now());

        try {
            const submitted = await chain.submit(input.account, input.proof, input.pub);
            return {status: "submitted", txHash: submitted.txHash};
        } catch {
            throw new HttpError(503, "Sponsored registration could not be submitted.");
        }
    }

    return async function eligibilityRelay(request, response) {
        if (request.method !== "POST") {
            response.setHeader("allow", "POST");
            send(response, 405, {error: "Use POST for sponsored eligibility."});
            return;
        }
        const contentType = String(request.headers?.["content-type"] || "").toLowerCase();
        if (!contentType.includes("application/json")) {
            send(response, 415, {error: "Eligibility requests must use application/json."});
            return;
        }
        const origin = normalizedOrigin(request.headers?.origin);
        if (!allowedOrigins.has(origin)) {
            send(response, 403, {error: "This origin cannot request sponsored eligibility."});
            return;
        }

        try {
            const input = validateEligibilityRequest(parseBody(request, bodyLimit), config);
            const key = `${input.account}:${input.pub[3]}:${input.pub[0]}`;
            const pending = inflight.get(key);
            if (pending) {
                const result = await pending;
                send(response, result.status === "already_granted" ? 200 : 202, result);
                return;
            }

            consume(accountRequests, input.account, accountLimit, requestWindowMs, now());
            consume(ipRequests, requestIp(request), ipLimit, requestWindowMs, now());
            const work = process(input);
            inflight.set(key, work);
            try {
                const result = await work;
                send(response, result.status === "already_granted" ? 200 : 202, result);
            } finally {
                inflight.delete(key);
            }
        } catch (error) {
            const status = error instanceof HttpError ? error.status : 500;
            const message = error instanceof HttpError
                ? error.message
                : "Sponsored eligibility failed safely.";
            send(response, status, {error: message});
        }
    };
}
