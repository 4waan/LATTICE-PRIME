# Six venues, compared on what they hide

Institutional and crypto-native venues were surveyed: over-the-counter bond
trading, a bank-operated tokenised settlement network, equity dark pools,
perpetual futures exchanges, an automated market maker, and a prediction market.

## What every venue hides

All six conceal the identity of who is behind an order before it executes. None
of them treat that as optional, and the ones that leak it do so accidentally
rather than by design.

Most also conceal order size before matching, either by hiding the book outright
or by accepting only indications that carry no firm quantity.

## What no venue hides

Executed price reaches the tape everywhere, though the delay varies from
immediate to end of day. Post-trade transparency is a regulatory floor, not a
design choice, and no venue in the survey is below it.

## Where the survey changed our design

Three things came out of it that were not obvious beforehand.

The taxonomies of privacy mechanisms in the literature are incomplete. Real
venues use a mechanism those taxonomies do not name: disclosure conditional on
an event, where the counterparty learns a fact only once a trigger fires. That
mechanism is what a margin call needs, and it is what this venue implements.

The most damaging leaks are not the fields a venue chooses to publish. They are
facts derived by combining published fields, which no policy covers because no
policy has a name for them. A venue can be careful about every column it prints
and still hand an observer a strategy fingerprint.

And in a book held by consensus, disclosure stops being a policy at all. It is a
consequence of replication, because everything the book knows is known by
everyone replicating it. That single point is why this project puts commitments
rather than orders on the wire.
