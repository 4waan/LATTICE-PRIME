import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

const template = readFileSync(new URL("../app/venue.template.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/app.css", import.meta.url), "utf8");
const obs = readFileSync(new URL("./venue-obs.mjs", import.meta.url), "utf8");
const issuerUi = readFileSync(new URL("./issuer-ui.mjs", import.meta.url), "utf8");
const hcsView = readFileSync(new URL("./hcs-view.mjs", import.meta.url), "utf8");
const genApp = readFileSync(new URL("./gen-app.mjs", import.meta.url), "utf8");
const makefile = readFileSync(new URL("../Makefile", import.meta.url), "utf8");

function makeElement(id) {
    const classes = new Set();
    const listeners = {};
    const attrs = {};
    return {
        id,
        textContent: "",
        innerHTML: "",
        value: "",
        hidden: false,
        className: "",
        dataset: {},
        disabled: false,
        children: [],
        style: {},
        classList: {
            add: (name) => classes.add(name),
            remove: (name) => classes.delete(name),
            toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
            contains: (name) => classes.has(name),
        },
        setAttribute: (k, v) => { attrs[k] = String(v); },
        removeAttribute: (k) => { delete attrs[k]; },
        getAttribute: (k) => attrs[k] ?? null,
        addEventListener: (name, handler) => {
            listeners[name] = listeners[name] || [];
            listeners[name].push(handler);
        },
        querySelectorAll: () => [],
        querySelector: () => null,
        focus: () => {},
        click() {
            (listeners.click || []).forEach((handler) => handler({
                preventDefault() {},
                target: this,
                currentTarget: this,
            }));
        },
        _listeners: listeners,
        offsetParent: {},
    };
}

