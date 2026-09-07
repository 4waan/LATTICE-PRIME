// Live client runtime. Inlined into the three screens by tools/gen-app.mjs.
// Relies on globals from the previous INLINE blocks: CLIENT, ABI, units,
// commitmentOf / preimageWords / SIDE / selector, lattice receiptFor, and ethers.

const ZERO = "0x0000000000000000000000000000000000000000";
const ATS_KYC = "0xfc855b1b";
const TICKET_VER = 1;
const HOLD_VER = 1;
const ROW_NAMES = {
    3: "Order size",
    4: "Order price",
    5: "Execution price",
    7: "Asset",
    12: "Counterparty",
    13: "Match predicate",
    14: "Position",
    15: "Activity fingerprint",
    16: "Cadence",
    17: "Account provenance",
};
const SIGS = [
    {i: 0, name: "nullifier", pin: "not pinned; usesThisEpoch caps reuse"},
    {i: 1, name: "passes", pin: "must equal 1"},
    {i: 2, name: "credentialRoot", pin: "rootForEpoch(current epoch)"},
    {i: 3, name: "epoch", pin: "registry.currentEpoch()"},
    {i: 4, name: "registrant", pin: "the connected account"},
    {i: 5, name: "minTier", pin: "gate.minTier()"},
    {i: 6, name: "jurisdictionMask", pin: "gate.jurisdictionMask()"},
];
const REPO_STATE = ["NONE", "PROPOSED", "OPEN", "MARGIN_CALL", "MANUFACTURED", "FAILING", "DEFAULTED", "CLOSED"];
const G_NAME = ["none", "predicate", "aggregate", "bucket", "exact"];
const T_NAME = ["before the fact", "immediately", "after 15 minutes", "at end of day", "at end of epoch", "never"];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));
const shortAddr = (a) => a ? a.slice(0, 6) + "…" + a.slice(-4) : "—";
const shortId = (id) => id ? id.slice(0, 10) + "…" + id.slice(-6) : "—";
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
const asBig = (v) => typeof v === "bigint" ? v : BigInt(v);
const toHexWord = (v) => {
    const n = asBig(v);
    return "0x" + n.toString(16).padStart(64, "0");
};
const addrEq = (a, b) => (a || "").toLowerCase() === (b || "").toLowerCase();
const explorerTx = (h) => CLIENT.network.explorer + "/transaction/" + h;
const explorerAddr = (a) => CLIENT.network.explorer + "/address/" + a;

function fmtRemain(secs) {
    if (secs <= 0n) return "0s";
    const s = Number(secs);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + String(m).padStart(2, "0") + "m";
    return String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
}

function bytesRow(w) {
    const hexed = [...w.bytes].map((x) => x.toString(16).padStart(2, "0"));
    const sig = hexed.slice(32 - w.sig).join("");
    const pad = hexed.slice(0, 32 - w.sig).join("");
    return '<span class="pad">' + pad + '</span><span class="sig">' + sig + "</span>";
}

function extractData(err) {
    const c = err?.info?.error?.data ?? err?.data ?? err?.error?.data ?? err?.receipt?.revertReason;
    if (typeof c === "string" && c.startsWith("0x")) return c;
    if (c && typeof c.data === "string") return c.data;
    const msg = String(err?.shortMessage || err?.message || "");
    const m = msg.match(/0x[0-9a-fA-F]{8,}/);
    return m ? m[0] : null;
}

function is429(err) {
    const s = String(err?.message || err || "");
    return s.includes("429") || s.toLowerCase().includes("rate limit");
}

function decodeRevert(err) {
    const data = extractData(err);
    const fallback = err?.shortMessage || err?.reason || err?.message || String(err);
    if (!data || data === "0x") return {message: fallback, selector: null, name: null};
    const sel = data.slice(0, 10).toLowerCase();
    if (sel === ATS_KYC) {
        return {
            selector: sel,
            name: "InvalidKycStatus",
            message: "ATS refused this address. Prove eligibility first.",
            route: "prove.html",
        };
    }
    const meta = CLIENT.errors[sel];
    let parsed = null;
    for (const abi of Object.values(ABI)) {
        try {
            parsed = new ethers.Interface(abi).parseError(data);
            if (parsed) break;
        } catch { /* try next */ }
    }
    const name = parsed?.name || meta?.signature?.split("(")[0] || sel;
    let message = name;
    if (parsed && parsed.args && parsed.args.length) {
        const parts = [];
        parsed.fragment.inputs.forEach((inp, i) => {
            const v = parsed.args[i];
            parts.push(inp.name + "=" + (typeof v === "bigint" ? v.toString() : String(v)));
        });
        message = name + "(" + parts.join(", ") + ")";
    } else if (meta?.signature) {
        message = meta.signature;
    }
    if (name === "WrongBond" && parsed) {
        const sent = asBig(parsed.args[0]);
        const want = asBig(parsed.args[1]);
        const why = diagnoseWrongBond(sent, want);
        if (why) message += " — " + why;
    }
    if (name === "UnknownCommitment") {
        message += " — the preimage does not match; check the salt on the ticket.";
    }
    if (name === "NotEscrow") {
        const escrow = parsed ? String(parsed.args[0]) : "";
        if (addrEq(escrow, ZERO) || escrow === "0" || escrow === "0x") {
            message += " — that hold id does not exist for this holder.";
        }
    }
    return {selector: sel, name, message, parsed};
}

function storeKey(kind, account) {
    return "seamme." + kind + "." + CLIENT.network.chainId + "." + account.toLowerCase();
}

