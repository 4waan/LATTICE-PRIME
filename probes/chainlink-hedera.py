#!/usr/bin/env python3
"""
Can a *contract* on Hedera read Chainlink's price feeds?

`venue/src/oracle/PrimeOracle.sol` composes the venue's own clean price with an
upstream HBAR/USD rate, and the whole argument for that split is that the second
half is not ours to build. Chainlink runs HBAR/USD on Hedera, so the design
called for reading it. This probe is what happened when the design met the chain.

**The answer is no, and it is no on both networks.** Chainlink's proxies here
are access controlled: the controller admits a caller that is allowlisted or for
which `msg.sender == tx.origin`, so an externally owned account sees a price and
a contract sees `No access`. `decimals()` is not gated. That combination is the
trap, because a constructor that validates a feed by its scale will seat one it
can never price against, and the failure surfaces at the first margin call
rather than at deployment. It is exactly what happened here, on chain, with a tx
hash.

So this probe answers four questions, and the third is the one that decided the
design:

  1. Is there code at the address at all?  `eth_getCode`.
  2. Does it answer `description()`, `decimals()` and `version()` with what
     Chainlink's registry says?  This is the half that works.
  3. **Does it answer a contract?**  Read through `FeedAccessProbe`, a contract
     deployed on 296 whose only job is to `staticcall` a feed and hand back the
     outcome instead of reverting. `eth_call` alone cannot show this: it sets
     `tx.origin` to whatever `from` says, so the caller and the origin are equal
     again and the access check passes. It needs a contract in the middle.
  4. How old is the answer, and what does Hedera's own rate say instead?
     `0x168` is the network's exchange rate system contract, it is what every
     transaction fee on the network is priced at, and unlike the feeds above it
     is readable by contracts because being read by contracts is what it is for.
     `venue/src/oracle/HederaRateFeed.sol` is the adapter that seats it in
     `AggregatorV3Interface`'s shape, and the gap between the two rates is
     printed rather than waved at.

No dependencies: `urllib` against the public relay, and the ABI encoding here is
a handful of selectors and fixed-width returns, which is less code than a
dependency.

Run:  python3 probes/chainlink-hedera.py
"""

import json
import os
import time
import urllib.request

RPC = os.environ.get("HEDERA_TESTNET_RPC", "https://testnet.hashio.io/api")

# Read out of Chainlink's own feed registry for hedera-testnet on 2026-09-07.
# The registry is the source for the addresses; this script is the source for
# whether they answer.
FEEDS = [
    ("HBAR / USD", "0xd4DC5F0a891381D09d6437482a0E4E2dca4ACCAa"),
    ("USDC / USD", "0x22B41b74e340b5A3e8fE70b82531509E05AbFA62"),
    ("USDT / USD", "0xAFb9e69BA1053a34b307664066eDCF9Ccf1F79Ef"),
    ("DAI / USD", "0xE7c825635998dBc2Ba915C54AD0EB64864387e82"),
    ("BTC / USD", "0x8A1EC8E9FA1636b2AA38dE3109539587fe755f62"),
    ("ETH / USD", "0x4D18EB4043241E8fC981112b23459F35E5b79147"),
    ("LINK / USD", "0x6EAcAE8c5C7531a425818Ad678fb59873DF338f2"),
]

# The heartbeat the registry publishes for every one of them.
REGISTRY_HEARTBEAT = 86_400

# Chainlink's HBAR/USD on Hedera **mainnet**, from the same registry. Read here
# only to establish that the access control is not a testnet convenience.
MAINNET_HBAR_USD = "0x1B9a65b54e36A4f4E3591e4deAAb423C64959Ae0"
MAINNET_RPC = os.environ.get("HEDERA_MAINNET_RPC", "https://mainnet.hashio.io/api")

# `FeedAccessProbe`, deployed to 296 by `venue/script/ProbeFeedAccess.s.sol`.
# Its only job is to staticcall a feed from inside a contract and hand back the
# outcome instead of reverting.
ACCESS_PROBE = "0x1ddd6B597b6FF96f4bcA0CD57650cA53d1A42815"

# Hedera's exchange rate system contract, HIP-475.
EXCHANGE_RATE = "0x0000000000000000000000000000000000000168"

# keccak selectors, hard coded rather than computed, so this file needs no
# hashing dependency. Each one is checked by the answer it produces.
SEL = {
    "decimals": "0x313ce567",
    "description": "0x7284e416",
    "version": "0x54fd4d50",
    "latestRoundData": "0xfeaf968c",
    # FeedAccessProbe.probeFeed(address)
    "probeFeed": "0x1d68fcf0",
    # IExchangeRate.tinybarsToTinycents(uint256)
    "tinybarsToTinycents": "0x43a88229",
}

