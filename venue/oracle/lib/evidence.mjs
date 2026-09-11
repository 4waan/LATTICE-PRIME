import {
    AccountId,
    Client,
    Hbar,
    PrivateKey,
    TopicId,
    TopicMessageSubmitTransaction,
    TransactionId,
} from "@hiero-ledger/sdk";
import {getAddress, isHexString, keccak256, toUtf8Bytes} from "ethers";
import {paged} from "../../tools/hcs-chain.mjs";

export const EVIDENCE_VERSION = 1;
export const EVIDENCE_KIND = "oracle-answer";
export const STATUS_KIND = "oracle-status";
export const MAX_TOPIC_MESSAGE_BYTES = 1024;
export const COMPACT_IDENTITY_BYTES = 8;

const LEGACY_EVIDENCE_VERSION = 1;
const MAX_SOURCE_COUNT = 65_535;
const SOURCE_FIELDS = [
    ["terms", "t"],
    ["sofr", "r"],
    ["hbarNetwork", "n"],
    ["hbarMarket", "h"],
    ["auction", "a"],
    ["dealers", "d"],
    ["model", "m"],
];

export const QUALITY_FLAGS = Object.freeze({
    SOFR_QUALIFIED: 1 << 0,
    AUCTION_QUALIFIED: 1 << 1,
    DEALER_QUALIFIED: 1 << 2,
    HBAR_MARKET_QUALIFIED: 1 << 3,
    INDEPENDENT_CROSS_CHECK: 1 << 4,
    VALUATION_QUALIFIED: 1 << 5,
    SOURCE_REJECTIONS: 1 << 6,
    MARKET_VWAP: 1 << 7,
});
const ALL_QUALITY_FLAGS = Object.values(QUALITY_FLAGS)
    .reduce((flags, value) => flags | value, 0);

export class EvidenceError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "EvidenceError";
        this.code = code;
    }
}

function integerString(value, field) {
    try {
        const number = BigInt(value);
        if (number < 0n) throw new Error();
        return number.toString();
    } catch {
        throw new EvidenceError("BAD_FIELD", `${field} must be an unsigned integer`);
    }
}

function positiveInteger(value, field) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) {
        throw new EvidenceError("BAD_FIELD", `${field} must be a positive integer`);
    }
    return number;
}

function count(value, field) {
    const number = Number(value ?? 0);
    if (!Number.isSafeInteger(number) || number < 0 || number > MAX_SOURCE_COUNT) {
        throw new EvidenceError(
            "BAD_FIELD",
            `${field} must be an integer from 0 through ${MAX_SOURCE_COUNT}`,
        );
    }
    return number;
}

function version(value, field) {
    const text = String(value ?? "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(text)) {
        throw new EvidenceError("BAD_FIELD", `${field} is invalid`);
    }
    return text;
}

function decisionCode(value, field, {nullable = false} = {}) {
    if (nullable && (value === null || value === undefined || value === "")) return null;
    const text = String(value ?? "");
    if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(text)) {
        throw new EvidenceError("BAD_FIELD", `${field} is invalid`);
    }
    return text;
}

function bytes32(value, field, {nullable = false} = {}) {
    if (nullable && (value === null || value === undefined || value === "")) return null;
    const text = String(value ?? "").toLowerCase();
    if (!isHexString(text, 32)) {
        throw new EvidenceError("BAD_FIELD", `${field} must be bytes32`);
    }
    return text;
}

function compactIdentity(value, field) {
    const text = String(value ?? "").toLowerCase();
    if (!isHexString(text, COMPACT_IDENTITY_BYTES)) {
        throw new EvidenceError(
            "BAD_FIELD",
            `${field} must be a ${COMPACT_IDENTITY_BYTES}-byte identity`,
        );
    }
    return text;
}

