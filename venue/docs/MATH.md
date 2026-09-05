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

## The axe grid

A lender's indication is a rectangle in `(class, size, rate)`. It is committed
as a 2,048-cell bitmap, one bit per cell, in a fixed-depth Merkle tree. A probe
opens exactly one leaf. The borrower learns one bit; every other cell stays
sealed; and the lender cannot answer twice differently, because the root was
fixed before the probe existed.

Size bands are the venue's own base-ten magnitude, capped at 15 so the axis is
finite. Rate bands are 25 basis points wide, top band open. Coverage is band
intersection, which is an interval because the band functions are monotone:
`band b meets [lo, hi]` if and only if `band(lo) <= b <= band(hi)`. That is
exhausted in `probes/axe-grid.py` and replayed in `test/AxeGrid.t.sol`, not
assumed.

An arbitrary grid is 2,048 bits. A rectangular one is 18. There are
`T(16) = 136` intervals on a 16-point axis, so `8 × 136 × 136 = 147,968`
rectangles, and `2^17 < 147,968 <= 2^18`. The row 13 budget is set against
that number. The readable shape is the weak one, by a factor of 113; a lender
who wants the other 2,030 bits posts a set that is not a rectangle, and the
mechanism already supports it.

## The axe bond

A lender who is genuinely axed where they were asked cannot answer "no": the
grid binds. The remaining moves are answer "yes" and firm up, or go silent.
Honesty dominates silence for every reachable number of concurrent obligations
when the axe bond covers the worst case,

    B_a  >  M × (B_c − f)

with one wei of slack, where `B_c` is the book's commit bond, `f` is the probe
fee and `M` is the outstanding cap. When the fee already covers the commit
bond the constraint is vacuous and any positive bond will do. Derived, not
chosen, in the shape the cancellation charge already has.

## Corrections to the initial design

Three pieces of arithmetic in the original design were wrong and were found by
implementing them. Each is now covered by a test that fails against the original
formulation, because an arithmetic fix without a test that distinguishes it from
the bug is not a fix.
