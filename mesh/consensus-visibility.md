# What a Hedera consensus node sees

Notes on where a transaction becomes visible on Hedera, and to whom, before any
contract runs.

## The question

Hedera is often described as having no public mempool. That is true, and it is
routinely quoted as a privacy property. We wanted to know whether it actually is
one.

## What we found

It is not. There is no open mempool to scrape, but a submitted transaction is
gossiped in full to the consensus node set before it is ordered or executed. The
absence of a mempool removes anonymous public observation. It does not remove
observation.

The node set is small and named. It is not a permissionless crowd. A meaningful
share of it is financial institutions, some of them active in the same markets a
trading venue would serve. So the population that sees an order before execution
is both identifiable and commercially interested.

Two further points mattered for the design. The argument that this set is
trustworthy rests on governance arrangements that are themselves scheduled to
change, so a design that depends on it has a shelf life. And a submitter picks
which node receives the transaction first, which is the same act as choosing who
is in a position to delay it.

## Consequence for this project

Order contents cannot be left in the clear and be called private, whatever the
mempool situation. Orders arrive as fixed length commitments, so what reaches the
node set carries no size, no price and no side. This is the reason the venue does
not simply post limit orders and rely on the network.
