# Private automated trading

## Release state

The private path is fail closed. The client may enable each order side only after
all of these checks pass for the deployed candidate:

1. A session proof verifies against the published holder-secret root.
2. The HBAR or LPRC denomination has at least eight notes from distinct funding
   addresses.
3. A fixed ticket was durably stored and read back before placement.
4. Quicknet beacon validation, delayed decryption, and reveal retry canaries pass.
5. Session order calldata, engine events, and ATS settlement do not contain the
   connected wallet.
6. Sell hold creation rolls back when reveal fails.
7. Same-period gas measurements stay below the side-specific hard cap.

The direct wallet path remains available if any private check fails.

## Privacy claim

The supported claim is **routed pseudonymous execution**.

The session eligibility proof does not publish a direct wallet-to-session or
manual-nullifier-to-session-nullifier link. Fixed-denomination routing avoids
publishing the exact order amount during funding. Orders from one session can
still be grouped under that session until rotation. Side, limit, quantity, and
fills become public when an order is revealed.

An authorized compliance viewer can decrypt the fixed identity mapping for a
session. That mapping has a separate key domain from the order ticket and never
receives the reveal key or sealed terms.

The design does not claim anonymous execution or unconditional unlinkability.
Public deposits and withdrawals, matching amounts, uncommon denomination
combinations, timing, low traffic, IP addresses, cookies, analytics, and relayer
reuse can create correlations. Operators must not log client addresses beside
ticket capabilities or session identifiers.

The eight-funder threshold counts distinct on-chain funding addresses. It is not
proof that eight unrelated people funded the pool, so the release canary must
also document how the seed notes were sourced.

## Order paths

### Private and automatic

After one-time setup, the browser:

1. Chooses a valid future Quicknet round.
2. Creates a fixed-width order record and random engine salt.
3. Encrypts the record with AES-256-GCM.
4. Tlock-encrypts only the AES key to the pinned Quicknet round.
5. Uploads the final 2048-byte envelope using a random capability.
6. Reads the stored bytes back and verifies their digest.
7. Signs one EIP-712 placement authorization with the session key.
8. Sends the authorization through a relayer.

The timed service verifies the target beacon, decrypts the record after release,
rechecks chain ownership, and calls permissionless reveal. A private sell creates
its ATS hold inside the same transaction as reveal.

### Service boundary

The ticket and relay process requires a persistent volume and a continuously
running worker. It must not use an ephemeral serverless filesystem. Public
routes are same-origin, reject cookies, validate the request origin, apply body
and rate limits, and return `Cache-Control: no-store`.

Ticket access uses the random capability only in the `Authorization` header.
The capability, envelope bytes, proof preimages, session keys, connected wallet,
and revert bytes must not enter application or proxy logs. The relayer accepts
only the dedicated `PRIVATE_TRADING_RELAYER_KEY`; venue administrator and
operator keys are not fallback credentials.

The reference deployment is
`agent/packaging/private-trading.compose.example.yaml`. It mounts `/state` from
a named volume, keeps the container filesystem read-only, and runs the HTTP
boundary and reveal worker in one continuously supervised process. The reverse
proxy must preserve the public `Host` and `Origin` headers, disable request-body
and `Authorization` logging, and expose only the four configured same-origin
paths. Cookie-bearing requests are rejected. Browser GET requests that do not
carry `Origin` are accepted only with an exact public `Host` and
`Sec-Fetch-Site: same-origin`.

Back up the state volume as encrypted infrastructure data. Restoring only the
application image is not recovery because the volume contains ciphertext
tickets and exact signed transaction bytes needed for reconciliation. Run one
writer per volume. The process applies strict route-specific body limits and an
in-memory per-client rate limit; the edge proxy should also enforce a rate
limit without logging capabilities or request bodies.

### Direct and manual

The connected wallet is the engine committer and appears publicly. A buy uses
one placement approval and one reveal approval. A sell uses one ATS reservation
approval, one placement approval, and one reveal approval.

## Timing

For commit time `C`, engine delay `D`, reveal window `W`, secrecy guard `G`,
retry margin `M`, and Quicknet release time `T`:

```text
C + D + G <= T <= C + D + W - M
```

Initial values are `G = 12 seconds` and `M = 60 seconds`. Quicknet uses genesis
`1692803367`, period `3 seconds`, and chain hash
`52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`.
The full chain public key is pinned in the timed-ticket implementation.

A ticket must be durably stored before placement. If placement would make its
release round unsafe, the session contract rejects before calling the engine.

## Funding and fees

Funding checks use public state and integer arithmetic in the client. They do not
use a price oracle and do not call `eth_estimateGas` with sealed calldata.

Recurring gas gates compare each private canary with its own same-period direct
control. The client uses the verified warm measurements for fee estimates. The
initial planning controls are 334,492 gas for buys and 720,040 gas for sells.
Each sample covers the whole recurring path: private placement plus automatic
reveal, direct BUY commit plus reveal, and direct SELL reservation plus commit
plus reveal. Setup, routing, rotation, recovery, early-refusal probes, and
settlement are excluded and reported separately.

The target is at most 10 percent overhead. The release stop is 15 percent,
computed separately for fresh and repeated samples.
Session creation, registration, pool entry, pool exit, top-ups, rotation, and
relayer operation are reported separately from recurring order gas.

## Recovery and lifecycle

The browser retains an encrypted local recovery record. File export is optional.
The timed service stores ciphertext only, addressed by a 256-bit capability.
It purges cancelled and terminal tickets after the retention period.

Before placement, terms are editable. Before reveal opens, replacement cancels
the old commitment and creates a prefilled draft with a fresh salt. Revealed
terms are immutable; the user can create a new opposite-side order.

Session rotation is explicit and uses a second confirmation. It is blocked
while any device-managed order for that session is active or engine credit
remains. The encrypted vault retains retiring session and recovery keys.
Full HBAR and LPRC denominations can then be relayed from the old session into
the fixed pool and withdrawn to the new session after the normal privacy delay.
The connected wallet does not send the recovery transaction. The public old
session deposit, new session withdrawal, timing, and low traffic can still be
correlated. If the old session crosses an eligibility boundary first, the saved
holder credential can generate a fresh proof for that specific session without
making it the active trading session. Any remainder below one fixed
denomination stays visible in the retiring session rather than being
represented as recovered.

The normal recovery path keeps the connected wallet out of order transactions.
If automation is unavailable after the scheduled release, the browser can send
an emergency reveal from the connected wallet. That protects the order from a
missed reveal, but it creates a public wallet-to-session link and requires a
second explicit confirmation.

## Candidate canary

`script/live/private-trading-canary.sh canary-plan` validates the candidate,
base Mirror Node evidence, role separation, privacy-set funding, service paths,
and all remaining external prerequisites without sending a transaction.
`canary-run` additionally requires the exact acknowledgement string and
dedicated keys for the relayer, session, recovery, direct controls, and
settler. None may match the connected wallet, administrator, issuer, deployer,
or venue operator.

The run creates fresh and repeated private BUY and SELL orders, same-period
direct controls, early reveal refusals, a failed private SELL rollback, worker
restart evidence, and settlement evidence. It writes candidate artifacts only
under `out/private-trading`. It refuses
`deployments/private-trading-release.json` as an output. Promotion remains a
separate `tools/private-release.mjs` step whose verifier must accept the
complete real receipts first.
