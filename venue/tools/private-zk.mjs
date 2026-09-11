import {
    poseidon1,
    poseidon2,
    poseidon3,
    poseidon4,
    poseidon5,
    poseidon6,
    poseidon7,
    poseidon8,
} from "poseidon-lite";

export const PRIVATE_ZK_FIELD =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const PRIVATE_ZK_MAX_ARTIFACT_BYTES = 160 * 1024 * 1024;

const HASH = /^(?:0x)?[0-9a-fA-F]{64}$/;
const INTEGER = /^(0|[1-9][0-9]*)$/;
const POSEIDON = new Map([
    [1, poseidon1],
    [2, poseidon2],
    [3, poseidon3],
    [4, poseidon4],
    [5, poseidon5],
    [6, poseidon6],
    [7, poseidon7],
    [8, poseidon8],
]);

export class PrivateZkError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "PrivateZkError";
        this.code = code;
    }
}

function fail(code, message) {
    throw new PrivateZkError(code, message);
}

function field(value, label = "private proof input") {
    const text = String(value ?? "");
    if (!INTEGER.test(text)) fail("INPUT_INVALID", `${label} is invalid`);
    const result = BigInt(text);
    if (result >= PRIVATE_ZK_FIELD) fail("INPUT_INVALID", `${label} is invalid`);
    return result;
}

function nonzero(value, label) {
    const result = field(value, label);
    if (result === 0n) fail("INPUT_INVALID", `${label} is invalid`);
    return result;
}

function fieldList(value, length, label) {
    if (!Array.isArray(value) || value.length !== length) {
        fail("INPUT_INVALID", `${label} is invalid`);
    }
    return value.map((item, index) => field(item, `${label}[${index}]`));
}

function bits(value, length, label) {
    const values = fieldList(value, length, label);
    if (values.some((item) => item !== 0n && item !== 1n)) {
        fail("INPUT_INVALID", `${label} is invalid`);
    }
    return values;
}

function poseidon(values) {
    const fn = POSEIDON.get(values.length);
    if (!fn) fail("POSEIDON_INVALID", "unsupported Poseidon input width");
    return BigInt(fn(values.map(BigInt)));
}

function cryptoApi(value = globalThis.crypto) {
    if (!value?.subtle || typeof value.getRandomValues !== "function") {
        fail("CRYPTO_UNAVAILABLE", "browser cryptography is unavailable");
    }
    return value;
}

function artifactDescriptor(value) {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || typeof value.url !== "string"
        || !HASH.test(String(value.sha256 || ""))
        || !Number.isSafeInteger(value.bytes)
        || value.bytes <= 0
        || value.bytes > PRIVATE_ZK_MAX_ARTIFACT_BYTES
    ) {
        fail("ARTIFACT_INVALID", "private proving artifact metadata is invalid");
    }
    let parsed;
    try {
        parsed = new URL(value.url, globalThis.location?.origin);
    } catch {
        fail("ARTIFACT_INVALID", "private proving artifact URL is invalid");
    }
    const localHttp = parsed.protocol === "http:"
        && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !localHttp) {
        fail("ARTIFACT_INVALID", "private proving artifacts require HTTPS");
    }
    return {
        url: parsed.href,
        sha256: String(value.sha256).toLowerCase().replace(/^0x/, ""),
        bytes: value.bytes,
    };
}

function equalHex(left, right) {
    if (left.length !== right.length) return false;
    let different = 0;
    for (let index = 0; index < left.length; index += 1) {
        different |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return different === 0;
}

async function boundedBody(response, expectedBytes) {
    if (!response?.ok) fail("ARTIFACT_UNAVAILABLE", "private proving artifact is unavailable");
    const declared = response.headers?.get?.("content-length");
    if (declared !== null && declared !== undefined && Number(declared) !== expectedBytes) {
        fail("ARTIFACT_SIZE", "private proving artifact size is invalid");
    }
    if (!response.body?.getReader) {
        const result = new Uint8Array(await response.arrayBuffer());
        if (result.length !== expectedBytes) {
            fail("ARTIFACT_SIZE", "private proving artifact size is invalid");
        }
        return result;
    }
    const output = new Uint8Array(expectedBytes);
    const reader = response.body.getReader();
    let offset = 0;
    try {
        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            if (!(value instanceof Uint8Array) || offset + value.length > expectedBytes) {
                fail("ARTIFACT_SIZE", "private proving artifact size is invalid");
            }
            output.set(value, offset);
            offset += value.length;
        }
    } finally {
        reader.releaseLock?.();
    }
    if (offset !== expectedBytes) {
        fail("ARTIFACT_SIZE", "private proving artifact size is invalid");
    }
    return output;
}

