import assert from "node:assert/strict";
import {mkdtemp, readFile, readdir, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {Wallet} from "ethers";

import {
    PRIVATE_CREDENTIAL_CLAIM_DOMAIN_NAME,
    PRIVATE_CREDENTIAL_CLAIM_KEYS,
    PRIVATE_CREDENTIAL_CLAIM_TYPES,
    PrivateCredentialController,
    privateCredentialClaimDomain,
} from "../runtime/private-credential-controller.mjs";
import {
    buildPrivateCredentialTree,
    readPrivateCredentialStore,
} from "../runtime/private-credential-store.mjs";
import {issuePrivateSessionCredentials} from "../../tools/private-zk.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = "0xbc80d92d6dd33be2e473eb9bb4f6a5c91061a808";
const FACTORY = "0x1111111111111111111111111111111111111111";
const ALLOWLIST = Object.freeze({chainId: "296", gate: GATE, factory: FACTORY});
const NOW = 1_789_240_563n;

const trader = Wallet.createRandom();
const newcomer = Wallet.createRandom();
const stranger = Wallet.createRandom();

function lower(wallet) {
    return wallet.address.toLowerCase();
}

function trees() {
    const legacy = issuePrivateSessionCredentials([
        {wallet: lower(trader), holderSecret: 11n, credentialId: 73},
    ], 16);
    const pooled = issuePrivateSessionCredentials([
        {wallet: lower(trader), holderSecret: 31n, credentialId: 73},
        {holderSecret: 101n, credentialId: 100},
        {holderSecret: 102n, credentialId: 101},
    ], 16);
    return {legacy, pooled};
}

async function harness({
    liveRoot,
    grants = {},
    store = null,
    chainFailure = null,
    now = NOW,
} = {}) {
    const directory = await mkdtemp(join(tmpdir(), "private-credential-controller-"));
    const storePath = join(directory, "holder-credentials.json");
    if (store !== null) {
        await writeFile(storePath, JSON.stringify(store), {mode: 0o600});
    }
    const reads = [];
    const registry = {
        async currentEpoch() {
            reads.push("currentEpoch");
            if (chainFailure) throw new Error(chainFailure);
            return 8n;
        },
        async getKycStatus(account) {
            reads.push(`getKycStatus:${account}`);
            if (chainFailure) throw new Error(chainFailure);
            return BigInt(grants[account.toLowerCase()] ?? 0);
        },
    };
    const gate = {
        async sessionRootForEpoch(epoch) {
            reads.push(`sessionRootForEpoch:${epoch}`);
            return BigInt(liveRoot);
        },
    };
    const controller = new PrivateCredentialController({
        registry,
        gate,
        allowlist: ALLOWLIST,
        storePath,
        nowSeconds: () => now,
    });
    return {controller, storePath, reads, directory};
}

async function signedClaim(wallet, overrides = {}) {
    const claim = {
        account: wallet.address,
        chainId: "296",
        gate: GATE,
        factory: FACTORY,
        issuedAt: NOW.toString(),
        ...overrides,
    };
    const signature = await wallet.signTypedData(
        privateCredentialClaimDomain({chainId: claim.chainId, gate: claim.gate}),
        PRIVATE_CREDENTIAL_CLAIM_TYPES,
        {account: claim.account, factory: claim.factory, issuedAt: claim.issuedAt},
    );
    return {...claim, signature};
}

function pooledStore(pooled) {
    return {
        v: 2,
        trees: {[pooled.root]: buildPrivateCredentialTree(pooled)},
    };
}

test("a granted wallet claims the first pool leaf once and the store persists it", async () => {
    const {pooled} = trees();
    const running = await harness({
        liveRoot: pooled.root,
        grants: {[lower(newcomer)]: 1},
        store: pooledStore(pooled),
    });
    await running.controller.initialize();

    const first = await running.controller.handle(await signedClaim(newcomer));
    assert.equal(first.credential.wallet, lower(newcomer));
    assert.equal(first.credential.credentialId, "100");
    assert.equal(first.credential.credentialRoot, pooled.root);
    assert.equal(first.credential.holderSecret, "101");
    assert.equal(first.credential.pathElements.length, 16);
    assert.deepEqual(
        Object.keys(first.credential).sort(),
        [
            "credentialId", "credentialRoot", "holderSecret", "holderSecretCommitment",
            "issuedAt", "jurisdiction", "pathElements", "pathIndices", "tier", "v",
            "validUntilEpoch", "wallet",
        ],
    );
    assert.equal((await stat(running.storePath)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(running.directory), ["holder-credentials.json"]);
    const persisted = await readPrivateCredentialStore(running.storePath);
    assert.equal(persisted.trees[pooled.root].pool.length, 1);
    assert.equal(
        persisted.trees[pooled.root].bound[lower(newcomer)].credential.credentialId,
        "100",
    );
    assert.equal(
        persisted.trees[pooled.root].bound[lower(newcomer)].boundAt,
        new Date(Number(NOW) * 1_000).toISOString(),
    );

    // Same wallet again: same leaf, pool untouched, grant not consulted.
    const again = await running.controller.handle(await signedClaim(newcomer, {
        issuedAt: (NOW + 10n).toString(),
    }));
    assert.deepEqual(again, first);
    const unchanged = await readPrivateCredentialStore(running.storePath);
    assert.equal(unchanged.trees[pooled.root].pool.length, 1);

    // The wallet bound at issue time is served without a grant.
    const bound = await running.controller.handle(await signedClaim(trader));
    assert.equal(bound.credential.credentialId, "73");
    assert.equal(bound.credential.wallet, lower(trader));
});

test("claims fail closed on signature, freshness, context, and schema", async () => {
    const {pooled} = trees();
    const running = await harness({
        liveRoot: pooled.root,
        grants: {[lower(newcomer)]: 1},
        store: pooledStore(pooled),
    });
    const before = await readFile(running.storePath, "utf8");

    const forged = await signedClaim(stranger);
    await assert.rejects(
        running.controller.handle({...forged, account: newcomer.address}),
        {code: "SIGNATURE_INVALID", status: 401},
    );
    await assert.rejects(
        running.controller.handle({
            ...(await signedClaim(newcomer)),
            signature: `0x${"11".repeat(65)}`,
        }),
        {code: "SIGNATURE_INVALID", status: 401},
    );
    for (const issuedAt of [(NOW - 301n).toString(), (NOW + 301n).toString()]) {
        await assert.rejects(
            running.controller.handle(await signedClaim(newcomer, {issuedAt})),
            {code: "CLAIM_STALE", status: 400},
        );
    }
    const inside = await running.controller.handle(await signedClaim(trader, {
        issuedAt: (NOW - 300n).toString(),
    }));
    assert.equal(inside.credential.credentialId, "73");
    for (const overrides of [
        {gate: FACTORY},
        {factory: GATE},
        {chainId: "295"},
    ]) {
        await assert.rejects(
            running.controller.handle(await signedClaim(newcomer, overrides)),
            {code: "CLAIM_CONTEXT_INVALID", status: 400},
        );
    }
    const valid = await signedClaim(newcomer);
    for (const body of [
        null,
        [],
        "claim",
        {...valid, extra: 1},
        Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "gate")),
        {...valid, account: "0x0000000000000000000000000000000000000000"},
        {...valid, issuedAt: 1},
        {...valid, issuedAt: "-1"},
        {...valid, chainId: 296},
        {...valid, signature: "0x1234"},
    ]) {
        await assert.rejects(
            running.controller.handle(body),
            {code: "CLAIM_SCHEMA_INVALID", status: 400},
        );
    }
    assert.equal(await readFile(running.storePath, "utf8"), before);
});

