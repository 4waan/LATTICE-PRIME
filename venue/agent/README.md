# Lattice Claw

Lattice Claw is a separate private execution product for the Lattice Prime
venue. This directory contains its Phase 1 infrastructure, Phase 2 Hedera
testnet integration, and local runtime. Synthetic model training ran in Cursor
cloud. Proving, verification, policy, signing, storage, isolation, protocol
reads, transaction submission, recovery, and receipt persistence run locally.

The current product UI is a coming-soon landing page with a non-functional chat
preview. Lattice Prime does not embed Claw controls. The tested runtime remains
available headlessly while the Claw interaction model is developed.

## Commands

```text
make agent-bootstrap  create the isolated Python environment
make agent-model      build and validate the fixed ONNX spike graph
make agent-formal     check graph structure and the bounded release property
make agent-test       run mandate, replay, budget, projection, and mutation tests
make agent-proof      generate and verify a real EZKL proof and negative cases
make agent-worker     build the pinned network-disabled proving image
make agent-worker-test  prove in isolation and verify outside the worker
make agent-e2e        run the complete local deterministic execution harness
make agent-launch     build prerequisites and open the local Claw preview
make agent-phase3-local  verify the Claw shell and local runtime boundary
make agent-phase2-plan  authenticate the pinned testnet deployment without sending
make agent-phase2-live  run filled, partial-fill, and no-fill testnet lifecycles
make agent-phase2-pause-live  pause new work and recover a sealed order on testnet
make agent-evm-verifier-live  deploy and probe the optional proof sidecar
```

`agent/artifacts/` is ignored. It contains the ONNX build, SRS, proving and
verification keys, witness, proof, and machine-local evidence JSON. None of
these files belong in the public application directory.

## Implemented boundary

- `runtime/context.mjs` strictly validates and encodes the 173-limb decision
  context. Unknown fields are refused.
- `runtime/mandate.mjs` implements the first BUY-only, one-order mandate. The
  default mode fixes both private preference categories to neutral constants.
- `runtime/policy.mjs` enforces evaluation sequence, slot replay, pending-order,
  principal, and bond counters as pure state transitions.
- `runtime/transaction-projector.mjs` constructs exact commit and BUY reveal
  calls from the approved tuple and independently checks decoded transaction
  fields.
- `runtime/store.mjs` maintains an atomically replaced, user-unlocked encrypted
  journal with chained entry hashes, restart recovery, and a strict migration
  from recognized Phase 1 authority and ticket records.
- `runtime/signer-worker.mjs` owns the dedicated key in a separate process and
  accepts only typed agent operations.
- `runtime/supervisor.mjs` exposes a paired loopback API with exact origin,
  expiring one-time pairing, bounded in-memory sessions, CSRF, request-schema,
  body-size, fixed static-file, no-store, and nonce-based CSP checks. Private
  signer action records are not exposed to the browser.
- `launch.mjs` serves the Lattice Claw preview from the same random loopback
  origin as the dormant API. It configures the live adapter only after an API
  client creates or unlocks the dedicated signer, and its operating-system
  advisory lock refuses concurrent launchers.
- `runtime/control-service.mjs` turns one validated BUY ticket into a one-use
  preview capability, exact one-evaluation mandate, authenticated snapshot,
  protocol preflight, and local verified execution.
- `runtime/lifecycle-scheduler.mjs` serializes nonce-sensitive recovery while
  the launcher remains open. It reveals, expires, withdraws, repairs an unsigned
  crash-interrupted commit ticket, rebroadcasts an unresolved signed commit, or
  cancels a sealed action after pause. One failed action does not starve later
  obligations.
- `runtime/receipt-store.mjs` atomically persists a checksum-chained journal of
  sanitized decision and lifecycle records. Authentication tags, proof bodies,
  passphrases, keys, salts, signed bytes, credentials, arbitrary diagnostics,
  and private witnesses are rejected. Receipt failure cannot block lifecycle
  recovery. The unkeyed checksums detect corruption, not a hostile writer that
  can replace the entire file.
- `runtime/hedera-protocol-adapter.mjs` pins deployment files, ABIs, runtime
  code, wiring, and market immutables before it authenticates snapshots,
  runs single-block protocol preflight, submits projected transactions, or
  reports single-block authoritative chain state.
- `runtime/agent-runtime.mjs` rechecks protocol authority, context expiry,
  snapshot freshness, and account nonce after proving and before commit
  signing. Recovery can finish an approved ticket interrupted before signed
  bytes were persisted or rebroadcast exact persisted commit bytes.
- `runtime/order-receipt.mjs` joins the local decision to the existing protocol
  order identifier while keeping inference, chain, venue-disclosure, and local
  runtime evidence scopes distinct.
- `runtime/worker.mjs` invokes the pinned non-root container with no network,
  a read-only root, dropped capabilities, bounded resources, and no wallet
  mount.
- `model/build_model.py` reconstructs the cloud-trained quantized graph whose
  only public outputs are a boolean decision and an identity copy of the bound
  context.
- `formal/check_graph.py` refuses operator, topology, weight, output, and
  decision-input mutations.
- `formal/decision_relation.py` compares cloud float references, integer
  inference, ONNX inference, context identity, and the independent relation.
- `formal/check_release.py` checks the two-execution release and exact
  quantized-graph correspondence with Z3.
- `proof/run_spike.py` runs the pinned EZKL lifecycle and tests altered public
  output, expected context, verification key, and model identity.

The model is trained only against a transparent synthetic rule. Its metrics
measure consistency with that rule, not profitability or validated financial
prediction. The deterministic adapter remains for local tests; the Hedera
adapter completed filled, partial-fill, no-fill, expiry, withdrawal, restart,
and paused recovery paths against the pinned testnet deployment. See
`agent/manifest.json` and the tracked `deployments/agent-phase2*.json` records.

## Lattice Claw preview

Run `make agent-launch`. The launcher opens `/claw/` on a random `127.0.0.1`
port. The page contains one hero, a coming-soon label, and a disabled chat bar.
Its Lattice Claw brand links back to Lattice Prime. It does not pair with the
runtime, unlock a signer, create a mandate, or send a transaction.

The headless API, signer, scheduler, and receipt modules are preserved for the
future Claw product. Existing outstanding lifecycle recovery still requires the
launcher process and an unlocked signer API session.

## Security properties

No module accepts a URL, arbitrary calldata, or an arbitrary signing request.
Money is represented as decimal strings or bigint values. The proof input is
private to the prover, while its decision and exact bound context are public to
whoever receives the proof. Proof packages therefore remain local before an
order reveal.

These checks cover the declared graph, proof, policy, local isolation, signer,
transaction projection, authenticated testnet snapshot, and observed protocol
outcome. They do not prove that every process on the host was silent or enforce
delegation in a contract. The optional EVM proof verifier is an evidence
sidecar and does not authorize or settle an order. Its deployment probe
recomputes the hashes of the exact verifier, ABI, proof, and calldata it uses.

The Lattice Claw coming-soon shell and local boundary pass deterministic
integration tests. The chat preview cannot originate an order. The underlying
typed lifecycle remains the Phase 2 live-tested path.
