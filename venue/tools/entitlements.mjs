// The entitlement tree, off chain. The client half of `MerkleSet` as
// `CouponDistributor` uses it.
//
// **This tree is positional and it is not the one your merkle library builds.**
// Two rules make it different, and both are load-bearing on chain:
//
//   1. Pairs are hashed in order and never sorted, so a proof carries a
//      position rather than direction bits it can infer.
//   2. An odd node is **promoted**, not duplicated, so the number of proof
//      elements a path needs depends on where it sits relative to every odd
//      level above it. `verify` therefore needs the leaf count, and a proof
//      with an unused tail is refused rather than ignored.
//
// A library that sorts pairs and duplicates odd nodes produces roots this
// contract will not recognise and proofs it will refuse, and it will do so
// silently: `claim` reverts `BadProof` and nothing says the shape was wrong.
// `src/merkle/MerkleSet.sol` carries the same three rules in the same order.
//
// `test/CouponFixture.sol` is the Solidity twin of this file and
// `tools/entitlements.test.mjs` carries the vectors both are checked against,
// on the rule this repo applies everywhere: every client-side copy of on-chain
// arithmetic is checked before anything inlines it.
import {keccak_256} from "./keccak.mjs";
import {hex} from "./commitment.mjs";

/// Thrown for every refusal here, so a caller can tell a rejected input from a
/// bug in the builder. `UnitError`'s reason, in `tools/units.mjs`.
export class EntitlementError extends Error {
    constructor(message) {
        super(message);
        this.name = "EntitlementError";
    }
}

/// The tags `CouponDistributor` publishes as `DOMAIN_LEAF` and `DOMAIN_NODE`.
/// Constants and not derived per call, so a client can check them against the
/// deployed contract's own getters rather than recompute them.
export const DOMAIN_LEAF = tag("hedera2026.coupon.entitlement.leaf.v1");
export const DOMAIN_NODE = tag("hedera2026.coupon.entitlement.node.v1");

function tag(s) {
    return hex(keccak_256(new TextEncoder().encode(s)));
}

// --------------------------------------------------------------- the words

const HEX = /^0x[0-9a-fA-F]*$/;

/// A 32-byte word from a bigint. Every field in a leaf is one, which is why
/// `abi.encode` and `abi.encodePacked` agree on chain today. They would stop
/// agreeing the moment a leaf carried a dynamic type, so this encodes the way
/// the standard does and not the way that happens to be shorter.
function word(v, what) {
    if (typeof v !== "bigint") {
        throw new EntitlementError(`${what} must be a bigint, got ${typeof v}`);
    }
    if (v < 0n || v >= 1n << 256n) throw new EntitlementError(`${what} is out of range`);
    return v.toString(16).padStart(64, "0");
}

/// A `bytes32` from a `0x` string, checked. A short hash silently left-padded
/// is a root that is wrong by a factor nobody can see.
function hex32(v, what) {
    if (typeof v !== "string" || !HEX.test(v) || v.length !== 66) {
        throw new EntitlementError(`${what} must be a 0x-prefixed 32-byte hex string`);
    }
    return v.slice(2).toLowerCase();
}

/// An address as the 32-byte word a leaf carries. Case is normalised rather
/// than checksummed: the tree hashes bytes, and two spellings of one address
/// must not produce two leaves.
export function addressWord(a) {
    if (typeof a !== "string" || !HEX.test(a) || a.length !== 42) {
        throw new EntitlementError(`holder must be a 0x-prefixed 20-byte address, got ${a}`);
    }
    return "0x" + a.slice(2).toLowerCase().padStart(64, "0");
}

function hash(...words) {
    const bytes = new Uint8Array(words.length * 32);
    words.forEach((w, i) => {
        for (let j = 0; j < 32; j++) {
            bytes[i * 32 + j] = parseInt(w.slice(j * 2, j * 2 + 2), 16);
        }
    });
    return hex(keccak_256(bytes));
}

// --------------------------------------------------------------- the shapes

/// `MerkleSet.leafOf(domain, scope, key, value)`: the four-word leaf.
///
/// The coupon index is **inside the leaf** and not in the domain tag. Without
/// it, a holder entitled to a hundred on coupon 3 holds a valid proof of a
/// hundred against every other coupon whose tree contains the same pair, and
/// the distributor cannot tell them apart because the leaf is all it sees.
/// `test_aProofFromAnotherCouponIsRefused`.
export function leafOf(index, holder, amount) {
    return hash(
        hex32(DOMAIN_LEAF, "DOMAIN_LEAF"),
        word(BigInt(index), "index"),
        hex32(addressWord(holder), "holder"),
        word(amount, "amount"),
    );
}

/// `MerkleSet.nodeOf(domain, a, b)`. Ordered, never sorted.
export function nodeOf(a, b) {
    return hash(hex32(DOMAIN_NODE, "DOMAIN_NODE"), hex32(a, "left"), hex32(b, "right"));
}

