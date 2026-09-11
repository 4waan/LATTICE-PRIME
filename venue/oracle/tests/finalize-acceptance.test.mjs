import assert from "node:assert/strict";
import test from "node:test";
import {monitoringCoverage} from "../finalize-acceptance.mjs";

function monitor(after = {}) {
    return {
        pollSeconds: 300,
        heartbeatSeconds: 21_600,
        observations: [
            {
                observedAt: 1_000,
                round: 3,
                publishedAt: 500,
                ourLegDark: false,
                cashLegDark: false,
            },
            {
                observedAt: 5_000,
                round: 3,
                publishedAt: 500,
                ourLegDark: false,
                cashLegDark: false,
                ...after,
            },
        ],
    };
}

test("a monitor suspension is covered by one unchanged unexpired round", () => {
    const result = monitoringCoverage(monitor());
    assert.equal(result.maximumGapSeconds, 4_000);
    assert.equal(result.longGaps.length, 1);
    assert.equal(result.longGaps[0].deterministicPanelCoverage, true);
    assert.equal(result.allLongGapsAccountedFor, true);
});

test("a monitor suspension past heartbeat expiry fails coverage", () => {
    const input = monitor({observedAt: 22_101});
    const result = monitoringCoverage(input);
    assert.equal(result.longGaps[0].expiresAt, 22_100);
    assert.equal(result.longGaps[0].deterministicPanelCoverage, false);
    assert.equal(result.allLongGapsAccountedFor, false);
});

test("a round transition inside a monitor suspension fails coverage", () => {
    const result = monitoringCoverage(monitor({round: 4, publishedAt: 4_900}));
    assert.equal(result.longGaps[0].deterministicPanelCoverage, false);
    assert.equal(result.allLongGapsAccountedFor, false);
});
