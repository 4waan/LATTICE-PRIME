# Lattice Claw implementation status

Evidence snapshot: 9 September 2026. Phase 1 has a cloud-trained synthetic
model and a local proof, authority, signer, isolation, API, and deterministic
protocol harness. Phase 2 has passed against the pinned Hedera testnet
deployment. The agent is now a separate product named Lattice Claw. Its first
product surface is a coming-soon landing page with one hero and a disabled chat
preview. Lattice Prime remains the venue and no longer embeds agent controls.
The execution backend is preserved but is not connected to the Claw preview.

## Result

The trained-model gate passes:

- Cursor cloud generated 18,000 seeded synthetic cases, split into 12,000
  training, 3,000 validation, and 3,000 test cases. Each split is balanced
  between WAIT and EXECUTE.
- Float and scale-256 quantized inference reached 100% synthetic decision
  consistency on validation, test, and 51 adversarial boundary cases, with
  zero float-versus-quantized disagreements.
- The local rebuild is byte-identical to the cloud ONNX artifact:
  `sha256:da8f5f55246a902a0cb1110bfa2725aae8a3ffab901e76b2bd916fdaa7fd5503`.
- Local correspondence compared all 51 cloud float boundary decisions against
  integer inference and the formal relation. It also compared 4,096 generated
  cases across integer inference, ONNX, the formal relation, and the exact
  173-limb context identity path. No mismatch was found.
- Z3 returned `unsat` for default excluded context, equal-category optional
  executions, and exact quantized-graph correspondence.
- EZKL 23.0.5 generated and verified the trained-model proof. Altered public
  output, expected context, verification key, and model identity were refused.
- Thirty-five Node agent tests, 44 application tests, and six Python tests pass.

The local runtime gate also passes:

- The user-unlocked AES-256-GCM journal writes atomically with a chained entry
  hash, restrictive permissions, restart recovery, and replay-safe counters.
- Unlock migrates recognized Phase 1 authority and ticket records to explicit
  v2 schemas. The migration preserves mandates, salts, transaction bytes,
  nonces, counters, and outstanding recovery state, and refuses unknown prior
  shapes.
- A separate process owns the dedicated signing key and accepts only typed
  setup, mandate, evaluation, commit, reveal, status, and broadcast-record
  messages. Commit salt and signed bytes are persisted before broadcast.
- The loopback supervisor enforces exact Host and mutating-request Origin,
  expiring one-time pairing, bounded bearer sessions, CSRF protection, closed
  request schemas, body limits, no-store headers, fixed static paths, and a
  per-document script nonce. Browser-safe GET requests still require a valid
  bearer session.
- The proving worker runs as a non-root user with no network, a read-only root,
  all capabilities dropped, no new privileges, bounded resources, a read-only
  proof bundle, and no wallet or host-secret mount.
- A headless deterministic test completed intent, isolated proof, independent
  verification, authority reservation, exact transaction projection, signing,
  unknown-broadcast reconciliation, and a sanitized receipt.
- A commit is signed only after a second protocol, wall-clock expiry, snapshot
  freshness, and pending-account-nonce check. An unresolved first commit can
  reconcile or rebroadcast its exact persisted transaction without re-signing.

These results measure synthetic decision consistency and implementation
correspondence. They do not measure profitability or validated financial
prediction.

## Phase 2 testnet result

The live protocol gate passes on chain 296:

- The adapter pinned the deployment JSON and six ABIs by SHA-256, checked
  MatchingEngine and ATS token runtime code by Keccak, found all 13 required
  engine selectors, and checked live wiring and market immutables.
- Protocol preflight authenticated the execution account, KYC status, halt
  state, native fee balance, policy epoch, KYC epoch, and latest block. Every
  authoritative value is read at that reported block.
- Reveal performs a second authoritative identity, KYC, funding, and mandate
  deadline preflight before the signer may post BUY principal. Halt is reported
  but does not block reveal because the deployed protocol permits reveal during
  a halt and locally suppressing it could forfeit the posted bond.
- Commit performs the same authoritative checks before proving and repeats
  them immediately after proving. Expired decision context, stale snapshot, or
  a changed account nonce is refused before commit signing.
- Every decision context used an adapter-created single-block market snapshot
  whose block hash, timestamp, feature values, and snapshot hash were checked
  again before proving. Post-run hardening added a process-local HMAC, exact
  ticket comparison, and wall-clock freshness check; a changed-feature
  snapshot was refused in the read-only live preflight.
- A real BUY filled 10 of 10 units. The ordinary ATS partition balances moved
  from 1,000 to 1,010 for the buyer and 2,000 to 1,990 for the seller.
- A second BUY filled 0 of 7 units, rested for the configured two rounds,
  expired, released all backing, and left both actors with zero protocol credit
  after withdrawal.
- A third BUY filled 4 of 10 units, retired the remaining 6 after two resting
  rounds, moved exactly 4 ATS units, and recovered both actors' credits.
