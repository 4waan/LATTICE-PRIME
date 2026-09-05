#!/usr/bin/env python3
"""
Disclosure matrix collusion check.

The join over the filled disclosure matrix, mechanised. Until this file
existed the check had only ever been run by hand in prose.

What it does, and the reason each step is here:

  1. Builds the disclosure matrix as a knowledge map:
     for every row and every party, the granularity that party attains and when.
     The prose writes cells as disclosures. A join needs knowledge, so credentials
     a party already holds out of band (the issuer knows who it onboarded) are
     recorded as knowledge rather than as a disclosure by the venue.

  2. Joins. For an observer subset S, knowledge of a row is the greatest
     granularity any member attains, at the earliest time any of them attains it.
     Landauer and Redmond: combined knowledge is the join of the partitions.

  3. Compares each join against the row's declared ceiling and reports violations.

  4. Runs the derived-fact check, which is the part cell-by-cell review cannot do.
     A derived fact is a function of several rows. A subset that holds every input
     at sufficient granularity holds the output, even when no single cell is above
     its own ceiling. This is the "k one-bit disclosures over a domain of 2^k"
     argument as arithmetic instead of a warning.

Run: python3 scripts/collusion-check.py [--verbose]
No network, no dependencies, no account.
"""

import itertools
import sys

# --------------------------------------------------------------------------
# The three lattices
# --------------------------------------------------------------------------

# Granularity, increasing. `pred` is a predicate over the value and nothing else.
GRAN = ["none", "pred", "agg", "bucket", "exact"]
G = {g: i for i, g in enumerate(GRAN)}

# Time, increasing = later = less disclosure. `never` is the top.
TIME = ["pre", "imm", "+15m", "EOD", "epoch", "never"]
T = {t: i for i, t in enumerate(TIME)}

# Observers. Subsets of this set, ordered by inclusion, join is union.
#
# section 7.1 lists six: iss, ven, cp, reg, nodes, pub. `relay` is added here and the
# addition is a finding rather than a convenience: J4 in section 7.3 is the subset
# {iss} join {relay}, and the security model's section 6.1 carries the relay as
# adversary A5, so the pitch's headline collusion example names a party the observer
# axis does not contain. An axis that cannot express a subset cannot check it.
PARTIES = ["iss", "ven", "cp", "reg", "nodes", "pub", "relay"]
SPEC_PARTIES = ["iss", "ven", "cp", "reg", "nodes", "pub"]

PARTY_NAME = {
    "iss": "issuer",
    "ven": "venue",
    "cp": "counterparty",
    "reg": "regulator",
    "nodes": "consensus node operators (29)",
    "pub": "the public",
    "relay": "the sponsoring relay",
}


def tmin(*ts):
    """Earliest time. Earlier disclosure is more disclosure."""
    return min(ts, key=lambda t: T[t])


# --------------------------------------------------------------------------
# The matrix. Seventeen rows.
# --------------------------------------------------------------------------
#
# knows:   party -> (granularity, time it is attained)
# ceiling: (max granularity for any party outside `trusted`, the trusted set)
# note:    why the row sits where it does, printed on a violation


class Row:
    def __init__(self, num, name, knows, ceiling_gran, trusted, note=""):
        self.num = num
        self.name = name
        self.knows = knows
        self.ceiling_gran = ceiling_gran
        self.trusted = set(trusted)
        self.note = note

    def attained(self, party):
        """What `party` attains. Anything the public sees, every party also sees:
        a public value is not a party's private holding, and a check that lets a
        named party 'not know' a published fact will under-report every join."""
        own = self.knows.get(party, ("none", "never"))
        pub = self.knows.get("pub", ("none", "never"))
        if G[pub[0]] > G[own[0]]:
            return pub
        return own

    def emergent(self, subset):
        """True when the join strictly exceeds every member's solo knowledge.
        Two parties pooling what one of them already held is not collusion."""
        jg, _ = self.join(subset)
        best = max((G[self.attained(p)[0]] for p in subset), default=0)
        return G[jg] > best

    def join(self, subset):
        """Greatest granularity the subset reaches, at the earliest time."""
        g, t = "none", "never"
        for p in subset:
            pg, pt = self.attained(p)
            if G[pg] > G[g]:
                g, t = pg, pt
            elif G[pg] == G[g] and pg != "none":
                t = tmin(t, pt)
        return g, t


