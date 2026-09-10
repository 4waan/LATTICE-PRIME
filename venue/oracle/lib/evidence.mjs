import {
    AccountId,
    Client,
    Hbar,
    PrivateKey,
    TopicId,
    TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";
import {getAddress, isHexString, keccak256, toUtf8Bytes} from "ethers";

export const EVIDENCE_VERSION = 1;
export const EVIDENCE_KIND = "oracle-answer";
export const STATUS_KIND = "oracle-status";
export const MAX_TOPIC_MESSAGE_BYTES = 1024;

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

export function canonicalEvidence(input) {
    const evidence = {
        v: EVIDENCE_VERSION,
        k: EVIDENCE_KIND,
        chain: Number(input.chain),
        oracle: getAddress(input.oracle).toLowerCase(),
        publisher: getAddress(input.publisher).toLowerCase(),
        round: integerString(input.round, "round"),
        tx: String(input.tx).toLowerCase(),
        price: integerString(input.price, "price"),
        rate: integerString(input.rate, "rate"),
        observedAt: Number(input.observedAt),
        expiresAt: Number(input.expiresAt),
        source: String(input.source).toLowerCase(),
        mode: String(input.mode),
        exactPrints: Number(input.exactPrints ?? 0),
        dealerQuotes: Number(input.dealerQuotes ?? 0),
        hbarNetwork: integerString(input.hbarNetwork, "hbarNetwork"),
        hbarMarket: input.hbarMarket === null || input.hbarMarket === undefined
            ? null
            : integerString(input.hbarMarket, "hbarMarket"),
        previous: input.previous ? String(input.previous).toLowerCase() : null,
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
    if (!isHexString(evidence.tx, 32) || !isHexString(evidence.source, 32)) {
        throw new EvidenceError("BAD_FIELD", "tx and source must be bytes32");
    }
    if (evidence.previous !== null && !isHexString(evidence.previous, 32)) {
        throw new EvidenceError("BAD_FIELD", "previous must be null or bytes32");
    }
    if (!Number.isSafeInteger(evidence.exactPrints) || evidence.exactPrints < 0 ||
        !Number.isSafeInteger(evidence.dealerQuotes) || evidence.dealerQuotes < 0) {
        throw new EvidenceError("BAD_FIELD", "source counts must be non-negative integers");
    }
    return evidence;
}

export function encodeEvidence(input) {
    const text = JSON.stringify(canonicalEvidence(input));
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
        source: input.source ? String(input.source).toLowerCase() : null,
        exactPrints: Number(input.exactPrints ?? 0),
        rejectedPrints: Number(input.rejectedPrints ?? 0),
        dealerQuotes: Number(input.dealerQuotes ?? 0),
        answerCount: Number(input.answerCount ?? 0),
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
        previous: input.previous ? String(input.previous).toLowerCase() : null,
    };
    if (!Number.isSafeInteger(status.chain) || status.chain <= 0 ||
        !Number.isSafeInteger(status.observedAt) || status.observedAt <= 0) {
        throw new EvidenceError("BAD_FIELD", "status chain and observedAt must be positive");
    }
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(status.code)) {
        throw new EvidenceError("BAD_FIELD", "status code is invalid");
    }
    if (status.source !== null && !isHexString(status.source, 32)) {
        throw new EvidenceError("BAD_FIELD", "status source must be null or bytes32");
    }
    if (status.previous !== null && !isHexString(status.previous, 32)) {
        throw new EvidenceError("BAD_FIELD", "status previous must be null or bytes32");
    }
    for (const field of ["exactPrints", "rejectedPrints", "dealerQuotes", "answerCount"]) {
        if (!Number.isSafeInteger(status[field]) || status[field] < 0) {
            throw new EvidenceError("BAD_FIELD", `${field} must be a non-negative integer`);
        }
    }
    return status;
}

export function encodeStatusEvidence(input) {
    const text = JSON.stringify(canonicalStatus(input));
    if (Buffer.byteLength(text, "utf8") > MAX_TOPIC_MESSAGE_BYTES) {
        throw new EvidenceError("TOO_LARGE", "status evidence exceeds 1024 bytes");
    }
    return text;
}

export function decodeOracleMessage(text) {
    let parsed;
    try {
        parsed = JSON.parse(String(text));
    } catch (error) {
        throw new EvidenceError("BAD_JSON", `evidence is not JSON: ${error.message}`);
    }
    if (parsed?.v !== EVIDENCE_VERSION ||
        ![EVIDENCE_KIND, STATUS_KIND].includes(parsed?.k)) {
        throw new EvidenceError("BAD_SCHEMA", "unsupported oracle evidence schema");
    }
    const canonical = parsed.k === EVIDENCE_KIND
        ? encodeEvidence(parsed)
        : encodeStatusEvidence(parsed);
    if (canonical !== String(text)) {
        throw new EvidenceError("NON_CANONICAL", "evidence is not canonically encoded");
    }
    return parsed;
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
}) {
    decodeOracleMessage(message);
    const hedera = client ?? hederaClient({chainId, accountId, privateKey});
    try {
        const transaction = await new TopicMessageSubmitTransaction()
            .setTopicId(TopicId.fromString(topicId))
            .setMessage(message)
            .setMaxTransactionFee(new Hbar(2))
            .execute(hedera);
        const receipt = await transaction.getReceipt(hedera);
        return {
            topicId: String(topicId),
            sequenceNumber: receipt.topicSequenceNumber?.toString() ?? null,
            runningHash: receipt.topicRunningHash
                ? Buffer.from(receipt.topicRunningHash).toString("hex")
                : null,
            transactionId: transaction.transactionId.toString(),
        };
    } finally {
        if (!client) hedera.close();
    }
}
