# Rulebook and tariff

What this venue does, in the shape Form ATS-N asks for it. `Rulebook.sol` holds
the keccak256 of this file and the tariff of section 8 as one committed edition,
so neither half can move without the other.

Numbers are named, not quoted. Every charge is a deploy-time constant with a
derivation beside it, and section 8 says which getter returns it. A figure in
this document that disagreed with the chain would be a figure; `reconcile` reads
the chain.

## 1. What the venue is

A secondary market in tokenised collateral for repo, issued through the Asset
Tokenization Studio on Hedera. Two mechanisms: a sealed order book that clears
in discrete rounds, and a lender axe board that answers one bit per probe.

It is not a continuous market and does not claim to be one. Measured order
arrival is about 1.6 a day.

## 2. Who may participate

Eligibility is proved, not listed. A participant registers by presenting a zero
knowledge proof against the issuer's eligibility tree, and the venue learns a
nullifier rather than an identity. There is no membership list to read and no
seat to buy.

The registration transaction's gas is paid by the venue relay and zero is
debited to the signer, because a trader who funds their own gas creates a funding
history that links the nullifier to a fundable account.

## 3. Order types

**One.** A sealed limit order.

An order arrives as a single `bytes32` commitment over
`(domain, committer, side, price, qty, salt)`. Fixed length, so the calldata
carries no signal about size. It opens in a later window by revealing the
preimage, and a sell must be backed by an ATS hold before it can rest.

There are no market orders, no stops, no icebergs, no pegged orders, no
minimum-quantity conditions and no time-in-force beyond the resting term. The
commitment binds the committer, so a commitment copied out of the mempool cannot
be opened by whoever copied it.

## 4. Market data used

**Execution uses none. Collateral valuation uses two feeds, and one of them is
not ours.**

Nothing in the matching path consumes market data. The clearing price is the
venue's own uniform-price auction over sealed orders, there is no reference
price and no consolidated tape, and there is nothing upstream of a trade to lag
or to spoof.

The repo book is different, because a repo has to be marked. `PrimeOracle`
publishes what the collateral is worth and `RepoVault.markToMarket` acts on it.

| leg | what | source | scale |
|---|---|---|---|
| clean price | USD per unit of face, LPRC | quorum median over the venue's seated publishers | 8 dp |
| coupon reference rate | basis points, the rate the variable coupon resets against | the same panel, medianed separately | bps |
| HBAR/USD | the rate between the instrument's currency and the venue's settlement unit | a **seated upstream feed** in Chainlink's `AggregatorV3Interface` shape, currently Hedera's own network exchange rate at `0x168` | 8 dp |

The split is the rule. The venue publishes the price of its own instrument
because no one else quotes it, and it consumes the rate between two currencies
because it has no business inventing one. A venue that rebuilt the second would
be running a worse feed under the same interface.

The composite mark is `cleanPrice / hbarUsd`, in tinybars per unit of face. It is
computed in memory when a repo is marked and is never stored.

### 4.1 Bounds on the venue's own leg

- **Quorum.** A round is decided by a median over at least a strict majority of
  the seated panel. A median moves by at most one order statistic per dishonest
  answer, which a mean does not; the panel bound and the sweep behind that
  statement are in `probes/oracle-median.py`.
- **Heartbeat.** A price older than the published heartbeat is not a price. The
  venue refuses to act on it rather than reading through it.
- **Deviation.** A finalised round more than the published cap away from the
  last one is refused rather than accepted quietly. **The cost of this bound is
  stated rather than hidden:** a genuine move larger than the cap takes several
  rounds to walk, and until it does the feed goes stale and the venue falls back
  to the seat below. That is deliberate. An unexplained jump in a private bond's
  clean price is a bad publisher long before it is a market.
- **Seating.** Publishers and the upstream aggregator are both seated through
  the same propose-then-adopt epoch delay the rest of this venue's governance
  uses, so a change to who prices the instrument is visible an epoch before it
  binds. Adoption is permissionless.

### 4.2 The upstream leg, and what is actually seated

The seat is a governed address, not a constant, and it is held to the checks a
Chainlink consumer owes any feed: a non-positive answer, an unfinished round, an
answer carried forward under a newer round id, and a feed that reverts outright
all read as **dark**, never as a price.

