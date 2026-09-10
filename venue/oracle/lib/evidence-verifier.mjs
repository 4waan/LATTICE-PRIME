import {Interface, getAddress} from "ethers";
import {decodeOracleMessage, evidenceHash} from "./evidence.mjs";
import {mirror, paged, tsKey} from "../../tools/hcs-chain.mjs";

function withHex(value) {
    const text = String(value ?? "");
    return text.startsWith("0x") ? text : `0x${text}`;
}

function sameAddress(left, right) {
    try {
        return getAddress(left) === getAddress(right);
    } catch {
        return false;
    }
}

export function accountIdAddress(accountId) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(accountId ?? ""));
    if (!match) return null;
    const shard = BigInt(match[1]);
    const realm = BigInt(match[2]);
    const number = BigInt(match[3]);
    if (shard > 0xffff_ffffn || realm > 0xffff_ffff_ffff_ffffn ||
        number > 0xffff_ffff_ffff_ffffn) return null;
    return getAddress(
        "0x" +
        shard.toString(16).padStart(8, "0") +
        realm.toString(16).padStart(16, "0") +
        number.toString(16).padStart(16, "0"),
    );
}

async function contractResult(mirrorUrl, hash) {
    try {
        return await mirror(
            mirrorUrl,
            `/api/v1/contracts/results/${encodeURIComponent(hash)}`,
            {attempts: 2},
        );
    } catch (error) {
        return {__error: error.message};
    }
}

function checkTransaction(evidence, message, result, {
    iface,
    oracle,
    publisher,
    publisherAccountId,
    maximumDelaySeconds,
    now,
}) {
    const checks = [];
    const say = (name, pass, detail) => checks.push({name, pass, detail});
    if (result.__error) {
        const pending = now <= evidence.expiresAt;
        say(
            pending ? "answer is still within its broadcast window" : "expired evidence is retained",
            true,
            pending ? "pending" : "no EVM answer arrived before expiry",
        );
        return {checks, state: pending ? "pending" : "expired"};
    }

    say("transaction succeeded", result.result === "SUCCESS", String(result.result));
    say(
        "transaction targets PrimeOracle",
        sameAddress(result.address, oracle),
        String(result.address),
    );
    say(
        "transaction sender is the topic publisher",
        sameAddress(result.from, publisher) ||
            sameAddress(result.from, accountIdAddress(publisherAccountId)),
        String(result.from),
    );
    let parsed = null;
    try {
        parsed = iface.parseTransaction({data: withHex(result.function_parameters)});
    } catch {
        parsed = null;
    }
    say("calldata is PrimeOracle.submit", parsed?.name === "submit", parsed?.name ?? "undecodable");
    if (parsed?.name === "submit") {
        say("round matches", BigInt(parsed.args[0]).toString() === evidence.round, evidence.round);
        say("clean price matches", BigInt(parsed.args[1]).toString() === evidence.price, evidence.price);
        say("reference rate matches", BigInt(parsed.args[2]).toString() === evidence.rate, evidence.rate);
    }
    const submittedAt = Number(String(result.timestamp ?? "0").split(".")[0]);
    const evidenceAt = Number(String(message.consensus_timestamp ?? "0").split(".")[0]);
    say(
        "HCS evidence reached consensus first",
        tsKey(message.consensus_timestamp) <= tsKey(result.timestamp),
        `${message.consensus_timestamp} then ${result.timestamp}`,
    );
    say(
        "broadcast stayed inside its declared window",
        submittedAt <= evidence.expiresAt,
        `submitted ${submittedAt}, expires ${evidence.expiresAt}`,
    );
    say(
        "broadcast followed evidence without excessive delay",
        submittedAt - evidenceAt <= maximumDelaySeconds,
        `${submittedAt - evidenceAt} seconds`,
    );
    return {checks, state: checks.every((check) => check.pass) ? "verified" : "invalid"};
}

export async function verifyEvidenceTopic({
    mirrorUrl,
    topic,
    oracle,
    oracleHistory = [],
    chainId,
    oracleAbi,
    now = Math.floor(Date.now() / 1000),
    maximumDelaySeconds = 900,
}) {
    const iface = oracleAbi instanceof Interface ? oracleAbi : new Interface(oracleAbi);
    const knownOracles = [oracle, ...oracleHistory];
    const path = `/api/v1/topics/${topic.topicId}/messages?order=asc&limit=100`;
    const messages = await paged(mirrorUrl, path, "messages", {pages: 100});
    const records = [];
    let previous = null;
    const seenTransactions = new Set();

    for (const message of messages) {
        const sequenceNumber = String(message.sequence_number);
        let text;
        let evidence;
        const checks = [];
        try {
            text = Buffer.from(message.message, "base64").toString("utf8");
            evidence = decodeOracleMessage(text);
            checks.push({name: "message is canonical evidence", pass: true, detail: evidenceHash(text)});
        } catch (error) {
            records.push({
                sequenceNumber,
                state: "invalid",
                checks: [{name: "message is canonical evidence", pass: false, detail: error.message}],
            });
            continue;
        }
        checks.push({
            name: "chain ID matches deployment",
            pass: evidence.chain === Number(chainId),
            detail: String(evidence.chain),
        });
        checks.push({
            name: "oracle matches a recorded deployment",
            pass: knownOracles.some((address) => sameAddress(evidence.oracle, address)),
            detail: evidence.oracle,
        });
        checks.push({
            name: "publisher matches topic record",
            pass: sameAddress(evidence.publisher, topic.publisher.evmAddress),
            detail: evidence.publisher,
        });
        checks.push({
            name: "publisher evidence chain is continuous",
            pass: evidence.previous === previous,
            detail: `previous ${evidence.previous ?? "null"}`,
        });
        previous = evidenceHash(text);

        if (evidence.k === "oracle-status") {
            const failed = checks.some((check) => !check.pass);
            records.push({
                sequenceNumber,
                consensusTimestamp: message.consensus_timestamp,
                evidence,
                state: failed ? "invalid" : "status",
                checks,
            });
            continue;
        }
        checks.push({
            name: "transaction appears only once",
            pass: !seenTransactions.has(evidence.tx),
            detail: evidence.tx,
        });
        seenTransactions.add(evidence.tx);
        const result = await contractResult(mirrorUrl, evidence.tx);
        const transaction = checkTransaction(evidence, message, result, {
            iface,
            oracle: evidence.oracle,
            publisher: topic.publisher.evmAddress,
            publisherAccountId: topic.publisher.accountId,
            maximumDelaySeconds,
            now,
        });
        checks.push(...transaction.checks);
        const failed = checks.some((check) => !check.pass);
        records.push({
            sequenceNumber,
            consensusTimestamp: message.consensus_timestamp,
            evidence,
            state: failed ? "invalid" : transaction.state,
            checks,
        });
    }
    return {
        topicId: topic.topicId,
        publisher: topic.publisher,
        messages: records.length,
        verified: records.filter((record) => record.state === "verified").length,
        pending: records.filter((record) => record.state === "pending").length,
        expired: records.filter((record) => record.state === "expired").length,
        statuses: records.filter((record) => record.state === "status").length,
        invalid: records.filter((record) => record.state === "invalid").length,
        records,
    };
}
