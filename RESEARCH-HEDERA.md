# Hedera research

What the platform actually provides, established by measurement and source
reading rather than from documentation.

## What the platform gives us

The elliptic curve operations a proof verifier needs are present and correct,
and verification fits inside a normal transaction with room to spare.

There is a verifiable randomness source at the consensus layer, which is what
makes a proved random disclosure level possible. This is the single strongest
reason to build this here rather than elsewhere.

Transaction fees are low and predictable enough that a fee structure can be
designed around them rather than around volatility.

## What the platform costs us

Contract execution and native token operations do not share a failure domain in
the way a single-environment chain would give you. Atomicity across that boundary
has to be arranged deliberately and was verified by deliberately failing each
leg.

The transaction a participant submits is gossiped in full to the consensus node
set before it is ordered. There is no open mempool, but the absence of one is
not a privacy property, and the node set is small, named, and includes firms
with commercial interests in the same markets.

The token layer publishes holder registers and per-account compliance status to
anyone who asks. This is the constraint the entire design responds to.

## What would change this assessment

If the consensus node set were to grow substantially or become permissionless,
the visibility analysis would need redoing, in the direction of making the
commitment scheme more important rather than less.

If the randomness source were to change its guarantees, the disclosure
randomisation would need a different source, and the alternatives are worse.
