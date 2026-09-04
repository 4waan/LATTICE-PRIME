#!/usr/bin/env node
// Turn the callstack census into an on-chain table.
//
// The census is a measurement over ATS v8.0.0 source. This writes it into
// Solidity so the test suite can assert coverage properties over it rather
// than a reviewer reading a markdown table and taking it on trust.
//
// Generated, never edited by hand. `make census` regenerates both, and
// `test/SeamCoverage.t.sol` fails if the properties stop holding, which is the
// only way an ATS upgrade that closes or opens a rail becomes visible to us.
//
// Run:   node tools/gen-seammap.mjs docs/callstack.json src/observatory/SeamMap.sol

import {readFileSync, writeFileSync} from "node:fs";
import {keccak_256} from "./keccak.mjs";

const [, , inPath, outPath] = process.argv;
const census = JSON.parse(readFileSync(inPath, "utf8"));

const SEAM_BIT = {A: 1, B: 2, C: 4, "C'": 8, D: 16, E: 32};
const WRITE_BIT = {
    "W:transfer": 1, "W:issue": 2, "W:redeem": 4, "W:adjust": 8,
    "W:hold": 16, "W:holdMove": 32, "W:lock": 64,
};

const rows = [];
for (const f of census.facets) {
    for (const e of f.entries ?? []) {
        if (!e.seams.length && !e.writes.length) continue;
        let seams = 0;
        for (const s of e.seams) seams |= SEAM_BIT[s];
        let writes = 0;
        for (const w of e.writes) writes |= WRITE_BIT[w];
        let inc = 0;
        for (const w of e.incidental ?? []) inc |= WRITE_BIT[w];
        rows.push({
            name: `${e.contract}.${e.fn}`,
            facet: f.facet, group: f.group,
            seams, writes, incidental: inc,
            depth: Math.min(e.depth, 255),
        });
    }
}
rows.sort((a, b) => a.name.localeCompare(b.name));

// 8 byte identity. Over a hundred and two names a truncated keccak collides
// with probability about 2^-45, and the generator checks rather than assumes.
const idOf = (s) => keccak_256(new TextEncoder().encode(s)).slice(0, 8);
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

const seen = new Map();
for (const r of rows) {
    r.id = hex(idOf(r.name));
    if (seen.has(r.id)) throw new Error(`id collision: ${r.name} vs ${seen.get(r.id)}`);
    seen.set(r.id, r.name);
}

// 12 bytes per record: id(8) | seams(1) | writes(1) | incidental(1) | depth(1).
const b = (n) => n.toString(16).padStart(2, "0");
const table = rows.map((r) =>
    r.id + b(r.seams) + b(r.writes) + b(r.incidental) + b(r.depth)).join("");

const byFacet = new Map();
for (const r of rows) {
    if (!byFacet.has(r.facet)) byFacet.set(r.facet, []);
    byFacet.get(r.facet).push(r);
}
const names = [...byFacet].map(([f, rs]) =>
    `///   ${f}: ` + rs.map((r) => r.name.split(".")[1]).join(", ")).join("\n");