# `nodes` sees the plaintext transaction body pre-consensus (mesh/consensus-visibility.md,
# AB-008), so any value transmitted in the clear carries `nodes` at `pre` whether the
# matrix says so or not. Rule 1 of section 7.4 is the mitigation: values hidden from `pub`
# are submitted as commitments. RULE_1 toggles it so the check can show what the rule buys.
RULE_1 = "--no-rule1" not in sys.argv

# Section 7.5's account pool moves R17 from (exact, pub, imm) to (bucket, pub, epoch).
POOL_FIX = "--no-pool" not in sys.argv

# INV-24. `pk_D = pk_I + pk_V` registered as a bare sum lets whichever share is
# submitted second be chosen adaptively, so one party ends up holding `sk_D` alone.
# With proof of possession, the credential-to-nullifier edge needs both shares.
INV_24 = "--no-inv24" not in sys.argv


def clear_text(base):
    """A value transmitted in the clear is also held by every node operator at `pre`."""
    out = dict(base)
    if not RULE_1:
        out["nodes"] = ("exact", "pre")
    return out


ROWS = [
    Row(1, "Trader identity",
        # The issuer holds identity from the onboarding relationship, not from the venue.
        {"iss": ("exact", "imm")},
        ceiling_gran="none", trusted=["iss"],
        note="P2, D8.1. The venue discloses nothing. The issuer already holds it."),

    Row(2, "KYC credential",
        {"pub": ("pred", "imm"), "ven": ("pred", "imm"), "nodes": ("pred", "pre"),
         "iss": ("exact", "imm")},
        ceiling_gran="pred", trusted=["iss"],
        note="P3. A predicate is public, the credential itself is not."),

    Row(3, "Order size",
        clear_text({"ven": ("exact", "imm"), "pub": ("bucket", "EOD")}),
        ceiling_gran="bucket", trusted=["ven"],
        note="P1, C1, D8.2. Exact to the venue, coarsened to the public at end of day."),

    Row(4, "Order price",
        clear_text({"ven": ("exact", "imm"), "pub": ("exact", "+15m")}),
        ceiling_gran="exact", trusted=["ven"],
        note="P1, C1, D8.2. The +15m clock is ESMA's, not ours."),

    Row(5, "Execution price",
        {"cp": ("exact", "imm"), "ven": ("exact", "imm"), "reg": ("exact", "imm"),
         "pub": ("exact", "+15m"), "nodes": ("exact", "pre")},
        ceiling_gran="exact", trusted=["cp", "ven", "reg"],
        note="C1, C3, D8.3, AB-024. Public at +15m by the sovereign-bond clock."),

    Row(6, "Quantity",
        {"cp": ("exact", "imm"), "ven": ("exact", "imm"), "reg": ("exact", "imm"),
         "pub": ("bucket", "imm"), "nodes": ("exact", "pre")},
        ceiling_gran="bucket", trusted=["cp", "ven", "reg"],
        note="C1, AB-024. Bucketed immediately, exact at EOD. The regulator's second clock."),

    Row(7, "Asset",
        {"pub": ("exact", "imm"), "nodes": ("exact", "pre")},
        ceiling_gran="exact", trusted=[],
        note="C1. Public by design. It is a listed instrument."),

    Row(8, "Compliance validity",
        {"pub": ("pred", "imm"), "nodes": ("pred", "pre")},
        ceiling_gran="pred", trusted=[],
        note="P3, C3. Verified on chain, so strictly better than D9a's {reg,cp} class."),

    Row(9, "Settlement validity",
        {"pub": ("pred", "imm"), "nodes": ("pred", "pre")},
        ceiling_gran="pred", trusted=[],
        note="C3."),

    Row(10, "Governance actions",
        {"pub": ("exact", "epoch"), "nodes": ("exact", "pre")},
        ceiling_gran="exact", trusted=[],
        note="D11e. Rule 2: actions land only at epoch boundaries."),

    Row(11, "Credential history",
        # Within an epoch the nullifier links a holder's registrations. It resets across.
        {"pub": ("exact", "imm"), "nodes": ("exact", "pre"), "relay": ("exact", "imm")},
        ceiling_gran="exact", trusted=[],
        note="D-16. Linkable within an epoch by construction, reset across epochs."),

    Row(12, "Counterparty relationship",
        {"pub": ("exact", "imm"), "nodes": ("exact", "pre"),
         "cp": ("exact", "imm"), "ven": ("exact", "imm"), "reg": ("exact", "imm")},
        ceiling_gran="none", trusted=["cp", "ven", "reg"],
        note="THE CELL WE DID NOT SOLVE. Settlement runs the stock ATS transfer path "
             "(D-05, D-07), which discloses the pair. Should sit at {reg,cp}. "
             "Fix is D-08's order-book-only second layer, on the roadmap."),

    Row(13, "Match predicate",
        {"pub": ("pred", "imm"), "nodes": ("pred", "pre")},
        ceiling_gran="pred", trusted=[],
        note="AB-033. Disjunctive in honest form, recorded as a documented limit."),

    Row(14, "Position risk",
        {"cp": ("pred", "imm"), "ven": ("pred", "imm"), "reg": ("pred", "imm")},
        ceiling_gran="none", trusted=["cp", "ven", "reg"],
        note="MK-020. Never public. Margin events are predicates to the trade parties."),

    Row(15, "Activity fingerprint",
        {"pub": ("agg", "EOD"), "nodes": ("exact", "pre")},
        ceiling_gran="agg", trusted=[],
        note="mu1.2. Aggregate only, end of day."),

    Row(16, "Cadence",
        {"pub": ("exact", "imm"), "nodes": ("exact", "pre")},
        ceiling_gran="bucket", trusted=[],
        note="THE SECOND CELL WE DID NOT SOLVE. AB-058: at 1.6 orders a day a "
             "submission window recovers nothing. The mechanism that works is cover "
             "traffic, priced in section 7.6 and not taken."),

    Row(17, "Account provenance",
        ({"pub": ("bucket", "epoch"), "nodes": ("bucket", "pre"), "relay": ("exact", "imm")}
         if POOL_FIX else
         {"pub": ("exact", "imm"), "nodes": ("exact", "pre"), "relay": ("exact", "imm")}),
        ceiling_gran="bucket", trusted=[],
        note="AB-023, AB-035. Monotonic account ids date a purpose-made account. "
             "Section 7.5's epoch-boundary pool gives an anonymity set of 50."),

    # The edge that decides J4. Holding an identity and holding a nullifier does
    # not link them: `ct = cid + Poseidon(r*pk_D)` with `pk_D = pk_I + pk_V`, so
    # `sk_I` alone yields `r*pk_I` and not `r*pk_V`, and the issuer cannot test a
    # `cid` it issued itself. Under INV-24 the edge is 2-of-2 and belongs to no
    # single party. Without proof of possession one share can be chosen adaptively
    # and its holder gets `sk_D` outright.
    Row(18, "Credential-to-nullifier linkage (cid <-> n)",
        ({} if INV_24 else {"iss": ("exact", "imm")}),
        ceiling_gran="none", trusted=[],
        note="INV-24, D-16. Under proof of possession no single party holds this "
             "edge; it is released only through DisclosureGate's 2-of-2. Without "
             "it, whichever share went second holds sk_D alone."),
]

