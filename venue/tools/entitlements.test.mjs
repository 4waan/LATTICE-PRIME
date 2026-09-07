// The vectors for `tools/entitlements.mjs`. Three kinds.
//
// **The pinned literals** are the same values `test/UnitVectors.t.sol`'s
// `EntitlementVectorsTest` asserts against `MerkleSet` in Solidity. Neither file
// computes the other's, which is the arrangement `commitment.test.mjs` and
// `CommitmentVectors.t.sol` already use. It matters more here than it does for
// arithmetic, because the failure mode is silent: a client that builds this tree
// with a library that sorts pairs or duplicates the odd node gets a root the
// distributor does not recognise and proofs it refuses with `BadProof`, and
// nothing in the revert says the shape was wrong.
//
// **The generated sweep** builds every tree from one leaf to seventeen and
// checks each position's proof against `verify`, plus that a proof from one
// position does not verify at another. Seventeen because the widths that break a
// promotion-based tree are the odd ones and the ones just past a power of two,
// and this covers 1, 3, 5, 7, 9, 17 along with the clean cases.
//
// **The refusals** are the inputs the builder is supposed to reject. They carry
// no contract twin, because the point of each is that the value never reaches a
// transaction.
import {
    DOMAIN_LEAF, DOMAIN_NODE, EntitlementError,
    addressWord, leafOf, nodeOf, buildEntitlements, verify,
} from "./entitlements.mjs";

let bad = 0;
const eq = (what, got, want) => {
    if (got !== want) {
        console.error(`FAIL ${what}\n  got  ${got}\n  want ${want}`);
        bad++;
    }
};
const ok = (what, got) => eq(what, got, true);
const throws = (what, fn, match) => {
    try {
        fn();
    } catch (e) {
        if (!(e instanceof EntitlementError)) {
            console.error(`FAIL ${what}: threw ${e.constructor.name}, want EntitlementError`);
            bad++;
        } else if (match && !e.message.includes(match)) {
            console.error(`FAIL ${what}: message missing ${JSON.stringify(match)}\n  ${e.message}`);
            bad++;
        }
        return;
    }
    console.error(`FAIL ${what}: did not throw`);
    bad++;
};

const H1 = "0x0000000000000000000000000000000000000111";
const H2 = "0x0000000000000000000000000000000000000222";
const H3 = "0x0000000000000000000000000000000000000333";

// --------------------------------------------------------------- the tags

eq(
    "DOMAIN_LEAF",
    DOMAIN_LEAF,
    "0x8f66f67a98507050e4159cde36e2efabb01a5475db27d2d12245fdc676967b56",
);
eq(
    "DOMAIN_NODE",
    DOMAIN_NODE,
    "0xab9aa7d0323f49a3026d7125010067e19dada5e943630e4a6224488aedb6c125",
);

// ---------------------------------------------------------------- the leaf

// The scope rule. Same holder, same amount, different coupon, different leaf.
// A client that dropped the index would build a tree whose proofs cross between
// coupons, which is what `test_aProofFromAnotherCouponIsRefused` refuses on
// chain.
eq(
    "the leaf at coupon 0",
    leafOf(0, H1, 1000n),
    "0x051895e0779b153467b79dcdb750d3ee07afb31601303dbd0eb01a34f9d0b5ac",
);
eq(
    "the same pair at coupon 1",
    leafOf(1, H1, 1000n),
    "0xc4a60d40b351823c9aa638b61820b0e05858e44f23374ee54ec99fa3bc3db88e",
);
eq("the address is normalised, not checksummed", leafOf(0, H1.toUpperCase().replace("0X", "0x"), 1000n), leafOf(0, H1, 1000n));
eq(
    "the holder word is left-padded to 32 bytes",
    addressWord(H1),
    "0x0000000000000000000000000000000000000000000000000000000000000111",
);

// ---------------------------------------------------------------- the trees

// A tree of one: the root is the leaf and the proof is empty.
{
    const t = buildEntitlements(0, [{holder: H1, amount: 1000n}]);
    eq("a tree of one roots at its leaf", t.root, leafOf(0, H1, 1000n));
    eq("and its proof is empty", t.proofFor(0).length, 0);
    eq("width", t.width, 1);
    eq("total", t.total, 1000n);
}

// A tree of two, at a non-zero index. The root is the node over the pair, in
// order and not sorted.
{
    const t = buildEntitlements(7, [
        {holder: H1, amount: 1n},
        {holder: H2, amount: 2n},
    ]);
    eq(
        "a tree of two at coupon 7",
        t.root,
        "0x2431103dde7824e986ccfb90a532e941c9f222c9a904ec93747adfff1c2cbe0b",
    );
    eq("and the node is the pair in order", t.root, nodeOf(leafOf(7, H1, 1n), leafOf(7, H2, 2n)));
}

