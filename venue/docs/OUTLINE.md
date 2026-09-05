# What is built

## Working

The disclosure model, as executable code rather than a document. A check costs
a small constant amount of gas, which is what makes it usable on a transfer path.

The eligibility circuit and its on-chain verifier, with the compiled circuit
checked mechanically for which inputs are genuinely public.

The contract ATS calls on every transfer, and the registration gate that writes
to it. This is the attachment point that decides whether a transfer happens, and
it is deliberately small.

The repo state machine and its arithmetic: haircuts, margin calls, and the two
legs of an opening.

A commit and reveal order book, so what reaches the consensus node set carries
no size, no price and no side.

Cancellation of a sealed order before its reveal window opens, at a bond charge
derived from how long the commitment sat on the book rather than chosen. The
window closes at the instant reveal opens, which is what keeps the bond pricing
the choice not to open. It is also the only thing the venue publishes coarsely
enough for the coalition budget to bind, so it is the first place that bound does
any work on the trading path.

Policy parameters, regimes and volume caps, with the parameter set addressed by
a root so that a change is a single visible event.

The call graph census, generated from source rather than maintained by hand, so
the claim about what each lifecycle path can reach is checkable.

A lender axe board. A lender posts a sealed coverage grid over collateral
class, size band and rate band; a borrower probes one cell and learns one bit,
the Turquoise Block Indication predicate, proved by a Merkle opening instead of
scored by an operator. The pre-trade privacy dial is the three FIX fields the
OTC research already named. The board and the exact-reveal book are two
parameter regimes: a probe publishes a bucket, and a bucket is the first cell
on rows 3 and 4 a coalition budget can bind.

A published rulebook and tariff. The document `Rulebook.sol` commits to is
`docs/RULEBOOK.md`, in the shape Form ATS-N asks for: one order type, no external
market data, price then pro rata, no halt, and a tariff of seven lines. Each
sourced line names the getter that holds it and `reconcile` reads it back, so a
charge the code makes and the page does not is visible to anyone. The venue's own
take is published as zero, which is the disclosure the fee question owes while it
stays open.

A halt, held as the mirror of the disclosure ceiling rather than as a pause key.
Narrowing what may be disclosed is the safe direction, so it is immediate and
unbounded; halting is the deprivation, so it is capped by an immutable grant,
budgeted per epoch, and expires by itself. It gates one function, `crossRound`,
so a halted venue cannot trade and cannot stop anyone leaving. In this
deployment the discretionary half has no caller, because the supervisor seat is
held by `VolumeCap`; what can fire is the breaker, and the breaker is arithmetic
on the venue's own clearing price.

## Not built

Collateral substitution mid-term. Common in practice, deferred deliberately.

Zero knowledge settlement, as opposed to zero knowledge eligibility. The
dependency order for it is written down but the work is not done.

Cross-platform collateral mobility. The interfaces are written against a
collateral token rather than a specific one so that this stays open, but nothing
implements it.

## Blocked on a decision rather than on work

The liquidation auction discloses more than the rest of the system, because a
forced sale needs bidders. How much more is a policy question, not an
engineering one, and it is not settled.
