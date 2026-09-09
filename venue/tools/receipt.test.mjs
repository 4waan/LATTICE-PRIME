import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const template = readFileSync(
    new URL("../docs/receipt.template.html", import.meta.url),
    "utf8",
);
const client = JSON.parse(
    readFileSync(new URL("../deployments/client.json", import.meta.url), "utf8"),
);

test("receipt copy matches the deployed row 15 budget", () => {
    assert.equal(client.disclosure.row15.budgetBits, 1);
    assert.match(template, /deployed budget is one bit per epoch/i);
    assert.match(template, /second valid cancellation completes without its venue event/i);
    assert.match(template, /budgetBits: 1/);
});

test("stale four-cancellation copy cannot return", () => {
    assert.doesNotMatch(template, /three bits per epoch/i);
    assert.doesNotMatch(template, /fourth cancellation/i);
    assert.doesNotMatch(template, /four-cancellation/i);
    assert.doesNotMatch(template, /cancel\(bytes32\)<\/b> four times/i);
});
