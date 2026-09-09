// Live client runtime. Inlined into the three screens by tools/gen-app.mjs.
// Relies on globals from the previous INLINE blocks: CLIENT, ABI, units,
// commitmentOf / preimageWords / SIDE / selector, lattice receiptFor, and ethers.

const ZERO = "0x0000000000000000000000000000000000000000";
const ATS_KYC = "0xfc855b1b";
const TICKET_VER = 1;
const VAULT_VER = 1;
const HOLD_VER = 1;
const ORDER_SCALE_LIMIT = 1n << 96n;
const VAULT_IDB = "seamme.vault";
const VAULT_STORE = "handles";
const RECEIPT_SESSION = "seamme.disclosure-receipt.v1";
const TRADE_SIDE_KEY = "seamme.trade.side";
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
    {i: 0, label: "Reuse limit", help: "Prevents one credential from being reused too often"},
    {i: 1, label: "Proof result", help: "Confirms the credential meets the current rules"},
    {i: 2, label: "Credential list", help: "Uses the issuer's list for this KYC period"},
    {i: 3, label: "KYC period", help: "Keeps an old proof from carrying forward"},
    {i: 4, label: "Connected wallet", help: "Binds access to the wallet requesting it"},
    {i: 5, label: "Access tier", help: "Meets the venue's minimum access level"},
    {i: 6, label: "Region policy", help: "Meets the venue's current region rules"},
];
const EMPTY_SIGNALS =
    '<div class="empty">Load a proof to compare its seven public checks with the ' +
    "venue's current requirements.</div>";
const REPO_STATE = ["NONE", "PROPOSED", "OPEN", "MARGIN_CALL", "MANUFACTURED", "FAILING", "DEFAULTED", "CLOSED"];
const G_NAME = ["none", "predicate", "aggregate", "bucket", "exact"];
const T_NAME = ["before the fact", "immediately", "after 15 minutes", "at end of day", "at end of epoch", "never"];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));
const readableHbar = (tinybar) => formatHbar(asBig(tinybar))
    .replace(/(\.\d*?[1-9])0+$/, "$1")
    .replace(/\.0+$/, "");
const shortAddr = (a) => a ? a.slice(0, 6) + "…" + a.slice(-4) : "Unknown";
const shortId = (id) => id ? id.slice(0, 10) + "…" + id.slice(-6) : "Unknown";
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
        if (why) message += ": " + why;
    }
    if (name === "UnknownCommitment") {
        message += ". The preimage does not match; check the reveal key on the ticket.";
    }
    if (name === "RegistrantMismatch") {
        message = "This proof belongs to another account. Watch that grant, or connect the matching wallet to request access.";
    }
    if (name === "NotEscrow") {
        const escrow = parsed ? String(parsed.args[0]) : "";
        if (addrEq(escrow, ZERO) || escrow === "0" || escrow === "0x") {
            message = "That inventory reservation does not exist for this wallet.";
        }
    }
    const at = (value) => new Date(Number(asBig(value)) * 1000)
        .toISOString().replace("T", " ").slice(0, 19) + "Z";
    if (name === "AlreadyCommitted") message = "This sealed order was already submitted. Draw a new reveal key for another order.";
    if (name === "AlreadyRevealed") message = "This order has already been revealed or permanently closed.";
    if (name === "AlreadyCancelled") message = "This order has already been cancelled.";
    if (name === "TooEarly" && parsed) message = "Reveal is not open yet. It opens at " + at(parsed.args[0]) + ".";
    if (name === "TooLate" && parsed) message = "The reveal deadline passed at " + at(parsed.args[0]) + ".";
    if (name === "CancelWindowClosed" && parsed) {
        message = "Cancellation closed at " + at(parsed.args[0]) + ". Reveal is now the required action.";
    }
    if (name === "WrongEscrow" && parsed) {
        message = "The buy requires exactly " + formatHbar(asBig(parsed.args[1])) +
            " HBAR at reveal. Refresh the order before trying again.";
    }
    if (name === "HoldTooSmall" && parsed) {
        message = "The attached reservation has " + formatQuantity(asBig(parsed.args[0])) +
            " LPRC, but this sell needs " + formatQuantity(asBig(parsed.args[1])) + ".";
    }
    if (name === "HoldExpiresTooSoon" && parsed) {
        message = "The inventory reservation expires before the order's final auction round. Reserve inventory again.";
    }
    if (name === "HoldNamesADestination") {
        message = "This inventory reservation is restricted to another recipient and cannot back an auction order.";
    }
    if (name === "NotCommitter") message = "Only the wallet that submitted this order can take that action.";
    if (name === "NothingToWithdraw") message = "No trading credit is currently available to withdraw.";
    if (name === "RoundStillOpen") message = "This auction round is still open. Process it after the round closes.";
    if (name === "AlreadyCrossed") message = "The last closed auction round has already been processed.";
    if (name === "StillResting" && parsed) message = "This order is still eligible to trade until " + at(parsed.args[0]) + ".";
    if (name === "VenueHalted" && parsed) message = "Auction processing is paused until " + at(parsed.args[0]) + ".";
    if (name === "PriceOutOfRange" || name === "QtyOutOfRange" || name === "OutOfRange") {
        message = "The order value is outside the supported contract range.";
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

function readPocketProof(account) {
    if (!account) return null;
    try {
        const raw = localStorage.getItem(storeKey("proof", account));
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function writePocketProof(account, picked, epoch) {
    if (!account || !picked) return;
    try {
        localStorage.setItem(storeKey("proof", account), JSON.stringify({
            epoch: String(epoch),
            proof: picked.proof,
            pub: picked.pub,
            address: picked.address || account,
        }));
    } catch { /* quota or private mode */ }
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
        warning: "Without this reveal key the order cannot be revealed and the commit bond is forfeit.",
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
        cancelled: t.cancelled || undefined,
        cancelTx: t.cancelTx || undefined,
        revealed: t.revealed || undefined,
        revealTx: t.revealTx || undefined,
        revealedAt: t.revealedAt || undefined,
        crossTx: t.crossTx || undefined,
    };
}

function vaultName(account) {
    const short = (account || "").replace(/^0x/i, "").slice(0, 8).toLowerCase();
    return "seamme-orders-" + CLIENT.network.chainId + "-" + short + ".json";
}

function vaultFile(account) {
    return {
        v: VAULT_VER,
        kind: "vault",
        warning: "Without these reveal keys the orders cannot be revealed and the commit bonds are forfeit.",
        network: CLIENT.network.chainId,
        engine: CLIENT.addresses.MatchingEngine,
        account,
        savedAt: new Date().toISOString(),
        tickets: readList("tickets", account).map(ticketFile),
    };
}

function isVaultBlob(obj) {
    return !!(obj && (obj.kind === "vault" || Array.isArray(obj.tickets)));
}

function ticketsFromBlob(obj) {
    if (Array.isArray(obj)) return obj;
    if (Array.isArray(obj?.tickets)) return obj.tickets;
    return null;
}

function ticketRecord(t, account) {
    if (!t || typeof t !== "object" || Array.isArray(t)) {
        throw new Error("The recovery file contains an invalid order.");
    }
    if (t.network != null && String(t.network) !== String(CLIENT.network.chainId)) {
        throw new Error("That order is for another network.");
    }
    if (t.engine && !addrEq(t.engine, CLIENT.addresses.MatchingEngine)) {
        throw new Error("That order belongs to another market contract.");
    }
    const committer = String(t.committer || "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(committer) || addrEq(committer, ZERO)) {
        throw new Error("The recovery file has an invalid submitting wallet.");
    }
    if (account && !addrEq(committer, account)) {
        throw new Error("That order belongs to another wallet.");
    }
    const side = Number(t.side);
    if (side !== 0 && side !== 1) throw new Error("The recovery file has an invalid order side.");
    const priceRaw = String(t.price ?? "");
    const qtyRaw = String(t.qty ?? "");
    if (!/^\d+$/.test(priceRaw) || !/^\d+$/.test(qtyRaw)) {
        throw new Error("The recovery file has an invalid price or quantity.");
    }
    const price = BigInt(priceRaw);
    const qty = BigInt(qtyRaw);
    if (price === 0n || qty === 0n || price >= ORDER_SCALE_LIMIT || qty >= ORDER_SCALE_LIMIT) {
        throw new Error("The recovery file has an out-of-range price or quantity.");
    }
    const salt = String(t.salt || "");
    const id = String(t.id || "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(salt) || !/^0x[0-9a-fA-F]{64}$/.test(id)) {
        throw new Error("The recovery file has an invalid reveal key or order id.");
    }
    if (commitmentOf(committer, side, price, qty, salt).toLowerCase() !== id.toLowerCase()) {
        throw new Error("The recovery key and order details do not match this order id.");
    }
    const optionalHash = (value, label) => {
        if (!value) return undefined;
        const hash = String(value);
        if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
            throw new Error("The recovery file has an invalid " + label + ".");
        }
        return hash;
    };
    const optionalUint = (value, label, max) => {
        if (value == null || value === "") return null;
        const raw = String(value);
        if (!/^\d+$/.test(raw) || BigInt(raw) > max) {
            throw new Error("The recovery file has an invalid " + label + ".");
        }
        return BigInt(raw).toString();
    };
    return {
        v: t.v || TICKET_VER,
        committer,
        side,
        price: price.toString(),
        qty: qty.toString(),
        salt,
        id,
        holdId: optionalUint(t.holdId, "inventory reservation id", (1n << 256n) - 1n),
        committedAt: optionalUint(t.committedAt, "submission time", (1n << 64n) - 1n),
        commitTx: optionalHash(t.commitTx, "submission receipt") || null,
        savedAt: t.savedAt || new Date().toISOString(),
        cancelled: t.cancelled || undefined,
        cancelTx: optionalHash(t.cancelTx, "cancellation receipt"),
        revealed: t.revealed || undefined,
        revealTx: optionalHash(t.revealTx, "reveal receipt"),
        revealedAt: t.revealedAt || undefined,
        crossTx: optionalHash(t.crossTx, "settlement receipt"),
    };
}

function canPickVaultFile() {
    return typeof window.showSaveFilePicker === "function";
}

function vaultHandleKey(account) {
    return String(CLIENT.network.chainId) + "." + account.toLowerCase();
}

function openVaultIdb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(VAULT_IDB, 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(VAULT_STORE)) {
                req.result.createObjectStore(VAULT_STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function getVaultHandle(account) {
    const db = await openVaultIdb();
    try {
        return await new Promise((resolve, reject) => {
            const r = db.transaction(VAULT_STORE, "readonly").objectStore(VAULT_STORE).get(vaultHandleKey(account));
            r.onsuccess = () => resolve(r.result || null);
            r.onerror = () => reject(r.error);
        });
    } finally {
        db.close();
    }
}

async function setVaultHandle(account, handle) {
    const db = await openVaultIdb();
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(VAULT_STORE, "readwrite");
            tx.objectStore(VAULT_STORE).put(handle, vaultHandleKey(account));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

async function clearVaultHandle(account) {
    const db = await openVaultIdb();
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(VAULT_STORE, "readwrite");
            tx.objectStore(VAULT_STORE).delete(vaultHandleKey(account));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

async function vaultHandleWritable(handle) {
    const opts = {mode: "readwrite"};
    if (handle.queryPermission && await handle.queryPermission(opts) === "granted") return true;
    if (handle.requestPermission && await handle.requestPermission(opts) === "granted") return true;
    return !handle.queryPermission;
}

async function writeVaultToHandle(handle, obj) {
    const w = await handle.createWritable();
    await w.write(JSON.stringify(obj, null, 2));
    await w.close();
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
    lastView: null,
    eth: null,
    _vaultHandles: {},
    orderStage: "details",
    trackTicketId: null,
};

Venue.restoreReceipt = function () {
    try {
        const text = sessionStorage.getItem(RECEIPT_SESSION);
        if (!text || text.length > 4096) return;
        const view = JSON.parse(text);
        if (
            !view
            || typeof view !== "object"
            || typeof view.kind !== "string"
            || !/^0x[0-9a-fA-F]{64}$/.test(String(view.tx || ""))
        ) return;
        if (!view.unmetered) {
            if (
                !Number.isInteger(view.row)
                || view.row < 0
                || view.row > 65535
                || !Number.isInteger(view.g)
                || view.g < 0
                || view.g >= G_NAME.length
                || !Number.isInteger(view.t)
                || view.t < 0
                || view.t >= T_NAME.length
            ) return;
        }
        Venue.lastView = view;
    } catch { /* private mode or an old value; this tab starts without a receipt */ }
};

Venue.rememberReceipt = function () {
    if (!Venue.lastView) return;
    try {
        sessionStorage.setItem(RECEIPT_SESSION, JSON.stringify(Venue.lastView));
    } catch { /* private mode; the receipt remains available on this page */ }
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
        // The feed, and the one contract here that is allowed not to exist. A
        // checkout whose address book predates PrimeOracle still boots every
        // screen; the Repo screen says the feed is not configured rather than
        // throwing, which is the shape `gen-app.mjs` already uses for the
        // consensus topic. Once it is in the address book it is not optional to
        // anything: `assertWiring` refuses to render a venue whose vault is
        // pointed at some other feed.
        oracle: A.PrimeOracle
            ? new ethers.Contract(A.PrimeOracle, ABI.PrimeOracle, runner)
            : null,
        couponSchedule: A.CouponSchedule
            ? new ethers.Contract(A.CouponSchedule, ABI.CouponSchedule, runner)
            : null,
        couponDistributor: A.CouponDistributor
            ? new ethers.Contract(A.CouponDistributor, ABI.CouponDistributor, runner)
            : null,
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
    Venue.restoreReceipt();
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
    await Venue.probeFinancing();
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
    const {engine, token, vault, watch, couponDistributor} = Venue.c;
    const A = CLIENT.addresses;
    const couponChecks = A.CouponSchedule
        ? Promise.all([
            vault.schedule(),
            watch.vault(),
            couponDistributor.policy(),
            couponDistributor.schedule(),
            couponDistributor.cash(),
        ])
        : Promise.resolve(null);
    const [sec, comp, pol, cap, halt, tcomp, kyc, feedOf, couponOf] = await Promise.all([
        engine.security(),
        engine.compliance(),
        engine.policy(),
        engine.volumeCap(),
        engine.tradingHalt(),
        token.compliance(),
        token.isExternalKycList(A.ZkKycRegistry),
        A.PrimeOracle ? vault.oracle() : Promise.resolve(null),
        couponChecks,
    ]);
    const fails = [];
    if (!addrEq(sec, A.token)) fails.push("engine.security() is not the bond");
    if (!addrEq(comp, A.SeamJournal)) fails.push("engine.compliance() is not SeamJournal");
    if (!addrEq(pol, A.ParameterRoot)) fails.push("engine.policy() is not ParameterRoot");
    if (addrEq(cap, ZERO)) fails.push("engine.volumeCap() is zero");
    if (addrEq(halt, ZERO)) fails.push("engine.tradingHalt() is zero");
    if (!addrEq(tcomp, A.SeamJournal)) fails.push("token.compliance() is not SeamJournal");
    if (!kyc) fails.push("token.isExternalKycList(ZkKycRegistry) is false");
    // A vault pointed at some other feed is a vault whose margin calls came from
    // a price this screen cannot show you, which is worse than showing nothing.
    if (feedOf !== null && !addrEq(feedOf, A.PrimeOracle)) {
        fails.push("vault.oracle() is not the PrimeOracle in this address book");
    }
    if (couponOf) {
        if (!addrEq(couponOf[0], A.CouponSchedule)) {
            fails.push("vault.schedule() is not CouponSchedule");
        }
        if (!addrEq(couponOf[1], A.RepoVault)) {
            fails.push("watch.vault() is not RepoVault");
        }
        if (!addrEq(couponOf[2], A.ParameterRoot)) {
            fails.push("distributor.policy() is not ParameterRoot");
        }
        if (!addrEq(couponOf[3], A.CouponSchedule)) {
            fails.push("distributor.schedule() is not CouponSchedule");
        }
        if (!addrEq(couponOf[4], A.couponCashToken)) {
            fails.push("distributor.cash() is not couponCashToken");
        }
    }
    if (fails.length) throw new Error(fails.join("; "));
};

// Historical vaults have no FINANCING_VERSION getter. Never bind fund/accept
// buttons to that bytecode. A missing selector is the gate, not a boot failure.
Venue.probeFinancing = async function () {
    Venue.financing = {
        ready: false,
        version: 0,
        reason: "This bound vault predates funded offers. Financing writes stay unavailable until a replacement vault is deployed.",
    };
    const vault = Venue.c?.vault;
    if (!vault) return;
    try {
        if (typeof vault.FINANCING_VERSION !== "function") return;
        const v = Number(await vault.FINANCING_VERSION());
        Venue.financing.version = v;
        if (
            v < 5 || typeof vault.fundOffer !== "function"
                || typeof vault.accept !== "function"
                || typeof vault.exposureNow !== "function"
                || typeof vault.registry !== "function"
                || typeof Venue.c?.oracle?.referenceRateBefore !== "function"
        ) {
            Venue.financing.reason = "This vault reports financing version " + v +
                ". Eligibility, fixed-term repayment, and historical coupon fixings require version 5.";
            return;
        }
        const boundRegistry = await vault.registry();
        if (!addrEq(boundRegistry, CLIENT.addresses.ZkKycRegistry)) {
            Venue.financing.reason =
                "This vault is not bound to the eligibility registry in the address book.";
            return;
        }
        try {
            const latest = await Venue.c.oracle.latest();
            const publishedAt = asBig(latest.publishedAt);
            if (publishedAt === 0n) throw new Error("no finalized oracle round");
            await Venue.c.oracle.referenceRateBefore(publishedAt + 1n);
        } catch {
            Venue.financing.reason =
                "The bound oracle cannot reproduce a historical coupon fixing.";
            return;
        }
        Venue.financing.ready = true;
        Venue.financing.reason = "";
    } catch {
        // Old bytecode: the call reverts or returns empty. Writes stay hidden.
    }
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
    Venue.bindClockFloat();
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) Venue.tick().catch(() => {});
    });
};

Venue.bindClockFloat = function () {
    const dock = $("clock-float");
    const btn = $("clock-float-toggle");
    const panel = $("clock-panel");
    if (!dock || !btn || !panel) return;

    if (dock.classList.contains("clock-inline")) {
        const close = () => {
            panel.hidden = true;
            btn.setAttribute("aria-expanded", "false");
            dock.classList.remove("open");
        };
        btn.addEventListener("click", () => {
            const opening = panel.hidden;
            panel.hidden = !opening;
            btn.setAttribute("aria-expanded", opening ? "true" : "false");
            dock.classList.toggle("open", opening);
        });
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && !panel.hidden) close();
        });
        return;
    }

    const pad = 12;
    const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

    const headerBottom = () => {
        const mast = document.querySelector(".mast");
        return mast ? mast.getBoundingClientRect().bottom : 0;
    };
    const box = () => {
        const w = dock.offsetWidth;
        const h = dock.offsetHeight;
        const minL = pad;
        const maxL = Math.max(pad, window.innerWidth - w - pad);
        const minT = Math.max(pad, headerBottom() + pad);
        const maxT = Math.max(minT, window.innerHeight - h - pad);
        return {w, h, minL, maxL, minT, maxT};
    };
    const apply = (left, top, held) => {
        const b = box();
        const minT = held ? pad : b.minT;
        const maxT = held ? Math.max(pad, window.innerHeight - b.h - pad) : b.maxT;
        const p = {
            left: Math.min(Math.max(b.minL, left), b.maxL),
            top: Math.min(Math.max(minT, top), maxT),
        };
        dock.style.left = p.left + "px";
        dock.style.top = p.top + "px";
        dock.style.right = "auto";
        dock.style.bottom = "auto";
        dock.classList.add("placed");
        return p;
    };
    const persist = () => {
        const r = dock.getBoundingClientRect();
        localStorage.setItem("seamme.clocks", JSON.stringify({left: r.left, top: r.top}));
    };
    const hang = () => {
        const r = dock.getBoundingClientRect();
        dock.classList.toggle("hang-end", r.left + r.width / 2 < window.innerWidth / 2);
        const room = window.innerHeight - r.bottom;
        dock.classList.toggle("drop-up", !panel.hidden && room < 140 && r.top > room);
    };
    const snapToEdge = () => {
        const r = dock.getBoundingClientRect();
        const b = box();
        const distR = Math.abs(r.right - (window.innerWidth - pad));
        const distL = Math.abs(r.left - b.minL);
        const distT = Math.abs(r.top - b.minT);
        const distB = Math.abs(r.bottom - (window.innerHeight - pad));
        const edges = [
            {d: distR, left: b.maxL, top: r.top},
            {d: distL, left: b.minL, top: r.top},
            {d: distT, left: r.left, top: b.minT},
            {d: distB, left: r.left, top: b.maxT},
        ];
        let pick = edges[0];
        for (const edge of edges) if (edge.d < pick.d) pick = edge;
        if (!reduce()) dock.classList.add("snapping");
        apply(pick.left, pick.top, false);
        hang();
        const done = () => dock.classList.remove("snapping");
        if (!reduce()) {
            dock.addEventListener("transitionend", done, {once: true});
            setTimeout(done, 360);
        }
        persist();
    };
    const parkDefault = () => {
        dock.classList.remove("placed");
        dock.style.left = "auto";
        dock.style.right = "1.25rem";
        dock.style.bottom = "auto";
        dock.style.top = dock.classList.contains("market-clock-float")
            ? Math.max(pad, window.innerHeight - dock.offsetHeight - pad) + "px"
            : Math.round(headerBottom() + pad) + "px";
    };

    try {
        const saved = JSON.parse(localStorage.getItem("seamme.clocks") || "null");
        if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
            apply(saved.left, saved.top, false);
            snapToEdge();
        } else {
            parkDefault();
        }
    } catch (_) {
        parkDefault();
    }

    const close = () => {
        panel.hidden = true;
        btn.setAttribute("aria-expanded", "false");
        dock.classList.remove("open", "drop-up", "hang-end");
    };
    const open = () => {
        panel.hidden = false;
        btn.setAttribute("aria-expanded", "true");
        dock.classList.add("open");
        hang();
    };

    let drag = null;
    const THRESH = 6;

    const onMove = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!drag.moved && (dx * dx + dy * dy) < THRESH * THRESH) return;
        if (!drag.moved) {
            drag.moved = true;
            dock.classList.add("dragging");
            dock.classList.remove("snapping");
        }
        apply(drag.left + dx, drag.top + dy, true);
        hang();
    };
    const endDrag = (e) => {
        if (!drag || (e && e.pointerId !== drag.id)) return;
        const moved = drag.moved;
        const fromBtn = drag.fromBtn;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", endDrag);
        window.removeEventListener("pointercancel", endDrag);
        dock.classList.remove("dragging");
        if (moved) {
            snapToEdge();
            if (!panel.hidden) open();
        } else if (fromBtn) {
            if (panel.hidden) open();
            else close();
        }
        drag = null;
    };

    dock.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        const r = dock.getBoundingClientRect();
        drag = {
            id: e.pointerId,
            x: e.clientX,
            y: e.clientY,
            left: r.left,
            top: r.top,
            moved: false,
            fromBtn: !!e.target.closest("#clock-float-toggle"),
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", endDrag);
        window.addEventListener("pointercancel", endDrag);
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !panel.hidden) close();
    });
    window.addEventListener("resize", () => {
        if (dock.classList.contains("placed")) snapToEdge();
        else parkDefault();
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
        '<h2 id="wm-title">Connect to Lattice Prime</h2>' +
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
        acts.push(() => {
            Venue.stopWatching();
            Venue.closeSheet();
            Venue.clearProveGrant();
            Venue.refreshForViewer().catch(() => {});
        });
    }

    list.innerHTML = html;
    [...list.querySelectorAll(".wallet-row")].forEach((b, i) => {
        b.addEventListener("click", () => {
            const run = acts[i];
            if (run) Promise.resolve(run()).catch((e) => Venue.sheetMsg(Venue.fail(e).message, true));
        });
    });
};

