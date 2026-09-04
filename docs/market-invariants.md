# Market invariants

Properties the venue must hold at all times, written as a list because a
property that is not written down is not tested.

## Eligibility

No account may hold the security without a valid proof of eligibility, and the
proof must be checked at the moment of transfer rather than at registration.
Eligibility can be revoked, and a design that checks only on the way in cannot
express that.

## Custody and the legs

Collateral under an open repo is not transferable by the party holding it. Both
legs of an opening either complete or neither does. A maturing repo cannot close
while a margin obligation is outstanding.

## Disclosure

Nothing published by the venue may allow an observer to recover a participant's
position, their identity, or the size of an individual order. Any value that is
revealed must be revealed at the resolution and to the audience the published
policy names, and not more.

The regulator's view is a superset of every other view. There is no state the
venue can reach in which someone can see something the regulator cannot.

## Auction and liquidation

A default triggers a liquidation, and liquidation is the one place where the
privacy policy has to yield, because a forced sale needs bidders. The design
narrows what becomes visible rather than pretending nothing does.

## Invariants without mechanisms

Writing this list found several properties the design asserted but did not
enforce anywhere. Each is now either implemented, or explicitly recorded as out
of scope with a reason. A property that is claimed but unenforced is worse than
one that is absent, because it will be relied on.
