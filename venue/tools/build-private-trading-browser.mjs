import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

import {build} from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ENTRY = path.join(HERE, "private-trading-browser-entry.mjs");
const OUTPUT = path.join(ROOT, "app", "private-trading-crypto.bundle.mjs");

export async function buildPrivateTradingBrowser({write = true} = {}) {
    const result = await build({
        entryPoints: [ENTRY],
        bundle: true,
        write: false,
        platform: "browser",
        format: "iife",
        target: ["es2022"],
        minify: true,
        legalComments: "none",
        charset: "ascii",
    });
    if (result.outputFiles?.length !== 1) {
        throw new Error("Private trading browser build returned unexpected output.");
    }
    const output = result.outputFiles[0].contents;
    if (write) {
        await writeFile(OUTPUT, output);
        const readback = await readFile(OUTPUT);
        if (!readback.equals(output)) {
            throw new Error("Private trading browser bundle failed readback.");
        }
    }
    return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    buildPrivateTradingBrowser().then((output) => {
        process.stdout.write(`app/private-trading-crypto.bundle.mjs: ${output.length} bytes\n`);
    }).catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
