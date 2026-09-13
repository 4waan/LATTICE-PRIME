import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

const template = readFileSync(new URL("../app/trade.template.html", import.meta.url), "utf8");
const runtime = readFileSync(new URL("./venue-app.mjs", import.meta.url), "utf8");

const WALLET = "0x00000000000000000000000000000000000000aa";
const OTHER = "0x00000000000000000000000000000000000000bb";
const GATE = "0xbc80d92d6dd33be2e473eb9bb4f6a5c91061a808";
const FACTORY = "0x1111111111111111111111111111111111111111";
const ROOT = "182851654048";
const SIGNATURE = "0x" + "ab".repeat(65);
const NOW = 1_789_240_563n;
const CLIENT = {
    network: {chainId: 296},
    clocks: {kyc: {origin: "1784392392", period: "604800"}},
    privateTrading: {
        enabled: true,
        services: {credentials: "/api/private/credentials"},
        addresses: {DualRegistrationGate: GATE, SessionAccountFactory: FACTORY},
    },
};

// Objects built inside the vm context carry that context's prototypes, so
// compare them by value rather than by prototype identity.
const plain = (value) => JSON.parse(JSON.stringify(value));

function slice(startMarker, endMarker) {
    const start = runtime.indexOf(startMarker);
    const end = runtime.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `${startMarker} should be extractable`);
    return runtime.slice(start, end);
}

function constants() {
    const start = runtime.indexOf("const PRIVATE_CREDENTIAL_CLAIM_DOMAIN_NAME");
    const end = runtime.indexOf("\n};\n", start) + 4;
    assert.ok(start >= 0 && end > start, "claim constants should be extractable");
    return runtime.slice(start, end);
}

function claimHarness({
    account = WALLET,
    kyc = 1,
    chainKyc = 1,
    credential = {credentialRoot: ROOT, holderSecret: "1"},
    postError = null,
    signError = null,
    switchAccountDuring = null,
    client = CLIENT,
} = {}) {
    const calls = [];
    const Venue = {
        account,
        snap: {kyc: kyc === "unknown" ? undefined : kyc},
        _privateSecretPayload: {},
        _privateCredentialState: null,
        signer: {
            async signTypedData(domain, types, message) {
                calls.push("sign");
                Venue.signed = {domain, types, message};
                if (switchAccountDuring === "sign") Venue.account = OTHER;
                if (signError) throw signError;
                return SIGNATURE;
            },
        },
        c: {
            registry: {
                async getKycStatus() {
                    calls.push("chain-kyc");
                    return BigInt(chainKyc);
                },
            },
        },
        async requireAccount() {
            calls.push("account");
            if (!Venue.account) throw new Error("Connect a wallet first.");
        },
        async privatePost(path, body) {
            calls.push("post");
            Venue.posted = {path, body};
            if (switchAccountDuring === "post") Venue.account = OTHER;
            if (postError) throw new Error(postError);
            return {credential: {...credential, wallet: Venue.account}};
        },
        async adoptPrivateCredential(value, owner) {
            calls.push("adopt");
            Venue.adopted = {value, owner};
            Venue._privateSecretPayload = {credential: value.credential};
            return true;
        },
        paintPrivateSetup() {
            calls.push("paint");
        },
    };
    const source = constants() + "\n" + slice(
        "Venue.privatePeriodOpens = function",
        "\nVenue.importPrivateCredential",
    );
    runInNewContext(source, {
        Venue,
        CLIENT: client,
        nowSec: () => NOW,
        asBig: (v) => typeof v === "bigint" ? v : BigInt(v),
        addrEq: (a, b) => (a || "").toLowerCase() === (b || "").toLowerCase(),
        Error,
    });
    return {Venue, calls};
}

