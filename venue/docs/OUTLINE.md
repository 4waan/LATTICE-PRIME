# What is built

## Working

- Disclosure lattice and coalition budget, cheap enough for a transfer path
- Eligibility circuit + on-chain verifier; `RegistrationGate` pins prover-chosen signals
- Seam D (`ZkKycRegistry`) and seam C (`SeamJournal`) against live ATS
- Repo state machine, haircut/coupon/fail (CSDR Art. 7) arithmetic
- `PrimeOracle`: quorum median clean price and coupon reference rate, composed
  with a seated HBAR/USD feed in Chainlink's `AggregatorV3Interface` shape.
  `RepoVault.markToMarket` is permissionless and stores nothing; `postMark`
  narrows to the dark-feed path
- `HederaRateFeed`: that seat, on Hedera, over the network's own rate at `0x168`.
  Chainlink runs HBAR/USD here and **refuses a contract caller**, measured on
  both networks in `probes/chainlink-hedera.out`
- Commit–reveal book, cancel fee, uniform-price call auction, hold settlement
- Policy stack: `Regime`, `ParameterRoot`, `VolumeCap`, `TradingHalt`, `EpochClock`
- Axe board (tested, not deployed — needs a real `IRespondentRegistry` owner)
- Published rulebook (`docs/RULEBOOK.md`, hashed on chain)
- Trader pages: `commit-preview.html`, `disclosure-receipt.html`
- Live screens: landing, prove, trade, position, venue, repo (`make app`)

Live addresses and evidence: `deployments/`. Client wiring: `deployments/client.json`.

Hedera EVM `msg.value` is **tinybars** (1 HBAR = 1e8). JSON-RPC `value` is **weibars** (1e18). The relay divides by 1e10. Use `tools/units.mjs`.

## Not built

- Coupon schedule and distributor (the feed's first consumer, `docs/BUILD-REMAINING.md`)
- Native scheduled settlement at `0x16b` (spiked, not in `src/`)
- Commit-reveal on oracle submissions: the panel answers in the open, so a
  publisher who answers last has seen the others. Bounded by the median and the
  deviation cap rather than by secrecy; `docs/manipulation-surface.md` says so
- Mid-term collateral substitution (`substitute` reverts by name)
- ZK settlement (eligibility only; see `docs/PLONKISH.md`)
- Cross-platform collateral mobility

## Blocked on a decision

Liquidation auction disclosure: a forced sale needs bidders. How much more it may say is policy, not engineering.
