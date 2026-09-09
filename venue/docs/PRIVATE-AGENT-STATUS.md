# Private agent implementation status

Evidence snapshot: 9 September 2026. Phase 1 now has a cloud-trained synthetic
model and a local proof, authority, signer, isolation, API, and deterministic
protocol harness. Live trading remains disabled.

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
- Twelve Node tests and six Python tests pass.

The local runtime gate also passes:

- The user-unlocked AES-256-GCM journal writes atomically with a chained entry
  hash, restrictive permissions, restart recovery, and replay-safe counters.
- A separate process owns the dedicated signing key and accepts only typed
  setup, mandate, evaluation, commit, reveal, status, and broadcast-record
  messages. Commit salt and signed bytes are persisted before broadcast.
- The loopback supervisor enforces exact Host and Origin, one-time pairing,
  bearer sessions, CSRF protection, closed request schemas, body limits, and
  no-store security headers.
- The proving worker runs as a non-root user with no network, a read-only root,
  all capabilities dropped, no new privileges, bounded resources, a read-only
  proof bundle, and no wallet or host-secret mount.
- A headless deterministic test completed intent, isolated proof, independent
  verification, authority reservation, exact transaction projection, signing,
  unknown-broadcast reconciliation, and a sanitized receipt.

These results measure synthetic decision consistency and implementation
correspondence. They do not measure profitability or validated financial
prediction.

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

- settings: 0.073 seconds
- compile: 0.005 seconds
- SRS: 1.174 seconds
- witness: 0.017 seconds
- setup: 1.102 seconds
- proof: 1.349 seconds
- verification: 0.017 seconds
- altered-circuit setup: 1.013 seconds
- process high-water RSS: 420,184,064 bytes

Artifact sizes and identities:

- ONNX: 1,708 bytes,
  `sha256:da8f5f55246a902a0cb1110bfa2725aae8a3ffab901e76b2bd916fdaa7fd5503`
- compiled circuit: 11,305 bytes,
  `sha256:c532125bf2ab2cf11ccab7cc1ee5b8ac68de2952e53588c03c845e3da34a0a7f`
- SRS: 2,097,412 bytes,
  `sha256:c09129f064c08ecb07ea3689a2247dcc177de6837e7d2f5f946e30453abbccef`
- proving key: 117,475,083 bytes,
  `sha256:1b3d0841c437e42b66cf80b2a9faac53e1033dd731e9a980e58c394ae918ec77`
- verification key: 34,055 bytes,
  `sha256:ca041db091663fd33da8c264eef4f581eb5c0abbe188a5df0497389bd58f2b46`
- proof JSON: 44,014 bytes,
  `sha256:8d8402cd576cacd839fe22f2999b3d5f9e60a922a2be4383315859ec07599642`

Setup and proof artifacts use randomized material, so key and proof hashes can
change on a clean run. The model and quantized-weight hashes remain fixed.

## Isolation and end-to-end evidence

- Colima 0.10.3 with Docker 29.8.0 is installed and running on this device.
- Worker image:
  `lattice-agent-worker@sha256:6e064bc5d6141df238b3e39a7fb8fa05893d3e69440a6d58a23eeb6cbfd1eee4`
- A direct no-network probe failed to resolve an external host as expected and
  confirmed that no user `.env` path was mounted.
- The trained-model isolated worker plus independent verifier completed in
  9,715 milliseconds with a 44,688 KiB Node process high-water RSS.
- The complete local headless execution completed in 13,827 milliseconds with
  a 78,224 KiB Node process high-water RSS and
  reconciled a simulated timeout after transaction acceptance.

Machine-readable proof, correspondence, worker, and end-to-end records are
stored under the ignored `agent/artifacts/` directory.

## Implemented boundary

- `agent/model/`: cloud-only training source, exact dependencies, seed and
  policy configuration, quantized weights, ONNX model, boundary corpus,
  lossless float reference, reports, and manifests.
- `agent/formal/`: pinned graph identity and topology, independent integer
  evaluator, executable correspondence, and Z3 release checks.
- `agent/proof/`: independent context codec, EZKL lifecycle, expected-instance
  validation, negative mutations, pinned verifier bundle, and receipt verifier.
- `agent/runtime/`: mandate and policy enforcement, encrypted journal, typed
  signer process, exact transaction decoder, isolated worker launcher,
  independent verifier, loopback supervisor, deterministic adapter, and
  headless orchestration.
- `agent/packaging/`: pinned worker image, closed entrypoint, isolation test,
  and end-to-end test.

## Remaining limitations

- `liveTradingEnabled` remains `false`.
- The protocol adapter is a deterministic harness. It does not authenticate a
  Hedera snapshot, deployment bytecode, balances, eligibility, or live
  receipts.
- No live chain transaction was sent.
- Optional private preference categories remain disabled by mandate v1 even
  though equal-category correspondence passed.
- Container isolation is local enforcement, not remote attestation and not a
  proof that every process on the host was silent.
- The user unlocks the encrypted store with a passphrase. JavaScript cannot
  guarantee immediate erasure of every in-memory string copy.
- Contract-level delegated authority remains later protocol work. The current
  signer boundary is enforced off chain.
