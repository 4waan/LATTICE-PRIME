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

## What it does not solve

The set of participants who submitted a commitment in a given window is visible,
because the transactions are. This is a volume and timing signal, and it is
addressed by the disclosure budget rather than by the commitment scheme.