function sourceObservation(value, field, {required = false} = {}) {
    if (value === null || value === undefined) {
        if (required) throw new EvidenceError("BAD_FIELD", `${field} is required`);
        return null;
    }
    return {
        observedAt: positiveInteger(value.observedAt, `${field}.observedAt`),
        identity: compactIdentity(value.identity, `${field}.identity`),
    };
}

function canonicalSources(input) {
    const sources = {};
    for (const [field] of SOURCE_FIELDS) {
        sources[field] = sourceObservation(input?.[field], `sources.${field}`, {
            required: ["terms", "sofr", "hbarNetwork", "model"].includes(field),
        });
    }
    return sources;
}

function canonicalQuality(input = {}) {
    const flags = Number(input.flags ?? 0);
    if (!Number.isSafeInteger(flags) || flags < 0 ||
        (flags & ~ALL_QUALITY_FLAGS) !== 0) {
        throw new EvidenceError("BAD_FIELD", "quality.flags contains unsupported bits");
    }
    return {
        flags,
        exactPrints: count(input.exactPrints, "quality.exactPrints"),
        rejectedPrints: count(input.rejectedPrints, "quality.rejectedPrints"),
        dealerQuotes: count(input.dealerQuotes, "quality.dealerQuotes"),
        rejectedDealerQuotes: count(
            input.rejectedDealerQuotes,
            "quality.rejectedDealerQuotes",
        ),
        crossCheckSources: count(input.crossCheckSources, "quality.crossCheckSources"),
    };
}

function qualityWire(quality) {
    return [
        quality.flags,
        quality.exactPrints,
        quality.rejectedPrints,
        quality.dealerQuotes,
        quality.rejectedDealerQuotes,
        quality.crossCheckSources,
    ];
}

function qualityFromWire(value) {
    if (!Array.isArray(value) || value.length !== 6) {
        throw new EvidenceError("BAD_SCHEMA", "quality tuple is malformed");
    }
    return canonicalQuality({
        flags: value[0],
        exactPrints: value[1],
        rejectedPrints: value[2],
        dealerQuotes: value[3],
        rejectedDealerQuotes: value[4],
        crossCheckSources: value[5],
    });
}

function sourcesWire(sources) {
    return Object.fromEntries(SOURCE_FIELDS.map(([field, key]) => {
        const source = sources[field];
        return [key, source ? [source.observedAt, source.identity] : null];
    }));
}

function sourcesFromWire(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new EvidenceError("BAD_SCHEMA", "source observations are malformed");
    }
    const input = {};
    for (const [field, key] of SOURCE_FIELDS) {
        const source = value[key];
        if (source !== null && (!Array.isArray(source) || source.length !== 2)) {
            throw new EvidenceError("BAD_SCHEMA", `source tuple ${key} is malformed`);
        }
        input[field] = source
            ? {observedAt: source[0], identity: source[1]}
            : null;
    }
    return canonicalSources(input);
}

export function compactEvidenceIdentity(value) {
    const canonical = typeof value === "string"
        ? value
        : JSON.stringify(value, (_, child) =>
            typeof child === "bigint" ? child.toString() : child);
    return keccak256(toUtf8Bytes(canonical))
        .slice(0, 2 + COMPACT_IDENTITY_BYTES * 2);
}

