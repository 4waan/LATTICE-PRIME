#!/usr/bin/env python3
"""Generate the optional Solidity verifier and calldata for a released proof."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from pathlib import Path

import ezkl


def sha256(path: Path) -> str:
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


async def build(bundle: Path, proof: Path) -> dict:
    verifier = bundle / "Verifier.sol"
    abi = bundle / "Verifier.abi.json"
    calldata = bundle / "evm-calldata.bin"
    await ezkl.create_evm_verifier(
        vk_path=str(bundle / "vk.key"),
        settings_path=str(bundle / "settings.json"),
        sol_code_path=str(verifier),
        abi_path=str(abi),
        srs_path=str(bundle / "kzg.srs"),
        reusable=False,
    )
    source = verifier.read_text(encoding="utf8")
    marker = "        assembly {"
    if source.count(marker) != 1:
        raise RuntimeError("generated verifier has an unexpected assembly shape")
    verifier.write_text(
        source.replace(marker, '        assembly ("memory-safe") {'),
        encoding="utf8",
    )
    ezkl.encode_evm_calldata(proof=str(proof), calldata=str(calldata))
    encoded = calldata.read_bytes()
    if len(encoded) < 4:
        raise RuntimeError("EZKL emitted malformed EVM calldata")
    return {
        "schemaVersion": "lattice.agent.evm-verifier-build.v1",
        "ezklVersion": "23.0.5",
        "verifierSolidityHash": sha256(verifier),
        "verifierAbiHash": sha256(abi),
        "proofHash": sha256(proof),
        "calldataHash": sha256(calldata),
        "calldataBytes": len(encoded),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--proof", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    report = asyncio.run(build(args.bundle.resolve(), args.proof.resolve()))
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(f"{json.dumps(report, indent=2)}\n", encoding="utf8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
