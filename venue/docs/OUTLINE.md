# What is built

## Working

- Disclosure lattice and coalition budget, cheap enough for a transfer path
- Eligibility circuit + on-chain verifier; `RegistrationGate` pins prover-chosen signals
- Seam D (`ZkKycRegistry`) and seam C (`SeamJournal`) against live ATS
- Repo state machine, haircut/coupon/fail (CSDR Art. 7) arithmetic
- Commit–reveal book, cancel fee, uniform-price call auction, hold settlement
- Policy stack: `Regime`, `ParameterRoot`, `VolumeCap`, `TradingHalt`, `EpochClock`
- Axe board (tested, not deployed — needs a real `IRespondentRegistry` owner)
- Published rulebook (`docs/RULEBOOK.md`, hashed on chain)
- Trader pages: `commit-preview.html`, `disclosure-receipt.html`
- Live screens: landing, prove, trade, position, venue, repo (`make app`)

Live addresses and evidence: `deployments/`. Client wiring: `deployments/client.json`.

Hedera EVM `msg.value` is **tinybars** (1 HBAR = 1e8). JSON-RPC `value` is **weibars** (1e18). The relay divides by 1e10. Use `tools/units.mjs`.

## Not built

- Mid-term collateral substitution (`substitute` reverts by name)
- ZK settlement (eligibility only; see `docs/PLONKISH.md`)
- Cross-platform collateral mobility

## Blocked on a decision

Liquidation auction disclosure: a forced sale needs bidders. How much more it may say is policy, not engineering.
