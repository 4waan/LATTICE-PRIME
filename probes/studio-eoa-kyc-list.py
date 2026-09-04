#!/usr/bin/env python3
"""
an earlier measurement's remaining probe: does the Studio accept a real, existing, codeless
Hedera account as an external KYC list, and does it reach the network?

Why this one and not the one already run. an earlier measurement entered 0.0.999999999, an
account that does not exist, and measured zero network traffic for the window.
That proves the absence of validation. It does not map onto a live token,
because a nonexistent id is not a shape anything downstream can be wired to.
An EOA is: it exists, it answers a staticcall, and an earlier measurement measured that the
typed KYC seam then bricks the security for everyone. This probe closes the
path from a typo in a browser form to a security that cannot settle.

What this script does, and what it does not. It cannot drive the browser; the
form is entered by hand and that half is a runbook, not a program. What it does
is the part that has to be right for the browser half to mean anything:

  1. verify the chosen target really is an EOA on testnet: the account exists,
     it is not a contract entity, and EXTCODESIZE over it is 0
  2. take a transaction baseline for the operator account before the browser
     window opens
  3. after the window, ask twice, two different ways, whether anything was sent

Step 3 is two independent queries on purpose. A single "no transactions" answer
is indistinguishable from a query that was wrong, and an earlier measurement measured that an
empty mirror node page arrives as HTTP 200 with a cursor rather than as an
error. Two queries against the same baseline, disagreeing, is a broken probe.
Agreeing, it is a measurement.

Usage:
    python3 probes/studio-eoa-kyc-list.py targets            # step 1
    python3 probes/studio-eoa-kyc-list.py baseline 0.0.10298158
    ... submit the Studio add-external-KYC form by hand ...
    python3 probes/studio-eoa-kyc-list.py verify

Controls, because a probe that reports "nothing happened" for everything
proves nothing:

  C1  a contract we deployed and watched work (spike 3's KYC list).
      MUST report nonzero code. If it reports zero, the codesize half is broken.
  C2  0.0.999999999, an earlier measurement's nonexistent account. MUST NOT resolve.
  C3  the baseline query is re-run against a timestamp far in the past, which
      MUST return transactions. If that comes back empty the window query in
      step 3 is not evidence of anything.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

MIRROR = "https://testnet.mirrornode.hedera.com/api/v1"
BASELINE_FILE = os.path.join(os.path.dirname(__file__), "studio-eoa-kyc-list.baseline.json")

# The EOA offered to the form. 0.0.2 is the testnet treasury: it certainly
# exists, it is codeless, and it is stable, so anyone can reproduce this
# without us handing out an account. Any real codeless account works.
EOA_TARGET = "0.0.2"
C1_CONTRACT = "0.0.10306623"         # spike 3 KYC list, 0x1b9b5e61...0c83
C2_NONEXISTENT = "0.0.999999999"     # an earlier measurement's original entry


def get(path):
    try:
        with urllib.request.urlopen(f"{MIRROR}/{path}", timeout=30) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, None


def extcodesize(evm_address):
    """Run EXTCODESIZE inside a consensus node. Nothing is deployed, nothing is paid."""
    addr = evm_address.lower().replace("0x", "").rjust(40, "0")
    initcode = "0x73" + addr + "3b60005260206000f3"
    body = json.dumps({"data": initcode, "estimate": False}).encode()
    req = urllib.request.Request(
        f"{MIRROR}/contracts/call", data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return int(json.load(r)["result"], 16)
    except urllib.error.HTTPError:
        return None


def targets():
    print("step 1: is the target actually an EOA, and are the controls sane?\n")
    rows = []
    for account, label, expect in [
        (EOA_TARGET, "EOA offered to the form", "exists, 0 code"),
        (C1_CONTRACT, "C1 spike 3 KYC list", "exists, nonzero code"),
        (C2_NONEXISTENT, "C2 an earlier measurement's nonexistent id", "does not resolve"),
    ]:
        status, data = get(f"accounts/{account}")
        if status != 200:
            rows.append((account, label, f"HTTP {status}", "n/a", "n/a", expect))
            continue
        evm = data.get("evm_address")
        is_contract = get(f"contracts/{account}")[0] == 200
        size = extcodesize(evm) if evm else None
        rows.append((account, label, "exists", "contract" if is_contract else "account", size, expect))

    width = max(len(r[1]) for r in rows)
    print(f"{'account':16} {'what':{width}} {'mirror':10} {'entity':9} {'codesize':>8}  expected")
    for account, label, resolved, entity, size, expect in rows:
        print(f"{account:16} {label:{width}} {resolved:10} {entity:9} {str(size):>8}  {expect}")

    print("\nThe probe is only meaningful if the first row exists with codesize 0,")
    print("C1 is nonzero and C2 does not resolve.")


def baseline(account):
    status, data = get(f"transactions?account.id={account}&limit=1&order=desc")
    if status != 200:
        sys.exit(f"cannot read transactions for {account}: HTTP {status}")
    txs = data.get("transactions", [])
    latest = txs[0]["consensus_timestamp"] if txs else "0.0"
    record = {
        "account": account,
        "baseline_consensus_timestamp": latest,
        "captured_at": time.time(),
        "latest_transaction_id": txs[0]["transaction_id"] if txs else None,
    }
    with open(BASELINE_FILE, "w") as f:
        json.dump(record, f, indent=2)
    print(json.dumps(record, indent=2))
    print(f"\nbaseline written to {BASELINE_FILE}")
    print("Now run the browser half. Do not sign anything else with this account")
    print("while the window is open, or the measurement is contaminated.")


def verify():
    with open(BASELINE_FILE) as f:
        record = json.load(f)
    account = record["account"]
    since = record["baseline_consensus_timestamp"]

    status_a, data_a = get(f"transactions?account.id={account}&timestamp=gt:{since}&limit=25&order=asc")
    after = data_a.get("transactions", []) if status_a == 200 else None

    status_b, data_b = get(f"accounts/{account}?timestamp=gt:{since}&limit=25")
    account_txs = data_b.get("transactions", []) if status_b == 200 else None

    status_c, data_c = get(f"transactions?account.id={account}&timestamp=gt:0.0&limit=1&order=asc")
    control = data_c.get("transactions", []) if status_c == 200 else None

    print(f"account            {account}")
    print(f"baseline           {since}")
    print(f"query A  transactions?timestamp=gt:   HTTP {status_a}  {len(after) if after is not None else 'n/a'} transactions")
    print(f"query B  accounts/{{id}}?timestamp=gt:  HTTP {status_b}  {len(account_txs) if account_txs is not None else 'n/a'} transactions")
    print(f"C3       same query, gt:0.0           HTTP {status_c}  {len(control) if control is not None else 'n/a'} transactions")

    if not control:
        print("\nBROKEN PROBE: C3 returned nothing, so an empty window is not evidence.")
        return
    if after is None or account_txs is None:
        print("\nBROKEN PROBE: a query failed. an earlier measurement: an empty page is HTTP 200, so a")
        print("non-200 here is a real failure and not an empty result.")
        return
    if len(after) != len(account_txs):
        print("\nBROKEN PROBE: the two queries disagree. Do not report either number.")
        return

    if len(after) == 0:
        print("\nRESULT: zero transactions for the whole window, confirmed two ways.")
        print("The form accepted the entry and never contacted the network.")
    else:
        print(f"\nRESULT: {len(after)} transactions in the window. The form DID reach the")
        print("network, which contradicts an earlier measurement. Read them before concluding anything:")
        for t in after:
            print(f"  {t['consensus_timestamp']}  {t['name']:28} {t['result']}")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "targets"
    if mode == "targets":
        targets()
    elif mode == "baseline":
        baseline(sys.argv[2] if len(sys.argv) > 2 else "0.0.10298158")
    elif mode == "verify":
        verify()
    else:
        sys.exit(__doc__)
