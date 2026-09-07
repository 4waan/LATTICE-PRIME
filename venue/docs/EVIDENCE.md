# What the market already said

**Applied, 2026-09-06.** The six cards on the landing page now name the accident
before the contract, in the copy below. The enforcement record is above the fold
as one line. `Venue` in the nav is `Rulebook`. The repo gloss is on its first
appearance. The Prove screen no longer dead-ends: **No proof? Load the
issuer's** loads one of the three real proofs `make prove-live` generated, starts
watching that address read-only if the visitor's own is not one of the three, and
`wouldAccept` answers `true` against the live gate. Item 3 of the ranked list,
the consensus topic, is built: `docs/HCS.md`.

Still open, and both are the same gap the last section names: the three
practitioner conversations, and a hosting URL.

The front page names mechanisms. A Groth16 proof, a commit and reveal book, a
disclosure budget. Every one of those is true and none of them is a reason to
care, because a mechanism is an answer and the page never states the question.

This is the question, sourced. Everything below is a public document with a
figure attached, so a card on the landing page can say what failed rather than
what we built.

## The two failures this venue sits between

Institutional trading has produced the same accident twice, in opposite
directions, and the accidents are what pay for the design.

**The operator read the orders.** Between 2011 and 2016 the SEC settled with
essentially every major dark pool operator, and the findings are almost
interchangeable:

| Venue | Year | Penalty | The finding |
|---|---|---|---|
| Pipeline Trading | 2011 | $1m | An affiliate filled the majority of customer orders |
| UBS ATS | 2015 | $14.4m | Undisclosed order types shown to selected subscribers |
| ITG / POSIT | 2015 | $20.3m | A secret proprietary desk traded against subscriber flow |
| Barclays LX | 2016 | $70m | Misrepresented the feeds behind its own NBBO; admitted wrongdoing |
| Credit Suisse Crossfinder | 2016 | $84.3m | **Failed to treat subscriber order information confidentially, and transmitted confidential order information out of the dark pool to other Credit Suisse systems** |

The Credit Suisse line is the whole thesis in a regulator's words. Every one of
these venues promised confidentiality and every one of them was architecturally
capable of breaking the promise, because the operator held the cleartext. The
enforcement was not about cryptography failing. There was no cryptography. There
was a contract term, and a machine that could read the orders anyway.

**Nobody could see the aggregate.** Archegos cost Credit Suisse alone about
$5.5bn in 2021, and the mechanism was the mirror image: total return swaps let
one fund build a position across several prime brokers where no counterparty,
and no supervisor, could see the sum. Privacy was working exactly as sold.

These two bracket the design space, and most attempts fix one by causing the
other. A venue that hides everything from everyone is Archegos with better
tooling. A venue that lets the operator see so it can supervise is Crossfinder.

The disclosure lattice is the answer to being asked to choose. Disclosure is a
metered quantity with a published ceiling and a per-epoch budget, so the
supervisor's read and the counterparty's read are different rows with different
prices, and both are on the record.

## The market that is actually moving, with numbers

Tokenised collateral is not a thesis any more. It is a running business with
monthly volume statements.

- **Broadridge Distributed Ledger Repo** processed $7.4tn in August 2026, a
  daily average of $351bn, and nearly $9tn in December 2025. This is the
  incumbent for the exact instrument this venue trades.
- **J.P. Morgan Kinexys Digital Assets** has done about $300bn of intraday repo
  and more than $3tn across the platform.
- **The GDF and ISDA U.S. Tokenized Money Market Fund report** (2026) is the
  category's own statement of the problem. More than 300 participants from over
  120 firms, with a sandbox run by Ownera whose participants included BlackRock,
  Brown Brothers Harriman, Citi, CME Group, Fidelity, Franklin Templeton, ICE,
  Invesco, J.P. Morgan Asset Management, State Street, Standard Chartered, U.S.
  Bank and WisdomTree. It covers UCC characterisation, settlement finality,
  insolvency treatment, bilateral variation margin, cleared initial margin
  cascades and UMR-compliant segregation. That is our product's regulatory
  surface, written up by the people who will buy it.
- **The SEC's Treasury clearing mandate** bites on 31 December 2026 for eligible
  cash transactions and 30 June 2027 for eligible repo. Every US Treasury repo
  participant is rebuilding its repo plumbing inside the next eighteen months.
  That is the window, and it is dated.

Two caveats on sourcing, because a judge will check.

