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
    assert.match(runtime, /Venue\.eligibilityCopy = function/);
    assert.match(runtime, /return "Confirm eligibility for this KYC period"/);
    assert.match(
        css,
        /\.eligibility-card\[data-state="error"\] \.eligibility-mark,\n\.eligibility-card\[data-state="ineligible"\] \.eligibility-mark\{/,
    );
});

test("the one action covers disconnected, ready, busy, and granted states", () => {
    const disconnected = renderAction();
    assert.equal(disconnected.action.textContent, "Connect wallet");
    assert.equal(disconnected.action.dataset.action, "connect");
    assert.equal(disconnected.card.dataset.state, "disconnected");

    const recovery = renderAction({account: wallet});
    assert.equal(recovery.action.textContent, "Restore access file");
    assert.equal(recovery.action.dataset.action, "recover");

    const ineligible = renderAction({account: wallet, stage: "ineligible"});
    assert.equal(ineligible.action.textContent, "Restore access file");
    assert.equal(ineligible.action.dataset.action, "recover");
    assert.equal(ineligible.card.dataset.state, "ineligible");

    const refused = renderAction({account: wallet, proof: {proof: [], pub: []}, stage: "ineligible"});
    assert.equal(refused.action.textContent, "Check access again");
    assert.equal(refused.action.dataset.action, "confirm");
    assert.equal(refused.card.dataset.state, "ineligible");

    const passed = renderAction({account: wallet, proof: {proof: [], pub: []}, stage: "passed"});
    assert.equal(passed.action.textContent, "Confirm private access");
    assert.equal(passed.action.dataset.action, "confirm");
    assert.equal(passed.card.dataset.state, "ready");

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
        paintEligibilityCopy() {},
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

function copyFor({account = wallet, watching = null, granted = 0, proof = null, stage = null} = {}) {
    const Venue = {
        account,
        proof,
        snap: {kyc: granted},
        _eligibilityStage: stage,
        viewer: () => account || watching || null,
    };
    const start = runtime.indexOf("Venue.eligibilityCopy = function");
    const end = runtime.indexOf("\nVenue.paintEligibilityCopy", start);
    assert.ok(start >= 0 && end > start, "eligibility copy table should be extractable");
    runInNewContext(runtime.slice(start, end), {Venue});
    return Venue.eligibilityCopy();
}

test("the headline follows the verdict instead of promising a check", () => {
    assert.equal(copyFor({account: null}), "Confirm eligibility for this KYC period");
    assert.equal(copyFor({granted: 1}), "Private access is confirmed for this period.");
    assert.equal(
        copyFor({account: null, watching: wallet}),
        "This account does not have private access for the current period.",
    );
    assert.equal(copyFor(), "Checking this wallet's access.");
    assert.equal(copyFor({proof: {}, stage: "checking"}), "Checking this wallet's access.");
    assert.equal(copyFor({stage: "ineligible"}), "This wallet is not eligible for the current period.");
    assert.equal(copyFor({proof: {}, stage: "ineligible"}), "This wallet is not eligible for the current period.");
    assert.equal(copyFor({stage: "error"}), "This wallet is not eligible for the current period.");
    assert.equal(copyFor({proof: {}}), "Confirm once. The venue checks and activates access automatically.");
    assert.equal(copyFor({proof: {}, stage: "error"}), "Confirm once. The venue checks and activates access automatically.");
    assert.equal(
        copyFor({proof: {}, stage: "passed"}),
        "Access check passed. Confirm once and the venue activates access for this period.",
    );
    assert.equal(copyFor({proof: {}, stage: "submitting"}), "Activating access for this period.");
    assert.equal(copyFor({proof: {}, stage: "confirming"}), "Activating access for this period.");
    // The one place the poll writes the headline goes through the table.
    const refresh = runtime.slice(
        runtime.indexOf("Venue.refreshProve = async function"),
        runtime.indexOf("\nVenue.onProofFile", runtime.indexOf("Venue.refreshProve = async function")),
    );
    assert.match(refresh, /Venue\.paintEligibilityCopy\(\)/);
    assert.doesNotMatch(refresh, /kyc-copy/);
    const clear = runtime.slice(
        runtime.indexOf("Venue.clearProveGrant = function"),
        runtime.indexOf("\nVenue.refreshProve", runtime.indexOf("Venue.clearProveGrant = function")),
    );
    assert.match(clear, /Venue\.paintEligibilityCopy\(\)/);
    assert.doesNotMatch(clear, /kyc-copy/);
});

function runCheck({proof, preflight, granted = 0, account = wallet, viewerAfter} = {}) {
    const calls = [];
    const Venue = {
        account,
        proof,
        snap: {kyc: granted},
        _eligibilityBusy: false,
        _eligibilityStage: null,
        _eligibilityCheck: null,
        viewer: () => account,
        stillViewer(who) {
            const now = viewerAfter === undefined ? account : viewerAfter;
            return !!now && now.toLowerCase() === who.toLowerCase();
        },
        async preflightEligibility() {
            calls.push("preflight");
            return preflight();
        },
        async submitSponsoredEligibility() { calls.push("sponsor"); },
        async waitForEligibility() { calls.push("poll"); },
        paintPins() {},
        paintEligibilityAction() { calls.push("paint"); },
        setEligibilityStage(stage, message, kind) {
            calls.push("stage:" + stage);
            this._eligibilityStage = stage;
            this.result = {message, kind};
            if (stage === "checking") this.checking = {message, kind};
        },
        explainGate: (reason) => "explained:" + reason,
    };
    const start = runtime.indexOf("Venue.checkEligibility = function");
    const end = runtime.indexOf("\nVenue.pickProof", start);
    assert.ok(start >= 0 && end > start, "automatic check should be extractable");
    runInNewContext(runtime.slice(start, end), {Venue});
    return {Venue, calls};
}

test("connecting runs a read-only access check and states the verdict", async () => {
    const bound = {address: wallet, proof: Array(24).fill("1"), pub: Array(7).fill("8")};

    const missing = runCheck({proof: null, preflight: () => [true, ""]});
    await missing.Venue.checkEligibility(wallet);
    assert.deepEqual(missing.calls, ["stage:ineligible"]);
    assert.equal(missing.Venue.result.kind, "bad");
    assert.match(missing.Venue.result.message, /no access file on record/);

    const passed = runCheck({proof: bound, preflight: () => [true, ""]});
    const pending = passed.Venue.checkEligibility(wallet);
    assert.equal(passed.Venue._eligibilityBusy, true);
    assert.equal(passed.Venue._eligibilityStage, "checking");
    await pending;
    assert.deepEqual(passed.calls, ["stage:checking", "preflight", "stage:passed"]);
    assert.equal(passed.Venue._eligibilityBusy, false);
    // The headline carries the verdict; the status line stays blank.
    assert.equal(passed.Venue.result.message, "");
    assert.equal(passed.Venue.checking.message, "");

    const refused = runCheck({proof: bound, preflight: () => [false, "wrong credential root"]});
    await refused.Venue.checkEligibility(wallet);
    assert.equal(refused.Venue._eligibilityStage, "ineligible");
    assert.equal(refused.Venue._eligibilityBusy, false);
    assert.equal(refused.Venue.result.message, "explained:wrong credential root");

    const flaky = runCheck({proof: bound, preflight: () => { throw new Error("timeout"); }});
    await flaky.Venue.checkEligibility(wallet);
    assert.equal(flaky.Venue._eligibilityStage, null);
    assert.equal(flaky.Venue._eligibilityBusy, false);
    assert.equal(flaky.Venue.result.message, "");

    const switched = runCheck({proof: bound, preflight: () => [true, ""], viewerAfter: "0x" + "bb".repeat(20)});
    switched.Venue._eligibilityBusy = false;
    await switched.Venue.checkEligibility(wallet);
    assert.deepEqual(switched.calls, ["stage:checking", "preflight"]);

    const granted = runCheck({proof: bound, preflight: () => [true, ""], granted: 1});
    await granted.Venue.checkEligibility(wallet);
    assert.deepEqual(granted.calls, ["paint"]);

    // Two callers for the same wallet and period share one gate read.
    let reads = 0;
    const twice = runCheck({proof: bound, preflight: () => { reads++; return [true, ""]; }});
    await Promise.all([twice.Venue.checkEligibility(wallet), twice.Venue.checkEligibility(wallet)]);
    assert.equal(reads, 1);
    assert.equal(twice.Venue._eligibilityCheck, null);

    for (const run of [missing, passed, refused, flaky, switched, granted, twice]) {
        assert.ok(!run.calls.includes("sponsor") && !run.calls.includes("poll"), "the check never registers");
    }
    const hydrate = runtime.slice(
        runtime.indexOf("Venue.hydrateProof = async function"),
        runtime.indexOf("\nVenue.checkEligibility", runtime.indexOf("Venue.hydrateProof = async function")),
    );
    assert.match(hydrate, /await Venue\.checkEligibility\(who\)/);
    assert.match(hydrate, /if \(Venue\._eligibilityBusy\) \{/);
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
