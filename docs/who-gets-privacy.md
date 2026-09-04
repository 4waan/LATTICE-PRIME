# Who gets privacy, and who decided

Every point in this system where someone has discretion over what another party
can see, and who holds that discretion.

## Why this is the central question

A privacy system is defined by its exceptions. The interesting question is never
whether data is encrypted; it is who can compel disclosure, under what
conditions, and whether the subject finds out.

A design that does not enumerate its discretion points has them anyway. They are
just undocumented, which means unaudited.

## The discretion points

There are several places where a decision is made about someone else's
visibility: who may register a participant, who may revoke eligibility, who sets
the disclosure policy parameters, who can compel a position to be revealed, who
may trigger a liquidation, and who can change any of the above.

For each one the design records who holds it, whether the subject is notified,
whether the action is logged where the subject can see it, and what stops the
holder from using it arbitrarily.

## The position

The regulator sees positions, on a published policy, without asking permission.
The market sees nothing about individual positions at any time. The counterparty
sees what the trade requires and no more.

This is deliberately not a system where nobody can see anything. That design is a
mixer, and it is unbankable for regulated assets. The claim here is narrower and
defensible: the holder does not choose whether they are visible to the
regulator, but nobody else gets that view by default, and every exception is
written down.

## What this does not claim

It does not claim the parameters cannot be changed. They can, by a named holder,
through a logged path. The claim is that the change is visible, not that it is
impossible.
