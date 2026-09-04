#!/usr/bin/env python3
"""Spike 1 stage 2: run a real Groth16 verification on Hedera, on chain.

No deployment. The verifier snarkjs generates is a fixed sequence of calls to
0x07, 0x06 and 0x08, so the whole verification can be driven straight at the
precompiles with eth_call. The consensus nodes do every field operation; the
only thing this does not exercise is the Solidity wrapper around them.

Everything the verifier uses comes out of the generated .sol file rather than
being re-derived here, so an ordering mistake in this script cannot silently
agree with an ordering mistake in the contract.

Two rules carried over from stage 1, both learned the hard way:
  1. Assert on returned bytes, never on call status. An address with no code
     answers a staticcall successfully and returns nothing.
  2. A relay error is not a result. Anything that is not a recognised execution
     outcome raises rather than being folded into "the call failed".
"""
import json, re, sys, time, urllib.request

P = 21888242871839275222246405745257275088696311157297823662689037894645226208583
ADD, MUL, PAIR = "0x06", "0x07", "0x08"
A_ADD  = "0x0000000000000000000000000000000000000006"
A_MUL  = "0x0000000000000000000000000000000000000007"
A_PAIR = "0x0000000000000000000000000000000000000008"
NOCODE = "0x00000000000000000000000000000000cafe0008"

EXEC = ("insufficient gas", "out of gas", "intrinsic gas", "floor data gas",
        "execution reverted", "INSUFFICIENT_GAS", "CONTRACT_EXECUTION_EXCEPTION",
        "point is not on curve", "invalid input parameters", "bad elliptic curve",
        "CONTRACT_REVERT_EXECUTED", "INVALID_SOLIDITY_ADDRESS", "gas required exceeds",
        "PrecompileError", "EVM error", "invalid opcode")


PACE = 0.6


class Transport(Exception):
    """The chain did not give us an execution result. Not a finding."""


def rpc(url, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method,
                       "params": params}).encode()
    req = urllib.request.Request(url, body, {"Content-Type": "application/json"})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 502, 503, 504) and attempt < 5:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise Transport("HTTP %d" % e.code)
        except Exception as e:
            if attempt < 5:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise Transport(str(e))
    raise Transport("exhausted retries")


def mirror(url, to, data, gas):
    """Hedera's own mirror node contracts/call. Same semantics as eth_call.

    Used in preference to a community JSON-RPC relay because it is first party
    and because it separates the two outcomes we must never conflate: a
    successful call returns HTTP 200 with a result, and a failed execution
    returns HTTP 400 naming a Hedera status. Anything else is transport.
    """
    body = json.dumps({"block": "latest", "estimate": False, "gas": gas,
                       "to": to, "data": "0x" + data}).encode()
    req = urllib.request.Request(url, body, {"Content-Type": "application/json"})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.loads(r.read())["result"]
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            if e.code == 400:
                msgs = " ".join(m.get("message", "") for m in
                                json.loads(raw).get("_status", {}).get("messages", []))
                if any(k in msgs for k in EXEC):
                    return None                  # a genuine execution failure
                raise Transport("400 but not a known execution status: %s" % msgs[:120])
            if e.code in (429, 502, 503, 504) and attempt < 5:
                time.sleep(2.0 * (attempt + 1))
                continue
            raise Transport("HTTP %d %s" % (e.code, raw[:80]))
        except Transport:
            raise
        except Exception as e:
            if attempt < 5:
                time.sleep(2.0 * (attempt + 1))
                continue
            raise Transport(str(e))
    raise Transport("exhausted retries")


def jsonrpc_call(url, to, data, gas):
    r = rpc(url, "eth_call", [{"to": to, "data": "0x" + data, "gas": hex(gas)}, "latest"])
    if "error" in r:
        msg = str(r["error"].get("message", ""))
        if any(k in msg for k in EXEC):
            return None
        raise Transport("relay error, not an execution result: %s" % msg[:120])
    return r["result"]


def call(url, to, data, gas=15_000_000):
    assert len(to) == 42, "to must be a 20 byte address, got %r" % to
    time.sleep(PACE)
    hexout = (mirror if "/api/v1/contracts/call" in url else jsonrpc_call)(url, to, data, gas)
    if hexout is None:
        return None
    return bytes.fromhex(hexout[2:])


def w(x):
    return "%064x" % (x % (1 << 256))


def parse_vk(sol_path):
    """Pull the verifying key straight out of the generated verifier."""
    src = open(sol_path).read()
    c = {k: int(v) for k, v in
         re.findall(r"uint256 constant (\w+)\s*=\s*(\d+);", src)}
    return c


def vk_x(url, vk, signals):
    """L = IC0 + sum_i IC_{i+1} * s_i, computed by the chain."""
    acc = (vk["IC0x"], vk["IC0y"])
    for i, s in enumerate(signals):
        prod = call(url, A_MUL, w(vk["IC%dx" % (i + 1)]) + w(vk["IC%dy" % (i + 1)]) + w(s))
        if prod is None or len(prod) != 64:
            return None
        px, py = int.from_bytes(prod[:32], "big"), int.from_bytes(prod[32:], "big")
        summed = call(url, A_ADD, w(acc[0]) + w(acc[1]) + w(px) + w(py))
        if summed is None or len(summed) != 64:
            return None
        acc = (int.from_bytes(summed[:32], "big"), int.from_bytes(summed[32:], "big"))
    return acc


