# Settlement

How the two legs of a repo either both happen or neither does, across two
execution environments on the same ledger.

## The problem

A repo opens by moving collateral one way and cash the other. Those two moves
touch different subsystems: the security is a token governed by its compliance
rules, the cash leg is a separate transfer. If one succeeds and the other fails,
one party is short an asset and the other is short the payment.

Hedera makes this harder than a single-environment chain would, because contract
execution and native token operations do not share one failure domain in the way
a naive reading suggests. A revert in one place does not automatically undo work
in the other.

## What we do

Settlement is arranged so that the collateral move is conditional on the cash
move having already been committed, and the whole sequence is driven from a
single contract call that owns the failure handling. Nothing is left in a state
where one leg has landed and the other is merely expected.

The boundary between the two environments was measured rather than trusted. What
rolls back and what does not was established by deliberately failing each leg in
turn and observing the result, because the behaviour is not what reading the
documentation would lead you to expect.

## The open leg

A repo is not settled when it opens. It has a second leg at maturity, and
between the two the position has to be margined. That is what makes repo a
harder instrument than a spot trade, and it is why the design carries a state
machine rather than a transfer function.
