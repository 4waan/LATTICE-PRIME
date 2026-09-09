#!/usr/bin/env python3
"""Build the deterministic ONNX graph from the committed quantized weights."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from export import export_model


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=Path("agent/artifacts/model"))
    parser.add_argument(
        "--weights",
        type=Path,
        default=Path(__file__).resolve().parent / "weights.json",
    )
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    model_path = args.output_dir / "network.onnx"
    onnx_record = export_model(args.weights.resolve(), model_path)
    weights = json.loads(args.weights.read_text(encoding="utf-8"))
    record = {
        "schemaVersion": "lattice.agent.generated-model.v1",
        "modelVersion": weights["modelVersion"],
        "purpose": "trained synthetic decision-consistency candidate; local verification required",
        "onnx": {"path": model_path.name, **onnx_record},
        "architecture": {
            "features": 6,
            "hiddenUnits": 8,
            "activation": "ReLU",
            "logits": ["WAIT", "EXECUTE"],
            "tieRule": "WAIT",
            "parameters": "fixed in the ONNX graph",
        },
        "quantization": weights["quantization"],
    }
    (args.output_dir / "manifest.json").write_text(
        json.dumps(record, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(record, sort_keys=True))


if __name__ == "__main__":
    main()