export function canonicalEvidence(input) {
    const evidence = {
        v: EVIDENCE_VERSION,
        k: EVIDENCE_KIND,
        chain: Number(input.chain),
        oracle: getAddress(input.oracle).toLowerCase(),
        publisher: getAddress(input.publisher).toLowerCase(),
        round: integerString(input.round, "round"),
        tx: bytes32(input.tx, "tx"),
        price: integerString(input.price, "price"),
        rate: integerString(input.rate, "rate"),
        observedAt: Number(input.observedAt),
        expiresAt: Number(input.expiresAt),
        algorithmVersion: version(input.algorithmVersion, "algorithmVersion"),
        configurationDigest: bytes32(
            input.configurationDigest,
            "configurationDigest",
        ),
        source: bytes32(input.source, "source"),
        mode: String(input.mode),
        trigger: decisionCode(input.trigger, "trigger", {nullable: true}),
        sources: canonicalSources(input.sources),
        quality: canonicalQuality(input.quality),
        hbarNetwork: integerString(input.hbarNetwork, "hbarNetwork"),
        hbarMarket: input.hbarMarket === null || input.hbarMarket === undefined
            ? null
            : integerString(input.hbarMarket, "hbarMarket"),
        previous: bytes32(input.previous, "previous", {nullable: true}),
    };
    if (!Number.isSafeInteger(evidence.chain) || evidence.chain <= 0) {
        throw new EvidenceError("BAD_FIELD", "chain must be positive");
    }
    if (!Number.isSafeInteger(evidence.observedAt) || evidence.observedAt <= 0) {
        throw new EvidenceError("BAD_FIELD", "observedAt must be positive");
    }
    if (!Number.isSafeInteger(evidence.expiresAt) ||
        evidence.expiresAt <= evidence.observedAt) {
        throw new EvidenceError("BAD_FIELD", "expiresAt must follow observedAt");
    }
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(evidence.mode)) {
        throw new EvidenceError("BAD_FIELD", "mode is invalid");
    }
    return evidence;
}

export function encodeEvidence(input) {
    const evidence = canonicalEvidence(input);
    const text = JSON.stringify({
        v: evidence.v,
        k: EVIDENCE_KIND,
        chain: evidence.chain,
        oracle: evidence.oracle,
        publisher: evidence.publisher,
        round: evidence.round,
        tx: evidence.tx,
        price: evidence.price,
        rate: evidence.rate,
        observedAt: evidence.observedAt,
        expiresAt: evidence.expiresAt,
        av: evidence.algorithmVersion,
        cfg: evidence.configurationDigest,
        source: evidence.source,
        mode: evidence.mode,
        ...(evidence.trigger ? {tr: evidence.trigger} : {}),
        ss: sourcesWire(evidence.sources),
        q: qualityWire(evidence.quality),
        exactPrints: evidence.quality.exactPrints,
        dealerQuotes: evidence.quality.dealerQuotes,
        hbarNetwork: evidence.hbarNetwork,
        hbarMarket: evidence.hbarMarket,
        previous: evidence.previous,
    });
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_TOPIC_MESSAGE_BYTES) {
        throw new EvidenceError("TOO_LARGE", `evidence is ${bytes} bytes, maximum is 1024`);
    }
    return text;
}

function canonicalStatus(input) {
    const status = {
        v: EVIDENCE_VERSION,
        k: STATUS_KIND,
        chain: Number(input.chain),
        oracle: getAddress(input.oracle).toLowerCase(),
        publisher: getAddress(input.publisher).toLowerCase(),
        round: integerString(input.round, "round"),
        observedAt: Number(input.observedAt),
        code: String(input.code),
        source: bytes32(input.source, "source", {nullable: true}),
        quality: canonicalQuality(input.quality ?? {
            flags: input.qualityFlags ?? 0,
            exactPrints: input.exactPrints,
            rejectedPrints: input.rejectedPrints,
            dealerQuotes: input.dealerQuotes,
            rejectedDealerQuotes: input.rejectedDealerQuotes,
            crossCheckSources: input.crossCheckSources,
        }),
        answerCount: count(input.answerCount, "answerCount"),
        hbarNetwork: input.hbarNetwork === null || input.hbarNetwork === undefined
            ? null
            : integerString(input.hbarNetwork, "hbarNetwork"),
        hbarMarket: input.hbarMarket === null || input.hbarMarket === undefined
            ? null
            : integerString(input.hbarMarket, "hbarMarket"),
        hbarDivergenceBps: input.hbarDivergenceBps === null ||
            input.hbarDivergenceBps === undefined
            ? null
            : integerString(input.hbarDivergenceBps, "hbarDivergenceBps"),
        previous: bytes32(input.previous, "previous", {nullable: true}),
    };
    if (!Number.isSafeInteger(status.chain) || status.chain <= 0 ||
        !Number.isSafeInteger(status.observedAt) || status.observedAt <= 0) {
        throw new EvidenceError("BAD_FIELD", "status chain and observedAt must be positive");
    }
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(status.code)) {
        throw new EvidenceError("BAD_FIELD", "status code is invalid");
    }
    return status;
}

