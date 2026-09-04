#!/usr/bin/env python3
"""
O1 / an earlier measurement: does the registration transaction bind the nullifier to a funded address?

The design note assumes it does, and lists "relayer" as a thing we would have to
build. On Hedera that assumption needs checking before it is designed around,
because HIP-410 wraps a signed Ethereum transaction inside a Hedera transaction
that has its OWN payer account and a max_gas_allowance field. So there are two
distinct identities on every EVM call here:

  payer   the Hedera account in transaction_id, who submitted and may be charged
  signer  the ECDSA key recovered from the wrapped RLP, which becomes msg.sender

If those can differ AND the payer can absorb the entire fee, then a registration
address needs no HBAR and no funding history, and the funding-graph link that
an earlier measurement says is fatal does not exist by construction.

This measures the split on mainnet. Read-only, unauthenticated, no key.

Controls, because an earlier measurement/an earlier measurement keeps happening:
  C1  the same classifier on native CONTRACTCALL, where payer IS the caller by
      construction. Any "sponsored" verdict there means the classifier is broken.
  C2  the long-zero address decode is checked against the mirror node's own
      account record, not trusted as arithmetic.
  C3  transfers are reconciled to charged_tx_fee, so "sender not debited" cannot
      be an artifact of a transfer list we parsed incompletely.
Every count is reported with the denominator that produced it.
"""
import json, sys, urllib.request, urllib.error
from collections import Counter

BASE = "https://mainnet-public.mirrornode.hedera.com"


