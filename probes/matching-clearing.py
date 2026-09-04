#!/usr/bin/env python3
"""
The arithmetic under `venue/src/market/CallAuction.sol` and `MatchingEngine.sol`.

Five questions, none of which a Solidity test can answer on its own, because each
one is a claim about *every* book rather than about the books a fuzzer happened to
draw.

  1. Is a scan over submitted prices complete, or only a heuristic?  The engine is
     O(n^2) over submitted prices. If the executable volume can peak strictly
     between two submitted prices, that scan is wrong and no amount of fuzzing the
     scan itself would say so.
  2. Is the tie-break total?  Maximum executable volume has ties. So does minimum
     imbalance. If either argmax set can be disconnected, "the midpoint" is not
     well defined and two honest implementations can disagree about a clearing
     price.
  3. Which tie-break, and what does the choice cost?  Lowest, highest and midpoint
     all clear the same volume. They do not move the same money.
  4. Where does the rounding go?  A clearing price that is the mean of two
     integers is a half-integer half the time, and the venue settles in integer
     minor units.
  5. Does resting orders across rounds pay for itself, and does splitting the book
     cost anything?  Both are design levers with a measured price, at THIS venue's
     order rate and not at a liquid one's.

Everything below is brute force against a reference implementation. The reference
is the oracle for `venue/test/CallAuction.t.sol`, which replays the vectors this
script writes to `venue/test/fixtures/clearing.json`.

Run:  python3 probes/matching-clearing.py
"""

import json
import math
import os
import random
import statistics
from fractions import Fraction

SEED = 20260904
HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "..", "venue", "test", "fixtures", "clearing.json")

BUY, SELL = 0, 1


# --------------------------------------------------------------------------
# 1. The reference clearing rule
# --------------------------------------------------------------------------
#
# Uniform price call auction. Demand at p is every buy willing to pay at least p;
# supply at p is every sell willing to accept at most p.
#
#   D(p) = sum of qty over buys  with price >= p     non-increasing in p
#   S(p) = sum of qty over sells with price <= p     non-decreasing in p
#   V(p) = min(D(p), S(p))                           executable volume
#
# The rule, in order:
#   (a) maximise V
#   (b) among those, minimise the imbalance |D - S|
#   (c) among those, take the midpoint of the surviving price interval
#
# (a) then (b) is the rule real call auctions use. (c) is the part this file is
# here to justify, because it is the only step that invents a number rather than
# selecting one.

def demand(orders, p):
    return sum(q for side, pr, q in orders if side == BUY and pr >= p)


def supply(orders, p):
    return sum(q for side, pr, q in orders if side == SELL and pr <= p)


def clear(orders):
    """Returns (p2, volume, lo, hi) with p2 = lo + hi, the clearing price at
    TWICE scale. The doubled price is the return value and not an intermediate,
    because halving it here is exactly the rounding this script measures."""
    prices = sorted({pr for _, pr, _ in orders})
    if not prices:
        return None
    best = -1
    for p in prices:
        v = min(demand(orders, p), supply(orders, p))
        if v > best:
            best = v
    if best <= 0:
        return None

    maximisers = [p for p in prices
                  if min(demand(orders, p), supply(orders, p)) == best]
    imb = [abs(demand(orders, p) - supply(orders, p)) for p in maximisers]
    least = min(imb)
    survivors = [p for p, i in zip(maximisers, imb) if i == least]
    lo, hi = survivors[0], survivors[-1]
    return (lo + hi, best, lo, hi)


