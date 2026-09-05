# What is built

## Working

The disclosure model, as executable code rather than a document. A check costs
a small constant amount of gas, which is what makes it usable on a transfer path.

The eligibility circuit and its on-chain verifier, with the compiled circuit
checked mechanically for which inputs are genuinely public.

The contract ATS calls on every transfer, and the registration gate that writes
to it. This is the attachment point that decides whether a transfer happens, and
it is deliberately small.

The repo state machine and its arithmetic: haircuts, margin calls, and the two
legs of an opening.

A commit and reveal order book, so what reaches the consensus node set carries
no size, no price and no side.

Cancellation of a sealed order before its reveal window opens, at a bond charge
derived from how long the commitment sat on the book rather than chosen. The
window closes at the instant reveal opens, which is what keeps the bond pricing
the choice not to open. It is also the only thing the venue publishes coarsely
enough for the coalition budget to bind, so it is the first place that bound does
any work on the trading path.

Policy parameters, regimes and volume caps, with the parameter set addressed by
a root so that a change is a single visible event.

The call graph census, generated from source rather than maintained by hand, so
the claim about what each lifecycle path can reach is checkable.

A lender axe board. A lender posts a sealed coverage grid over collateral
class, size band and rate band; a borrower probes one cell and learns one bit,
the Turquoise Block Indication predicate, proved by a Merkle opening instead of
scored by an operator. The pre-trade privacy dial is the three FIX fields the
OTC research already named. The board and the exact-reveal book are two
parameter regimes: a probe publishes a bucket, and a bucket is the first cell
on rows 3 and 4 a coalition budget can bind.

A published rulebook and tariff. The document `Rulebook.sol` commits to is
`docs/RULEBOOK.md`, in the shape Form ATS-N asks for: one order type, no external
market data, price then pro rata, no halt, and a tariff of seven lines. Each
sourced line names the getter that holds it and `reconcile` reads it back, so a
charge the code makes and the page does not is visible to anyone. The venue's own
take is published as zero, which is the disclosure the fee question owes while it
stays open.

A halt, held as the mirror of the disclosure ceiling rather than as a pause key.
Narrowing what may be disclosed is the safe direction, so it is immediate and
unbounded; halting is the deprivation, so it is capped by an immutable grant,
budgeted per epoch, and expires by itself. It gates one function, `crossRound`,
so a halted venue cannot trade and cannot stop anyone leaving. In this
deployment the discretionary half has no caller, because the supervisor seat is
held by `VolumeCap`; what can fire is the breaker, and the breaker is arithmetic
on the venue's own clearing price.

A settlement fail, which is not a default. `maturity` was written, published and
never read: `close` had no maturity check and the only route to `DEFAULTED` ran
through a margin call, so a borrower who never closed left the repo `OPEN` and
the lender had no remedy. `FAILING` sits between the two, with a CSDR Article 7
cash penalty accruing daily from the intended settlement date and a grace before
default. The penalty runs from maturity rather than from the declaration, so a
fail nobody recorded still costs. Article 7(2) says the mechanism is not a
revenue source, and that is the clause the tariff can check rather than assert.

Two client pages, generated from the contracts rather than written beside them.
`commit-preview.html` derives the thirty-two bytes a trader is asked to sign from
the fields they chose, using the six-word preimage the contract will re-hash.
`disclosure-receipt.html` is the other end: after an action it prints what the
venue published, at what granularity, to whom, from when, and how much of that
row's epoch budget the action spent. Both are the five `DisclosureView` getters
and one hash, so the pages cost no new machinery. Each carries a client-side copy
of arithmetic the contract also performs, and each copy is pinned to the contract
by a vector suite that runs before the page is built.

The receipt is the part a competing venue cannot copy. A venue whose operator
reads the cleartext knows what it learned only as "everything it was sent", so it
has no quantity to print and no bound to print it against.

Seam D is live on Hedera testnet, and the fixture proofs verify against it
unchanged. `KycVerifier` is `0.0.10380608`, `ZkKycRegistry` is `0.0.10380610`,
`RegistrationGate` is `0.0.10380613`, all three source-verified on Sourcify. The
epoch arithmetic is what makes the fixtures portable: the tests warp to epoch 7
and a live chain cannot be warped, so `script/DeployKyc.s.sol` sets `epochZero`
seven epochs behind the deploy timestamp and the registry reads epoch 7 from
birth. A real PLONK proof verified in transaction
`0x93aa278fe234b1ed3c4ee430db016cf31dd62bc557bc443d8bcb9c21425dc543` for 368,066
gas, and the four negative fixtures refuse on-chain for the reasons they refuse
in the suite: `forged_root` returns `RootMismatch` carrying both roots, and the
three policy failures return `PolicyNotSatisfied`. Addresses and evidence are in
`deployments/296-kyc.json`.

The venue trades a real Asset Tokenization Studio bond, and the seams are live
calls rather than calls against a test double. `SeamMe Repo Collateral 2028`
(SEAMC, ISIN `XS0SEAMME017`) is `0.0.10381562`, deployed through the ATS factory
Hashgraph itself runs on testnet, `0.0.9213391`, over the resolver `0.0.9212226`
and its 108 facets. That deployment was cut from v8.0.0 `be4f860`, which is the
commit `src/observatory/SeamMap.sol` is generated from, so the 102 rows the
census asserts over are rows of this token and not of a private copy of ATS.
Building our own resolver was the alternative and it is the weaker one: the June
2026 run of `deploy:newBlr:hedera:testnet` cost 180 million gas over
twenty-eight minutes to produce a copy nobody else uses.