The claim that Hedera is named twelve times in the GDF/ISDA paper comes from a
Reddit reader's own count and has not been verified here. Cite the report, not
the count.

A conference talk titled "The Settlement Layer Wall Street Already Trusts" could
not be found. The verifiable version of that claim is that FATF's 2026 DeFi
report lists Hedera alongside Ethereum and Solana as an example of a settlement
layer, and that Archax mints pool tokens on Hedera bundling money market funds
from BlackRock, State Street and Legal & General. Use those; do not cite a talk
nobody can find.

## Who else is in this space, and the one thing they cannot do

Everyone in this category falls into one of two families, and each family is
missing the other's half.

**Family one: institutional tokenised repo.** Broadridge DLR, J.P. Morgan
Kinexys, HQLAx, Fnality. Real instruments, real volume, real legal opinions.
Their privacy model is *membership*: you are private because the network is
permissioned and outsiders are not admitted. Nothing is proved and nothing is
metered. If the operator learns something about your position there is no
mechanism by which you could find out, and no quantity anyone could put on it.
This is Crossfinder's architecture with a better operator, and the enforcement
record above is what that is worth when the operator is worse.

**Family two: crypto privacy venues.** Renegade runs MPC matching with
zero-knowledge settlement on Arbitrum and Base. Penumbra runs sealed-bid batch
auctions on Cosmos, where a block's orders clear at a single price so nobody can
react to anyone. The cryptography is real and, in Penumbra's case, mechanically
close to this venue's call auction. What is absent is everything an institution
is legally obliged to have: no eligibility rule, no supervisor, no regulated
instrument, no settlement fail regime, and above all no disclosure accounting.
Privacy is binary. A regulated venue cannot be binary, which is why nobody at a
bank can use one of these.

**Where Lattice Prime is different, in one sentence:** it is the only one of the three
that can print a *quantity*. `docs/OUTLINE.md` already says why, and it is the
line the front page should be built around:

> A venue whose operator reads the cleartext knows what it learned only as
> "everything it was sent", so it has no quantity to print and no bound to print
> it against.

That is not a feature comparison. It is a claim about what a competitor is
structurally unable to build, which is the only kind of differentiation worth
putting on a landing page.

## The front page, rewritten against the failures

The six cards under "What makes it different" each name a contract. Each should
name the accident instead, and then the contract. Suggested copy, one per card,
in the "this is what happened, this is what happens here" shape the cards are
already sized for.

**01 · Orders are sealed, not merely hidden.**
Before: Credit Suisse settled for $84.3m after subscriber order information left
its dark pool for other Credit Suisse systems. The venue held the cleartext, so
the confidentiality was a contract term.
Here: an order reaches the chain as a keccak commitment. Side, price and size are
not on the wire, so there is no cleartext for an operator to be trusted with.
`MatchingEngine.commit`

**02 · Eligibility without identity.**
Before: getting into a regulated venue means handing a counterparty a permanent
copy of who you are, which every venue then has to defend and none of them can
un-learn.
Here: a proof answers tier and jurisdiction against an issuer root that rolls
every KYC epoch. The venue learns one bit and stores one bit.
`ZkKycRegistry` · PLONK over a universal ceremony

**03 · A disclosure budget the chain enforces.**
Before: Archegos built a position across several prime brokers and cost Credit
Suisse about $5.5bn, because privacy had no supervisory counterpart and nobody
held the sum.
Here: disclosure is metered. Every read that leaks spends bits from a per-epoch
budget with a published ceiling, so a supervisor can be answered without the
venue becoming an open book.
`SeamJournal.spentBits`

**04 · Cancel and reveal never overlap.**
Before: the last-look window is where information advantage lives, and it exists
in most venues because the two windows are defined separately and drift.
Here: both windows come off one timestamp and are disjoint by construction.
There is no instant in which you can watch a reveal land and still pull your own
order.
`cancellableUntil(id)`

**05 · Margin you can believe, or told plainly that you cannot.**
Before: a margin figure with no statement of its own reliability is how a stale
position becomes a default nobody saw.
Here: the watcher returns the position and, separately, whether the log behind it
was audible. A row can be permitted and unreliable at once, and it says so.
`MarginWatch.watch`

**06 · Fair ordering, and a fee you can predict.**
Before: on a public book the resting order is the leak, and the mempool is where
somebody else gets paid for reading it.
Here: Hedera orders by consensus timestamp. No mempool to be front-run in and no
gas auction to lose.
Hedera consensus

