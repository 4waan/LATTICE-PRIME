// Builds `docs/commit-preview.html` from the template plus the modules the vector
// suite checks. Generated, never hand edited: the page claims to show the
// commitment the contract will re-hash, and a page carrying its own private copy
// of keccak cannot make that claim.
//
// Drop the `import` lines, drop the `export` keyword, concatenate. Nothing is
// rewritten, so what runs in the browser is what ran under node.
import {readFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const flatten = (rel) =>
    readFileSync(join(root, rel), "utf8")
        .split("\n")
        .filter((l) => !/^import\s/.test(l))
        .map((l) => l.replace(/^export\s+/, ""))
        .join("\n");

const template = readFileSync(join(root, "docs/commit-preview.template.html"), "utf8");
const out = template.replace(/^\s*\/\*INLINE ([^*]+)\*\/\s*$/gm, (_, rel) => flatten(rel.trim()));

if (out.includes("/*INLINE")) throw new Error("an INLINE marker was not substituted");
writeFileSync(join(root, "docs/commit-preview.html"), out);
console.log(`commit-preview.html: ${out.length} bytes`);
