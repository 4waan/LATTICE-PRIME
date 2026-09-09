#!/usr/bin/env python3
"""Reject ONNX graphs outside the Phase 1 information-flow envelope."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, numpy_helper


ALLOWED_OPERATORS = {"Gather", "MatMul", "Add", "Relu", "Greater", "Identity"}
EXPECTED_CONTEXT_LIMBS = 173
APPROVED_MODEL_SHA256 = "sha256:da8f5f55246a902a0cb1110bfa2725aae8a3ffab901e76b2bd916fdaa7fd5503"
PARAMETER_SCALE = 256
EXPECTED_NODES = [
    ("Gather", ["context", "feature_indices"], ["features"]),
    ("MatMul", ["features", "weights_1"], ["hidden_linear"]),
    ("Add", ["hidden_linear", "bias_1"], ["hidden_biased"]),
    ("Relu", ["hidden_biased"], ["hidden"]),
    ("MatMul", ["hidden", "weights_2"], ["logits_linear"]),
    ("Add", ["logits_linear", "bias_2"], ["logits"]),
    ("MatMul", ["logits", "wait_selector"], ["wait_logit"]),
    ("MatMul", ["logits", "execute_selector"], ["execute_logit"]),
    ("Greater", ["execute_logit", "wait_logit"], ["decision"]),
    ("Identity", ["context"], ["bound_context"]),
]
EXPECTED_WEIGHTS_1_INTEGERS = np.array(
    [
        [6, 6, 6, 6, -6, -6, -6, -6],
        [4, 4, 4, 4, -4, -4, -4, -4],
        [1, 1, 1, 1, -1, -1, -1, -1],
        [-16, -16, -16, -16, 16, 16, 16, 16],
        [1000, 1000, 1000, 1000, -1000, -1000, -1000, -1000],
        [700, 700, 700, 700, -700, -700, -700, -700],
    ],
    dtype=np.int64,
)
EXPECTED_BIAS_1_INTEGERS = np.array(
    [-14300, -14300, -14300, -14300, 14300, 14300, 14300, 14300],
    dtype=np.int64,
)
EXPECTED_WEIGHTS_2_INTEGERS = np.array(
    [[0, 64], [0, 64], [0, 64], [0, 64], [64, 0], [64, 0], [64, 0], [64, 0]],
    dtype=np.int64,
)


class GraphRefused(ValueError):
    pass


def sha256(path: Path) -> str:
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def inspect_graph(model_path: Path) -> dict[str, object]:
    model_hash = sha256(model_path)
    if model_hash != APPROVED_MODEL_SHA256:
        raise GraphRefused("model artifact identity differs from the approved cloud export")
    model = onnx.load(model_path)
    onnx.checker.check_model(model, full_check=True)
    graph = model.graph

    if [(op.domain, op.version) for op in model.opset_import] != [("", 17)]:
        raise GraphRefused("the graph must use only default-domain ONNX opset 17")
    properties = {entry.key: entry.value for entry in model.metadata_props}
    if properties != {
        "lattice.model_version": "lattice.agent.synthetic-decision-model.v1",
        "lattice.quantization_scale": "256",
        "lattice.tie_rule": "WAIT",
    }:
        raise GraphRefused("model metadata differs from the approved cloud export")
    if any(op.domain not in ("", "ai.onnx") for op in model.opset_import):
        raise GraphRefused("custom operator domains are forbidden")
    if any(node.domain not in ("", "ai.onnx") for node in graph.node):
        raise GraphRefused("custom operator domains are forbidden")
    if len(graph.input) != 1 or graph.input[0].name != "context":
        raise GraphRefused("the graph must have exactly one context input")
    if graph.input[0].type.tensor_type.elem_type != TensorProto.FLOAT:
        raise GraphRefused("context input must be float32")
    dimensions = graph.input[0].type.tensor_type.shape.dim
    shape = [dimension.dim_value for dimension in dimensions]
    if shape != [1, EXPECTED_CONTEXT_LIMBS]:
        raise GraphRefused(f"context shape is {shape}, expected [1, {EXPECTED_CONTEXT_LIMBS}]")
    if [output.name for output in graph.output] != ["decision", "bound_context"]:
        raise GraphRefused("the graph has an unexpected public output")
    output_types = [output.type.tensor_type.elem_type for output in graph.output]
    output_shapes = [
        [dimension.dim_value for dimension in output.type.tensor_type.shape.dim]
        for output in graph.output
    ]
    if output_types != [TensorProto.BOOL, TensorProto.FLOAT] or output_shapes != [
        [1, 1],
        [1, EXPECTED_CONTEXT_LIMBS],
    ]:
        raise GraphRefused("public output type or shape differs from the approved graph")

    operators = {node.op_type for node in graph.node}
    forbidden = sorted(operators - ALLOWED_OPERATORS)
    if forbidden:
        raise GraphRefused(f"forbidden operators: {', '.join(forbidden)}")
    actual_nodes = [(node.op_type, list(node.input), list(node.output)) for node in graph.node]
    if actual_nodes != EXPECTED_NODES:
        raise GraphRefused("the graph topology differs from the approved decision and context paths")

    initializers = {value.name: numpy_helper.to_array(value) for value in graph.initializer}
    if set(initializers) != {
        "feature_indices",
        "weights_1",
        "bias_1",
        "weights_2",
        "bias_2",
        "wait_selector",
        "execute_selector",
    }:
        raise GraphRefused("the fixed parameter set differs from the approved graph")
    if not np.array_equal(initializers["feature_indices"], np.arange(6, dtype=np.int64)):
        raise GraphRefused("the decision graph may read only context limbs 0 through 5")
    expected_parameters = {
        "weights_1": (EXPECTED_WEIGHTS_1_INTEGERS / PARAMETER_SCALE).astype(np.float32),
        "bias_1": (EXPECTED_BIAS_1_INTEGERS / PARAMETER_SCALE).astype(np.float32),
        "weights_2": (EXPECTED_WEIGHTS_2_INTEGERS / PARAMETER_SCALE).astype(np.float32),
        "bias_2": np.array([0.0, 0.0], dtype=np.float32),
        "wait_selector": np.array([[1.0], [0.0]], dtype=np.float32),
        "execute_selector": np.array([[0.0], [1.0]], dtype=np.float32),
    }
    for name, expected in expected_parameters.items():
        if not np.array_equal(initializers[name], expected):
            raise GraphRefused(f"fixed parameter {name} differs from the approved graph")

    producers = {output: node for node in graph.node for output in node.output}
    bound = producers.get("bound_context")
    if bound is None or bound.op_type != "Identity" or list(bound.input) != ["context"]:
        raise GraphRefused("bound_context must be an exact identity path from context")

    decision = producers.get("decision")
    if decision is None or decision.op_type != "Greater":
        raise GraphRefused("decision must be the approved strict comparison so ties WAIT")

    graph_inputs = {value.name for value in graph.input}
    for node in graph.node:
        for name in node.input:
            if name and name not in graph_inputs and name not in initializers and name not in producers:
                raise GraphRefused(f"node {node.op_type} reads an unbound value {name}")

    return {
        "schemaVersion": "lattice.agent.graph-check.v1",
        "accepted": True,
        "modelSha256": model_hash,
        "inputShape": shape,
        "operators": sorted(operators),
        "decisionInputLimbs": [0, 1, 2, 3, 4, 5],
        "boundContextPath": "Identity(context)",
        "customOperators": False,
        "scope": (
            "Structural dependency check for graph inputs and public outputs. "
            "It does not prove host-wide absence of side channels."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("model", type=Path)
    args = parser.parse_args()
    print(json.dumps(inspect_graph(args.model), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
