// The issuer's tree for one epoch, and the circuit inputs drawn from it.
//
// Extracted from `gen-input.mjs` when the venue went live on testnet. Two
// callers now need the same tree and they must not be allowed to disagree
// about it: `gen-input.mjs` writes the test fixtures, and `prove-live.mjs`
// proves for a real address against the root already published on chain. A
// second copy of this arithmetic would be a second issuer, and the gate pins
// the root, so the divergence would show up as an on chain refusal rather
// than as a failing test.
//
// The registrant is the only free variable. It is a public input to the
// circuit and not an input to any leaf, so **the root does not depend on it**.
// That is what makes a live proof possible at all: the root published for
// epoch 7 is write once, and a new holder needs a proof under that same root
// rather than a new one.
import {buildPoseidon} from "circomlibjs";

export const DEPTH = 16;

/// The epoch the **fixtures** are built for, and the default everywhere else.
///
/// `test/fixtures/proofs.json` is pinned to it, and `deployments/296-kyc.json`
/// records it as `proofEpoch`, so moving this constant would silently invalidate
/// every committed fixture. It is a default rather than the only value: pass an
/// epoch to `buildTree` for a live proof against a later one.
export const EPOCH = 7n;
export const MIN_TIER = 3n;
export const JUR_MASK = 0xffn; // jurisdictions 0..7 admitted

/// The address `gen-input.mjs` has always used, kept here so the fixtures it
/// writes are unchanged by the extraction.
export const FIXTURE_REGISTRANT = BigInt("0xd30DE9C5aEF8079B4718B4988E8FD1D1A96F3115");

// Four credentials the issuer has actually signed into this epoch's tree.
export const creds = {
    valid:             {credentialId: 1n, secret: 111222333444555666777n, jurisdiction: 3n, tier: 4n, validUntilEpoch: 40n},
    fail_tier:         {credentialId: 2n, secret: 222333444555666777888n, jurisdiction: 3n, tier: 1n, validUntilEpoch: 40n},
    fail_epoch:        {credentialId: 3n, secret: 333444555666777888999n, jurisdiction: 3n, tier: 4n, validUntilEpoch: 5n},
    fail_jurisdiction: {credentialId: 4n, secret: 444555666777888999111n, jurisdiction: 9n, tier: 4n, validUntilEpoch: 40n},
};
export const names = Object.keys(creds);

// Eight more passing credentials, one per synthetic participant, for the wide
// tree the second RegistrationGate publishes. Each has its own secret, so each
// has its own nullifier: `ZkKycRegistry.MAX_USES_PER_EPOCH` then binds per bot
// rather than across the whole population. They are appended after the four
// above, so the wide tree changes the root and nothing else: every fixture
// index, and the default root, is exactly what it was.
export const botCreds = {
    bot_1: {credentialId: 5n,  secret: 515161718192021222324n, jurisdiction: 3n, tier: 4n, validUntilEpoch: 40n},
    bot_2: {credentialId: 6n,  secret: 626272829303132333435n, jurisdiction: 3n, tier: 4n, validUntilEpoch: 40n},
    bot_3: {credentialId: 7n,  secret: 737383940414243444546n, jurisdiction: 3n, tier: 4n, validUntilEpoch: 40n},
    bot_4: {credentialId: 8n,  secret: 848495051525354555657n, jurisdiction: 3n, tier: 4n, validUntilEpoch: 40n},
    bot_5: {credentialId: 9n,  secret: 959606162636465666768n, jurisdiction: 3n, tier: 4n, validUntilEpoch: 40n},
    bot_6: {credentialId: 10n, secret: 106071727374757677787n, jurisdiction: 3n, tier: 4n, validUntilEpoch: 40n},
    bot_7: {credentialId: 11n, secret: 117181828384858687888n, jurisdiction: 3n, tier: 4n, validUntilEpoch: 40n},
    bot_8: {credentialId: 12n, secret: 128192939495969798999n, jurisdiction: 3n, tier: 4n, validUntilEpoch: 40n},
};
export const botNames = Object.keys(botCreds);
export const wideNames = [...names, ...botNames];

