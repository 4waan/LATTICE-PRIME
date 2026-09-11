# Success

> **Rubric** (`JUDGING-CRITERIA.md`): "The extent to which the project impacts
> the growth and traction of the Hedera network and ecosystem." Guiding
> questions: more accounts created, more monthly active accounts, greater TPS,
> exposure to a greater audience.
>
> **23% weight under the project's adapted criteria.** Most teams score 1 here
> because they leave the argument implied. This file makes it explicit.

---

## The rule this file follows

Every number below is one of three things, and each is labelled:

- **`[MEASURED]`** taken from Hedera mainnet by
  [probes/network-baseline.py](probes/network-baseline.py), unauthenticated, no
  key and no relationship with any issuer. Captured output in
  [probes/network-baseline.out](probes/network-baseline.out). Re-runnable by a judge.
- **`[DERIVED]`** arithmetic from a `[MEASURED]` figure and our own design, with
  the assumptions stated inline.
- **`[PROJECTED]`** a forward claim. Named as such, never mixed into a table of
  measurements.

**No number in this file is quoted from a marketing page.** Hedera's advertised
throughput does not appear here. What appears is what the network was actually
doing when we measured it, because the rubric asks whether we move the real
number, and the real number is the only honest denominator.

---

## 0. The argument in five sentences

Hedera's institutional tokenisation is **issuance-only**: it creates accounts
that transact three or four times and then go quiet, and we measured that on
the flagship deployment rather than asserting it. A repo book is not a
position, it is a **schedule**, so it produces transactions every day a trade is
open, by construction rather than by user choice. Measured against the real
mainnet contract-execution rate, roughly **140 concurrently open repo trades
move Hedera's contract traffic by 1%**, and about **14,000 would double it**,
which is a handful of desks rather than a consumer-scale fantasy. The account
*count* is where this project honestly does not move the needle, and we say so
rather than inflate it. The account *activity* is where it does, and the
incumbent comparison is 9.4% monthly active against a design where an active
counterparty is active every month it has a book.

---

## 1. The denominators, measured

`[MEASURED]` mainnet, over an 880-second consensus window.

| Quantity | Value |
|---|---|
| Transaction rate, all types | **2.84 tx/s** = 245,337 per day |
| Contract-executing subset (`CONTRACTCALL` + `ETHEREUMTRANSACTION`) | **0.209 tx/s** = 18,057 per day |
| Accounts created | **1,403 per day** = 42,076 per month |

Composition of the 2,500 transactions sampled:

| Type | Share |
|---|---|
| `CRYPTOTRANSFER` | 73.5% |
| `CONSENSUSSUBMITMESSAGE` | 15.8% |
| `ETHEREUMTRANSACTION` | 3.8% |
| `CONTRACTCALL` | 3.5% |
| everything else | 3.4% |

Two things follow, and both matter for how this section should be argued.

**The relevant denominator is not the headline rate.** Our venue is contract
calls and HCS messages. Three quarters of mainnet traffic is plain HBAR
transfers we neither compete with nor add to. Measuring ourselves against
245,337 per day understates the effect; measuring against **18,057 contract
executions per day** is the honest comparison and it is a denominator a
single institutional desk can visibly move.

**The account creation rate is high enough that we should not claim it.**
42,076 accounts a month is a number an institutional bilateral product will not
meaningfully change. See §4, where we decline the claim.

> **Method note.** The account rate is taken from the **id delta** across a
> window of newly created accounts, not from a `CRYPTOCREATEACCOUNT` transaction
> filter. Hedera ids are monotonic (`marketplace/EVIDENCE.md` MK-010), so the
> delta captures alias auto-creations that the transaction-type filter misses.
> The filter would have reported 0.64% of traffic, roughly 1,570 per day by a
> different route, and would have silently excluded a whole creation path.

---

## 2. What institutional tokenisation on Hedera does