test("ungranted wallets, exhausted pools, and unknown roots are refused without writes", async () => {
    const {pooled, legacy} = trees();
    const ungranted = await harness({
        liveRoot: pooled.root,
        store: pooledStore(pooled),
    });
    const before = await readFile(ungranted.storePath, "utf8");
    await assert.rejects(
        ungranted.controller.handle(await signedClaim(newcomer)),
        {code: "NOT_ELIGIBLE", status: 403},
    );
    assert.equal(await readFile(ungranted.storePath, "utf8"), before);
    assert.deepEqual(ungranted.reads, [
        "currentEpoch",
        `getKycStatus:${lower(newcomer)}`,
        "sessionRootForEpoch:8",
    ]);

    const exhausted = await harness({
        liveRoot: legacy.root,
        grants: {[lower(newcomer)]: 1, [lower(trader)]: 1},
        store: Object.fromEntries(legacy.credentials.map((item) =>
            [item.wallet, {credential: item}])),
    });
    await exhausted.controller.initialize();
    const served = await exhausted.controller.handle(await signedClaim(trader));
    assert.equal(served.credential.credentialId, "73");
    await assert.rejects(
        exhausted.controller.handle(await signedClaim(newcomer)),
        {code: "POOL_EXHAUSTED", status: 409},
    );
    const legacyText = await readFile(exhausted.storePath, "utf8");
    assert.equal(JSON.parse(legacyText).v, undefined, "v1 store is not rewritten by reads");

    const unknownRoot = await harness({
        liveRoot: "12345",
        grants: {[lower(newcomer)]: 1},
        store: pooledStore(pooled),
    });
    await assert.rejects(
        unknownRoot.controller.handle(await signedClaim(newcomer)),
        {code: "ROOT_NOT_ACTIVE", status: 409},
    );
    const zeroRoot = await harness({
        liveRoot: "0",
        grants: {[lower(newcomer)]: 1},
        store: pooledStore(pooled),
    });
    await assert.rejects(
        zeroRoot.controller.handle(await signedClaim(newcomer)),
        {code: "ROOT_NOT_ACTIVE", status: 409},
    );
});