def fills(orders, p2, volume):
    """Which orders trade, and how much.

    Price priority down to the marginal level, then PRO RATA by size at that
    level. Not array order, and the difference is the whole reason there is a
    rule here at all: array order is reveal order, reveal order is a time
    priority, and a time priority at the marginal level is manipulable by late
    reveal. Pro rata has nothing to game.

    The remainder from flooring is handed out one minor unit at a time in array
    order, which IS a time priority, over at most (k-1) units where k is the
    number of orders at the marginal level. That residue is stated rather than
    removed: no allocation of an integer volume across integer lots is both
    exactly proportional and exhaustive, and the alternative to a stated
    tie-break is a lost unit.

    Lemma the loop depends on: V is constant on the whole real interval [lo, hi],
    not merely at its submitted endpoints. For p in [lo, hi], D(lo) >= D(p) >=
    D(hi) and S(lo) <= S(p) <= S(hi), so V(p) >= min(D(hi), S(lo)); and
    V(lo) <= S(lo) with V(hi) <= D(hi) give min(D(hi), S(lo)) >= best. So the
    eligible quantity on each side at the midpoint is at least `volume`, and the
    marginal level the loop below looks for always exists. Without that lemma the
    midpoint tie-break could name a price at which the cleared volume is not
    executable."""
    out = [0] * len(orders)
    for side in (BUY, SELL):
        elig = [i for i, (s_, pr, q) in enumerate(orders)
                if s_ == side and ((2 * pr >= p2) if side == BUY else (2 * pr <= p2))]
        levels = sorted({orders[i][1] for i in elig}, reverse=(side == BUY))
        cum, marginal = 0, None
        for lv in levels:
            at_lv = sum(orders[i][2] for i in elig if orders[i][1] == lv)
            if cum + at_lv >= volume:
                marginal = lv
                break
            cum += at_lv
        assert marginal is not None, "eligible qty below the cleared volume"
        better = [i for i in elig
                  if (orders[i][1] > marginal if side == BUY else orders[i][1] < marginal)]
        for i in better:
            out[i] = orders[i][2]
        residual = volume - sum(orders[i][2] for i in better)
        at = [i for i in elig if orders[i][1] == marginal]
        tot = sum(orders[i][2] for i in at)
        given = 0
        for i in at:
            out[i] = residual * orders[i][2] // tot
            given += out[i]
        rem = residual - given
        for i in at:
            if rem == 0:
                break
            if out[i] < orders[i][2]:
                out[i] += 1
                rem -= 1
        assert rem == 0, "remainder did not fit"
        assert sum(out[i] for i in elig) == volume, "side does not sum to the volume"
    return out


# --------------------------------------------------------------------------
# 2. Random books
# --------------------------------------------------------------------------

def book(rng, n=None, pmax=200, qmax=1000):
    n = n if n is not None else rng.randint(2, 10)
    return [(rng.randint(0, 1), rng.randint(1, pmax), rng.randint(1, qmax))
            for _ in range(n)]


# --------------------------------------------------------------------------
# 3. Theorem A: the maximum is attained at a submitted price
# --------------------------------------------------------------------------

def theorem_a(trials, rng):
    """Brute force V over a grid finer than the submitted prices, including the
    half-integers strictly between them, and check nothing beats the best
    submitted price.

    If this ever fails, `CallAuction._clear`'s scan is incomplete and the engine
    is clearing at a price that is not the venue's own rule."""
    violations = 0
    checked = 0
    for _ in range(trials):
        b = book(rng)
        prices = sorted({pr for _, pr, _ in b})
        if not prices:
            continue
        best_submitted = max(min(demand(b, p), supply(b, p)) for p in prices)
        # every half step across the whole submitted range, plus outside it
        grid = set()
        for p in range(2 * (min(prices) - 2), 2 * (max(prices) + 2) + 1):
            grid.add(Fraction(p, 2))
        best_grid = max(min(demand(b, p), supply(b, p)) for p in grid)
        checked += 1
        if best_grid > best_submitted:
            violations += 1
    return checked, violations


# --------------------------------------------------------------------------
# 4. Theorem B: both argmax sets are intervals
# --------------------------------------------------------------------------

def theorem_b(trials, rng):
    """V is the min of a non-increasing and a non-decreasing function, so it is
    quasi-concave and its argmax is an interval. |D-S| is max(D,S) minus a
    constant on that interval, and max of a non-increasing and a non-decreasing
    function is quasi-convex, so its argmin is an interval too.

    Both are checked as CONNECTEDNESS over the submitted price list: the indices
    of the argmax must be contiguous. A gap would make "the midpoint" a price
    that is not itself a maximiser."""
    gaps_v = 0
    gaps_imb = 0
    checked = 0
    for _ in range(trials):
        b = book(rng)
        prices = sorted({pr for _, pr, _ in b})
        if not prices:
            continue
        vs = [min(demand(b, p), supply(b, p)) for p in prices]
        best = max(vs)
        if best <= 0:
            continue
        checked += 1
        idx = [i for i, v in enumerate(vs) if v == best]
        if idx != list(range(idx[0], idx[-1] + 1)):
            gaps_v += 1
        imb = [abs(demand(b, prices[i]) - supply(b, prices[i])) for i in idx]
        least = min(imb)
        jdx = [i for i, v in zip(idx, imb) if v == least]
        if jdx != list(range(jdx[0], jdx[-1] + 1)):
            gaps_imb += 1
    return checked, gaps_v, gaps_imb


