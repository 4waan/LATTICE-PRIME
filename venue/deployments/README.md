# Talking to the deployed venue

Everything a client needs is in this directory. `296-venue.json` has the
addresses and the evidence they were read from; `296-kyc.json` has the
eligibility contracts, deployed a day earlier and unchanged since; `abi/` has one
ABI per contract, copied out of `out/` by `script/live/export-abis.sh` so a
client cannot compile against an interface the chain does not have.

## The network

| | |
|---|---|
| chain id | 296 (`0x128`) |
| JSON-RPC | `https://testnet.hashio.io/api` |
| mirror node | `https://testnet.mirrornode.hedera.com` |
| explorer | `https://hashscan.io/testnet` |

Accounts must be ECDSA secp256k1. An ED25519 Hedera key cannot sign an EVM
transaction, which is a property of the network and not of this venue.

## Read this before you display or send an amount

**Inside the EVM, one HBAR is `1e8`. Over JSON-RPC, one HBAR is `1e18`.**

Hedera's relay takes a transaction's `value` field in weibars, divides by 1e10,
and the EVM sees tinybars. So:

- Anything a contract returns or stores (`commitBond`, `credit(address)`, a
  buyer's escrow) is in **tinybars**. Format with 8 decimals.
- Anything you put in a transaction's `value` is in **weibars**. Multiply the
  tinybar figure by `1e10` on the way out.

`ethers.parseEther` and `formatEther` assume 18 decimals and are wrong for the
first case in both directions. Use `parseUnits(x, 8)` for contract-facing
amounts.

This is not a footnote. The venue was deployed once with `commitBond` set to
`0.01 ether`, which asked the EVM for a hundred million HBAR, and every `commit`
reverted `WrongBond`. `296-venue.json` records the superseded addresses.

Bond quantities are a separate matter and carry no decimals at all: the token
was issued with `decimals: 0`, so a balance of `1000` is a thousand units.

## The order of operations for a trade

1. **Be eligible.** `RegistrationGate.register(account, proof[24], pub[7])` after
   proving with `circuits/prove-live.mjs`. `register` is permissionless in
   `msg.sender`, so a relay can pay for it; the proof pins the registrant in
   public signal 4, which is what makes a lifted proof useless. Check with
   `ZkKycRegistry.getKycStatus(account)`, where `1` is granted.
2. **Hold the collateral.** The seller calls `createHoldByPartition` on the token
   with `escrow` set to the `MatchingEngine` and `to` left at the zero address.
   A hold naming a destination is refused at reveal, and so is one expiring
   inside the resting window.
3. **Commit.** `commitmentOf(committer, side, price, qty, salt)` gives the id;
   `commit(id)` with exactly `commitBond` as value. Keep the salt: without it
   the order cannot be revealed and the bond is forfeit.
4. **Reveal.** After `revealDelay` and before `revealDelay + revealWindow`. A
   sell passes its hold id as `backing`; a buy passes `0` and sends
   `price * qty` as value.
5. **Cross.** `crossRound(r)` once `roundEnd(r)` has passed. Permissionless.
   `quote(r)` says in advance whether it will cross and at what price.

Proceeds and refunds land in `credit(address)` rather than being pushed, so one
trader whose `receive` reverts cannot stop a settlement. Withdraw separately.

## What each address is

See `296-venue.json`. The short version: `MatchingEngine` is the venue,
`RepoVault` is the repo lifecycle, `SeamJournal` is what the ATS token calls on
every balance write, `ZkKycRegistry` is what it calls to decide whether an
address may hold at all, and `Regime`, `ParameterRoot`, `VolumeCap` and
`TradingHalt` are the policy the venue is held to rather than the policy it
writes.

The token is not ours. It is an Asset Tokenization Studio bond over the resolver
Hashgraph deployed, and a client should read balances from it directly with
`abi/IAtsToken.json`.

The coupon cash token is native HTS token `0.0.10419905`, exposed to the EVM at
`0x00000000000000000000000000000000009efec1`. It has two decimals and one
inclusive fractional fee of 25 basis points with a minimum of one smallest
unit. `CouponDistributor` publishes the same number through
`payingAgentFeeBps()`. `make client` checks the contract value against the live
HTS fee schedule and fails on drift.

## RepoVault v5 and its evidence

The client is bound to production
[RepoVault `0.0.10454144`](https://hashscan.io/testnet/contract/0.0.10454144)
and [MarginWatch `0.0.10454146`](https://hashscan.io/testnet/contract/0.0.10454146).
The vault answers `FINANCING_VERSION() == 5` and points to the existing LPRC
token, policy, KYC registry, fixed CouponSchedule, and compatible PrimeOracle.
Its deployment record also pins runtime hash
`0xec4ff4f7e69ff5e576bf0e41a502f0f3fe077b6ac7a7a6580bfac5782d51185b`.
The client generator compares that hash with live runtime code before writing
an address bundle. The vault started with a separate 20 HBAR operating reserve.
Every obligation remains manually settleable at or after its economic due time.

`financing-hss-canary.json` proves the current scheduling revision. A
one-LPRC, 300-second funded repo created ATS hold 44, moved 1,273.52970084 HBAR,
closed before maturity, released the hold, and drained both actor credits. HSS
schedule
[`0.0.10454245`](https://hashscan.io/testnet/transaction/0.0.7314364@1789020209.540687199)
expired at economic due plus two seconds and returned `SUCCESS`. Its EVM block
timestamp equalled economic due, the obligation became `SETTLED`, and the
five-HBAR reservation returned to zero. No manual `settle` receipt belongs to
this canary.

`financing-beat.json` remains historical boundary and fallback evidence for
superseded RepoVault `0.0.10452732`. Its exact-due HSS call reached consensus
while the EVM block timestamp was one second before maturity, so the strict
due-time guard reverted. The recorded permissionless `settle` fallback then
settled the obligation. The old contract remains callable and retains an
unreserved 19.9696972 HBAR because it has no operator reserve withdrawal path.
The deployment record does not describe that balance as migrated or deleted.

`financing-lifecycle.json` is intentionally not a client binding. It records a
separate compressed-clock testnet deployment and labels its five-minute cure
window, two-minute fail grace, and capital-bounded demo haircut. Two positions
cover margin call, additional collateral, cure, close, a nonzero coupon from a
historical fixing, maturity fail, CSDR Article 7 accrual, default, and execution
of 128 LPRC to the lender. Its two scheduler attempts decoded to
`UNFUNDED (-3)` and both obligations completed through `settle`.

The current credential epoch had already consumed its contract-address grant
quota when the new vault addresses became known. Each demonstrated vault therefore received
its ATS allowance through a temporary immutable `ApprovalWindowCompliance`
seat. That seat admitted only `(borrower, vault, 0)`, refused positive-value
transfers, and the original SeamJournal was restored immediately after the
approval. The deployment and restoration receipts are retained in both
the deployment and financing evidence.

Run `make financing-verify` to replay all 32 successful financing receipts and
eight contract identities through Mirror Node. It checks the current automatic
schedule hash, fee, block timing, ATS hold lifecycle, and final state alongside
the historical boundary and fallback, compressed-demo HSS reasons, coupon
commitment, and default-time ATS execution. The current record passes 362
Mirror Node assertions.
