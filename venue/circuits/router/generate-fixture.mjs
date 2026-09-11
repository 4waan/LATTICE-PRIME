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
import {
    buildBabyjub,
    buildPoseidon,
    poseidonContract,
} from "circomlibjs";

const SNARK = "../toolchain/node_modules/.bin/snarkjs";
const DEPTH = 20;
const NOTE_COUNT = 8;
const FIELD =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const randomField = (bytes = 31) =>
    BigInt(`0x${randomBytes(bytes).toString("hex")}`) % FIELD;

const pool = BigInt("0x4444444444444444444444444444444444444444");
const recipient = BigInt("0x5555555555555555555555555555555555555555");
const asset = 0n;
const denomination = 100000000n;
const chainId = 296n;
const viewKeyEpoch = 4n;
const viewSecret = 9876543210123456789n;

const poseidon = await buildPoseidon();
const poseidonField = poseidon.F;
const hash = (values) => poseidonField.toObject(poseidon(values));

const notes = Array.from({length: NOTE_COUNT}, () => ({
    noteSecret: randomField(),
    noteNullifier: randomField(),
    fundingTag: randomField(),
}));
const complianceNonce = randomField(30);
const encryptionRandomness = randomField(30);

const commitments = notes.map((note) =>
    hash([
        note.noteSecret,
        note.noteNullifier,
        note.fundingTag,
        chainId,
        pool,
        asset,
        denomination,
    ]),
);

const zeroAtLevel = [0n];
for (let level = 0; level < DEPTH; level++) {
    zeroAtLevel.push(hash([zeroAtLevel[level], zeroAtLevel[level]]));
}

function treeFor(leaves) {
    const nodes = [new Map()];
    leaves.forEach((leaf, index) => nodes[0].set(index, leaf));
    for (let level = 0; level < DEPTH; level++) {
        const next = new Map();
        for (const index of nodes[level].keys()) {
            const parent = index >> 1;
            if (next.has(parent)) continue;
            const left = nodes[level].get(parent * 2) ?? zeroAtLevel[level];
            const right = nodes[level].get(parent * 2 + 1) ?? zeroAtLevel[level];
            next.set(parent, hash([left, right]));
        }
        nodes.push(next);
    }
    return {nodes, root: nodes[DEPTH].get(0) ?? zeroAtLevel[DEPTH]};
}

const acceptedRoots = [];
for (let count = 1; count <= commitments.length; count++) {
    acceptedRoots.push(treeFor(commitments.slice(0, count)).root);
}
const {nodes, root} = treeFor(commitments);

const pathElements = [];
const pathIndices = [];
let pathIndex = 0;
for (let level = 0; level < DEPTH; level++) {
    const bit = pathIndex & 1;
    pathIndices.push(BigInt(bit));
    pathElements.push(
        nodes[level].get(pathIndex ^ 1) ?? zeroAtLevel[level],
    );
    pathIndex >>= 1;
}

const babyjub = await buildBabyjub();
const viewPoint = babyjub.mulPointEscalar(babyjub.Base8, viewSecret);
const viewPublicKeyX = babyjub.F.toObject(viewPoint[0]);
const viewPublicKeyY = babyjub.F.toObject(viewPoint[1]);

const target = notes[0];
const sharedPublic = {
    root: root.toString(),
    recipient: recipient.toString(),
    pool: pool.toString(),
    asset: asset.toString(),
    denomination: denomination.toString(),
    chainId: chainId.toString(),
};
const withdrawalInput = {
    noteSecret: target.noteSecret.toString(),
    noteNullifier: target.noteNullifier.toString(),
    fundingTag: target.fundingTag.toString(),
    pathElements: pathElements.map(String),
    pathIndices: pathIndices.map(String),
    complianceNonce: complianceNonce.toString(),
    ...sharedPublic,
};

const work = mkdtempSync(join(tmpdir(), "hedera-router-proof-"));

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
            `circuits/router/${wasm}_js/${wasm}.wasm`,
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
            `circuits/router/${zkey}.zkey`,
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
            `circuits/router/${zkey}_vkey.json`,
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