ROW_BY_NUM = {r.num: r for r in ROWS}


# --------------------------------------------------------------------------
# Derived facts. The part a cell-by-cell review cannot reach.
# --------------------------------------------------------------------------
#
# Each is a function of rows. A subset holding every input at or above the required
# granularity holds the output, whether or not any single cell is above its ceiling.
# The first four come from marketplace/F4-ROW-SCOPE.md's mainnet probe, which found
# them reconstructible against a live treasury. The fifth is J4.


class Derived:
    def __init__(self, key, name, inputs, permitted, note):
        self.key = key
        self.name = name
        self.inputs = inputs          # [(row number, minimum granularity)]
        self.permitted = set(permitted)  # subsets wholly inside this set are fine
        self.note = note

    def held_by(self, subset):
        for num, need in self.inputs:
            g, _ = ROW_BY_NUM[num].join(subset)
            if G[g] < G[need]:
                return False
        return True


DERIVED = [
    Derived("deanon", "Deanonymisation: real identity behind a nullifier",
            [(1, "exact"), (11, "exact"), (18, "exact")], [],
            "J4. The issuer holds identity to credential; the registry publishes "
            "address to nullifier. The missing edge is cid to n, and INV-24's proof "
            "of possession on pk_D = pk_I + pk_V is what keeps it missing."),

    Derived("graph", "Counterparty graph",
            [(1, "exact"), (12, "exact")], ["reg", "cp", "ven"],
            "F4-ROW-SCOPE derived fact 1, reconstructed on mainnet."),

    Derived("fingerprint", "Activity fingerprint",
            [(1, "exact"), (6, "bucket"), (16, "exact")], ["reg", "cp", "ven"],
            "F4-ROW-SCOPE derived fact 2. Identity plus quantity plus time."),

    Derived("flow", "Fund flow per share class",
            [(6, "exact"), (7, "exact")], ["iss", "reg", "ven", "cp"],
            "F4-ROW-SCOPE derived fact 3. Scoped to the issuer, not the trader."),

    Derived("frontrun", "Pre-trade order intent",
            [(3, "exact"), (4, "exact")], ["ven"],
            "J3. Size and price at `pre` is front-running material, before the "
            "venue can apply any policy. Rule 1 of section 7.4 is the mitigation."),
]


