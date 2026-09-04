# The ATS transfer path

Notes from reading the Asset Tokenization Studio transfer path end to end, to
find where a venue can attach without forking anything.

## What we were looking for

ATS runs a transfer through a chain of checks before it moves balance. Some of
those checks call out to addresses supplied when the security is deployed. Those
call sites are the seams. If a seam is real, a venue can decide whether a
transfer happens by supplying its own contract at deploy time, and the ATS tree
stays untouched.

## What we found

There are five such call sites on the path. All five take their target from a
deploy-time parameter, so occupying one needs no change to ATS and no privileged
role afterwards.

They do not behave the same way when the target misbehaves. Two of them treat an
empty answer as approval, so an address that returns nothing at all passes the
check silently. The other three reject on anything they do not understand. That
split decides which seam a compliance decision can safely live on, and it is the
main reason this project sits where it does.

Three further details shaped the design. One seam is called twice on a single
transfer, and the two calls carry different arguments. The transfer amount is
not populated on most paths, including the ones a repo actually uses, so a seam
that wants to reason about size cannot read it from there. And freeze is an
accounting adjustment rather than a gate, so it does not do what a venue would
want a freeze to do.

## Consequence for this project

We occupy two seams and fork nothing. The security is deployed through the ATS
factory unmodified, and a small contract of ours decides whether a transfer
happens. Sizing policy is enforced where the amount is actually available rather
than where it is merely expected.
