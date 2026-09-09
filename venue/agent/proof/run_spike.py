#!/usr/bin/env python3
"""Build, prove, verify, and negatively test the Phase 1 EZKL spike."""

from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import json
import platform
import resource
import subprocess
import sys
import time
from pathlib import Path

import ezkl
import onnx
from onnx import numpy_helper

from context_codec import encode_context


AGENT_ROOT = Path(__file__).resolve().parents[1]
VENUE_ROOT = Path(__file__).resolve().parents[2]


class ExpectedInstancesMismatch(ValueError):
    pass


def sha256_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def synthetic_context(model_hash: str) -> dict:
    deployment = json.loads((VENUE_ROOT / "deployments/client.json").read_text(encoding="utf-8"))
    return {
        "protocolDomain": sha256_bytes(b"lattice.agent.decision-context.v1").replace("sha256:", "0x"),
        "chainId": str(deployment["network"]["chainId"]),
        "engine": deployment["addresses"]["MatchingEngine"],
        "executionAccount": "0x1000000000000000000000000000000000000001",
        "token": deployment["addresses"]["token"],
        "side": "BUY",
        "price": "2500000",
        "quantity": "2",
        "recoveryAddress": "0x2000000000000000000000000000000000000002",
        "snapshotId": sha256_bytes(b"synthetic-public-snapshot-0").replace("sha256:", "0x"),
        "deploymentHash": sha256_file(VENUE_ROOT / "deployments/client.json").replace("sha256:", "0x"),
        "modelBundleHash": model_hash.replace("sha256:", "0x"),
        "policyHash": sha256_file(AGENT_ROOT / "formal/spec.json").replace("sha256:", "0x"),
        "mandateNonce": "0x" + "11" * 32,
        "decisionSequence": 0,
        "publicSlot": "1788950000",
        "expiresAt": "1788950060",
        "features": {
            "limitRoomBps": 600,
            "recentMoveOffsetBps": 1100,
            "roundProgressBps": 5000,
            "freshnessSeconds": 30,
            "bufferCategory": 1,
            "horizonCategory": 1,
        },
    }


def decision_for(context: dict) -> bool:
    features = context["features"]
    hidden = [
        max(features["limitRoomBps"] - 250, 0),
        max(features["recentMoveOffsetBps"] - 1000, 0),
        max(180 - features["freshnessSeconds"], 0),
        max(features["roundProgressBps"] - 2500, 0),
        max(8000 - features["roundProgressBps"], 0),
        features["bufferCategory"],
        features["horizonCategory"],
        1,
    ]
    scaled_score = (
        128 * hidden[0]
        + 32 * hidden[1]
        + 128 * hidden[2]
        + 2 * hidden[3]
        + hidden[4]
        - 12_800 * hidden[5]
        + 2_560 * hidden[6]
        - 64_000 * hidden[7]
    )
    return scaled_score > 0


def normalize_felt(value: str) -> str:
    return value.lower().removeprefix("0x")


def assert_expected_instances(proof_path: Path, settings_path: Path, context: dict) -> None:
    proof = json.loads(proof_path.read_text(encoding="utf-8"))
    settings = json.loads(settings_path.read_text(encoding="utf-8"))
    actual = [normalize_felt(value) for column in proof["instances"] for value in column]
    scales = settings["model_output_scales"]
    if len(scales) != 2:
        raise ExpectedInstancesMismatch("the circuit does not expose exactly two declared outputs")

    context_limbs = encode_context(context)
    expected = [
        ezkl.float_to_felt(float(decision_for(context)), scales[0], ezkl.PyInputType.Bool),
        *[
            ezkl.float_to_felt(float(limb), scales[1], ezkl.PyInputType.F32)
            for limb in context_limbs
        ],
    ]
    expected = [normalize_felt(value) for value in expected]
    if actual != expected:
        difference = next(
            (index for index, pair in enumerate(zip(actual, expected)) if pair[0] != pair[1]),
            min(len(actual), len(expected)),
        )
        raise ExpectedInstancesMismatch(
            f"public instances differ at index {difference}; got {len(actual)}, expected {len(expected)}"
        )


def timed(label: str, timings: dict, function, *args):
    started = time.perf_counter()
    result = function(*args)
    timings[label] = round(time.perf_counter() - started, 3)
    return result


def get_srs(settings_path: Path, srs_path: Path) -> bool:
    async def download() -> bool:
        return await ezkl.get_srs(str(settings_path), srs_path=str(srs_path))

    return asyncio.run(download())


def verify_returns_false(*args) -> bool:
    try:
        return ezkl.verify(*args) is False
    except Exception:
        return True


