#!/usr/bin/env python3
"""
Probe: are the EIP-2537 BLS12-381 precompiles (0x0b..0x11) live on Hedera?

Why this exists. An earlier measurement established the rule that an address with
no code answers a staticcall successfully and returns nothing, so "the call
worked" is never evidence a precompile exists. An earlier design decision refused
recursive aggregate proving partly because BLS12-381 is absent on Hedera. That
refusal was never measured: spike 1 probed 0x06/0x07/0x08 and stopped there.
HIP-1341 is Approved and adopts EIP-2537, so the answer can have changed.

Method, inherited from spikes/bn254/verify.py:

  1. A CONTROL IS MANDATORY. Every vector runs against Ethereum mainnet too.
     Pectra shipped there on 2025-05-07, so 0x0b IS present on mainnet. A vector
     that fails on Ethereum is a bad vector, not a Hedera finding.

  2. A TRANSPORT ERROR IS NOT A RESULT. HTTP failures are their own outcome.

  3. THE LOAD-BEARING TEST IS ALGEBRAIC. G1ADD(G, -G) = O needs only the field
     prime and the generator; no reference implementation, no copied vector.
     Paired with G1ADD(G, O) = G it pins the address: an absent address returns
     empty and fails both, an all-zero stub passes the first and fails the
     second, an echo stub fails both.

EIP-2537 encoding: an Fp element is 64 bytes = 16 zero bytes || 48-byte BE.
A G1 point is 128 bytes. G1ADD takes 256 bytes and returns 128.
"""
import json, sys, urllib.request, urllib.error, time

# BLS12-381 base field prime
P = 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab
# G1 generator, from the BLS12-381 spec (draft-irtf-cfrg-pairing-friendly-curves)
GX = 0x17f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb
GY = 0x08b3f481e3aaa0f1a09e30ed741d8ae4fcf5e095d5d00af600db18cb2c04b3edd03cc744a2888ae40caa232946c5e7e1

def fp(x):
    """EIP-2537 Fp encoding: 64 bytes, 16 leading zero bytes then 48-byte BE."""
    return "00" * 16 + "%096x" % x

def g1(x, y):
    return fp(x) + fp(y)

INF = g1(0, 0)
G   = g1(GX, GY)
NEG = g1(GX, P - GY)

ADDR = {
    "0x0b": "BLS12_G1ADD",
    "0x0c": "BLS12_G1MSM",
    "0x0d": "BLS12_G2ADD",
    "0x0e": "BLS12_G2MSM",
    "0x0f": "BLS12_PAIRING_CHECK",
    "0x10": "BLS12_MAP_FP_TO_G1",
    "0x11": "BLS12_MAP_FP2_TO_G2",
}

def addr20(short):
    return "0x" + "%040x" % int(short, 16)

ENDPOINTS = [
    ("hedera-testnet", "https://testnet.hashio.io/api"),
    ("hedera-mainnet", "https://mainnet.hashio.io/api"),
    ("ethereum-CONTROL", "https://ethereum-rpc.publicnode.com"),
]

def call(url, to, data, gas=None):
    """Returns ('OK', hexstring) | ('FAIL', msg) | ('XPRT', msg). XPRT never passes."""
    params = {"to": to, "data": "0x" + data}
    if gas:
        params["gas"] = hex(gas)
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                       "params": [params, "latest"]}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", "User-Agent": "curl/8.4.0"})
    try:
        r = json.loads(urllib.request.urlopen(req, timeout=25).read())
    except urllib.error.HTTPError as e:
        # A relay may return the JSON-RPC error body under an HTTP 4xx. Scoring
        # that as a transport failure would turn a correct REJECT into XPRT,
        # which is the same mistake wearing a different hat. Read the body first.
        try:
            r = json.loads(e.read())
        except Exception:
            return ("XPRT", "HTTP %s, unreadable body" % e.code)
    except Exception as e:
        return ("XPRT", str(e)[:90])
    if "error" in r:
        return ("FAIL", json.dumps(r["error"])[:110])
    return ("OK", r.get("result", ""))

VECTORS = [
    # name,               input,        expected output (hex, no 0x)
    ("G1ADD(G, O) = G",   G + INF,      G),
    ("G1ADD(G, -G) = O",  G + NEG,      INF),
    ("G1ADD(O, O) = O",   INF + INF,    INF),
]

def main():
    print("EIP-2537 BLS12-381 precompile probe")
    print("date:", time.strftime("%Y-%m-%d %H:%M:%S"))
    print()

    for label, url in ENDPOINTS:
        print("=" * 66)
        print(label, url)
        print("=" * 66)

        # Step 1: existence sweep across all seven addresses, using a
        # deliberately EMPTY input. Every EIP-2537 precompile rejects empty
        # input, so a present precompile FAILS here and an absent address
        # SUCCEEDS with empty output. This is that distinction, used the
        # right way round.
        print("\n  [existence sweep] empty input: FAIL = present, OK/empty = absent")
        present = {}
        for short, name in ADDR.items():
            st, res = call(url, addr20(short), "")
            if st == "XPRT":
                print("    %-4s %-22s XPRT  %s" % (short, name, res))
                present[short] = None
                continue
            verdict = "PRESENT (rejected empty)" if st == "FAIL" else \
                      ("ABSENT (returned empty)" if res in ("0x", "") else "ODD: %s" % res[:40])
            present[short] = (st == "FAIL")
            print("    %-4s %-22s %s" % (short, name, verdict))
            time.sleep(0.3)

        # Step 2: known-answer tests on 0x0b, which is the cheapest to encode
        # and the only one whose correctness is checkable by algebra alone.
        print("\n  [known-answer] 0x0b BLS12_G1ADD")
        for name, inp, want in VECTORS:
            st, res = call(url, addr20("0x0b"), inp)
            if st == "XPRT":
                print("    %-20s XPRT  %s" % (name, res))
            elif st == "FAIL":
                print("    %-20s FAIL  %s" % (name, res))
            else:
                got = res[2:] if res.startswith("0x") else res
                ok = got.lower() == want.lower()
                print("    %-20s %s  (%d bytes returned)" %
                      (name, "PASS" if ok else "MISMATCH", len(got) // 2))
            time.sleep(0.3)
        print()

if __name__ == "__main__":
    main()
