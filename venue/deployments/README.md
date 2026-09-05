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
