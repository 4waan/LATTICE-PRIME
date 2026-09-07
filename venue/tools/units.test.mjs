// The vectors for `tools/units.mjs`. Two kinds, and the distinction matters.
//
// **The venue vectors are the deployment's own numbers**, read out of
// `deployments/296-venue.json` and out of the recorded trade in its `evidence`
// block. `test/UnitVectors.t.sol` asserts the same literals against
// `CallAuction.notional` and against the engine's immutables, so the client half
// and the contract half cannot drift silently. That is the shape
// `commitment.test.mjs` and `test/CommitmentVectors.t.sol` already use.
//
// **The refusal vectors** are the inputs this module is supposed to reject. They
// carry no contract twin because there is nothing on chain to compare to: the
// point of each is that the value never reaches a transaction.
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {
    TINYBAR, WEIBAR, WEIBAR_PER_TINYBAR, BOND_DECIMALS,
    PRICE_DECIMALS, PRICE_ONE,
    toWeibar, fromWeibar, formatHbar, parseHbar,
    toUnits, formatQuantity, buyEscrow, notional, displayPrice,
    markPerUnitTinybar, markOfLot, formatPrice, median, deviationBps,
    diagnoseWrongBond, UnitError,
} from "./units.mjs";

let bad = 0;
const eq = (what, got, want) => {
    if (got !== want) {
        console.error(`FAIL ${what}\n  got  ${got}\n  want ${want}`);
        bad++;
    }
};
const throws = (what, fn, match) => {
    try {
        fn();
    } catch (e) {
        if (!(e instanceof UnitError)) {
            console.error(`FAIL ${what}: threw ${e.constructor.name}, want UnitError`);
            bad++;
        } else if (match && !e.message.includes(match)) {
            console.error(`FAIL ${what}: message missing ${JSON.stringify(match)}\n  ${e.message}`);
            bad++;
        }
        return;
    }
    console.error(`FAIL ${what}: did not throw`);
    bad++;
};

// ------------------------------------------------------------- the constants

eq("TINYBAR", TINYBAR, 100000000n);
eq("WEIBAR", WEIBAR, 1000000000000000000n);
eq("the ratio", WEIBAR_PER_TINYBAR, 10000000000n);
eq("the bond has no decimals", BOND_DECIMALS, 0);

// ------------------------------------------- the venue's own numbers, live

// `venue.market.commitBond`, 296-venue.json.
eq("commitBond to weibar", toWeibar(1000000n), 10000000000000000n);
eq("and back", fromWeibar(10000000000000000n), 1000000n);
// `venue.market.cancelFee`.
eq("cancelFee to weibar", toWeibar(100000n), 1000000000000000n);

// The recorded trade: sellLimit 95, buyLimit 105, qty 1000, clearingPrice 100.
eq("the buyer escrows at their own limit", buyEscrow(105n, 1000n), 105000n);
eq("and its value field", toWeibar(buyEscrow(105n, 1000n)), 1050000000000000n);
// `evidence.reveals.quote`: priceTwice 200, volume 1000.
eq("notional at the clearing price", notional(200n, 1000n), 100000n);
eq("the clearing price displays as 100", displayPrice(200n), "100");
// `evidence.cross`: the seller's credit is proceeds plus the bond returned.
eq("seller credit", notional(200n, 1000n) + 1000000n, 1100000n);
// and the buyer's is the overpayment plus the bond.
eq("buyer credit", buyEscrow(105n, 1000n) - notional(200n, 1000n) + 1000000n, 1005000n);

// The odd interval, which is why the contract carries twice the price. A
// maximiser interval of [95, 106] clears at 100.5 and no rounded price exists.
eq("an odd interval halves in the product", notional(201n, 1000n), 100500n);
eq("and displays with the half", displayPrice(201n), "100.5");
eq(
    "halving the price first would lose it",
    notional(201n, 1000n) !== (201n / 2n) * 1000n,
    true,
);

// ---------------------------------------------------------------- formatting

eq("commitBond as HBAR", formatHbar(1000000n), "0.01000000");
eq("cancelFee as HBAR", formatHbar(100000n), "0.00100000");
eq("one whole HBAR", formatHbar(TINYBAR), "1.00000000");
eq("trimmed for a screen", formatHbar(1000000n, {decimals: 2}), "0.01");
eq("no decimals at all", formatHbar(TINYBAR, {decimals: 0}), "1");
eq("parseHbar round trips", parseHbar("0.01"), 1000000n);
eq("parseHbar takes eight places", parseHbar("0.00000001"), 1n);
eq("and whole numbers", parseHbar("12"), 1200000000n);

