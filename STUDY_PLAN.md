# Study plan

What this project had to understand before it could be built, and what each
piece of study was for.

## Foundation

**The instrument.** Repo is a sale with an agreement to repurchase. It is the
most common way institutions finance a bond position, and it is the use case
named for tokenised collateral. We needed the mechanics precisely: how a haircut
is set, what a margin call is, what happens on failure to deliver.

**The machine.** The Asset Tokenization Studio is Hedera's production framework
for regulated securities. We read its transfer path in full to find where a venue
can attach without forking it, and what each attachment point does when the thing
it calls misbehaves.

**The venue.** Market microstructure under adversaries. What a trading venue has
to hide to stay usable, what it has to reveal to stay legal, and what an attacker
can reconstruct from what is left. Six real venues were surveyed for how they
answer this.

**The exposure.** What a tokenised security on Hedera publishes today, to anyone,
with no key and no relationship. This is the finding the project is built around
and it was measured rather than assumed.

**The mechanism.** Zero knowledge proving, concretely: which curve, which proving
system, what a proof costs to verify on Hedera, and whether it fits inside a
transaction.

**The plumbing.** Price, cash and settlement. How the two legs of a trade either
both happen or neither does, across two execution environments.

## Design

The design questions were whether privacy is warranted here at all, what the
strongest argument against it is, who should be able to see what and under whose
authority, how that compares to what Hedera already publishes, and who holds the
parameters once the thing is live.

A venue where nobody can see anything is a mixer and is unbankable. A venue where
everybody sees everything is what exists today. The design work was locating the
line between those, and making the position on that line a published policy
rather than an implementation detail.

## Method

Each area was studied until it produced something checkable: a measurement
against a live network, a reading of source that could be cited to a line, or a
working piece of code. Claims that could not be reduced to one of those were not
carried forward.
