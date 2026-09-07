# The three that are left

Seams A and B are built (`src/policy/TransferPause.sol`, `src/policy/FreezeList.sol`,
30 tests). This is the plan for the other three, written before the code so the
constraints are visible rather than discovered.

> **1 is built and live.** `src/oracle/PrimeOracle.sol`,
> `src/oracle/HederaRateFeed.sol`, `RepoVault.markToMarket`, 62 tests, deployed
> to chain 296 and publishing. What the plan got right and what the chain
> corrected is at the bottom of the section, under *What actually happened*.
> 2 and 3 are unchanged.

Order is forced by a fact in `deployments/296-venue.json`: the bond is
`"kind": "bond, variable rate"`. A variable coupon resets against a reference
rate, and a reference rate is a feed. So the oracle is not third, it is first,
and the coupon schedule is its first consumer.

    PrimeOracle  ->  CouponSchedule + CouponDistributor  ->  ScheduledSettlement

## The five rules any of this has to survive

These are not style. Each one is load-bearing somewhere in the existing pitch,
and a feature that breaks one has broken the venue rather than extended it.

1. **Zero fork.** Attach at a measured seam or do not attach. Every new ATS
   call joins the seam call list in `src/interfaces/` with a note saying why,
   and `make census` regenerates `SeamMap.sol` rather than anyone editing it.
2. **Every event names a row.** Disclosing events route through
   `DisclosureView._emitUnder`, which withholds on an exhausted budget. A
   contract that opts out says why in its header, the way `FreezeList` does.
3. **A seam call is total.** No revert, no unbounded gas, one SLOAD where it
   can be. A revert on seam A, B or D is not a refusal, it is a bricked bond.
4. **Instrument data is public; positions are not.** Row 7 sits at
   `(exact, imm)` in the deployed matrix. A coupon rate, a clean price and a
   maturity date are terms of the bond. `rate x lot` is a position and is not.
   The line between them is where every disclosure argument below lives.
5. **Generated stays generated, and evidence is not assertion.** `make census`,
   `make vectors`, `make rulebook`, `make client`, `deployments/`.

---

## 1. `PrimeOracle` — asset pricing and NAV

*Named `MarkOracle` when this was written. `PrimeOracle` on the deployed
contract, after the venue itself was renamed to Lattice Prime: the feed carries
the venue's name and the mark is what it produces, not what it is.*

### What is wrong today

`RepoVault.postMark` takes a commitment from `marginEngine`, which
`script/DeployVenue.s.sol:172` admits is an EOA: *"`postMark` is a price feed's
call and this venue has no oracle wired. It is the one seat here held by an
address rather than by a contract."* The scorecard reads that as a role and not
a feed, and it is right.

There is a second problem the first one hides. `markCommitment` is a Poseidon
commitment justified by row 14, but `repo(id)` returns `collateralAmount` in the
clear in the same breath, and `RepoVault`'s own helper comment says so. A
commitment to `price x lot` where the lot is a public storage read protects
nothing against anyone who can also read a price. The commitment is doing less
work than its comment claims.

### What gets built

`src/oracle/PrimeOracle.sol`, plus `src/interfaces/IPrimeOracle.sol`.

- **Quorum median.** `submit(round, price)` from a seated publisher, one answer
  per publisher per round. `finalize(round)` sorts a fixed-size array and takes
  the median once `quorum` answers are in. Fixed size because the publisher set
  is bounded by an immutable, which is what keeps the sort a known cost.
- **Two seats, one pattern.** Publishers are seated through the propose/adopt
  epoch delay `ZkKycRegistry.proposeGate` already establishes, so a feed
  operator change is visible an epoch before it binds. There is no second
  governance idiom in the tree.
- **Heartbeat.** `stale()` is `block.timestamp > publishedAt + heartbeat`.
- **Deviation bound.** A finalized round more than `maxDeviationBps` from the
  last one is refused rather than accepted quietly. A feed that can jump is a
  feed that can call margin.