export async function fetchVerifiedPrivateArtifact(
    descriptor,
    {
        fetchImpl = globalThis.fetch,
        crypto: cryptoImpl = globalThis.crypto,
    } = {},
) {
    const expected = artifactDescriptor(descriptor);
    if (typeof fetchImpl !== "function") {
        fail("ARTIFACT_UNAVAILABLE", "private proving artifact fetch is unavailable");
    }
    let response;
    try {
        response = await fetchImpl(expected.url, {
            method: "GET",
            cache: "force-cache",
            credentials: "omit",
            redirect: "error",
            referrerPolicy: "no-referrer",
            headers: {Accept: "application/octet-stream"},
        });
    } catch {
        fail("ARTIFACT_UNAVAILABLE", "private proving artifact is unavailable");
    }
    const data = await boundedBody(response, expected.bytes);
    const digest = new Uint8Array(
        await cryptoApi(cryptoImpl).subtle.digest("SHA-256", data),
    );
    const actual = [...digest].map((item) => item.toString(16).padStart(2, "0")).join("");
    if (!equalHex(actual, expected.sha256)) {
        data.fill(0);
        fail("ARTIFACT_DIGEST", "private proving artifact digest is invalid");
    }
    return data;
}

export function randomPrivateField(
    cryptoImpl = globalThis.crypto,
    bytes = 30,
) {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 31) {
        fail("RANDOM_INVALID", "private field randomness size is invalid");
    }
    const value = cryptoApi(cryptoImpl).getRandomValues(new Uint8Array(bytes));
    let result = 0n;
    for (const item of value) result = (result << 8n) | BigInt(item);
    value.fill(0);
    result %= PRIVATE_ZK_FIELD;
    return result === 0n ? 1n : result;
}

export function privateHolderCommitment(holderSecret) {
    return poseidon([nonzero(holderSecret, "holder secret")]);
}

export function privateSessionLeaf(credential) {
    return poseidon([
        field(credential.credentialId, "credential id"),
        privateHolderCommitment(credential.holderSecret),
        field(credential.jurisdiction, "jurisdiction"),
        field(credential.tier, "tier"),
        field(credential.validUntilEpoch, "valid-until epoch"),
    ]);
}

export function privateRouterNoteCommitment(note, context) {
    return poseidon([
        nonzero(note.noteSecret, "note secret"),
        nonzero(note.noteNullifier, "note nullifier"),
        field(note.fundingTag, "funding tag"),
        field(context.chainId, "chain id"),
        field(context.pool, "pool"),
        field(context.asset, "asset"),
        nonzero(context.denomination, "denomination"),
    ]);
}

export function reconstructPrivateMerkleRoot(leaf, pathElements, pathIndices) {
    const elements = fieldList(pathElements, pathIndices.length, "Merkle path");
    const indices = bits(pathIndices, pathIndices.length, "Merkle path directions");
    let current = field(leaf, "Merkle leaf");
    for (let level = 0; level < elements.length; level += 1) {
        current = indices[level] === 0n
            ? poseidon([current, elements[level]])
            : poseidon([elements[level], current]);
    }
    return current;
}