def pairing_input(vk, A, B, C, L):
    """The exact 768 bytes checkPairing assembles, in the same order."""
    return "".join([
        w(A[0]), w((P - A[1]) % P),                                   # -A
        w(B[0][0]), w(B[0][1]), w(B[1][0]), w(B[1][1]),               # B
        w(vk["alphax"]), w(vk["alphay"]),                             # alpha1
        w(vk["betax1"]), w(vk["betax2"]), w(vk["betay1"]), w(vk["betay2"]),
        w(L[0]), w(L[1]),                                             # vk_x
        w(vk["gammax1"]), w(vk["gammax2"]), w(vk["gammay1"]), w(vk["gammay2"]),
        w(C[0]), w(C[1]),                                             # C
        w(vk["deltax1"]), w(vk["deltax2"]), w(vk["deltay1"]), w(vk["deltay2"]),
    ])


def verify(url, vk, A, B, C, signals, pair_addr=A_PAIR):
    """Returns (ran, ok). ran is False when the chain gave no usable answer."""
    for s in signals:
        if s >= 21888242871839275222246405745257275088548364400416034343698204186575808495617:
            return (True, False)                      # checkField
    L = vk_x(url, vk, signals)
    if L is None:
        return (False, False)
    out = call(url, pair_addr, pairing_input(vk, A, B, C, L))
    if out is None:
        return (False, False)                          # precompile refused
    if len(out) != 32:
        return (False, False)                          # absent, or wrong shape
    val = int.from_bytes(out, "big")
    if val > 1:
        return (False, False)
    return (True, val == 1)


def load_proof(base):
    p = json.load(open("proof/%s_proof.json" % base))
    s = [int(x) for x in json.load(open("proof/%s_public.json" % base))]
    A = (int(p["pi_a"][0]), int(p["pi_a"][1]))
    B = ((int(p["pi_b"][0][1]), int(p["pi_b"][0][0])),
         (int(p["pi_b"][1][1]), int(p["pi_b"][1][0])))
    C = (int(p["pi_c"][0]), int(p["pi_c"][1]))
    return A, B, C, s


CHAINS = [("hedera-testnet  (mirror node)", "https://testnet.mirrornode.hedera.com/api/v1/contracts/call"),
          ("hedera-mainnet  (mirror node)", "https://mainnet.mirrornode.hedera.com/api/v1/contracts/call")]

if __name__ == "__main__":
    if "--local" in sys.argv:
        CHAINS = [("anvil (cross-check)", "http://127.0.0.1:8545")]
    vk1 = parse_vk("src/TrivialVerifier.sol")
    vk5 = parse_vk("src/FiveVerifier.sol")
    A, B, C, S = load_proof("trivial")
    fA, fB, fC, fS = load_proof("five")
    R = 21888242871839275222246405745257275088548364400416034343698204186575808495617

    cases = [
        # label, expected (ran, ok), args
        ("valid proof, 1 public signal",   (True, True),  (vk1, A, B, C, S)),
        ("valid proof, 5 public signals",  (True, True),  (vk5, fA, fB, fC, fS)),
        ("A negated, still on curve",      (True, False), (vk1, (A[0], (P - A[1]) % P), B, C, S)),
        ("public signal 33 -> 34",         (True, False), (vk1, A, B, C, [S[0] + 1])),
        ("C negated",                      (True, False), (vk1, A, B, (C[0], (P - C[1]) % P), S)),
        ("public signal == r",             (True, False), (vk1, A, B, C, [R])),
        ("A off curve (1,1)",              (False, False), (vk1, (1, 1), B, C, S)),
    ]

    failures = 0
    for name, url in CHAINS:
        print("\n=== %s ===" % name)
        for label, want, args in cases:
            try:
                got = verify(url, *args)
            except Transport as e:
                print("  %-32s TRANSPORT, no verdict: %s" % (label, e))
                failures += 1
                continue
            mark = "ok " if got == want else "BAD"
            if got != want:
                failures += 1
            print("  %-32s ran=%-5s ok=%-5s  %s" % (label, got[0], got[1], mark))

        # negative control: the same pipeline against a codeless pairing address.
        # A chain without 0x08 must not be able to produce ok=True here.
        try:
            ctl = verify(url, vk1, (1, 1), B, C, S, pair_addr=NOCODE)
            mark = "ok " if ctl == (False, False) else "BAD"
            if ctl != (False, False):
                failures += 1
            print("  %-32s ran=%-5s ok=%-5s  %s  <- control" %
                  ("forged proof, 0x08 codeless", ctl[0], ctl[1], mark))
        except Transport as e:
            print("  %-32s TRANSPORT: %s" % ("codeless control", e))

    print("\n%d failure(s)" % failures)
    sys.exit(1 if failures else 0)
