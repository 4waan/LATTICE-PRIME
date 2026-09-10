# Pitching Lattice Prime

[Open the app](https://lattice-prime.vercel.app) · [Project README](../README.md)

## The sentence to remember

**Lattice Prime is a bond market on Hedera that can account for its silence.**

The app and README share the public headline: **Trade tokenised bonds. Shield your next move.** Follow it immediately with the product: an ATS secondary market, zero-knowledge eligibility, and a governed record of venue publication. Explain repo as financing against bond collateral on its first mention.

The receipt is the distinctive moment. Show one successful cancellation that publishes, then another that succeeds in silence after the publication budget is spent. Follow its transaction onto Hedera. An abstract disclosure lattice becomes a result someone can see and verify.

## What earlier winners make useful

These are patterns inferred from published project descriptions and official winner announcements, not claims about private judging deliberations or transcripts of videos we have not reviewed.

- **Kuma, ETHOnline 2024, Hedera Ecosystem Builder Bounty first place:** its explanation starts with the friction of wallet recovery and moves to a familiar biometric experience. The technical account follows the user benefit. Apply that ordering here: introduce trading and the receipt before PLONK, policy rows, and contract names. [Project and award](https://ethglobal.com/showcase/kuma-trh21).
- **Eros, ETHOnline 2024 finalist:** programmable privacy becomes a concrete dating interaction. Its submission also distinguishes the working prototype from intended additions. Apply both moves: make cancellation and withholding visible, then label financing deployment and Claw's release status accurately. [Project and finalist designation](https://ethglobal.com/showcase/eros-ob04t).
- **AuthWallet 2.5, ETHOnline 2024 finalist:** its description connects a familiar action, signing in, to the specific mechanism that removes an intermediary. Apply that causal structure: ATS checks eligibility, the auction settles, the meter constrains publication, and HCS lets someone else check the record. [Project and finalist designation](https://ethglobal.com/showcase/authwallet-2-5-1i9gq).
- **Whisper Transactions, ETHOnline 2024, Hedera EVM Starter Bounty:** this is relevant prior art for ZK privacy on Hedera. Its submission states the privacy level demonstrated. Avoid claiming to be the first privacy project on Hedera; focus on this project's combination of an ATS market and disclosure accounting. [Project and bounty](https://ethglobal.com/showcase/whisper-transactions-ui8pq).
- **KeyRing and VeriCycle, Hello Future Ascension winners:** the official descriptions connect a user problem to a concrete workflow and name the Hedera infrastructure underneath. VeriCycle connects payments and HCS records to a usable proof of income; KeyRing makes accountability visible in a dashboard. Apply the same structure to the Issuer screen and disclosure receipt. Their projected adoption figures are not evidence for ours. [Official Ascension winners](https://hedera.com/blog/these-are-the-winners-of-the-hello-future-ascension-hackathon/).

The useful common structure is **problem → user action → visible result → mechanism → evidence → next step**. Attractive presentation makes that sequence easier to follow; it cannot substitute for a working result.

## Shape the pitch for this event

The current [ETHOnline 2026 Hedera Tokenization of Anything brief](https://ethglobal.com/events/ethonline2026/prizes/hedera) is the primary fit. It asks for ATS usage, a testnet demonstration, a public repository, applicable contract verification, and a short lifecycle demo. Its examples and extra-credit areas closely match the project: repo collateral, secondary markets, compliance, distributions, pricing, and scheduled operations.

The workspace's `JUDGING-CRITERIA.md` is an **internal adaptation** of Hedera's broader rubric. It weights Innovation 10%, Feasibility 13%, Execution 23%, Integration 18%, Success 23%, and Pitch 13%, after removing Validation. Use it to prioritise the narrative; do not present those redistributed percentages as official ETHOnline scoring. The [broader Hello Future rubric](https://hackathon.stackup.dev/web/events/hedera-hello-future-apex-hackathon-2026-the-finale) includes Validation separately.

Give the priorities visible evidence:

- **Innovation:** the two-cancellation receipt and its precise publication boundary.
- **Feasibility:** a real ATS test asset, one coherent market workflow, and an issuer-first pilot plan. Operator monetisation remains unresolved.
- **Execution:** open the deployed screens and follow recorded transactions. Distinguish a contract being deployed from its lifecycle being demonstrated.
- **Integration:** explain the different jobs of ATS, EVM contracts, HTS coupon cash, HCS, HSS, and the exchange-rate adapter.
- **Success:** show why an issued bond produces recurring activity through renewals, trading, servicing, and verification. Describe accounts and transaction categories; do not invent adoption or TPS.
- **Pitch:** use the same product name, headline, navigation labels, and primary URL in the README, app, and recording.

Claw's proof experiment is optional supporting evidence. It does not establish qualification for the AI payment bounty, which has a specific paid-service requirement. Keep the main narrative centred on tokenisation.

## A 3 minute 45 second recording

**0:00 to 0:20. The product.** Open the homepage. “Tokenising a bond is only the beginning. Lattice Prime gives it a market, checks who can hold it, and accounts for what the venue publishes.” Enter Markets immediately.

**0:20 to 0:45. The asset.** Show LPRC and its ATS deployment. Use the recorded issuance/configuration evidence and an actual transfer or eligibility check. Establish the asset lifecycle before introducing the privacy mechanism.

**0:45 to 1:15. Eligibility and entry.** Connect the matching wallet and click
“Confirm private access” once. Show the automatic account-bound proof lookup,
policy preflight, sponsored registration, and resulting grant. Explain that
credential attributes remain private while the account grant is public. Open
technical details only long enough to distinguish the policy preflight from
full proof verification, then show the sealed ticket and its reveal clock.

**1:15 to 2:15. The receipt.** Show the two recorded cancellations. Both succeed, both credit the refund, but only the first publishes a venue event. Read back the budget and withheld event. Make this the longest beat.

**2:15 to 2:45. Independent evidence.** Open the Issuer HCS panel and HashScan. Explain that the relay publishes a claim and the verifier checks it against chain evidence. State the public-ledger boundary in one sentence.

**2:45 to 3:20. Lifecycle and Hedera.** Open Financing's verified-run section. Show the bound vault's compressed funded canary, ATS hold and release, then follow its successful automatic HSS receipt. Say that HSS runs two seconds after the unchanged economic due time and that the permissionless fallback remains strict. Show the previous vault's one-second boundary and fallback only as historical evidence. Then show the separately labelled route through margin, cure, coupon, fail penalty, default, and collateral execution. Give ATS, EVM, HTS, HCS, HSS, and the exchange-rate adapter one purpose each. Do not imply that the 300-second canary, five-minute cure, or two-minute fail grace is production configuration.

**3:20 to 3:45. The next user and the close.** Name the intended first pilot: one ATS issuer and eligible counterparties. End on the app URL and “Trade the bond. Check the rules. Read the receipt.”

The auction round is 300 seconds and the recorded repo lifecycle spans nearly nineteen minutes, so neither complete fresh path fits inside this recording. Use the clearly labelled recorded transactions and read their state back. Do not make edited waits look instantaneous. Check the current proof epoch and deployment addresses before recording.

## Claims to keep precise

Sealed **until reveal**. Eligibility attributes **inside the proof**. Publication budgets **over specified venue events**. Settlement and ledger state **public**. Coupon cash **HTS**; the bond **ATS**; trading cash **HBAR**. Scheduling **capacity-dependent with a manual fallback**. The current vault schedules HSS two seconds after economic due; its funded canary returned `SUCCESS` in an EVM block at economic due without a manual fallback receipt. The previous exact-due vault hit the recorded one-second clock boundary and settled through the fallback. Keep those current and historical claims distinct. Claw **a preview**. Commercial model **proposed, not validated**.

The README is the product's front door; this guide is the preparation behind it. Neither should invent users, revenue, awards, partnerships, full-chain privacy, or completed deployments.