export function buildPrivateMerklePath(leaves, leafIndex, depth) {
    if (
        !Array.isArray(leaves)
        || !Number.isSafeInteger(leafIndex)
        || !Number.isSafeInteger(depth)
        || depth < 1
        || depth > 24
        || leafIndex < 0
        || leafIndex >= 2 ** depth
    ) {
        fail("MERKLE_INPUT_INVALID", "private Merkle tree input is invalid");
    }
    const zero = [0n];
    for (let level = 0; level < depth; level += 1) {
        zero.push(poseidon([zero[level], zero[level]]));
    }
    const levels = [new Map()];
    leaves.forEach((leaf, index) => {
        if (leaf !== null && leaf !== undefined) {
            levels[0].set(index, field(leaf, `Merkle leaf ${index}`));
        }
    });
    const elements = [];
    const indices = [];
    let cursor = leafIndex;
    for (let level = 0; level < depth; level += 1) {
        indices.push(BigInt(cursor & 1));
        elements.push(levels[level].get(cursor ^ 1) ?? zero[level]);
        const parents = new Map();
        for (const index of levels[level].keys()) {
            const parent = index >> 1;
            if (parents.has(parent)) continue;
            parents.set(parent, poseidon([
                levels[level].get(parent * 2) ?? zero[level],
                levels[level].get(parent * 2 + 1) ?? zero[level],
            ]));
        }
        levels.push(parents);
        cursor >>= 1;
    }
    return {
        root: levels[depth].get(0) ?? zero[depth],
        elements,
        indices,
    };
}

export function issuePrivateSessionCredentials(holders, depth = 16) {
    if (!Array.isArray(holders) || holders.length === 0) {
        fail("MERKLE_INPUT_INVALID", "private session holders are required");
    }
    const issuedAt = new Date().toISOString();
    const prepared = holders.map((holder, index) => ({
        wallet: holder.wallet ? String(holder.wallet).toLowerCase() : "",
        holderSecret: nonzero(holder.holderSecret, `holder ${index} secret`),
        credentialId: field(holder.credentialId ?? index + 1, `holder ${index} id`),
        jurisdiction: field(holder.jurisdiction ?? 3, `holder ${index} jurisdiction`),
        tier: field(holder.tier ?? 4, `holder ${index} tier`),
        validUntilEpoch: field(
            holder.validUntilEpoch ?? 50,
            `holder ${index} valid-until`,
        ),
    }));
    const leaves = prepared.map((holder) => privateSessionLeaf(holder));
    const credentials = prepared.map((holder, index) => {
        const path = buildPrivateMerklePath(leaves, index, depth);
        return {
            v: 1,
            wallet: holder.wallet || undefined,
            holderSecret: holder.holderSecret.toString(),
            credentialId: holder.credentialId.toString(),
            jurisdiction: holder.jurisdiction.toString(),
            tier: holder.tier.toString(),
            validUntilEpoch: holder.validUntilEpoch.toString(),
            holderSecretCommitment: privateHolderCommitment(holder.holderSecret).toString(),
            credentialRoot: path.root.toString(),
            pathElements: path.elements.map((item) => item.toString()),
            pathIndices: path.indices.map((item) => item.toString()),
            issuedAt,
        };
    });
    return {
        depth,
        root: credentials[0].credentialRoot,
        credentials,
    };
}

function proofContext(context) {
    return {
        credentialRoot: field(context.credentialRoot, "credential root").toString(),
        rotationEpoch: field(context.rotationEpoch, "rotation epoch").toString(),
        sessionAccount: field(context.sessionAccount, "session account").toString(),
        sessionSigner: field(context.sessionSigner, "session signer").toString(),
        factory: field(context.factory, "factory").toString(),
        implementationCodeHashLow:
            field(context.implementationCodeHashLow, "implementation code hash").toString(),
        implementationCodeHashHigh:
            field(context.implementationCodeHashHigh, "implementation code hash").toString(),
        minTier: field(context.minTier, "minimum tier").toString(),
        jurisdictionMask: field(context.jurisdictionMask, "jurisdiction mask").toString(),
    };
}

function assertSignals(signals, expected, indices) {
    for (const [index, value] of indices) {
        if (BigInt(signals[index]) !== BigInt(expected[value])) {
            fail("PROOF_CONTEXT_MISMATCH", "private proof output does not match its context");
        }
    }
}