- **What it publishes.** The clean price per unit of face, and the reference
  rate the coupon resets against. Both are terms of the instrument, both are row
  7, both are `(exact, imm)` in the deployed matrix already.

### How it integrates

`RepoVault` gains `markToMarket(bytes32 id)`, permissionless:

    read latest()  ->  refuse if stale()  ->  mark = price * collateralAmount
                   ->  RepoMath maintenance test
                   ->  MARGIN_CALL and the boolean under row 14, as today

The mark is computed in memory and never stored. That is a strict improvement on
the current design: the number that must not be public is not written anywhere,
rather than written as a commitment whose preimage is two public reads away.

`postMark` stays and is narrowed to the stale-feed path. It is the documented
degradation, it keeps `RepoVault.t.sol` meaningful, and it means the feed going
dark does not freeze the repo book.

### How it is robust

- **Staleness refuses, never reads through.** `markToMarket` reverts
  `FeedStale(at, heartbeat)`. Acting on an old price is the failure that
  matters, and a margin call is not a place to be optimistic.
- **The multiply is bounded.** `price` is `uint128`, `collateralAmount` is
  bounded by the bond's `maxSupply` of 1,000,000, so the product cannot
  approach `uint256`. Asserted rather than assumed.
- **A new manipulation surface, declared.** A publisher who moves the mark can
  trigger a margin call on a counterparty. `docs/manipulation-surface.md` gains
  the row, bounded by the deviation cap, the quorum, and the cure window that
  already exists in `RepoVault`. `probes/market-abuse.py` gains the case.
- **Median tested against an oracle that does not share its code**, which is
  what `test/CallAuction.t.sol` already does for the clearing rule: a Python
  reference in `probes/`, fixtures committed, the Solidity checked against them.
- **Mutation check.** Deleting the staleness gate, and deleting the deviation
  cap, each has to fail a named test. The pause work found a headline invariant
  that survived its own mutation; that is the standard now.

### What else moves

`docs/RULEBOOK.md` §4 "Market data used" currently says the venue uses its own
clearing price and nothing else. That stops being true, so §4 is rewritten,
`make rulebook` reprints the hash and `test/Rulebook.t.sol` takes the new
constant. `tools/units.mjs` gains the price scale and `test/UnitVectors.t.sol`
gains its vector.

---

### What actually happened

Four things the plan did not know, in the order the chain taught them.

**The Chainlink leg does not exist, and finding that out cost a deployment.**
The plan said HBAR/USD comes from Chainlink, and Chainlink does run it on
Hedera: `probes/chainlink-hedera.out` reads `description()`, `decimals()`,
`version()` and a live price off all seven feeds on chain 296. Every one of
those is an `eth_call` from an account. **From a contract, every price read
reverts `No access`**, because the proxies are access controlled and the
controller admits a caller only when it is allowlisted or when `msg.sender ==
tx.origin`. `decimals()` is not gated, so `PrimeOracle`'s constructor check
passed, the seat took, the deployment succeeded, and the first `markToMarket`
reverted `CashFeedStale`. Measured again on mainnet: same revert. An `eth_call`
cannot show this, because it sets `tx.origin` to its own `from`, so
`FeedAccessProbe` went on chain to show it from inside a contract.

The venue behaved correctly the whole way through, which is the part worth
keeping: a leg it cannot read is dark, dark opens `RepoVault.postMark`, and
nothing was stuck. But the seat needed something readable, so
`src/oracle/HederaRateFeed.sol` wraps Hedera's own exchange rate at `0x168` in
the same `AggregatorV3Interface` shape. The interface stayed; the address behind
it changed. `docs/RULEBOOK.md` §4.2 states what that swap costs: the network's
rate is governed rather than market-derived, the two differ by around 2.3
percent, and divergence is a risk a heartbeat cannot express.

