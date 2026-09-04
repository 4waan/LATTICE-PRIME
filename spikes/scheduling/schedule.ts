// SPDX-License-Identifier: Apache-2.0
//
// Spike 4: schedule a transaction from a contract and let it fire.
// Closes the "pending spike 4" qualification on a design decision.
//
// Run:
//   HEDERA_TESTNET_PRIVATE_KEY_0="$(cat ~/.hedera-testnet-key)" \
//   npx hardhat run --network hedera-testnet scripts/spike/schedule.ts

import { ethers } from "hardhat";

const DELAY = 90;          // seconds until the scheduled call should fire
const SCHED_GAS = 200_000; // gas budget for the scheduled call itself
const WAIT = 210;          // how long to keep watching after the expiry passes

function note(step: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ step...fields }));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [signer] = await ethers.getSigners();
  const provider = signer.provider!;
  const quoted = (await provider.getFeeData()).gasPrice ?? 0n;
  const gasPrice = (quoted * 12n) / 10n;
  const opts = { gasLimit: 3_000_000, gasPrice };

  const f = await ethers.getContractFactory("ScheduleProbe", signer);
  const probe = await f.deploy(opts);
  await probe.waitForDeployment();
  const addr = await probe.getAddress();
  const p = probe as any;
  note("deploy", { probe: addr });

  // The scheduled call pays from the contract, so the contract needs a balance.
  await (await signer.sendTransaction({ to: addr, value: ethers.parseEther("5")...opts })).wait();
  note("fund", { hbar: 5, contractBalance: (await provider.getBalance(addr)).toString() });

  // ---- C1. Call the target directly. If the counter does not move here, then
  // "the counter moved" later would not be evidence that anything fired.
  const c0 = await p.counter();
  await (await p.bump(opts)).wait();
  const c1 = await p.counter();
  note("C1_direct_bump", {
    before: c0.toString(), after: c1.toString(),
    pass: c1 - c0 === 1n, expected: "counter increments by 1",
  });
  if (c1 - c0 !== 1n) { note("ABORT", { why: "target is not observable" }); return; }

  // ---- Schedule it.
  const baseline = await p.counter();
  let rc: string, scheduleAddress: string;
  try {
    const sim = await p.scheduleBump.staticCall(DELAY, SCHED_GAS);
    rc = sim[0].toString();
    scheduleAddress = sim[1];
  } catch (e: any) {
    note("FAILED_at_schedule", { error: (e.shortMessage ?? e.message ?? String(e)).slice(0, 200) });
    return;
  }
  const tx = await p.scheduleBump(DELAY, SCHED_GAS, opts);
  const receipt = await tx.wait();
  const scheduledFor = Math.floor(Date.now() / 1000) + DELAY;
  note("schedule", {
    hash: tx.hash, gasUsed: receipt!.gasUsed.toString(),
    responseCodeFromStaticCall: rc, scheduleAddressFromStaticCall: scheduleAddress,
    note: "22 is SUCCESS in the Hedera response code table",
  });

  // ---- C2. Nothing may have fired yet. If the counter has already moved, the
  // call executed inline and this spike proves nothing about scheduling.
  const c2 = await p.counter();
  note("C2_not_yet", {
    counter: c2.toString(), baseline: baseline.toString(),
    pass: c2 === baseline, expected: "unchanged, the expiry has not passed",
  });

  // ---- Watch.
  const deadline = Date.now() + WAIT * 1000;
  let fired = false;
  while (Date.now() < deadline) {
    await sleep(10_000);
    const c = await p.counter();
    const left = Math.round((deadline - Date.now()) / 1000);
    if (c > baseline) {
      fired = true;
      note("FIRED", {
        counter: c.toString(),
        firedAt: (await p.firedAt()).toString(),
        scheduledFor,
        lastCaller: await p.lastCaller(),
        probe: addr,
      });
      break;
    }
    note("waiting", { counter: c.toString(), secondsLeft: left });
  }

  note("result", {
    fired,
    verdict: fired
      ? "PASS. A contract scheduled a call and it executed with no keeper."
      : "NOT OBSERVED within the window. Not the same as a failure, see the writeup.",
    contractBalanceAfter: (await provider.getBalance(addr)).toString(),
  });
}

main().catch((e) => {
  console.error(JSON.stringify({ step: "FAILED", error: e.shortMessage ?? e.message ?? String(e) }));
  process.exit(1);
});
