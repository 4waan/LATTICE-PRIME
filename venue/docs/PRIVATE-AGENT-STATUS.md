# Private agent implementation status

Evidence snapshot: 9 September 2026. This records the first Phase 1
proof-and-context spike. It does not report a complete agent, a live
transaction, worker isolation, or a release model.

## Result

The spike passes:

- EZKL 23.0.5 generated and verified a real proof with private model input,
  fixed parameters, a public boolean decision, and 173 exact public context
  limbs.
- Altered public output, expected context, verification key from a different
  circuit, and model identity were all refused.
- The graph checker accepted the pinned topology and refused a context-input
  bypass mutation and a weight mutation.
- Z3 returned `unsat` for default excluded context and for two optional-mode
  executions with equal approved categories.
- Six Node infrastructure tests and four Python mutation/formal tests pass.

This is the proof-and-context dependency gate only. The ONNX graph uses
hand-fixed spike weights and has `liveTradingEnabled: false`.

## Measured run

Command: `make agent-proof`

Environment:

- macOS 26.5.1, arm64, 8 GiB host memory
- Python 3.9.6
- EZKL 23.0.5 at source commit
  `534ff3e6c13d4c2c1aca2358910d62dac466d3cc`
- ONNX 1.17.0, NumPy 2.0.2, Z3 4.15.3.0

Final measured timings:

- setup: 0.984 seconds
- witness: 0.014 seconds
- prove: 1.472 seconds
- verify: 0.021 seconds
- altered-circuit setup: 1.454 seconds
- process high-water RSS: 440,942,592 bytes

Final artifact sizes and identities:

- ONNX: 1,268 bytes,
  `sha256:0c56ed00dfc9ddd0a48160e21a13f06fb465a11008daa0daef62ea1277b0f01f`
- compiled circuit: 10,250 bytes,
  `sha256:a66e59b63f8bb22353221d87ace1ad4280236a23d1cd4cd7c9bac8ef04f5610d`
- SRS: 2,097,412 bytes,
  `sha256:c09129f064c08ecb07ea3689a2247dcc177de6837e7d2f5f946e30453abbccef`
- proving key: 117,475,083 bytes,
  `sha256:49f192037a9675e6e6ddb76c93fc1361f26e9000d14bdc23f601e14ded85b82c`
- verification key: 34,055 bytes,
  `sha256:199650ea9a5e1bac81335ee563016b441fe932d4bb346878f6eb5528c0eda96a`
- proof JSON: 44,008 bytes,
  `sha256:2f30739949e495a9c9414e37a11eb5a34ba71bf832a795e5e289b2285ed44637`

The generated artifacts and full machine-readable evidence are under the
ignored `agent/artifacts/` path. Setup and proof artifacts contain randomized
material, so their hashes can change on a new run even when the source graph
does not.

## Implemented files

- `agent/manifest.json`: capability, dependency, source, and deployment pins.
- `agent/proof/instances.json`: the ordered public-instance contract.
- `agent/runtime/context.mjs`: strict context validation and 16-bit limb
  encoding.
- `agent/runtime/mandate.mjs`: the closed BUY-only mandate and context binding.
- `agent/runtime/policy.mjs`: replay, sequence, pending-order, and cumulative
  budget state transitions.
- `agent/runtime/transaction-projector.mjs`: exact commit and BUY reveal
  construction and decoded transaction comparison.
- `agent/model/build_model.py`: deterministic ONNX spike graph builder.
- `agent/formal/check_graph.py`: operator, topology, parameter, input, and
  output restrictions.
- `agent/formal/check_release.py`: bounded two-execution release check.
- `agent/proof/run_spike.py`: setup, witness, proof, verification, expected
  instance comparison, measurement, and negative cases.
- `agent/tests/`: authority, projection, graph mutation, and formal checks.
- `Makefile`: explicit `agent-bootstrap`, `agent-model`, `agent-formal`,
  `agent-test`, and `agent-proof` commands.

## Baseline

Implementation started from git commit
`f81a727d10b4666128463284521e2cee1b8fea7a` while preserving the existing
working tree. Relevant baseline SHA-256 identities are recorded in
`agent/manifest.json`. The deployment source is chain 296 at
`deployments/client.json`, checked there at `2026-09-08T15:32:57.179Z`.
Live code was not rechecked during this Phase 1 spike.

## Open limitations and next gate

- Replace the spike weights with the seeded synthetic training and quantized
  boundary evaluation required by the plan.
- Add executable correspondence tests between the ONNX decision, integer
  formal model, and both context codecs before optional private preferences can
  be enabled.
- Implement atomic durable state, encrypted ticket storage, and restart
  recovery.
- Add the separate typed signer and final signed-transaction decoder.
- Add the paired loopback API and hostile-origin tests.
- Install a supported local container runtime before claiming worker network
  isolation. Docker was not available on this host during the spike.
- Authenticate market snapshots and deployment code in the later protocol
  adapter. The proof currently establishes consistency with supplied context,
  not its chain provenance.
