# Publishing the disclosure stream to a consensus topic

**Built. Topic 0.0.10397186 on chain 296, and `docs/HCS.md` is what shipped.**
Read that for the record's shape, the verifier's assertions, and the three places
the build is deliberately narrower than this scope. This document is kept as
written, because the value of a scope is that it can be checked against the
thing, and two of its estimates turned out to be wrong in ways worth seeing.

Corrections, in one place:

- **Two disclosing contracts, not four.** `AxeBoard` is not deployed and
  `SeamJournal` carries its own meter with a different key and its own explicit
  withheld event, so neither is on the topic. `MatchingEngine` and `RepoVault`
  are.
- **Silence detection needed a fourth condition nobody wrote down.**
  `budgetFor(row)` reads current state, and the venue's first parameter set
  metered nothing. Judging a call from epoch 4 against today's budget would have
  printed a false silence for every one of them. Both halves now read
  `ParameterRoot`'s `Adopted` history and refuse to judge before the epoch the
  set in force took effect. The relay found this by stopping rather than by
  publishing.
- **Checkpoints are not one per epoch unconditionally.** One per epoch that
  carried a record, plus the latest closed one.

A scope, not an implementation. It says what can be built, what cannot, what it
is worth, and what it costs. The finding that shapes all of it is in the first
section and it is the opposite of what the obvious search returns.

## What a contract on Hedera can do with HCS, which is nothing

There is no consensus service system contract. A contract in the Hedera EVM
cannot create a topic, cannot submit a message to one, and cannot read one.

That was checked rather than assumed, on chain 296:

| Address | `eth_getCode` |
|---|---|
| `0x167` HTS | 1 byte, the system contract marker |
| `0x168` exchange rate | no code |
| `0x169` PRNG | no code |
| `0x16a` account service | no code |
| `0x16b` schedule service | no code |
| `0x16c` | no code |

Only the token service answers. There is no address a consensus service system
contract would live at, because there is not one.

