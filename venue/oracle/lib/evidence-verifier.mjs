import {Interface, getAddress} from "ethers";
import {
    EVIDENCE_KIND,
    STATUS_KIND,
    decodeOracleMessage,
    evidenceHash,
} from "./evidence.mjs";
import {mirror, paged, tsKey} from "../../tools/hcs-chain.mjs";

const DEFAULT_MAXIMUM_PANEL_ROUNDS = 10_000;

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

function normalizedAddress(value) {
    return getAddress(value).toLowerCase();
}

function positiveRound(value, field) {
    const round = Number(value);
    if (!Number.isSafeInteger(round) || round <= 0) {
        throw new Error(`${field} must be a positive integer`);
    }
    return round;
}

function answerKey(oracle, round, publisher) {
    return `${normalizedAddress(oracle)}:${String(round)}:${normalizedAddress(publisher)}`;
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
        if (/\banswered 404\b/.test(error.message)) {
            return {__missing: true};
        }
        return {__mirrorError: error.message};
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
    if (result.__mirrorError) {
        say("contract result mirror query succeeded", false, result.__mirrorError);
        return {checks, state: "mirror-error"};
    }
    if (result.__missing) {
        const pending = now <= evidence.expiresAt;
        say(
            pending ? "answer is inside its broadcast window" : "answer expired without an EVM result",
            true,
            pending ? "pending" : "expired",
        );
        return {checks, state: pending ? "pending" : "expired"};
    }

    say("transaction succeeded", result.result === "SUCCESS", String(result.result));
    say(
        "transaction targets the evidenced oracle",
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
        submittedAt >= evidenceAt &&
            submittedAt - evidenceAt <= maximumDelaySeconds,
        `${submittedAt - evidenceAt} seconds`,
    );
    return {checks, state: checks.every((check) => check.pass) ? "verified" : "invalid"};
}

function normalizeHistory(oracle, oracleHistory, currentFromRound) {
    const currentAddress = normalizedAddress(oracle);
    const accepted = [{
        address: currentAddress,
        fromRound: positiveRound(currentFromRound, "currentFromRound"),
        toRound: null,
        current: true,
    }];
    const excluded = [];
    const seen = new Set([currentAddress]);
    for (const entry of oracleHistory ?? []) {
        const addressValue = typeof entry === "string" ? entry : entry?.address;
        if (!addressValue) throw new Error("historical oracle entry has no address");
        const address = normalizedAddress(addressValue);
        if (seen.has(address)) continue;
        seen.add(address);
        const fromValue = typeof entry === "object"
            ? entry.fromRound ?? entry.activationFromRound
            : null;
        const toValue = typeof entry === "object"
            ? entry.toRound ?? entry.activationThroughRound
            : null;
        if (fromValue === null || fromValue === undefined ||
            toValue === null || toValue === undefined) {
            excluded.push({
                address,
                reason: "historical oracle has no explicit activation range",
            });
            continue;
        }
        const fromRound = positiveRound(fromValue, "historical fromRound");
        const toRound = positiveRound(toValue, "historical toRound");
        if (toRound < fromRound) {
            throw new Error(`historical oracle ${address} has an inverted range`);
        }
        accepted.push({
            address,
            fromRound,
            toRound,
            current: false,
        });
    }
    return {accepted, excluded};
}

function evidenceScope(evidence, scopes) {
    const address = normalizedAddress(evidence.oracle);
    const round = positiveRound(evidence.round, "evidence round");
    const accepted = scopes.accepted.find((scope) => scope.address === address);
    if (accepted) {
        const inRange = round >= accepted.fromRound &&
            (accepted.toRound === null || round <= accepted.toRound);
        return inRange
            ? {accepted: true, current: accepted.current, scope: accepted}
            : {accepted: false, invalid: true, reason: "round is outside activation range"};
    }
    const excluded = scopes.excluded.find((scope) => scope.address === address);
    if (excluded) {
        return {accepted: false, excluded: true, reason: excluded.reason};
    }
    return {accepted: false, invalid: true, reason: "oracle is not configured"};
}

function normalizedPanelAnswer(answer) {
    return {
        price: BigInt(answer.price ?? answer[0]).toString(),
        rate: BigInt(answer.rate ?? answer[1]).toString(),
        by: normalizedAddress(answer.by ?? answer[2]),
    };
}

