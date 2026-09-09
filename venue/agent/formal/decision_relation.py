#!/usr/bin/env python3
"""Independent integer and ONNX correspondence checks for the trained model."""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import struct
from pathlib import Path

import numpy as np
import onnx
from onnx.reference import ReferenceEvaluator


FEATURE_ORDER = [
    "limitRoomBps",
    "recentMoveOffsetBps",
    "roundProgressBps",
    "freshnessSeconds",
    "bufferCategory",
    "horizonCategory",
]
MINIMUMS = [0, 0, 0, 0, 0, 0]
MAXIMUMS = [2000, 2000, 10_000, 300, 2, 2]
CENTERS = [1000, 1000, 5000, 150, 1, 1]
COEFFICIENTS = [6, 4, 1, -16, 1000, 700]
PARAMETER_SCALE = 256
APPROVED_MODEL_HASH = "sha256:da8f5f55246a902a0cb1110bfa2725aae8a3ffab901e76b2bd916fdaa7fd5503"

EXPECTED_INTEGERS = {
    "weights1": [
        [6, 6, 6, 6, -6, -6, -6, -6],
        [4, 4, 4, 4, -4, -4, -4, -4],
        [1, 1, 1, 1, -1, -1, -1, -1],
        [-16, -16, -16, -16, 16, 16, 16, 16],
        [1000, 1000, 1000, 1000, -1000, -1000, -1000, -1000],
        [700, 700, 700, 700, -700, -700, -700, -700],
    ],
    "bias1": [-14300, -14300, -14300, -14300, 14300, 14300, 14300, 14300],
    "weights2": [
        [0, 64],
        [0, 64],
        [0, 64],
        [0, 64],
        [64, 0],
        [64, 0],
        [64, 0],
        [64, 0],
    ],
    "bias2": [0, 0],
}


class CorrespondenceError(ValueError):
    pass


def sha256(path: Path) -> str:
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def require_features(features: list[int]) -> list[int]:
    if (
        not isinstance(features, list)
        or len(features) != 6
        or any(isinstance(value, bool) or not isinstance(value, int) for value in features)
        or any(
            value < minimum or value > maximum
            for value, minimum, maximum in zip(features, MINIMUMS, MAXIMUMS)
        )
    ):
        raise CorrespondenceError("feature vector is outside the approved integer domains")
    return features


def relation_score(features: list[int]) -> int:
    values = require_features(features)
    return sum(
        coefficient * (value - center)
        for value, center, coefficient in zip(values, CENTERS, COEFFICIENTS)
    )


def relation_decision(features: list[int]) -> bool:
    return relation_score(features) > 0


def load_integer_parameters(weights_path: Path) -> dict[str, np.ndarray]:
    record = json.loads(weights_path.read_text(encoding="utf-8"))
    if (
        record.get("schemaVersion") != "lattice.agent.quantized-weights.v1"
        or record.get("quantization", {}).get("scale") != PARAMETER_SCALE
        or set(record.get("tensors", {})) != set(EXPECTED_INTEGERS)
    ):
        raise CorrespondenceError("quantized weights schema or scale is not approved")
    result = {}
    for name, expected in EXPECTED_INTEGERS.items():
        actual = record["tensors"][name].get("integers")
        if actual != expected:
            raise CorrespondenceError(f"quantized tensor {name} differs from the approved artifact")
        result[name] = np.asarray(actual, dtype=object)
    return result


def quantized_logits(features: list[int], parameters: dict[str, np.ndarray]) -> tuple[int, int]:
    values = np.asarray(require_features(features), dtype=object)
    hidden = values @ parameters["weights1"] + parameters["bias1"]
    hidden = np.maximum(hidden, 0)
    logits = hidden @ parameters["weights2"] + parameters["bias2"] * PARAMETER_SCALE
    return int(logits[0]), int(logits[1])


def quantized_decision(features: list[int], parameters: dict[str, np.ndarray]) -> bool:
    wait, execute = quantized_logits(features, parameters)
    return execute > wait


def float32_bits(value: float) -> str:
    return f"0x{struct.pack('>f', np.float32(value)).hex()}"


def generated_cases(count: int) -> list[list[int]]:
    generator = random.Random(20260909)
    cases = [
        MINIMUMS.copy(),
        MAXIMUMS.copy(),
        CENTERS.copy(),
    ]
    for index in range(6):
        for value in (MINIMUMS[index], MAXIMUMS[index]):
            features = CENTERS.copy()
            features[index] = value
            cases.append(features)
    while len(cases) < count:
        cases.append(
            [
                generator.randint(minimum, maximum)
                for minimum, maximum in zip(MINIMUMS, MAXIMUMS)
            ]
        )
    return cases