`[MEASURED]` Token `0.0.9379434`, the abrdn Liquidity Fund (Lux) US Dollar share
class, issued on Hedera mainnet by Archax, an FCA-regulated venue. This is the
deployment behind the Lloyds / Aberdeen / Archax trade that the Wholesale
Digital Markets Champion report cites as an exemplary achievement
(`HANDOFF.md` §2). It is the strongest institutional record Hedera has.

**23 accounts associated. 9 hold a non-zero balance. 8 of those are investors.**

Their entire on-ledger life:

| Account | Transactions, lifetime |
|---|---|
| `0.0.10420068` | 3 |
| `0.0.10420061` | 3 |
| `0.0.10420058` | 5 |
| `0.0.10420057` | 3 |
| `0.0.10420056` | 4 |
| `0.0.10420055` | 3 |
| `0.0.10420054` | 3 |
| `0.0.10420052` | 5 |
| **8 investor accounts** | **29 total, mean 3.6 each** |
| `0.0.10116630` treasury | 845 |

Monthly active, counted per calendar month rather than inferred from the first
and last dates:

```
  onboarding month   8/8 active   ########
  next month         0/8 active
  following month    1/8 active   #
  following month    1/8 active   #
  following month    1/8 active   #
```

**100% active in the onboarding month. 9.4% monthly active in every month
after.**

**This is not a criticism of Archax, and the file should not be read as one.**
It is what an issuance-only product *is*. A holder of a money market fund share
has nothing to do on-chain between subscription and redemption, so the ledger
correctly records nothing. The 845 transactions on the treasury are the issuer
doing mints, burns, and KYC administration: the issuer is busy and the investors
are inert, which is exactly the expected shape.

The point is what it says about the **opportunity**, and it is the whole basis of
this section:

> Hedera's flagship institutional tokenisation converts one onboarding event into
> one dormant account. Every account it creates is a one-shot. Nothing in the
> instrument generates a second transaction.

That is the gap. It is not a gap in Hedera and it is not a gap in ATS. It is a
gap in the **instrument being tokenised**.

---

## 3. Why repo is structurally different

A fund share is a position. **A repo is a schedule.** That is the entire
argument, and it is a property of the instrument, not of our implementation.

An open repo obliges both sides to mark collateral daily for the life of the
trade, to move margin when the mark breaches the haircut threshold, to observe
any coupon that falls inside the term from the fixed schedule and historical
rate, and to settle a close leg on a known date. Under this vault's hold-custody
model title stays with the borrower, so `noteCoupon` records the coupon without
inventing a second payment. None of those servicing dates depend on a user
choosing to log in.

### The per-trade transaction budget

`[DERIVED]` from the deployed `RepoVault` flow, D-11 (HCS audit trail), and D-12
(native scheduling).

**Assumptions, stated so they can be attacked:** one bilateral trade, 30-day
term, daily marking, exactly one margin call over the term, no coupon date inside
the term, no default. The oracle mark is excluded because it is one transaction
per day shared across every open position, so it does not scale per trade.

| Event | When | Signed by | Count |
|---|---|---|---|
| Funded offer | open | lender | 1 |
| Acceptance and ATS collateral hold | open | borrower | 1 |
| Principal withdrawal | open | borrower | 1 |
| Margin check | daily, 30 days | venue | 30 |
| Margin call, added collateral, cure | on breach | borrower, venue | 3 |
| Close and collateral release | maturity | borrower | 1 |
| Lender withdrawal | close | lender | 1 |
| HSS maturity observation | maturity | scheduled vault | 1 |
| HCS records | open and close | relay | 2 |
| **Total** | | | **41** |

**41 transactions per 30-day trade, sustaining 1.37 per day.** Of those, 39 are
contract-executing and 2 are HCS. The current vault schedules HSS two seconds
after the unchanged economic due time. Its funded canary returned `SUCCESS` in
an EVM block timestamped at economic due, so no manual fallback transaction was
needed. The previous exact-due vault's one-second clock boundary and successful
permissionless fallback remain historical evidence.

### The comparison, like for like

