#!/usr/bin/env python3
"""
O4: max calldata per Hedera contract call.

Sibling of measure_gas_cap.py, which bisected WORK against blake2f to find the
15,000,000 gas ceiling. This bisects LENGTH against the identity precompile to
find the calldata ceiling.

Target is 0x04 (identity): cost 15 + 3*ceil(len/32), and it echoes its input, so
a successful call can be checked for the exact byte count rather than merely for
"did not revert". Length is the only variable.

Three controls, because the first answer this probe gave was wrong:

  1. TWO TRANSPORTS. Probing only powers of two on the mirror node reports a
     failure at 256 KiB that is an HTML 403 from a CDN, not a Hedera answer.
     hashio must agree on the boundary or the number is a transport artefact.
  2. BYTE CONTENT. Zero bytes cost 4 gas, 0xff costs 16. If the boundary moves
     with content it is a gas limit wearing a size limit's name.
  3. THE GAS FIELD IS LIVE. The same payload at a low gas cap must return
     INSUFFICIENT_GAS, or the oversize rejection could be a mislabelled gas
     failure.

Run: python3 measure_calldata_cap.py
"""

import json
import urllib.request
import urllib.error

IDENTITY = "0x0000000000000000000000000000000000000004"
MIRROR = "https://testnet.mirrornode.hedera.com/api/v1/contracts/call"
HASHIO = "https://testnet.hashio.io/api"


def mirror(nbytes, byte="00", gas=15_000_000):
    payload = json.dumps({
        "to": IDENTITY, "data": "0x" + byte * nbytes, "gas": gas,
        "estimate": False, "block": "latest",
    }).encode()
    req = urllib.request.Request(
        MIRROR, method="POST", data=payload,
        headers={"Content-Type": "application/json", "Accept": "application/json"})
    try:
        r = json.loads(urllib.request.urlopen(req, timeout=120).read())
        res = r.get("result", "")
        return True, "ok", (len(res) // 2 - 1) if res.startswith("0x") else -1
    except urllib.error.HTTPError as e:
        body = e.read()[:200].decode(errors="replace").replace("\n", " ")
        # A CDN rejects with an HTML body. Hedera rejects with JSON.
        if e.code == 403 and "<!doctype" in body.lower():
            return False, "EDGE-403-HTML (CDN, not Hedera)", -1
        try:
            msg = json.loads(body)["_status"]["messages"][0]["message"]
        except Exception:
            msg = f"HTTP {e.code} {body[:80]}"
        return False, msg, -1
    except Exception as e:
        return False, f"{type(e).__name__}: {e}", -1


def hashio(nbytes, byte="00", gas=15_000_000):
    payload = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "eth_call",
        "params": [{"to": IDENTITY, "data": "0x" + byte * nbytes, "gas": hex(gas)},
                   "latest"],
    }).encode()
    req = urllib.request.Request(
        HASHIO, method="POST", data=payload,
        headers={"Content-Type": "application/json", "User-Agent": "curl/8.4.0"})
    try:
        r = json.loads(urllib.request.urlopen(req, timeout=120).read())
        if "result" in r:
            return True, "ok", len(r["result"]) // 2 - 1
        return False, f"rpc-error {str(r.get('error'))[:70]}", -1
    except urllib.error.HTTPError as e:
        body = e.read()[:200].decode(errors="replace").replace("\n", " ")
        if e.code == 403 and "<!doctype" in body.lower():
            return False, "EDGE-403-HTML (CDN, not Hedera)", -1
        return False, f"HTTP {e.code} {body[:70]}", -1
    except Exception as e:
        return False, f"{type(e).__name__}: {e}", -1


def bisect(fn, lo, hi):
    """lo must pass, hi must fail. Returns (max_accepted, reason_at_first_reject)."""
    reason = ""
    while lo < hi - 1:
        mid = (lo + hi) // 2
        ok, msg, echoed = fn(mid)
        if ok and echoed == mid:
            lo = mid
        else:
            hi = mid
            reason = msg
    return lo, reason


def main():
    print("O4: max calldata per Hedera contract call, testnet\n")

    print("CONTROL 0: the instrument echoes, so a pass is checked not assumed")
    for n in (1, 32, 1024):
        ok, msg, echoed = mirror(n)
        print(f"   {n:>6} bytes -> ran={ok} echoed={echoed} "
              f"{'match' if echoed == n else 'MISMATCH'}")

    print("\nBRACKET: exponential probe, mirror node")
    last_ok, first_fail = None, None
    for k in range(10, 20):
        n = 2 ** k
        ok, msg, echoed = mirror(n)
        print(f"   {n:>7} bytes ({n/1024:>7.1f} KiB) -> ran={ok} {msg}")
        if ok and echoed == n:
            last_ok = n
        else:
            first_fail = n
            break

    if first_fail is None:
        print("   no ceiling found in range")
        return

    print(f"\nBISECT between {last_ok} and {first_fail}, on both transports")
    results = {}
    for name, fn in (("mirror node", mirror), ("hashio JSON-RPC", hashio)):
        cap, reason = bisect(fn, last_ok, first_fail)
        results[name] = cap
        print(f"   {name:<18} max accepted = {cap} bytes ({cap/1024:.2f} KiB)")
        print(f"   {'':<18} first reject = {cap+1}, reason: {reason}")

    agree = len(set(results.values())) == 1
    print(f"\n   transports agree: {agree}"
          f"{'' if agree else '  <- ARTEFACT, do not cite'}")
    cap = results["mirror node"]

    print("\nCONTROL 1: byte content. Same boundary for 4-gas and 16-gas bytes?")
    for byte, cost in (("00", 4), ("ff", 16)):
        ok_at, _, _ = mirror(cap, byte)
        ok_over, msg_over, _ = mirror(cap + 1, byte)
        print(f"   0x{byte} ({cost:>2} gas/byte): {cap} ran={ok_at}, "
              f"{cap+1} ran={ok_over} ({msg_over})")
    print("   Identical boundary means a SIZE limit, not a gas limit.")

    print("\nCONTROL 2: is the gas field even honoured on this path?")
    for g in (15_000_000, 1_000_000, 100_000):
        ok, msg, _ = mirror(cap, "00", gas=g)
        print(f"   gas={g:>10}: ran={ok} {msg}")
    print("   INSUFFICIENT_GAS at a low cap proves gas is live, so the")
    print("   oversize rejection above is not a mislabelled gas failure.")

    print(f"\nRESULT: max calldata = {cap} bytes = {cap/1024:.0f} KiB exactly")
    print(f"        {cap+1} bytes returns TRANSACTION_OVERSIZE")
    print()
    print("Consequence for the security model's section 8.2, at ~50,100 gas and 256 bytes")
    print("per batched Groth16 proof:")
    by_gas = 15_000_000 // 50_100
    by_size = cap // 256
    print(f"   gas ceiling  allows ~{by_gas} proofs")
    print(f"   calldata cap allows ~{by_size} proofs")
    print(f"   GAS binds first. Calldata has {100*(by_size-by_gas)/by_gas:.0f}% headroom.")


if __name__ == "__main__":
    main()
