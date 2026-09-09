// Proves the `valid` credential for a real address, against the credential root
// the issuer has published on chain for the epoch named.
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
// **The epoch is an argument, and that is what makes an expiring grant
// recoverable.** `ZkKycRegistry` compares the stored grant epoch against the
// current one at read time, so at an epoch boundary every grant dies with no
// transaction from anyone, and `RegistrationGate.register` pins public signal 3
// to `registry.currentEpoch()`. Last epoch's proof is worthless the instant the
// clock rolls. The root is not the problem: `tree.mjs` shows the leaves carry no
// epoch, so the same root serves every epoch and the issuer can publish it ahead
// of time. The proofs are the problem, and they take about twenty-three seconds
// each, which is not a thing to start doing at the boundary.
//
// So: prove for the next epoch **before** it arrives, and hold the file. Nothing
// on chain refuses that; `register` simply refuses the proof until the epoch it
// names is the current one, which is the same check that makes it safe to hold.
//
// Usage: node circuits/prove-live.mjs [--epoch N] [--wide] [--cred NAME] 0xADDRESS [0xADDRESS...]
//        writes deployments/proofs-live.json, or proofs-live-epoch<N>.json for
//        an epoch other than the tree's default, with `-wide` in the name when
//        proving against the wide tree
//
// `--wide` proves against the twelve-leaf tree (`tree.mjs` `botCreds`), the
// root the second RegistrationGate publishes. `--cred NAME` picks the credential
// for every address that follows it (default `valid`), so one command can give
// each bot its own credential and therefore its own nullifier:
//   prove-live.mjs --epoch 8 --wide --cred bot_1 0xA --cred bot_2 0xB --cred valid 0xC
// proves 0xA under bot_1, 0xB under bot_2, and 0xC under the shared credential.
import {execFileSync} from "child_process";
import {writeFileSync, mkdirSync, readFileSync, existsSync} from "fs";
import {buildTree, EPOCH as DEFAULT_EPOCH} from "./tree.mjs";

const SNARK = "/Users/awaansiddiqui/hedera2026/toolchain/node_modules/.bin/snarkjs";
const WORK = "circuits/build/live";

const argv = process.argv.slice(2);
let epoch = DEFAULT_EPOCH;
let wide = false;
let cred = "valid";
const jobs = []; // {addr, cred}
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--epoch") {
        epoch = BigInt(argv[++i]);
        continue;
    }
    if (argv[i] === "--wide") {
        wide = true;
        continue;
    }
    if (argv[i] === "--cred") {
        cred = argv[++i];
        continue;
    }
    jobs.push({addr: argv[i], cred});
}
if (jobs.length === 0) {
    console.error("usage: node circuits/prove-live.mjs [--epoch N] [--wide] [--cred NAME] 0xADDRESS [0xADDRESS...]");
    process.exit(1);
}
for (const {addr} of jobs) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error(`not an address: ${addr}`);
}

const {root, inputFor} = await buildTree(epoch, {wide});
mkdirSync(WORK, {recursive: true});

// A separate file per epoch, because a proof file is only good for the epoch it
// names and overwriting the current one with next epoch's would take the venue
// down rather than protect it. The default epoch keeps the original name so
// `script/live/register.sh` is unchanged. Wide-tree proofs get their own file
// too: they verify only on a gate that published the wide root.
const FILE = wide
    ? `deployments/proofs-live-epoch${epoch}-wide.json`
    : epoch === DEFAULT_EPOCH
        ? "deployments/proofs-live.json"
        : `deployments/proofs-live-epoch${epoch}.json`;

const out = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};

for (const {addr, cred: credName} of jobs) {
    const key = addr.toLowerCase();
    const tag = key.slice(2, 10) + (wide ? "_w" : "");
    const inf = `live/in_${tag}_e${epoch}.json`;
    writeFileSync(`circuits/build/${inf}`,
        JSON.stringify(inputFor(credName, BigInt(addr)), null, 1));

    const w = `live/w_${tag}_e${epoch}.wtns`;
    const pf = `live/p_${tag}_e${epoch}.json`;
    const pubf = `live/pub_${tag}_e${epoch}.json`;
    execFileSync("node", ["kyc_js/generate_witness.js", "kyc_js/kyc.wasm", inf, w],
        {cwd: "circuits/build"});
    execFileSync(SNARK, ["plonk", "prove", "kyc.zkey", w, pf, pubf],
        {cwd: "circuits/build"});

    // Verify before it ever leaves this machine. A proof that does not verify
    // here would be discovered on chain as a spent transaction instead.
    const v = execFileSync(SNARK, ["plonk", "verify", "vkey.json", pubf, pf],
        {cwd: "circuits/build", encoding: "utf8"});
    if (!v.includes("OK!")) throw new Error(`${addr}: proof did not verify`);

    const raw = execFileSync(SNARK, ["zkey", "export", "soliditycalldata", pubf, pf],
        {cwd: "circuits/build", encoding: "utf8"});
    const [proof, pub] = JSON.parse("[" + raw.trim().replace("][", "],[") + "]");
    if (proof.length !== 24) throw new Error(`${addr}: proof length ${proof.length}`);
    if (pub.length !== 7) throw new Error(`${addr}: pub length ${pub.length}`);

    // The four signals the gate pins, checked here so a mismatch is a local
    // error rather than a revert reason.
    if (BigInt(pub[1]) !== 1n) throw new Error(`${addr}: passes=${BigInt(pub[1])}`);
    if (BigInt(pub[2]) !== root) throw new Error(`${addr}: root mismatch`);
    if (BigInt(pub[3]) !== epoch) throw new Error(`${addr}: epoch=${BigInt(pub[3])}, want ${epoch}`);
    if (BigInt(pub[4]) !== BigInt(addr)) throw new Error(`${addr}: registrant not pinned`);

    out[key] = {address: addr, epoch: epoch.toString(), cred: credName, wide, proof, pub};
    console.log(`${addr}  verified  epoch=${epoch}  cred=${credName}  nullifier=${BigInt(pub[0])}`);
}

mkdirSync("deployments", {recursive: true});
writeFileSync(FILE, JSON.stringify(out, null, 1));
console.log(`wrote ${FILE}  (${Object.keys(out).length} addresses)`);
console.log(`issuer root (${wide ? "wide" : "narrow"} tree)`, root.toString());
console.log(`the gate must hold rootForEpoch(${epoch}) == that value before any of these register`);