Venue.openSheet = function (opts) {
    Venue.buildSheet();
    // Ask again on open: a wallet installed since page load will answer.
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    Venue.paintWallets();
    const addr = $("wm-addr");
    if (addr) addr.value = (opts && opts.watchAddr) || "";
    Venue.sheetMsg(
        (opts && opts.msg) ||
        "No extension needed. Every screen fills in, and nothing can be signed.",
        false,
    );
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

// A read that started for one viewer must not paint for the next. Disconnect
// from the wallet is the case that used to lose: the masthead cleared, then
// `wouldAccept` came back and wrote the last grant back into Eligibility.
Venue.stillViewer = function (who) {
    const now = Venue.viewer();
    if (!who && !now) return true;
    if (!who || !now) return false;
    return who.toLowerCase() === now.toLowerCase();
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
    if (Venue.page === "prove") await Venue.hydrateProof();
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
            Venue.sheetMsg("You declined the network switch. Lattice Prime only runs on chain 296.", true);
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
        // The masthead follows accountsChanged. Eligibility used not to: the
        // last grant and the use count sat there until a reload.
        Venue.clearProveGrant();
        await Venue.refreshForViewer().catch(() => {});
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
    Venue.clearProveGrant();
    await Venue.hydrateVaultHandle(Venue.account);
    await Venue.refreshForViewer();
    if (Venue.page === "prove") await Venue.hydrateProof();
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
            const now = Date.now();
            if (Venue.refreshOracle && now - (Venue._tradeOracleAt || 0) > 30000) {
                Venue._tradeOracleAt = now;
                work.push(Venue.refreshOracle().catch(() => {}));
            }
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
    Venue.paintTicketClocks();
    const s = Venue.snap;
    if (s.round === undefined) return;
    const t = nowSec();
    const roundLeft = s.roundEnd > t ? s.roundEnd - t : 0n;
    const kycLeft = s.kycEnd > t ? s.kycEnd - t : 0n;
    const discLeft = s.discEnd > t ? s.discEnd - t : 0n;
    const closeTime = new Date(Number(s.roundEnd) * 1000)
        .toISOString().slice(11, 16) + " UTC";
    const set = (id, label, value, warn) => {
        const el = $(id);
        if (!el) return;
        el.querySelector(".k").textContent = label;
        el.querySelector(".v").textContent = value;
        el.classList.toggle("warn", !!warn);
    };
    const fr = $("fact-round");
    if (fr) fr.textContent = s.round.toString();
    set("clk-round", "Auction · Round " + s.round,
        s.halted
            ? "Paused until " + new Date(Number(s.haltUntil) * 1000).toISOString().slice(11, 16) + " UTC"
            : fmtRemain(roundLeft) + " · closes " + closeTime,
        false);
    set("clk-disc", "Disclosure " + s.discEpoch, fmtRemain(discLeft), false);
    set("clk-kyc", "KYC " + s.kycEpoch, fmtRemain(kycLeft), kycLeft < 86400n);
    const haltEl = $("clk-round");
    if (haltEl) haltEl.classList.toggle("halt", !!s.halted);
    $("clock-float-toggle")?.classList.toggle("warn", !!s.halted || kycLeft < 86400n);
    if ($("market-phase")) {
        $("market-phase").textContent = s.halted ? "Auction processing paused" : "Auction open";
    }
    const liveKicker = $("live-market-kicker");
    if (liveKicker) {
        liveKicker.textContent = s.halted ? "Market paused" : "Live market";
        liveKicker.classList.toggle("is-live", !s.halted);
    }
};

Venue.status = function (id, msg, kind) {
    const el = $(id);
    if (!el) return;
    const text = msg || "";
    const same = el.textContent === text && text !== "";
    el.textContent = text;
    el.className = "status" + (kind ? " " + kind : "");
    if (same) Venue.flashStatus(el);
};

Venue.flashStatus = function (el) {
    if (!el) return;
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
};

Venue.pulseProveStatus = function () {
    const el = $("prove-status");
    if (!el) return;
    if (!el.textContent) {
        Venue.status("prove-status", "You already hold a grant this period. Markets is next.", "ok");
        return;
    }
    if (!el.classList.contains("ok")) el.classList.add("ok");
    Venue.flashStatus(el);
};

Venue.paintProveActions = function () {
    const granted = Venue.snap.kyc === 1;
    $("demo-proof")?.classList.toggle("stale", granted);
    $("open-lab")?.classList.toggle("stale", granted);
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
        if (el) el.innerHTML = esc(d.message) + ' <a href="' + d.route + '">Eligibility</a>';
    }
    return d;
};

Venue.tradeTxStage = function (stage, label, detail) {
    if (Venue.page !== "trade") return;
    const action = $("commit");
    const messages = {
        approval: "Confirm " + label.toLowerCase() + " in your wallet.",
        pending: label + " is pending on Hedera.",
        confirmed: label + " confirmed.",
        rejected: "The wallet request was rejected. Your order values and recovery key are unchanged.",
        failed: (detail
            ? String(detail).replace(/[.!?]\s*$/, "") + ". "
            : label + " failed. ") + "Your order values and recovery key are unchanged.",
    };
    Venue.status("trade-status", messages[stage] || "", stage === "confirmed" ? "ok" : stage === "failed" || stage === "rejected" ? "bad" : "");
    if (action) {
        const active = stage === "approval" || stage === "pending";
        action.setAttribute("aria-busy", active ? "true" : "false");
        if (active) {
            action.disabled = true;
            action.textContent = stage === "approval" ? "Check wallet" : label + " pending";
        }
    }
};

Venue.send = async function (txPromise, label) {
    if (Venue.busy) return null;
    Venue.busy = true;
    try {
        const tx = await txPromise;
        Venue.toast(label + " sent " + shortId(tx.hash));
        Venue.tradeTxStage("pending", label);
        const rec = await tx.wait();
        if (rec.status !== 1) throw new Error(label + " reverted");
        Venue.lastReceipt = rec;
        Venue.toast(label + " confirmed");
        Venue.tradeTxStage("confirmed", label);
        return rec;
    } catch (e) {
        const rejected = e?.code === 4001 || e?.code === "ACTION_REJECTED"
            || /user rejected|request rejected|denied/i.test(String(e?.shortMessage || e?.message || ""));
        const d = rejected
            ? {message: "Wallet request rejected."}
            : Venue.fail(e);
        if (rejected) Venue.toast(d.message);
        Venue.tradeTxStage(rejected ? "rejected" : "failed", label, d.message);
        return null;
    } finally {
        Venue.busy = false;
        if (Venue.page === "trade") Venue.paintTicket();
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
        $("clock-float-toggle")?.classList.add("warn");
        const live = document.querySelector(".fact .live");
        if (live) live.style.background = "var(--exposed)";
        const round = $("fact-round");
        if (round) round.textContent = "offline";
        Venue.toast("Could not verify the venue over RPC. Reads are down; the tour still works.");
    }
};

Venue.mountProve = async function () {
    $("proof-file")?.addEventListener("change", (e) => Venue.onProofFile(e.target.files[0]));
    $("demo-proof")?.addEventListener("click", () => {
        if (Venue.snap.kyc === 1) { Venue.pulseProveStatus(); return; }
        Venue.loadDemoProof().catch((e) => Venue.fail(e));
    });
    $("open-lab")?.addEventListener("click", () => {
        if (Venue.snap.kyc === 1) { Venue.pulseProveStatus(); return; }
        const lab = $("prove-lab");
        if (!lab) return;
        lab.open = true;
        lab.scrollIntoView({block: "nearest", behavior: "smooth"});
    });
    const drop = $("drop");
    drop?.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop?.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop?.addEventListener("drop", (e) => {
        e.preventDefault();
        drop.classList.remove("over");
        Venue.onProofFile(e.dataTransfer.files[0]);
    });
    $("kyc-act")?.addEventListener("click", () => {
        if ($("kyc-act")?.dataset.act === "trade") {
            location.href = "trade.html";
            return;
        }
        Venue.openSheet();
    });
    $("check")?.addEventListener("click", () => Venue.previewRegister().catch((e) => {
        const d = Venue.fail(e);
        Venue.status("prove-status", d.message, "bad");
    }));
    $("register")?.addEventListener("click", () => Venue.doRegister().catch((e) => Venue.fail(e)));
    await Promise.all([
        Venue.refreshProve(),
        Venue.refreshGateGov().catch(() => {}),
    ]);
    await Venue.hydrateProof();
};

Venue.clearProveGrant = function () {
    if (Venue.page !== "prove") return;
    Venue.snap.kyc = 0;
    Venue.status("prove-status", "", "");
    const uses = $("uses");
    if (uses) uses.textContent = "";
    const reg = $("register");
    if (reg) reg.disabled = true;
    if (Venue.viewer()) {
        Venue.paintKycAct();
        return;
    }
    $("kyc-banner")?.classList.remove("warn");
    const copy = $("kyc-copy");
    if (copy) copy.textContent = "Connect a wallet, or load a proof to watch a live grant.";
    Venue.paintKycAct();
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
    if (!Venue.stillViewer(who)) return;
    Venue.snap.minTier = asBig(minTier);
    Venue.snap.mask = asBig(mask);
    Venue.snap.maxUses = Number(maxUses);
    Venue.snap.root = asBig(root);
    Venue.snap.nextRoot = asBig(nextRoot);
    $("pol-tier").textContent = minTier.toString();
    $("pol-mask").textContent = "0x" + asBig(mask).toString(16);
    $("pol-root").textContent = root === 0n ? "not published" : toHexWord(root);
    $("pol-next").textContent = nextRoot === 0n
        ? "next epoch root is unpublished; grants die at the boundary"
        : toHexWord(nextRoot);
    $("pol-next").classList.toggle("bad", nextRoot === 0n);
    let status = "Connect a wallet, or load a proof to watch a live grant.";
    if (who) {
        const kyc = Number(granted);
        Venue.snap.kyc = kyc;
        status = kyc === 1
            ? "Allowed for this KYC period. That ends when the period does."
            : "Not yet allowed this period.";
        $("kyc-banner")?.classList.toggle("warn", kyc !== 1);
    } else {
        Venue.snap.kyc = 0;
        $("kyc-banner")?.classList.remove("warn");
        Venue.clearProveGrant();
    }
    Venue.paintKycAct();
    Venue.paintProveActions();
    $("kyc-copy").textContent = status;
    if (Venue.proof) Venue.paintPins();
    Venue.paintCheckButton();
};

