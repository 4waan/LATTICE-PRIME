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
