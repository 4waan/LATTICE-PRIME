# Synthetic decision model

This directory contains the reproducible CPU-only training pipeline for the
six-input Lattice Prime decision classifier. It uses generated bounded
scenarios only. It never reads investor data, account data, credentials,
wallet material, private preference values, proof witnesses, or hosted model
APIs.

Run the training command only in a Cursor cloud training environment, from the
repository root:

```sh
venue/agent/model/reproduce.sh
```

The command creates an ignored virtual environment, installs the exact
versions in `requirements-training.txt`, regenerates the dataset in memory,
trains with the recorded seed, selects the smallest dyadic parameter scale
with zero evaluated float-versus-quantized decision disagreements, exports
ONNX opset 17, and rewrites the small committed artifacts.

On the local integration device, use `make agent-model`. That command rebuilds
the ONNX file from committed integer weights without training.

Committed outputs:

- `training_config.json`: bounded feature domains, seed, split, transparent
  versioned synthetic labeling rule, margin, training method, and
  quantization policy.
- `weights.json`: canonical integer weights and biases with one shared dyadic
  scale.
- `network.onnx`: fixed `[1,173]` graph. Inference gathers only limbs 0 through
  5, computes an eight-unit ReLU layer and WAIT/EXECUTE logits, releases only
  strict `EXECUTE > WAIT`, and returns the complete context through Identity.
- `boundary-corpus.json`: compact extrema, threshold, category, tie, WAIT, and
  EXECUTE cases.
- `float-correspondence.json`: lossless float logit bit patterns and strict
  float decisions for every boundary case, plus a digest over the ordered
  held-out float decisions tied to the generated dataset hash. This lets local
  checks compare float, integer, ONNX, and formal results without retraining.
- `evaluation-report.json`: synthetic decision-consistency metrics, confusion
  counts, dependency versions, hashes, quantization comparisons, and
  limitations.
- `manifest.json`: artifact identities and release state.

`build_model.py` re-exports the committed integer parameters to an arbitrary
artifact directory without retraining. The model remains disabled for live
trading until the separate local formal, EZKL, policy, and integration gates
are updated for this model identity and pass. Nothing here measures
profitability or establishes a validated financial prediction.