| | Fund subscription `[MEASURED]` | 30-day repo `[DERIVED]` |
|---|---|---|
| Transactions per relationship | **3.6, lifetime** | **41, per trade** |
| Repeats? | No. Terminal. | Yes. Every term. |
| Activity after month one | 9.4% monthly active | active every day the trade is open |

**An 11x difference on the first trade, and the fund number never repeats while
the repo number repeats every 30 days.** A counterparty rolling a book
continuously produces roughly 12 trades a year against the fund holder's one
subscription.

### The honest cost of this argument

`[ASSUMPTION]` **The daily margin check could be batched.** Nothing forces one
transaction per position per day; N positions can be marked in one call, and
`DESIGN-DECISIONS.md` D-08 already chose batch verification over recursion for
the proof path. Batching would cut the dominant term of the table above and
therefore **reduce** our TPS contribution.

We are flagging this rather than hiding it because a judge who knows the domain
will ask, and because it is a genuine design tension: the cheapest system and the
highest-TPS system are not the same system. Our position is that per-position
marking is correct for a bilateral venue at the scale we are building, since it
keeps each counterparty's mark independently auditable on the ledger, which is
the property `DESIGN-DECISIONS.md` D-11 exists to protect. If the venue later
batches, this section's numbers fall and we would rather be caught having said so.

---

## 4. Accounts created: the claim we decline

`[MEASURED]` Hedera creates **42,076 accounts per month**.

`[PROJECTED]` Our design creates accounts on two paths. Each counterparty needs a
trading account. Beyond that, `SECURITY-MODEL.md` §4.4 and `marketplace/EVIDENCE.md`
MK-010 together force **per-epoch address rotation**: because Hedera account ids
are monotonic and creation timestamps are public to the second, a registration
address is a cohort fingerprint, so a counterparty that reuses one address across
epochs is linkable across them. Address rotation is a privacy requirement here,
and it has an account-creation side effect.

50 counterparties on monthly epochs is 600 accounts a year, or **1.6 per day.**

**Against 1,403 per day that is 0.1%, and we are not going to claim it as
impact.** An institutional bilateral repo venue does not move an account counter,
and a submission that claims it does is telling the judge it has not checked.
The rubric asks the question; the honest answer for this project is that account
creation is the wrong metric for it, and §5 is the right one.

We would rather lose a fraction of a point for candour here than have the rest of
this file read as promotional.

---

## 5. Monthly active accounts, where the argument is actually won

The rubric asks about accounts created **and** monthly active accounts as separate
questions. They behave completely differently for this project.

| | Measured incumbent | This design `[PROJECTED]` |
|---|---|---|
| Accounts created | 8 investors, one cohort | small, see §4 |
| Monthly active, after onboarding | **9.4%** | an account with an open trade is active every month |

A repo counterparty is active in a month if it has any trade open, and the whole
economic point of a repo book is that trades are always open. There is no state
in which a participating desk is dormant, because dormancy means it has closed
its book.

`[DERIVED]` Under the §3 budget, **a single counterparty with one continuously
rolled trade produces about 500 transactions a year** (41 per trade, 12.2 trades
a year) against the measured incumbent's 3.6 for the lifetime of the
relationship. That is a **139x difference in on-ledger activity per relationship**,
and unlike the account count it is a number this instrument genuinely produces.

**This is the sentence for the pitch:** the project does not bring Hedera more
accounts. It brings Hedera accounts that come back.

---

## 6. TPS: what it would actually take

`[DERIVED]` from §1 and §3, at 1.30 contract-executing transactions per day per
open trade.

| Target | Contract tx/day needed | Concurrently open trades |
|---|---|---|
| Move contract traffic 1% | 181 | **~140** |
| Move contract traffic 10% | 1,806 | **~1,400** |
| **Double contract traffic** | 18,057 | **~14,000** |

And against total mainnet traffic, the harder denominator:

| Target | Total tx/day needed | Concurrently open trades |
|---|---|---|
| Move all mainnet traffic 1% | 2,453 | **~1,800** |

