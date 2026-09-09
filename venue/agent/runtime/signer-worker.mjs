import process from "node:process";

import {EncryptedJournalStore} from "./store.mjs";
import {LocalTypedSigner} from "./signer.mjs";

const REQUEST_ID = /^[a-zA-Z0-9_-]{1,64}$/;

function configuration() {
    const rootDir = process.env.LATTICE_AGENT_STATE_DIR;
    const commitBondTinybar = process.env.LATTICE_AGENT_COMMIT_BOND_TINYBAR;
    const cancelFeeTinybar = process.env.LATTICE_AGENT_CANCEL_FEE_TINYBAR;
    let feePolicy;
    try {
        feePolicy = JSON.parse(process.env.LATTICE_AGENT_FEE_POLICY ?? "");
    } catch {
        throw new Error("invalid signer fee policy");
    }
    return {rootDir, commitBondTinybar, cancelFeeTinybar, feePolicy};
}

const config = configuration();
const store = new EncryptedJournalStore({rootDir: config.rootDir});
const signer = new LocalTypedSigner({
    store,
    feePolicy: config.feePolicy,
    commitBondTinybar: config.commitBondTinybar,
    cancelFeeTinybar: config.cancelFeeTinybar,
});
let sessionPassphrase = null;

function requireMessage(message) {
    if (
        message === null ||
        typeof message !== "object" ||
        Array.isArray(message) ||
        !REQUEST_ID.test(message.id) ||
        typeof message.method !== "string" ||
        message.params === null ||
        typeof message.params !== "object" ||
        Array.isArray(message.params)
    ) {
        throw Object.assign(new Error("invalid signer IPC request"), {code: "IPC_REQUEST_INVALID"});
    }
}

function requireUnlocked() {
    if (sessionPassphrase === null) {
        throw Object.assign(new Error("signer is locked"), {code: "SIGNER_LOCKED"});
    }
    return sessionPassphrase;
}

async function dispatch(message) {
    requireMessage(message);
    switch (message.method) {
        case "initializeStore": {
            const created = await store.initialize(message.params.passphrase);
            return {created};
        }
        case "initializeAccount": {
            const passphrase = message.params.passphrase;
            const address = await signer.initializeAccount(
                passphrase,
                message.params.privateKey ?? null
            );
            sessionPassphrase = passphrase;
            return {address};
        }
        case "unlock": {
            const passphrase = message.params.passphrase;
            const migration = await signer.migrateState(passphrase);
            const address = await signer.account(passphrase);
            sessionPassphrase = passphrase;
            return {address, migration};
        }
        case "lock":
            sessionPassphrase = null;
            return {locked: true};
        case "account":
            return {address: await signer.account(requireUnlocked())};
        case "summary":
            return signer.summary(requireUnlocked());
        case "action":
            return signer.action(requireUnlocked(), message.params.actionId);
        case "activateMandate":
            return signer.activateMandate(requireUnlocked(), message.params.mandate);
        case "pauseMandate":
            return signer.pauseMandate(requireUnlocked(), message.params);
        case "reserveEvaluation":
            return signer.reserveEvaluation(
                requireUnlocked(),
                message.params.mandate,
                message.params.context
            );
        case "prepareCommit":
            return signer.prepareCommit(
                requireUnlocked(),
                message.params.mandate,
                message.params.context,
                message.params.request
            );
        case "preparePersistedCommit":
            return signer.preparePersistedCommit(
                requireUnlocked(),
                message.params.actionId
            );
        case "abandonUnsignedCommit":
            return signer.abandonUnsignedCommit(
                requireUnlocked(),
                message.params.actionId
            );
        case "prepareReveal":
            return signer.prepareReveal(
                requireUnlocked(),
                message.params.mandate,
                message.params.context,
                message.params.request
            );
        case "prepareOutstanding":
            return signer.prepareOutstanding(requireUnlocked(), message.params);
        case "recordBroadcast":
            return signer.recordBroadcast(requireUnlocked(), message.params);
        default:
            throw Object.assign(new Error("unsupported signer method"), {code: "IPC_METHOD_REFUSED"});
    }
}

let dispatchQueue = Promise.resolve();

async function respond(message) {
    const id = typeof message?.id === "string" ? message.id : "invalid";
    try {
        const result = await dispatch(message);
        process.send?.({id, ok: true, result});
    } catch (error) {
        process.send?.({
            id,
            ok: false,
            error: {
                code: typeof error?.code === "string" ? error.code : "SIGNER_REQUEST_FAILED",
                message: typeof error?.message === "string" ? error.message : "signer request failed",
            },
        });
    }
}

process.on("message", (message) => {
    dispatchQueue = dispatchQueue.then(
        () => respond(message),
        () => respond(message)
    );
});

process.on("disconnect", () => {
    sessionPassphrase = null;
    process.exit(0);
});
