#!/usr/bin/env python3
"""
Do Hedera system contracts report bytecode to EXTCODESIZE?

Why this matters. an earlier measurement's proposed upstream fix for the LowLevelCall fail-open
seam is a `target.code.length == 0` guard. If the HTS system contract at 0x167
reports zero code, that guard rejects HTS itself and the patch is wrong. The
same question is a design decision step 1: whether an EVM contract can reach HTS at all.

Method. eth_call with no `to` treats `data` as init code, so a 12 byte program
can run EXTCODESIZE inside a consensus node and RETURN the answer. Nothing is
deployed and nothing is paid.

    61 01 67   PUSH2 <address>
    3b         EXTCODESIZE
    60 00      PUSH1 0x00
    52         MSTORE
    60 20      PUSH1 0x20
    60 00      PUSH1 0x00
    f3         RETURN

Controls, because a probe that returns 0 for everything proves nothing:

  C1  a contract we deployed ourselves and watched work (spike 2's bond).
      MUST be nonzero. If it is zero the probe is broken and every other row
      is meaningless.
  C2  0x0fff, an address nothing has ever been deployed to. MUST be zero.
  C3  0x06, a bn254 precompile that spike 1 proved is live and correct.
      Its answer is the calibration: it tells us what a working native
      implementation looks like to EXTCODESIZE.
"""
import json, urllib.request, urllib.error, sys

MIRROR = "https://testnet.mirrornode.hedera.com/api/v1/contracts/call"

TARGETS = [
    ("0x0000000000000000000000000000000000000167", "HTS system contract",        None),
    ("0x0000000000000000000000000000000000000168", "exchange rate system c.",    None),
    ("0x0000000000000000000000000000000000000169", "PRNG system contract",       None),
    ("0x000000000000000000000000000000000000016a", "HAS (hbar allowance)",       None),
    ("0x0000000000000000000000000000000000000006", "C3 bn254 ecAdd precompile",  None),
    ("0x0000000000000000000000000000000000000001", "C3 ecrecover precompile",    None),
    ("0x893AB1A77B098aC3aE930de50ce47a58d3d5B328", "C1 spike 2 bond (ATS)",      "nonzero"),
    ("0x1B9B5E6147a55e243232d9E2Cc350Fe63B040C83", "C1 spike 3 kyc list",        "nonzero"),
    ("0x0000000000000000000000000000000000000fff", "C2 never deployed",          "zero"),
]

def initcode_for(addr):
    """PUSH20 <addr>; EXTCODESIZE; PUSH1 0; MSTORE; PUSH1 32; PUSH1 0; RETURN"""
    a = addr.lower().replace("0x", "").rjust(40, "0")
    return "0x73" + a + "3b60005260206000f3"

def call(data):
    body = json.dumps({"data": data, "gas": 1000000, "estimate": False}).encode()
    req = urllib.request.Request(MIRROR, data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read()).get("result"), None
    except urllib.error.HTTPError as e:
        return None, "HTTP %d %s" % (e.code, e.read()[:200].decode("utf8", "replace"))
    except Exception as e:
        return None, str(e)

rows = []
for addr, label, expect in TARGETS:
    res, err = call(initcode_for(addr))
    if err:
        rows.append((addr, label, expect, None, err))
        continue
    size = int(res, 16) if res and res != "0x" else 0
    rows.append((addr, label, expect, size, None))

print("EXTCODESIZE from inside a Hedera consensus node, testnet 296")
print("%-44s %-26s %10s" % ("address", "what", "codesize"))
print("-" * 84)
for addr, label, expect, size, err in rows:
    shown = "ERR" if err else str(size)
    print("%-44s %-26s %10s%s" % (addr, label, shown, "  <- " + err if err else ""))

print()
ok = True
for addr, label, expect, size, err in rows:
    if expect == "nonzero":
        good = size is not None and size > 0
        print("[%s] %s expected nonzero, got %s" % ("PASS" if good else "FAIL", label, size))
        ok &= good
    if expect == "zero":
        good = size == 0
        print("[%s] %s expected zero, got %s" % ("PASS" if good else "FAIL", label, size))
        ok &= good
print()
print("controls %s. Rows above are %s." % (
    "PASS" if ok else "FAIL",
    "a measurement" if ok else "NOT a measurement, do not quote them"))
