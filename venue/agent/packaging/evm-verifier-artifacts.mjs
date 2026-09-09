import {createHash} from "node:crypto";

export class EvmArtifactError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "EvmArtifactError";
        this.code = code;
    }
}

function sha256(bytes) {
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function verifyEvmBuildArtifacts({
    abiBytes,
    verifierBytes,
    proofBytes,
    calldataBytes,
    build,
}) {
    const hashes = {
        verifierSolidityHash: sha256(verifierBytes),
        verifierAbiHash: sha256(abiBytes),
        proofHash: sha256(proofBytes),
        calldataHash: sha256(calldataBytes),
        calldataBytes: calldataBytes.length,
    };
    for (const [field, actual] of Object.entries(hashes)) {
        if (build?.[field] !== actual) {
            throw new EvmArtifactError(
                "EVM_ARTIFACT_MISMATCH",
                `${field} differs from the fresh verifier build report`
            );
        }
    }
    return hashes;
}