Four configuration choices carry the claim, and each is argued in
`script/DeployAtsBond.s.sol` rather than left to be inferred.
`internalKycActivated` is false: `KycStorageWrapper.verifyKycStatus` skips the
internal register when the flag is off and ANDs the external lists regardless,
so turning it off removes the *other* gate and leaves `ZkKycRegistry` as the only
thing between an address and the bond. `identityRegistry` is the zero address,
because seam E is not implemented here and a stub answering `true` would be a
seam the census counts and nothing enforces. `isMultiPartition` is false, which
turns the coincidence that the venue's partition constant already equalled ATS's
`_DEFAULT_PARTITION` into something `onlyDefaultPartitionWithSinglePartition`
enforces. And `compliance` was written after deployment rather than in the
factory call: `SeamJournal.token` is immutable and is the write side's only
accepted caller, so the token cannot name the journal before the journal exists
and the journal cannot be built before the token has an address.

Two findings came out of deploying rather than reasoning, and neither was
reachable from the suite.

The first cost a simulation. `SecurityData`'s upstream docstring says a
`maxSupply` of zero means unlimited; the bond configuration's `initializeCap`
reverts `NewMaxSupplyCannotBeZero()` on exactly that value.

The second cost a venue. **`msg.value` inside the Hedera EVM is denominated in
tinybars, not weibars.** Solidity's `ether` literal is 1e18 and every test in
this repo runs on an EVM where that is the unit `msg.value` counts in; Hedera's
relay takes a transaction's `value` in weibars, divides by 1e10, and the EVM
sees tinybars. So a `commitBond` of `0.01 ether` asks for 1e16 tinybars, which
is a hundred million HBAR, and the first `commit` came back
`WrongBond(1000000, 10000000000000000)`. The ratio was then measured rather than
assumed: 1e18 weibar arrives as 1e8 and 5e18 as 5e8, so 1e10 at two points.
Nothing in `src/` was wrong. `commitBond` is a `uint256` the deployer chooses
and the contracts are unit-agnostic; the deployment was wrong, which is the
correct place for a chain's native denomination to be decided and the wrong
place to discover it from a document. `Regime.bootstrapSupervisor` is single-use
by design, so fixing it meant redeploying the regime, the parameter root and
everything seated under them. The superseded addresses are recorded in
`deployments/296-venue.json` rather than quietly dropped.

The rest of the venue is up against it. `MatchingEngine` is `0.0.10381839` and
takes the bond as its `IHoldByPartition` and `SeamJournal` as its `ICompliance`;
until this deployment the only implementations of those two interfaces in the
tree were `AtsHolds` and `ComplianceSpy`, both declared inside
`test/MatchingEngine.t.sol`. `SeamJournal` was never a mock, it simply had no
token to be the compliance module of. The wiring order is the suite's:
`VolumeCap` takes the engine, `Regime.bootstrapSupervisor` then seats the cap,
and `attachVolumeCap` verifies `cap.venue() == engine`, so **the supervisor is a
contract and suspension is arithmetic rather than a person**.

`EpochClock` is new and is the first `IEpochClock` in the tree that is not a
test double. The suite's clocks tick by hand, which is correct for a test and
impossible on a chain. Its arithmetic is `ZkKycRegistry._epochAt` deliberately,
because two epoch definitions in one venue is a defect waiting for a boundary
condition. The deployment counts in five-minute epochs so the separation between
proposing a parameter set and adopting it is observable inside a session; the
honest cost of that is recorded on the contract, namely that a short epoch
shortens the worst-case wait without weakening the rule that a proposal cannot
land in the epoch it was made in.

The parameter matrix moved out of `test/PolicyFixture.sol` into
`script/PolicySets.sol` so the deploy script and the suite cannot publish
different sets, and `test/PolicySets.t.sol` pins the root that is on chain,
`0xb24633c7d8b306282e8ca5c25685c90ddab8b1764457f0d71fd1461b1d212454`. A row that
moves now breaks a test that names the deployment.

What is deployed is the trading and repo core: the engine, the vault, the
journal, the policy stack and the observatory. **The axe board is not**, and the
reason is a decision rather than an omission of work. `AxeBoard` takes an
`IRespondentRegistry` and the only implementation of it is
`RespondentRegistryMock` in `test/AxeBoard.t.sol`. A respondent registry answers
what kind of counterparty an address is, which is a classification somebody has
to be accountable for; writing one here would be inventing the policy rather
than implementing it, and a stand-in that answers the same for everybody makes
the coverage grid meaningless. It stays off chain until the classification has
an owner.

One live trade is the evidence, and it is in `deployments/296-venue.json`.
Issuing to an address with no credential reverts `InvalidKycStatus()` naming
that address; issuing to the seller succeeds; the seller encumbers a thousand
units with the engine as escrow; both sides commit sealed orders carrying no
side, price or size; both reveal; and `crossRound` executes the hold on the ATS
token at a uniform price of 100 against limits of 95 and 105, so neither side
got its own limit. That is the same arithmetic
`test_theRoundCrossesAndSettles` asserts against `AtsHolds`, run against a
diamond instead. `SeamJournal.epochRecord` then reads one issue of 4,000 in
epoch 1 and one transfer of 1,000 in epoch 4, with `unverifiedArrivals` zero on
both, which is the inference working rather than the seam not firing.

## Not built

Collateral substitution mid-term. Common in practice, deferred deliberately.

Zero knowledge settlement, as opposed to zero knowledge eligibility. The
dependency order for it is written down but the work is not done.

Cross-platform collateral mobility. The interfaces are written against a
collateral token rather than a specific one so that this stays open, but nothing
implements it.

## Blocked on a decision rather than on work

The liquidation auction discloses more than the rest of the system, because a
forced sale needs bidders. How much more is a policy question, not an
engineering one, and it is not settled.