**Read the first table honestly.** 140 open trades is one desk having a normal
book. That is a real claim and it is small enough to be credible. 14,000 open
trades doubling Hedera's contract execution is a handful of mid-size repo desks,
which is a plausible medium-term outcome for a market whose own regulator has
stood up a 54-firm taskforce with an end-to-end repo use case as its named next
workstream (`HANDOFF.md` §2).

**What we are not claiming.** This is not a high-TPS system and we are not going
to dress it as one. Institutional bilateral repo is low-frequency by design; a
desk does not want its collateral moving at 10,000 tx/s. The reason the numbers
above still land is not that the venue is busy, it is that **Hedera's contract
execution denominator is genuinely small right now**, so a real institutional
workload is visible against it rather than lost in noise. That is a fact about
the current network, it will change as the network grows, and this file should be
re-run before it is cited again.

---

## 7. Audience: exposure that has already happened

This is the one part of the Success argument that is not a projection, because
the outreach is already done.

`[MEASURED]` Six validation approaches sent (`VALIDATION.md` Targets). Each one
is a named institution or individual being told, in writing, that a repo venue
is being built on Hedera:

| Target | Audience reached |
|---|---|
| **ICMA ERCC** | Owns the GMRA, the standard repo agreement. ~120 member firms. |
| **Archax**, Graham Rodford (CEO) | The FCA-regulated venue that executed the UK-first tokenised gilt collateral trade on Hedera. |
| **ioBuilders / ATS maintainers** | The firm that actually builds ATS, via a GitHub issue on the public repo. |
| **Peter Left**, Lloyds Banking Group | Head of Digital and Markets Innovation. Runs Project Agora, digital gilts, and Great British Tokenised Deposits. |
| **Allan Trimmer**, Aberdeen | Head of Product. |
| Plus the academics and practitioner channel | Queued, `VALIDATION.md` T5. |

This is exposure to **UK wholesale finance**, which is not Hedera's existing
crypto-native audience and is precisely the "wider, new audience" the rubric asks
about. The taskforce that these firms sit inside was stood up by a report to the
Chancellor that sizes tokenisation at £33bn added annual UK output and £14bn of
tax revenue (`HANDOFF.md` §2).

`[PROJECTED]` The Open Source track compounds this. Upstream contributions to
`hashgraph/asset-tokenization-studio` put this work in front of the ATS
maintainers permanently rather than only for the duration of a submission. Two
are identified and ready: the reference `IExternalKycList` implementation, and
the scheduled-tasks test failures documented in the ATS repo and still unfixed
(`DESIGN-DECISIONS.md` D-12).

---

## 8. What this submission has already put on Hedera

`[MEASURED]` Not a projection. Live, on-ledger, and verified.

| What | Where | Evidence |
|---|---|---|
| 3 Groth16 verifier contracts | testnet, `exact_match` on Sourcify | `spikes/bn254/stage2/` |
| An ERC-3643 bond via the shipped ATS factory | testnet `0x893AB1A7...B328`, `exact_match` | `spikes/ats/README.md` |
| Our own `IExternalKycList` seam contract | testnet `0x1B9B5E61...0C83`, `exact_match` | `spikes/ats/README.md` |
| A compliance-gated transfer, blocked then allowed | 9 transactions, 10.22 HBAR | `spikes/ats/run.out` |
| Bound RepoVault v5 and MarginWatch | testnet `0.0.10454144`, `0.0.10454146` | `venue/deployments/296-venue.json` |
| Funded offer, ATS hold, cash withdrawals, close and release | 5 successful bound-vault receipts | `venue/deployments/financing-hss-canary.json` |
| Automatic HSS settlement | due plus two-second schedule, `SUCCESS`, no manual fallback receipt | `venue/deployments/financing-hss-canary.json` |
| Historical HSS boundary and permissionless settlement | scheduled revert plus successful fallback receipt | `venue/deployments/financing-beat.json` |
| Margin, cure, coupon, fail penalty, default and collateral execution | 20 successful receipts on a separate compressed demo vault | `venue/deployments/financing-lifecycle.json` |
| Canonical LPRC coupon zero | archived record-date ownership, 228 gross LPCASH, and both holder claims | `venue/deployments/bond-coupon-zero.json` |
| Complete ATS bond lifecycle | 10,000-unit issue, coupon snapshot and claim, then full maturity redemption | `venue/deployments/bond-lifecycle.json` |

