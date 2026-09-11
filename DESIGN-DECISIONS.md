# Design Decisions

**Status:** living record of design decisions.

One entry per real choice. A choice with no cost stated is not a decision, it is
a preference, so every entry names what was given up. Entries are never deleted;
a reversed decision is marked `SUPERSEDED` and keeps its original reasoning, in
the same discipline as `AUDIT-BOX.md`.

**Markers** as in `SECURITY-MODEL.md`: `[MEASURED]`, `[SOURCE]`, `[DERIVED]`,
`[OPEN]`.

**Status values:** `SETTLED` (do not reopen), `OPEN` (a decision still owed),
`SUPERSEDED` (reversed, reasoning kept).

| # | Decision | Status |
|---|---|---|
| D-01 | Bilateral repo, not tri-party | SETTLED |
| D-02 | Mint our own cash leg, as HTS | **SETTLED, both sub-questions measured.** AB-039, AB-042 |
| D-03 | Repo open leg is two ATS holds, and therefore not clearing | SETTLED, cost re-measured |
| D-04 | Haircut, expressed once | SETTLED |
| D-05 | One circuit ships, a second is stretch | SETTLED |
| D-06 | Sealed-bid over Dutch auction for liquidation | SETTLED |
| D-07 | Occupy the seams, do not fork ATS | SETTLED, and wider than first stated |
| D-08 | No recursive aggregate proving. Batch verification instead | SETTLED |
| D-09 | Proof system: **PLONK** over bn254 | **SETTLED, on measured gas.** AB-044 |
| D-10 | Fee and settlement arithmetic stays outside the circuit | SETTLED, conditional on D-10a |
| D-11 | HCS for the audit trail, not contract events | SETTLED |
| D-12 | Native scheduling, not a keeper bot | **SETTLED, spike 4 ran and passed.** AB-040 |
| D-13 | Internal KYC off, so the public register is never written | **SETTLED.** Contract path proven on testnet; UI path traced in source, AB-036. The seam is a first-class Studio feature. Live browser confirmation still owed |
| D-14 | Monotone ramp instead of a hard LIS threshold | **CUT** by the demo script. No beat, and remaining capacity is full. Reasoning kept below |
| D-15 | Pin the node, and only because the fallback ships with it | **SETTLED**, on a measurement that showed we were not pinned. Supersedes the earlier ruling |
| D-16 | **The nullifier: preimage, rotation, and the revocation window** | **SETTLED. Closes O3, hole H3.** The circuit interface is frozen. **Amended by INV-23, INV-24, INV-25, none of which touches a public input, and by D-18, which does** |
| D-17 | The project is called **Seam** | **SUPERSEDED by D-21.** The reasoning for *seam* survives intact and is quoted forward; what failed was the bare word, which collides with this repository's own primitive and with a US commodities trading platform literally named The Seam |
| D-21 | The project is called **SeamMe** | **SUPERSEDED by D-25.** The collision analysis survives intact and is quoted forward; what failed was that the name carried the attachment point rather than the innovation |
| D-25 | The project is called **Lattice Prime** | **SETTLED. Supersedes D-21.** The lattice is the part with no prior art on any chain, and the name now carries it. Renamed on the live bond via the ATS Core facet, two transactions, no redeploy |
| D-22 | **The venue prices nothing, and cost recovery collides with relay independence** | **`[OPEN]`.** Raised by `docs/fee-mechanics.md` FM-05. Three shipped rules conflict and none of them knows it. Not a v1 blocker: what is owed is the disclosure, not the mechanism. **Disclosure discharged** by the published rulebook and tariff; the decision stays open |
| D-23 | **A halt is the mirror of the ceiling, not a pause key** | **BUILT.** `venue/src/policy/TradingHalt.sol`. Halting is the leaky direction, so it is capped by an immutable grant, budgeted per epoch, and expires by itself. It gates `crossRound` and nothing else. Amends the rulebook's section 7, which said the venue had no halt |
| D-24 | **A settlement fail is not a default, and `maturity` was never read** | **BUILT.** `FAILING` between `OPEN` and `DEFAULTED`, with a CSDR Article 7 accrual. Closes a hole rather than adding a feature: `close` had no maturity check and the only route to `DEFAULTED` needed a margin call |
| D-18 | **One public input binds the proof to its registration** | **SETTLED. Amends D-16's frozen interface.** Nullifier squatting is a known bug class fixed the same way in Zcash, Tornado Cash and Semaphore; our variant misattributes identity in the compliance record rather than merely denying service. One field, before the circuit compiles. AB-057 |

---

## D-01 · Bilateral repo, not tri-party
**Status:** SETTLED · `HANDOFF.md` §6

Tri-party adds a collateral agent role and roughly doubles the state machine.

**Why.** Bilateral is what the Woolard taskforce is testing first, and it is what
can actually be finished without tri-party complexity.

**Cost.** Tri-party is where the real operational complexity in repo lives,
including collateral substitution and the agent's optimisation. We do not touch
it. A domain judge may ask; the answer is that it is a roadmap item and we know
which one it is.

---

## D-02 · Mint our own cash leg, as an HTS token
**Status:** SETTLED, and the risk that made it conditional is closed · AB-039 ·
`HANDOFF.md` §6, `STUDY_PLAN.md` F6b

Rather than depending on HBAR price movement or a bridged stablecoin.

**Why.** Tokenised commercial bank money is what the report is actually about, so
this is the more realistic construction, not the more convenient one. HTS also
carries fractional custom fees, which is the only honest route to the
fee-schedule extra point, since ATS securities are pure EVM Solidity diamonds and
outside HTS scope entirely. `[SOURCE]` `HANDOFF.md` §2.

**Rejected alternatives, with reasons.** Crypto-native stablecoin: wrong
instrument for a wholesale settlement story. Off-chain fiat: destroys atomicity
outright and there is nothing to demo.

**The risk, and it was hole H4.** The security is an EVM diamond. The cash is an
HTS token. Atomic DvP means both legs settle or neither does, and those are two
different systems. **`[MEASURED]` They share a rollback boundary.**
1. ~~Can an EVM contract move an HTS token inside the same transaction that
   executes an ATS hold?~~ **YES. AB-039, three arms on testnet.** An HTS
   transfer followed by a revert moves nothing; the same is true when the revert
   happens in an inner frame the caller catches, which is where a two-subsystem
   design would most plausibly leak; and the composite, HTS cash moving and then
   an ATS transfer failing on its own terms, rolls the cash back. Each arm
   carried a control that moved the balance by exactly the amount under test, so
   the zeroes are results. **"Atomic DvP" stays in the README, unqualified for
   the single-transaction construction the design actually uses.**
2. ~~A fractional custom fee means the recipient receives less than the contract
   computed.~~ **MEASURED, AB-042, and it is worse than rounding.**
   `fee = max(min, floor(amount * num / den))`, taken out of the amount. With
   `min = 0` everything below `den/num` units moves free, so the fee is avoidable
   by fragmenting and 400,000 units move for nothing in 1,002 transfers. With
   `min = 1` a one unit transfer delivers **zero** to the recipient and does not
   revert. Neither default is safe, so the settlement contract computes the
   delivered amount itself and rejects a leg that does not deliver what the trade
   requires. **D-02 is now fully settled.**
   Also: a fee schedule key must be set at token **creation** or fees can never
   be attached. The first cash token we minted lacked it and is permanently
   incapable of carrying a fee.

**Stated fallback, now unused.** ~~Cash leg as a plain ERC-20 we mint.~~ Kept on
the record because the fallback existing is why D-02 could be settled before the
risk was measured. Taking it would have cost the fee-schedule extra point for
nothing.

**One implementation note that comes out of the same run.** The HTS system
contract at `0x167` answers an unknown selector with success and empty
returndata rather than reverting. Our cash-leg code must decode the HTS response
code and not treat "the call did not revert" as success. AB-037, AB-039.

---

## D-03 · Repo open leg is two ATS holds, and therefore not clearing
**Status:** SETTLED, with the cost now measured rather than assumed
**Evidence:** AB-009, `mesh/transfer-path.md` F-03, F-05, F-06

The repo contract is the designated `escrow` on two ATS holds. No custom escrow
code.

**Why.** Less work, and higher Integration score, because the track brief asks
for the SDK as it stands.

**What changed since the decision was taken.** `HANDOFF.md` §5 counted `clearing`
as a free settlement primitive alongside holds. It is not.
`onlyClearingDisabled` sits on hold **creation** as well as on every direct
transfer, so activating clearing reverts `createHoldByPartition` and takes the
entire hold API with it, maturity redemption included. `[SOURCE]` AB-009,
`HoldByPartition.sol:49,81`.

> **Clearing is a rail selection, not an addition. Picking one costs the other.**
The decision stands and now has a price attached. Two further costs, both
measured, both design-affecting:

- **Hold creation runs no compliance and no identity check at all.** A fully
   denying compliance module cannot stop a hold being created toward an unverified
   address. `[SOURCE]` F-05.
- **Hold execution is gated, but ATS hands the compliance seam
   `(address(0), to, 0)`.** The held amount is not passed. A size-dependent policy
   at seam C is blind on exactly this rail. `[SOURCE]` F-05.

**Consequence, recorded so it is not rediscovered:** if the venue needs a
size-dependent rule at settlement, it lives in the repo contract, not in the
compliance module. The only place in the whole path that sees a real amount on
every route is the **write** side of seam C (`transferred` / `created` /
`destroyed`). `[SOURCE]` F-06.

---

## D-04 · Haircut, expressed once
**Status:** SETTLED · `HANDOFF.md` §6

Haircut and initial margin are two statements of the same overcollateralisation
with different denominators. We pick one, name it in the code, and say which in
this file.

**Why.** Mixing them is the classic tell that the team has not done repo.

**Decision:** haircut, applied to collateral market value. Initial margin appears
nowhere in the codebase, including in variable names.

---

## D-05 · One circuit ships, a second is stretch
**Status:** SETTLED, do not reopen · `HANDOFF.md` §6, `STUDY_PLAN.md` F5c

- **Ships: ZK-KYC via `IExternalKycList`.** The only one that touches ATS, zero
   fork, demos in the official Studio UI, upstream-contributable. Lowest risk,
   highest Integration.
- **Stretch: sealed-bid auction.** Highest innovation, best domain story, earns
   the word "market."
- **Dropped: ZK margin adequacy.** `IMarginCheck` ships as an interface with a
   plain implementation, so the roadmap stays credible at the seam.

**Why the second circuit is cheap.** Marginal cost is roughly 30 percent, not 100
percent: same Circom toolchain, same verifier pattern, one shared setup. Note
that the last clause is only true under D-09's PLONK branch; under Groth16 each
circuit needs **its own phase-2 ceremony**, and the marginal cost is higher than
30 percent. This is one of the inputs to D-09.

---

## D-06 · Sealed-bid over Dutch auction for liquidation
**Status:** SETTLED · `HANDOFF.md` §6

Commit phase with a proof that the bid clears reserve and is funded, then **only
the winner opens. Losing bids are never revealed.**Why.** The real problem in a forced liquidation is that everyone can see you are
a distressed seller. Publishing your valuation of a distressed gilt basket is
itself a disclosure, and in lattice terms every losing bid that opens is an
avoidable term in the observer's join.

**Cost, stated rather than hidden.** Commit-reveal is slower than a descending
clock, and speed matters in a stressed market. A judge who knows auctions
respects the acknowledgment more than a clean claim.

**Related:** the auction is a configuration of one market engine, not a separate
machine. See `HANDOFF.md` §5 gap closer 1. A Dutch auction and a compliance-gated
order book are the same engine with a different clock.

---

## D-07 · Occupy the seams, do not fork ATS
**Status:** SETTLED, and the surface is wider than first documented
**Evidence:** `mesh/transfer-path.md` F-01, F-02, F-10, AB-002, AB-003, AB-004

`HANDOFF.md` §2 documented one injection point. There are **five**, and each one
alone blocks a transfer that otherwise succeeds. `[SOURCE]`

| Seam | Interface | Sees | Fails |
|---|---|---|---|
| A | `IExternalPause.isPaused()` | nothing, not even a selector argument | closed |
| B | `IExternalControlList.isAuthorized(address)` | one address | closed |
| **C** | `ICompliance.canTransfer(from, to, value)` | **the amount** | **OPEN** |
| D | `IExternalKycList.getKycStatus(address)` | one address | closed |
| E | `IIdentityRegistry.isVerified(address)` | one address | **OPEN** |

**Decision: occupy D, and C if a size-dependent policy is needed.** D is the
narrowest seam and the safest to demo. C is the only seam receiving the amount
and the only **writable** one, via `transferred` / `created` / `destroyed`.

Three facts that constrain how, all measured:

- **All five are fields of `IFactory.SecurityData`, wired by the stock factory at
   deploy time.** Not a post-deploy retrofit and not a fork: you hand the factory
   five addresses. `[SOURCE]` F-01, F-10. **The seam has to be planned for at
   issuance**, which puts it in the demo script, not in a later transaction.
- **The two ERC-3643 seams (C and E) fail open when unset.** A misconfigured
   module is silently permissive. `[SOURCE]` F-02, AB-003, AB-004. Anything we put
   at C or E must be verified live, not assumed present.
- **Registering an external KYC list that answers GRANTED makes `grantKyc`
   revert.** The two halves have an ordering constraint and it goes in the demo
   script. `[SOURCE]` AB-012, F-09.

