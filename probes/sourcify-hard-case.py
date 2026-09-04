#!/usr/bin/env python3
"""
Spike 5, the half an earlier measurement said was skipped.

an earlier measurement: the three contracts we verified were all single-file snarkjs output, and
"repetition of the easy case reads as thoroughness and is not coverage." The
contracts a judge clicks through on the demo are hardhat-compiled with imports,
and the ATS security itself is a resolver proxy deployed by a factory. None of
that was tested, and the ATS team has verified none of their own on testnet.

This submits the real shapes to Sourcify v2 for chain 296.

Controls, in order of what they rule out:
  C1  a contract we deployed today whose source we hold and whose bytecode we
      watched go on chain. If this cannot verify, the harness is wrong and no
      failure below is evidence about ATS.
  C2  a deliberate mismatch: the same source submitted against a DIFFERENT
      address. Sourcify MUST reject it. Without this, "verified" only means the
      endpoint returns 200.
"""
import json, os, sys, time, urllib.request, urllib.error, glob

SERVER = "https://sourcify.dev/server"
CHAIN = "296"
ROOT = "/Users/awaansiddiqui/hedera2026/asset-tokenization-studio/packages/ats/contracts"

TARGETS = [
    ("0xAECF4D3E5Fb45372596813d37A15725610344907",
     "contracts/test/mocks/AtomicityProbe.sol:AtomicityProbe",
     "a2af6aa2931d53d735aa2178e28c890d", "C1 ours, hardhat, deployed today"),
    ("0x1B9B5E6147a55e243232d9E2Cc350Fe63B040C83",
     "contracts/test/mocks/MockedExternalKycList.sol:MockedExternalKycList",
     "051f7dea8c6331103f79930c5ae40079", "the seam skeleton, 108-facet build"),
    ("0x893AB1A77B098aC3aE930de50ce47a58d3d5B328",
     "contracts/infrastructure/proxy/ResolverProxy.sol:ResolverProxy",
     "051f7dea8c6331103f79930c5ae40079", "THE HARD CASE, factory-deployed proxy"),
    ("0x48a4F97121CD019d793d3b95E251E5D2F32d7094",
     "contracts/test/mocks/AtomicityProbe.sol:AtomicityProbe",
     "a2af6aa2931d53d735aa2178e28c890d", "C2 wrong source for this address"),
]

def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or b"{}")
        except Exception: return e.code, {}

def get(url):
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or b"{}")
        except Exception: return e.code, {}

print("Sourcify v2, chain %s\n" % CHAIN)
for addr, ident, bi, label in TARGETS:
    path = os.path.join(ROOT, "artifacts/build-info", bi + ".json")
    d = json.load(open(path))
    body = {
        "stdJsonInput": d["input"],
        "compilerVersion": d["solcLongVersion"],
        "contractIdentifier": ident,
    }
    st, res = post("%s/v2/verify/%s/%s" % (SERVER, CHAIN, addr), body)
    vid = res.get("verificationId")
    print("%-38s %s" % (label, addr))
    print("    submit  HTTP %s  %s" % (st, vid or json.dumps(res)[:140]))
    if not vid:
        print()
        continue
    final = None
    for _ in range(40):
        time.sleep(4)
        s2, j = get("%s/v2/verify/%s" % (SERVER, vid))
        if j.get("isJobCompleted"):
            final = j
            break
    if final is None:
        print("    result  still running after 160s, no verdict\n")
        continue
    c = final.get("contract", {})
    err = final.get("error", {}) or {}
    print("    result  match=%s  creation=%s  runtime=%s  %s" % (
        c.get("match"), c.get("creationMatch"), c.get("runtimeMatch"),
        err.get("customCode") or err.get("message", "")[:90]))
    print()
