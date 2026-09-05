// The vectors `test/ReceiptVectors.t.sol` asserts against the deployed getters.
// Both files carry the same literals; neither computes the other's.
import {bits, breakingSize, earliest, excess, G, permits, point, receiptFor, spend, T, TOP}
    from "./lattice.mjs";

let bad = 0;
const eq = (what, got, want) => {
    if (String(got) !== String(want)) {
        console.error(`FAIL ${what}\n  got  ${got}\n  want ${want}`);
        bad++;
    }
};

// The cells the venue actually publishes on, from `PolicyFixture.asDeployed`.
eq("point(PRED,IMM)", point(G.PRED, T.IMM), 4030);
eq("point(EXACT,IMM)", point(G.EXACT, T.IMM), 1056698302);
eq("point(AGG,EOD)", point(G.AGG, T.EOD), 233016);
eq("point(BUCKET,EOD)", point(G.BUCKET, T.EOD), 14913080);
eq("point(NONE,PRE)", point(G.NONE, T.PRE), 63);
eq("TOP", TOP, 1073741823);

// Row 15, the venue's only incomparable divergence: section 7.2 says
// `(agg, EOD)` and the book publishes `(pred, imm)`, which is less per event and
// sooner. Neither ideal contains the other, so both directions must fail.
const asWritten = point(G.AGG, T.EOD), asDeployed = point(G.PRED, T.IMM);
eq("row15 as-written refuses the cancel", permits(asWritten, asDeployed), false);
eq("row15 excess", excess(asWritten, asDeployed), 390);
eq("row15 is incomparable, not merely narrower", permits(asDeployed, asWritten), false);
eq("row15 reverse excess", excess(asDeployed, asWritten), 229376);

// A ceiling stated in granularity alone cannot say "not before end of day".
eq("earliest(AGG,EOD)", earliest(asWritten), T.EOD);
eq("earliest(EXACT,IMM)", earliest(asDeployed), T.IMM);

// `PolicyFixture.meteredCancellations`: domain 8, agg 2, bucket 4, budget 3.
const row15 = {domainBits: 8, aggBits: 2, bucketBits: 4, budgetBits: 3};
eq("bits(pred)", bits(row15, G.PRED), 1);
eq("bits(agg)", bits(row15, G.AGG), 2);
eq("bits(bucket)", bits(row15, G.BUCKET), 4);
eq("bits(exact)", bits(row15, G.EXACT), 8);
eq("breakingSize(pred)", breakingSize(row15, G.PRED), 4);

// Rule A: the fourth cancellation of an epoch is withheld and still succeeds.
let spent = 0;
for (let i = 1; i <= 3; i++) {
    const r = spend(row15, spent, G.PRED);
    eq(`cancel ${i} afforded`, r.afforded, true);
    spent = r.spentAfter;
}
eq("three cancels spend three bits", spent, 3);
const fourth = spend(row15, spent, G.PRED);
eq("cancel 4 withheld", fourth.afforded, false);
eq("a withheld disclosure spends nothing", fourth.spentAfter, 3);

// The receipt itself, at the cell the fourth cancel sits on.
const r = receiptFor(asDeployed, row15, 3, G.PRED, T.IMM);
eq("receipt permitted", r.permitted, true);
eq("receipt wouldAfford", r.wouldAfford, false);
eq("receipt spent/budget", `${r.spentBits}/${r.budgetBits}`, "3/3");
eq("receipt breakingSize", r.breakingSize, 4);

// An unmetered row: rows 3, 4, 7, 16 and 17 all publish at exact, and Rule B
// refuses a budget on each. Unmetered affords forever and costs nothing.
const unmetered = {domainBits: 16, aggBits: 2, bucketBits: 4, budgetBits: 0};
eq("unmetered breakingSize", breakingSize(unmetered, G.EXACT), 0);
eq("unmetered always affords", spend(unmetered, 999, G.EXACT).afforded, true);
eq("unmetered costs nothing", spend(unmetered, 999, G.EXACT).cost, 0);

console.log(bad ? `lattice: ${bad} FAILED` : "lattice: 27 vectors ok");
process.exit(bad ? 1 : 0);
