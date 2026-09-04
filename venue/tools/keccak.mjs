// keccak-256, the Ethereum variant. Sixty lines, no dependency.
//
// Node ships `sha3-256`, which is NIST SHA-3 and pads with 0x06. Ethereum uses
// the original Keccak padding, 0x01, and the two disagree on every input. This
// file exists so `gen-seammap.mjs` computes the same `bytes8(keccak256(...))`
// the Solidity does. `tools/keccak.test.mjs` checks it against three published
// vectors before anything downstream is allowed to use it.

const RC = [
    0x00000001n, 0x00008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n,
    0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n,
    0x0000000080008009n, 0x000000008000000an, 0x000000008000808bn,
    0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an,
    0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n,
    0x0000000080000001n, 0x8000000080008008n,
];
const R = [
    0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8,
    18, 2, 61, 56, 14,
];
const M = (1n << 64n) - 1n;
const rotl = (x, n) => n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M;

function f1600(A) {
    for (let round = 0; round < 24; round++) {
        const Cc = new Array(5);
        for (let x = 0; x < 5; x++) {
            Cc[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
        }
        for (let x = 0; x < 5; x++) {
            const Dd = Cc[(x + 4) % 5] ^ rotl(Cc[(x + 1) % 5], 1);
            for (let y = 0; y < 5; y++) A[x + 5 * y] ^= Dd;
        }
        const B = new Array(25).fill(0n);
        for (let x = 0; x < 5; x++) {
            for (let y = 0; y < 5; y++) {
                B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], R[x + 5 * y]);
            }
        }
        for (let x = 0; x < 5; x++) {
            for (let y = 0; y < 5; y++) {
                A[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & M) & B[((x + 2) % 5) + 5 * y];
            }
        }
        A[0] ^= RC[round];
    }
    return A;
}

export function keccak_256(input) {
    const rate = 136;
    const pad = new Uint8Array(rate - (input.length % rate));
    pad[0] = 0x01;
    pad[pad.length - 1] |= 0x80;
    const msg = new Uint8Array(input.length + pad.length);
    msg.set(input);
    msg.set(pad, input.length);

    let A = new Array(25).fill(0n);
    for (let off = 0; off < msg.length; off += rate) {
        for (let i = 0; i < rate / 8; i++) {
            let lane = 0n;
            for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(msg[off + i * 8 + b]);
            A[i] ^= lane;
        }
        A = f1600(A);
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 4; i++) {
        let lane = A[i];
        for (let b = 0; b < 8; b++) {
            out[i * 8 + b] = Number(lane & 0xffn);
            lane >>= 8n;
        }
    }
    return out;
}
