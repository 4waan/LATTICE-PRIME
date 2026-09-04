# The disclosure lattice

The coordinate system this project uses to talk about privacy, so that a claim
like "the position is private" can be checked instead of asserted.

## Why a coordinate system

Privacy is usually stated as a single dial between hidden and public. That is not
enough to design against. Two systems can both be called private and disagree
completely about who sees what, at what resolution, and for how long.

Information disclosed is better modelled as a partition. Saying a trade was
between 10 and 50 million is not a smaller number than saying it was 34 million.
It is a coarser partition of the same space, and it stands in an order relation
to the exact figure rather than on a scale beneath it.

## Three axes

Every disclosure in this system is a point on three axes:

**Granularity.** How coarse is what is revealed. An exact value, a bucket, a
boolean, or nothing.

**Observers.** Who receives it. The counterparty, the venue, a regulator, the
network, the public.

**Time.** When they receive it. Immediately, after a delay, on a trigger, or
never.

A privacy claim that does not fix all three is not a claim. Most marketing
material fixes none of them.

## What this buys

Once disclosure is a coordinate, a policy is a table rather than a posture, and
the table can be published. A regulator can be given exact values immediately
while the market gets a boolean on a delay, and that difference is expressible,
auditable and enforceable in a contract rather than a matter of trust.

It also makes collusion checkable. If two observers who are each supposed to see
a coarse view can combine their views to recover the exact one, the policy is
weaker than it reads, and this is only visible when observers are a dimension
rather than an afterthought.

## Where it runs out

The lattice describes single disclosures well and repeated ones badly. A boolean
answered often enough stops being coarse, because the sequence carries more than
any one answer. Anything disclosed on a schedule needs a budget across time, not
just a coordinate at each point, and that is handled separately.