test("chain and store failures surface as public codes only", async () => {
    const {pooled} = trees();
    const down = await harness({
        liveRoot: pooled.root,
        grants: {[lower(newcomer)]: 1},
        store: pooledStore(pooled),
        chainFailure: "rpc secret detail",
    });
    await assert.rejects(
        down.controller.handle(await signedClaim(newcomer)),
        (error) => {
            assert.equal(error.code, "CHAIN_UNAVAILABLE");
            assert.equal(error.status, 503);
            assert.equal(JSON.stringify(error).includes("secret"), false);
            assert.equal(JSON.stringify(error).includes("holderSecret"), false);
            return true;
        },
    );

    const missing = await harness({liveRoot: pooled.root, grants: {[lower(newcomer)]: 1}});
    await assert.rejects(
        missing.controller.initialize(),
        {code: "CREDENTIAL_STORE_UNAVAILABLE", status: 503},
    );
    await assert.rejects(
        missing.controller.handle(await signedClaim(newcomer)),
        {code: "CREDENTIAL_STORE_UNAVAILABLE", status: 503},
    );

    const corrupt = await harness({liveRoot: pooled.root, store: {v: 2, trees: {bad: 1}}});
    await assert.rejects(
        corrupt.controller.initialize(),
        {code: "CREDENTIAL_STORE_INVALID", status: 500},
    );

    assert.throws(
        () => new PrivateCredentialController({
            registry: {},
            gate: {},
            allowlist: ALLOWLIST,
            storePath: "/tmp/x",
        }),
        {code: "CONTROLLER_CONFIG_INVALID", status: 500},
    );
    assert.throws(
        () => new PrivateCredentialController({
            registry: {async currentEpoch() {}, async getKycStatus() {}},
            gate: {async sessionRootForEpoch() {}},
            allowlist: {...ALLOWLIST, chainId: "1"},
            storePath: "/tmp/x",
        }),
        {code: "CONTROLLER_CONFIG_INVALID", status: 500},
    );
});

test("concurrent claims from different wallets receive distinct leaves", async () => {
    const {pooled} = trees();
    const other = Wallet.createRandom();
    const running = await harness({
        liveRoot: pooled.root,
        grants: {[lower(newcomer)]: 1, [lower(other)]: 1},
        store: pooledStore(pooled),
    });
    const [first, second] = await Promise.all([
        running.controller.handle(await signedClaim(newcomer)),
        running.controller.handle(await signedClaim(other)),
    ]);
    assert.notEqual(first.credential.holderSecret, second.credential.holderSecret);
    assert.deepEqual(
        [first.credential.credentialId, second.credential.credentialId].sort(),
        ["100", "101"],
    );
    const persisted = await readPrivateCredentialStore(running.storePath);
    assert.equal(persisted.trees[pooled.root].pool.length, 0);
    assert.deepEqual(
        Object.keys(persisted.trees[pooled.root].bound).sort(),
        [lower(trader), lower(newcomer), lower(other)].sort(),
    );
});

test("the browser runtime signs the same claim the worker verifies", async () => {
    const runtime = await readFile(join(HERE, "../../tools/venue-app.mjs"), "utf8");
    assert.equal(runtime.includes(`"${PRIVATE_CREDENTIAL_CLAIM_DOMAIN_NAME}"`), true);
    const fields = PRIVATE_CREDENTIAL_CLAIM_TYPES.CredentialClaim
        .map((item) => `{name: "${item.name}", type: "${item.type}"}`);
    for (const field of fields) {
        assert.equal(runtime.includes(field), true, `runtime declares ${field}`);
    }
    const postStart = runtime.indexOf("result = await Venue.privatePost(path, {");
    const postEnd = runtime.indexOf("});", postStart);
    assert.ok(postStart > 0 && postEnd > postStart, "claim POST should be extractable");
    const posted = runtime.slice(postStart, postEnd);
    for (const key of PRIVATE_CREDENTIAL_CLAIM_KEYS) {
        assert.match(posted, new RegExp(`\\b${key}\\b`), `runtime sends ${key}`);
    }
    assert.equal(runtime.includes("/api/private/holder-credential"), false);
    assert.equal(runtime.includes("x-lattice-account"), false);
});
