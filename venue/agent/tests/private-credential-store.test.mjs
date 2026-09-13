import assert from "node:assert/strict";
import {mkdtemp, readFile, readdir, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {
    bindPrivateCredential,
    boundPrivateCredential,
    buildPrivateCredentialTree,
    normalizePrivateCredentialStore,
    readPrivateCredentialStore,
    selectPrivateCredentialTree,
    writePrivateCredentialStore,
} from "../runtime/private-credential-store.mjs";
import {issuePrivateSessionCredentials} from "../../tools/private-zk.mjs";

const TRADER = "0xcfc5923def1f25db05fe50754ef0822175afd449";
const CANARY = "0xedfbec5444f61e757fb0f64018886d4a5bdd2a27";
const NEWCOMER = "0x1111111111111111111111111111111111111111";
const NOW = "2026-09-13T00:00:00.000Z";

function issued(holders) {
    return issuePrivateSessionCredentials(holders, 16);
}

function legacyTree() {
    return issued([
        {wallet: TRADER, holderSecret: 11n, credentialId: 73},
        {wallet: CANARY, holderSecret: 22n, credentialId: 74},
    ]);
}

function pooledTree() {
    return issued([
        {wallet: TRADER, holderSecret: 31n, credentialId: 73},
        {holderSecret: 101n, credentialId: 100},
        {holderSecret: 102n, credentialId: 101},
    ]);
}

function legacyStore(tree = legacyTree()) {
    return Object.fromEntries(tree.credentials.map((item) =>
        [item.wallet, {credential: item}]));
}

test("v1 flat store normalizes into one tree per root with an empty pool", () => {
    const tree = legacyTree();
    const store = normalizePrivateCredentialStore(legacyStore(tree));
    assert.equal(store.v, 2);
    assert.deepEqual(Object.keys(store.trees), [tree.root]);
    const only = store.trees[tree.root];
    assert.equal(only.depth, 16);
    assert.deepEqual(Object.keys(only.bound).sort(), [TRADER, CANARY].sort());
    assert.equal(only.pool.length, 0);
    assert.equal(Object.hasOwn(only.bound[TRADER].credential, "wallet"), false);
    assert.equal(only.bound[TRADER].credential.credentialId, "73");
    assert.equal(boundPrivateCredential(store, tree.root, TRADER).credentialId, "73");
    assert.equal(boundPrivateCredential(store, tree.root, NEWCOMER), null);
});

test("v2 store passes through and refuses malformed shapes", () => {
    const tree = buildPrivateCredentialTree(pooledTree());
    const store = normalizePrivateCredentialStore({
        v: 2,
        trees: {[tree.pool[0].credential.credentialRoot]: tree},
    });
    assert.deepEqual(
        JSON.parse(JSON.stringify(normalizePrivateCredentialStore(store))),
        JSON.parse(JSON.stringify(store)),
    );
    const root = Object.keys(store.trees)[0];
    assert.equal(store.trees[root].pool.length, 2);
    assert.equal(store.trees[root].bound[TRADER].credential.credentialId, "73");
    assert.equal(selectPrivateCredentialTree(store, root), store.trees[root]);
    assert.equal(selectPrivateCredentialTree(store, "0"), null);
    assert.equal(selectPrivateCredentialTree(store, "not a root"), null);

    for (const broken of [
        null,
        [],
        {v: 2},
        {v: 2, trees: []},
        {v: 2, trees: {[root]: {...store.trees[root], depth: 15}}},
        {v: 2, trees: {[root]: {...store.trees[root], extra: 1}}},
        {v: 2, trees: {["1" + root]: store.trees[root]}},
        {v: 2, trees: {[root]: {...store.trees[root], pool: [{}]}}},
        {v: 2, trees: {[root]: {
            ...store.trees[root],
            bound: {"0xNotLower": store.trees[root].bound[TRADER]},
        }}},
        {v: 2, trees: {[root]: {
            ...store.trees[root],
            pool: [store.trees[root].pool[0], store.trees[root].pool[0]],
        }}},
        {[TRADER]: {credential: {...tree.pool[0].credential, holderSecret: "0"}}},
        {[TRADER]: {credential: {...tree.pool[0].credential, pathIndices: ["2"]}}},
    ]) {
        assert.throws(
            () => normalizePrivateCredentialStore(broken),
            {code: "CREDENTIAL_STORE_INVALID"},
        );
    }
});

test("binding pops the first pool leaf once and leaves bound entries alone", () => {
    const tree = buildPrivateCredentialTree(pooledTree());
    const root = tree.pool[0].credential.credentialRoot;
    const store = normalizePrivateCredentialStore({v: 2, trees: {[root]: tree}});

    const first = bindPrivateCredential(store, root, NEWCOMER, NOW);
    assert.equal(first.changed, true);
    assert.equal(first.credential.credentialId, "100");
    assert.equal(first.store.trees[root].pool.length, 1);
    assert.equal(first.store.trees[root].bound[NEWCOMER].boundAt, NOW);
    assert.deepEqual(first.store.trees[root].bound[NEWCOMER].credential, first.credential);
    assert.equal(store.trees[root].pool.length, 2, "input store is not mutated");

    const again = bindPrivateCredential(first.store, root, NEWCOMER, "2026-09-14T00:00:00Z");
    assert.equal(again.changed, false);
    assert.equal(again.credential.credentialId, "100");
    assert.equal(again.store.trees[root].pool.length, 1);
    assert.equal(again.store.trees[root].bound[NEWCOMER].boundAt, NOW);

    const trader = bindPrivateCredential(first.store, root, TRADER, NOW);
    assert.equal(trader.changed, false);
    assert.equal(trader.credential.credentialId, "73");

    const second = bindPrivateCredential(
        first.store,
        root,
        "0x2222222222222222222222222222222222222222",
        NOW,
    );
    assert.equal(second.credential.credentialId, "101");
    assert.equal(second.store.trees[root].pool.length, 0);
    assert.throws(
        () => bindPrivateCredential(
            second.store,
            root,
            "0x3333333333333333333333333333333333333333",
            NOW,
        ),
        {code: "POOL_EXHAUSTED", status: 409},
    );
    assert.throws(
        () => bindPrivateCredential(store, "12345", NEWCOMER, NOW),
        {code: "ROOT_NOT_ACTIVE", status: 409},
    );
});

test("built trees keep wallet-bound leaves out of the pool and share one root", () => {
    const tree = buildPrivateCredentialTree(pooledTree());
    assert.deepEqual(Object.keys(tree.bound), [TRADER]);
    assert.deepEqual(tree.pool.map((entry) => entry.credential.credentialId), ["100", "101"]);
    assert.equal(Object.hasOwn(tree.bound[TRADER].credential, "wallet"), false);
    const mixed = pooledTree();
    mixed.credentials[1].credentialRoot = "7";
    assert.throws(
        () => buildPrivateCredentialTree(mixed),
        {code: "CREDENTIAL_STORE_INVALID"},
    );
    assert.throws(
        () => buildPrivateCredentialTree({depth: 16, root: "1", credentials: []}),
        {code: "CREDENTIAL_STORE_INVALID"},
    );
});

test("store files are written atomically with owner-only mode and read back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "private-credential-store-"));
    const file = join(directory, "nested", "holder-credentials.json");
    await assert.rejects(
        readPrivateCredentialStore(file),
        {code: "CREDENTIAL_STORE_UNAVAILABLE", status: 503},
    );

    const legacy = legacyTree();
    const pooled = buildPrivateCredentialTree(pooledTree());
    const pooledRoot = pooled.pool[0].credential.credentialRoot;
    const legacyNormalized = normalizePrivateCredentialStore(legacyStore(legacy));
    const written = await writePrivateCredentialStore(file, {
        v: 2,
        trees: {
            ...legacyNormalized.trees,
            [pooledRoot]: pooled,
        },
    });
    assert.deepEqual(Object.keys(written.trees).sort(), [legacy.root, pooledRoot].sort());
    assert.deepEqual(await readdir(join(directory, "nested")), ["holder-credentials.json"]);
    assert.equal((await stat(file)).mode & 0o777, 0o600);

    const parsed = JSON.parse(await readFile(file, "utf8"));
    assert.equal(parsed.v, 2);
    const read = await readPrivateCredentialStore(file);
    assert.deepEqual(JSON.parse(JSON.stringify(read)), JSON.parse(JSON.stringify(written)));
    assert.equal(read.trees[legacy.root].bound[TRADER].credential.credentialId, "73");
    assert.equal(read.trees[pooledRoot].pool.length, 2);

    await assert.rejects(
        writePrivateCredentialStore(file, {v: 2, trees: {x: 1}}),
        {code: "CREDENTIAL_STORE_INVALID"},
    );
    assert.deepEqual(await readdir(join(directory, "nested")), ["holder-credentials.json"]);
});
