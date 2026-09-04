// Solidity declaration and call-edge extractor.
//
// Not a compiler front end. It reads the vendored ATS sources and builds the
// coarsest graph that answers one question: from a facet entry point, which
// interface calls can the EVM reach, and through what.
//
// Three properties make a regex pass sound enough here, and they are checked
// rather than assumed (see `tools/callstack.mjs`, the coverage block):
//
//   1. ATS puts all shared logic in `library` StorageWrappers called by an
//      explicit `Name.fn(...)` qualifier. Qualified calls resolve exactly.
//   2. Facets are `abstract contract`s with a shallow, non-diamond inheritance
//      chain, so C3 linearisation is not needed; depth-first over bases agrees.
//   3. The seams are reached through five named interface symbols. Those are
//      matched on the interface name, not on a variable, so an aliased
//      `address` local cannot hide one.
//
// Where the graph is unsound it is unsound in the safe direction: an
// unresolved callee drops an edge, so a reported seam set is a subset of the
// truth. `unresolved` is reported per facet so that subset is not silent.

import {readFileSync} from "node:fs";

const KEYWORDS = new Set([
    "if", "for", "while", "switch", "catch", "return", "returns", "require",
    "assert", "revert", "emit", "new", "delete", "type", "payable", "memory",
    "calldata", "storage", "public", "private", "internal", "external", "view",
    "pure", "constant", "immutable", "override", "virtual", "modifier",
    "function", "constructor", "assembly", "unchecked", "try", "else", "do",
    "uint", "int", "bool", "bytes", "string", "address", "mapping", "struct",
    "enum", "event", "error", "using", "is", "abi", "keccak256", "sha256",
    "ecrecover", "ripemd160", "addmod", "mulmod", "selfdestruct", "blockhash",
]);
for (let i = 8; i <= 256; i += 8) {
    KEYWORDS.add(`uint${i}`);
    KEYWORDS.add(`int${i}`);
}
for (let i = 1; i <= 32; i++) KEYWORDS.add(`bytes${i}`);

/// Replace comments and string literals with spaces, preserving byte offsets so
/// that a later `indexOf` still points at the right line.
export function strip(src) {
    const out = src.split("");
    let i = 0;
    const blank = (a, b) => {
        for (let k = a; k < b && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
    };
    while (i < src.length) {
        const c = src[i], d = src[i + 1];
        if (c === "/" && d === "/") {
            const e = src.indexOf("\n", i);
            blank(i, e === -1 ? src.length : e);
            i = e === -1 ? src.length : e;
        } else if (c === "/" && d === "*") {
            const e = src.indexOf("*/", i + 2);
            blank(i, e === -1 ? src.length : e + 2);
            i = e === -1 ? src.length : e + 2;
        } else if (c === '"' || c === "'") {
            let j = i + 1;
            while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
            blank(i, j + 1);
            i = j + 1;
        } else {
            i++;
        }
    }
    return out.join("");
}

/// Index of the brace matching the one at `open`. -1 if unbalanced.
function matchBrace(s, open) {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
        if (s[i] === "{") depth++;
        else if (s[i] === "}" && --depth === 0) return i;
    }
    return -1;
}

/// Index just past the paren matching the one at `open`.
function matchParen(s, open) {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
        if (s[i] === "(") depth++;
        else if (s[i] === ")" && --depth === 0) return i;
    }
    return -1;
}

const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;