function readList(kind, account) {
    if (!account) return [];
    try {
        const raw = localStorage.getItem(storeKey(kind, account));
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function writeList(kind, account, items) {
    localStorage.setItem(storeKey(kind, account), JSON.stringify(items));
}

function upsert(kind, account, item, idField) {
    const items = readList(kind, account);
    const i = items.findIndex((x) => x[idField] === item[idField]);
    if (i === -1) items.unshift(item);
    else items[i] = {...items[i], ...item};
    writeList(kind, account, items);
    return items;
}

function downloadJson(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], {type: "application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function ticketFile(t) {
    return {
        v: TICKET_VER,
        warning: "Without this salt the order cannot be revealed and the commit bond is forfeit.",
        network: CLIENT.network.chainId,
        engine: CLIENT.addresses.MatchingEngine,
        committer: t.committer,
        side: t.side,
        sideName: t.side === 1 ? "SELL" : "BUY",
        price: t.price,
        qty: t.qty,
        salt: t.salt,
        id: t.id,
        holdId: t.holdId || null,
        committedAt: t.committedAt || null,
        commitTx: t.commitTx || null,
        savedAt: t.savedAt,
    };
}

const Venue = {
    page: "",
    account: null,
    reader: null,
    signer: null,
    c: {},
    snap: {},
    pollMs: 5000,
    timer: 0,
    localTimer: 0,
    wiringOk: false,
    busy: false,
    watching: null,
    eth: null,
};

Venue.contracts = function (runner) {
    const A = CLIENT.addresses;
    return {
        engine: new ethers.Contract(A.MatchingEngine, ABI.MatchingEngine, runner),
        gate: new ethers.Contract(A.RegistrationGate, ABI.RegistrationGate, runner),
        registry: new ethers.Contract(A.ZkKycRegistry, ABI.ZkKycRegistry, runner),
        token: new ethers.Contract(A.token, ABI.IAtsToken, runner),
        holds: new ethers.Contract(A.token, ABI.IHoldByPartition, runner),
        watch: new ethers.Contract(A.MarginWatch, ABI.MarginWatch, runner),
        policy: new ethers.Contract(A.ParameterRoot, ABI.ParameterRoot, runner),
        halt: new ethers.Contract(A.TradingHalt, ABI.TradingHalt, runner),
        // The rest of the deployed venue. Nothing below is optional to the
        // venue's behaviour, so nothing below is optional to a client that
        // claims to show it: the cap can suspend trading, the regime sets the
        // floor the cap suspends against, the rulebook is what the fees are
        // reconciled to, and the journal is the contract that answers no.
        journal: new ethers.Contract(A.SeamJournal, ABI.SeamJournal, runner),
        vault: new ethers.Contract(A.RepoVault, ABI.RepoVault, runner),
        rulebook: new ethers.Contract(A.Rulebook, ABI.Rulebook, runner),
        regime: new ethers.Contract(A.Regime, ABI.Regime, runner),
        cap: new ethers.Contract(A.VolumeCap, ABI.VolumeCap, runner),
        clock: new ethers.Contract(A.EpochClock, ABI.EpochClock, runner),
    };
};

Venue.boot = async function (page) {
    Venue.page = page;
    document.body.setAttribute("data-screen", page);
    if (typeof CLIENT === "undefined" || typeof ABI === "undefined") {
        Venue.block("The client bundle is missing. Run node tools/gen-app.mjs from venue/.");
        return;
    }
    if (typeof ethers === "undefined") {
        Venue.block("ethers failed to load from the CDN.");
        return;
    }
    const net = new ethers.Network("hedera-testnet", CLIENT.network.chainId);
    Venue.reader = new ethers.JsonRpcProvider(CLIENT.network.rpc, net, {staticNetwork: net});
    Venue.c = Venue.contracts(Venue.reader);

    // Nothing above the chrome needs the chain, so nothing above the chrome
    // waits for it. The theme, the nav and the wallet sheet are painted from
    // the document before a single read is issued; only figures wait for reads,
    // which is the distinction a viewer can see.
    $("block")?.setAttribute("hidden", "");
    $("app")?.removeAttribute("hidden");
    Venue.bindChrome();
    Venue.restoreTheme();
    Venue.listenProviders();
    Venue.buildSheet();

    // The wiring checks and the clocks are independent of each other, so they
    // are issued together and cost one round trip between them rather than two.
    // The injected wallet is a third party on a different transport, so it is
    // asked at the same time and nothing waits on its answer either.
    //
    // Prefer a wallet that announced itself over whoever won the race for
    // window.ethereum. Reconnect without a prompt if this origin is already
    // authorised; eth_accounts asks nothing of the user.
    const injected = Venue.providers[0]?.provider || window.ethereum;
    const walletReady = (async () => {
        if (!injected) return;
        Venue.eth = injected;
        Venue.bindProviderEvents(injected);
        const accs = await injected.request({method: "eth_accounts"}).catch(() => []);
        if (accs?.[0]) await Venue.attachAccount(accs[0]);
    })();

    let wired = null;
    let clocked = false;
    for (let attempt = 0; attempt < 4 && !wired; attempt++) {
        const [w, c] = await Promise.allSettled([
            Venue.assertWiring(),
            clocked ? Promise.resolve() : Venue.refreshClocks(),
        ]);
        if (c.status === "rejected") {
            const e = c.reason;
            Venue.toast(is429(e) ? "HashIO is rate limiting reads. Backing off." : decodeRevert(e).message);
        } else {
            clocked = true;
        }
        if (w.status === "fulfilled") { wired = true; break; }
        const e = w.reason;
        if (attempt === 3) {
            // A screen that can print a venue figure refuses to render one
            // it cannot stand behind. The front door prints no venue figure
            // of its own, so it stays up and says plainly that the chain
            // could not be reached.
            if (page !== "index") {
                Venue.block("The live venue did not match its wiring checks. " + (e.message || e));
                return;
            }
            Venue.wiringErr = e.message || String(e);
        }
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
    Venue.wiringOk = !Venue.wiringErr;
    await walletReady;
    if (!Venue.account) {
        let saved = null;
        try { saved = sessionStorage.getItem("seamme.watch"); } catch (e) { saved = null; }
        if (saved) {
            Venue.watching = saved;
            Venue.renderWallet();
        }
    }
    const mount = {
        index: Venue.mountIndex,
        prove: Venue.mountProve,
        trade: Venue.mountTrade,
        position: Venue.mountPosition,
        venue: Venue.mountVenue,
        repo: Venue.mountRepo,
    }[page];
    if (mount) await mount();
    Venue.startPolling();
};

Venue.block = function (msg) {
    const el = $("block");
    const app = $("app");
    if (app) app.hidden = true;
    if (el) {
        el.hidden = false;
        el.querySelector("p").textContent = msg;
    } else {
        document.body.insertAdjacentHTML("afterbegin",
            '<div class="blocked"><h1>This is not the live venue.</h1><p>' + esc(msg) + "</p></div>");
    }
};

Venue.assertWiring = async function () {
    const {engine, token} = Venue.c;
    const A = CLIENT.addresses;
    const [sec, comp, pol, cap, halt, tcomp, kyc] = await Promise.all([
        engine.security(),
        engine.compliance(),
        engine.policy(),
        engine.volumeCap(),
        engine.tradingHalt(),
        token.compliance(),
        token.isExternalKycList(A.ZkKycRegistry),
    ]);
    const fails = [];
    if (!addrEq(sec, A.token)) fails.push("engine.security() is not the bond");
    if (!addrEq(comp, A.SeamJournal)) fails.push("engine.compliance() is not SeamJournal");
    if (!addrEq(pol, A.ParameterRoot)) fails.push("engine.policy() is not ParameterRoot");
    if (addrEq(cap, ZERO)) fails.push("engine.volumeCap() is zero");
    if (addrEq(halt, ZERO)) fails.push("engine.tradingHalt() is zero");
    if (!addrEq(tcomp, A.SeamJournal)) fails.push("token.compliance() is not SeamJournal");
    if (!kyc) fails.push("token.isExternalKycList(ZkKycRegistry) is false");
    if (fails.length) throw new Error(fails.join("; "));
};

Venue.bindChrome = function () {
    $("connect")?.addEventListener("click", () => Venue.connect().catch((e) => Venue.fail(e)));
    // The theme control was a floating button over the bottom-left corner,
    // which on a phone lands on top of whatever the page put there. Dock it in
    // the masthead instead: one row of chrome, nothing floating over content.
    const themeBtn = $("theme");
    const end = document.querySelector(".mast-end");
    if (themeBtn && end) {
        end.insertBefore(themeBtn, $("connect") || null);
        themeBtn.classList.add("docked");
    }
    themeBtn?.addEventListener("click", Venue.toggleTheme);
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) Venue.tick().catch(() => {});
    });
};

Venue.restoreTheme = function () {
    const t = localStorage.getItem("seamme.theme")
        || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", t);
    Venue.paintThemeBtn();
};

Venue.paintThemeBtn = function () {
    const btn = $("theme");
    if (!btn) return;
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    btn.textContent = dark ? "Light" : "Dark";
    btn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
};

Venue.toggleTheme = function () {
    const cur = document.documentElement.getAttribute("data-theme") || "light";
    const next = cur === "dark" ? "light" : "dark";
    const root = document.documentElement;
    root.style.cssText = "*,*::before,*::after{transition:none !important}";
    root.setAttribute("data-theme", next);
    localStorage.setItem("seamme.theme", next);
    root.offsetHeight;
    root.style.cssText = "";
    Venue.paintThemeBtn();
};

// ---------- wallets ----------
//
// Three ways in, because a judge on a phone has none of the first one:
//
//   1. Any injected EVM wallet the browser announces under EIP-6963. That
//      standard exists precisely so a page does not have to guess at
//      `window.ethereum` when two extensions are fighting over it, and it hands
//      us the wallet's own name and icon, so the list is honest.
//   2. Legacy `window.ethereum` if nothing announces.
//   3. A read-only watch on any address, which needs no wallet at all.
//
// HashPack and Kabila are deliberately absent. They sign through HashConnect,
// not through an EIP-1193 provider, so `ethers` could not send these calls
// through them; offering them would be a button that cannot work. Blade and
// MetaMask Mobile both expose an EVM provider and do appear.

const FOX = '<svg viewBox="0 0 36 34" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M33.4 1 20.2 10.8l2.5-5.8z" fill="#E2761B"/>' +
    '<path d="M2.6 1l13.1 9.9-2.4-5.9zM28.6 24.1l-3.5 5.4 7.5 2.1 2.2-7.3zM1.2 24.3l2.2 7.3 7.5-2.1-3.5-5.4z" fill="#E4761B"/>' +
    '<path d="M10.5 14.9 8.4 18l7.4.3-.2-8zM25.5 14.9l-5.2-7.8-.2 8.1 7.4-.3zM11.1 29.5l4.5-2.2-3.9-3zM20.4 27.3l4.5 2.2-.6-5.2z" fill="#E4761B"/>' +
    '<path d="M24.9 29.5l-4.5-2.2.4 2.9v1.3zM11.1 29.5l4.1 2v-1.3l.4-2.9z" fill="#D7C1B3"/>' +
    '<path d="M15.3 22.7l-3.7-1.1 2.6-1.2zM20.7 22.7l1.1-2.3 2.6 1.2z" fill="#233447"/>' +
    '<path d="M11.1 29.5l.6-5.4-4.1.1zM24.3 24.1l.6 5.4 3.7-5.3zM27.6 18l-7.4.3.7 3.8 1.1-2.3 2.6 1.2zM11.6 21.6l2.6-1.2 1.1 2.3.7-3.8-7.4-.3z" fill="#CD6116"/>' +
    '<path d="M8.4 18l3.1 6-.1-3zM24.6 21l-.1 3 3.1-6zM15.8 18.3l-.7 3.8.9 4.5.2-5.9zM20.2 18.3l-.4 2.4.2 5.9.9-4.5z" fill="#E4751F"/>' +
    '<path d="M20.9 22.7l-.9 4.6.6.5 4.5-3.5.1-3zM11.6 21.6l-.1 3 4.5 3.5.6-.5-.9-4.6z" fill="#F6851B"/>' +
    '<path d="M21 31.5v-1.3l-.4-.3h-5.2l-.3.3v1.3l-4.1-2 1.4 1.2 2.9 2h5.3l2.9-2 1.4-1.2z" fill="#C0AD9E"/>' +
    '<path d="M20.7 27.3l-.6-.5h-4.2l-.6.5-.4 2.9.3-.3h5.2l.4.3z" fill="#161616"/>' +
    "</svg>";

const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/></svg>';

Venue.providers = [];

// Announcements can arrive before anything asks for them, so the listener goes
// up at boot and the request goes out immediately after. Wallets that load late
// announce whenever they are ready and the open sheet repaints itself.
Venue.listenProviders = function () {
    window.addEventListener("eip6963:announceProvider", (e) => {
        const d = e.detail;
        if (!d || !d.info || !d.info.uuid || !d.provider) return;
        if (Venue.providers.some((p) => p.info.uuid === d.info.uuid)) return;
        Venue.providers.push(d);
        if (!$("wallet-modal")?.hidden) Venue.paintWallets();
    });
    window.dispatchEvent(new Event("eip6963:requestProvider"));
};

