// Turns snarkjs proof output into JSON fixtures the Foundry tests read, so the
// integration test runs against a real proof over the real circuit rather than a
// mock verifier. The mock proves the plumbing; only this proves the statement.
import {execFileSync} from "child_process";
import {writeFileSync, existsSync} from "fs";

const SNARK = "/Users/awaansiddiqui/hedera2026/toolchain/node_modules/.bin/snarkjs";
const cases = ["valid", "fail_tier", "fail_epoch", "fail_jurisdiction", "forged_root"];

const out = {};
for (const name of cases) {
    const inf = `in_${name}.json`, pubf = `pub_${name}.json`, prooff = `p_${name}.json`;
    if (!existsSync(`circuits/build/${inf}`)) {
        console.error("missing", inf);
        continue;
    }
    execFileSync("node", [`kyc_js/generate_witness.js`, `kyc_js/kyc.wasm`, inf, `w_${name}.wtns`],
        {cwd: "circuits/build"});
    execFileSync(SNARK, ["plonk", "prove", "kyc.zkey", `w_${name}.wtns`, prooff, pubf],
        {cwd: "circuits/build"});
    const ok = execFileSync(SNARK, ["plonk", "verify", "vkey.json", pubf, prooff],
        {cwd: "circuits/build", encoding: "utf8"}).includes("OK!");
    if (!ok) throw new Error(`${name}: proof did not verify`);
    const raw = execFileSync(SNARK,
        ["zkey", "export", "soliditycalldata", pubf, prooff],
        {cwd: "circuits/build", encoding: "utf8"});
    // snarkjs prints "[a, b, ...],[c, d, ...]". Wrapping in one more pair of
    // brackets makes it a single well formed document, which is more robust than
    // hunting for the boundary in output whose spacing is not contractual.
    // The two arrays are printed adjacent with no separator, so supply one.
    const [proof, pub] = JSON.parse("[" + raw.trim().replace("][", "],[") + "]");
    if (proof.length !== 24) throw new Error(`${name}: proof length ${proof.length}`);
    if (pub.length !== 7) throw new Error(`${name}: pub length ${pub.length}`);
    out[name] = {proof, pub};
    console.log(`${name.padEnd(18)} verified  passes=${BigInt(pub[1])}  root=${BigInt(pub[2])}`);
}
writeFileSync("test/fixtures/proofs.json", JSON.stringify(out, null, 1));
console.log("wrote test/fixtures/proofs.json");
