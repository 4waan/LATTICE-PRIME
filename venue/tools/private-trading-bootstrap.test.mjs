import assert from "node:assert/strict";
import test from "node:test";

import {
    DEFAULT_CREDENTIAL_POOL,
    credentialPoolSize,
    mergeEnvText,
    planCredentialStore,
    poolHolderSecrets,
} from "./private-trading-bootstrap.mjs";
import {issuePrivateSessionCredentials} from "./private-zk.mjs";
import {
    normalizePrivateCredentialStore,
} from "../agent/runtime/private-credential-store.mjs";

const TRADER = "0xcfc5923def1f25db05fe50754ef0822175afd449";
const CANARY = "0xedfbec5444f61e757fb0f64018886d4a5bdd2a27";
const NEWCOMER = "0x2222222222222222222222222222222222222222";

test("env merge keeps lines it does not own and appends new keys once", () => {
    const prior = [
        "# operator note",
        "PRIVATE_TRADING_ISSUER_KEY=0xissuer",
        "PRIVATE_TRADING_SESSION_ROOT=111",
        "",
        "PRIVATE_TRADING_RPC_URL=https://testnet.hashio.io/api",
        "PRIVATE_TRADING_SESSIONS_PATH=/api/private/sessions",
        "",
    ].join("\n");
    const merged = mergeEnvText(prior, {
        PRIVATE_TRADING_SESSION_ROOT: "111",
        PRIVATE_TRADING_SESSION_ROOT_NEXT: "222",
        PRIVATE_TRADING_CREDENTIALS_PATH: "/api/private/credentials",
    });
    assert.equal(merged, [
        "# operator note",
        "PRIVATE_TRADING_ISSUER_KEY=0xissuer",
        "PRIVATE_TRADING_SESSION_ROOT=111",
        "",
        "PRIVATE_TRADING_RPC_URL=https://testnet.hashio.io/api",
        "PRIVATE_TRADING_SESSIONS_PATH=/api/private/sessions",
        "PRIVATE_TRADING_SESSION_ROOT_NEXT=222",
        "PRIVATE_TRADING_CREDENTIALS_PATH=/api/private/credentials",
        "",
    ].join("\n"));
    assert.equal(mergeEnvText(merged, {PRIVATE_TRADING_SESSION_ROOT_NEXT: "333"}).split("\n")
        .filter((line) => line.startsWith("PRIVATE_TRADING_SESSION_ROOT_NEXT=")).length, 1);
    assert.equal(mergeEnvText("", {A: "1"}), "A=1\n");
});

test("pool size comes from the environment with a bounded default", () => {
    assert.equal(credentialPoolSize(undefined), DEFAULT_CREDENTIAL_POOL);
    assert.equal(credentialPoolSize(""), DEFAULT_CREDENTIAL_POOL);
    assert.equal(credentialPoolSize("24"), 24);
    assert.equal(credentialPoolSize("0"), 0);
    assert.throws(() => credentialPoolSize("-1"));
    assert.throws(() => credentialPoolSize("sixteen"));
    assert.throws(() => credentialPoolSize("4097"));
});

test("pool secrets are reused by credential id so two runs share one root", () => {
    const trader = {wallet: TRADER, holderSecret: "11"};
    const canary = {wallet: CANARY, holderSecret: "22"};
    let drawn = 0;
    const random = () => String(5_000 + (drawn += 1));

    const first = planCredentialStore({
        store: null,
        trader,
        canary,
        pool: poolHolderSecrets(null, 4, random),
    });
    assert.equal(first.added, true);
    assert.equal(drawn, 4);
    const firstTree = first.store.trees[first.tree.root];
    assert.deepEqual(Object.keys(firstTree.bound).sort(), [TRADER, CANARY].sort());
    assert.deepEqual(
        firstTree.pool.map((entry) => entry.credential.credentialId),
        ["100", "101", "102", "103"],
    );

    // A wallet claims a leaf between runs; the second run must not disturb it.
    const claimed = normalizePrivateCredentialStore({
        v: 2,
        trees: {
            [first.tree.root]: {
                ...firstTree,
                bound: {
                    ...firstTree.bound,
                    [NEWCOMER]: {credential: firstTree.pool[0].credential, boundAt: "2026-09-19T17:00:00Z"},
                },
                pool: firstTree.pool.slice(1),
            },
        },
    });
    const second = planCredentialStore({
        store: claimed,
        trader,
        canary,
        pool: poolHolderSecrets(claimed, 4, random),
    });
    assert.equal(second.added, false, "same inputs reproduce the same root");
    assert.equal(second.tree.root, first.tree.root);
    assert.equal(drawn, 4, "no new secrets were drawn");
    assert.equal(second.store.trees[first.tree.root].bound[NEWCOMER].credential.credentialId, "100");
    assert.equal(second.store.trees[first.tree.root].pool.length, 3);

    // A larger pool is a new tree next to the old one; ids 100..103 keep their secrets.
    const grown = planCredentialStore({
        store: claimed,
        trader,
        canary,
        pool: poolHolderSecrets(claimed, 6, random),
    });
    assert.equal(grown.added, true);
    assert.equal(drawn, 6);
    assert.deepEqual(Object.keys(grown.store.trees).sort(), [first.tree.root, grown.tree.root].sort());
    const grownTree = grown.store.trees[grown.tree.root];
    assert.equal(grownTree.pool.length, 6);
    assert.equal(grownTree.pool[0].credential.holderSecret, firstTree.pool[0].credential.holderSecret);
    assert.equal(grown.store.trees[first.tree.root].bound[NEWCOMER].credential.credentialId, "100");
});

test("a v1 store is carried into the pooled store with its tree intact", () => {
    const legacy = issuePrivateSessionCredentials([
        {wallet: TRADER, holderSecret: 11n, credentialId: 73},
        {wallet: CANARY, holderSecret: 22n, credentialId: 74},
    ], 16);
    const v1 = Object.fromEntries(legacy.credentials.map((item) => [item.wallet, {credential: item}]));
    const planned = planCredentialStore({
        store: normalizePrivateCredentialStore(v1),
        trader: {wallet: TRADER, holderSecret: "11"},
        canary: {wallet: CANARY, holderSecret: "22"},
        pool: poolHolderSecrets(null, 2, (() => {
            let next = 777;
            return () => String(next += 1);
        })()),
    });
    assert.equal(planned.added, true);
    assert.notEqual(planned.tree.root, legacy.root, "the pooled tree has its own root");
    assert.deepEqual(Object.keys(planned.store.trees).sort(), [legacy.root, planned.tree.root].sort());
    assert.equal(planned.store.trees[legacy.root].bound[TRADER].credential.credentialId, "73");
    assert.equal(planned.store.trees[legacy.root].pool.length, 0);
    assert.equal(planned.store.trees[planned.tree.root].pool.length, 2);
    // Two pool leaves with the same secret are refused rather than issued.
    assert.throws(() => planCredentialStore({
        store: null,
        trader: {wallet: TRADER, holderSecret: "11"},
        canary: {wallet: CANARY, holderSecret: "22"},
        pool: [{credentialId: "100", holderSecret: "9"}, {credentialId: "101", holderSecret: "9"}],
    }));
});
