// SPDX-License-Identifier: Apache-2.0
//
// Spike 6: which address shapes does the ATS KYC seam accept, and does it fail
// open or closed for each.
//
// Why. an earlier measurement's proposed upstream fix is `target.code.length == 0`. Two mirror
// node probes found that the guard does not partition the way the PR assumes:
// HTS system contracts report ZERO bytes, and HTS tokens report 147 bytes of
// HIP-719 facade that answers any selector with success and empty returndata.
// So `code.length > 0` admits every token on the network. Whether that reaches
// the seam depends on Solidity's ABI decoder, and reasoning about the decoder
// is not a measurement. This runs it.
//
// Reuses spike 2's bond and spike 3's mock rather than deploying. State is
// restored at the end and the restoration is verified, not assumed.
//
// Run:
//   HEDERA_TESTNET_PRIVATE_KEY_0="$(cat ~/.hedera-testnet-key)" \
//   npx hardhat run --network hedera-testnet scripts/spike/seam-shapes.ts

import { ethers } from "hardhat";

const BOND = "0x893AB1A77B098aC3aE930de50ce47a58d3d5B328";
const MOCK = "0x1B9B5E6147a55e243232d9E2Cc350Fe63B040C83";
const COUNTERPARTY = "0x000000000000000000000000000000000000dEaD";

// Every shape an operator could plausibly put in the Studio's "external KYC
// list" field, which an earlier measurement showed validates format only.
const SHAPES: [string, string, string][] = [
  // address, label, what the code-length guard would do with it
  ["0x00000000000000000000000000000000009d7900", "HTS token, HIP-719 facade", "ADMITS, 147 bytes"],
  ["0xd30de9c5aef8079b4718b4988e8fd1d1a96f3115", "EOA, ECDSA alias",          "rejects, 0 bytes"],
  ["0x0000000000000000000000000000000000000167", "HTS system contract",       "rejects, 0 bytes"],
  ["0x0000000000000000000000000000000000000006", "bn254 ecAdd precompile",    "rejects, 0 bytes"],
  [BOND,                                         "C2 a contract that reverts", "ADMITS, 390 bytes"],
];

function note(step: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ step...fields }));
}

async function main() {
  const [signer] = await ethers.getSigners();
  const provider = signer.provider!;
  const me = await signer.getAddress();
  const bal0 = await provider.getBalance(me);
  const quoted = (await provider.getFeeData()).gasPrice ?? 0n;
  const gasPrice = (quoted * 12n) / 10n;
  const opts = { gasLimit: 3_000_000, gasPrice };

  note("env", { signer: me, balanceHbar: Number(bal0 / 10n ** 14n) / 10000 });

  const kyc = await ethers.getContractAt("IExternalKycListManagement", BOND, signer);
  const transfer = await ethers.getContractAt("ITransfer", BOND, signer);

  // Can this transfer happen right now. Everything below is read against this.
  async function probeTransfer(): Promise<[boolean, string]> {
    try {
      await transfer.transfer.staticCall(COUNTERPARTY, 1n);
      return [true, ""];
    } catch (e: any) {
      return [false, (e.shortMessage ?? e.message ?? String(e)).slice(0, 120)];
    }
  }

  const before = (await kyc.getExternalKycListsMembers(0, 10)) as string[];
  const [c1ok, c1why] = await probeTransfer();
  note("C1_baseline", {
    lists: before,
    transferSucceeds: c1ok,
    reason: c1why,
    expected: "true, the mock grants both parties",
  });
  if (!c1ok) {
    note("ABORT", { why: "baseline transfer already fails, nothing below would mean anything" });
    return;
  }

  // Clear the mock so each shape under test is the ONLY list. With no list at
  // all the seam reads GRANTED (spike 2 measured this), so a shape that fails
  // open is indistinguishable from an empty list, which is the whole point.
  await (await kyc.removeExternalKycList(MOCK, opts)).wait();
  const [emptyOk] = await probeTransfer();
  note("C3_empty_list", { transferSucceeds: emptyOk, expected: "true, an empty list reads GRANTED" });

  for (const [addr, label, guard] of SHAPES) {
    let accepted = false;
    let addErr = "";
    try {
      await (await kyc.addExternalKycList(addr, opts)).wait();
      accepted = true;
    } catch (e: any) {
      addErr = (e.shortMessage ?? e.message ?? String(e)).slice(0, 120);
    }

    if (!accepted) {
      note("shape", { addr, label, codeLengthGuard: guard, registered: false, addError: addErr });
      continue;
    }

    let granted: boolean | string;
    try {
      granted = await kyc.isExternallyGranted(me, 1);
    } catch (e: any) {
      granted = "revert: " + (e.shortMessage ?? e.message ?? String(e)).slice(0, 80);
    }
    const [ok, why] = await probeTransfer();

    note("shape", {
      addr,
      label,
      codeLengthGuard: guard,
      registered: true,
      isExternallyGranted: granted,
      transferSucceeds: ok,
      reason: why,
      verdict: ok ? "FAILS OPEN" : "fails closed",
    });

    await (await kyc.removeExternalKycList(addr, opts)).wait();
  }

  // Restore, and verify the restore rather than trusting it.
  await (await kyc.addExternalKycList(MOCK, opts)).wait();
  const after = (await kyc.getExternalKycListsMembers(0, 10)) as string[];
  const [restoredOk] = await probeTransfer();
  const spent = bal0 - (await provider.getBalance(me));
  note("restore", {
    lists: after,
    matchesBaseline: JSON.stringify(after) === JSON.stringify(before),
    transferSucceeds: restoredOk,
    hbarSpent: Number(spent / 10n ** 14n) / 10000,
  });
}

main().catch((e) => {
  console.error(JSON.stringify({ step: "FAILED", error: e.shortMessage ?? e.message ?? String(e) }));
  process.exit(1);
});
