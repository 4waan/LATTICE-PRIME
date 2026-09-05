// The client half of `OrderBook.commitmentOf`. Vectors live in
// `tools/commitment.test.mjs`; `test/CommitmentVectors.t.sol` asserts the same
// literals against the contract, so the two halves cannot drift silently.
import {keccak_256} from "./keccak.mjs";

export const hex = (b) => "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/// One 32 byte big-endian word. `abi.encode` of a static type is exactly this,
/// which is why the preimage is six words with no length prefix.
export function word(v) {
    let x = BigInt(v);
    if (x < 0n) throw new RangeError("negative");
    if (x >= 1n << 256n) throw new RangeError("wider than a word");
    const out = new Uint8Array(32);
    for (let i = 31; i >= 0; i--) {
        out[i] = Number(x & 0xffn);
        x >>= 8n;
    }
    return out;
}

export const DOMAIN_ORDER = hex(keccak_256(new TextEncoder().encode("hedera2026.orderbook.v1")));

export const SIDE = {BUY: 0, SELL: 1};

/// The six words in order, tagged with where each came from. The renderer wants
/// the tags; `commitmentOf` wants only the bytes.
///
/// The committer is in the preimage so a commitment lifted from the wire cannot
/// be submitted and revealed by someone else. Without it the stolen commitment
/// still verifies, which is what makes the omission easy to miss.
export function preimageWords(committer, side, price, qty, salt) {
    return [
        {name: "DOMAIN_ORDER", type: "bytes32", bytes: word(DOMAIN_ORDER), sig: 32, from: "constant"},
        {name: "committer", type: "address", bytes: word(committer), sig: 20, from: "wallet"},
        {name: "side", type: "uint8", bytes: word(side), sig: 1, from: "order"},
        {name: "price", type: "uint128", bytes: word(price), sig: 16, from: "order"},
        {name: "qty", type: "uint128", bytes: word(qty), sig: 16, from: "order"},
        {name: "salt", type: "bytes32", bytes: word(salt), sig: 32, from: "you"},
    ];
}

export function encodePreimage(committer, side, price, qty, salt) {
    const words = preimageWords(committer, side, price, qty, salt);
    const out = new Uint8Array(words.length * 32);
    words.forEach((w, i) => out.set(w.bytes, i * 32));
    return out;
}

export const commitmentOf = (committer, side, price, qty, salt) =>
    hex(keccak_256(encodePreimage(committer, side, price, qty, salt)));

/// `bytes4(keccak256(sig))`. Computed rather than pasted.
export const selector = (sig) => hex(keccak_256(new TextEncoder().encode(sig))).slice(0, 10);

/// `OrderBook.minimumCancelFee`, transcribed. `ceil(bond * delay / (delay + window))`,
/// rounded up because truncating leaves the fee a wei short of the bound.
export function minimumCancelFee(bond, delay, window) {
    const life = BigInt(delay) + BigInt(window);
    if (life === 0n) return 0n;
    return (BigInt(bond) * BigInt(delay) + life - 1n) / life;
}
