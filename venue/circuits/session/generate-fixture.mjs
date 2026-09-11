import {execFileSync} from "node:child_process";
import {randomBytes} from "node:crypto";
import {
    mkdtempSync,
    mkdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildBabyjub, buildPoseidon} from "circomlibjs";
import {keccak256, toUtf8Bytes} from "ethers";

const SNARK = "../toolchain/node_modules/.bin/snarkjs";
const DEPTH = 16;
const FIELD =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const holderSecret = process.env.SESSION_FIXTURE_HOLDER_SECRET
    ? BigInt(process.env.SESSION_FIXTURE_HOLDER_SECRET)
    : BigInt(`0x${randomBytes(31).toString("hex")}`) % FIELD;
if (holderSecret === 0n) throw new Error("holder secret must be nonzero");

const credential = {
    credentialId: 73n,
    jurisdiction: 3n,
    tier: 4n,
    validUntilEpoch: 50n,
};
const rotationEpoch = 7n;
const sessionAccount = BigInt("0x1111111111111111111111111111111111111111");
const sessionSigner = BigInt("0x2222222222222222222222222222222222222222");
const factory = BigInt("0x3333333333333333333333333333333333333333");
const minTier = 3n;
const jurisdictionMask = 0xffn;
const viewKeyEpoch = 4n;
const viewSecret = 9876543210123456789n;
const complianceNonce = BigInt(`0x${randomBytes(30).toString("hex")}`);
const encryptionRandomness = BigInt(`0x${randomBytes(30).toString("hex")}`);

const implementationCodeHash = BigInt(
    keccak256(toUtf8Bytes("session-account-fixture-implementation-v1")),
);
const implementationCodeHashLow = implementationCodeHash & ((1n << 128n) - 1n);
const implementationCodeHashHigh = implementationCodeHash >> 128n;

const poseidon = await buildPoseidon();
const poseidonField = poseidon.F;
const hash = (values) => poseidonField.toObject(poseidon(values));

const holderSecretCommitment = hash([holderSecret]);
const leaf = hash([
    credential.credentialId,
    holderSecretCommitment,
    credential.jurisdiction,
    credential.tier,
    credential.validUntilEpoch,
]);

const zeroAtLevel = [0n];
for (let level = 0; level < DEPTH; level++) {
    zeroAtLevel.push(hash([zeroAtLevel[level], zeroAtLevel[level]]));
}
const pathElements = [];
const pathIndices = [];
let credentialRoot = leaf;
for (let level = 0; level < DEPTH; level++) {
    pathElements.push(zeroAtLevel[level]);
    pathIndices.push(0n);
    credentialRoot = hash([credentialRoot, zeroAtLevel[level]]);
}

const babyjub = await buildBabyjub();
const viewPoint = babyjub.mulPointEscalar(babyjub.Base8, viewSecret);
const viewPublicKeyX = babyjub.F.toObject(viewPoint[0]);
const viewPublicKeyY = babyjub.F.toObject(viewPoint[1]);

const sharedPublic = {
    credentialRoot: credentialRoot.toString(),
    rotationEpoch: rotationEpoch.toString(),
    sessionAccount: sessionAccount.toString(),
    sessionSigner: sessionSigner.toString(),
    factory: factory.toString(),
    implementationCodeHashLow: implementationCodeHashLow.toString(),
    implementationCodeHashHigh: implementationCodeHashHigh.toString(),
    minTier: minTier.toString(),
    jurisdictionMask: jurisdictionMask.toString(),
};

const eligibilityInput = {
    holderSecret: holderSecret.toString(),
    credentialId: credential.credentialId.toString(),
    jurisdiction: credential.jurisdiction.toString(),
    tier: credential.tier.toString(),
    validUntilEpoch: credential.validUntilEpoch.toString(),
    pathElements: pathElements.map(String),
    pathIndices: pathIndices.map(String),
    complianceNonce: complianceNonce.toString(),
    ...sharedPublic,
};

const work = mkdtempSync(join(tmpdir(), "hedera-session-proof-"));

function prove(name, input, wasm, zkey) {
    const inputPath = join(work, `${name}-input.json`);
    const witnessPath = join(work, `${name}.wtns`);
    const proofPath = join(work, `${name}-proof.json`);
    const publicPath = join(work, `${name}-public.json`);
    writeFileSync(inputPath, JSON.stringify(input));
    execFileSync(
        SNARK,
        [
            "wtns",
            "calculate",
            `circuits/session/${wasm}_js/${wasm}.wasm`,
            inputPath,
            witnessPath,
        ],
        {stdio: "inherit"},
    );
    execFileSync(
        SNARK,
        [
            "plonk",
            "prove",
            `circuits/session/${zkey}.zkey`,
            witnessPath,
            proofPath,
            publicPath,
        ],
        {stdio: "inherit"},
    );
    execFileSync(
        SNARK,
        [
            "plonk",
            "verify",
            `circuits/session/${zkey}_vkey.json`,
            publicPath,
            proofPath,
        ],
        {stdio: "inherit"},
    );
    const calldata = execFileSync(
        SNARK,
        ["zkey", "export", "soliditycalldata", publicPath, proofPath],
        {encoding: "utf8"},
    );
    const [proof, publicSignals] = JSON.parse(
        `[${calldata.trim().replace("][", "],[")}]`,
    );
    return {proof, publicSignals};
}

