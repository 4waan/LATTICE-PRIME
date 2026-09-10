# The four minute cut

ETHOnline takes a video of two to four minutes. `DEMO-SCRIPT.md` is written for
five and for a room. This is the cut, the running order, and what has to be true
on chain before the camera is on.

## The constraint that decides everything

The venue cannot be driven end to end inside the video, and no amount of editing
changes that. The clocks are longer than the runtime:

| Clock | Period | What it gates |
|---|---|---|
| Round | 300s | reveal opens at +30s, closes at +300s, crossing after that |
| Disclosure epoch | 300s | budgets, `spentBits`, governance |
| KYC epoch | 604800s | every grant in the venue |

One commit to one settlement is 300 seconds minimum, which is longer than the
whole submission. A PLONK proof is about 23 seconds. Reads are not the problem
they were once written down as: a HashIO `eth_call` answers in about 0.4s and
sixty of them batch into 0.8s, so a screen now holds its figures in one to three
round trips. `docs/SPEED.md` has the measurements.

So the video does not run the venue. **The venue is run before the camera, and
the video reads the state back.** That is not a workaround, it is the thesis:
every figure on every screen is a getter, and `deployments/receipt-beat.json`
carries the transaction hashes for anything a judge wants to check. Nothing is
staged, nothing is a mock, and every hash resolves on HashScan.

## What is cut, and why

`DEMO-SCRIPT.md` has five beats. The repo beat goes.

The client now has a guarded RepoVault v5 write surface and a verified-run panel,
but the full recorded financing lifecycle took nearly nineteen minutes. Cutting
margin, coupon, maturity, grace, and default into a four-minute video would turn
the strongest evidence into a rushed list. Keep one short Financing panel read
inside the Hedera lifecycle beat, and leave the full route to its timestamped
HashScan links. The substitution refusal that made it worth 13 seconds in the
room is a repo desk's question, and the video is not being watched by a repo
desk.

It stays in the README and in the slide deck.

## The running order

Target 3:45. The 15 seconds of headroom is not optional; every recording of this
has run long.

| From | To | Beat | On screen |
|---|---|---|---|
| 0:00 | 0:25 | **The exposure** | A live query against the public network returning the complete holder register of a real regulated fund, per account compliance status, no credential of any kind. Run it, do not screenshot it. |
| 0:25 | 0:55 | **Prove** | The proof, `wouldAccept` answering before gas is spent, `register`, the grant appearing. Then the same query from beat one, returning nothing about this holder. |
| 0:55 | 2:15 | **The receipt** | Commit, cancel, and the page saying what the venue published: row, granularity, observers, time, bits spent. Then the second cancel. Status 1, zero logs, 60,090 gas against 118,154. The state no event stream can report. |
| 2:15 | 2:55 | **The supervisor** | The same position resolved to exact figures, on a published policy, without the participant's cooperation and without asking anyone. |
| 2:55 | 3:10 | **The record** | The Rulebook screen's consensus topic panel. Sequence 2, the `silence` record, and "matches the chain" appearing next to it when the audit runs. Then the same topic on HashScan, ordered, with consensus timestamps, outside our app. |
| 3:10 | 3:30 | **On Hedera** | HashScan on the beat's transactions, the tape read from the mirror node index, the ATS bond, the thirteen deployed contracts. Say "HIP-478" out loud: there is no consensus service system contract, the oracle is the specified pattern, and we checked `eth_getCode` rather than assuming. |
| 3:30 | 3:45 | **The line** | What it is, in one sentence, and the URL. |

The exposure is first because everything after it is unmotivated otherwise. The
supervisor is last because "this is a mixer" is the objection an institutional
audience forms during the privacy beats, and it has to be answered after it has
been allowed to form. The receipt sits immediately before it because it is the
beat a competing venue cannot answer at all.

The Hedera beats are fifth and sixth rather than woven through, because
Integration and Success are 35% of the rubric between them and a judge scoring
those two needs 35 uninterrupted seconds of chain, not a mention. The topic beat
comes first of the two because it is the one that answers "which Hedera services,
and used how": the EVM and the mirror node are table stakes, and the consensus
topic is doing something the EVM provably cannot, since no contract can reach
HCS at all.

## Producing it

Six steps, in this order. Do not record audio and picture together.

1. **Confirm the grants.** `script/live/renew-kyc.sh status`. If the KYC epoch
   has rolled, see the cliff below before anything else.
2. **Run a fresh beat.** `script/live/receipt-beat.sh run`. This writes
   `deployments/receipt-beat.json` and asserts eleven claims about its own run.
   Fresh hashes dated near the submission read better than a week old ones.
2b. **Leave the relay running, and check it.** `make hcs-relay` well before the
   recording, so the beat's charge and silence land on a topic that already has
   history rather than becoming its first two messages. Then `make hcs-verify`:
   it exits non-zero on any mismatch, and a topic that does not reconcile is not
   something to point a camera at.
3. **Capture picture, silent, one beat per take.** Seven takes. A screen holds
   its figures in one to three round trips now and a cold open is one to two
   seconds, so there is little left to cut; where there is, cut the wait rather
   than speeding it up, because a sped up spinner looks like a fake.
4. **Write the voiceover against the captured picture**, not against this table.
   The picture is what exists.
5. **Record the voiceover in one pass.** Retakes per sentence, not per beat.
6. **Cut to picture.** The receipt beat is where the time goes if it runs long;
   protect the exposure and the supervisor.

## The cliff, dated

**KYC epoch 7 ends 2026-09-12 16:33 UTC. Submission closes 2026-09-13 16:00 UTC.
The epoch rolls about 23 hours before the deadline.**

At that instant every grant in the venue dies with no transaction from anyone
and nothing warns. Rounds still cross and prints still go out while
`MatchingEngine` emits `SettlementRefused` per pair and nothing settles. A judge
opening the app after the roll sees a venue that refuses every hold.

Both halves of the recovery are already prepared:

- The root for epoch 8 is published. A leaf carries no epoch, so the tree is bit
  for bit the one already on chain.
- `deployments/proofs-live-epoch8.json` holds proofs for all three live
  addresses, public signal 3 pinned to 8.

What is left is one command, and it cannot be run early because `register`
refuses a proof for a future epoch:

```
script/live/renew-kyc.sh renew 8      # after 2026-09-12 16:33 UTC
```

Put it in a calendar. If the submission video is recorded before the roll and a
judge watches after it, the video shows a venue the app no longer matches.
