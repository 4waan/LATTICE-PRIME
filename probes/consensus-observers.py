#!/usr/bin/env python3
"""
What does a Hedera consensus node see, and when?

The structural half of that question is answered by documentation and is recorded
in mesh/consensus-visibility.md. This script measures the half that documentation
cannot answer: WHO the pre-consensus observers actually are on mainnet today, and
how long they hold plaintext before the public does.

Four measurements, all unauthenticated. No key, no account, no relationship with
any issuer.

  1. the live address book: every node that receives gossiped events
  2. the stake distribution across that observer set
  3. how many of those observers are financial institutions
  4. the pre-consensus window, as an upper bound

Run:  python3 probes/consensus-observers.py
"""

import json
import urllib.request
import collections
import statistics
import datetime

BASE = "https://mainnet-public.mirrornode.hedera.com"

# Operators that are financial institutions, i.e. plausible counterparties or
# competitors in the market this project is building a venue for. Matched on the
# description string the address book publishes.
FINANCIAL = ["Nomura", "Shinhan Bank", "LSE", "Aberdeen Investments",
             "BitGo", "Australian Payments Plus"]


def get(path):
    req = urllib.request.Request(BASE + path, headers={"User-Agent": "hedera2026-probe"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def paged(path, key):
    out, nxt = [], path
    while nxt:
        d = get(nxt)
        out.extend(d[key])
        nxt = (d.get("links") or {}).get("next")
    return out


def rule(t):
    print("\n" + "=" * 72 + "\n" + t + "\n" + "=" * 72)


print("Hedera consensus-layer observer set, captured %s UTC"
      % datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M"))
print("source: %s  (unauthenticated)" % BASE)
print("probe for consensus visibility")

# ---------------------------------------------------------------- 1 + 2
nodes = paged("/api/v1/network/nodes?limit=100", "nodes")
total = sum(int(n.get("stake") or 0) for n in nodes)

rule("1. The address book: every entity that sees a transaction pre-consensus")
print("\nEvery consensus node receives gossiped events, and a hashgraph event")
print("carries an array of transactions, not hashes. So this list IS the")
print("pre-consensus observer set. It is not a subset of it.\n")
print("  %-4s %-9s %-38s %12s %7s" % ("id", "account", "operator and location", "stake", "share"))
print("  " + "-" * 72)
for n in sorted(nodes, key=lambda x: int(x.get("stake") or 0), reverse=True):
    s = int(n.get("stake") or 0)
    d = (n.get("description") or "").replace("Hosted by ", "")
    print("  %-4s %-9s %-38s %12d %6.2f%%"
          % (n["node_id"], n["node_account_id"], d[:38], s // 10**8,
             100 * s / total if total else 0))
print("\n  observers          %d" % len(nodes))
print("  total stake        %d hbar" % (total // 10**8))
print("  largest single     %.2f%%" % (100 * max(int(n.get("stake") or 0) for n in nodes) / total))
print("  nodes at zero stake %d" % sum(1 for n in nodes if int(n.get("stake") or 0) == 0))

# ---------------------------------------------------------------- 3
rule("3. How many observers are financial institutions")
fin = [n for n in nodes
       if any(f in (n.get("description") or "") for f in FINANCIAL)]
fstake = sum(int(n.get("stake") or 0) for n in fin)
for n in sorted(fin, key=lambda x: int(x.get("stake") or 0), reverse=True):
    print("  %-9s %s" % (n["node_account_id"], (n.get("description") or "").replace("Hosted by ", "")))
print("\n  %d of %d observers (%.0f%%), holding %.2f%% of stake"
      % (len(fin), len(nodes), 100 * len(fin) / len(nodes), 100 * fstake / total))
print("\n  Note the entity at node 0.0.29. Aberdeen Investments operates a")
print("  consensus node AND is the asset manager behind the tokenised money")
print("  market funds found issued on this same mainnet, and a")
print("  counterparty in the July 2025 tokenised-collateral trade that")
print("  marketplace/hedera-record.md treats as our exact use case.")
print("  It is on both sides of the glass.")

geo = collections.Counter()
for n in nodes:
    d = (n.get("description") or "")
    geo[d.split("|")[-1].strip().split(",")[-1].strip() if "|" in d else "?"] += 1
print("\n  jurisdictions represented: %d" % len(geo))
print("  " + ", ".join("%s x%d" % (k, v) for k, v in geo.most_common()))

# ---------------------------------------------------------------- 4
rule("4. The pre-consensus window, upper bound")
txs = get("/api/v1/transactions?limit=100&order=desc&result=SUCCESS")["transactions"]
gaps, bytype = [], collections.defaultdict(list)
for t in txs:
    try:
        g = float(t["consensus_timestamp"]) - float(t["valid_start_timestamp"])
    except (KeyError, TypeError, ValueError):
        continue
    if 0 < g < 180:
        gaps.append(g)
        bytype[t["name"]].append(g)
v = sorted(gaps)
print("\n  valid_start -> consensus_timestamp, n=%d, seconds" % len(v))
for lbl, x in [("min", v[0]), ("p25", v[len(v) // 4]), ("median", statistics.median(v)),
               ("p75", v[3 * len(v) // 4]), ("p90", v[int(len(v) * 0.9)]), ("max", v[-1])]:
    print("    %-7s %.3f" % (lbl, x))
print("\n  by type:")
for n_, gs in sorted(bytype.items(), key=lambda kv: -len(kv[1]))[:6]:
    print("    %-26s n=%-4d median %.3f" % (n_, len(gs), statistics.median(gs)))
print("""
  CAVEAT, and it is why this is an upper bound and not a measurement.
  valid_start is chosen by the CLIENT, and the SDKs deliberately backdate it
  to survive clock skew. So this interval contains an unknown amount of
  client-side offset. The true window is bounded above by these figures and
  below by the observed min. Hedera documents ~2 to 3 seconds for the fame
  elections that decide order, which is consistent with the min here.

  A clean measurement needs a transaction we submit ourselves with a known
  local clock. That is the same transaction mu1.2 needs in order to inspect
  calldata shape, so the two probes should be run together.""")

rule("What this settles")
print("""
  A Hedera transaction names its recipient node in the signed body, so it is
  valid at exactly one node. The submitter therefore CHOOSES its first
  observer. That is a real and unusual property.

  It does not survive gossip. The receiving node validates, packs the
  transaction into an event, and gossips the event onward. Events carry
  transactions, so within the consensus window all %d entities above hold the
  plaintext, and they hold it before any of it is public.

  The absence of a public mempool is therefore true and materially good: there
  is no open queue for an anonymous searcher to watch. It is not the same
  claim as pre-trade privacy. It relocates the observer set from "anyone"
  to "these %d", and %d of them are financial institutions.""" % (len(nodes), len(nodes), len(fin)))