Venue.buildSheet = function () {
    if ($("wallet-modal")) return;
    const el = document.createElement("div");
    el.id = "wallet-modal";
    el.className = "modal";
    el.hidden = true;
    el.innerHTML =
        '<div class="modal-scrim" data-close></div>' +
        '<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="wm-title">' +
        '<button type="button" class="modal-x" data-close aria-label="Close">&times;</button>' +
        '<h2 id="wm-title">Connect to SeamMe</h2>' +
        '<p class="sub">Hedera testnet, chain 296. The key must be ECDSA secp256k1: an ED25519 Hedera key cannot sign an EVM transaction.</p>' +
        '<div class="wallet-list" id="wm-wallets"></div>' +
        '<div class="wm-or"><span>OR</span></div>' +
        '<form class="watch-form" id="wm-watch">' +
        '<label for="wm-addr">Watch an address, read only</label>' +
        '<input id="wm-addr" placeholder="0x… or 0.0.1234" spellcheck="false" autocomplete="off">' +
        '<button type="submit" class="btn-grad">Watch this address</button>' +
        '<p class="wm-note" id="wm-msg">No extension needed. Every screen fills in, and nothing can be signed.</p>' +
        "</form></div>";
    document.body.appendChild(el);

    el.addEventListener("click", (e) => {
        if (e.target.closest("[data-close]")) Venue.closeSheet();
    });
    $("wm-watch").addEventListener("submit", (e) => {
        e.preventDefault();
        Venue.startWatching($("wm-addr").value.trim()).catch((err) => {
            Venue.sheetMsg(err.message || String(err), true);
        });
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !$("wallet-modal").hidden) Venue.closeSheet();
    });
};

Venue.sheetMsg = function (msg, bad) {
    const el = $("wm-msg");
    if (!el) return;
    el.textContent = msg;
    el.className = "wm-note" + (bad ? " bad" : "");
};

Venue.row = function (icon, name, sub, cls) {
    return '<button type="button" class="wallet-row ' + (cls || "") + '">' +
        '<span class="ic">' + icon + "</span>" +
        '<span class="tx"><span class="nm">' + esc(name) + '</span><span class="sb">' + esc(sub) + "</span></span>" +
        '<span class="chev">&rsaquo;</span></button>';
};

Venue.paintWallets = function () {
    const list = $("wm-wallets");
    if (!list) return;
    const acts = [];
    let html = "";

    if (Venue.account) {
        html += Venue.row(
            '<svg viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>',
            shortAddr(Venue.account), "Connected. Tap to view on HashScan.", "installed");
        acts.push(() => window.open(explorerAddr(Venue.account), "_blank", "noopener"));
    }

    for (const p of Venue.providers) {
        const icon = p.info.icon && /^data:image\//.test(p.info.icon)
            ? '<img src="' + esc(p.info.icon) + '" alt="">'
            : FOX;
        html += Venue.row(icon, p.info.name, "Detected in this browser", "installed");
        acts.push(() => Venue.connectWith(p.provider));
    }

    // Nothing announced itself, but something is sitting on window.ethereum.
    if (!Venue.providers.length && window.ethereum) {
        const mm = !!window.ethereum.isMetaMask;
        html += Venue.row(mm ? FOX : EYE, mm ? "MetaMask" : "Browser wallet",
            "Detected in this browser", "installed");
        acts.push(() => Venue.connectWith(window.ethereum));
    }

    // No injected provider at all. On a phone that is the normal case, so send
    // them to the one place the page will work: MetaMask's own browser.
    if (!Venue.providers.length && !window.ethereum) {
        const deep = "https://metamask.app.link/dapp/" + location.host + location.pathname;
        html += Venue.row(FOX, "Open in MetaMask", "No extension here. Continue in the MetaMask app.");
        acts.push(() => { location.href = deep; });
    }

    if (Venue.watching) {
        html += Venue.row(EYE, "Stop watching " + shortAddr(Venue.watching), "Return to a disconnected page");
        acts.push(() => { Venue.stopWatching(); Venue.closeSheet(); });
    }

    list.innerHTML = html;
    [...list.querySelectorAll(".wallet-row")].forEach((b, i) => {
        b.addEventListener("click", () => {
            const run = acts[i];
            if (run) Promise.resolve(run()).catch((e) => Venue.sheetMsg(Venue.fail(e).message, true));
        });
    });
};

Venue.openSheet = function () {
    Venue.buildSheet();
    // Ask again on open: a wallet installed since page load will answer.
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    Venue.paintWallets();
    Venue.sheetMsg("No extension needed. Every screen fills in, and nothing can be signed.", false);
    const el = $("wallet-modal");
    el.hidden = false;
    setTimeout(() => $("wm-addr")?.focus({preventScroll: true}), 40);
};

Venue.closeSheet = function () {
    const el = $("wallet-modal");
    if (el) el.hidden = true;
    $("connect")?.focus({preventScroll: true});
};

// ---------- read-only watching ----------
//
// A watcher gets every read on every screen and not one write. That is enforced
// by keeping `Venue.account` null: every action button on the three screens is
// already gated on it, and `Venue.w` (the signer's contracts) is never built.

Venue.viewer = function () {
    return Venue.account || Venue.watching || null;
};

Venue.resolveAddress = async function (input) {
    if (!input) throw new Error("Type an address first.");
    if (/^0x[0-9a-fA-F]{40}$/.test(input)) return ethers.getAddress(input);
    if (/^\d+\.\d+\.\d+$/.test(input)) {
        const url = CLIENT.network.mirror + "/api/v1/accounts/" + input;
        const res = await fetch(url).catch(() => null);
        if (!res || !res.ok) throw new Error("The mirror node does not know " + input + ".");
        const body = await res.json();
        if (!body.evm_address) throw new Error(input + " has no EVM address. It is probably an ED25519 account.");
        return ethers.getAddress(body.evm_address);
    }
    throw new Error("Not an address. Use 0x… or a Hedera id like 0.0.1234.");
};

Venue.startWatching = async function (input) {
    Venue.sheetMsg("Resolving…", false);
    const addr = await Venue.resolveAddress(input);
    Venue.account = null;
    Venue.signer = null;
    Venue.w = null;
    Venue.watching = addr;
    try {
        sessionStorage.setItem("seamme.watch", addr);
    } catch (e) { /* private mode; the session simply will not survive a reload */ }
    Venue.renderWallet();
    Venue.closeSheet();
    Venue.toast("Watching " + shortAddr(addr) + ". Read only.");
    await Venue.refreshForViewer();
};

Venue.stopWatching = function () {
    Venue.watching = null;
    try {
        sessionStorage.removeItem("seamme.watch");
    } catch (e) { /* nothing to clean up */ }
    Venue.renderWallet();
};

Venue.refreshForViewer = async function () {
    if (Venue.page === "prove") await Venue.refreshProve();
    if (Venue.page === "trade") await Venue.refreshTrade();
    if (Venue.page === "position") await Venue.refreshPosition();
};

Venue.paintWatchBar = function () {
    let bar = $("watch-bar");
    if (!Venue.watching) {
        bar?.remove();
        return;
    }
    if (!bar) {
        bar = document.createElement("div");
        bar.id = "watch-bar";
        bar.className = "watch-bar";
        // Inside the masthead, not after it: the masthead is sticky, so the
        // ribbon stays on screen. A watcher must not be able to scroll away
        // from the fact that nothing here can be signed.
        document.querySelector(".mast")?.appendChild(bar);
    }
    bar.innerHTML = EYE.replace("24 24", "24 24") +
        " Read only. Watching <span class=\"mono\">" + esc(Venue.watching) + "</span>. " +
        "Nothing on this page can be signed. " +
        '<button type="button" id="watch-off">Stop watching</button>';
    bar.querySelector("svg").setAttribute("width", "15");
    bar.querySelector("svg").setAttribute("height", "15");
    $("watch-off").addEventListener("click", () => {
        Venue.stopWatching();
        location.reload();
    });
};

Venue.connect = async function () {
    Venue.openSheet();
};

Venue.connectWith = async function (provider) {
    if (!provider) {
        Venue.sheetMsg("That wallet is no longer available.", true);
        return;
    }
    Venue.eth = provider;
    const hexChain = CLIENT.network.chainIdHex;
    Venue.sheetMsg("Check your wallet…", false);
    try {
        await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{chainId: hexChain}],
        });
    } catch (e) {
        if (e.code === 4902 || String(e.message || "").includes("4902")) {
            await provider.request({
                method: "wallet_addEthereumChain",
                params: [{
                    chainId: hexChain,
                    chainName: "Hedera Testnet",
                    nativeCurrency: {name: "HBAR", symbol: "HBAR", decimals: 18},
                    rpcUrls: [CLIENT.network.rpc],
                    blockExplorerUrls: [CLIENT.network.explorer],
                }],
            });
        } else if (e.code === 4001) {
            Venue.sheetMsg("You declined the network switch. SeamMe only runs on chain 296.", true);
            return;
        } else {
            throw e;
        }
    }
    const accs = await provider.request({method: "eth_requestAccounts"});
    if (!accs || !accs[0]) {
        Venue.sheetMsg("The wallet returned no account.", true);
        return;
    }
    Venue.bindProviderEvents(provider);
    Venue.stopWatching();
    await Venue.attachAccount(accs[0]);
    Venue.closeSheet();
};

