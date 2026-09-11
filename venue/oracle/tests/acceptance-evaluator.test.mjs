import {test} from "node:test";
import assert from "node:assert/strict";
import {evaluateSourceDrivenRounds} from "../lib/acceptance-evaluator.mjs";

const publisherA = "0x00000000000000000000000000000000000000a1";
const publisherB = "0x00000000000000000000000000000000000000b2";

function answer({
    publisher,
    round,
    trigger = null,
    sofr = `sofr-${round}`,
    dealer = `dealer-${round}`,
    configurationDigest = `config-${publisher}`,
}) {
    const source = (identity) => ({
        observedAt: round * 100,
        identity,
    });
    return {
        state: "verified",
        scope: {current: true},
        evidence: {
            k: "oracle-answer",
            publisher,
            round: String(round),
            trigger,
            algorithmVersion: "hybrid-vwap-usd8-v1",
            configurationDigest,
            sources: {
                terms: source("terms"),
                sofr: source(sofr),
                hbarNetwork: source("network"),
                hbarMarket: source("market"),
                auction: null,
                dealers: source(dealer),
                model: source(`model-${round}`),
            },
        },
    };
}

test("acceptance requires quorum evidence of a real trigger-specific source change", () => {
    const results = [{
        records: [
            answer({publisher: publisherA, round: 3}),
            answer({publisher: publisherB, round: 3}),
            answer({publisher: publisherA, round: 4, trigger: "NEW_SOFR"}),
            answer({publisher: publisherB, round: 4, trigger: "NEW_SOFR"}),
        ],
    }];
    const evaluated = evaluateSourceDrivenRounds(results, {
        initialRound: 2,
        quorum: 2,
    });
    assert.equal(evaluated.passed, true);
    assert.equal(evaluated.qualified.length, 1);
    assert.equal(evaluated.qualified[0].round, 4);
    assert.equal(evaluated.qualified[0].distinctConfigurationDigests, 2);
    assert.deepEqual(
        evaluated.qualified[0].contributors.map((row) => row.changedFields),
        [["sofr", "dealers"], ["sofr", "dealers"]],
    );
});

test("a NEW_SOFR label cannot pass when only the rotating dealer changed", () => {
    const results = [{
        records: [
            answer({publisher: publisherA, round: 3, sofr: "same"}),
            answer({publisher: publisherB, round: 3, sofr: "same"}),
            answer({
                publisher: publisherA,
                round: 4,
                trigger: "NEW_SOFR",
                sofr: "same",
            }),
            answer({
                publisher: publisherB,
                round: 4,
                trigger: "NEW_SOFR",
                sofr: "same",
            }),
        ],
    }];
    const evaluated = evaluateSourceDrivenRounds(results, {
        initialRound: 2,
        quorum: 2,
    });
    assert.equal(evaluated.passed, false);
    assert.equal(evaluated.evaluated[1].sourceDrivenPublishers, 0);
});
