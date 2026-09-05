// Proves the `valid` credential for a real address, against the credential root
// the issuer has ALREADY published on chain for epoch 7.
//
// Why this exists. The fixtures in `test/fixtures/proofs.json` are bound to one
// address, `tree.mjs`'s `FIXTURE_REGISTRANT`, whose key nobody holds. A live
// venue needs holders it can actually transact as. The registrant is a public
// input and not part of any leaf, so the root is the same one already published
// and `publishRoot` staying write-once per epoch is not in the way.
//
// The sybil bound is the real constraint here, not the tree. The nullifier is
// `Poseidon(secret, DOMAIN_KYC, epoch)` and carries nothing about the
// registrant, so every address proved from this one credential shares a
// nullifier and `ZkKycRegistry.MAX_USES_PER_EPOCH` caps the set at five.
// That is the bound working, not a limitation being worked around.
//
// Usage: node circuits/prove-live.mjs 0xADDRESS [0xADDRESS...]
//        writes deployments/proofs-live.json
import {execFileSync} from "child_process";
import {writeFileSync, mkdirSync, readFileSync, existsSync} from "fs";
import {buildTree} from "./tree.mjs";

const SNARK = "/Users/awaansiddiqui/hedera2026/toolchain/node_modules/.bin/snarkjs";
const WORK = "circuits/build/live";

const addrs = process.argv.slice(2);
if (addrs.length === 0) {
    console.error("usage: node circuits/prove-live.mjs 0xADDRESS [0xADDRESS...]");
    process.exit(1);
}
for (const a of addrs) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`not an address: ${a}`);
}

const {root, inputFor} = await buildTree();
mkdirSync(WORK, {recursive: true});

const out = existsSync("deployments/proofs-live.json")
    ? JSON.parse(readFileSync("deployments/proofs-live.json", "utf8"))
    : {};

for (const addr of addrs) {
    const key = addr.toLowerCase();
    const tag = key.slice(2, 10);
    const inf = `live/in_${tag}.json`;
    writeFileSync(`circuits/build/${inf}`,
        JSON.stringify(inputFor("valid", BigInt(addr)), null, 1));

    execFileSync("node", ["kyc_js/generate_witness.js", "kyc_js/kyc.wasm", inf, `live/w_${tag}.wtns`],
        {cwd: "circuits/build"});
    execFileSync(SNARK, ["plonk", "prove", "kyc.zkey", `live/w_${tag}.wtns`,
        `live/p_${tag}.json`, `live/pub_${tag}.json`], {cwd: "circuits/build"});

    // Verify before it ever leaves this machine. A proof that does not verify
    // here would be discovered on chain as a spent transaction instead.
    const v = execFileSync(SNARK, ["plonk", "verify", "vkey.json",
        `live/pub_${tag}.json`, `live/p_${tag}.json`], {cwd: "circuits/build", encoding: "utf8"});
    if (!v.includes("OK!")) throw new Error(`${addr}: proof did not verify`);

    const raw = execFileSync(SNARK, ["zkey", "export", "soliditycalldata",
        `live/pub_${tag}.json`, `live/p_${tag}.json`], {cwd: "circuits/build", encoding: "utf8"});
    const [proof, pub] = JSON.parse("[" + raw.trim().replace("][", "],[") + "]");
    if (proof.length !== 24) throw new Error(`${addr}: proof length ${proof.length}`);
    if (pub.length !== 7) throw new Error(`${addr}: pub length ${pub.length}`);

    // The four signals the gate pins, checked here so a mismatch is a local
    // error rather than a revert reason.
    if (BigInt(pub[1]) !== 1n) throw new Error(`${addr}: passes=${BigInt(pub[1])}`);
    if (BigInt(pub[2]) !== root) throw new Error(`${addr}: root mismatch`);
    if (BigInt(pub[3]) !== 7n) throw new Error(`${addr}: epoch=${BigInt(pub[3])}`);
    if (BigInt(pub[4]) !== BigInt(addr)) throw new Error(`${addr}: registrant not pinned`);

    out[key] = {address: addr, proof, pub};
    console.log(`${addr}  verified  nullifier=${BigInt(pub[0])}`);
}

mkdirSync("deployments", {recursive: true});
writeFileSync("deployments/proofs-live.json", JSON.stringify(out, null, 1));
console.log(`wrote deployments/proofs-live.json  (${Object.keys(out).length} addresses)`);
console.log("issuer root  ", root.toString());