**A struct field called `at` is unreadable by the client.** `latest()` returned
one. `ethers` decodes a tuple into an array-like `Result`, so `result.at`
resolves to `Array.prototype.at`, and the Repo screen did arithmetic on a
function. Renamed to `publishedAt`, three contracts redeployed, and
`tools/gen-app.mjs` now refuses to bundle any ABI with a colliding member name.
That check found a second one the same minute, in `TradingHalt.Resumed`, which
needed no redeploy because an event topic hashes types and not names.

**A panel change mid-round had to be handled, and the plan did not mention it.**
Without a rule, a round straddling a seating is decided partly by publishers who
no longer hold a seat, and the array `finalize` sorts is no longer bounded by
`maxPublishers`. A seating now bumps a generation counter, which restarts the
open round in one write. It is the only version that cannot wedge.

**The permissionless mark closed row 16 rather than incurring it.** `postMark`
charged the cadence row because the engine marked on a schedule.
`markToMarket` is callable by anyone against a price the feed already published,
so its timing says nothing, and a mark that decides nothing emits nothing at
all. The row the plan carried as an open limit is not incurred on this path.

Live: `deployments/296-venue.json` `venue.feed`. Round 1 is three publishers at
99.75, 100.00 and 100.25, medianed to par, against HBAR/USD at 0.08064133.

---

## 2. `CouponSchedule` and `CouponDistributor` — coupons that pay

### What is wrong today

`RepoVault.noteCoupon(id, commitment)` takes the commitment as an argument from
any caller, with no check that a coupon fell due at all. The scorecard says
"coupons only, and only as a commitment"; the sharper reading is that the
commitment is **asserted rather than derived**. Nothing on chain connects it to
a coupon date, a rate, or the bond.

### What gets built

**`src/coupon/CouponSchedule.sol`** — the calendar as published instrument data.
Coupon dates, day count, and the spread over the reference rate, fixed at
issuance, hashed into the same root discipline `ParameterRoot` uses. Row 7. It
is the issuer's statement about the bond and it is public because a bond's
coupon calendar is public.

**`src/coupon/CouponDistributor.sol`** — the money.

- `declare(index, recordDate, entitlementRoot)`, funded in the cash asset before
  it is accepted. A declaration nobody funded is not a declaration.
- Entitlements are a keccak merkle tree over `(holder, amount)`, built off chain
  from the mirror node at the record date. **The same tree machinery as
  `ParameterRoot`** — `DOMAIN_LEAF`, `DOMAIN_NODE`, the ascending-key rule — so
  the repo has one merkle discipline and not two.
- `claim(index, amount, proof)` pays the cash token. Marked claimed before the
  transfer, so the external call cannot re-enter into a second payment.
- Unclaimed funds return to the issuer after `claimWindow`.

**The pass-through.** Title passed at T1, so the coupon reaches the lender, who
is not economically entitled to it. That is the existing `MANUFACTURED` state
and it is correct. The distributor pays the lender; `RepoVault.payThrough` moves
it to the borrower. Both legs now exist, where today only the second does.

**`noteCoupon` changes shape** from `noteCoupon(id, commitment)` to
`noteCoupon(id, index)`: it reads the schedule, refuses unless that coupon date
falls inside `[openedAt, maturity]`, and computes the obligation from the
schedule's rate and the vault's own stored lot. The event stays exactly what it
is today, a predicate under row 14. The disclosure does not widen; the *claim*
behind it stops being a caller's word.

### The custom fee, and why it is native

The cash asset is an HTS token created with a **fractional custom fee**, so the
paying agent's charge is collected by HTS itself rather than by EVM bookkeeping
this repo would then have to argue is correct. `spikes/d02-atomicity/fractional-fee.js`
already measured fractional fee behaviour; this promotes it out of the spike.
The tariff in `docs/RULEBOOK.md` §8 gains the row and names the fee schedule on
the token, so a reader can check the charge against the chain rather than
against the document.

### How it is robust