Venue.paintKycAct = function () {
    const act = $("kyc-act");
    if (!act) return;
    act.hidden = false;
    act.classList.remove("connected", "primary");
    if (Venue.account && Venue.snap.kyc === 1) {
        act.textContent = "Markets";
        act.classList.add("primary");
        act.setAttribute("aria-label", "Go to Markets");
        act.dataset.act = "trade";
    } else if (Venue.account) {
        act.innerHTML = '<span class="dot"></span>Connected';
        act.classList.add("connected");
        act.setAttribute("aria-label", "Connected as " + Venue.account + ". Open wallet options.");
        act.dataset.act = "sheet";
    } else {
        act.textContent = "Connect";
        act.classList.add("primary");
        act.setAttribute("aria-label", "Connect a wallet");
        act.dataset.act = "sheet";
    }
};

Venue.paintCheckButton = function () {
    const btn = $("check");
    if (!btn || Venue._checking) return;
    btn.disabled = false;
    btn.removeAttribute("disabled");
    btn.classList.remove("busy");
    btn.setAttribute("aria-busy", "false");
    btn.textContent = btn.dataset.label || "Check the gate";
};

Venue.onProofFile = async function (file) {
    if (!file) return;
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); }
    catch { Venue.status("prove-status", "That file is not JSON.", "bad"); return; }
    const picked = Venue.pickProof(data);
    if (!picked) {
        Venue.status("prove-status", "That file is not a proof the gate recognises.", "bad");
        return;
    }
    Venue.proof = picked;
    const epoch = Venue.snap.kycEpoch;
    const who = picked.address || Venue.viewer();
    if (who && epoch != null) writePocketProof(who, picked, epoch);
    Venue.paintCheckButton();
    Venue.paintPins();
    if (Venue.viewer()) {
        await Venue.previewRegister().catch((e) => {
            Venue.status("prove-status", Venue.fail(e).message, "bad");
        });
        return;
    }
    Venue.status("prove-status", "Loaded your proof file. Check the gate next.", "ok");
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
/// the issuer's three addresses they get their own. Otherwise this is the same
/// door as Connect: a proof that does not name the viewer would fail
/// `RegistrantMismatch`, and silently watching the issuer instead looked like
/// the page had connected a wallet when it had not.
Venue.loadDemoProof = async function () {
    const epoch = Venue.snap.kycEpoch !== undefined && Venue.snap.kycEpoch !== null
        ? String(Venue.snap.kycEpoch)
        : String(await Venue.c.registry.currentEpoch());
    const set = (typeof DEMO_PROOFS !== "undefined" && DEMO_PROOFS) ? DEMO_PROOFS[epoch] : null;
    if (!set) {
        Venue.status("prove-status",
            "This page has no live proof for the current KYC period.", "bad");
        return;
    }
    const keys = Object.keys(set);
    const who = Venue.viewer();
    const mine = who ? set[who.toLowerCase()] : null;
    if (!mine) {
        const opts = {
            msg: who
                ? "This proof belongs to another account. Connect the matching wallet, or watch that live grant read-only."
                : "Connect a wallet this page already holds a proof for, or watch that live grant read-only.",
        };
        if (keys[0]) opts.watchAddr = keys[0];
        Venue.openSheet(opts);
        return;
    }
    const picked = Venue.pickProof(mine);
    if (!picked) {
        Venue.status("prove-status", "The bundled proof is not the shape the gate wants.", "bad");
        return;
    }
    Venue.proof = picked;
    if (picked.address && who.toLowerCase() === String(picked.address).toLowerCase()) {
        writePocketProof(who, picked, epoch);
    }
    Venue.paintPins();
    Venue.paintCheckButton();
    await Venue.refreshProve();
    await Venue.previewRegister().catch((e) => {
        Venue.status("prove-status", Venue.fail(e).message, "bad");
    });
};

Venue.proofFor = function (who, epoch) {
    if (!who) return null;
    const key = who.toLowerCase();
    const e = String(epoch);
    const set = (typeof DEMO_PROOFS !== "undefined" && DEMO_PROOFS) ? DEMO_PROOFS[e] : null;
    if (set && set[key]) {
        const bundled = Venue.pickProof(set[key]);
        if (bundled) return bundled;
    }
    const stored = readPocketProof(who);
    if (!stored || String(stored.epoch) !== e) return null;
    return Venue.pickProof(stored);
};

Venue.hydrateProof = async function () {
    if (Venue.page !== "prove") return;
    const who = Venue.viewer();
    if (!who) {
        Venue.paintCheckButton();
        return;
    }
    const epoch = Venue.snap.kycEpoch !== undefined && Venue.snap.kycEpoch !== null
        ? Venue.snap.kycEpoch
        : asBig(await Venue.c.registry.currentEpoch());
    const bound = Venue.proof?.address
        && String(Venue.proof.address).toLowerCase() === who.toLowerCase();
    if (bound) {
        Venue.paintCheckButton();
        return;
    }
    const picked = Venue.proofFor(who, epoch);
    if (picked) {
        Venue.proof = picked;
        Venue.paintPins();
        Venue.paintCheckButton();
        await Venue.previewRegister().catch((e) => {
            Venue.status("prove-status", Venue.fail(e).message, "bad");
        });
        return;
    }
    if (Venue.account && Venue.proof && !bound) {
        Venue.proof = null;
        const pins = $("pins");
        if (pins) {
            pins.className = "pins-slot";
            pins.innerHTML = EMPTY_SIGNALS;
        }
        const uses = $("uses");
        if (uses) uses.textContent = "";
    }
    Venue.paintCheckButton();
    if (Venue.account && !Venue.proof && Venue.snap.kyc !== 1) {
        Venue.status("prove-status",
            "No proof on this device for this wallet this period. Add a file once and it stays here.",
            "");
    }
};

