#!/usr/bin/env python3
"""
Does an HTS token address, pointed at a typed ATS seam, fail open?

Context. an earlier measurement's proposed upstream fix is `target.code.length == 0`. The
companion probe (system-contract-bytecode.py) found that HTS tokens report 147
bytes of HIP-719 facade, so a token address PASSES both that guard and the
extcodesize check the Solidity compiler already emits for a typed call. If the
facade then answers a seam selector with success and decodable data, the
typed-seam family fails open too and an earlier measurement's "typed seams fail closed"
asymmetry is wrong.

What decides it: `success` and the returndata, for the real seam selectors.

Controls:
  C1  MockedExternalKycList from spike 3. MUST answer getKycStatus. If it does
      not, the harness is broken and no row below means anything.
  C2  an EOA. MUST fail, and that failure is the known-closed baseline every
      other row is compared against.
"""
import json, urllib.request, urllib.error

MIRROR = "https://testnet.mirrornode.hedera.com/api/v1/contracts/call"
ARG = "000000000000000000000000d30de9c5aef8079b4718b4988e8fd1d1a96f3115"

SELECTORS = [
    ("0xbe88ff49", "getKycStatus(address)",  ARG),  # IExternalKycList
    ("0xfe575a87", "isBlacklisted(address)", ARG),  # IExternalControlList
    ("0xb187bd26", "isPaused()",             ""),   # IExternalPause
    ("0xb9209e33", "isVerified(address)",    ARG),  # ERC-3643 identityRegistry
]

TARGETS = [
    ("0x1B9B5E6147a55e243232d9E2Cc350Fe63B040C83", "C1 MockedExternalKycList", "must answer"),
    ("0xd30de9c5aef8079b4718b4988e8fd1d1a96f3115", "C2 EOA (0 bytes code)",    "must fail"),
    ("0x00000000000000000000000000000000009d7900", "HTS token (147 bytes)",    None),
    ("0x893AB1A77B098aC3aE930de50ce47a58d3d5B328", "ATS bond, wrong iface",    None),
    ("0x0000000000000000000000000000000000000167", "HTS system contract",      None),
]

def call(to, data):
    body = json.dumps({"to": to, "data": data, "gas": 500000,
                       "estimate": False}).encode()
    req = urllib.request.Request(MIRROR, data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return True, json.loads(r.read()).get("result", "")
    except urllib.error.HTTPError as e:
        try:
            j = json.loads(e.read())
            msgs = j.get("_status", {}).get("messages", [{}])
            m = msgs[0].get("message") or msgs[0].get("detail") or str(j)[:80]
        except Exception:
            m = "HTTP %d" % e.code
        return False, m

print("A typed seam call, against each shape an operator could register")
print("testnet 296, via mirror node /contracts/call\n")
for to, label, expect in TARGETS:
    print("%s   %s" % (label, to))
    for sel, name, arg in SELECTORS:
        ok, out = call(to, sel + arg)
        verdict = "SUCCESS" if ok else "revert "
        shown = (out[:66] + "...") if ok and len(out) > 66 else out
        print("    %-26s %s  %s" % (name, verdict, shown))
    print()