**On this chain the seat does not hold a Chainlink feed, and the reason is
measured rather than argued.** Chainlink runs HBAR/USD on Hedera. Its proxies
are access controlled: a contract reading one is refused with `No access`, while
`decimals()` answers anyone. That is true of all seven feeds, on testnet and on
mainnet, and an `eth_call` cannot show it, because `eth_call` sets `tx.origin`
to its own `from` and the check passes. It takes a contract in the middle, and
`probes/chainlink-hedera.out` is that probe and its output.

What is seated instead is Hedera's own exchange rate, at the system contract
`0x168`, through the thin adapter `HederaRateFeed`. It is the rate every
transaction fee on this network is priced at, and it is readable by contracts
because being read by contracts is what it is for.

Two consequences are stated rather than left to be discovered.

- **It is not a market price.** Hedera's rate is governed and updated on the
  network's own schedule; a market feed is aggregated from exchanges. They do not
  agree. On 2026-09-07 the two differed by about 2.3 percent, and the probe
  prints the gap on every run rather than quoting a number that ages.
- **It cannot go stale, so the heartbeat does not bind this seat.** The rate is
  consensus state that every transaction in the block is already priced against;
  there is no last-update to report. The risk that replaces staleness here is
  divergence from the market, which a heartbeat cannot express, which is why it
  is written here in words. The heartbeat is kept at the publisher's own value so
  that it binds again the moment a readable market feed is seated in its place.

### 4.3 What happens when a feed goes dark

`RepoVault.postMark`, a seat held by a named margin engine, may post a mark by
hand. **It is reachable on no other condition:** while the feed is live it
refuses. So the discretionary seat cannot overrule a working price, and a feed
outage cannot freeze the repo book. Both halves of that are load-bearing.

A disclosure policy narrowed below what a price disclosure requires also takes
the feed dark, by the same path: the venue may not publish the price, so it does
not, and therefore does not act on one. That is the mechanism working rather
than a failure of it.

### 4.4 The surface this creates

A publisher who moves the mark can trigger a margin call on a counterparty. That
is a new surface, it is bounded by the deviation cap, the quorum and the cure
window, and it is written up beside the venue's other manipulation surfaces
rather than left to be found.

### 4.5 What the venue publishes

Governed per row by the disclosure lattice under a committed parameter root:
order size, order price, execution price, counterparty, the match predicate,
activity and account provenance. A print degrades to an order of magnitude, and
then to silence, before it will fail a trade. A clean price and a coupon
reference rate are terms of the instrument and are published exactly and at
once, on the same row as a maturity date. A mark, which is a price multiplied by
somebody's position, is not.

## 5. Execution and priority

Discrete-round uniform-price call auction with resting orders.

Price is the maximiser of executable volume; among those, the minimum imbalance;
among those, the midpoint. It exists only as `lo + hi`, at twice scale, because
rounding before multiplying by quantity is wrong by up to half the quantity.

Allocation is **price priority down to the marginal level, then pro rata by size
at that level.** There is no time priority anywhere in price determination: the
only timestamp a sealed book has is the reveal, and the trader chooses when to
reveal. Reveal order survives in exactly one place, the remainder of the pro rata
division, and moves at most `k - 1` minor units among the `k` orders sharing the
marginal level. That residue is stated rather than removed, because no allocation
of an integer volume across integer lots is both exactly proportional and
exhaustive.

`crossRound` is permissionless. The venue must not choose when to cross, because
choosing when to cross is choosing the price.

## 6. Order segmentation

**The book does not segment.** Every revealed order enters the same round and
faces the same rule. There is no separate pool, no counterparty class, no opt-out
from any category of participant, and no order type available to some
participants and not others.

**The axe board does, at the lender's election, and the values are published.**
A posted axe names a respondent class in FIX tag 1172:

| tag | class | who may probe |
|---|---|---|
| 1 | all | anyone registered |
| 2 | specified | a Merkle set the lender fixes at posting |
| 3 | market makers | as recorded by the respondent registry |
| 4 | primary dealers | as recorded by the respondent registry |

The class is set at posting and cannot be changed afterwards. This is
segmentation of *indications*, not of executions: an axe is not an order, and
whatever it leads to is a commitment in the same undivided book.

## 7. Halts and suspensions