Venue.bindProviderEvents = function (provider) {
    if (!provider || provider.__seamme) return;
    provider.__seamme = true;
    provider.on?.("accountsChanged", (accs) => Venue.onAccounts(accs));
    provider.on?.("chainChanged", () => location.reload());
};


Venue.onAccounts = async function (accs) {
    if (!accs?.[0]) {
        Venue.account = null;
        Venue.signer = null;
        Venue.w = null;
        Venue.renderWallet();
        return;
    }
    await Venue.attachAccount(accs[0]);
};

Venue.attachAccount = async function (account) {
    const eth = Venue.eth || window.ethereum;
    if (!eth) return;
    const provider = new ethers.BrowserProvider(eth, CLIENT.network.chainId);
    const net = await provider.getNetwork();
    if (net.chainId !== BigInt(CLIENT.network.chainId)) {
        Venue.toast("Wallet is not on Hedera testnet (296).");
        return;
    }
    Venue.account = ethers.getAddress(account);
    Venue.signer = await provider.getSigner();
    Venue.w = Venue.contracts(Venue.signer);
    Venue.watching = null;
    Venue.renderWallet();
    await Venue.refreshForViewer();
};

Venue.renderWallet = function () {
    const btn = $("connect");
    Venue.paintWatchBar();
    if (!btn) return;
    btn.classList.remove("connected", "watching");
    if (Venue.account) {
        btn.innerHTML = '<span class="dot"></span>' + esc(shortAddr(Venue.account));
        btn.classList.add("connected");
        btn.setAttribute("aria-label", "Connected as " + Venue.account + ". Open wallet options.");
    } else if (Venue.watching) {
        btn.innerHTML = '<span class="dot"></span>' + esc(shortAddr(Venue.watching));
        btn.classList.add("watching");
        btn.setAttribute("aria-label", "Watching " + Venue.watching + " read only. Open wallet options.");
    } else {
        btn.textContent = "Connect Wallet";
        btn.setAttribute("aria-label", "Connect a wallet");
    }
};

Venue.startPolling = function () {
    clearInterval(Venue.timer);
    clearInterval(Venue.localTimer);
    Venue.timer = setInterval(() => Venue.tick().catch(() => {}), Venue.pollMs);
    Venue.localTimer = setInterval(Venue.paintClocks, 1000);
};

Venue.tick = async function () {
    if (document.hidden) return;
    try {
        // One wave a tick. The clocks are read alongside the screen rather than
        // before it: a refresh that wanted this tick's round would have had to
        // wait for it, and every one of them is content with the last, which is
        // at most five seconds old and is re-read in the same request.
        //
        // The venue screen answers for the whole venue, so it has no viewer to
        // wait for. The book is the same: what is resting in this round is not
        // a fact about whoever happens to be connected.
        const work = [Venue.refreshClocks()];
        const viewer = Venue.viewer();
        if (Venue.page === "prove") {
            if (viewer) work.push(Venue.refreshProve({quiet: true}));
            work.push(Venue.refreshGateGov());
        }
        if (Venue.page === "trade") {
            if (viewer) work.push(Venue.refreshTrade({quiet: true}));
            work.push(Venue.refreshBook());
        }
        if (Venue.page === "position") {
            if (viewer) work.push(Venue.refreshPosition({quiet: true}));
            work.push(Venue.refreshInstrument());
        }
        await Promise.all(work);
        // The venue screen is about sixty reads and nothing on it moves faster
        // than an epoch. Redraw it once a minute, and immediately whenever the
        // disclosure epoch it is scoped to actually turns over.
        if (Venue.page === "venue") {
            const now = Date.now();
            const epoch = String(Venue.snap.discEpoch);
            if (epoch !== Venue._venueEpoch || now - (Venue._venueAt || 0) > 60000) {
                Venue._venueEpoch = epoch;
                Venue._venueAt = now;
                await Venue.refreshVenue();
            }
        }
        Venue.pollMs = 5000;
        clearInterval(Venue.timer);
        Venue.timer = setInterval(() => Venue.tick().catch(() => {}), Venue.pollMs);
    } catch (e) {
        if (is429(e)) {
            Venue.pollMs = Math.min(Venue.pollMs * 2, 60000);
            clearInterval(Venue.timer);
            Venue.timer = setInterval(() => Venue.tick().catch(() => {}), Venue.pollMs);
        }
    }
};

// Every read on this page costs one network round trip, and the round trip, not
// the call, is what a viewer waits for: seven getters issued together answer in
// the time one of them takes, and the same seven issued in three waves take
// three times as long. ethers batches whatever is dispatched in a single tick
// into one JSON-RPC request, so the only thing that costs time here is a value
// that has to arrive before the next call can be written.
//
// Two of the seven were exactly that. `roundEnd(r)` needs `r`, and
// `rootForEpoch(e + 1)` needs `e`. Neither is read from the chain any less for
// being predicted: both getters are still called, in the same wave, against a
// round and an epoch this client works out from the same immutables the
// contracts use. The prediction is then checked against what the chain said,
// and a miss falls back to the read it would have done anyway. A miss can only
// happen within a second of a boundary, or on a machine whose clock is wrong.
Venue.predictRound = function () {
    const genesis = asBig(CLIENT.immutables.genesis);
    const len = asBig(CLIENT.immutables.roundLength);
    const t = nowSec();
    return t <= genesis ? 0n : (t - genesis) / len;
};

Venue.predictKycEpoch = function () {
    const zero = asBig(CLIENT.clocks.kyc.origin);
    const period = asBig(CLIENT.clocks.kyc.period);
    const t = nowSec();
    return t <= zero ? 0n : (t - zero) / period;
};

Venue.refreshClocks = async function () {
    const {engine, registry, policy, halt, gate} = Venue.c;
    const guessRound = Venue.predictRound();
    const guessKyc = Venue.predictKycEpoch();
    let [round, kycEpoch, discEpoch, halted, haltUntil, roundEnd, nextRoot] = await Promise.all([
        engine.currentRound(),
        registry.currentEpoch(),
        policy.currentEpoch(),
        halt.haltedNow(),
        halt.haltedUntil(),
        engine.roundEnd(guessRound),
        gate.rootForEpoch(guessKyc + 1n).catch(() => 0n),
    ]);
    // The boundary case, and the wrong-clock case. Both re-read rather than
    // print a figure that belongs to a round or an epoch that has moved on.
    const missed = [];
    if (asBig(round) !== guessRound) missed.push(engine.roundEnd(round));
    if (asBig(kycEpoch) !== guessKyc) missed.push(gate.rootForEpoch(asBig(kycEpoch) + 1n).catch(() => 0n));
    if (missed.length) {
        const again = await Promise.all(missed);
        if (asBig(round) !== guessRound) roundEnd = again.shift();
        if (asBig(kycEpoch) !== guessKyc) nextRoot = again.shift();
    }
    const kycZero = asBig(CLIENT.clocks.kyc.origin);
    const kycPeriod = asBig(CLIENT.clocks.kyc.period);
    const discZero = asBig(CLIENT.clocks.disclosure.origin);
    const discPeriod = asBig(CLIENT.clocks.disclosure.period);
    Venue.snap.round = asBig(round);
    Venue.snap.roundEnd = asBig(roundEnd);
    Venue.snap.kycEpoch = asBig(kycEpoch);
    Venue.snap.kycEnd = kycZero + (asBig(kycEpoch) + 1n) * kycPeriod;
    Venue.snap.discEpoch = asBig(discEpoch);
    Venue.snap.discEnd = discZero + (asBig(discEpoch) + 1n) * discPeriod;
    Venue.snap.halted = !!halted;
    Venue.snap.haltUntil = asBig(haltUntil);
    Venue.snap.nextRoot = asBig(nextRoot);
    Venue.paintClocks();
};

Venue.paintClocks = function () {
    const s = Venue.snap;
    if (s.round === undefined) return;
    const t = nowSec();
    const roundLeft = s.roundEnd > t ? s.roundEnd - t : 0n;
    const kycLeft = s.kycEnd > t ? s.kycEnd - t : 0n;
    const discLeft = s.discEnd > t ? s.discEnd - t : 0n;
    const set = (id, label, value, warn) => {
        const el = $(id);
        if (!el) return;
        el.querySelector(".k").textContent = label;
        el.querySelector(".v").textContent = value;
        el.classList.toggle("warn", !!warn);
    };
    const fr = $("fact-round");
    if (fr) fr.textContent = s.round.toString();
    set("clk-round", "Round " + s.round, fmtRemain(roundLeft), false);
    set("clk-disc", "Disclosure " + s.discEpoch, fmtRemain(discLeft), false);
    set("clk-kyc", "KYC " + s.kycEpoch, fmtRemain(kycLeft), kycLeft < 86400n);
    const haltEl = $("clk-round");
    if (haltEl) haltEl.classList.toggle("halt", !!s.halted);
};

Venue.status = function (id, msg, kind) {
    const el = $(id);
    if (!el) return;
    el.textContent = msg || "";
    el.className = "status" + (kind ? " " + kind : "");
};

Venue.toast = function (msg) {
    const el = $("toast");
    if (!el) return;
    el.hidden = false;
    el.textContent = msg;
    clearTimeout(Venue._toast);
    Venue._toast = setTimeout(() => { el.hidden = true; }, 5200);
};

Venue.fail = function (err) {
    const d = decodeRevert(err);
    Venue.toast(d.message);
    if (d.route && Venue.page !== "prove") {
        const el = $("toast");
        if (el) el.innerHTML = esc(d.message) + ' <a href="' + d.route + '">Prove</a>';
    }
    return d;
};

