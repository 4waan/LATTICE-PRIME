# The disclosure record, on a consensus topic

`HCS-SCOPE.md` is the argument for building this. This is what was built, what it
publishes, what checks it, and the three places it is deliberately narrower than
the scope said.

Topic **0.0.10397186** on chain 296, memo `seamme venue chain 296 disclosure
receipts`.

## The finding that shapes it, restated because it is the whole design

There is no consensus service system contract. `eth_getCode` answers for `0x167`
and for nothing else, so a contract in the Hedera EVM cannot create a topic,
cannot submit to one, and cannot read one. That was checked rather than assumed
and the table is in `HCS-SCOPE.md`.

[HIP-478](https://github.com/hiero-ledger/hiero-improvement-proposals/blob/main/HIP/hip-478.md)
is `Active`, `category: Application`, `needs-council-approval: No`, and its
abstract proposes an oracle between the two services rather than a precompile.
So `tools/hcs-relay.mjs` is the specified pattern and not a workaround. Say that
out loud, with the HIP number, because a judge who knows Hedera will be waiting
to see whether the project claims a native path that does not exist.

## What is on the topic

Five record kinds the relay writes today, one message each, always one chunk,
plus one legacy kind the decoder still reads. `tools/hcs.mjs` is the grammar and
`tools/hcs.test.mjs` holds it to the deployed ABIs.

| `k` | when | carries |
|---|---|---|
| `charge` | a `DisclosureCharged` log | `c`, `a`, `tx`, `li`, `r`, `e`, `g`, `cost`, `after` |
| `ceiling` | a disclosing call that reverted with `DisclosureExceedsCeiling` | `c`, `a`, `tx`, `sel`, `fn`, `r`, `x` |
| `silence` | a disclosing call that succeeded and said nothing on a metered row | `c`, `a`, `tx`, `sel`, `fn`, `r`, `e`, `spent`, `budget` |
| `checkpoint` | a closed epoch that carried a record | `c`, `a`, `e`, `blk`, `rows` |
| `anchor` | an hour of closed epochs, every `spentBits` cell hashed into one word | `c`, `a`, `from`, `to`, `blk`, `rows`, `h` |
| `refusal` | schema 1 only: a `DisclosureRefused` log, which no deployed contract emits | `c`, `tx`, `li`, `id`, `r`, `x` |

`v` is 2. Schema 1 records, the first thirteen on the topic, carry no `a`; the
decoder reads both and the verifier audits both. `c` is `engine` or `vault`, and
`a` is that contract's address, and neither is decoration: `spentBits` lives on
each disclosing contract's own meter, so a record without them could not be
reconciled against anything, and the topic outlives deployments. The widest
checkpoint and the widest anchor the venue can produce are each asserted under
the 1024 byte single-chunk limit in `tools/hcs.test.mjs` rather than assumed to
fit.

An anchor's `h` is `keccak256` over `spentBits(row, epoch)` for every epoch from
`from` to `to` and every row in `rows`, epoch-major, each cell one 32-byte word:
the bytes `abi.encodePacked` would give a `uint256[]`, so anyone with the
contract and a hash function can rebuild it. `anchorPreimage` in `tools/hcs.mjs`
is that layout, and it refuses a missing cell rather than hashing a zero in its
place. A span is at most 288 epochs, one day, so a verifier's work per record is
bounded by the record and not by how long the relay was down.

## An ordered record, not a database

Hedera's own guidance on the service, [How to unlock the full potential of HCS
(and why it is not a
database)](https://hedera.com/blog/how-to-unlock-the-full-potential-of-hcs-and-why-it-is-not-a-database/),
draws a line this design was already on and now states: a topic is an ordered,
timestamped, tamper-evident log of events. It has no query, no index and no
"current value". Treating it as storage, and reading state back off it, is the
pattern that works at a hundred messages and fails at fifty thousand.

Where each thing lives here, in the article's terms:

- **State** is on the contracts. `spentBits` is written by `DisclosureMeter` and
  nothing on the topic can move it. No screen and no tool reads current state
  off the topic.
- **The event log** is the topic. Every record is a compact derived event with
  a `tx` pointer into the ledger, or a hash over cells the ledger holds. The
  data stays external and the topic anchors it, which is the article's "anchor
  state transitions, keep data external" pattern rather than a choice made
  after reading it.
- **The index** is the mirror node's REST listing, paged by sequence number,
  and on top of it a projection: `tools/hcs-project.mjs` folds the messages in
  order into what a reader asks of them, `tools/hcs-index.mjs` writes that fold
  to `deployments/hcs-index.json`, and the Issuer screen boots from the
  committed snapshot and asks the mirror node only for `sequencenumber` above
  it. Before it appends the tail it fetches the snapshot's last message back
  and compares the network's own `running_hash`; a snapshot the topic does not
  recognise is set aside and the screen reads the topic directly and says so.
- **Rebuild and compare** is `tools/hcs-verify.mjs`, which is the article's
  closing test run as a `make` target: read the topic off the mirror node,
  rebuild the projection, recompute every anchor from the contracts, and refuse
  the moment any of it disagrees with what the venue believes.

The cadence follows from the same line. A checkpoint every five-minute epoch was
a heartbeat that cost a message to say nothing, and buried the gap a stalled
relay leaves under identical zero rows. One anchor an hour per source covers
every one of those epochs with a hash the verifier recomputes, so the omission
check holds everywhere and the topic stays a record of things that happened.

The record the venue exists to be able to write is the third one. Live, on the
topic, at sequence 2:

```json
{"v":1,"k":"silence","c":"engine","tx":"0x2885d8da867b1cab43863698895a2bf78fb35114743a33849ba5f771cc707594","sel":"0xc4d252f5","fn":"cancel","r":15,"e":39,"spent":1,"budget":1}
```

The venue saying, on an ordered public stream with a consensus timestamp: *I
acted, I deliberately told you nothing, and here is the row and the budget that
made me stop.* Nothing in the contracts can produce that sentence, because Rule A
withholds the event and lets the transaction succeed, so a silenced row and a
quiet row are the same bytes in the log.

## Why a silence is never claimed on a guess

Printing a silence that did not happen is worse than printing none, so three
conditions have to hold before one is published, and each one closes a way of
being wrong.

**The site has to be unconditional.** `SITES` in `tools/hcs.mjs` marks each
`_emitUnder` call site `sure: true` only when every guard before it reverts.
`RepoVault.postMark`'s row 14 site sits behind `if (breach && state == OPEN)`, so
it is `sure: false` and excluded by name rather than by omission. That loses a
silence rather than inventing one.

`RepoVault.noteCoupon` joined it, and for a reason worth writing down because
the flag had been correct until the code changed under it. The call used to take
the coupon commitment as an argument and every guard in it reverted, so a
successful transaction with no row 14 charge could only be a withheld
disclosure. It now derives the commitment, and deriving brought an idempotence
guard: a coupon already noted **returns zero** rather than reverting, because
`docs/BUILD-REMAINING.md` §3 puts this call behind a HIP-1215 `scheduleCall` and
a scheduled call that fires after somebody made it by hand has to be a no-op.
Under scheduling that second call is the ordinary case rather than the rare one,
so `sure: true` would have printed a silence on nearly every scheduled coupon.

**The row has to be metered.** `DisclosureMeter.spend` returns early on
`budgetBits == 0` and emits nothing, entirely legitimately, so absence of a
charge on an unmetered row means nothing at all. The deployed set meters rows 13,
14 and 15 and `tools/hcs.test.mjs` pins that against `deployments/client.json`.

**The budget has to have been the budget.** `budgetFor(row)` is a read of current
state. The venue's first parameter set metered nothing and the set now in force
was adopted at disclosure epoch 34, so every disclosing call before that charged
nothing and said nothing, correctly. Both halves read `ParameterRoot`'s `Adopted`
history and refuse to judge a silence before that epoch. The relay found this the
first time it ran, by stopping on a `crossRound` in epoch 4 rather than by
publishing five false silences.

There is a fourth, quieter one. The relay replays each row's running total and
checks it against the `spentAfter` in every log it publishes. If the arithmetic
and the chain disagree it stops the pass rather than publishing a total nobody
can reproduce.

## What checks it

`tools/hcs-verify.mjs`. It reads the topic back from the mirror node and takes
nothing on the relay's word: not its cursor, not its logs, not its state.

- **Shape.** One chunk, under the limit, parses, and is byte for byte the
  canonical encoding of what it decodes to.
- **A charge names a real log.** `auditRecord` fetches the transaction back and
  compares row, epoch, granularity, cost and running total against the log at
  that index, emitted by the contract the record names. **The relay cannot
  forge.**
- **The sums reconcile.** For every checkpointed or anchored epoch, the
  published charges on a row must add up to `spentBits(row, epoch)` read off the
  contract, and a checkpoint must agree with it too. That number is written by
  the venue and the relay has no way to move it. **The relay cannot silently
  omit.**
- **A silence is a real silence.** The transaction succeeded, its calldata
  carries the selector the record names, it was sent to the contract the record
  names, the row it claims was withheld carries no charge in that transaction,
  and the budget it names is what `ParameterRoot` publishes.
- **An anchor is the chain's own hash.** Per source, the anchors tile: each
  starts the epoch after the previous one ended, so nothing is covered twice
  and nothing between the first and the last is covered by nothing. None
  reaches into an epoch that was still open at its consensus timestamp. Every
  cell in the range is read back off the contract, in waves of fifty, and
  `auditAnchor` recomputes `h`. Then every one of those cells has to equal what
  the topic published for it, zero where nothing was published, which is the
  omission check for every epoch at one message an hour. `--since <epoch>`
  bounds the reads on a long history; the default is everything.
- **The index is the topic.** If `deployments/hcs-index.json` exists: it claims
  no message the topic lacks, its digest is the digest of the topic's bytes to
  that sequence, its `running_hash` is the mirror node's at that sequence, and
  `project()` over those messages is, field for field, the committed file.

`make hcs-verify` runs the vector suite first, prints the table, writes
`deployments/hcs-verify.json`, and exits non-zero on any mismatch. The count
grows with the topic: 118 of 118 over thirteen messages when this was first
written; 2,002 of 2,002 over 220 messages on 10 September 2026, the two anchors
among them recomputed from 2,376 cells.

`auditRecord` is in `tools/hcs.mjs` rather than in the verifier, and the Rulebook
screen calls the same function over the same mirror node results. A green tick on
the page means what a `pass` in the table means, because it is one implementation
and one set of vectors. The screen runs seven of the verifier's eight per-record
assertions plus the policy-boundary check; what it leaves out is the per-epoch
sum against `spentBits` and the anchor recomputation, which are the omission
check and need a read per row per epoch. Firing hundreds of `eth_call`s off a
button is how a demonstration trips HashIO's rate limit, so those assertions
live in `make hcs-verify` and the panel says so.

`auditRecord` also refuses to run at all on a context that is missing the
address, the epoch, or a silence's governed budget. Comparing an absent value to
an absent value reads as a match, and an audit that can be made to succeed by
handing it less is not an audit. `tools/hcs.test.mjs` has a vector for each.

## What the operator is trusted for

Stated plainly, because a reader will work it out anyway.

**Cannot forge.** Every record names a transaction anyone can fetch, and the
verifier does. `tools/hcs.test.mjs` carries the forgery vectors: the two real
transactions off testnet with one field moved at a time, and the audit has to
catch each one. A charge with the row changed, the epoch changed, the cost or the
running total changed; a charge pointing at a log index that is not a charge, or
at one that does not exist; a charge attributed to the wrong contract; a charge
invented out of nothing. A silence on a transaction that reverted, at a different
entry point, in the wrong epoch, on a row that transaction did in fact charge, or
against a budget the venue does not publish.

**Cannot silently omit.** The per-epoch sum against `spentBits`, for every
epoch inside an anchored range and not only the epochs the relay chose to print.

**Cannot delete or rewrite.** The topic was created with a submit key and **no
admin key**, and `tools/hcs-topic.mjs` reads the topic back after creating it and
fails if either is wrong. So the venue cannot delete the topic, rename it, or
change who may write to it. The cost of that choice is that a leaked submit key
cannot be rotated, which is survivable only because a record written by somebody
else fails the same test a forged one would.

**Cannot make a public tree private.** A `CouponDistributor` entitlement root is
published to declare a coupon, and Hedera balances are readable from the mirror
node, so an observer who already reads balances can test candidate leaves against
the root and reconstruct who held what at the record date. The tree itself names
no address and this venue emits none, but that is a property of a public ledger
and not of this design, and no disclosure policy here reaches it. Row 14's
ceiling constrains what the venue says; it does not constrain what the ledger
already shows. `docs/RULEBOOK.md` §11.

**Can stall.** Nothing forces liveness. Turn the relay off and the topic stops.
The gap is visible in the sequence numbers and in the anchor series, where the
range an anchor covers sits against the epoch it reached consensus in, and it
cannot be prevented. That is inherent to HIP-478 and to every oracle pattern,
and the correct response is to say so rather than to pretend a heartbeat fixes
it.

## Where this is narrower than the scope

**Two contracts, not four.** `HCS-SCOPE.md` says four disclosing contracts. Of
the four `DisclosureView` implementations, `AxeBoard` is not deployed and
`SeamJournal` does not use `DisclosureMeter` at all: it carries its own row, its
own `spentBits(uint64)` keyed by epoch alone, and its own explicit
`UnverifiedArrivalWithheld` event. Bringing it in means a second reconciliation
shape for a contract that already publishes its own withholding, so it is out of
v1 and named here rather than quietly missing.

**Two conditional sites are excluded.** `RepoVault.postMark`'s row 14 and
`RepoVault.noteCoupon`'s, both above.

**The coupon leg's own claim path is outside this entirely.**
`CouponDistributor.claim` does not meter. Paying somebody what a published root
already says they are owed discloses nothing the root did not, and a claim that
could exhaust a budget is a coupon a holder cannot collect because other holders
collected first. `declare` is metered on row 7 and a ceiling breach there
reverts, because a venue that may not publish a corporate action must not
declare one, and nothing is stranded when it refuses. The payment is not
metered, and the asymmetry is deliberate rather than an omission:
`test_aCouponPaysWhateverTheMatrixSays` narrows row 7 after a declaration and
requires every holder of it to still be paid to the last unit, while
`test_aNarrowedRowFourteenStopsTheNote` shows the other side, where
`RepoVault.noteCoupon` does stop.

**Checkpoints are not one per epoch.** Every closed epoch that carried a record
gets one, because that is the epoch a reader wants the numbers for; an epoch
whose record landed while it was still open waits in the cursor until it closes,
so the numbers printed are final. Quiet epochs get no checkpoint. Until 10
September 2026 the latest closed epoch got one each pass as a heartbeat, which
at a five-minute epoch was 576 messages a day that said nothing, and which put a
hundred identical zero rows between the reader and the gap the series exists to
show. The anchors cover those epochs now: once twelve have closed since the last
anchor, one message per source hashes every cell in them. `--anchor-every`
changes the twelve; the span of one anchor is capped at 288 by the schema, so a
relay restarting after a long outage publishes one anchor per day of gap. The
relay reads the topic back at startup and resumes anchoring from the last epoch
an anchor reaches, or from the last checkpointed epoch on a topic that predates
anchors, so a lost cursor cannot produce two anchors over one epoch. The first
anchors on the topic, sequences 219 and 220, cover epochs 943 to 1206.

## Running it

```
make hcs-topic             # once, ever. About $0.01. Writes deployments/hcs.json
make hcs-relay MODE=dry    # build every record, submit none
make hcs-relay MODE=once   # one pass, then stop
make hcs-relay             # poll and publish until interrupted
make hcs-verify            # read the topic back and check it against the chain
make hcs-index             # extend deployments/hcs-index.json from the topic's tail
make hcs-index MODE=check  # rebuild it from sequence 1 and compare
```

`hcs-topic` refuses if `deployments/hcs.json` already names a topic: a second
topic would split the record in two and neither half would be the venue's. The
relay reads the topic back at startup and dedupes against it, so a lost cursor
cannot cause a double publish.

`hcs-index` extends the committed projection from `sequencenumber` above its
`throughSequence`, after fetching that message back and refusing to grow a file
whose `running_hash` the mirror node does not recognise. `MODE=check` is the
deterministic-reconstruction proof: the whole topic from sequence one, folded
again, has to equal the file. The Issuer screen inlines the compact form of this
file through `tools/hcs-index-bundle.mjs`, which `make app` regenerates; moving
the index is a separate decision from rebuilding a template, so `app` does not
depend on `hcs-index`. Run it, then `make app`, then commit both.

`deployments/hcs-cursor.json` is gitignored. It is runtime state, not evidence.
`deployments/hcs-index.json` is committed. It is a projection of evidence, and
the verifier holds it to the topic.

## The dependency, and the audit

One: `@hiero-ledger/sdk`, Apache 2.0, because a native
`TopicMessageSubmitTransaction` has to be signed and there is no JSON-RPC path to
one. It is installed in `toolchain/` and reached only from `venue/tools/`.
`tools/gen-app.mjs` inlines a fixed list that does not include it, so the six
built screens still carry no dependency but the vendored ethers.

`toolchain/package.json` pins `overrides` for `protobufjs` and `ws` on its
behalf. Without them the SDK added a critical and ten high advisories to the
tree, most of them through a `react-native` peer that a Node CLI never loads.
With them `npm audit` reports the same eighteen findings before and after,
all in the pre-existing snarkjs and circomlibjs chains, none with a fix
available. Adding a service was not allowed to cost the tree a vulnerability.

## Cost

$0.01 to create the topic, once. $0.0008 per message: `ConsensusSubmitMessage`
was $0.0001 when `HCS-SCOPE.md` was written and has been $0.0008 since the
[January 2026 mainnet
upgrade](https://hedera.com/blog/price-update-to-consensussubmitmessage-in-consensus-service-january-2026/).
Testnet HBAR is free, so the figures below are what the same relay would cost on
mainnet.

The cadence is what the fee prices. Under the heartbeat, a continuously running
relay wrote one checkpoint per source per five-minute epoch: 576 messages a day,
about $0.46, nearly all of it zero rows. Under the anchors it writes one message
per source per hour, 48 a day, about $0.04, plus one checkpoint per epoch that
carried a record and one record per charge, ceiling and silence, which is the
part of the bill that scales with the venue rather than with the clock. The
first pass after the change published 83 messages, 41 of them charges the venue
had made, for about $0.07.
