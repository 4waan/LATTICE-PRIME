#!/usr/bin/env python3
"""Read the header of a circom-generated .r1cs and report the public/private split.

Why this exists
---------------
A circom `component main = X()` with no `{public [...]}` list compiles every
input to *private witness*. The circuit still proves something, the proof still
verifies on-chain, and the statement is vacuous, because nothing the verifier
sees is bound to anything. Source review does not catch it: the .circom file
looks correct and its comments will claim the inputs are public. The compiled
R1CS is the only artifact that knows the truth.

This is a thirty-line check that reads that truth. It is a probe against
prior-art/zerovault.md a prior-art finding, and it is meant to be kept as a CI gate over our
own circuits once they exist.

Usage
-----
    python3 r1cs-header.py <file.r1cs> [<file.r1cs> ...]
    python3 r1cs-header.py --selftest        # re-derive the ZeroVault finding

Exit status is non-zero if any circuit reports zero public inputs, which for our
purposes is always a bug.

Format reference: iden3 r1cs_bin_format.md. Header is section type 1:
    u32 fieldSize | fieldSize bytes prime | u32 nWires | u32 nPubOut
    u32 nPubIn    | u32 nPrvIn            | u64 nLabels | u32 nConstraints
"""

import struct
import sys
import urllib.request

# ZeroVault, github.com/irajgill/ZeroVault @ main, read .
SELFTEST = {
    "https://raw.githubusercontent.com/irajgill/ZeroVault/main/circuits/data_authenticity.r1cs":
        {"wires": 495, "pub_out": 1, "pub_in": 0, "prv_in": 6, "constraints": 491},
    "https://raw.githubusercontent.com/irajgill/ZeroVault/main/circuits/quality_proof.r1cs":
        {"wires": 1131, "pub_out": 2, "pub_in": 0, "prv_in": 13, "constraints": 1138},
}


def read_header(blob: bytes) -> dict:
    if blob[:4] != b"r1cs":
        raise ValueError(f"not an r1cs file (magic was {blob[:4]!r})")
    _version, n_sections = struct.unpack("<II", blob[4:12])
    off = 12
    for _ in range(n_sections):
        sec_type, sec_size = struct.unpack("<IQ", blob[off:off + 12])
        off += 12
        if sec_type == 1:
            field_size = struct.unpack("<I", blob[off:off + 4])[0]
            q = off + 4 + field_size
            wires, pub_out, pub_in, prv_in, labels, cons = struct.unpack(
                "<IIIIQI", blob[q:q + 28])
            return {"wires": wires, "pub_out": pub_out, "pub_in": pub_in,
                    "prv_in": prv_in, "labels": labels, "constraints": cons}
        off += sec_size
    raise ValueError("no header section (type 1) found")


def load(path: str) -> bytes:
    if path.startswith("http"):
        with urllib.request.urlopen(path, timeout=60) as r:
            return r.read()
    with open(path, "rb") as f:
        return f.read()


def main(argv: list[str]) -> int:
    selftest = "--selftest" in argv
    targets = list(SELFTEST) if selftest else [a for a in argv if not a.startswith("-")]
    if not targets:
        print(__doc__.strip())
        return 2

    print(f"{'circuit':<34} {'pubIn':>6} {'pubOut':>7} {'privIn':>7} {'wires':>7} {'cons':>7}")
    bad = 0
    for t in targets:
        h = read_header(load(t))
        name = t.rsplit("/", 1)[-1]
        print(f"{name:<34} {h['pub_in']:>6} {h['pub_out']:>7} {h['prv_in']:>7} "
              f"{h['wires']:>7} {h['constraints']:>7}")
        if selftest:
            want = SELFTEST[t]
            for k, v in want.items():
                assert h[k] == v, f"{name}: {k} was {h[k]}, expected {v}"
        if h["pub_in"] == 0:
            print(f"  ^^ ZERO PUBLIC INPUTS. The verifier is handed only outputs. "
                  f"Nothing in this proof is bound to a caller-visible value.")
            bad += 1

    if selftest:
        print("\nselftest OK: both ZeroVault circuits reproduce a prior-art finding exactly.")
        return 0
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
