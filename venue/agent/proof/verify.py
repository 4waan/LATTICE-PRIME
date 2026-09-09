#!/usr/bin/env python3
"""Verify one proof against a pinned local bundle and expected context."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
from pathlib import Path

import ezkl

from run_spike import ExpectedInstancesMismatch, assert_expected_instances, decision_for


class VerificationRefused(ValueError):
    pass


def sha256(path: Path) -> str:
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def require_artifact(bundle: Path, record: dict) -> Path:
    if set(record) != {"file", "sha256"} or not isinstance(record["file"], str):
        raise VerificationRefused("verifier manifest artifact is invalid")
    path = (bundle / record["file"]).resolve()
    if path.parent != bundle.resolve() or sha256(path) != record["sha256"]:
        raise VerificationRefused("verifier artifact identity mismatch")
    return path


def verify_request(bundle: Path, request: dict) -> dict:
    if not isinstance(request, dict) or set(request) != {"proof", "context"}:
        raise VerificationRefused("verification request schema is invalid")
    manifest = json.loads((bundle / "verifier-manifest.json").read_text(encoding="utf-8"))
    if (
        not isinstance(manifest, dict)
        or manifest.get("schemaVersion") != "lattice.agent.verifier-bundle.v1"
        or set(manifest)
        != {"schemaVersion", "modelHash", "compiledCircuit", "settings", "verificationKey", "srs"}
    ):
        raise VerificationRefused("verifier manifest is invalid")
    settings = require_artifact(bundle, manifest["settings"])
    verification_key = require_artifact(bundle, manifest["verificationKey"])
    srs = require_artifact(bundle, manifest["srs"])
    require_artifact(bundle, manifest["compiledCircuit"])

    with tempfile.TemporaryDirectory(prefix="lattice-agent-verify-") as directory:
        proof_path = Path(directory) / "proof.json"
        proof_path.write_text(json.dumps(request["proof"], separators=(",", ":")), encoding="utf-8")
        if not ezkl.verify(str(proof_path), str(settings), str(verification_key), str(srs)):
            raise VerificationRefused("cryptographic proof verification failed")
        try:
            assert_expected_instances(proof_path, settings, request["context"])
        except ExpectedInstancesMismatch as error:
            raise VerificationRefused("proof public instances do not match expected context") from error

    return {
        "verified": True,
        "decision": "EXECUTE" if decision_for(request["context"]) else "WAIT",
        "modelHash": manifest["modelHash"],
        "settingsHash": manifest["settings"]["sha256"],
        "verificationKeyHash": manifest["verificationKey"]["sha256"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", type=Path, required=True)
    args = parser.parse_args()
    try:
        request = json.loads(sys.stdin.buffer.read(1024 * 1024 + 1))
        result = verify_request(args.bundle.resolve(), request)
    except Exception:
        print(json.dumps({"verified": False, "code": "PROOF_REFUSED"}, sort_keys=True))
        raise SystemExit(1)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