_id = 0


def rpc(method, params, url=None):
    global _id
    _id += 1
    body = json.dumps({"jsonrpc": "2.0", "id": _id, "method": method,
                       "params": params}).encode()
    # HashIO answers 403 to urllib's default user agent, which is a fact about
    # the relay and not about the request. `probes/bls12381-pectra.py` hit the
    # same wall against a different host and named itself the same way.
    req = urllib.request.Request(url or RPC, data=body, headers={
        "Content-Type": "application/json",
        "User-Agent": "hedera2026-probe",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        out = json.loads(r.read())
    if "error" in out:
        raise RuntimeError(out["error"])
    return out["result"]


def call(to, data, url=None):
    return rpc("eth_call", [{"to": to, "data": data}, "latest"], url)


def probe_feed(feed, url=None, probe=None):
    """Read `feed` from inside a contract. Returns (decimalsOk, priceOk, revert).

    The probe returns `(bool, bytes, bool, bytes)`, so the layout is four head
    words followed by two length-prefixed tails.
    """
    arg = feed.lower().replace("0x", "").rjust(64, "0")
    out = call(probe or ACCESS_PROBE, SEL["probeFeed"] + arg, url)
    decimals_ok = word(out, 0) == 1
    price_ok = word(out, 2) == 1
    # The price tail, whose offset is the fourth head word.
    off = word(out, 3) // 32
    n = word(out, off)
    raw = out[2 + (off + 1) * 64:][: n * 2]
    reason = ""
    if n and raw[:8] == "08c379a0":
        # Error(string): a 32 byte offset, a 32 byte length, then the bytes.
        strlen = int(raw[8 + 64: 8 + 128], 16)
        reason = bytes.fromhex(raw[8 + 128: 8 + 128 + strlen * 2]).decode()
    return decimals_ok, price_ok, reason, raw


def word(data, i):
    return int(data[2 + i * 64: 2 + (i + 1) * 64], 16)


def signed_word(data, i):
    v = word(data, i)
    return v - (1 << 256) if v >> 255 else v


def decode_string(data):
    off = word(data, 0) // 32
    n = word(data, off)
    raw = data[2 + (off + 1) * 64:]
    return bytes.fromhex(raw[: n * 2]).decode()


def main():
    print("Chainlink data feeds on Hedera testnet, chain 296")
    print("=" * 74)
    print(f"relay: {RPC}")
    now = int(time.time())
    print(f"read at: {now}  ({time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now))})")
    print()

    worst_age = 0
    all_eight = True
    for name, addr in FEEDS:
        code = rpc("eth_getCode", [addr, "latest"])
        has_code = len(code) > 2
        desc = decode_string(call(addr, SEL["description"]))
        dec = word(call(addr, SEL["decimals"]), 0)
        ver = word(call(addr, SEL["version"]), 0)
        lrd = call(addr, SEL["latestRoundData"])
        round_id = word(lrd, 0)
        answer = signed_word(lrd, 1)
        updated_at = word(lrd, 3)
        answered_in = word(lrd, 4)
        age = now - updated_at
        worst_age = max(worst_age, age)
        all_eight = all_eight and dec == 8

        print(f"{name:<12} {addr}")
        print(f"  code                 {'yes' if has_code else 'NO'}"
              f"   ({(len(code) - 2) // 2} bytes)")
        print(f"  description()        {desc!r}")
        print(f"  decimals()           {dec}")
        print(f"  version()            {ver}")
        print(f"  latestRoundData()    roundId {round_id}  answeredInRound {answered_in}")
        print(f"                       answer {answer}  =  {answer / 10 ** dec:.8f} USD")
        print(f"                       updatedAt {updated_at}, {age}s ago")
        print(f"  PrimeOracle._cash    answer > 0 {answer > 0}, updatedAt != 0"
              f" {updated_at != 0}, answeredInRound >= roundId"
              f" {answered_in >= round_id}")
        print()

    # ---------------------------------------------------------- the finding
    print("=" * 74)
    print("3. the same feeds, read from inside a contract")
    print(f"   through FeedAccessProbe at {ACCESS_PROBE}")
    print()
    gated = 0
    for name, addr in FEEDS:
        dec_ok, price_ok, reason, raw = probe_feed(addr)
        if not price_ok:
            gated += 1
        print(f"   {name:<12} decimals() {'ok ' if dec_ok else 'REVERT'}"
              f"   latestRoundData() "
              f"{'ok' if price_ok else 'REVERT ' + (repr(reason) if reason else raw[:16])}")
    print()
    print(f"   {gated} of {len(FEEDS)} refuse a contract while answering its scale.")
    print()
    print("   This is the finding. An externally owned account reads a price and")
    print("   a contract does not, because the proxy's access controller admits a")
    print("   caller only when it is allowlisted or when msg.sender == tx.origin.")
    print("   eth_call cannot show it: eth_call sets tx.origin to whatever `from`")
    print("   says, so the two are equal again and the check passes. Every read in")
    print("   section 1 above is an eth_call and every one of them succeeded.")
    print()
    print("   decimals() is not gated, and that is the trap. PrimeOracle validates")
    print("   a feed by its scale before seating it, because the scale is the one")
    print("   thing that has to match. So the seat took, the deployment succeeded,")
    print("   and the first markToMarket reverted CashFeedStale. The venue behaved")
    print("   correctly throughout: a leg it cannot read is dark, and dark opens")
    print("   RepoVault.postMark. But the feed was never going to work.")
    print()

    # --- and it is not a testnet convenience
    print("   Hedera **mainnet**, same question, same probe bytecode:")
    print(f"     {MAINNET_HBAR_USD}")
    print("       extcodesize        22337")
    print("       decimals()         ok, 8")
    print("       latestRoundData()  REVERT 'No access'")
    print()
    print("     Recorded rather than read live, because the probe contract is")
    print("     deployed on 296 only and putting one on mainnet would spend real")
    print("     HBAR to learn something a fork already answers. `forge script`")
    print("     runs against a fork of whatever RPC it is given, and a fork")
    print("     carries the target chain's contract bytecode, so Chainlink's")
    print("     access controller executes there exactly as it does on the")
    print("     network. Reproduce it in one command, free:")
    print()
    print("       FEED=" + MAINNET_HBAR_USD + " \\")
    print("         forge script script/ProbeFeedAccess.s.sol:ForkProbe \\")
    print("           --rpc-url https://mainnet.hashio.io/api")
    print()
    print("     A fork is the wrong instrument for `0x168` and for `0x16b`,")
    print("     which are the node's and are not bytecode. Those are read with")
    print("     `cast` against the real relay, which is what section 4 does.")
    print()

    # ------------------------------------------------- what is seated instead
    print("=" * 74)
    print("4. what the venue seats instead: Hedera's own exchange rate, 0x168")
    tc = word(call(EXCHANGE_RATE, SEL["tinybarsToTinycents"] +
                   (10 ** 14).to_bytes(32, "big").hex()), 0)
    hedera_usd8 = (tc * 10 ** 6) // 10 ** 14
    print(f"   tinybarsToTinycents(1e14)  {tc}")
    print(f"   USD per HBAR, eight dp     {hedera_usd8}"
          f"   = {hedera_usd8 / 1e8:.8f} USD")
    cl = None
    for name, addr in FEEDS:
        if name.startswith("HBAR"):
            cl = signed_word(call(addr, SEL["latestRoundData"]), 1)
    if cl:
        drift = abs(cl - hedera_usd8) / cl * 100
        print(f"   Chainlink says             {cl}   = {cl / 1e8:.8f} USD")
        print(f"   they differ by             {drift:.2f} percent")
    print()
    print("   Both are HBAR/USD and neither is wrong. Chainlink's is aggregated")
    print("   from exchanges; Hedera's is set by the council and is what every")
    print("   transaction fee on the network is priced at. The venue seats the")
    print("   second because it is the one a contract can read, through")
    print("   venue/src/oracle/HederaRateFeed.sol, which wears the Chainlink")
    print("   interface so the seat stays swappable. What replaces staleness as")
    print("   the risk on that seat is divergence from the market, which is the")
    print("   number printed directly above and which docs/RULEBOOK.md section")
    print("   4.2 states in words rather than pretending a heartbeat covers it.")
    print()

    print("-" * 74)
    print(f"every feed answers eight decimals:   {all_eight}")
    print("   PrimeOracle._requireEightDecimals refuses anything else rather")
    print("   than normalising, and this is why that refusal is safe: there is")
    print("   no feed here it would turn away.")
    print()
    print(f"oldest answer across the seven:      {worst_age}s")
    print(f"registry heartbeat:                  {REGISTRY_HEARTBEAT}s")
    print(f"DeployOracle.CASH_HEARTBEAT:         {26 * 3600}s")
    print("   Kept at the publisher's heartbeat plus slack even though the seat")
    print("   now holds an adapter that cannot go stale. It costs nothing, and")
    print("   it is the bound that binds again the moment a real Chainlink")
    print("   aggregator is seated on a chain that permits contract reads.")
    print()
    print("The other six feeds are read to establish that both claims above are")
    print("about Chainlink on this chain, and not about one address that happened")
    print("to behave that way.")


if __name__ == "__main__":
    main()
