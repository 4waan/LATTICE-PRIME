#!/usr/bin/env python3
"""
The arithmetic under `venue/src/oracle/OracleMath.sol` and `PrimeOracle`.

Written against the specification and not against the Solidity, for the reason
`probes/matching-clearing.py` is: a test that reimplements the contract's own
algorithm checks that the code does what the code does. What follows takes the
claims in prose and answers them by brute force, then writes the vectors
`venue/test/PrimeOracle.t.sol` replays.

Four questions.

  1. Does the median agree with an implementation that does not share its sort?
     `OracleMath` insertion-sorts a bounded array; this uses Python's `sorted`
     and slices the middle. If those ever disagree the fixture replay fails.

  2. How far can one dishonest publisher move the result?  This is the whole
     reason the panel is medianed rather than averaged, and it is a claim about
     *every* panel rather than about the panels a fuzzer happens to draw. Brute
     forced over every panel of every size up to the deployed bound, with the
     dishonest answer taken to both extremes of the type.

  3. What does the quorum buy?  The same sweep, with `f` dishonest answers
     rather than one, to find where the median leaves the honest range. The
     answer decides whether `_quorum` in the deploy script is a majority or the
     whole panel.

  4. Is the composite mark exact?  `markPerUnitTinybar` is
     `price * 1e8 // hbarUsd` in integer arithmetic. Where the division is not
     exact the contract floors, and the direction of that floor is a claim about
     who it favours.

Run:  python3 probes/oracle-median.py
"""

import json
import os
import random
from itertools import combinations_with_replacement

SEED = 20260907
HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "..", "venue", "test", "fixtures", "median.json")

MAX_PUBLISHERS = 7          # PrimeOracle.maxPublishers, as deployed
UINT128_MAX = 2**128 - 1
TINYBAR = 10**8


# --------------------------------------------------------------------------
# 1. The reference
# --------------------------------------------------------------------------

