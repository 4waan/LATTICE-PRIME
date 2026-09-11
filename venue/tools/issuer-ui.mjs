// Issuer command center chrome. Inlined only into venue.html after venue-obs
// and hcs-view, so Venue.refreshVenue and the existing contract helpers are in
// scope. Keeps progressive disclosure, hash routing, modals, and the activity
// drawer off the main trading screens.

const ISSUER_VIEWS = Object.freeze(["overview", "governance", "payments", "compliance"]);
const ISSUER_DETAIL_GROUPS = Object.freeze({
    instrument: true,
    controls: true,
    "param-row": true,
    "param-keys": true,
    fees: true,
    immutables: true,
    "coupon-calendar": true,
    "payment-rail": true,
    journal: true,
    transfer: true,
    disclose: true,
    shortcuts: true,
});

Venue.defaultIssuerUi = function () {
    return {
        view: "overview",
        userView: false,
        modal: null,
        drawerOpen: false,
        drawerTab: "activity",
        loaded: {},
        loading: {},
        errors: {},
        lastRefreshAt: null,
        coreStale: false,
        hcs: {
            checked: false,
            loaded: false,
            schemaValid: false,
            snapshotHashAccepted: false,
            audited: false,
            auditFailed: false,
            unreadable: 0,
            truncated: false,
            fallback: null,
        },
        activityChecked: false,
        unread: 0,
        localLog: [],
        attention: [],
        rowDrift: 0,
        opener: null,
    };
};

Venue.issuerUiState = function () {
    if (!Venue.issuerUi) Venue.issuerUi = Venue.defaultIssuerUi();
    return Venue.issuerUi;
};

Venue.setIssuerUi = function (patch) {
    const state = Venue.issuerUiState();
    Object.assign(state, patch);
    return state;
};

Venue.issuerCoreState = function () {
    if (!Venue.issuerCore) Venue.issuerCore = null;
    return Venue.issuerCore;
};