export function encodeStatusEvidence(input) {
    const status = canonicalStatus(input);
    const text = JSON.stringify({
        v: status.v,
        k: STATUS_KIND,
        chain: status.chain,
        oracle: status.oracle,
        publisher: status.publisher,
        round: status.round,
        observedAt: status.observedAt,
        code: status.code,
        source: status.source,
        q: qualityWire(status.quality),
        exactPrints: status.quality.exactPrints,
        rejectedPrints: status.quality.rejectedPrints,
        dealerQuotes: status.quality.dealerQuotes,
        answerCount: status.answerCount,
        hbarNetwork: status.hbarNetwork,
        hbarMarket: status.hbarMarket,
        hbarDivergenceBps: status.hbarDivergenceBps,
        previous: status.previous,
    });
    if (Buffer.byteLength(text, "utf8") > MAX_TOPIC_MESSAGE_BYTES) {
        throw new EvidenceError("TOO_LARGE", "status evidence exceeds 1024 bytes");
    }
    return text;
}

function legacyCanonicalEvidence(input) {
    const evidence = {
        v: LEGACY_EVIDENCE_VERSION,
        k: EVIDENCE_KIND,
        chain: Number(input.chain),
        oracle: getAddress(input.oracle).toLowerCase(),
        publisher: getAddress(input.publisher).toLowerCase(),
        round: integerString(input.round, "round"),
        tx: bytes32(input.tx, "tx"),
        price: integerString(input.price, "price"),
        rate: integerString(input.rate, "rate"),
        observedAt: Number(input.observedAt),
        expiresAt: Number(input.expiresAt),
        source: bytes32(input.source, "source"),
        mode: String(input.mode),
        exactPrints: count(input.exactPrints, "exactPrints"),
        dealerQuotes: count(input.dealerQuotes, "dealerQuotes"),
        hbarNetwork: integerString(input.hbarNetwork, "hbarNetwork"),
        hbarMarket: input.hbarMarket === null || input.hbarMarket === undefined
            ? null
            : integerString(input.hbarMarket, "hbarMarket"),
        previous: bytes32(input.previous, "previous", {nullable: true}),
    };
    if (!Number.isSafeInteger(evidence.chain) || evidence.chain <= 0 ||
        !Number.isSafeInteger(evidence.observedAt) || evidence.observedAt <= 0 ||
        !Number.isSafeInteger(evidence.expiresAt) ||
        evidence.expiresAt <= evidence.observedAt) {
        throw new EvidenceError("BAD_FIELD", "legacy evidence timing is invalid");
    }
    return evidence;
}

function legacyCanonicalStatus(input) {
    const status = {
        v: LEGACY_EVIDENCE_VERSION,
        k: STATUS_KIND,
        chain: Number(input.chain),
        oracle: getAddress(input.oracle).toLowerCase(),
        publisher: getAddress(input.publisher).toLowerCase(),
        round: integerString(input.round, "round"),
        observedAt: Number(input.observedAt),
        code: String(input.code),
        source: bytes32(input.source, "source", {nullable: true}),
        exactPrints: count(input.exactPrints, "exactPrints"),
        rejectedPrints: count(input.rejectedPrints, "rejectedPrints"),
        dealerQuotes: count(input.dealerQuotes, "dealerQuotes"),
        answerCount: count(input.answerCount, "answerCount"),
        hbarNetwork: input.hbarNetwork === null || input.hbarNetwork === undefined
            ? null
            : integerString(input.hbarNetwork, "hbarNetwork"),
        hbarMarket: input.hbarMarket === null || input.hbarMarket === undefined
            ? null
            : integerString(input.hbarMarket, "hbarMarket"),
        hbarDivergenceBps: input.hbarDivergenceBps === null ||
            input.hbarDivergenceBps === undefined
            ? null
            : integerString(input.hbarDivergenceBps, "hbarDivergenceBps"),
        previous: bytes32(input.previous, "previous", {nullable: true}),
    };
    if (!Number.isSafeInteger(status.chain) || status.chain <= 0 ||
        !Number.isSafeInteger(status.observedAt) || status.observedAt <= 0 ||
        !/^[A-Z][A-Z0-9_]{0,63}$/.test(status.code)) {
        throw new EvidenceError("BAD_FIELD", "legacy status fields are invalid");
    }
    return status;
}