Venue.send = async function (txPromise, label) {
    if (Venue.busy) return null;
    Venue.busy = true;
    try {
        const tx = await txPromise;
        Venue.toast(label + " sent " + shortId(tx.hash));
        const rec = await tx.wait();
        if (rec.status !== 1) throw new Error(label + " reverted");
        Venue.lastReceipt = rec;
        Venue.toast(label + " confirmed");
        return rec;
    } catch (e) {
        Venue.fail(e);
        return null;
    } finally {
        Venue.busy = false;
    }
};

Venue.requireAccount = async function () {
    if (Venue.account) return;
    Venue.openSheet();
    throw new Error(Venue.watching
        ? "Watching is read only. Connect a wallet to sign this."
        : "Connect a wallet first.");
};

Venue.mountIndex = async function () {
    const rpc = $("net-rpc");
    if (rpc) rpc.textContent = CLIENT.network.rpc.replace("https://", "").replace(/\/api$/, "");
    const scan = $("foot-scan");
    if (scan) scan.href = explorerAddr(CLIENT.addresses.MatchingEngine);

    // Say so, once, if the wiring checks did not pass. The page keeps working:
    // nothing above the fold is a number this venue had to answer for.
    if (Venue.wiringErr) {
        const clocks = document.querySelector(".clocks");
        if (clocks) {
            clocks.innerHTML = '<div class="clk warn"><span class="k">Venue</span>' +
                '<span class="v">unreachable</span></div>';
        }
        const live = document.querySelector(".fact .live");
        if (live) live.style.background = "var(--exposed)";
        const round = $("fact-round");
        if (round) round.textContent = "offline";
        Venue.toast("Could not verify the venue over RPC. Reads are down; the tour still works.");
    }
};

Venue.mountProve = async function () {
    $("proof-file")?.addEventListener("change", (e) => Venue.onProofFile(e.target.files[0]));
    $("demo-proof")?.addEventListener("click", () => Venue.loadDemoProof().catch((e) => Venue.fail(e)));
    const drop = $("drop");
    drop?.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop?.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop?.addEventListener("drop", (e) => {
        e.preventDefault();
        drop.classList.remove("over");
        Venue.onProofFile(e.dataTransfer.files[0]);
    });
    $("kyc-act")?.addEventListener("click", () => Venue.openSheet());
    $("check")?.addEventListener("click", () => Venue.previewRegister().catch((e) => Venue.fail(e)));
    $("register")?.addEventListener("click", () => Venue.doRegister().catch((e) => Venue.fail(e)));
    await Promise.all([
        Venue.refreshProve(),
        Venue.refreshGateGov().catch(() => {}),
    ]);
};

Venue.refreshProve = async function () {
    const {gate, registry} = Venue.c;
    const epoch = Venue.snap.kycEpoch ?? asBig(await registry.currentEpoch());
    const who = Venue.viewer();
    const [minTier, mask, maxUses, root, nextRoot, granted] = await Promise.all([
        gate.minTier(),
        gate.jurisdictionMask(),
        registry.MAX_USES_PER_EPOCH(),
        gate.rootForEpoch(epoch),
        gate.rootForEpoch(epoch + 1n),
        who ? registry.getKycStatus(who) : null,
    ]);
    Venue.snap.minTier = asBig(minTier);
    Venue.snap.mask = asBig(mask);
    Venue.snap.maxUses = Number(maxUses);
    Venue.snap.root = asBig(root);
    Venue.snap.nextRoot = asBig(nextRoot);
    $("pol-tier").textContent = minTier.toString();
    $("pol-mask").textContent = "0x" + asBig(mask).toString(16);
    $("pol-root").textContent = root === 0n ? "not published" : toHexWord(root);
    $("pol-next").textContent = nextRoot === 0n
        ? "next epoch root is unpublished — grants die at the boundary"
        : toHexWord(nextRoot);
    $("pol-next").classList.toggle("bad", nextRoot === 0n);
    let status = "Connect or watch an address to read grant state.";
    if (who) {
        const kyc = Number(granted);
        Venue.snap.kyc = kyc;
        status = kyc === 1
            ? "Granted for epoch " + epoch + ". The grant is nothing the instant the epoch ends."
            : "Not granted in epoch " + epoch + ".";
        $("kyc-banner")?.classList.toggle("warn", kyc !== 1);
    } else {
        $("kyc-banner")?.classList.remove("warn");
    }
    const act = $("kyc-act");
    if (act) act.hidden = !!who;
    $("kyc-copy").textContent = status;
    if (Venue.proof) Venue.paintPins();
};

Venue.onProofFile = async function (file) {
    if (!file) return;
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); }
    catch { Venue.status("prove-status", "That file is not JSON.", "bad"); return; }
    const picked = Venue.pickProof(data);
    if (!picked) {
        Venue.status("prove-status", "Need {proof[24], pub[7]} or a proofs-live.json map keyed by address.", "bad");
        return;
    }
    Venue.proof = picked;
    Venue.status("prove-status", "Loaded " + file.name + ".", "ok");
    Venue.paintPins();
};

/// The issuer's own proofs, for whoever arrives without one.
///
/// Step one of a three-step product cannot be completed by anybody who is not
/// us: proving needs circom, node 22 and about twenty-three seconds per address,
/// so a visitor with no proof file is stopped at the first screen and the second
/// and third are behind it. These are real proofs for real addresses and they
/// verify against the root already on chain; nothing here is a mock, and the
/// button says so.
///
/// It picks by the registry's current KYC epoch rather than by whichever set was
/// generated last, because `RegistrationGate.register` pins public signal 3 to
/// that epoch and a proof for the wrong one is refused. If the viewer is one of
/// the issuer's three addresses they get their own; otherwise the page starts
/// watching the first of them read-only, because a proof that does not name the
/// viewer would fail `RegistrantMismatch` and the failure would look like a
/// broken button rather than the rule it is.
Venue.loadDemoProof = async function () {
    const epoch = Venue.snap.kycEpoch !== undefined && Venue.snap.kycEpoch !== null
        ? String(Venue.snap.kycEpoch)
        : String(await Venue.c.registry.currentEpoch());
    const set = (typeof DEMO_PROOFS !== "undefined" && DEMO_PROOFS) ? DEMO_PROOFS[epoch] : null;
    if (!set) {
        Venue.status("prove-status",
            "This build carries no issuer proof for KYC epoch " + epoch +
            ". Run `make prove-live-epoch EPOCH=" + epoch + "` and rebuild.", "bad");
        return;
    }
    const keys = Object.keys(set);
    const mine = Venue.viewer() ? set[Venue.viewer().toLowerCase()] : null;
    let picked = Venue.pickProof(mine || set);
    if (!picked && keys.length) {
        await Venue.startWatching(keys[0]);
        picked = Venue.pickProof(set[keys[0]]);
    }
    if (!picked) {
        Venue.status("prove-status", "The issuer proof in this build is not the shape the gate wants.", "bad");
        return;
    }
    Venue.proof = picked;
    Venue.status("prove-status",
        "Loaded the issuer's proof for " + shortAddr(picked.address || Venue.viewer()) +
        ", KYC epoch " + epoch + ". Real, and it verifies on chain. Ask wouldAccept.", "ok");
    Venue.paintPins();
};

Venue.pickProof = function (data) {
    const norm = (p) => {
        if (!p?.proof || !p?.pub) return null;
        if (p.proof.length !== 24 || p.pub.length !== 7) return null;
        return {proof: p.proof.map(String), pub: p.pub.map(String), address: p.address};
    };
    const direct = norm(data);
    if (direct) return direct;
    if (data && typeof data === "object") {
        const key = Venue.viewer() ? Venue.viewer().toLowerCase() : null;
        if (key && data[key]) return norm(data[key]);
        const keys = Object.keys(data);
        if (keys.length === 1) return norm(data[keys[0]]);
    }
    return null;
};

Venue.paintPins = function () {
    const p = Venue.proof;
    if (!p) return;
    const epoch = Venue.snap.kycEpoch;
    const want = [
        null,
        1n,
        Venue.snap.root,
        epoch,
        Venue.viewer() ? BigInt(Venue.viewer()) : null,
        Venue.snap.minTier,
        Venue.snap.mask,
    ];
    const body = SIGS.map((s) => {
        const got = asBig(p.pub[s.i]);
        const w = want[s.i];
        const match = w === null ? "—" : (got === asBig(w) ? "ok" : "no");
        const wantTxt = w === null ? "output" : (s.i === 4 && !Venue.viewer() ? "connect" : toHexWord(w).replace(/^0x0+/, "0x") );
        return '<div class="pin"><span>' + s.i + "</span><span>" + s.name +
            "</span><span class='v'>" + toHexWord(got) + "</span><span class='v'>" +
            esc(String(wantTxt)) + '</span><span class="' + match + '">' + match +
            "</span></div>";
    }).join("");
    $("pins").className = "pins";
    $("pins").innerHTML =
        '<div class="pin head"><span>#</span><span>Signal</span><span>Proof</span><span>Gate</span><span></span></div>' +
        body;
    const nf = p.pub[0];
    if (Venue.viewer() && nf) {
        Venue.c.registry.usesThisEpoch(toHexWord(nf)).then((u) => {
            $("uses").textContent = u.toString() + " / " + Venue.snap.maxUses + " uses this epoch";
        }).catch(() => {});
    }
};