Venue.issuerNormalizeView = function (raw) {
    const view = String(raw || "").replace(/^#/, "").toLowerCase();
    return ISSUER_VIEWS.includes(view) ? view : "overview";
};

Venue.selectIssuerView = function (view, {user = false, hash = true} = {}) {
    const next = Venue.issuerNormalizeView(view);
    Venue.setIssuerUi({
        view: next,
        userView: user ? true : Venue.issuerUiState().userView,
    });
    const toggle = $("iss-view-toggle");
    if (toggle) toggle.dataset.view = next;
    for (const name of ISSUER_VIEWS) {
        const panel = $("iss-" + name);
        const tab = $("iss-view-" + name);
        if (panel) panel.hidden = name !== next;
        if (tab) {
            tab.setAttribute("aria-selected", name === next ? "true" : "false");
            tab.tabIndex = name === next ? 0 : -1;
        }
    }
    if (hash && typeof location !== "undefined") {
        const want = "#" + next;
        if (location.hash !== want) {
            try {
                history.replaceState(null, "", want);
            } catch (e) {
                location.hash = want;
            }
        }
    }
    if (next === "payments") Venue.ensureIssuerDetail("coupon-summary").catch(() => {});
    return next;
};

Venue.issuerTone = function (el, tone, text) {
    if (!el) return;
    el.textContent = text;
    el.className = "iss-tone-" + (tone || "neutral");
};

Venue.issuerPut = function (id, text) {
    const el = $(id);
    if (el) el.textContent = text == null ? "Unavailable" : String(text);
};

Venue.issuerAt = function (ts) {
    if (asBig(ts) === 0n) return "Unavailable";
    return new Date(Number(ts) * 1000).toISOString().slice(0, 19).replace("T", " ") + "Z";
};

Venue.issuerBps = function (v) {
    return (Number(v) / 100).toFixed(2) + "%";
};

Venue.recordIssuerActivity = function ({title, detail, tx, source = "local"} = {}) {
    const state = Venue.issuerUiState();
    const entry = {
        at: Date.now(),
        title: String(title || "UI action"),
        detail: detail ? String(detail) : "",
        tx: tx || null,
        source,
    };
    state.localLog = [entry, ...(state.localLog || [])].slice(0, 40);
    if (!state.drawerOpen) Venue.setIssuerUi({unread: Number(state.unread || 0) + 1});
    Venue.paintIssuerLocalLog();
    Venue.paintIssuerBadge();
};

Venue.paintIssuerBadge = function () {
    const badge = $("iss-activity-badge");
    if (!badge) return;
    const unread = Number(Venue.issuerUiState().unread || 0);
    badge.hidden = unread <= 0;
    badge.textContent = unread > 9 ? "9+" : String(unread);
};

Venue.paintIssuerLocalLog = function () {
    const el = $("iss-local-log");
    if (!el) return;
    const rows = Venue.issuerUiState().localLog || [];
    if (!rows.length) {
        el.innerHTML = '<div class="empty">No local checks recorded this session.</div>';
        return;
    }
    el.innerHTML = rows.map((row) => {
        const when = new Date(row.at).toLocaleString();
        const link = row.tx
            ? ' · <a href="' + esc(explorerTx(row.tx)) + '" target="_blank" rel="noopener noreferrer">' +
              esc(shortId(row.tx)) + "</a>"
            : "";
        return '<div class="fin-activity-item">' +
            "<header><strong>" + esc(row.title) + "</strong><time>" + esc(when) + "</time></header>" +
            '<p><span class="iss-tape-src">Local UI · ' + esc(row.source) + "</span>" +
            (row.detail ? " · " + esc(row.detail) : "") + link + "</p></div>";
    }).join("");
};

Venue.issuerAttentionItems = function (core) {
    if (!core) return [];
    const items = [];
    const add = (id, title, consequence, source, action) => {
        if (items.some((item) => item.id === id)) return;
        items.push({id, title, consequence, source, action});
    };
    if (core.halted) {
        add("halt", "Trading halted",
            core.haltUntilText === "Unavailable"
                ? "The venue is not accepting trading activity."
                : "Halted until " + core.haltUntilText + ".",
            "TradingHalt", {type: "open", group: "controls"});
    }
    if (core.capSuspended) {
        add("cap", "Volume cap suspended",
            "Disclosure point is held at the suspended floor by arithmetic, not an operator decision.",
            "VolumeCap", {type: "open", group: "controls"});
    }
    if (core.permits === false) {
        add("regime", "Current regime point refused",
            "The live lattice point is outside the permitted band.",
            "Regime", {type: "open", group: "controls"});
    }
    if (core.regimePending || core.paramPending || core.rulebookPending) {
        add("gov-pending", "Governance change pending",
            "A regime, parameter, or rulebook proposal is waiting on its window.",
            "Governance", {type: "view", view: "governance"});
    }
    if (core.immChecked && core.immDrift > 0) {
        add("imm", "Immutable drift detected",
            core.immDrift + " embedded value" + (core.immDrift === 1 ? " has" : "s have") +
            " moved since this bundle was generated.",
            "Immutables", {type: "open", group: "immutables"});
    }
    if (core.feeChecked && core.feeMismatch) {
        add("fees", "Fee schedule mismatch",
            "Published charges do not match live contract charges.",
            "Rulebook", {type: "open", group: "fees"});
    }
    if (core.feeChecked && core.noEdition) {
        add("no-fees", "No fee schedule published",
            "reconcile is vacuously true because nothing is published to compare.",
            "Rulebook", {type: "open", group: "fees"});
    }
    if (core.coupon) {
        if (core.coupon.missing) {
            add("no-coupon", "Missing coupon rail",
                "No coupon payment rail is named in this address book.",
                "Coupon", {type: "view", view: "payments"});
        } else {
            if (core.coupon.feeMismatch) {
                add("hts-fee", "HTS paying-agent fee mismatch",
                    "Live Mirror Node token fee does not match the configured tariff.",
                    "HTS", {type: "open", group: "payment-rail"});
            }
            if (core.coupon.underfunded) {
                add("hss", "Insufficient HSS reserve",
                    "Reserved funding cannot cover another scheduled settlement call.",
                    "HSS", {type: "open", group: "payment-rail"});
            }
        }
    }
    if (core.journalDisagree) {
        add("journal", "Journal getters disagree",
            "explain and canTransfer returned different answers for the last check.",
            "SeamJournal", {type: "open", group: "transfer"});
    }
    const hcs = Venue.issuerUiState().hcs;
    if (hcs.checked && hcs.unreadable > 0) {
        add("hcs-unreadable", "Unreadable HCS messages",
            hcs.unreadable + " topic message" + (hcs.unreadable === 1 ? "" : "s") +
            " failed schema validation.",
            "HCS", {type: "drawer", tab: "evidence"});
    }
    if (hcs.checked && hcs.fallback) {
        add("hcs-snap", "Invalid HCS snapshot",
            "Committed snapshot was set aside: " + hcs.fallback,
            "HCS", {type: "drawer", tab: "evidence"});
    }
    if (hcs.auditFailed) {
        add("hcs-audit", "HCS audit failure",
            "One or more loaded records did not match chain state.",
            "HCS", {type: "drawer", tab: "evidence"});
    }
    if (core.readError) {
        add("rpc", "Issuer read failure",
            core.readError,
            "RPC / Mirror", {type: "refresh"});
    }
    return items;
};

Venue.renderIssuerAttention = function () {
    const list = $("iss-attention-list");
    if (!list) return;
    const items = Venue.issuerAttentionItems(Venue.issuerCore);
    Venue.setIssuerUi({attention: items});
    if (!items.length) {
        list.innerHTML = '<div class="iss-attention-ok" id="iss-attention-ok">' +
            "No issues detected from completed checks</div>";
        return;
    }
    list.innerHTML = items.map((item) =>
        '<div class="attention-item ' +
        (item.id === "halt" || item.id === "rpc" || item.id === "hcs-audit" ? "danger" : "warning") +
        '" data-attention="' + esc(item.id) + '">' +
        "<div><strong>" + esc(item.title) + "</strong>" +
        "<p>" + esc(item.consequence) + " · " + esc(item.source) + "</p></div>" +
        '<button type="button" data-attention-action="' + esc(item.id) + '">Review</button></div>'
    ).join("");
    list.querySelectorAll("[data-attention-action]").forEach((button) => {
        button.addEventListener("click", () => {
            const item = Venue.issuerUiState().attention.find((row) => row.id === button.dataset.attentionAction);
            if (!item) return;
            Venue.runIssuerAttentionAction(item.action);
        });
    });
};

Venue.runIssuerAttentionAction = function (action) {
    if (!action) return;
    if (action.type === "open") Venue.openIssuerDetail(action.group);
    else if (action.type === "view") Venue.selectIssuerView(action.view, {user: true});
    else if (action.type === "drawer") Venue.openIssuerDrawer(action.tab);
    else if (action.type === "refresh") Venue.refreshIssuerCore().catch((e) => Venue.fail(e));
};

Venue.renderIssuerOverview = function () {
    const core = Venue.issuerCore;
    if (!core) return;

    const tradingText = core.halted
        ? (core.haltUntilText === "Unavailable" ? "Halted" : "Halted until " + core.haltUntilText.replace("Z", " UTC"))
        : "Trading active";
    Venue.issuerTone($("iss-st-trading"), core.halted ? "bad" : "ok", tradingText);

    Venue.issuerTone($("iss-st-cap"),
        core.capSuspended ? "bad" : "ok",
        core.capSuspended ? "Cap suspended" : "Under volume cap");

    Venue.issuerTone($("iss-st-regime"),
        core.permits ? "ok" : "bad",
        core.permits ? "Current regime permitted" : "Current regime refused");

    const govPending = core.regimePending || core.paramPending || core.rulebookPending;
    Venue.issuerTone($("iss-st-gov"),
        govPending ? "warn" : "ok",
        govPending ? "Governance change pending" : "No governance proposal");

    if (!core.feeChecked) {
        Venue.issuerTone($("iss-st-fees"), "neutral", "Not loaded");
    } else if (core.noEdition) {
        Venue.issuerTone($("iss-st-fees"), "neutral", "No schedule published");
    } else if (core.feeMismatch) {
        Venue.issuerTone($("iss-st-fees"), "bad", "Fee schedule mismatch");
    } else {
        Venue.issuerTone($("iss-st-fees"), "ok", "Fee schedule matches");
    }

    if (!core.immChecked) {
        Venue.issuerTone($("iss-st-imm"), "neutral", "Not loaded");
    } else if (core.immDrift > 0) {
        Venue.issuerTone($("iss-st-imm"), "bad",
            core.immDrift + " immutable value" + (core.immDrift === 1 ? "" : "s") + " changed");
    } else {
        Venue.issuerTone($("iss-st-imm"), "ok",
            core.immTotal + " of " + core.immTotal + " immutables match");
    }

    if (!core.coupon || core.coupon.missing) {
        Venue.issuerTone($("iss-st-pay"), core.coupon ? "warn" : "neutral",
            core.coupon ? "Payment rail needs funding" : "Not loaded");
        if (core.coupon?.missing) Venue.issuerTone($("iss-st-pay"), "neutral", "No coupon rail");
    } else if (core.coupon.underfunded || core.coupon.feeMismatch) {
        Venue.issuerTone($("iss-st-pay"), "warn", "Payment rail needs funding");
    } else {
        Venue.issuerTone($("iss-st-pay"), "ok", "Payment rail funded");
    }

    const hcs = Venue.issuerUiState().hcs;
    if (!hcs.checked) {
        Venue.issuerTone($("iss-st-hcs"), "neutral", "Evidence not checked");
    } else if (hcs.auditFailed || hcs.fallback || hcs.unreadable > 0) {
        Venue.issuerTone($("iss-st-hcs"), "bad", "Evidence verification failed");
    } else if (hcs.audited) {
        Venue.issuerTone($("iss-st-hcs"), "ok", "Evidence verified");
    } else {
        Venue.issuerTone($("iss-st-hcs"), "warn", "Evidence loaded, not audited");
    }

    Venue.issuerPut("iss-sum-trading", tradingText);
    Venue.issuerPut("iss-sum-regime",
        core.permits ? "Permitted at " + core.currentHex : "Refused at " + core.currentHex);
    Venue.issuerPut("iss-sum-volume",
        core.shareText + " of " + core.capText + (core.capSuspended ? " · suspended" : ""));
    Venue.issuerPut("iss-sum-priority",
        core.halted ? "Trading halted"
            : core.capSuspended ? "Volume cap suspended"
                : !core.permits ? "Regime refused"
                    : govPending ? "Governance pending"
                        : "No high-priority warning");
    Venue.issuerPut("iss-sum-root", core.rootShort);
    Venue.issuerPut("iss-sum-pending",
        govPending ? "Proposal pending" : "No proposal");
    Venue.issuerPut("iss-sum-rulebook",
        !core.feeChecked ? "Not loaded"
            : core.noEdition ? "Not published"
                : core.feeMismatch ? "Mismatch" : "Reconciled");
    Venue.issuerPut("iss-sum-imm",
        !core.immChecked ? "Not loaded"
            : core.immDrift ? core.immDrift + " drifted" : core.immTotal + " match");

    if (core.coupon && !core.coupon.missing) {
        Venue.issuerPut("iss-sum-next", core.coupon.nextDate || "Unavailable");
        Venue.issuerPut("iss-sum-coupons", String(core.coupon.count));
        Venue.issuerPut("iss-sum-reserve",
            core.coupon.underfunded ? "Needs funding" : "Ready");
    } else {
        Venue.issuerPut("iss-sum-next", core.coupon?.missing ? "No rail" : "Not loaded");
        Venue.issuerPut("iss-sum-coupons", "—");
        Venue.issuerPut("iss-sum-reserve", "—");
    }
    Venue.issuerPut("iss-sum-disc",
        "Epoch " + core.epochNow + " · " + core.spentText);

    Venue.issuerPut("gov-sum-trading", tradingText);
    Venue.issuerPut("gov-sum-point", core.currentHex);
    Venue.issuerPut("gov-sum-permits", core.permits ? "Permitted" : "Refused");
    Venue.issuerPut("gov-sum-band", core.floorHex + " / " + core.ceilingHex);
    Venue.issuerPut("gov-sum-share", core.shareText + " / " + core.capText);
    Venue.issuerPut("gov-sum-budget", core.haltBudgetText);
    Venue.issuerPut("gov-sum-root", core.rootShort);
    Venue.issuerPut("gov-sum-prev", core.prevRootShort);
    Venue.issuerPut("gov-sum-keys", String(core.keyCount));
    Venue.issuerPut("gov-sum-pending", core.paramPendingText);
    Venue.issuerPut("gov-sum-window", core.windowText);
    Venue.issuerPut("gov-sum-drift",
        Venue.issuerUiState().rowDrift
            ? Venue.issuerUiState().rowDrift + " drifted row value(s)"
            : (core.immChecked ? "No row drift checked yet" : "Not checked"));
    Venue.issuerPut("gov-sum-edition", core.editionText);
    Venue.issuerPut("gov-sum-published", core.noEdition ? "Not published" : "Published");
    Venue.issuerPut("gov-sum-reconcile", core.reconcileText);
    Venue.issuerPut("gov-sum-charges", core.chargeCountText);
    Venue.issuerPut("gov-sum-imm",
        !core.immChecked ? "Not loaded"
            : core.immDrift + " drift / " + core.immTotal);
    Venue.issuerPut("gov-sum-minfee", core.minFeeText || "Not loaded");

    Venue.issuerPut("cmp-registry", core.registryText);
    Venue.issuerPut("cmp-epoch", String(core.epochNow));
    Venue.issuerPut("cmp-spent", core.spentText);
    Venue.issuerPut("cmp-activity", core.epochActivity);
    Venue.issuerPut("cmp-state",
        core.permits === false ? "Regime blocking"
            : core.halted ? "Trading halted"
                : "Journal metering active");

    Venue.issuerPut("disc-latest", String(core.latestClosed));
    Venue.issuerPut("disc-spent", core.spentText);
    Venue.issuerPut("disc-wallet", Venue.account ? shortAddr(Venue.account) : "Not connected");

    if (core.coupon && !core.coupon.missing) Venue.paintIssuerPaymentsSummary(core.coupon);

    const refreshed = $("iss-refreshed");
    if (refreshed && Venue.issuerUiState().lastRefreshAt) {
        refreshed.textContent = "Last refreshed " +
            new Date(Venue.issuerUiState().lastRefreshAt).toLocaleString() +
            (Venue.issuerUiState().coreStale ? " · stale" : "");
    }

    Venue.issuerPut("iss-instrument-chip",
        (core.tokenName || "Instrument") + " · " + (core.tokenSymbol || "—"));
    Venue.issuerPut("iss-detail-name", core.tokenName || "Unavailable");
    Venue.issuerPut("iss-detail-symbol", core.tokenSymbol || "Unavailable");
    const detailAddr = $("iss-detail-addr");
    if (detailAddr) {
        detailAddr.innerHTML = '<a href="' + esc(explorerAddr(CLIENT.addresses.token)) +
            '" target="_blank" rel="noopener noreferrer">' +
            esc(CLIENT.addresses.token) + "</a>";
    }

    Venue.renderIssuerAttention();
};

Venue.paintIssuerPaymentsSummary = function (coupon) {
    if (!coupon || coupon.missing) {
        Venue.issuerPut("pay-ready", "No coupon payment rail is named in this address book.");
        return;
    }
    const ready = !coupon.underfunded && !coupon.feeMismatch;
    const readyEl = $("pay-ready");
    if (readyEl) {
        readyEl.textContent = ready
            ? "Payment rail ready: reserve covers another call and the HTS fee matches the tariff."
            : coupon.feeMismatch
                ? "Payment rail blocked: live HTS paying-agent fee does not match the configured tariff."
                : "Payment rail needs funding: reserved HBAR cannot cover another scheduled call.";
        readyEl.className = "iss-pay-ready " + (ready ? "iss-tone-ok" : "iss-tone-warn");
    }
    Venue.issuerPut("pay-next", coupon.nextDate || "Unavailable");
    Venue.issuerPut("pay-remain", coupon.remainText || "Unavailable");
    Venue.issuerPut("pay-count", String(coupon.count));
    Venue.issuerPut("pay-spread", coupon.spread + " bps");
    Venue.issuerPut("pay-face", coupon.face + " cash units");
    Venue.issuerPut("pay-basis", coupon.basisText);
    Venue.issuerPut("pay-cash", coupon.cashText);
    Venue.issuerPut("pay-fee",
        coupon.liveFeeBps + " bps · " + (coupon.feeMismatch ? "MISMATCH" : "matches tariff"));
    Venue.issuerPut("pay-reserved", coupon.reservedText);
    Venue.issuerPut("pay-funding", coupon.fundingText);
    Venue.issuerPut("pay-funded", String(coupon.funded));

    const three = $("pay-next-three");
    if (three) {
        const rows = (coupon.upcoming || []).slice(0, 3);
        three.innerHTML = rows.length
            ? rows.map((row) =>
                '<div class="rowline pset"><span>Coupon ' + esc(String(row.index)) + "</span>" +
                "<span>" + esc(row.label) + '</span><span class="mono">' +
                esc(String(row.dueAt)) + "</span></div>").join("")
            : '<div class="empty">No upcoming coupon periods.</div>';
    }
    const cal = $("coupon-calendar");
    if (cal && coupon.calendarHtml) cal.innerHTML = coupon.calendarHtml;
};

Venue.issuerPopupFocusable = function (root) {
    if (!root) return [];
    return [...root.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((el) => !el.hidden && el.offsetParent !== null);
};

Venue.closeIssuerDetail = function () {
    const state = Venue.issuerUiState();
    const open = state.modal;
    if (!open) return;
    const modal = $("iss-modal-" + open);
    if (modal) modal.hidden = true;
    const anyDrawer = state.drawerOpen;
    if (!anyDrawer) {
        $("iss-modal-backdrop").hidden = true;
        document.documentElement.classList.remove("iss-popup-open");
    }
    Venue.setIssuerUi({modal: null});
    const opener = state.opener;
    Venue.setIssuerUi({opener: null});
    try { opener?.focus?.(); } catch (e) { /* element may be gone */ }
};

Venue.openIssuerDetail = async function (group) {
    if (!ISSUER_DETAIL_GROUPS[group]) return;
    const state = Venue.issuerUiState();
    if (state.drawerOpen) Venue.closeIssuerDrawer();
    if (state.modal && state.modal !== group) Venue.closeIssuerDetail();
    const modal = $("iss-modal-" + group);
    if (!modal) return;
    Venue.setIssuerUi({
        modal: group,
        opener: document.activeElement,
    });
    $("iss-modal-backdrop").hidden = false;
    modal.hidden = false;
    document.documentElement.classList.add("iss-popup-open");
    await Venue.ensureIssuerDetail(group).catch((e) => Venue.fail(e));
    const focusable = Venue.issuerPopupFocusable(modal);
    (focusable[0] || modal.querySelector("[data-close]") || modal).focus?.();
};

Venue.closeIssuerDrawer = function () {
    const drawer = $("iss-drawer");
    const backdrop = $("iss-drawer-backdrop");
    if (!drawer) return;
    Venue.setIssuerUi({drawerOpen: false});
    drawer.hidden = true;
    if (backdrop) backdrop.hidden = true;
    $("iss-open-activity")?.setAttribute("aria-expanded", "false");
    if (!Venue.issuerUiState().modal) {
        document.documentElement.classList.remove("iss-popup-open");
    }
    const opener = Venue.issuerUiState().opener;
    Venue.setIssuerUi({opener: null});
    try { opener?.focus?.(); } catch (e) { /* ignore */ }
};

Venue.setIssuerDrawerTab = function (tab) {
    const next = tab === "evidence" ? "evidence" : "activity";
    Venue.setIssuerUi({drawerTab: next});
    const activity = $("iss-activity-panel");
    const evidence = $("iss-evidence-panel");
    if (activity) activity.hidden = next !== "activity";
    if (evidence) evidence.hidden = next !== "evidence";
    $("iss-tab-activity")?.setAttribute("aria-selected", next === "activity" ? "true" : "false");
    $("iss-tab-evidence")?.setAttribute("aria-selected", next === "evidence" ? "true" : "false");
    const title = $("iss-drawer-title");
    if (title) title.textContent = next === "evidence" ? "HCS evidence" : "Venue activity";
    const status = $("iss-drawer-status");
    if (status) {
        if (next === "evidence") {
            status.textContent = Venue.issuerUiState().hcs.checked
                ? "Topic loaded this session"
                : "Not checked this session";
        } else {
            status.textContent = Venue.issuerUiState().activityChecked
                ? "Mirror Node tape loaded this session"
                : "Not checked this session";
        }
    }
};

Venue.openIssuerDrawer = async function (tab) {
    if (Venue.issuerUiState().modal) Venue.closeIssuerDetail();
    const drawer = $("iss-drawer");
    const backdrop = $("iss-drawer-backdrop");
    if (!drawer) return;
    Venue.setIssuerUi({
        drawerOpen: true,
        unread: 0,
        opener: document.activeElement,
    });
    Venue.paintIssuerBadge();
    Venue.setIssuerDrawerTab(tab || Venue.issuerUiState().drawerTab);
    drawer.hidden = false;
    if (backdrop) backdrop.hidden = false;
    document.documentElement.classList.add("iss-popup-open");
    $("iss-open-activity")?.setAttribute("aria-expanded", "true");
    const focusable = Venue.issuerPopupFocusable(drawer);
    (focusable[0] || $("iss-drawer-close"))?.focus?.();
    const useTab = tab || Venue.issuerUiState().drawerTab;
    if (useTab === "evidence") await Venue.refreshIssuerEvidence({lazy: true});
    else await Venue.refreshIssuerActivity({lazy: true});
};

Venue.ensureIssuerDetail = async function (group) {
    const state = Venue.issuerUiState();
    const loaded = state.loaded || {};
    if (group === "param-row") {
        if (!loaded["param-row"]) {
            await Venue.refreshParamRow();
            loaded["param-row"] = true;
        }
        return;
    }
    if (group === "param-keys") {
        if (!loaded["param-keys"]) {
            await Venue.refreshParamSet();
            loaded["param-keys"] = true;
        }
        return;
    }
    if (group === "fees") {
        if (!loaded.fees) {
            const n = Number(Venue.issuerCore?.chargeCount || 0);
            await Venue.refreshCharges(n);
            loaded.fees = true;
        }
        return;
    }
    if (group === "immutables") {
        if (!loaded.immutables) {
            await Venue.refreshImmutables();
            loaded.immutables = true;
        }
        return;
    }
    if (group === "coupon-calendar" || group === "payment-rail" || group === "coupon-summary") {
        if (!loaded.coupon) {
            await Venue.refreshCoupon();
            loaded.coupon = true;
        } else if (Venue.issuerCoupon) {
            Venue.paintIssuerPaymentsSummary(Venue.issuerCoupon);
            if (group === "payment-rail") Venue.paintCouponDetail?.(Venue.issuerCoupon);
            if (group === "coupon-calendar" && Venue.issuerCoupon.calendarHtml) {
                const cal = $("coupon-calendar");
                if (cal) cal.innerHTML = Venue.issuerCoupon.calendarHtml;
            }
        }
        return;
    }
    if (group === "disclose") {
        const de = $("disc-epoch-in");
        if (de && Venue.issuerCore && !de.value) {
            de.value = String(Venue.issuerCore.latestClosed);
        }
        Venue.issuerPut("disc-wallet", Venue.account ? shortAddr(Venue.account) : "Not connected");
        return;
    }
    // instrument, controls, journal, transfer, shortcuts use core paint only
};

Venue.refreshIssuerActivity = async function ({lazy = false, force = false} = {}) {
    const state = Venue.issuerUiState();
    if (lazy && state.activityChecked && !force) return;
    await Venue.refreshTape();
    Venue.setIssuerUi({activityChecked: true});
    const status = $("iss-drawer-status");
    if (status && state.drawerTab === "activity") {
        status.textContent = "Mirror Node tape loaded this session";
    }
    Venue.recordIssuerActivity({
        title: "Venue activity refreshed",
        detail: "Scope " + ($("tape-scope")?.value || "governance"),
        source: "mirror",
    });
};

Venue.refreshIssuerEvidence = async function ({lazy = false, force = false} = {}) {
    const state = Venue.issuerUiState();
    if (lazy && state.hcs.checked && !force) {
        Venue.paintTopic?.(Venue.hcsRecords);
        return;
    }
    if (!Venue.refreshTopic) return;
    await Venue.refreshTopic();
    const records = Venue.hcsRecords;
    const hcs = {
        ...state.hcs,
        checked: true,
        loaded: !!(records && records.records),
        schemaValid: true,
        snapshotHashAccepted: !!(records && records.snapshot && !records.fallback),
        unreadable: records ? Number(records.unreadable || 0) : 0,
        truncated: !!(records && records.truncated),
        fallback: records && records.fallback ? String(records.fallback) : null,
        audited: false,
        auditFailed: false,
    };
    Venue.setIssuerUi({hcs});
    Venue.paintIssuerHcsHeader(records);
    Venue.renderIssuerOverview();
    const status = $("iss-drawer-status");
    if (status && Venue.issuerUiState().drawerTab === "evidence") {
        status.textContent = "Topic loaded this session";
    }
};

Venue.paintIssuerHcsHeader = function (state) {
    const put = Venue.issuerPut;
    if (!HCS || !HCS.topicId) {
        put("hcs-topic-id", "No topic configured");
        put("hcs-loaded", "not loaded");
        put("hcs-schema", "not checked");
        put("hcs-hash", "not checked");
        put("hcs-audited", "not audited");
        return;
    }
    put("hcs-topic-id", HCS.topicId);
    if (!state) {
        put("hcs-readable", "—");
        put("hcs-unreadable", "—");
        put("hcs-snapshot", "—");
        put("hcs-live", "—");
        put("hcs-last-seq", "—");
        put("hcs-loaded", "not loaded");
        put("hcs-schema", "not checked");
        put("hcs-hash", "not checked");
        put("hcs-audited", "not audited");
        return;
    }
    put("hcs-readable", String((state.records || []).length));
    put("hcs-unreadable", String(state.unreadable || 0));
    put("hcs-snapshot", state.snapshot
        ? "through #" + state.snapshot.through
        : (state.fallback ? "set aside" : "none"));
    put("hcs-live", String(state.live || 0));
    const last = (state.records || [])[0];
    put("hcs-last-seq", last ? String(last.seq) : "—");
    put("hcs-loaded", "loaded");
    put("hcs-schema", "schema valid for rendered rows");
    put("hcs-hash", state.snapshot
        ? "snapshot hash accepted"
        : (state.fallback ? "fallback: " + state.fallback : "full topic read"));
    const hcs = Venue.issuerUiState().hcs;
    put("hcs-audited", hcs.audited
        ? (hcs.auditFailed ? "audit failed" : "audited against chain")
        : "not audited");
};

Venue.invalidateIssuerCache = function (groups) {
    const loaded = {...(Venue.issuerUiState().loaded || {})};
    for (const group of groups) delete loaded[group];
    Venue.setIssuerUi({loaded, coreStale: false});
};

Venue.refreshIssuerCore = async function () {
    await Venue.refreshVenue();
};

Venue.bindIssuerChrome = function () {
    if (Venue._issuerChromeBound || !$("iss-view-toggle")) return;
    Venue._issuerChromeBound = true;
    const prior = Venue.issuerUi;
    Venue.issuerUi = Venue.defaultIssuerUi();
    if (prior?.userView) {
        Venue.issuerUi.view = Venue.issuerNormalizeView(prior.view);
        Venue.issuerUi.userView = true;
        Venue.issuerUi.drawerTab = prior.drawerTab || "activity";
        Venue.issuerUi.localLog = prior.localLog || [];
        Venue.issuerUi.hcs = prior.hcs || Venue.issuerUi.hcs;
        Venue.issuerUi.activityChecked = !!prior.activityChecked;
    }

    const hashView = Venue.issuerNormalizeView(
        (typeof location !== "undefined" && location.hash) || "overview");
    Venue.selectIssuerView(
        prior?.userView ? Venue.issuerUi.view : hashView,
        {user: !!prior?.userView, hash: true});

    $("iss-view-toggle")?.addEventListener("click", (event) => {
        const button = event.target.closest("[data-view]");
        if (!button) return;
        Venue.selectIssuerView(button.dataset.view, {user: true});
    });

    window.addEventListener("hashchange", () => {
        if (Venue.page !== "venue") return;
        Venue.selectIssuerView(location.hash, {user: true, hash: false});
    });

    $("iss-refresh")?.addEventListener("click", () => {
        Venue.invalidateIssuerCache(["param-row", "param-keys", "fees", "immutables", "coupon"]);
        Venue.setIssuerUi({activityChecked: false, hcs: {...Venue.issuerUiState().hcs, checked: false, audited: false}});
        Venue.refreshIssuerCore().catch((e) => Venue.fail(e));
    });
    $("iss-open-activity")?.addEventListener("click", () => Venue.openIssuerDrawer("activity"));
    $("iss-shortcuts")?.addEventListener("click", () => Venue.openIssuerDetail("shortcuts"));
    $("iss-copy-token")?.addEventListener("click", async () => {
        const value = CLIENT.addresses.token;
        try {
            await navigator.clipboard.writeText(value);
            Venue.toast("Token address copied");
        } catch (e) {
            Venue.toast("Could not copy address");
        }
    });
    $("iss-hashscan")?.addEventListener?.("click", () => {});

    document.addEventListener("click", (event) => {
        if (Venue.page !== "venue") return;
        const openEl = event.target.closest("[data-open]");
        if (openEl && (openEl.closest(".issuer-page") || openEl.closest(".iss-workspace") ||
            openEl.classList?.contains("iss-card-action") || openEl.classList?.contains("iss-card") ||
            openEl.classList?.contains("primary"))) {
            const group = openEl.getAttribute("data-open");
            if (group && ISSUER_DETAIL_GROUPS[group]) {
                event.preventDefault();
                Venue.openIssuerDetail(group);
                return;
            }
        }
        const gotoEl = event.target.closest("[data-goto]");
        if (gotoEl) {
            const view = gotoEl.getAttribute("data-goto");
            if (view) {
                event.preventDefault();
                Venue.selectIssuerView(view, {user: true});
            }
        }
    });

    $("iss-modal-backdrop")?.addEventListener("click", () => {
        const modal = Venue.issuerUiState().modal;
        if (!modal) return;
        const node = $("iss-modal-" + modal);
        if (node?.dataset?.transactional === "true") return;
        Venue.closeIssuerDetail();
    });
    document.querySelectorAll(".iss-modal [data-close]").forEach((button) => {
        button.addEventListener("click", () => Venue.closeIssuerDetail());
    });

    $("iss-drawer-close")?.addEventListener("click", () => Venue.closeIssuerDrawer());
    $("iss-drawer-backdrop")?.addEventListener("click", () => Venue.closeIssuerDrawer());
    $("iss-tab-activity")?.addEventListener("click", () => {
        Venue.setIssuerDrawerTab("activity");
        Venue.refreshIssuerActivity({lazy: true}).catch((e) => Venue.fail(e));
    });
    $("iss-tab-evidence")?.addEventListener("click", () => {
        Venue.setIssuerDrawerTab("evidence");
        Venue.refreshIssuerEvidence({lazy: true}).catch((e) => Venue.fail(e));
    });
    $("tape-reload")?.addEventListener("click", () => {
        Venue.refreshIssuerActivity({force: true}).catch((e) => Venue.fail(e));
    });
    $("hcs-filter")?.addEventListener("change", () => {
        Venue.paintTopic?.(Venue.hcsRecords);
    });
    $("param-keys-search")?.addEventListener("input", () => {
        const q = ($("param-keys-search")?.value || "").trim().toLowerCase();
        $("param-set")?.querySelectorAll(".rowline.pset:not(.head)").forEach((row) => {
            row.hidden = q ? !row.textContent.toLowerCase().includes(q) : false;
        });
    });
    $("ex-use-wallet")?.addEventListener("click", () => {
        if (!Venue.account) {
            Venue.toast("Connect a wallet first");
            return;
        }
        const input = $("ex-from");
        if (input) input.value = Venue.account;
    });
    $("param-row")?.addEventListener("change", () => {
        Venue.invalidateIssuerCache(["param-row"]);
        Venue.ensureIssuerDetail("param-row").catch((e) => Venue.fail(e));
    });
    $("journal-go")?.addEventListener("click", () => Venue.doExplain().catch((e) => Venue.fail(e)));
    $("disclose-go")?.addEventListener("click", () => Venue.doDisclose().catch((e) => Venue.fail(e)));

    document.addEventListener("keydown", (event) => {
        if (Venue.page !== "venue") return;
        const state = Venue.issuerUiState();
        const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || "");
        if (event.key === "Escape") {
            if (state.modal) {
                event.preventDefault();
                Venue.closeIssuerDetail();
                return;
            }
            if (state.drawerOpen) {
                event.preventDefault();
                Venue.closeIssuerDrawer();
                return;
            }
        }
        if (state.modal || state.drawerOpen) {
            const root = state.modal
                ? $("iss-modal-" + state.modal)
                : $("iss-drawer");
            if (event.key === "Tab" && root) {
                const nodes = Venue.issuerPopupFocusable(root);
                if (!nodes.length) return;
                const first = nodes[0];
                const last = nodes[nodes.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            }
            return;
        }
        if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === "g" || event.key === "G") {
            event.preventDefault();
            Venue.selectIssuerView("governance", {user: true});
        } else if (event.key === "p" || event.key === "P") {
            event.preventDefault();
            Venue.selectIssuerView("payments", {user: true});
        } else if (event.key === "c" || event.key === "C") {
            event.preventDefault();
            Venue.selectIssuerView("compliance", {user: true});
        } else if (event.key === "a" || event.key === "A") {
            event.preventDefault();
            Venue.openIssuerDrawer();
        } else if (event.key === "?") {
            event.preventDefault();
            Venue.openIssuerDetail("shortcuts");
        } else if (event.key === "/") {
            const search = $("param-keys-search");
            if (search && Venue.issuerUiState().modal === "param-keys") {
                event.preventDefault();
                search.focus();
            }
        }
    });

    window.addEventListener("popstate", () => {
        if (Venue.page !== "venue") return;
        if (Venue.issuerUiState().modal) {
            Venue.closeIssuerDetail();
            return;
        }
        if (Venue.issuerUiState().drawerOpen) Venue.closeIssuerDrawer();
    });

    const scan = $("iss-hashscan");
    if (scan) {
        scan.href = explorerAddr(CLIENT.addresses.token);
        scan.hidden = false;
    }
    Venue.paintIssuerBadge();
    Venue.paintIssuerLocalLog();
};
