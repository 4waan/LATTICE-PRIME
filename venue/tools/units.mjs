// The three denominations, and the conversions between the two that are
// denominations at all.
//
// **This file exists because the venue was deployed once with `commitBond` at
// `0.01 ether`.** `msg.value` inside the Hedera EVM is tinybars, not weibars, so
// that literal asked for a hundred million HBAR, every `commit` reverted
// `WrongBond(1000000, 10000000000000000)`, and `Regime.bootstrapSupervisor`
// being single-use meant the regime, the parameter root and everything seated
// under them had to come down and go back up. Nothing in `src/` was wrong. One
// number in a deploy script was in the wrong unit.
//
// `deployments/296-venue.json` records the whole episode under `superseded`, and
// the ratio was measured at two points rather than assumed: 1e18 weibar arrives
// as 1e8, 5e18 as 5e8.
//
// ## The three quantities
//
// | quantity | unit | where |
// |---|---|---|
// | `commitBond`, `cancelFee`, `credit`, buy escrow, `notional` | tinybar, 1 HBAR = 1e8 | anything a contract returns or stores |
// | a transaction's `value` field | weibar, 1 HBAR = 1e18 | anything handed to the relay |
// | `qty`, `balanceOfByPartition`, `filled` | **no decimals at all** | the bond was issued `decimals: 0` |
//
// The third is the trap, because it looks like the other two. A balance of
// `1000` is a thousand bonds. `formatUnits` on it produces `0.00000000001`, which
// is a number, is wrong, and reads as plausible.
//
// `parseEther` and `formatEther` assume eighteen decimals and are wrong in both
// directions here. Nothing in this file calls them and a client should not
// either.
//
// ## Why these are `bigint` and never `number`
//
// A JavaScript `number` holds integers exactly only below 2^53. One HBAR in
// weibars is 1e18, which is past that, so `Number(1e18) + 1` is `1e18` and a
// rounding error becomes a value the relay accepts and the contract refuses.
// Every function here takes and returns `bigint` and throws on anything else,
// including on a `number` that would convert cleanly, because the one that
// converts cleanly today is the one that does not tomorrow.

/// Tinybars in one HBAR. `msg.value` inside the Hedera EVM is denominated here.
export const TINYBAR = 10n ** 8n;

/// Weibars in one HBAR. What a transaction's `value` field carries.
export const WEIBAR = 10n ** 18n;

/// The relay divides `value` by this before the EVM sees it. Measured, not
/// assumed: `deployments/296-venue.json` `superseded.why` records the two points.
export const WEIBAR_PER_TINYBAR = WEIBAR / TINYBAR; // 1e10

/// The bond's decimals, read off the deployment rather than guessed. Zero, so a
/// quantity is a count and never a fixed-point number.
export const BOND_DECIMALS = 0;

class UnitError extends RangeError {}

function big(v, what) {
    if (typeof v !== "bigint") {
        throw new UnitError(
            `${what} must be a bigint, got ${typeof v}. A number loses precision above 2^53 ` +
            `and one HBAR in weibars is 1e18, which is past it.`
        );
    }
    if (v < 0n) throw new UnitError(`${what} must not be negative`);
    return v;
}

// ------------------------------------------------------------- the conversion

/// Tinybars to the weibars a transaction's `value` field carries.
/// @dev Exact by construction: the ratio is a power of ten and tinybars are the
///      finer of the two on the contract side, so nothing is ever lost going out.
export function toWeibar(tinybar) {
    return big(tinybar, "tinybar") * WEIBAR_PER_TINYBAR;
}

/// Weibars back to tinybars. **Throws on a remainder rather than truncating.**
/// @dev A weibar amount that is not a whole number of tinybars is one the EVM
///      never saw: the relay truncates, so the contract's view and the client's
///      differ by exactly the part this would have silently dropped. A value the
///      chain will round is a value the client got wrong, and the right moment to
///      say so is before it is sent.
export function fromWeibar(weibar) {
    const w = big(weibar, "weibar");
    if (w % WEIBAR_PER_TINYBAR !== 0n) {
        throw new UnitError(
            `${w} weibar is not a whole number of tinybars. The relay truncates, so this ` +
            `value reaches the EVM as ${w / WEIBAR_PER_TINYBAR} tinybar and the difference ` +
            `is gone. Round before converting, deliberately.`
        );
    }
    return w / WEIBAR_PER_TINYBAR;
}

// ------------------------------------------------------------- the formatting