test("a granted wallet signs one claim, posts it, and adopts the credential", async () => {
    const {Venue, calls} = claimHarness();
    const outcome = await Venue.claimPrivateHolderCredential();
    assert.equal(outcome.ok, true);
    assert.deepEqual(calls, ["account", "paint", "sign", "post", "adopt"]);
    assert.deepEqual(plain(Venue.signed.domain), {
        name: "Lattice Prime Private Session",
        version: "1",
        chainId: 296,
        verifyingContract: GATE,
    });
    assert.deepEqual(plain(Venue.signed.types), {
        CredentialClaim: [
            {name: "account", type: "address"},
            {name: "factory", type: "address"},
            {name: "issuedAt", type: "uint64"},
        ],
    });
    assert.deepEqual(plain(Venue.signed.message), {
        account: WALLET,
        factory: FACTORY,
        issuedAt: NOW.toString(),
    });
    assert.equal(Venue.posted.path, "/api/private/credentials");
    assert.deepEqual(Object.keys(Venue.posted.body).sort(), [
        "account", "chainId", "factory", "gate", "issuedAt", "signature",
    ]);
    assert.deepEqual(plain(Venue.posted.body), {
        account: WALLET,
        chainId: "296",
        gate: GATE,
        factory: FACTORY,
        issuedAt: NOW.toString(),
        signature: SIGNATURE,
    });
    assert.equal(Venue.adopted.owner, WALLET);
    assert.equal(Venue.adopted.value.credential.credentialRoot, ROOT);
    assert.deepEqual(plain(Venue._privateCredentialState), {stage: "linked"});
    assert.equal(await Venue.ensurePrivateHolderCredential(), true, "already adopted");
    assert.deepEqual(calls.slice(5), [], "a held credential is not claimed again");
});

test("a wallet without a grant is sent to eligibility and never signs or posts", async () => {
    const known = claimHarness({kyc: 0});
    const outcome = await known.Venue.claimPrivateHolderCredential();
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "needs-eligibility");
    assert.deepEqual(known.calls, ["account"]);
    assert.equal(known.Venue._privateCredentialState.reason, "needs-eligibility");

    const unknown = claimHarness({kyc: "unknown", chainKyc: 0});
    const fallback = await unknown.Venue.claimPrivateHolderCredential();
    assert.equal(fallback.reason, "needs-eligibility");
    assert.deepEqual(unknown.calls, ["account", "chain-kyc"]);

    const granted = claimHarness({kyc: "unknown", chainKyc: 1});
    assert.equal((await granted.Venue.claimPrivateHolderCredential()).ok, true);
    assert.deepEqual(granted.calls, ["account", "chain-kyc", "paint", "sign", "post", "adopt"]);

    const noService = claimHarness({
        client: {...CLIENT, privateTrading: {...CLIENT.privateTrading, services: {}}},
    });
    assert.equal((await noService.Venue.claimPrivateHolderCredential()).reason, "no-service");
    assert.deepEqual(noService.calls, ["account"]);
});

test("service refusals map to reasons and dated copy without adopting anything", async () => {
    const refused = claimHarness({postError: "NOT_ELIGIBLE"});
    const outcome = await refused.Venue.claimPrivateHolderCredential();
    assert.equal(outcome.reason, "needs-eligibility");
    assert.deepEqual(refused.calls, ["account", "paint", "sign", "post"]);
    assert.deepEqual(refused.Venue._privateSecretPayload, {});

    const full = claimHarness({postError: "POOL_EXHAUSTED"});
    const wait = await full.Venue.claimPrivateHolderCredential();
    assert.equal(wait.reason, "pool-exhausted");
    assert.match(wait.message, /fully allocated\. New sessions open \d{1,2} [A-Z][a-z]{2} \d{2}:\d{2} UTC\./);
    // NOW sits in epoch 8 of the registry clock; the next boundary is epoch 9.
    assert.equal(wait.message.includes("19 Sep 16:33 UTC"), true);

    for (const [code, reason] of [
        ["CLAIM_STALE", "clock"],
        ["ROOT_NOT_ACTIVE", "root-not-active"],
        ["SIGNATURE_INVALID", "signature-invalid"],
        ["CLAIM_CONTEXT_INVALID", "context"],
        ["CHAIN_UNAVAILABLE", "service-unavailable"],
        ["Private service refused the request.", "service-unavailable"],
    ]) {
        const running = claimHarness({postError: code});
        assert.equal((await running.Venue.claimPrivateHolderCredential()).reason, reason, code);
        assert.equal(running.calls.includes("adopt"), false);
    }

    const declined = claimHarness({signError: Object.assign(new Error("denied"), {code: 4001})});
    assert.equal((await declined.Venue.claimPrivateHolderCredential()).reason, "signature-declined");
    assert.deepEqual(declined.calls, ["account", "paint", "sign"]);
    const failedSign = claimHarness({signError: new Error("hardware wallet timeout")});
    assert.equal((await failedSign.Venue.claimPrivateHolderCredential()).reason, "signature-failed");
});

