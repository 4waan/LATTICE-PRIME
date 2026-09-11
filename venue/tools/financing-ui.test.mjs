import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {Interface} from "ethers";

const template = readFileSync(new URL("../app/repo.template.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/app.css", import.meta.url), "utf8");
const source = readFileSync(new URL("./venue-obs.mjs", import.meta.url), "utf8");
const runtime = readFileSync(new URL("./venue-app.mjs", import.meta.url), "utf8");

const repoId = "0x" + "11".repeat(32);
const otherId = "0x" + "22".repeat(32);
const ZERO = "0x0000000000000000000000000000000000000000";

function makeElement() {
    const classes = new Set();
    const listeners = {};
    return {
        textContent: "",
        innerHTML: "",
        value: "",
        hidden: false,
        className: "",
        dataset: {},
        disabled: false,
        type: "button",
        children: [],
        classList: {
            add: (name) => classes.add(name),
            remove: (name) => classes.delete(name),
            toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
            contains: (name) => classes.has(name),
        },
        setAttribute: () => {},
        removeAttribute: () => {},
        getAttribute: () => null,
        addEventListener: (name, handler) => {
            listeners[name] = listeners[name] || [];
            listeners[name].push(handler);
        },
        click() {
            (listeners.click || []).forEach((handler) => handler({
                preventDefault() {},
                target: this,
            }));
        },
        querySelectorAll: (sel) => {
            if (sel === ".fin-chip") {
                return [...String(this?.innerHTML || "").matchAll(/data-id="([^"]+)"/g)]
                    .map((match) => ({
                        dataset: {id: match[1]},
                        addEventListener: () => {},
                    }));
            }
            return [];
        },
        querySelector: () => null,
        appendChild: (node) => {
            this.children = this.children || [];
            this.children.push(node);
            return node;
        },
        focus: () => {},
        select: () => {},
        scrollIntoView: () => {},
        open: false,
        readOnly: false,
        tabIndex: 0,
    };
}

function harness({now = 1_000, account = null, watching = null} = {}) {
    const elements = new Map();
    const store = {};
    const copied = [];
    const element = (id) => {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
    };
    const Venue = {
        page: "repo",
        account,
        watching,
        financing: {ready: true, reason: ""},
        c: {watch: {calledAmong: async () => []}},
        viewer: () => account || watching || null,
    };
    runInNewContext(source, {
        Venue,
        $: element,
        esc: (value) => String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;"),
        shortId: (value) => String(value).slice(0, 10),
        shortAddr: (value) => String(value).slice(0, 8),
        asBig: BigInt,
        fmtRemain: String,
        addrEq: (left, right) =>
            String(left || "").toLowerCase() === String(right || "").toLowerCase(),
        decodeRevert: (error) => ({message: error?.message || String(error)}),
        formatHbar: String,
        formatPrice: String,
        readableHbar: String,
        explorerAddr: (value) => "https://example.test/address/" + value,
        explorerTx: (hash) => "https://example.test/transaction/" + hash,
        WEIBAR_PER_TINYBAR: 10_000_000_000n,
        CLIENT: {
            addresses: {RepoVault: "vault", PrimeOracle: "oracle"},
            network: {chainId: 296, explorer: "https://example.test", mirror: "https://mirror.test"},
            immutables: {partition: "0x" + "33".repeat(32)},
        },
        FINANCING_EVIDENCE: {},
        ORACLE_TOPICS: [],
        ZERO,
        G: {EXACT: 4, PRED: 1},
        T: {IMM: 0},
        nowSec: () => BigInt(now),
        navigator: {clipboard: {writeText: async (value) => copied.push(value)}},
        document: {
            execCommand: () => false,
            hidden: false,
            activeElement: null,
            documentElement: {classList: {add: () => {}, remove: () => {}}},
            addEventListener: () => {},
            querySelectorAll: () => [],
        },
        sessionStorage: {
            getItem: (key) => store[key] || null,
            setItem: (key, value) => { store[key] = value; },
        },
        localStorage: {
            getItem: (key) => store[key] || null,
            setItem: (key, value) => { store[key] = value; },
        },
        location: {search: "", origin: "https://example.test", pathname: "/repo.html"},
        URLSearchParams,
        URL,
        setTimeout: (fn) => fn(),
        clearTimeout: () => {},
        ethers: {
            hexlify: () => repoId,
            randomBytes: () => new Uint8Array(32),
        },
    });
    return {Venue, element, copied, store};
}

test("Financing workspace follows Create, Review, Manage, and Audit", () => {
    for (const copy of [
        "Create facility",
        "Manage facilities",
        "Review offer",
        "Fund offer",
        "Standard 30-day",
        "Advanced terms",
        "Live quote",
        "Activity",
        "Verified evidence",
        "Look up any public facility id",
        "Last finalized",
        "HCS evidence sequence",
        "Borrow HBAR against LPRC",
        "Pricing and oracle",
        "Facility lifecycle",
        "Native settlement",
        "Contract and policy wiring",
        "Verified demo evidence",
        "Quote details",
    ]) {
        assert.match(template, new RegExp(copy));
    }
    assert.match(template, /id="fin-borrower"/);
    assert.match(template, /id="fin-lot"/);
    assert.match(template, /id="fin-review"[^>]*disabled/);
    assert.match(template, /id="fin-fund"[^>]*disabled/);
    assert.match(template, /id="fin-review-panel"[^>]*hidden/);
    assert.match(template, /id="fin-drawer"[^>]*hidden/);
    assert.match(template, /id="fin-audit"/);
    assert.match(template, /id="feed-impact"/);
    assert.match(template, /id="feed-state"/);
    assert.match(template, /id="feed-mark"/);
    assert.match(template, /id="feed-age"/);
    assert.match(template, /id="feed-refresh"/);
    assert.match(template, /id="fin-view-toggle"[^>]*data-view="create"/);
    assert.match(template, /class="fin-view-thumb"/);
    assert.match(template, /id="fin-view-create"[\s\S]*class="dia"/);
    assert.match(template, /id="fin-view-manage"[\s\S]*class="dia"/);
    const createIndex = template.indexOf('id="fin-create"');
    const reviewIndex = template.indexOf('id="fin-review-panel"');
    const manageIndex = template.indexOf('id="fin-manage"');
    const drawerIndex = template.indexOf('id="fin-drawer"');
    assert.ok(createIndex < reviewIndex && reviewIndex < manageIndex && manageIndex < drawerIndex);
});