Venue.previewRegister = async function () {
    const who = Venue.viewer();
    if (!who) { Venue.openSheet(); throw new Error("Connect or watch an address first."); }
    if (!Venue.proof) throw new Error("Load a proof file first.");
    const pub = Venue.proof.pub.map((x) => asBig(x));
    const [ok, reason] = await Venue.c.gate.wouldAccept(who, pub);
    $("register").disabled = !ok || !Venue.account;
    Venue.status("prove-status", ok ? "wouldAccept: true. The gate will spend verification gas." : "wouldAccept: " + reason, ok ? "ok" : "bad");
    Venue.paintPins();
};

Venue.doRegister = async function () {
    await Venue.requireAccount();
    if (!Venue.proof) throw new Error("Load a proof file first.");
    const pub = Venue.proof.pub.map((x) => asBig(x));
    const [ok, reason] = await Venue.w.gate.wouldAccept(Venue.account, pub);
    if (!ok) {
        Venue.status("prove-status", "wouldAccept: " + reason, "bad");
        $("register").disabled = true;
        return;
    }
    const rec = await Venue.send(
        Venue.w.gate.register(Venue.account, Venue.proof.proof.map((x) => asBig(x)), pub, {gasLimit: 1_500_000}),
        "register"
    );
    if (rec) {
        Venue.status("prove-status", "Registered. Grant is live only until this KYC epoch ends.", "ok");
        await Venue.refreshProve();
    }
};

Venue.mountTrade = async function () {
    $("side")?.addEventListener("change", Venue.paintTicket);
    for (const id of ["price", "qty", "salt"]) {
        $(id)?.addEventListener("input", Venue.paintTicket);
    }
    $("reroll")?.addEventListener("click", Venue.reroll);
    $("save-ticket")?.addEventListener("click", () => Venue.saveTicketNow().catch((e) => Venue.fail(e)));
    $("commit")?.addEventListener("click", () => Venue.doCommit().catch((e) => Venue.fail(e)));
    $("hold")?.addEventListener("click", () => Venue.doHold().catch((e) => Venue.fail(e)));
    $("load-ticket")?.addEventListener("change", (e) => Venue.importTicket(e.target.files[0]));
    $("cross")?.addEventListener("click", () => Venue.doCross().catch((e) => Venue.fail(e)));
    $("withdraw")?.addEventListener("click", () => Venue.doWithdraw().catch((e) => Venue.fail(e)));
    $("market-reload")?.addEventListener("click", () => Venue.refreshMarketTape().catch((e) => Venue.fail(e)));
    if (!$("salt").value) Venue.reroll();
    else Venue.paintTicket();
    await Venue.refreshTrade();
    // The book does not need a connected wallet. Someone deciding whether to
    // commit is exactly the person who has not connected one yet.
    await Venue.refreshBook().catch(() => {});
};

Venue.reroll = function () {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    $("salt").value = "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    Venue.paintTicket();
};

Venue.readOrder = function () {
    const side = Number($("side").value);
    const priceRaw = ($("price").value || "").trim();
    const qtyRaw = ($("qty").value || "").trim();
    const salt = ($("salt").value || "").trim();
    const bad = {};
    let price = 0n, qty = 0n;
    try {
        if (!/^\d+$/.test(priceRaw)) throw new Error("tinybars");
        price = BigInt(priceRaw);
        if (price === 0n) throw new Error("zero");
    } catch { bad.price = true; }
    try { qty = toUnits(BigInt(qtyRaw)); if (qty === 0n) throw new Error("zero"); }
    catch { bad.qty = true; }
    if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) bad.salt = true;
    const committer = Venue.viewer() || ZERO;
    const ok = !bad.price && !bad.qty && !bad.salt && !!Venue.account;
    const id = ok ? commitmentOf(committer, side, price, qty, salt) : null;
    return {side, price, qty, salt, committer, bad, ok, id};
};

Venue.paintTicket = function () {
    const o = Venue.readOrder();
    $("priceHint").textContent = o.bad.price
        ? "integer tinybars per unit, no decimals"
        : formatHbar(o.price) + " HBAR per unit";
    $("priceHint").classList.toggle("bad", !!o.bad.price);
    $("qtyHint").textContent = o.bad.qty ? "a count; this bond has no decimals" : formatQuantity(o.qty) + " units";
    $("qtyHint").classList.toggle("bad", !!o.bad.qty);
    $("saltHint").textContent = o.bad.salt ? "32 bytes, 0x-prefixed" : "kept off-chain; losing it forfeits the bond";
    $("saltHint").classList.toggle("bad", !!o.bad.salt);
    $("sideHint").textContent = o.side === 1 ? "SELL, enum 1. Needs a hold before reveal." : "BUY, enum 0. Reveal sends price × qty.";
    if (o.ok) {
        const words = preimageWords(o.committer, o.side, o.price, o.qty, o.salt);
        $("words").className = "words";
        $("words").innerHTML = words.map((w, i) =>
            '<div class="w" data-from="' + w.from + '"><span class="wi">' + i + "</span>" +
            '<span class="wn">' + w.name + " <i>" + w.type + "</i></span>" +
            '<span class="wb">' + bytesRow(w) + "</span></div>"
        ).join("");
        $("idOut").textContent = o.id;
        const escrow = o.side === 0 ? buyEscrow(o.price, o.qty) : 0n;
        $("escrowHint").textContent = o.side === 0
            ? "Buy reveal value " + formatHbar(escrow) + " HBAR (" + escrow.toString() + " tinybar)."
            : "Sell reveal value 0. Backing is the hold id.";
    }
    if (!o.ok) {
        // Back to waiting, rather than leaving the last good words standing
        // beside a ticket that no longer produces them.
        $("words").className = "words-slot";
        $("words").innerHTML =
            '<div class="empty">Fill in side, price and quantity. The six words that go into' +
            " the hash, and the id they produce, appear here as you type.</div>";
        $("idOut").textContent = Venue.viewer() ? "waiting on a complete ticket" : "connect to bind the committer";
    }
    $("commit").disabled = !o.ok || Venue.busy;
    $("save-ticket").disabled = !o.ok;
    $("hold").disabled = !Venue.account || o.bad.qty || o.side !== 1 || Venue.busy;
};

Venue.draftTicket = function (o) {
    return {
        v: TICKET_VER,
        committer: o.committer,
        side: o.side,
        price: o.price.toString(),
        qty: o.qty.toString(),
        salt: o.salt,
        id: o.id,
        holdId: $("holdId")?.value || null,
        savedAt: new Date().toISOString(),
    };
};

Venue.saveTicketNow = async function () {
    await Venue.requireAccount();
    const o = Venue.readOrder();
    if (!o.ok) throw new Error("Fix the order fields first.");
    const t = Venue.draftTicket(o);
    upsert("tickets", Venue.account, t, "id");
    downloadJson("seamme-ticket-" + t.id.slice(2, 10) + ".json", ticketFile(t));
    Venue.status("trade-status", "Ticket written. Keep the file. The salt is not on chain.", "ok");
    Venue.paintTickets();
};

Venue.importTicket = async function (file) {
    if (!file) return;
    const t = JSON.parse(await file.text());
    $("side").value = String(t.side);
    $("price").value = String(t.price);
    $("qty").value = String(t.qty);
    $("salt").value = t.salt;
    if (t.holdId && $("holdId")) $("holdId").value = String(t.holdId);
    if (Venue.account) upsert("tickets", Venue.account, {
        ...t, price: String(t.price), qty: String(t.qty),
    }, "id");
    Venue.paintTicket();
    Venue.paintTickets();
};

Venue.doHold = async function () {
    await Venue.requireAccount();
    const o = Venue.readOrder();
    if (o.side !== 1) throw new Error("Holds are for sells.");
    if (o.bad.qty) throw new Error("Quantity is not a unit count.");
    const rest = asBig(CLIENT.immutables.restRounds);
    const r = Venue.snap.round;
    const needed = await Venue.c.engine.roundEnd(r + rest + 2n);
    const hold = {
        amount: o.qty,
        expirationTimestamp: needed,
        escrow: CLIENT.addresses.MatchingEngine,
        to: ZERO,
        data: "0x",
    };
    if (!addrEq(hold.escrow, CLIENT.addresses.MatchingEngine)) throw new Error("escrow must be the engine");
    if (!addrEq(hold.to, ZERO)) throw new Error("to must be zero");
    const [, predicted] = await Venue.w.holds.createHoldByPartition.staticCall(
        CLIENT.immutables.partition, hold
    );
    const rec = await Venue.send(
        Venue.w.holds.createHoldByPartition(CLIENT.immutables.partition, hold, {gasLimit: 1_000_000}),
        "hold"
    );
    if (!rec) return;
    const holdId = asBig(predicted).toString();
    $("holdId").value = holdId;
    upsert("holds", Venue.account, {
        v: HOLD_VER, holdId, amount: o.qty.toString(), expiry: needed.toString(),
        tx: rec.hash, at: new Date().toISOString(),
    }, "holdId");
    Venue.status("trade-status", "Hold id " + holdId + ". Write it on the ticket before you commit.", "ok");
    await Venue.refreshTrade();
};