**The venue has one halt, and it stops exactly one function.** `TradingHalt`
gates `crossRound`. Commit, reveal, cancel, expire, forfeit and withdraw stay
open, and the repo contracts do not reference it at all, so a halted venue
cannot trade and cannot stop anyone leaving. That is the property, and it is
tested: `test_aHaltStopsTheVenueTradingAndNeverStopsAnyoneLeaving`.

**A halt is a deadline and never a flag.** It expires by itself, and no call is
needed to end one. A halt that must be lifted is a halt whose lifting can be
declined.

Three bounds, and each is one of the disclosure regime's read in the mirror.
Narrowing what may be disclosed is the safe direction, so it is immediate and
unbounded. Halting is the deprivation, so it is the bounded one.

| | who | bound |
|---|---|---|
| halt | supervisor | at most `maxHaltSeconds`, which is immutable, and at most `budgetSeconds` granted per epoch |
| resume | supervisor | immediate, unbounded, and never required |
| breaker | nobody | arithmetic on the venue's own clearing price |

**In this deployment nobody can call the discretionary halt.** The supervisor
seat is held by `VolumeCap`, a contract with no path to `halt`, so the only
thing that can stop a round here is the breaker, and the breaker is arithmetic.
`test_inTheShippedDeploymentTheDiscretionaryHaltHasNoCaller` drives that
contract through everything it can be made to do and the venue stays open.

**The breaker cannot stop the round that breached it.** A sealed book has no
indicative price to collar, because the price does not exist until the round
clears. So the breaching round prints and the next one is halted. That is a
limit-move halt rather than an auction collar, and it is a stated limit.

A halted round is refused and not voided, so it crosses once the halt lifts.
The protection against a stale print is the limit and not the clock: every order
here is a sealed limit, so a late cross still executes inside the price its
owner named, and an owner who wants out has `expire`, which no halt can reach.

One suspension exists and it is not a halt. When the venue's deferred share of
volume exceeds the published cap, MiFIR Article 5's waiver suspension fires,
which **raises** the disclosure floor and compels the venue to print. It is
triggered by arithmetic anyone can run, on a call that takes no arguments and
checks nobody's identity. It restricts secrecy; it does not stop trading.

## 8. Tariff

Every line is `(source, reader)` on chain and `reconcile` reads it back. `payee`
of *nobody* is retained by the contract and no path pays it out.

| key | charged on | payer | payee | refundable | source |
|---|---|---|---|---|---|
| `book.commit.bond` | committing an order | participant | nobody | yes | `OrderBook.commitBond` |
| `book.commit.cancel` | voiding a commitment before reveal opens | participant | nobody | no | `OrderBook.cancelFee` |
| `book.commit.forfeit` | a commitment never opened | participant | counterparty | no | `OrderBook.commitBond` |
| `axe.post.bond` | posting an axe | participant | nobody | yes | `AxeBoard.axeBond` |
| `axe.probe.fee` | probing a cell | participant | counterparty | no | `AxeBoard.probeFee` |
| `axe.probe.slash` | failing to answer a probe | participant | counterparty | no | `AxeBoard.axeBond` |
| `repo.fail.penalty` | a close leg that did not settle | participant | counterparty | no | `RepoVault.penaltyRate` |
| `venue.take` | nothing | participant | operator | no | none, and zero |

`repo.fail.penalty` is a **rate** and not an amount: hundredths of a basis
point per day, charged on the cash that failed to arrive, from the intended
settlement date through to actual settlement. The unit is forced by the
regulation, which writes its rates to one decimal place of a basis point, so in
basis points the two bond rates would both be zero.

Four derivations, because a charge without one is a constant nobody can check:

- **`book.commit.cancel`** is `ceil(B * D / (D + W))` where `B` is the commit
  bond, `D` the reveal delay and `W` the reveal window. A phantom order can be
  bought by lapsing, costing `B` for up to `D + W`, or by cancelling at `t < D`,
  costing the fee for `t`. Requiring the second is never cheaper per second is
  `f / t >= B / (D + W)`, and the binding case `t -> D` gives the formula. The
  constructor enforces it. Read backwards it is a pro rata refund: pay for the
  fraction of the commitment's life you used.

- **`axe.post.bond`** is `M * (commitBond - probeFee) + 1`, where `M` is the
  outstanding-probe cap. The binding case is `M` concurrent yes-answers, and the
  bond must exceed what a lender saves by lying on all of them.

