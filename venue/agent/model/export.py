#!/usr/bin/env python3
"""Export the canonical quantized Lattice Prime classifier to ONNX opset 17."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


CONTEXT_LIMBS = 173
FEATURES = 6
HIDDEN = 8
LOGITS = 2
EXPECTED_TENSORS = {
    "weights1": (FEATURES, HIDDEN),
    "bias1": (HIDDEN,),
    "weights2": (HIDDEN, LOGITS),
    "bias2": (LOGITS,),
}


def sha256(path: Path) -> str:
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def _is_power_of_two(value: int) -> bool:
    return value > 0 and value & (value - 1) == 0


def load_quantized_parameters(weights_path: Path) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
    record = json.loads(weights_path.read_text(encoding="utf-8"))
    if record.get("schemaVersion") != "lattice.agent.quantized-weights.v1":
        raise ValueError("unsupported weights schema")

    scale = record.get("quantization", {}).get("scale")
    if not isinstance(scale, int) or not _is_power_of_two(scale):
        raise ValueError("the shared quantization scale must be a positive power of two")

    tensors = record.get("tensors")
    if not isinstance(tensors, dict) or set(tensors) != set(EXPECTED_TENSORS):
        raise ValueError("the weights artifact must contain exactly the four learned tensors")

    parameters: dict[str, np.ndarray] = {}
    for name, expected_shape in EXPECTED_TENSORS.items():
        tensor = tensors[name]
        if tensor.get("shape") != list(expected_shape):
            raise ValueError(f"{name} has shape {tensor.get('shape')}, expected {list(expected_shape)}")
        integers = np.asarray(tensor.get("integers"), dtype=np.int64)
        if integers.shape != expected_shape:
            raise ValueError(f"{name} integer payload does not match its declared shape")

        values = (integers.astype(np.float64) / scale).astype(np.float32)
        recovered = values.astype(np.float64) * scale
        if not np.array_equal(recovered, integers.astype(np.float64)):
            raise ValueError(f"{name} contains a dyadic value that is not exact in float32")
        parameters[name] = values

    return parameters, record


def build_graph(weights_path: Path) -> onnx.ModelProto:
    parameters, record = load_quantized_parameters(weights_path)
    model_version = record["modelVersion"]

    initializers = [
        numpy_helper.from_array(np.arange(FEATURES, dtype=np.int64), "feature_indices"),
        numpy_helper.from_array(parameters["weights1"], "weights_1"),
        numpy_helper.from_array(parameters["bias1"], "bias_1"),
        numpy_helper.from_array(parameters["weights2"], "weights_2"),
        numpy_helper.from_array(parameters["bias2"], "bias_2"),
        numpy_helper.from_array(np.array([[1.0], [0.0]], dtype=np.float32), "wait_selector"),
        numpy_helper.from_array(np.array([[0.0], [1.0]], dtype=np.float32), "execute_selector"),
    ]
    nodes = [
        helper.make_node("Gather", ["context", "feature_indices"], ["features"], axis=1),
        helper.make_node("MatMul", ["features", "weights_1"], ["hidden_linear"]),
        helper.make_node("Add", ["hidden_linear", "bias_1"], ["hidden_biased"]),
        helper.make_node("Relu", ["hidden_biased"], ["hidden"]),
        helper.make_node("MatMul", ["hidden", "weights_2"], ["logits_linear"]),
        helper.make_node("Add", ["logits_linear", "bias_2"], ["logits"]),
        helper.make_node("MatMul", ["logits", "wait_selector"], ["wait_logit"]),
        helper.make_node("MatMul", ["logits", "execute_selector"], ["execute_logit"]),
        helper.make_node("Greater", ["execute_logit", "wait_logit"], ["decision"]),
        helper.make_node("Identity", ["context"], ["bound_context"]),
    ]
    graph = helper.make_graph(
        nodes,
        "lattice_agent_synthetic_decision",
        [helper.make_tensor_value_info("context", TensorProto.FLOAT, [1, CONTEXT_LIMBS])],
        [
            helper.make_tensor_value_info("decision", TensorProto.BOOL, [1, 1]),
            helper.make_tensor_value_info(
                "bound_context", TensorProto.FLOAT, [1, CONTEXT_LIMBS]
            ),
        ],
        initializer=initializers,
    )
    model = helper.make_model(
        graph,
        producer_name="lattice-prime",
        producer_version=model_version,
        opset_imports=[helper.make_opsetid("", 17)],
    )
    model.ir_version = 9
    model.doc_string = (
        "Synthetic decision-consistency classifier. Gather reads only context limbs "
        "0 through 5. The graph releases only strict EXECUTE>WAIT and an exact "
        "Identity of the complete bound context."
    )
    helper.set_model_props(
        model,
        {
            "lattice.model_version": model_version,
            "lattice.quantization_scale": str(record["quantization"]["scale"]),
            "lattice.tie_rule": "WAIT",
        },
    )
    onnx.checker.check_model(model, full_check=True)
    inferred = onnx.shape_inference.infer_shapes(model, strict_mode=True)
    onnx.checker.check_model(inferred, full_check=True)
    return inferred


def export_model(weights_path: Path, output_path: Path) -> dict[str, Any]:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    onnx.save_model(build_graph(weights_path), output_path)
    checked = onnx.load(output_path)
    onnx.checker.check_model(checked, full_check=True)
    return {
        "input": {"name": "context", "type": "float32", "shape": [1, CONTEXT_LIMBS]},
        "opset": 17,
        "outputs": [
            {"name": "decision", "type": "bool", "shape": [1, 1]},
            {
                "name": "bound_context",
                "type": "float32",
                "shape": [1, CONTEXT_LIMBS],
            },
        ],
        "sha256": sha256(output_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    model_dir = Path(__file__).resolve().parent
    parser.add_argument("--weights", type=Path, default=model_dir / "weights.json")
    parser.add_argument("--output", type=Path, default=model_dir / "network.onnx")
    args = parser.parse_args()
    print(
        json.dumps(
            export_model(args.weights.resolve(), args.output.resolve()),
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
