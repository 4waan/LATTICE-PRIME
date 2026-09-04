// SPDX-License-Identifier: Apache-2.0
//
// a design decision step 2: is an HTS token transfer rolled back by an EVM revert in the
// same transaction.
//
// a design decision settled "mint our own cash leg as HTS" carrying hole H4: the security is
// an EVM diamond, the cash is an HTS token, and atomic DvP means both legs
// settle or neither does. If they do not share a rollback boundary then
// "atomic DvP" comes out of the README rather than being softened.
//
// Requires the token from mint-cash.js.
//
// Run:
//   HEDERA_TESTNET_PRIVATE_KEY_0="$(cat ~/.hedera-testnet-key)" \
//   npx hardhat run --network hedera-testnet scripts/spike/d02-atomicity.ts

import { ethers } from "hardhat";

const TOKEN = "0x00000000000000000000000000000000009d7df9"; // 0.0.10321401, GBPX
const SEED = 10000n;   // 100.00 units moved into the probe
const MOVE = 100n;     // 1.00 unit per arm

function note(step: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ step...fields }));
}

async function main() {
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  const quoted = (await signer.provider!.getFeeData()).gasPrice ?? 0n;
  const gasPrice = (quoted * 12n) / 10n;
  const opts = { gasLimit: 3_000_000, gasPrice };

  const probeFactory = await ethers.getContractFactory("AtomicityProbe", signer);
  const probe = await probeFactory.deploy(opts);
  await probe.waitForDeployment();
  const probeAddr = await probe.getAddress();
  note("deploy", { probe: probeAddr, signer: me });

  const token = await ethers.getContractAt("IERC20Like", TOKEN, signer);

  // The probe cannot hold an HTS token until it is associated.
  await (await (probe as any).associateWith(TOKEN, opts)).wait();
  note("associate", { ok: true });

  await (await token.transfer(probeAddr, SEED, opts)).wait();
  const seeded = await token.balanceOf(probeAddr);
  note("seed", { probeBalance: seeded.toString(), expected: SEED.toString() });
  if (seeded !== SEED) { note("ABORT", { why: "seeding failed, no arm below is interpretable" }); return; }

  // ---- CONTROL. The same HTS transfer with no revert after it. If this does
  // not move the balance then "the balance did not move" in arm 2 is worthless.
  const before1 = await token.balanceOf(probeAddr);
  await (await (probe as any).moveThenSucceed(TOKEN, me, MOVE, opts)).wait();
  const after1 = await token.balanceOf(probeAddr);
  const controlMoved = before1 - after1 === MOVE;
  note("C1_move_then_succeed", {
    before: before1.toString(), after: after1.toString(),
    moved: (before1 - after1).toString(),
    pass: controlMoved, expected: "moved by " + MOVE,
  });
  if (!controlMoved) { note("ABORT", { why: "control did not move the balance" }); return; }

  // ---- MEASUREMENT. Same transfer, then revert.
  const before2 = await token.balanceOf(probeAddr);
  let reverted = false, reason = "";
  try {
    const t = await (probe as any).moveThenRevert(TOKEN, me, MOVE, opts);
    await t.wait();
  } catch (e: any) {
    reverted = true;
    reason = (e.shortMessage ?? e.message ?? String(e)).slice(0, 120);
  }
  const after2 = await token.balanceOf(probeAddr);
  note("A_move_then_revert", {
    txReverted: reverted, reason,
    before: before2.toString(), after: after2.toString(),
    moved: (before2 - after2).toString(),
    verdict: before2 === after2 ? "ATOMIC, HTS rolled back with the EVM"
                                : "NOT ATOMIC, HTS kept the transfer",
  });

  // ---- The sharper case: revert inside a frame the caller swallows.
  const before3 = await token.balanceOf(probeAddr);
  let caught: unknown = null, outerReverted = false;
  try {
    const t = await (probe as any).moveThenRevertCaught(TOKEN, me, MOVE, opts);
    await t.wait();
    caught = await (probe as any).moveThenRevertCaught.staticCall(TOKEN, me, MOVE);
  } catch (e: any) {
    outerReverted = true;
    caught = (e.shortMessage ?? e.message ?? String(e)).slice(0, 120);
  }
  const after3 = await token.balanceOf(probeAddr);
  note("B_revert_caught_by_caller", {
    outerReverted, innerCaught: String(caught),
    before: before3.toString(), after: after3.toString(),
    moved: (before3 - after3).toString(),
    verdict: before3 === after3 ? "inner frame rolled back, caller saw the catch"
                                : "BALANCE MOVED while the caller reported success",
  });

  note("done", { probe: probeAddr, token: TOKEN, finalProbeBalance: after3.toString() });
}

main().catch((e) => {
  console.error(JSON.stringify({ step: "FAILED", error: e.shortMessage ?? e.message ?? String(e) }));
  process.exit(1);
});