Venue.doCommit = async function () {
    await Venue.requireAccount();
    const o = Venue.readOrder();
    if (!o.ok) throw new Error("Fix the order fields first.");
    const t = Venue.draftTicket(o);
    upsert("tickets", Venue.account, t, "id");
    downloadJson("seamme-ticket-" + t.id.slice(2, 10) + ".json", ticketFile(t));
    const bond = asBig(await Venue.c.engine.commitBond());
    const value = toWeibar(bond);
    const rec = await Venue.send(
        Venue.w.engine.commit(o.id, {value, gasLimit: 400_000}),
        "commit"
    );
    if (!rec) return;
    const cmt = await Venue.c.engine.commitments(o.id);
    upsert("tickets", Venue.account, {
        ...t,
        committedAt: cmt.committedAt.toString(),
        commitTx: rec.hash,
        holdId: t.holdId || $("holdId")?.value || null,
    }, "id");
    Venue.status("trade-status", "Sealed. Cancel is open for " + CLIENT.immutables.revealDelay + "s.", "ok");
    await Venue.refreshTrade();
};

Venue.ticketPhase = function (t, chain) {
    const D = asBig(CLIENT.immutables.revealDelay);
    const W = asBig(CLIENT.immutables.revealWindow);
    if (chain?.cancelled) return {phase: "done", label: "cancelled", until: 0n};
    if (chain?.revealed && chain.committer !== ZERO) {
        return {phase: "done", label: chain.cancelled ? "cancelled" : "revealed", until: 0n};
    }
    if (!chain || chain.committer === ZERO || chain.committedAt === 0n) {
        return {phase: "local", label: "not committed", until: 0n};
    }
    const t0 = asBig(chain.committedAt);
    const opens = t0 + D;
    const closes = opens + W;
    const n = nowSec();
    if (n < opens) return {phase: "cancel", label: "cancel open", until: opens};
    if (n <= closes) return {phase: "reveal", label: "reveal open", until: closes};
    return {phase: "lost", label: "reveal closed", until: 0n};
};

Venue.paintTickets = async function () {
    const who = Venue.viewer();
    if (!who) {
        $("tickets").innerHTML = '<div class="empty">Connect a wallet to see the tickets this browser is holding for you.</div>';
        return;
    }
    const tickets = readList("tickets", who);
    if (!tickets.length) {
        $("tickets").innerHTML = '<div class="empty">No tickets on this device. A reveal is a list of tickets, not a salt form, so a committed order shows up here.</div>';
        return;
    }
    const chains = await Promise.all(tickets.map((t) =>
        Venue.c.engine.commitments(t.id).catch(() => null)
    ));
    const cards = [];
    for (let i = 0; i < tickets.length; i++) {
        const t = tickets[i];
        const chain = chains[i];
        const ph = Venue.ticketPhase(t, chain);
        const D = Number(CLIENT.immutables.revealDelay);
        const W = Number(CLIENT.immutables.revealWindow);
        const t0 = chain && chain.committedAt ? Number(chain.committedAt) : 0;
        const elapsed = t0 ? Math.max(0, Number(nowSec()) - t0) : 0;
        const life = D + W;
        const pct = t0 ? Math.min(100, (elapsed / life) * 100) : 0;
        const actions = [];
        if (ph.phase === "cancel") {
            actions.push('<button type="button" data-act="cancel" data-id="' + esc(t.id) + '">Cancel</button>');
        }
        if (ph.phase === "reveal") {
            actions.push('<button type="button" class="primary" data-act="reveal" data-id="' + esc(t.id) + '">Reveal</button>');
        }
        cards.push(
            '<article class="card ' + (ph.phase === "cancel" ? "sealed" : ph.phase === "reveal" ? "open" : ph.phase === "lost" ? "dead" : "") + '">' +
            '<span class="phase ' + ph.phase + '">' + ph.label +
            (ph.until ? " · " + fmtRemain(ph.until - nowSec()) : "") + "</span>" +
            '<div class="id">' + esc(t.id) + "</div>" +
            '<div class="meta">' + (t.side === 1 ? "SELL" : "BUY") +
            " · price " + esc(String(t.price)) + " tinybar · qty " + esc(String(t.qty)) +
            (t.holdId ? " · hold " + esc(String(t.holdId)) : "") + "</div>" +
            '<div class="tlbar"><span class="seg cancelw">cancel ' + D + "s</span>" +
            '<span class="seg revealw">reveal ' + W + "s</span>" +
            '<span class="seg gone">forfeit</span></div>' +
            (t0 ? '<div class="needle"><i style="left:' + pct + '%"></i></div>' : "") +
            '<div class="rowbtns">' + actions.join("") +
            '<button type="button" class="quiet" data-act="download" data-id="' + esc(t.id) + '">Save file</button></div>' +
            "</article>"
        );
    }
    $("tickets").innerHTML = cards.join("");
    $("tickets").onclick = (e) => {
        const btn = e.target.closest("button[data-act]");
        if (!btn) return;
        const id = btn.getAttribute("data-id");
        const act = btn.getAttribute("data-act");
        if (act === "cancel") Venue.doCancel(id).catch((err) => Venue.fail(err));
        if (act === "reveal") Venue.doReveal(id).catch((err) => Venue.fail(err));
        if (act === "download") {
            const t = readList("tickets", Venue.account).find((x) => x.id === id);
            if (t) downloadJson("seamme-ticket-" + id.slice(2, 10) + ".json", ticketFile(t));
        }
    };
};

Venue.doCancel = async function (id) {
    await Venue.requireAccount();
    const until = asBig(await Venue.c.engine.cancellableUntil(id));
    if (until === 0n) throw new Error("cancellableUntil is 0 — terminal, or unknown.");
    if (nowSec() >= until) throw new Error("Cancel window has shut. Reveal is the remaining move.");
    const rec = await Venue.send(Venue.w.engine.cancel(id, {gasLimit: 400_000}), "cancel");
    if (rec) {
        Venue.status("trade-status", "Cancelled. Refund sits in credit until you withdraw.", "ok");
        await Venue.refreshTrade();
        await Venue.noteReceipt("cancel", rec, 15, G.PRED, T.IMM);
    }
};

Venue.doReveal = async function (id) {
    await Venue.requireAccount();
    const t = readList("tickets", Venue.account).find((x) => x.id === id);
    if (!t) throw new Error("No local ticket for that id. Load the file.");
    const side = Number(t.side);
    const price = BigInt(t.price);
    const qty = BigInt(t.qty);
    let backing = 0n;
    if (side === 1) {
        backing = BigInt(t.holdId || $("holdId").value || "0");
        if (backing === 0n) throw new Error("A sell needs the hold id on the ticket.");
        const hold = await Venue.c.holds.getHoldForByPartition({
            partition: CLIENT.immutables.partition,
            tokenHolder: Venue.account,
            holdId: backing,
        });
        if (hold.escrow_ === ZERO || asBig(hold.amount_) === 0n) {
            throw new Error("Hold id " + backing + " reads as empty.");
        }
        if (!addrEq(hold.escrow_, CLIENT.addresses.MatchingEngine)) {
            throw new Error("Hold escrow is not the matching engine.");
        }
        if (!addrEq(hold.destination_, ZERO)) throw new Error("Hold names a destination.");
        if (asBig(hold.amount_) < qty) throw new Error("Hold is smaller than qty.");
    }
    const value = side === 0 ? toWeibar(buyEscrow(price, qty)) : 0n;
    const rec = await Venue.send(
        Venue.w.engine.reveal(side, price, qty, t.salt, backing, {value, gasLimit: 800_000}),
        "reveal"
    );
    if (rec) {
        Venue.status("trade-status", "Opened. The round can cross once it ends.", "ok");
        await Venue.refreshTrade();
        await Venue.noteReceipt("reveal", rec, 4, G.EXACT, T.IMM);
    }
};

Venue.doCross = async function () {
    await Venue.requireAccount();
    const r = Venue.snap.round === 0n ? 0n : Venue.snap.round - 1n;
    const rec = await Venue.send(Venue.w.engine.crossRound(r, {gasLimit: 1_500_000}), "crossRound");
    if (rec) {
        const q = await Venue.c.engine.quote(r);
        Venue.status("trade-status",
            q.willCross
                ? "Crossed round " + r + " at " + displayPrice(asBig(q.priceTwice)) + " (display only)."
                : "Round " + r + " printed empty.",
            "ok");
        await Venue.refreshTrade();
        await Venue.noteReceipt("cross", rec, 13, G.PRED, T.IMM);
    }
};

Venue.doWithdraw = async function () {
    await Venue.requireAccount();
    const rec = await Venue.send(Venue.w.engine.withdraw({gasLimit: 250_000}), "withdraw");
    if (rec) await Venue.refreshTrade();
};

