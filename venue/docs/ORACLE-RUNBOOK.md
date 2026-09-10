# Hedera-native oracle runbook

## What is native and what is not

The recovery uses Hedera Mirror Node for auction evidence, Hedera Consensus
Service for immutable publisher evidence, Hedera Schedule Service at `0x16b`
for event-driven quorum checks, and the Hedera exchange-rate system contract at
`0x168` for the cash conversion already seated by `HederaRateFeed`.

The `0x168` value is the Hedera network fee conversion rate. It updates roughly
hourly and is not guaranteed to be spot market data. Every publisher therefore
compares it with a separately configured HBAR/USD market feed and stops when
the two exceed the configured divergence cap.

Hedera does not publish SOFR or a private LPRC clean price. SOFR comes from the
New York Fed. Clean price comes from qualified venue auctions, checked against
the fixed-point floating-rate model. When there is no qualified auction, the
fallback requires the model and at least one allowlisted signed dealer quote.

## Fail-closed source policy

An exact auction print qualifies only when:

1. The Mirror Node record contains `RoundCrossed` and settled fills.
2. Every settled counterparty resolves from `MatchingEngine.orders`.
3. Buyer and seller differ.
4. No counterparty is on `auction.excludedAddresses`.
5. Settled volume, freshness, and outlier limits pass.

All bot actors are excluded. Their job files intentionally divide the economic
price by 1,000, so their prints are simulation traffic and not valuation
evidence.

No auction plus no signed dealer quote yields `SOURCE_QUORUM`. This state is
supposed to leave the feed dark. It must not be converted to a green status by
reusing the previous price or weakening the source count.

## Publisher isolation

Copy `oracle/config.example.json` to the ignored `oracle/config.json`. Configure
dealer endpoints, dealer addresses, market cross-check, and quality limits.

Create three secret files from
`oracle/packaging/publisher.env.example`. Each file uses the same generic
variable names but contains only one publisher key:

```text
ORACLE_PUBLISHER_ID=publisher-a
ORACLE_PUBLISHER_ACCOUNT_ID=0.0.x
ORACLE_PUBLISHER_PRIVATE_KEY=one ECDSA key
ORACLE_EVIDENCE_TOPIC_ID=0.0.y
```

Never put `HEDERA_PRIVATE_KEY` or numbered publisher key variables into a
publisher process. The runtime rejects those layouts. The Compose example
mounts one secret file and one state volume into each container.

Create one immutable HCS evidence topic per publisher:

```sh
make oracle-topic
```

The topic has the publisher public key as submit key and no admin key. Record
the returned topic ID in that publisher's secret file. The same one key pays
for HCS evidence and signs `PrimeOracle.submit`.

Start one process:

```sh
make oracle-publisher
```

Start all three isolated containers:

```sh
docker compose -f oracle/packaging/compose.example.yaml up -d
```

Each answer is signed before broadcast so its EVM transaction hash is known.
The process writes a durable `PREPARED` journal, waits for the HCS evidence
receipt, marks the entry `EVIDENCED`, then broadcasts the exact signed
transaction. A restart resumes this sequence without recomputing or changing
the answer.

## Dealer quote operation

A dealer keeps `DEALER_QUOTE_PRIVATE_KEY` outside every publisher process. The
source packet can contain pricing inputs or a dealer system receipt. Sign it:

```sh
node oracle/sign-dealer-quote.mjs \
  --price-usd 100.00 \
  --source dealer-source.json \
  --output dealer-quote.json
```

Add the dealer address to `dealers.allowedAddresses`. Serve the quote through
HTTPS or mount it read-only and configure a `file:///quotes/dealer-quote.json`
endpoint. Quotes are bound to chain 296, the deployed oracle, the bond address,
an expiry, a nonce, and the source packet hash.

## HSS finalization

Deploy the scheduler once:

```sh
make oracle-scheduler MODE=deploy
```

Fund it, then arm it if a round already has an answer:

```sh
make oracle-scheduler MODE=fund FUND_HBAR=50
make oracle-scheduler MODE=arm
```

`OracleScheduler.tick` reads the open panel and calls `finalize` only after
`quorum()` answers exist. A failed finalize, malformed system-contract reply,
capacity refusal, or low balance becomes an event. It does not revert the
check. Anyone can call `tick` as a fallback.

This is not a permanent timer. The first publisher answer arms one check. A
successful finalization stops scheduling. Short quorum backs off through 5
minutes, 15 minutes, and 1 hour, then stops after four checks for an unchanged
answer set. A new answer may rearm it, but no round can create more than eight
checks. An empty round cannot be armed.

That bound is part of the institutional cost control. Hedera prices a
ScheduleCreate containing a contract call at about $0.10 before the documented
20 percent system-contract markup and execution gas. A one-minute permanent
timer would therefore cost thousands of dollars per month. The event-driven
path normally creates one schedule per oracle round.

`MIN_BALANCE_TINYBAR` is only a guard before creating the next check. It is not
the fee and it does not reserve 5 HBAR. Actual charges are defined in USD by
Hedera, converted to HBAR at the network rate, and deducted from the scheduler
as calls execute. Monitor actual transaction fees, `activeSchedule`,
`nextCheckAt`, scheduler balance, `checksThisRound`, and `CheckUnscheduled`
events.

The successful testnet round 3 acceptance measured the costs rather than
inferring them from gas limits:

- the publisher's arm transaction consumed 1,532,015 gas and was charged
  1.7158568 HBAR;
- the scheduled finalization consumed 133,018 of its 2,000,000 gas limit and
  was charged 0.14898016 HBAR from the scheduler;
- total HSS automation cost was 1.86483696 HBAR, or about $0.14147 at the
  contemporaneous `0x168` rate of $0.075862 per HBAR;
- six four-hour keepalive rounds at that measured cost are about $0.85 per day.

These are testnet measurements, not a fixed quote. The arm caller pays schedule
creation. The scheduler pays deferred execution. A permanent one-minute timer
would multiply both costs and remains prohibited.

Hedera executed the first acceptance schedule at its expiry second while the
EVM block timestamp was one second behind. `EXECUTION_CLOCK_TOLERANCE` admits
that measured two-second boundary without allowing materially early checks.
The treasury can recover remaining funding with
`make oracle-scheduler MODE=withdraw` after confirming no schedule is active.

## Verification and exact failure states

Run local and live-read checks:

```sh
make oracle-test
make oracle-dry-run
make oracle-evidence-verify
```

The verifier reads each topic from sequence one, checks the publisher hash
chain, fetches the named EVM transaction independently from Mirror Node, decodes
`PrimeOracle.submit`, compares price, rate, round, sender, and target, then
proves that HCS consensus preceded EVM submission.

Common withholding codes:

* `SOURCE_QUORUM`: no qualified auction and no model plus dealer quorum.
* `SOURCE_DIVERGENCE`: qualified auction and fallback disagree.
* `HBAR_MARKET_UNAVAILABLE`: required spot cross-check could not be read.
* `HBAR_RATE_DIVERGENCE`: `0x168` and market HBAR/USD exceed the cap.
* `ORACLE_DEVIATION_CAP`: a truthful valuation cannot pass the deployed
  round-to-round cap. Do not stair-step a false price. Governance must address
  the stale contract.
* `NOT_SEATED`: this process has the wrong key or the panel changed.
* `ALREADY_ANSWERED`: this publisher has already answered the open round.
* `NOT_DUE`: process is healthy, but neither movement nor keepalive requires a
  new round.