async function provePlonk(input, artifacts, plonk, options) {
    if (
        typeof plonk?.fullProve !== "function"
        || typeof plonk?.verify !== "function"
        || typeof plonk?.exportSolidityCallData !== "function"
    ) {
        fail("PROVER_UNAVAILABLE", "private PLONK prover is unavailable");
    }
    const wasm = await fetchVerifiedPrivateArtifact(artifacts?.wasm, options);
    const zkey = await fetchVerifiedPrivateArtifact(artifacts?.zkey, options);
    let result;
    try {
        result = await plonk.fullProve(input, wasm, zkey);
    } catch {
        fail("PROOF_FAILED", "private proof generation failed");
    }
    let verified = false;
    try {
        verified = await plonk.verify(
            artifacts.verificationKey,
            result.publicSignals,
            result.proof,
        );
    } catch {
        verified = false;
    }
    if (!verified) fail("PROOF_VERIFY_FAILED", "private proof failed local verification");
    let calldata;
    try {
        const serialized = await plonk.exportSolidityCallData(
            result.proof,
            result.publicSignals,
        );
        calldata = JSON.parse(`[${serialized.trim().replace("][", "],[")}]`);
    } catch {
        fail("PROOF_ENCODING_FAILED", "private proof encoding failed");
    }
    if (
        !Array.isArray(calldata)
        || !Array.isArray(calldata[0])
        || !Array.isArray(calldata[1])
    ) {
        fail("PROOF_ENCODING_FAILED", "private proof encoding failed");
    }
    return {
        proof: calldata[0].map(String),
        publicSignals: calldata[1].map(String),
    };
}

export async function createPrivateSessionProofs({
    credential,
    context,
    viewKey,
    artifacts,
    plonk,
    crypto: cryptoImpl = globalThis.crypto,
    fetchImpl = globalThis.fetch,
}) {
    const pathElements = fieldList(credential.pathElements, 16, "credential path");
    const pathIndices = bits(credential.pathIndices, 16, "credential path directions");
    const root = reconstructPrivateMerkleRoot(
        privateSessionLeaf(credential),
        pathElements,
        pathIndices,
    );
    if (root !== field(context.credentialRoot, "credential root")) {
        fail("CREDENTIAL_ROOT_MISMATCH", "private credential does not match the current root");
    }
    const nonce = randomPrivateField(cryptoImpl);
    const shared = proofContext(context);
    const eligibility = await provePlonk({
        holderSecret: nonzero(credential.holderSecret, "holder secret").toString(),
        credentialId: field(credential.credentialId, "credential id").toString(),
        jurisdiction: field(credential.jurisdiction, "jurisdiction").toString(),
        tier: field(credential.tier, "tier").toString(),
        validUntilEpoch: field(
            credential.validUntilEpoch,
            "valid-until epoch",
        ).toString(),
        pathElements: pathElements.map(String),
        pathIndices: pathIndices.map(String),
        complianceNonce: nonce.toString(),
        ...shared,
    }, artifacts?.eligibility, plonk, {crypto: cryptoImpl, fetchImpl});
    if (eligibility.publicSignals.length !== 12 || eligibility.publicSignals[1] !== "1") {
        fail("PROOF_POLICY_FAILED", "private credential does not satisfy current policy");
    }
    assertSignals(eligibility.publicSignals, shared, [
        [3, "credentialRoot"],
        [4, "rotationEpoch"],
        [5, "sessionAccount"],
        [6, "sessionSigner"],
        [7, "factory"],
        [8, "implementationCodeHashLow"],
        [9, "implementationCodeHashHigh"],
        [10, "minTier"],
        [11, "jurisdictionMask"],
    ]);

    const encryptionRandomness = randomPrivateField(cryptoImpl);
    const compliance = await provePlonk({
        holderSecret: nonzero(credential.holderSecret, "holder secret").toString(),
        credentialId: field(credential.credentialId, "credential id").toString(),
        complianceNonce: nonce.toString(),
        encryptionRandomness: encryptionRandomness.toString(),
        complianceBridge: eligibility.publicSignals[2],
        ...shared,
        viewKeyEpoch: field(viewKey.epoch, "view key epoch").toString(),
        viewPublicKeyX: field(viewKey.x, "view key").toString(),
        viewPublicKeyY: field(viewKey.y, "view key").toString(),
    }, artifacts?.compliance, plonk, {crypto: cryptoImpl, fetchImpl});
    if (compliance.publicSignals.length !== 17) {
        fail("PROOF_OUTPUT_INVALID", "private compliance proof output is invalid");
    }
    if (compliance.publicSignals[4] !== eligibility.publicSignals[2]) {
        fail("PROOF_CONTEXT_MISMATCH", "private split proofs do not match");
    }
    assertSignals(compliance.publicSignals, {
        ...shared,
        viewKeyEpoch: field(viewKey.epoch).toString(),
        viewPublicKeyX: field(viewKey.x).toString(),
        viewPublicKeyY: field(viewKey.y).toString(),
    }, [
        [5, "credentialRoot"],
        [6, "rotationEpoch"],
        [7, "sessionAccount"],
        [8, "sessionSigner"],
        [9, "factory"],
        [10, "implementationCodeHashLow"],
        [11, "implementationCodeHashHigh"],
        [12, "minTier"],
        [13, "jurisdictionMask"],
        [14, "viewKeyEpoch"],
        [15, "viewPublicKeyX"],
        [16, "viewPublicKeyY"],
    ]);
    return {
        eligibility,
        compliance,
        sessionSlot: eligibility.publicSignals[0],
        ciphertext: {
            encryptedCredential: compliance.publicSignals[0],
            tag: compliance.publicSignals[1],
            ephemeralX: compliance.publicSignals[2],
            ephemeralY: compliance.publicSignals[3],
        },
    };
}