function decodeCurrent(parsed) {
    if (parsed.k === EVIDENCE_KIND) {
        return canonicalEvidence({
            chain: parsed.chain,
            oracle: parsed.oracle,
            publisher: parsed.publisher,
            round: parsed.round,
            tx: parsed.tx,
            price: parsed.price,
            rate: parsed.rate,
            observedAt: parsed.observedAt,
            expiresAt: parsed.expiresAt,
            algorithmVersion: parsed.av,
            configurationDigest: parsed.cfg,
            source: parsed.source,
            mode: parsed.mode,
            trigger: parsed.tr,
            sources: sourcesFromWire(parsed.ss),
            quality: qualityFromWire(parsed.q),
            hbarNetwork: parsed.hbarNetwork,
            hbarMarket: parsed.hbarMarket,
            previous: parsed.previous,
        });
    }
    if (parsed.k === STATUS_KIND) {
        return canonicalStatus({
            chain: parsed.chain,
            oracle: parsed.oracle,
            publisher: parsed.publisher,
            round: parsed.round,
            observedAt: parsed.observedAt,
            code: parsed.code,
            source: parsed.source,
            quality: qualityFromWire(parsed.q),
            answerCount: parsed.answerCount,
            hbarNetwork: parsed.hbarNetwork,
            hbarMarket: parsed.hbarMarket,
            hbarDivergenceBps: parsed.hbarDivergenceBps,
            previous: parsed.previous,
        });
    }
    throw new EvidenceError("BAD_SCHEMA", "unsupported oracle evidence kind");
}

export function decodeOracleMessage(text) {
    let parsed;
    try {
        parsed = JSON.parse(String(text));
    } catch (error) {
        throw new EvidenceError("BAD_JSON", `evidence is not JSON: ${error.message}`);
    }
    let evidence;
    let canonical;
    const expanded = parsed?.v === EVIDENCE_VERSION &&
        ((parsed.k === EVIDENCE_KIND && Object.hasOwn(parsed, "av")) ||
        (parsed.k === STATUS_KIND && Object.hasOwn(parsed, "q")));
    if (expanded) {
        evidence = decodeCurrent(parsed);
        canonical = evidence.k === EVIDENCE_KIND
            ? encodeEvidence(evidence)
            : encodeStatusEvidence(evidence);
    } else if (parsed?.v === LEGACY_EVIDENCE_VERSION &&
        [EVIDENCE_KIND, STATUS_KIND].includes(parsed?.k)) {
        evidence = parsed.k === EVIDENCE_KIND
            ? legacyCanonicalEvidence(parsed)
            : legacyCanonicalStatus(parsed);
        canonical = JSON.stringify(evidence);
    } else {
        throw new EvidenceError("BAD_SCHEMA", "unsupported oracle evidence schema");
    }
    if (canonical !== String(text)) {
        throw new EvidenceError("NON_CANONICAL", "evidence is not canonically encoded");
    }
    return evidence;
}