**Also recorded:** nothing in ATS has a reentrancy guard. `[SOURCE]` AB-011,
F-08. Our contracts carry their own; we do not inherit one.

---

## D-08 · No recursive aggregate proving. Batch verification instead
**Status:** SETTLED · new, 
**Evidence:** `SECURITY-MODEL.md` §8

The question raised was whether to build three layers (private state,
cryptographic state, ZK validity) with state transitions as the basis, aggregating
bid rules, matching, fee calculation and settlement into recursive proofs. It is
the right architecture for a scalable private market. It is not this one.

**Two reasons, and the second is the real one.**
1. `[MEASURED]` Recursion on bn254 means verifying a bn254 pairing inside a bn254
   circuit: non-native field emulation, millions of constraints, hours of proving.
   The standard escape is a two-chain such as BLS12-377 with BW6-761, and Hedera
   forecloses it. BLS12-381 at `0x0b` to `0x11` is **absent** and present on the
   Ethereum control. bn254 is the only pairing-friendly curve available on-chain
   here.
2. `[DERIVED]` **It contradicts D-07.** Zero-fork means ATS's unmodified transfer
   path enforces eligibility, which puts canonical state in ATS storage, publicly.
   Canonical state cannot live in both an accumulator we advance and a diamond we
   do not control. One of them owns it, and D-07 already chose.

**What ships instead.** Batch verification of Groth16 proofs sharing one verifying
key: `n + 3` pairs rather than `4n`, break-even at n = 2, about 3.0x at n = 8 and
4.0x at n = 32 against the measured gas schedule. Derivation, caveats and the
soundness requirement on the Fiat-Shamir randomizers are in `SECURITY-MODEL.md`
§8.2. It needs no recursion, no new curve, and no new ceremony.

**The roadmap shape, if state transitions are wanted later.** Scope the
cryptographic-state layer to the **order book only**: a commitment over open
orders, ours and small, advanced by a proof that a match applied the bid rules
correctly. Settlement executes in the clear against ATS.

> **The circuit proves the match was fair. The chain proves the settlement was
> legal. Neither trusts the other.**

**Cost.** We do not get to say "recursive SNARKs" in the pitch. Given that the
frame explicitly does not lead with ZK (`HANDOFF.md` §4), this costs less than it
appears to, and a measured 4x batching result is more defensible in five minutes
than an unmeasured recursion claim.

**Checked against an outside source, AB-067.** arXiv:2409.01976
measures a batching optimisation saving 73 percent on Ethereum and only 26 percent
on Hedera, because Hedera meters `LOG` and `SSTORE` as rent rather than at a flat
rate. **That erosion does not touch these numbers.** What it batches there is
Merkle inserts, dominated by storage; what is batched here is pairing checks,
priced off the `45,000 + 34,000k` precompile schedule already `[MEASURED]` on
Hedera. The 3.0x and 4.0x stand. The finding lands instead on `PLONKISH.md` §2.5's
on-chain accumulator, which is storage-dominated and which that section already
declines in favour of HCS data availability.

**One correction this forces elsewhere.** `[DERIVED]` The disclosure class of an
aggregate is the **join** of its leaves' classes. So batching reduces gas and does
**not** reduce disclosure: n batched proofs still publish n public-input vectors.
Anyone reaching for batching as a privacy improvement has made an error.

---

## D-09 · Proof system
**Status:**SETTLED: PLONK.** Decided on measured
numbers rather than the inferred ones this entry was carrying · AB-044
**Evidence:** AB-044, `spikes/d09-plonk/`, `SECURITY-MODEL.md` (trusted setup, verifier, post-quantum posture)

~~**Current position: Groth16 over bn254, circom plus snarkjs.**~~ **DECIDED:
PLONK over bn254, circom plus snarkjs.** Both systems were built over one
circuit and measured on Hedera the same hour, each against a corrupted-proof
control. See the table below, now `[MEASURED]` on both rows.

The Groth16 figure this entry carried, **214,202** for one public signal and
**6,647** per additional signal, was taken by driving the precompile sequence
directly and remains correct for that. Through a deployed Solidity verifier the
same proof costs **228,649**, which includes intrinsic and calldata cost.

**Why not a post-quantum system.** The objection is correct that bn254 is not PQ,
and the conclusion usually drawn from it is wrong. Groth16 zero knowledge is
**perfect**; the PLONK that shipped blinds the witness polynomials, so hiding
does not rest on discrete log remaining hard. There is no harvest-now-decrypt-later
risk from the proof. What breaks is soundness: a quantum adversary can forge a
live eligibility proof. That window is the current epoch, not a settled trade
(settlement is not proved) and not the MiFID II retention clock. The
confidentiality risk that does not expire is viewing-key encryption of
supervisor records, **when that channel exists**. The F5b / D-16 linkage is
designed and not in `kyc.circom`; HCS carries policy metadata, not
ciphertexts. The fix for that channel is ML-KEM and never touches a circuit.

The proving-system migration is not deferred by preference. Hedera verifies
bn254 pairings and nothing else on-chain at bounded cost: BLS12-381 is absent
(D-08), and FRI / STARK proofs hit the 128 KiB calldata wall (AB-031) or wrap
back into bn254, which is Plonky2's own answer and does not remove the
assumption. Full argument in `SECURITY-MODEL.md`, post-quantum posture.

**Why not Plonky2 specifically.** It is FRI over Goldilocks, hash-based,
plausibly post-quantum, and fast at recursion. Its proofs are 100KB or more and
there is no production Solidity verifier. Plonky2's own answer to on-chain
verification is to wrap the final proof in a Groth16 proof over bn254, which is
what Polygon zkEVM does. So adopting it does not remove the bn254 dependency, it
adds a layer above it. `[INFERRED]`

**The swap that is actually on the table, and it is not Plonky2.**
| | Groth16 | PLONK (bn254, snarkjs) |
|---|---|---|
| Ceremony | **one phase-2 per circuit** | **none.** Universal setup, Hermez ptau directly |
| Verify gas on Hedera | **228,649** `[MEASURED]` | **322,697** `[MEASURED]`, was inferred at ~290,000 and that was 10% low |
| Percent of the 15,000,000 ceiling | 1.52 | **2.15** |
| Deploy gas | 345,578 | 1,224,531, one time |
| Deployed verifier | 1,352 B | 5,417 B, against an EIP-170 limit of 24,576 |
| Proof calldata | 637 hex | 1,729 hex, against a cap of 131,072 B |
| Valid / corrupted proof | `true` / `false` | `true` / `false` |
| A circuit change | new ceremony | free |

D-05 plans two circuits, so Groth16 costs two project-specific ceremonies, each a
trust assumption to defend and a piece of work to do. PLONK removes phase 2 from
the project entirely, at **41 percent** more gas against a **15,000,000** ceiling
we would then be using **2.15 percent** of. `[MEASURED]`

**The argument the original entry understated.** Every change to a Groth16
circuit invalidates its zkey and needs a fresh contribution. In this build the
circuit changes repeatedly, so the cost is not two ceremonies, it is a ceremony
every time anyone touches the circuit. PLONK makes iteration free.

> That is trading a resource we have in abundance for a risk we cannot otherwise
> remove, which is the stated priority: the fix is not worth spending on,
> optimising safety is.

**~~Inputs still needed before deciding:~~ all resolved.**
- ~~O4, max calldata per Hedera contract call.~~ **CLOSED, AB-031: 131,072
   bytes.** PLONK's proof calldata is 1,729 hex characters, about 0.7 percent of
   it. Proof size does not bear on this decision at all.
- ~~Does PLONK even verify on Hedera.~~ **MEASURED, AB-044.** It does, it
   rejects a corrupted public signal, and its verifier fits EIP-170 at 5,417
   bytes. This input was not on the original list and should have been: it was
   the only one that could have invalidated the choice.
- D-08's batching derivation is Groth16-specific. PLONK proofs also batch, via
   batched KZG openings, but the numbers in §8.2 need redoing. **Still owed, and
   it is now a sizing question rather than a decision one.**
- Proving time on a laptop for the actual circuit, not the trivial one. **Still
   owed**, and it bites PLONK harder, since PLONK proving is slower than Groth16.
   It affects the demo's timing, not the design.

**The sentence this buys the security model:** *this project has no trusted
setup of its own.* It inherits a universal ceremony with public transcripts
rather than asking anyone to trust entropy generated by us in a build.
That is worth more than 94,048 gas.

**Sequencing rationale.** `STUDY_PLAN.md` sequencing says Part II finishes before
substantial contract code, because D9 determines the circuit interface and
reworking it afterwards is the expensive failure mode. The proof system sits
underneath that, so it decides first.

---

## D-10 · Fee and settlement arithmetic stays outside the circuit
**Status:** SETTLED, conditional on D-10a below · new, 
**Evidence:** `SECURITY-MODEL.md` §2.3

Bid rules and matching go in the circuit. **Fee calculation and settlement amounts
do not.** They are recomputed in plain Solidity from the published execution price
and quantity.

**Why, and it is a security argument rather than a gas one.** A compromised
trusted setup breaks soundness: someone can prove a match that never cleared. A
plain Solidity check over public values **cannot be forged by a broken CRS,
because it does not depend on the CRS.** Putting value conservation outside the
circuit means the worst a broken setup buys is unfair ordering, not theft.

This is the guard layer. Two of its members already exist as artifacts:
`spikes/bn254/stage2/src/GuardedVerifier.sol` and `CappedVerifier.sol`.

**Cost.** The fee becomes public.

**D-10a, the condition.** `[OPEN]` This holds only if the fee does not leak
counterparty tier. If a tiered fee schedule identifies the counterparty class, the
fee moves back inside the circuit and this decision is `SUPERSEDED`. Resolve when
the fee schedule is designed, and record the answer here.

---

## D-11 · HCS for the audit trail, not contract events
**Status:** SETTLED · `HANDOFF.md` §4

Every supervisor disclosure is written to the Hedera Consensus Service.

**Why.** Consensus timestamps on disclosure events are a Hedera-native primitive
that is not cheaply reproducible elsewhere, and "the audit trail covers the
auditors" is the sentence that makes the venue institutional rather than a dark
pool. It is also the strongest genuinely Hedera-specific argument in the design,
which is what the Integration section rewards.

**~~The unresolved half, and it is the most probeable claim in the pitch.~~
CLOSED, AB-043.** The construction forces the record and no downgrade
is needed. Make the topic's submit key a **contract id**: our own key is then
refused with `INVALID_SIGNATURE`, and only the contract can authorise a write,
through HIP-755 `authorizeSchedule`. Authorising and then reverting leaves the
topic **empty**, so the disclosure secret and the audit record are one event
rather than two. When the record cannot land, `authorizeSchedule` returns 206
rather than reverting, so release can be conditioned on it. See
`SECURITY-MODEL.md` §5.1 and AB-043.

Residual, and it is policy rather than platform: the spike's contract authorises
anything it is asked to. Conditioning release on the correct record for the
correct disclosure is ordinary contract logic and is the next piece of work.

---

## D-12 · Native scheduling, not a keeper bot
**Status:** SETTLED, and spike 4 has now run · AB-040 · `HANDOFF.md` §5,
`STUDY_PLAN.md` F6c

ATS scheduled tasks for lifecycle events, HIP-755 / 756 scheduled transactions for
the repo close leg.

**Why.** A keeper bot is off-chain infrastructure that has to be running for the
system to be correct, which is exactly the "no machine gets authority" rule
inverted. Native scheduling also covers the Scheduled Transactions extra point
twice over.

**Cost.** ~~It depends on a path we have not executed.~~ **Executed,
AB-040.** A contract called HIP-1215 `scheduleCall` at `0x16b`, scheduled a call
back into itself 90 seconds out, and it fired 8 milliseconds after its expiry.
The mirror node records the schedule as a child of the creating transaction with
`payer_account_id` set to the contract's own account, so nothing off chain
created it, signed it, or paid for it. **The keeper fallback is not needed and
the docs do not have to hedge.**
The real cost is where it was not expected: **scheduling is the expensive half.**
1,434,866 gas to create the schedule against 0.0414 HBAR to execute it. A close
leg that rolls should extend an existing schedule rather than cancel and recreate
one.

**Note.** `packages/ats/contracts/SCHEDULED_TASKS_ISSUES.md` documents about
twelve failing scheduled-task tests from the `EvmAccessors` migration, still
unfixed. `[SOURCE]` `HANDOFF.md` §2. That is simultaneously a risk to this
decision and the cheapest credible upstream PR in the repo.

---

## D-13 · Internal KYC off, so the public register is never written
**Status:** HALF SETTLED. Contract path proven on testnet; UI path still open.
**Evidence:** AB-001, `STUDY_PLAN.md` finding B, `spikes/ats/README.md`

`internalKycActivated` is a flag with a public toggle, settable at issuance. With
it off, `verifyKycStatus` collapses to the external seam alone, `grantKyc` is
never called, and the plaintext credential ids and public investor register never
exist. `[SOURCE]` `KycStorageWrapper.sol:206-209`, `Factory.sol:614`.

**Why it matters.** This upgrades the pitch from "we add privacy beside the public
register" to **"the register is never written."** `HANDOFF.md` §2(b) treats the
register as a hole to work around. It is a default that can be turned off.

