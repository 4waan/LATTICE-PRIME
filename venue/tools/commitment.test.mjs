// The vectors `test/CommitmentVectors.t.sol` asserts against the contract. Both
// files carry the same literals; neither computes the other's.
import {commitmentOf, DOMAIN_ORDER, minimumCancelFee, selector, SIDE} from "./commitment.mjs";

const V = [
    ["0x000000000000000000000000000000000000a11c", SIDE.SELL, 1_000_000n, 500n,
     "0x000000000000000000000000000000000000000000000000000000000000002a",
     "0x087d6fecb7ba175bbe38e107a77c79d0e97987a6777aecfc22587480585f0d55"],
    ["0x0000000000000000000000000000000000000000", SIDE.BUY, 0n, 0n,
     "0x0000000000000000000000000000000000000000000000000000000000000000",
     "0x04d63799f526c3f4a78284ed6044f1b2eb59c3a7694f28cb577537b1a627297a"],
    ["0xffffffffffffffffffffffffffffffffffffffff", SIDE.SELL, (1n << 128n) - 1n, (1n << 128n) - 1n,
     "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
     "0xa81015b59fe8780581d4cd24ba1dcc34428c3d343edcd99da11735cc10cfa8ad"],
    ["0x00000000000000000000000000000000000a11ce", SIDE.BUY, 9_876_543n, 42n,
     "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
     "0xa4f0ab0ee91b3505d6e38cc7f26cd23fac3e854fdd08eecb73a72ebb6a282930"],
];

let bad = 0;
const eq = (what, got, want) => {
    if (got !== want) {
        console.error(`FAIL ${what}\n  got  ${got}\n  want ${want}`);
        bad++;
    }
};

eq("DOMAIN_ORDER", DOMAIN_ORDER,
   "0x6d04045e7ab73fdb5477bc72228c72a7f596d3790608f982e92be89ae991107d");
eq("selector commit(bytes32)", selector("commit(bytes32)"), "0xf14fcbc8");
eq("minimumCancelFee", minimumCancelFee(10n ** 17n, 300, 1800).toString(), "14285714285714286");

for (const [c, s, p, q, salt, want] of V) eq(`commitmentOf(${c})`, commitmentOf(c, s, p, q, salt), want);

console.log(bad ? `commitment: ${bad} FAILED` : `commitment: ${V.length + 3} vectors ok`);
process.exit(bad ? 1 : 0);