test("repo screen tokens and health strip stay out of the Markets chip", () => {
    assert.match(css, /body\[data-screen="repo"\]\{[^}]*--primary:#d9a31a/);
    assert.match(css, /body\[data-screen="repo"\]\{[^}]*--screen:#d9a31a/);
    assert.match(css, /body\[data-screen="repo"\]\{[^}]*--on-primary:#1a1408/);
    assert.match(css, /\.mast\{[^}]*z-index:30/);
    assert.match(css, /\.fin-health\{[^}]*position:relative/);
    assert.doesNotMatch(css, /\.fin-health\{[^}]*z-index:27/);
    assert.doesNotMatch(css, /\.fin-hero-actions\{[^}]*z-index:27/);
    assert.doesNotMatch(css, /\.fin-view-toggle\{[^}]*z-index:27/);
    assert.match(css, /\.fin-health-strip \.feed-state\{/);
    assert.match(css, /\.fin-view-toggle button\[aria-selected="true"\] \.dia/);
    assert.doesNotMatch(css, /body\[data-screen="trade"\]\{[^}]*--primary:#d9a31a/);
});

test("quote banner hides programmer errors and clones frozen terms", () => {
    const {Venue, element} = harness();
    const frozen = Object.freeze({
        0: "nope",
        partition: "0x" + "33".repeat(32),
        collateralAmount: 1n,
        haircutBps: 200n,
        maintenanceBps: 200n,
        repoRateBps: 450n,
        term: 2_592_000n,
    });
    const plain = Venue.financeTermsForQuote(frozen);
    assert.equal(plain.collateralAmount, 1n);
    assert.equal(plain.haircutBps, 200);
    assert.equal(Venue.financeQuoteMessage({
        message: "Cannot assign to read only property '0' of object '[object Object]'",
    }), "");
    assert.match(Venue.financeQuoteMessage({name: "FeedIsDark", message: "FeedIsDark"}), /dark/i);
    Venue.paintFinanceQuote({
        lot: 1n,
        principal: 1_000n,
        repay: 1_001n,
        maturityText: "2026-10-10 00:00:00Z",
        rate: 450,
        haircut: 200,
        maintenance: 200,
        feedHealth: "live",
        borrowerEligibility: "granted",
        lenderEligibility: "unavailable",
        quoteError: Venue.financeQuoteMessage({
            message: "Cannot assign to read only property '0' of object '[object Object]'",
        }),
    });
    assert.doesNotMatch(element("fin-preview").innerHTML, /read only|banner warn/i);
    assert.match(element("fin-preview").innerHTML, /1 LPRC/);
});

test("frozen offer terms still quote without a warning banner", async () => {
    const {Venue, element} = harness();
    element("fin-id").value = repoId;
    const frozen = Object.freeze({
        0: "nope",
        partition: "0x" + "33".repeat(32),
        collateralAmount: 1n,
        haircutBps: 200n,
        maintenanceBps: 200n,
        repoRateBps: 450n,
        term: 2_592_000n,
    });
    Venue.c.vault = {
        offers: async () => ({
            lender: "0x" + "aa".repeat(20),
            borrower: "0x" + "bb".repeat(20),
            principal: 1294n,
            expiresAt: 9_999_999n,
            terms: frozen,
        }),
        stateOf: async () => 0n,
        quotePrincipal: async (terms) => {
            if (Object.isFrozen(terms)) {
                throw new TypeError(
                    "Cannot assign to read only property '0' of object '[object Object]'",
                );
            }
            return 1294n;
        },
        credit: async () => 0n,
    };
    Venue.c.oracle = {markPerUnitTinybar: async () => 1_320n};
    Venue.c.token = {
        balanceOfByPartition: async () => 1n,
        allowance: async () => 0n,
    };
    Venue.c.registry = {getKycStatus: async () => 1n};
    const preview = await Venue.previewFinance();
    assert.equal(preview.principal, 1294n);
    assert.equal(preview.livePrincipal, 1294n);
    assert.match(element("fin-preview").innerHTML, />live</i);
    assert.doesNotMatch(element("fin-preview").innerHTML, /read only|banner warn/i);
});

test("a TypeError from quotePrincipal does not block a live mark", async () => {
    const {Venue, element} = harness();
    element("fin-id").value = repoId;
    Venue.c.vault = {
        offers: async () => ({
            lender: "0x" + "aa".repeat(20),
            borrower: "0x" + "bb".repeat(20),
            principal: 1294n,
            expiresAt: 9_999_999n,
            terms: {
                partition: "0x" + "33".repeat(32),
                collateralAmount: 1n,
                haircutBps: 200n,
                maintenanceBps: 200n,
                repoRateBps: 450n,
                term: 2_592_000n,
            },
        }),
        stateOf: async () => 0n,
        quotePrincipal: async () => {
            throw new TypeError(
                "Cannot assign to read only property '0' of object '[object Object]'",
            );
        },
        credit: async () => 0n,
    };
    Venue.c.oracle = {markPerUnitTinybar: async () => 1_320n};
    Venue.c.token = {
        balanceOfByPartition: async () => 1n,
        allowance: async () => 0n,
    };
    Venue.c.registry = {getKycStatus: async () => 1n};
    const preview = await Venue.previewFinance();
    assert.equal(preview.principal, 1294n);
    assert.equal(preview.livePrincipal, null);
    assert.match(element("fin-preview").innerHTML, />live</i);
    assert.doesNotMatch(element("fin-preview").innerHTML, /read only|banner warn|blocked/i);
});

test("verbose oracle identifiers live in Audit, not the default workspace", () => {
    const health = template.slice(
        template.indexOf('id="feed-box"'),
        template.indexOf('id="fin-view-create"'),
    );
    const audit = template.slice(template.indexOf('id="fin-audit"'));
    assert.match(health, /id="feed-state"/);
    assert.match(health, /id="feed-mark"/);
    assert.match(health, /id="feed-age"/);
    assert.match(health, /id="feed-impact"/);
    assert.doesNotMatch(health, /id="feed-failure"/);
    assert.doesNotMatch(health, /HCS evidence sequence/);
    assert.doesNotMatch(health, /id="feed-scheduler"/);
    assert.match(audit, /id="feed-failure"/);
    assert.match(audit, /HCS evidence sequence/);
    assert.match(audit, /id="feed-scheduler"/);
    assert.match(audit, /id="fin-evidence"/);
    assert.match(audit, /id="rv-penalty"/);
    assert.match(audit, /id="repo-tape"/);
});

test("Create starts with borrower and lot; terms stay under Advanced", () => {
    const form = template.slice(
        template.indexOf('id="fin-form"'),
        template.indexOf('id="fin-review-panel"'),
    );
    assert.match(form, /id="fin-borrower"/);
    assert.match(form, /id="fin-lot"/);
    assert.match(form, /id="fin-advanced"/);
    assert.match(form, /id="fin-haircut"[^>]*value="200"/);
    assert.match(form, /id="fin-rate"[^>]*value="450"/);
    assert.match(form, /id="fin-maint"[^>]*value="200"/);
    assert.match(form, /id="fin-term"[^>]*value="30"/);
    assert.match(form, /id="fin-expiry"[^>]*value="2"/);
    assert.doesNotMatch(form, /id="fin-id"/);
    assert.match(template, /id="fin-review-panel"[\s\S]*id="fin-id"/);
});

test("urgency prefers default, then failing, call, offer, credit, maturity", () => {
    const {Venue} = harness({account: "0xborrower"});
    const now = 1_000;
    const rows = [
        {id: "mature", stateNo: 2, maturity: 5_000, alert: {}},
        {id: "offer", offered: true, maturity: 1_200, alert: {}},
        {id: "call", stateNo: 3, alert: {called: true}},
        {id: "fail", stateNo: 5, alert: {cureExpired: true}},
        {id: "defaultable", stateNo: 5, alert: {defaultable: true}},
    ];
    assert.equal(Venue.facilityUrgency(rows[4], now).rank, 2);
    assert.equal(Venue.facilityUrgency(rows[3], now).rank, 3);
    assert.equal(Venue.facilityUrgency(rows[2], now).rank, 4);
    assert.equal(Venue.facilityUrgency({id: "defaulted", stateNo: 6, alert: {}}, now).rank, 1);
    assert.equal(Venue.facilityUrgency({id: "failing", stateNo: 5, alert: {}}, now).rank, 5);
    assert.equal(Venue.facilityUrgency(rows[1], now).rank, 7);
    assert.equal(Venue.facilityUrgency({id: "fresh-offer", offered: true, maturity: 10_000, alert: {}}, now).rank, 6);
    assert.equal(Venue.facilityUrgency(rows[0], now).rank, 9);
    assert.equal(Venue.chooseFinanceStart(rows, 0n).selectedId, "defaultable");
    assert.equal(Venue.chooseFinanceStart(rows, 0n).view, "manage");
    assert.equal(Venue.chooseFinanceStart([rows[0]], 0n).view, "create");
    assert.equal(Venue.chooseFinanceStart([rows[0]], 10n).view, "manage");
    assert.equal(Venue.chooseFinanceStart([rows[0]], 10n).reason, "withdrawable-credit");
});

test("role detection covers lender, borrower, unrelated, watch, and disconnected", () => {
    const disconnected = harness();
    assert.equal(disconnected.Venue.financeRoleFor("lender", "borrower"), "disconnected");

    const watch = harness({watching: "0xwatch"});
    assert.equal(watch.Venue.financeRoleFor("lender", "borrower"), "watch");
    assert.equal(watch.Venue.financeRoleFor("0xwatch", "borrower"), "lender");

    const lender = harness({account: "lender"});
    assert.equal(lender.Venue.financeRoleFor("lender", "borrower"), "lender");

    const borrower = harness({account: "borrower"});
    assert.equal(borrower.Venue.financeRoleFor("lender", "borrower"), "borrower");

    const stranger = harness({account: "other"});
    assert.equal(stranger.Venue.financeRoleFor("lender", "borrower"), "unrelated");
});

test("preset edits become custom and reset restores Standard 30-day", () => {
    const {Venue, element} = harness();
    Venue.applyFinancePreset();
    assert.equal(Venue.financeUi.preset, "standard-30");
    element("fin-haircut").value = "300";
    Venue.paintFinancePreset();
    assert.equal(Venue.financeUi.preset, "custom");
    assert.match(element("fin-preset-label").textContent, /Custom/);
    Venue.applyFinancePreset();
    assert.equal(element("fin-haircut").value, "200");
    assert.equal(element("fin-rate").value, "450");
    assert.equal(element("fin-term").value, "30");
    assert.equal(Venue.financeUi.preset, "standard-30");
});

test("repo screen tokens and health strip stay out of the Markets chip", () => {
    assert.match(css, /body\[data-screen="repo"\]\{[^}]*--primary:#d9a31a/);
    assert.match(css, /body\[data-screen="repo"\]\{[^}]*--screen:#d9a31a/);
    assert.match(css, /body\[data-screen="repo"\]\{[^}]*--on-primary:#1a1408/);
    assert.match(css, /\.mast\{[^}]*z-index:30/);
    assert.match(css, /\.fin-health\{[^}]*position:relative/);
    assert.doesNotMatch(css, /\.fin-health\{[^}]*z-index:27/);
    assert.doesNotMatch(css, /\.fin-hero-actions\{[^}]*z-index:27/);
    assert.doesNotMatch(css, /\.fin-view-toggle\{[^}]*z-index:27/);
    assert.match(css, /\.fin-health-strip \.feed-state\{/);
    assert.match(css, /\.fin-view-toggle button\[aria-selected="true"\] \.dia/);
    assert.doesNotMatch(css, /body\[data-screen="trade"\]\{[^}]*--primary:#d9a31a/);
});

test("workspace chrome binds before mount and keeps a user-chosen view", async () => {
    const {Venue, element} = harness();
    Venue.pollOracle = async () => {
        Venue.markOracleHeadline?.();
        return true;
    };
    Venue.refreshVault = async () => {};
    Venue.discoverRepos = async () => {};
    Venue.bindFinanceChrome();
    element("fin-view-manage").click();
    assert.equal(Venue.financeUi.view, "manage");
    assert.equal(element("fin-view-toggle").dataset.view, "manage");
    assert.equal(element("fin-create").hidden, true);
    assert.equal(element("fin-manage").hidden, false);
    element("fin-open-activity").click();
    assert.equal(Venue.financeUi.drawerOpen, true);
    assert.equal(element("fin-drawer").hidden, false);
    element("fin-open-evidence").click();
    assert.equal(Venue.financeUi.drawerTab, "audit");
    assert.equal(element("fin-audit-evidence").open, true);
    element("feed-refresh").click();
    assert.equal(element("feed-refresh").textContent, "Refreshing");
    await Venue.mountRepo();
    assert.equal(Venue.financeUi.view, "manage");
    assert.equal(Venue.financeUi.userView, true);
    assert.equal(element("fin-create").hidden, true);
    assert.equal(element("feed-refresh").textContent, "Refresh");
});

test("facility ids are created automatically and Fund stays behind review", async () => {
    const {Venue, element} = harness({account: "lender"});
    Venue.c.vault = {
        offers: async () => ({lender: ZERO}),
        stateOf: async () => 0,
        quotePrincipal: async () => 1_000n,
        credit: async () => 0n,
    };
    Venue.c.oracle = {markPerUnitTinybar: async () => 10n};
    Venue.c.token = {
        balanceOfByPartition: async () => 100n,
        allowance: async () => 0n,
    };
    Venue.c.registry = {getKycStatus: async () => 1n};
    element("fin-borrower").value = "0x" + "aa".repeat(20);
    element("fin-lot").value = "10";
    Venue.applyFinancePreset();
    const draft = await Venue.previewFinance();
    assert.match(draft.id, /^0x[0-9a-fA-F]{64}$/);
    assert.equal(Venue.financeUi.reviewStage, "draft");
    assert.equal(element("fin-fund").disabled, true);
    Venue.requireAccount = async () => {};
    await assert.rejects(Venue.doFundOffer(), /Review the offer before funding/);
    await Venue.enterFinanceReview();
    assert.equal(Venue.financeUi.reviewStage, "review");
    assert.equal(element("fin-review-panel").hidden, false);
    assert.match(element("fin-review-body").innerHTML, /Facility id/);
    assert.equal(element("fin-fund").disabled, false);
});

test("borrower acceptance is reviewed, then authorized, then accepted", () => {
    const {Venue} = harness({account: "borrower"});
    const ctx = {
        id: repoId,
        kind: "offer",
        lender: "lender",
        borrower: "borrower",
        expired: false,
        enoughAllowance: false,
        collateral: 10n,
        principal: 5n,
        offer: {terms: {collateralAmount: 10n}},
    };
    let actions = Venue.financeActions(ctx);
    assert.equal(actions.primary.id, "accept-review");
    Venue.setFinanceUi({acceptStage: "review"});
    actions = Venue.financeActions(ctx);
    assert.equal(actions.primary.id, "approve");
    ctx.enoughAllowance = true;
    Venue.setFinanceUi({acceptStage: "accept"});
    actions = Venue.financeActions(ctx);
    assert.equal(actions.primary.id, "accept");
});

test("watch-only and disconnected modes never expose a write primary", () => {
    const watch = harness({watching: "borrower"});
    const offer = {
        id: repoId,
        kind: "offer",
        lender: "lender",
        borrower: "borrower",
        expired: false,
        enoughAllowance: true,
    };
    assert.equal(watch.Venue.financeActions(offer).primary, null);
    assert.equal(watch.Venue.financeCanSign(), false);

    const closed = harness();
    const facility = {
        id: repoId,
        kind: "facility",
        stateNo: 2,
        lender: "lender",
        borrower: "borrower",
        price: 10n,
        penalty: 0n,
        mk: {dark: false, breach: false},
        alert: {},
    };
    assert.match(closed.Venue.financeActions(facility).primary.label, /Connect to act/);
});

test("primary actions follow defaultable, margin, funded, and closed states", () => {
    const lender = harness({account: "lender"});
    lender.Venue.financing = {ready: true};
    assert.equal(lender.Venue.financeActions({
        kind: "offer", lender: "lender", borrower: "borrower", expired: true,
    }).primary.id, "cancel");

    const borrower = harness({account: "borrower"});
    assert.equal(borrower.Venue.financeActions({
        kind: "facility",
        stateNo: 5,
        lender: "lender",
        borrower: "borrower",
        alert: {defaultable: true},
        mk: {dark: false, breach: true},
        price: 10n,
        penalty: 0n,
    }).primary.id, "declare");
    assert.equal(borrower.Venue.financeActions({
        kind: "facility",
        stateNo: 3,
        lender: "lender",
        borrower: "borrower",
        alert: {called: true, cureExpired: false},
        mk: {dark: false, breach: false},
        price: 10n,
        penalty: 0n,
        borrowerEligible: true,
    }).primary.id, "cure");
    assert.equal(borrower.Venue.financeActions({
        kind: "facility",
        stateNo: 2,
        lender: "lender",
        borrower: "borrower",
        alert: {},
        mk: {dark: false, breach: false},
        price: 12n,
        penalty: 0n,
    }).primary.id, "close");
    assert.equal(borrower.Venue.financeActions({
        kind: "offer",
        lender: "lender",
        borrower: "borrower",
        expired: true,
        enoughAllowance: true,
    }).primary, null);
    assert.equal(borrower.Venue.financeActions({
        kind: "facility",
        stateNo: 3,
        lender: "lender",
        borrower: "borrower",
        alert: {called: true, cureExpired: false},
        mk: {dark: false, breach: true},
        price: 10n,
        penalty: 0n,
        borrowerEligible: false,
    }).primary.disabled, true);
    assert.equal(borrower.Venue.financeActions({
        kind: "facility",
        stateNo: 7,
        lender: "lender",
        borrower: "borrower",
        alert: {},
        mk: null,
        price: null,
        credit: 0n,
    }).primary, null);

    const stranger = harness({account: "other"});
    const unrelated = stranger.Venue.financeActions({
        kind: "facility",
        stateNo: 2,
        lender: "lender",
        borrower: "borrower",
        alert: {},
        mk: {dark: false, breach: false},
        price: 12n,
        penalty: 0n,
    });
    assert.equal(unrelated.primary?.id, "mark");
});

test("activity is newest first, deduped, relative by default, and explorer-limited", () => {
    const {Venue, element, store} = harness();
    Venue.recordFinanceActivity({
        ts: 1_000,
        category: "lifecycle",
        title: "Offer funded",
        detail: "Exact principal was deposited.",
        facilityId: repoId,
        txHash: repoId,
        explorer: "https://evil.test/transaction/" + repoId,
    });
    Venue.recordFinanceActivity({
        ts: 2_000,
        category: "lifecycle",
        title: "Offer funded",
        detail: "Exact principal was deposited.",
        facilityId: repoId,
        txHash: repoId,
        explorer: "https://example.test/transaction/" + repoId,
    });
    Venue.recordFinanceActivity({
        ts: 3_000,
        category: "transaction",
        title: "Wallet confirmation requested",
        detail: "accept financing needs a separate wallet confirmation.",
        facilityId: otherId,
    });
    const html = element("fin-activity").innerHTML;
    assert.ok(html.indexOf("Wallet confirmation requested") < html.indexOf("Offer funded"));
    assert.equal((html.match(/Offer funded/g) || []).length, 1);
    assert.match(html, /just now|minute|hour|day/);
    assert.match(html, /1970-01-01T00:00:03.000Z/);
    assert.match(html, /https:\/\/example\.test\/transaction\//);
    assert.doesNotMatch(html, /evil\.test/);
    assert.doesNotMatch(html, /private key/i);
    const cached = JSON.parse(store["seamme.finance.activity.296.disconnected"]);
    assert.ok(cached.every((row) => !row.explorer || row.explorer.startsWith("https://example.test")));
    assert.match(html, /data-copy-facility="/);
    assert.ok(html.includes(repoId));
    assert.doesNotMatch(html, /<article class="fin-activity-item/);
});

test("drawer never opens itself and unread badges stay on the banner", () => {
    const {Venue, element} = harness();
    Venue.page = "repo";
    element("fin-drawer").hidden = true;
    Venue.paintOracleImpact(["HCS evidence missing or failed: issuer: timeout."]);
    assert.equal(element("fin-drawer").hidden, true);
    assert.equal(Venue.financeUi.drawerOpen, false);
    assert.equal(element("fin-alert").hidden, false);
    assert.match(element("feed-impact").textContent, /Publisher evidence could not be verified/);
    assert.doesNotMatch(element("feed-impact").textContent, /issuer: timeout/);
    assert.equal(element("fin-activity-badge").hidden, false);
    Venue.openFinanceDrawer("audit");
    assert.equal(element("fin-drawer").hidden, false);
    assert.equal(Venue.financeUi.drawerTab, "audit");
    Venue.closeFinanceDrawer();
    assert.equal(element("fin-drawer").hidden, true);
    assert.equal(Venue.financeUi.unread, 0);
});

test("selected facility uses contract covered-or-breach text, never a coverage percent", () => {
    const {Venue, element} = harness({account: "borrower"});
    Venue.paintSelectedFacility({
        id: repoId,
        kind: "facility",
        stateNo: 3,
        stateLabel: "MARGIN CALL",
        lender: "lender",
        borrower: "borrower",
        collateral: 10n,
        principal: 8n,
        repay: 9n,
        maturity: 2_000,
        rate: 450,
        haircut: null,
        maintenance: 200,
        mark: 7n,
        exposure: 8n,
        verdict: "Breach: the live mark is short of the maintenance margin.",
        verdictTone: "bad",
        alert: {called: true},
        mk: {dark: false, breach: true, mark: 7n},
        price: 9n,
        penalty: 0n,
        borrowerEligible: true,
        lenderEligible: true,
    });
    assert.match(element("repo-out").innerHTML, /Breach: the live mark is short/);
    assert.doesNotMatch(element("repo-out").innerHTML, /%/);
    assert.match(element("repo-out").innerHTML, /Not retained after acceptance/);
    assert.ok(element("repo-out").innerHTML.includes(repoId));
    assert.match(element("repo-out").innerHTML, /Copy id/);
    assert.match(element("fin-next").innerHTML, /Add collateral|Repay/);
    Venue.paintSelectedFacility({
        id: otherId,
        kind: "facility",
        stateNo: 2,
        stateLabel: "OPEN",
        lender: "lender",
        borrower: "borrower",
        collateral: 10n,
        principal: 8n,
        repay: 9n,
        maturity: 2_000,
        rate: 450,
        haircut: null,
        maintenance: 200,
        mark: null,
        exposure: 8n,
        verdict: "The feed is dark, so the contract will not mark this facility.",
        verdictTone: "bad",
        alert: {},
        mk: {dark: true, breach: false},
        price: 9n,
        penalty: 0n,
        borrowerEligible: true,
        lenderEligible: true,
    });
    assert.match(element("repo-out").innerHTML, /The feed is dark/);
    assert.doesNotMatch(element("repo-out").innerHTML, /coverage %|percent covered/i);
});

test("Financing styles stay inside one viewport and stack on small screens", () => {
    assert.match(css, /\.fin-split\{[\s\S]*grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
    assert.match(css, /\.fin-manage-grid\{[\s\S]*grid-template-columns:minmax\(13\.5rem,16rem\) minmax\(0,1fr\) minmax\(15rem,18rem\)/);
    assert.match(css, /\.fin-health-strip\{[\s\S]*grid-template-columns:minmax\(7\.5rem,\.7fr\) minmax\(11rem,1\.15fr\) minmax\(12rem,1\.35fr\) auto/);
    assert.match(css, /\.fin-health-label\{/);
    assert.doesNotMatch(css, /\.fin-health-strip span\{/);
    assert.match(css, /\.fin-drawer\{[\s\S]*position:fixed;top:0;right:0/);
    assert.match(css, /@media\(max-width:900px\)\{[\s\S]*\.fin-split,\.fin-manage-grid\{grid-template-columns:minmax\(0,1fr\)\}/);
    assert.match(css, /@media\(max-width:640px\)\{[\s\S]*\.fin-drawer,\.fin-drawer-backdrop\{inset:0;width:100vw\}/);
    assert.match(css, /\.financing-page button:focus-visible/);
    assert.match(css, /\.fin-draft-actions \.primary[\s\S]*min-height:46px/);
    assert.match(css, /\.fin-tx-status\{/);
    assert.doesNotMatch(css, /overflow-x:\s*scroll/);
});

test("Markets polling still refreshes Financing without reload", () => {
    assert.match(runtime, /const ORACLE_REFRESH_MS = 30_000;/);
    assert.match(runtime, /Venue\.refreshFinanceWorkspace\?/);
    assert.match(runtime, /Venue\.financeTxStage\?/);
    assert.match(runtime, /if \(Venue\.page !== "repo"\) Venue\.toast\(label \+ " sent "/);
});

test("Audit copy keeps diagnostics but drops contract and function names", () => {
    const audit = template.slice(template.indexOf('id="fin-audit"'));
    assert.match(audit, /id="rv-grace"/);
    assert.match(audit, /fail grace period/);
    assert.match(audit, /daily penalty/);
    assert.match(audit, /HCS evidence sequence/);
    for (const name of [
        "failGrace", "penaltyRate", "marginEngine", "cashLeg()", "refRateBps",
        "lastRound", "panelOf", "maxDeviationBps", "cashFeed", "fundOffer",
        "markToMarket", "postMark", "MarginWatch", "ParameterRoot", "RepoVault",
    ]) {
        assert.doesNotMatch(audit, new RegExp(name.replace(/[()]/g, "\\$&")));
    }
});

test("remembered facility ids survive reload and open Manage", async () => {
    const {Venue, store} = harness({account: "lender"});
    Venue.rememberFinanceFacility(repoId, {accounts: ["lender", "borrower"], role: "lender"});
    const known = JSON.parse(store["seamme.finance.known.296.lender"]);
    assert.equal(known[0].id, repoId);
    const borrowerKnown = JSON.parse(store["seamme.finance.known.296.borrower"]);
    assert.equal(borrowerKnown[0].id, repoId);

    const reloaded = harness({account: "lender"});
    Object.assign(reloaded.store, store);
    reloaded.Venue.history = async () => [];
    reloaded.Venue.discoverViewerFacilityIds = async () => [];
    reloaded.Venue.readRepoRows = async (ids) => ({
        rows: ids.map((id) => ({
            id,
            known: true,
            offered: true,
            lender: "lender",
            borrower: "borrower",
            state: "FUNDED_OFFER",
            stateNo: 0,
            maturity: 2_000,
            alert: {},
        })),
    });
    reloaded.Venue.doRepo = async () => {};
    reloaded.Venue.c.watch.calledAmong = async () => [];
    await reloaded.Venue.discoverRepos();
    assert.equal(reloaded.Venue.knownRepos.some((row) => row.id === repoId), true);
    assert.equal(reloaded.Venue.financeUi.view, "manage");
    assert.equal(reloaded.Venue.financeUi.selectedId, repoId);
});

test("viewer vault calls recover a facility omitted from global logs", async () => {
    const {Venue} = harness({account: "lender"});
    Venue.history = async () => [];
    Venue.discoverViewerFacilityIds = async () => [repoId];
    Venue.readRepoRows = async (ids) => ({
        rows: ids.map((id) => ({
            id,
            known: true,
            offered: true,
            lender: "lender",
            borrower: "borrower",
            state: "FUNDED_OFFER",
            alert: {},
        })),
    });
    Venue.doRepo = async () => {};
    await Venue.discoverRepos();
    assert.equal(Venue.knownRepos.length, 1);
    assert.equal(Venue.knownRepos[0].id, repoId);
    assert.equal(Venue.financeCallId(""), "");
    Venue.iface = () => ({
        parseTransaction: () => ({name: "fundOffer", args: [repoId]}),
    });
    assert.equal(Venue.financeCallId("0xabcdef" + "11".repeat(32)), repoId);
});

test("Hedera alias and long-zero count as the same lender", async () => {
    const alias = "0xcfc5923def1f25db05fe50754ef0822175afd449";
    const longZero = "0x00000000000000000000000000000000009d2f80";
    const {Venue} = harness({account: alias});
    Venue.rememberAliasSet([alias, longZero]);
    assert.equal(Venue.hederaLongZero("0.0.10301312"), longZero);
    assert.equal(Venue.sameHederaAccount(alias, longZero), true);
    assert.equal(Venue.financeRoleFor(longZero, "0x" + "21".repeat(20)), "lender");
    Venue.c.vault = {
        credit: async (addr) => String(addr).toLowerCase() === longZero ? 12n : 0n,
    };
    assert.equal(await Venue.financeViewerCredit(), 12n);
    Venue.history = async () => [];
    Venue.discoverViewerFacilityIds = async () => [repoId];
    Venue.readRepoRows = async (ids) => ({
        rows: ids.map((id) => ({
            id,
            known: true,
            offered: true,
            lender: longZero,
            borrower: "0x" + "21".repeat(20),
            state: "FUNDED OFFER",
            stateNo: 0,
            maturity: 2_000,
            alert: {},
        })),
    });
    Venue.doRepo = async () => {};
    Venue.c.watch.calledAmong = async () => [];
    await Venue.discoverRepos();
    assert.equal(Venue.relatedFacilities.some((row) => row.id === repoId), true);
    assert.equal(Venue.financeUi.view, "manage");
    assert.equal(Venue.financeUi.selectedId, repoId);
});

test("paged vault results backfill Activity when global logs are empty", async () => {
    const alias = "0xcfc5923def1f25db05fe50754ef0822175afd449";
    const longZero = "0x00000000000000000000000000000000009d2f80";
    const txHash = "0x" + "ab".repeat(32);
    const {Venue, element} = harness({account: alias});
    Venue.history = async () => [];
    Venue.mirror = async (path) => {
        if (String(path).includes("/accounts/")) {
            return {account: "0.0.10301312", evm_address: alias};
        }
        if (String(path).includes("timestamp=lt")) {
            return {results: [], links: {}};
        }
        return {
            results: [{
                function_parameters: "0x0244b7ed" + "11".repeat(32),
                hash: txHash,
                timestamp: "1789000000.1",
                error_message: null,
            }],
            links: {next: "/api/v1/contracts/vault/results?from=" + alias + "&timestamp=lt:1"},
        };
    };
    Venue.iface = () => ({
        parseTransaction: () => ({name: "fundOffer", args: [repoId]}),
    });
    Venue.readRepoRows = async (ids) => ({
        rows: ids.map((id) => ({
            id,
            known: true,
            offered: true,
            lender: longZero,
            borrower: "0x" + "21".repeat(20),
            state: "FUNDED OFFER",
            alert: {},
        })),
    });
    Venue.doRepo = async () => {};
    Venue.c.watch.calledAmong = async () => [];
    await Venue.discoverRepos();
    assert.equal(Venue.knownRepos.some((row) => row.id === repoId), true);
    assert.equal(Venue.relatedFacilities.some((row) => row.id === repoId), true);
    assert.match(element("fin-activity").innerHTML, new RegExp(repoId, "i"));
    assert.match(element("fin-activity").innerHTML, /Copy id/);
    assert.match(element("fin-activity").innerHTML, /Offer funded/);
    assert.match(element("fin-activity").innerHTML, /example\.test\/transaction/);
});

test("wallet recovery paints Activity before the global vault log scan", async () => {
    const alias = "0xcfc5923def1f25db05fe50754ef0822175afd449";
    const longZero = "0x00000000000000000000000000000000009d2f80";
    const txHash = "0x" + "cd".repeat(32);
    const {Venue, element} = harness({account: alias});
    let historyCalls = 0;
    Venue.history = async () => {
        historyCalls += 1;
        throw new Error("global logs must not block Activity");
    };
    Venue.mirror = async (path) => {
        if (String(path).includes("/accounts/")) {
            return {account: "0.0.10301312", evm_address: alias};
        }
        return {
            results: [{
                function_parameters: "0x0244b7ed" + "11".repeat(32),
                hash: txHash,
                timestamp: "1789078266.7",
                error_message: null,
            }],
            links: {},
        };
    };
    Venue.iface = () => ({
        parseTransaction: () => ({name: "fundOffer", args: [repoId]}),
    });
    Venue.readRepoRows = async (ids) => ({
        rows: ids.map((id) => ({
            id,
            known: true,
            offered: true,
            lender: longZero,
            borrower: "0x" + "21".repeat(20),
            state: "FUNDED OFFER",
            alert: {},
        })),
    });
    Venue.doRepo = async () => {};
    const ids = await Venue.recoverViewerFinanceHistory();
    assert.equal(ids.length, 1);
    assert.equal(String(ids[0]).toLowerCase(), repoId.toLowerCase());
    assert.equal(historyCalls, 0);
    assert.match(element("fin-activity").innerHTML, /Offer funded/);
    assert.match(element("fin-activity").innerHTML, new RegExp(repoId, "i"));
    assert.match(element("fin-activity").innerHTML, /Copy id/);
    assert.equal(Venue.relatedFacilities.some((row) => row.id === repoId), true);
});

test("empty Activity tells a disconnected viewer to connect or watch", () => {
    const {Venue, element} = harness();
    Venue.paintFinanceActivity();
    const html = element("fin-activity").innerHTML;
    assert.match(html, /data-finance-connect/);
    assert.match(html, /Connect wallet/);
    assert.match(html, /data-finance-watch/);
    assert.match(html, /fin-activity-watch-input/);
    assert.doesNotMatch(html, /Confirmed vault events/);
});

test("opening Activity recovers the funded offer from the connected wallet", async () => {
    const alias = "0xcfc5923def1f25db05fe50754ef0822175afd449";
    const longZero = "0x00000000000000000000000000000000009d2f80";
    const txHash = "0x" + "ef".repeat(32);
    const {Venue, element} = harness({account: alias});
    Venue.history = async () => {
        throw new Error("opening Activity must not wait on global logs");
    };
    Venue.mirror = async (path) => {
        if (String(path).includes("/accounts/")) {
            return {account: "0.0.10301312", evm_address: alias};
        }
        return {
            results: [{
                function_parameters: "0x0244b7ed" + "11".repeat(32),
                hash: txHash,
                timestamp: "1789078266.7",
                error_message: null,
            }],
            links: {},
        };
    };
    Venue.iface = () => ({
        parseTransaction: () => ({name: "fundOffer", args: [repoId]}),
    });
    Venue.readRepoRows = async (ids) => ({
        rows: ids.map((id) => ({
            id,
            known: true,
            offered: true,
            lender: longZero,
            borrower: "0x" + "21".repeat(20),
            state: "FUNDED OFFER",
            alert: {},
        })),
    });
    Venue.doRepo = async () => {};
    element("fin-drawer").hidden = true;
    await Venue.openFinanceDrawer("activity");
    assert.match(element("fin-activity").innerHTML, /Offer funded/);
    assert.match(element("fin-activity").innerHTML, new RegExp(repoId, "i"));
    assert.match(element("fin-activity").innerHTML, /Copy id/);
});

test("RepoVault ABI reads the facility id out of a fundOffer call", () => {
    const {Venue} = harness();
    const abi = JSON.parse(readFileSync(new URL("../deployments/abi/RepoVault.json", import.meta.url), "utf8"));
    const iface = new Interface(abi);
    Venue.iface = () => iface;
    const data = iface.encodeFunctionData("fundOffer", [
        repoId,
        "0x21113454ae7A3c2Dec1cfAc29f4fD715E9FB3397",
        {
            partition: "0x" + "33".repeat(32),
            collateralAmount: 10_000n,
            haircutBps: 500,
            maintenanceBps: 200,
            repoRateBps: 450,
            term: 30n * 24n * 60n * 60n,
        },
        1_800_000_000,
    ]);
    const info = Venue.financeCallInfo(data);
    assert.equal(info.name, "fundOffer");
    assert.equal(String(info.id).toLowerCase(), repoId.toLowerCase());
});

test("vault refresh failure leaves Unavailable, not Loading", async () => {
    const {Venue, element} = harness();
    Venue.c.vault = null;
    Venue.c.watch = {};
    await Venue.refreshVault();
    assert.equal(element("rv-grace").textContent, "Unavailable");
    assert.equal(element("rv-penalty").textContent, "Unavailable");
    assert.doesNotMatch(element("rv-engine").textContent, /Loading|MarginWatch/);
});

test("template ids are unique and Audit keeps every required group", () => {
    const ids = [...template.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    const seen = new Set();
    const dupes = [];
    for (const id of ids) {
        if (seen.has(id)) dupes.push(id);
        seen.add(id);
    }
    assert.deepEqual(dupes, []);
    for (const id of [
        "feed-state", "feed-mark", "feed-age", "feed-impact", "feed-failure",
        "fin-audit-pricing", "fin-audit-lifecycle", "fin-audit-settlement",
        "fin-audit-wiring", "fin-audit-evidence", "fin-id-short", "fin-quote-details",
        "fin-settlement", "fin-tx-live",
    ]) {
        assert.equal(ids.filter((value) => value === id).length, 1);
    }
});

test("quote states cover incomplete, checking, blocked, and existing offer", async () => {
    const {Venue, element} = harness({account: "lender"});
    Venue.applyFinancePreset();
    Venue.ensureFinanceId(false);
    Venue.c.vault = {
        offers: async () => ({lender: ZERO}),
        stateOf: async () => 0,
        quotePrincipal: async () => 1_000n,
        credit: async () => 0n,
    };
    Venue.c.oracle = {markPerUnitTinybar: async () => 10n};
    Venue.c.token = {
        balanceOfByPartition: async () => 100n,
        allowance: async () => 0n,
    };
    Venue.c.registry = {getKycStatus: async () => 1n};
    await Venue.previewFinance();
    assert.equal(element("fin-quote-status").textContent, "Incomplete");
    assert.equal(element("fin-review").disabled, true);

    let releaseQuote;
    const quoteGate = new Promise((resolve) => {
        releaseQuote = resolve;
    });
    Venue.c.vault.quotePrincipal = () => quoteGate;
    element("fin-borrower").value = "0x" + "aa".repeat(20);
    element("fin-lot").value = "10";
    const pending = Venue.previewFinance();
    assert.equal(element("fin-quote-status").textContent, "Checking");
    releaseQuote(1_000n);
    await pending;
    assert.equal(element("fin-quote-status").textContent, "Ready to review");

    element("fin-borrower").value = "not-an-address";
    await Venue.previewFinance();
    assert.equal(element("fin-quote-status").textContent, "Blocked");

    Venue.c.vault.offers = async () => ({
        lender: "0x" + "bb".repeat(20),
        borrower: "0x" + "aa".repeat(20),
        principal: 1_000n,
        expiresAt: 9_999_999n,
        terms: {
            partition: "0x" + "33".repeat(32),
            collateralAmount: 10n,
            haircutBps: 200n,
            maintenanceBps: 200n,
            repoRateBps: 450n,
            term: 2_592_000n,
        },
    });
    Venue.c.vault.quotePrincipal = async () => 1_000n;
    element("fin-borrower").value = "0x" + "aa".repeat(20);
    const existing = await Venue.previewFinance();
    assert.equal(existing.hasOffer, true);
    assert.equal(element("fin-quote-status").textContent, "Existing offer loaded");
    assert.match(element("fin-quote-details-body").innerHTML, /0x[0-9a-fA-F]{40}/);

    Venue.c.vault.quotePrincipal = async () => 2_000n;
    await Venue.previewFinance();
    assert.match(element("fin-quote-status").textContent, /Quote moved since funding/);
});

test("review locks the draft and shows full addresses plus the fund amount", async () => {
    const {Venue, element} = harness({account: "0x" + "cc".repeat(20)});
    Venue.c.vault = {
        offers: async () => ({lender: ZERO}),
        stateOf: async () => 0,
        quotePrincipal: async () => 1_273n,
        credit: async () => 0n,
    };
    Venue.c.oracle = {markPerUnitTinybar: async () => 10n};
    Venue.c.token = {
        balanceOfByPartition: async () => 100n,
        allowance: async () => 0n,
    };
    Venue.c.registry = {getKycStatus: async () => 1n};
    element("fin-borrower").value = "0x" + "aa".repeat(20);
    element("fin-lot").value = "10";
    Venue.applyFinancePreset();
    await Venue.enterFinanceReview();
    assert.equal(element("fin-wizard").classList.contains("is-reviewing"), true);
    assert.equal(element("fin-borrower").readOnly, true);
    assert.match(element("fin-review-body").innerHTML, /0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
    assert.match(element("fin-review-body").innerHTML, /0xcccccccccccccccccccccccccccccccccccccccc/);
    assert.match(element("fin-review-body").innerHTML, /Cash withdrawal is a separate pull/);
    assert.match(element("fin-fund").textContent, /Fund 1273 HBAR/);
    Venue.exitFinanceReview();
    assert.equal(element("fin-borrower").readOnly, false);
    assert.equal(element("fin-review-panel").hidden, true);
});

test("acceptance does not start the approve wallet prompt by itself", async () => {
    const {Venue, element} = harness({account: "0x" + "aa".repeat(20)});
    let approved = false;
    Venue.requireAccount = async () => {};
    element("fin-id").value = repoId;
    Venue.c.vault = {
        offers: async () => ({
            lender: "0x" + "bb".repeat(20),
            borrower: "0x" + "aa".repeat(20),
            principal: 5n,
            expiresAt: 9_999_999n,
            terms: {
                partition: "0x" + "33".repeat(32),
                collateralAmount: 10n,
            },
        }),
        quotePrincipal: async () => 5n,
    };
    Venue.c.registry = {getKycStatus: async () => 1n};
    Venue.c.token = {
        allowance: async () => 0n,
        balanceOfByPartition: async () => 10n,
    };
    Venue.ensureVaultAllowance = async () => {
        approved = true;
        return true;
    };
    await assert.rejects(Venue.doAcceptOffer(), /Authorize the collateral lot first/);
    assert.equal(approved, false);
});

test("an urgent related facility overrides a remembered Create view", async () => {
    const {Venue} = harness({account: "lender"});
    Venue.setFinanceView("create", {user: true});
    Venue.readRepoRows = async (ids) => ({
        rows: ids.map((id) => ({
            id,
            known: true,
            offered: true,
            lender: "lender",
            borrower: "borrower",
            state: "FUNDED OFFER",
            stateNo: 0,
            maturity: 2_000,
            alert: {},
        })),
    });
    Venue.doRepo = async () => {};
    Venue.c.watch.calledAmong = async () => [];
    await Venue.paintRelatedWorkspace([repoId]);
    assert.equal(Venue.financeUi.view, "manage");
    assert.equal(Venue.financeUi.selectedId, repoId);
});

test("related rows name the counterparty and hide unrelated public ids", () => {
    const {Venue, element} = harness({account: "lender"});
    Venue.paintRelatedFacilities([
        {
            id: repoId,
            lender: "lender",
            borrower: "0x" + "21".repeat(20),
            state: "FUNDED OFFER",
            offered: true,
            principal: 12n,
            maturity: 2_000,
            alert: {},
        },
    ]);
    assert.match(element("fin-related").innerHTML, /FUNDED OFFER/);
    assert.match(element("fin-related").innerHTML, /lender/);
    assert.match(element("fin-related").innerHTML, /0x212121/);
    assert.match(element("fin-related").innerHTML, /12 HBAR/);
    Venue.paintRelatedFacilities([]);
    assert.match(element("fin-related").innerHTML, /No facilities that name this wallet/);
});

test("selected facility groups economics, risk, timing, and settlement", () => {
    const {Venue, element} = harness({account: "borrower"});
    Venue.paintSelectedFacility({
        id: repoId,
        kind: "facility",
        stateNo: 2,
        stateLabel: "OPEN",
        lender: "0x" + "bb".repeat(20),
        borrower: "borrower",
        collateral: 10n,
        principal: 8n,
        repay: 9n,
        maturity: 2_000,
        openedAt: 1_000,
        cureDeadline: 0n,
        rate: 450,
        haircut: null,
        maintenance: 200,
        mark: 11n,
        exposure: 8n,
        penalty: 0n,
        verdict: "Covered: the live mark meets the maintenance margin.",
        verdictTone: "ok",
        alert: {},
        mk: {dark: false, breach: false, mark: 11n},
        price: 9n,
        borrowerEligible: true,
        lenderEligible: true,
        schedules: [{
            id: otherId,
            label: "maturity fail",
            obligation: {status: 1, dueAt: 3_000},
            funded: true,
        }],
    });
    const html = element("repo-out").innerHTML;
    assert.match(html, /Facility status/);
    assert.match(html, /Economics/);
    assert.match(html, /Risk and eligibility/);
    assert.match(html, /Timing/);
    assert.match(html, /Settlement/);
    assert.match(html, /Covered: the live mark meets/);
    assert.match(html, /Not retained after acceptance/);
    assert.match(element("fin-settlement").innerHTML, /maturity fail/);
    assert.match(element("fin-next").innerHTML, /Repay/);
});

test("activity storage is scoped to chain and account", () => {
    const lender = harness({account: "lender"});
    lender.Venue.recordFinanceActivity({
        title: "Wallet confirmation requested",
        category: "wallet",
        facilityId: repoId,
    });
    assert.ok(lender.store["seamme.finance.activity.296.lender"]);
    assert.equal(lender.store["seamme.finance.activity"], undefined);

    const other = harness({account: "borrower"});
    other.Venue.paintFinanceActivity();
    assert.doesNotMatch(other.element("fin-activity").innerHTML, /Wallet confirmation requested/);
});

test("financeTxStage paints visible copy and upserts one facility row", () => {
    const hash = "0x" + "ab".repeat(32);
    const {Venue, element} = harness({account: "borrower"});
    Venue.setFinanceUi({selectedId: repoId});
    Venue.financePreview = {terms: {collateralAmount: 1n}};
    Venue.financeTxStage("approval", "authorize collateral");
    assert.match(element("fin-tx-status").textContent || element("fin-tx-status").innerHTML, /authorize collateral/i);
    assert.match(element("fin-tx-live").textContent, /wallet confirmation/i);
    assert.equal(element("fin-tx-status").hidden, false);
    Venue.financeTxStage("pending", "authorize collateral", {hash});
    assert.match(element("fin-tx-status").innerHTML, /submitted/i);
    assert.match(element("fin-tx-status").innerHTML, /example\.test\/transaction/);
    const rows = (Venue.financeActivity || []).filter((row) => row.action === "authorize collateral");
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0].facilityId).toLowerCase(), repoId.toLowerCase());
    assert.equal(rows[0].txHash, hash);
    assert.match(rows[0].detail, /Authorize 1 LPRC to the vault/);
    assert.match(element("fin-activity").innerHTML, /Transaction submitted/);
    assert.doesNotMatch(element("fin-activity").innerHTML, /Wallet confirmation requested/);
});

test("a second approve while busy does not call approve", async () => {
    const {Venue, element} = harness({account: "borrower"});
    let approved = 0;
    Venue.busy = true;
    Venue.ensureVaultAllowance = async () => {
        approved += 1;
        return true;
    };
    Venue.paintSelectedFacility = () => {};
    await Venue.runFinanceAction({id: "approve", label: "Approve collateral"}, {
        id: repoId,
        offer: {terms: {collateralAmount: 1n}},
        collateral: 1n,
    });
    assert.equal(approved, 0);
    assert.match(element("fin-activity").innerHTML, /already waiting on the wallet or Hedera/);
    Venue.busy = false;
    Venue.setFinanceUi({flight: {action: "authorize collateral", facilityId: repoId}});
    await Venue.runFinanceAction({id: "approve", label: "Approve collateral"}, {
        id: repoId,
        offer: {terms: {collateralAmount: 1n}},
        collateral: 1n,
    });
    assert.equal(approved, 0);
});

test("doRepo on a live offer keeps acceptStage", async () => {
    const borrower = "0x" + "bf".repeat(20);
    const lender = "0x" + "cf".repeat(20);
    const {Venue, element} = harness({account: borrower});
    element("repo-id").value = repoId;
    Venue.setFinanceUi({selectedId: repoId, acceptStage: "review"});
    Venue.c.vault = {
        repo: async () => ({lender: ZERO}),
        stateOf: async () => 0,
        offers: async () => ({
            lender,
            borrower,
            principal: 5n,
            expiresAt: 9_999_999n,
            terms: {
                partition: "0x" + "33".repeat(32),
                collateralAmount: 1n,
                haircutBps: 200n,
                maintenanceBps: 200n,
                repoRateBps: 450n,
                term: 2_592_000n,
            },
        }),
    };
    Venue.c.watch.alertOf = async () => ({});
    Venue.previewFinance = async () => {};
    let painted = null;
    Venue.paintOffer = (id, offer) => {
        painted = {id, offer};
    };
    await Venue.doRepo();
    assert.equal(Venue.financeUi.acceptStage, "review");
    assert.equal(painted.id, repoId);
});

test("selecting a funded offer as the borrower records awaiting acceptance", () => {
    const borrower = "0x" + "bf".repeat(20);
    const lender = "0x" + "cf".repeat(20);
    const {Venue, element, store} = harness({account: borrower});
    Venue.paintOffer(repoId, {
        lender,
        borrower,
        principal: 1311n,
        expiresAt: 9_999_999n,
        terms: {
            collateralAmount: 1n,
            repoRateBps: 450n,
            term: 100n,
            haircutBps: 200n,
            maintenanceBps: 200n,
        },
    });
    assert.match(element("fin-activity").innerHTML, /Funded offer awaiting acceptance/);
    assert.match(element("fin-activity").innerHTML, new RegExp(repoId, "i"));
    assert.match(element("fin-activity").innerHTML, /1 LPRC/);
    const cached = JSON.parse(store["seamme.finance.activity.296." + borrower.toLowerCase()] || "[]");
    assert.equal(cached.some((row) => row.title === "Funded offer awaiting acceptance"), true);
});

test("Activity with a selected id hides an older Offer funded from another facility", () => {
    const {Venue, element} = harness({account: "borrower"});
    Venue.setFinanceUi({selectedId: repoId});
    Venue.recordFinanceActivity({
        title: "Offer funded",
        category: "transaction",
        facilityId: otherId,
        detail: "old canary",
    });
    Venue.recordFinanceActivity({
        title: "Funded offer awaiting acceptance",
        category: "facility",
        facilityId: repoId,
        detail: "this offer",
    });
    Venue.paintFinanceActivity();
    assert.match(element("fin-activity").innerHTML, /Funded offer awaiting acceptance/);
    assert.match(element("fin-activity").innerHTML, /this offer/);
    assert.doesNotMatch(element("fin-activity").innerHTML, /old canary/);
});

test("opening the drawer while recovering does not clear existing rows", () => {
    const {Venue, element} = harness({account: "borrower"});
    Venue.recordFinanceActivity({
        title: "Wallet confirmation requested",
        category: "wallet",
        facilityId: repoId,
        detail: "Authorize 1 LPRC to the vault.",
    });
    Venue._financeRecovering = true;
    Venue.paintFinanceActivity();
    assert.match(element("fin-activity").innerHTML, /Wallet confirmation requested/);
    assert.match(element("fin-activity").innerHTML, /Refreshing wallet history/);
    assert.doesNotMatch(element("fin-activity").innerHTML, /Looking up this wallet/);
});

test("a 32-byte hash in an error message is not revert data", () => {
    const hash = "0x" + "66ee".repeat(16);
    const {Venue} = harness();
    assert.equal(Venue.looksLikeRevertData(hash), false);
    assert.equal(Venue.financeRevertData({
        message: "missing revert data in call exception; tx=" + hash,
    }), "");
    const readable = Venue.financeReadableRevert({
        message: "missing revert data in call exception; tx=" + hash,
    });
    assert.doesNotMatch(readable, /0x66ee/);
    assert.match(readable, /Hedera rejected the collateral approval/);
});

test("an unnamed approve staticCall still reaches send and records a readable failure", async () => {
    const {Venue, element} = harness({account: "borrower"});
    let sent = 0;
    Venue.setFinanceUi({selectedId: repoId});
    Venue.page = "repo";
    Venue.financePreview = {terms: {collateralAmount: 1n}};
    Venue.requireAccount = async () => {};
    Venue.c.token = {allowance: async () => 0n};
    const approve = async () => {
        sent += 1;
        throw Object.assign(new Error("user rejected"), {code: 4001});
    };
    approve.staticCall = async () => {
        throw {data: "0x66eeb154", message: "0x66eeb154"};
    };
    Venue.w = {token: {approve}};
    Venue.send = async () => {
        sent += 1;
        return null;
    };
    await assert.rejects(
        Venue.runFinanceAction({id: "approve", label: "Approve collateral"}, {
            id: repoId,
            offer: {terms: {collateralAmount: 1n}},
            collateral: 1n,
        }),
        /Hedera rejected the collateral approval|Collateral authorization was not confirmed/,
    );
    assert.equal(sent, 1);
    assert.match(element("fin-tx-status").innerHTML, /authorize collateral failed/i);
    assert.doesNotMatch(element("fin-tx-status").innerHTML, /0x66eeb154/);
    assert.match(element("fin-activity").innerHTML, /Transaction failed/);
    assert.match(element("fin-activity").innerHTML, /Authorize 1 LPRC to the vault/);
    assert.match(element("fin-activity").innerHTML, /Hedera rejected the collateral approval|Collateral authorization was not confirmed/);
    assert.doesNotMatch(element("fin-activity").innerHTML, /0x66eeb154/);
});

test("a ComplianceNotAllowed approve staticCall never opens the wallet", async () => {
    const {Venue, element} = harness({account: "borrower"});
    let sent = 0;
    Venue.setFinanceUi({selectedId: repoId});
    Venue.page = "repo";
    Venue.financePreview = {terms: {collateralAmount: 1n}};
    Venue.requireAccount = async () => {};
    Venue.c.token = {allowance: async () => 0n};
    const approve = async () => {
        sent += 1;
        throw new Error("approve should not be sent");
    };
    approve.staticCall = async () => {
        throw {data: "0x66eb1b54", message: "0x66eb1b54"};
    };
    Venue.w = {token: {approve}};
    Venue.send = async () => {
        sent += 1;
        return null;
    };
    await assert.rejects(
        Venue.runFinanceAction({id: "approve", label: "Approve collateral"}, {
            id: repoId,
            offer: {terms: {collateralAmount: 1n}},
            collateral: 1n,
        }),
        /vault is not admitted as a spender/,
    );
    assert.equal(sent, 0);
    assert.match(element("fin-tx-status").innerHTML, /authorize collateral failed/i);
    assert.match(element("fin-tx-status").innerHTML, /vault is not admitted as a spender/);
    assert.match(element("fin-activity").innerHTML, /Transaction failed/);
    assert.doesNotMatch(element("fin-activity").innerHTML, /0x66eb1b54/);
});

test("a journal refusal never opens the wallet for approve", async () => {
    const {Venue, element} = harness({account: "borrower"});
    let sent = 0;
    Venue.setFinanceUi({selectedId: repoId});
    Venue.page = "repo";
    Venue.financePreview = {terms: {collateralAmount: 1n}};
    Venue.requireAccount = async () => {};
    Venue.c.token = {allowance: async () => 0n};
    Venue.c.journal = {
        explain: async () => [false, 1],
    };
    const approve = async () => {
        sent += 1;
        throw new Error("approve should not be sent");
    };
    approve.staticCall = async () => {
        sent += 1;
        throw new Error("staticCall should not run");
    };
    Venue.w = {token: {approve}};
    Venue.send = async () => {
        sent += 1;
        return null;
    };
    await assert.rejects(
        Venue.runFinanceAction({id: "approve", label: "Approve collateral"}, {
            id: repoId,
            offer: {terms: {collateralAmount: 1n}},
            collateral: 1n,
        }),
        /vault is not admitted as a spender/,
    );
    assert.equal(sent, 0);
    assert.match(element("fin-tx-status").innerHTML, /authorize collateral failed/i);
    assert.match(element("fin-activity").innerHTML, /Transaction failed/);
});

test("a KYC approve staticCall never opens the wallet", async () => {
    const {Venue, element} = harness({account: "borrower"});
    let sent = 0;
    Venue.setFinanceUi({selectedId: repoId});
    Venue.page = "repo";
    Venue.financePreview = {terms: {collateralAmount: 1n}};
    Venue.requireAccount = async () => {};
    Venue.c.token = {allowance: async () => 0n};
    const approve = async () => {
        sent += 1;
        throw new Error("approve should not be sent");
    };
    approve.staticCall = async () => {
        throw {data: "0xfc855b1b", message: "0xfc855b1b"};
    };
    Venue.w = {token: {approve}};
    Venue.send = async () => {
        sent += 1;
        return null;
    };
    await assert.rejects(
        Venue.runFinanceAction({id: "approve", label: "Approve collateral"}, {
            id: repoId,
            offer: {terms: {collateralAmount: 1n}},
            collateral: 1n,
        }),
        /Prove eligibility first/,
    );
    assert.equal(sent, 0);
    assert.match(element("fin-tx-status").innerHTML, /authorize collateral failed/i);
    assert.match(element("fin-tx-status").innerHTML, /Prove eligibility first/);
    assert.match(element("fin-activity").innerHTML, /Transaction failed/);
    assert.match(element("fin-activity").innerHTML, /Prove eligibility first/);
});
