# Call limits and gas topology

What a single transaction can afford on Hedera, measured rather than read from
documentation.

## The ceiling

There is a hard ceiling on the gas one call may consume. We found its exact
value by bisection, running the same operation with increasing budgets until it
stopped succeeding. Documentation was not sufficient here, because the published
figures describe a different limit from the one that actually binds.

## Why bisection rather than a benchmark

A benchmark tells you what an operation cost on the run you observed. Bisection
tells you where the wall is. For a design that has to fit a proof verification
inside one transaction, the wall is the number that matters, and it is the one
that decides whether an approach is viable at all.

Measuring this way also caught a sizeable error in our own first estimate of the
cost of one curve operation. The estimate was out by several times, in the
direction that would have made the design look impossible.

## What it means for the design

Verification fits, with room. The binding constraint on this project is not gas.
It is the number of public inputs a proof can carry, and that ceiling is high
enough that it does not constrain the disclosure policy in practice.