const sol = `// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title SeamMap
/// @notice GENERATED. Do not edit. \`make census\` rewrites this file.
///
/// The ATS lifecycle surface, measured. One record per entry point that either
/// reaches a seam or moves a balance, across the twenty two facets named in the
/// brief plus the \`ByPartition\` rails they actually sit on.
///
/// Source: ${census.source}
/// Tool:   tools/callstack.mjs, then tools/gen-seammap.mjs
/// Census: ${census.generated}
/// Rows:   ${rows.length} of ${census.coverage.entryPoints} entry points
///
/// The point of putting a measurement on chain is that \`test/SeamCoverage.t.sol\`
/// can then assert properties of it. The properties are the findings: which
/// rails our seam D registry can see before the fact, which it can only see
/// after, and which it cannot see at all. An ATS upgrade that changes any of
/// those breaks a test instead of silently widening the hole.
///
/// Names, by facet:
${names}
library SeamMap {
    // ------------------------------------------------------------ seam bits

    /// \`IExternalPause.isPaused\`. Typed call, OR over the registered list.
    uint8 internal constant A = 1 << 0;
    /// \`IExternalControlList.isAuthorized\`. Typed call, AND, one address.
    uint8 internal constant B = 1 << 1;
    /// \`ICompliance.canTransfer\`. STATICCALL, pre-state, carries the value.
    uint8 internal constant C = 1 << 2;
    /// \`ICompliance.transferred | created | destroyed\`. CALL, post-state.
    uint8 internal constant CW = 1 << 3;
    /// \`IExternalKycList.getKycStatus\`. Typed call, AND, one address.
    uint8 internal constant D = 1 << 4;
    /// \`IIdentityRegistry.isVerified\`. STATICCALL, one address.
    uint8 internal constant E = 1 << 5;

    /// The seams the venue implements today: D is \`ZkKycRegistry\`, C and CW
    /// are \`SeamJournal\`. A, B and E are ATS-side or unimplemented.
    uint8 internal constant VENUE_OBSERVED = C | CW | D;
    /// The seams that run *before* the balance moves. CW does not.
    uint8 internal constant PRE_STATE = A | B | C | D | E;

    // ----------------------------------------------------------- write bits

    /// A balance leaves one holder and arrives at another.
    uint8 internal constant W_TRANSFER = 1 << 0;
    uint8 internal constant W_ISSUE = 1 << 1;
    uint8 internal constant W_REDEEM = 1 << 2;
    /// The supply factor changes. Every holder's balance is rescaled at once.
    uint8 internal constant W_ADJUST = 1 << 3;
    /// A hold is created. Tokens are encumbered, not moved.
    uint8 internal constant W_HOLD = 1 << 4;
    /// A hold is executed. This one does move the balance.
    uint8 internal constant W_HOLDMOVE = 1 << 5;
    /// A lock is created. Encumbrance again.
    uint8 internal constant W_LOCK = 1 << 6;

    /// Value changes hands. This is the set ATS gates.
    uint8 internal constant W_MOVES = W_TRANSFER | W_ISSUE | W_REDEEM | W_HOLDMOVE;
    /// Value is immobilised or rescaled in place. This is the set it does not.
    uint8 internal constant W_ENCUMBERS = W_HOLD | W_LOCK | W_ADJUST;
    uint8 internal constant W_ANY = W_MOVES | W_ENCUMBERS;

    // --------------------------------------------------------------- table

    uint256 internal constant COUNT = ${rows.length};
    /// 12 bytes per record: id(8) | seams(1) | writes(1) | incidental(1) | depth(1).
    uint256 internal constant STRIDE = 12;

    bytes internal constant TABLE = hex"${table}";

    error NoSuchOp(bytes8 op);

    /// @notice The identity of an entry point, as \`keccak256("Contract.fn")\`
    ///         truncated to eight bytes. The generator proves no collision.
    function id(string memory qualifiedName) internal pure returns (bytes8) {
        return bytes8(keccak256(bytes(qualifiedName)));
    }

    /// @notice One record. \`incidental\` is the set of balance sinks this entry
    ///         point reaches **only** through the lazy scheduled task
    ///         dispatcher, that is, effects it may fire without being asked to.
    function at(uint256 i)
        internal
        pure
        returns (bytes8 op, uint8 seams, uint8 writes, uint8 incidental, uint8 depth)
    {
        bytes memory t = TABLE;
        uint256 o = i * STRIDE;
        assembly {
            let word := mload(add(add(t, 0x20), o))
            op := word
            seams := byte(8, word)
            writes := byte(9, word)
            incidental := byte(10, word)
            depth := byte(11, word)
        }
    }

    /// @notice Look one entry point up by name. Reverts if it is not measured,
    ///         because a silent zero would read as "reaches no seam", which is
    ///         the most dangerous wrong answer this table can give.
    function seamsOf(string memory qualifiedName) internal pure returns (uint8) {
        bytes8 want = id(qualifiedName);
        for (uint256 i = 0; i < COUNT; ++i) {
            (bytes8 op, uint8 seams,,,) = at(i);
            if (op == want) return seams;
        }
        revert NoSuchOp(want);
    }

    function writesOf(string memory qualifiedName) internal pure returns (uint8) {
        bytes8 want = id(qualifiedName);
        for (uint256 i = 0; i < COUNT; ++i) {
            (bytes8 op,, uint8 writes,,) = at(i);
            if (op == want) return writes;
        }
        revert NoSuchOp(want);
    }

    /// @notice The balance sinks this entry point reaches only by firing a due
    ///         scheduled task. Measured because ATS dispatches those lazily from
    ///         inside unrelated calls: a freeze, a snapshot or a clearing submit
    ///         can apply a pending supply factor change on the way past.
    function incidentalOf(string memory qualifiedName) internal pure returns (uint8) {
        bytes8 want = id(qualifiedName);
        for (uint256 i = 0; i < COUNT; ++i) {
            (bytes8 op,,, uint8 inc,) = at(i);
            if (op == want) return inc;
        }
        revert NoSuchOp(want);
    }

    function has(uint8 set, uint8 bit) internal pure returns (bool) {
        return set & bit == bit;
    }
}
`;

writeFileSync(outPath, sol);
console.error(`seammap: ${rows.length} rows, ${table.length / 2} bytes`);
