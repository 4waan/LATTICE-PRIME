//! Algebraic conformance oracle for the bn254 G1 scalar multiplication that
//! sits behind precompile 0x07.
//!
//! Every check here is an identity that is true by the group law for ANY input.
//! None of them needs a reference implementation or a copied test vector, which
//! is the same reason `e(-P,Q).e(P,Q) == 1` was the load-bearing pairing test:
//! a vector only proves agreement with whoever produced it, an identity proves
//! the operation is the operation.
//!
//! Everything runs through `revm_precompile::bn254::{run_mul, run_add}`, so the
//! bytes take the exact path an EVM CALL to 0x07 or 0x06 takes.

use revm_precompile::bn254::{run_add, run_mul};

const R: [u8; 32] = hex_lit(
    "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
);

const fn hex_lit(s: &str) -> [u8; 32] {
    let b = s.as_bytes();
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        let hi = hexval(b[2 * i]);
        let lo = hexval(b[2 * i + 1]);
        out[i] = hi * 16 + lo;
        i += 1;
    }
    out
}
const fn hexval(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        _ => 0,
    }
}

fn mul(p: &[u8; 64], k: &[u8; 32]) -> [u8; 64] {
    let mut input = [0u8; 96];
    input[..64].copy_from_slice(p);
    input[64..].copy_from_slice(k);
    let out = run_mul(&input, 6_000, 100_000).expect("0x07 rejected a valid point");
    let mut r = [0u8; 64];
    r.copy_from_slice(&out.bytes);
    r
}

fn add(a: &[u8; 64], b: &[u8; 64]) -> [u8; 64] {
    let mut input = [0u8; 128];
    input[..64].copy_from_slice(a);
    input[64..].copy_from_slice(b);
    let out = run_add(&input, 150, 100_000).expect("0x06 rejected a valid point");
    let mut r = [0u8; 64];
    r.copy_from_slice(&out.bytes);
    r
}

/// Scalars are compared and added modulo r as 256-bit big-endian integers.
fn add_mod_r(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut s = [0u8; 32];
    let mut carry = 0u16;
    for i in (0..32).rev() {
        let v = a[i] as u16 + b[i] as u16 + carry;
        s[i] = v as u8;
        carry = v >> 8;
    }
    if carry > 0 || !lt(&s, &R) {
        let mut borrow = 0i16;
        for i in (0..32).rev() {
            let v = s[i] as i16 - R[i] as i16 - borrow;
            s[i] = v as u8;
            borrow = if v < 0 { 1 } else { 0 };
        }
    }
    s
}
fn lt(a: &[u8; 32], b: &[u8; 32]) -> bool {
    for i in 0..32 {
        if a[i] != b[i] {
            return a[i] < b[i];
        }
    }
    false
}

/// xorshift64*, so the scalar stream is reproducible without a dependency.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn scalar(&mut self) -> [u8; 32] {
        let mut s = [0u8; 32];
        for c in s.chunks_mut(8) {
            c.copy_from_slice(&self.next().to_be_bytes());
        }
        s[0] &= 0x0f; // keep it below r without a full reduction
        s
    }
}

fn main() {
    let mut g = [0u8; 64];
    g[31] = 1;
    g[63] = 2;
    let zero = [0u8; 64];

    let mut fails = 0usize;
    let mut checks = 0usize;
    let mut note = |name: &str, ok: bool, fails: &mut usize, checks: &mut usize| {
        *checks += 1;
        if !ok {
            *fails += 1;
            println!("  FAIL  {name}");
        }
    };

    // Fixed identities.
    let mut one = [0u8; 32];
    one[31] = 1;
    let mut two = [0u8; 32];
    two[31] = 2;
    note("mul(G, 1) == G", mul(&g, &one) == g, &mut fails, &mut checks);
    note("mul(G, 0) == O", mul(&g, &[0u8; 32]) == zero, &mut fails, &mut checks);
    note("mul(G, r) == O", mul(&g, &R) == zero, &mut fails, &mut checks);
    note("mul(G, 2) == G + G", mul(&g, &two) == add(&g, &g), &mut fails, &mut checks);
    note("mul(O, k) == O", mul(&zero, &two) == zero, &mut fails, &mut checks);

    // Homomorphism over a reproducible random scalar stream. This is the check
    // that actually exercises the GLV decomposition and the wNAF recoding: a
    // wrong window, a wrong sign branch or a mis-indexed table breaks
    // mul(G,a) + mul(G,b) == mul(G, a+b) for some a, b almost immediately.
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut homo_fail = 0usize;
    const N: usize = 512;
    for _ in 0..N {
        let a = rng.scalar();
        let b = rng.scalar();
        let lhs = add(&mul(&g, &a), &mul(&g, &b));
        let rhs = mul(&g, &add_mod_r(&a, &b));
        if lhs != rhs {
            homo_fail += 1;
        }
    }
    note(
        &format!("mul(G,a) + mul(G,b) == mul(G, a+b)  over {N} random pairs"),
        homo_fail == 0,
        &mut fails,
        &mut checks,
    );
    if homo_fail > 0 {
        println!("        {homo_fail}/{N} pairs disagreed");
    }

    // Endomorphism-boundary scalars. GLV splits k near sqrt(r); values that
    // land a half-scalar on a window edge are where a recoding bug hides.
    let mut edge_fail = 0usize;
    let mut edges: Vec<[u8; 32]> = Vec::new();
    for bit in 0..255u32 {
        let mut s = [0u8; 32];
        s[31 - (bit / 8) as usize] = 1u8 << (bit % 8);
        if lt(&s, &R) {
            edges.push(s);
        }
    }
    for k in &edges {
        let k1 = add_mod_r(k, &one);
        if add(&mul(&g, k), &g) != mul(&g, &k1) {
            edge_fail += 1;
        }
    }
    note(
        &format!("mul(G, 2^i) + G == mul(G, 2^i + 1)  for all {} bit positions", edges.len()),
        edge_fail == 0,
        &mut fails,
        &mut checks,
    );

    println!(
        "\n{} checks, {} failed",
        checks,
        fails
    );
    if fails > 0 {
        std::process::exit(1);
    }
}