- A paused signer refused a new evaluation but preserved outstanding recovery.
  It cancelled a sealed order, recovered 900,000 tinybar after the configured
  100,000 tinybar fee, and withdrew the credit.
- The signer restarted from the encrypted journal between commit and reveal.
  A changed signed projection and cancel after reveal were refused before
  broadcast.
- Combined receipts use the protocol commitment as their order identifier and
  label inference, authoritative chain state, venue disclosure, and local
  runtime observations separately. Sanitized receipts contain no key, signed
  bytes, salt, witness, or proof body.
- Independent Foundry readback confirmed transaction status, selectors,
  contract destination, order quantities and fills, retirement, credits, and
  final ATS partition balances.
- Each action and round accounting report now pins every contract read and its
  observation timestamp to one block. Recovery does not withdraw account-level
  credit while the tracked order remains in an active auction.

The optional EZKL EVM verifier is deployed at
`0x9f035f847a0840e8d6ccdf7ab31c15cbd04cd9dc`. Its 10,027-byte runtime
accepted the valid released proof in a 712,013-gas testnet transaction and
refused an altered proof. It is an evidence sidecar. MatchingEngine does not
call it, and per-order proof publication remains disabled by default.
The current deployment probe recomputes the Solidity, ABI, proof, and calldata
hashes from the files it actually compiles and submits, then refuses any stale
build report before deploying.

Tracked evidence is in `deployments/agent-phase2.json`,
`deployments/agent-phase2-partial.json`,
`deployments/agent-phase2-pause.json`, and
`deployments/agent-ezkl-verifier.json`. `agent/manifest.json` is the exact
capability statement.

## Lattice Claw product split

- `agent/launch.mjs` opens `/claw/` from one random IPv4 loopback origin. The
  Claw route has a strict no-connect CSP, no remote assets, and no browser
  pairing bootstrap. Its chat field is read-only and its send control is
  disabled.
- Every Lattice Prime brand link switches to Claw. The Lattice Claw brand
  switches back to the Lattice Prime landing page.
- Prime Markets and Portfolio no longer load the mandate controls, agent client,
  or local receipt panel. Those modules remain dormant for future Claw work.
- The paired API, one-use control service, and in-memory browser client remain
  implemented and tested independently of the coming-soon page.
- The browser cannot request the signer's persisted action object. Salt,
  context, mandate internals, and signed transaction bytes remain inside the
  signer and runtime boundary.
- The lifecycle scheduler serializes all tickets against the pending account
  nonce. A per-action failure is recorded without starving later obligations.
  It reveals eligible commitments, expires rested orders, withdraws available
  credit, repairs an unsigned crash-interrupted commit ticket, recovers an
  unresolved signed commit, and cancels a sealed action when its mandate is
  paused. Expired, paused, or nonce-conflicted unsigned tickets are abandoned
  without signing and release their nonce reservation. Commit persistence
  transactionally refuses a concurrent abandonment or pause.
- The durable receipt journal uses atomic replacement, restrictive permissions,
  a checksum-chained event log, and a checksum of every current record. It
  refuses private-key naming variants, passphrases, proof bodies, reveal salts,
  snapshot authentication tags, capabilities, signed bytes, witnesses, and
  arbitrary diagnostic messages. Receipt failure cannot block lifecycle
  recovery.
- The dormant receipt renderer uses DOM text nodes and exports sanitized JSON.
  It is not loaded by either product.
- The launcher gate serves the Claw shell with `no-store` and confirms that the
  preview cannot pair, unlock, evaluate, or submit a message. No live
  transaction is sent by the gate.

`make agent-phase3-local` reproduces the non-broadcast launcher and browser
boundary checks and writes an ignored machine-local report to
`agent/artifacts/evidence/phase3-local.json`.

## Cloud provenance

- Branch: `cursor/lattice-prime-model-training-3c95`
- Foundation commit: `2792b9da7eb930dfa4a9cfb6e2eecd01c5e8a5a5`
- Training artifact commit: `d39cd53da23ae47c435b25592e473491c72cdea5`
- Float correspondence commit: `e80404c6c9685a12276042ad480ae61ec4d1b832`
- Seed: `20260909`
- Quantized weights:
  `sha256:5bd29c9515e7428832e354d0b865d5209d48f2b47763027edbf19d6ba2ffa18e`
- Float boundary reference:
  `sha256:93f0abb329220f8d8a82c511327fb47ac85b296ef52782d4e027d3e3c3e438fc`
- Held-out float decision digest:
  `sha256:3b5e140323d084f37e8c2bdc312e0cf8a775f18838a0108f09a048201af12aeb`

No investor data, wallet material, private preference values, credentials,
production witnesses, or hosted model endpoint entered the cloud job.

## Measured local proof run

Command: `make agent-proof`

Environment:

- macOS 26.5.1, arm64, 8 GiB host memory
- Python 3.9.6
- EZKL 23.0.5
- ONNX 1.17.0, NumPy 2.0.2, Z3 4.15.3.0