def tamper_first_instance(source: Path, target: Path) -> None:
    proof = json.loads(source.read_text(encoding="utf-8"))
    original = proof["instances"][0][0]
    replacement = ("1" if original[0] != "1" else "2") + original[1:]
    proof["instances"][0][0] = replacement
    target.write_text(json.dumps(proof, separators=(",", ":")), encoding="utf-8")


def run(output_dir: Path) -> dict:
    model_dir = output_dir / "model"
    proof_dir = output_dir / "proof"
    model_dir.mkdir(parents=True, exist_ok=True)
    proof_dir.mkdir(parents=True, exist_ok=True)

    subprocess.run(
        [sys.executable, str(AGENT_ROOT / "model/build_model.py"), "--output-dir", str(model_dir)],
        check=True,
        capture_output=True,
        text=True,
    )
    model_path = model_dir / "network.onnx"
    model_hash = sha256_file(model_path)
    graph_check = json.loads(
        subprocess.run(
            [sys.executable, str(AGENT_ROOT / "formal/check_graph.py"), str(model_path)],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    )
    release_check = json.loads(
        subprocess.run(
            [sys.executable, str(AGENT_ROOT / "formal/check_release.py")],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    )
    context = synthetic_context(model_hash)
    context_limbs = encode_context(context)
    expected_decision = decision_for(context)

    input_path = proof_dir / "input.json"
    context_path = proof_dir / "expected-context.json"
    settings_path = proof_dir / "settings.json"
    compiled_path = proof_dir / "network.ezkl"
    srs_path = proof_dir / "kzg.srs"
    vk_path = proof_dir / "vk.key"
    pk_path = proof_dir / "pk.key"
    witness_path = proof_dir / "witness.json"
    proof_path = proof_dir / "proof.json"
    for path in proof_dir.iterdir():
        if path.is_file():
            path.unlink()
    input_path.write_text(json.dumps({"input_data": [context_limbs]}), encoding="utf-8")
    context_path.write_text(json.dumps(context, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    run_args = ezkl.PyRunArgs()
    run_args.input_visibility = "private"
    run_args.output_visibility = "public"
    run_args.param_visibility = "fixed"
    run_args.input_scale = 0
    run_args.param_scale = 8
    run_args.logrows = 14
    run_args.variables = [("batch_size", 1)]

    timings: dict[str, float] = {}
    if not timed("genSettingsSeconds", timings, ezkl.gen_settings, str(model_path), str(settings_path), run_args):
        raise RuntimeError("ezkl.gen_settings returned false")
    if not timed("compileSeconds", timings, ezkl.compile_circuit, str(model_path), str(compiled_path), str(settings_path)):
        raise RuntimeError("ezkl.compile_circuit returned false")
    if not timed("getSrsSeconds", timings, get_srs, settings_path, srs_path):
        raise RuntimeError("ezkl.get_srs returned false")
    if not timed("witnessSeconds", timings, ezkl.gen_witness, str(input_path), str(compiled_path), str(witness_path)):
        raise RuntimeError("ezkl.gen_witness returned false")
    if not timed("setupSeconds", timings, ezkl.setup, str(compiled_path), str(vk_path), str(pk_path), str(srs_path)):
        raise RuntimeError("ezkl.setup returned false")
    if not timed(
        "proveSeconds",
        timings,
        ezkl.prove,
        str(witness_path),
        str(compiled_path),
        str(pk_path),
        str(proof_path),
        str(srs_path),
    ):
        raise RuntimeError("ezkl.prove returned false")
    if not timed(
        "verifySeconds",
        timings,
        ezkl.verify,
        str(proof_path),
        str(settings_path),
        str(vk_path),
        str(srs_path),
    ):
        raise RuntimeError("valid EZKL proof was refused")
    assert_expected_instances(proof_path, settings_path, context)

    tampered_proof = proof_dir / "tampered-output-proof.json"
    tamper_first_instance(proof_path, tampered_proof)
    altered_output_refused = verify_returns_false(
        str(tampered_proof), str(settings_path), str(vk_path), str(srs_path)
    )

    altered_context = copy.deepcopy(context)
    altered_context["quantity"] = "3"
    try:
        assert_expected_instances(proof_path, settings_path, altered_context)
        altered_context_refused = False
    except ExpectedInstancesMismatch:
        altered_context_refused = True

    altered_model = proof_dir / "altered-network.onnx"
    model = onnx.load(model_path)
    altered_weights = next(value for value in model.graph.initializer if value.name == "weights_2")
    altered_array = numpy_helper.to_array(altered_weights).copy()
    altered_array[0, 0] += 1.0
    altered_weights.CopyFrom(numpy_helper.from_array(altered_array, "weights_2"))
    onnx.save_model(model, altered_model)
    altered_model_refused = sha256_file(altered_model) != model_hash

    altered_settings = proof_dir / "altered-settings.json"
    altered_compiled = proof_dir / "altered-network.ezkl"
    altered_vk = proof_dir / "altered-vk.key"
    altered_pk = proof_dir / "altered-pk.key"
    if not ezkl.gen_settings(str(altered_model), str(altered_settings), run_args):
        raise RuntimeError("could not generate altered-circuit settings")
    if not ezkl.compile_circuit(str(altered_model), str(altered_compiled), str(altered_settings)):
        raise RuntimeError("could not compile altered circuit")
    if not timed(
        "alteredCircuitSetupSeconds",
        timings,
        ezkl.setup,
        str(altered_compiled),
        str(altered_vk),
        str(altered_pk),
        str(srs_path),
    ):
        raise RuntimeError("could not set up altered circuit")
    altered_key_refused = verify_returns_false(
        str(proof_path), str(settings_path), str(altered_vk), str(srs_path)
    )

    negative_results = {
        "alteredOutputRefused": altered_output_refused,
        "alteredContextRefused": altered_context_refused,
        "alteredVerificationKeyRefused": altered_key_refused,
        "alteredModelIdentityRefused": altered_model_refused,
    }
    if not all(negative_results.values()):
        raise RuntimeError(f"a negative proof check passed unexpectedly: {negative_results}")

    artifacts = {}
    for path in [model_path, settings_path, compiled_path, srs_path, vk_path, pk_path, proof_path]:
        artifacts[path.name] = {"bytes": path.stat().st_size, "sha256": sha256_file(path)}
    verifier_manifest = {
        "schemaVersion": "lattice.agent.verifier-bundle.v1",
        "modelHash": artifacts["network.onnx"]["sha256"],
        "compiledCircuit": {
            "file": compiled_path.name,
            "sha256": artifacts["network.ezkl"]["sha256"],
        },
        "settings": {
            "file": settings_path.name,
            "sha256": artifacts["settings.json"]["sha256"],
        },
        "verificationKey": {
            "file": vk_path.name,
            "sha256": artifacts["vk.key"]["sha256"],
        },
        "srs": {
            "file": srs_path.name,
            "sha256": artifacts["kzg.srs"]["sha256"],
        },
    }
    verifier_manifest_path = proof_dir / "verifier-manifest.json"
    verifier_manifest_path.write_text(
        json.dumps(verifier_manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    artifacts["verifier-manifest.json"] = {
        "bytes": verifier_manifest_path.stat().st_size,
        "sha256": sha256_file(verifier_manifest_path),
    }

    return {
        "schemaVersion": "lattice.agent.proof-spike-evidence.v1",
        "status": "passed",
        "releaseStatus": "proof-spike-only",
        "versions": {
            "ezkl": ezkl.__version__,
            "onnx": onnx.__version__,
            "python": platform.python_version(),
            "platform": platform.platform(),
            "machine": platform.machine(),
        },
        "settings": {
            "inputVisibility": "private",
            "outputVisibility": "public",
            "parameterVisibility": "fixed",
            "inputScale": 0,
            "parameterScale": 8,
            "contextLimbs": len(context_limbs),
        },
        "decision": "EXECUTE" if expected_decision else "WAIT",
        "formalChecks": {
            "graph": graph_check,
            "release": release_check,
        },
        "timings": timings,
        "processPeakRssRaw": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "processPeakRssPlatformUnits": "bytes on macOS; kibibytes on Linux",
        "negativeResults": negative_results,
        "artifacts": artifacts,
        "limitations": [
            "The graph is a deterministic proof-spike fixture and is not approved for live trading.",
            "The proof binds the supplied context but does not authenticate that market snapshot against Hedera.",
            "The memory figure is a process high-water mark, not isolated per proof stage.",
            "Worker container isolation is not available on this host yet and was not tested.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=AGENT_ROOT / "artifacts")
    args = parser.parse_args()
    evidence_dir = args.output_dir / "evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    evidence_path = evidence_dir / "proof-spike.json"
    try:
        evidence = run(args.output_dir)
    except Exception as error:
        failure = {
            "schemaVersion": "lattice.agent.proof-spike-evidence.v1",
            "status": "failed",
            "errorType": type(error).__name__,
            "error": str(error),
        }
        evidence_path.write_text(json.dumps(failure, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        raise
    evidence_path.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(evidence, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
