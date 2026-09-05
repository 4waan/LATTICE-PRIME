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

Write the ticket (incl. salt) **before** send. No salt ⇒ no reveal ⇒ bond is forfeit.

Windows from `committedAt` (delay D, window W):

```
cancel  [committedAt, committedAt + D)
reveal  [committedAt + D, committedAt + D + W]
forfeit (committedAt + D + W, ∞)
```

`cancellableUntil(id)` is exclusive; zero means terminal, a past timestamp means the window already shut.

Reveal: sell `backing = holdId`, `value = 0`; buy `backing = 0`, `value = toWeibar(price * qty)`.

`crossRound(r)` is permissionless and nothing calls it. `quote(r)` is view. `priceTwice` is twice the price.

Proceeds land in `credit` (pull). Watch `SettlementRefused` — the round can print and still not settle that pair.

## Screen 3 · Position and receipt

`MarginWatch.watch(ids)` returns positions **and** whether the log can be believed (`Stream.audible`).

Five getters on the engine: `ceilingFor`, `wouldDisclose`, `spentBits`, `wouldAfford`, `breakingSize`. A row can be permitted and inaudible at once.

Do not subscribe to events (`eth_getLogs` throttles; Rule A withholds). Decode events from the tx receipt only.

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

## Out of scope

`AxeBoard` is not deployed. Repo writes are not a v1 client path (`substitute` reverts `SubstitutionRefused`). Governance writes are operator/supervisor surfaces.

## Reads

Cache immutables. One coalesced pass per tick. 5s while a round is live and the tab focused. Back off on 429. History from the mirror node.
