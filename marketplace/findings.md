# What the study changed

The findings that altered the design rather than confirming it.

**Price and volume run on different clocks.** A venue can publish both and still
be consistent, because the two figures are not required to refer to the same
moment. Any privacy claim indexed on a single point in time is therefore
underspecified, and a disclosure policy has to describe a trajectory instead.

**A fifth mechanism exists.** Standard treatments list permissioning, delay,
aggregation and cryptography. Real venues also use conditional disclosure, where
information is released only when a stated event occurs. This is the mechanism a
margin call requires and it is the one this project implements.

**Derived facts are the real leak.** The dangerous disclosures are not published
fields. They are functions over published fields, and a policy indexed only on
the fields has nothing to say about them. Several of these were reconstructed
from public data during the study.

**Aggregate concealment has a legal ceiling.** There is a regulatory cap on how
much of a market may go dark, which means maximal privacy is not a design goal
even in principle. The target is a defensible position, not the hidden extreme.

**Consensus replication is disclosure.** In a book replicated across a node set,
whatever the book knows the node set knows. This is not a policy that can be
tightened. It is why orders arrive here as commitments rather than as orders.

**The highest-revenue venue in crypto discloses everything.** Concealment is not
what makes a venue viable, and the study does not support an argument that it is.
Privacy here is justified by the regulated-asset context, not by market appetite.
