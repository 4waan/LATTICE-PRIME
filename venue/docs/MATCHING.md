# Matching

How orders are matched without the book being readable.

## The constraint

On this network a submitted transaction is gossiped in full to the consensus node
set before it is ordered or executed. Anything in a plain limit order is visible
to that set ahead of execution, so a conventional on-chain book cannot be private
regardless of what the contract does afterwards.

## The approach

Orders arrive as fixed length commitments. What reaches the node set carries no
size, no price and no side, and every commitment is the same length so the
message itself reveals nothing by its shape.

Matching happens against revealed values in a second step, with the reveal bound
to the earlier commitment so a participant cannot change their order after seeing
others.

## What this costs

Two steps rather than one, and a participant who commits and does not reveal has
to be handled rather than ignored. The design treats non-reveal as an expected
case with a defined consequence, not as an error.

## Resting, and why orders do not re-commit each round

A revealed order rests for eight daily rounds rather than expiring with its
round. The lever is measured, not assumed. At this venue's rate of 600 orders a
year, Poisson, `probes/matching-clearing.py`:

| resting rounds | crossings/yr | against R=0 |
|---|---|---|
| R=0 | 130.0 | 1.00x |
| R=1 | 211.8 | 1.63x |
| R=7 | 277.8 | 2.14x |
| R=30 | 292.8 | 2.25x |

Resting roughly doubles crossings while keeping a daily price. It is also cheaper
in disclosure than the alternative, which is the argument that settles it.
Re-committing each round spends a fresh exact disclosure on the size and price
rows every round against the same row budget, which is the repetition attack with
the trader as the attacker. Resting spends one, plus a per-round "still unfilled"
predicate. Neither is free and both saturate; resting saturates later.

## Three questions this design closes

**Counterparty relationship.** A netted settlement layer hides a counterparty
only if the netting set holds more than one trade. At this venue's rate a set of
five needs a weekly batch, and anything worth calling private needs a thirty day
epoch, which the time axis already rules out for the trading cadence row. Same
mechanism, same arithmetic, opposite row. So the counterparty is published in the
clear and named as a stated limit rather than hidden badly.

**The match predicate.** Not a dependent disclosure here. It would be one if the
observer set were computed from a hidden value, but in a call auction over
already revealed orders under a public deterministic rule, nothing is hidden at
evaluation time and anyone recomputes the match from the tape. No evaluator means
no trusted evaluator surface.

**Price-time priority.** There is none, because there is nothing for it to do.
A call auction clears at one price; see `CallAuction`.

## What it does not solve

The set of participants who submitted a commitment in a given window is visible,
because the transactions are. This is a volume and timing signal, and it is
addressed by the disclosure budget rather than by the commitment scheme.