// ---------------------------------------------------------------- the tree

/// Every level of the tree, leaves first, root last.
///
/// Kept rather than collapsed because a proof needs the siblings and rebuilding
/// the whole tree per proof is quadratic on a holder list of any size. The
/// Solidity fixture does rebuild per proof, deliberately: it must not share
/// intermediate state with the verifier it is checking.
function levelsOf(leaves) {
    const levels = [leaves];
    let level = leaves;
    while (level.length > 1) {
        const next = [];
        for (let i = 0; i + 1 < level.length; i += 2) next.push(nodeOf(level[i], level[i + 1]));
        // Promoted, not duplicated. Duplicating the last node of an odd level
        // is the classic second-valid-tree bug: `n` leaves and the same set
        // with its last leaf repeated hash to the same root.
        if (level.length & 1) next.push(level[level.length - 1]);
        levels.push(next);
        level = next;
    }
    return levels;
}

/// Build the tree for one coupon from `(holder, amount)` entries.
///
/// Returns the root, the width `declare` pins alongside it, the total the
/// issuer has to have funded, and a `proofFor` bound to this tree.
///
/// Entries are sorted here rather than required in order, because the caller is
/// a mirror-node query and the mirror node has no reason to answer in address
/// order. The strict-ascent rule is still enforced after the sort, where it
/// catches the thing that actually matters: **a duplicate holder**, which would
/// otherwise be a second leaf for one address and a coupon paid twice.
export function buildEntitlements(index, entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new EntitlementError("an entitlement tree needs at least one entry");
    }
    if (!Number.isInteger(index) && typeof index !== "bigint") {
        throw new EntitlementError("index must be an integer");
    }

    const rows = entries
        .map(({holder, amount}) => {
            if (typeof amount !== "bigint") {
                throw new EntitlementError(`amount for ${holder} must be a bigint`);
            }
            if (amount <= 0n) {
                throw new EntitlementError(`amount for ${holder} must be positive`);
            }
            return {holder: holder.toLowerCase(), key: BigInt(addressWord(holder)), amount};
        })
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    for (let i = 1; i < rows.length; i++) {
        if (!(rows[i].key > rows[i - 1].key)) {
            throw new EntitlementError(`duplicate holder ${rows[i].holder}`);
        }
    }

    const leaves = rows.map((r) => leafOf(index, r.holder, r.amount));
    const levels = levelsOf(leaves);

    return {
        index: BigInt(index),
        root: levels[levels.length - 1][0],
        width: rows.length,
        total: rows.reduce((s, r) => s + r.amount, 0n),
        holders: rows.map((r) => ({holder: r.holder, amount: r.amount})),
        positionOf(holder) {
            const at = rows.findIndex((r) => r.holder === holder.toLowerCase());
            if (at < 0) throw new EntitlementError(`${holder} is not in this tree`);
            return at;
        },
        proofFor(position) {
            return proofAt(levels, position);
        },
    };
}

/// The sibling path for one position. A promoted node contributes nothing at
/// its level, which is why this can be shorter than the tree is deep and why a
/// verifier cannot infer the depth from `proof.length`.
function proofAt(levels, position) {
    if (!Number.isInteger(position) || position < 0 || position >= levels[0].length) {
        throw new EntitlementError(`position ${position} is outside the tree`);
    }
    const proof = [];
    let pos = position;
    for (let d = 0; d < levels.length - 1; d++) {
        const n = levels[d].length;
        if (!(n & 1 && pos === n - 1)) proof.push(levels[d][pos & 1 ? pos - 1 : pos + 1]);
        pos >>= 1;
    }
    return proof;
}

/// `MerkleSet.verify`, line for line, so a client can check a proof before it
/// sends the transaction that would revert on it.
///
/// The `width` argument is not redundant, and leaving it out is the bug this
/// comment exists to prevent: with promotion, a verifier that walked
/// `proof.length` levels would accept a path through a differently shaped tree
/// that happened to hash to the same root. `p === proof.length` at the end is
/// the other half of the same claim.
export function verify(root, leaf, position, width, proof) {
    if (!Number.isInteger(width) || width <= 0) return false;
    if (!Number.isInteger(position) || position < 0 || position >= width) return false;

    let h = leaf;
    let pos = position;
    let p = 0;
    let w = width;

    while (w > 1) {
        if (!(w & 1 && pos === w - 1)) {
            if (p === proof.length) return false;
            const sibling = proof[p++];
            h = pos % 2 === 0 ? nodeOf(h, sibling) : nodeOf(sibling, h);
        }
        pos >>= 1;
        // Rounds up, which is promotion counted: an odd level of `n` yields
        // `(n - 1) / 2` hashed nodes and one promoted one.
        w = (w + 1) >> 1;
    }

    return h === root && p === proof.length;
}