# --------------------------------------------------------------------------
# 5. What the tie-break costs
# --------------------------------------------------------------------------

def tiebreak_bias(trials, rng):
    """Three rules that clear identical volume, priced.

    Signed bias is measured in favour of the BUYER: a lower clearing price is
    better for the buyer, so bias = (reference - chosen), reference being the
    midpoint at exact (fractional) arithmetic. A rule with a non-zero mean bias
    is a rule that pays one side of the book, every round, forever."""
    lo_bias, hi_bias, mid_bias = [], [], []
    crossing = 0
    lost_lo = lost_hi = lost_mid = 0
    for _ in range(trials):
        b = book(rng)
        c = clear(b)
        if c is None:
            continue
        p2, vol, lo, hi = c
        crossing += 1
        exact = Fraction(p2, 2)
        lo_bias.append(float(exact - lo))
        hi_bias.append(float(exact - hi))
        mid_bias.append(float(exact - (p2 // 2)))
        # volume actually executable at each choice
        for p, acc in ((lo, "lo"), (hi, "hi"), (p2 // 2, "mid")):
            v = min(demand(b, p), supply(b, p))
            if v < vol:
                if acc == "lo":
                    lost_lo += 1
                elif acc == "hi":
                    lost_hi += 1
                else:
                    lost_mid += 1
    return {
        "crossing": crossing,
        "lo": (statistics.mean(lo_bias), lost_lo),
        "hi": (statistics.mean(hi_bias), lost_hi),
        "mid": (statistics.mean(mid_bias), lost_mid),
    }


def rounding_error(trials, rng, qmax=1000):
    """The finding this whole file exists for.

    A clearing price is the mean of two integers, so it is a half-integer half
    the time. Settlement is `price * qty` in integer minor units. Two orders of
    operation:

        round the price first:    floor(p2 / 2) * qty
        carry at 2x, divide once: floor(p2 * qty / 2)

    The error of the first is `qty * frac(p2/2)`, which is `qty/2` whenever the
    two surviving maximisers have odd sum and 0 otherwise. The error of the
    second is `frac(p2*qty/2)`, which is at most one half, always.

    So the gap is NOT a constant factor to be quoted. It is linear in the lot
    size against a bound of one half, which is why `qmax` is swept: on a bond lot
    of a hundred thousand units the first order of operations is out by up to
    fifty thousand minor units and the second is still out by at most one."""
    first, once = [], []
    for _ in range(trials):
        b = book(rng, qmax=qmax)
        c = clear(b)
        if c is None:
            continue
        p2, vol, lo, hi = c
        for f in fills(b, p2, vol):
            if f == 0:
                continue
            truth = Fraction(p2 * f, 2)
            first.append(abs(float(truth - (p2 // 2) * f)))
            once.append(abs(float(truth - (p2 * f) // 2)))
    return {
        "n": len(first),
        "qmax": qmax,
        "first": (statistics.mean(first), max(first)),
        "once": (statistics.mean(once), max(once)),
    }


# --------------------------------------------------------------------------
# 6. Crossings: does resting pay?
# --------------------------------------------------------------------------
#
# The venue's own order rate, not a liquid market's. the results notes section 4 gives 50
# counterparties and section 3 gives 12 trades a year each, so 600 orders a year,
# Poisson. Buys and sells are independent by thinning at one half.
#
# Crossings are counted as min(buys, sells) among the live book, which is an UPPER
# BOUND: it assumes every buy crosses every sell, i.e. that price never gets in
# the way. The bound is the right object here because the question is whether
# there is anyone to trade with at all, not whether the prices agree.

ORDERS_PER_YEAR = 600
YEAR = 365 * 24 * 3600


def crossings(rng, round_seconds, rest_rounds, books=1, years=200):
    rounds = int(years * YEAR / round_seconds)
    lam = ORDERS_PER_YEAR * round_seconds / YEAR / 2.0 / books  # per side per book
    total = 0
    for _ in range(books):
        # live[i] = orders with i rounds of life left, as (buys, sells)
        live_b = [0] * (rest_rounds + 1)
        live_s = [0] * (rest_rounds + 1)
        for _ in range(rounds):
            live_b[rest_rounds] += poisson(rng, lam)
            live_s[rest_rounds] += poisson(rng, lam)
            b, s = sum(live_b), sum(live_s)
            m = min(b, s)
            total += m
            # remove the matched from the oldest first, then age the survivors
            live_b = age(live_b, m)
            live_s = age(live_s, m)
    return total / years


def age(live, matched):
    for i in range(len(live)):
        take = min(live[i], matched)
        live[i] -= take
        matched -= take
        if matched == 0:
            break
    return live[1:] + [0]


def poisson(rng, lam):
    if lam <= 0:
        return 0
    if lam < 30:
        el, k, p = math.exp(-lam), 0, 1.0
        while True:
            p *= rng.random()
            if p <= el:
                return k
            k += 1
    return int(rng.gauss(lam, math.sqrt(lam)) + 0.5)


# --------------------------------------------------------------------------
# 7. Fixtures for the Solidity differential test
# --------------------------------------------------------------------------

def fixtures(rng, n=64, noncrossing=8):
    """Flat arrays under a per-vector key, because that is the shape a Solidity
    test can read without a JSON path wildcard: `.v3.prices` is one
    `parseJsonUintArray`, and `.vectors[3].orders[*].price` is a dialect
    argument with the cheatcode.

    `noncrossing` of the vectors deliberately do not cross. A differential test
    that only ever replays crossing books agrees with the reference about the
    interesting half and never checks the answer the venue gives on most of its
    rounds, which at 0.36 crossings a round is the majority answer."""
    out, i = {}, 0
    crossed = 0
    while i < n:
        b = book(rng, n=rng.randint(2, 8), pmax=120, qmax=500)
        c = clear(b)
        want_cross = crossed < n - noncrossing
        if (c is None) == want_cross:
            continue
        if c is None:
            p2, vol, lo, hi, f = 0, 0, 0, 0, [0] * len(b)
        else:
            p2, vol, lo, hi = c
            f = fills(b, p2, vol)
            crossed += 1
        out["v%d" % i] = {
            "sides": [s for s, _, _ in b],
            "prices": [p for _, p, _ in b],
            "qtys": [q for _, _, q in b],
            "crossed": 1 if c is not None else 0,
            "priceTwice": p2,
            "volume": vol,
            "lo": lo,
            "hi": hi,
            "fills": f,
        }
        i += 1
    out["count"] = n
    return out


# --------------------------------------------------------------------------

def main():
    rng = random.Random(SEED)
    print("=" * 74)
    print("matching-clearing.py    seed", SEED)
    print("=" * 74)

    print("\n1. THEOREM A. The maximum executable volume is attained at a")
    print("   submitted price, so an O(n^2) scan over submitted prices is")
    print("   complete rather than heuristic.")
    n, v = theorem_a(20000, rng)
    print(f"   books checked against a half-integer grid : {n}")
    print(f"   books where the grid beat every submitted price : {v}")

    print("\n2. THEOREM B. Both tie-break stages have connected argmax sets, so")
    print("   'the midpoint' names a price that is itself a maximiser and the")
    print("   rule is total.")
    n, gv, gi = theorem_b(20000, rng)
    print(f"   crossing books checked            : {n}")
    print(f"   disconnected volume maximisers    : {gv}")
    print(f"   disconnected imbalance minimisers : {gi}")

    print("\n3. WHAT THE TIE-BREAK COSTS. Signed bias in price units, positive")
    print("   means the buyer pays less than the exact midpoint.")
    t = tiebreak_bias(20000, rng)
    print(f"   crossing books: {t['crossing']}")
    print(f"   {'rule':<26}{'volume lost':>14}{'mean signed bias':>20}")
    for k, label in (("lo", "lowest maximiser"), ("hi", "highest maximiser"),
                     ("mid", "midpoint, floored")):
        mean, lost = t[k]
        print(f"   {label:<26}{lost:>14}{mean:>20.4f}")

    print("\n4. WHERE THE ROUNDING GOES. Absolute error against exact")
    print("   arithmetic, in minor units, over every non-zero fill. Swept over")
    print("   lot size, because the answer is not a constant factor.")
    print(f"   {'max lot':>10}{'fills':>9}"
          f"{'round-first mean':>19}{'max':>9}"
          f"{'divide-once mean':>19}{'max':>7}{'ratio':>9}")
    for qmax in (100, 1000, 10_000, 100_000):
        r = rounding_error(4000, rng, qmax=qmax)
        ratio = r["first"][0] / r["once"][0] if r["once"][0] else float("inf")
        print(f"   {qmax:>10}{r['n']:>9}"
              f"{r['first'][0]:>19.2f}{r['first'][1]:>9.1f}"
              f"{r['once'][0]:>19.3f}{r['once'][1]:>7.1f}{ratio:>8.0f}x")
    print("   The round-first error grows with the lot. The divide-once error is")
    print("   bounded by one half whatever the lot is. That is the invariant, and")
    print("   any single 'improvement factor' is an artefact of the lot size the")
    print("   benchmark happened to draw.")

    print("\n5. DOES RESTING PAY? Crossings a year at 600 orders a year,")
    print("   Poisson, daily rounds. An upper bound: price is assumed never to")
    print("   get in the way.")
    base = None
    print(f"   {'resting rounds':<20}{'crossings/yr':>16}{'vs R=0':>12}")
    for R in (0, 1, 7, 30):
        c = crossings(rng, 24 * 3600, R)
        if base is None:
            base = c
        print(f"   R={R:<18}{c:>16.1f}{c / base:>11.2f}x")

    print("\n   And the window itself, at R=0, which is what an earlier measurement's arithmetic")
    print("   says about anonymity sets as much as about liquidity.")
    print(f"   {'round':<20}{'orders/round':>16}{'crossings/yr':>16}")
    for label, secs in (("15 min", 900), ("1 day", 86400),
                        ("1 week", 7 * 86400), ("30 days", 30 * 86400)):
        c = crossings(rng, secs, 0, years=400 if secs < 86400 else 200)
        print(f"   {label:<20}{ORDERS_PER_YEAR * secs / YEAR:>16.3f}{c:>16.1f}")

    print("\n6. DOES SPLITTING THE BOOK COST ANYTHING? k books, daily round,")
    print("   R=7, same total order flow divided between them.")
    base = None
    print(f"   {'books':<20}{'crossings/yr':>16}{'vs k=1':>12}")
    for k in (1, 2, 4, 6):
        c = crossings(rng, 24 * 3600, 7, books=k)
        if base is None:
            base = c
        print(f"   k={k:<18}{c:>16.1f}{100 * c / base:>11.1f}%")

    print("\n7. THE ALLOCATION INVARIANT. Pro rata at the marginal level plus a")
    print("   stated remainder rule must allocate the cleared volume EXACTLY on")
    print("   both sides, and must never fill an order beyond its own size.")
    books = over = short = 0
    for _ in range(20000):
        b = book(rng)
        c = clear(b)
        if c is None:
            continue
        p2, vol, lo, hi = c
        f = fills(b, p2, vol)
        books += 1
        for i, (s_, pr, q) in enumerate(b):
            if f[i] > q:
                over += 1
        for side in (BUY, SELL):
            if sum(f[i] for i in range(len(b)) if b[i][0] == side) != vol:
                short += 1
    print(f"   crossing books checked          : {books}")
    print(f"   orders filled beyond their size : {over}")
    print(f"   sides not summing to the volume : {short}")

    fx = fixtures(rng)
    os.makedirs(os.path.dirname(FIXTURE), exist_ok=True)
    with open(FIXTURE, "w") as f:
        json.dump(fx, f, indent=1)
    print(f"\n8. Wrote {fx['count']} clearing vectors to")
    print(f"   venue/test/fixtures/clearing.json, replayed by CallAuction.t.sol.")
    print("\ndone.")


if __name__ == "__main__":
    main()
