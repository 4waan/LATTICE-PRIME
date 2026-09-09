import {spawn} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";

const VERIFY_SCRIPT = fileURLToPath(new URL("../proof/verify.py", import.meta.url));
const MAX_RESULT_BYTES = 16 * 1024;

export class VerifierError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "VerifierError";
        this.code = code;
    }
}

export class EzklVerifier {
    constructor({bundleDir, pythonPath, timeoutMilliseconds = 15_000}) {
        if (typeof bundleDir !== "string" || !path.isAbsolute(bundleDir)) {
            throw new VerifierError("BUNDLE_INVALID", "verifier bundle path must be absolute");
        }
        if (typeof pythonPath !== "string" || !path.isAbsolute(pythonPath)) {
            throw new VerifierError("PYTHON_INVALID", "verifier Python path must be absolute");
        }
        this.bundleDir = path.resolve(bundleDir);
        this.pythonPath = path.resolve(pythonPath);
        this.timeoutMilliseconds = timeoutMilliseconds;
    }

    async verify(request) {
        const input = JSON.stringify(request);
        if (Buffer.byteLength(input) > 1024 * 1024) {
            throw new VerifierError("PROOF_TOO_LARGE", "proof verification request exceeds one mebibyte");
        }
        return new Promise((resolve, reject) => {
            const child = spawn(
                this.pythonPath,
                [VERIFY_SCRIPT, "--bundle", this.bundleDir],
                {
                    stdio: ["pipe", "pipe", "ignore"],
                    env: {PATH: process.env.PATH, HOME: process.env.HOME},
                }
            );
            const chunks = [];
            let size = 0;
            let settled = false;
            const fail = (code, message) => {
                if (settled) return;
                settled = true;
                reject(new VerifierError(code, message));
            };
            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                fail("VERIFIER_TIMEOUT", "independent verifier timed out");
            }, this.timeoutMilliseconds);
            timer.unref();
            child.stdout.on("data", (chunk) => {
                size += chunk.length;
                if (size > MAX_RESULT_BYTES) {
                    child.kill("SIGKILL");
                    fail("VERIFIER_OUTPUT_REFUSED", "independent verifier output is too large");
                    return;
                }
                chunks.push(chunk);
            });
            child.once("error", () => fail("VERIFIER_START_FAILED", "independent verifier could not start"));
            child.once("exit", (code) => {
                clearTimeout(timer);
                if (settled) return;
                if (code !== 0) {
                    fail("PROOF_REFUSED", "independent verifier refused the proof");
                    return;
                }
                try {
                    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                    if (result.verified !== true) throw new Error("not verified");
                    settled = true;
                    resolve(result);
                } catch {
                    fail("VERIFIER_OUTPUT_REFUSED", "independent verifier output is invalid");
                }
            });
            child.stdin.end(input);
        });
    }
}