try {
    const withdrawal = prove(
        "withdrawal",
        withdrawalInput,
        "fixed_withdrawal",
        "fixed_withdrawal",
    );
    if (withdrawal.publicSignals.length !== 8) {
        throw new Error("unexpected withdrawal public-signal count");
    }

    const complianceInput = {
        noteSecret: target.noteSecret.toString(),
        noteNullifier: target.noteNullifier.toString(),
        fundingTag: target.fundingTag.toString(),
        complianceNonce: complianceNonce.toString(),
        encryptionRandomness: encryptionRandomness.toString(),
        complianceBridge: BigInt(withdrawal.publicSignals[1]).toString(),
        ...sharedPublic,
        viewKeyEpoch: viewKeyEpoch.toString(),
        viewPublicKeyX: viewPublicKeyX.toString(),
        viewPublicKeyY: viewPublicKeyY.toString(),
    };
    const compliance = prove(
        "compliance",
        complianceInput,
        "fixed_withdrawal_compliance",
        "fixed_withdrawal_compliance",
    );
    if (compliance.publicSignals.length !== 14) {
        throw new Error("unexpected compliance public-signal count");
    }

    const ephemeral = [
        babyjub.F.e(BigInt(compliance.publicSignals[2])),
        babyjub.F.e(BigInt(compliance.publicSignals[3])),
    ];
    const decryptShared = babyjub.mulPointEscalar(ephemeral, viewSecret * 8n);
    const decryptPad = hash([
        2026091013n,
        babyjub.F.toObject(decryptShared[0]),
        babyjub.F.toObject(decryptShared[1]),
        viewKeyEpoch,
        recipient,
        pool,
    ]);
    const decryptedCommitment =
        (BigInt(compliance.publicSignals[0]) - decryptPad + FIELD) % FIELD;
    if (decryptedCommitment !== commitments[0]) {
        throw new Error("authorized view key did not decrypt note commitment");
    }
    const wrongShared = babyjub.mulPointEscalar(ephemeral, (viewSecret + 1n) * 8n);
    const wrongPad = hash([
        2026091013n,
        babyjub.F.toObject(wrongShared[0]),
        babyjub.F.toObject(wrongShared[1]),
        viewKeyEpoch,
        recipient,
        pool,
    ]);
    if (
        (BigInt(compliance.publicSignals[0]) - wrongPad + FIELD) % FIELD
        === commitments[0]
    ) {
        throw new Error("unauthorized view key decrypted note commitment");
    }

    const fixture = {
        commitments: commitments.map(String),
        acceptedRoots: acceptedRoots.map(String),
        withdrawal,
        compliance,
        ciphertext: {
            encryptedCommitment: compliance.publicSignals[0],
            tag: compliance.publicSignals[1],
            ephemeralX: compliance.publicSignals[2],
            ephemeralY: compliance.publicSignals[3],
        },
        metadata: {
            root: root.toString(),
            recipient: `0x${recipient.toString(16).padStart(40, "0")}`,
            pool: `0x${pool.toString(16).padStart(40, "0")}`,
            asset: "0x0000000000000000000000000000000000000000",
            denomination: denomination.toString(),
            chainId: chainId.toString(),
            viewKeyEpoch: viewKeyEpoch.toString(),
            viewPublicKeyX: viewPublicKeyX.toString(),
            viewPublicKeyY: viewPublicKeyY.toString(),
        },
    };
    const serialized = JSON.stringify(fixture, null, 2);
    for (const note of notes) {
        for (const secret of [
            note.noteSecret,
            note.noteNullifier,
            note.fundingTag,
        ]) {
            if (serialized.includes(secret.toString())) {
                throw new Error("refusing to write a note preimage");
            }
        }
    }

    mkdirSync("test/fixtures/router", {recursive: true});
    writeFileSync("test/fixtures/router/proofs.json", `${serialized}\n`);
    writeFileSync(
        "test/fixtures/router/poseidon-bytecode.json",
        `${JSON.stringify(
            {creationCode: poseidonContract.createCode(2)},
            null,
            2,
        )}\n`,
    );
} finally {
    rmSync(work, {recursive: true, force: true});
}
