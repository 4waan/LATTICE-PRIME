import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

const runtime = readFileSync(new URL("./venue-app.mjs", import.meta.url), "utf8");

const WALLET = "0x00000000000000000000000000000000000000aa";
const GATE = "0xbc80d92d6dd33be2e473eb9bb4f6a5c91061a808";
const FACTORY = "0x1111111111111111111111111111111111111111";
const REGISTRY = "0x2222222222222222222222222222222222222222";
const SESSION = "0x3333333333333333333333333333333333333333";
const SIGNER = "0x4444444444444444444444444444444444444444";
const HASH = "0x6a949bfe201cd3499d52c9399a31ba67c5c4a43b5edfe34db78c812e57059305";
const OTHER_HASH = "0x" + "ab".repeat(32);
const ROOT = "182851654048";

const plain = (value) => JSON.parse(JSON.stringify(value));

function slice(startMarker, endMarker) {
    const start = runtime.indexOf(startMarker);
    const end = runtime.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `${startMarker} should be extractable`);
    return runtime.slice(start, end);
}

function overlayClient(session = {creationCodeHash: ""}) {
    return {
        network: {chainId: 296},
        addresses: {ZkKycRegistry: REGISTRY},
        privateTrading: {
            enabled: true,
            overlay: true,
            addresses: {DualRegistrationGate: GATE, SessionAccountFactory: FACTORY},
            services: {sessions: "/api/private/sessions"},
            artifacts: {sessionEligibility: {kind: "eligibility"}, sessionCompliance: {kind: "compliance"}},
            session,
        },
    };
}

function codeHashHarness({client, factoryHash = HASH, factoryError = null} = {}) {
    const calls = [];
    const Venue = {
        _privateStatus: null,
        async observePrivateGate() {
            calls.push("observe");
        },
        privateContracts() {
            return {
                factory: {
                    async creationCodeHash() {
                        calls.push("factory");
                        if (factoryError) throw factoryError;
                        return factoryHash;
                    },
                },
            };
        },
    };
    runInNewContext(
        slice("Venue.applyPrivateCandidateOverlay = async function", "\nVenue.observePrivateGate"),
        {Venue, CLIENT: client, Error},
    );
    return {Venue, calls, client};
}

test("the factory ABI exposes the session creation code hash", () => {
    const abi = slice("const PRIVATE_FACTORY_ABI = [", "];");
    assert.match(abi, /"function creationCodeHash\(\) view returns \(bytes32\)"/);
});

test("a bound release answers with its shipped hash and never reads the factory", async () => {
    const shipped = HASH.toUpperCase().replace("0X", "0x");
    const client = {privateTrading: {enabled: true, overlay: false, session: {creationCodeHash: shipped}}};
    const {Venue, calls} = codeHashHarness({client});
    assert.equal(await Venue.privateSessionCodeHash(Venue.privateContracts()), HASH);
    assert.deepEqual(calls, []);

    const unreleased = codeHashHarness({client: {privateTrading: {enabled: true, overlay: false, session: {creationCodeHash: ""}}}});
    await assert.rejects(
        unreleased.Venue.privateSessionCodeHash(unreleased.Venue.privateContracts()),
        /Private session code is not released\./,
    );
    assert.deepEqual(unreleased.calls, []);
});

test("the overlay reads the hash from the factory once and keeps it", async () => {
    const {Venue, calls, client} = codeHashHarness({client: overlayClient()});
    const contracts = Venue.privateContracts();
    assert.equal(await Venue.privateSessionCodeHash(contracts), HASH);
    assert.equal(client.privateTrading.session.creationCodeHash, HASH);
    assert.equal(client.privateTrading.overlay, true, "the rest of the overlay is kept");
    assert.equal(await Venue.privateSessionCodeHash(contracts), HASH);
    assert.deepEqual(calls, ["factory"], "the second call is answered from the client");

    const broken = codeHashHarness({client: overlayClient(), factoryHash: "0x1234"});
    await assert.rejects(
        broken.Venue.privateSessionCodeHash(broken.Venue.privateContracts()),
        /Private session code hash is unavailable\./,
    );
    assert.equal(broken.client.privateTrading.session.creationCodeHash, "");
});

test("applying the candidate overlay fills the hash and survives a failed read", async () => {
    const overlay = overlayClient().privateTrading;
    const filled = codeHashHarness({client: {privateTrading: {enabled: false, overlay: false}}});
    filled.Venue._privateStatus = {overlay};
    const applied = await filled.Venue.applyPrivateCandidateOverlay();
    assert.equal(applied.session.creationCodeHash, HASH);
    assert.equal(filled.client.privateTrading.session.creationCodeHash, HASH);
    assert.equal(filled.client.privateTrading.overlay, true);
    assert.deepEqual(filled.calls, ["factory", "observe"]);

    const rateLimited = codeHashHarness({
        client: {privateTrading: {enabled: false, overlay: false}},
        factoryError: new Error("429"),
    });
    rateLimited.Venue._privateStatus = {overlay: overlayClient().privateTrading};
    const kept = await rateLimited.Venue.applyPrivateCandidateOverlay();
    assert.equal(kept.overlay, true, "the overlay is still applied");
    assert.equal(kept.session.creationCodeHash, "", "registration reads the hash again later");
    assert.deepEqual(rateLimited.calls, ["factory", "observe"]);

    const bound = codeHashHarness({client: {privateTrading: {enabled: true, overlay: false, session: {creationCodeHash: HASH}}}});
    bound.Venue._privateStatus = {overlay};
    assert.equal((await bound.Venue.applyPrivateCandidateOverlay()).overlay, false);
    assert.deepEqual(bound.calls, []);
});

