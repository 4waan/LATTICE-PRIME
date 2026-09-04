const fs = require("fs");
const h = (s) => "0x" + BigInt(s).toString(16).padStart(64, "0");
function emit(name, tag) {
  const p = JSON.parse(fs.readFileSync(`proof/${name}_proof.json`));
  const s = JSON.parse(fs.readFileSync(`proof/${name}_public.json`));
  const L = [];
  L.push(`    // generated from build/${name}_proof.json, do not hand edit`);
  L.push(`    function ${tag}A() internal pure returns (uint[2] memory a) {`);
  L.push(`        a[0] = uint(${h(p.pi_a[0])}); a[1] = uint(${h(p.pi_a[1])});`);
  L.push(`    }`);
  // snarkjs solidity calldata swaps the Fp2 component order for G2 (EIP-197 is imaginary first)
  L.push(`    function ${tag}B() internal pure returns (uint[2][2] memory b) {`);
  L.push(`        b[0][0] = uint(${h(p.pi_b[0][1])}); b[0][1] = uint(${h(p.pi_b[0][0])});`);
  L.push(`        b[1][0] = uint(${h(p.pi_b[1][1])}); b[1][1] = uint(${h(p.pi_b[1][0])});`);
  L.push(`    }`);
  L.push(`    function ${tag}C() internal pure returns (uint[2] memory c) {`);
  L.push(`        c[0] = uint(${h(p.pi_c[0])}); c[1] = uint(${h(p.pi_c[1])});`);
  L.push(`    }`);
  L.push(`    function ${tag}Pub() internal pure returns (uint[${s.length}] memory z) {`);
  s.forEach((v, i) => L.push(`        z[${i}] = uint(${h(v)});`));
  L.push(`    }`);
  return L.join("\n");
}
fs.writeFileSync("test/ProofData.sol",
`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Emitted by gendata.js from the snarkjs proof files. The G2 element order is
// swapped here because EIP-197 takes Fp2 imaginary part first while snarkjs
// writes real part first, the same convention snarkjs applies in its own
// exportsoliditycalldata.
contract ProofData {
    uint constant Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

${emit("trivial", "t")}

${emit("five", "f")}
}
`);
console.log("wrote fv/test/ProofData.sol");
