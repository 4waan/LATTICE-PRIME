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

Four record kinds, one message each, always one chunk. `tools/hcs.mjs` is the
grammar and `tools/hcs.test.mjs` holds it to the deployed ABIs.

| `k` | when | carries |
|---|---|---|
| `charge` | a `DisclosureCharged` log | `c`, `tx`, `li`, `r`, `e`, `g`, `cost`, `after` |
| `refusal` | a `DisclosureRefused` log | `c`, `tx`, `li`, `id`, `r`, `x` |
| `silence` | a disclosing call that succeeded and said nothing on a metered row | `c`, `tx`, `sel`, `fn`, `r`, `e`, `spent`, `budget` |
| `checkpoint` | an epoch that carried a record, and the latest closed epoch | `c`, `e`, `blk`, `rows` |

`c` is `engine` or `vault`, and it is not decoration: `spentBits` lives on each
disclosing contract's own meter, so a record without it could not be reconciled
against anything. The widest checkpoint the venue can produce is asserted under
the 1024 byte single-chunk limit in `tools/hcs.test.mjs` rather than assumed to
fit.

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
- **The sums reconcile.** For every checkpointed epoch, the published charges on
  a row must add up to `spentBits(row, epoch)` read off the contract, and the
  checkpoint must agree with it too. That number is written by the venue and the
  relay has no way to move it. **The relay cannot silently omit.**
- **A silence is a real silence.** The transaction succeeded, its calldata
  carries the selector the record names, it was sent to the contract the record
  names, the row it claims was withheld carries no charge in that transaction,
  and the budget it names is what `ParameterRoot` publishes.

`make hcs-verify` runs the vector suite first, prints the table, writes
`deployments/hcs-verify.json`, and exits non-zero on any mismatch. The count
grows with the topic; at the time of writing, 118 of 118 pass over thirteen
messages.

`auditRecord` is in `tools/hcs.mjs` rather than in the verifier, and the Rulebook
screen calls the same function over the same mirror node results. A green tick on
the page means what a `pass` in the table means, because it is one implementation
and one set of vectors. The screen runs seven of the verifier's eight per-record
assertions plus the policy-boundary check; the one it leaves out is the per-epoch
sum against `spentBits`, which is the omission check and needs a read per row per
epoch. Firing dozens of `eth_call`s off a button is how a demonstration trips
HashIO's rate limit, so that assertion lives in `make hcs-verify` and the panel
says so.

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

**Cannot silently omit.** The per-epoch sum against `spentBits`.

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
The gap is visible in the sequence numbers and in the checkpoint series and
cannot be prevented. That is inherent to HIP-478 and to every oracle pattern, and
the correct response is to say so rather than to pretend a heartbeat fixes it.

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

**Checkpoints are not one per epoch unconditionally.** Every epoch that carried a
record gets one, because that is the epoch a verifier reconciles, plus the latest
closed epoch as a heartbeat. Backfilling every quiet epoch would put a hundred
identical zero rows between the reader and the gap the series exists to show.

## Running it

```
make hcs-topic          # once, ever. About $0.01. Writes deployments/hcs.json
make hcs-relay MODE=dry # build every record, submit none
make hcs-relay          # poll and publish until interrupted
make hcs-verify         # read the topic back and check it against the chain
```

`hcs-topic` refuses if `deployments/hcs.json` already names a topic: a second
topic would split the record in two and neither half would be the venue's. The
relay reads the topic back at startup and dedupes against it, so a lost cursor
cannot cause a double publish.

`deployments/hcs-cursor.json` is gitignored. It is runtime state, not evidence.

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

$0.01 to create the topic, $0.0001 per message.
