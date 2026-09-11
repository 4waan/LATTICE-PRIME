const SOURCE_CHANGE_FIELDS = [
    "terms",
    "sofr",
    "hbarNetwork",
    "hbarMarket",
    "auction",
    "dealers",
];

function publisherOf(record) {
    return String(record?.evidence?.publisher ?? "").toLowerCase();
}

function roundOf(record) {
    const round = Number(record?.evidence?.round);
    return Number.isSafeInteger(round) && round > 0 ? round : null;
}

function sourceIdentity(evidence, field) {
    const source = evidence?.sources?.[field];
    if (!source) return null;
    return {
        observedAt: Number(source.observedAt),
        identity: String(source.identity).toLowerCase(),
    };
}

function changedFields(previous, current) {
    return SOURCE_CHANGE_FIELDS.filter((field) => {
        const before = sourceIdentity(previous, field);
        const after = sourceIdentity(current, field);
        if (!before && !after) return false;
        return before?.identity !== after?.identity;
    });
}

function triggerProvesChange(trigger, fields) {
    if (trigger === "NEW_SOFR") return fields.includes("sofr");
    if (trigger === "NEW_AUCTION_PRINT") return fields.includes("auction");
    if (trigger === "PRICE_MOVE") return fields.length > 0;
    return false;
}

function expandedAnswer(record) {
    const evidence = record?.evidence;
    return record?.state === "verified" &&
        record?.scope?.current &&
        evidence?.k === "oracle-answer" &&
        evidence?.algorithmVersion &&
        evidence?.configurationDigest &&
        evidence?.sources;
}

export function evaluateSourceDrivenRounds(
    results,
    {
        initialRound,
        quorum,
    },
) {
    const required = Number(quorum);
    if (!Number.isSafeInteger(required) || required <= 0) {
        throw new Error("quorum must be a positive integer");
    }
    const records = results
        .flatMap((result) => result.records ?? [])
        .filter(expandedAnswer)
        .sort((left, right) => roundOf(left) - roundOf(right));
    const history = new Map();
    const rounds = new Map();
    for (const record of records) {
        const publisher = publisherOf(record);
        const round = roundOf(record);
        if (!publisher || round === null) continue;
        if (!history.has(publisher)) history.set(publisher, []);
        history.get(publisher).push(record);
        if (!rounds.has(round)) rounds.set(round, []);
        rounds.get(round).push(record);
    }

    const qualified = [];
    const evaluated = [];
    for (const round of [...rounds.keys()].sort((left, right) => left - right)) {
        if (round <= Number(initialRound)) continue;
        const contributors = [];
        const seen = new Set();
        for (const record of rounds.get(round)) {
            const publisher = publisherOf(record);
            if (seen.has(publisher)) continue;
            seen.add(publisher);
            const previous = (history.get(publisher) ?? [])
                .filter((candidate) => roundOf(candidate) < round)
                .at(-1);
            const fields = previous
                ? changedFields(previous.evidence, record.evidence)
                : [];
            const trigger = record.evidence.trigger ?? null;
            contributors.push({
                publisher,
                trigger,
                previousRound: previous ? roundOf(previous) : null,
                changedFields: fields,
                provesNewSource: Boolean(
                    previous && triggerProvesChange(trigger, fields),
                ),
                configurationDigest: record.evidence.configurationDigest,
            });
        }
        const proving = contributors.filter((row) => row.provesNewSource);
        const configurationDigests = [
            ...new Set(proving.map((row) => row.configurationDigest)),
        ];
        const detail = {
            round,
            verifiedPublishers: contributors.length,
            sourceDrivenPublishers: proving.length,
            distinctConfigurationDigests: configurationDigests.length,
            contributors,
            qualified: proving.length >= required,
        };
        evaluated.push(detail);
        if (detail.qualified) qualified.push(detail);
    }
    return {
        quorum: required,
        evaluated,
        qualified,
        passed: qualified.length > 0,
    };
}