The proposal that covers this is [HIP-478, Interoperability Between Smart
Contracts and HCS](https://github.com/hiero-ledger/hiero-improvement-proposals/blob/main/HIP/hip-478.md).
Its status is `Active`, and the important field is `category: Application`,
with `needs-council-approval: No`. It is not a network change. Its abstract
proposes the opposite of a system contract:

> Enable Smart Contracts and Hedera Consensus Services to interoperate by having
> an oracle network talk to both services.

So the relay is not a workaround for a missing feature. **The relay is the
specified pattern**, and it is an accepted, Active HIP that can be cited by
number. That is a better position than the one this scope started in, and it is
worth saying out loud in the video, because a judge who knows Hedera will be
waiting to see whether we claim a native path that does not exist.

`HIP-1195` hooks, which would eventually change this, are approved by the TSC
but [not available on the public
network](https://hedera.com/blog/introducing-hooks-programmable-customization-for-hedera-entities/).
Same class of claim as HIP-1535. Do not lean on it.

## Why this needs no Solidity and no redeployment

`DisclosureMeter.DisclosureCharged` already carries every field a receipt needs:

```solidity
event DisclosureCharged(
    uint16 indexed row, uint64 indexed epoch, uint8 granularity, uint32 cost, uint32 spentAfter
);
```

Row, epoch, level, cost, and the running total after the charge.
`DisclosureView.DisclosureRefused(bytes32 id, uint16 row, uint32 excess)` covers
the ceiling breach. Between them there is nothing left to add.

**No contract changes. No redeployment.** That matters more here than it
usually would. `deployments/client.json` carries a `superseded` block from the
last time this venue redeployed, along with a stranded hold on the bond that
still names the old engine as escrow. A feature that costs a redeployment is not
a feature, it is a second superseded block.

## What the topic adds that the chain does not already have

The honest version, because three of the obvious answers are wrong.

It is not that the data is unavailable. Every charge is a log, and
`spentBits(row, epoch)` is a mapping that persists, so a past epoch is still
readable. It is not that the chain is unordered. And it is not that a
supervisor cannot reconstruct this, because they can.

What the topic adds is one thing, and it is the thing this venue is about.

**The stream can carry the silences.** `DisclosureView` says this in its own
comment, twice, as a known limit of the design:

> The read that makes withholding visible: a row silenced by an exhausted budget
> and a row nobody disclosed on are identical in the event stream.

Rule A withholds the event and lets the transaction succeed. So a withheld
disclosure is, in the log, indistinguishable from nothing having happened. The
venue's answer today is a view, `spentBits`, and a page that reads it. That
works for a person looking now. It does not produce a record.

A relay reading contract *results* rather than only logs can tell the
difference. A call to `cancel` that succeeded and emitted no `Cancelled` and no
`DisclosureCharged` is a silence, and it is visible in the results feed as a
transaction with a known selector, status 1, and no logs. The relay can publish
a positive record of it:

```json
{"v":1,"k":"silence","tx":"0x...","sel":"cancel","r":15,"e":5962107,"spent":1,"budget":1}
```

That message is the venue saying, on an ordered public stream, **"I acted, and I
deliberately told you nothing, and here is the row and the budget that made me
stop."** Nothing in the current design produces that sentence. It is the whole
thesis in one record, and it is the strongest single artifact this project could
put in front of a judge.

Two smaller things come with it, worth having but not worth claiming loudly. A
topic spans redeployments, which this venue has already needed once. And a
supervisor subscribes to one stream instead of polling four contracts' logs and
interleaving them by timestamp.

## The design

**One topic**, memo `seamme venue chain 296 disclosure receipts`, submit key
held by the venue operator so the stream cannot be polluted by third parties.
Anyone may read it. A second topic per row was considered and rejected: the
ordering guarantee across rows is most of the value.

**One message per record, always one chunk.** The HCS single-chunk limit is
1024 bytes. Staying under it means every record gets exactly one consensus
timestamp and one sequence number, which is what makes a receipt citable.
Chunked messages would put one logical record under several sequence numbers.
The schema below is roughly 180 bytes, so there is a lot of headroom, and the
verifier should assert the limit rather than trust it.

**Four record kinds.**

| `k` | when | carries |
|---|---|---|
| `charge` | a `DisclosureCharged` log | `tx`, `li`, `c`, `r`, `e`, `g`, `cost`, `spentAfter` |
| `refusal` | a `DisclosureRefused` log | `tx`, `c`, `r`, `excess` |
| `silence` | a disclosing call with status 1 and no charge | `tx`, `sel`, `r`, `e`, `spent`, `budget` |
| `checkpoint` | once per disclosure epoch | `e`, `rows` as `{row: spentBits}`, `blk` |

Rows run 3 to 17, so a checkpoint over every row is about 150 bytes.

**The relay** is `tools/hcs-relay.mjs`. It polls the mirror node's
`/api/v1/contracts/{addr}/results/logs` and `/results` for the four disclosing
contracts, which return consensus-ordered records and a resumable cursor as
`timestamp=gt:` plus `index=gt:`. It keeps that cursor in
`deployments/hcs-cursor.json` so a restart does not double-publish, and every
message carries `tx` and `li` so a consumer can dedupe regardless.

**The verifier** is `tools/hcs-verify.mjs`, and it is the piece that makes this
evidence instead of decoration. It reads the topic back from
`/api/v1/topics/{id}/messages`, and for each record independently checks it
against the chain:

- a `charge` must match the log at that `tx` and `li`, field for field
- a `silence` must name a transaction that succeeded and emitted no charge
- per epoch and row, the summed `cost` of charges must equal `spentBits(row, epoch)`
- every message must be one chunk

It prints a pass or fail table and exits non-zero on a mismatch, in the shape
`script/live/receipt-beat.sh` already uses. That last check is the one that
matters: **it makes the relay unable to lie.** The meter audits the stream.

## What the operator is trusted for, and what it is not

State this plainly rather than letting a judge find it.

The relay **cannot forge**. Every `charge` and `refusal` names a transaction
hash and log index, and the verifier fetches that log from the mirror node and
compares. An invented record fails.

The relay **cannot silently omit**. The per-epoch sum of published charges must
equal `spentBits(row, epoch)` read from the chain. Dropping a charge breaks the
arithmetic against a number the relay does not control.

The relay **can stall**. Nothing forces liveness. If the operator turns it off,
the topic stops, and the gap is obvious in the sequence numbers and the
checkpoint series but cannot be prevented. That is inherent to HIP-478 and to
every oracle pattern, and the correct response is to say so, not to pretend the
checkpoint fixes it.

## What it is worth

Against the Hedera rubric, honestly weighted.

**Integration, 15%.** This is the real gain. The venue currently uses the EVM
and the mirror node and nothing else. One more first-party Hedera service, used
for something the EVM genuinely cannot do, is the difference between "deployed
on Hedera" and "uses Hedera." Citing HIP-478 by number and status shows the
choice was researched rather than defaulted into.

**Success, 20%.** Message count is a usage metric that accumulates without a
human in the loop, and it is visible on HashScan without our app.

**Innovation, 10%.** The silence record is the novel part. Everything else here
is competent plumbing.

Not Validation. This does not talk to a user, and Validation stays the gap.

## Work

| | hours |
|---|---|
| Topic creation script, operator account id resolved from the EVM address via mirror node | 1.5 |
| Relay: poll, decode, submit, cursor, 429 backoff | 4 |
| Silence detection from the results feed | 2 |
| Checkpoint per epoch | 1.5 |
| Verifier and its assertion table | 3 |
| Receipt page shows sequence number and consensus timestamp, links to HashScan | 2 |
| NOTICE, docs, demo beat | 1.5 |
| Live run on testnet and the debugging it will actually need | 3 |
| | **~18** |

Seven days remain before the deadline at 2026-09-13 12:00 EDT. Eighteen hours
fits, provided it starts before the video is cut, because the topic wants
history in it when the recording happens.

**The one new dependency is the Hedera SDK**, needed to sign a native
`TopicMessageSubmitTransaction`. It is Apache 2.0 and must go in NOTICE. It
lands in `tools/` only. The six built pages stay dependency-free and the page
build does not touch it, which is the property worth protecting.

Cost: $0.01 to create the topic, $0.0008 per message. This scope was first
written against the pre-2026 figure of $0.0001; `ConsensusSubmitMessage` has
been $0.0008 since the January 2026 mainnet upgrade, and the cadence arithmetic
that follows from the corrected fee is in `docs/HCS.md`.

## Risks

**The relay must be running when the demo is recorded.** Mitigate by running it
well before, so the topic has history and the demo shows a live message landing
on top of a real stream rather than the first message ever.

**Mirror node lag.** Records appear a few seconds after consensus. The demo beat
must allow for that, the way `receipt-beat.sh` already allows for window timing.

**Silence detection is selector-based** and needs the disclosing entry points
enumerated. There are 23 `_emitUnder` call sites across `OrderBook`, `AxeBoard`
and `RepoVault`, plus `SeamJournal`'s own meter. Getting the list wrong means a
missed silence, not a false one, so it fails safe.

## Out of scope

Reading the topic from a contract, which is impossible. Any claim that HCS
orders the trades themselves, which it does not, since the matching engine is
the EVM and the topic is downstream of it. Replacing the receipt page, which
reads live state and should keep doing so.
