import assert from "node:assert/strict";
import {createHash, webcrypto} from "node:crypto";
import test from "node:test";

import {
    PrivateZkError,
    buildPrivateMerklePath,
    createPrivateSessionProofs,
    fetchVerifiedPrivateArtifact,
    issuePrivateSessionCredentials,
    privateSessionLeaf,
    reconstructPrivateMerkleRoot,
} from "./private-zk.mjs";

function descriptor(bytes, overrides = {}) {
    return {
        url: "https://artifacts.example/prover.bin",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ...overrides,
    };
}

function response(bytes, declared = bytes.length) {
    return {
        ok: true,
        headers: {get: (name) => name === "content-length" ? String(declared) : null},
        body: null,
        arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
}

test("private proving artifacts require exact HTTPS bytes and digest", async () => {
    const bytes = Uint8Array.of(1, 2, 3, 4);
    const calls = [];
    const loaded = await fetchVerifiedPrivateArtifact(descriptor(bytes), {
        crypto: webcrypto,
        fetchImpl: async (url, options) => {
            calls.push({url, options});
            return response(bytes);
        },
    });
    assert.deepEqual(loaded, bytes);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.credentials, "omit");
    assert.equal(calls[0].options.redirect, "error");

    await assert.rejects(
        fetchVerifiedPrivateArtifact(
            descriptor(bytes, {sha256: "00".repeat(32)}),
            {crypto: webcrypto, fetchImpl: async () => response(bytes)},
        ),
        {code: "ARTIFACT_DIGEST"},
    );
    await assert.rejects(
        fetchVerifiedPrivateArtifact(
            descriptor(bytes, {url: "http://artifacts.example/prover.bin"}),
            {crypto: webcrypto, fetchImpl: async () => response(bytes)},
        ),
        {code: "ARTIFACT_INVALID"},
    );
    await assert.rejects(
        fetchVerifiedPrivateArtifact(
            descriptor(bytes),
            {crypto: webcrypto, fetchImpl: async () => response(bytes, bytes.length + 1)},
        ),
        {code: "ARTIFACT_SIZE"},
    );
});

test("independent sparse-tree construction reconstructs the selected path", () => {
    const leaves = [11n, 22n, 33n, 44n, 55n];
    for (let index = 0; index < leaves.length; index += 1) {
        const path = buildPrivateMerklePath(leaves, index, 6);
        assert.equal(
            reconstructPrivateMerkleRoot(
                leaves[index],
                path.elements,
                path.indices,
            ),
            path.root,
        );
    }
});

test("issued session credentials reconstruct a shared published root", () => {
    const tree = issuePrivateSessionCredentials([
        {wallet: "0xCFc5923dEf1F25db05FE50754Ef0822175AFD449", holderSecret: 11n},
        {wallet: "0x1111111111111111111111111111111111111111", holderSecret: 22n},
    ], 16);
    assert.equal(tree.credentials.length, 2);
    assert.equal(tree.credentials[0].credentialRoot, tree.credentials[1].credentialRoot);
    for (const credential of tree.credentials) {
        assert.equal(
            reconstructPrivateMerkleRoot(
                privateSessionLeaf(credential),
                credential.pathElements,
                credential.pathIndices,
            ).toString(),
            tree.root,
        );
    }
});

function fakeArtifacts(bytes) {
    const item = {
        wasm: descriptor(bytes),
        zkey: descriptor(bytes),
        verificationKey: {},
    };
    return {
        eligibility: item,
        compliance: item,
    };
}

