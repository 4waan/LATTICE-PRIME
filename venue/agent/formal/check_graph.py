#!/usr/bin/env python3
"""Reject ONNX graphs outside the Phase 1 information-flow envelope."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper


ALLOWED_OPERATORS = {"Gather", "MatMul", "Add", "Relu", "Greater", "Identity"}
EXPECTED_OUTPUTS = {"decision", "bound_context"}
EXPECTED_CONTEXT_LIMBS = 173
EXPECTED_NODES = [
    ("Gather", ["context", "feature_indices"], ["features"]),
    ("MatMul", ["features", "weights_1"], ["hidden_linear"]),
    ("Add", ["hidden_linear", "bias_1"], ["hidden_biased"]),
    ("Relu", ["hidden_biased"], ["hidden"]),
    ("MatMul", ["hidden", "weights_2"], ["score_linear"]),
    ("Add", ["score_linear", "bias_2"], ["score"]),
    ("Greater", ["score", "zero"], ["decision"]),
    ("Identity", ["context"], ["bound_context"]),
]
EXPECTED_WEIGHTS_1 = np.array(
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
EXPECTED_BIAS_1 = np.array(
    [-250.0, -1000.0, 180.0, -2500.0, 8000.0, 0.0, 0.0, 1.0],
    dtype=np.float32,
)
EXPECTED_WEIGHTS_2 = np.array(
    [[1.0], [0.25], [1.0], [1.0 / 64.0], [1.0 / 128.0], [-100.0], [20.0], [-500.0]],
    dtype=np.float32,
)


class GraphRefused(ValueError):
    pass


def sha256(path: Path) -> str:
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def inspect_graph(model_path: Path) -> dict[str, object]:
    model = onnx.load(model_path)
    onnx.checker.check_model(model, full_check=True)
    graph = model.graph

    if any(op.domain not in ("", "ai.onnx") for op in model.opset_import):
        raise GraphRefused("custom operator domains are forbidden")
    if any(node.domain not in ("", "ai.onnx") for node in graph.node):
        raise GraphRefused("custom operator domains are forbidden")
    if len(graph.input) != 1 or graph.input[0].name != "context":
        raise GraphRefused("the graph must have exactly one context input")
    dimensions = graph.input[0].type.tensor_type.shape.dim
    shape = [dimension.dim_value for dimension in dimensions]
    if shape != [1, EXPECTED_CONTEXT_LIMBS]:
        raise GraphRefused(f"context shape is {shape}, expected [1, {EXPECTED_CONTEXT_LIMBS}]")
    if {output.name for output in graph.output} != EXPECTED_OUTPUTS:
        raise GraphRefused("the graph has an unexpected public output")

    operators = {node.op_type for node in graph.node}
    forbidden = sorted(operators - ALLOWED_OPERATORS)
    if forbidden:
        raise GraphRefused(f"forbidden operators: {', '.join(forbidden)}")
    actual_nodes = [(node.op_type, list(node.input), list(node.output)) for node in graph.node]
    if actual_nodes != EXPECTED_NODES:
        raise GraphRefused("the graph topology differs from the approved decision and context paths")

    initializers = {value.name: numpy_helper.to_array(value) for value in graph.initializer}
    if set(initializers) != {"feature_indices", "weights_1", "bias_1", "weights_2", "bias_2", "zero"}:
        raise GraphRefused("the fixed parameter set differs from the approved graph")
    if not np.array_equal(initializers["feature_indices"], np.arange(6, dtype=np.int64)):
        raise GraphRefused("the decision graph may read only context limbs 0 through 5")
    expected_parameters = {
        "weights_1": EXPECTED_WEIGHTS_1,
        "bias_1": EXPECTED_BIAS_1,
        "weights_2": EXPECTED_WEIGHTS_2,
        "bias_2": np.array([0.0], dtype=np.float32),
        "zero": np.array([0.0], dtype=np.float32),
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
        "modelSha256": sha256(model_path),
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
