// Three published keccak-256 vectors. Run before trusting `gen-seammap.mjs`.
import {keccak_256} from "./keccak.mjs";
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const V = [
    ["", "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
    ["abc", "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"],
    ["Hello, world!", "b6e16d27ac5ab427a7f68900ac5559ce272dc6c37c82b3e052246c82244c50e4"],
];
let bad = 0;
for (const [msg, want] of V) {
    const got = hex(keccak_256(new TextEncoder().encode(msg)));
    if (got !== want) { console.error(`FAIL ${JSON.stringify(msg)}\n  got  ${got}\n  want ${want}`); bad++; }
}
console.log(bad ? `keccak: ${bad} FAILED` : `keccak: ${V.length} vectors ok`);
process.exit(bad ? 1 : 0);
