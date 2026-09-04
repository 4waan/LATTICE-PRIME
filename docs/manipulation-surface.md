# The manipulation surface

What a disclosure policy lets someone do, as opposed to what it lets them see.

## The gap

Privacy analysis usually stops at confidentiality: can an observer read a value.
That is the wrong question for a trading venue. The right one is what an
observer can profitably do with what the policy permits them to learn, including
things the policy considers harmless.

A boolean is not safe because it is one bit. It is safe or unsafe depending on
what an adversary can do with a stream of them.

## What we did

The disclosure policy was treated as an attack surface and worked through
adversarially: for each value the policy releases, to whom, and when, what
strategy does that enable, and what does it cost to run.

Several of the resulting attacks work against the policy as originally written.
They are not cryptographic breaks. They exploit the fact that a value released
repeatedly on a schedule carries information the same value released once does
not, and that an adversary can often choose when to provoke a release.

## The inversion

The most useful finding was that the strongest attacks run in the opposite
direction from the obvious one. Rather than an observer learning a position from
disclosures, an adversary induces disclosures by trading against a participant
and reads the response. The policy governs what is published, and it has nothing
to say about what an attacker can cause to be published.

This changed the design. Disclosure that responds to an event has to be
decoupled from the timing of that event, or the response becomes the signal.

## Consequence

Anything released on a trigger is released on a schedule that an adversary
cannot align to the trigger, and the amount released is budgeted over time
rather than evaluated per event.
