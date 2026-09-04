#!/usr/bin/env python3
"""
Spike 1 verification harness. No dependencies, no deployment, no funded account.

Runs the bn254 known-answer tests directly against a chain's precompiles by
eth_call, then bisects the gas field for exact op costs.

    python3 verify.py                 # Hedera testnet + Ethereum mainnet control
    python3 verify.py <rpc-url> ...   # any set of endpoints

Two design rules, both learned the hard way (the audit notes an earlier measurement):

1. A CONTROL IS MANDATORY. Every vector runs against Ethereum mainnet as well.
   A bad vector fails there first, so a Hedera failure means Hedera.

2. A TRANSPORT ERROR IS NOT A RESULT. An early version of this script counted
   HTTP 403 as a passing "precompile correctly rejected bad input" and reported
   4 false passes. Transport failures are now their own outcome and never pass.

The load-bearing test is BILINEARITY: e(-P,Q).e(P,Q) == 1 holds for any P and Q
by algebra alone, so it needs no reference implementation and no copied vector.
A stub returning 0 fails it; a stub returning 1 fails the single-pair test; a
broken final exponentiation fails it. Testing only "empty input returns 1" and
"one pair returns 0", as the original probe did, proves almost nothing.
"""
import json, sys, urllib.request

P = 21888242871839275222246405745257275088696311157297823662689037894645226208583
R = 21888242871839275222246405745257275088548364400416034343698204186575808495617

def w(x): return "%064x" % (x % (1 << 256))

G2X = (0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2,
       0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed)
G2Y = (0x090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b,
       0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa)
TWO_G1 = (0x030644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd3,
          0x15ed738c0e0a7c92e7845f96b2ae9c0a68a6a449e3538fc7ff3ebf7a5a18a2c4)

def pair(p1): return w(p1[0]) + w(p1[1]) + w(G2X[0]) + w(G2X[1]) + w(G2Y[0]) + w(G2Y[1])

G1, NEG_G1 = (1, 2), (1, P - 2)

TESTS = [
 ("ecAdd  G+G = 2G",     6, w(1)+w(2)+w(1)+w(2),      w(TWO_G1[0])+w(TWO_G1[1])),
 ("ecAdd  G+(-G) = O",   6, w(1)+w(2)+w(1)+w(P-2),    w(0)+w(0)),
 ("ecAdd  O+G = G",      6, w(0)+w(0)+w(1)+w(2),      w(1)+w(2)),
 ("ecAdd  off-curve",    6, w(1)+w(3)+w(1)+w(2),      "REJECT"),
 ("ecMul  2*G = 2G",     7, w(1)+w(2)+w(2),           w(TWO_G1[0])+w(TWO_G1[1])),
 ("ecMul  0*G = O",      7, w(1)+w(2)+w(0),           w(0)+w(0)),
 ("ecMul  r*G = O",      7, w(1)+w(2)+w(R),           w(0)+w(0)),
 ("ecMul  off-curve",    7, w(1)+w(3)+w(2),           "REJECT"),
 ("pair   empty",        8, "",                       w(1)),
 ("pair   e(G,H) != 1",  8, pair(G1),                 w(0)),
 ("pair   BILINEAR 2",   8, pair(NEG_G1)+pair(G1),    w(1)),
 ("pair   e(G,H)^2 != 1",8, pair(G1)+pair(G1),        w(0)),
 ("pair   BILINEAR 3",   8, pair(TWO_G1)+pair(NEG_G1)+pair(NEG_G1), w(1)),
 ("pair   G2 off-twist", 8, w(1)+w(2)+w(G2X[0])+w(G2X[1])+w(G2Y[0])+w(G2Y[1]+1), "REJECT"),
 ("pair   bad length",   8, w(1)+w(2),                "REJECT"),
]

def rpc(url, method, params):
    req = urllib.request.Request(url, method="POST",
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "curl/8.4.0"})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=40).read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())        # JSON-RPC errors arrive as HTTP 400 on some relays
        except Exception:
            return {"__transport__": "HTTP %s" % e.code}
    except Exception as e:
        return {"__transport__": str(e)}

def calldata_gas(h):
    return sum(4 if b == 0 else 16 for b in bytes.fromhex(h))

def run(url):
    print("\n" + "=" * 78)
    cid = rpc(url, "eth_chainId", []).get("result")
    print("%s\nchainId = %s (%s)" % (url, cid, int(cid, 16) if cid else "?"))
    print("=" * 78)
    npass = nfail = 0
    for name, addr, data, expect in TESTS:
        r = rpc(url, "eth_call", [{"to": "0x%040x" % addr, "data": "0x" + data}, "latest"])
        if "__transport__" in r:
            print("  [XPRT] %-22s transport failed, NOT a result: %s" % (name, r["__transport__"]))
            nfail += 1
            continue
        got, err = r.get("result"), r.get("error", {}).get("message")
        ok = (err is not None or got == "0x") if expect == "REJECT" else (got == "0x" + expect)
        npass, nfail = npass + ok, nfail + (not ok)
        print("  [%s] %-22s %s" % ("PASS" if ok else "FAIL", name, (err or got or "")[:44]))
        if not ok and expect != "REJECT":
            print("           expected 0x%s" % expect)
    print("  ---- %d passed, %d failed ----" % (npass, nfail))

    def works(addr, data, gas):
        r = rpc(url, "eth_call", [{"to": "0x%040x" % addr, "data": "0x" + data, "gas": hex(gas)}, "latest"])
        return "result" in r and r["result"] not in (None, "0x")

    def min_gas(addr, data, lo=21000, hi=3_000_000):
        if not works(addr, data, hi):
            return None
        while lo < hi:
            mid = (lo + hi) // 2
            if works(addr, data, mid): hi = mid
            else: lo = mid + 1
        return lo

    if works(8, "", 20999):
        print("\n  gas field NOT honored by this relay; skipping gas bisect")
        return
    print("\n  exact op gas (min_gas - 21000 intrinsic - calldata):")
    for nm, addr, data in [("ecAdd", 6, w(1)+w(2)+w(1)+w(2)), ("ecMul", 7, w(1)+w(2)+w(2))]:
        g = min_gas(addr, data)
        if g: print("    %-14s %d" % (nm, g - 21000 - calldata_gas(data)))
    for k in (1, 2, 4):
        g = min_gas(8, pair(G1) * k)
        if g: print("    %-14s %d" % ("pairing k=%d" % k, g - 21000 - calldata_gas(pair(G1) * k)))
    print("    (EIP-1108 says 150 / 6000 / 45000+34000k)")
    print("\n  NOTE: max gas per contract call is NOT measurable this way. The relay")
    print("  ignores the consensus cap and a bisect saturates at your upper bound.")
    print("  It needs a real signed transaction from a funded account.")

urls = sys.argv[1:] or ["https://ethereum-rpc.publicnode.com", "https://testnet.hashio.io/api"]
for u in urls:
    run(u)
