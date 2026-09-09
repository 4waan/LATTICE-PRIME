import {spawn} from "node:child_process";
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {encodeContext} from "./context.mjs";

const PINNED_IMAGE =
    "lattice-agent-worker@sha256:6e064bc5d6141df238b3e39a7fb8fa05893d3e69440a6d58a23eeb6cbfd1eee4";

export class WorkerError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "WorkerError";
        this.code = code;
    }
}

function run(command, args, timeoutMilliseconds, diagnosticOutput) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: diagnosticOutput ? ["ignore", "inherit", "inherit"] : ["ignore", "ignore", "ignore"],
            env: {PATH: process.env.PATH, HOME: process.env.HOME},
        });
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new WorkerError("WORKER_TIMEOUT", "isolated proving worker timed out"));
        }, timeoutMilliseconds);
        timer.unref();
        child.once("error", () => {
            clearTimeout(timer);
            reject(new WorkerError("WORKER_START_FAILED", "isolated proving worker could not start"));
        });
        child.once("exit", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new WorkerError("WORKER_FAILED", "isolated proving worker refused the job"));
        });
    });
}

export class IsolatedProvingWorker {
    constructor({
        bundleDir,
        image = PINNED_IMAGE,
        timeoutMilliseconds = 120_000,
        diagnosticOutput = false,
        jobRoot = path.join(os.homedir(), ".lattice-agent", "worker-jobs"),
    }) {
        if (typeof bundleDir !== "string" || !path.isAbsolute(bundleDir)) {
            throw new WorkerError("BUNDLE_INVALID", "worker bundle path must be absolute");
        }
        if (
            typeof image !== "string" ||
            !/^lattice-agent-worker@sha256:[0-9a-f]{64}$/.test(image)
        ) {
            throw new WorkerError("IMAGE_REFUSED", "worker image is not in the local allowlist");
        }
        if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1000) {
            throw new WorkerError("TIMEOUT_INVALID", "worker timeout is invalid");
        }
        if (typeof jobRoot !== "string" || !path.isAbsolute(jobRoot)) {
            throw new WorkerError("JOB_ROOT_INVALID", "worker job root must be an absolute path");
        }
        this.bundleDir = path.resolve(bundleDir);
        this.image = image;
        this.timeoutMilliseconds = timeoutMilliseconds;
        this.diagnosticOutput = diagnosticOutput === true;
        this.jobRoot = path.resolve(jobRoot);
    }

    async prove(context) {
        await mkdir(this.jobRoot, {recursive: true, mode: 0o700});
        await chmod(this.jobRoot, 0o700);
        const jobDir = await mkdtemp(path.join(this.jobRoot, "proof-"));
        await chmod(jobDir, 0o700);
        const inputPath = path.join(jobDir, "input.json");
        await writeFile(inputPath, JSON.stringify({input_data: [encodeContext(context)]}), {
            encoding: "utf8",
            mode: 0o600,
        });
        const user = `${process.getuid()}:${process.getgid()}`;
        const args = [
            "run",
            "--rm",
            "--pull",
            "never",
            "--network",
            "none",
            "--read-only",
            "--user",
            user,
            "--cpus",
            "1",
            "--memory",
            "1g",
            "--pids-limit",
            "64",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--env",
            "HOME=/tmp",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,size=64m",
            "--mount",
            `type=bind,src=${this.bundleDir},dst=/bundle,readonly`,
            "--mount",
            `type=bind,src=${jobDir},dst=/job`,
            this.image,
            "prove",
        ];
        try {
            await run("docker", args, this.timeoutMilliseconds, this.diagnosticOutput);
            const proof = JSON.parse(await readFile(path.join(jobDir, "proof.json"), "utf8"));
            return {
                proof,
                evidence: {
                    schemaVersion: "lattice.agent.worker-evidence.v1",
                    image: this.image,
                    networking: "docker-none",
                    readOnlyRoot: true,
                    nonRootUid: process.getuid(),
                    capabilitiesDropped: "ALL",
                    noNewPrivileges: true,
                    bundleMount: "read-only",
                    hostSecretsMounted: false,
                },
            };
        } catch (error) {
            if (error instanceof WorkerError) throw error;
            throw new WorkerError("WORKER_OUTPUT_INVALID", "isolated proving worker output is invalid");
        } finally {
            await rm(jobDir, {recursive: true, force: true});
        }
    }
}