def median(xs):
    """Odd: the middle. Even: the floor of the mean of the two middle.

    The even rule is Chainlink's, whose `Median.sol` averages the two middle
    values and whose `avg` reduces to `(a + b) // 2` over non-negative inputs.
    Followed here so the repository holds one answer to the question rather
    than two.
    """
    a = sorted(xs)
    n = len(a)
    if n == 0:
        raise ValueError("empty panel")
    if n % 2 == 1:
        return a[n // 2]
    return (a[n // 2 - 1] + a[n // 2]) // 2


def deviation_bps(a, b):
    if b == 0:
        return 0
    return (abs(a - b) * 10_000) // b


def mark_per_unit_tinybar(clean_price, usd_per_hbar):
    """Both legs carry eight decimals, so the scale cancels."""
    return (clean_price * TINYBAR) // usd_per_hbar


# --------------------------------------------------------------------------
# 2. One dishonest publisher
# --------------------------------------------------------------------------

def brackets(honest):
    """The window a corrupted median must stay inside.

    Replacing one element of a sorted array moves every order statistic by at
    most one index: `a[i-1] <= b[i] <= a[i+1]`. Push that through the median
    formula and the window falls out, and it is the even case that makes the
    formula worth writing down rather than eyeballing — the median there is the
    mean of two adjacent statistics, so both of them move and the window is
    wider than one index of the honest array.

    Stated against the honest panel, because that is the number the venue would
    have published had nobody lied.
    """
    a = sorted(honest)
    n = len(a)
    k = n // 2
    at = lambda i: a[min(max(i, 0), n - 1)]
    if n % 2 == 1:
        return at(k - 1), at(k + 1)
    return (at(k - 2) + at(k - 1)) // 2, (at(k) + at(k + 1)) // 2


def sweep_one_liar():
    """Every panel of every size, one seat replaced by an extreme answer.

    Values are drawn from a small alphabet rather than randomly: the claim is
    about order and not about magnitude, so exhausting the orderings of a small
    set is a stronger statement than sampling a large one.
    """
    cases = 0
    failures = 0
    alphabet = [1, 2, 3, 5, 8]
    for n in range(3, MAX_PUBLISHERS + 1):
        for panel in combinations_with_replacement(alphabet, n):
            honest = list(panel)
            lo, hi = brackets(honest)
            for seat in range(n):
                for liar in (1, UINT128_MAX, min(alphabet), max(alphabet)):
                    corrupted = honest[:]
                    corrupted[seat] = liar
                    got = median(corrupted)
                    cases += 1
                    if not (lo <= got <= hi):
                        failures += 1
                        raise AssertionError(
                            f"panel {honest} seat {seat} liar {liar} -> {got}, "
                            f"outside [{lo}, {hi}]")
    return cases, failures


def sweep_one_liar_on_the_mean():
    """The same sweep against the mean, which is the arrangement not chosen."""
    worst = 0
    alphabet = [1, 2, 3, 5, 8]
    for n in range(3, MAX_PUBLISHERS + 1):
        for panel in combinations_with_replacement(alphabet, n):
            honest = list(panel)
            hi = max(honest)
            for seat in range(n):
                corrupted = honest[:]
                corrupted[seat] = UINT128_MAX
                got = sum(corrupted) // n
                worst = max(worst, got - hi)
    return worst


def sweep_f_liars():
    """Where the median leaves the honest range, as a function of f."""
    out = {}
    alphabet = [10, 20, 30, 40, 50]
    for n in range(1, MAX_PUBLISHERS + 1):
        for f in range(0, n + 1):
            escaped = False
            for panel in combinations_with_replacement(alphabet, n):
                honest = list(panel)
                lo, hi = min(honest), max(honest)
                for seats in combinations_with_replacement(range(n), f):
                    corrupted = honest[:]
                    for s in set(seats):
                        corrupted[s] = UINT128_MAX
                    got = median(corrupted)
                    if got < lo or got > hi:
                        escaped = True
                        break
                if escaped:
                    break
            out[(n, f)] = escaped
    return out


# --------------------------------------------------------------------------
# 3. The fixtures
# --------------------------------------------------------------------------

def build_fixtures():
    rng = random.Random(SEED)
    panels = []

    # Named cases first, so a failure reads as a sentence rather than as an index.
    named = [
        ("one seat is its own median", [100_00000000]),
        ("odd panel takes the middle", [99_00000000, 100_00000000, 101_00000000]),
        ("even panel floors the mean of the two middle",
         [99_00000000, 100_00000000, 100_00000001, 101_00000000]),
        ("the floor is a floor and not a round", [1, 2]),
        ("a liar at the top of the type moves it one seat",
         [99_00000000, 100_00000000, UINT128_MAX]),
        ("a liar at the bottom moves it one seat the other way",
         [1, 100_00000000, 101_00000000]),
        ("duplicates do not break the middle",
         [100_00000000, 100_00000000, 100_00000000, 100_00000000, 100_00000000]),
        ("the full deployed panel",
         [98_50000000, 99_25000000, 100_00000000, 100_12500000,
          100_50000000, 101_00000000, 103_75000000]),
    ]
    for what, xs in named:
        panels.append({"what": what, "xs": xs, "median": median(xs)})

    # Then random panels across every legal size, so the replay covers the
    # orderings nobody thought to name.
    for _ in range(64):
        n = rng.randint(1, MAX_PUBLISHERS)
        xs = [rng.randrange(1, 200 * 10**8) for _ in range(n)]
        panels.append({"what": "random", "xs": xs, "median": median(xs)})

    deviations = []
    for prev, nxt in [
        (100_00000000, 100_00000000),
        (100_00000000, 105_00000000),   # exactly 500 bps
        (100_00000000, 105_00000001),   # a hair over
        (100_00000000, 95_00000000),    # 500 bps down
        (100_00000000, 94_99999999),
        (1, 2),
        (3, 1),
    ]:
        deviations.append({"prev": prev, "next": nxt, "bps": deviation_bps(nxt, prev)})

    # The composite. `hbarUsd` values are the shape Chainlink answers with on
    # Hedera: eight decimals, so 0.08109665 USD arrives as 8109665.
    marks = []
    for price, hbar in [
        (100_00000000, 8109665),      # par, at the rate measured on 296
        (100_00000000, 10000000),     # a tidy 0.10 USD, so the answer is round
        (99_50000000, 8109665),
        (103_75000000, 5000000),
        (1, 3),                       # the floor, at the smallest scale there is
        (UINT128_MAX, 1),             # the bound the overflow claim rests on
    ]:
        marks.append({
            "cleanPrice": price,
            "usdPerHbar": hbar,
            "markPerUnitTinybar": mark_per_unit_tinybar(price, hbar),
        })

    # Counts alongside the arrays, because `vm.parseJson*` in Foundry has no
    # length primitive and `test/fixtures/clearing.json` already carries one for
    # the same reason.
    return {
        "panelCount": len(panels),
        "deviationCount": len(deviations),
        "markCount": len(marks),
        "panels": panels,
        "deviations": deviations,
        "marks": marks,
    }


# --------------------------------------------------------------------------

def main():
    print("PrimeOracle: the median, the deviation bound, and the composite mark")
    print("=" * 74)

    cases, failures = sweep_one_liar()
    drag = sweep_one_liar_on_the_mean()
    print()
    print("2. one dishonest publisher")
    print(f"   panels swept, sizes 3..{MAX_PUBLISHERS}:          {cases}")
    print(f"   landed outside the adjacent pair:  {failures}")
    print("   Read: on any panel of three or more, replacing one answer with")
    print("   anything at all, including the top of uint128, leaves the median")
    print("   between the honest answers on either side of the middle. It moves")
    print("   by one order statistic and no further.")
    print()
    print("   The same sweep against the mean, which is the arrangement not")
    print(f"   chosen: one liar drags it up to {drag} above the honest maximum.")
    print("   That is the whole argument for the median in one number.")

    esc = sweep_f_liars()
    print()
    print("3. f dishonest publishers: does the median leave the honest range?")
    print("   n\\f   " + "  ".join(f"{f}" for f in range(MAX_PUBLISHERS + 1)))
    for n in range(1, MAX_PUBLISHERS + 1):
        row = []
        for f in range(MAX_PUBLISHERS + 1):
            row.append("." if f > n else ("X" if esc[(n, f)] else "-"))
        print(f"   {n}     " + "  ".join(row))
    print("   '-' inside the honest range, 'X' outside it.")
    print("   The boundary is f >= n/2 at every n, which is what makes a strict")
    print("   majority the right quorum: it is the largest f the median still")
    print("   survives. DeployVenue._quorum is seats/2 + 1 for that reason.")

    print()
    print("4. the composite mark")
    for price, hbar in [(100_00000000, 8109665), (1, 3)]:
        got = mark_per_unit_tinybar(price, hbar)
        exact = price * TINYBAR / hbar
        print(f"   price {price:>42} / rate {hbar:<10} -> {got}")
        print(f"     exact {exact:.6f}, floored, so the loss is at most one tinybar")
    print("   The floor moves the mark down. A lower mark is a position closer")
    print("   to a margin call, which is toward the lender and away from the")
    print("   party the call is taken against. Stated in OracleMath's header.")

    fx = build_fixtures()
    os.makedirs(os.path.dirname(FIXTURE), exist_ok=True)
    with open(FIXTURE, "w") as f:
        json.dump(fx, f, indent=1)
        f.write("\n")
    print()
    print(f"5. wrote {len(fx['panels'])} panels, {len(fx['deviations'])} deviation "
          f"cases and {len(fx['marks'])} marks")
    print(f"   -> {os.path.relpath(FIXTURE, HERE)}")
    print("   venue/test/PrimeOracle.t.sol replays every one of them.")


if __name__ == "__main__":
    main()
