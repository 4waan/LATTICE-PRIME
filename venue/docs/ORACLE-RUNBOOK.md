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

1. The Mirror Node record contains exactly one `RoundCrossed`, settled fills,
   and no degraded or refused settlement output.
2. Every settled counterparty resolves from `MatchingEngine.orders`.
3. Buyer and seller differ.
4. No counterparty is on `auction.excludedAddresses`.
5. Settled volume equals the crossed indicated volume, and the configured
   freshness, minimum-volume, and outlier limits pass.

All bot actors are excluded. Their job files intentionally divide the economic
price by 1,000, so their prints are simulation traffic and not valuation
evidence.

No auction plus no signed dealer quote yields `SOURCE_QUORUM`. This state is
supposed to leave the feed dark. It must not be converted to a green status by
reusing the previous price or weakening the source count.

## Publisher isolation

Copy `oracle/config.example.json` to the ignored `oracle/config.json`. Configure
dealer endpoints, dealer addresses, market cross-check, and quality limits.

For containers, make one config per publisher under `oracle/profiles/`. Give
every config a distinct `sourceProfile` and, where providers exist, a separately
operated RPC, Mirror Node, and dealer delivery path. The source profile is
committed into the configuration and aggregate source digests. The Compose
example uses distinct config paths for each process. Production dealer quotes
arrive over HTTPS from the institutional endpoint. File quote mounts stay
available only for explicit local tests.

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

Persistent hosting uses one Fly app per publisher so each process sees only its
own key. The checked-in Fly files are
`oracle/packaging/fly.publisher-a.toml`,
`oracle/packaging/fly.publisher-b.toml`, and
`oracle/packaging/fly.publisher-c.toml`. Each app has one always-on Machine,
automatic stopping disabled, a 512 MB VM, a 1 GB encrypted `/state` volume with
fourteen day snapshot retention, and a read-only `/healthz` check. Deploy each
app from the repository root so the Dockerfile copy paths resolve. Install
secrets per app. Do not put more than one publisher key in any shared file or
image. Stop local publisher copies of those keys before starting the Fly apps.

Watch `/healthz` from an external checker as well as the Fly HTTP check. Alert
when the status is not HTTP 200. A failing Fly health check does not by itself
restart the Machine. Keep the always-on restart policy and the stalled-worker
alert.

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

Add the dealer address to `dealers.allowedAddresses` or
`ORACLE_DEALER_ADDRESSES`. Serve the quote from the institutional HTTPS
endpoint. Quotes are bound to chain 296, the deployed oracle, the bond address,
an expiry, a nonce, and the source packet hash. The unsigned `source` label is
not used for identity or authorization. The recovered signer is.

The signing utility is for tests and institutional onboarding. Do not run it as
a production daemon. Historical scheduler and canary records that name the
earlier testnet simulation remain accurate for those rounds.

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

The current bounded scheduler is Hedera contract `0.0.10456288`, EVM address
`0x405c034ec3ba7839e348ed3536f0bcff15cfbff9`. Its deployment record verifies
the PrimeOracle and treasury bindings, live runtime bytecode, immutable-masked
artifact match, 10 HBAR funding receipt, and the eight-attempt cap.

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

The superseded pre-attempt-budget scheduler's successful testnet round 2
measured the costs rather than inferring them from gas limits:

- the acceptance process shortened only its off-chain keepalive trigger to one
  second; source validation, HCS-first ordering, onchain quorum, scheduler
  timing, and the restored four-hour production setting were unchanged;
- the schedule-creating arm transaction consumed 1,537,115 gas and was charged
  1.6908265 HBAR;
- two publishers raced that arm, safely hit the idempotent active-schedule
  branch, consumed 23,740 gas each, and were charged 0.026114 HBAR each;
- the scheduled finalization consumed 139,253 of its 2,000,000 gas limit and
  was charged 0.1531783 HBAR from the scheduler;
- the direct create-plus-execute path cost 1.8440048 HBAR;
- including both observed race transactions, the round cost 1.8962328 HBAR, or
  about $0.14617 at the immediately following `0x168` network conversion rate
  of $0.07708266 per HBAR;
- six four-hour keepalive rounds at that race-inclusive cost are about $0.88
  per day.

The final bounded scheduler then completed round 3 through HSS:

- the schedule-creating arm cost 1.70859969 HBAR;
- two idempotent race calls cost 0.02635140 HBAR each;
- deferred execution used 161,686 gas and cost 0.17947146 HBAR;
- the direct path cost 1.88807115 HBAR and the race-inclusive observed total
  was 1.94077395 HBAR, about $0.14801 at the following `0x168` network
  conversion rate;
- at six ordinary four-hour rounds per day, that observed pattern is about
  $0.89 per day;
- four unchanged-answer checks and eight total scheduling attempts per round
  are hard count limits. Fees remain network-priced, so extrapolated HBAR or
  USD figures are measurements rather than monetary ceilings.

The later natural NY Fed SOFR update finalized round 4 through the same
scheduler. Its direct path cost 1.88112569 HBAR and its race-inclusive total
was 1.93477809 HBAR, about $0.14528 at the following `0x168` rate. This second
measurement is the current institutional planning value; it remains a network
measurement rather than a fixed fee quote.

These are testnet measurements, not a fixed quote. The arm caller pays schedule
creation. The scheduler pays deferred execution. A permanent one-minute timer
would multiply both costs and remains prohibited. These figures cover scheduler
arming and finalization only; publisher answer transactions, HCS evidence, and
off-chain source retrieval are separate.

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
make oracle-acceptance
make oracle-acceptance-finalize
```

The verifier reads each topic from sequence one, checks the publisher hash
chain, fetches the named EVM transaction independently from Mirror Node, decodes
`PrimeOracle.submit`, compares price, rate, round, sender, and target, then
proves that HCS consensus preceded EVM submission. It also reads
`panelOf(round)` for every in-scope round, rejects an onchain answer without one
matching HCS record, and fails closed on pending, expired, invalid, missing, or
unreadable evidence. Round 1 of the current oracle is explicitly outside this
evidence scope because it was the documented migration round before HCS-first
publishing; verification begins at round 2.

`oracle-acceptance` refuses a scheduler deployment record or onchain scheduler
bound to any oracle other than the current address book. It must start from the
latest round and observe both a later source-driven round and one full heartbeat.
Historical baselines are refused. After the monitor ends,
`oracle-acceptance-finalize` reruns fail-closed HCS and exact panel verification.
It only accepts a later source round when quorum evidence carries a
trigger-specific changed source identity, so a migration baseline or misleading
`NEW_SOFR` label cannot satisfy the gate.

Run `make oracle-health ORACLE_PROFILE=issuer`, `seller`, or `buyer` against
the corresponding state volume. The default profile is `issuer`; each
container invokes the same check using its own `ORACLE_PUBLISHER_ID`.

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