export function decodeEvidence(text) {
    const parsed = decodeOracleMessage(text);
    if (parsed.k !== EVIDENCE_KIND) {
        throw new EvidenceError("BAD_SCHEMA", "message is not oracle answer evidence");
    }
    return parsed;
}

export function evidenceHash(text) {
    return keccak256(toUtf8Bytes(String(text)));
}

function mirrorTransactionId(message) {
    const initial = message?.chunk_info?.initial_transaction_id;
    if (!initial) return null;
    if (typeof initial === "string") return initial;
    const account = initial.account_id;
    const start = initial.transaction_valid_start;
    if (!account || !start?.seconds) return null;
    return `${account}@${start.seconds}.${String(start.nanos ?? 0).padStart(9, "0")}`;
}

export async function findEvidenceMessage({
    mirrorUrl,
    topicId,
    message,
    after = null,
    pagedFn = paged,
}) {
    decodeOracleMessage(message);
    if (!mirrorUrl) throw new EvidenceError("NO_MIRROR", "mirror URL is required");
    if (!/^\d+\.\d+\.\d+$/.test(String(topicId))) {
        throw new EvidenceError("BAD_TOPIC", "topic ID is invalid");
    }
    const timestamp = after === null
        ? ""
        : `&timestamp=gte:${Math.max(0, Number(after) - 5)}.0`;
    const basePath = `/api/v1/topics/${topicId}/messages?order=desc&limit=100`;
    const path = `${basePath}${timestamp}`;
    let rows = await pagedFn(mirrorUrl, path, "messages", {pages: 20});
    const wanted = Buffer.from(String(message), "utf8");
    const matching = (candidates) => candidates.filter((row) => {
        try {
            return Buffer.from(String(row.message ?? ""), "base64").equals(wanted);
        } catch {
            return false;
        }
    });
    let matches = matching(rows);
    if (matches.length === 0 && after !== null) {
        rows = await pagedFn(mirrorUrl, basePath, "messages", {pages: 100});
        matches = matching(rows);
    }
    if (matches.length > 1) {
        throw new EvidenceError(
            "DUPLICATE_EVIDENCE",
            `canonical evidence appears ${matches.length} times on topic ${topicId}`,
        );
    }
    if (matches.length === 0) return null;
    const found = matches[0];
    return {
        topicId: String(topicId),
        sequenceNumber: String(found.sequence_number),
        runningHash: found.running_hash ?? null,
        transactionId: mirrorTransactionId(found),
        consensusTimestamp: found.consensus_timestamp ?? null,
        recovered: true,
    };
}

export function hederaClient({chainId, accountId, privateKey}) {
    const key = PrivateKey.fromStringECDSA(privateKey);
    const client = Client.forName(Number(chainId) === 295 ? "mainnet" : "testnet");
    client.setOperator(AccountId.fromString(accountId), key);
    return client;
}

export async function submitEvidence({
    chainId,
    accountId,
    privateKey,
    topicId,
    message,
    client = null,
    onTransactionId = null,
    transactionId = null,
}) {
    decodeOracleMessage(message);
    const hedera = client ?? hederaClient({chainId, accountId, privateKey});
    try {
        const request = new TopicMessageSubmitTransaction()
            .setTopicId(TopicId.fromString(topicId))
            .setMessage(message)
            .setMaxTransactionFee(new Hbar(2));
        if (transactionId) {
            request.setTransactionId(TransactionId.fromString(transactionId));
        }
        request.freezeWith(hedera);
        if (onTransactionId) {
            await onTransactionId(request.transactionId?.toString() ?? null);
        }
        const response = await request.execute(hedera);
        const receipt = await response.getReceipt(hedera);
        return {
            topicId: String(topicId),
            sequenceNumber: receipt.topicSequenceNumber?.toString() ?? null,
            runningHash: receipt.topicRunningHash
                ? Buffer.from(receipt.topicRunningHash).toString("hex")
                : null,
            transactionId: response.transactionId.toString(),
        };
    } finally {
        if (!client) hedera.close();
    }
}
