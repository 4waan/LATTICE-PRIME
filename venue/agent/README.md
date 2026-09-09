# Lattice Prime private agent

This directory contains the Phase 1 private-agent infrastructure and the
Phase 2 Hedera testnet integration. Synthetic model training ran in Cursor
cloud. Proving, verification, policy, signing, storage, isolation, protocol
reads, transaction submission, recovery, and receipt construction run locally.
The Phase 3 product UI remains disabled.

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
  session, CSRF, request-schema, and body-size checks.
- `runtime/hedera-protocol-adapter.mjs` pins deployment files, ABIs, runtime
  code, wiring, and market immutables before it authenticates snapshots,
  runs single-block protocol preflight, submits projected transactions, or
  reports single-block authoritative chain state.
- `runtime/agent-runtime.mjs` rechecks protocol authority, context expiry,
  snapshot freshness, and account nonce after proving and before commit
  signing. Recovery can rebroadcast the exact persisted first commit.
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
