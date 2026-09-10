# Frontend integration

How a client talks to the live venue. Addresses and immutables: `deployments/client.json` (`make client`). Do not hardcode numbers from this file.

Companion: `docs/UI-PLAN.md` (what to build). Units: `tools/units.mjs`.

## Network

| | |
|---|---|
| chain | 296 (`0x128`) |
| RPC | `https://testnet.hashio.io/api` |
| mirror | `https://testnet.mirrornode.hedera.com` |
| wallet | MetaMask / `window.ethereum`. ECDSA secp256k1 only |

### Units

| quantity | unit |
|---|---|
| `commitBond`, `cancelFee`, `credit`, escrow, `notional` | tinybar (1 HBAR = 1e8) |
| tx `value` | weibar (1e18). Relay ÷ 1e10 |
| `qty`, token balances | no decimals (`decimals: 0`) |

`toWeibar(tinybar) = tinybar * 10n**10n`. Never `parseEther`. `notional` halves the product, never the price.

## Wiring (assert at load)

```
engine.security()    == the bond
engine.compliance()  == SeamJournal
engine.policy()      == ParameterRoot
engine.volumeCap()   != 0
engine.tradingHalt() != 0
token.compliance()   == SeamJournal
token.isExternalKycList(ZkKycRegistry) == true
vault.oracle()       == PrimeOracle
```

Refuse to render if any fail. Skip `superseded` addresses in `296-venue.json`.

## Three clocks

Never derive one from another. Read the getter. Origins and periods are in `client.json`.

| clock | governs |
|---|---|
| round (`engine.genesis`) | reveal, rest, `crossRound` |
| disclosure epoch (`ParameterRoot` / `SeamJournal`) | budgets, `spentBits` |
| KYC epoch (`ZkKycRegistry`) | grants, nullifiers, proof signal 3 |

A receipt for a specific tx must take the epoch from that block's timestamp, not `currentEpoch()` at render time.

## Screen 1 · Register

Reads: `currentEpoch`, `rootForEpoch`, `minTier`, `jurisdictionMask`, `MAX_USES_PER_EPOCH`, `getKycStatus`, `usesThisEpoch`.

Call `wouldAccept(account, pub)` before `register`. Pin table: `docs/MATH.md`.

`register` is permissionless in `msg.sender`; signal 4 binds the account.

## Screen 2 · Trade

Hold (sell, on the **bond**):

```
createHoldByPartition(partition, Hold{
  amount:              >= qty
  expirationTimestamp: >= engine.roundEnd(firstRound + restRounds)
  escrow:              MatchingEngine
  to:                  address(0)
  data:                ""
})
```

`firstRound` is the round **reveal** lands in. Hold ids are per holder, not enumerable; a missing id returns zeros and `_bind` reverts `NotEscrow(0)`. `balanceOfByPartition` excludes held units.

Commit:

```
id = engine.commitmentOf(committer, side, price, qty, salt)
engine.commit(id)  value = toWeibar(commitBond)
```

Encrypt and verify the ticket (including its salt) **before** a hold or commit is sent. No salt ⇒ no reveal ⇒ bond is forfeit.

Windows from `committedAt` (delay D, window W):

```
cancel  [committedAt, committedAt + D)
reveal  [committedAt + D, committedAt + D + W]
forfeit (committedAt + D + W, ∞)
```

`cancellableUntil(id)` is exclusive; zero means terminal, a past timestamp means the window already shut.

### Reveal-key custody

The client stores tickets in IndexedDB with AES-256-GCM. Each write uses a unique 12-byte IV and authenticated metadata for the schema, chain, matching engine, and submitting account. The device key is a non-extractable `CryptoKey`. A write is not considered complete until the encrypted record is read back and authenticated.

Legacy plaintext `localStorage` tickets are removed only after that encrypted readback succeeds. If secure storage is unavailable, hold and commit transactions remain blocked until the user downloads a manual recovery copy. Export and restore stay optional under Your orders during normal operation. Exports contain plaintext reveal keys.

This protects site data at rest, not a compromised origin. Script execution on the same origin can use the device key while the page is open. Clearing site data or losing the device also loses the key, so an optional export is still the only off-device recovery path.

Sell reservation and commit are separate contract calls, so Reserve & place sell still requires two wallet approvals. A compatible hold can be reused because `holdId` is not part of the commitment preimage. Before commit, a reserved draft can change price or quantity and reuse a large enough hold. After commit, those fields are immutable; changing them requires cancellation and a new order.

Reveal: sell `backing = holdId`, `value = 0`; buy `backing = 0`, `value = toWeibar(price * qty)`.

`crossRound(r)` is permissionless and nothing calls it. `quote(r)` is view. `priceTwice` is twice the price.

Proceeds land in `credit` (pull). Watch `SettlementRefused` — the round can print and still not settle that pair.

## Screen 3 · Position and receipt

`MarginWatch.watch(ids)` returns positions **and** whether the log can be believed (`Stream.audible`).