/// Tinybars as HBAR, for display only. A string, because the value does not fit
/// a `number` and a display is the one place it does not have to.
export function formatHbar(tinybar, {decimals = 8} = {}) {
    const t = big(tinybar, "tinybar");
    if (decimals < 0 || decimals > 8) throw new UnitError("decimals must be 0 to 8");
    const whole = t / TINYBAR;
    const frac = (t % TINYBAR).toString().padStart(8, "0").slice(0, decimals);
    return decimals === 0 ? `${whole}` : `${whole}.${frac}`;
}

/// HBAR, as a decimal string, to tinybars. Rejects more than eight decimal
/// places rather than rounding them away.
export function parseHbar(s) {
    if (typeof s !== "string") throw new UnitError("parseHbar takes a string");
    const m = /^(\d+)(?:\.(\d*))?$/.exec(s.trim());
    if (!m) throw new UnitError(`not a decimal amount: ${JSON.stringify(s)}`);
    const frac = m[2] ?? "";
    if (frac.length > 8) {
        throw new UnitError(
            `${s} has ${frac.length} decimal places and a tinybar is the eighth. ` +
            `The extra digits cannot be represented and are not dropped silently.`
        );
    }
    return BigInt(m[1]) * TINYBAR + BigInt(frac.padEnd(8, "0") || "0");
}

// ---------------------------------------------------------- the third quantity

/// A bond quantity, on its way to a contract. Identity, and that is the point.
/// @dev The bond was issued `decimals: 0`, so a quantity is a count of bonds and
///      scaling it by anything produces a different order. This exists so a call
///      site that wants to be explicit can be, and so `formatQuantity` below has
///      an inverse to point at.
export function toUnits(qty) {
    return big(qty, "qty");
}

/// A bond quantity, for display. Also identity, and it throws if you hand it
/// anything with a decimal point.
/// @dev **The bug this catches is `formatUnits(qty, 8)`**, which turns a thousand
///      bonds into `0.00001` and looks like a number rather than like a mistake.
///      There is no denomination here to convert to or from.
export function formatQuantity(qty) {
    return big(qty, "qty").toString();
}

// ------------------------------------------------------------ the venue's own

/// The buy escrow, in tinybars. `price * qty`, and both are contract units.
/// @dev `MatchingEngine.reveal` refuses `WrongEscrow(sent, want)` on anything
///      else, so this is the whole of the buyer's arithmetic. `price` is
///      tinybars per bond and `qty` is a count, so the product is tinybars and
///      no scaling enters.
export function buyEscrow(price, qty) {
    return big(price, "price") * big(qty, "qty");
}

/// `CallAuction.notional`, transcribed. `priceTwice * qty / 2`.
/// @dev **`priceTwice` is twice the clearing price.** The uniform price is the
///      midpoint of the maximiser interval and does not exist as a rounded
///      number, so the contract returns `lo + hi` and the halving happens once,
///      here, against the product. Halving the price first and multiplying would
///      lose the odd case, which is every crossing whose interval has odd width.
export function notional(priceTwice, qty) {
    return (big(priceTwice, "priceTwice") * big(qty, "qty")) / 2n;
}

/// The clearing price, for display only, as a decimal string.
/// @dev Never feed this back into arithmetic. `priceTwice` is the number the
///      contract holds and `notional` is defined against it; a price rounded for
///      a screen is a price that no longer multiplies out.
export function displayPrice(priceTwice) {
    const p = big(priceTwice, "priceTwice");
    return p % 2n === 0n ? `${p / 2n}` : `${p / 2n}.5`;
}

// -------------------------------------------------------------- the feed

/// Decimals on every price this venue reads or publishes.
/// @dev Eight, and it is the same eight on both legs of the composite mark.
///      `PrimeOracle.DECIMALS` is the contract's copy. The number is Chainlink's
///      rather than the venue's: every feed Chainlink runs on Hedera answers
///      with eight, measured across all seven in `probes/chainlink-hedera.out`,
///      and `PrimeOracle._requireEightDecimals` refuses a feed that does not, so
///      there is one price scale in this repository and not two.
///
///      **This is a fourth quantity and it is not a denomination of HBAR.** A
///      clean price of `10000000000` is 100.00 USD per unit of face, not 100
///      HBAR and not 1e10 tinybars. Reading it with `formatHbar` produces
///      `100.00000000`, which is the right digits for the wrong reason and will
///      be wrong the moment either scale moves.
export const PRICE_DECIMALS = 8;

/// One unit of price, in the fixed-point the feed publishes.
export const PRICE_ONE = 10n ** 8n;