async function loadPanels(scopes, oracleReader, maximumPanelRounds) {
    const panels = new Map();
    const errors = [];
    if (!oracleReader ||
        typeof oracleReader.openRound !== "function" ||
        typeof oracleReader.panelOf !== "function") {
        return {
            panels,
            errors: [{oracle: null, round: null, message: "oracle panel reader is required"}],
        };
    }
    let queried = 0;
    for (const scope of scopes.accepted) {
        let through = scope.toRound;
        if (scope.current) {
            try {
                through = positiveRound(
                    await oracleReader.openRound(scope.address),
                    "openRound",
                );
            } catch (error) {
                errors.push({
                    oracle: scope.address,
                    round: null,
                    message: `openRound failed: ${error.message}`,
                });
                continue;
            }
        }
        if (through < scope.fromRound) continue;
        const count = through - scope.fromRound + 1;
        if (queried + count > maximumPanelRounds) {
            errors.push({
                oracle: scope.address,
                round: null,
                message: `panel range exceeds ${maximumPanelRounds} rounds`,
            });
            continue;
        }
        queried += count;
        for (let round = scope.fromRound; round <= through; round++) {
            const key = `${scope.address}:${round}`;
            try {
                const panel = await oracleReader.panelOf(scope.address, round);
                panels.set(key, (panel ?? []).map(normalizedPanelAnswer));
            } catch (error) {
                errors.push({
                    oracle: scope.address,
                    round,
                    message: `panelOf failed: ${error.message}`,
                });
            }
        }
    }
    return {panels, errors};
}

function emptyResult(topic, fields = {}) {
    return {
        topicId: topic.topicId,
        publisher: topic.publisher,
        messages: 0,
        verified: 0,
        currentVerified: 0,
        historicalVerified: 0,
        pending: 0,
        expired: 0,
        statuses: 0,
        excluded: 0,
        invalid: 0,
        missingPanelEvidence: 0,
        mirrorErrors: 0,
        panelErrors: 0,
        panelAnswers: 0,
        records: [],
        missing: [],
        errors: [],
        ...fields,
    };
}

