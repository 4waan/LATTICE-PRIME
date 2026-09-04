# Repo state machine

The lifecycle a repo passes through, and the decisions taken at each point.

## What repo is

One party sells a security and agrees to buy it back later at an agreed price.
Economically it is a secured loan: the seller gets cash, the buyer gets
collateral worth more than the cash, and the difference protects the buyer if
the seller fails to repurchase.

That difference is the haircut. It is set when the trade opens and it is why the
position has to be watched: if the collateral falls in value, the protection
erodes and the buyer calls for more.

## States

A repo here moves through opening, an open period during which it can be
margined, and then either normal maturity or default. Default paths matter more
than the happy path, because that is where the design earns its keep and where
most of the invariants live.

## Decisions taken

**Coupons on collateral belong to the seller.** The buyer holds the security but
not its economics, so payments received during the term are passed back. This is
standard and the design implements it rather than ignoring it.

**Haircut and initial margin are not the same thing** and the design keeps them
distinct, because they are quoted differently and conflating them produces
margin calls of the wrong size.

**Collateral substitution is out of scope for this version.** Letting a seller
swap one security for another mid-term is common in practice and adds a
significant amount of machinery. It is deferred deliberately rather than
overlooked.