Five getters on the engine: `ceilingFor`, `wouldDisclose`, `spentBits`, `wouldAfford`, `breakingSize`. A row can be permitted and inaudible at once.

Do not subscribe to events (`eth_getLogs` throttles; Rule A withholds). Decode a *specific transaction's* events from its own receipt. For history, read the mirror node's log index: `/api/v1/contracts/{evmAddress}/results/logs?order=desc&limit=n`, decoded against the bundled ABI. Different host, so it does not spend the relay budget.

## Errors worth special-casing

| error | meaning |
|---|---|
| `WrongBond(sent, want)` | units. `diagnoseWrongBond` |
| `UnknownCommitment(id)` | preimage / salt |
| `NotEscrow(0)` | hold id does not exist |
| ATS `InvalidKycStatus()` `0xfc855b1b` | route to Screen 1 |

Selector table: `client.json` → `errors`.

## Must not violate

1. Salt is unrecoverable (**loss**).
2. Cancel and reveal never overlap.
3. Sell hold: escrow, `to==0`, amount, expiry — all four.
4. Buy value is exactly `price * qty` tinybars, as weibars.
5. Commit value is exactly `commitBond`.
6. Never format a quantity; never derive clocks; never claim a number the contracts do not say.
7. Grants die at the KYC epoch boundary with no warning (**loss**).
8. `disclose(e)` on an open epoch is a silent no-op.

## The feed

`PrimeOracle`. Two legs, and a client that shows one number is hiding which half
broke.

| read | what |
|---|---|
| `stale()` | the composite. True means `markToMarket` reverts and `postMark` opens |
| `ourLegStale()` | the venue's seated panel alone |
| `cashLeg()` | `(ok, usdPerHbar, updatedAt)` for the upstream leg. Total, never reverts |
| `latest()` | `(cleanPrice, refRateBps, publishedAt, round)` |
| `markPerUnitTinybar()` | the composite. **Reverts** on either dark leg |
| `MarginWatch.feed()` | all of the above in one call, plus the seated addresses |

`MarginWatch.watch(ids)` now returns three values, not two: positions, the
disclosure stream, and the feed. Positions alone cannot tell a quiet market from
a silenced one, and neither can tell either from a market whose price stopped
arriving.

### Scales

Prices are **eight decimals**, and that is a fourth quantity: it is not a
denomination of HBAR. `100_00000000` is 100.00 USD per unit of face. Use
`tools/units.mjs` `formatPrice`, never `formatHbar`, and
`markPerUnitTinybar(cleanPrice, usdPerHbar)` for the composite. The result of
*that* is tinybars and `formatHbar` is correct on it.

### Two things that will bite

1. **`markPerUnitTinybar()` reverts when the feed is dark.** Use
   `RepoVault.previewMark(id)`, which is total and answers `(mark, breach, dark)`,
   anywhere a screen has to render regardless.
2. **The cash seat does not hold a Chainlink feed on this chain.** Chainlink runs
   HBAR/USD on Hedera and its proxies refuse a contract caller with `No access`
   while answering `decimals()` to anyone. The seat holds `HederaRateFeed` over
   the network's own rate at `0x168`. Read `cashFeed().description()` rather than
   labelling the seat in your own copy: it is governed and it can move.
   `probes/chainlink-hedera.out`.

### Writes offered

`markToMarket(id)` is permissionless and safe to offer: it raises a margin call
only when the position is actually short, the cure window is an immutable rather
than a caller's argument, and a mark that decides nothing emits nothing.
`submit`/`finalize` are the panel's and are not a v1 client path.

## Screens 4 and 5 · Repo and Venue

Repo reads `RepoVault.repo/stateOf/repurchasePriceNow/settlementPenaltyNow/previewMark`
plus `MarginWatch.alertOf/calledAmong/feed`; repo ids come from the vault's own
log history, since they are not enumerable on chain. A version-5 capability
check enables funded offers, acceptance, withdrawal, repayment, additional
collateral, cure, permissionless marking and due-obligation settlement. Each
write checks the connected party and live state, simulates, locks against a
duplicate request, and waits for confirmation. The Venue view of `Regime`,
`VolumeCap`, `TradingHalt`, `ParameterRoot`, `Rulebook`, `SeamJournal` and
`EpochClock` remains read-only, including every proposal window and `reconcile`.

Read budgets and ceilings from `ParameterRoot`, never from `client.json`. The Venue screen compares the two and says so when they differ.

Two permissionless writes are offered: `engine.expire(id)` (retires an order past `lastRound`; reverts `StillResting` before that) and `journal.disclose(e)` (a no-op on an open epoch, so the client refuses to send one).

## Out of scope

`AxeBoard` is not deployed. Collateral substitution remains refused by
`SubstitutionRefused`, and liquidation auctions remain refused by
`AuctionNotSupported`. Governance writes are operator or supervisor surfaces.
`forfeit` is never offered.

## Reads

Cache immutables. One coalesced pass per tick. 5s while a round is live and the tab focused. Back off on 429. History from the mirror node.