function harness(extra = {}) {
    const elements = new Map();
    const store = {};
    const element = (id) => {
        if (!id) return null;
        if (!elements.has(id)) elements.set(id, makeElement(id));
        return elements.get(id);
    };
    const docListeners = {};
    const Venue = {
        page: "venue",
        account: null,
        snap: {discEpoch: 5n},
        c: {},
        fail: (e) => { throw e; },
        toast: () => {},
        status: (id, text, cls) => {
            const el = element(id);
            if (el) {
                el.textContent = text;
                el.className = "status " + (cls || "");
            }
        },
        viewer: () => Venue.account,
        ...extra.Venue,
    };
    const context = {
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
        fmtRemain: (s) => String(s) + "s",
        addrEq: (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase(),
        decodeRevert: (error) => ({message: error?.message || String(error)}),
        formatHbar: String,
        formatPrice: String,
        readableHbar: String,
        explorerAddr: (value) => "https://example.test/address/" + value,
        explorerTx: (hash) => "https://example.test/transaction/" + hash,
        WEIBAR_PER_TINYBAR: 10_000_000_000n,
        CLIENT: {
            addresses: {
                token: "0x" + "11".repeat(20),
                VolumeCap: "0x" + "22".repeat(20),
                MatchingEngine: "0x" + "33".repeat(20),
                ZkKycRegistry: "0x" + "44".repeat(20),
                SeamJournal: "0x" + "55".repeat(20),
                ParameterRoot: "0x" + "66".repeat(20),
                CouponSchedule: "0x" + "77".repeat(20),
                CouponDistributor: "0x" + "88".repeat(20),
            },
            network: {chainId: 296, explorer: "https://example.test", mirror: "https://mirror.test"},
            immutables: {
                commitBond: 1, cancelFee: 2, revealDelay: 3, revealWindow: 4,
                roundLength: 5, restRounds: 6, genesis: 7, partition: "0x" + "33".repeat(32),
                DOMAIN_ORDER: 8, MAX_USES_PER_EPOCH: 9, minTier: 10, jurisdictionMask: 11,
            },
            disclosure: {row13: {ceiling: "5"}},
            coupon: {cashToken: {tokenId: "0.0.9"}},
            clocks: {disclosure: {origin: 0, period: 100}},
        },
        ZERO: "0x0000000000000000000000000000000000000000",
        G: {EXACT: 4},
        G_NAME: ["", "", "", "", "exact"],
        T: {IMM: 0},
        PAYER: ["none", "taker", "maker", "venue", "operator"],
        ROW_NAMES: {},
        ABI: {SeamJournal: [], ParameterRoot: []},
        nowSec: () => 1_000n,
        HCS: {topicId: "0.0.123", memo: "test"},
        HCS_INDEX: null,
        LIVENESS_KINDS: ["checkpoint", "anchor"],
        decode: JSON.parse,
        validate: (rec) => rec,
        describe: (rec) => "record " + rec.k,
        auditRecord: () => [{name: "ok", pass: true}],
        assertSiteDeployments: async () => {},
        SITES: {},
        SOURCE_ADDRESS_KEY: {},
        bits: () => 1,
        navigator: {clipboard: {writeText: async () => {}}},
        document: {
            execCommand: () => false,
            hidden: false,
            activeElement: null,
            documentElement: {classList: {add: () => {}, remove: () => {}}},
            addEventListener: (name, handler) => {
                docListeners[name] = docListeners[name] || [];
                docListeners[name].push(handler);
            },
            querySelectorAll: () => [],
        },
        window: {
            addEventListener: () => {},
        },
        location: {hash: "#overview", search: "", pathname: "/venue.html"},
        history: {replaceState: () => {}},
        sessionStorage: {
            getItem: (key) => store[key] || null,
            setItem: (key, value) => { store[key] = value; },
        },
        localStorage: {
            getItem: (key) => store[key] || null,
            setItem: (key, value) => { store[key] = value; },
        },
        URLSearchParams,
        URL,
        setTimeout: (fn) => fn(),
        clearTimeout: () => {},
        Date,
        JSON,
        TextDecoder,
        Uint8Array,
        atob: (s) => Buffer.from(s, "base64").toString("binary"),
        encodeURIComponent,
        fetch: async () => ({ok: true, json: async () => ({})}),
        ethers: {
            isAddress: (value) => /^0x[0-9a-fA-F]{40}$/.test(value),
            Interface: class {
                constructor() {}
                parseLog() { return null; }
                getEvent() { return {topicHash: "0xadopted"}; }
            },
            keccak256: (x) => x,
        },
        ...extra.globals,
    };
    runInNewContext(obs, context);
    runInNewContext(hcsView, context);
    runInNewContext(issuerUi, context);
    return {Venue, element, elements, store, docListeners, context};
}

test("template keeps overview compact and moves heavy tables into modals or drawer", () => {
    assert.match(template, /iss-view-toggle/);
    assert.match(template, /id="iss-overview"/);
    assert.match(template, /id="iss-governance"/);
    assert.match(template, /id="iss-payments"/);
    assert.match(template, /id="iss-compliance"/);
    assert.match(template, /Activity &amp; evidence/);
    assert.match(template, /id="iss-drawer"/);
    assert.match(template, /id="iss-modal-param-keys"/);
    assert.match(template, /id="iss-modal-immutables"/);
    assert.match(template, /id="iss-modal-coupon-calendar"/);
    assert.doesNotMatch(template.split('id="iss-overview"')[1].split('id="iss-governance"')[0], /id="param-set"/);
    assert.doesNotMatch(template.split('id="iss-overview"')[1].split('id="iss-governance"')[0], /id="immutables"/);
    assert.doesNotMatch(template.split('id="iss-overview"')[1].split('id="iss-governance"')[0], /id="tape"/);
    assert.doesNotMatch(template.split('id="iss-overview"')[1].split('id="iss-governance"')[0], /id="hcs"/);
    assert.doesNotMatch(template.split('id="iss-overview"')[1].split('id="iss-governance"')[0], /id="coupon-calendar"/);
    assert.match(template, /\/\*INLINE tools\/issuer-ui\.mjs\*\//);
});

test("generated venue.html is produced from the template, not hand maintained", () => {
    assert.match(genApp, /"venue"/);
    assert.match(genApp, /build\("app\/" \+ name \+ "\.template\.html"/);
    assert.match(makefile, /issuer-ui\.test\.mjs/);
});

test("CSS provides issuer command center layout without horizontal page scroll rules", () => {
    assert.match(css, /\.issuer-page\{/);
    assert.match(css, /\.iss-status-strip\{/);
    assert.match(css, /\.iss-summary-grid\{/);
    assert.match(css, /\.iss-drawer\{/);
    assert.match(css, /\.iss-modal\{/);
    assert.match(css, /overflow-wrap:anywhere/);
});

test("invalid hashes fall back to overview and primary views are selectable", () => {
    const {Venue, element} = harness();
    Venue.bindIssuerChrome();
    assert.equal(Venue.selectIssuerView("nope"), "overview");
    assert.equal(element("iss-overview").hidden, false);
    assert.equal(Venue.selectIssuerView("governance", {user: true}), "governance");
    assert.equal(element("iss-governance").hidden, false);
    assert.equal(element("iss-overview").hidden, true);
    assert.equal(Venue.selectIssuerView("#payments"), "payments");
    assert.equal(Venue.selectIssuerView("compliance"), "compliance");
});

test("status strip does not label unchecked evidence as healthy", () => {
    const {Venue, element} = harness();
    Venue.issuerCore = {
        halted: false,
        haltUntilText: "Unavailable",
        capSuspended: false,
        permits: true,
        regimePending: false,
        paramPending: false,
        rulebookPending: false,
        feeChecked: false,
        immChecked: false,
        coupon: null,
        currentHex: "0x1",
        floorHex: "0x0",
        ceilingHex: "0x2",
        shareText: "1%",
        capText: "10%",
        haltBudgetText: "0 / 0 s",
        rootShort: "0xroot",
        prevRootShort: "none",
        keyCount: 0,
        paramPendingText: "no proposal",
        windowText: "Unavailable",
        editionText: "none",
        noEdition: true,
        reconcileText: "Not loaded",
        chargeCountText: "0",
        epochNow: "5",
        latestClosed: "4",
        spentText: "0 bits",
        epochActivity: "none",
        registryText: "ZkKycRegistry",
    };
    Venue.renderIssuerOverview();
    assert.equal(element("iss-st-hcs").textContent, "Evidence not checked");
    assert.match(element("iss-st-hcs").className, /neutral/);
    assert.equal(element("iss-st-fees").textContent, "Not loaded");
    assert.match(element("iss-st-fees").className, /neutral/);
    assert.equal(element("iss-st-imm").textContent, "Not loaded");
});

test("attention items cover halt, suspension, refusal, proposals, drift, mismatches, and underfunding", () => {
    const {Venue} = harness();
    Venue.issuerCore = {
        halted: true,
        haltUntilText: "2026-01-01 00:00:00Z",
        capSuspended: true,
        permits: false,
        regimePending: true,
        paramPending: false,
        rulebookPending: false,
        immChecked: true,
        immDrift: 2,
        feeChecked: true,
        feeMismatch: true,
        noEdition: false,
        coupon: {missing: false, feeMismatch: true, underfunded: true},
        journalDisagree: true,
        readError: null,
    };
    Venue.setIssuerUi({
        hcs: {
            checked: true, unreadable: 3, fallback: "hash mismatch",
            auditFailed: true, audited: true, loaded: true,
            schemaValid: true, snapshotHashAccepted: false, truncated: false,
        },
    });
    const items = Venue.issuerAttentionItems(Venue.issuerCore);
    const ids = items.map((item) => item.id);
    assert.ok(ids.includes("halt"));
    assert.ok(ids.includes("cap"));
    assert.ok(ids.includes("regime"));
    assert.ok(ids.includes("gov-pending"));
    assert.ok(ids.includes("imm"));
    assert.ok(ids.includes("fees"));
    assert.ok(ids.includes("hts-fee"));
    assert.ok(ids.includes("hss"));
    assert.ok(ids.includes("journal"));
    assert.ok(ids.includes("hcs-unreadable"));
    assert.ok(ids.includes("hcs-snap"));
    assert.ok(ids.includes("hcs-audit"));
    assert.equal(ids.filter((id) => id === "gov-pending").length, 1);
});

test("missing fee schedule is informational, not a healthy reconcile", () => {
    const {Venue, element} = harness();
    Venue.issuerCore = {
        halted: false,
        haltUntilText: "Unavailable",
        capSuspended: false,
        permits: true,
        regimePending: false,
        paramPending: false,
        rulebookPending: false,
        feeChecked: true,
        noEdition: true,
        feeMismatch: false,
        immChecked: true,
        immDrift: 0,
        immTotal: 12,
        coupon: {missing: false, underfunded: false, feeMismatch: false, nextDate: "2026-02-01", count: 4},
        currentHex: "0x1",
        floorHex: "0x0",
        ceilingHex: "0x2",
        shareText: "1%",
        capText: "10%",
        haltBudgetText: "10 / 10 s",
        rootShort: "0xabc",
        prevRootShort: "none",
        keyCount: 3,
        paramPendingText: "no proposal",
        windowText: "Unavailable",
        editionText: "none adopted",
        reconcileText: "Not applicable",
        chargeCountText: "no schedule published",
        epochNow: "5",
        latestClosed: "4",
        spentText: "0 / 8 bits",
        epochActivity: "0 transfers",
        registryText: "ZkKycRegistry",
    };
    Venue.renderIssuerOverview();
    assert.equal(element("iss-st-fees").textContent, "No schedule published");
    assert.match(element("iss-st-fees").className, /neutral/);
    const items = Venue.issuerAttentionItems(Venue.issuerCore);
    assert.ok(items.some((item) => item.id === "no-fees"));
});

test("detail groups load lazily and cache until invalidated", async () => {
    const {Venue} = harness();
    let paramSetCalls = 0;
    let chargeCalls = 0;
    Venue.refreshParamSet = async () => { paramSetCalls += 1; };
    Venue.refreshCharges = async () => { chargeCalls += 1; };
    Venue.issuerCore = {chargeCount: 2};
    await Venue.ensureIssuerDetail("param-keys");
    await Venue.ensureIssuerDetail("param-keys");
    await Venue.ensureIssuerDetail("fees");
    await Venue.ensureIssuerDetail("fees");
    assert.equal(paramSetCalls, 1);
    assert.equal(chargeCalls, 1);
    Venue.invalidateIssuerCache(["param-keys", "fees"]);
    await Venue.ensureIssuerDetail("param-keys");
    assert.equal(paramSetCalls, 2);
});

test("manual refresh invalidates caches and updates timestamp", async () => {
    const {Venue} = harness();
    Venue.issuerUiState().loaded = {fees: true, "param-keys": true, coupon: true};
    Venue.invalidateIssuerCache(["fees", "param-keys", "coupon"]);
    assert.equal(Venue.issuerUiState().loaded.fees, undefined);
    Venue.setIssuerUi({lastRefreshAt: 123});
    assert.equal(Venue.issuerUiState().lastRefreshAt, 123);
});

test("parameter row inspector preserves drift detection", async () => {
    const {Venue, element} = harness();
    element("param-row").value = "13";
    Venue.c.policy = {
        ceilingFor: async () => 9n,
        budgetFor: async () => [1, 2, 3, 4],
        floorFor: async () => 0n,
        isWaived: async () => false,
        keyOfRow: async () => "0x" + "aa".repeat(32),
        keyOfRowBudget: async () => "0x" + "bb".repeat(32),
        keyOfRowFloor: async () => "0x" + "cc".repeat(32),
    };
    await Venue.refreshParamRow();
    assert.match(element("param-out").innerHTML, /drifted from the bundle/);
    assert.equal(Venue.issuerUiState().rowDrift, 1);
});

test("parameter enumeration still uses getFunction valueOf", async () => {
    const {Venue, element} = harness();
    let usedGetFunction = false;
    Venue.c.policy = {
        keyCount: async () => 1n,
        ROW_CARD: async () => 10n,
        KEY_WAIVED_ROWS: async () => "0x" + "00".repeat(32),
        keyAt: async () => "0x" + "ab".repeat(32),
        getFunction: (name) => {
            assert.equal(name, "valueOf");
            usedGetFunction = true;
            return async () => 7n;
        },
        valueOf: () => { throw new Error("must not call Object valueOf"); },
    };
    await Venue.refreshParamSet();
    assert.equal(usedGetFunction, true);
    assert.match(element("param-set").innerHTML, /0x7/);
});

test("immutable comparisons use live chain values and report mismatches", async () => {
    const {Venue, element} = harness();
    Venue.c.engine = {
        commitBond: async () => 99n,
        cancelFee: async () => 2n,
        revealDelay: async () => 3n,
        revealWindow: async () => 4n,
        roundLength: async () => 5n,
        restRounds: async () => 6n,
        genesis: async () => 7n,
        partition: async () => "0x" + "33".repeat(32),
        DOMAIN_ORDER: async () => 8n,
        minimumCancelFee: async () => 1n,
    };
    Venue.c.registry = {MAX_USES_PER_EPOCH: async () => 9n};
    Venue.c.gate = {minTier: async () => 10n, jurisdictionMask: async () => 11n};
    await Venue.refreshImmutables();
    assert.match(element("immutables").innerHTML, /drift/);
    assert.equal(Venue.issuerImmutables.drifted >= 1, true);
    assert.equal(Venue.issuerImmutables.checked, true);
});

test("coupon fee comparison uses live Mirror Node token fee data", async () => {
    const {Venue} = harness();
    Venue.c.couponSchedule = {
        issuedAt: async () => 1_000n,
        count: async () => 2n,
        spreadBps: async () => 25n,
        faceValue: async () => 100n,
        basis: async () => 1n,
        root: async () => "0x" + "dd".repeat(32),
        dates: async () => [2_000n, 3_000n],
    };
    Venue.c.couponDistributor = {
        issuer: async () => "0x" + "11".repeat(20),
        claimWindow: async () => 60n,
        payingAgentFeeBps: async () => 10n,
        committed: async () => 0n,
    };
    Venue.c.vault = {
        HSS: async () => "0x" + "12".repeat(20),
        SCHEDULE_GAS_LIMIT: async () => 1n,
        FUNDING_PER_CALL: async () => 100n,
        reservedFunding: async () => 50n,
        fundedFor: async () => 0n,
    };
    Venue.mirror = async () => ({
        name: "Cash",
        symbol: "LPCASH",
        token_id: "0.0.9",
        decimals: 6,
        custom_fees: {fractional_fees: [{amount: {numerator: 1, denominator: 100}, net_of_transfers: false}]},
    });
    const coupon = await Venue.refreshCoupon();
    assert.equal(coupon.feeMismatch, true);
    assert.equal(coupon.underfunded, true);
    assert.equal(coupon.liveFeeBps, "100");
});

test("transfer preflight validates addresses and reports getter disagreement", async () => {
    const {Venue, element} = harness();
    element("ex-from").value = "not-an-address";
    element("ex-to").value = "0x" + "11".repeat(20);
    element("ex-amt").value = "1";
    await Venue.doExplain();
    assert.match(element("journal-out").innerHTML, /Both sides have to be addresses/);

    element("ex-from").value = "0x" + "11".repeat(20);
    element("ex-to").value = "0x" + "22".repeat(20);
    Venue.issuerCore = {};
    Venue.c.journal = {
        explain: async () => [true, 0],
        canTransfer: async () => false,
    };
    await Venue.doExplain();
    assert.match(element("journal-out").innerHTML, /disagree/);
    assert.equal(Venue.issuerCore.journalDisagree, true);
});

test("current or future epochs are rejected before wallet connection", async () => {
    const {Venue, element} = harness();
    let required = false;
    Venue.requireAccount = async () => { required = true; };
    Venue.send = async () => { throw new Error("should not send"); };
    element("disc-epoch-in").value = "5";
    Venue.snap.discEpoch = 5n;
    await Venue.doDisclose();
    assert.equal(required, false);
    assert.match(element("disclose-status").textContent, /has not closed/);
});

test("successful disclosure decodes its receipt and reports spent-bit changes", async () => {
    const {Venue, element} = harness();
    element("disc-epoch-in").value = "4";
    Venue.snap.discEpoch = 5n;
    let spent = 1n;
    Venue.requireAccount = async () => {};
    Venue.c.journal = {
        spentBits: async () => spent,
    };
    Venue.c.policy = {currentEpoch: async () => 5n};
    Venue.w = {
        journal: {
            disclose: async () => ({}),
        },
    };
    Venue.send = async () => {
        spent = 3n;
        return {
            hash: "0x" + "ee".repeat(32),
            logs: [{
                topics: ["0xdisc"],
                data: "0x",
            }],
        };
    };
    Venue.iface = () => ({
        parseLog: () => ({
            name: "EpochDisclosed",
            args: [4n, 4, 12n],
        }),
    });
    Venue.refreshVenue = async () => {};
    await Venue.doDisclose();
    assert.match(element("disclose-status").textContent, /1 → 3/);
    assert.match(element("disclose-status").textContent, /granularity/);
});

test("mirror node event loading stays newest-first and preserves unknown events", async () => {
    const {Venue, element} = harness();
    Venue.historyOf = async () => ([
        {source: "Regime", name: "Changed", args: null, fragment: null, topic0: "0xabc", tx: "0xtx1", at: 200},
        {source: "Rulebook", name: "Adopted", args: [1], fragment: {inputs: [{name: "edition"}]}, tx: "0xtx2", at: 100},
    ]);
    element("tape-scope").value = "governance";
    await Venue.refreshTape();
    const html = element("tape").innerHTML;
    assert.match(html, /Changed/);
    assert.match(html, /unknown/);
    assert.ok(html.indexOf("Changed") < html.indexOf("Adopted"));
});

test("HCS loading preserves schema validation, unreadable counts, and verification states", async () => {
    const {Venue, element} = harness();
    Venue.hcsRecords = {
        records: [
            {seq: 2, at: "2.0", rec: {k: "charge", tx: "0x" + "11".repeat(32)}, audit: null},
            {seq: 1, at: "1.0", rec: {k: "silence", tx: "0x" + "22".repeat(32)}, audit: null},
        ],
        unreadable: 2,
        total: 4,
        snapshot: {through: 1, builtAt: "2026-01-01T00:00:00.000Z"},
        live: 1,
        truncated: false,
        fallback: null,
    };
    Venue.paintTopic(Venue.hcsRecords);
    assert.match(element("hcs").innerHTML, /#2/);
    assert.match(element("hcs").innerHTML, /charge/);
    Venue.setIssuerUi({
        hcs: {
            checked: true, loaded: true, schemaValid: true,
            snapshotHashAccepted: true, audited: false, auditFailed: false,
            unreadable: 2, truncated: false, fallback: null,
        },
    });
    Venue.paintIssuerHcsHeader(Venue.hcsRecords);
    assert.equal(element("hcs-unreadable").textContent, "2");
    assert.equal(element("hcs-audited").textContent, "not audited");
    assert.equal(element("hcs-loaded").textContent, "loaded");
});

test("HCS audit success and failure are separate from merely loading the topic", () => {
    const {Venue, element} = harness();
    Venue.issuerCore = {
        halted: false, haltUntilText: "Unavailable", capSuspended: false, permits: true,
        regimePending: false, paramPending: false, rulebookPending: false,
        feeChecked: true, noEdition: false, feeMismatch: false,
        immChecked: true, immDrift: 0, immTotal: 12,
        coupon: {missing: false, underfunded: false, feeMismatch: false, nextDate: "x", count: 1},
        currentHex: "0x1", floorHex: "0x0", ceilingHex: "0x2", shareText: "1%", capText: "2%",
        haltBudgetText: "1 / 1 s", rootShort: "0xr", prevRootShort: "none", keyCount: 1,
        paramPendingText: "no proposal", windowText: "Unavailable", editionText: "0xe",
        reconcileText: "Reconciled", chargeCountText: "1", epochNow: "1", latestClosed: "0",
        spentText: "0", epochActivity: "none", registryText: "ZkKycRegistry",
    };
    Venue.setIssuerUi({
        hcs: {
            checked: true, loaded: true, schemaValid: true, snapshotHashAccepted: true,
            audited: false, auditFailed: false, unreadable: 0, truncated: false, fallback: null,
        },
    });
    Venue.renderIssuerOverview();
    assert.equal(element("iss-st-hcs").textContent, "Evidence loaded, not audited");
    Venue.setIssuerUi({
        hcs: {
            checked: true, loaded: true, schemaValid: true, snapshotHashAccepted: true,
            audited: true, auditFailed: false, unreadable: 0, truncated: false, fallback: null,
        },
    });
    Venue.renderIssuerOverview();
    assert.equal(element("iss-st-hcs").textContent, "Evidence verified");
    Venue.setIssuerUi({
        hcs: {
            checked: true, loaded: true, schemaValid: true, snapshotHashAccepted: true,
            audited: true, auditFailed: true, unreadable: 0, truncated: false, fallback: null,
        },
    });
    Venue.renderIssuerOverview();
    assert.equal(element("iss-st-hcs").textContent, "Evidence verification failed");
});

test("network-provided strings and errors cannot inject markup", () => {
    const {Venue, element} = harness();
    Venue.paintTape("tape", [{
        source: "<script>x</script>",
        name: "Evil",
        args: null,
        fragment: null,
        topic0: "0x1",
        tx: "0x2",
        at: 1,
    }]);
    assert.doesNotMatch(element("tape").innerHTML, /<script>x<\/script>/);
    assert.match(element("tape").innerHTML, /&lt;script&gt;x&lt;\/script&gt;/);
});

test("shortcuts are suppressed while typing in form fields", () => {
    const {Venue, docListeners} = harness();
    Venue.bindIssuerChrome();
    const keydown = (docListeners.keydown || [])[0];
    assert.equal(typeof keydown, "function");
    let selected = null;
    Venue.selectIssuerView = (view) => { selected = view; };
    keydown({
        key: "g",
        target: {tagName: "INPUT"},
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        preventDefault() {},
    });
    assert.equal(selected, null);
    keydown({
        key: "g",
        target: {tagName: "DIV"},
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        preventDefault() {},
    });
    assert.equal(selected, "governance");
});

test("escape closes the open modal and restores focus tracking", async () => {
    const {Venue, element, docListeners} = harness();
    Venue.bindIssuerChrome();
    const opener = element("iss-open-activity");
    Venue.issuerUiState().opener = opener;
    element("iss-modal-shortcuts").hidden = true;
    await Venue.openIssuerDetail("shortcuts");
    assert.equal(Venue.issuerUiState().modal, "shortcuts");
    assert.equal(element("iss-modal-shortcuts").hidden, false);
    const keydown = (docListeners.keydown || [])[0];
    keydown({
        key: "Escape",
        target: {tagName: "DIV"},
        preventDefault() {},
    });
    assert.equal(Venue.issuerUiState().modal, null);
    assert.equal(element("iss-modal-shortcuts").hidden, true);
});

test("mountVenue does not eagerly refresh tape or topic", async () => {
    const {Venue} = harness();
    let tape = 0;
    let topic = 0;
    Venue.refreshVenue = async () => {};
    Venue.refreshInstrument = async () => {};
    Venue.refreshTape = async () => { tape += 1; };
    Venue.mountTopic = async (opts) => {
        assert.equal(opts?.lazy, true);
        topic += 1;
    };
    Venue.bindIssuerChrome = () => { Venue._issuerChromeBound = true; };
    await Venue.mountVenue();
    assert.equal(tape, 0);
    assert.equal(topic, 1);
});
