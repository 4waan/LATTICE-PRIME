# The mathematics

What the proof system proves, and the arithmetic the venue relies on.

## The eligibility statement

A participant demonstrates membership in a set of issued credentials without
revealing which one. The set is committed to on-chain as a single value, so
adding or revoking a credential is a change to that commitment rather than a
change to any participant's proof obligations.

Freshness is bound in so that an old proof cannot be replayed after a revocation.

## Nullifiers

Reuse is prevented by deriving a value from the credential that is stable across
uses of the same credential and unlinkable across different ones. The derivation
must not be a function of anything that identifies the holder, or the linkage the
proof removes is quietly reintroduced.

## The cancellation bond

A commitment can be withdrawn before it becomes openable, and the charge for
withdrawing is derived rather than picked.

A bond exists because committing would otherwise be free, and a free commitment
is a free way to put a phantom order on the book and move the reference price. A
refundable withdrawal gives that back some of its cheapness, and no amount of
argument removes it. So the quantity to bound is not the cost of a withdrawal
but its cost per second of phantom.

There are two ways to buy phantom. Post a bond and let the commitment lapse,
which costs the whole bond and buys the full commitment lifetime. Or post a bond
and withdraw, which costs the charge and buys only the time before withdrawal,
which is at most the reveal delay. Requiring that the second is never the cheaper
rate gives a single inequality, and its binding case gives the charge: the bond
scaled by the reveal delay's share of the whole lifetime, rounded up.

Read forward this is a bound on manipulation. Read backwards it is a refund rule
with an ordinary meaning, which is that a committer pays for the fraction of the
commitment's life they used. At the derived minimum the two routes cost the same
per second, so withdrawal adds no cheap manipulation and only stops charging
honest participants for time they did not take.

What it does not do, stated because the number is worth publishing rather than
discovering: withdrawal is cheaper per *commitment* than lapsing, by exactly the
ratio of the two lifetimes. The bound buys back on duration what it concedes on
count.

The other half of the argument is not arithmetic but a window. Withdrawal is
legal only before the commitment could have been opened. Allowing it any later
would let a participant who has watched the market turn pay the small charge
instead of the whole bond, and the bond would stop pricing the decision not to
open at all, which is a property the venue already had.

## The disclosure arithmetic

A disclosure level is a point on three axes rather than a scalar, so comparing
two disclosures is a partial order rather than a comparison of numbers. The
implementation represents this compactly enough that a check costs a small
constant, which is what allows it to sit on a transfer path.

The level is drawn rather than chosen, and the draw is proved correct. A
participant cannot bias it and an observer cannot infer intent from the result.

## Repo arithmetic

Haircut and initial margin are quoted differently and are kept as distinct
quantities. Conflating them produces margin calls of the wrong size in the
direction that under-protects the lender.

Rounding is fixed to favour the party bearing the risk at each point, and the
direction is asserted in tests rather than left to the reader.

## Corrections to the initial design

Three pieces of arithmetic in the original design were wrong and were found by
implementing them. Each is now covered by a test that fails against the original
formulation, because an arithmetic fix without a test that distinguishes it from
the bug is not a fix.