/// `PrimeOracle.markPerUnitTinybar`, transcribed.
///
/// @dev The venue's clean price is USD per unit of face and the venue settles
///      in tinybars, so the mark needs a rate between them. Both legs carry
///      eight decimals, so the scale cancels and what is left is HBAR per unit;
///      multiplying by `TINYBAR` before dividing keeps the answer in whole
///      tinybars rather than throwing the fraction away.
///
///      **The division floors, and the direction is deliberate.** A lower mark
///      is a position closer to a margin call, which is toward the lender and
///      away from the party the call is taken against. The loss is at most one
///      tinybar per unit of face. `venue/src/oracle/OracleMath.sol` states the
///      same thing about the median of an even panel.
export function markPerUnitTinybar(cleanPrice, usdPerHbar) {
    const p = big(cleanPrice, "cleanPrice");
    const r = big(usdPerHbar, "usdPerHbar");
    if (r === 0n) {
        throw new UnitError(
            "usdPerHbar is zero. PrimeOracle refuses a non-positive upstream answer " +
            "rather than dividing by it, and so does this."
        );
    }
    return (p * TINYBAR) / r;
}

/// The whole mark on a repo: the price per unit times the lot.
/// @dev `RepoVault.markToMarket` computes exactly this and stores none of it.
///      The lot is a count, because the bond was issued `decimals: 0`, so no
///      scaling enters on that side either.
export function markOfLot(cleanPrice, usdPerHbar, lot) {
    return markPerUnitTinybar(cleanPrice, usdPerHbar) * big(lot, "lot");
}

/// A price the feed publishes, as a decimal string in its own currency.
/// @dev Display only, and deliberately not `formatHbar`: the unit is USD per
///      unit of face and calling it HBAR is the same class of error as reading a
///      bond quantity with eighteen decimals.
export function formatPrice(cleanPrice) {
    const p = big(cleanPrice, "cleanPrice");
    return `${p / PRICE_ONE}.${(p % PRICE_ONE).toString().padStart(PRICE_DECIMALS, "0")}`;
}

/// `OracleMath.median`, transcribed. Sorted middle; even panels take the floor
/// of the mean of the two middle.
/// @dev The even rule is Chainlink's, whose `Median.sol` averages the two middle
///      values. The client carries a copy because a screen that shows a panel
///      should be able to show what the panel decided without a second call, and
///      `venue/test/PrimeOracle.t.sol` replays the same fixture file this one is
///      checked against, so the two cannot drift.
export function median(xs) {
    if (!Array.isArray(xs) || xs.length === 0) {
        throw new UnitError("median takes a non-empty array");
    }
    const a = xs.map((x, i) => big(x, `xs[${i}]`)).sort((p, q) => (p < q ? -1 : p > q ? 1 : 0));
    const n = a.length;
    return n % 2 === 1 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2n;
}

/// `OracleMath.deviationBps`. How far `a` sits from `b`, in basis points of `b`.
export function deviationBps(a, b) {
    const x = big(a, "a");
    const y = big(b, "b");
    if (y === 0n) return 0n;
    const d = x > y ? x - y : y - x;
    return (d * 10_000n) / y;
}

// ------------------------------------------------------------------ the coupon

/// Basis points in one hundred percent.
export const BPS = 10_000n;

/// The year `CouponMath` accrues against. ACT/365, so a fixed 365 days and never
/// a calendar year: 2028 is a leap year and the bond's coupon does not know it.
export const COUPON_YEAR = 365n * 24n * 60n * 60n;

/// The largest coupon `CouponMath` will accrue at. One hundred percent.
export const MAX_RATE_BPS = BPS;

/// `CouponMath.couponBps`, transcribed. The published reference plus the
/// schedule's spread, which is the whole of what makes this bond variable rate.
/// @dev Refuses over the cap rather than saturating at it, because a schedule
///      that quietly clamped would pay a coupon nobody agreed to. `CouponSchedule`
///      calls this in its constructor so a spread that could never accrue is a
///      schedule that cannot be deployed.
export function couponBps(refRateBps, spreadBps) {
    const r = big(refRateBps, "refRateBps") + big(spreadBps, "spreadBps");
    if (r > MAX_RATE_BPS) {
        throw new UnitError(
            `coupon rate ${r} bps is over the ${MAX_RATE_BPS} bp cap. ` +
            "CouponMath.RateTooLarge refuses this rather than clamping to it."
        );
    }
    return r;
}

