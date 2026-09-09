#!/usr/bin/env python3
"""Deterministically train, quantize, export, and evaluate the synthetic model."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import struct
import sys
from collections import OrderedDict
from pathlib import Path
from typing import Any

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import numpy as np
import onnx
import onnxruntime as ort
import torch

from export import export_model, load_quantized_parameters


WAIT = 0
EXECUTE = 1
PARAMETER_SHAPES = {
    "weights1": (6, 8),
    "bias1": (8,),
    "weights2": (8, 2),
    "bias2": (2,),
}


def canonical_json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n"
    ).encode("utf-8")


def pretty_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def sha256_bytes(content: bytes) -> str:
    return f"sha256:{hashlib.sha256(content).hexdigest()}"


def sha256(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def validate_config(config: dict[str, Any]) -> None:
    if config.get("schemaVersion") != "lattice.agent.synthetic-training-config.v1":
        raise ValueError("unsupported training configuration schema")
    features = config.get("features")
    if not isinstance(features, list) or len(features) != 6:
        raise ValueError("the model must have exactly six declared input features")
    if [feature.get("index") for feature in features] != list(range(6)):
        raise ValueError("feature indices must be exactly 0 through 5")
    for feature in features:
        if not isinstance(feature.get("minimum"), int) or not isinstance(
            feature.get("maximum"), int
        ):
            raise ValueError("all feature domains must have integer bounds")
        if feature["minimum"] >= feature["maximum"]:
            raise ValueError(f"invalid feature domain for {feature.get('name')}")

    architecture = config.get("architecture", {})
    expected_architecture = {
        "contextInputShape": [1, 173],
        "decisionInputLimbs": [0, 1, 2, 3, 4, 5],
        "hiddenUnits": 8,
        "inputFeatures": 6,
        "logits": ["WAIT", "EXECUTE"],
        "opset": 17,
        "tieRule": "WAIT",
    }
    for key, expected in expected_architecture.items():
        if architecture.get(key) != expected:
            raise ValueError(f"architecture.{key} must be {expected!r}")

    label_rule = config.get("labelRule", {})
    if len(label_rule.get("centers", [])) != 6 or len(
        label_rule.get("coefficients", [])
    ) != 6:
        raise ValueError("the executable label rule must have six centers and coefficients")

    split = config.get("dataset", {}).get("split", {})
    if sum(split.get(name, 0) for name in ("train", "validation", "test")) != config[
        "dataset"
    ].get("sampleCount"):
        raise ValueError("split counts must sum to dataset.sampleCount")
    if any(split.get(name, 0) % 2 for name in ("train", "validation", "test")):
        raise ValueError("pair-preserving split counts must be even")


def feature_arrays(
    config: dict[str, Any],
) -> tuple[list[str], np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    names = [feature["name"] for feature in config["features"]]
    minimums = np.asarray([feature["minimum"] for feature in config["features"]], dtype=np.int64)
    maximums = np.asarray([feature["maximum"] for feature in config["features"]], dtype=np.int64)
    centers = np.asarray(config["labelRule"]["centers"], dtype=np.int64)
    coefficients = np.asarray(config["labelRule"]["coefficients"], dtype=np.int64)
    if not np.array_equal(minimums + maximums, centers * 2):
        raise ValueError("pair reflection requires each rule center to be the domain midpoint")
    return names, minimums, maximums, centers, coefficients


def rule_scores(
    features: np.ndarray, centers: np.ndarray, coefficients: np.ndarray
) -> np.ndarray:
    values = np.asarray(features, dtype=np.int64)
    return ((values - centers) * coefficients).sum(axis=1, dtype=np.int64)


def generate_splits(
    config: dict[str, Any],
) -> tuple[dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]], str]:
    _, minimums, maximums, centers, coefficients = feature_arrays(config)
    dataset = config["dataset"]
    margin = int(dataset["trainingMarginScoreUnits"])
    split_counts = dataset["split"]
    pair_total = dataset["sampleCount"] // 2
    rng = np.random.Generator(np.random.PCG64(int(dataset["seed"])))

    accepted: list[np.ndarray] = []
    accepted_count = 0
    while accepted_count < pair_total:
        remaining = pair_total - accepted_count
        batch_size = max(2048, remaining * 2)
        batch = rng.integers(
            minimums,
            maximums + 1,
            size=(batch_size, len(minimums)),
            dtype=np.int64,
        )
        scores = rule_scores(batch, centers, coefficients)
        keep = batch[np.abs(scores) > margin]
        if keep.size:
            selected = keep[:remaining]
            accepted.append(selected)
            accepted_count += len(selected)

    bases = np.concatenate(accepted, axis=0)
    reflected = minimums + maximums - bases
    pairs = np.stack([bases, reflected], axis=1)
    reflected_scores = rule_scores(reflected, centers, coefficients)
    if not np.array_equal(
        rule_scores(bases, centers, coefficients), -reflected_scores
    ):
        raise RuntimeError("the generated reflection did not negate the label score")

    pairs = pairs[rng.permutation(pair_total)]
    result: dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]] = {}
    pair_offset = 0
    digest = hashlib.sha256()
    for split_name in ("train", "validation", "test"):
        count = int(split_counts[split_name])
        pair_count = count // 2
        split_features = pairs[pair_offset : pair_offset + pair_count].reshape(-1, 6)
        pair_offset += pair_count
        split_features = split_features[rng.permutation(count)]
        split_scores = rule_scores(split_features, centers, coefficients)
        split_labels = (split_scores > 0).astype(np.int64)
        if np.count_nonzero(split_labels == WAIT) != count // 2:
            raise RuntimeError(f"{split_name} split lost exact class balance")
        if np.any(np.abs(split_scores) <= margin):
            raise RuntimeError(f"{split_name} split contains a scenario inside the margin")
        result[split_name] = (split_features, split_scores, split_labels)

        digest.update(split_name.encode("ascii") + b"\0")
        digest.update(split_features.astype("<i4", copy=False).tobytes(order="C"))
        digest.update(split_scores.astype("<i8", copy=False).tobytes(order="C"))
        digest.update(split_labels.astype("u1", copy=False).tobytes(order="C"))

    return result, f"sha256:{digest.hexdigest()}"


def configure_torch(config: dict[str, Any]) -> None:
    if config["training"]["device"] != "cpu":
        raise ValueError("this pipeline permits CPU training only")
    torch.set_num_threads(int(config["training"]["threads"]))
    torch.set_num_interop_threads(1)
    torch.use_deterministic_algorithms(True)
    if hasattr(torch.backends, "mkldnn"):
        torch.backends.mkldnn.enabled = False
    torch.manual_seed(int(config["dataset"]["seed"]))


def train_float_parameters(
    config: dict[str, Any],
    train_features: np.ndarray,
    train_scores: np.ndarray,
) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
    _, minimums, maximums, centers, _ = feature_arrays(config)
    half_ranges = (maximums - minimums).astype(np.float64) / 2.0
    normalized = (train_features.astype(np.float64) - centers) / half_ranges
    target_scale = int(config["quantization"]["candidateDyadicScales"][0])
    signed_target = train_scores.astype(np.float64) / target_scale

    x = torch.from_numpy(normalized)
    y = torch.from_numpy(signed_target[:, None])
    design = torch.cat([x, torch.ones((len(x), 1), dtype=torch.float64)], dim=1)
    projection_fit = torch.linalg.lstsq(design, y, driver="gels").solution[:, 0]
    projection = design @ projection_fit

    positive = torch.relu(projection)
    negative = torch.relu(-projection)
    unique_hidden = torch.stack([positive, negative], dim=1)
    target_logits = torch.stack(
        [torch.relu(-y[:, 0]), torch.relu(y[:, 0])],
        dim=1,
    )
    output_design = torch.cat(
        [unique_hidden, torch.ones((len(unique_hidden), 1), dtype=torch.float64)],
        dim=1,
    )
    output_fit = torch.linalg.lstsq(
        output_design, target_logits, driver="gels"
    ).solution

    normalized_weights = projection_fit[:6].detach().cpu().numpy()
    normalized_bias = float(projection_fit[6])
    raw_projection = normalized_weights / half_ranges
    raw_bias = normalized_bias - float(np.dot(raw_projection, centers))

    weights1 = np.empty((6, 8), dtype=np.float64)
    weights1[:, :4] = raw_projection[:, None]
    weights1[:, 4:] = -raw_projection[:, None]
    bias1 = np.concatenate(
        [
            np.full(4, raw_bias, dtype=np.float64),
            np.full(4, -raw_bias, dtype=np.float64),
        ]
    )

    weights2 = np.empty((8, 2), dtype=np.float64)
    weights2[:4, :] = output_fit[0].detach().cpu().numpy()[None, :] / 4.0
    weights2[4:, :] = output_fit[1].detach().cpu().numpy()[None, :] / 4.0
    bias2 = output_fit[2].detach().cpu().numpy()

    parameters = {
        "weights1": weights1.astype(np.float32),
        "bias1": bias1.astype(np.float32),
        "weights2": weights2.astype(np.float32),
        "bias2": bias2.astype(np.float32),
    }
    zero_threshold = float(config["training"]["numericalZeroThreshold"])
    for values in parameters.values():
        values[np.abs(values) < zero_threshold] = np.float32(0.0)
    for name, shape in PARAMETER_SHAPES.items():
        if parameters[name].shape != shape:
            raise RuntimeError(f"trained {name} has the wrong shape")

    projection_residual = projection - y[:, 0]
    output_residual = output_design @ output_fit - target_logits
    diagnostics = {
        "device": str(design.device),
        "fitMethod": "torch.linalg.lstsq",
        "firstStageRank": int(torch.linalg.matrix_rank(design).item()),
        "maxAbsProjectionResidual": float(torch.max(torch.abs(projection_residual)).item()),
        "maxAbsOutputResidual": float(torch.max(torch.abs(output_residual)).item()),
        "numericalZeroThreshold": zero_threshold,
        "outputStageRank": int(torch.linalg.matrix_rank(output_design).item()),
        "targetScale": target_scale,
    }
    return parameters, diagnostics


def classifier_logits(
    parameters: dict[str, np.ndarray], features: np.ndarray
) -> np.ndarray:
    values = np.asarray(features, dtype=np.float32)
    hidden = np.maximum(
        values @ parameters["weights1"] + parameters["bias1"], np.float32(0.0)
    )
    return hidden @ parameters["weights2"] + parameters["bias2"]


def predict(parameters: dict[str, np.ndarray], features: np.ndarray) -> np.ndarray:
    logits = classifier_logits(parameters, features)
    return (logits[:, EXECUTE] > logits[:, WAIT]).astype(np.int64)


def build_boundary_corpus(config: dict[str, Any]) -> tuple[dict[str, Any], np.ndarray, np.ndarray]:
    names, minimums, maximums, centers, coefficients = feature_arrays(config)
    cases: OrderedDict[tuple[int, ...], set[str]] = OrderedDict()

    def add(values: np.ndarray | list[int], *tags: str) -> None:
        array = np.asarray(values, dtype=np.int64)
        if array.shape != (6,):
            raise ValueError("boundary case must contain exactly six features")
        if np.any(array < minimums) or np.any(array > maximums):
            raise ValueError(f"boundary case outside declared domains: {array.tolist()}")
        key = tuple(int(value) for value in array)
        cases.setdefault(key, set()).update(tags)

    add(minimums, "all-minima", "representative-WAIT")
    add(maximums, "all-maxima", "representative-EXECUTE")
    add(centers, "exact-rule-tie", "representative-WAIT")
    for index, name in enumerate(names):
        for endpoint, label in ((minimums[index], "minimum"), (maximums[index], "maximum")):
            values = centers.copy()
            values[index] = endpoint
            add(values, f"{name}-{label}", "feature-extremum")

    for index, name in enumerate(names[:4]):
        for offset in (-1, 0, 1):
            values = centers.copy()
            values[index] += offset
            add(values, f"{name}-threshold-neighborhood", f"offset-{offset:+d}")

    progress_index = names.index("roundProgressBps")
    for score in config["boundaryCorpus"]["ruleScoreNeighborhood"]:
        values = centers.copy()
        values[progress_index] += int(score)
        add(values, "rule-score-threshold-neighborhood", f"rule-score-{score:+d}")

    buffer_index = names.index("bufferCategory")
    horizon_index = names.index("horizonCategory")
    for buffer_category in range(3):
        for horizon_category in range(3):
            category_contribution = (
                coefficients[buffer_index] * (buffer_category - centers[buffer_index])
                + coefficients[horizon_index] * (horizon_category - centers[horizon_index])
            )
            for target_score in (-1, 0, 1):
                values = centers.copy()
                values[buffer_index] = buffer_category
                values[horizon_index] = horizon_category
                values[progress_index] = (
                    centers[progress_index] - category_contribution + target_score
                )
                add(
                    values,
                    "all-category-values",
                    "category-conditioned-threshold",
                    f"rule-score-{target_score:+d}",
                )

    feature_matrix = np.asarray(list(cases), dtype=np.int64)
    scores = rule_scores(feature_matrix, centers, coefficients)
    labels = (scores > 0).astype(np.int64)
    serialized_cases = []
    for index, (features, tags) in enumerate(cases.items()):
        score = int(scores[index])
        serialized_cases.append(
            {
                "expectedDecision": "EXECUTE" if score > 0 else "WAIT",
                "features": {name: int(value) for name, value in zip(names, features)},
                "id": f"boundary-{index:03d}",
                "ruleScore": score,
                "tags": sorted(tags),
            }
        )
    record = {
        "cases": serialized_cases,
        "featureOrder": names,
        "labelRuleId": config["labelRule"]["id"],
        "modelVersion": config["modelVersion"],
        "schemaVersion": config["boundaryCorpus"]["schemaVersion"],
    }
    return record, feature_matrix, labels


def quantize(
    parameters: dict[str, np.ndarray], scale: int
) -> tuple[dict[str, np.ndarray], dict[str, np.ndarray]]:
    integers: dict[str, np.ndarray] = {}
    dequantized: dict[str, np.ndarray] = {}
    for name in PARAMETER_SHAPES:
        quantized = np.rint(parameters[name].astype(np.float64) * scale).astype(np.int64)
        values = (quantized.astype(np.float64) / scale).astype(np.float32)
        if not np.array_equal(
            values.astype(np.float64) * scale, quantized.astype(np.float64)
        ):
            raise ValueError(f"{name} is not exactly representable at dyadic scale {scale}")
        integers[name] = quantized
        dequantized[name] = values
    return integers, dequantized


def confusion(expected: np.ndarray, actual: np.ndarray) -> dict[str, int]:
    return {
        "trueEXECUTE_predEXECUTE": int(
            np.count_nonzero((expected == EXECUTE) & (actual == EXECUTE))
        ),
        "trueEXECUTE_predWAIT": int(
            np.count_nonzero((expected == EXECUTE) & (actual == WAIT))
        ),
        "trueWAIT_predEXECUTE": int(
            np.count_nonzero((expected == WAIT) & (actual == EXECUTE))
        ),
        "trueWAIT_predWAIT": int(
            np.count_nonzero((expected == WAIT) & (actual == WAIT))
        ),
    }


def evaluation_metrics(
    expected: np.ndarray, float_decisions: np.ndarray, quantized_decisions: np.ndarray
) -> dict[str, Any]:
    count = len(expected)
    wait_count = int(np.count_nonzero(expected == WAIT))
    execute_count = int(np.count_nonzero(expected == EXECUTE))
    return {
        "classBalance": {
            "EXECUTE": execute_count,
            "WAIT": wait_count,
            "executeFraction": round(execute_count / count, 12),
            "waitFraction": round(wait_count / count, 12),
        },
        "float": {
            "accuracyAgainstSyntheticRule": round(
                float(np.mean(float_decisions == expected)), 12
            ),
            "confusion": confusion(expected, float_decisions),
        },
        "floatVersusQuantizedDisagreementCount": int(
            np.count_nonzero(float_decisions != quantized_decisions)
        ),
        "quantized": {
            "accuracyAgainstSyntheticRule": round(
                float(np.mean(quantized_decisions == expected)), 12
            ),
            "confusion": confusion(expected, quantized_decisions),
        },
        "sampleCount": count,
    }


def float_parameter_hash(parameters: dict[str, np.ndarray]) -> str:
    digest = hashlib.sha256()
    for name in PARAMETER_SHAPES:
        digest.update(name.encode("ascii") + b"\0")
        digest.update(np.asarray(parameters[name], dtype="<f4").tobytes(order="C"))
    return f"sha256:{digest.hexdigest()}"


def float32_hex_bits(value: np.float32) -> str:
    bits = struct.unpack(">I", struct.pack(">f", float(value)))[0]
    return f"0x{bits:08x}"


def held_out_float_decision_digest(
    dataset_hash: str, split_name: str, decisions: np.ndarray
) -> str:
    encoded_decisions = np.asarray(decisions, dtype=np.uint8)
    if np.any((encoded_decisions != WAIT) & (encoded_decisions != EXECUTE)):
        raise ValueError("held-out decisions must contain only WAIT or EXECUTE")
    digest = hashlib.sha256()
    digest.update(b"lattice.agent.held-out-float-decisions.v1\0")
    digest.update(dataset_hash.encode("ascii") + b"\0")
    digest.update(split_name.encode("ascii") + b"\0")
    digest.update(len(encoded_decisions).to_bytes(8, byteorder="big"))
    digest.update(encoded_decisions.tobytes(order="C"))
    return f"sha256:{digest.hexdigest()}"


def build_float_correspondence(
    config: dict[str, Any],
    config_hash: str,
    dataset_hash: str,
    boundary_record: dict[str, Any],
    boundary_features: np.ndarray,
    float_parameters: dict[str, np.ndarray],
    held_out_decisions: np.ndarray,
) -> dict[str, Any]:
    boundary_logits = classifier_logits(float_parameters, boundary_features)
    boundary_decisions = (
        boundary_logits[:, EXECUTE] > boundary_logits[:, WAIT]
    ).astype(np.int64)
    if len(boundary_record["cases"]) != len(boundary_features):
        raise RuntimeError("boundary record and feature matrix lengths differ")

    cases = []
    for index, boundary_case in enumerate(boundary_record["cases"]):
        cases.append(
            {
                "caseId": boundary_case["id"],
                "features": [int(value) for value in boundary_features[index]],
                "floatDecision": (
                    "EXECUTE" if boundary_decisions[index] == EXECUTE else "WAIT"
                ),
                "floatLogitsF32Bits": {
                    "EXECUTE": float32_hex_bits(boundary_logits[index, EXECUTE]),
                    "WAIT": float32_hex_bits(boundary_logits[index, WAIT]),
                },
            }
        )

    split_name = "test"
    decision_digest = held_out_float_decision_digest(
        dataset_hash, split_name, held_out_decisions
    )
    return {
        "boundaryCases": cases,
        "featureOrder": [feature["name"] for feature in config["features"]],
        "floatInference": {
            "decisionRule": "EXECUTE strictly greater than WAIT; ties are WAIT",
            "logitEncoding": (
                "Exact IEEE-754 binary32 bit pattern as 0x followed by eight "
                "lowercase hexadecimal digits"
            ),
            "parameterSha256": float_parameter_hash(float_parameters),
            "source": (
                "Actual in-memory trained float parameters before parameter "
                "quantization"
            ),
        },
        "heldOutFloatDecisions": {
            "decisionByteEncoding": "WAIT=0x00, EXECUTE=0x01, in generated split order",
            "digestAlgorithm": "SHA-256",
            "digestPreimage": [
                "ASCII lattice.agent.held-out-float-decisions.v1 followed by NUL",
                "ASCII generatedDatasetSha256 followed by NUL",
                "ASCII split name followed by NUL",
                "sampleCount as unsigned 64-bit big-endian",
                "one decision byte per case",
            ],
            "generatedDatasetSha256": dataset_hash,
            "sampleCount": int(len(held_out_decisions)),
            "sha256": decision_digest,
            "split": split_name,
        },
        "modelVersion": config["modelVersion"],
        "provenance": {
            "generatedDatasetSha256": dataset_hash,
            "seed": config["dataset"]["seed"],
            "trainingConfigSha256": config_hash,
        },
        "schemaVersion": "lattice.agent.float-correspondence.v1",
        "serialization": "UTF-8 sorted-key compact JSON with one trailing LF",
    }


def build_weights_record(
    config: dict[str, Any],
    config_hash: str,
    dataset_hash: str,
    scale: int,
    integers: dict[str, np.ndarray],
) -> dict[str, Any]:
    layouts = {
        "weights1": "input_feature_by_hidden_unit",
        "bias1": "hidden_unit",
        "weights2": "hidden_unit_by_logit_WAIT_EXECUTE",
        "bias2": "logit_WAIT_EXECUTE",
    }
    tensors = {}
    for name, shape in PARAMETER_SHAPES.items():
        tensors[name] = {
            "integers": integers[name].tolist(),
            "layout": layouts[name],
            "shape": list(shape),
        }
    return {
        "architecture": {
            "activation": "ReLU",
            "hiddenUnits": 8,
            "inputFeatures": 6,
            "logits": ["WAIT", "EXECUTE"],
        },
        "modelVersion": config["modelVersion"],
        "provenance": {
            "datasetSha256": dataset_hash,
            "seed": config["dataset"]["seed"],
            "trainingConfigSha256": config_hash,
        },
        "quantization": {
            "dequantization": "float32_value = integer / scale",
            "float32Exact": True,
            "scale": scale,
            "schemeVersion": config["quantization"]["schemeVersion"],
        },
        "schemaVersion": "lattice.agent.quantized-weights.v1",
        "serialization": "UTF-8 sorted-key compact JSON with one trailing LF",
        "tensors": tensors,
    }


def validate_onnx_runtime(
    model_path: Path,
    quantized_parameters: dict[str, np.ndarray],
    test_features: np.ndarray,
    boundary_features: np.ndarray,
) -> dict[str, Any]:
    session = ort.InferenceSession(
        str(model_path), providers=["CPUExecutionProvider"]
    )
    if [item.name for item in session.get_inputs()] != ["context"]:
        raise RuntimeError("ONNX graph has an unexpected input")
    if [item.name for item in session.get_outputs()] != ["decision", "bound_context"]:
        raise RuntimeError("ONNX graph has an unexpected public output")

    comparisons = np.concatenate([test_features, boundary_features], axis=0)
    expected = predict(quantized_parameters, comparisons)
    mismatches = 0
    for index, features in enumerate(comparisons):
        context = np.arange(173, dtype=np.float32)[None, :]
        context[0, :6] = features.astype(np.float32)
        decision, bound_context = session.run(None, {"context": context})
        mismatches += int(bool(decision[0, 0]) != bool(expected[index]))
        if not np.array_equal(bound_context, context):
            raise RuntimeError("bound_context is not an exact runtime Identity")

    model = onnx.load(model_path)
    feature_indices = next(
        initializer
        for initializer in model.graph.initializer
        if initializer.name == "feature_indices"
    )
    indices = onnx.numpy_helper.to_array(feature_indices)
    if not np.array_equal(indices, np.arange(6, dtype=np.int64)):
        raise RuntimeError("ONNX inference Gather reads outside context limbs 0 through 5")
    if any(node.domain not in ("", "ai.onnx") for node in model.graph.node):
        raise RuntimeError("custom ONNX operators are forbidden")
    if [(item.domain, item.version) for item in model.opset_import] != [("", 17)]:
        raise RuntimeError("ONNX graph must pin the default domain to opset 17")

    return {
        "boundContextIdentityCaseCount": len(comparisons),
        "checkerFullCheck": "passed",
        "customOperators": False,
        "decisionComparison": "EXECUTE strictly greater than WAIT",
        "decisionInputLimbs": [0, 1, 2, 3, 4, 5],
        "numpyVersusOnnxDecisionMismatchCount": mismatches,
        "opset": 17,
        "outputNames": ["decision", "bound_context"],
        "runtimeCaseCount": len(comparisons),
    }


def run(config_path: Path, output_dir: Path) -> dict[str, Any]:
    config_content = config_path.read_bytes()
    config = json.loads(config_content)
    validate_config(config)
    configure_torch(config)
    config_hash = sha256_bytes(config_content)

    splits, dataset_hash = generate_splits(config)
    boundary_record, boundary_features, boundary_labels = build_boundary_corpus(config)
    boundary_path = output_dir / "boundary-corpus.json"
    write_bytes(boundary_path, pretty_json_bytes(boundary_record))

    float_parameters, training_diagnostics = train_float_parameters(
        config, splits["train"][0], splits["train"][1]
    )
    float_predictions = {
        split_name: predict(float_parameters, values[0])
        for split_name, values in splits.items()
    }
    float_boundary = predict(float_parameters, boundary_features)
    correspondence_record = build_float_correspondence(
        config,
        config_hash,
        dataset_hash,
        boundary_record,
        boundary_features,
        float_parameters,
        float_predictions["test"],
    )
    correspondence_path = output_dir / "float-correspondence.json"
    write_bytes(correspondence_path, canonical_json_bytes(correspondence_record))

    selected: tuple[int, dict[str, np.ndarray], dict[str, np.ndarray]] | None = None
    scale_trials = []
    for scale in config["quantization"]["candidateDyadicScales"]:
        integers, quantized_parameters = quantize(float_parameters, int(scale))
        disagreement_counts = {
            split_name: int(
                np.count_nonzero(
                    float_predictions[split_name]
                    != predict(quantized_parameters, splits[split_name][0])
                )
            )
            for split_name in ("validation", "test")
        }
        disagreement_counts["boundary"] = int(
            np.count_nonzero(float_boundary != predict(quantized_parameters, boundary_features))
        )
        exact = sum(disagreement_counts.values()) == int(
            config["quantization"]["requiredFloatVersusQuantizedDisagreements"]
        )
        scale_trials.append(
            {
                "disagreementCounts": disagreement_counts,
                "passed": exact,
                "scale": int(scale),
            }
        )
        if exact:
            selected = int(scale), integers, quantized_parameters
            break
    if selected is None:
        raise RuntimeError(
            "no candidate dyadic scale achieved zero float-versus-quantized disagreements"
        )
    selected_scale, selected_integers, quantized_parameters = selected

    weights_record = build_weights_record(
        config, config_hash, dataset_hash, selected_scale, selected_integers
    )
    weights_path = output_dir / "weights.json"
    write_bytes(weights_path, canonical_json_bytes(weights_record))
    weights_hash = sha256(weights_path)

    model_path = output_dir / "network.onnx"
    onnx_summary = export_model(weights_path, model_path)
    loaded_parameters, _ = load_quantized_parameters(weights_path)
    for name in PARAMETER_SHAPES:
        if not np.array_equal(loaded_parameters[name], quantized_parameters[name]):
            raise RuntimeError(f"export reload changed quantized tensor {name}")

    evaluations = {}
    for split_name in ("validation", "test"):
        expected = splits[split_name][2]
        evaluations[split_name] = evaluation_metrics(
            expected,
            float_predictions[split_name],
            predict(quantized_parameters, splits[split_name][0]),
        )
    evaluations["boundary"] = evaluation_metrics(
        boundary_labels,
        float_boundary,
        predict(quantized_parameters, boundary_features),
    )
    total_disagreements = sum(
        result["floatVersusQuantizedDisagreementCount"]
        for result in evaluations.values()
    )
    if total_disagreements != 0:
        raise RuntimeError("selected model did not preserve all evaluated float decisions")

    graph_validation = validate_onnx_runtime(
        model_path,
        quantized_parameters,
        splits["test"][0],
        boundary_features,
    )
    if graph_validation["numpyVersusOnnxDecisionMismatchCount"] != 0:
        raise RuntimeError("ONNX runtime decisions differ from quantized NumPy inference")

    dependencies = {
        "numpy": np.__version__,
        "onnx": onnx.__version__,
        "onnxruntime": ort.__version__,
        "python": platform.python_version(),
        "pytorch": torch.__version__,
    }
    report = {
        "artifactHashes": {
            "boundaryCorpus": sha256(boundary_path),
            "floatCorrespondence": sha256(correspondence_path),
            "floatParametersNotExported": float_parameter_hash(float_parameters),
            "modelOnnx": onnx_summary["sha256"],
            "trainingConfig": config_hash,
            "weights": weights_hash,
        },
        "claim": (
            "Metrics measure synthetic decision consistency only; they do not measure "
            "profitability or validated financial prediction."
        ),
        "dataset": {
            "generatedDatasetSha256": dataset_hash,
            "randomTrainingMarginScoreUnits": config["dataset"][
                "trainingMarginScoreUnits"
            ],
            "savedFullDataset": False,
            "seed": config["dataset"]["seed"],
            "splitClassBalance": {
                name: {
                    "EXECUTE": int(np.count_nonzero(values[2] == EXECUTE)),
                    "WAIT": int(np.count_nonzero(values[2] == WAIT)),
                }
                for name, values in splits.items()
            },
            "splitCounts": {
                name: len(values[0]) for name, values in splits.items()
            },
        },
        "dependencies": dependencies,
        "floatCorrespondence": {
            "boundaryCaseCount": len(correspondence_record["boundaryCases"]),
            "heldOutFloatDecisionSha256": correspondence_record[
                "heldOutFloatDecisions"
            ]["sha256"],
            "path": correspondence_path.name,
            "source": correspondence_record["floatInference"]["source"],
        },
        "evaluations": evaluations,
        "graphValidation": graph_validation,
        "labelRuleId": config["labelRule"]["id"],
        "limitations": [
            "All examples and labels are synthetic; no investor, account, wallet, credential, witness, or production data was used.",
            "Accuracy is agreement with the versioned synthetic rule, not evidence of profitability, market quality, or validated financial prediction.",
            "The four market features are bounded inputs; this training run does not authenticate their eventual source or freshness.",
            "Preference categories are coarse approved inputs, but an externally visible decision or its timing may still reveal information about a category.",
            "No EZKL proving, formal-check update, runtime integration, signer action, hosted model API, or live-chain action was performed in this cloud run.",
            "The committed artifact remains disabled for live trading until local proof, formal, integration, and policy gates are updated and pass.",
        ],
        "modelVersion": config["modelVersion"],
        "quantization": {
            "float32DyadicValuesExact": True,
            "scale": selected_scale,
            "scaleTrials": scale_trials,
            "schemeVersion": config["quantization"]["schemeVersion"],
            "totalFloatVersusQuantizedDisagreementCount": total_disagreements,
        },
        "schemaVersion": "lattice.agent.synthetic-evaluation.v1",
        "training": training_diagnostics,
    }
    report_path = output_dir / "evaluation-report.json"
    write_bytes(report_path, pretty_json_bytes(report))

    manifest = {
        "artifacts": {
            "boundaryCorpus": {
                "path": boundary_path.name,
                "sha256": sha256(boundary_path),
            },
            "floatCorrespondence": {
                "path": correspondence_path.name,
                "sha256": sha256(correspondence_path),
            },
            "evaluationReport": {
                "path": report_path.name,
                "sha256": sha256(report_path),
            },
            "network": {
                "opset": 17,
                "path": model_path.name,
                "sha256": sha256(model_path),
            },
            "trainingConfig": {
                "path": config_path.name,
                "sha256": config_hash,
            },
            "weights": {
                "path": weights_path.name,
                "sha256": weights_hash,
            },
        },
        "claim": report["claim"],
        "cloudTraining": {
            "branch": "cursor/lattice-prime-model-training-3c95",
            "floatReferenceCommit": "e80404c6c9685a12276042ad480ae61ec4d1b832",
            "foundationCommit": "2792b9da7eb930dfa4a9cfb6e2eecd01c5e8a5a5",
            "provider": "Cursor cloud agent",
            "trainingArtifactCommit": "d39cd53da23ae47c435b25592e473491c72cdea5",
        },
        "graph": {
            "activation": "ReLU",
            "allowedOperators": ["Add", "Gather", "Greater", "Identity", "MatMul", "Relu"],
            "contextInputShape": [1, 173],
            "decisionInputLimbs": [0, 1, 2, 3, 4, 5],
            "hiddenUnits": 8,
            "logits": ["WAIT", "EXECUTE"],
            "outputs": ["decision", "bound_context"],
            "parameterVisibility": "fixed",
            "tieRule": "WAIT",
        },
        "liveTradingEnabled": False,
        "modelVersion": config["modelVersion"],
        "quantization": {
            "floatVersusQuantizedDisagreementCount": total_disagreements,
            "scale": selected_scale,
            "schemeVersion": config["quantization"]["schemeVersion"],
        },
        "releaseStatus": "trained-model-candidate-local-verification-required",
        "schemaVersion": "lattice.agent.model-source.v2",
        "training": {
            "dataset": "generated in memory and not committed",
            "dependencies": dependencies,
            "labelRuleId": config["labelRule"]["id"],
            "sampleCount": config["dataset"]["sampleCount"],
            "seed": config["dataset"]["seed"],
        },
    }
    manifest_path = output_dir / "manifest.json"
    write_bytes(manifest_path, pretty_json_bytes(manifest))

    return {
        "artifacts": manifest["artifacts"],
        "evaluations": evaluations,
        "modelVersion": config["modelVersion"],
        "quantizationScale": selected_scale,
        "status": "synthetic decision-consistency training passed",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    model_dir = Path(__file__).resolve().parent
    parser.add_argument("--config", type=Path, default=model_dir / "training_config.json")
    parser.add_argument("--output-dir", type=Path, default=model_dir)
    args = parser.parse_args()
    result = run(args.config.resolve(), args.output_dir.resolve())
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"model training failed: {error}", file=sys.stderr)
        raise
