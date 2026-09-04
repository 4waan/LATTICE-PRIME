# ATS end to end on testnet

Deploying a real security through the Asset Tokenization Studio, unmodified, and
driving it through its lifecycle to find out what the framework does rather than
what its documentation says.

## Result

Both objectives passed in a single session, for around ten HBAR of network fees.
A security was issued through the studio's own factory, an external compliance
contract of ours was attached at deploy time, and transfers were gated by it.

## What we were checking

Three things the design depends on.

That a venue can attach its own contract to the transfer path without forking
the framework or holding a privileged role afterwards. It can, because the
attachment points take their target from a deploy-time parameter.

That the attachment is genuinely consulted on the paths a repo uses, rather than
only on the simple transfer path. It is, though one attachment point is consulted
twice per transfer with different arguments, which is not obvious from reading
the source.

That a rejection from our contract stops the transfer rather than being logged
and ignored. On the seams we chose, it does.

## What we found that changed the design

Some attachment points treat silence as consent. An address that returns nothing
at all is read as approval on two of them, which means a misconfigured or
self-destructed compliance contract fails open rather than closed. We chose our
seams accordingly and wrote a wrapper that refuses to be ambiguous.

Separately, the transfer amount is not populated on most call paths, so a check
that wants to reason about size cannot read it where it would expect to. Size
policy in this project is therefore enforced where the value is actually present.
