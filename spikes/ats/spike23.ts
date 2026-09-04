// SPDX-License-Identifier: Apache-2.0
//
// Spikes 2 and 3, run as one session against the ATS team's shipped testnet
// deployment. Throwaway: this file lives in the vendored clone and is not ours
// to commit. The writeup lives in ../../../../../spikes/ats/README.md.
//
// Run:
//   HEDERA_TESTNET_PRIVATE_KEY_0="$(cat ~/.hedera-testnet-key)" \
//   npx hardhat run --network hedera-testnet scripts/spike/spike23.ts

import { ethers } from "hardhat";

// From deployments/hedera-testnet/newBlr-2026-06-12T11-19-42-198.json.
// Confirmed live and permissionless: measured separately.
const FACTORY = "0xd1F118A40f3b02883D35909eF2517e7EDd78379d";
const RESOLVER = "0xBA2D5FC2083A0b8f164c50e65d782087fBA18E0a";
const BOND_CONFIG_ID = "0x0000000000000000000000000000000000000000000000000000000000000002";

const ROLE_DEFAULT_ADMIN = "0x0000000000000000000000000000000000000000000000000000000000000000";
const ROLE_ISSUER = "0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f";
const ROLE_KYC_MANAGER = "0xec811504e835acf29535b5b62307b08000468f0c61ca6163ed6f17a03629b91e";
const ROLE_CONTROL_LIST_MANAGER = "0xccf29bda8369877bcc921e38f30df86156a571ca5c5b8e777bf7ff75270313ea";

// A real UK gilt ISIN. Checked against the ISO 6166 checksum the factory
// enforces in isinValidator.sol before spending anything.
const ISIN = "GB0004893086";

// Never funded, never signs. It only needs to receive, and receiving is what
// the KYC seam gates.
const COUNTERPARTY = "0x000000000000000000000000000000000000dEaD";

const log: Record<string, unknown>[] = [];

function note(step: string, fields: Record<string, unknown>) {
  const row = { step...fields };
  log.push(row);
  console.log(JSON.stringify(row));
}