/// `CouponMath.accrue`, transcribed. The coupon on `lot` units over `[from, to)`.
///
/// @dev **Rounds down, where `RepoMath.accrued` and this file's repo arithmetic
///      round up, and the difference is not an inconsistency.** `RepoMath` prices
///      what a borrower owes and rounds so the borrower never repays less than
///      the contract says. This prices what an issuer owes out of a pool funded
///      in advance, and rounding up there means a set of entitlements whose sum
///      exceeds what was funded: a rounding choice turning into a payment that
///      fails at the last claimant. `CouponDistributor` bounds each coupon by its
///      own pool for the same reason from the other side.
///
///      **The multiplication order is the contract's and not a convenience.**
///      Every factor first, one division last. Dividing early throws away a
///      fraction the remaining factors would have recovered, and on the bond's
///      `maxSupply` of a million that is a missing coupon rather than a rounding
///      error. JavaScript `bigint` has no overflow to trade against, so the only
///      reason to keep the order is that a client which divided in a different
///      place would answer a different number than the chain, which is the whole
///      point of this file.
export function couponAccrual({lot, faceValue, rateBps, from, to}) {
    const l = big(lot, "lot");
    const f = big(faceValue, "faceValue");
    const r = big(rateBps, "rateBps");
    const a = big(from, "from");
    const b = big(to, "to");
    if (b < a) {
        throw new UnitError(
            `period runs backwards: ${a} to ${b}. CouponMath.PeriodNotOrdered.`
        );
    }
    if (r > MAX_RATE_BPS) {
        throw new UnitError(`rate ${r} bps is over the ${MAX_RATE_BPS} bp cap.`);
    }
    return (l * f * r * (b - a)) / (BPS * COUPON_YEAR);
}

/// The coupon on one repo's lot, given what the feed published.
/// @dev The four reads `RepoVault.noteCoupon` makes, in the order it makes them,
///      so a screen can show what a `noteCoupon` will find before anybody sends
///      one. `couponOwed` on the vault answers the same number from the chain and
///      this is what a client compares it against.
export function couponOnLot({lot, faceValue, spreadBps, refRateBps, accrualStart, dueAt}) {
    return couponAccrual({
        lot,
        faceValue,
        rateBps: couponBps(refRateBps, spreadBps),
        from: accrualStart,
        to: dueAt,
    });
}

// ------------------------------------------------------------- the diagnosis

/// Reads a `WrongBond(sent, want)` and names which of the three units mistakes
/// produced it, or `null` when it is an ordinary wrong amount.
///
/// @dev The one revert a client will actually hit, and "you sent the wrong
///      amount" and "the denominations are crossed" are different bugs with
///      different fixes. `MatchingEngine` cannot tell them apart, because by the
///      time it runs there is one number and no unit attached. The ratio can.
///
///      Three cases, and the third is the one that actually happened.
///
///      - **`sent == want * 1e10`.** The `value` field was scaled twice. The
///        contract's figure is already tinybars, so it needs `toWeibar` once;
///        applying an eighteen-decimal parse to a figure that was in tinybars
///        applies it again.
///      - **`sent == 0` against a non-zero `want`.** The `value` field carried a
///        raw tinybar figure and the relay divided it by 1e10. Every amount this
///        venue deals in is below 1e10 tinybars, so the division truncates to
///        nothing and the contract sees a call with no value at all.
///      - **`want == sent * 1e10`.** Not the client. The **contract's own
///        parameter** is in weibars, which is `deployments/296-venue.json`'s
///        `superseded` block verbatim: the first venue set `commitBond` to
///        `0.01 ether`, the revert read `WrongBond(1000000, 10000000000000000)`,
///        and no client-side change could have fixed it. A page that reports
///        this as the user's mistake sends them looking in the wrong place.
export function diagnoseWrongBond(sent, want) {
    const s = big(sent, "sent");
    const w = big(want, "want");
    if (w !== 0n && s === w * WEIBAR_PER_TINYBAR) {
        return "the value field was scaled to weibars twice: the contract's figure was " +
            "already in tinybars";
    }
    if (w !== 0n && s === 0n) {
        return "the value field carried tinybars unscaled: the relay divides by 1e10 and " +
            "an amount this small truncates to nothing";
    }
    if (s !== 0n && w === s * WEIBAR_PER_TINYBAR) {
        return "the contract's own parameter is denominated in weibars, not the client's " +
            "value: this is the deployment bug in 296-venue.json's superseded block";
    }
    return null;
}

export {UnitError};