export async function verifyEvidenceTopic({
    mirrorUrl,
    topic,
    oracle,
    oracleHistory = [],
    currentFromRound = 1,
    chainId,
    oracleAbi,
    oracleReader,
    now = Math.floor(Date.now() / 1000),
    maximumDelaySeconds = 900,
    maximumPanelRounds = DEFAULT_MAXIMUM_PANEL_ROUNDS,
    pagedFn = paged,
    contractResultFn = contractResult,
}) {
    const iface = oracleAbi instanceof Interface ? oracleAbi : new Interface(oracleAbi);
    let scopes;
    try {
        scopes = normalizeHistory(oracle, oracleHistory, currentFromRound);
    } catch (error) {
        return emptyResult(topic, {
            invalid: 1,
            errors: [{type: "configuration", message: error.message}],
        });
    }

    const panelState = await loadPanels(
        scopes,
        oracleReader,
        Number(maximumPanelRounds),
    );
    const path = `/api/v1/topics/${topic.topicId}/messages?order=asc&limit=100`;
    let messages;
    try {
        messages = await pagedFn(mirrorUrl, path, "messages", {pages: 100});
    } catch (error) {
        return emptyResult(topic, {
            mirrorErrors: 1,
            panelErrors: panelState.errors.length,
            errors: [
                ...panelState.errors.map((row) => ({type: "panel", ...row})),
                {type: "mirror", message: error.message},
            ],
        });
    }

    const records = [];
    let previous = null;
    const seenTransactions = new Set();
    const evidenceByAnswer = new Map();

    for (const message of messages) {
        const sequenceNumber = String(message.sequence_number);
        const text = Buffer.from(message.message, "base64").toString("utf8");
        const rawHash = evidenceHash(text);
        let evidence;
        const checks = [];
        try {
            evidence = decodeOracleMessage(text);
            checks.push({name: "message is canonical evidence", pass: true, detail: rawHash});
        } catch (error) {
            records.push({
                sequenceNumber,
                consensusTimestamp: message.consensus_timestamp,
                state: "invalid",
                checks: [{name: "message is canonical evidence", pass: false, detail: error.message}],
            });
            previous = rawHash;
            continue;
        }
        checks.push({
            name: "chain ID matches deployment",
            pass: evidence.chain === Number(chainId),
            detail: String(evidence.chain),
        });
        const scope = evidenceScope(evidence, scopes);
        checks.push({
            name: "oracle is active for the evidenced round",
            pass: scope.accepted || scope.excluded,
            detail: scope.reason ?? evidence.oracle,
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
        previous = rawHash;

        if (scope.excluded) {
            const failed = checks.some((check) => !check.pass);
            records.push({
                sequenceNumber,
                consensusTimestamp: message.consensus_timestamp,
                evidence,
                state: failed ? "invalid" : "excluded",
                scope,
                checks,
            });
            continue;
        }
        if (scope.invalid) {
            records.push({
                sequenceNumber,
                consensusTimestamp: message.consensus_timestamp,
                evidence,
                state: "invalid",
                scope,
                checks,
            });
            continue;
        }
        if (evidence.k === STATUS_KIND) {
            const failed = checks.some((check) => !check.pass);
            records.push({
                sequenceNumber,
                consensusTimestamp: message.consensus_timestamp,
                evidence,
                state: failed ? "invalid" : "status",
                scope,
                checks,
            });
            continue;
        }
        if (evidence.k !== EVIDENCE_KIND) {
            checks.push({name: "message kind is supported", pass: false, detail: evidence.k});
            records.push({
                sequenceNumber,
                consensusTimestamp: message.consensus_timestamp,
                evidence,
                state: "invalid",
                scope,
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
        const result = await contractResultFn(mirrorUrl, evidence.tx);
        const transaction = checkTransaction(evidence, message, result, {
            iface,
            oracle: evidence.oracle,
            publisher: topic.publisher.evmAddress,
            publisherAccountId: topic.publisher.accountId,
            maximumDelaySeconds,
            now,
        });
        checks.push(...transaction.checks);

        const key = answerKey(evidence.oracle, evidence.round, evidence.publisher);
        if (!evidenceByAnswer.has(key)) evidenceByAnswer.set(key, []);
        evidenceByAnswer.get(key).push(evidence);
        let state = transaction.state;
        if (transaction.state === "verified") {
            const panelKey = `${normalizedAddress(evidence.oracle)}:${evidence.round}`;
            const panel = panelState.panels.get(panelKey);
            const panelError = panelState.errors.find((row) =>
                row.oracle === normalizedAddress(evidence.oracle) &&
                (row.round === null || String(row.round) === evidence.round),
            );
            if (panelError) {
                checks.push({
                    name: "oracle panel was readable",
                    pass: false,
                    detail: panelError.message,
                });
            } else {
                const answer = panel?.find((row) =>
                    sameAddress(row.by, evidence.publisher),
                );
                checks.push({
                    name: "publisher answer exists in panelOf",
                    pass: Boolean(answer),
                    detail: answer ? `${answer.price}:${answer.rate}` : "missing",
                });
                if (answer) {
                    checks.push({
                        name: "panel clean price equals evidence",
                        pass: answer.price === evidence.price,
                        detail: answer.price,
                    });
                    checks.push({
                        name: "panel reference rate equals evidence",
                        pass: answer.rate === evidence.rate,
                        detail: answer.rate,
                    });
                }
            }
            if (checks.some((check) => !check.pass)) state = "invalid";
        } else if (checks.some((check) => !check.pass) &&
            transaction.state !== "mirror-error") {
            state = "invalid";
        }
        records.push({
            sequenceNumber,
            consensusTimestamp: message.consensus_timestamp,
            evidence,
            state,
            scope,
            checks,
            mirrorError: transaction.state === "mirror-error",
        });
    }

    const missing = [];
    let panelAnswers = 0;
    for (const [key, panel] of panelState.panels) {
        const [oracleAddress, round] = key.split(":");
        for (const answer of panel) {
            if (!sameAddress(answer.by, topic.publisher.evmAddress)) continue;
            panelAnswers += 1;
            const keyForPublisher = answerKey(
                oracleAddress,
                round,
                topic.publisher.evmAddress,
            );
            const candidates = evidenceByAnswer.get(keyForPublisher) ?? [];
            const match = candidates.some((evidence) =>
                evidence.price === answer.price && evidence.rate === answer.rate,
            );
            if (!match) {
                missing.push({
                    state: "missing-panel-evidence",
                    oracle: oracleAddress,
                    round,
                    publisher: normalizedAddress(topic.publisher.evmAddress),
                    price: answer.price,
                    rate: answer.rate,
                });
            }
        }
    }

    return {
        topicId: topic.topicId,
        publisher: topic.publisher,
        messages: messages.length,
        verified: records.filter((record) => record.state === "verified").length,
        currentVerified: records.filter((record) =>
            record.state === "verified" && record.scope?.current).length,
        historicalVerified: records.filter((record) =>
            record.state === "verified" && !record.scope?.current).length,
        pending: records.filter((record) => record.state === "pending").length,
        expired: records.filter((record) => record.state === "expired").length,
        statuses: records.filter((record) => record.state === "status").length,
        excluded: records.filter((record) => record.state === "excluded").length,
        invalid: records.filter((record) => record.state === "invalid").length,
        missingPanelEvidence: missing.length,
        mirrorErrors: records.filter((record) => record.mirrorError).length,
        panelErrors: panelState.errors.length,
        panelAnswers,
        records,
        missing,
        errors: panelState.errors.map((row) => ({type: "panel", ...row})),
    };
}
