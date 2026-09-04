//! Wall-clock cost of the bn254 ecMul precompile body, measured through
//! `revm_precompile::bn254::run_mul` so the timed region is exactly what an EVM
//! CALL to 0x07 executes. Reports ns per call over a fixed pseudo-random scalar
//! stream, so two builds are comparable.
use revm_precompile::bn254::run_mul;
use std::time::Instant;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
}

fn main() {
    const N: usize = 20_000;
    let mut inputs = Vec::with_capacity(N);
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for _ in 0..N {
        let mut input = [0u8; 96];
        input[31] = 1;
        input[63] = 2;
        for c in input[64..].chunks_mut(8) {
            c.copy_from_slice(&rng.next().to_be_bytes());
        }
        input[64] &= 0x0f;
        inputs.push(input);
    }
    // warm up
    for i in inputs.iter().take(500) {
        std::hint::black_box(run_mul(i, 6_000, 100_000).unwrap());
    }
    let t = Instant::now();
    for i in &inputs {
        std::hint::black_box(run_mul(i, 6_000, 100_000).unwrap());
    }
    let e = t.elapsed();
    println!(
        "run_mul  {N} calls  {:?}  {:.0} ns/call  {:.0} calls/s",
        e,
        e.as_nanos() as f64 / N as f64,
        N as f64 / e.as_secs_f64()
    );
}
