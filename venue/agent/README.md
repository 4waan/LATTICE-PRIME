# Lattice Prime private agent

This directory contains the Phase 1 private-agent infrastructure. Synthetic
model training ran in Cursor cloud. Context binding, formal checks, proving,
state, signing, isolation, API security, transaction projection, and protocol
harness work run locally. Live trading remains disabled.

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
  journal with chained entry hashes and restart recovery.
- `runtime/signer-worker.mjs` owns the dedicated key in a separate process and
  accepts only typed agent operations.
- `runtime/supervisor.mjs` exposes a paired loopback API with exact origin,
  session, CSRF, request-schema, and body-size checks.
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
prediction. The current protocol adapter is a deterministic harness. Snapshot
and deployment authentication plus live Hedera submission remain later work.

## Security properties

No module accepts a URL, arbitrary calldata, or an arbitrary signing request.
Money is represented as decimal strings or bigint values. The proof input is
private to the prover, while its decision and exact bound context are public to
whoever receives the proof. Proof packages therefore remain local before an
order reveal.

These checks cover the declared graph, proof, policy, local isolation, signer,
and transaction projection. They do not prove that every process on the host
was silent, authenticate a market snapshot, or enforce delegation in a
contract.