// The odd tree, which is the one that separates the two disciplines. Position 2
// is promoted at the leaf level, so its proof is one element and the other two
// need two. A library that duplicated the odd node would return two elements
// for every position and a different root.
{
    const t = buildEntitlements(0, [
        {holder: H2, amount: 2500n},
        {holder: H1, amount: 1000n},
        {holder: H3, amount: 4500n},
    ]);
    eq(
        "the three-leaf root",
        t.root,
        "0x80ff7e014666963a7a9d4cec7d4a9519d96a22f27e249ea04ae51f35a202a4a9",
    );
    eq("entries are sorted, not required in order", t.holders[0].holder, H1);
    eq("width", t.width, 3);
    eq("total", t.total, 8000n);

    const p0 = t.proofFor(0);
    const p1 = t.proofFor(1);
    const p2 = t.proofFor(2);
    eq("position 0 needs two elements", p0.length, 2);
    eq("position 1 needs two", p1.length, 2);
    eq("the promoted path needs one", p2.length, 1);

    eq("p0[0]", p0[0], "0xf84280408334aef6e4e77c3892cef0a2d36898ce41d35cd3a67df41a49c1ab7f");
    eq("p0[1]", p0[1], "0xbf9f306ac8a0e41aa2b8346a47be87a8c90bb6720d623074cb44f973b6bbb9f1");
    eq("p1[0]", p1[0], "0x051895e0779b153467b79dcdb750d3ee07afb31601303dbd0eb01a34f9d0b5ac");
    eq("p2[0]", p2[0], "0x4ccfa27f6569a8ce693d5349330117327792645be5c972a55b525b8843346632");

    ok("position 0 verifies", verify(t.root, leafOf(0, H1, 1000n), 0, 3, p0));
    ok("position 1 verifies", verify(t.root, leafOf(0, H2, 2500n), 1, 3, p1));
    ok("position 2 verifies", verify(t.root, leafOf(0, H3, 4500n), 2, 3, p2));

    // An unused tail is refused rather than ignored, which is the other half of
    // `p === proof.length`.
    eq(
        "a padded proof is refused",
        verify(t.root, leafOf(0, H3, 4500n), 2, 3, [p2[0], p2[0]]),
        false,
    );

    // The width is not redundant, though only a promoted path shows it: the
    // paths that would notice are exactly the ones an attacker would not pick,
    // which is why `declare` pins the width rather than trusting a claimant.
    eq(
        "the promoted path fails at a width the declaration did not pin",
        verify(t.root, leafOf(0, H3, 4500n), 2, 4, p2),
        false,
    );

    // And an amount the tree does not carry has no proof, whatever the path.
    eq(
        "a raised amount is refused",
        verify(t.root, leafOf(0, H1, 1001n), 0, 3, p0),
        false,
    );
}

// ------------------------------------------------------ the generated sweep

// Deterministic addresses, ascending, so the sweep is reproducible and the
// builder's sort has something to do.
const holderAt = (i) => "0x" + (BigInt(i + 1) * 0x1111n).toString(16).padStart(40, "0");

for (let n = 1; n <= 17; n++) {
    const entries = [];
    for (let i = 0; i < n; i++) entries.push({holder: holderAt(i), amount: BigInt(100 + i)});
    // Reversed on the way in, so every tree in the sweep also checks that the
    // root does not depend on the order the caller handed the pairs over in.
    const t = buildEntitlements(3, [...entries].reverse());
    eq(`width ${n}: sorted back`, t.holders[0].holder, entries[0].holder);
    eq(`width ${n}: total`, t.total, entries.reduce((s, e) => s + e.amount, 0n));

    for (let i = 0; i < n; i++) {
        const leaf = leafOf(3, entries[i].holder, entries[i].amount);
        const proof = t.proofFor(i);
        ok(`width ${n}: position ${i} verifies`, verify(t.root, leaf, i, n, proof));

        // A proof is bound to its position. Spending it at the next one over
        // must fail, and at width 1 there is no other position to try.
        if (n > 1) {
            const other = (i + 1) % n;
            eq(
                `width ${n}: position ${i}'s proof at ${other}`,
                verify(t.root, leaf, other, n, proof),
                false,
            );
        }

        // And bound to its coupon. The same tree at another index is a
        // different set of leaves.
        eq(
            `width ${n}: position ${i} against coupon 4`,
            verify(t.root, leafOf(4, entries[i].holder, entries[i].amount), i, n, proof),
            false,
        );
    }

    eq(`width ${n}: a position past the end`, verify(t.root, t.root, n, n, []), false);
}

// ---------------------------------------------------------- the refusals

throws("an empty tree", () => buildEntitlements(0, []), "at least one");
throws("a non-array", () => buildEntitlements(0, null), "at least one");
throws(
    "a duplicate holder",
    () =>
        buildEntitlements(0, [
            {holder: H1, amount: 1n},
            {holder: H1, amount: 2n},
        ]),
    "duplicate holder",
);
throws(
    "a zero amount",
    () => buildEntitlements(0, [{holder: H1, amount: 0n}]),
    "must be positive",
);
throws(
    "an amount that is not a bigint",
    () => buildEntitlements(0, [{holder: H1, amount: 100}]),
    "must be a bigint",
);
throws(
    "an address that is not one",
    () => buildEntitlements(0, [{holder: "0x111", amount: 1n}]),
    "20-byte address",
);
throws("a position outside the tree", () => {
    buildEntitlements(0, [{holder: H1, amount: 1n}]).proofFor(1);
}, "outside the tree");
throws("a holder the tree does not carry", () => {
    buildEntitlements(0, [{holder: H1, amount: 1n}]).positionOf(H3);
}, "not in this tree");
throws(
    "a truncated hash where a node should be",
    () => nodeOf("0x00", DOMAIN_NODE),
    "32-byte hex",
);

if (bad) {
    console.error(`\n${bad} failing vector${bad === 1 ? "" : "s"}`);
    process.exit(1);
}
console.log("entitlements: all vectors pass");
