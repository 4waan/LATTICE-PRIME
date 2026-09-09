import {randomUUID} from "node:crypto";
import {fork} from "node:child_process";
import {fileURLToPath} from "node:url";

const WORKER_PATH = fileURLToPath(new URL("./signer-worker.mjs", import.meta.url));
const METHODS = new Set([
    "initializeStore",
    "initializeAccount",
    "unlock",
    "lock",
    "account",
    "summary",
    "action",
    "activateMandate",
    "pauseMandate",
    "reserveEvaluation",
    "prepareCommit",
    "prepareReveal",
    "prepareOutstanding",
    "recordBroadcast",
]);

export class SignerProcessError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "SignerProcessError";
        this.code = code;
    }
}

export class SignerProcess {
    constructor({
        stateDir,
        feePolicy,
        commitBondTinybar,
        cancelFeeTinybar,
        timeoutMilliseconds = 15_000,
    }) {
        if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 100) {
            throw new SignerProcessError("TIMEOUT_INVALID", "signer timeout is invalid");
        }
        this.timeoutMilliseconds = timeoutMilliseconds;
        this.pending = new Map();
        this.child = fork(WORKER_PATH, {
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                LATTICE_AGENT_STATE_DIR: stateDir,
                LATTICE_AGENT_FEE_POLICY: JSON.stringify(feePolicy),
                LATTICE_AGENT_COMMIT_BOND_TINYBAR: commitBondTinybar,
                LATTICE_AGENT_CANCEL_FEE_TINYBAR: cancelFeeTinybar,
            },
        });
        this.child.on("message", (message) => this.#receive(message));
        this.child.on("error", () => this.#failAll("SIGNER_PROCESS_FAILED", "signer process failed"));
        this.child.on("exit", () => this.#failAll("SIGNER_PROCESS_EXITED", "signer process exited"));
    }

    async call(method, params) {
        if (!METHODS.has(method)) {
            throw new SignerProcessError("SIGNER_METHOD_REFUSED", "signer method is not allowed");
        }
        if (!this.child.connected) {
            throw new SignerProcessError("SIGNER_PROCESS_EXITED", "signer process is unavailable");
        }
        const id = randomUUID().replaceAll("-", "");
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new SignerProcessError("SIGNER_TIMEOUT", "signer request timed out"));
            }, this.timeoutMilliseconds);
            timer.unref();
            this.pending.set(id, {resolve, reject, timer});
            this.child.send({id, method, params}, (error) => {
                if (!error) return;
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new SignerProcessError("SIGNER_PROCESS_FAILED", "signer request could not be sent"));
            });
        });
    }

    async stop() {
        if (!this.child.connected) return;
        try {
            await this.call("lock", {});
        } finally {
            this.child.disconnect();
        }
    }

    #receive(message) {
        const pending = this.pending.get(message?.id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.ok === true) {
            pending.resolve(message.result);
            return;
        }
        pending.reject(
            new SignerProcessError(
                typeof message?.error?.code === "string" ? message.error.code : "SIGNER_REQUEST_FAILED",
                typeof message?.error?.message === "string" ? message.error.message : "signer request failed"
            )
        );
    }

    #failAll(code, message) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new SignerProcessError(code, message));
        }
        this.pending.clear();
    }
}
