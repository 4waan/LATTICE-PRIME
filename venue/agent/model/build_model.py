#!/usr/bin/env python3
"""Build the deterministic ONNX graph used by the Phase 1 proof spike."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


CONTEXT_LIMBS = 173
FEATURES = 6
HIDDEN = 8
MODEL_VERSION = "lattice.agent.proof-spike-model.v1"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return f"sha256:{digest.hexdigest()}"


def build_graph() -> onnx.ModelProto:
    weights_1 = np.array(
        [
            [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            [0.0, 0.0, 0.0, 1.0, -1.0, 0.0, 0.0, 0.0],
            [0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            [0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        ],
        dtype=np.float32,
    )
    bias_1 = np.array(
        [-250.0, -1000.0, 180.0, -2500.0, 8000.0, 0.0, 0.0, 1.0],
        dtype=np.float32,
    )
    weights_2 = np.array(
        [[1.0], [0.25], [1.0], [1.0 / 64.0], [1.0 / 128.0], [-100.0], [20.0], [-500.0]],
        dtype=np.float32,
    )
    bias_2 = np.array([0.0], dtype=np.float32)

    initializers = [
        numpy_helper.from_array(np.arange(FEATURES, dtype=np.int64), "feature_indices"),
        numpy_helper.from_array(weights_1, "weights_1"),
        numpy_helper.from_array(bias_1, "bias_1"),
        numpy_helper.from_array(weights_2, "weights_2"),
        numpy_helper.from_array(bias_2, "bias_2"),
        numpy_helper.from_array(np.array([0.0], dtype=np.float32), "zero"),
    ]
    nodes = [
        helper.make_node("Gather", ["context", "feature_indices"], ["features"], axis=1),
        helper.make_node("MatMul", ["features", "weights_1"], ["hidden_linear"]),
        helper.make_node("Add", ["hidden_linear", "bias_1"], ["hidden_biased"]),
        helper.make_node("Relu", ["hidden_biased"], ["hidden"]),
        helper.make_node("MatMul", ["hidden", "weights_2"], ["score_linear"]),
        helper.make_node("Add", ["score_linear", "bias_2"], ["score"]),
        helper.make_node("Greater", ["score", "zero"], ["decision"]),
        helper.make_node("Identity", ["context"], ["bound_context"]),
    ]
    graph = helper.make_graph(
        nodes,
        "lattice_agent_proof_spike",
        [helper.make_tensor_value_info("context", TensorProto.FLOAT, [1, CONTEXT_LIMBS])],
        [
            helper.make_tensor_value_info("decision", TensorProto.BOOL, [1, 1]),
            helper.make_tensor_value_info("bound_context", TensorProto.FLOAT, [1, CONTEXT_LIMBS]),
        ],
        initializer=initializers,
    )
    model = helper.make_model(
        graph,
        producer_name="lattice-prime",
        producer_version=MODEL_VERSION,
        opset_imports=[helper.make_opsetid("", 17)],
    )
    model.ir_version = 9
    model.doc_string = (
        "Phase 1 proof spike only. Fixed one-hidden-layer decision graph with a public "
        "boolean decision and an exact public copy of the private u16-limb context."
    )
    onnx.checker.check_model(model, full_check=True)
    return onnx.shape_inference.infer_shapes(model, strict_mode=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=Path("agent/artifacts/model"))
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    model_path = args.output_dir / "network.onnx"
    onnx.save_model(build_graph(), model_path)
    onnx.checker.check_model(onnx.load(model_path), full_check=True)

    record = {
        "schemaVersion": "lattice.agent.generated-model.v1",
        "modelVersion": MODEL_VERSION,
        "purpose": "proof-and-context spike; not approved for live trading",
        "onnx": {
            "path": model_path.name,
            "sha256": sha256(model_path),
            "opset": 17,
            "inputShape": [1, CONTEXT_LIMBS],
            "outputs": [
                {"name": "decision", "type": "bool", "shape": [1, 1]},
                {"name": "bound_context", "type": "float32", "shape": [1, CONTEXT_LIMBS]},
            ],
        },
        "architecture": {
            "features": FEATURES,
            "hiddenUnits": HIDDEN,
            "activation": "ReLU",
            "tieRule": "WAIT",
            "parameters": "fixed in the ONNX graph",
        },
        "dependencies": {
            "python": "3.9",
            "onnx": onnx.__version__,
            "numpy": np.__version__,
        },
    }
    (args.output_dir / "manifest.json").write_text(
        json.dumps(record, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(record, sort_keys=True))


if __name__ == "__main__":
    main()
