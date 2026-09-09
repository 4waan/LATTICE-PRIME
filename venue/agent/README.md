# Lattice Prime private agent

This directory contains the Phase 1 local-agent infrastructure. The current
slice is a proof-and-context spike plus the authority primitives that must gate
later signing. It does not submit transactions or enable live trading.

## Commands

```text
make agent-bootstrap  create the isolated Python environment
make agent-model      build and validate the fixed ONNX spike graph
make agent-formal     check graph structure and the bounded release property
make agent-test       run mandate, replay, budget, projection, and mutation tests
make agent-proof      generate and verify a real EZKL proof and negative cases
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
- `model/build_model.py` creates a small fixed graph whose only public outputs
  are a boolean decision and an identity copy of the bound context.
- `formal/check_graph.py` refuses operator, topology, weight, output, and
  decision-input mutations.
- `formal/check_release.py` checks the bounded two-execution release property
  with Z3.
- `proof/run_spike.py` runs the pinned EZKL lifecycle and tests altered public
  output, expected context, verification key, and model identity.

The ONNX graph currently uses hand-fixed spike weights. It is not the planned
trained synthetic-scenario model and is not approved for live action. Snapshot
authenticity, durable encrypted storage, a signer process, worker isolation,
the local API, and the protocol adapter remain later Phase 1 work.

## Security properties

No module accepts a URL, arbitrary calldata, or an arbitrary signing request.
Money is represented as decimal strings or bigint values. The proof input is
private to the prover, while its decision and exact bound context are public to
whoever receives the proof. Proof packages therefore remain local before an
order reveal.

These checks cover the declared graph, policy, and transaction projection.
They do not prove that every process on the host was silent, authenticate a
market snapshot, or enforce delegation in a contract.