**Probe, first half discharged.** Spikes 2 and 3 issued a bond
through the ATS team's own unmodified testnet factory with
`internalKycActivated = false`, registered our `IExternalKycList` implementation,
and drove a transfer that reverted `InvalidKycStatus()` while the seam denied and
succeeded once it granted. So the contract path behaves exactly as this decision
assumed: with the internal flag off, `verifyKycStatus` collapses to the external
seam alone and `grantKyc` is never called, so **the plaintext register is never
written**. `[SOURCE]` `spikes/ats/README.md`, bond `0x893AB1A7...B328`.

**The half still open is the UI.** Does the Studio web app render a security whose
internal KYC is off, or does it assume a populated register? **If the UI breaks,
the "demoable in official tooling" Integration advantage is lost**, and that
advantage is the entire reason D-05 picked the KYC circuit. This is spike 2 step 5
and it needs the Studio running locally against the shipped deployment. Run it
before the demo script is written.

---

## D-14 · Monotone ramp instead of a hard LIS threshold
**Status:**CUT by the demo script.** No beat in the five minutes
and the remaining capacity is already over-subscribed. Reasoning kept below, because the
ramp is the right construction if this is ever built past the prototype
**Evidence:** `privacy-abstraction/DISCLOSURE-LATTICE.md` §III.2, §III.3

D8 hides size and price pre-trade for block-size orders only, and D9 requires a
named threshold constant.

**The problem.** A hard constant on a vague predicate creates a cliff, and cliffs
get gamed. Splitting orders to sit under a size threshold is documented behaviour
around MiFID II LIS thresholds. `[SOURCE]`

**The fix, and it is cheap.** A monotone ramp removes the gaming edge and stays
inside the monotonicity requirement the policy needs anyway. The construction
worth keeping: let the fixed-point scale grow as `s^d` rather than rescaling at
each step, and compare once at the end against a threshold scaled to match. That
is `d` multiplication gates and **one** range proof, instead of a range check per
level.

**Why it is optional.** One constant and a handful of constraints, but it touches
the circuit, and the circuit is the long pole. Do it only if the circuit verifies
early. **Deliberately excluded** alongside it: a general quantale evaluator,
tensor in the circuit, and any graded-truth machinery beyond this single ramp. The
algebra's value in this build is as a specification and a checking
discipline, not a runtime.

---

## D-15 · Pin the node, and only because the fallback ships with it
**Status:** SETTLED. **Supersedes the earlier ruling below**, which
was "pin, disclose, claim nothing," taken because no fallback existed. The
fallback now exists as a design, so the decision is a different one
**Evidence:** MK-025, `[MEASURED]` `probes/node-pinning.out`,
`SECURITY-MODEL.md` §6.4, [DEMO-SCRIPT.md](DEMO-SCRIPT.md) §3.2

### What was measured first, because it changes what the decision is

`[MEASURED]`, `probes/node-pinning.py` against our own operator on
testnet, 100 records:

| | nodes | busiest node holds |
|---|---|---|
| **our account now** | **7** | **18.6%** of 86 top-level records |
| the mainnet institutional comparator, MK-025 | 1 | 100% of 190 |
| mainnet baseline, MK-025 | 28 | 7% |

**We are not pinned. The SDK is choosing a node per transaction and we never
noticed.** So D-15 is a change we would be making, not a property we already
have, and writing "we pin submission" in the README would have been false.
The probe existed to make that failure impossible rather than to confirm a
guess.

### What pinning actually buys, stated narrowly

Not fewer observers. A transaction reaches one node and is then gossiped, so
AB-008's 29 named pre-consensus observers all still see it.

> **Pinning chooses the first observer, not the only one. What is being assigned
> is the head start, and the head start is one gossip interval.**
That is worth having for an order venue, and it is worth saying at exactly that
size. The claim available to us is a disclosure claim:

> Every venue participant submits to the same named node, so the pre-consensus
> head start is uniform across participants and is held by one party who is not
> a participant, and we say who it is.

The receiving node is a public field on every transaction record, so that
sentence is checkable by anyone against the ledger rather than trusted.

### The fallback, and the one fact that makes it sound

The cost that blocked this earlier decision: **a pinned node is the only
party who can silently drop you**, and a precheck failure never reaches
consensus, so it leaves no on-ledger trace. Choosing an observer and choosing a
censor is one action.

The fallback is a retry ladder, and it is safe because of a detail of the
transaction format:

> `[SOURCE]` A `TransactionID` is `accountID` plus `transactionValidStart`.
> `nodeAccountID` is a **separate field of `TransactionBody`** and is not part
> of the id. So the same transaction id can be re-signed for a second node, and
> Hedera's duplicate detection admits at most one of them.
> **A fallback cannot double-execute**, which is the property that would
> otherwise make retrying a settlement transaction unacceptable.

```
sign body for N1, submit, start timeout
  consensus seen at the mirror node within δ_n -> done
  timeout expires -> re-sign the SAME
    transaction id for N2
  N2 expires -> N3
  ladder exhausted -> fail, loudly, to the operator
```

`δ_n = 10 s`, against a measured Hedera finality of roughly 3 to 5 seconds and a
`transactionValidDuration` of 180 s. Three rungs is 30 s and leaves 150 s of
validity unused, so the ladder never races its own expiry.

**Owed probe, and it is small.** Submit one transaction id to two nodes and
confirm exactly one reaches consensus while the other returns
`DUPLICATE_TRANSACTION`. The paragraph above is `[SOURCE]`, read from the
protobufs, and this file's own rule is that a fix inherited from a
specification is an assumption until it is run. **Do not ship the ladder on the
source read alone.**
### The liveness story, and the part of it that does not work

A node that drops one participant selectively is indistinguishable from a node
that is slow, on any single observation. It is distinguishable in aggregate: the
**fallback rate per participant** is measurable, and a censoring node makes one
participant's rate diverge from the rest. Publishing that count per participant
per epoch to the HCS topic would put censorship in the audit trail instead of
leaving it invisible.

**That mechanism does not work at our volume, and the numbers are our own.**
D-16 sets the epoch at 30 days and `SUCCESS.md` §3 puts a counterparty at
roughly 12 trades a year. So the sample is about one observation per participant
per epoch.

> **A divergence test over a sample of one is not a test.** The censorship
> detection is real arithmetic at venue scale and is decoration at ours, so it
> is not claimed, not built, and recorded here as the reason.

What survives is the liveness half, which does work: the ladder converts a node
outage from a venue outage into `δ_n` of added latency per transaction.

### The decision, and why it is one item rather than two

**Pinning without the fallback makes the venue strictly less available than not
pinning at all**, because it trades N nodes' worth of redundancy for one node's
uptime and buys nothing back. So these are not an item and an enhancement:

> **Pin and build the ladder, or do neither. The fallback is the precondition
> for pinning, not an improvement on it.**
Cost: roughly half a day, and `DEMO-SCRIPT.md` gives it no beat, so under that
file's own rule it needs a written justification to exist. It has one, and it is
the sentence above: the alternative to building it is not "pin without it," it
is "do not pin." **If capacity bites, drop both**, and the loss is one
Integration sentence rather than a capability.

### What was given up

| Given up | For |
|---|---|
| The fairness claim | A disclosure claim that is checkable against a public field. "One named party has the head start and we say who" is smaller than "the venue is fair" and it is true |
| Censorship detection | Saying why it does not work at our volume. It needs a sample this venue does not generate, and shipping it would have been a mechanism that could never fire |
| Half a day, if it ships | Not trading 7 nodes of redundancy for 1 |

---

### Superseded ruling, kept per this file's rule

> **Decision: pin, and treat it as a disclosure rather than as a mechanism.** We
> do not claim node choice as a fairness property. That claim needs a fallback
> path and a liveness story, because a pinned node is the one party that can
> silently drop us. That is build work, and the demo script has no beat for it.
> **Cost: one Integration sentence we could have said and will not.**
Still correct on the fairness claim, which is refused here too. Wrong in
assuming the fallback was expensive enough to leave undesigned: it is a
timeout, a re-sign and a counter, and the reason to design it turned out not to
be the fairness claim at all but the fact that pinning without it is a
regression.

## D-16 · The nullifier: preimage, rotation, and the revocation window
**Status:** SETTLED. **Closes O3, the last open item that could force
a rewrite.** `STUDY_PLAN.md` hole H3
**Amended, three times, by the re-derivation of `BUILD-PLAN.md` §7.3's
J4 downgrade.** INV-24, INV-25 and INV-23 in `docs/market-invariants.md` §F. **None
of the three touches a public input, so the frozen interface below is unchanged**,
which is the only reason they are amendments rather than a reopening. The
amendments are stated in place, marked, and collected at the end of this entry.
**Evidence:** AB-026, AB-035, AB-043, AB-044, `SECURITY-MODEL.md` §4, §5,
`privacy-abstraction/DISCLOSURE-LATTICE.md` §II, §III.4, `STUDY_PLAN.md` D9a, D11d

This is a design sitting, not a measurement. It fixes three things: what is
hashed, what rotates and when, and the size of the revocation gap. `STUDY_PLAN.md`
puts it before contract code because it determines the circuit's public inputs
and the registry's storage layout, and reworking either afterwards is the
expensive failure mode.

### The finding that kills the direction we were carrying

`SECURITY-MODEL.md` §4.1 carried `nullifier = H(credential_secret, epoch)` with
the secret "known only to holder and issuer." **That construction hands the
issuer a silent deanonymisation oracle and it has to go.**
> `[DERIVED]` **For a hash-based nullifier over a bounded credential set,
> recognising one nullifier and enumerating all of them are the same
> computation.** The issuer holds every credential secret. Answering "who is
> behind this nullifier" is one Poseidon evaluation per candidate; building the
> entire epoch's nullifier-to-identity table is the same loop, run to the end. A
> credential universe the size of the Woolard taskforce is 54 evaluations. There
> is no parameter choice that makes the first cheap and the second expensive.

The consequence is not a performance problem, it is the frame breaking.
`HANDOFF.md` §4 promises "every disclosure is itself written to HCS" and adds
"the audit trail covers the auditors too." AB-043 built the forcing construction
that makes that true, by binding the topic's submit key to a contract id so the
release and the record are one event. **An issuer who can compute the table
offline never touches that contract**, so the forcing construction would have
been bypassed by the one party it exists to bind, and the strongest claim in the
pitch would have been decorative in exactly the place a judge probes first.

So the preimage is chosen to make the issuer structurally unable to compute the
nullifier at all.

### The preimage

Written as it will appear in the circuit.

```
Issuance, once per credential:
  s_h                              holder secret, one bn254 scalar, sampled by the holder
  C_h = Poseidon(s_h)              commitment, the only thing the issuer sees
  cred = (cid, C_h, attrs, expiry)
  sigma = EdDSA_issuer(Poseidon(cid, C_h, attrs, expiry))

Per registration:
  n = Poseidon(s_h, DOMAIN, ctx)   the nullifier, public
  R = r * G                        ephemeral key, public, r fresh per registration
  ct = cid + Poseidon(r * pk_D)    the linkage, public
  pk_D = pk_I + pk_V               2-of-2, additive, PoP on each share

  DOMAIN = 1 for KYC registration, ctx = epoch
  DOMAIN = 2 for a sealed-bid auction, ctx = auction id
```

| Term | Held by | Why there |
|---|---|---|
| `s_h` | the holder, alone | the issuer must not be able to compute `n` |
| `C_h` | published in the credential | binds `s_h` without revealing it, blind at issuance |
| `pk_I` | the issuer | one half of the disclosure key |
| `pk_V` | the venue, used only inside `DisclosureGate` | the half that makes AB-043 bite |
| `cid` | the plaintext under `ct` | **never `s_h`.** See the two-line argument below |

**The disclosure plaintext is the credential id and never the holder secret, and
this is the whole of §5.1's granularity requirement.** `s_h` generates every
epoch's nullifier, so a disclosure that revealed it would deanonymise the
holder's entire history, past and future, from one lawful request. `cid` is inert:
opening one registration's `ct` names the holder for that registration only.
Every further epoch is a separate `ct`, needing a separate gated call, writing a
separate HCS record. **The audit trail's granularity is a property of the
plaintext choice, not a policy.**Domain separation is stated once so the stretch circuit needs no new design.**
D-05 keeps the sealed-bid auction as a stretch. Its double-bid nullifier is the
same construction at `DOMAIN = 2`, so if the auction ships it inherits this
entry rather than reopening it.

### The viewing key is split 2-of-2, which closes §5.1's other open half

`SECURITY-MODEL.md` §5.1 left "split or not" `[OPEN]`. The preimage decides it.
`pk_D = pk_I + pk_V`, decryption is `cid = ct - Poseidon(sk_I * R + sk_V * R)`,
and neither share alone opens anything.

> **AMENDMENT 1 of 3. That last clause was not true as written, and it
> is the load-bearing one.** `pk_D` is folded into the governed parameter root
> below, so the shares are registered in some order, and a bare additive aggregate
> is chosen adaptively by whoever goes second: submit `pk_I = x*G - pk_V` and
> `pk_D = x*G` with `x` held alone. **An issuer doing that opens every `ct`,
> recovers `cid`, and joins identity to nullifier without ever calling
> `DisclosureGate`**, which is the same bypass this entry's opening finding exists
> to close, arriving through the key setup instead of the preimage.
>
> **Fix: each share is registered with a proof of possession, and the aggregate is
> rejected if either is absent.** One signature check, once, at setup. It changes
> no public input and no storage layout. `docs/market-invariants.md` INV-24,
> `SECURITY-MODEL.md` §5.1.

