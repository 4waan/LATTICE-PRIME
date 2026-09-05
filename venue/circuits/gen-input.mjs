// Builds ONE issuer tree for one epoch, containing four real credentials, and
// writes a circuit input for each.
//
// The first version of this script varied the credential and recomputed the root
// from it, which meant every "policy failure" fixture also carried a different
// root. That is not the situation the gate is defending against: in the real
// system the root is pinned to what the issuer published, so a holder cannot
// present a credential the issuer never signed. The interesting case is a
// credential that IS in the issuer's tree and still fails the policy, and it only
// exists if the good and bad credentials share a tree.
//
// The tree itself now lives in `tree.mjs`, because `prove-live.mjs` proves
// against the same root on chain and a second copy of the arithmetic would be a
// second issuer. This script's output is unchanged by that move.
import {writeFileSync, mkdirSync} from "fs";
import {buildTree, names, FIXTURE_REGISTRANT} from "./tree.mjs";

const {root, inputFor, forgedRootInput} = await buildTree();

mkdirSync("circuits/build", {recursive: true});

for (const n of names) {
    writeFileSync(`circuits/build/in_${n}.json`,
        JSON.stringify(inputFor(n, FIXTURE_REGISTRANT), null, 1));
}

const forged = forgedRootInput(FIXTURE_REGISTRANT);
writeFileSync("circuits/build/in_forged_root.json", JSON.stringify(forged.input, null, 1));
console.log("forged root  ", forged.root.toString());

console.log("issuer root  ", root.toString());
console.log("cases        ", names.join(", "), ", forged_root");