export async function createPrivateRoutingProofs({
    note,
    path,
    context,
    viewKey,
    artifacts,
    plonk,
    crypto: cryptoImpl = globalThis.crypto,
    fetchImpl = globalThis.fetch,
}) {
    const elements = fieldList(path.elements, 20, "routing path");
    const indices = bits(path.indices, 20, "routing path directions");
    const root = reconstructPrivateMerkleRoot(
        privateRouterNoteCommitment(note, context),
        elements,
        indices,
    );
    if (root !== field(context.root, "routing root")) {
        fail("ROUTING_ROOT_MISMATCH", "private routing note does not match the selected root");
    }
    const nonce = randomPrivateField(cryptoImpl);
    const shared = {
        root: root.toString(),
        recipient: field(context.recipient, "routing recipient").toString(),
        pool: field(context.pool, "routing pool").toString(),
        asset: field(context.asset, "routing asset").toString(),
        denomination: nonzero(context.denomination, "routing denomination").toString(),
        chainId: field(context.chainId, "chain id").toString(),
    };
    const noteInputs = {
        noteSecret: nonzero(note.noteSecret, "note secret").toString(),
        noteNullifier: nonzero(note.noteNullifier, "note nullifier").toString(),
        fundingTag: field(note.fundingTag, "funding tag").toString(),
        complianceNonce: nonce.toString(),
    };
    const withdrawal = await provePlonk({
        ...noteInputs,
        pathElements: elements.map(String),
        pathIndices: indices.map(String),
        ...shared,
    }, artifacts?.withdrawal, plonk, {crypto: cryptoImpl, fetchImpl});
    if (withdrawal.publicSignals.length !== 8) {
        fail("PROOF_OUTPUT_INVALID", "private routing proof output is invalid");
    }
    assertSignals(withdrawal.publicSignals, shared, [
        [2, "root"],
        [3, "recipient"],
        [4, "pool"],
        [5, "asset"],
        [6, "denomination"],
        [7, "chainId"],
    ]);
    const compliance = await provePlonk({
        ...noteInputs,
        encryptionRandomness: randomPrivateField(cryptoImpl).toString(),
        complianceBridge: withdrawal.publicSignals[1],
        ...shared,
        viewKeyEpoch: field(viewKey.epoch, "view key epoch").toString(),
        viewPublicKeyX: field(viewKey.x, "view key").toString(),
        viewPublicKeyY: field(viewKey.y, "view key").toString(),
    }, artifacts?.compliance, plonk, {crypto: cryptoImpl, fetchImpl});
    if (
        compliance.publicSignals.length !== 14
        || compliance.publicSignals[4] !== withdrawal.publicSignals[1]
    ) {
        fail("PROOF_CONTEXT_MISMATCH", "private routing split proofs do not match");
    }
    return {
        withdrawal,
        compliance,
        nullifier: withdrawal.publicSignals[0],
        ciphertext: {
            encryptedCommitment: compliance.publicSignals[0],
            tag: compliance.publicSignals[1],
            ephemeralX: compliance.publicSignals[2],
            ephemeralY: compliance.publicSignals[3],
        },
    };
}
