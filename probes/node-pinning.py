#!/usr/bin/env python3
"""
a design decision: are we pinned, and what does the network default look like?

`nodeAccountID` is signed into a Hedera transaction body, so a transaction is
valid at exactly one node and the submitter chooses their own first observer.
the marketplace study measured that the flagship institutional asset on mainnet is pinned:
190 of 190 transactions to one node, against a network baseline of 28 nodes
with the busiest at 7 percent.

This asks the same question of our own account. If our transactions are spread,
the default is unpinned, and a design decision is a change we would be making rather than a
property we already have. Saying "we pin" while the SDK picks a node at random
per transaction would be false.

Method. The receiving node is a public field on every mirror node transaction
record, so this needs no authentication and no cooperation from anyone.

Controls:
  C1  a spread result and a pinned result must be distinguishable by this
      script, so it reports the distinct-node count and the top share, not a
      yes/no. One number cannot separate "pinned" from "we only sent one".
  C2  records with no node field are counted separately rather than dropped.
      Child records of a contract call carry no node of their own, and folding
      them into the denominator would understate concentration.

Usage:
    python3 probes/node-pinning.py [account] [network]
"""
import collections
import json
import sys
import urllib.request

account = sys.argv[1] if len(sys.argv) > 1 else "0.0.10298158"
network = sys.argv[2] if len(sys.argv) > 2 else "testnet"
MIRROR = f"https://{network}.mirrornode.hedera.com/api/v1"

url = f"{MIRROR}/transactions?account.id={account}&limit=100&order=desc"
with urllib.request.urlopen(url, timeout=30) as r:
    txs = json.load(r).get("transactions", [])

counts = collections.Counter(t.get("node") for t in txs if t.get("node"))
no_node = sum(1 for t in txs if not t.get("node"))
total = sum(counts.values())

print(f"account            {account}  ({network})")
print(f"records sampled    {len(txs)}")
print(f"C2 no node field   {no_node}   (child records, excluded from the denominator)")
print(f"top-level records  {total}")
print(f"distinct nodes     {len(counts)}\n")

if total:
    print(f"{'node':12} {'count':>6} {'share':>7}")
    for node, n in counts.most_common():
        print(f"{node:12} {n:6} {100 * n / total:6.1f}%")
    top = counts.most_common(1)[0]
    print(f"\ntop node holds {100 * top[1] / total:.1f}% of {total} records across {len(counts)} nodes.")
    print("the marketplace study measured the mainnet institutional comparator at 100% of 190 across 1 node,")
    print("and the mainnet baseline at 28 nodes with the busiest holding 7%.")
    if len(counts) > 1:
        print("\nREAD: this account is NOT pinned. The SDK is choosing a node per transaction.")
    else:
        print("\nREAD: this account is pinned, or it has sent too little to tell.")
