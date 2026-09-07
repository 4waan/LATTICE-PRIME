# venue

Tokenised collateral for repo, on Hedera, using the Asset Tokenization Studio.

Eligibility is decided by a zero knowledge proof instead of a public KYC
register, margin calls disclose a boolean instead of a price, and orders arrive
as fixed length commitments because on Hedera a plain limit order reaches twenty
nine node operators before any contract runs.

Collateral is marked against a live feed rather than an account's word. A seated
panel medians the bond's clean price, the cash leg comes from somewhere else,
and `markToMarket` is permissionless and stores nothing: the number that must
not be public is never written down.

Start at [docs/OUTLINE.md](docs/OUTLINE.md) for what is built and what is not,
and [docs/RULEBOOK.md](docs/RULEBOOK.md) for how the venue operates and what it
charges. [docs/EVIDENCE.md](docs/EVIDENCE.md) is why any of it matters, sourced
to the enforcement record and to what the collateral market is already doing.
[docs/disclosure-receipt.html](docs/disclosure-receipt.html) is the
shortest route to the thesis: act, and read back what the venue published about
you and what it has left to say.

The same record is published to a Hedera Consensus Service topic, ordered and
independently verifiable, and it carries the one thing the contracts structurally
cannot report about themselves: a positive record of a disclosure the venue
withheld. [docs/HCS.md](docs/HCS.md) is what was built and
[docs/HCS-SCOPE.md](docs/HCS-SCOPE.md) is why.

## Quick start

```
make all       build, compile the circuit, prove, generate fixtures, test
make test      the test suite
make census    measure the ATS lifecycle surface and regenerate SeamMap.sol
make pages     the trader-facing pages, after checking their vectors
make rulebook  the hash of docs/RULEBOOK.md, to republish after an edit
make report    constraint counts, deployed sizes against the contract size limit
make app       the six live screens, after checking their vectors
make hcs-relay publish the disclosure record to the consensus topic
make hcs-verify read the topic back and check every record against the chain
```

Node must be 22.x. Older versions fail in ways that look like circuit compiler
bugs, so every node target in the Makefile sets it explicitly.

## Layout

| | |
|---|---|
| `src/lattice/` | the disclosure model, executable |
| `src/kyc/` | the contract ATS calls on every transfer, and the gate that writes to it |
| `src/repo/` | the repo state machine, its arithmetic and the fail penalty |
| `src/oracle/` | the price feed: a quorum median, and the adapter that supplies its cash leg |
| `src/market/` | the commit and reveal order book, and the lender axe board |
| `src/policy/` | parameters, regimes, volume caps and the trading halt |
| `src/observatory/` | the attachment points, the call graph census, and the published rulebook |
| `src/interfaces/` | ATS seams and venue interfaces (`IEpochClock`, book, axe), plus two vendored ones declared in `NOTICE` |
| `circuits/` | the eligibility circuit and its fixture generators |
| `tools/` | the call graph extractor, the census generators, the client half of the contracts the pages run on, and the consensus topic relay and verifier |
| `docs/` | the outline, the rulebook, the evidence, the speed audit, the consensus topic scope and build, and two generated pages: [commit-preview.html](docs/commit-preview.html) before signing and [disclosure-receipt.html](docs/disclosure-receipt.html) after acting |
