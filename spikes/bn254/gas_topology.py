"""
Topology probe v2: classify a precompile by the SHAPE of its gas -> outcome step
function rather than by one sample of its return bytes.

A byte-only differential cannot separate these two, because both are "empty":
    ABSENT   address has no code: the call SUCCEEDS, returns empty, costs ~0
    REJECT   precompile refuses:  the call FAILS,   returns empty, costs everything
Guessing between them from bytes is the fail-open bug this spike exists to
rule out, reappearing one level up in the test harness.

Second axis: for fixed calldata, f(g) = outcome at gas limit g is a step
function whose discontinuity g* is an invariant of the code at that address.
    ABSENT    g* = floor                (nothing charged past intrinsic)
    PRESENT   g* = floor + price
    REJECT    no g* at any g
Running identical calldata against a known no-code address cancels the intrinsic
and calldata terms AND any chain-specific floor, so g*(addr) - g*(nocode) is the
consensus price with no gasleft() and no contract framing inside the window.

v2 fixes two defects in v1, both of which are rules this repo had already
written down and I broke anyway:
  - a transport failure (hashio rate-limits under this load) was being folded
    into "call failed", which turned throttling into a fake REJECT verdict.
    XPRT is now a hard abort, never a data point.
  - no pacing, which caused the throttling in the first place.
"""
import json, urllib.request, sys, time

NOCODE = "0x00000000000000000000000000000000deadbe01"
PACE = 0.35

class Transport(Exception): pass

def rpc(url, method, params, tries=4):
    last = ""
    for a in range(tries):
        time.sleep(PACE)
        req = urllib.request.Request(url, method="POST",
            data=json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode(),
            headers={"Content-Type":"application/json","User-Agent":"curl/8.4.0"})
        try:
            return json.loads(urllib.request.urlopen(req, timeout=45).read())
        except urllib.error.HTTPError as e:
            body = e.read()
            if e.code in (429, 502, 503, 504):     # throttling, not an answer
                last = "HTTP %d" % e.code; time.sleep(2.0 * (a + 1)); continue
            try: return json.loads(body)
            except Exception: last = "HTTP %d unparseable" % e.code
        except Exception as ex:
            last = str(ex); time.sleep(1.0 + a)
    raise Transport(last)

# Only these mean "the EVM ran and refused". Anything else a relay says is
# infrastructure noise, and folding it into "failed" is how a throttled endpoint
# gets recorded as a precompile that rejects valid input.
EXEC = ("insufficient gas", "out of gas", "intrinsic gas", "floor data gas",
        "execution reverted", "INSUFFICIENT_GAS", "CONTRACT_EXECUTION_EXCEPTION",
        "point is not on curve", "invalid input parameters", "bad elliptic curve",
        "CONTRACT_REVERT_EXECUTED", "INVALID_SOLIDITY_ADDRESS", "gas required exceeds")

def ok(url, to, data, gas):
    assert len(to) == 42, "to must be a full 20-byte address, not %r" % to
    r = rpc(url, "eth_call", [{"to": to, "data": "0x"+data, "gas": hex(gas)}, "latest"])
    if "error" not in r:
        return True
    msg = str(r["error"].get("message", ""))
    if any(k in msg for k in EXEC):
        return False
    raise Transport("relay error, not an execution result: %s" % msg[:90])

def step(url, to, data, lo, hi):
    """Least gas at which the call succeeds, or None if it never does below hi."""
    if not ok(url, to, data, hi): return None
    if ok(url, to, data, lo):     return lo
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if ok(url, to, data, mid): hi = mid
        else: lo = mid
    return hi

G2 = ("198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2"
      "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed"
      "090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b"
      "12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa")
W = lambda n: "%064x" % n
P = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47

CASES = [
    ("0x06 ecAdd  G+G",           "0x0000000000000000000000000000000000000006", W(1)+W(2)+W(1)+W(2),        150),
    ("0x06 ecAdd  O+O -> O",      "0x0000000000000000000000000000000000000006", W(0)*4,                     150),
    ("0x06 ecAdd  off-curve",     "0x0000000000000000000000000000000000000006", W(1)+W(3)+W(1)+W(2),        None),
    ("0x07 ecMul  2*G",           "0x0000000000000000000000000000000000000007", W(1)+W(2)+W(2),            6000),
    ("0x08 pair   empty",         "0x0000000000000000000000000000000000000008", "",                       45000),
    ("0x08 pair   bilinear x2",   "0x0000000000000000000000000000000000000008", W(1)+W(P-2)+G2+W(1)+W(2)+G2, 113000),
]

chains = [("hedera-testnet", "https://testnet.hashio.io/api"),
          ("ethereum-mainnet (control)", "https://ethereum-rpc.publicnode.com")]
if len(sys.argv) > 1 and sys.argv[1] == "--all":
    chains.insert(1, ("hedera-mainnet", "https://mainnet.hashio.io/api"))

print("TOPOLOGY OF THE GAS STEP FUNCTION\n")
for cname, url in chains:
    try:
        code = rpc(url, "eth_getCode", [NOCODE, "latest"]).get("result")
    except Transport as e:
        print("== %s ==  UNREACHABLE (%s), no verdict\n" % (cname, e)); continue
    if code != "0x":
        print("== %s ==  control address has code %s, cannot calibrate\n" % (cname, code)); continue
    print("== %s ==  control 0x...beef01 confirmed codeless" % cname)
    print("  %-26s %-10s %-11s %-9s %-8s %s" % ("case","g*","g*(nocode)","delta","spec","verdict"))
    for label, addr, data, expect in CASES:
        try:
            gn = step(url, NOCODE, data, 21000, 400000)
            g  = step(url, addr,   data, 21000, 400000)
        except Transport as e:
            print("  %-26s %s" % (label, "XPRT (%s): no verdict, not a failure" % e)); continue
        if gn is None:  v, d = "CONTROL BROKEN", "-"
        elif g is None: v, d = ("REJECT, correct" if expect is None else "!! REJECTED a valid input"), "-"
        else:
            d = g - gn
            if d == 0:            v = "ABSENT / fail-open"
            elif expect is None:  v = "!! ACCEPTED, must reject"
            elif d == expect:     v = "PRESENT, price exact"
            else:                 v = "PRESENT, price %d, spec %d" % (d, expect)
        print("  %-26s %-10s %-11s %-9s %-8s %s" % (
            label, g, gn, d, expect if expect is not None else "reject", v))
    print()
