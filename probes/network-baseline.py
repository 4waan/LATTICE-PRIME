#!/usr/bin/env python3
"""
Network baseline for the results notes.

Measures the denominators the Success rubric asks about, on Hedera mainnet,
unauthenticated. No key, no account, no relationship with any issuer.

Four measurements:
  1. actual transaction rate and composition
  2. actual account creation rate, from monotonic account ids
  3. the holder set of the flagship institutional fund on Hedera
  4. the lifetime on-ledger activity of each of those holders

Run:  python3 probes/network-baseline.py
"""

import json
import urllib.request
import urllib.error
import collections
import datetime
import sys

BASE = "https://mainnet-public.mirrornode.hedera.com"

# The abrdn Liquidity Fund (Lux) USD share class issued by Archax on Hedera
# mainnet. Identified in marketplace/EVIDENCE.md the marketplace study.
FUND = "0.0.9379434"


def get(url):
    req = urllib.request.Request(url, headers={"accept": "application/json"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.load(r)


def month(x):
    return datetime.datetime.utcfromtimestamp(float(x)).strftime("%Y-%m")


def day(x):
    return datetime.datetime.utcfromtimestamp(float(x)).strftime("%Y-%m-%d")


def minute(x):
    return datetime.datetime.utcfromtimestamp(float(x)).strftime("%Y-%m-%d %H:%M")


def acct_num(a):
    return int(a.split(".")[-1])


def rule(title):
    print()
    print("=" * 72)
    print(title)
    print("=" * 72)


def measure_throughput(pages=25):
    """Walk the transaction feed backwards and divide count by consensus span."""
    rule("1. Transaction rate and composition")
    url = BASE + "/api/v1/transactions?limit=100&order=desc"
    counts = collections.Counter()
    stamps = []
    for _ in range(pages):
        d = get(url)
        txs = d.get("transactions", [])
        if not txs:
            break
        for t in txs:
            counts[t["name"]] += 1
            stamps.append(float(t["consensus_timestamp"]))
        nxt = d.get("links", {}).get("next")
        if not nxt:
            break
        url = BASE + nxt

    n = len(stamps)
    span = max(stamps) - min(stamps)
    print(f"window   {minute(min(stamps))} to {minute(max(stamps))} UTC")
    print(f"sampled  {n} transactions over {span:.0f} s")
    print(f"rate     {n / span:.2f} tx/s   ({n / span * 86400:,.0f} per day)")
    print()
    total = sum(counts.values())
    for name, c in counts.most_common():
        print(f"   {name:<28} {c:>5}   {100.0 * c / total:5.2f}%")

    # The contract-executing subset, which is the denominator our venue joins.
    contract = counts["CONTRACTCALL"] + counts["ETHEREUMTRANSACTION"]
    print()
    print(f"contract-executing subset: {contract} of {total} "
          f"= {contract / span:.3f} tx/s ({contract / span * 86400:,.0f} per day)")
    return n / span, contract / span


def measure_account_creation():
    """
    Hedera account ids are monotonically assigned (EVIDENCE.md the marketplace study), so the
    id delta across a window of newly created accounts is the exact number of
    accounts created in it. This counts alias auto-creations too, which a
    CRYPTOCREATEACCOUNT transaction-type filter would miss.
    """
    rule("2. Account creation rate")
    d = get(BASE + "/api/v1/accounts?order=desc&limit=100")
    accs = [a for a in d["accounts"] if a.get("created_timestamp")]
    if len(accs) < 2:
        print("   insufficient sample")
        return None
    newest, oldest = accs[0], accs[-1]
    span = float(newest["created_timestamp"]) - float(oldest["created_timestamp"])
    delta = acct_num(newest["account"]) - acct_num(oldest["account"])
    print(f"newest    {newest['account']}   {minute(newest['created_timestamp'])} UTC")
    print(f"100 back  {oldest['account']}   {minute(oldest['created_timestamp'])} UTC")
    print(f"id delta  {delta} over {span:.0f} s")
    print()
    print(f"   {delta / span * 86400:,.0f} accounts per day")
    print(f"   {delta / span * 86400 * 30:,.0f} accounts per month")
    return delta / span * 86400


def account_tx_count(acct, created_ts, max_pages=400):
    """
    Count every transaction for an account, over its whole life.

    The mirror node scans this endpoint in fixed 60-day windows. An empty page
    means "nothing in this window", NOT "nothing for this account", and it is
    returned as HTTP 200 with a valid next cursor either way. A loop that stops
    on the first empty page reports zero for an account that is merely quiet
    right now. So walk backwards until the cursor passes the account's own
    creation timestamp, and report whether the walk finished.

    Returns (count, first_ts, last_ts, kinds, complete).
    """
    url = f"{BASE}/api/v1/transactions?account.id={acct}&limit=100&order=desc"
    n = 0
    first = last = None
    kinds = collections.Counter()
    complete = False

    for _ in range(max_pages):
        d = get(url)
        for t in d.get("transactions", []):
            n += 1
            kinds[t["name"]] += 1
            if last is None:
                last = t["consensus_timestamp"]
            first = t["consensus_timestamp"]

        nxt = d.get("links", {}).get("next")
        if not nxt:
            complete = True
            break

        # Stop once the descending cursor has passed account creation.
        cursor = None
        for part in nxt.split("&"):
            if part.startswith("timestamp="):
                cursor = float(part.split(":", 1)[1])
        if cursor is not None and created_ts is not None and cursor < float(created_ts):
            complete = True
            break

        url = BASE + nxt

    return n, first, last, kinds, complete


def measure_fund_activity():
    """
    The register, then what the register actually does. The second half is the
    one that matters: an account that exists and never transacts again is not
    a monthly active account.
    """
    rule("3. The flagship institutional fund, and 4. what its holders do")
    info = get(f"{BASE}/api/v1/tokens/{FUND}")
    treasury = info.get("treasury_account_id")
    print(f"token     {FUND}  {info['name']} ({info['symbol']})")
    print(f"created   {day(info['created_timestamp'])}")
    print(f"supply    {info['total_supply']}")

    bals = get(f"{BASE}/api/v1/tokens/{FUND}/balances")
    holders = [b["account"] for b in bals["balances"] if b["balance"] > 0]
    print(f"accounts  {len(bals['balances'])} associated, "
          f"{len(holders)} with a non-zero balance")
    print()

    investor_total = 0
    investor_count = 0
    truncated = []

    for acct in holders:
        meta = get(f"{BASE}/api/v1/accounts/{acct}")
        created = meta.get("created_timestamp")
        n, first, last, kinds, complete = account_tx_count(acct, created)

        if not complete:
            truncated.append(acct)
        is_treasury = acct == treasury
        if not is_treasury:
            investor_total += n
            investor_count += 1

        tag = "  <- TREASURY (issuer operations)" if is_treasury else ""
        flag = "" if complete else "  [TRUNCATED, count is a floor]"
        window = f"{day(first)} .. {day(last)}" if first else "never transacted"
        born = day(created) if created else "?"
        print(f"{acct:<15} {n:>4} txs   born {born}   active {window}{tag}{flag}")

    print()
    print(f"the {investor_count} investor accounts: {investor_total} transactions "
          f"in total, mean {investor_total / investor_count:.1f} each, lifetime")
    if truncated:
        print(f"WARNING: {len(truncated)} account(s) hit the page cap: {truncated}")
        print("Their counts are floors, not totals. Do not cite them as totals.")
    else:
        print("Every walk reached the account's creation timestamp. Counts are complete.")
    return investor_total, investor_count


def measure_monthly_active():
    """
    Accounts created is the vanity number. The rubric also asks about monthly
    ACTIVE accounts, which is the one an issuance-only product loses.
    Counted per calendar month, not inferred from first and last activity.
    """
    rule("5. Monthly active accounts, for the same fund")
    info = get(f"{BASE}/api/v1/tokens/{FUND}")
    treasury = info.get("treasury_account_id")
    bals = get(f"{BASE}/api/v1/tokens/{FUND}/balances")
    holders = [b["account"] for b in bals["balances"]
               if b["balance"] > 0 and b["account"] != treasury]

    active = collections.defaultdict(set)
    for acct in holders:
        meta = get(f"{BASE}/api/v1/accounts/{acct}")
        created = meta.get("created_timestamp")
        url = f"{BASE}/api/v1/transactions?account.id={acct}&limit=100&order=desc"
        for _ in range(400):
            d = get(url)
            for t in d.get("transactions", []):
                active[month(t["consensus_timestamp"])].add(acct)
            nxt = d.get("links", {}).get("next")
            if not nxt:
                break
            cursor = None
            for part in nxt.split("&"):
                if part.startswith("timestamp="):
                    cursor = float(part.split(":", 1)[1])
            if cursor is not None and created is not None and cursor < float(created):
                break
            url = BASE + nxt

    if not active:
        print("   no activity found")
        return
    lo = min(active)
    hi = datetime.datetime.utcnow().strftime("%Y-%m")
    y, m = map(int, lo.split("-"))
    seq = []
    while True:
        k = f"{y:04d}-{m:02d}"
        seq.append(k)
        if k == hi:
            break
        m += 1
        if m == 13:
            m, y = 1, y + 1

    n_h = len(holders)
    print(f"{n_h} investor accounts (treasury excluded)\n")
    for k in seq:
        n = len(active.get(k, ()))
        note = "   <- onboarding month" if k == lo else ""
        print(f"   {k}   {n}/{n_h} active  {'#' * n}{note}")

    post = [len(active.get(k, ())) for k in seq[1:]]
    print()
    print(f"onboarding month : {len(active[lo])}/{n_h} "
          f"= {100 * len(active[lo]) / n_h:.0f}% active")
    if post:
        mean = sum(post) / len(post)
        print(f"every month after: mean {mean:.2f}/{n_h} "
              f"= {100 * mean / n_h:.1f}% monthly active")


def main():
    print(f"Hedera mainnet baseline, captured {datetime.datetime.utcnow():%Y-%m-%d %H:%M} UTC")
    print(f"source: {BASE}  (unauthenticated)")
    try:
        measure_throughput()
        measure_account_creation()
        measure_fund_activity()
        measure_monthly_active()
    except urllib.error.URLError as e:
        print(f"\nPROBE DID NOT COMPLETE: {e}", file=sys.stderr)
        print("No figures are produced. A transport failure is not a measurement.",
              file=sys.stderr)
        return 1
    print()
    print("Every figure above is a measurement taken at the timestamp in the header.")
    print("They drift. Re-run before citing.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
