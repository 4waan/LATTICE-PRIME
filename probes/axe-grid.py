#!/usr/bin/env python3
"""Independent oracle for AxeGrid bands, rectangle count, and the axe-bond floor.

Writes `venue/test/fixtures/axe-grid.json` for `AxeGrid.t.sol`.
"""

import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "..", "venue", "test", "fixtures", "axe-grid.json")

CLASS_CARD = 8
SIZE_CARD = 16
RATE_CARD = 16
RATE_BAND_BPS = 25
UINT256_MAX = (1 << 256) - 1


def venue_bucket(v):
    b = 0
    while v >= 10:
        v //= 10
        b += 1
    return b


def size_band(v):
    b = 0
    while v >= 10 and b < SIZE_CARD - 1:
        v //= 10
        b += 1
    return b


def size_band_low(b):
    if b == 0:
        return 0
    return 10 ** b


def size_band_high(b):
    if b == SIZE_CARD - 1:
        return UINT256_MAX
    return 10 ** (b + 1) - 1


def rate_band(bps):
    b = bps // RATE_BAND_BPS
    return RATE_CARD - 1 if b >= RATE_CARD else b


def rate_band_low(b):
    return b * RATE_BAND_BPS


def rate_band_high(b):
    if b == RATE_CARD - 1:
        return UINT256_MAX
    return (b + 1) * RATE_BAND_BPS - 1


def intervals_on(n):
    return n * (n + 1) // 2


def rectangle_count():
    return CLASS_CARD * intervals_on(SIZE_CARD) * intervals_on(RATE_CARD)


def rectangle_bits():
    n = rectangle_count()
    bits = 0
    pow2 = 1
    while pow2 < n:
        pow2 <<= 1
        bits += 1
    return bits


def minimum_axe_bond(commit_bond, probe_fee, max_outstanding):
    if probe_fee >= commit_bond:
        return 1
    return max_outstanding * (commit_bond - probe_fee) + 1


def _meets(lo, hi, band_lo, band_hi):
    return band_lo <= hi and band_hi >= lo


def exhaust_intersection(band_fn, low_fn, high_fn, card, samples):
    violations = 0
    checks = 0
    for lo in samples:
        for hi in samples:
            if lo > hi:
                continue
            blo = band_fn(lo)
            bhi = band_fn(hi)
            for b in range(card):
                checks += 1
                claimed = blo <= b <= bhi
                actual = _meets(lo, hi, low_fn(b), high_fn(b))
                if claimed != actual:
                    violations += 1
    return checks, violations


def size_samples():
    out = {0, 1, 9, UINT256_MAX}
    for b in range(SIZE_CARD):
        lo = size_band_low(b)
        hi = size_band_high(b)
        out.add(lo)
        if hi != UINT256_MAX:
            out.add(hi)
            out.add(hi + 1)
        if lo > 0:
            out.add(lo - 1)
        if hi != UINT256_MAX and hi > lo:
            out.add(lo + (hi - lo) // 2)
    return sorted(out)


def rate_samples():
    out = {0, 1, 24, 25, 374, 375, 376, 10_000, UINT256_MAX}
    for b in range(RATE_CARD):
        lo = rate_band_low(b)
        hi = rate_band_high(b)
        out.add(lo)
        if hi != UINT256_MAX:
            out.add(hi)
            out.add(hi + 1)
        if lo > 0:
            out.add(lo - 1)
    return sorted(out)


def honesty_dominates(axe_bond, commit_bond, probe_fee, max_outstanding):
    for k in range(1, max_outstanding + 1):
        if axe_bond + k * probe_fee <= k * commit_bond:
            return False
    return True


def main():
    size_s = size_samples()
    rate_s = rate_samples()
    size_checks, size_viol = exhaust_intersection(
        size_band, size_band_low, size_band_high, SIZE_CARD, size_s
    )
    rate_checks, rate_viol = exhaust_intersection(
        rate_band, rate_band_low, rate_band_high, RATE_CARD, rate_s
    )

    rects = rectangle_count()
    bits = rectangle_bits()
    assert rects == 8 * 136 * 136 == 147_968, rects
    assert bits == 18, bits
    assert (1 << 17) < rects <= (1 << 18)
    assert size_viol == 0, size_viol
    assert rate_viol == 0, rate_viol

    below = [0, 1, 9, 10, 99, 100, 10 ** 14, 10 ** 15 - 1, 10 ** 15]
    for v in below:
        assert size_band(v) == venue_bucket(v), (v, size_band(v), venue_bucket(v))
    assert size_band(10 ** 16) == 15
    assert venue_bucket(10 ** 16) == 16
    assert size_band(UINT256_MAX) == 15

    bond_rows = [
        {"commit": 10 ** 17, "fee": 10 ** 16, "m": 4, "floor": None},
        {"commit": 10 ** 17, "fee": 10 ** 17, "m": 4, "floor": None},
        {"commit": 10 ** 17, "fee": 2 * 10 ** 17, "m": 8, "floor": None},
        {"commit": 1, "fee": 0, "m": 1, "floor": None},
        {"commit": 1000, "fee": 1, "m": 7, "floor": None},
    ]
    for row in bond_rows:
        floor = minimum_axe_bond(row["commit"], row["fee"], row["m"])
        row["floor"] = floor
        assert honesty_dominates(floor, row["commit"], row["fee"], row["m"])
        if floor > 1:
            assert not honesty_dominates(
                floor - 1, row["commit"], row["fee"], row["m"]
            )

    size_vectors = [{"v": str(v), "b": size_band(v)} for v in below + [10 ** 16, UINT256_MAX]]
    rate_vectors = [
        {"v": v, "b": rate_band(v)}
        for v in [0, 24, 25, 49, 50, 374, 375, 376, 10_000]
    ]

    fixture = {
        "rectangleCount": rects,
        "rectangleBits": bits,
        "sizeChecks": size_checks,
        "rateChecks": rate_checks,
        "sizeBand": size_vectors,
        "rateBand": rate_vectors,
        "bond": bond_rows,
    }

    os.makedirs(os.path.dirname(FIXTURE), exist_ok=True)
    with open(FIXTURE, "w") as f:
        json.dump(fixture, f, indent=2)
        f.write("\n")

    print("== axe grid ==")
    print(f"  rectangles:          {rects}")
    print(f"  bits:                {bits}")
    print(f"  size lemma checks:   {size_checks}  violations {size_viol}")
    print(f"  rate lemma checks:   {rate_checks}  violations {rate_viol}")
    print(f"  bond vectors:        {len(bond_rows)}")
    print(f"  wrote {os.path.relpath(FIXTURE, os.path.join(HERE, '..'))}")


if __name__ == "__main__":
    main()