- The **issuer** cannot deanonymise, which is what "the audit trail covers the
   auditors" actually requires.
- The **venue** cannot either, and its share moves only through
   `DisclosureGate.disclose()`, whose call authorises the HCS submit in the same
   EVM frame. AB-043 arm A measured that an authorise-then-revert leaves the topic
   empty, so release and record cannot be separated.

> **A disclosure with no audit trail requires the venue to use its key outside
> its own contract.** That is a key-custody claim, not a protocol claim, and it
> is written in `SECURITY-MODEL.md` as one. The dishonest version of this
> sentence is the one that says the record is forced unconditionally.

> **AMENDMENT 2 of 3.** The block above calls `r` ephemeral and
> nothing requires it to be **fresh**. Reuse gives `ct_1 - ct_2 = cid_1 - cid_2`,
> so one credential registered twice under the same `r` produces an identical
> `ct`, and identical ciphertexts in two epochs publish the cross-epoch join to
> every observer rather than to the relay alone. This is the requirement
> `docs/market-invariants.md` INV-19 already places on the bid commitment, and
> INV-25 now places on the linkage. It is a witness-generation requirement, so it
> changes no public input.

`[ASSUMPTION]` Circuit cost of the linkage: one Baby Jubjub scalar
multiplication plus one Poseidon, roughly 2,300 constraints against circomlib's
published component sizes. The whole statement lands near 13,000 constraints,
which is seconds of PLONK proving in browser wasm. **This is an estimate from
component sizes and not a measurement. Compiling the circuit and timing it is
the first build task, and if it is wrong the linkage is the piece that moves.**
### Rotation, which is two policies and not one

**Epoch rotation, and the epoch length is derived rather than picked.**
`STUDY_PLAN.md` D9a settled that the nullifier must be per-epoch, because a
stable one lets a single observer accumulate a join across the account lifetime.
It did not say how long an epoch is. The instrument does:

> `[DERIVED]` **Epoch length equals the instrument's term: 30 days.** An epoch
> shorter than the term forces a nullifier rotation inside an open trade, and it
> buys nothing, because both legs of that trade are already linked by the trade
> itself. The shortest epoch that is not decorative is the term. `SUCCESS.md` §3
> fixes the term at 30 days for the modelled trade.

The settlement address is a separate question and gets a separate rule. It is
named in the ATS hold and must persist for the life of the trade, so it cannot
rotate on the epoch clock. **One settlement address per trade, not one per
trader.** AB-035 makes that free: the address is sponsored to zero cost and need
never hold value. The join over a settlement address is then bounded by one
trade, and the join over a nullifier is bounded by one epoch.

**Credential rotation.** Re-KYC, reissue and expiry all produce a new `cid`. The
holder keeps `s_h` and the issuer signs the same `C_h` into the new credential,
so **the nullifier is unchanged and sybil resistance survives reissue**. The old
`cid` enters the revocation set. This answers F5b's question directly: `s_h`
belongs to the holder, not to the credential, and the commitment is what binds
them.

That places one obligation on the issuer, and it is where sybil resistance
actually lives:

> **The issuer must never sign two live credentials for one subject under
> different `C_h`.** It is checkable, because the issuer holds the subject-to-`C_h`
> table, and it is consistent with `SECURITY-MODEL.md` §1.2, which already says
> sybil resistance is inherited from the issuer's KYC process rather than
> manufactured in the circuit.

**The registration cap, enforced on chain.** A per-epoch nullifier bounds the
join at one epoch's registrations, which is only useful if that number is small.
The contract can count, so it does:

> `[DERIVED]` **`K = 5` registrations per nullifier per epoch, rejected on the
> sixth.** `privacy-abstraction/DISCLOSURE-LATTICE.md` §II: `k` one-bit
> disclosures fully determine a `2^k` domain. The counterparty universe is the
> 54-firm taskforce, and `log2(54) = 5.75`, so six linked observations identify a
> firm outright. Five leaves at least two candidates standing.
>
> **The assumption this rests on, stated so it can be attacked:** one linked
> trade contributes one bit. That holds because D9's landing zone publishes
> post-trade information in aggregate. **If D9 fills the post-trade size cell
> with a bucket instead, a trade contributes roughly three bits and `K` falls to
> 1.** `K` is a function of the matrix and is not final until the matrix is.

`K` is also the coordinate that makes D11c's governance argument concrete.
Lowering `K` is always safe, raising it needs the collusion bound re-verified, and
"safe policies are downward closed" stops being an abstraction the moment there
is a number to move.

**Cost, stated:** a desk that opens more than five trades in a 30-day epoch
cannot do it under one nullifier. The venue enforces the ceiling rather than
letting the desk trade past its own anonymity and discover it later. A
high-frequency participant is not a fit for this venue at this setting, and that
is a real limit on the addressable market rather than a tuning parameter.

### Delta, the revocation window

`SECURITY-MODEL.md` §4.3 offered three options. **We take option 1 and option 3
together, and refuse option 2 on a cost we can now price.**
The mechanism, and the point is that expiry costs nothing:

```
registry[n] = { address a, epoch e, revRoot r, class c }

getKycStatus(a) == GRANTED iff an entry exists for a
  and entry.epoch == currentEpoch
  and entry.revRoot == currentRevRoot
```

**Publishing a new revocation root expires every registration proved against the
old one, and expiry is a comparison rather than a write.** No transaction sweeps
the registry, no per-entry bookkeeping, and at the instant of any transfer the
registration behind it has been proved against the root that is current right
then. That is most of option 2's safety without option 2's cost.

So the window is not "a revoked credential trades for delta." It is the interval
between the issuer revoking and the root landing on chain:

| Component | Value | Kind |
|---|---|---|
| Venue polls the issuer's revocation feed | 30 s | operational commitment |
| Venue publishes the new root once it sees a change | 60 s | operational commitment |
| Hedera consensus finality | ~3 s | platform |
| **delta** | **93 s** | |

> **Delta is a service level, not a cryptographic bound, and calling it anything
> else would be false.** Ninety of the ninety-three seconds are our own
> off-chain conduct. The on-chain half is the part that is enforced: once the
> root moves, nothing proved against the old one passes, and no operator
> discretion enters that.