async function main() {
  const [signer] = await ethers.getSigners();
  const provider = signer.provider!;
  const me = await signer.getAddress();

  const bal = await provider.getBalance(me);
  const quoted = (await provider.getFeeData()).gasPrice ?? 0n;
  // ATS's own scripts pair an explicit gasLimit with an explicit gasPrice to
  // skip eth_estimateGas on Hedera (constants.ts:183). Their 1.2x multiplier.
  const gasPrice = (quoted * 12n) / 10n;

  note("env", {
    signer: me,
    balanceHbar: Number(bal / 10n ** 14n) / 10000,
    quotedTinybar: Number(quoted / 10n ** 10n),
    bidTinybar: Number(gasPrice / 10n ** 10n),
  });

  const factory = await ethers.getContractAt("Factory", FACTORY, signer);

  // ---------------------------------------------------------------- step 2
  // One bond through the shipped factory. internalKycActivated is false, so
  // KYC collapses to the external seam alone (an earlier measurement). The three roles are
  // named here because the factory renounces DEFAULT_ADMIN on the way out
  // (F-10) and addExternalKycList is onlyRole(ROLE_KYC_MANAGER).
  const now = Math.floor(Date.now() / 1000);
  const securityData = {
    resolver: RESOLVER,
    maxSupply: 1_000_000n,
    resolverProxyConfiguration: { key: BOND_CONFIG_ID, version: 1 },
    erc20MetadataInfo: { name: "Spike Gilt 2027", symbol: "SPKG", isin: ISIN, decimals: 2 },
    rbacs: [
      { role: ROLE_DEFAULT_ADMIN, members: [me] },
      { role: ROLE_ISSUER, members: [me] },
      { role: ROLE_KYC_MANAGER, members: [me] },
      { role: ROLE_CONTROL_LIST_MANAGER, members: [me] },
    ],
    externalPauses: [],
    externalControlLists: [],
    externalKycLists: [],
    compliance: ethers.ZeroAddress,
    identityRegistry: ethers.ZeroAddress,
    arePartitionsProtected: false,
    isMultiPartition: false,
    isControllable: true,
    isWhiteList: false,
    clearingActive: false,
    internalKycActivated: false,
    erc20VotesActivated: false,
  };

  const bondData = {
    security: securityData,
    bondDetails: {
      currency: "0x474250", // "GBP"
      nominalValue: 100n,
      nominalValueDecimals: 2,
      startingDate: now + 60,
      maturityDate: now + 365 * 24 * 3600,
    },
    proceedRecipients: [],
    proceedRecipientsData: [],
  };

  const regulationData = {
    regulationType: 1, // REG_S
    regulationSubType: 0, // NONE
    additionalSecurityData: { countriesControlListType: true, listOfCountries: "", info: "" },
  };

  const tx = await factory.deployBond(bondData, regulationData, { gasLimit: 10_000_000, gasPrice });
  const rc = await tx.wait();
  const ev = rc!.logs.find((l: any) => l.fragment?.name === "BondDeployed") as any;
  const bond: string = ev.args[1];
  note("deployBond", { hash: tx.hash, gasUsed: rc!.gasUsed.toString(), bond });

  // ---------------------------------------------------------------- step 3
  const mint = await ethers.getContractAt("IMint", bond, signer);
  const transfer = await ethers.getContractAt("ITransfer", bond, signer);

  let r = await (await mint.mint(me, 1000n, { gasLimit: 3_000_000, gasPrice })).wait();
  note("mint", { gasUsed: r!.gasUsed.toString(), to: me, amount: 1000 });

  // Baseline: no external list registered, so isExternallyGranted over an
  // empty list is GRANTED and the transfer must go through.
  r = await (await transfer.transfer(COUNTERPARTY, 10n, { gasLimit: 3_000_000, gasPrice })).wait();
  note("transfer_before_seam", { gasUsed: r!.gasUsed.toString(), expected: "success", got: "success" });

  // Register a trivial IExternalKycList. This 26 line contract is the product
  // skeleton with the privacy removed: our ZK-KYC contract is the same shape
  // with getKycStatus reading a nullifier registry.
  const mockFactory = await ethers.getContractFactory("MockedExternalKycList", signer);
  const mock = await mockFactory.deploy({ gasLimit: 3_000_000, gasPrice });
  await mock.waitForDeployment();
  const mockAddr = await mock.getAddress();
  note("deploy_kyc_list", { address: mockAddr });

  const kycMgmt = await ethers.getContractAt("IExternalKycListManagement", bond, signer);
  r = await (await kycMgmt.addExternalKycList(mockAddr, { gasLimit: 3_000_000, gasPrice })).wait();
  note("register_kyc_list", { gasUsed: r!.gasUsed.toString() });

  // Now the seam answers NOT_GRANTED for everyone, so the same transfer must
  // fail. Report (ran, ok) rather than collapsing a transport failure into a
  // result: an earlier measurement and an earlier measurement discipline.
  let blocked = false;
  let reason = "";
  try {
    await transfer.transfer.staticCall(COUNTERPARTY, 10n);
  } catch (e: any) {
    blocked = true;
    reason = e.shortMessage ?? e.message ?? String(e);
  }
  note("transfer_with_seam_denying", { expected: "revert", blocked, reason: reason.slice(0, 160) });

  // Flip the seam to GRANTED for both sides and the same call must succeed.
  r = await (await (mock as any).grantKyc(me, { gasLimit: 3_000_000, gasPrice })).wait();
  note("grant_kyc_sender", { gasUsed: r!.gasUsed.toString() });
  r = await (await (mock as any).grantKyc(COUNTERPARTY, { gasLimit: 3_000_000, gasPrice })).wait();
  note("grant_kyc_receiver", { gasUsed: r!.gasUsed.toString() });

  r = await (await transfer.transfer(COUNTERPARTY, 10n, { gasLimit: 3_000_000, gasPrice })).wait();
  note("transfer_after_grant", { gasUsed: r!.gasUsed.toString(), expected: "success", got: "success" });

  const spent = bal - (await provider.getBalance(me));
  note("done", { bond, kycList: mockAddr, hbarSpent: Number(spent / 10n ** 14n) / 10000 });
}

main().catch((e) => {
  console.error(JSON.stringify({ step: "FAILED", error: e.shortMessage ?? e.message ?? String(e) }));
  process.exit(1);
});
