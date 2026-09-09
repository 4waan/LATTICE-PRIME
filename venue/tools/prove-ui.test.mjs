import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

const template = readFileSync(new URL("../app/prove.template.html", import.meta.url), "utf8");
const runtime = readFileSync(new URL("./venue-app.mjs", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/app.css", import.meta.url), "utf8");
const wallet = "0x00000000000000000000000000000000000000aa";

function renderSignals({viewer = wallet, proof = {}, snap = {}} = {}) {
    const elements = {
        pins: {className: "pins-slot", innerHTML: ""},
        uses: {textContent: ""},
    };
    const pub = [91n, 1n, 42n, 8n, BigInt(wallet), 2n, 3n];
    for (const [index, value] of Object.entries(proof)) pub[Number(index)] = BigInt(value);
    const Venue = {
        proof: {pub},
        snap: {
            kycEpoch: 8n,
            root: 42n,
            minTier: 2n,
            mask: 3n,
            maxUses: 3,
            ...snap,
        },
        viewer: () => viewer,
        stillViewer: () => true,
        c: {registry: {usesThisEpoch: () => Promise.resolve(0n)}},
    };
    const sigStart = runtime.indexOf("const SIGS =");
    const sigEnd = runtime.indexOf("const REPO_STATE", sigStart);
    const paintStart = runtime.indexOf("Venue.paintPins = function");
    const paintEnd = runtime.indexOf("\nVenue.explainGate", paintStart);
    assert.ok(sigStart >= 0 && sigEnd > sigStart, "signal metadata source should be extractable");
    assert.ok(paintStart >= 0 && paintEnd > paintStart, "signal renderer source should be extractable");
    runInNewContext(
        runtime.slice(sigStart, sigEnd) + runtime.slice(paintStart, paintEnd),
        {
            Venue,
            $: (id) => elements[id],
            asBig: (value) => typeof value === "bigint" ? value : BigInt(value),
            toHexWord: (value) => "0x" + BigInt(value).toString(16).padStart(64, "0"),
            esc: (value) => String(value).replace(/[&<>"']/g, (char) => ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
            })[char]),
        },
    );
    Venue.paintPins();
    return elements.pins;
}

test("eligibility introduction explains privacy and wallet binding", () => {
    assert.match(
        template,
        /Confirm eligibility for this KYC period while keeping the underlying credential private\./,
    );
    assert.match(template, /binds access to your connected wallet\./);
    assert.match(
        template,
        /Load a proof for the connected wallet, compare it with the venue's current requirements, then request access/,
    );
    assert.match(template, />Request access<\/button>/);
    assert.doesNotMatch(template, />Register<\/button>/);
});

test("eligibility presents proof checks in plain language", () => {
    const sigs = runtime.match(/const SIGS = \[[\s\S]*?\n\];/)?.[0];
    assert.ok(sigs, "signal metadata should be present");
    for (const label of [
        "Reuse limit",
        "Proof result",
        "Credential list",
        "KYC period",
        "Connected wallet",
        "Access tier",
        "Region policy",
    ]) {
        assert.match(sigs, new RegExp('label: "' + label + '"'));
    }
    assert.doesNotMatch(
        sigs,
        /\b(?:nullifier|passes|credentialRoot|registrant|minTier|jurisdictionMask)\b/,
    );
    assert.doesNotMatch(
        sigs,
        /\b(?:usesThisEpoch|rootForEpoch|currentEpoch|minTier|jurisdictionMask)\s*\(/,
    );
    assert.doesNotMatch(
        template,
        />\s*(?:minTier|credentialRoot|jurisdictionMask|rootForEpoch|currentEpoch)\s*</,
    );
});

test("public signals render as an accessible responsive checklist", () => {
    for (const status of [
        "Matched",
        "Needs attention",
        "Waiting for wallet",
        "Checked by the gate",
    ]) {
        assert.match(runtime, new RegExp('"' + status + '"'));
    }
    assert.match(runtime, /class="signal-verdict /);
    assert.match(runtime, /class="signal-value-label">Current requirement/);
    assert.match(runtime, /class="signal-summary /);
    assert.match(css, /\.signal-check\{/);
    assert.match(css, /\.signal-verdict\.ok\{/);
    assert.match(css, /@media\(max-width:560px\)\{[\s\S]*?\.signal-values\{grid-template-columns:minmax\(0,1fr\)\}/);
    assert.doesNotMatch(css, /\.pin\.head\{/);
});

test("signal checklist distinguishes aligned, mismatched, and disconnected states", () => {
    const aligned = renderSignals();
    assert.equal(aligned.className, "signal-checklist");
    assert.match(aligned.innerHTML, /Proof matches current requirements/);
    assert.equal((aligned.innerHTML.match(/>Matched</g) || []).length, 6);
    assert.match(aligned.innerHTML, />Checked by the gate</);

    const mismatched = renderSignals({proof: {5: 9n}});
    assert.match(mismatched.innerHTML, /1 check needs attention/);
    assert.match(mismatched.innerHTML, />Needs attention</);
    assert.match(mismatched.innerHTML, /signal-check is-no/);

    const disconnected = renderSignals({viewer: null});
    assert.match(disconnected.innerHTML, /Comparison needs more information/);
    assert.match(disconnected.innerHTML, />Waiting for wallet</);
    assert.match(disconnected.innerHTML, /signal-check is-pending/);
});
