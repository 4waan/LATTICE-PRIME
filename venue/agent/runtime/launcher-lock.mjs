import {spawn} from "node:child_process";
import {chmod, open} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const HELPER_PATH = fileURLToPath(new URL("./launcher-lock-helper.mjs", import.meta.url));
const LOCKF_PATH = "/usr/bin/lockf";

export async function acquireLauncherLock(directory, {lockfPath = LOCKF_PATH} = {}) {
    if (typeof directory !== "string" || !path.isAbsolute(directory)) {
        throw new TypeError("launcher lock directory must be absolute");
    }
    const lockPath = path.join(directory, "launcher.lock");
    const lockFile = await open(lockPath, "a", 0o600);
    await lockFile.close();
    await chmod(lockPath, 0o600);

    const child = spawn(
        lockfPath,
        ["-t", "0", lockPath, process.execPath, HELPER_PATH],
        {stdio: ["pipe", "pipe", "pipe"]}
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
        if (stderr.length < 4096) stderr += chunk;
    });
    await new Promise((resolve, reject) => {
        let stdout = "";
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            child.stdout.off("data", onData);
            child.off("error", onError);
            child.off("exit", onExit);
            callback(value);
        };
        const onData = (chunk) => {
            stdout += chunk.toString("utf8");
            if (stdout === "LOCK_ACQUIRED\n") finish(resolve);
            else if (stdout.length > "LOCK_ACQUIRED\n".length) {
                finish(reject, new Error("local agent launcher lock helper returned invalid output"));
            }
        };
        const onError = () => {
            finish(reject, new Error("local agent launcher requires the operating system lock utility"));
        };
        const onExit = () => {
            const detail = stderr.trim();
            finish(
                reject,
                new Error(
                    detail.length === 0 || detail.includes("already locked")
                        ? "local agent launcher is already running"
                        : `local agent launcher lock was refused: ${detail}`
                )
            );
        };
        child.stdout.on("data", onData);
        child.once("error", onError);
        child.once("exit", onExit);
    }).catch(async (error) => {
        child.stdin.destroy();
        child.kill();
        throw error;
    });

    let released = false;
    return async () => {
        if (released) return;
        released = true;
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.stdin.end();
        try {
            await exited;
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill();
        }
    };
}