Two structural notes on the page itself.

The hero is right and should not change. "Trade size without showing it" is the
sentence, and the lead already states the failure rather than the mechanism.

What is missing above the fold is the *stakes*. One line of the enforcement
record, stated as fact with the figure attached, does more work than any of the
six cards. Something in the shape of: five dark pools, $190m of settlements, one
finding repeated in each of them.

## The vocabulary question

Three separate worries, and only one of them is real.

**"Venue" is correct and should stay in the prose.** It is the term of art in
MiFID II and in Form ATS-N, which is the document `Rulebook.sol` is shaped
against. To the audience this product is for it reads as competence, and swapping
it for "platform" or "exchange" would be a downgrade. Keep it.

**"Venue" as a navigation item is wrong.** Look at the nav: Prove, Trade,
Position, Repo, Venue. The first four are things you do or things you hold. The
fifth is the place you are standing in, which is not a peer of the other four,
and a visitor clicking it has no idea what they are about to see. What is
actually on that screen is the regime, the volume cap, the trading halt, the
parameter root, the rulebook, the journal and the clock. That is the supervision
surface. **Rename the nav item to "Rulebook" or "Oversight"** and the whole nav
becomes readable in one pass.

**"Repo" needs one gloss and no more.** It is the product and it is not
negotiable, but the landing page never says in plain words what a repo is. One
clause the first time it appears is enough: a repo is borrowing cash against
collateral, with an agreement to buy the collateral back.

## The step that dead-ends, which is the real ease-of-use problem

The three-step flow is well built and correctly ordered. Step one cannot be
completed by anybody who is not us.

`prove.html` says "Drop a proof file, or click to choose one." A judge does not
have a proof file. Generating one needs the circom toolchain, node 22, and about
twenty-three seconds per address. So the first screen of a three-screen product
is a wall, and the second and third are gated behind it.

Worse, the landing page and the prove screen disagree about this in writing. The
landing page said the circuit "is proved in the browser tab"; the prove screen
says "This page does not prove in the browser." One of those was going to be read
aloud in a demo. The landing copy has been corrected.

Three ways out, cheapest first.

1. **Ship the demo proofs.** Put the pre-generated proofs for the three live
   addresses behind a link on the prove screen: "No proof? Load the issuer's demo
   proof." One click, no toolchain, and it is honest because those proofs are
   real and verify on chain. This is an hour of work and it removes the wall for
   everybody who is watching rather than trading.
2. **Watch mode should be the default landing state on Prove.** The screen
   already supports watching an address read-only. A visitor with no wallet
   should arrive at a screen that is already showing a real grant, not one
   waiting for them.
3. **Proving in the tab** is the honest version of the original claim, but it is
   twenty-three seconds and it is demo-hostile. Do not put it on the critical
   path of a four-minute video.

## HIP-1535 and CLPR, stated accurately

The forward-looking answer here is worth more than the integration would be, and
the integration is not available.

**Status, checked.** CLPR is HIP-1535, "CLPR: A Cross Ledger Protocol for Hiero",
authored by Richard Bair, Edward Wertz and Leemon Baird. It exists as pull
request #1535 against `hiero-ledger/hiero-improvement-proposals`, created
2026-08-18 and still open. Front matter: `type: Standards Track`,
`category: Service`, `status: Draft`, `needs-hiero-approval: Yes`,
`needs-hedera-review: Yes`.

Category Service is the decisive word. CLPR is a native Hiero service that ships
in a network release, not a contract anyone can deploy. There is no system
contract address, no testnet channel, and no `sendMessage` to call. Claiming an
integration would be checked in about ninety seconds and found false.

**What can honestly be claimed is better.** The specification contains this, in
its Rationale:

> **No confidentiality, by design.** CLPR provides integrity and authenticity of
> message payloads but stores them in plaintext on both ledgers. [...]
> Applications that need confidentiality encrypt at the application layer.

CLPR hands the confidentiality problem back to the application, and this venue's
order payload is already the answer to it. A commitment is thirty-two bytes,
fixed length, and content-free. Routed across a CLPR channel it would leak size,
timing, sender and connector, which is precisely the metadata set CLPR names as
irreducible, and precisely the metadata this venue already meters on rows 13 to
15. **The order format is CLPR-safe today, and that is a design claim we can make
and defend without shipping anything.**

