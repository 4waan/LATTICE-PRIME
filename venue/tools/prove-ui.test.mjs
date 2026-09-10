import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

const template = readFileSync(new URL("../app/prove.template.html", import.meta.url), "utf8");
const runtime = readFileSync(new URL("./venue-app.mjs", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/app.css", import.meta.url), "utf8");
const wallet = "0x00000000000000000000000000000000000000aa";

function renderAction({
    account = null,
    granted = 0,
    proof = null,
    busy = false,
    stage = null,
} = {}) {
    const action = {
        textContent: "",
        disabled: false,
        dataset: {},
        attributes: {},
        classList: {add() {}},
        setAttribute(name, value) {
            this.attributes[name] = String(value);
        },
    };
    const card = {dataset: {}};
    const Venue = {
        account,
        proof,
        snap: {kyc: granted},
        _eligibilityBusy: busy,
        _eligibilityStage: stage,
    };
    const start = runtime.indexOf("Venue.paintEligibilityAction = function");
    const end = runtime.indexOf("\nVenue.toast", start);
    assert.ok(start >= 0 && end > start, "eligibility action painter should be extractable");
    runInNewContext(runtime.slice(start, end), {
        Venue,
        $: (id) => ({["eligibility-action"]: action, ["kyc-banner"]: card})[id],
    });
    Venue.paintEligibilityAction();
    return {action, card};
}

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

test("eligibility presents one centered private-access action", () => {
    assert.match(template, /class="wrap page eligibility-page"/);
    assert.match(template, /class="eligibility-card"/);
    assert.match(template, /id="eligibility-action"/);
    assert.match(template, />Connect wallet<\/button>/);
    assert.match(template, /Confirm eligibility for this KYC period/);
    assert.match(template, /stays on this device and is checked securely/);
    assert.doesNotMatch(template, /checked automatically/);
    assert.match(template, /Your credential details stay private/);
    assert.match(template, />Technical details and recovery<\/summary>/);
    assert.equal((template.match(/id="eligibility-action"/g) || []).length, 1);
    const card = template.slice(
        template.indexOf('<section class="eligibility-card"'),
        template.indexOf('<details class="lab eligibility-details"'),
    );
    assert.equal((card.match(/<button\b/g) || []).length, 1);
    assert.doesNotMatch(card, /\bproof\b/i);
    for (const removed of ["demo-proof", "check", "register", "open-lab", "kyc-act"]) {
        assert.doesNotMatch(template, new RegExp('id="' + removed + '"'));
    }
    assert.match(css, /\.eligibility-page\{/);
    assert.match(css, /\.eligibility-card\{/);
    assert.match(css, /:root\[data-theme="dark"\] \.eligibility-card\{/);
    const cardStyles = css.slice(
        css.indexOf(".eligibility-page .eligibility-card{"),
        css.indexOf(".eligibility-mark{"),
    );
    assert.match(cardStyles, /padding:clamp\(4rem/);
    assert.match(cardStyles, /background:var\(--surface\)/);
    assert.match(cardStyles, /background:#252b3b/);
    assert.match(cardStyles, /rgba\(130,89,239,.32\)/);
    assert.doesNotMatch(cardStyles, /radial-gradient/);
    assert.match(
        css,
        /\.eligibility-mark\{[\s\S]*?top:0;left:50%[\s\S]*?transform:translate\(-50%,-50%\)/,
    );
    assert.match(
        css,
        /\.eligibility-page \.eligibility-details\{width:min\(100%,42rem\);margin:1\.2rem auto 0\}/,
    );
    assert.match(
        css,
        /\.eligibility-page button\.eligibility-action\{[\s\S]*?background:var\(--grad\)/,
    );
    assert.match(runtime, /let status = "Confirm eligibility for this KYC period"/);
});

test("the one action covers disconnected, ready, busy, and granted states", () => {
    const disconnected = renderAction();
    assert.equal(disconnected.action.textContent, "Connect wallet");
    assert.equal(disconnected.action.dataset.action, "connect");
    assert.equal(disconnected.card.dataset.state, "disconnected");

    const recovery = renderAction({account: wallet});
    assert.equal(recovery.action.textContent, "Restore access file");
    assert.equal(recovery.action.dataset.action, "recover");

    const ready = renderAction({account: wallet, proof: {proof: [], pub: []}});
    assert.equal(ready.action.textContent, "Confirm private access");
    assert.equal(ready.action.dataset.action, "confirm");

    const busy = renderAction({
        account: wallet,
        proof: {proof: [], pub: []},
        busy: true,
        stage: "submitting",
    });
    assert.equal(busy.action.textContent, "Securing access");
    assert.equal(busy.action.disabled, true);
    assert.equal(busy.action.attributes["aria-busy"], "true");
    assert.equal(busy.card.dataset.state, "busy");

    const granted = renderAction({account: wallet, granted: 1});
    assert.equal(granted.action.textContent, "Open Markets");
    assert.equal(granted.action.dataset.action, "trade");
    assert.equal(granted.card.dataset.state, "granted");
});

test("confirmation preflights and uses only the sponsored same-origin endpoint", () => {
    assert.match(runtime, /const ELIGIBILITY_RELAY_PATH = "\/api\/eligibility\/register"/);
    assert.match(runtime, /Venue\.preflightEligibility/);
    assert.match(runtime, /Venue\.submitSponsoredEligibility/);
    assert.match(runtime, /Venue\.waitForEligibility/);
    assert.match(runtime, /Venue\.ensureEligibility/);
    assert.match(runtime, /Venue\.proofProviders = \[/);
    assert.match(runtime, /name: "bundled"/);
    assert.match(runtime, /name: "device"/);
    assert.doesNotMatch(runtime, /Venue\.w\.gate\.register\(/);
});

test("one confirmation runs lookup, preflight, sponsor, and grant polling in order", async () => {
    const calls = [];
    const elements = {
        ["kyc-copy"]: {textContent: ""},
        ["prove-lab"]: {open: false},
    };
    const Venue = {
        account: wallet,
        proof: {
            address: wallet,
            proof: Array(24).fill("1"),
            pub: Array(7).fill("1"),
        },
        snap: {kyc: 0},
        _eligibilityBusy: false,
        c: {
            registry: {
                async getKycStatus() {
                    calls.push("status");
                    return 0;
                },
            },
        },
        async requireAccount() { calls.push("account"); },
        async hydrateProof() { calls.push("proof"); },
        async preflightEligibility() {
            calls.push("preflight");
            return [true, ""];
        },
        async submitSponsoredEligibility() {
            calls.push("sponsor");
            return {status: "submitted", txHash: "0x" + "11".repeat(32)};
        },
        async waitForEligibility() {
            calls.push("poll");
            return true;
        },
        stillViewer: () => true,
        paintPins() {},
        paintEligibilityAction() {},
        setEligibilityStage(stage) {
            calls.push("stage:" + stage);
            this._eligibilityStage = stage;
        },
        status(id, message, kind) {
            calls.push("result:" + kind);
            this.result = {id, message, kind};
        },
    };
    const start = runtime.indexOf("Venue.ensureEligibility = async function");
    const end = runtime.indexOf("\nVenue.mountTrade", start);
    assert.ok(start >= 0 && end > start, "eligibility controller should be extractable");
    runInNewContext(runtime.slice(start, end), {
        Venue,
        $: (id) => elements[id],
        Error,
    });

    await Venue.ensureEligibility();
    assert.deepEqual(calls, [
        "account",
        "status",
        "stage:checking",
        "proof",
        "preflight",
        "stage:submitting",
        "sponsor",
        "stage:confirming",
        "poll",
        "result:ok",
    ]);
    assert.equal(Venue.snap.kyc, 1);
    assert.equal(Venue._eligibilityBusy, false);
    assert.equal(Venue.result.message, "Access confirmed. The venue paid the registration cost.");
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
