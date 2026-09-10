import assert from "node:assert/strict";
import test from "node:test";

import {
    cashAmountFromFraction,
    couponCashAmount,
    inclusiveFractionalFee,
} from "./bond-coupon-entitlements.mjs";

test("canonical coupon zero rounds per holder like CouponSchedule", () => {
    const terms = {
        faceValue: 10_000n,
        rateBps: 500n,
        accrualStart: 1_788_862_481n,
        dueAt: 1_788_866_081n,
    };
    assert.equal(couponCashAmount({...terms, lot: 3_000n}), 171n);
    assert.equal(couponCashAmount({...terms, lot: 1_000n}), 57n);
    assert.equal(couponCashAmount({...terms, lot: 4_000n}), 228n);
});

test("ATS fractional coupon converts to LPCASH before rounding", () => {
    const numerator = 10_000n * 100n * 500n * 1_200n;
    const denominator = 10_000n * 365n * 24n * 60n * 60n;
    assert.equal(cashAmountFromFraction(numerator, denominator, 2), 190n);
});

test("inclusive LPCASH fee applies the one-unit minimum", () => {
    assert.equal(inclusiveFractionalFee(171n, 25n, 10_000n, 1n), 1n);
    assert.equal(inclusiveFractionalFee(57n, 25n, 10_000n, 1n), 1n);
    assert.equal(inclusiveFractionalFee(0n, 25n, 10_000n, 1n), 0n);
});

test("invalid fractional inputs are rejected", () => {
    assert.throws(() => cashAmountFromFraction(1n, 0n, 2), /denominator/);
    assert.throws(
        () =>
            couponCashAmount({
                lot: 1n,
                faceValue: 1n,
                rateBps: 1n,
                accrualStart: 2n,
                dueAt: 1n,
            }),
        /precede/,
    );
});
