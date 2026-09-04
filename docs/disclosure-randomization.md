# Randomising the disclosure class

Why the disclosure level is drawn rather than fixed, and what privacy coins
teach about getting this wrong.

## The lesson from elsewhere

Two well-studied privacy systems failed in opposite ways.

One made concealment optional, and almost nobody chose it. The small set that
did became conspicuous precisely because they were the set that opted in. The
anonymity set was the problem, not the cryptography.

The other made concealment mandatory but left the amount concealed variable and
observable in aggregate, which let observers partition users by behaviour over
time even without breaking any individual transaction.

The common failure is the same. If a user's privacy level is a choice, the choice
itself is a signal, and it identifies them.

## What we do instead

The disclosure level is not chosen by the participant and is not constant. It is
drawn, and the draw is proved correct rather than asserted, so a participant
cannot bias it toward a level that suits them and an observer cannot infer intent
from the level that appeared.

This makes a coarse disclosure uninformative about the participant who produced
it. The observer learns that a value fell in a band; they do not learn that this
participant wanted it to.

## Where the randomness comes from

It has to be unpredictable to the participant before they commit, and verifiable
by everyone afterwards. Hedera provides a source with those properties at the
consensus layer, which is one of the few places where building on this network
is a genuine advantage rather than a constraint to work around.