# --------------------------------------------------------------------------
# The check
# --------------------------------------------------------------------------

def subsets(parties, max_size=3):
    """Every subset up to max_size. Larger subsets only ever join to more, so the
    small ones are where a violation is a finding rather than an inevitability."""
    for n in range(1, max_size + 1):
        for c in itertools.combinations(parties, n):
            yield frozenset(c)


def fmt(subset):
    return "{" + " u ".join(sorted(subset)) + "}"


def main():
    verbose = "--verbose" in sys.argv
    print("the disclosure matrix COLLUSION CHECK")
    print("=" * 74)
    print(f"rows: {len(ROWS)}   parties: {len(PARTIES)}   "
          f"subsets checked: {sum(1 for _ in subsets(PARTIES))}")
    print(f"Rule 1 (commitments for hidden values): {'ON' if RULE_1 else 'OFF'}")
    print(f"Section 7.5 account pool:               {'ON' if POOL_FIX else 'OFF'}")
    print()

    # -- axis completeness -------------------------------------------------
    missing = [p for p in PARTIES if p not in SPEC_PARTIES]
    if missing:
        print("AXIS FINDING")
        print("-" * 74)
        for p in missing:
            print(f"  `{p}` ({PARTY_NAME[p]}) is used by this check and is NOT in")
            print(f"  the observer axis. J4 is a subset containing it")
            print(f"  and the security model's section 6.1 carries it as adversary A5.")
        print()

    # -- per-row joins -----------------------------------------------------
    #
    # The question is not "can these parties together see it" but "can parties
    # who are NOT entitled to it reach it by combining". A subset containing a
    # trusted party tells you only that the trusted party can leak what it was
    # given, which is true of every design and is not a finding. So the ceiling
    # check runs over subsets disjoint from the row's trusted set.
    row_hits = []
    for row in ROWS:
        for s_ in subsets(PARTIES):
            if s_ & row.trusted:
                continue
            g, t = row.join(s_)
            if G[g] > G[row.ceiling_gran]:
                row_hits.append((row, s_, g, t))

    def minimal_for(hits):
        # A row already violated by {pub} alone is violated by every party, since
        # public knowledge propagates. Reporting seven singletons for one public
        # fact is noise, so collapse to {pub} and say it once.
        pub_rows = {r.num for r, s_, _, _ in hits if s_ == frozenset(["pub"])}
        out = []
        for row, s_, g, t in hits:
            if row.num in pub_rows and s_ != frozenset(["pub"]):
                continue
            if not any(r2.num == row.num and s2 < s_ for r2, s2, _, _ in hits):
                out.append((row, s_, g, t))
        return out

    minimal = minimal_for(row_hits)

    print("PART 1 - PER-ROW JOINS AGAINST CEILING")
    print("-" * 74)
    print("  subsets containing no party entitled to the row")
    print()
    if not minimal:
        print("  no unentitled subset exceeds its ceiling")
    for row, s_, g, t in sorted(minimal, key=lambda x: (x[0].num, len(x[1]))):
        flag = "  <- named unsolved" if row.ceiling_gran == "none" else ""
        if s_ == frozenset(["pub"]):
            flag += "  (public, so every party holds it)"
        print(f"  R{row.num:<2} {row.name:<34} {fmt(s_):<16} "
              f"{g}@{t} > {row.ceiling_gran}{flag}")
        if verbose or row.ceiling_gran == "none":
            print(f"       {row.note}")
    print()

    # -- emergent joins ----------------------------------------------------
    #
    # The join that strictly exceeds what any member held alone. This is the
    # arithmetic of section 2.1: k disclosures that each pass a cell review and
    # jointly determine the value. If this list is empty at row level, every
    # leak is a single party's, and the interesting failures are all in part 3.
    print("PART 2 - EMERGENT ROW JOINS (strictly more than any member alone)")
    print("-" * 74)
    emergent = [(r, s_) for r in ROWS for s_ in subsets(PARTIES)
                if len(s_) > 1 and r.emergent(s_)]
    if not emergent:
        print("  none. No row is reconstructed by pooling that a member did not")
        print("  already hold. Every row-level leak above is one party's alone,")
        print("  which is why part 3 is where the design is actually tested.")
    for r, s_ in emergent[:12]:
        print(f"  R{r.num:<2} {r.name:<34} {fmt(s_)}")
    print()

    # -- derived facts -----------------------------------------------------
    #
    # The part cell-by-cell review cannot reach. A derived fact is a function of
    # several rows; a subset holding every input at sufficient granularity holds
    # the output, whether or not any single cell is above its own ceiling.
    print("PART 3 - DERIVED FACTS (the check a cell-by-cell review cannot do)")
    print("-" * 74)
    derived_hits = []
    for d in DERIVED:
        for s_ in subsets(PARTIES):
            if s_ & d.permitted:
                continue
            if not d.held_by(s_):
                continue
            if any(k == d.key and other_s < s_ for k, other_s in derived_hits):
                continue
            derived_hits.append((d.key, s_))
            perm = fmt(d.permitted) if d.permitted else "nobody unilaterally"
            print(f"  {d.name}")
            print(f"       held by {fmt(s_)}   (permitted: {perm})")
            print(f"       inputs: " + ", ".join(f"R{n}>={g}" for n, g in d.inputs))
            print(f"       {d.note}")
            print()
    if not derived_hits:
        print("  no derived fact is reachable outside its permitted set")
        print()

    # -- verdict -----------------------------------------------------------
    print("=" * 74)
    unsolved = sorted({r.num for r, _, _, _ in minimal if r.ceiling_gran == "none"})
    print(f"rows checked:                                  {len(ROWS)}")
    print(f"row-level ceiling violations (minimal):        {len(minimal)}")
    print(f"emergent row joins:                            {len(emergent)}")
    print(f"derived facts outside their permitted set:     {len(derived_hits)}")
    print(f"rows at ceiling `none` and violated:           "
          f"{', '.join('R' + str(n) for n in unsolved) or 'none'}")
    print()
    print("Read this as the design intends: the failures below are the ones the")
    print("documents already name and price. A check that finds nothing has not")
    print("been run against a real design.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
