import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {keccak_256} from "./keccak.mjs";

const template = readFileSync(
    new URL("../app/position.template.html", import.meta.url),
    "utf8",
);
const runtime = readFileSync(new URL("./venue-app.mjs", import.meta.url), "utf8");
const observability = readFileSync(new URL("./venue-obs.mjs", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/app.css", import.meta.url), "utf8");

function extract(startNeedle, endNeedle) {
    const start = runtime.indexOf(startNeedle);
    const end = runtime.indexOf(endNeedle, start);
    assert.ok(start >= 0 && end > start, startNeedle + " should be extractable");
    return runtime.slice(start, end);
}

function hex(bytes) {
    return "0x" + [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytes(value) {
    return Uint8Array.from(
        String(value).replace(/^0x/, "").match(/../g)?.map((part) => Number.parseInt(part, 16)) || [],
    );
}

function word(type, value) {
    if (type === "bytes32") {
        return String(value).replace(/^0x/, "").padStart(64, "0");
    }
    if (type === "uint256") {
        return BigInt(value).toString(16).padStart(64, "0");
    }
    throw new Error("unsupported test ABI type " + type);
}

const fakeEthers = {
    AbiCoder: {
        defaultAbiCoder: () => ({
            encode: (types, values) =>
                "0x" + types.map((type, index) => word(type, values[index])).join(""),
        }),
    },
    zeroPadValue: (value, size) =>
        "0x" + String(value).replace(/^0x/, "").padStart(size * 2, "0"),
    keccak256: (value) => hex(keccak_256(bytes(value))),
};

test("Portfolio hierarchy leads with personal money and defers evidence", () => {
    const order = [
        'class="portfolio-summary"',
        'id="needs-box"',
        'class="portfolio-core"',
        'class="portfolio-section financing-section"',
        'class="portfolio-section activity-section"',
    ].map((needle) => template.indexOf(needle));
    assert.ok(order.every((index) => index >= 0));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    for (const copy of [
        "Bonds owned",
        "Trading proceeds",
        "Coupon income available",
        "Your holdings",
        "Available",
        "Reserved",
        "Activity and records",
        "One transaction receipt, not complete account history",
    ]) {
        assert.match(template, new RegExp(copy));
    }
    const primary = template.slice(
        template.indexOf('<section class="portfolio-summary"'),
        template.indexOf('<section class="portfolio-section activity-section"'),
    );
    assert.doesNotMatch(primary, /ceilingFor|wouldDisclose|spentBits|breakingSize/);
    assert.match(template, /Disclosure evidence and verification/);
    assert.match(template, /Withheld venue speech is not a private blockchain transaction/);
    assert.match(observability, /Number\(instrument\.basis\) === 1\s*\?\s*"Actual\/365"/);
});

test("position rendering preserves available plus reserved accounting", () => {
    const ids = [
        "pos-total", "pos-available", "pos-reserved", "pos-credit",
        "holding-total", "holding-available", "holding-reserved",
        "in-eligibility", "holding-reserve-detail", "in-balance",
        "holding-card", "holding-empty", "holding-unavailable",
        "finance-credit-summary", "pos-vault-credit",
    ];
    const elements = Object.fromEntries(ids.map((id) => [
        id,
        {textContent: "", innerHTML: "", hidden: false},
    ]));
    const Venue = {
        financing: {ready: false},
        paintWithdraw: () => {},
        paintVaultWithdraw: () => {},
        paintPortfolioOrders: () => {},
        paintPortfolioReference: () => {},
        paintNeeds: () => {},
    };
    runInNewContext(
        extract("Venue.paintPositionState = function", "\nVenue.refreshPosition = async function"),
        {
            Venue,
            $: (id) => elements[id] || null,
            readableQuantity: String,
            readableHbar: String,
            esc: String,
        },
    );

    Venue.positionState = {
        viewer: "0x01",
        total: 25n,
        totalReliable: true,
        free: 20n,
        freeKnown: true,
        held: 5n,
        heldKnown: true,
        credit: 7n,
        creditKnown: true,
        vaultCredit: null,
        vaultCreditKnown: false,
        kyc: 1,
        kycKnown: true,
        knownHolds: [{amount: 5n, reason: "Sell order reservation", holdId: "9"}],
        orders: [],
    };
    Venue.paintPositionState();
    assert.equal(elements["pos-total"].textContent, "25");
    assert.equal(elements["pos-available"].textContent, "20");
    assert.equal(elements["pos-reserved"].textContent, "5");
    assert.equal(elements["in-balance"].textContent, "25 = 20 available + 5 reserved");
    assert.match(elements["holding-reserve-detail"].innerHTML, /5 LPRC.*Sell order reservation/);

    Venue.positionState.totalReliable = false;
    Venue.paintPositionState();
    assert.equal(elements["pos-total"].textContent, "Unavailable");
    assert.equal(elements["pos-available"].textContent, "20");
    assert.equal(elements["pos-reserved"].textContent, "5");
    assert.match(elements["in-balance"].textContent, /disagree/);

    Venue.positionState.totalReliable = true;
    Venue.positionState.total = 0n;
    Venue.positionState.free = 0n;
    Venue.positionState.held = 0n;
    Venue.paintPositionState();
    assert.equal(elements["holding-card"].hidden, true);
    assert.equal(elements["holding-empty"].hidden, false);

    Venue.positionState = {viewer: null};
    Venue.paintPositionState();
    assert.equal(elements["pos-total"].textContent, "Unavailable");
    assert.equal(elements["holding-unavailable"].hidden, false);
});

test("attention stays hidden for routine state and appears for consequences", () => {
    const box = {hidden: false};
    const out = {innerHTML: ""};
    const Venue = {
        positionState: {
            orders: [],
            kycKnown: true,
            kyc: 1,
        },
        portfolioFinancing: {positions: []},
        snap: {},
    };
    runInNewContext(
        extract("Venue.paintNeeds = function", "\nVenue.refreshDisclosure = async function"),
        {
            Venue,
            $: (id) => id === "needs-box" ? box : id === "needs-out" ? out : null,
            esc: String,
            asBig: BigInt,
            nowSec: () => 1_000n,
        },
    );
    Venue.paintNeeds("0x01");
    assert.equal(box.hidden, true);

    Venue.positionState.orders = [{phase: {phase: "reveal"}}];
    Venue.paintNeeds("0x01");
    assert.equal(box.hidden, false);
    assert.match(out.innerHTML, /requires.*reveal now/);

    Venue.positionState.orders = [];
    Venue.portfolioFinancing = {
        positions: [{alert: {}, preview: {dark: true}}],
        feed: {dark: true},
    };
    Venue.paintNeeds("0x01");
    assert.match(out.innerHTML, /risk valuation is unavailable/);
    assert.doesNotMatch(runtime, /Trading proceeds are available to withdraw/);

    Venue.portfolioFinancing = {
        positions: [{
            alert: {defaultable: true, called: false, cureDeadline: 0n},
            preview: {breach: true},
        }],
        feed: {dark: false},
    };
    Venue.paintNeeds("0x01");
    assert.match(out.innerHTML, /eligible for default/);
    assert.doesNotMatch(out.innerHTML, /collateral shortfall/);
});

test("coupon quote and positional proof validation match the configured mechanics", () => {
    const CLIENT = {
        coupon: {
            cashToken: {
                fractionalFee: {
                    numerator: "25",
                    denominator: "10000",
                    minimum: "1",
                    maximum: "0",
                    netOfTransfers: false,
                },
            },
        },
    };
    const Venue = {};
    runInNewContext(
        extract("Venue.couponFeeQuote = function", "\nVenue.couponRowStatus = function"),
        {Venue, CLIENT, asBig: BigInt, ethers: fakeEthers},
    );
    assert.deepEqual(
        {...Venue.couponFeeQuote(10_000n)},
        {
            known: true,
            numerator: 25n,
            denominator: 10_000n,
            minimum: 1n,
            maximum: 0n,
            fee: 25n,
            net: 9_975n,
            chargedOnTop: false,
        },
    );
    assert.equal(Venue.couponFeeQuote(100n).fee, 1n);
    assert.equal(Venue.couponFeeQuote(100n).net, 99n);

    const text = new TextEncoder();
    const leafDomain = hex(keccak_256(text.encode("hedera2026.coupon.entitlement.leaf.v1")));
    const nodeDomain = hex(keccak_256(text.encode("hedera2026.coupon.entitlement.node.v1")));
    const coder = fakeEthers.AbiCoder.defaultAbiCoder();
    const coupon = 2;
    const holders = [
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
        "0x0000000000000000000000000000000000000003",
    ];
    const amounts = [100n, 200n, 300n];
    const leaves = holders.map((holder, index) => fakeEthers.keccak256(coder.encode(
        ["bytes32", "uint256", "bytes32", "uint256"],
        [leafDomain, coupon, fakeEthers.zeroPadValue(holder, 32), amounts[index]],
    )));
    const node = (left, right) => fakeEthers.keccak256(coder.encode(
        ["bytes32", "bytes32", "bytes32"],
        [nodeDomain, left, right],
    ));
    const left = node(leaves[0], leaves[1]);
    const root = node(left, leaves[2]);
    const proof = {
        index: coupon,
        holder: holders[2],
        position: 2n,
        amount: amounts[2],
        proof: [left],
    };
    const declaration = {root, holders: 3n};
    const domains = {leaf: leafDomain, node: nodeDomain};
    assert.equal(Venue.verifyCouponProof(proof, declaration, domains), true);
    assert.equal(
        Venue.verifyCouponProof({...proof, proof: [left, leaves[0]]}, declaration, domains),
        false,
    );
    assert.equal(
        Venue.verifyCouponProof({...proof, amount: 301n}, declaration, domains),
        false,
    );
    delete CLIENT.coupon.cashToken.fractionalFee;
    assert.equal(Venue.couponFeeQuote(300n).known, false);
});

test("Portfolio wallet states lock actions and explain rejection", () => {
    const makeAction = (disabled) => ({
        disabled,
        dataset: {},
        attrs: new Map(),
        setAttribute(name, value) { this.attrs.set(name, value); },
    });
    const actions = [makeAction(false), makeAction(true)];
    const status = {message: "", tone: ""};
    const Venue = {
        page: "position",
        status: (_id, message, tone) => {
            status.message = message;
            status.tone = tone;
        },
    };
    runInNewContext(
        extract("Venue.positionTxStage = function", "\nVenue.send = async function"),
        {
            Venue,
            document: {querySelectorAll: () => actions},
        },
    );
    Venue.positionTxStage("approval", "Claim coupon");
    assert.equal(actions[0].disabled, true);
    assert.equal(actions[0].attrs.get("aria-busy"), "true");
    Venue.positionTxStage("rejected", "Claim coupon");
    assert.equal(actions[0].disabled, false);
    assert.equal(actions[1].disabled, true);
    assert.match(status.message, /No Portfolio transaction was sent/);
    assert.equal(status.tone, "bad");
});

test("an unknown financing ID does not invent risk or economics", () => {
    const Venue = {
        viewer: () => "0x1111111111111111111111111111111111111111",
        portfolioDate: () => "Unavailable",
    };
    runInNewContext(
        extract(
            "Venue.financingPositionHtml = function",
            "\nVenue.portfolioFinancingContextHtml = function",
        ),
        {
            Venue,
            addrEq: (left, right) => left === right,
            asBig: BigInt,
            esc: String,
            shortId: String,
            readableQuantity: String,
            readableHbar: String,
            readableBps: String,
        },
    );
    const html = Venue.financingPositionHtml({
        id: "0x" + "0".repeat(64),
        state: "NOT FOUND",
        known: false,
        offered: false,
        readError: false,
        borrower: null,
        lender: null,
        collateral: 0n,
        principal: 0n,
        maturity: 0n,
        cureDeadline: 0n,
        repoRateBps: 0n,
        repurchase: 0n,
        preview: {dark: true, breach: false},
        alert: null,
    }, true);
    assert.match(html, /No funded offer or agreement was found for this ID/);
    assert.match(html, /No agreement economics available/);
    assert.doesNotMatch(html, /Repurchase now|price feed is stale/);

    const offer = Venue.financingPositionHtml({
        id: "0x" + "1".repeat(64),
        state: "FUNDED OFFER",
        known: true,
        offered: true,
        readError: false,
        borrower: "0x2222222222222222222222222222222222222222",
        lender: "0x3333333333333333333333333333333333333333",
        collateral: 10n,
        principal: 20n,
        maturity: 30n,
        cureDeadline: 0n,
        repoRateBps: 125n,
        repurchase: 0n,
        preview: {dark: true, breach: true},
        alert: null,
    }, true);
    assert.match(offer, /The lender has funded this offer/);
    assert.match(offer, /Repo rate 125/);
    assert.doesNotMatch(offer, /Repurchase now|price feed is stale|maintenance shortfall/);
});

test("financing discovery and records state their actual coverage", () => {
    assert.match(runtime, /Venue\.history\("RepoVault", \{limit: 25\}\)/);
    assert.match(runtime, /Automatic coverage checks up to 25 recent vault events/);
    assert.doesNotMatch(runtime, /\bloadRepos\(/);
    assert.match(runtime, /addrEq\(position\.borrower, who\) \|\| addrEq\(position\.lender, who\)/);
    assert.match(runtime, /An empty result does not prove that the account has no financing obligations/);
    assert.match(template, /Use an exact ID for agreements outside the recent mirror window/);
    assert.match(template, /Lookup is read only/);
    assert.match(runtime, /Margin events may be withheld; current contract state is shown/);
});

test("Portfolio styling preserves desktop hierarchy and mobile priority", () => {
    assert.match(css, /\.portfolio-summary-grid\{\s*display:grid;grid-template-columns:1\.15fr 1fr 1fr/);
    assert.match(css, /\.portfolio-core\{\s*display:grid;grid-template-columns:minmax\(0,1\.52fr\) minmax\(310px,\.86fr\)/);
    assert.match(css, /\.portfolio-page \.income-section\{[\s\S]*?padding:1\.2rem 1\.3rem/);
    assert.match(css, /\.holding-card > summary\{[\s\S]*?grid-template-columns:3\.2rem/);
    assert.match(css, /@media\(max-width:620px\)\{/);
    assert.match(css, /\.portfolio-summary-grid:has\(#finance-credit-summary:not\(\[hidden\]\)\)/);
    assert.match(css, /\.portfolio-page :focus-visible/);
    assert.match(css, /\.portfolio-file input\{[\s\S]*?display:block/);
    assert.match(css, /@media\(prefers-reduced-motion:no-preference\)/);
    assert.match(template, /id="withdraw-modal" hidden/);
    assert.match(template, /aria-modal="true"/);
});