/// **The root does not depend on the epoch.** A leaf is
/// `Poseidon(credentialId, secret, jurisdiction, tier, validUntilEpoch)` and the
/// epoch is in none of those, so the tree the issuer published for epoch 7 is
/// bit for bit the tree for epoch 8. That is what makes an expiring grant
/// recoverable at all: `RegistrationGate.publishRoot` is write once per epoch and
/// takes any epoch, so the issuer can publish the *same* root for a future epoch
/// today, before anybody needs it.
///
/// The epoch does two things and neither is the root. It enters the nullifier,
/// `Poseidon(secret, DOMAIN_KYC, epoch)`, so the sybil counter resets each epoch
/// and last epoch's proofs cannot be replayed. And it is checked against
/// `validUntilEpoch`, which is where a credential actually expires. The `valid`
/// credential runs to epoch 40.
/// `wide` adds `botCreds` after the four fixture credentials. The default
/// (narrow) tree is the one every committed fixture and the first gate's
/// published root are bound to; the wide one is what the second gate publishes.
export async function buildTree(epoch = EPOCH, {wide = false} = {}) {
    const e = BigInt(epoch);
    if (e < 0n) throw new RangeError(`epoch must not be negative: ${epoch}`);
    const poseidon = await buildPoseidon();
    const F = poseidon.F;
    const H = (xs) => F.toObject(poseidon(xs));
    const leafOf = (c) =>
        H([c.credentialId, c.secret, c.jurisdiction, c.tier, c.validUntilEpoch]);

    const leafNames = wide ? wideNames : names;
    const credOf = (name) => {
        const c = wide ? (creds[name] ?? botCreds[name]) : creds[name];
        if (!c) throw new RangeError(`no credential named ${name} in the ${wide ? "wide" : "narrow"} tree`);
        return c;
    };

    // Sparse Poseidon tree. Zero subtree hash per level, real nodes in a map.
    const zero = [0n];
    for (let i = 0; i < DEPTH; i++) zero.push(H([zero[i], zero[i]]));

    const nodes = [new Map()];
    leafNames.forEach((n, i) => nodes[0].set(i, leafOf(credOf(n))));
    for (let lvl = 0; lvl < DEPTH; lvl++) {
        const next = new Map();
        for (const idx of nodes[lvl].keys()) {
            const p = idx >> 1;
            if (next.has(p)) continue;
            const l = nodes[lvl].get(p * 2) ?? zero[lvl];
            const r = nodes[lvl].get(p * 2 + 1) ?? zero[lvl];
            next.set(p, H([l, r]));
        }
        nodes.push(next);
    }
    const root = nodes[DEPTH].get(0);

    function pathFor(index) {
        const pathElements = [];
        const pathIndices = [];
        let idx = index;
        for (let lvl = 0; lvl < DEPTH; lvl++) {
            const bit = idx & 1;
            const sib = idx ^ 1;
            pathIndices.push(BigInt(bit));
            pathElements.push(nodes[lvl].get(sib) ?? zero[lvl]);
            idx >>= 1;
        }
        return {pathElements, pathIndices};
    }

    /// One circuit input. `rootOverride` exists only for the forged-root case,
    /// where the prover honestly proves inclusion in a tree of their own.
    function inputFor(name, registrant, rootOverride) {
        const cred = credOf(name);
        const {pathElements, pathIndices} = pathFor(leafNames.indexOf(name));
        return {
            secret: cred.secret.toString(),
            credentialId: cred.credentialId.toString(),
            jurisdiction: cred.jurisdiction.toString(),
            tier: cred.tier.toString(),
            validUntilEpoch: cred.validUntilEpoch.toString(),
            pathElements: pathElements.map(String),
            pathIndices: pathIndices.map(String),
            credentialRoot: (rootOverride ?? root).toString(),
            epoch: e.toString(),
            registrant: registrant.toString(),
            minTier: MIN_TIER.toString(),
            jurisdictionMask: JUR_MASK.toString(),
        };
    }

    /// The fifth case, which is not a policy failure at all. The prover builds a
    /// private tree holding one credential they wrote themselves, proves honest
    /// inclusion in it, and gets `passes = 1`. The circuit has nothing to object
    /// to. Only the gate, which pins the root to what the issuer published, can
    /// refuse this.
    function forgedRootInput(registrant) {
        const mine = {credentialId: 99n, secret: 999n, jurisdiction: 0n, tier: 9n, validUntilEpoch: 99n};
        let cur = leafOf(mine);
        const pathElements = [], pathIndices = [];
        for (let lvl = 0; lvl < DEPTH; lvl++) {
            pathIndices.push(0n);
            pathElements.push(zero[lvl]);
            cur = H([cur, zero[lvl]]);
        }
        return {
            input: {
                secret: mine.secret.toString(), credentialId: mine.credentialId.toString(),
                jurisdiction: mine.jurisdiction.toString(), tier: mine.tier.toString(),
                validUntilEpoch: mine.validUntilEpoch.toString(),
                pathElements: pathElements.map(String), pathIndices: pathIndices.map(String),
                credentialRoot: cur.toString(), epoch: e.toString(),
                registrant: registrant.toString(), minTier: MIN_TIER.toString(),
                jurisdictionMask: JUR_MASK.toString(),
            },
            root: cur,
        };
    }

    return {root, epoch: e, wide, names: leafNames, inputFor, forgedRootInput};
}
