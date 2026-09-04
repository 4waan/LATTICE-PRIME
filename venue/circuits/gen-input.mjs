// Builds ONE issuer tree for one epoch, containing four real credentials, and
// writes a circuit input for each.
//
// The first version of this script varied the credential and recomputed the root
// from it, which meant every "policy failure" fixture also carried a different
// root. That is not the situation the gate is defending against: in the real
// system the root is pinned to what the issuer published, so a holder cannot
// present a credential the issuer never signed. The interesting case is a
// credential that IS in the issuer's tree and still fails the policy, and it only
// exists if the good and bad credentials share a tree.
import {buildPoseidon} from "circomlibjs";
import {writeFileSync, mkdirSync} from "fs";

const DEPTH = 16;
const EPOCH = 7n;
const REGISTRANT = BigInt("0xd30DE9C5aEF8079B4718B4988E8FD1D1A96F3115");
const MIN_TIER = 3n;
const JUR_MASK = 0xffn; // jurisdictions 0..7 admitted

const poseidon = await buildPoseidon();
const F = poseidon.F;
const H = (xs) => F.toObject(poseidon(xs));

// Four credentials the issuer has actually signed into this epoch's tree.
const creds = {
    valid:             {credentialId: 1n, secret: 111222333444555666777n, jurisdiction: 3n, tier: 4n, validUntilEpoch: 40n},
    fail_tier:         {credentialId: 2n, secret: 222333444555666777888n, jurisdiction: 3n, tier: 1n, validUntilEpoch: 40n},
    fail_epoch:        {credentialId: 3n, secret: 333444555666777888999n, jurisdiction: 3n, tier: 4n, validUntilEpoch: 5n},
    fail_jurisdiction: {credentialId: 4n, secret: 444555666777888999111n, jurisdiction: 9n, tier: 4n, validUntilEpoch: 40n},
};
const names = Object.keys(creds);
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

mkdirSync("circuits/build", {recursive: true});

function write(name, cred, index, rootOverride) {
    const {pathElements, pathIndices} = pathFor(index);
    const input = {
        secret: cred.secret.toString(),
        credentialId: cred.credentialId.toString(),
        jurisdiction: cred.jurisdiction.toString(),
        tier: cred.tier.toString(),
        validUntilEpoch: cred.validUntilEpoch.toString(),
        pathElements: pathElements.map(String),
        pathIndices: pathIndices.map(String),
        credentialRoot: (rootOverride ?? root).toString(),
        epoch: EPOCH.toString(),
        registrant: REGISTRANT.toString(),
        minTier: MIN_TIER.toString(),
        jurisdictionMask: JUR_MASK.toString(),
    };
    writeFileSync(`circuits/build/in_${name}.json`, JSON.stringify(input, null, 1));
}

names.forEach((n, i) => write(n, creds[n], i));

// A fifth case that is not a policy failure at all. The prover builds a private
// tree holding one credential they wrote themselves, proves honest inclusion in
// it, and gets `passes = 1`. The circuit has nothing to object to. Only the gate,
// which pins the root to what the issuer published, can refuse this.
{
    const mine = {credentialId: 99n, secret: 999n, jurisdiction: 0n, tier: 9n, validUntilEpoch: 99n};
    let cur = leafOf(mine);
    const pathElements = [], pathIndices = [];
    for (let lvl = 0; lvl < DEPTH; lvl++) {
        pathIndices.push(0n);
        pathElements.push(zero[lvl]);
        cur = H([cur, zero[lvl]]);
    }
    writeFileSync("circuits/build/in_forged_root.json", JSON.stringify({
        secret: mine.secret.toString(), credentialId: mine.credentialId.toString(),
        jurisdiction: mine.jurisdiction.toString(), tier: mine.tier.toString(),
        validUntilEpoch: mine.validUntilEpoch.toString(),
        pathElements: pathElements.map(String), pathIndices: pathIndices.map(String),
        credentialRoot: cur.toString(), epoch: EPOCH.toString(),
        registrant: REGISTRANT.toString(), minTier: MIN_TIER.toString(),
        jurisdictionMask: JUR_MASK.toString(),
    }, null, 1));
    console.log("forged root  ", cur.toString());
}

console.log("issuer root  ", root.toString());
console.log("cases        ", names.join(", "), ", forged_root");