// One wave. The venue's own four figures, the viewer's four, and the quote all
// go out together: `quote` is the only one that needed a round number first, and
// the clocks already read one this tick.
Venue.refreshTrade = async function () {
    const {engine, token, registry, holds} = Venue.c;
    const acc = Venue.viewer();
    const round = Venue.snap.round ?? Venue.predictRound();
    const [bond, fee, chainRound, revealed, kyc, bal, held, credit, q] = await Promise.all([
        engine.commitBond(),
        engine.cancelFee(),
        engine.currentRound(),
        engine.revealedCount(),
        acc ? registry.getKycStatus(acc) : null,
        acc ? token.balanceOfByPartition(CLIENT.immutables.partition, acc) : null,
        acc ? holds.getHeldAmountForByPartition(CLIENT.immutables.partition, acc) : null,
        acc ? engine.credit(acc) : null,
        acc ? engine.quote(round) : null,
    ]);
    $("im-bond").textContent = formatHbar(asBig(bond)) + " HBAR";
    $("im-fee").textContent = formatHbar(asBig(fee)) + " HBAR";
    $("im-round").textContent = chainRound.toString();
    $("im-live").textContent = revealed.toString() + " revealed";
    if (acc) {
        $("bal-kyc").textContent = Number(kyc) === 1 ? "granted" : "not granted";
        $("bal-units").textContent = formatQuantity(asBig(bal));
        $("bal-held").textContent = formatQuantity(asBig(held));
        $("bal-credit").textContent = formatHbar(asBig(credit)) + " HBAR";
        $("withdraw").disabled = asBig(credit) === 0n || !Venue.account;
        $("kyc-gate").hidden = Number(kyc) === 1;
        // The quote was asked of the round this client predicted. If the round
        // turned over between the prediction and the answer, ask again rather
        // than print a quote for a round that has ended.
        const quote = asBig(chainRound) === asBig(round) ? q : await engine.quote(chainRound);
        $("quote").textContent = quote.willCross
            ? "This round would cross at " + displayPrice(asBig(quote.priceTwice)) + ", volume " + formatQuantity(asBig(quote.volume))
            : "This round would not cross (quote is a view).";
    }
    Venue.paintTicket();
    await Venue.paintTickets();
};

Venue.noteReceipt = async function (kind, rec, row, g, t) {
    try {
        const epoch = Venue.snap.discEpoch;
        const engine = Venue.c.engine;
        const [ceiling, would, spent, afford, br] = await Promise.all([
            engine.ceilingFor(row),
            engine.wouldDisclose(row, g, t),
            engine.spentBits(row, epoch),
            engine.wouldAfford(row, g),
            engine.breakingSize(row, g),
        ]);
        const disc = CLIENT.disclosure["row" + row] || {domainBits: 0, aggBits: 0, bucketBits: 0, budgetBits: 0};
        const local = receiptFor(Number(ceiling), disc, Number(spent), g, t);
        Venue.lastView = {
            kind, row, g, t, tx: rec.hash, epoch: epoch.toString(),
            ceiling: ceiling.toString(), would: !!would, spent: spent.toString(),
            afford: !!afford, breaking: br.toString(),
            permitted: local.permitted, audible: null,
        };
    } catch { /* getters only */ }
};

Venue.mountPosition = async function () {
    $("watch-go")?.addEventListener("click", () => Venue.doWatch().catch((e) => Venue.fail(e)));
    $("withdraw")?.addEventListener("click", () => Venue.doWithdraw().catch((e) => Venue.fail(e)));
    $("disclose")?.addEventListener("click", () => Venue.refreshDisclosure().catch((e) => Venue.fail(e)));
    await Promise.all([
        Venue.refreshPosition(),
        Venue.refreshInstrument().catch(() => {}),
    ]);
};

Venue.refreshPosition = async function () {
    const who = Venue.viewer();
    const [, credit] = await Promise.all([
        Venue.refreshDisclosure(),
        who ? Venue.c.engine.credit(who) : null,
    ]);
    if (!who) return;
    $("pos-credit").textContent = formatHbar(asBig(credit)) + " HBAR";
    $("withdraw").disabled = asBig(credit) === 0n || !Venue.account;
    const tickets = readList("tickets", who);
    $("pos-tickets").textContent = tickets.length ? tickets.length + " on this device" : "none stored here";
    if (Venue.lastView) Venue.paintLastView();
};

Venue.refreshDisclosure = async function () {
    const engine = Venue.c.engine;
    const policy = Venue.c.policy;
    const epoch = Venue.snap.discEpoch ?? asBig(await policy.currentEpoch());
    const rows = Object.keys(CLIENT.disclosure).filter((k) => k.startsWith("row")).map((k) => Number(k.slice(3)));

    // The budget and the waiver come off ParameterRoot, not off the bundle.
    // client.json records what these were when it was generated; a governance
    // window exists so they can change without it, and docs/UI-INTEGRATION-MAP.md
    // says in as many words not to hardcode a number from that file.
    //
    // The bundle is still allowed to say which granularity to *ask about*, which
    // is not the same as printing a figure from it. Asking is free to be wrong:
    // `budgetFor` goes out in the same wave, and any row where the bundle and the
    // chain disagree is asked again at the granularity the chain gave. That turns
    // fifty reads plus twenty into one round trip instead of two, and a governance
    // change costs a second one on the tick that meets it rather than being missed.
    const ask = rows.map((row) => {
        const b = CLIENT.disclosure["row" + row];
        return b ? !!b.metered : true;
    });
    const rowCalls = (row, metered) => {
        const g = metered ? G.PRED : G.EXACT;
        return [
            engine.ceilingFor(row),
            engine.wouldDisclose(row, g, T.IMM),
            engine.spentBits(row, epoch),
            engine.wouldAfford(row, g),
            engine.breakingSize(row, g),
        ];
    };
    const [live, got] = await Promise.all([
        Promise.all(rows.map(async (row) => {
            const [budget, waived] = await Promise.all([
                policy.budgetFor(row), policy.isWaived(row),
            ]);
            return {budgetBits: Number(budget[3]), metered: Number(budget[3]) !== 0, waived};
        })),
        Promise.all(rows.flatMap((row, i) => rowCalls(row, ask[i]))),
    ]);
    const drift = rows.map((row, i) => live[i].metered !== ask[i]).filter(Boolean).length;
    if (drift) {
        const redo = await Promise.all(rows.flatMap((row, i) =>
            live[i].metered === ask[i] ? [] : rowCalls(row, live[i].metered)));
        let k = 0;
        rows.forEach((row, i) => {
            if (live[i].metered === ask[i]) return;
            for (let j = 0; j < 5; j++) got[i * 5 + j] = redo[k++];
        });
    }

    const head = '<div class="rowline head"><span>Row</span><span>Name</span><span>Ceiling</span><span>Would</span><span>Spent</span><span>Afford</span></div>';
    const lines = rows.map((row, i) => {
        const meta = live[i];
        const off = i * 5;
        const ceiling = got[off], would = got[off + 1], spent = got[off + 2], afford = got[off + 3], br = got[off + 4];
        const bundled = CLIENT.disclosure["row" + row];
        const drifted = bundled && String(bundled.ceiling) !== String(ceiling);
        return '<div class="rowline"><span class="mono">' + row + "</span><span>" +
            esc(ROW_NAMES[row] || "") + (meta.waived ? ' <i class="hint">waived</i>' : "") +
            '</span><span class="mono">' +
            "0x" + Number(ceiling).toString(16) +
            (drifted ? ' <b class="bad">≠ bundle</b>' : "") + '</span><span class="mono">' +
            (would ? "true" : "false") + '</span><span class="mono">' +
            spent.toString() + (meta.metered ? " / " + meta.budgetBits : "") +
            '</span><span class="mono">' + (afford ? "true" : "false") +
            (asBig(br) > 0n ? " · break " + br : "") + "</span></div>";
    });
    $("disc-rows").innerHTML = head + lines.join("");
    $("disc-epoch").textContent = String(epoch);
};

Venue.paintLastView = function () {
    const v = Venue.lastView;
    if (!v || !$("last-view")) return;
    $("last-view").innerHTML =
        '<article class="card sealed"><div class="meta">' + esc(v.kind) +
        " · tx <a href='" + esc(explorerTx(v.tx)) + "'>" + esc(shortId(v.tx)) + "</a></div>" +
        "<div>row " + v.row + " " + esc(ROW_NAMES[v.row] || "") +
        " · " + G_NAME[v.g] + " · " + T_NAME[v.t] + "</div>" +
        "<div class='meta'>ceilingFor=" + esc(v.ceiling) +
        " · wouldDisclose=" + v.would +
        " · spentBits=" + esc(v.spent) +
        " · wouldAfford=" + v.afford +
        " · breakingSize=" + esc(v.breaking) +
        " · permitted locally " + v.permitted +
        "</div><div class='meta'>A row can be permitted and inaudible at once. Epoch from the action is not re-derived from currentEpoch at paint time if the receipt named one: " +
        esc(v.epoch) + ".</div></article>";
};

Venue.doWatch = async function () {
    const raw = $("repo-ids").value.trim();
    const ids = raw.split(/[\s,]+/).filter(Boolean);
    if (!ids.length) throw new Error("Paste one or more repo ids.");
    const [alerts, stream] = await Venue.c.watch.watch(ids);
    const rows = alerts.map((a, i) => {
        const st = REPO_STATE[Number(a.state)] || String(a.state);
        return '<div class="card"><div class="id">' + esc(ids[i]) + "</div>" +
            "<div class='meta'>state " + st +
            (a.called ? " · called" : "") +
            (a.unmarkedFail ? " · unmarked fail" : "") +
            (a.defaultable ? " · defaultable" : "") +
            "</div></div>";
    }).join("");
    $("watch-out").innerHTML = rows +
        '<div class="banner' + (stream.audible ? "" : " held") + '">' +
        "stream epoch " + stream.epoch +
        " · permitted " + stream.permitted +
        " · audible " + stream.audible +
        " · spent " + stream.spentBits + "/" + stream.budgetBits +
        " · breakingSize " + stream.breakingSize +
        (stream.audible ? "" : ". The log cannot be believed; a permitted row can still be inaudible.") +
        "</div>";
};

window.Venue = Venue;