test("root mismatch and wallet switches fail closed", async () => {
    const mismatch = claimHarness();
    const outcome = await mismatch.Venue.claimPrivateHolderCredential({expectedRoot: "7"});
    assert.equal(outcome.reason, "root-mismatch");
    assert.equal(mismatch.calls.includes("adopt"), false);
    const matched = claimHarness();
    assert.equal((await matched.Venue.claimPrivateHolderCredential({expectedRoot: ROOT})).ok, true);

    for (const during of ["sign", "post"]) {
        const switched = claimHarness({switchAccountDuring: during});
        const result = await switched.Venue.claimPrivateHolderCredential();
        assert.equal(result.reason, "wallet-changed", during);
        assert.equal(switched.calls.includes("adopt"), false, during);
    }

    const ensure = claimHarness({postError: "POOL_EXHAUSTED"});
    assert.equal(await ensure.Venue.ensurePrivateHolderCredential(), false);
    assert.equal(ensure.Venue._privateCredentialState.reason, "pool-exhausted");
    const disconnected = claimHarness({account: null});
    assert.equal(await disconnected.Venue.ensurePrivateHolderCredential(), false);
    assert.deepEqual(disconnected.calls, []);
});

function paintHarness({kyc = 1, credential = null, state = null, session = null} = {}) {
    const elements = {};
    for (const id of [
        "private-step-credential", "private-step-session", "private-step-funding",
        "private-session-hbar", "private-session-lprc", "private-credential-wrap",
        "private-setup-action", "private-setup-copy", "side",
    ]) {
        elements[id] = {textContent: "", hidden: false, disabled: false, value: "0"};
    }
    const statuses = [];
    const Venue = {
        snap: {kyc, sessionKyc: session ? 1 : undefined},
        session,
        _privateSecretPayload: {credential},
        _privateCredentialState: state,
        _privateSessionRecords: [],
        _privateSetupSide: 0,
        readOrder: () => ({qty: 0n}),
        orderFunds: () => ({privateRequired: null}),
        status(id, message, kind) {
            statuses.push({id, message, kind});
        },
    };
    runInNewContext(slice("Venue.paintPrivateSetup = function", "\nVenue.openPrivateSetup"), {
        Venue,
        CLIENT,
        $: (id) => elements[id],
        shortAddr: (a) => a,
        readableHbar: () => "0",
        formatQuantity: () => "0",
        Number,
    });
    Venue.paintPrivateSetup();
    return {elements, statuses};
}

test("the setup modal names the linked credential and never asks for a file", () => {
    const granted = paintHarness({kyc: 1});
    assert.equal(granted.elements["private-step-credential"].textContent, "Linked to eligibility");
    assert.equal(granted.elements["private-setup-action"].textContent, "Link holder credential");
    assert.equal(granted.elements["private-credential-wrap"].hidden, false);

    const ungranted = paintHarness({kyc: 0});
    assert.equal(ungranted.elements["private-step-credential"].textContent, "Prove eligibility first");
    assert.equal(ungranted.elements["private-setup-action"].textContent, "Prove eligibility");

    const claiming = paintHarness({state: {stage: "claiming"}});
    assert.equal(claiming.elements["private-step-credential"].textContent, "Claiming…");
    assert.equal(claiming.elements["private-setup-action"].textContent, "Waiting for wallet signature");

    const held = paintHarness({credential: {credentialRoot: ROOT}});
    assert.equal(held.elements["private-step-credential"].textContent, "Encrypted on device");
    assert.equal(held.elements["private-setup-action"].textContent, "Create private session");
    assert.equal(held.elements["private-credential-wrap"].hidden, true);

    const failed = paintHarness({state: {stage: "failed", reason: "pool-exhausted", message: "Full."}});
    assert.deepEqual(plain(failed.statuses), [{id: "private-setup-status", message: "Full.", kind: "bad"}]);
    const heldAfterFailure = paintHarness({
        credential: {credentialRoot: ROOT},
        state: {stage: "failed", reason: "pool-exhausted", message: "Full."},
    });
    assert.deepEqual(heldAfterFailure.statuses, []);
});

