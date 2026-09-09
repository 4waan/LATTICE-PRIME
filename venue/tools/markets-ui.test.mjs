import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

const template = readFileSync(new URL("../app/trade.template.html", import.meta.url), "utf8");
const runtime = readFileSync(new URL("./venue-app.mjs", import.meta.url), "utf8");
const oracleRuntime = readFileSync(new URL("./venue-obs.mjs", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/app.css", import.meta.url), "utf8");

function guidedHarness() {
    const Venue = {
        account: null,
        busy: false,
        snap: {commitBond: 1_000_000n, cancelFee: 100_000n},
        draftRecord: () => null,
    };
    const start = runtime.indexOf("Venue.orderFunds = function");
    const end = runtime.indexOf("\nVenue.paintGuidedOrder", start);
    assert.ok(start >= 0 && end > start, "guided order state should be extractable");
    runInNewContext(runtime.slice(start, end), {
        Venue,
        CLIENT: {immutables: {commitBond: "1000000", cancelFee: "100000"}},
        asBig: BigInt,
        buyEscrow: (price, quantity) => price * quantity,
        formatHbar: String,
        readableHbar: String,
        formatQuantity: String,
    });
    return Venue;
}

test("Markets hierarchy follows the trading journey", () => {
    for (const copy of [
        "Lattice Prime Repo Collateral 2028",
        "Price reference",
        "Available to trade",
        "Place an order",
        "Review and prepare",
        "Cash required before fees",
        "Your orders",
        "Global market records",
    ]) {
        assert.match(template, new RegExp(copy));
    }
    assert.match(template, /Losing every copy can forfeit the full deposit/);
    assert.match(template, /coupon reference fixes the variable rate under contract rules/);
    assert.match(template, /data-order-stage="review"[^>]*hidden/);
    assert.match(template, /data-order-stage="submit"[^>]*hidden/);
    assert.match(template, /data-order-stage="track"[^>]*hidden/);
    assert.match(template, /id="side" value="0"/);
    assert.match(template, /id="price"[^>]*value=""/);
    assert.match(template, /id="qty"[^>]*value=""/);
    assert.equal((template.match(/class="dia"/g) || []).length, 2);
    const accountIndex = template.indexOf('class="account-context"');
    const orderIndex = template.indexOf('id="order-panel"');
    const marketIndex = template.indexOf('class="auction-panel"');
    const ordersIndex = template.indexOf('id="active-orders"');
    assert.ok(
        accountIndex < orderIndex && orderIndex < marketIndex && marketIndex < ordersIndex,
        "account and order entry should precede the full-width market and orders",
    );
    const primary = template.slice(
        template.indexOf('<main class="wrap page markets-page">'),
        template.indexOf('<section class="market-support">'),
    );
    assert.doesNotMatch(primary, /\b(?:bytes32|uint128|abi\.encode|commit\(|reveal\()\b/i);
});

test("the order stages control which content is visible", () => {
    const sections = ["details", "review", "submit", "track"].map((stage) => ({
        dataset: {orderStage: stage},
        hidden: false,
    }));
    const elements = {
        "order-panel": {dataset: {}},
        "draft-state": {textContent: "", className: ""},
        "order-back": {hidden: true, textContent: ""},
    };
    const Venue = {orderStage: "details"};
    const start = runtime.indexOf("Venue.showOrderStage = function");
    const end = runtime.indexOf("\nVenue.paintOrderTrack", start);
    assert.ok(start >= 0 && end > start, "stage visibility logic should be extractable");
    runInNewContext(runtime.slice(start, end), {
        Venue,
        $: (id) => elements[id] || null,
        document: {querySelectorAll: () => sections},
    });

    for (const stage of ["details", "review", "submit", "track"]) {
        Venue.showOrderStage(stage);
        assert.equal(
            sections.filter((section) => !section.hidden).map((section) => section.dataset.orderStage).join(),
            stage,
        );
        assert.equal(elements["order-panel"].dataset.stage, stage);
    }
    assert.equal(elements["draft-state"].textContent, "Track order");
    assert.equal(elements["order-back"].hidden, true);
});

test("guided order action exposes every real prerequisite", () => {
    const Venue = guidedHarness();
    const wallet = "0x00000000000000000000000000000000000000aa";
    const buy = {
        side: 0, price: 105n, qty: 25n,
        salt: "0x" + "11".repeat(32), id: "0x" + "22".repeat(32),
        ok: true, bad: {},
    };

    assert.equal(Venue.guidedOrderState(buy).mode, "connect");
    Venue.account = wallet;
    Venue.snap.kyc = 0;
    assert.equal(Venue.guidedOrderState(buy).mode, "eligibility");
    Venue.snap.kyc = 1;
    Venue.snap.walletTinybar = 1n;
    assert.equal(Venue.guidedOrderState(buy).mode, "balance");
    assert.match(Venue.guidedOrderState(buy).blocker, /plus network fees/);
    Venue.snap.walletTinybar = 2_000_000n;
    Venue.snap.free = 24n;
    assert.equal(Venue.guidedOrderState({...buy, side: 1}).mode, "balance");
    Venue.snap.free = 25n;
    Venue.snap.walletTinybar = 999_999n;
    assert.equal(Venue.guidedOrderState({...buy, side: 1}).mode, "balance");
    Venue.snap.walletTinybar = 2_000_000n;
    assert.equal(Venue.guidedOrderState(buy).mode, "backup");
    Venue.draftRecord = () => ({id: buy.id});
    assert.equal(Venue.guidedOrderState(buy).mode, "commit");
    Venue.busy = true;
    assert.equal(Venue.guidedOrderState(buy).mode, "busy");

    const funds = Venue.orderFunds(buy);
    assert.equal(funds.bond, 1_000_000n);
    assert.equal(funds.fee, 100_000n);
    assert.equal(funds.limit, 2_625n);
    assert.equal(funds.reveal, 2_625n);
    assert.equal(funds.totalCash, 1_002_625n);
});

test("wallet stages prevent duplicate action and preserve recovery messaging", () => {
    const action = {
        disabled: false,
        textContent: "",
        attrs: new Map(),
        setAttribute(name, value) { this.attrs.set(name, value); },
    };
    const status = {textContent: "", className: ""};
    const Venue = {
        page: "trade",
        status: (_id, message, tone) => {
            status.textContent = message;
            status.className = tone;
        },
    };
    const start = runtime.indexOf("Venue.tradeTxStage = function");
    const end = runtime.indexOf("\nVenue.send = async function", start);
    assert.ok(start >= 0 && end > start, "wallet stage renderer should be extractable");
    runInNewContext(runtime.slice(start, end), {
        Venue,
        $: (id) => id === "commit" ? action : null,
    });

    Venue.tradeTxStage("pending", "Submit sealed order");
    assert.equal(action.disabled, true);
    assert.match(action.textContent, /pending/i);
    assert.equal(action.attrs.get("aria-busy"), "true");

    Venue.tradeTxStage("rejected", "Submit sealed order");
    assert.match(status.textContent, /order values and recovery key are unchanged/i);
    assert.equal(status.className, "bad");

    Venue.tradeTxStage("failed", "Submit sealed order", "RPC unavailable.");
    assert.match(status.textContent, /RPC unavailable\. Your order values and recovery key are unchanged/);
    assert.equal(status.className, "bad");

    Venue.tradeTxStage("confirmed", "Submit sealed order");
    assert.match(status.textContent, /confirmed/i);
    assert.equal(status.className, "ok");
});

test("withdrawal confirmation separates intent from the wallet transaction", async () => {
    let withdrawals = 0;
    let focused = "";
    const readyClasses = new Set();
    const withdrawCue = {textContent: ""};
    const elements = {
        "withdraw-modal": {hidden: true},
        "withdraw-confirm-amount": {textContent: ""},
        "withdraw-confirm": {focus: () => { focused = "confirm"; }},
        withdraw: {
            disabled: true,
            attrs: new Map(),
            classList: {
                toggle: (name, on) => on ? readyClasses.add(name) : readyClasses.delete(name),
            },
            querySelector: () => withdrawCue,
            setAttribute(name, value) { this.attrs.set(name, value); },
            focus: () => { focused = "withdraw"; },
        },
    };
    const Venue = {
        account: "0x00000000000000000000000000000000000000aa",
        busy: false,
        snap: {credit: 250_000n},
        doWithdraw: async () => { withdrawals++; },
    };
    const start = runtime.indexOf("Venue.openWithdrawConfirm = function");
    const end = runtime.indexOf("\nVenue.doWithdraw = async function", start);
    assert.ok(start >= 0 && end > start, "withdrawal confirmation should be extractable");
    runInNewContext(runtime.slice(start, end), {
        Venue,
        $: (id) => elements[id] || null,
        asBig: BigInt,
        readableHbar: String,
        setTimeout: (fn) => fn(),
    });

    Venue.openWithdrawConfirm();
    assert.equal(elements["withdraw-modal"].hidden, false);
    assert.equal(elements["withdraw-confirm-amount"].textContent, "250000 HBAR");
    assert.equal(focused, "confirm");
    Venue.paintWithdraw(250_000n);
    assert.equal(elements.withdraw.disabled, false);
    assert.equal(readyClasses.has("is-ready"), true);
    assert.match(elements.withdraw.attrs.get("aria-label"), /250000 HBAR/);
    assert.equal(withdrawCue.textContent, "Withdraw trading credit");
    Venue.closeWithdrawConfirm();
    assert.equal(elements["withdraw-modal"].hidden, true);
    assert.equal(focused, "withdraw");

    Venue.openWithdrawConfirm();
    await Venue.confirmWithdraw();
    assert.equal(withdrawals, 1);
    assert.equal(elements["withdraw-modal"].hidden, true);

    Venue.snap.credit = 0n;
    Venue.paintWithdraw(0n);
    assert.equal(elements.withdraw.disabled, true);
    assert.equal(readyClasses.has("is-ready"), false);
    assert.equal(withdrawCue.textContent, "No credit available");
    Venue.openWithdrawConfirm();
    assert.equal(elements["withdraw-modal"].hidden, true);
});

test("order deadlines preserve cancel, reveal, and forfeiture boundaries", () => {
    let current = 1_000n;
    const Venue = {};
    const start = runtime.indexOf("Venue.ticketPhase = function");
    const end = runtime.indexOf("\nfunction ticketChainKind", start);
    assert.ok(start >= 0 && end > start, "order phase logic should be extractable");
    runInNewContext(runtime.slice(start, end), {
        Venue,
        CLIENT: {immutables: {revealDelay: "30", revealWindow: "270"}},
        ZERO: "0x0000000000000000000000000000000000000000",
        asBig: BigInt,
        nowSec: () => current,
    });
    const chain = {
        committer: "0x00000000000000000000000000000000000000aa",
        committedAt: 1_000n,
        revealed: false,
        cancelled: false,
    };

    assert.equal(Venue.ticketPhase({}, chain).phase, "cancel");
    current = 1_030n;
    assert.equal(Venue.ticketPhase({}, chain).phase, "reveal");
    current = 1_300n;
    assert.equal(Venue.ticketPhase({}, chain).phase, "reveal");
    current = 1_301n;
    assert.equal(Venue.ticketPhase({}, chain).phase, "lost");
    assert.equal(Venue.ticketPhase({}, {...chain, cancelled: true}).phase, "cancelled");
    assert.equal(Venue.ticketPhase({}, {...chain, revealed: true}).phase, "done");
});

test("recovery import validates the commitment and keeps order receipts", () => {
    const committer = "0x00000000000000000000000000000000000000aa";
    const id = "0x" + "22".repeat(32);
    const hash = "0x" + "33".repeat(32);
    const context = {
        TICKET_VER: 1,
        ORDER_SCALE_LIMIT: 1n << 96n,
        ZERO: "0x0000000000000000000000000000000000000000",
        CLIENT: {
            network: {chainId: 296},
            addresses: {MatchingEngine: "0x00000000000000000000000000000000000000bb"},
        },
        addrEq: (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
        commitmentOf: () => id,
    };
    const start = runtime.indexOf("function ticketRecord");
    const end = runtime.indexOf("\nfunction canPickVaultFile", start);
    assert.ok(start >= 0 && end > start, "recovery validator should be extractable");
    runInNewContext(
        runtime.slice(start, end) + "\nthis.validateTicket = ticketRecord;",
        context,
    );
    const valid = {
        network: 296,
        engine: context.CLIENT.addresses.MatchingEngine,
        committer,
        side: 0,
        price: "105",
        qty: "25",
        salt: "0x" + "11".repeat(32),
        id,
        committedAt: "1000",
        commitTx: hash,
        revealed: true,
        revealTx: hash,
        crossTx: hash,
    };
    const restored = context.validateTicket(valid, committer);
    assert.equal(restored.commitTx, hash);
    assert.equal(restored.revealTx, hash);
    assert.equal(restored.crossTx, hash);
    assert.equal(restored.revealed, true);
    assert.throws(
        () => context.validateTicket({...valid, committer: context.ZERO}, committer),
        /invalid submitting wallet/,
    );
    context.commitmentOf = () => "0x" + "44".repeat(32);
    assert.throws(
        () => context.validateTicket(valid, committer),
        /do not match this order id/,
    );
});

test("Markets styles and oracle states stay responsive and honest", () => {
    assert.match(css, /\.market-main\{\s*display:grid;grid-template-columns:minmax\(18rem,2fr\) minmax\(0,3fr\)/);
    assert.match(css, /\.auction-panel\{grid-column:1\/-1;grid-row:2\}/);
    assert.match(css, /\.orders-section\{grid-column:1\/-1;grid-row:3\}/);
    assert.match(css, /\.balance-strip\{[\s\S]*?grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
    assert.match(css, /\.side-toggle button \.dia\{[\s\S]*?clip-path:polygon/);
    assert.match(css, /\.order-primary\{flex:1;width:auto;min-height:46px/);
    assert.match(css, /withdraw-ready-pulse/);
    assert.match(css, /live-market-pulse/);
    assert.match(css, /@media\(max-width:520px\)\{/);
    assert.match(css, /:focus-visible/);
    assert.match(template, /id="withdraw-modal" hidden/);
    assert.match(template, /id="withdraw-confirm">Yes, withdraw/);
    assert.match(template, /class="clock-float market-clock-float"/);
    assert.match(template, /id="market-tape" role="region" aria-label="Market activity records" tabindex="0"/);
    assert.doesNotMatch(template, /clock-inline|id="market-close"/);
    assert.match(css, /\.markets-page \.support-detail > summary span\{font-size:\.86rem\}/);
    assert.match(css, /\.markets-page #market-tape\{[\s\S]*?max-height:min\(52vh,30rem\);overflow-x:hidden;overflow-y:auto/);
    assert.match(css, /overscroll-behavior:contain;scrollbar-gutter:stable/);
    assert.match(runtime, /Auction · Round/);
    assert.match(runtime, /liveKicker\.classList\.toggle\("is-live"/);
    assert.match(oracleRuntime, /Venue\.page === "trade" \? \(dark \? "Unavailable" : "Live"\)/);
    assert.match(oracleRuntime, /Auction trading remains available with user-supplied limits/);
    assert.match(oracleRuntime, /box\.classList\.toggle\("is-unavailable"/);
});
