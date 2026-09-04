// SPDX-License-Identifier: Apache-2.0
//
// a design decision step 2, arm C: the composite. HTS cash leg moves, the ATS security leg
// then fails, and DvP requires that the cash does not survive it.
//
// Arms A and B (d02-atomicity.ts) proved HTS obeys EVM revert semantics
// including nested frames. That makes this arm's outcome predictable, which is
// exactly why it is worth running: the prediction is written down first and the
// run either confirms it or the design changes.
//
// PREDICTION, recorded before the run: the ATS transfer reverts because this
// contract holds no bond units and is not KYC granted, the whole transaction
// reverts, and the HTS balance is unchanged.

import { ethers } from "hardhat";

const TOKEN = "0x00000000000000000000000000000000009d7df9"; // GBPX, 0.0.10321401
const BOND = "0x893AB1A77B098aC3aE930de50ce47a58d3d5B328";  // spike 2 bond
const SEED = 1000n;
const CASH = 100n;
const UNITS = 1n;

function note(step: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ step...fields }));
}

async function main() {
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  const quoted = (await signer.provider!.getFeeData()).gasPrice ?? 0n;
  const gasPrice = (quoted * 12n) / 10n;
  const opts = { gasLimit: 3_000_000, gasPrice };

  const f = await ethers.getContractFactory("AtomicityProbe", signer);
  const probe = await f.deploy(opts);
  await probe.waitForDeployment();
  const probeAddr = await probe.getAddress();
  const token = await ethers.getContractAt("IERC20Like", TOKEN, signer);

  await (await (probe as any).associateWith(TOKEN, opts)).wait();
  await (await token.transfer(probeAddr, SEED, opts)).wait();
  const seeded = await token.balanceOf(probeAddr);
  note("setup", { probe: probeAddr, probeCash: seeded.toString() });
  if (seeded !== SEED) { note("ABORT", { why: "seeding failed" }); return; }

  // C1. The cash leg alone must move, or "it did not move" below is vacuous.
  const b0 = await token.balanceOf(probeAddr);
  await (await (probe as any).moveThenSucceed(TOKEN, me, CASH, opts)).wait();
  const b1 = await token.balanceOf(probeAddr);
  note("C1_cash_alone", { moved: (b0 - b1).toString(), pass: b0 - b1 === CASH });
  if (b0 - b1 !== CASH) { note("ABORT", { why: "cash control failed" }); return; }

  // The composite.
  const before = await token.balanceOf(probeAddr);
  let reverted = false, reason = "";
  try {
    await (await (probe as any).cashThenSecurity(TOKEN, me, CASH, BOND, UNITS, opts)).wait();
  } catch (e: any) {
    reverted = true;
    reason = (e.shortMessage ?? e.message ?? String(e)).slice(0, 140);
  }
  const after = await token.balanceOf(probeAddr);
  note("C_cash_then_failing_security", {
    txReverted: reverted, reason,
    cashBefore: before.toString(), cashAfter: after.toString(),
    cashMoved: (before - after).toString(),
    verdict: before === after
      ? "ATOMIC. The security leg failing rolled the cash leg back"
      : "NOT ATOMIC. Cash left the contract with no security delivered",
    predictionHeld: reverted && before === after,
  });
}

main().catch((e) => {
  console.error(JSON.stringify({ step: "FAILED", error: e.shortMessage ?? e.message ?? String(e) }));
  process.exit(1);
});
