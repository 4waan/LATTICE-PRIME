# Matching

How orders match without the book being readable.

## Constraint

Hedera gossips the full transaction body to the consensus node set (~29 operators) before order or execution. A plain limit order is already disclosed, whatever the contract does next.

## Approach

Orders arrive as fixed-length `bytes32` commitments. Reveal is bound to the commitment. Non-reveal is an expected case with a defined consequence (forfeit).

Clearing is a uniform-price call auction (`CallAuction`). `crossRound` is permissionless: choosing when to cross is choosing the price.

## Resting

A revealed order rests `restRounds + 1` rounds. At 600 orders/year, Poisson (`probes/matching-clearing.py`):

| resting rounds | crossings/yr | against R=0 |
|---|---|---|
| R=0 | 130.0 | 1.00x |
| R=1 | 211.8 | 1.63x |
| R=7 | 277.8 | 2.14x |
| R=30 | 292.8 | 2.25x |

Re-committing each round spends a fresh exact disclosure on size and price against the same budget. Resting spends one, plus a per-round unfilled predicate.

## Stated limits

**Counterparty.** Netted settlement only hides a pair when the set has more than one trade. At this rate that needs a long batch, already ruled out on the time axis. Published in the clear.

**Match predicate.** Public deterministic rule over already-revealed orders: anyone recomputes from the tape. No trusted evaluator.

**Time priority.** None in the price. Residue ≤ `k−1` at the marginal pro-rata level only.

## What it does not solve

Who submitted a commitment in a window is visible (the txs are). That volume/timing signal is the disclosure budget's problem, not the commitment scheme's.
