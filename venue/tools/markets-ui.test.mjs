import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext, Script} from "node:vm";

const template = readFileSync(new URL("../app/trade.template.html", import.meta.url), "utf8");
const runtime = readFileSync(new URL("./venue-app.mjs", import.meta.url), "utf8");
const oracleRuntime = readFileSync(new URL("./venue-obs.mjs", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/app.css", import.meta.url), "utf8");

function flattenInline(rel) {
    return readFileSync(new URL("../" + rel, import.meta.url), "utf8")
        .split("\n")
        .filter((line) => !/^import\s/.test(line))
        .map((line) => line.replace(/^export\s+/, ""))
        .join("\n");
}

test("Markets inlined runtime parses as one browser script", () => {
    const files = [...template.matchAll(/\/\*INLINE ([^*]+)\*\//g)]
        .map((match) => match[1].trim())
        .filter((rel) => rel.endsWith(".mjs"));
    assert.ok(files.includes("tools/private-session-vault.mjs"));
    assert.ok(files.includes("tools/private-secret-vault.mjs"));
    const source = files.map(flattenInline).join("\n") + '\nVenue.boot("trade");\n';
    new Script(source, {filename: "trade-inline.js"});
});

function guidedHarness() {
    const Venue = {
        account: null,
        busy: false,
        snap: {commitBond: 1_000_000n, cancelFee: 100_000n},
        draftRecord: () => null,
        ticketVaultReady: () => Venue.vaultReady,
        vaultReady: false,
        _exportedTickets: new Set(),
        _liveHolds: [],
    };
    const start = runtime.indexOf("Venue.orderFunds = function");
    const end = runtime.indexOf("\nVenue.paintGuidedOrder", start);
    assert.ok(start >= 0 && end > start, "guided order state should be extractable");
    runInNewContext(runtime.slice(start, end), {
        Venue,
        CLIENT: {
            immutables: {commitBond: "1000000", cancelFee: "100000"},
            privateTrading: {
                enabled: true,
                buyEnabled: true,
                sellEnabled: true,
                gasObserved: {buy: "367941", sell: "792044"},
                routingNotes: {HBAR: 8, LPRC: 8},
                timedReleaseVerified: true,
                privacyCanaryPassed: true,
                rollbackCanaryPassed: true,
            },
        },
        asBig: BigInt,
        buyEscrow: (price, quantity) => price * quantity,
        nowSec: () => 1_000n,
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
        "HBAR per bond",
        "Place an order",
        "Review order",
        "Reveal window",
        "Your orders",
        "Global market records",
    ]) {
        assert.match(template, new RegExp(copy));
    }
    assert.match(template, /coupon reference fixes the variable rate under contract rules/);
    assert.match(template, /data-order-stage="review"[^>]*hidden/);
    assert.match(template, /data-order-stage="track"[^>]*hidden/);
    assert.doesNotMatch(template, /data-order-stage="submit"/);
    assert.doesNotMatch(template, /Available to trade|Variable-rate bond|Finalized valuation context/);
    assert.doesNotMatch(template, /Set the lowest price you will accept/);
    assert.match(template, /class="trade-balances"/);
    assert.match(template, /id="order-balance-label">HBAR available/);
    assert.match(template, /id="order-balance-value">Connect wallet/);
    assert.match(template, /id="side" value="0"/);
    assert.match(template, /id="price"[^>]*value=""/);
    assert.match(template, /id="qty"[^>]*value=""/);
    assert.match(template, /class="wallet-btn" id="commit-auto">⚡️ Shield Fast/);
    assert.match(template, /id="commit-manual">🔒 Seal Order/);
    assert.match(template, /id="private-setup-modal"/);
    assert.match(template, /id="private-recovery-action"/);
    assert.match(template, /\/\*INLINE tools\/private-session-vault.mjs\*\//);
    assert.match(template, /id="private-session-management"/);
    assert.match(template, /id="private-session-rotate"/);
    assert.match(template, /id="private-session-history"/);
    assert.doesNotMatch(template, /ZK-routed session · automatic reveal/);
    assert.doesNotMatch(template, /id="auto-path-balance"|id="auto-path-fee"/);
    assert.match(template, /A buy needs two wallet approvals; a sell needs three/);
    assert.match(template, /routed pseudonymous execution/);
    assert.match(template, /authorized compliance viewer can map that session/);
    assert.match(template, /timing, uncommon denominations, low traffic, IP metadata/);
    assert.match(template, /Emergency wallet reveal/);
    assert.match(template, /publicly links this wallet to the private session/);
    assert.equal((template.match(/class="dia"/g) || []).length, 2);
    const orderIndex = template.indexOf('id="order-panel"');
    const marketIndex = template.indexOf('class="auction-panel"');
    const ordersIndex = template.indexOf('id="active-orders"');
    assert.ok(
        orderIndex < marketIndex && marketIndex < ordersIndex,
        "full-width order entry should precede the market and orders",
    );
    const primary = template.slice(
        template.indexOf('<main class="wrap page markets-page">'),
        template.indexOf('<section class="market-support">'),
    );
    assert.doesNotMatch(primary, /\b(?:bytes32|uint128|abi\.encode|commit\(|reveal\()\b/i);
});

test("oracle diagnostics stay in reference details, not the price bar", () => {
    const summary = template.slice(
        template.indexOf('class="oracle-summary"'),
        template.indexOf('class="oracle-values"'),
    );
    const details = template.slice(
        template.indexOf('class="oracle-details"'),
        template.indexOf('class="order-attention"'),
    );
    assert.match(summary, /Price reference/);
    assert.match(summary, /id="feed-state"/);
    assert.match(summary, /id="feed-failure"/);
    assert.doesNotMatch(summary, /Publisher quorum|HCS evidence|Reported divergence/);
    assert.match(details, /HCS evidence sequence/);
    assert.match(details, /Publisher quorum/);
    assert.match(css, /\.markets-page \.oracle-quote strong\{font-size:\.84rem\}/);
    assert.match(css, /\.oracle-summary \.note:empty\{display:none\}/);
});

test("the order stages control which content is visible", () => {
    const sections = ["details", "review", "track"].map((stage) => ({
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

    for (const stage of ["details", "review", "track"]) {
        Venue.showOrderStage(stage);
        assert.equal(
            sections.filter((section) => !section.hidden).map((section) => section.dataset.orderStage).join(),
            stage,
        );
        assert.equal(elements["order-panel"].dataset.stage, stage);
    }
    assert.equal(elements["draft-state"].textContent, "Track order");
    assert.equal(elements["order-back"].hidden, true);
    Venue.showOrderStage("submit");
    assert.equal(elements["order-panel"].dataset.stage, "details");
});

test("order recovery is automatic and encrypted with export as an option", () => {
    const vaultMarker = template.indexOf("/*INLINE tools/ticket-vault.mjs*/");
    const appMarker = template.indexOf("/*INLINE tools/venue-app.mjs*/");
    assert.ok(vaultMarker >= 0 && vaultMarker < appMarker);
    assert.match(runtime, /Venue\.hydrateTicketVault = async function/);
    assert.match(runtime, /await Venue\.secureDraft\(\)/);
    assert.match(runtime, /await Venue\.persistTickets\(Venue\.account, next\)/);
    assert.doesNotMatch(runtime, /(?:upsert|writeList)\("tickets"/);
    const commitStart = runtime.indexOf("Venue.doCommit = async function");
    const commitEnd = runtime.indexOf("\nVenue.ticketPhase = function", commitStart);
    assert.doesNotMatch(runtime.slice(commitStart, commitEnd), /writeVault|downloadJson|showSaveFilePicker/);
    assert.match(template, /id="save-ticket">Export this order/);
    assert.match(template, /id="save-vault">Export backup/);
});

test("completed orders offer another order and return to a clean form", () => {
    assert.match(
        runtime,
        /if \(retired\) \{[\s\S]*?data-act="new">Place another order<\/button>/,
    );

    const fields = {
        price: {value: "105", dataset: {touched: "1"}, focus: () => {}},
        qty: {value: "25", dataset: {touched: "1"}},
        holdId: {value: "7", dataset: {}},
        side: {value: "1", dataset: {}},
    };
    let stage = "";
    let rerolled = 0;
    const Venue = {
        trackTicketId: "old-order",
        showOrderStage: (next) => { stage = next; },
        reroll: () => { rerolled++; },
        status: () => {},
    };
    const start = runtime.indexOf("Venue.startNewOrder = function");
    const end = runtime.indexOf("\nVenue.doGuidedOrderAction", start);
    assert.ok(start >= 0 && end > start, "new-order reset should be extractable");
    runInNewContext(runtime.slice(start, end), {
        Venue,
        $: (id) => fields[id] || null,
    });

    Venue.startNewOrder();

    assert.equal(Venue.trackTicketId, null);
    assert.equal(stage, "details");
    assert.equal(fields.price.value, "");
    assert.equal(fields.qty.value, "");
    assert.equal(fields.holdId.value, "");
    assert.equal(fields.side.value, "1");
    assert.equal("touched" in fields.price.dataset, false);
    assert.equal("touched" in fields.qty.dataset, false);
    assert.equal(rerolled, 1);

    fields.price.value = "99";
    fields.qty.value = "10";
    Venue.trackTicketId = "completed-order";
    let click;
    let scrolled = 0;
    const button = {
        getAttribute: (name) => name === "data-act" ? "new" : null,
    };
    const ticketBox = {
        dataset: {},
        addEventListener: (_name, handler) => { click = handler; },
        contains: (node) => node === button,
    };
    const bindStart = runtime.indexOf("Venue.bindTicketList = function");
    const bindEnd = runtime.indexOf("\nfunction ticketDate", bindStart);
    assert.ok(bindStart >= 0 && bindEnd > bindStart, "order action handler should be extractable");
    runInNewContext(runtime.slice(bindStart, bindEnd), {
        Venue,
        $: (id) => id === "tickets" ? ticketBox : null,
        document: {
            querySelector: () => ({
                scrollIntoView: () => { scrolled++; },
            }),
        },
        window: {location: {href: ""}},
    });
    Venue.bindTicketList();
    click({target: {closest: () => button}});

    assert.equal(Venue.trackTicketId, null);
    assert.equal(fields.price.value, "");
    assert.equal(fields.qty.value, "");
    assert.equal(scrolled, 1);
});

test("order attention distinguishes deadlines, losses, and routine release", () => {
    const elements = {
        "order-attention": {hidden: true, dataset: {}},
        "order-attention-title": {textContent: ""},
        "order-attention-copy": {textContent: ""},
    };
    const Venue = {};
    const start = runtime.indexOf("Venue.paintOrderAttention = function");
    const end = runtime.indexOf("\nVenue.paintTickets", start);
    assert.ok(start >= 0 && end > start, "attention renderer should be extractable");
    runInNewContext(runtime.slice(start, end), {
        Venue,
        $: (id) => elements[id] || null,
    });

    Venue.paintOrderAttention({release: 2});
    assert.equal(elements["order-attention"].hidden, false);
    assert.equal(elements["order-attention"].dataset.tone, "info");
    assert.match(elements["order-attention-title"].textContent, /funds ready to unlock/);
    assert.match(elements["order-attention-copy"].textContent, /no deadline/i);

    Venue.paintOrderAttention({release: 2, missed: 1});
    assert.equal(elements["order-attention"].dataset.tone, "danger");
    assert.match(elements["order-attention-title"].textContent, /reveal deadline.*missed/);

    Venue.paintOrderAttention({release: 2, missed: 1, urgent: 1});
    assert.equal(elements["order-attention"].dataset.tone, "warning");
    assert.match(elements["order-attention-title"].textContent, /must be revealed now/);

    Venue.paintOrderAttention();
    assert.equal(elements["order-attention"].hidden, true);
    assert.equal("tone" in elements["order-attention"].dataset, false);

    assert.match(
        runtime,
        /else if \(pastLast\) \{[\s\S]*?tone = "waiting";[\s\S]*?badgeTone = "waiting";/,
    );
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
    assert.equal(Venue.guidedOrderState(buy).mode, "secure");
    Venue.draftRecord = () => ({id: buy.id});
    assert.equal(Venue.guidedOrderState(buy).mode, "backup");
    Venue.vaultReady = true;
    assert.equal(Venue.guidedOrderState(buy).mode, "commit");
    Venue.snap.free = 0n;
    Venue.draftRecord = () => ({id: buy.id, holdId: "7"});
    Venue._liveHolds = [{holdId: "7", amount: "25", expiry: "2000"}];
    const reservedSell = Venue.guidedOrderState({...buy, side: 1});
    assert.equal(reservedSell.mode, "commit");
    assert.doesNotMatch(reservedSell.label, /Reserve/);
    Venue.session = {account: "0x00000000000000000000000000000000000000bb"};
    Venue.snap.sessionKyc = 1;
    Venue.snap.sessionFree = 0n;
    Venue.snap.sessionTinybar = 2_000_000n;
    const privateTopUp = Venue.guidedOrderState({...buy, side: 1}, "private");
    assert.equal(privateTopUp.mode, "session-fund");
    assert.equal(privateTopUp.disabled, false);
    Venue.busy = true;
    assert.equal(Venue.guidedOrderState(buy).mode, "busy");

    const funds = Venue.orderFunds(buy);
    assert.equal(funds.bond, 1_000_000n);
    assert.equal(funds.fee, 100_000n);
    assert.equal(funds.limit, 2_625n);
    assert.equal(funds.reveal, 2_625n);
    assert.equal(funds.totalCash, 1_002_625n);
    assert.equal(funds.gasUnits.manual, 334_492n);
    const quoted = Venue.orderFunds(buy);
    assert.equal(quoted.network.manual, null);
    assert.equal(quoted.privateRequired, 1_002_625n);
    assert.equal(quoted.walletDepositGas, null);
});

test("private route fails closed on gas, liquidity, timing, and privacy gates", () => {
    const Venue = {snap: {}};
    const CLIENT = {privateTrading: {}};
    const start = runtime.indexOf("Venue.orderFunds = function");
    const end = runtime.indexOf("\nVenue.guidedOrderState", start);
    assert.ok(start >= 0 && end > start, "private gas gate should be extractable");
    runInNewContext(runtime.slice(start, end), {Venue, CLIENT, asBig: BigInt});

    assert.equal(Venue.privatePathReadiness(0).ready, false);
    assert.equal(Venue.privatePathReadiness(1).ready, false);
    assert.match(Venue.privatePathReadiness(0).reason, /not bound on this deployment/);
    assert.match(Venue.privatePathReadiness(1).reason, /not bound on this deployment/);

    Venue._privateStatus = {
        candidateOnly: true,
        activationEpoch: 8,
        routingNotes: {HBAR: 8, LPRC: 0},
        lprcCanaryActivated: false,
        worker: {ok: true},
    };
    assert.match(Venue.privatePathReadiness(0).reason, /pending for epoch 8/);
    assert.match(Venue.privatePathReadiness(0).reason, /HBAR notes 8/);
    assert.match(Venue.privatePathReadiness(0).reason, /relayer is up/);
    Venue._privateStatus = null;

    CLIENT.privateTrading = {
        enabled: true,
        buyEnabled: true,
        sellEnabled: true,
        gasObserved: {buy: "384666", sell: "828046"},
        routingNotes: {HBAR: 8, LPRC: 8},
        timedReleaseVerified: true,
        privacyCanaryPassed: true,
        rollbackCanaryPassed: true,
    };

    assert.equal(Venue.privatePathReadiness(0).ready, true);
    assert.equal(Venue.privatePathReadiness(0).withinTarget, false);
    assert.equal(Venue.privatePathReadiness(1).ready, true);

    CLIENT.privateTrading.gasObserved.buy = "384667";
    assert.equal(Venue.privatePathReadiness(0).ready, false);
    assert.match(Venue.privatePathReadiness(0).reason, /15% hard release cap/);
    CLIENT.privateTrading.gasObserved.buy = "367941";
    CLIENT.privateTrading.routingNotes.HBAR = 7;
    assert.equal(Venue.privatePathReadiness(0).ready, false);
    assert.match(Venue.privatePathReadiness(0).reason, /fewer than 8/);
    CLIENT.privateTrading.routingNotes.HBAR = 8;
    CLIENT.privateTrading.timedReleaseVerified = false;
    assert.equal(Venue.privatePathReadiness(0).ready, false);
    assert.match(Venue.privatePathReadiness(0).reason, /canaries/);

    CLIENT.privateTrading = {
        overlay: true,
        enabled: true,
        buyEnabled: true,
        sellEnabled: false,
        provingReady: true,
        artifacts: {sessionEligibility: {}},
        routingNotes: {HBAR: 8, LPRC: 0},
        activationEpoch: 8,
    };
    Venue._privateStatus = {
        worker: {ok: true},
        routingNotes: {HBAR: 8, LPRC: 0},
        activationEpoch: 8,
        currentEpoch: 7,
        gateAdopted: false,
    };
    assert.equal(Venue.privatePathReadiness(0).ready, false);
    assert.match(Venue.privatePathReadiness(0).reason, /pending for epoch 8/);
    assert.equal(Venue.privatePathReadiness(1).ready, false);
    assert.match(Venue.privatePathReadiness(1).reason, /LPRC/);
    Venue._privateStatus.gateAdopted = true;
    Venue._privateStatus.currentEpoch = 8;
    assert.equal(Venue.privatePathReadiness(0).ready, true);
    assert.equal(Venue.privatePathReadiness(1).ready, false);
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

test("transaction lock is acquired before a wallet request starts", async () => {
    let walletRequests = 0;
    let confirm;
    const confirmed = new Promise((resolve) => { confirm = resolve; });
    const Venue = {
        busy: false,
        page: "trade",
        toast: () => {},
        tradeTxStage: () => {},
        fail: (err) => ({message: err.message}),
        paintTicket: () => {},
    };
    const start = runtime.indexOf("Venue.send = async function");
    const end = runtime.indexOf("\nVenue.requireAccount = async function", start);
    assert.ok(start >= 0 && end > start, "transaction sender should be extractable");
    runInNewContext(runtime.slice(start, end), {
        Venue,
        shortId: String,
    });

    const txFactory = async () => {
        walletRequests++;
        return {hash: "0x01", wait: () => confirmed};
    };
    const first = Venue.send(txFactory, "Reveal order");
    const duplicate = Venue.send(txFactory, "Reveal order");

    assert.equal(walletRequests, 1);
    assert.equal(await duplicate, null);
    confirm({status: 1});
    assert.equal((await first).status, 1);
    assert.equal(Venue.busy, false);
});

test("reveal action stays disabled while the order clock repaints", () => {
    const id = "0x" + "22".repeat(32);
    const fields = {
        ".order-status": {className: "", textContent: ""},
        ".order-next-copy strong": {textContent: ""},
        ".order-next-copy span": {textContent: ""},
        "[data-order-deadline]": {textContent: ""},
        ".order-next-actions": {innerHTML: ""},
        ".order-progress": null,
    };
    const card = {
        className: "",
        dataset: {id, side: "0", holdValid: "true"},
        querySelector: (selector) => fields[selector],
    };
    const Venue = {
        revealPending: new Set([id]),
        snap: {kyc: 1, cancelFee: 100_000n},
    };
    const start = runtime.indexOf("Venue.syncTicketActions = function");
    const end = runtime.indexOf("\nVenue.paintTicketClocks = function", start);
    assert.ok(start >= 0 && end > start, "ticket action renderer should be extractable");
    runInNewContext(runtime.slice(start, end), {
        Venue,
        CLIENT: {immutables: {cancelFee: "100000"}},
        asBig: BigInt,
        esc: String,
        fmtRemain: String,
        nowSec: () => 1_000n,
        readableHbar: String,
        ticketDate: String,
    });

    Venue.syncTicketActions(card, {phase: "reveal", until: 1_300n});
    assert.match(fields[".order-next-actions"].innerHTML, /\bdisabled\b/);
    assert.match(fields[".order-next-actions"].innerHTML, /aria-busy="true"/);
    assert.match(fields[".order-next-actions"].innerHTML, /Reveal processing/);
});

test("reveal locks synchronously and sends one wallet request", async () => {
    const id = "0x" + "22".repeat(32);
    const ticket = {
        id,
        side: 0,
        price: "2",
        qty: "3",
        salt: "0x" + "11".repeat(32),
    };
    const attrs = new Map([["data-id", id], ["data-act", "reveal"]]);
    const classes = new Set(["primary"]);
    const button = {
        disabled: false,
        textContent: "Reveal order",
        getAttribute: (name) => attrs.get(name),
        setAttribute: (name, value) => attrs.set(name, value),
        classList: {
            toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
        },
    };
    const box = {querySelectorAll: () => [button]};
    let walletRequests = 0;
    let finishSend;
    const pending = new Promise((resolve) => { finishSend = resolve; });
    const Venue = {
        account: "0x00000000000000000000000000000000000000aa",
        revealPending: new Set(),
        snap: {kyc: 1, walletTinybar: 100n},
        requireAccount: async () => {},
        tradeTxStage: () => {},
        w: {
            engine: {
                reveal: async () => {
                    walletRequests++;
                    return {};
                },
            },
        },
        send: async (txFactory) => {
            await txFactory();
            await pending;
            return null;
        },
        ticketList: () => [ticket],
        ticketVaultReady: () => true,
        upsertTicket: async () => {},
        cacheTicket: () => {},
    };
    const start = runtime.indexOf("Venue.paintRevealPending = function");
    const end = runtime.indexOf("\nVenue.doCross = async function", start);
    assert.ok(start >= 0 && end > start, "reveal action should be extractable");
    runInNewContext(runtime.slice(start, end), {
        Venue,
        $: (name) => name === "tickets" ? box : null,
        buyEscrow: (price, qty) => price * qty,
        toWeibar: BigInt,
        asBig: BigInt,
        addrEq: (a, b) => a === b,
        nowSec: () => 1_000n,
        ZERO: "0x0000000000000000000000000000000000000000",
        CLIENT: {
            addresses: {MatchingEngine: "0x00000000000000000000000000000000000000bb"},
            immutables: {partition: "0x01"},
        },
        G: {EXACT: 4},
        T: {IMM: 0},
    });

    const first = Venue.doReveal(id);
    const duplicate = Venue.doReveal(id);
    assert.equal(button.disabled, true);
    assert.equal(button.textContent, "Reveal processing");
    assert.equal(attrs.get("aria-busy"), "true");
    assert.equal(classes.has("stale"), true);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(walletRequests, 1);
    assert.equal(await duplicate, null);
    finishSend();
    assert.equal(await first, null);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, "Reveal order");
    assert.equal(attrs.get("aria-busy"), "false");
    assert.equal(classes.has("stale"), false);
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

test("sell placement reuses reservations and stops cleanly after a rejected first approval", async () => {
    const account = "0x00000000000000000000000000000000000000aa";
    const id = "0x" + "22".repeat(32);
    const fields = {holdId: {value: "7"}};
    const order = {
        side: 1,
        qty: 25n,
        id,
        ok: true,
        bad: {},
    };
    let commits = 0;
    let holds = 0;
    let holdResult = "8";
    const Venue = {
        account,
        snap: {},
        _liveHolds: [{holdId: "7", amount: "25", expiry: "2000"}],
        requireAccount: async () => {},
        readOrder: () => order,
        guidedOrderState: () => ({mode: "commit"}),
        draftTicket: () => ({
            id,
            committer: account,
            side: 1,
            price: "100",
            qty: "25",
            salt: "0x" + "11".repeat(32),
            holdId: fields.holdId.value || null,
        }),
        draftRecord: () => ({id, holdId: fields.holdId.value || null}),
        ticketVaultReady: () => true,
        upsertTicket: async () => {},
        cacheTicket: () => {},
        tradeTxStage: () => {},
        send: async (factory) => {
            await factory();
            return {hash: "0x" + "33".repeat(32)};
        },
        w: {
            engine: {
                commit: async () => {
                    commits++;
                },
            },
        },
        c: {
            engine: {
                commitBond: async () => 1_000_000n,
                commitments: async () => ({committedAt: 1_000n}),
            },
        },
        doHold: async () => {
            holds++;
            if (holdResult) fields.holdId.value = holdResult;
            return holdResult;
        },
        showOrderStage: () => {},
        status: () => {},
        refreshTrade: async () => {},
        noteReceipt: async () => {},
    };
    const start = runtime.indexOf("Venue.doCommit = async function");
    const end = runtime.indexOf("\nVenue.ticketPhase = function", start);
    assert.ok(start >= 0 && end > start, "sell placement should be extractable");
    runInNewContext(runtime.slice(start, end), {
        Venue,
        $: (name) => fields[name] || null,
        asBig: BigInt,
        nowSec: () => 1_000n,
        toWeibar: BigInt,
        CLIENT: {immutables: {revealDelay: "30"}},
        G: {EXACT: 4},
        T: {IMM: 0},
    });

    await Venue.doCommit();
    assert.equal(holds, 0);
    assert.equal(commits, 1);

    commits = 0;
    fields.holdId.value = "";
    Venue._liveHolds = [];
    await Venue.doCommit();
    assert.equal(holds, 1);
    assert.equal(commits, 1);

    commits = 0;
    fields.holdId.value = "";
    holdResult = null;
    await Venue.doCommit();
    assert.equal(holds, 2);
    assert.equal(commits, 0);
});

test("track panel exposes cancel, reserve, reveal, and release without scrolling away", () => {
    const id = "0x" + "22".repeat(32);
    const account = "0x00000000000000000000000000000000000000aa";
    const ticket = {
        id,
        committer: account,
        committedAt: "1000",
        side: 1,
        qty: "25",
        holdId: null,
    };
    const elements = Object.fromEntries([
        "track-status-label",
        "track-status-title",
        "track-status-copy",
        "track-deadline",
    ].map((name) => [name, {textContent: ""}]));
    let phase = {phase: "cancel", until: 1_030n};
    const Venue = {
        account,
        trackTicketId: id,
        snap: {kyc: 1, round: 5n},
        _liveHolds: [],
        _ticketChains: new Map([[id, {}]]),
        _ticketOrderStates: new Map(),
        viewer: () => account,
        ticketList: () => [ticket],
        ticketPhase: () => phase,
    };
    const start = runtime.indexOf("Venue.paintOrderTrack = function");
    const end = runtime.indexOf("\nVenue.paintGuidedOrder", start);
    assert.ok(start >= 0 && end > start, "track panel should be extractable");
    runInNewContext(runtime.slice(start, end), {
        Venue,
        $: (name) => elements[name] || null,
        fmtRemain: String,
        nowSec: () => 1_000n,
        ticketDate: String,
        asBig: BigInt,
    });

    assert.equal(Venue.paintOrderTrack().mode, "cancel-track");
    phase = {phase: "reveal", until: 1_300n};
    assert.equal(Venue.paintOrderTrack().mode, "reserve-reveal");
    ticket.holdId = "7";
    Venue._liveHolds = [{holdId: "7", amount: "25", expiry: "2000"}];
    assert.equal(Venue.paintOrderTrack().mode, "reveal-track");
    phase = {phase: "done", until: 0n};
    Venue._ticketOrderStates.set(id, {
        order: {retired: false, lastRound: 4n},
    });
    assert.equal(Venue.paintOrderTrack().mode, "release-track");

    const actionStart = runtime.indexOf("Venue.doGuidedOrderAction = async function");
    const actionEnd = runtime.indexOf("\nVenue.paintTicket = function", actionStart);
    assert.doesNotMatch(runtime.slice(actionStart, actionEnd), /scrollIntoView|active-orders/);
});

test("reserved drafts reopen for editing while placed orders remain immutable", () => {
    const draft = {id: "draft", holdId: "7"};
    const committed = {id: "committed", holdId: "7", committedAt: "1000"};
    let tickets = [draft, committed];
    let stage = "";
    let message = "";
    const Venue = {
        editingDraftId: null,
        trackTicketId: null,
        viewer: () => "0x01",
        ticketList: () => tickets,
        applyTicketToForm: () => {},
        showOrderStage: (value) => {
            stage = value;
        },
        status: (_id, value) => {
            message = value;
        },
        paintTicket: () => {},
    };
    const start = runtime.indexOf("Venue.continueTicket = function");
    const end = runtime.indexOf("\nVenue.discardDraft", start);
    assert.ok(start >= 0 && end > start, "draft editing should be extractable");
    runInNewContext(runtime.slice(start, end), {
        Venue,
        document: {querySelector: () => ({scrollIntoView: () => {}})},
    });

    Venue.continueTicket("draft");
    assert.equal(stage, "details");
    assert.equal(Venue.editingDraftId, "draft");
    assert.match(message, /reservation will be reused/);

    Venue.continueTicket("committed");
    assert.equal(stage, "track");
    assert.equal(Venue.editingDraftId, null);
    assert.match(template, /Placed price and quantity are immutable/);
});

test("sealed replacement cancels first and offsetting creates opposite fresh terms", async () => {
    const ticket = {
        id: "old",
        path: "manual",
        side: 1,
        price: "10500000000",
        qty: "25",
        salt: "0x" + "11".repeat(32),
    };
    let cancelled = 0;
    let secured = 0;
    let rerolled = 0;
    let stage = "";
    const fields = {
        price: {value: "", dataset: {}, focus: () => {}},
        qty: {value: "", dataset: {}},
        holdId: {value: "7", dataset: {}},
    };
    const Venue = {
        account: "0x01",
        trackTicketId: ticket.id,
        editingDraftId: ticket.id,
        viewer: () => "0x01",
        ticketList: () => [ticket],
        doCancel: async () => {
            cancelled++;
            return {hash: "0x01"};
        },
        applyTicketToForm: () => {},
        reroll: () => { rerolled++; },
        secureDraft: async () => { secured++; },
        showOrderStage: (value) => { stage = value; },
        status: () => {},
        paintTicket: () => {},
        paintTickets: async () => {},
        setSide: (side) => { Venue.side = side; },
    };
    const replaceStart = runtime.indexOf("Venue.replaceTicket = async function");
    const replaceEnd = runtime.indexOf("\nVenue.doCancel", replaceStart);
    runInNewContext(runtime.slice(replaceStart, replaceEnd), {
        Venue,
        $: (id) => fields[id] || null,
        document: {querySelector: () => ({scrollIntoView: () => {}})},
    });
    await Venue.replaceTicket(ticket.id);
    assert.equal(cancelled, 1);
    assert.equal(secured, 1);
    assert.equal(rerolled, 1);
    assert.equal(stage, "details");

    ticket.path = "private";
    let privateCancelled = 0;
    Venue.cancelPrivateOrder = async () => {
        privateCancelled++;
        return {hash: "0x02"};
    };
    await Venue.replaceTicket(ticket.id);
    assert.equal(privateCancelled, 1);
    assert.equal(secured, 1);

    const offsetStart = runtime.indexOf("Venue.startOffsettingOrder = function");
    const offsetEnd = runtime.indexOf("\nVenue.doGuidedOrderAction", offsetStart);
    runInNewContext(runtime.slice(offsetStart, offsetEnd), {
        Venue,
        $: (id) => fields[id] || null,
        formatHbar: String,
        asBig: BigInt,
        document: {querySelector: () => ({scrollIntoView: () => {}})},
    });
    Venue.startOffsettingOrder(ticket.id);
    assert.equal(Venue.side, 0);
    assert.equal(fields.qty.value, "25");
    assert.equal(fields.holdId.value, "");
    assert.equal(Venue.trackTicketId, null);
    assert.match(runtime, /Placed terms are immutable[\s\S]*?Place opposite order/);
});

test("saving an edited reserved draft replaces its old commitment id", async () => {
    const account = "0x00000000000000000000000000000000000000aa";
    const old = {id: "old", holdId: "7"};
    const placed = {id: "placed", committedAt: "1000"};
    let persisted = null;
    const Venue = {
        account,
        editingDraftId: "old",
        requireAccount: async () => {},
        readOrder: () => ({ok: true}),
        draftTicket: () => ({id: "new", holdId: "7"}),
        ticketList: () => [old, placed],
        persistTickets: async (_account, tickets) => {
            persisted = tickets;
        },
        status: () => {},
    };
    const start = runtime.indexOf("Venue.secureDraft = async function");
    const end = runtime.indexOf("\nVenue.saveTicketNow", start);
    assert.ok(start >= 0 && end > start, "secure draft update should be extractable");
    runInNewContext(runtime.slice(start, end), {Venue});

    await Venue.secureDraft();
    assert.deepEqual(
        persisted.map((ticket) => ticket.id),
        ["new", "placed"],
    );
    assert.equal(persisted[0].holdId, "7");
    assert.equal(Venue.editingDraftId, "new");
});

test("a restored precommit export recovers its placed chain state", async () => {
    const account = "0x00000000000000000000000000000000000000aa";
    const record = {id: "0x" + "22".repeat(32), committer: account};
    const Venue = {
        c: {
            engine: {
                commitments: async () => ({
                    committer: account,
                    committedAt: 1_000n,
                    cancelled: false,
                    revealed: true,
                }),
            },
        },
    };
    const start = runtime.indexOf("Venue.reconcileTicketRecord = async function");
    const end = runtime.indexOf("\nVenue.ingestTickets", start);
    assert.ok(start >= 0 && end > start, "ticket reconciliation should be extractable");
    runInNewContext(runtime.slice(start, end), {
        Venue,
        ZERO: "0x0000000000000000000000000000000000000000",
        addrEq: (left, right) => left.toLowerCase() === right.toLowerCase(),
        asBig: BigInt,
    });

    assert.deepEqual(
        {...await Venue.reconcileTicketRecord(record)},
        {...record, committedAt: "1000", cancelled: false, revealed: true},
    );
    Venue.c.engine.commitments = async () => {
        throw new Error("RPC offline");
    };
    assert.equal(await Venue.reconcileTicketRecord(record), record);
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
    assert.match(css, /\.market-main\{\s*display:grid;grid-template-columns:minmax\(0,1fr\)/);
    assert.match(css, /\.order-panel\{grid-column:1;grid-row:1\}/);
    assert.match(css, /\.auction-panel\{grid-column:1\/-1;grid-row:2\}/);
    assert.match(css, /\.orders-section\{grid-column:1\/-1;grid-row:3\}/);
    assert.match(css, /\.trade-balances-popout\{[\s\S]*?position:absolute/);
    assert.match(css, /\.trade-balance-grid\{[\s\S]*?grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
    assert.match(css, /\.market-oracle\{[\s\S]*?grid-template-columns:minmax\(13rem,1fr\) minmax\(18rem,1\.25fr\) auto/);
    assert.match(css, /\.oracle-label-row h2\{font-size:1rem/);
    assert.match(css, /\.oracle-values\{[\s\S]*?grid-template-columns:repeat\(2,minmax\(9rem,1fr\)\)/);
    assert.match(css, /\.side-toggle button \.dia\{[\s\S]*?clip-path:polygon/);
    assert.match(css, /\.order-primary\{flex:1;width:auto;min-height:46px/);
    assert.match(css, /withdraw-ready-pulse/);
    assert.match(css, /oracle-live-pulse/);
    assert.match(css, /live-market-pulse/);
    assert.match(css, /\.order-attention\[data-tone="info"\][\s\S]*?--attention-color:var\(--market-blue\)/);
    assert.match(css, /\.order-attention\[data-tone="danger"\][\s\S]*?--attention-color:var\(--market-red\)/);
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
    assert.match(oracleRuntime, /stateLabel = Venue\.page === "trade" \? "Live" : "live"/);
    assert.doesNotMatch(oracleRuntime, /Finalized valuation context|Auction trading remains available with user-supplied limits/);
    assert.match(oracleRuntime, /Venue\.page === "trade" \? "" : " HBAR"/);
    assert.match(oracleRuntime, /box\.classList\.toggle\("is-unavailable"/);
});
