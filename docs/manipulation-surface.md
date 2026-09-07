# The manipulation surface

What a disclosure policy lets someone do, as opposed to what it lets them see.

## The gap

Privacy analysis usually stops at confidentiality: can an observer read a value.
That is the wrong question for a trading venue. The right one is what an
observer can profitably do with what the policy permits them to learn, including
things the policy considers harmless.

A boolean is not safe because it is one bit. It is safe or unsafe depending on
what an adversary can do with a stream of them.

## What we did

The disclosure policy was treated as an attack surface and worked through
adversarially: for each value the policy releases, to whom, and when, what
strategy does that enable, and what does it cost to run.

Several of the resulting attacks work against the policy as originally written.
They are not cryptographic breaks. They exploit the fact that a value released
repeatedly on a schedule carries information the same value released once does
not, and that an adversary can often choose when to provoke a release.

## The inversion

The most useful finding was that the strongest attacks run in the opposite
direction from the obvious one. Rather than an observer learning a position from
disclosures, an adversary induces disclosures by trading against a participant
and reads the response. The policy governs what is published, and it has nothing
to say about what an attacker can cause to be published.

This changed the design. Disclosure that responds to an event has to be
decoupled from the timing of that event, or the response becomes the signal.

## Consequence

Anything released on a trigger is released on a schedule that an adversary
cannot align to the trigger, and the amount released is budgeted over time
rather than evaluated per event.

## The feed, which is a surface the disclosure policy cannot reach

`PrimeOracle` added a mark to a venue that did not have one, and a mark is a
number an adversary would like to move. This is the one surface in this document
that is not about disclosure at all: nothing here is learned, something here is
*caused*.

### What a publisher can do

A seated publisher who moves the clean price moves every open repo's mark, and a
mark below the maintenance margin is a margin call raised against a counterparty
who has done nothing. The call starts a cure clock that ends in a default and a
liquidation auction, so the payoff is not the price, it is the collateral.

Three things bound it, and none of them is secrecy.

- **The median.** One dishonest answer moves the result by at most one order
  statistic, whatever value it carries, including the top of the type.
  `probes/oracle-median.py` brute forces that over 18,340 panels and prints the
  same sweep against the mean, where one liar drags the result to roughly
  `type(uint128).max / n`. The quorum is a strict majority because that is the
  largest number of dishonest answers the median survives.
- **The deviation cap.** A round more than the published cap from the last one
  does not land. An adversary with a majority of the panel does not get an
  arbitrary mark, they get the cap, once per round.
- **The cure window.** A call is not a liquidation. The borrower has a published
  window, and the window is an immutable rather than an argument precisely
  because `markToMarket` is permissionless.

### What it costs to run

A majority of the panel, and then one round per cap-width of price movement,
each of them visible, each of them attributable to the addresses that submitted
it, and each of them undoable by the panel's honest half at the next round. The
attack is not cheap and it is not quiet, which is the pair of properties the
venue is buying.

### The part that is not bounded, and is stated

**Submissions are open.** A publisher who answers last has seen the answers
already in, and can place their own to move the median by that one order
statistic in a chosen direction. Hiding the price in the event would not fix it:
`submit` takes the price in calldata and `panelOf` reads it back out of storage,
so an event that withheld it would be theatre, which is the trade this venue
already refused once in `RepoVault.close`. A commit-reveal on the panel would
fix it and is not built. It is recorded here as owed rather than defended.

### The other half of the feed

Everything above is about the leg the venue publishes. The cash leg is somebody
else's number, and the venue's exposure there is not manipulation but
**divergence**: Hedera's network exchange rate is governed rather than
market-derived, so an HBAR/USD that drifts from the market drifts every mark
with it, in one direction, for everyone. No adversary is required.

That is bounded by nothing in this contract, and saying so is the point. It is
not a staleness problem and a heartbeat does not detect it. What the venue has
instead is that the seat is governed rather than constant, the divergence is
printed on every run of `probes/chainlink-hedera.py`, and `docs/RULEBOOK.md`
section 4.2 states it as a term of the venue rather than burying it.

### The inversion, again

The pattern this document opened with runs here too, and in the useful
direction. `RepoVault.postMark` charged row 16 because the margin engine marked
on a schedule, so the sequence of marks was a cadence an adversary could align
to. `markToMarket` is permissionless and reads a price the feed already
published, so the timing of a mark carries no information about who chose to
look, and a mark that changes nothing emits nothing at all. The feed added a
surface and closed one.

## The coupon, where the surface is a date and not a price

`CouponDistributor` pays money against a tree the issuer built, and the number
an adversary would like to move here is not a price. It is **who was holding at
the record date**.

### What the issuer can do

`declare` takes a record date and the contract bounds it on both sides: not in
the future, because the mirror node cannot answer about balances nobody could
have read yet, and not after the coupon's own due date. Between those it is the
issuer's choice, and the choice is made *after* the balances exist. An issuer
who wants a particular holder paid less can look for the instant inside that
window where they held less, and declare against it.

Three things bound it, and again none of them is secrecy.

- **The date is published, at exact and immediate.** It is in the declaration,
  on row 7, attributable to the issuer's own address, one epoch after nothing.
  A record date picked to disinherit somebody is a record date anybody can read
  and nobody has to guess at.
- **The mirror node holds the other half.** Balances at any past instant are
  public, so the tree is checkable against the ledger it claims to describe.
  `test/CouponFixture.sol` is the reference builder precisely so a third party
  can rebuild the root and get the same answer or a different one.
- **The pool bounds the tree.** A tree whose leaves sum past what was funded
  runs out inside its own coupon rather than reaching another declaration's
  money. The loss falls on the last claimant of the same coupon, which is the
  place it can still be seen and argued about.

### The part that is not bounded, and is stated

**The contract verifies membership, not correctness.** `claim` proves a leaf is
in the root. Nothing on chain requires the root to agree with the balances at
the record date, because nothing on chain can read a past balance. A tree is a
claim the issuer makes by declaring it, checkable by anyone against the mirror
node and enforced by nothing here. That is the same disposition the panel's open
submissions carry above: recorded as owed rather than defended.

**The residue is the issuer's after the window**, so an issuer is better off
when a holder does not claim. What takes the edge off it is that `claim` is
permissionless and pays the leaf's holder rather than the caller: a holder who
never touches the chain can be paid by anybody who has the tree, and the tree is
public. Copying somebody's claim out of the mempool costs the copier gas and
sends the money where it was already going.

### The inversion, again

Two decisions elsewhere in this build removed surfaces here rather than adding
them. The paying agent's fee is a fractional custom fee on the token itself, so
there is no fee arithmetic in this repository to move and no rounding to farm;
the charge either is on the token's HTS fee schedule or it is not. And `claim`
is deliberately not metered, which is what stops the coalition budget from
becoming a weapon: on a metered payment path an adversary could spend a row's
budget on unrelated traffic and stop a coupon from being collected for a reason
that has nothing to do with the bond. `test_aCouponPaysWhateverTheMatrixSays`.