// snarkjs 0.7.6 exports calldata as two JSON arrays of quoted 0x-prefixed
// 32-byte words with no separator between them. The decimal form is kept as an
// option so both encodings stay covered.
function calldataWord(value, encoding) {
    if (encoding === "decimal") return String(value);
    return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function fakePlonk(encoding = "hex") {
    const proofWords = Array.from({length: 24}, (_, index) => String(index + 1));
    return {
        async fullProve(input, wasm, zkey, logger, witnessOptions, proverOptions) {
            assert.equal(wasm instanceof Uint8Array, true);
            assert.equal(zkey instanceof Uint8Array, true);
            assert.equal(logger, undefined);
            assert.equal(witnessOptions, undefined);
            assert.deepEqual(proverOptions, {singleThread: true});
            if (input.validUntilEpoch !== undefined) {
                return {
                    proof: {kind: "eligibility"},
                    publicSignals: [
                        "901",
                        "1",
                        "902",
                        input.credentialRoot,
                        input.rotationEpoch,
                        input.sessionAccount,
                        input.sessionSigner,
                        input.factory,
                        input.implementationCodeHashLow,
                        input.implementationCodeHashHigh,
                        input.minTier,
                        input.jurisdictionMask,
                    ],
                };
            }
            return {
                proof: {kind: "compliance"},
                publicSignals: [
                    "801",
                    "802",
                    "803",
                    "804",
                    input.complianceBridge,
                    input.credentialRoot,
                    input.rotationEpoch,
                    input.sessionAccount,
                    input.sessionSigner,
                    input.factory,
                    input.implementationCodeHashLow,
                    input.implementationCodeHashHigh,
                    input.minTier,
                    input.jurisdictionMask,
                    input.viewKeyEpoch,
                    input.viewPublicKeyX,
                    input.viewPublicKeyY,
                ],
            };
        },
        async verify() {
            return true;
        },
        async exportSolidityCallData(proof, publicSignals) {
            assert.ok(["eligibility", "compliance"].includes(proof.kind));
            const words = proofWords.map((word) => calldataWord(word, encoding));
            const signals = publicSignals.map((word) => calldataWord(word, encoding));
            return `${JSON.stringify(words)}${JSON.stringify(signals)}`;
        },
    };
}

test("session proof orchestration keeps holder data local and pins every output", async () => {
    const credential = {
        holderSecret: "123456789",
        credentialId: "73",
        jurisdiction: "3",
        tier: "4",
        validUntilEpoch: "50",
        pathElements: Array(16).fill("0"),
        pathIndices: Array(16).fill("0"),
    };
    const root = reconstructPrivateMerkleRoot(
        privateSessionLeaf(credential),
        credential.pathElements,
        credential.pathIndices,
    );
    const context = {
        credentialRoot: root.toString(),
        rotationEpoch: "7",
        sessionAccount: BigInt("0x1111111111111111111111111111111111111111").toString(),
        sessionSigner: BigInt("0x2222222222222222222222222222222222222222").toString(),
        factory: BigInt("0x3333333333333333333333333333333333333333").toString(),
        implementationCodeHashLow: "44",
        implementationCodeHashHigh: "55",
        minTier: "3",
        jurisdictionMask: "255",
    };
    const artifactBytes = Uint8Array.of(9, 8, 7);
    const result = await createPrivateSessionProofs({
        credential,
        context,
        viewKey: {epoch: "4", x: "333", y: "444"},
        artifacts: fakeArtifacts(artifactBytes),
        plonk: fakePlonk(),
        crypto: webcrypto,
        fetchImpl: async () => response(artifactBytes),
    });
    assert.equal(result.sessionSlot, "901");
    assert.equal(result.eligibility.proof.length, 24);
    assert.equal(result.compliance.publicSignals.length, 17);
    assert.deepEqual(result.ciphertext, {
        encryptedCredential: "801",
        tag: "802",
        ephemeralX: "803",
        ephemeralY: "804",
    });
    // Calldata words come back as decimal strings whatever snarkjs emitted.
    const decimal = /^[0-9]+$/;
    for (const proofSet of [result.eligibility, result.compliance]) {
        assert.deepEqual(proofSet.proof, Array.from({length: 24}, (_, index) => String(index + 1)));
        assert.ok(proofSet.publicSignals.every((word) => decimal.test(word)));
    }
    assert.equal(result.eligibility.publicSignals[1], "1");
    assert.equal(result.eligibility.publicSignals[7], context.factory);
    assert.equal(result.compliance.publicSignals[5], context.credentialRoot);

    const decimalResult = await createPrivateSessionProofs({
        credential,
        context,
        viewKey: {epoch: "4", x: "333", y: "444"},
        artifacts: fakeArtifacts(artifactBytes),
        plonk: fakePlonk("decimal"),
        crypto: webcrypto,
        fetchImpl: async () => response(artifactBytes),
    });
    assert.deepEqual(decimalResult.eligibility.publicSignals, result.eligibility.publicSignals);
    assert.deepEqual(decimalResult.compliance.proof, result.compliance.proof);

    let error;
    try {
        await createPrivateSessionProofs({
            credential: {...credential, holderSecret: "987654321"},
            context,
            viewKey: {epoch: "4", x: "333", y: "444"},
            artifacts: fakeArtifacts(artifactBytes),
            plonk: fakePlonk(),
            crypto: webcrypto,
            fetchImpl: async () => response(artifactBytes),
        });
    } catch (caught) {
        error = caught;
    }
    assert.ok(error instanceof PrivateZkError);
    assert.equal(`${error.code}:${error.message}`.includes("987654321"), false);
});
