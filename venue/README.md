# venue

Tokenised collateral for repo, on Hedera, using the Asset Tokenization Studio.

Eligibility is decided by a zero knowledge proof instead of a public KYC
register, margin calls disclose a boolean instead of a price, and orders arrive
as fixed length commitments because on Hedera a plain limit order reaches twenty
nine node operators before any contract runs.

Start at [docs/OUTLINE.md](docs/OUTLINE.md) for what is built and what is not,
and [docs/RULEBOOK.md](docs/RULEBOOK.md) for how the venue operates and what it
charges.

## Quick start

```
make all       build, compile the circuit, prove, generate fixtures, test
make test      the test suite
make census    measure the ATS lifecycle surface and regenerate SeamMap.sol
make rulebook  the hash of docs/RULEBOOK.md, to republish after an edit
make report    constraint counts, deployed sizes against the contract size limit
```

Node must be 22.x. Older versions fail in ways that look like circuit compiler
bugs, so every node target in the Makefile sets it explicitly.

## Layout

| | |
|---|---|
| `src/lattice/` | the disclosure model, executable |
| `src/kyc/` | the contract ATS calls on every transfer, and the gate that writes to it |
| `src/repo/` | the repo state machine, its arithmetic and the fail penalty |
| `src/market/` | the commit and reveal order book, and the lender axe board |
| `src/policy/` | parameters, regimes, volume caps and the trading halt |
| `src/observatory/` | the attachment points, the call graph census, and the published rulebook |
| `src/interfaces/` | ATS interfaces, Apache 2.0 |
| `circuits/` | the eligibility circuit and its fixture generators |
| `tools/` | a Solidity call graph extractor and the census generators |