function requireWrongPreimageFailure() {
    const inputPath = join(work, "wrong-holder-preimage-input.json");
    const witnessPath = join(work, "wrong-holder-preimage.wtns");
    const wrongSecret = holderSecret + 1n < FIELD ? holderSecret + 1n : 1n;
    writeFileSync(
        inputPath,
        JSON.stringify({...eligibilityInput, holderSecret: wrongSecret.toString()}),
    );
    try {
        execFileSync(
            SNARK,
            [
                "wtns",
                "calculate",
                "circuits/session/session_eligibility_js/session_eligibility.wasm",
                inputPath,
                witnessPath,
            ],
            {stdio: "pipe"},
        );
    } catch (error) {
        if (error.status !== 0) return;
        throw error;
    }
    throw new Error("wrong holder-secret preimage unexpectedly produced a witness");
}

try {
    requireWrongPreimageFailure();
    const eligibility = prove(
        "eligibility",
        eligibilityInput,
        "session_eligibility",
        "session_eligibility",
    );
    if (eligibility.publicSignals.length !== 12) {
        throw new Error("unexpected eligibility public-signal count");
    }

    const complianceInput = {
        holderSecret: holderSecret.toString(),
        credentialId: credential.credentialId.toString(),
        complianceNonce: complianceNonce.toString(),
        encryptionRandomness: encryptionRandomness.toString(),
        complianceBridge: BigInt(eligibility.publicSignals[2]).toString(),
        ...sharedPublic,
        viewKeyEpoch: viewKeyEpoch.toString(),
        viewPublicKeyX: viewPublicKeyX.toString(),
        viewPublicKeyY: viewPublicKeyY.toString(),
    };
    const compliance = prove(
        "compliance",
        complianceInput,
        "session_compliance",
        "session_compliance",
    );
    if (compliance.publicSignals.length !== 17) {
        throw new Error("unexpected compliance public-signal count");
    }

    const ephemeral = [
        babyjub.F.e(BigInt(compliance.publicSignals[2])),
        babyjub.F.e(BigInt(compliance.publicSignals[3])),
    ];
    const decryptShared = babyjub.mulPointEscalar(ephemeral, viewSecret * 8n);
    const decryptPad = hash([
        2026091002n,
        babyjub.F.toObject(decryptShared[0]),
        babyjub.F.toObject(decryptShared[1]),
        viewKeyEpoch,
        sessionAccount,
    ]);
    const decryptedCredential =
        (BigInt(compliance.publicSignals[0]) - decryptPad + FIELD) % FIELD;
    if (decryptedCredential !== credential.credentialId) {
        throw new Error("authorized view key did not decrypt credential id");
    }
    const wrongShared = babyjub.mulPointEscalar(ephemeral, (viewSecret + 1n) * 8n);
    const wrongPad = hash([
        2026091002n,
        babyjub.F.toObject(wrongShared[0]),
        babyjub.F.toObject(wrongShared[1]),
        viewKeyEpoch,
        sessionAccount,
    ]);
    if (
        (BigInt(compliance.publicSignals[0]) - wrongPad + FIELD) % FIELD
        === credential.credentialId
    ) {
        throw new Error("unauthorized view key decrypted credential id");
    }

    const fixture = {
        eligibility,
        compliance,
        ciphertext: {
            encryptedCredential: compliance.publicSignals[0],
            tag: compliance.publicSignals[1],
            ephemeralX: compliance.publicSignals[2],
            ephemeralY: compliance.publicSignals[3],
        },
    };
    const issuerCredential = {
        credentialId: credential.credentialId.toString(),
        jurisdiction: credential.jurisdiction.toString(),
        tier: credential.tier.toString(),
        validUntilEpoch: credential.validUntilEpoch.toString(),
        holderSecretCommitment: holderSecretCommitment.toString(),
        credentialRoot: credentialRoot.toString(),
        rotationEpoch: rotationEpoch.toString(),
        sessionAccount: `0x${sessionAccount.toString(16).padStart(40, "0")}`,
        sessionSigner: `0x${sessionSigner.toString(16).padStart(40, "0")}`,
        factory: `0x${factory.toString(16).padStart(40, "0")}`,
        implementationCodeHash: `0x${implementationCodeHash
            .toString(16)
            .padStart(64, "0")}`,
        minTier: minTier.toString(),
        jurisdictionMask: jurisdictionMask.toString(),
        viewKeyEpoch: viewKeyEpoch.toString(),
        viewPublicKeyX: viewPublicKeyX.toString(),
        viewPublicKeyY: viewPublicKeyY.toString(),
    };

    const serializedFixture = JSON.stringify(fixture, null, 2);
    const serializedIssuer = JSON.stringify(issuerCredential, null, 2);
    const secretText = holderSecret.toString();
    if (
        serializedFixture.includes(secretText)
        || serializedIssuer.includes(secretText)
        || serializedFixture.includes('"holderSecret":')
        || serializedIssuer.includes('"holderSecret":')
    ) {
        throw new Error("refusing to write a holder secret");
    }

    mkdirSync("test/fixtures/session", {recursive: true});
    writeFileSync("test/fixtures/session/proofs.json", `${serializedFixture}\n`);
    writeFileSync(
        "test/fixtures/session/issuer-credential.json",
        `${serializedIssuer}\n`,
    );
} finally {
    rmSync(work, {recursive: true, force: true});
}