Timings:

- settings: 0.047 seconds
- compile: 0.003 seconds
- SRS: 0.934 seconds
- witness: 0.015 seconds
- setup: 1.034 seconds
- proof: 1.484 seconds
- verification: 0.015 seconds
- altered-circuit setup: 1.315 seconds
- process high-water RSS: 416,776,192 bytes

Artifact sizes and identities:

- ONNX: 1,708 bytes,
  `sha256:da8f5f55246a902a0cb1110bfa2725aae8a3ffab901e76b2bd916fdaa7fd5503`
- compiled circuit: 11,305 bytes,
  `sha256:345d7bbb1bdb4e43867673c49d96b66b67fcb287b49216a8aa61355268239fb0`
- SRS: 2,097,412 bytes,
  `sha256:c09129f064c08ecb07ea3689a2247dcc177de6837e7d2f5f946e30453abbccef`
- proving key: 117,475,083 bytes,
  `sha256:3f4a03acdf8a6083e33db9bb6f2e99ca806a31254cb6ab0c793fb1523e2683a6`
- verification key: 34,055 bytes,
  `sha256:eb64504a1a8cf077acbc21384c8548a494c8efbabe8f3590a301d999557d417f`
- proof JSON: 44,021 bytes,
  `sha256:4c35056e6733d105ea93bc7328d798741c5beb5bfbe2fd2789face0487d0fb97`

Setup and proof artifacts use randomized material, so key and proof hashes can
change on a clean run. The model and quantized-weight hashes remain fixed.

## Isolation and end-to-end evidence

- Colima 0.10.3 with Docker 29.8.0 is installed and running on this device.
- Worker image:
  `lattice-agent-worker@sha256:6e064bc5d6141df238b3e39a7fb8fa05893d3e69440a6d58a23eeb6cbfd1eee4`
- A direct no-network probe failed to resolve an external host as expected and
  confirmed that no user `.env` path was mounted.
- The trained-model isolated worker plus independent verifier completed in
  15,087 milliseconds.
- The complete local headless execution completed in 10,791 milliseconds and
  reconciled a simulated timeout after transaction acceptance.

Machine-readable proof, correspondence, worker, and local end-to-end records
are stored under the ignored `agent/artifacts/` directory. Sanitized Phase 2
chain evidence is tracked under `deployments/`.

## Implemented boundary

- `agent/model/`: cloud-only training source, exact dependencies, seed and
  policy configuration, quantized weights, ONNX model, boundary corpus,
  lossless float reference, reports, and manifests.
- `agent/formal/`: pinned graph identity and topology, independent integer
  evaluator, executable correspondence, and Z3 release checks.
- `agent/proof/`: independent context codec, EZKL lifecycle, expected-instance
  validation, negative mutations, pinned verifier bundle, and receipt verifier.
- `agent/runtime/`: mandate and policy enforcement, local pause control,
  encrypted journal, typed signer process, exact transaction decoder, isolated
  worker launcher, independent verifier, loopback supervisor, deterministic
  adapter, pinned Hedera adapter, one-use control service, serialized lifecycle
  scheduler, durable sanitized receipt store, combined receipt, and headless
  orchestration.
- `agent/launch.mjs`, `app/claw/`, and `tools/agent-*.mjs`: the separate Claw
  coming-soon shell, same-origin local API launch, dormant in-memory browser
  pairing, and preserved future control and receipt modules.
- `agent/packaging/`: pinned worker image, closed entrypoint, isolation test,
  local end-to-end test, testnet lifecycle tests, pause recovery test, and
  optional EVM-verifier deployment probe.

## Remaining limitations

- The Lattice Claw chat is a non-functional preview. It cannot create a
  mandate, run inference, unlock the signer, or send an order.
- Lattice Prime no longer embeds agent controls. A future Claw execution
  interface must be integrated and pass a new click-to-settlement testnet gate.
- Lifecycle scheduling continues only while the local launcher process runs.
  After a process or device restart, the user must unlock the encrypted signer
  before pending obligations resume.
- Per-order proof publication to the optional EVM verifier is disabled by
  default and was not used for the recorded orders. The verifier probe used the
  released synthetic proof bundle.
- The v1 mandate does not sign the protocol's permissionless `forfeit` method
  after a missed reveal window. Timely reveal scheduling is therefore still a
  critical local-runtime obligation.
- Optional private preference categories remain disabled by mandate v1 even
  though equal-category correspondence passed.
- Container isolation is local enforcement, not remote attestation and not a
  proof that every process on the host was silent.
- The durable receipt checksum chain detects corruption and inconsistent edits.
  It is not a signature against a writer that can replace the entire receipt
  file and recompute unkeyed checksums.
- The user unlocks the encrypted store with a passphrase. JavaScript cannot
  guarantee immediate erasure of every in-memory string copy.
- Contract-level delegated authority remains later protocol work. The current
  signer boundary is enforced off chain.