test("continuing setup without a grant goes to eligibility, never to a file dialog", async () => {
    const calls = [];
    const location = {href: "trade.html"};
    const fileInput = {click() { calls.push("file-click"); }};
    function harness({kyc, adopted, reason = null}) {
        const Venue = {
            snap: {kyc},
            session: null,
            _privateSecretPayload: {},
            _privateCredentialState: null,
            async ensurePrivateHolderCredential() {
                calls.push("ensure");
                if (!adopted) Venue._privateCredentialState = {stage: "failed", reason};
                else Venue._privateSecretPayload = {credential: {credentialRoot: ROOT}};
                return adopted;
            },
            async createOrRenewPrivateSession() { calls.push("session"); },
            closePrivateSetup() { calls.push("close"); },
            paintPrivateSetup() { calls.push("paint"); },
            status(id, message, kind) { calls.push("status:" + kind); },
        };
        runInNewContext(slice("Venue.continuePrivateSetup = async function", "\nVenue.runPrivatePathClick"), {
            Venue,
            window: {location},
            $: (id) => id === "private-credential-file" ? fileInput : null,
            Number,
        });
        return Venue;
    }
    await harness({kyc: 0, adopted: false}).continuePrivateSetup();
    assert.deepEqual(calls, ["close"]);
    assert.equal(location.href, "prove.html");

    calls.length = 0;
    location.href = "trade.html";
    await harness({kyc: 1, adopted: true}).continuePrivateSetup();
    assert.deepEqual(calls, ["ensure", "paint", "status:ok", "session"]);
    assert.equal(location.href, "trade.html");

    calls.length = 0;
    await harness({kyc: 1, adopted: false, reason: "pool-exhausted"}).continuePrivateSetup();
    assert.deepEqual(calls, ["ensure", "paint"]);
    assert.equal(location.href, "trade.html");

    calls.length = 0;
    await harness({kyc: undefined, adopted: false, reason: "needs-eligibility"}).continuePrivateSetup();
    assert.deepEqual(calls, ["ensure", "paint", "close"]);
    assert.equal(location.href, "prove.html");
    assert.equal(calls.includes("file-click"), false);
});

test("the file picker survives only as a restore control under recovery", () => {
    assert.doesNotMatch(runtime, /\/api\/private\/holder-credential/);
    assert.doesNotMatch(runtime, /x-lattice-account/);
    assert.doesNotMatch(runtime, /holderCredentials/);
    assert.doesNotMatch(runtime, /Choose holder credential/);
    assert.doesNotMatch(runtime, /Import required/);
    assert.doesNotMatch(runtime, /private-credential-file"\)\?\.click\(\)/);
    assert.match(runtime, /Venue\.claimPrivateHolderCredential\(\{expectedRoot: asBig\(root\)\}\)/);

    const summary = template.indexOf("<summary>Privacy limits and recovery</summary>");
    const input = template.indexOf('id="private-credential-file"');
    const actions = template.indexOf('class="private-setup-actions"');
    assert.ok(summary > 0 && input > summary && actions > input,
        "restore control sits inside the recovery details");
    assert.match(template, /Restore from file/);
    assert.doesNotMatch(template, /Choose credential</);
    assert.doesNotMatch(template, /Imported once, then encrypted/);
    assert.match(template, /One wallet signature links this wallet's eligibility grant/);
});
