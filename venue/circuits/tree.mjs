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

export async function buildTree() {
    const poseidon = await buildPoseidon();
    const F = poseidon.F;
    const H = (xs) => F.toObject(poseidon(xs));
    const leafOf = (c) =>
        H([c.credentialId, c.secret, c.jurisdiction, c.tier, c.validUntilEpoch]);

    // Sparse Poseidon tree. Zero subtree hash per level, real nodes in a map.
    const zero = [0n];
    for (let i = 0; i < DEPTH; i++) zero.push(H([zero[i], zero[i]]));

    const nodes = [new Map()];
    names.forEach((n, i) => nodes[0].set(i, leafOf(creds[n])));
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
        const cred = creds[name];
        const {pathElements, pathIndices} = pathFor(names.indexOf(name));
        return {
            secret: cred.secret.toString(),
            credentialId: cred.credentialId.toString(),
            jurisdiction: cred.jurisdiction.toString(),
            tier: cred.tier.toString(),
            validUntilEpoch: cred.validUntilEpoch.toString(),
            pathElements: pathElements.map(String),
            pathIndices: pathIndices.map(String),
            credentialRoot: (rootOverride ?? root).toString(),
            epoch: EPOCH.toString(),
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
                credentialRoot: cur.toString(), epoch: EPOCH.toString(),
                registrant: registrant.toString(), minTier: MIN_TIER.toString(),
                jurisdictionMask: JUR_MASK.toString(),
            },
            root: cur,
        };
    }

    return {root, inputFor, forgedRootInput};
}