**Why option 2 is refused, priced rather than argued.** An on-chain re-check at
settlement means a fresh proof per transfer: 322,697 gas each `[MEASURED]`
AB-044, and, worse, the trader has to be online to produce it. A repo's margin
calls and close leg are venue-driven by design (`SUCCESS.md` §3: 38 of the 40
transactions are not the counterparty's). **Requiring the trader online at
settlement converts a liveness convenience into a settlement dependency**, which
is a worse failure than a 93 second window. The leak argument in the old table,
that an on-chain check reveals a specific credential was checked, is true and is
now the second reason rather than the first.

**Two settings, one mechanism, which refines D11d.2.** `STUDY_PLAN.md` D11d.2
proposed sharing one freshness window between revocation and governance
staleness. Share the mechanism, not the setting:

| Root | Accepted | Failure mode if stale |
|---|---|---|
| revocation root | **current only** | a revoked credential trades. Compliance failure |
| parameter root | **current or previous** | an old policy applies for one interval. Governance latency |

They get different settings because they fail differently, and collapsing them
onto one `N` would price a compliance failure at the cost of a latency.

**The cost, and it is the real one:** a single revocation expires the
registrations of **every** active holder, not just the revoked one, because the
contract compares roots and cannot see whose credential moved. At demo scale
that is one re-registration. At venue scale it is a thundering herd, and it is
what D-08's batch verification is actually for, which upgrades that decision
from a gas optimisation to a load-bearing part of the revocation path. The
per-holder fix, a sparse-tree non-membership proof with individual expiry, is a
roadmap item and is named as one.

### Four things this settles elsewhere

**AB-026, the failure path that publishes the address that failed.** The probe
asked whether the seam should answer GRANTED for unknown addresses. **It should
not.** Seam D failing closed is the security property, and AB-012's ordering
constraint makes answering GRANTED by default actively hazardous. The leak
changes character under this design rather than being mitigated: the addresses
enumerable through `InvalidKycStatus()` are single-trade, sponsored, zero-value
addresses with no funding history, so "this address is not registered" names no
institution. **The leak is real in stock ATS and empty here, and the reason is
the address lifecycle rather than the seam.** That goes in `SECURITY-MODEL.md`
because a reviewer who knows ERC-3643 will look for it.

**ATS's own revocation list cannot be the source.** `SsiManagement` points at
`IRevocationList.revoked(address, string)` `[SOURCE]`, which is keyed by address.
Our credential never has an address on chain, so that interface cannot answer a
non-membership question about a `cid`. **The venue republishes the issuer's
revocation set as its own Merkle root over credential ids.** This is an addition
beside ATS rather than a use of it, and it is the one place in the design where
ATS's credential model and ours do not line up. Say it in the README rather than
letting the mismatch read as an oversight.

**The public-input count.** `n, e, issuerRoot, revRoot, ct, R.x, R.y, class`,
with `pk_D` and the policy parameters folded into the governed parameter root per
D11b. Eight to nine public inputs, against a column that holds roughly 2,100 at
the measured 15,000,000 gas ceiling `[MEASURED]` AB-020. **The interface is
frozen by this entry and the registry storage layout follows from the table
above.** That is what H3 was blocking.

**The relay now holds the cross-epoch join.** AB-035's residual was that the
relay learns which nullifier it sponsored. Under this design the relay also
sponsors the same trader's next epoch, so **the relay is the one party who can
link epochs**, which is the join the epoch exists to break. It is the largest
single residual in the privacy claim, it is A5 in §6.1, and AB-035's blinding
probe is now the successor item rather than an improvement.

> **AMENDMENT 3 of 3, and it names the mechanism this paragraph left
> implicit.** `n`, the address and `ct` all rotate at the epoch boundary, so
> nothing the relay **receives** links two epochs. The only thing that can is how
> the holder reached it: source address, session, timing. The join is in the
> channel, not the payload, which is why `SECURITY-MODEL.md` §4.4a answers it with
> a conduct rule about channel state rather than with a construction.
>
> Two consequences for this entry. **The `K` cap above is a contract counter and
> not a circuit statement**, so a verifying proof establishes an unrevoked
> credential and nothing about the count; a sponsor that gates on proof validity
> alone can be drained by registrations that revert after it has paid, and it must
> read the counter, epoch and revocation root before paying (INV-23). And
> **`registry[n]` publishes the address**, so `address ↔ n` was never the relay's
> to withhold; blinding it would buy the channel rule by construction and nothing
> else. Neither consequence moves the storage layout frozen below.

### The three amendments, collected

Added, when `BUILD-PLAN.md` §7.3's J4 downgrade was re-derived by a
second reader as that entry asked. **The downgrade held. Three claims underneath
it did not**, and all three were in this entry. They are stated in place above and
listed here so a reader of the frozen interface can check the freeze in one place.

| # | What was wrong | Fix | Touches a public input? |
|---|---|---|---|
| INV-24 | "neither share alone opens anything" is false for a bare additive aggregate. The second registrant sets `pk_I = x*G - pk_V` and holds `sk_D` alone | proof of possession per share, verified once at parameter-root setup | **No.** Key setup |
| INV-25 | `r` is called ephemeral and is never required to be fresh. Reuse repeats `ct` and publishes the cross-epoch join | the freshness sentence INV-19 already carries for the bid blinder | **No.** Witness generation |
| INV-23 | the `K` cap is a contract counter, so a verifying proof carries no count bound and a proof-gated sponsor is drainable | the relay reads counter, epoch and revocation root before it pays | **No.** Relay conduct |

**Why this is an amendment and not a reopening.** `STUDY_PLAN.md` put this entry
before contract code because the public inputs and the storage layout are
expensive to rework afterwards. None of the three moves either. The one finding
the item that **does** move a public input is the registration payload hash,
`docs/market-invariants.md` INV-07, and it is recorded as an interface change with
a gas number rather than as an amendment.

**INV-24 is the one that was not merely imprecise.** Unamended it is a working
deanonymisation by the issuer, which is the exact failure this entry opens by
refusing, so it would have been the finding that killed the direction we were
carrying for the second time in two days.


### What was given up

| Given up | For |
|---|---|
| A nullifier the issuer can compute, which is simpler and needs no in-circuit encryption | An issuer that cannot silently deanonymise, which is the whole "auditable" half of the frame |
| Unconditional forcing of the HCS record | An honest key-custody statement. The unconditional version is not achievable on a public ledger and claiming it would be the failure mode this file exists to avoid |
| Unbounded trading frequency under one identity | A collusion bound with a number in it, enforced by the contract rather than promised |
| A cryptographic revocation guarantee | A 93 second window declared as an SLA, against the alternative of a proof per transfer and a trader who must be online to settle |
| Per-holder revocation independence | Root comparison, which makes expiry free and makes one revocation everyone's re-registration |

---

## D-17 · The project is called Seam

**SUPERSEDED by D-21**, which keeps every word of the argument below
for *seam* and rejects only the bare form of it. Kept unedited because D-21's
case is built on this one.

**Decided.** Recorded because a name is a decision with rejected
alternatives, and because the rejection reason for the prettiest candidate is a
real constraint rather than taste.

**Seam.** ATS exposes five external seams on the transfer path
(`mesh/transfer-path.md` F-01); we occupy D and possibly C and fork nothing,
which is D-07. The word also covers the EVM/HTS rollback boundary AB-039
measured and the six boundaries in `docs/settlement.md`. It names the
architecture rather than the asset.

**ENS: `theseam.eth`.** `seam.eth` is unregistered but four characters, which
puts it in the premium tier at $160/yr against $5/yr at five or more, and the
registration perk excludes premium names. The definite article is the standard
fallback and the project name stays "Seam". Verified available on-chain against
the BaseRegistrar at `0x57f1887a...47eA85`, with `vitalik.eth` and `ens.eth` as
controls returning `false` first so the instrument is known to discriminate.

**Rejected, with reasons:**
| Candidate | Why not |
|---|---|
| **giltedge** | The best-sounding option, and it contradicts our own roadmap. `HANDOFF.md` §3 rules that we build against a collateral token interface rather than a hardcoded asset, because collateral mobility across platforms is the Woolard report's real problem and DIGIT is targeted at Orion rather than Hedera. Naming the project after gilts dates it to the one asset we decided not to bind to |
| **quantale** | Names the project after the algebra in `SECURITY-MODEL.md` Sources. Accurate and unclaimed, and it signals the intellectual depth that is genuinely differentiating. Too obscure for a judge who is not a specialist, and the pitch already has to carry the lattice on its own merits |
| **quietbook** | Encodes P2 well, and "quiet" correctly avoids the regulatory baggage that "dark" carries. Softer than the design deserves, and "book" is order-book jargon a non-trading judge may not catch |
| **unwritten**, **tacit**, **vellum**, **haircut**, **gilt**, **repo**, **seams** | All taken on ENS |
| **seamd** | Precise, since seam D is the one we occupy. Cryptic, reads as a typo, and does not survive being said aloud |

---

## D-18 · One public input is added to D-16's frozen interface, and the reason is a known bug
**Status:** SETTLED. **Amends D-16, which was frozen.** Must land
before the circuit compiles
**Evidence:** AB-057, `docs/prior-attempts.md` §7, `docs/market-invariants.md`
INV-07, AB-008, AB-014, AB-035

Amending a frozen interface deserves more scrutiny than setting one, so the bar
here is: a named bug class with public prior art, a fix that three shipped
systems already use, and a cost that fits the budget already recorded. All three
are met.

### What is added

```
public input: payload = Poseidon(DOMAIN_REG, registrant, epoch, ct, R)
```

One field element, bound to the registration the proof is for. The circuit
asserts nothing about it beyond membership in the hash; the work is done by the
verifier contract, which recomputes `payload` from the call it is executing and
rejects any proof whose public input does not match. **A proof is then valid for
exactly one registry write by exactly one submitter.**
### Why the frozen interface has to move

D-16 froze the public inputs at the nullifier, epoch, issuer-set root, revocation
root, the linkage ciphertext `ct` and its ephemeral key `R`, and the disclosure
class. **None of them binds the submitter.** A valid proof is therefore usable by
anyone who sees it, and AB-008 established that a `ContractCall` body reaches all
29 consensus node operators in plaintext before consensus.

The naive attack is weaker than INV-07 first claimed, and AB-057 records the
correction honestly: hashgraph's median-of-first-receive ordering means an
attacker who must observe first is racing from behind. **The fix does not rest on
that race.** It rests on the variant that needs no timing assumption at all:

> An unbound proof stays valid for the remainder of its epoch. D-16 sets the
> epoch at 30 days. **If the legitimate holder's transaction fails once, for gas,
> throttling, expiry or any other reason, an observer holds a valid proof for up
> to 30 days and registers it whenever they like.**
### The severity, which is not what the entry originally said

The attacker replays the whole public input set, `ct` included, into
`registry[n] = { address a, epoch e, revRoot r, class c }` with `a` under their
control. A later lawful disclosure opens `ct`, names the victim's credential, and
the record asserts that the victim's verified identity authorised an address the
victim never held.

**That is identity misattribution inside the compliance record, not denial of
service.** `HANDOFF.md` §4 sells the audit trail as the product, and this is an
attacker writing false entries into the product against a named institution. It
is the worst failure available to a venue whose output is a compliance artifact,
and it is why this amendment is not optional.

### Why this fix and not the obvious alternative

The mitigation a reviewer suggests first is to reject duplicate proofs by hash.
**Refused, with a source.** `[PRIMARY]` Beosin's Groth16 analysis: projects
"typically record used Proofs in a mapping to prevent double-spending attacks,
but when using Groth16, malleability attacks exist, so recording should use
original node data rather than just Proof data." A valid Groth16 proof
re-randomises into a different valid proof over the same public inputs, so the
hash is not a stable identity. D-09 chose PLONK, where that particular
re-randomisation does not apply in the same form, but the key choice is right for
the other reason regardless: **the nullifier is the object with meaning and the
proof is an encoding of it.** D-16 already keys the registry on the nullifier.
This entry exists partly so nobody later optimises that into a `keccak(proof)`
check.

### Cost, against a budget that was already measured

`[MEASURED]` AB-014 put the marginal cost of a public input at 6,150 gas under
Groth16. D-09's PLONK constant differs and is not yet measured. The interface
carries 8 to 9 inputs against a ceiling near 2,100, derived from the 15,000,000
gas cap (AB, gas cap bisect), so **one more input consumes roughly 0.05% of the
available headroom.** There is no version of this where cost is the reason not to.

`[ASSUMPTION]` One extra Poseidon over five field elements, roughly 240
constraints against circomlib component sizes, on a statement D-16 estimates near
13,000. Under 2% growth. Like every constraint number in D-16 this is an estimate
from component sizes, and compiling the circuit is what settles it.

### This is not an invention, and the pitch should say so

`[PRIMARY]` Zcash binds the nullifier to the recipient key; Tornado Cash binds
`recipient`, `relayer` and `fee` as public inputs and its whitepaper states the
proof "is binding: one can not use the same proof with a different nullifier
hash, another recipient"; Semaphore documents binding the relayer address into
the signal. The bug was reported against Miximus.

**The same system is also the precedent for who pays**, and the repository should
cite it in both places rather than one. Tornado's relayer fronts the withdrawal
gas and recovers a fee of **0.05% to 0.2%** agreed off-chain, denominated in the
withdrawn asset rather than taken as gas from an account the user had to fund
first. Its documentation names the reason the *fee payment dilemma*: paying your
own gas exposes a funding pattern that links the two ends. That is exactly the
argument J4 makes in `SECURITY-MODEL.md` §4.4a, arrived at independently and on a
Hedera-specific protocol fact (HIP-410). `docs/fee-mechanics.md` FM-02. Where we
diverge is recovery, and that divergence is D-22.

**Claiming originality here would be false and checkable in one search.** The
defensible claim is the one about method: the repo found it by writing the
invariants down before the checks, recorded that its own first version overstated
the attacker set, and fixed the interface before the circuit compiled rather than
after the verifier was generated.

### Obligation this places before the circuit compiles

Write the squat as a **failing** test against the unamended circuit first, then
add the input and watch it pass. `SECURITY-MODEL.md` is worth more carrying "we
wrote the attack, it worked, and now it does not" than an assurance that the
interface is sound. Same rule AB-006 sets for the enumeration attack, and the two
tests share a Poseidon instantiation, so they belong in the same sitting.

---

## Refused, with reasons

Carried forward from `HANDOFF.md` §9 so they are not rediscovered as gaps. These
are closed.

| Refused | Reason |
|---|---|
| **zkML anywhere** | There is no unverifiable computation in this system. Proofs buy privacy here, not integrity. Paying zkML proving costs to answer a question nobody asked reads as a tell |
| **AI price prediction** | Oracles exist and gilts have observable prices. A model guessing collateral values inside a margin engine is something a risk committee rejects on sight |
| **AI credit or counterparty scoring** | An unexplainable model making counterparty decisions is a compliance liability, not a feature |
| **A chatbot over the repo position** | Delete it and nothing degrades. That is the test |
| **Formal verification as a workstream** | ATS is about 100 diamond facets, a hostile target in this build, and invisible in a five-minute video. It scores nothing on Success, Validation or Integration. The right dose is `SECURITY-MODEL.md`, not a proof effort |
| **Recursive aggregate proving** | D-08. Foreclosed by the absent BLS12-381 precompiles and by D-07's zero-fork commitment |
| **The Continuity track** | It is for projects previously built at an earlier event or already on Hedera. This is a fresh build. Out of scope, do not chase it |

---

## Decisions still owed

| # | Owed | By | Blocks |
|---|---|---|---|
| D-09 | ~~Groth16 or PLONK~~ | **ANSWERED, AB-044: PLONK.** Both built over one circuit and measured on Hedera the same hour, each against a corrupted-proof control. 322,697 gas against Groth16's 228,649, which is 2.15 percent of the ceiling instead of 1.52. Buys away every phase-2 ceremony, including the ones a changing circuit would keep demanding | ~~the circuit interface, and two ceremonies of work~~. Successor: redo D-08's batching numbers for KZG, and time proving on the real circuit |
| D-02 | ~~Is HTS plus EVM atomic~~ | **ANSWERED, AB-039: yes, inside one EVM transaction. Measured three ways, each against a control that moved. Hole H4 closed.** | ~~whether "atomic DvP" is a claim we may make~~. Successor: the fractional-fee rounding sub-question, which is arithmetic and not a platform risk |
| D-10a | ~~Does the fee leak counterparty tier~~ | **NARROWED, AB-042.** An HTS fee is a property of the token with no per-holder variation, so on one cash token it leaks nothing. Per-tier pricing would need one token per tier and the token id would leak the tier outright. **Constraint: one cash token, tiering lives in the guard layer.** | ~~the guard layer's scope~~ |
| D-13 | ~~Does the Studio UI survive `internalKycActivated = false`~~ | **ANSWERED, AB-036: it does better than survive it. External KYC list registration is a first-class UI feature with its own route, store and creation step, so the overlay is operator-configurable through the shipped product.** Residual: the UI validates format only and reports success for a localStorage write, which is a second upstream filing | the Integration argument behind D-05 |
| O3 | ~~Nullifier preimage, rotation, revocation window~~ | **CLOSED, D-16.** Preimage is `Poseidon(s_h, DOMAIN, ctx)` on a holder-only secret, so the issuer cannot enumerate; linkage is a 2-of-2 ciphertext over the credential id; epoch is 30 days, derived from the instrument's term; `K = 5` registrations per nullifier per epoch, derived from `log2(54)`; delta is 93 seconds and is an SLA rather than a bound. **The circuit interface and the registry storage layout are frozen**, and the three amendments of leave both untouched | ~~D9's identity row, hole H3~~. Successor: ~~AB-035's relay-blinding probe, which now carries the cross-epoch join~~ **the cross-epoch join is a channel property, answered by `SECURITY-MODEL.md` §4.4a Rule 3. The blinding probe is reduced to buying that rule by construction** |
| O1 | ~~Does registration deanonymise the nullifier~~ | **CLOSED, AB-035. No, the address can be sponsored to zero cost and need never hold value. The circuit interface is unblocked.** | ~~the headline privacy claim~~ |
| D-15 | ~~Node pinning~~ | **SETTLED, D-15 above.** Pin, name the node in the README, and make no fairness claim, because the fairness claim needs a fallback and a liveness story and the demo script has no beat for it | ~~the demo script~~. Unblocked |

---

## D-19 · The regulatory proxy is a parameter proxy, and never a code proxy
**Status:** BUILT, because it is 4.3 KB and
it converts the project's strongest sentence from `[DOC]` to enforced
**Evidence:** `STUDY_PLAN.md` D11a-e, `marketplace/EVIDENCE.md` MK-003, MK-015,
MK-021, `docs/who-gets-privacy.md` DP-01, DP-02, `[MEASURED]`
[venue/test/Regime.t.sol](venue/test/Regime.t.sol), 9 tests, output in
[probes/regime.out](probes/regime.out)

Regulation moves. MK-003 has RTS 2 amended by Delegated Regulation (EU)
2025/1246 with APA in force, and MK-015 has Article 5's double
volume cap replaced by Regulation (EU) 2024/791. Both are inside our own
evidence folder. Meanwhile `RepoVault` and `OrderBook` each hardcode
`ceiling = L.point(L.G_BUCKET, L.T_EOD)` in an `immutable`, so a deferral
change is a redeployment. That gap is real and it needs a layer.

### The trap, which is the decision

On the EVM, "proxy layer" means `delegatecall` upgradeability. **That is the one
construction we must not use**, and the reason is not security, it is the pitch.
D11c's sentence is:

> The regulator defines the ideal. Governance moves within it. The circuit
> proves you stayed inside it.

An upgradeable venue can rewrite the check that bounds it. **An upgradeable venue
has no ceiling it does not set**, so the sentence becomes false once the proxy
ships, and it is the sentence that separates this from Kinexys or any
permissioned venue that writes its own rules.

> **Decision: the proxy proxies parameters and never code. `ideal` is
> `immutable`. Raising it is a deployment, not a transaction**, which is the
> correct shape, because a wider waiver is a new grant rather than a
> configuration change.

### Three principals, because the regulation has three

| | may | when | bounded by |
|---|---|---|---|
| deployment | fix the ideal | once | nothing, it *is* the grant |
| `supervisor` | restrict, and later lift | narrowing immediate, widening at the boundary | `ideal` |
| `operator` | pick a point inside | next epoch | the ceiling in force |

The asymmetry carries the argument. **Narrowing is immediate** because the safe
set is downward closed per D11c, so everything below a safe policy is safe, and a
suspension that waits a month is not a suspension. **Widening waits for a
boundary** because widening is the direction that leaks, and Rule 2 and INV-15
already say governance lands on boundaries so a moving threshold is not itself a
signal that a large order arrived.

Two lines do the work, and they are the two lines worth showing on camera:
`L.requireIdeal(point)` rejects an incoherent policy, and `L.permits(ceiling,
point)` rejects a coherent policy the venue was not granted. 42 gas, measured.
**The operator does not lose a vote. It cannot express the state.**
### What this discharges, and what it does not

- **DP-02's containment half.** `who-gets-privacy.md` records D11c's safety
   argument as `[DOC]`. It is now enforced at every write. `[MEASURED]`
   `testFuzz_nothingReachableEverExceedsTheGrant` over arbitrary action sequences.
- **DP-01 and DP-02's "published rather than proved" disposition.** Every
   proposal carries a `bytes32 rationale` commitment, emitted, so the operator
   cannot later claim a different reason than the one committed at proposal time.
- **MK-003's second variable.** `liquidityClass` is a governed field beside the
   point. `[DOC]`, per D11e's own ruling: published with its reasoning, not proved,
   because a graded assessment consuming market data is an oracle problem and we
   do not claim the pipeline is trustless.
- **It does not touch neutrality.** DP-02's stated limit stands unchanged: within
   the ideal, the configuration is ours. A contract cannot hold that property.

### MK-015, the one objection we could not represent

A quota is not a coordinate on a cell, and D9 has no representation for "what
fraction of the market may hide at all." Correct, and the resolution is that it
was never a missing coordinate. **It is a second layer with the same shape as
`DisclosureBudget`:** count consumption against a ceiling, reset per window.
`SeamJournal`'s `_spent`, INV-27's bound on margin-call frequency, and Article
5's cap are one mechanism sighted three times.

`VolumeCap` is that layer, and the design point is that **it holds the supervisor
role itself**, so suspension is arithmetic rather than a person. MK-021's finding
across four venues is that each one backfills with discretion: a reputation
score, a validator set, an emergency vote, and the JELLYJELLY remedy was a
discretionary operator intervention on the most transparent venue in the study.
`enforce()` takes no arguments and checks nobody's identity. The venue cannot
decline to suspend itself.

The asymmetry that keeps it safe: **recording is permissioned, enforcing is
not.** An open counter is a counter an adversary inflates to suspend a rival's
waiver, which is market abuse wearing a compliance hat.

**Three things stated rather than claimed.** `capBps` is a configuration and not
a derivation, because MK-015's instruction to pull the consolidated Article 5
text before the pitch has not been carried out. The cap is measured over our own
venue and Article 5's is market-wide, which the 2024/791 amendment narrows but
does not close, since that amendment made it a single cap **applied by venues**.
And a suspension lifts through `proposeRelax`, so it lands at a boundary, because
a cap that restored instantly would make the restore a tradeable signal.

### The Hedera framing, and it is checkable

The public-spending post is not an objection to this project, it is the far end
of the same dial, and the far end is a named constant in our source.
`[MEASURED]` `test_theTransparencyEndOfTheDialIsTOP`:

   L.point(L.G_EXACT, L.T_PRE) == L.TOP

Public spending is the case where the public is the intended observer, and every
row of it is `(exact, {pub}, imm)`, one step below `TOP`, which additionally
admits pre-disclosure and is what a tender notice is. **A ledger that can only do
that setting cannot host a bond desk, and one that can only do the opposite
cannot host public spending.** The same test deploys both regimes on the same
bytecode and shows the bond desk refused the transparency configuration and the
spending venue granted it. One engine, two grants, and the grant is the thing
neither venue writes.

### Cost, honestly, against remaining capacity already overspent

Built, not planned: 4,332 B and 2,510 B runtime, 9 tests, no new dependency and
no circuit change. What is **not** built and must not be smuggled in: D11b's
Merkle parameter root, D11d's freshness window shared with F5b, and any wiring of
`Regime` into `RepoVault` or `OrderBook`, which still hold `immutable` ceilings.
**Those three are the actual integration and they are not free.** If the schedule
does not admit them, this ships as a standalone contract with a test suite and a
demo beat, which is worth more than a half-integrated one.

---

## D-20 · The parameter root, the freshness window, and what wiring the check to something proved

**Status: BUILT.** `venue/src/policy/ParameterRoot.sol`,
`venue/src/policy/RootWindow.sol`, `venue/src/interfaces/IDisclosurePolicy.sol`,
`venue/test/ParameterRoot.t.sol`, `venue/test/PolicyFixture.sol`. `RepoVault` and
`OrderBook` rewired. 134 tests, 0 failures, `probes/parameter-root.out`. Closes
the three items D-19 named as not built.

### The three were one build

D11b asks for a Merkle parameter root, D11d.2 for a freshness window shared with
F5b, and D-19 left `RepoVault` and `OrderBook` holding `uint32 public immutable
ceiling`. They looked like three tasks. The seam that joins them is that
**a ceiling is a property of a row, and both contracts had one ceiling for
several rows.**
One ceiling for many rows has to be set to the most permissive row it touches, so
it cannot refuse anything that row allows. `RepoVault` held `(bucket, EOD)`,
chosen in a comment for "the size rows", while the same contract published a
maturity date, a coupon amount, a settlement price and a margin state. A per-row
ceiling needs somewhere to keep seventeen values that governance can move, which
is D11b's tree, and a tree that governance moves needs a rule for proofs that were
made against the previous root, which is D11d.2's window.

### What the root buys that D11b did not claim

D11b's argument is about the circuit: Groth16 costs `181,000 + 6,150n` and depends
only on the public input count, so an unbounded parameter set behind one root
costs 6,150 gas. That is true and it is the smaller half.

> **The root turns the disclosure matrix from a document into a deployment
> artefact.** Section 7.2 has seventeen rows. Before this, two of them were
> compiled into contracts as constants and the other fifteen existed only in
> Markdown. A regulator asking which cells this venue is actually operating under
> had no on-chain answer.

Measured cost of asking: **2,163 gas** for a waived row, **1,364** for an
unwaived one, warm, across the external call `[MEASURED]`.

### Four properties, and each one is a defect that would otherwise be available

| Property | Without it |
|---|---|
| The root is **derived** in `adopt`, never declared | whoever builds the tree commits to one set and writes another, and the circuit proves membership in a set the contract never applied |
| Keys **strictly ascend** | the root depends on submission order, so it commits to an ordering rather than to a set. Also rejects a duplicate key in the same comparison |
| `adopt` **clears** the old key set first | a row is silently un-governed by omission and keeps answering with a value no committed root covers |
| An unpublished row returns `BOTTOM` | an unconfigured venue discloses everything. It now discloses nothing, which is seam D's direction from D-17 |

### Governance is a disclosure, so governance gets commit and reveal

`propose` takes a **root and nothing else**. `adopt` takes the set and rebuilds
the root from it. D11d.1 names the dangerous case as the per-asset parameter
change, and a proposal in the clear announces which threshold is about to move, an
epoch before it moves, to everyone. Row 10 gives governance actions
`(exact, {pub}, epoch)`; this meets that and adds `(pred, {pub}, imm)` for the
commitment. It is the order book's own discipline turned on the governance layer,
and it costs one word.

Adoption is permissionless, following `ZkKycRegistry.adoptGate` and
`Regime.adopt`. Anyone may call it and only someone holding the set can, which is
what makes the commitment a commitment.

### The window, and why "the last N roots" is not one

D11d.2 says the contract accepts the last N roots. Taken literally that is not a
window: if the root never moves again, its predecessor stays acceptable forever,
and a window that never closes is a second live policy. So acceptance is bounded
in **time** as well as in count. `depth` says how many roots may be live;
`grace` says for how long.

D-17's rule is share the mechanism, not the setting, and `RootWindow` is a library
precisely so `depth` can be an argument. `test_revocationTakesTheCurrentRootOnly`
runs both settings in one block on one library: the parameter instance accepts its
predecessor, the revocation instance does not. The grace is the same 93 seconds
D-17 derived, for the same reason, because the object in flight is the same object.

### The waiver has an extent, and meeting it into every row was wrong

The first version met `Regime.current()` into every row. Under it a supervisory
narrowing also stopped the venue publishing a maturity date, and the venue could
not open a repo. **A suspension that halts the venue is not the suspension the
regulation describes.** MiFIR's reference-price waiver covers pre-trade
transparency for order size and price; it says nothing about instrument reference
data. So the parameter set carries a bitmask of the rows the waiver covers, and
`Regime` bounds those and no others.

### Three findings that only appeared because the check was wired to something

**1. MA-03 is closed, and closing it forced a field change.** Every disclosing
`emit` in `RepoVault` now routes through `_emitUnder`. The first thing that
refused was `CouponObserved(bytes32, uint256)`. A manufactured payment is the
coupon rate times the collateral lot and the rate is public instrument data, so
the amount divided out to the **exact position size**, which row 14 puts at
`(none, {}, never)`. `manufacturedOwed` is now `manufacturedCommitment`. The state
machine already forbade a second coupon before pay-through, so a single commitment
replaces the accumulator without losing anything.

**2. Row 5's fifteen minute deferral is unreachable for the repo close leg, and
the reason is MA-01.** The obvious build is to emit the predicate at close and open
the price at `+15m`. It cannot work. `RepoMath.repurchasePrice` is a function of
`principal`, `repoRateBps` and `openedAt`, and `repo(id)` returns all three in the
clear, so the exact settlement price of every open repo is computable by anyone for
every future timestamp at the moment it opens. **A deferral of a number the public
already holds is theatre.** So `Closed` carries the predicate.

**The deferral does not come back by deleting the getter, and this entry first said
it did.** The original wording made row 5 unreachable at T2 "until the struct
accessor is dealt with", which is a pending change rather than a limit, and it is
wrong in three steps. `repurchasePriceNow(id)` returns the settlement price
directly, so an observer watching for `Closed` and calling it in the same block has
the number without reading the struct. Delete that accessor too and `open` still
takes `Terms calldata`: `repoRateBps` is in it verbatim, `principal` is
`purchasePrice(markValue, haircutBps)` over two more of its fields, and `openedAt`
is that transaction's timestamp. No accessor change touches calldata the ledger has
already recorded.

That makes this finding 3 arriving one contract early: `{ven}` and `{pub}` are one
set on a public ledger, so row 5 has nothing to defer from for this leg. The
disposition is a stated limit and not a roadmap item, which is also
`docs/manipulation-surface.md` §7's reading of MA-01. MA-01 and the row 5 deferral
are one defect and not two.

Stated as scope, because the fix is narrower than the claim it replaces:
`_emitUnder` covers **events**, and a public getter is neither an event nor a
transaction, so MA-01 lives in that gap and nothing in this entry closes it. It is
not confined to that gap. Rule 1 is about what appears in a transaction body, and
`open`'s terms appear in one.

**3. Rows 3 and 4 cannot be satisfied on a public ledger, and the divergence is now
published rather than hidden.** Section 7.2 reaches row 3's `(bucket, {pub}, EOD)`
and row 4's `(exact, {pub}, +15m)` through a first cell, `(exact, {ven}, imm)`, in
which the venue holds the value and the public does not. **That observer set does
not exist here.** A contract that can read a number is a contract whose storage and
calldata anyone can read, so `{ven}` and `{pub}` are one set and the deferral has
nothing to defer from. Commit and reveal moves *when*, which is what buys Rule 1
against the node operators; it does not narrow *who*.

The response is not to loosen the check. Rows 3 and 4 are deployed at
`(exact, imm)`, and `test_theMatrixAsWrittenRefusesTheReveal` publishes section 7.2
verbatim and shows the reveal reverting under it. The divergence is a governed
parameter under a committed root, with its derivation written beside it, which is
DP-01's disposition for exactly this case.

### One classification that is load-bearing and should be re-read if the venue changes

`Committed` indexes `msg.sender` and is filed under row 17, account provenance, and
**not** row 1, trader identity, whose published ceiling is `BOTTOM`. The
justification is the account lifecycle: AB-023 and AB-035 put orders on single-use
sponsored addresses that name no institution. If the venue ever admits long-lived
addresses the correct row becomes 1 and every `commit` starts reverting. That is
the property worth having: the classification is a claim the contract makes, and
the claim failing is a compile-and-test failure rather than a quiet drift.

### What this entry does not build, named so it is not smuggled in

- ~~**A floor.** See D-20a below. This is now the largest known gap in the policy layer.~~ **Built by D-20a.**
- **Per-holder revocation.** D-17's sparse-tree non-membership proof is still a roadmap item.
- **The circuit side of the root.** Nothing here emits a public input. The contract holds the root and answers `accepts`; wiring it to `RegistrationGate`'s signal layout is a separate change and the layout is frozen, so it is additive.

---

## D-20a · The lattice expresses a maximum and MiFID imposes a minimum, so D-19's Article 5 enforcement is the wrong sign

**Status: FOUND and BUILT. It amends D-19.**
`venue/src/policy/Regime.sol` (`mandate`, `floor`, `raiseFloor`,
`proposeLowerFloor`, `adoptLowerFloor`, `_setFloor`, `_reconcile`),
`venue/src/policy/ParameterRoot.sol` (row floors at keys 18 to 35, `floorFor`,
`_effective`), `venue/src/policy/VolumeCap.sol`, `venue/src/interfaces/IDisclosurePolicy.sol`.
151 tests, 0 failures, `probes/disclosure-floor.out`.

`DisclosureLattice` is a ceiling: `permits(ceiling, actual)` asks whether `actual`
discloses at most as much as the policy. Every enforcement in the repo is that
comparison. `L.point(G_EXACT, T_PRE) == L.TOP` puts maximum transparency at the
top, which is the check that carried the DOGE framing, and it is correct.

A transparency obligation is the other comparison. MiFIR does not say a venue may
publish at most this much, it says at least this much, and **a waiver lowers that
floor rather than raising a ceiling.** Article 5 suspends the waiver, which raises
the floor back.

D-19 built the suspension as `regime.narrow(suspended,...)`. Narrowing moves the
ceiling **down**, and a lower ceiling forbids disclosure. It cannot compel it.
`test_theCapIsHeldByArithmeticAndTriggeredByAnyone` passes and asserts exactly what
it says, that `ceiling()` moved, and the venue's live `current` is
`(bucket, EOD)`, which is inside the new ceiling and does not have to move at all.
**The cap fires, the ceiling moves, and the venue keeps trading dark.**
This is the same shape as MA-03 one layer up: a check that reads as enforcement and
is not, and the way to catch it was to ask what the value actually constrains
rather than to read the comment beside it.

**The fix is a floor, and its enforceable part is narrower than it first looks.**
A floor cannot be checked per event: an event discloses at one cell, while an
obligation is over a row and a window, and a predicate emitted now can be
legitimately followed by the exact publication later. What *is* enforceable, and is
the same shape as `Regime._setNarrowed`, is that **the floor bounds the ceiling**:
a parameter set whose row ceiling forbids what the venue is obliged to publish is
un-adoptable, and an existing configuration is clamped up when the floor rises.
That does not guarantee the venue emits. It guarantees the venue cannot be
configured to be unable to, which is the half a contract can hold.

### What was built, against that pricing

The estimate was a second keyed value per row in `ParameterRoot`, a `floor` on
`Regime` with the asymmetry mirrored, and `VolumeCap.enforce` switched to raise
it. All three, plus one thing the pricing missed.

**The mirror is exact, and writing it out is what showed the parts.** Every
sentence about the ceiling has a counterpart, and each counterpart is true for the
same reason turned over:

| ceiling | floor | why the mirror holds |
|---|---|---|
| `ideal`, immutable | `mandate`, immutable | a wider waiver is a new grant; so is a narrower obligation |
| `narrow`, immediate, down only | `raiseFloor`, immediate, up only | compelling disclosure is the safe direction, and a suspension that waits for a boundary is not a suspension |
| `proposeRelax` then `adoptRelax`, at a boundary | `proposeLowerFloor` then `adoptLowerFloor`, at a boundary | restoring a waiver buys secrecy, which is what Rule 2 is about |
| `proposeRelax` bounded by `ideal`, not `narrowed` | `proposeLowerFloor` bounded by `mandate`, not `floor` | the call that undoes a move cannot be bound by the value it undoes |
| `adopt` clamps down with a meet | `_reconcile` clamps up with a join | a permissionless adopt must not be wedgeable |

**The part the pricing missed is the interaction, and it is where the work was.**
Two instruments held by one principal can contradict: a supervisor with a standing
narrowing that forbids the disclosure it now wants to compel has issued two
instructions that cannot both be obeyed. The contract does not get to guess which
was meant. So INV-29 is one predicate, `floor <= ceiling()`, applied at both
writers, and the direction of the response depends on **who is calling**:

- `narrow` and `propose` and `ParameterRoot.adopt` **revert**. These are live
   callers with discretion, and refusing outright is what "un-adoptable" means.
- `_setNarrowed` reached from `adoptRelax` **lifts** to the join, and
   `_reconcile` clamps `current` in whichever direction moved. These are on
   permissionless paths, and a revert there is a wedge.

That split is not new. It is `adopt`'s existing revert-at-propose,
clamp-at-adoption rule, and finding that the floor needed the same rule for the
same reason is the evidence the mirror is real rather than decorative.

### The assertion that would have caught it

`test_theCapMovesTheVenueAndNotOnlyTheCeiling`. The old test asserted
`ceiling() == (exact, imm)`, which was true. The new one asserts
`current != (bucket, EOD)`, which was false and is now true. Restoring D-19's
`regime.narrow` under the new suite fails three tests, one of them reading **the
cap fired and the venue kept trading dark**, which is the sentence this entry
opened with. Two more mutations, both recorded in the probe: deleting the upward
clamp in `_reconcile`, and deleting the join in `ParameterRoot._effective`.

### One thing the floor does that the pricing did not anticipate

**A supervisory obligation lifts a row ceiling the operator published.**
`ceilingFor` is the value `_emitUnder` checks against, so an obligation that did
not reach it would leave the venue configured to be unable to publish what it
must, which is the defect one layer down. It is not a leak: `Regime` holds
`floor <= current`, so the lift never carries a row above what the regime permits,
and it is the *regime's* floor that joins in rather than the row's, so the
operator cannot use it as a lever against a narrowing. It is scoped by `isWaived`
for the reason the meet is, which is D-20's finding about the waiver's extent
applied unchanged in the other direction.

### What this still does not do, stated because the entry is about a check that read as enforcement

**It does not compel the venue to emit anything.** That claim was never available:
an obligation runs over a row and a window, an event discloses at one cell, and a
predicate emitted now can be legitimately followed by the exact publication later.
`floorFor` is a view for a regulator and for the tests, `IDisclosurePolicy` says in
its own comment that no disclosing contract should treat it as a per-event check,
and nothing calls it as one.

**The venue ships with `mandate = BOTTOM` and no row floors published.** The
seventeen per-row minimums have not been derived from the regulation, and
`who-gets-privacy.md` DP-01 refuses a published constant with no derivation behind
it, so inventing them would be the decoration this entry was written to avoid. The
floor that binds this deployment today is the one `VolumeCap` raises when the cap
fires, and that path is the one under test. `PolicyFixture.withFloors` publishes
row obligations so the other half is exercised, and it is marked as not
deployed.

---

## D-21 · The project is called SeamMe

**SUPERSEDED by D-25.** Settled, superseding D-17. The
collision analysis below stands and is quoted forward by D-25; what it never
asked was what the name had to carry. D-17's argument for *seam* is not
disturbed: the word still names the five ATS transfer-path seams we occupy two
of, the EVM/HTS rollback boundary AB-039 measured, and the six boundaries in
`docs/settlement.md`, and it still refuses to name the asset. What D-17 got
wrong was that the bare word was available to us in the sense that mattered.

**Three collisions, none of them taste.**
1. **The name collides with its own primitive.** Seam A through seam E are
   interfaces in this repository. `SeamJournal` and `SeamMap` are contracts in
   it, `test/SeamCoverage.t.sol` is the test that pins them, and `docs/ats-seams.md`
   is a table whose first column is headed *Seam*. `README.md` under D-17 opened
   with the title **Seam** and, 160 lines later, a table column also headed
   *Seam* meaning something else. A project name that is a homonym of the
   project's central technical term costs a reader a disambiguation on every
   page and buys nothing.

2. **`theseam.eth` is another company's name.**The Seam** is a US software
   company that builds and operates commodities trading platforms. D-17 reached
   for the definite article to dodge ENS's four-character premium tier and
   landed on a trading-platform incumbent's exact trading name. The bare word is
   further encumbered by an unrelated device-control API at `seam.co` and a
   consumer marketplace. Of the three, the trading one is the one that matters,
   because it is the sector a judge would search.

3. **The compound is cheaper than the fallback and more exact than the
   original.** `seamme.eth` is six characters, which is the $5/yr standard tier
   rather than the $160/yr premium tier that forced D-17's article. The project
   gets its exact name with no article in front of it.

**What *me* adds, and why it is not a contradiction.** Said aloud the name is
*see me*, which for a privacy layer looks backwards for about a second and then
resolves into the exact claim. The venue does not assert that nobody can see the
position. It asserts that the holder decides who can, and that a regulator
reading a published policy is on the seeing side of that decision. The
distinction is the product: `who-gets-privacy.md` is an entire document about
it, and D-17's own rejection of **quietbook** already recorded that *dark* is
regulatory baggage we decline to carry. A name that reads as concealment would
have described a mixer. This one describes selective disclosure, which is what
was built.

**Rejected framings, with reasons:**
| Framing | Why not |
|---|---|
| *Seamless trading* | Offered alongside the two above and dropped. It is generic vendor language, it is the one reading a judge has heard before, and it describes an outcome any venue would claim rather than the mechanism this one implements. The seam that matters here is a real named boundary, not the absence of friction |
| **Seam** retained, collisions accepted | Costs the disambiguation in item 1 on every page of a document set that is itself the submission, and hands a searching judge a commodities trading incumbent |
| **seamd**, **quantale**, **giltedge**, **quietbook** | Re-rejected on D-17's original grounds, which the rename does not change |

**ENS verified on-chain, **, against the BaseRegistrar at
`0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85` by the same method D-17 used:

```
seamme.eth available=true
theseam.eth available=true
vitalik.eth available=false <- control
ens.eth available=false <- control
```

The controls return `false` first, so the instrument is known to discriminate
before the result on the name is read. **Not yet registered.**Not renamed, deliberately.** `SeamJournal`, `SeamMap`, `SeamCoverage.t.sol`,
seams A through E and every prose use of *seam* as a boundary stay exactly as
they are. Those name the architecture and were never the product name. D-21
changes four files: `README.md`, `DEMO-SCRIPT.md`'s title card,
`docs/prior-attempts.md`, and this one.

---

## D-25 · The project is called Lattice Prime

**SETTLED. Supersedes D-21.** D-21's collision analysis is not
disturbed and none of it is reversed: **Seam** really is encumbered by a US
commodities trading platform, the bare word really does collide with this
repository's own primitive, and *SeamMe* really did resolve that in six
characters. D-21 answered the question it was asked. The question was wrong.

**What D-21 got wrong.** It optimised the name against collisions and never
asked what the name had to *carry*. *Seam* names the attachment point where this
venue meets ATS. That is architecture vocabulary, and architecture vocabulary
promoted to a product name describes how the thing is bolted on rather than what
it does. The front page under D-21 never said what was new, and a reader who got
as far as the features section met the heading *Six things a normal order book
cannot do*, which compares the venue to a strawman nobody is defending.

**What the name has to carry.** The disclosure lattice is the only claim in this
repository with no prior art anywhere. Renegade and Penumbra hide the book and
answer a boolean. Broadridge, Kinexys, HQLAx and Fnality answer the same boolean
by membership. Neither family can print a quantity, because an operator holding
the cleartext knows what it learned only as everything it was sent. A budget in
bits, a ceiling the chain enforces, and a venue that stops talking rather than
stops trading when the budget is gone: that is the thing, and *Lattice* is the
word for it. *Prime* is the register the buyer already speaks, from prime
brokerage and prime services, and it says institutional without saying dark.

**The objection, recorded because it is real.** *Lattice* collides with lattice
cryptography, and a crypto-literate reader may spend a beat expecting LWE and
post-quantum. That is a real cost and it was accepted rather than missed. The
mitigation is that the first line of copy after the name defines the lattice as
the disclosure algebra, so the beat is spent once and never again.

**Renamed on chain, without a redeploy.** This is the part that was expected to
be expensive and was not. ATS exposes `setName` and `setSymbol` on the Core
facet, both gated on `ROLE_TREX_OWNER`, and `script/DeployAtsBond.s.sol` already
grants that role to the deployer. So `0.0.10381562` becomes
`Lattice Prime Repo Collateral 2028` / `LPRC` in two transactions against the
live token.

The alternative was a redeploy, and it is worth writing down what that would
have cost, because it is why the question was asked before the sed was run:
`SeamJournal.token` is immutable and the journal is the token's only accepted
compliance caller, so a new token forces a new journal, which forces a new
`MatchingEngine`, which forces a new `VolumeCap`, and
`Regime.bootstrapSupervisor` is single-use so it forces a new regime and a new
parameter root under it. That is the same cascade the tinybars finding already
cost once, and it would have invalidated every hash in
`deployments/receipt-beat.json` while the demo window is still open.

**The ISIN does not change, and that is correct.** `XS0SEAMME017` still spells
the old name. ATS exposes no setter for it, so on the live token it is
immutable, and the immutability is right rather than merely tolerable: an ISIN is
assigned once by a national numbering agency and survives an issuer renaming the
instrument. Changing it would assert a different bond. The reasoning is repeated
on the constant in `script/DeployAtsBond.s.sol` so a reader who spots it in the
deployment record finds it answered there.

**Not renamed, deliberately.** D-21's closing paragraph is carried forward
unchanged and is now load-bearing rather than incidental. `SeamJournal`,
`SeamMap.sol`, `ISeamJournal`, `test/SeamCoverage.t.sol`, seams A through E and
every prose use of *seam* as a boundary stay exactly as they are. They name the
architecture, they were never the product name, and two of them are deployed and
source-verified on Sourcify. The word reads better now than it did under D-21,
because it is no longer a homonym of the thing over the door: the venue is
Lattice Prime, and the seams are where it attaches to ATS.

**Costs, in full.** `seamme.eth` was verified available under D-21 and recorded
there as **not yet registered**, so no registration is stranded by this. ENS
availability for the new name is **not yet verified**, and D-21 set the standard
that it is checked on-chain against the BaseRegistrar with discriminating
controls before it is claimed in a document. That check is owed.
`docs/LatticePrime-writeup.pdf` and `docs/LatticePrime.pptx` are renamed but
still carry the old name inside; both are generated and both need rebuilding
before submission.

---

## D-22 · The venue prices nothing, and cost recovery collides with relay independence

**`[OPEN]`.** Raised by `docs/fee-mechanics.md` FM-05, which was
commissioned to study the fee mechanics of privacy and found that the thing
needing study was the absence of any fee mechanics at all. Recorded as open
rather than settled because **every available answer requires reopening a
decision that is currently closed**, and reopening one under remaining
capacity would be worse than shipping with the gap named.

**The finding, and it is a grep rather than an argument.** Across 25 contracts
and 7,901 lines in `venue/src`, the word *fee* occurs **three times, all comment
lines in `RepoMath.sol`**, and all three say the HTS fractional fee must be
**off** for INV-12's exact settlement to hold. There is no fee accrual, no cost
recovery, no treasury and no revenue mechanism anywhere in the venue.

**The conflict, which is three-way and was not visible from inside any one
decision.**
1. **The relay pays and recovers nothing.** J4 puts registration cost on the
   venue relay, measured at 2,373,000 gas debited to the relay against **zero**
   to the signer, AB-035. That zero is load-bearing: it is what closes O1, since
   a trader who funds their own gas creates a funding history that links the
   nullifier to a fundable identity. Rule 2 of `SECURITY-MODEL.md` §4.4a bounds
   the drain by refusing sponsorship above `K` per epoch, which is a
   denial-of-service control. **A bound is not a business model.**
   `who-gets-privacy.md` DP-04 already owes a published sponsorship policy, and a
   sponsorship policy with no funding behind it is a policy about how to run out
   of money.

2. **Independence forces the relay to fund itself.** Rule 1 of the same section
   requires the relay to be operationally independent of the issuer, because if
   it is not, the issuer's view joins the relay's and DP-04's discretion becomes
   the issuer's discretion. Independence means separate revenue. If that revenue
   is per-trade and attributable, it rebuilds precisely the link sponsorship was
   built to break, and O1 reopens through the back door.

3. **The known fix is closed to us by two prior rulings.** The precedent is
   Tornado's, cited now in D-16: charge the fee in the settled asset and bind it
   into the proof, so nothing is paid as gas from an account the user had to fund.
   But **D-10** puts fee and settlement arithmetic outside the circuit, so there
   is nothing to bind it into; and **D-10a** was narrowed to *no leak* on AB-042,
   which holds only because there is exactly one cash token with the fractional
   fee off, as INV-12 requires. A venue fee taken in that token either reopens
   D-10a or moves to the guard layer where D-10a put tiering. Neither has been
   ruled on, because until FM-05 nobody asked.

**Why this is not being settled now.** Any fee schedule written under remaining capacity would be
a number with no derivation behind it, which is the exact defect
`who-gets-privacy.md` DP-01 refuses in the block-size threshold and that this
document criticises there. Inventing one to close a gap would trade a disclosed
limit for an undefended constant, which is a bad trade in both directions: the
gap is unremarkable in a prototype venue, and the constant would be checkable.

**What would settle it, when it is settled.** In order of preference, and none of
these is chosen here:

| Route | What it costs |
|---|---|
| Fee in the settled asset, bound into the proof, per Tornado | Reopens D-10 and D-10a. The honest route, and the expensive one |
| Fee in the guard layer, where D-10a already put tiering | Cheapest, and it inherits whatever the guard layer leaks. Needs the D-10a leak analysis redone against a fee rather than against a tier |
| Subscription or membership at the venue boundary, priced per participant per epoch rather than per trade | Breaks the per-trade attribution problem in item 2 by construction, and it is what block venues actually do. Wholly unanalysed here |
| The relay is funded as public infrastructure and never recovers | Internally consistent, and it makes Rule 1 independence a claim about funding source that the design cannot check |

**Obligation, and it is the whole of the disposition.** The README states the
limit in `Honest limits`. This entry stays `[OPEN]` and is not to be closed by
picking a row above without the analysis that row demands. `docs/fee-mechanics.md`
§7 and §9 hold the reasoning and the explicit refusal to propose a number.

### The obligation is discharged, and the decision is still open

**Discharged by `venue/src/observatory/Rulebook.sol` and
`venue/docs/RULEBOOK.md`.** 41 tests, 0 failures. What was owed here was the
disclosure, not the mechanism, and the two are separable in a way this entry
did not notice: a venue can publish that it charges nothing without deciding
what it will charge later. The page does that and nothing more. No row above is
picked, no number is invented, and the entry stays `[OPEN]`.

Three things make the zero worth more than a sentence.

1. **It is a published line and not an absence.** `venue.take` sits in the
   schedule with the operator as payee and an amount of zero, and
   `netOperatorTake` sums the schedule to zero. The day it stops being zero is
   an `Adopted` event with a number in it, one epoch before it takes effect.

2. **A charge cannot be published without a mechanism, and a mechanism cannot be
   hidden from the page.** Every sourced line carries the getter that holds it
   and `adopt` reads it back, so a schedule disagreeing with the code cannot be
   adopted at all; `reconcile` re-runs the same check permissionlessly after
   adoption, so a charge that moves later is visible to anyone. The one line
   with no source is held to zero, which is the rule that makes "the venue
   charges nothing" checkable rather than asserted.

3. **It is the precondition for a rebate.** MiFIR permits venue rebates only
   under an approved and public tariff structure. A rebate is now expressible as
   a line with the operator as *payer*, netting negative, and it inherits the
   propose-then-adopt delay. Whatever settles the fee question later lands as an
   edition rather than as a deploy.

The document also discharges the Form ATS-N shaped disclosure the venue never
had: order types (one, a sealed limit), market data (none external), execution
and priority (price, then pro rata by size, with reveal order deciding only the
residue), segmentation (none in the book; FIX tag 1172 on the axe board, at the
lender's election), and halts (**none, and that is a stated limit**). The last
three are tested against the code rather than asserted:
`test_noAddressCanStopACross` drives the operator and the supervisor through
everything each may do and then crosses a round from a passer-by, so any halt
added later fails a test rather than contradicting a page.

**And one was, two days later.** D-23 built the halt, that test failed, and the
page changed with it. The test survives as `test_nothingButTheHaltStopsACross`,
holding the narrower property that the disclosure instruments are not halt
instruments. The rename is the interlock working rather than a concession to it:
the page could not go stale quietly, because the claim was a test.

---

## D-23 · A halt is the mirror of the ceiling, and a pause key with a nicer owner is still a pause key

**Status: BUILT.** `venue/src/policy/TradingHalt.sol`, wired into
`MatchingEngine.crossRound`. `venue/test/TradingHalt.t.sol` 24 tests,
`venue/test/TradingHaltInvariant.t.sol` 5 invariants, 3 claims in
`venue/test/RulebookClaims.t.sol`. It amends `docs/RULEBOOK.md` section 7.

A search for pause, halt or circuit breaker across the sources returned nothing,
and every regulated venue has one. MiFID II Article 48(5) asks a venue to be
able to halt on significant price movement.

### One correction to the framing that raised it

**`VolumeCap` does act on its measurement.** D-20a is the entry: Article 5
suspends a *waiver*, a waiver lowers a *floor*, so the suspension raises one and
compels the venue to print. `test_theCapMovesTheVenueAndNotOnlyTheCeiling`
asserts the venue moved and not only the ceiling. Article 5's remedy is not a
halt and building it as one would be D-20a's defect a second time. What was
missing is the *other* halt, Article 48(5)'s, and it is a different instrument.

### The trap, and the one underneath it

An admin pause key contradicts the rule that no machine gets authority. Correct.
But **the principal is not what makes `Regime` safe, the asymmetry is**, so
handing `halt()` to the supervisor and stopping there builds the same pause key
with a better name on it.

D-19's asymmetry is that narrowing is immediate because it is safe and widening
waits for a boundary because it leaks. A halt inverts the sign: taking away the
ability to trade is the deprivation, so **halting is the leaky direction**.
Three bounds follow, each one of `Regime`'s read in the mirror.

1. **An expiry, never a flag.** No call is needed to end a halt. A halt that
   must be lifted is a halt whose lifting can be declined.
2. **`maxHaltSeconds` immutable.** A supervisor cannot grant itself a longer
   halt, for the reason an operator cannot grant itself a wider waiver.
3. **Budgeted per epoch.** Unlimited maximum-length halts are an unlimited halt.
   The fourth sighting of the accumulator pattern `VolumeCap`'s header names
   three of, and the second time that header's prediction has come true.

### What a halt may stop, which is one function

`crossRound`. Commit, reveal, cancel, expire, forfeit and withdraw stay open and
`RepoVault` does not import the contract, so **a halted venue cannot trade and
cannot stop anyone leaving.** `OrderBook.expire` already stated the principle: a
venue that alone could return a bond would have a lever over every open order.

### The part that makes it a demonstration rather than a backdoor

In the shipped deployment **the discretionary halt has no caller.** The
supervisor seat is held by `VolumeCap`, a contract with no path to `halt`, so
the only thing that can stop a round here is the breaker, and the breaker is
arithmetic on the venue's own clearing price.
`test_inTheShippedDeploymentTheDiscretionaryHaltHasNoCaller` drives that
contract through everything it can be made to do and the venue stays open.

### Two stated limits

**The breaker cannot stop the round that breached it.** A sealed book has no
indicative price to collar, because the price does not exist until the round
clears. So this is a limit-move halt and not an auction collar.

**A halted round is refused and not voided**, so it crosses once the halt lifts.
Voiding is the tidier machine and it takes orders away from people who did not
ask to leave. The protection against a stale print is the limit, not the clock.

### What the invariants cost to make honest

The first handler could not reach two of the three bounds. Deleting the budget
check failed nothing, because the caller was drawn as the supervisor one time in
four and the halt lengths were small against the budget. Fixing that by drawing
lengths inside the cap then made deleting the *cap* check fail nothing, because
the handler no longer asked for a halt the cap would refuse. Both ranges are now
tuned against mutations and `afterInvariant` asserts the handler reached each
bound: a halt succeeded, a halt was refused, and the cap was asked to bind. Four
mutations are caught between the two suites.

---

## D-24 · A settlement fail is not a default, and `maturity` was written and never read

**Status: BUILT.** `RepoMath.failDays`, `RepoMath.settlementPenalty`,
`RepoVault.State.FAILING`, `markFailing`, `settlementPenaltyNow`, the penalty in
`close`, the second entry to `declareDefault`. `venue/test/RepoFail.t.sol`, 14
tests. New tariff line `repo.fail.penalty` in `docs/RULEBOOK.md` section 8.

### The finding is worse than the one that was reported

The report was that the close leg can fail and the machine sends it to
`DEFAULTED`. **It did not send it anywhere.** `maturity` was written by `open`,
published by `Opened`, and never read again. `close` had no maturity check, and
the only route to `DEFAULTED` ran through `MARGIN_CALL`, which needs the margin
engine to post a breaching mark. So a borrower who never closed left the repo
`OPEN` for ever, and the lender had no remedy unless the collateral happened to
move. The comment on `close` claiming the venue reaches `DEFAULTED` through T4b
was describing a path that did not exist from `OPEN`.

That makes `FAILING` a hole being closed rather than a feature being added.

### Three decisions inside the arithmetic

**The penalty runs from maturity and not from the declaration.** Key it off the
state and a borrower closes late without ever being marked, which is a charge
nobody triggers. It also covers the path `markFailing` cannot reach, a repo
sitting in `MANUFACTURED` when maturity passes.

**Days round up.** `RepoMath`'s one stated rounding direction, and a floor would
make a twenty three hour fail free, which is an option nobody should be handed.
A day is 24 hours here and business days in the regulation; the contract has no
calendar, so it over-counts across a weekend, in the direction that favours the
party that was failed against.

**The rate is published, not derived.** Article 7 prices a *cash* fail, which is
what a close leg is, at the overnight credit rate of the central bank of issue
floored at zero, and there is no oracle for that. So the disposition is
`VolumeCap.capBps`'s unchanged: a published constant with the derivation named
as owed. The unit is hundredths of a basis point, because the delegated act
writes its rates to one decimal place of a basis point and in basis points the
two bond rates are both zero.

### The interlock with D-22, which is the best part of this entry

Article 7(2) says the penalty mechanism "shall not operate as a revenue source."
That is a constraint on **who is paid**, and it is the one clause of the
regulation the rulebook can check rather than assert. The tariff line names the
counterparty as payee, so `Rulebook.netOperatorTake` cannot contain it, and
`test_theFailPenaltyIsNotVenueRevenue` moves the payee to the operator and shows
the same schedule then reports a take. D-22 stays open and the venue take stays
zero: a penalty that flowed to the operator would be venue revenue by a
different name, and the tariff is now the thing that would say so.

### Row 14, again

The penalty amount is never emitted. It is `value * rate * days` with rate and
days both public, so an amount in the event divides out to the position. The
`Failing` event carries the date and nothing else, which `Opened` already
published. `settlementPenaltyNow` is a view and not an event, for the reason
`repurchasePriceNow` is: the ledger already holds what it returns, and the event
stream is the surface `_emitUnder` governs.