function sessionHarness({client = overlayClient(), gateHash = HASH, factoryHash = HASH} = {}) {
    const calls = [];
    const record = {
        v: 1,
        generation: 1,
        state: "PENDING",
        account: SESSION,
        signer: SIGNER,
        recovery: SIGNER,
        deploymentSalt: "0x" + "11".repeat(32),
        createdAt: "2026-09-13T00:00:00.000Z",
        retiredAt: null,
    };
    const contracts = {
        factory: {
            async creationCodeHash() {
                calls.push("factory");
                return factoryHash;
            },
        },
        gate: {
            async sessionRootForEpoch() { return BigInt(ROOT); },
            async viewKeyEpochForRotationEpoch() { return 8n; },
            async sessionImplementationCodeHash() { return gateHash; },
            async sessionImplementationCodeHashLow() { return 44n; },
            async sessionImplementationCodeHashHigh() { return 55n; },
            async minTier() { return 3n; },
            async jurisdictionMask() { return 255n; },
            async viewKeyForEpoch() { return {x: 333n, y: 444n, published: true}; },
        },
    };
    const Venue = {
        account: WALLET,
        session: null,
        snap: {},
        _privateSecretPayload: {credential: {credentialRoot: ROOT, holderSecret: "1"}},
        _privateSessionRecords: [record],
        c: {registry: {async currentEpoch() { return 8n; }}},
        reader: {async getCode() { return "0x6080"; }},
        privateContracts() { return contracts; },
        privateSessionConfig(item) { return {sessionSigner: item.signer}; },
        status(_id, message) { calls.push(`status:${message}`); },
        async privatePost(path, body) {
            calls.push("post");
            Venue.posted = {path, body};
            return {status: "ALREADY_CONFIRMED"};
        },
        async runPrivateProof(kind, request) {
            assert.equal(kind, "session");
            return PrivateTradingCrypto.createPrivateSessionProofs(request);
        },
        async savePrivateSessionRecords(records) {
            Venue._privateSessionRecords = records;
        },
        async verifyPrivateSessionRecord(item) { return {...item, kycStatus: 1}; },
        async refreshTrade() { calls.push("refresh"); },
        paintPrivateSetup() { calls.push("paint"); },
        async refreshPrivateSessionRecovery() {},
    };
    const PrivateTradingCrypto = {
        plonk: {},
        async createPrivateSessionProofs(request) {
            calls.push("proofs");
            Venue.proved = request;
            return {
                eligibility: {proof: ["1"], publicSignals: ["901", "1"]},
                compliance: {proof: ["2"], publicSignals: ["801"]},
                sessionSlot: "901",
                ciphertext: {encryptedCredential: "801", tag: "802", ephemeralX: "803", ephemeralY: "804"},
            };
        },
    };
    const source = slice("Venue.applyPrivateCandidateOverlay = async function", "\nVenue.observePrivateGate")
        + "\n" + slice("Venue.createOrRenewPrivateSession = async function", "\nVenue.privateSessionOpenOrderCount");
    runInNewContext(source, {
        Venue,
        CLIENT: client,
        PrivateTradingCrypto,
        ZERO: "0x0000000000000000000000000000000000000000",
        asBig: (v) => typeof v === "bigint" ? v : BigInt(v),
        addrEq: (a, b) => (a || "").toLowerCase() === (b || "").toLowerCase(),
        Error,
    });
    return {Venue, calls, client};
}

test("session setup on the candidate compares the gate against the factory hash", async () => {
    const {Venue, calls, client} = sessionHarness();
    const session = await Venue.createOrRenewPrivateSession();
    assert.equal(session.state, "ACTIVE");
    assert.equal(session.kycStatus, 1);
    assert.equal(client.privateTrading.session.creationCodeHash, HASH);
    assert.deepEqual(calls, [
        "factory",
        "status:Generating two local proofs. The proving files are large and cached after first use.",
        "proofs",
        "post",
        "refresh",
        "status:Private session is active.",
        "paint",
    ]);
    assert.deepEqual(plain(Venue.proved.context), {
        credentialRoot: ROOT,
        rotationEpoch: "8",
        sessionAccount: BigInt(SESSION).toString(),
        sessionSigner: BigInt(SIGNER).toString(),
        factory: BigInt(FACTORY).toString(),
        implementationCodeHashLow: "44",
        implementationCodeHashHigh: "55",
        minTier: "3",
        jurisdictionMask: "255",
    });
    assert.deepEqual(plain(Venue.proved.viewKey), {epoch: "8", x: "333", y: "444"});
    assert.equal(Venue.posted.path, "/api/private/sessions");
    assert.deepEqual(Object.keys(Venue.posted.body).sort(), [
        "account", "action", "chainId", "ciphertext", "compliance", "config",
        "deploymentSalt", "eligibility", "factory", "gate", "registry",
    ]);
    assert.equal(Venue.posted.body.action, "register");
    assert.equal(Venue.posted.body.registry, REGISTRY);
});

test("a gate whose code differs from the factory is refused before any proof", async () => {
    const mismatch = sessionHarness({gateHash: OTHER_HASH});
    await assert.rejects(
        mismatch.Venue.createOrRenewPrivateSession(),
        /Private session code does not match the released configuration\./,
    );
    assert.deepEqual(mismatch.calls, ["factory"]);

    const released = overlayClient({creationCodeHash: HASH});
    released.privateTrading.overlay = false;
    const bound = sessionHarness({client: released});
    await bound.Venue.createOrRenewPrivateSession();
    assert.equal(bound.calls.includes("factory"), false, "a bound release trusts its shipped hash");
    assert.equal(bound.calls.includes("post"), true);
});