- **`book.commit.forfeit`** pays the sweeper because sweeping is work. A cancel
  creates none, so the cancel fee is retained instead: every candidate recipient
  of a cancel fee invents an incentive to want cancellations.

- **`repo.fail.penalty`** is CSDR Article 7, and the derivation is partly owed.
  The shape is derived: daily accrual from the intended settlement date, days
  rounded up so a fail of any length costs one, charged on the cash that failed
  rather than on the collateral, because a close leg fails on the cash side. The
  **rate** is not derived. Article 7 prices a cash fail at the overnight credit
  rate of the central bank of issue, floored at zero, and this contract has no
  oracle for that rate, so it is published and named as owed, which is the same
  disposition the Article 5 cap's own threshold carries. The security-side table
  the same field would take is 0.10 bp a day for sovereign debt, 0.20 for other
  bonds, 1.00 for a liquid share.

  Article 7(2) says the mechanism "shall not operate as a revenue source". That
  is a constraint on who is paid, and it is the one clause of the regulation
  this page can check rather than assert: the line names the counterparty as
  payee, so `netOperatorTake` cannot include it. `test_theFailPenaltyIsNotVenueRevenue`.

## 9. Venue revenue, and the open question that makes it zero

**`venue.take` is zero, and `netOperatorTake` returns zero across the whole
schedule.** No line pays the operator, there is no accrual, no treasury and no
revenue mechanism anywhere in the venue.

That is a disclosed gap and not a business model. Three shipped rules conflict:

1. The relay pays registration gas and recovers nothing. The cap on sponsorship
   is a denial-of-service control, and a bound is not a business model.
2. The relay must be operationally independent of the issuer, which means
   separate revenue. Per-trade attributable revenue rebuilds exactly the link
   sponsorship exists to break.
3. The known fix, charging in the settled asset and binding the fee into the
   proof, is closed by two prior rulings: fee arithmetic sits outside the
   circuit, so there is nothing to bind it into, and the no-leak result holds
   only because there is one cash token with the HTS fractional fee off.

Four routes could settle it, and none is chosen: fee in the settled asset bound
into the proof; fee in the guard layer; subscription priced per participant per
epoch rather than per trade; or the relay funded as public infrastructure that
never recovers. Each reopens something. A fee schedule written to close the gap
this week would be a number with no derivation, which is the defect this venue
refuses everywhere else.

**A rebate would appear here.** MiFIR permits venue rebates only under an
approved and public tariff structure. A rebate is a line with the operator as
payer and a negative contribution to `netOperatorTake`, published one epoch
before it takes effect like every other line. Nothing in the current schedule is
one.

## 10. Amendment

An edition is proposed by the operator and adopted by anyone, at the next epoch
or later. The operator cannot open its own commitment early, so the timing of
adoption is not a second discretionary signal.

The superseded edition stays checkable for 93 seconds after it is replaced: 90
seconds of off-chain conduct plus roughly 3 of Hedera consensus finality. A trade
already in flight is priced under the edition it was made against.

A schedule that does not agree with the code cannot be adopted at all. Each
sourced line is read back at adoption and refused on mismatch, so a false tariff
cannot be published truthfully.

## 11. Stated limits

- The breaker halts the round after the one that breached the band, not the
  round that breached it. A sealed book has no price to collar until it clears.
  Section 7.
- The discretionary halt exists and has no caller in this deployment, because
  the supervisor seat is held by a contract. Section 7.
- No venue revenue, and no derivation for one. Section 9.
- The settlement-fail penalty rate is published, not derived. The shape of the
  charge is derived; the number is owed. Section 8.
- A settlement day is 24 hours here and business days in the regulation, because
  the contract has no calendar. It over-counts across a weekend, in the
  direction that favours the party that was failed against.
- Rows 3, 4 and 5 are published at exact and immediate rather than deferred,
  because a public ledger has no observer set that holds a value the public does
  not. Commit and reveal moves *when*; it does not narrow *who*.
- The volume cap is the venue's own share against a configured ceiling, not the
  market-wide figure the regulation names.
- No per-holder revocation, no collateral substitution mid-term, no zero
  knowledge settlement.
- The liquidation auction discloses more than the rest of the system, and how
  much more is not settled.