- **Idempotent claims.** `claimed[index][holder]`, set before the transfer.
- **Roots are fixed at declare.** No path moves one afterwards. A distributor
  that could restate entitlements after publishing them is a distributor whose
  root means nothing.
- **Funded or refused.** The contract can never owe more than it holds, checked
  at `declare` rather than discovered at the last claim.
- **A proof from one index cannot be spent against another.** The index is in
  the leaf, and `test_aProofFromAnotherCouponIsRefused` is that claim.
- Fuzz over generated trees, with the generator in `tools/` and its own
  `.test.mjs` vector file, on the rule that every client-side copy of on-chain
  arithmetic is checked before anything inlines it.

### The limitation that gets stated rather than papered over

The entitlement root is public and Hedera balances are readable from the mirror
node, so a determined observer can reconstruct who held what at the record date
without any help from this contract. That is a property of a public ledger and
not of this design, and it goes in the docs in the same register `docs/HCS.md`
uses for the relay's ability to stall: said plainly, not hidden behind a
mechanism that does not actually prevent it.

---

### What actually happened

Five things the plan did not know, in the order the build taught them.

**"The same tree machinery as `ParameterRoot`" was not a reuse, it was an
extraction.** `ParameterRoot` had the tree inlined, so honouring the rule meant
lifting it into `src/merkle/MerkleSet.sol` and moving the policy root onto the
library first, before a coupon existed to use it. That refactor is the reason
the repo has one merkle discipline rather than two, and it is also where the
discipline turned out to have a sharp edge worth naming: the tree **promotes**
an odd node rather than duplicating it, so a proof is positional. It carries a
position and the tree's width, and it is not the sorted-pair proof every
OpenZeppelin-shaped client library produces. A client that assumes sorted pairs
builds proofs this contract refuses, which is why `test/CouponFixture.sol`
carries the reference builder and calls itself that.

**`noteCoupon` was taking the caller's word for the number.** The old shape was
`noteCoupon(bytes32 id, bytes32 commitment)`, selector `0x2df30366`, and the
commitment was an argument. The vault has the lot, the schedule has the dates
and the spread, and the oracle has the reference rate, so the vault can compute
the coupon itself and the argument was a place for a caller to put a different
one. It now derives, at selector `0x2bae2cde`, and
`test_theOldShapeThatTookACallersWordIsGone` calls the old selector low level
and requires the call to fail.

**Deriving it brought an idempotence guard, and the guard changed what a silent
transaction means.** A coupon already noted returns zero rather than reverting,
because §3 puts this call behind a HIP-1215 `scheduleCall` and a scheduled call
that fires after somebody made it by hand has to be a no-op. That is a
successful transaction that reaches no `_emitUnder` and is not a withheld
disclosure, so `tools/hcs.mjs` flipped this selector's `sure` flag to false.
Under scheduling the second call is the ordinary case and not the rare one, and
leaving the flag set would have printed a silence that did not happen, which
that file's header names as the failure the venue cannot have.

**A fractional fee has a disposition that inverts who pays it.** The ordinary
case deducts from the amount transferred, so the holder receives the coupon less
the fee and the distributor's balance falls by exactly what it committed. A fee
schedule with `netOfTransfers` set charges the **sender** on top, and then every
payment costs the distributor more than it declared. The funding check at
`declare` cannot see it, and the shortfall would surface at the last claimant of
the last coupon, furthest from the schedule that caused it. `_pay` measures its
own balance either side of the transfer and refuses on the first claim, naming
the fee. Two extra reads on a path that already makes an external call.

**The invariant campaign measured nothing three times before it measured
anything.** `targetContract` exposes every external function, including the
handler's own `wire` setter, and the fuzzer spent 1826 calls, about eleven
percent of a campaign's depth, on re-wiring attempts that reverted;
`targetSelector` naming the eight drivers fixed it. Blind index draws over twelve
coupons rarely landed on one whose claim window was open, so the handler now
walks its own record of declared indices to the first coupon that is still
claimable. And the counters printed by `afterInvariant` come from the **shrunk**
replay rather than from the campaign, so they read zero whatever happened, which
is a diagnostic that looks like a result. All three are recorded in the handler
next to the measurement that motivated them.

