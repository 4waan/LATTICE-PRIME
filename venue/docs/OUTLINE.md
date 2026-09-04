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

Policy parameters, regimes and volume caps, with the parameter set addressed by
a root so that a change is a single visible event.

The call graph census, generated from source rather than maintained by hand, so
the claim about what each lifecycle path can reach is checkable.

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