// --------------------------------------------------- the quantity, which is not

// `token.decimals` is 0 and `maxSupply` is 1,000,000.
eq("a quantity is a count", formatQuantity(1000n), "1000");
eq("and stays one", toUnits(1000n), 1000n);
eq("the whole supply", formatQuantity(1000000n), "1000000");

// ------------------------------------------------------------- the refusals

throws("a number is refused outright", () => toWeibar(1000000), "bigint");
throws("even a small one", () => toWeibar(1), "bigint");
throws("a negative amount", () => toWeibar(-1n), "negative");
throws("a quantity as a number", () => formatQuantity(1000), "bigint");
throws(
    "weibars that are not a whole number of tinybars",
    () => fromWeibar(10000000000000001n),
    "truncates",
);
throws("nine decimal places", () => parseHbar("0.000000001"), "eighth");
throws("not a decimal amount", () => parseHbar("0x01"), "not a decimal");
throws("a string with a sign", () => parseHbar("-1"), "not a decimal");
throws("more than eight display places", () => formatHbar(1n, {decimals: 9}), "0 to 8");

// ------------------------------------------------------------ the diagnosis

// The revert the deployment actually produced, verbatim from
// `superseded.why`: WrongBond(1000000, 10000000000000000).
eq(
    "the recorded revert is diagnosed as the venue's own parameter",
    diagnoseWrongBond(1000000n, 10000000000000000n),
    "the contract's own parameter is denominated in weibars, not the client's value: " +
        "this is the deployment bug in 296-venue.json's superseded block",
);
eq(
    "scaling twice is the client's",
    diagnoseWrongBond(10000000000000000n, 1000000n),
    "the value field was scaled to weibars twice: the contract's figure was already in tinybars",
);
eq(
    "and not scaling at all truncates to nothing",
    diagnoseWrongBond(0n, 1000000n),
    "the value field carried tinybars unscaled: the relay divides by 1e10 and an amount " +
        "this small truncates to nothing",
);
eq(
    "an ordinary wrong amount is not a units bug",
    diagnoseWrongBond(999999n, 1000000n),
    null,
);

// ------------------------------------------------------------------ the feed
//
// **These vectors are not written here.** They are the file
// `probes/oracle-median.py` produced and `venue/test/PrimeOracle.t.sol` replays,
// read from disk by both. One fixture, two consumers, neither of which computed
// the other's answer: if the client's copy of the median ever diverges from the
// contract's, one of the two suites fails rather than a screen quietly showing a
// mark the chain does not hold.

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, "../test/fixtures/median.json"), "utf8"));

eq("the price scale", PRICE_DECIMALS, 8);
eq("one unit of price", PRICE_ONE, 100000000n);

for (const [i, p] of fx.panels.entries()) {
    eq(`panel ${i} (${p.what})`, median(p.xs.map(BigInt)), BigInt(p.median));
}
eq("the fixture is the one the contract replays", fx.panelCount, fx.panels.length);

for (const d of fx.deviations) {
    eq(`deviation ${d.prev} -> ${d.next}`,
        deviationBps(BigInt(d.next), BigInt(d.prev)), BigInt(d.bps));
}

for (const m of fx.marks) {
    eq(`mark at price ${m.cleanPrice} rate ${m.usdPerHbar}`,
        markPerUnitTinybar(BigInt(m.cleanPrice), BigInt(m.usdPerHbar)),
        BigInt(m.markPerUnitTinybar));
}

// The lot multiply, against the numbers `venue/test/MarkToMarket.t.sol` opens a
// repo with: a thousand units of a bond at par, priced against HBAR/USD as
// `probes/chainlink-hedera.out` read it off chain 296.
eq(
    "a thousand units at par",
    markOfLot(10000000000n, 8152235n, 1000n),
    markPerUnitTinybar(10000000000n, 8152235n) * 1000n,
);

// A price is not an HBAR amount, and this is the vector that says so.
eq("par, formatted as the price it is", formatPrice(10000000000n), "100.00000000");
throws("a price is not a quantity", () => median([]), "non-empty");
throws("and a zero rate is not divided by", () => markPerUnitTinybar(1n, 0n), "zero");

if (bad) {
    console.error(`\n${bad} failing vector${bad === 1 ? "" : "s"}`);
    process.exit(1);
}
console.log("units: all vectors pass");