The tariff line landed with the counterparty as payee, so `netOperatorTake` is
still zero and §9's headline survives. What §9 gained instead is a boundary: the
coupon leg puts a second HTS asset in the venue and that one's fractional fee is
on, which does not reopen the trading no-leak result because the coupon path has
no circuit, no proof and no order book on it.

Not live. The distributor needs a cash token with a fee schedule, and creating
that is a receipted HTS transaction rather than a Solidity `new`, so
`script/DeployCoupon.s.sol` takes `CASH_TOKEN` from the environment and refuses
to deploy without it.

---

## 3. `ScheduledSettlement` — the spike, shipped

### What is wrong today

`spikes/scheduling/ScheduleProbe.sol` proved a contract can schedule a call at
`0x16b` and let it fire with no keeper. It closed a design decision that had
been recorded as settled "pending spike 4". None of it is in `src/`.

### What gets built

`src/interfaces/IHederaScheduleService.sol`, vendored with a header naming
HIP-1215, and `src/schedule/ScheduledSettlement.sol`.

- `scheduleCall` at `0x16b`, with `hasScheduleCapacity` checked before paying.
- `extcodesize(0x16b) == 0` is detected, not assumed. On a chain without the
  system contract the call is recorded as `Unscheduled(id, reason)` and the
  fallback runs.
- The `scheduleAddress` is stored per obligation, so a client can link the
  pending settlement to HashScan.

Hooks: `RepoVault.open` schedules `markFail(id)` at maturity, and
`CouponSchedule` schedules `noteCoupon(id, index)` at each coupon date inside
the term. Both are the calendar of the instrument, executing itself.

### How it is robust

**The fallback is the invariant, and it is the whole safety argument.** Every
scheduled call has a permissionless manual equivalent that anyone may call once
the deadline has passed. Scheduling is an optimisation and never the only path.
That is what makes it safe to ship on a chain where the schedule queue can be
full, where the contract can run out of HBAR, and where a call can simply fail.

- Tested three ways with `vm.etch` at `0x16b`: a mock that succeeds, one that
  returns a failure response code, and an absent one. The fallback is asserted
  in all three, so a green suite cannot mean "we only tested the happy chain".
- **Targets become idempotent.** A scheduled `markFail` firing after someone
  already called it manually must return, not revert. Same for `noteCoupon`.
- Funding is checked before scheduling, and `fundedFor()` is a public read so a
  client can show that settlement is actually paid for rather than merely
  requested.

This is the same argument as `docs/HCS-SCOPE.md`'s. HIP-478 says there is no
consensus service system contract and an oracle is the specified pattern;
HIP-1215 says there *is* a schedule service system contract and this is it. In
both cases the venue uses the mechanism Hedera specifies, measures it, and
states what it cannot do.

---

## What moves in every one of the three

Easy to forget, and it is what "does not break the pitch" actually means here.

| | |
|---|---|
| `make census` | any new ATS call, regenerated not edited |
| `docs/RULEBOOK.md` + `make rulebook` + `test/Rulebook.t.sol` | §4 for the feed, §8 for the fee, §7a/§7b for pause and freeze |
| `docs/OUTLINE.md` | the working list and the not-built list both move |
| `make vectors` | every client-side copy of contract arithmetic |
| `make client` and `make app` | ABIs, address book, screens |
| `docs/manipulation-surface.md` | the feed is a new surface and gets a row |
| `NOTICE` | every newly vendored file, disclosed |

That last row is not housekeeping. The submission rules require every reused and
vendored piece to be declared, and this work vendors five interfaces so far:
`IExternalPause`, `IExternalControlList`, `AggregatorV3Interface` (Chainlink,
MIT), `IExchangeRate` (Hedera, Apache 2.0), and `IHederaScheduleService` to
come.