def check_correspondence(model_dir: Path, random_case_count: int = 4096) -> dict:
    model_path = model_dir / "network.onnx"
    weights_path = model_dir / "weights.json"
    boundary = json.loads((model_dir / "boundary-corpus.json").read_text(encoding="utf-8"))
    float_reference = json.loads(
        (model_dir / "float-correspondence.json").read_text(encoding="utf-8")
    )
    report = json.loads((model_dir / "evaluation-report.json").read_text(encoding="utf-8"))
    if sha256(model_path) != APPROVED_MODEL_HASH:
        raise CorrespondenceError("ONNX artifact identity differs from the approved cloud export")
    if boundary.get("featureOrder") != FEATURE_ORDER:
        raise CorrespondenceError("boundary feature order is invalid")
    if float_reference.get("featureOrder") != FEATURE_ORDER:
        raise CorrespondenceError("float reference feature order is invalid")
    if (
        float_reference.get("heldOutFloatDecisions", {}).get("sha256")
        != report.get("floatCorrespondence", {}).get("heldOutFloatDecisionSha256")
    ):
        raise CorrespondenceError("held-out float decision digest differs between cloud artifacts")

    parameters = load_integer_parameters(weights_path)
    model = onnx.load(model_path)
    evaluator = ReferenceEvaluator(model)
    boundary_by_id = {case["id"]: case for case in boundary["cases"]}
    float_by_id = {case["caseId"]: case for case in float_reference["boundaryCases"]}
    if set(boundary_by_id) != set(float_by_id):
        raise CorrespondenceError("float and boundary case identifiers differ")

    float_cases = 0
    for case_id, case in boundary_by_id.items():
        features = [case["features"][name] for name in FEATURE_ORDER]
        reference = float_by_id[case_id]
        if reference["features"] != features:
            raise CorrespondenceError(f"float feature vector differs for {case_id}")
        wait, execute = quantized_logits(features, parameters)
        expected_bits = {
            "WAIT": float32_bits(wait / (PARAMETER_SCALE * PARAMETER_SCALE)),
            "EXECUTE": float32_bits(execute / (PARAMETER_SCALE * PARAMETER_SCALE)),
        }
        decisions = {
            case["expectedDecision"],
            reference["floatDecision"],
            "EXECUTE" if quantized_decision(features, parameters) else "WAIT",
            "EXECUTE" if relation_decision(features) else "WAIT",
        }
        if len(decisions) != 1 or reference["floatLogitsF32Bits"] != expected_bits:
            raise CorrespondenceError(f"float, integer, and relation paths differ for {case_id}")
        float_cases += 1

    cases = generated_cases(random_case_count)
    onnx_cases = 0
    for case_index, features in enumerate(cases):
        relation = relation_decision(features)
        if quantized_decision(features, parameters) != relation:
            raise CorrespondenceError(f"integer graph differs from the relation at case {case_index}")
        context = np.zeros((1, 173), dtype=np.float32)
        context[0, :6] = np.asarray(features, dtype=np.float32)
        context[0, 6:] = np.asarray(
            [(case_index * 257 + index * 17) % 65536 for index in range(167)],
            dtype=np.float32,
        )
        decision, bound_context = evaluator.run(None, {"context": context})
        if bool(decision[0, 0]) != relation or not np.array_equal(bound_context, context):
            raise CorrespondenceError(f"ONNX path differs from the relation at case {case_index}")
        onnx_cases += 1

    return {
        "schemaVersion": "lattice.agent.local-correspondence.v1",
        "status": "passed",
        "modelSha256": sha256(model_path),
        "weightsSha256": sha256(weights_path),
        "cloudFloatReferenceSha256": sha256(model_dir / "float-correspondence.json"),
        "heldOutFloatDecisionSha256": float_reference["heldOutFloatDecisions"]["sha256"],
        "boundaryCasesComparedAcrossFloatIntegerAndRelation": float_cases,
        "generatedCasesComparedAcrossIntegerOnnxAndRelation": onnx_cases,
        "boundContextIdentityCases": onnx_cases,
        "tieRule": "WAIT",
        "scope": (
            "Cloud float inference is compared on the committed boundary corpus. "
            "Local integer, ONNX, and formal relations are compared on deterministic generated cases."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--model-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "model",
    )
    parser.add_argument("--random-cases", type=int, default=4096)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = check_correspondence(args.model_dir.resolve(), args.random_cases)
    rendered = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")


if __name__ == "__main__":
    main()