def get(path):
    req = urllib.request.Request(BASE + path, headers={"accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def payer_of(txid):
    # transaction_id is "shard.realm.num-seconds-nanos"
    return txid.rsplit("-", 2)[0]


def longzero_to_id(evm):
    """A long-zero EVM address is 12 zero bytes then the entity num. Anything
    else is an alias or a real ECDSA-derived address and has no id embedded."""
    h = evm.lower().replace("0x", "")
    if len(h) != 40 or h[:24] != "0" * 24:
        return None
    return "0.0.%d" % int(h[24:], 16)


def debit_of(tx, acct):
    """What this account paid in this transaction. Positive means it was debited."""
    for t in tx.get("transfers", []):
        if t["account"] == acct:
            return -t["amount"]
    return 0


def collect(txtype, want):
    """Join transactions of one type against their contract results by timestamp."""
    rows, path = [], "/api/v1/transactions?transactiontype=%s&limit=100&order=desc" % txtype
    while path and len(rows) < want:
        page = get(path)
        for tx in page.get("transactions", []):
            if tx.get("result") != "SUCCESS":
                continue
            rows.append(tx)
            if len(rows) >= want:
                break
        path = (page.get("links") or {}).get("next")
    out = []
    for tx in rows:
        ts = tx["consensus_timestamp"]
        try:
            res = get("/api/v1/contracts/results?timestamp=%s&limit=1" % ts)
        except urllib.error.HTTPError:
            continue
        hits = res.get("results", [])
        if hits:
            out.append((tx, hits[0]))
    return out


def classify(pairs):
    """Returns per-row dicts. 'sponsored' means the signer was debited nothing."""
    rows = []
    for tx, res in pairs:
        payer = payer_of(tx["transaction_id"])
        signer_evm = (res.get("from") or "").lower()
        signer_id = longzero_to_id(signer_evm)
        fee = tx.get("charged_tx_fee", 0)
        payer_paid = debit_of(tx, payer)
        signer_paid = debit_of(tx, signer_id) if signer_id else None
        rows.append(dict(
            payer=payer, signer_evm=signer_evm, signer_id=signer_id, fee=fee,
            payer_paid=payer_paid, signer_paid=signer_paid,
            split=(signer_id != payer) if signer_id else None,
            sponsored=(signer_id is not None and signer_id != payer
                       and signer_paid == 0 and payer_paid > 0),
            # Conservation, not fee equality. An EVM call may also move HBAR value,
            # so the negative side is not the fee. But every transfer list must sum
            # to zero, and if ours does not we did not read the whole list.
            net=sum(t["amount"] for t in tx.get("transfers", [])),
            reward=sum(t["amount"] for t in tx.get("staking_reward_transfers", [])),
        ))
    return rows


def main():
    print("=" * 74)
    print("O1 probe: is the EVM signer the account that pays, on Hedera mainnet?")
    print("=" * 74)

    N = 60
    print("\n[1] sampling %d successful ETHEREUMTRANSACTION calls" % N)
    eth = classify(collect("ETHEREUMTRANSACTION", N))
    print("    joined to a contract result: %d" % len(eth))

    decoded = [r for r in eth if r["signer_id"]]
    print("\n[2] payer vs signer")
    print("    signer address decodes to a Hedera id : %d/%d" % (len(decoded), len(eth)))
    split = [r for r in decoded if r["split"]]
    print("    payer differs from signer             : %d/%d" % (len(split), len(decoded)))
    spon = [r for r in decoded if r["sponsored"]]
    print("    signer debited ZERO, payer paid all   : %d/%d" % (len(spon), len(decoded)))

    print("\n[2b] who actually bore the fee, on the %d rows where payer != signer" % len(split))
    only_signer = [r for r in split if r["signer_paid"] > 0 and r["payer_paid"] <= 0]
    only_payer  = [r for r in split if r["payer_paid"] > 0 and r["signer_paid"] == 0]
    both        = [r for r in split if r["payer_paid"] > 0 and r["signer_paid"] > 0]
    print("    signer bore it alone, payer bore nothing : %d" % len(only_signer))
    print("    payer bore it alone, signer bore nothing : %d" % len(only_payer))
    print("    split between the two                    : %d" % len(both))

    print("\n[3] C3, does each transfer list conserve (sum to zero)")
    bad = [r for r in eth if r["net"] - r["reward"] != 0]
    print("    rows not summing to zero              : %d/%d" % (len(bad), len(eth)))
    print("    %s" % ("PASS, the transfer lists are read whole, so [2] and [2b] hold"
                      if not bad else
                      "FAIL, transfer parsing is incomplete and [2] is not trustworthy"))

    print("\n[4] who are the payers (the anonymity set a registrant would hide in)")
    for acct, n in Counter(r["payer"] for r in eth).most_common(6):
        print("    %-14s %3d calls  %s" % (acct, n, "#" * min(n, 40)))

    print("\n[5] C1 control: native CONTRACTCALL, where payer IS the caller")
    cc = classify(collect("CONTRACTCALL", 20))
    ccd = [r for r in cc if r["signer_id"]]
    ccs = [r for r in ccd if r["sponsored"]]
    print("    sampled %d, decoded %d, classifier says sponsored: %d" % (len(cc), len(ccd), len(ccs)))
    print("    EXPECT 0. %s" % ("PASS, classifier is not just saying yes" if not ccs
                                else "FAIL, classifier is broken and [2] means nothing"))

    if spon:
        print("\n[6] C2 + funding history of three sponsored signers")
        for r in spon[:3]:
            a = get("/api/v1/accounts/%s?limit=1" % r["signer_id"])
            ev = (a.get("evm_address") or "").lower()
            ok = ev == r["signer_evm"]
            print("    %s  balance %d tinybar  created %s" % (
                r["signer_id"], (a.get("balance") or {}).get("balance", -1),
                a.get("created_timestamp")))
            print("      C2 decode check: mirror node evm_address %s   %s"
                  % (ev or "(none)", "matches" if ok else "MISMATCH, decode is wrong"))
    else:
        print("\n[6] no fully sponsored call in this sample. That is a result, not an error.")
        print("    Report the split rate and say the allowance path was not observed live.")


if __name__ == "__main__":
    main()
