import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {agentOrderInput} from "./agent-ui.mjs";

const ROOT = new URL("../", import.meta.url);

test("Markets agent controls bind only the validated buy ticket", () => {
    assert.deepEqual(
        agentOrderInput({
            readOrder: () => ({
                side: 0,
                price: 119n,
                qty: 10n,
                bad: {price: false, qty: false, salt: true},
            }),
        }),
        {limitPrice: "119", quantity: "10"}
    );
    assert.throws(
        () => agentOrderInput({
            readOrder: () => ({
                side: 1,
                price: 119n,
                qty: 10n,
                bad: {},
            }),
        }),
        /buy orders only/
    );
    assert.throws(
        () => agentOrderInput({
            readOrder: () => ({
                side: 0,
                price: 0n,
                qty: 0n,
                bad: {price: true, qty: true},
            }),
        }),
        /valid buy price/
    );
});

test("dormant agent modules stay private and are not wired into Lattice Prime", async () => {
    const [
        bridge,
        controls,
        receipts,
        markets,
        portfolio,
    ] = await Promise.all([
        readFile(new URL("tools/agent-client.mjs", ROOT), "utf8"),
        readFile(new URL("tools/agent-ui.mjs", ROOT), "utf8"),
        readFile(new URL("tools/agent-receipts-ui.mjs", ROOT), "utf8"),
        readFile(new URL("app/trade.template.html", ROOT), "utf8"),
        readFile(new URL("app/position.template.html", ROOT), "utf8"),
    ]);
    const localSources = `${bridge}\n${controls}\n${receipts}`;
    assert.doesNotMatch(localSources, /localStorage|sessionStorage/);
    assert.doesNotMatch(localSources, /console\./);
    assert.doesNotMatch(receipts, /innerHTML/);
    assert.doesNotMatch(markets, /id="agent-workspace"/);
    assert.doesNotMatch(markets, /INLINE tools\/agent-(?:client|ui)\.mjs/);
    assert.doesNotMatch(portfolio, /id="agent-receipts"/);
    assert.doesNotMatch(portfolio, /INLINE tools\/agent-(?:client|receipts-ui)\.mjs/);
    assert.doesNotMatch(markets, /fonts\.googleapis/);
    assert.doesNotMatch(portfolio, /fonts\.googleapis/);
});
