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

const sol = `// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title SeamMap
/// @notice GENERATED. Do not edit. \`make census\` rewrites this file.
///
/// One record per ATS entry point that reaches a seam or moves a balance.
/// \`test/SeamCoverage.t.sol\` asserts the findings over it, so an upgrade that
/// opens, closes or reorders a rail breaks a test.
///
/// Source: ${census.source}
/// Tool:   tools/callstack.mjs, then tools/gen-seammap.mjs
/// Rows:   ${rows.length} of ${census.coverage.entryPoints} entry points
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

    /// D is \`ZkKycRegistry\`, C and CW are \`SeamJournal\`.
    uint8 internal constant VENUE_OBSERVED = C | CW | D;
    /// Runs before the balance moves. CW does not.
    uint8 internal constant PRE_STATE = A | B | C | D | E;

    // ----------------------------------------------------------- write bits

    uint8 internal constant W_TRANSFER = 1 << 0;
    uint8 internal constant W_ISSUE = 1 << 1;
    uint8 internal constant W_REDEEM = 1 << 2;
    /// Every holder rescaled at once.
    uint8 internal constant W_ADJUST = 1 << 3;
    uint8 internal constant W_HOLD = 1 << 4;
    uint8 internal constant W_HOLDMOVE = 1 << 5;
    uint8 internal constant W_LOCK = 1 << 6;

    /// Value changes hands. The set ATS gates.
    uint8 internal constant W_MOVES = W_TRANSFER | W_ISSUE | W_REDEEM | W_HOLDMOVE;
    /// Immobilised or rescaled in place. The set it does not.
    uint8 internal constant W_ENCUMBERS = W_HOLD | W_LOCK | W_ADJUST;
    uint8 internal constant W_ANY = W_MOVES | W_ENCUMBERS;

    // --------------------------------------------------------------- table

    uint256 internal constant COUNT = ${rows.length};
    /// 12 bytes per record: id(8) | seams(1) | writes(1) | incidental(1) | depth(1).
    uint256 internal constant STRIDE = 12;

    bytes internal constant TABLE = hex"${table}";

    error NoSuchOp(bytes8 op);

    /// @notice \`keccak256("Contract.fn")\` truncated to eight bytes. The
    ///         generator proves no collision.
    function id(string memory qualifiedName) internal pure returns (bytes8) {
        return bytes8(keccak256(bytes(qualifiedName)));
    }

    /// @notice One record. \`incidental\` is the set of balance sinks the entry
    ///         point reaches only through the lazy scheduled task dispatcher.
    function recordAt(uint256 i)
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

    /// @notice Look one entry point up by name. Reverts if it is not measured:
    ///         a silent zero would read as "reaches no seam".
    function recordOf(string memory qualifiedName)
        internal
        pure
        returns (bytes8 op, uint8 seams, uint8 writes, uint8 incidental, uint8 depth)
    {
        bytes8 want = id(qualifiedName);
        for (uint256 i = 0; i < COUNT; ++i) {
            (op, seams, writes, incidental, depth) = recordAt(i);
            if (op == want) return (op, seams, writes, incidental, depth);
        }
        revert NoSuchOp(want);
    }

    function seamsOf(string memory qualifiedName) internal pure returns (uint8) {
        (, uint8 seams,,,) = recordOf(qualifiedName);
        return seams;
    }

    function writesOf(string memory qualifiedName) internal pure returns (uint8) {
        (,, uint8 writes,,) = recordOf(qualifiedName);
        return writes;
    }

    function incidentalOf(string memory qualifiedName) internal pure returns (uint8) {
        (,,, uint8 incidental,) = recordOf(qualifiedName);
        return incidental;
    }

    function has(uint8 set, uint8 bit) internal pure returns (bool) {
        return set & bit == bit;
    }
}
`;

writeFileSync(outPath, sol);
console.error(`seammap: ${rows.length} rows, ${table.length / 2} bytes`);
