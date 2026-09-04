# Zero knowledge settlement

What would be required to make settlement itself private, as opposed to
eligibility, written in dependency order because the pieces are not independent.

## Why this is separate

Proving eligibility is a membership statement over a small committed set. Proving
settlement means proving a state transition over balances, which is a different
and much larger class of circuit.

Treating them as the same problem is the mistake that makes this look easy from
a distance.

## The dependency order

Committed balances have to come first, because nothing else can be stated
without them.

Then transitions over those commitments, which is where the constraint count
becomes the binding cost rather than the pairing.

Then the interaction with the collateral token, which is the genuinely hard part,
because the token is governed by rules that live outside the circuit and cannot
be assumed away.

## What this is not

It is not on the path for this version and nothing here depends on it. It is
written down so the boundary of the current claim is explicit: eligibility is
proved, settlement is not, and anyone reading the code should not have to infer
that from what is absent.