There is a second, smaller point that lands well with a Hedera audience. CLPR
chose a two-phase commit-reveal for channel and connector registration, for this
reason:

> A naive "claim the ID you want" flow is subject to cross-chain front-running
> [...] The two-phase commit-reveal scheme closes this window.

The venue's order book is the same construction applied to the same problem one
layer up. Hashgraph's own architects reached for commit-reveal against
front-running while this was being built. That is independent validation of the
mechanism, and it costs nothing to say.

**The one-slide design, for when CLPR lands.** Outbound message is the
commitment, never the opening. Reveal and settlement stay on the ledger the
collateral lives on, because the ATS hold is the escrow and a hold does not
travel. The lattice grows one column, a cross-ledger observer, and rows 3, 4 and
12 acquire a time value for it. That is a paragraph in the roadmap and a diagram
in the deck, and it is worth more than a fake integration.

## Features worth building, ranked by points per hour

Against the published rubric, where Success is 20%, Execution 20%, Integration
15% and Validation 15%.

1. **Get three practitioner conversations on the record.** Validation is 15% of
   the grade and this project currently has nothing on it, which is a hard cap
   at roughly a third of those points. Three fifteen-minute calls with anyone who
   has worked a repo or collateral desk, written up with what they said and what
   changed as a result, is the cheapest fifteen percent available. Nothing else
   on this list has a better ratio.
2. **Deploy the app to a URL.** There is no hosting configured. `DEMO-4MIN.md`
   ends the video by saying the URL out loud. Six static files and a vendored
   runtime; any static host will do.
3. **Publish the receipt to a Hedera Consensus Service topic.** This venue uses
   the Hedera EVM and the mirror node REST index and nothing else. No HCS, no
   scheduled transactions, no direct token service calls. The Integration rubric
   asks which services are used and whether one is used in a way that has not
   been seen before. The disclosure receipt is the product's whole thesis and it
   currently exists only as contract state a client renders. Writing each receipt
   to an HCS topic makes the disclosure record an ordered, independently
   verifiable stream with a consensus timestamp, which is a genuine use of the
   service rather than a bolt-on, and it produces one message per action, which
   is the metric Success is scored on.
4. **A scheduled reveal, via the Hedera Schedule Service.** Commit an order and
   schedule its reveal in the same breath, so that opening the order does not
   depend on the trader still being willing or able when the window arrives.
   This is a real repo-desk concern and no other chain can express it natively.
   It scores on Innovation and Integration at once.
5. **The demo proof link** from the section above. An hour, and it unblocks
   every visitor.

Held back deliberately: CLPR, for the reason above; a second collateral class,
because it multiplies the census surface without changing the argument; and
browser-side proving, because twenty-three seconds is not a demo.

## Sources

- [SEC, Barclays and Credit Suisse charged with dark pool violations (2016)](https://www.sec.gov/newsroom/press-releases/2016-16)
- [NY Attorney General, landmark dark pool resolutions, combined penalties over $154m](https://ag.ny.gov/press-release/2016/ag-schneiderman-announces-landmark-resolutions-barclays-and-credit-suisse)
- [GDF and ISDA, Unlocking Capital with U.S. Tokenized Money Market Funds for Collateral Mobility](https://www.gdf.io/resources/unlocking-capital-with-u-s-tokenized-money-market-funds-for-collateral-mobility/)
- [Ownera, industry sandbox findings](https://www.ownera.io/news/industry-sandbox-findings-powered-by-ownera)
- [SEC, extension of Treasury clearing compliance dates to 31 Dec 2026 and 30 Jun 2027](https://www.sec.gov/newsroom/press-releases/2025-43-sec-extends-compliance-dates-provides-temporary-exemption-rule-related-clearing-us-treasury)
- [Broadridge, Distributed Ledger Repo monthly volumes](https://www.broadridge.com/press-release/2026/broadridges-dlr-processes-over-7-trillion-in-june)
- [Kinexys by J.P. Morgan, digital financing](https://www.jpmorgan.com/kinexys/digital-assets/digital-financing)
- [HIP-1535, CLPR, pull request](https://github.com/hiero-ledger/hiero-improvement-proposals/pull/1535)
- [Hashgraph, CLPR](https://hashgraph.com/clpr/)
- [Renegade documentation](https://docs.renegade.fi/core-concepts/dark-pool-explainer)
- [Hedera hackathon judging criteria](../../JUDGING-CRITERIA.md), local copy