/// All calls in a body, as {qualifier, name}. `qualifier` is null for a bare
/// call. `X.y.selector` is emitted as a call to `X.y`, because ATS reaches four
/// of the six seam sites through `abi.encodeWithSelector` rather than a typed
/// call, and those are exactly the sites that carry the transfer value.
export function calls(body) {
    const out = [];
    const re = /(?:([A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(body))) {
        const [, qual, name] = m;
        if (KEYWORDS.has(name)) continue;
        if (qual && KEYWORDS.has(qual)) continue;
        out.push({qualifier: qual ?? null, name, at: m.index});
    }
    const sel = /([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*selector/g;
    while ((m = sel.exec(body))) {
        out.push({qualifier: m[1], name: m[2], at: m.index, viaSelector: true});
    }
    return out;
}

/// Every top-level declaration in one file, with its functions and modifiers.
export function parseFile(path) {
    const raw = readFileSync(path, "utf8");
    const src = strip(raw);
    const decls = [];
    const re = /\b(abstract\s+contract|contract|library|interface)\s+([A-Za-z_$][\w$]*)([^{;]*)\{/g;
    let m;
    while ((m = re.exec(src))) {
        const kind = m[1].includes("abstract") ? "abstract" : m[1];
        const name = m[2];
        const isClause = m[3];
        const open = src.indexOf("{", m.index + m[0].length - 1);
        const close = matchBrace(src, open);
        if (close === -1) continue;
        const body = src.slice(open + 1, close);
        const bases = [];
        // The `is` clause is routinely wrapped across lines, so match the
        // keyword rather than a space-delimited literal. Getting this wrong
        // silently empties the inheritance chain and every modifier resolves
        // to nothing, which is how the first run of this tool reported four
        // seam reaches out of a hundred and ninety four.
        const isMatch = isClause.match(/\bis\b([\s\S]*)$/);
        if (isMatch) {
            for (const b of isMatch[1].split(",")) {
                const t = b.trim().match(/^([A-Za-z_$][\w$]*)/);
                if (t) bases.push(t[1]);
            }
        }
        decls.push({
            kind, name, bases, path,
            line: lineOf(raw, m.index),
            members: members(body, src, raw, open + 1),
        });
        re.lastIndex = close;
    }
    return decls;
}

/// Functions and modifiers inside one declaration body.
function members(body, fullSrc, raw, offset) {
    const out = new Map();
    const re = /\b(function|modifier)\s+([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(body))) {
        const [, kind, name] = m;
        const parenOpen = body.indexOf("(", m.index + m[0].length - 1);
        const parenClose = matchParen(body, parenOpen);
        if (parenClose === -1) continue;
        // Header runs from the end of the parameter list to the body brace or
        // the semicolon of a declaration-only signature. Skip `returns (...)`
        // so a return type is not mistaken for an applied modifier.
        let i = parenClose + 1, depth = 0, header = "";
        while (i < body.length) {
            const c = body[i];
            if (c === "(") depth++;
            else if (c === ")") depth--;
            else if (depth === 0 && (c === "{" || c === ";")) break;
            header += c;
            i++;
        }
        if (i >= body.length) continue;
        const hasBody = body[i] === "{";
        let fnBody = "";
        if (hasBody) {
            const close = matchBrace(body, i);
            if (close === -1) continue;
            fnBody = body.slice(i + 1, close);
            re.lastIndex = close;
        }
        const attrs = header.replace(/returns\s*\(([^()]|\([^()]*\))*\)/g, " ")
            .replace(/override\s*\(([^()]*)\)/g, " override ");
        const applied = [];
        for (const t of attrs.match(/[A-Za-z_$][\w$]*/g) ?? []) {
            if (!KEYWORDS.has(t)) applied.push(t);
        }
        const visibility = /\bexternal\b/.test(attrs) ? "external"
            : /\bpublic\b/.test(attrs) ? "public"
            : /\bprivate\b/.test(attrs) ? "private" : "internal";
        const key = `${kind}:${name}`;
        // Overloads collapse into one node. Every question asked of this graph
        // is "can it reach a seam", and the union over overloads answers it.
        const prev = out.get(key);
        if (prev) {
            prev.body += "\n" + fnBody;
            prev.applied.push(...applied);
            prev.calls.push(...calls(fnBody));
            continue;
        }
        out.set(key, {
            kind, name, visibility, applied, hasBody,
            line: lineOf(raw, offset + m.index),
            body: fnBody,
            calls: calls(fnBody),
        });
    }
    return out;
}
