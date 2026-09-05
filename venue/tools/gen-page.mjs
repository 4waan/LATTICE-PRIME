// Inlines `/*INLINE path*/` markers into a template and writes the result.
//
// Drop the `import` lines, drop the `export` keyword, concatenate. Nothing is
// rewritten, so what runs in the browser is what ran under node. CSS passes
// through untouched, having neither.
import {readFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const flatten = (rel) =>
    readFileSync(join(root, rel), "utf8")
        .split("\n")
        .filter((l) => !/^import\s/.test(l))
        .map((l) => l.replace(/^export\s+/, ""))
        .join("\n");

export function build(template, out) {
    const src = readFileSync(join(root, template), "utf8");
    const page = src.replace(/^\s*\/\*INLINE ([^*]+)\*\/\s*$/gm, (_, rel) => flatten(rel.trim()));
    if (page.includes("/*INLINE")) throw new Error("an INLINE marker was not substituted");
    writeFileSync(join(root, out), page);
    console.log(`${out.replace(/^docs\//, "")}: ${page.length} bytes`);
}