Venue.pickProof = function (data) {
    const norm = (p) => {
        if (!p?.proof || !p?.pub) return null;
        if (p.proof.length !== 24 || p.pub.length !== 7) return null;
        let address = p.address;
        if (!address && p.pub[4] != null) {
            try {
                address = ethers.getAddress("0x" + asBig(p.pub[4]).toString(16).padStart(40, "0"));
            } catch { /* pub[4] is not an address */ }
        }
        return {proof: p.proof.map(String), pub: p.pub.map(String), address};
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
    if (!p || !$("pins")) return;
    const epoch = Venue.snap.kycEpoch;
    const expected = [
        null,
        1n,
        Venue.snap.root,
        epoch,
        Venue.viewer() ? BigInt(Venue.viewer()) : null,
        Venue.snap.minTier,
        Venue.snap.mask,
    ];
    const states = [];
    const value = (text, plain = false) => {
        const shown = String(text);
        return '<span class="signal-value' + (plain ? " plain" : "") +
            '" title="' + esc(shown) + '">' + esc(shown) + "</span>";
    };
    const rows = SIGS.map((s) => {
        const got = asBig(p.pub[s.i]);
        const want = expected[s.i];
        // Clocks may not have stamped the epoch yet; treat missing pins as
        // unknown rather than throwing BigInt(undefined) and wiping the gate result.
        let state;
        let verdict;
        let requirement;
        let plainRequirement = false;
        if (s.i === 0) {
            state = "info";
            verdict = "Checked by the gate";
            requirement = "Within this period's usage limit";
            plainRequirement = true;
        } else if (want == null) {
            state = "pending";
            verdict = s.i === 4 ? "Waiting for wallet" : "Waiting for policy";
            requirement = s.i === 4 ? "Connect the matching wallet" : "Loading current requirement";
            plainRequirement = true;
            states.push(state);
        } else {
            state = got === asBig(want) ? "ok" : "no";
            verdict = state === "ok" ? "Matched" : "Needs attention";
            requirement = toHexWord(want);
            states.push(state);
        }
        return '<li class="signal-check is-' + state + '">' +
            '<div class="signal-identity"><span class="signal-marker" aria-hidden="true"></span>' +
            '<div class="signal-copy"><h3>' + esc(s.label) + "</h3><p>" + esc(s.help) +
            '</p></div></div><div class="signal-values">' +
            '<div><span class="signal-value-label">Proof</span>' + value(toHexWord(got)) + "</div>" +
            '<div><span class="signal-value-label">Current requirement</span>' +
            value(requirement, plainRequirement) + "</div></div>" +
            '<span class="signal-verdict ' + state + '">' + esc(verdict) + "</span></li>";
    }).join("");
    const mismatches = states.filter((state) => state === "no").length;
    const waiting = states.filter((state) => state === "pending").length;
    let summaryClass;
    let summaryTitle;
    let summaryCopy;
    let summaryState;
    if (mismatches) {
        summaryClass = "is-no";
        summaryTitle = mismatches + (mismatches === 1
            ? " check needs attention"
            : " checks need attention");
        summaryCopy = "The highlighted proof values differ from the venue's current requirements.";
        summaryState = "Review proof";
    } else if (waiting) {
        summaryClass = "is-pending";
        summaryTitle = "Comparison needs more information";
        summaryCopy = "Connect the matching wallet and wait for the current requirements to load.";
        summaryState = "Waiting";
    } else {
        summaryClass = "is-ok";
        summaryTitle = "Proof matches current requirements";
        summaryCopy = "The reuse allowance is checked separately by the gate.";
        summaryState = "Signals aligned";
    }
    const summary =
        '<div class="signal-summary ' + summaryClass + '"><div class="signal-summary-copy">' +
        '<span class="signal-summary-label">Proof comparison</span><strong>' +
        esc(summaryTitle) + "</strong><p>" + esc(summaryCopy) + "</p></div>" +
        '<span class="signal-summary-state">' + esc(summaryState) + "</span></div>";
    $("pins").className = "signal-checklist";
    $("pins").innerHTML = summary + '<ol class="signal-list">' + rows + "</ol>";
    const nf = p.pub[0];
    const uses = $("uses");
    const who = Venue.viewer();
    if (who && nf) {
        Venue.c.registry.usesThisEpoch(toHexWord(nf)).then((u) => {
            if (!Venue.stillViewer(who)) return;
            if (uses) uses.textContent = u.toString() + " / " + Venue.snap.maxUses + " uses this epoch";
        }).catch(() => {});
    } else if (uses) {
        uses.textContent = "";
    }
};

Venue.explainGate = function (reason) {
    const r = String(reason || "");
    if (r.includes("different address")) {
        return "This proof belongs to another account. You can watch that grant, or connect the matching wallet to request access.";
    }
    if (r.includes("wrong epoch")) return "This proof is for a different KYC period.";
    if (r.includes("nullifier exhausted")) {
        return "This credential has already been used as many times as this period allows.";
    }
    if (r.includes("root not published")) return "The issuer has not published a root for this period yet.";
    if (r.includes("wrong credential root")) return "This proof is not for the root the gate holds today.";
    if (r.includes("policy mismatch")) return "The proof was built against a different policy than the gate has now.";
    if (r.includes("policy not satisfied")) return "This proof does not pass the gate's policy.";
    return r || "The gate will not accept this proof.";
};

Venue.previewRegister = async function () {
    const who = Venue.viewer();
    const btn = $("check");
    if (!who) {
        Venue.openSheet();
        Venue.status("prove-status", "Connect a wallet, or load a proof to watch.", "bad");
        return;
    }
    if (!Venue.proof) {
        Venue.status("prove-status",
            "Use a real eligibility proof first, or connect a wallet this page already holds a proof for.",
            "bad");
        return;
    }
    // A native `disabled` button never fires click, so a hung check used to
    // look like a dead control. Keep the handler alive; if a check is already
    // in flight, just make that visible.
    if (Venue._checking) {
        if (btn) {
            btn.textContent = "Checking…";
            btn.classList.add("busy");
            btn.setAttribute("aria-busy", "true");
        }
        return;
    }
    const label = "Check the gate";
    Venue._checking = true;
    if (btn) {
        btn.dataset.label = label;
        btn.disabled = false;
        btn.removeAttribute("disabled");
        btn.textContent = "Checking…";
        btn.classList.add("busy");
        btn.setAttribute("aria-busy", "true");
    }
    const started = Date.now();
    let timeoutId = 0;
    try {
        const pub = Venue.proof.pub.map((x) => asBig(x));
        const [ok, reason] = await Promise.race([
            Venue.c.gate.wouldAccept(who, pub),
            new Promise((_, rej) => {
                timeoutId = setTimeout(() => {
                    rej(new Error("The gate did not answer. Try Check the gate again."));
                }, 20000);
            }),
        ]);
        clearTimeout(timeoutId);
        if (!Venue.stillViewer(who)) return;
        const granted = Venue.snap.kyc === 1;
        const reg = $("register");
        if (reg) reg.disabled = granted || !ok || !Venue.account;
        const exhausted = String(reason || "").includes("nullifier exhausted");
        let msg;
        let kind = ok ? "ok" : "bad";
        if (granted) {
            msg = "You already hold a grant this period. Markets is next.";
            if (exhausted) {
                msg += " This credential cannot be used again until the next KYC epoch.";
            }
            kind = "ok";
        } else if (ok && Venue.account) {
            msg = "The gate will accept this. Request access to activate it for this period.";
        } else if (ok && !Venue.account) {
            msg = "Watching a live grant for " + shortAddr(who) +
                ". Connect that wallet if you want to request access.";
        } else if (exhausted) {
            msg = Venue.explainGate(reason)
                + " A new grant needs the next KYC epoch, or a different credential.";
        } else {
            msg = Venue.explainGate(reason);
        }
        Venue.status("prove-status", msg, kind);
        try { Venue.paintPins(); } catch { /* pin paint must not wipe the gate result */ }
    } finally {
        clearTimeout(timeoutId);
        const wait = 400 - (Date.now() - started);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        Venue._checking = false;
        if (btn) {
            btn.textContent = label;
            btn.classList.remove("busy");
            btn.setAttribute("aria-busy", "false");
        }
    }
};

Venue.doRegister = async function () {
    await Venue.requireAccount();
    if (!Venue.proof) throw new Error("Use a real eligibility proof first.");
    const pub = Venue.proof.pub.map((x) => asBig(x));
    const [ok, reason] = await Venue.w.gate.wouldAccept(Venue.account, pub);
    if (!ok) {
        Venue.status("prove-status", Venue.explainGate(reason), "bad");
        $("register").disabled = true;
        return;
    }
    const rec = await Venue.send(
        Venue.w.gate.register(Venue.account, Venue.proof.proof.map((x) => asBig(x)), pub, {gasLimit: 1_500_000}),
        "Request access"
    );
    if (rec) {
        Venue.status("prove-status", "Access granted. It lasts only for this KYC period.", "ok");
        await Venue.refreshProve();
    }
};

Venue.mountTrade = async function () {
    let rememberedSide = "0";
    try { rememberedSide = localStorage.getItem(TRADE_SIDE_KEY) || "0"; } catch { /* private mode */ }
    Venue.setSide(rememberedSide === "1" ? 1 : 0, {persist: false});
    Venue.showOrderStage("details");
    const toggle = $("side-toggle");
    if (toggle) {
        toggle.addEventListener("click", (e) => {
            const btn = e.target.closest("[role=radio]");
            if (!btn) return;
            Venue.setSide(btn.dataset.side);
            Venue.paintTicket();
        });
        toggle.addEventListener("keydown", (e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight"
                && e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            const next = Number($("side").value) === 1 ? 0 : 1;
            Venue.setSide(next);
            Venue.paintTicket();
            toggle.querySelector('[data-side="' + next + '"]')?.focus();
        });
    }
    for (const id of ["price", "qty"]) {
        $(id)?.addEventListener("input", (event) => {
            event.currentTarget.dataset.touched = "1";
            Venue.paintTicket();
        });
    }
    $("salt")?.addEventListener("input", Venue.paintTicket);
    $("reroll")?.addEventListener("click", () => Venue.reroll({announce: true}));
    $("salt-copy")?.addEventListener("click", () => Venue.copySalt().catch((e) => Venue.fail(e)));
    $("salt-show")?.addEventListener("click", Venue.toggleSalt);
    $("hold-pick")?.addEventListener("change", () => {
        if ($("holdId")) $("holdId").value = $("hold-pick").value;
        Venue.paintHoldStatus();
    });
    $("save-ticket")?.addEventListener("click", () => Venue.saveTicketNow().catch((e) => Venue.fail(e)));
    $("save-vault")?.addEventListener("click", () => Venue.saveVaultNow().catch((e) => Venue.fail(e)));
    $("commit")?.addEventListener("click", () => Venue.doGuidedOrderAction().catch((e) => {
        Venue.tradeTxStage("failed", "Order action", Venue.fail(e).message);
        Venue.paintTicket();
    }));
    $("order-back")?.addEventListener("click", () => {
        Venue.showOrderStage(Venue.orderStage === "submit" ? "review" : "details");
        Venue.paintTicket();
    });
    $("edit-order")?.addEventListener("click", () => {
        Venue.showOrderStage("details");
        Venue.paintTicket();
        $("price")?.focus();
    });
    $("switch-buy")?.addEventListener("click", () => {
        Venue.setSide(0);
        Venue.showOrderStage("details");
        Venue.paintTicket();
    });
    $("hold")?.addEventListener("click", () => Venue.doHold().catch((e) => Venue.fail(e)));
    $("load-ticket")?.addEventListener("change", (e) => {
        Venue.importTicket(e.target.files[0]).catch((err) => Venue.fail(err));
        e.target.value = "";
    });
    $("load-vault")?.addEventListener("change", (e) => {
        Venue.importVault(e.target.files[0]).catch((err) => Venue.fail(err));
        e.target.value = "";
    });
    $("cross")?.addEventListener("click", () => Venue.doCross().catch((e) => Venue.fail(e)));
    $("withdraw")?.addEventListener("click", Venue.openWithdrawConfirm);
    $("withdraw-confirm")?.addEventListener("click", () =>
        Venue.confirmWithdraw().catch((e) => Venue.fail(e)));
    document.querySelectorAll("[data-withdraw-close]").forEach((control) => {
        control.addEventListener("click", () => Venue.closeWithdrawConfirm());
    });
    document.addEventListener("keydown", (event) => {
        const modal = $("withdraw-modal");
        if (event.key === "Escape" && !modal?.hidden) {
            Venue.closeWithdrawConfirm();
            return;
        }
        if (event.key === "Tab" && !modal?.hidden) {
            const focusable = [...modal.querySelectorAll("button:not(:disabled)")];
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    });
    $("market-reload")?.addEventListener("click", () => Venue.refreshMarketTape().catch((e) => Venue.fail(e)));
    $("feed-refresh")?.addEventListener("click", () => Venue.refreshOracle().catch((e) => Venue.fail(e)));
    $("order-attention-go")?.addEventListener("click", () => {
        $("active-orders")?.scrollIntoView({behavior: "smooth", block: "start"});
    });
    if (!$("salt").value) Venue.reroll();
    else Venue.paintTicket();
    if (Venue.account) await Venue.hydrateVaultHandle(Venue.account);
    await Promise.all([
        Venue.refreshTrade(),
        Venue.refreshInstrument?.().catch(() => {}),
        Venue.refreshOracle?.().catch((e) => {
            const says = $("feed-says");
            if (says) says.textContent =
                "Auction trading remains available with user-supplied limits. Reference data could not be read.";
            const state = $("feed-state");
            if (state) {
                state.textContent = "Unavailable";
                state.className = "feed-state bad";
            }
            if ($("feed-age")) $("feed-age").textContent = "Last update unavailable";
            $("feed-box")?.classList.add("is-unavailable");
        }),
    ]);
    // The book does not need a connected wallet. Someone deciding whether to
    // commit is exactly the person who has not connected one yet.
    await Venue.refreshBook().catch(() => {});
};

Venue.setSide = function (side, opts) {
    const n = Number(side) === 0 ? 0 : 1;
    const input = $("side");
    if (input) input.value = String(n);
    if (Venue.page === "trade" && opts?.persist !== false) {
        try { localStorage.setItem(TRADE_SIDE_KEY, String(n)); } catch { /* private mode */ }
    }
    const toggle = $("side-toggle");
    if (toggle) {
        toggle.dataset.side = String(n);
        toggle.querySelectorAll("[role=radio]").forEach((btn) => {
            btn.setAttribute("aria-checked", btn.dataset.side === String(n) ? "true" : "false");
        });
    }
    const hold = $("hold-field");
    if (hold) {
        hold.hidden = n !== 1;
        hold.setAttribute("aria-hidden", n !== 1 ? "true" : "false");
    }
};

function holdUntil(expiry) {
    const n = Number(asBig(expiry));
    if (!n) return "Unknown";
    return new Date(n * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

Venue.shortSalt = function (hex) {
    const s = (hex || "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(s)) return "Unknown";
    return s.slice(0, 6) + "…" + s.slice(-4);
};

Venue.paintSaltChip = function () {
    const chip = $("salt-chip");
    if (!chip) return;
    chip.textContent = Venue.shortSalt($("salt")?.value);
};

Venue.toggleSalt = function () {
    const row = $("salt-row");
    const show = $("salt-show");
    if (!row || !show) return;
    const open = row.dataset.open === "1";
    row.dataset.open = open ? "0" : "1";
    show.textContent = open ? "Show" : "Hide";
    show.setAttribute("aria-pressed", open ? "false" : "true");
    if (!open) $("salt")?.focus();
};

Venue.copySalt = async function () {
    const v = ($("salt")?.value || "").trim();
    const btn = $("salt-copy");
    try {
        await navigator.clipboard.writeText(v);
    } catch {
        const row = $("salt-row");
        if (row && row.dataset.open !== "1") Venue.toggleSalt();
        $("salt")?.select();
        if (!document.execCommand("copy")) throw new Error("Could not copy the reveal key.");
    }
    if (btn) {
        btn.textContent = "Copied";
        setTimeout(() => { if ($("salt-copy")) $("salt-copy").textContent = "Copy"; }, 1200);
    }
};

Venue.lockLabel = function (h) {
    return formatQuantity(asBig(h.amount)) + " bonds locked until " + holdUntil(h.expiry);
};

Venue.pickHold = function (holds, qty) {
    const enough = holds.filter((h) => asBig(h.amount) >= qty);
    if (!enough.length) return null;
    const exact = enough.filter((h) => asBig(h.amount) === qty);
    const pool = (exact.length ? exact : enough).slice();
    pool.sort((a, b) => {
        const e = asBig(a.expiry) - asBig(b.expiry);
        if (e < 0n) return -1;
        if (e > 0n) return 1;
        return asBig(a.holdId) < asBig(b.holdId) ? -1 : 1;
    });
    return pool[0];
};

Venue.readLiveHolds = async function () {
    const acc = Venue.account;
    if (!acc || !Venue.c.holds) return [];
    const ids = new Set();
    for (const h of readList("holds", acc)) {
        if (h.holdId != null && h.holdId !== "") ids.add(String(h.holdId));
    }
    const typed = ($("holdId")?.value || "").trim();
    if (typed) ids.add(typed);
    const live = [];
    for (const holdId of ids) {
        try {
            const rec = await Venue.c.holds.getHoldForByPartition({
                partition: CLIENT.immutables.partition,
                tokenHolder: acc,
                holdId,
            });
            const amount = asBig(rec.amount_);
            const expiry = asBig(rec.expirationTimestamp_);
            if (amount === 0n) continue;
            if (!addrEq(rec.escrow_, CLIENT.addresses.MatchingEngine)) continue;
            if (!addrEq(rec.destination_, ZERO)) continue;
            if (expiry <= nowSec()) continue;
            live.push({holdId, amount: amount.toString(), expiry: expiry.toString()});
            upsert("holds", acc, {
                v: HOLD_VER, holdId, amount: amount.toString(), expiry: expiry.toString(),
                at: new Date().toISOString(),
            }, "holdId");
        } catch { /* skip a hold the node will not read */ }
    }
    return live;
};

Venue.paintHoldStatus = function () {
    const status = $("hold-status");
    const pick = $("hold-pick");
    const input = $("holdId");
    if (!status) return;
    const live = Venue._liveHolds || [];
    const id = (input?.value || "").trim();
    const chosen = live.find((h) => h.holdId === id);
    if (pick) {
        if (live.length > 1) {
            pick.hidden = false;
            if (document.activeElement !== pick) {
                pick.innerHTML = live.map((h) =>
                    '<option value="' + esc(h.holdId) + '">' +
                    esc(formatQuantity(asBig(h.amount)) + " bonds · until " + holdUntil(h.expiry)) +
                    "</option>"
                ).join("");
                if (id && live.some((h) => h.holdId === id)) pick.value = id;
            }
        } else {
            pick.hidden = true;
            pick.innerHTML = "";
        }
    }
    if (!Venue.account) {
        status.textContent = "Connect to lock inventory for this sell.";
        return;
    }
    if (chosen) {
        status.textContent = Venue.lockLabel(chosen) + ". Attached to this ticket.";
        return;
    }
    if (live.length) {
        status.textContent = "No lock matches this quantity. Lock inventory or pick a larger reservation.";
        return;
    }
    status.textContent = "Lock inventory to back this sell. This page keeps the reservation.";
};

Venue.syncHoldField = function () {
    const input = $("holdId");
    if (!input) return;
    const o = Venue.readOrder();
    if (o.side !== 1) {
        Venue.paintHoldStatus();
        return;
    }
    const live = Venue._liveHolds;
    if (!live) {
        Venue.paintHoldStatus();
        return;
    }
    const current = (input.value || "").trim();
    const still = live.find((h) => h.holdId === current);
    const qty = o.bad.qty ? null : o.qty;
    if (still && (qty === null || asBig(still.amount) >= qty)) {
        Venue.paintHoldStatus();
        return;
    }
    const picked = qty === null ? (still || live[0] || null) : Venue.pickHold(live, qty);
    input.value = picked ? picked.holdId : "";
    Venue.paintHoldStatus();
};

Venue.attachHold = async function () {
    if (!$("hold-field")) return;
    const gen = (Venue._holdGen = (Venue._holdGen || 0) + 1);
    const live = Venue.account ? await Venue.readLiveHolds() : [];
    if (gen !== Venue._holdGen) return;
    Venue._liveHolds = live;
    Venue.syncHoldField();
};

Venue.reroll = function (opts) {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    $("salt").value = "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    Venue.paintSaltChip();
    Venue.paintTicket();
    if (opts?.announce) {
        Venue.status("trade-status", "New reveal key drawn. Write the ticket before you commit.", "ok");
    }
};

Venue.readOrder = function () {
    const side = Number($("side").value);
    const priceRaw = ($("price").value || "").trim();
    const qtyRaw = ($("qty").value || "").trim();
    const salt = ($("salt").value || "").trim();
    const empty = {price: priceRaw === "", qty: qtyRaw === ""};
    const bad = {};
    let price = 0n, qty = 0n;
    try {
        price = parseHbar(priceRaw);
        if (price === 0n) throw new Error("zero");
        if (price >= ORDER_SCALE_LIMIT) throw new Error("range");
    } catch { bad.price = true; }
    try {
        qty = toUnits(BigInt(qtyRaw));
        if (qty === 0n) throw new Error("zero");
        if (qty >= ORDER_SCALE_LIMIT) throw new Error("range");
    }
    catch { bad.qty = true; }
    if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) bad.salt = true;
    const committer = Venue.viewer() || ZERO;
    const ok = !bad.price && !bad.qty && !bad.salt && !!Venue.account;
    const id = ok ? commitmentOf(committer, side, price, qty, salt) : null;
    return {side, price, qty, salt, committer, bad, empty, ok, id};
};

Venue.draftRecord = function (o) {
    if (!Venue.account || !o?.id) return null;
    return readList("tickets", Venue.account).find((t) => t.id === o.id) || null;
};

Venue.orderFunds = function (o) {
    const bond = Venue.snap.commitBond ?? asBig(CLIENT.immutables.commitBond);
    const fee = Venue.snap.cancelFee ?? asBig(CLIENT.immutables.cancelFee);
    const limit = o.bad.price || o.bad.qty ? null : buyEscrow(o.price, o.qty);
    const reveal = o.side === 0 && limit !== null ? limit : 0n;
    return {bond, fee, limit, reveal, totalCash: limit === null ? null : bond + reveal};
};

Venue.guidedOrderState = function (o) {
    const record = Venue.draftRecord(o);
    const saved = !!record;
    const submitted = !!record?.committedAt;
    const funds = Venue.orderFunds(o);
    if (Venue.busy) return {mode: "busy", label: "Transaction in progress", disabled: true, saved, submitted};
    if (!Venue.account) return {mode: "connect", label: "Connect wallet", disabled: false, saved, submitted};
    if (o.bad.price || o.bad.qty) {
        return {
            mode: "invalid", label: "Enter a valid price and quantity", disabled: true,
            blocker: "Use HBAR with no more than 8 decimal places and a whole-bond quantity.", saved, submitted,
        };
    }
    if (o.bad.salt) {
        return {
            mode: "invalid", label: "Draw a valid reveal key", disabled: true,
            blocker: "Draw a new reveal key or restore a saved ticket.", saved, submitted,
        };
    }
    if (submitted) return {mode: "new", label: "Start another order", disabled: false, saved, submitted};
    if (Venue.snap.kyc === undefined) {
        return {mode: "loading", label: "Checking account", disabled: true, saved, submitted};
    }
    if (Venue.snap.kyc !== 1) {
        return {
            mode: "eligibility", label: "Review eligibility", disabled: false,
            blocker: "This wallet needs a current eligibility grant before it can safely trade.", saved, submitted,
        };
    }
    if (o.side === 1 && Venue.snap.free !== undefined && Venue.snap.free < o.qty) {
        return {
            mode: "balance", label: "Not enough inventory", disabled: true,
            blocker: "This sell needs " + formatQuantity(o.qty) + " free LPRC. Reduce the quantity or add inventory to this wallet.",
            saved, submitted,
        };
    }
    if (Venue.snap.walletTinybar !== undefined && Venue.snap.walletTinybar < funds.totalCash) {
        return {
            mode: "balance", label: "Not enough HBAR", disabled: true,
            blocker: "This wallet needs at least " + readableHbar(funds.totalCash) +
                " HBAR plus network fees. Add HBAR or withdraw available trading credit.",
            saved, submitted,
        };
    }
    if (!saved) return {mode: "backup", label: "Back up order key", disabled: false, saved, submitted};
    return {
        mode: "commit",
        label: "Submit sealed " + (o.side === 1 ? "sell" : "buy") + " · " + readableHbar(funds.bond) + " HBAR",
        disabled: false, saved, submitted,
    };
};

Venue.showOrderStage = function (stage) {
    const allowed = ["details", "review", "submit", "track"];
    const next = allowed.includes(stage) ? stage : "details";
    Venue.orderStage = next;
    const panel = $("order-panel");
    if (panel) panel.dataset.stage = next;
    document.querySelectorAll("[data-order-stage]").forEach((section) => {
        section.hidden = section.dataset.orderStage !== next;
    });
    const labels = {
        details: "Order details",
        review: "Review and prepare",
        submit: "Submit",
        track: "Track order",
    };
    const badge = $("draft-state");
    if (badge) {
        badge.textContent = labels[next];
        badge.className = "draft-state stage-" + next;
    }
    const back = $("order-back");
    if (back) {
        back.hidden = next === "details" || next === "track";
        back.textContent = next === "submit" ? "Back to review" : "Edit details";
    }
};

Venue.paintOrderTrack = function () {
    const who = Venue.viewer();
    const tickets = who ? readList("tickets", who) : [];
    const ticket = tickets.find((item) => item.id === Venue.trackTicketId)
        || tickets.find((item) => item.committedAt && !item.cancelled);
    const status = $("track-status-label");
    const title = $("track-status-title");
    const copy = $("track-status-copy");
    const deadline = $("track-deadline");
    if (!ticket) {
        if (status) status.textContent = "No submitted order";
        if (title) title.textContent = "Start with new order details";
        if (copy) copy.textContent = "Submitted orders and their next actions appear in Your orders.";
        if (deadline) deadline.textContent = "None";
        return {mode: "new", label: "Start another order", disabled: false};
    }
    Venue.trackTicketId = ticket.id;
    const chain = {
        committer: ticket.committer,
        committedAt: ticket.committedAt || 0,
        cancelled: !!ticket.cancelled,
        revealed: !!ticket.revealed,
    };
    const phase = Venue.ticketPhase(ticket, chain);
    if (phase.phase === "cancel") {
        if (status) status.textContent = "Submitted and sealed";
        if (title) title.textContent = "Reveal opens in " + fmtRemain(phase.until - nowSec());
        if (copy) copy.textContent = "No action is required yet. Cancellation remains available until reveal opens.";
        if (deadline) deadline.textContent = "Reveal opens " + ticketDate(phase.until);
    } else if (phase.phase === "reveal") {
        if (status) status.textContent = "Reveal required";
        if (title) title.textContent = "Reveal within " + fmtRemain(phase.until - nowSec());
        if (copy) {
            copy.textContent = Number(ticket.side) === 1
                ? "Reserve the required LPRC, then reveal in a wallet transaction."
                : "Fund the full limit value, then reveal in a wallet transaction.";
        }
        if (deadline) deadline.textContent = ticketDate(phase.until);
    } else if (phase.phase === "lost") {
        if (status) status.textContent = "Reveal missed";
        if (title) title.textContent = "The reveal window has closed";
        if (copy) copy.textContent = "The deposit can now be claimed by a permissionless sweeper.";
        if (deadline) deadline.textContent = "Closed";
    } else if (phase.phase === "cancelled") {
        if (status) status.textContent = "Cancelled";
        if (title) title.textContent = "Refund moved to trading credit";
        if (copy) copy.textContent = "The cancellation fee was retained. Withdraw the remaining credit separately.";
        if (deadline) deadline.textContent = "Complete";
    } else if (phase.phase === "done") {
        if (status) status.textContent = "Revealed";
        if (title) title.textContent = "Awaiting auction outcome";
        if (copy) copy.textContent = "Matching, settlement, and credit withdrawal remain separate.";
        if (deadline) deadline.textContent = "See Your orders";
    }
    return {mode: "view-orders", label: "Open order actions", disabled: false};
};

Venue.paintGuidedOrder = function (o) {
    const state = Venue.guidedOrderState(o);
    const action = $("commit");
    const blocker = $("order-blocker");
    let stage = Venue.orderStage || "details";
    let view = {mode: "review", label: "Review order", disabled: false};

    if (stage === "details") {
        const incomplete = o.bad.price || o.bad.qty;
        view = {
            mode: "review",
            label: incomplete ? "Enter order details" : "Review order",
            disabled: incomplete,
        };
    } else if (stage === "review") {
        if (state.mode === "commit") {
            view = {mode: "continue-submit", label: "Continue to wallet", disabled: false};
        } else if (state.mode === "new") {
            Venue.trackTicketId = Venue.draftRecord(o)?.id || o.id;
            stage = "track";
            Venue.showOrderStage(stage);
            view = Venue.paintOrderTrack();
        } else {
            view = state.mode === "backup"
                ? {...state, label: "Save recovery file"}
                : state;
        }
    } else if (stage === "submit") {
        if (state.mode === "new") {
            Venue.trackTicketId = Venue.draftRecord(o)?.id || o.id;
            stage = "track";
            Venue.showOrderStage(stage);
            view = Venue.paintOrderTrack();
        } else if (state.mode === "commit" || state.mode === "busy") {
            view = state;
        } else {
            Venue.showOrderStage("review");
            stage = "review";
            view = state.mode === "backup" ? {...state, label: "Save recovery file"} : state;
        }
    } else {
        view = Venue.paintOrderTrack();
    }

    Venue.showOrderStage(stage);
    if (action) {
        action.dataset.action = view.mode;
        action.textContent = view.label;
        action.disabled = !!view.disabled;
    }
    if (blocker) {
        blocker.hidden = !view.blocker;
        blocker.textContent = view.blocker || "";
        blocker.className = "order-blocker" +
            (view.mode === "balance" ? " is-warning" : "");
    }
};

Venue.startNewOrder = function () {
    Venue.trackTicketId = null;
    Venue.showOrderStage("details");
    for (const id of ["price", "qty"]) {
        const input = $(id);
        if (input) {
            input.value = "";
            delete input.dataset.touched;
        }
    }
    if ($("holdId")) $("holdId").value = "";
    Venue.reroll();
    Venue.status("trade-status", "New order ready. No wallet transaction was sent.", "ok");
    $("price")?.focus();
};

Venue.doGuidedOrderAction = async function () {
    const mode = $("commit")?.dataset.action;
    if (mode === "review") {
        Venue.showOrderStage("review");
        Venue.paintTicket();
        return;
    }
    if (mode === "continue-submit") {
        Venue.showOrderStage("submit");
        Venue.paintTicket();
        return;
    }
    if (mode === "connect") {
        Venue.openSheet();
        return;
    }
    if (mode === "eligibility") {
        window.location.href = "prove.html";
        return;
    }
    if (mode === "backup") {
        await Venue.saveTicketNow();
        return;
    }
    if (mode === "commit") {
        await Venue.doCommit();
        return;
    }
    if (mode === "view-orders") {
        $("active-orders")?.scrollIntoView({behavior: "smooth", block: "start"});
        return;
    }
    if (mode === "new") Venue.startNewOrder();
};

Venue.paintTicket = function () {
    if (!$("saltHint") || !$("priceHint")) return;
    const o = Venue.readOrder();
    const funds = Venue.orderFunds(o);
    Venue.setSide(o.side);
    Venue.paintSaltChip();
    const priceTouched = $("price")?.dataset.touched === "1";
    const qtyTouched = $("qty")?.dataset.touched === "1";
    $("priceHint").textContent = o.empty.price
        ? "Up to 8 decimal places."
        : o.bad.price
            ? "Enter a positive HBAR amount with no more than 8 decimals."
            : o.price.toString() + " tinybar exact";
    $("priceHint").classList.toggle("bad", !!o.bad.price && !o.empty.price && priceTouched);
    $("qtyHint").textContent = o.empty.qty
        ? "Whole bonds only."
        : o.bad.qty
            ? "Enter a positive whole-bond quantity."
            : formatQuantity(o.qty) + " bond" + (o.qty === 1n ? "" : "s");
    $("qtyHint").classList.toggle("bad", !!o.bad.qty && !o.empty.qty && qtyTouched);
    $("saltHint").textContent = o.bad.salt
        ? "Not a valid reveal key. Load a ticket or draw a new one."
        : "Stored locally. The portable ticket is the recovery copy.";
    $("saltHint").classList.toggle("bad", !!o.bad.salt);
    $("sideHint").textContent = o.side === 1
        ? "Set the lowest price you will accept. LPRC must be reserved before reveal."
        : "Set the highest price you will pay. HBAR is funded only when you reveal.";
    if ($("qty-availability")) {
        $("qty-availability").textContent = o.side === 1
            ? "Available: " + (Venue.snap.free === undefined
                ? "Unavailable"
                : formatQuantity(Venue.snap.free) + " LPRC")
            : "Wallet: " + (Venue.snap.walletTinybar === undefined
                ? "Unavailable"
                : readableHbar(Venue.snap.walletTinybar) + " HBAR");
    }
    const sellPrerequisite = $("sell-prerequisite");
    if (sellPrerequisite) {
        const unknown = Venue.snap.free === undefined;
        const insufficient = !o.bad.qty && !unknown && Venue.snap.free < o.qty;
        const emptyInventory = !unknown && Venue.snap.free === 0n;
        sellPrerequisite.hidden = o.side !== 1 || (!unknown && !emptyInventory && !insufficient);
        sellPrerequisite.classList.toggle("is-warning", insufficient && qtyTouched);
        if ($("sell-prerequisite-title")) {
            $("sell-prerequisite-title").textContent = unknown
                ? "Selling requires available LPRC"
                : emptyInventory
                    ? "No LPRC is available to sell"
                    : "Quantity exceeds available LPRC";
        }
        if ($("sell-prerequisite-copy")) {
            $("sell-prerequisite-copy").textContent = unknown
                ? "Connect a wallet to check inventory, or review Portfolio."
                : "Switch to Buy or check Portfolio for LPRC held by this wallet.";
        }
    }
    if ($("details-estimate-label")) {
        $("details-estimate-label").textContent = o.side === 1
            ? "Proceeds at your limit"
            : "Maximum order value";
    }
    if ($("details-estimate")) {
        $("details-estimate").textContent = funds.limit === null
            ? "Enter price and quantity"
            : readableHbar(funds.limit) + " HBAR";
    }
    if ($("details-estimate-note")) {
        $("details-estimate-note").textContent = funds.limit === null
            ? "Deposit and future obligations appear during review."
            : o.side === 1
                ? "Only if fully executed at your limit. The auction may not fill."
                : "Maximum funded at reveal. Actual execution may be lower or may not occur.";
    }
    if ($("summary-limit-label")) {
        $("summary-limit-label").textContent = o.side === 1
            ? "Proceeds if fully filled at limit"
            : "Maximum spend if fully filled";
    }
    if ($("review-order")) {
        $("review-order").textContent = o.bad.qty
            ? (o.side === 1 ? "Sell order" : "Buy order")
            : (o.side === 1 ? "Sell " : "Buy ") + formatQuantity(o.qty) + " LPRC";
    }
    if ($("summary-limit")) {
        $("summary-limit").textContent = funds.limit === null
            ? "Enter order details"
            : readableHbar(funds.limit) + " HBAR";
    }
    if ($("summary-deposit")) $("summary-deposit").textContent = readableHbar(funds.bond) + " HBAR";
    if ($("summary-reveal-label")) {
        $("summary-reveal-label").textContent = "Bonds to reserve";
    }
    if ($("summary-reveal")) {
        $("summary-reveal").textContent = funds.limit === null
            ? "Enter order details"
            : o.side === 1
                ? formatQuantity(o.qty) + " LPRC"
                : "None";
    }
    if ($("summary-total-label")) {
        $("summary-total-label").textContent = "Cash required before fees";
    }
    if ($("summary-total")) {
        $("summary-total").textContent = funds.limit === null
            ? "Enter order details"
            : readableHbar(funds.totalCash) + " HBAR";
    }
    if ($("escrowHint")) {
        const refund = funds.bond > funds.fee ? funds.bond - funds.fee : 0n;
        $("escrowHint").textContent =
            "Deposit " + readableHbar(funds.bond) + " HBAR (" + funds.bond +
            " tinybar) returns as trading credit when the order fills or closes. Cancelling before reveal returns " +
            readableHbar(refund) + " HBAR after the " + readableHbar(funds.fee) +
            " HBAR fee. Missing reveal can forfeit the full deposit. Network fees are separate.";
    }
    if ($("future-obligation-copy")) {
        $("future-obligation-copy").textContent =
            "Reveal opens " + CLIENT.immutables.revealDelay + " seconds after submission and stays open for " +
            CLIENT.immutables.revealWindow + " seconds. " +
            (o.side === 1
                ? "Reserve enough LPRC before revealing. "
                : "Fund the full limit value when revealing. ") +
            "Missing the deadline can forfeit the deposit. Matching, settlement, and withdrawal remain separate.";
    }
    if ($("submit-order")) {
        $("submit-order").textContent = funds.limit === null
            ? "Complete the order first"
            : (o.side === 1 ? "Sell " : "Buy ") + formatQuantity(o.qty) +
                " LPRC at " + formatHbar(o.price) + " HBAR per bond";
    }
    if ($("submit-deposit")) {
        $("submit-deposit").textContent =
            readableHbar(funds.bond) + " HBAR deposit plus a separate network fee";
    }
    if (o.ok) {
        const words = preimageWords(o.committer, o.side, o.price, o.qty, o.salt);
        $("words").className = "words";
        $("words").innerHTML = words.map((w, i) =>
            '<div class="w" data-from="' + w.from + '"><span class="wi">' + i + "</span>" +
            '<span class="wn">' + w.name + " <i>" + w.type + "</i></span>" +
            '<span class="wb">' + bytesRow(w) + "</span></div>"
        ).join("");
        $("idOut").textContent = o.id;
    }
    if (!o.ok) {
        // Back to waiting, rather than leaving the last good words standing
        // beside a ticket that no longer produces them.
        $("words").className = "words-slot";
        $("words").innerHTML =
            '<div class="empty">Fill in side, price and quantity. The six slots that go into' +
            " the sealed ticket, and the id they produce, appear here as you type.</div>";
        $("idOut").textContent = Venue.viewer() ? "waiting on a complete ticket" : "connect to bind the committer";
    }
    $("save-ticket").disabled = !o.ok;
    $("hold").disabled = !Venue.account || o.bad.qty || o.side !== 1 || Venue.busy
        || (Venue.snap.free !== undefined && Venue.snap.free < o.qty);
    Venue.syncHoldField();
    Venue.paintGuidedOrder(o);
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
    const before = readList("tickets", Venue.account);
    upsert("tickets", Venue.account, t, "id");
    Venue.status("trade-status", "Saving a portable recovery file. No wallet approval is needed.", "");
    try {
        await Venue.writeVault(Venue.account);
    } catch (e) {
        writeList("tickets", Venue.account, before);
        throw e;
    }
    Venue.status("trade-status", "Recovery file saved. No wallet transaction was sent.", "ok");
    Venue.paintTicket();
    Venue.paintTickets();
};

Venue.applyTicketToForm = function (t) {
    $("side").value = String(t.side);
    Venue.setSide(t.side);
    $("price").value = formatHbar(asBig(t.price));
    $("qty").value = String(t.qty);
    $("price").dataset.touched = "1";
    $("qty").dataset.touched = "1";
    $("salt").value = t.salt;
    if (t.holdId && $("holdId")) $("holdId").value = String(t.holdId);
    const row = $("salt-row");
    const show = $("salt-show");
    if (row) {
        row.dataset.open = "0";
        if (show) {
            show.textContent = "Show";
            show.setAttribute("aria-pressed", "false");
        }
    }
};

Venue.ingestTickets = function (list) {
    if (!Venue.account) return 0;
    if (!Array.isArray(list)) throw new Error("The recovery file does not contain an order list.");
    if (list.length > 500) throw new Error("The recovery file contains too many orders.");
    const records = list.map((ticket) => ticketRecord(ticket, Venue.account));
    for (const record of records) upsert("tickets", Venue.account, record, "id");
    return records.length;
};

Venue.parseTicketFile = async function (file) {
    if (!file) return null;
    if (Number(file.size || 0) > 2 * 1024 * 1024) {
        throw new Error("The recovery file is larger than 2 MB.");
    }
    let obj;
    try {
        obj = JSON.parse(await file.text());
    } catch {
        throw new Error("The recovery file is not valid JSON.");
    }
    if (obj && obj.network != null && String(obj.network) !== String(CLIENT.network.chainId)) {
        throw new Error("That file is for another network.");
    }
    if (obj?.engine && !addrEq(obj.engine, CLIENT.addresses.MatchingEngine)) {
        throw new Error("That file belongs to another market contract.");
    }
    return obj;
};

Venue.importTicket = async function (file) {
    const obj = await Venue.parseTicketFile(file);
    if (!obj) return;
    if (isVaultBlob(obj)) {
        await Venue.importVaultBlob(obj);
        return;
    }
    if (!obj.id || !obj.salt) throw new Error("Not a ticket or a vault.");
    const record = ticketRecord(obj, Venue.account);
    Venue.applyTicketToForm(record);
    if (Venue.account) upsert("tickets", Venue.account, record, "id");
    Venue.trackTicketId = record.committedAt ? record.id : null;
    Venue.showOrderStage(record.committedAt ? "track" : "review");
    Venue.paintTicket();
    Venue.paintTickets();
    Venue.attachHold().catch((e) => Venue.fail(e));
};

Venue.importVault = async function (file) {
    const obj = await Venue.parseTicketFile(file);
    if (!obj) return;
    if (isVaultBlob(obj)) {
        await Venue.importVaultBlob(obj);
        return;
    }
    if (!obj.id || !obj.salt) throw new Error("Not a ticket or a vault.");
    await Venue.requireAccount();
    Venue.ingestTickets([obj]);
    Venue.status("trade-status", "One sealed order restored from the file.", "ok");
    await Venue.paintTickets();
};

Venue.importVaultBlob = async function (obj) {
    await Venue.requireAccount();
    if (obj.account && !addrEq(obj.account, Venue.account)) {
        throw new Error("That vault belongs to another account.");
    }
    const list = ticketsFromBlob(obj) || [];
    const n = Venue.ingestTickets(list);
    Venue._ticketSig = "";
    Venue.status("trade-status", n
        ? n + " sealed order" + (n === 1 ? "" : "s") + " restored from the vault."
        : "Vault had no tickets.", "ok");
    await Venue.paintTickets();
};

Venue.hydrateVaultHandle = async function (account) {
    if (!account || !canPickVaultFile()) return;
    const key = account.toLowerCase();
    if (Venue._vaultHandles[key]) return;
    try {
        const handle = await getVaultHandle(account);
        if (handle) Venue._vaultHandles[key] = handle;
    } catch { /* private mode or IDB blocked */ }
};

Venue.writeVault = async function (account, opts) {
    const who = account || Venue.account;
    if (!who) throw new Error("Connect a wallet first.");
    const quiet = !!(opts && opts.quiet);
    const obj = vaultFile(who);
    const name = vaultName(who);
    const key = who.toLowerCase();
    let handle = Venue._vaultHandles[key];
    if (handle) {
        try {
            if (await vaultHandleWritable(handle)) {
                await writeVaultToHandle(handle, obj);
                return {how: "file", name};
            }
        } catch {
            delete Venue._vaultHandles[key];
            await clearVaultHandle(who).catch(() => {});
            handle = null;
        }
    }
    if (quiet) return {how: "skipped", name};
    if (canPickVaultFile()) {
        try {
            handle = await window.showSaveFilePicker({
                suggestedName: name,
                types: [{
                    description: "Sealed orders vault",
                    accept: {"application/json": [".json"]},
                }],
            });
            Venue._vaultHandles[key] = handle;
            await setVaultHandle(who, handle).catch(() => {});
            await writeVaultToHandle(handle, obj);
            return {how: "file", name};
        } catch (e) {
            if (e && e.name === "AbortError") {
                downloadJson(name, obj);
                return {how: "download", name};
            }
        }
    }
    downloadJson(name, obj);
    return {how: "download", name};
};

Venue.saveVaultNow = async function () {
    await Venue.requireAccount();
    await Venue.writeVault(Venue.account);
    Venue.status("trade-status", "Portable order backup saved. Keep the file private and available on another device.", "ok");
};

Venue.doHold = async function () {
    await Venue.requireAccount();
    const o = Venue.readOrder();
    if (o.side !== 1) throw new Error("Inventory locks are for sells.");
    if (o.bad.qty) throw new Error("Quantity is a whole number of bonds.");
    if (Venue.snap.free !== undefined && Venue.snap.free < o.qty) {
        throw new Error("Not enough free LPRC for this reservation.");
    }
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
    Venue.tradeTxStage("approval", "Reserve sell inventory");
    const rec = await Venue.send(
        Venue.w.holds.createHoldByPartition(CLIENT.immutables.partition, hold, {gasLimit: 1_000_000}),
        "Reserve sell inventory"
    );
    if (!rec) return;
    const holdId = asBig(predicted).toString();
    $("holdId").value = holdId;
    upsert("holds", Venue.account, {
        v: HOLD_VER, holdId, amount: o.qty.toString(), expiry: needed.toString(),
        tx: rec.hash, at: new Date().toISOString(),
    }, "holdId");
    const ticket = Venue.draftRecord(o);
    if (ticket) {
        upsert("tickets", Venue.account, {...ticket, holdId}, "id");
        await Venue.writeVault(Venue.account);
    }
    Venue.status("trade-status",
        formatQuantity(o.qty) + " LPRC reserved for this sell" +
        (ticket ? " and added to its recovery file." : ". Save the order next."),
        "ok");
    await Venue.refreshTrade();
};

Venue.doCommit = async function () {
    await Venue.requireAccount();
    const o = Venue.readOrder();
    if (!o.ok) throw new Error("Fix the order fields first.");
    const state = Venue.guidedOrderState(o);
    if (state.mode !== "commit") {
        throw new Error(state.blocker || "Back up this order before submitting it.");
    }
    const t = Venue.draftTicket(o);
    const saved = Venue.draftRecord(o);
    upsert("tickets", Venue.account, {...saved, ...t}, "id");
    await Venue.writeVault(Venue.account, {quiet: true});
    const bond = asBig(await Venue.c.engine.commitBond());
    const value = toWeibar(bond);
    Venue.tradeTxStage("approval", "Submit sealed order");
    const rec = await Venue.send(
        Venue.w.engine.commit(o.id, {value, gasLimit: 400_000}),
        "Submit sealed order"
    );
    if (!rec) return;
    const cmt = await Venue.c.engine.commitments(o.id);
    upsert("tickets", Venue.account, {
        ...t,
        committedAt: cmt.committedAt.toString(),
        commitTx: rec.hash,
        holdId: t.holdId || $("holdId")?.value || null,
    }, "id");
    await Venue.writeVault(Venue.account, {quiet: true});
    Venue.trackTicketId = o.id;
    Venue.showOrderStage("track");
    Venue.status("trade-status",
        "Order submitted. Reveal is not open yet. You may cancel for " +
        CLIENT.immutables.revealDelay + " seconds.",
        "ok");
    await Venue.refreshTrade();
    await Venue.noteReceipt(
        "commit", rec, 17, G.EXACT, T.IMM, "engine", "Committed"
    );
};

Venue.ticketPhase = function (t, chain) {
    const D = asBig(CLIENT.immutables.revealDelay);
    const W = asBig(CLIENT.immutables.revealWindow);
    if (chain?.cancelled || t?.cancelled) return {phase: "cancelled", label: "cancelled", until: 0n};
    if (chain?.revealed && chain.committer !== ZERO) {
        return {phase: "done", label: "revealed", until: 0n};
    }
    if (!chain || chain.committer === ZERO || asBig(chain.committedAt || 0) === 0n) {
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

function ticketChainKind(chain, t) {
    if (chain?.cancelled || t?.cancelled) return "cancelled";
    if (chain?.revealed && chain.committer && chain.committer !== ZERO) return "revealed";
    if (!chain || chain.committer === ZERO || asBig(chain.committedAt || 0) === 0n) return "local";
    return "committed";
}

function ticketTone(phase) {
    if (phase === "cancel") return "sealed";
    if (phase === "reveal") return "open";
    if (phase === "lost") return "dead";
    if (phase === "cancelled") return "stale";
    if (phase === "done") return "done";
    return "";
}

function ticketClockLive(phase) {
    return phase === "cancel" || phase === "reveal";
}

function ticketBarHtml(D, W, t0, phase) {
    const life = D + W;
    const elapsed = t0 ? Math.max(0, Date.now() / 1000 - t0) : 0;
    const pct = phase === "lost" ? 100 : (life ? Math.min(100, (elapsed / life) * 100) : 0);
    const live = ticketClockLive(phase);
    const needle = t0 && live ? '<i class="needle" aria-hidden="true"></i>' : "";
    const stale = phase === "cancelled" ? " stale" : "";
    return '<div class="tlbar' + stale + '"><div class="tltrack" style="--d:' + D +
        ";--w:" + W +
        ";--life:" + life + "s" +
        ";--elapsed:" + elapsed.toFixed(3) + "s" +
        ";--pct:" + pct + '%">' +
        '<span class="seg cancelw">cancel ' + D + "s</span>" +
        '<span class="seg revealw">reveal ' + W + "s</span>" +
        needle +
        '</div><span class="seg gone">forfeit</span></div>';
}

Venue.cardPhase = function (card) {
    const kind = card.dataset.chain;
    return Venue.ticketPhase({}, {
        cancelled: kind === "cancelled",
        revealed: kind === "revealed",
        committer: kind === "local" ? ZERO : "0x0000000000000000000000000000000000000001",
        committedAt: card.dataset.t0 || "0",
    });
};

Venue.syncTicketActions = function (card, ph) {
    const status = card.querySelector(".order-status");
    const title = card.querySelector(".order-next-copy strong");
    const copy = card.querySelector(".order-next-copy span");
    const deadline = card.querySelector("[data-order-deadline]");
    const row = card.querySelector(".order-next-actions");
    const progress = card.querySelector(".order-progress");
    if (!status || !title || !copy || !row) return;
    const id = card.dataset.id;
    if (ph.phase === "cancel") {
        status.className = "order-status waiting";
        status.textContent = "Submitted";
        title.textContent = "Reveal opens in " + fmtRemain(ph.until - nowSec());
        copy.textContent = "Until then, cancellation costs " +
            readableHbar(Venue.snap.cancelFee ?? asBig(CLIENT.immutables.cancelFee)) + " HBAR.";
        if (deadline) deadline.textContent = "Reveal opens " + ticketDate(ph.until);
        row.innerHTML = '<button type="button" class="danger" data-act="cancel" data-id="' +
            esc(id) + '">Cancel order</button>';
        card.className = "order-card waiting";
    } else if (ph.phase === "reveal") {
        const needsHold = card.dataset.side === "1" && card.dataset.holdValid !== "true";
        const needsEligibility = Venue.snap.kyc !== 1;
        status.className = "order-status urgent";
        status.textContent = "Reveal required";
        title.textContent = needsEligibility
            ? "Renew eligibility before revealing"
            : needsHold
                ? "Reserve inventory before revealing"
                : "Reveal within " + fmtRemain(ph.until - nowSec());
        copy.textContent = needsEligibility
            ? "Settlement requires a current grant. The reveal deadline continues while you renew it."
            : needsHold
            ? "This sell needs a separate inventory-reservation transaction, followed by reveal."
            : card.dataset.side === "0"
                ? "The reveal transaction funds the full limit value. A fill is not guaranteed."
                : "The reveal transaction places this reserved sell into the call auction.";
        if (deadline) deadline.textContent = "Reveal by " + ticketDate(ph.until);
        row.innerHTML = needsEligibility
            ? '<button type="button" class="primary" data-act="eligibility" data-id="' +
                esc(id) + '">Review eligibility</button>'
            : needsHold
            ? '<button type="button" class="primary" data-act="reserve" data-id="' +
                esc(id) + '">Reserve inventory</button>'
            : '<button type="button" class="primary" data-act="reveal" data-id="' +
                esc(id) + '">Reveal order</button>';
        card.className = "order-card urgent";
    } else if (ph.phase === "lost") {
        status.className = "order-status urgent";
        status.textContent = "Reveal missed";
        title.textContent = "The reveal window has closed";
        copy.textContent = "Reveal and cancellation are no longer available. The deposit can now be claimed by a sweeper.";
        if (deadline) deadline.textContent = "Closed " + ticketDate(asBig(card.dataset.t0) +
            asBig(CLIENT.immutables.revealDelay) + asBig(CLIENT.immutables.revealWindow));
        row.innerHTML = "";
        card.className = "order-card urgent closed";
    } else {
        row.innerHTML = "";
    }
    if (progress && card.dataset.t0) {
        const total = asBig(CLIENT.immutables.revealDelay) + asBig(CLIENT.immutables.revealWindow);
        const elapsed = nowSec() - asBig(card.dataset.t0);
        const bounded = elapsed < 0n ? 0n : elapsed > total ? total : elapsed;
        const pct = total === 0n ? 100 : Number(bounded * 10000n / total) / 100;
        progress.style.setProperty("--progress", pct + "%");
    }
};

Venue.paintTicketClocks = function () {
    const box = $("tickets");
    const heading = $("sealed-heading");
    if (!box) return;
    let live = false;
    let urgent = 0;
    let release = 0;
    let missed = 0;
    for (const card of box.querySelectorAll(":scope > .order-card")) {
        if (card.dataset.needs === "release") release++;
        if (card.dataset.chain !== "committed") continue;
        const ph = Venue.cardPhase(card);
        if (ticketClockLive(ph.phase)) live = true;
        if (ph.phase === "reveal") urgent++;
        if (ph.phase === "lost") missed++;
        Venue.syncTicketActions(card, ph);
    }
    heading?.classList.toggle("live", live);
    Venue.paintOrderAttention({urgent, release, missed});
};

Venue.bindTicketList = function () {
    const box = $("tickets");
    if (!box || box.dataset.bound) return;
    box.dataset.bound = "1";
    box.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-act]");
        if (!btn || !box.contains(btn)) return;
        const id = btn.getAttribute("data-id");
        const act = btn.getAttribute("data-act");
        if (act === "cancel") Venue.doCancel(id).catch((err) => Venue.fail(err));
        if (act === "reveal") Venue.doReveal(id).catch((err) => Venue.fail(err));
        if (act === "reserve") Venue.reserveForTicket(id).catch((err) => Venue.fail(err));
        if (act === "load") Venue.continueTicket(id);
        if (act === "discard") Venue.discardDraft(id);
        if (act === "expire") Venue.doExpire(id).catch((err) => Venue.fail(err));
        if (act === "process") Venue.doCross().catch((err) => Venue.fail(err));
        if (act === "eligibility") window.location.href = "prove.html";
    });
};

function ticketDate(value) {
    const n = Number(asBig(value || 0));
    if (!n) return "Unavailable";
    return new Date(n * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function ticketReceipt(label, hash) {
    if (!hash) return "";
    return '<div><span>' + esc(label) + '</span><a href="' + esc(explorerTx(hash)) +
        '" target="_blank" rel="noopener">' + esc(shortId(hash)) + "</a></div>";
}

Venue.continueTicket = function (id) {
    const t = readList("tickets", Venue.viewer()).find((item) => item.id === id);
    if (!t) return;
    Venue.applyTicketToForm(t);
    Venue.trackTicketId = t.committedAt ? t.id : null;
    Venue.showOrderStage(t.committedAt ? "track" : "review");
    Venue.paintTicket();
    document.querySelector(".order-panel")?.scrollIntoView({behavior: "smooth", block: "start"});
};

Venue.discardDraft = function (id) {
    if (!Venue.account) return;
    const tickets = readList("tickets", Venue.account);
    const target = tickets.find((t) => t.id === id);
    if (!target || target.committedAt) return;
    writeList("tickets", Venue.account, tickets.filter((t) => t.id !== id));
    Venue._ticketSig = "";
    Venue.status("trade-status", "Local draft removed. No on-chain order was changed.", "ok");
    Venue.paintTicket();
    Venue.paintTickets();
};

Venue.reserveForTicket = async function (id) {
    if (Venue.snap.kyc !== 1) {
        throw new Error("Renew eligibility before reserving inventory for this order.");
    }
    const t = readList("tickets", Venue.account).find((item) => item.id === id);
    if (!t) throw new Error("Restore this order's recovery file before reserving inventory.");
    Venue.applyTicketToForm(t);
    Venue.trackTicketId = t.id;
    Venue.showOrderStage("track");
    Venue.paintTicket();
    await Venue.attachHold();
    const attached = ($("holdId")?.value || "").trim();
    if (attached) {
        upsert("tickets", Venue.account, {...t, holdId: attached}, "id");
        await Venue.writeVault(Venue.account);
        Venue.status("trade-status", "An existing reservation was attached and the recovery file was updated.", "ok");
        Venue._ticketSig = "";
        await Venue.paintTickets();
        return;
    }
    await Venue.doHold();
};

Venue.paintOrderAttention = function ({urgent = 0, release = 0, missed = 0} = {}) {
    const box = $("order-attention");
    if (!box) return;
    const title = $("order-attention-title");
    const copy = $("order-attention-copy");
    if (urgent) {
        box.hidden = false;
        title.textContent = urgent + " order" + (urgent === 1 ? "" : "s") + " must be revealed now";
        copy.textContent = "Reveal before the deadline to protect the deposit and enter the auction.";
        return;
    }
    if (release) {
        box.hidden = false;
        title.textContent = release + " rested order" + (release === 1 ? " is" : "s are") + " ready to close";
        copy.textContent = "Release the remaining reserve and move the deposit to withdrawable credit.";
        return;
    }
    if (missed) {
        box.hidden = false;
        title.textContent = missed + " reveal deadline" + (missed === 1 ? " was" : "s were") + " missed";
        copy.textContent = "The affected deposit is now exposed to permissionless forfeiture.";
        return;
    }
    box.hidden = true;
};

Venue.paintTickets = async function () {
    const box = $("tickets");
    if (!box) return;
    Venue.bindTicketList();
    const heading = $("sealed-heading");
    const who = Venue.viewer();
    if (!who) {
        Venue._ticketSig = "nowallet";
        box.classList.remove("boxed");
        heading?.classList.remove("live");
        box.innerHTML = '<div class="empty">Connect a wallet to restore orders saved by this browser.</div>';
        Venue.paintOrderAttention();
        return;
    }
    const tickets = readList("tickets", who);
    if (!tickets.length) {
        Venue._ticketSig = "empty:" + who.toLowerCase();
        box.classList.remove("boxed");
        heading?.classList.remove("live");
        box.innerHTML = '<div class="empty">No orders are saved in this browser. Place an order or restore a portable backup.</div>';
        Venue.paintOrderAttention();
        return;
    }
    const chains = await Promise.all(tickets.map((t) =>
        Venue.c.engine.commitments(t.id).catch(() => null)
    ));
    if (!Venue.stillViewer(who)) return;
    const kinds = chains.map((c, i) => ticketChainKind(c, tickets[i]));
    const round = Venue.snap.round ?? asBig(await Venue.c.engine.currentRound());
    const states = await Promise.all(tickets.map(async (t, i) => {
        const chain = chains[i];
        if (!chain?.revealed || !chain.committer || addrEq(chain.committer, ZERO)) return null;
        try {
            const [order, live] = await Promise.all([
                Venue.c.engine.orders(t.id),
                Venue.c.engine.isLive(t.id),
            ]);
            return {order, live};
        } catch {
            return null;
        }
    }));
    if (!Venue.stillViewer(who)) return;
    const validHolds = new Map((Venue._liveHolds || []).map((h) => [String(h.holdId), h]));
    const sig = who.toLowerCase() + "|" + round + "|" + tickets.map((t, i) => {
        const o = states[i]?.order;
        return t.id + ":" + kinds[i] + ":" + (o ? o.filled + ":" + o.lastRound + ":" + o.retired : "") +
            ":" + (validHolds.get(String(t.holdId || ""))?.amount || "");
    }).join(",");
    if (sig === Venue._ticketSig && box.querySelector(":scope > .order-card")) {
        Venue.paintTicketClocks();
        return;
    }
    Venue._ticketSig = sig;
    const scrollTop = box.scrollTop;
    const cards = [];
    for (let i = 0; i < tickets.length; i++) {
        const t = tickets[i];
        const chain = chains[i];
        const kind = kinds[i];
        const ph = Venue.ticketPhase(t, chain);
        const t0 = chain && asBig(chain.committedAt || 0) > 0n ? Number(asBig(chain.committedAt)) : 0;
        const side = Number(t.side);
        const quantity = asBig(t.qty);
        const price = asBig(t.price);
        const limit = buyEscrow(price, quantity);
        const state = states[i];
        const order = state?.order;
        const filled = order ? asBig(order.filled) : 0n;
        const attachedHold = validHolds.get(String(t.holdId || ""));
        const holdValid = side === 0 || !!attachedHold && asBig(attachedHold.amount) >= quantity;
        let tone = "closed";
        let badge = "Local draft";
        let badgeTone = "";
        let nextTitle = "Ready to submit";
        let nextCopy = "Continue this saved draft when you are ready.";
        let actions = '<button type="button" class="primary" data-act="load" data-id="' +
            esc(t.id) + '">Continue</button><button type="button" data-act="discard" data-id="' +
            esc(t.id) + '">Remove draft</button>';
        let needs = "";
        let deadline = "Not submitted";
        if (ph.phase === "cancel" || ph.phase === "reveal" || ph.phase === "lost") {
            tone = ph.phase === "cancel" ? "waiting" : "urgent";
            badge = ph.label;
            badgeTone = ph.phase === "cancel" ? "waiting" : "urgent";
            nextTitle = ph.label;
            nextCopy = "";
            actions = "";
            deadline = ph.until ? ticketDate(ph.until) : "Closed";
        } else if (kind === "cancelled") {
            badge = "Cancelled";
            nextTitle = "Refund ready to withdraw";
            nextCopy = "The cancellation fee was retained. The remainder of the deposit is trading credit.";
            actions = "";
            deadline = "Cancelled";
        } else if (kind === "revealed" && order) {
            const retired = !!order.retired;
            const pastLast = !retired && round > asBig(order.lastRound);
            if (retired) {
                badge = filled >= quantity ? "Filled" : filled > 0n ? "Partially filled" : "Closed unfilled";
                badgeTone = filled > 0n ? "live" : "";
                nextTitle = "Order complete";
                nextCopy = "Check inventory and trading credit for the settled outcome and released remainder.";
                actions = "";
                deadline = "Closed";
            } else if (pastLast) {
                tone = "urgent";
                badge = "Release available";
                badgeTone = "urgent";
                nextTitle = "Close this rested order";
                nextCopy = "Its final auction round has passed. Anyone may retire it and release the remaining reserve.";
                actions = '<button type="button" class="primary" data-act="expire" data-id="' +
                    esc(t.id) + '">Release order</button>';
                needs = "release";
                deadline = ticketDate(await Venue.c.engine.roundEnd(asBig(order.lastRound)));
            } else {
                tone = "live";
                badge = state.live ? "In auction" : "Revealed";
                badgeTone = "live";
                nextTitle = "Awaiting auction processing";
                nextCopy = "This order can trade through round " + order.lastRound +
                    ". Matching and full execution are not guaranteed.";
                actions = "";
                deadline = "Final round " + order.lastRound;
            }
        } else if (kind !== "local") {
            badge = "Status unavailable";
            badgeTone = "urgent";
            nextTitle = "Chain status could not be read";
            nextCopy = "Keep the recovery file and refresh before taking another action.";
            actions = '<button type="button" data-act="load" data-id="' + esc(t.id) + '">Open saved ticket</button>';
        }
        const progress = kind === "committed" && t0
            ? '<div class="order-progress" style="--progress:0%"><i></i></div>'
            : "";
        const details =
            '<details class="order-details"><summary>Details, receipts, and recovery</summary>' +
            '<div class="order-detail-grid">' +
            '<div><span>Commitment</span><strong>' + esc(t.id) + "</strong></div>" +
            '<div><span>Reveal key</span><strong>Available in this browser and portable backup</strong></div>' +
            '<div><span>Limit value</span><strong>' + esc(readableHbar(limit)) + " HBAR</strong></div>" +
            '<div><span>Inventory reservation</span><strong>' +
                esc(t.holdId ? "Hold " + t.holdId : side === 1 ? "Not attached" : "Not required") +
                "</strong></div>" +
            (t0 ? '<div><span>Submitted</span><strong>' + esc(ticketDate(t0)) + "</strong></div>" : "") +
            ticketReceipt("Commit receipt", t.commitTx) +
            ticketReceipt("Reveal receipt", t.revealTx) +
            ticketReceipt("Cancel receipt", t.cancelTx) +
            ticketReceipt("Settlement receipt", t.crossTx) +
            "</div></details>";
        cards.push(
            '<article class="order-card ' + tone + '" data-id="' + esc(t.id) +
            '" data-chain="' + kind + '" data-t0="' + t0 + '" data-side="' + side +
            '" data-hold-valid="' + holdValid + '" data-needs="' + needs + '">' +
            '<div class="order-card-head"><div class="order-card-title">' +
            '<span class="order-side' + (side === 1 ? " sell" : "") + '">' +
            (side === 1 ? "SELL" : "BUY") + "</span><strong>" + esc(shortId(t.id)) +
            '</strong></div><span class="order-status ' + badgeTone + '">' + esc(badge) + "</span></div>" +
            '<div class="order-facts">' +
            '<div><span>Limit price</span><strong class="num">' + esc(readableHbar(price)) +
                " HBAR<small>" + esc(String(price)) + " tinybar exact</small></strong></div>" +
            '<div><span>Quantity</span><strong class="num">' + esc(formatQuantity(quantity)) + " LPRC</strong></div>" +
            '<div><span>Filled</span><strong class="num">' + esc(formatQuantity(filled)) + " LPRC</strong></div>" +
            '<div><span>Deadline</span><strong data-order-deadline>' + esc(deadline) + "</strong></div>" +
            "</div>" + progress +
            '<div class="order-next"><div class="order-next-copy"><strong>' + esc(nextTitle) +
            "</strong><span>" + esc(nextCopy) + '</span></div><div class="order-next-actions">' +
            actions + "</div></div>" + details + "</article>"
        );
    }
    box.classList.add("boxed");
    box.innerHTML = cards.join("");
    box.scrollTop = scrollTop;
    Venue.paintTicketClocks();
};


Venue.doCancel = async function (id) {
    await Venue.requireAccount();
    const until = asBig(await Venue.c.engine.cancellableUntil(id));
    if (until === 0n) {
        throw new Error("cancellableUntil is 0. The ticket is terminal or unknown.");
    }
    if (nowSec() >= until) throw new Error("Cancel window has shut. Reveal is the remaining move.");
    Venue.tradeTxStage("approval", "Cancel order");
    const rec = await Venue.send(Venue.w.engine.cancel(id, {gasLimit: 400_000}), "Cancel order");
    if (rec) {
        const t = readList("tickets", Venue.account).find((x) => x.id === id);
        if (t) upsert("tickets", Venue.account, {...t, cancelled: true, cancelTx: rec.hash}, "id");
        Venue.status("trade-status",
            "Order cancelled. The deposit less the cancellation fee is ready to withdraw.",
            "ok");
        await Venue.refreshTrade();
        await Venue.noteReceipt(
            "cancel", rec, 15, G.PRED, T.IMM, "engine", "Cancelled"
        );
    }
};

Venue.doReveal = async function (id) {
    await Venue.requireAccount();
    if (Venue.snap.kyc !== 1) {
        throw new Error("Renew eligibility before revealing. Settlement requires a current grant.");
    }
    const t = readList("tickets", Venue.account).find((x) => x.id === id);
    if (!t) throw new Error("No local ticket for that id. Load the file.");
    const side = Number(t.side);
    const price = BigInt(t.price);
    const qty = BigInt(t.qty);
    let backing = 0n;
    if (side === 1) {
        backing = BigInt(t.holdId || $("holdId").value || "0");
        if (backing === 0n) throw new Error("A sell needs locked inventory on the ticket.");
        const hold = await Venue.c.holds.getHoldForByPartition({
            partition: CLIENT.immutables.partition,
            tokenHolder: Venue.account,
            holdId: backing,
        });
        if (hold.escrow_ === ZERO || asBig(hold.amount_) === 0n) {
            throw new Error("That locked inventory reads as empty.");
        }
        if (!addrEq(hold.escrow_, CLIENT.addresses.MatchingEngine)) {
            throw new Error("Locked inventory is not escrowed to the matching engine.");
        }
        if (!addrEq(hold.destination_, ZERO)) throw new Error("Locked inventory names a destination.");
        if (asBig(hold.amount_) < qty) throw new Error("Locked inventory is smaller than qty.");
    }
    const value = side === 0 ? toWeibar(buyEscrow(price, qty)) : 0n;
    if (side === 0 && Venue.snap.walletTinybar !== undefined
        && Venue.snap.walletTinybar < buyEscrow(price, qty)) {
        throw new Error("This wallet does not have enough HBAR to fund the buy reveal and network fee.");
    }
    Venue.tradeTxStage("approval", "Reveal order");
    const rec = await Venue.send(
        Venue.w.engine.reveal(side, price, qty, t.salt, backing, {value, gasLimit: 800_000}),
        "Reveal order"
    );
    if (rec) {
        upsert("tickets", Venue.account, {
            ...t,
            holdId: backing === 0n ? t.holdId : backing.toString(),
            revealed: true,
            revealTx: rec.hash,
            revealedAt: new Date().toISOString(),
        }, "id");
        await Venue.writeVault(Venue.account, {quiet: true});
        Venue.status("trade-status",
            "Order revealed and now eligible for the call auction. Submission is not a fill.",
            "ok");
        await Venue.refreshTrade();
        await Venue.noteReceipt(
            "reveal", rec, 4, G.EXACT, T.IMM, "engine", "Revealed"
        );
    }
};

Venue.doCross = async function () {
    await Venue.requireAccount();
    const r = Venue.snap.round === 0n ? 0n : Venue.snap.round - 1n;
    Venue.tradeTxStage("approval", "Process auction round");
    const rec = await Venue.send(
        Venue.w.engine.crossRound(r, {gasLimit: 1_500_000}),
        "Process auction round"
    );
    if (rec) {
        const iface = Venue.c.engine.interface;
        const events = (rec.logs || []).flatMap((log) => {
            if (!addrEq(log.address, Venue.c.engine.target)) return [];
            try { return [iface.parseLog(log)]; } catch { return []; }
        });
        const named = (name) => events.find((event) => event.name === name);
        const crossing = named("RoundCrossed");
        const coarse = named("PrintedCoarse");
        const withheld = named("PrintWithheld");
        const empty = named("RoundEmpty");
        const settlements = events.filter((event) => event.name === "Settled");
        const settledQty = settlements.reduce((sum, event) => sum + asBig(event.args.amount), 0n);
        if (Venue.account && settlements.length) {
            const settledIds = new Set(settlements.flatMap((event) => [
                String(event.args.sellId).toLowerCase(),
                String(event.args.buyId).toLowerCase(),
            ]));
            const tickets = readList("tickets", Venue.account);
            let changed = false;
            const updated = tickets.map((ticket) => {
                if (!settledIds.has(String(ticket.id).toLowerCase())) return ticket;
                changed = true;
                return {...ticket, crossTx: rec.hash};
            });
            if (changed) {
                writeList("tickets", Venue.account, updated);
                await Venue.writeVault(Venue.account, {quiet: true});
            }
        }
        let result;
        if (crossing) {
            result = "Round " + r + " cleared at " +
                displayPriceHbar(asBig(crossing.args.priceTwice)) + " HBAR per bond. " +
                formatQuantity(settledQty) + " LPRC settled.";
        } else if (coarse || withheld) {
            result = "Round " + r + " settled " + formatQuantity(settledQty) +
                " LPRC. The exact public auction print was " +
                (coarse ? "coarsened." : "withheld.");
        } else if (empty) {
            result = "Round " + r + " closed without a match.";
        } else {
            result = "Round " + r + " was processed. Refresh order outcomes for details.";
        }
        Venue.status("trade-status", result, "ok");
        await Venue.refreshTrade();
        await Venue.noteReceipt(
            "cross", rec, 13, G.PRED, T.IMM, "engine",
            crossing ? "RoundCrossed" : coarse ? "PrintedCoarse" : withheld ? "PrintWithheld" : "RoundEmpty"
        );
    }
};

Venue.openWithdrawConfirm = function () {
    const modal = $("withdraw-modal");
    const credit = Venue.snap.credit ?? 0n;
    if (!modal || !Venue.account || asBig(credit) === 0n || Venue.busy) return;
    if ($("withdraw-confirm-amount")) {
        $("withdraw-confirm-amount").textContent = readableHbar(asBig(credit)) + " HBAR";
    }
    modal.hidden = false;
    setTimeout(() => $("withdraw-confirm")?.focus({preventScroll: true}), 20);
};

Venue.paintWithdraw = function (credit) {
    const action = $("withdraw");
    if (!action) return;
    const amount = asBig(credit ?? 0n);
    const ready = amount > 0n && !!Venue.account;
    action.disabled = !ready;
    action.classList.toggle("is-ready", ready);
    action.setAttribute("aria-label", ready
        ? "Withdraw " + readableHbar(amount) + " HBAR trading credit"
        : Venue.account
            ? "No trading credit ready to withdraw"
            : "Connect a wallet to view trading credit");
    const cue = action.querySelector(".withdraw-action");
    if (cue) {
        cue.textContent = ready
            ? "Withdraw trading credit"
            : Venue.account
                ? "No credit available"
                : "Connect to withdraw";
    }
    if (!ready && !$("withdraw-modal")?.hidden) {
        Venue.closeWithdrawConfirm({restoreFocus: false});
    }
};

Venue.closeWithdrawConfirm = function ({restoreFocus = true} = {}) {
    const modal = $("withdraw-modal");
    if (modal) modal.hidden = true;
    if (restoreFocus) $("withdraw")?.focus({preventScroll: true});
};

Venue.confirmWithdraw = async function () {
    if ($("withdraw-modal")?.hidden || Venue.busy) return;
    Venue.closeWithdrawConfirm({restoreFocus: false});
    await Venue.doWithdraw();
};

Venue.doWithdraw = async function () {
    await Venue.requireAccount();
    Venue.tradeTxStage("approval", "Withdraw trading credit");
    const rec = await Venue.send(
        Venue.w.engine.withdraw({gasLimit: 250_000}),
        "Withdraw trading credit"
    );
    if (rec) {
        await Venue.refreshTrade().catch(() => {});
        await Venue.refreshPosition().catch(() => {});
    }
};

Venue.doVaultWithdraw = async function () {
    if (!Venue.financing?.ready) {
        throw new Error(Venue.financing?.reason || "Financing writes are unavailable.");
    }
    await Venue.requireAccount();
    const rec = await Venue.send(Venue.w.vault.withdraw({gasLimit: 250_000}), "withdraw financing credit");
    if (rec) {
        await Venue.refreshPosition().catch(() => {});
        await Venue.doRepo?.().catch(() => {});
    }
};

// One wave. The venue's own four figures, the viewer's four, and the quote all
// go out together: `quote` is the only one that needed a round number first, and
// the clocks already read one this tick.
Venue.refreshTrade = async function () {
    const {engine, token, registry, holds, policy} = Venue.c;
    const acc = Venue.viewer();
    const round = Venue.snap.round ?? Venue.predictRound();
    const previous = round > 0n ? round - 1n : 0n;
    const discEpoch = Venue.snap.discEpoch;
    const activity = discEpoch == null ? Promise.resolve(null) : Promise.all([
        policy.budgetFor(15),
        engine.spentBits(15, discEpoch),
        engine.wouldAfford(15, G.PRED),
    ]);
    const [
        bond, fee, chainRound, revealed, kyc, bal, held, credit, walletBalance,
        q, previousCrossed, publication,
    ] = await Promise.all([
        engine.commitBond(),
        engine.cancelFee(),
        engine.currentRound(),
        engine.revealedCount(),
        acc ? registry.getKycStatus(acc) : null,
        acc ? token.balanceOfByPartition(CLIENT.immutables.partition, acc) : null,
        acc ? holds.getHeldAmountForByPartition(CLIENT.immutables.partition, acc) : null,
        acc ? engine.credit(acc) : null,
        acc ? Venue.reader.getBalance(acc).catch(() => null) : null,
        engine.quote(round),
        round > 0n ? engine.crossed(previous).catch(() => false) : true,
        activity,
    ]);
    Venue.snap.commitBond = asBig(bond);
    Venue.snap.cancelFee = asBig(fee);
    Venue.snap.previousCrossed = !!previousCrossed;
    if ($("im-bond")) $("im-bond").textContent = readableHbar(asBig(bond)) + " HBAR";
    if ($("im-fee")) $("im-fee").textContent = readableHbar(asBig(fee)) + " HBAR";
    if ($("im-round")) $("im-round").textContent = chainRound.toString();
    if ($("im-live")) {
        const count = asBig(revealed);
        $("im-live").textContent = count === 0n
            ? "Revealed book empty"
            : count + " revealed order" + (count === 1n ? "" : "s");
    }
    const currentQuote = asBig(chainRound) === asBig(round) ? q : await engine.quote(chainRound);
    if ($("quote")) {
        $("quote").textContent = currentQuote.willCross
            ? displayPriceHbar(asBig(currentQuote.priceTwice)) + " HBAR per bond · " +
                formatQuantity(asBig(currentQuote.volume)) + " LPRC indicated"
            : "No crossing indicated in this round";
    }
    const cross = $("cross");
    if (cross) {
        cross.disabled = asBig(chainRound) === 0n || !!previousCrossed || Venue.snap.halted || !Venue.account;
        cross.textContent = !!previousCrossed
            ? "Round " + previous + " processed"
            : Venue.snap.halted
                ? "Processing paused"
                : "Process round " + previous;
    }
    if ($("cross-help")) {
        $("cross-help").textContent = asBig(chainRound) === 0n
            ? "No auction round has closed yet."
            : previousCrossed
                ? "This round has already been matched and settled."
                : Venue.snap.halted
                    ? "Auction processing is currently paused by the protocol."
                    : !Venue.account
                        ? "Connect a wallet to process matching. This is permissionless and charges only the network fee."
                        : "Matches and settles eligible revealed orders. This wallet transaction charges a network fee.";
    }
    if (!Venue.stillViewer(acc)) return;
    if (acc) {
        Venue.snap.kyc = Number(kyc);
        Venue.snap.free = asBig(bal);
        Venue.snap.held = asBig(held);
        Venue.snap.credit = asBig(credit);
        if (walletBalance !== null) {
            try {
                Venue.snap.walletTinybar = fromWeibar(asBig(walletBalance));
            } catch {
                delete Venue.snap.walletTinybar;
            }
        } else {
            delete Venue.snap.walletTinybar;
        }
        if ($("bal-kyc")) {
            $("bal-kyc").textContent = Number(kyc) === 1 ? "Eligible" : "Eligibility required";
            $("bal-kyc").className = "account-grant " + (Number(kyc) === 1 ? "ok" : "bad");
        }
        if ($("bal-units")) $("bal-units").textContent = formatQuantity(asBig(bal));
        if ($("bal-held")) $("bal-held").textContent = formatQuantity(asBig(held));
        if ($("bal-credit")) $("bal-credit").textContent = readableHbar(asBig(credit));
        if ($("bal-hbar")) {
            $("bal-hbar").textContent = Venue.snap.walletTinybar === undefined
                ? "Unavailable"
                : readableHbar(Venue.snap.walletTinybar) + " HBAR";
        }
        Venue.paintWithdraw(asBig(credit));
        if ($("kyc-gate")) $("kyc-gate").hidden = Number(kyc) === 1;
    } else {
        delete Venue.snap.kyc;
        delete Venue.snap.free;
        delete Venue.snap.held;
        delete Venue.snap.credit;
        delete Venue.snap.walletTinybar;
        if ($("bal-kyc")) {
            $("bal-kyc").textContent = "Connect wallet";
            $("bal-kyc").className = "account-grant";
        }
        if ($("bal-units")) $("bal-units").textContent = "Unavailable";
        if ($("bal-held")) $("bal-held").textContent = "Unavailable";
        if ($("bal-credit")) $("bal-credit").textContent = "Unavailable";
        if ($("bal-hbar")) $("bal-hbar").textContent = "Unavailable";
        Venue.paintWithdraw(0n);
        if ($("kyc-gate")) $("kyc-gate").hidden = true;
    }
    Venue.paintPublication(publication, discEpoch);
    Venue.paintTicket();
    await Venue.attachHold();
    await Venue.paintTickets();
    if (Venue.lastView) Venue.paintLastView();
};

Venue.paintPublication = function (publication, epoch) {
    const track = $("pub-track");
    if (!track) return;
    const spentEl = $("pub-spent");
    const budgetEl = $("pub-budget");
    const next = $("pub-next");
    if ($("pub-epoch")) $("pub-epoch").textContent = epoch == null ? "Unknown" : String(epoch);
    if (!publication) {
        if (spentEl) spentEl.textContent = "Unknown";
        if (budgetEl) budgetEl.textContent = "Unknown";
        if (next) next.textContent = "The disclosure clock is not available yet.";
        return;
    }

    const budget = asBig(publication[0][3]);
    const spent = asBig(publication[1]);
    const afford = !!publication[2];
    if (spentEl) spentEl.textContent = String(spent);
    if (budgetEl) budgetEl.textContent = budget === 0n ? "unmetered" : String(budget) + " bits";
    const shownSpent = budget === 0n ? 0n : (spent > budget ? budget : spent);
    const pct = budget === 0n ? 0 : Number(shownSpent * 10000n / budget) / 100;
    $("pub-fill").style.width = pct + "%";
    track.setAttribute("aria-valuemax", String(budget));
    track.setAttribute("aria-valuenow", String(shownSpent));
    if (!next) return;
    next.classList.toggle("withheld", budget !== 0n && !afford);
    next.textContent = budget === 0n
        ? "Row 15 is unmetered in the current policy. Its venue event is not budget-limited."
        : afford
            ? "The next activity predicate may publish. It will spend 1 bit."
            : "Budget exhausted. The next valid action can still complete, but its activity event will be withheld.";
};

Venue.noteReceipt = async function (
    kind, rec, row, g, t, source = "engine", eventName = null
) {
    try {
        const disclosureSource = Venue.c[source];
        if (!disclosureSource) throw new Error("Unknown disclosure source " + source);
        const sourceAddress = String(
            disclosureSource.target ||
            CLIENT.addresses[source === "vault" ? "RepoVault" : "MatchingEngine"] ||
            "",
        );
        const chargedTopic = ethers.id(
            "DisclosureCharged(uint16,uint64,uint8,uint32,uint32)",
        ).toLowerCase();
        const rowTopic = ethers.zeroPadValue(ethers.toBeHex(row), 32).toLowerCase();
        const chargedLog = (rec.logs || []).find((log) =>
            addrEq(log.address, sourceAddress) &&
            String(log.topics?.[0] || "").toLowerCase() === chargedTopic &&
            String(log.topics?.[1] || "").toLowerCase() === rowTopic
        );
        const event = eventName
            ? disclosureSource.interface.getEvent(eventName)
            : null;
        const audible = event
            ? hasContractEvent(rec.logs, sourceAddress, event.topicHash)
            : null;
        const epoch = chargedLog?.topics?.[2]
            ? asBig(chargedLog.topics[2])
            : Venue.snap.discEpoch ?? asBig(await Venue.c.policy.currentEpoch());
        const [ceiling, would, spent, afford, br, budget] = await Promise.all([
            disclosureSource.ceilingFor(row),
            disclosureSource.wouldDisclose(row, g, t),
            disclosureSource.spentBits(row, epoch),
            disclosureSource.wouldAfford(row, g),
            disclosureSource.breakingSize(row, g),
            Venue.c.policy.budgetFor(row),
        ]);
        const disc = {
            domainBits: Number(budget[0]),
            aggBits: Number(budget[1]),
            bucketBits: Number(budget[2]),
            budgetBits: Number(budget[3]),
        };
        const local = receiptFor(Number(ceiling), disc, Number(spent), g, t);
        Venue.lastView = {
            kind, source, eventName, row, g, t, tx: rec.hash, epoch: epoch.toString(),
            ceiling: ceiling.toString(), would: !!would, spent: spent.toString(),
            afford: !!afford, breaking: br.toString(),
            metered: local.metered, permitted: local.permitted, audible,
        };
        Venue.rememberReceipt();
        Venue.paintLastView();
    } catch { /* getters only */ }
};

Venue.mountPosition = async function () {
    $("watch-go")?.addEventListener("click", () => Venue.doWatch().catch((e) => Venue.fail(e)));
    $("withdraw")?.addEventListener("click", () => Venue.doWithdraw().catch((e) => Venue.fail(e)));
    $("vault-withdraw")?.addEventListener("click", () => Venue.doVaultWithdraw().catch((e) => Venue.fail(e)));
    $("disclose")?.addEventListener("click", () => Venue.refreshPosition().catch((e) => Venue.fail(e)));
    $("coupon-refresh")?.addEventListener("click", () => Venue.refreshIncome().catch((e) => Venue.fail(e)));
    $("coupon-associate")?.addEventListener("click", () => Venue.doAssociateCash().catch((e) => Venue.fail(e)));
    $("coupon-proof")?.addEventListener("change", (e) => {
        Venue.importCouponProof(e.target.files[0]).catch((err) => Venue.fail(err));
        e.target.value = "";
    });
    await Promise.all([
        Venue.refreshPosition(),
        Venue.refreshInstrument().catch(() => {}),
        Venue.refreshIncome().catch(() => {}),
    ]);
};

Venue.refreshPosition = async function () {
    const who = Venue.viewer();
    const vaultReady = Venue.financing?.ready && Venue.c.vault;
    const [, credit, vaultCredit, kyc] = await Promise.all([
        Venue.refreshDisclosure(),
        who ? Venue.c.engine.credit(who) : null,
        who && vaultReady ? Venue.c.vault.credit(who) : null,
        who ? Venue.c.registry.getKycStatus(who) : null,
    ]);
    if (!Venue.stillViewer(who)) return;
    if (kyc != null) Venue.snap.kyc = Number(kyc);
    if (!who) {
        if ($("pos-credit")) $("pos-credit").textContent = "Unavailable";
        if ($("pos-vault-credit")) $("pos-vault-credit").textContent = "Unavailable";
        if ($("pos-tickets")) $("pos-tickets").textContent = "Unavailable";
        if ($("withdraw")) $("withdraw").disabled = true;
        if ($("vault-withdraw")) $("vault-withdraw").disabled = true;
        Venue.paintNeeds(null, 0n, 0n);
        return;
    }
    $("pos-credit").textContent = formatHbar(asBig(credit)) + " HBAR";
    if ($("pos-vault-credit")) {
        $("pos-vault-credit").textContent = vaultReady
            ? formatHbar(asBig(vaultCredit ?? 0n)) + " HBAR"
            : "unavailable on this vault";
    }
    $("withdraw").disabled = asBig(credit) === 0n || !Venue.account;
    if ($("vault-withdraw")) {
        $("vault-withdraw").disabled = !vaultReady || asBig(vaultCredit ?? 0n) === 0n || !Venue.account;
    }
    const tickets = readList("tickets", who);
    $("pos-tickets").textContent = tickets.length ? tickets.length + " on this device" : "none stored here";
    Venue.paintNeeds(who, asBig(credit), asBig(vaultCredit ?? 0n));
    if (Venue.lastView) Venue.paintLastView();
};

Venue.paintNeeds = function (who, tradeCredit, vaultCredit) {
    const el = $("needs-out");
    if (!el) return;
    if (!who) {
        el.innerHTML = '<div class="empty">Connect a wallet to see what is due.</div>';
        return;
    }
    const items = [];
    if (Venue.snap.kyc !== 1) {
        items.push('<a href="prove.html">Prove eligibility for this KYC epoch. Request is not approval.</a>');
    }
    if (tradeCredit > 0n) {
        items.push("Trading proceeds are available to withdraw.");
    }
    if (Venue.financing?.ready && vaultCredit > 0n) {
        items.push("Financing cash is credited. Withdraw it; the vault does not push HBAR.");
    }
    if (!Venue.financing?.ready) {
        items.push(esc(Venue.financing?.reason ||
            "Financing writes are unavailable on this bound vault."));
    }
    if (!items.length) {
        el.innerHTML = '<div class="empty">Nothing is waiting on this account from this screen.</div>';
        return;
    }
    el.innerHTML = '<div class="needs">' + items.map((t) => "<p>" + t + "</p>").join("") + "</div>";
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
    if (v.unmetered) {
        $("last-view").innerHTML =
            '<div class="rcpt-layers">' +
            '<article><h3>Succeeded</h3><p>' + esc(v.kind) +
            " · tx <a href='" + esc(explorerTx(v.tx)) + "'>" +
            esc(shortId(v.tx)) + "</a></p></article>" +
            '<article><h3>Venue published</h3><p>' +
            esc(v.published) + "</p></article>" +
            '<article><h3>Withheld</h3><p>Nothing by a disclosure budget. This action is not metered.</p></article>' +
            '<article><h3>Still public elsewhere</h3><p>' +
            esc(v.publicElsewhere) + "</p></article></div>";
        return;
    }
    const published = typeof v.audible === "boolean"
        ? v.audible
        : v.would && v.afford;
    const withheld = !published;
    $("last-view").innerHTML =
        '<div class="rcpt-layers">' +
        '<article><h3>Succeeded</h3><p>' + esc(v.kind) +
        " · tx <a href='" + esc(explorerTx(v.tx)) + "'>" + esc(shortId(v.tx)) + "</a></p></article>" +
        '<article><h3>Venue published</h3><p>' +
        (published
            ? "row " + v.row + " " + esc(ROW_NAMES[v.row] || "") +
              " · " + G_NAME[v.g] + " · " + T_NAME[v.t]
            : "nothing on this row") +
        "</p></article>" +
        '<article><h3>Withheld</h3><p>' +
        (withheld
            ? "row " + v.row + " " + esc(ROW_NAMES[v.row] || "") +
              (v.permitted && v.metered ? " (budget spent)" : " (outside the ceiling)")
            : "nothing this row") +
        "</p></article>" +
        '<article><h3>Still public elsewhere</h3><p>Storage, calldata, ATS events, and your wallet. A withheld venue log is not a private chain.</p>' +
        "<p class='meta'>ceilingFor=" + esc(v.ceiling) +
        " · wouldDisclose=" + v.would +
        " · spentBits=" + esc(v.spent) +
        " · wouldAfford=" + v.afford +
        " · breakingSize=" + esc(v.breaking) +
        " · epoch " + esc(v.epoch) + "</p></article>" +
        "</div>";
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

Venue.cashContract = function (runner) {
    const addr = CLIENT.addresses.couponCashToken;
    if (!addr) return null;
    return new ethers.Contract(addr, [
        "function associate() returns (uint256)",
        "function isAssociated() view returns (bool)",
        "function balanceOf(address) view returns (uint256)",
    ], runner || Venue.reader);
};

function formatCashAmount(amount) {
    const decimals = Number(CLIENT.coupon?.cashToken?.decimals ?? 2);
    const a = asBig(amount);
    const scale = 10n ** BigInt(decimals);
    const whole = a / scale;
    const frac = (a % scale).toString().padStart(decimals, "0");
    return whole.toString() + "." + frac;
}

Venue.refreshIncome = async function () {
    const el = $("coupon-claim");
    if (!el) return;
    const dist = Venue.c.couponDistributor;
    const sched = Venue.c.couponSchedule;
    if (!dist || !sched) {
        el.innerHTML = '<div class="empty">No coupon distributor is named in this address book.</div>';
        return;
    }
    const who = Venue.viewer();
    const cash = Venue.cashContract();
    const count = Number(await sched.count());
    const now = Number(nowSec());
    const feeBps = CLIENT.coupon?.distributor?.payingAgentFeeBps
        || CLIENT.coupon?.cashToken?.fractionalFee?.basisPoints;
    let associated = null;
    if (Venue.account && cash) {
        const live = Venue.cashContract(Venue.signer || Venue.reader);
        associated = await live.isAssociated().catch(() => null);
    }
    if ($("coupon-associate")) {
        $("coupon-associate").disabled = !Venue.account || associated === true;
    }
    const cards = [];
    for (let i = 0; i < count; i++) {
        const [decl, closes, due] = await Promise.all([
            dist.declarationOf(i),
            dist.claimsCloseAt(i),
            sched.dateOf(i),
        ]);
        const declared = asBig(decl.declaredAt) > 0n;
        const open = declared && now < Number(asBig(closes));
        const claimed = who ? await dist.claimed(i, who) : false;
        const dueAt = new Date(Number(due) * 1000).toISOString().slice(0, 10);
        let status;
        if (!declared) status = "issuer has not funded this coupon";
        else if (claimed) status = "already claimed by this account";
        else if (!open) status = "claim window closed";
        else status = "declared; a merkle proof is required to claim";
        cards.push(
            '<article class="card"><div class="id">coupon ' + i + "</div>" +
            "<div class='meta'>due " + esc(dueAt) + " · remaining " +
            esc(formatCashAmount(decl.remaining)) + " LPCASH · " + esc(status) + "</div></article>"
        );
    }
    const proof = Venue.couponProof;
    let proofHtml = "";
    if (proof) {
        const gross = formatCashAmount(proof.amount);
        const cfg = CLIENT.coupon?.cashToken?.fractionalFee || {};
        const numerator = asBig(cfg.numerator ?? feeBps ?? 0);
        const denominator = asBig(cfg.denominator ?? 10_000);
        const minimum = asBig(cfg.minimum ?? 0);
        const maximum = asBig(cfg.maximum ?? 0);
        let fee = denominator === 0n ? 0n : proof.amount * numerator / denominator;
        if (fee < minimum) fee = minimum;
        if (maximum > 0n && fee > maximum) fee = maximum;
        const net = proof.amount > fee ? proof.amount - fee : 0n;
        const holderIsAccount = !!Venue.account && addrEq(Venue.account, proof.holder);
        proofHtml = '<p>Loaded proof for coupon ' + esc(String(proof.index)) +
            " · holder " + esc(shortAddr(proof.holder)) +
            " · gross " + esc(gross) + " LPCASH · fee " +
            esc(formatCashAmount(fee)) + " · net " + esc(formatCashAmount(net)) +
            ". HTS deducts the " + esc(String(feeBps)) +
            " bps inclusive fee from this transfer.</p>" +
            (Venue.account && !holderIsAccount
                ? "<p class='note'>This proof names another holder. Connect that holder to claim and associate LPCASH.</p>"
                : "") +
            '<div class="rowbtns"><button type="button" class="primary" id="coupon-claim-go"' +
            (holderIsAccount ? "" : " disabled") + ">Claim</button></div>";
    }
    el.innerHTML = cards.join("") + proofHtml +
        (associated === false
            ? "<p class='note'>Associate LPCASH before the first claim or HTS will refuse the transfer.</p>"
            : "");
    $("coupon-claim-go")?.addEventListener("click", () => Venue.doClaimCoupon().catch((e) => Venue.fail(e)));
};

Venue.importCouponProof = async function (file) {
    if (!file) return;
    const obj = JSON.parse(await file.text());
    const index = Number(obj.index ?? obj.coupon);
    const holder = obj.holder;
    const position = BigInt(obj.position);
    const amount = BigInt(obj.amount);
    const proof = obj.proof;
    if (!Number.isInteger(index) || !holder || !Array.isArray(proof)) {
        throw new Error("Proof JSON needs index, holder, position, amount, and proof[].");
    }
    if (!ethers.isAddress(holder) || position < 0n || amount <= 0n) {
        throw new Error("Proof holder, position, or amount is invalid.");
    }
    Venue.couponProof = {index, holder, position, amount, proof};
    const dist = Venue.c.couponDistributor;
    if (dist) {
        const ok = await dist.wouldAccept(index, holder, position, amount, proof);
        if (!ok) Venue.toast("wouldAccept is false for this proof against the live declaration.");
        else Venue.toast("wouldAccept is true. Claim when ready.");
    }
    await Venue.refreshIncome();
};

Venue.doAssociateCash = async function () {
    await Venue.requireAccount();
    const cash = Venue.cashContract(Venue.signer);
    if (!cash) throw new Error("No coupon cash token is named in this address book.");
    const rec = await Venue.send(cash.associate({gasLimit: 250_000}), "associate LPCASH");
    if (rec) await Venue.refreshIncome();
};

Venue.doClaimCoupon = async function () {
    await Venue.requireAccount();
    const p = Venue.couponProof;
    if (!p) throw new Error("Load an entitlement proof first.");
    const dist = Venue.c.couponDistributor;
    const ok = await dist.wouldAccept(p.index, p.holder, p.position, p.amount, p.proof);
    if (!ok) throw new Error("wouldAccept is false. The proof does not match a live declaration.");
    const rec = await Venue.send(
        Venue.w.couponDistributor.claim(p.index, p.holder, p.position, p.amount, p.proof, {gasLimit: 400_000}),
        "claim coupon"
    );
    if (rec) {
        Venue.toast("Coupon claimed. LPCASH arrives after the HTS fee.");
        Venue.lastView = {
            kind: "coupon claimed",
            tx: rec.hash,
            unmetered: true,
            published: "Coupon index and holder in CouponDistributor. The venue event carries no amount.",
            publicElsewhere:
                "The LPCASH Transfer record carries the amount. The entitlement root and wallet transaction are public.",
        };
        Venue.rememberReceipt();
        await Venue.refreshIncome();
        Venue.paintLastView();
    }
};

window.Venue = Venue;