The bond was deployed through **the ATS team's own unmodified testnet factory**,
not a fork, which is the Integration claim and the Success claim at once: this is
additional real usage of infrastructure Hedera and ioBuilders already shipped and
are already paying to run. The financing records add a real lender deposit,
borrower withdrawal, ATS collateral custody, servicing calls, and default
execution rather than counting deployment transactions as lifecycle evidence.
The canonical coupon record closes the live LPRC coupon gap. The separate
compressed ATS record proves issuance, a record-date snapshot, cash payment, and
full maturity redemption while leaving the production binding and its published
maturity untouched.

---

## 9. What would falsify this

Stated so the argument can be attacked rather than admired.

| Claim | What kills it |
|---|---|
| The incumbent is issuance-only and dormant | A single institutional Hedera deployment with sustained monthly active holders. Re-run §2 against other tokens; if one shows recurring activity, the framing weakens. |
| 140 open trades moves contract traffic 1% | Mainnet contract execution growing an order of magnitude. The denominator is the snapshot in §1 and it is the load-bearing number in §6. |
| 41 transactions per trade | A decision to batch daily marks (§3, stated). Batching to 1 call per day across all positions cuts the figure to roughly 11 per trade and the §6 table by about 4x. |
| Repo generates recurring activity | Validation replies saying desks would run marking off-ledger and settle only the net. **This is a live question in `VALIDATION.md` Group B and the answers are not in yet.** If practitioners say marking stays off-ledger, §3 loses its dominant term and this file needs rewriting, not defending. |
| The audience claim | Zero replies. Messages sent is exposure; a reply is engagement. §7 claims only the former. |

**The fourth row is the real risk**, and it is unresolved on purpose. The
validation outreach in §7 is partly designed to answer it, which is why
`VALIDATION.md` and this file are the same workstream rather than two.

---

## Sources and reproduction

```
python3 probes/network-baseline.py
```

No key, no account, no funding. Roughly 90 seconds against the public mainnet
mirror node. Captured output: [probes/network-baseline.out](probes/network-baseline.out).

> **Instrument warning, recorded because it silently produced a wrong answer
> during this work.** The mirror node's `/api/v1/transactions?account.id=`
> endpoint scans in fixed **60-day windows**. An empty page means "nothing in
> this window", not "nothing for this account", and it is returned as **HTTP 200
> with a valid `next` cursor either way**. A loop that stops on the first empty
> page reports **zero transactions for every account**, which is what our first
> pass reported for all nine holders including the treasury. The probe now walks
> back to each account's own creation timestamp and prints whether the walk
> completed, so a truncated count can never be presented as a total. See
> `AUDIT-BOX.md` AB-030.

| Figure | Source |
|---|---|
| Rubric text and weights | `JUDGING-CRITERIA.md` |
| Mainnet rates, fund register, holder activity, monthly active | `probes/network-baseline.py`, this file §1, §2, §5 |
| The fund as flagship institutional issuance | `marketplace/EVIDENCE.md` MK-008, MK-011 |
| Monotonic ids, cohort inference | `marketplace/EVIDENCE.md` MK-010 |
| Per-trade budget inputs | `DESIGN-DECISIONS.md` D-03, D-08, D-11, D-12 |
| Address rotation requirement | `SECURITY-MODEL.md` §4.4 |
| Market context, taskforce, £33bn | `HANDOFF.md` §2 |
| Outreach targets | `VALIDATION.md` Targets |
| On-ledger artefacts | `spikes/ats/README.md`, `spikes/bn254/stage2/`, `venue/deployments/` |
