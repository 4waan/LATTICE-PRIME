// Live client runtime. Inlined into the three screens by tools/gen-app.mjs.
// Relies on globals from the previous INLINE blocks: CLIENT, ABI, units,
// commitmentOf / preimageWords / SIDE / selector, lattice receiptFor, and ethers.

const ZERO = "0x0000000000000000000000000000000000000000";
const ATS_KYC = "0xfc855b1b";
const TICKET_VER = 1;
const VAULT_VER = 1;
const HOLD_VER = 1;
const ORDER_SCALE_LIMIT = 1n << 96n;
const RECEIPT_SESSION = "seamme.disclosure-receipt.v1";
const TRADE_SIDE_KEY = "seamme.trade.side";
const ELIGIBILITY_RELAY_PATH = "/api/eligibility/register";
const ORACLE_REFRESH_MS = 30_000;
// Live HBAR inserts used 892,647 to 959,079 gas. 600,000 OOGs on Hedera.
const PRIVATE_HBAR_DEPOSIT_GAS = 1_100_000n;
const PRIVATE_LPRC_DEPOSIT_GAS = 1_200_000n;
const PRIVATE_LPRC_APPROVE_GAS = 250_000n;
const PRIVATE_SESSION_ABI = [
    "function sessionSigner() view returns (address)",
    "function recoverySigner() view returns (address)",
    "function engine() view returns (address)",
    "function security() view returns (address)",
    "function partition() view returns (bytes32)",
    "function router() view returns (address)",
    "function quicknetChainHash() view returns (bytes32)",
    "function generation() view returns (uint64)",
    "function feePolicyDigest() view returns (bytes32)",
    "function commitmentFor(uint8 side,uint128 price,uint128 qty,bytes32 randomSalt,bytes32 envelopeDigest,uint64 quicknetRound) view returns (bytes32)",
    "function placeAuthorizationDigest(bytes32 commitment,bytes32 envelopeDigest,uint64 quicknetRound) view returns (bytes32)",
    "function cancelAuthorizationDigest(bytes32 commitment,bytes32 envelopeDigest,uint64 quicknetRound) view returns (bytes32)",
    "function recoveryNonce() view returns (uint256)",
    "function recoveryAuthorizationDigest(address asset,uint256 amount,uint256 noteCommitment,uint256 nonce) view returns (bytes32)",
    "function revealAuthorized(uint8 side,uint128 price,uint128 qty,bytes32 randomSalt,bytes32 envelopeDigest,uint64 quicknetRound) returns (bytes32)",
    "function expire(bytes32 id)",
    "function sweepEngineCredit()",
];
const PRIVATE_FACTORY_ABI = [
    "function isSessionAccount(address account) view returns (bool)",
    "function accountAddress((address sessionSigner,address recoverySigner,address engine,address security,bytes32 partition,address router,bytes32 quicknetChainHash,uint64 generation,bytes32 feePolicyDigest) config,bytes32 salt) view returns (address)",
];
const PRIVATE_GATE_ABI = [
    "function sessionRootForEpoch(uint64 epoch) view returns (uint256)",
    "function viewKeyEpochForRotationEpoch(uint64 epoch) view returns (uint64)",
    "function viewKeyForEpoch(uint64 epoch) view returns (uint256 x,uint256 y,bool published)",
    "function sessionImplementationCodeHash() view returns (bytes32)",
    "function sessionImplementationCodeHashLow() view returns (uint256)",
    "function sessionImplementationCodeHashHigh() view returns (uint256)",
    "function minTier() view returns (uint256)",
    "function jurisdictionMask() view returns (uint256)",
];
const PRIVATE_ROUTER_ABI = [
    "event Deposited(uint256 indexed commitment,uint32 indexed leafIndex,uint256 indexed root,address depositor,address asset,uint256 denomination,uint64 acceptedAt)",
    "function deposit(uint256 commitment) payable returns (uint256 root)",
    "function asset() view returns (address)",
    "function denomination() view returns (uint256)",
    "function deploymentChainId() view returns (uint256)",
    "function currentRoot() view returns (uint256)",
    "function nextLeafIndex() view returns (uint32)",
    "function commitmentAt(uint32 index) view returns (uint256)",
    "function commitmentRange(uint32 start,uint32 count) view returns (uint256[] values)",
    "function rootAtNoteCount(uint32 noteCount) view returns (uint256)",
    "function rootMetadata(uint256 root) view returns (uint64 acceptedAt,uint32 realNotes,uint32 independentFunders,bool known)",
    "function independentFunders() view returns (uint32)",
    "function minimumRealNotes() view returns (uint32)",
    "function minimumWithdrawalDelay() view returns (uint64)",
    "function activeViewKeyEpoch() view returns (uint64)",
    "function activeViewKeyX() view returns (uint256)",
    "function activeViewKeyY() view returns (uint256)",
    "function nullifierSpent(bytes32 nullifier) view returns (bool)",
];
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
    '<div class="empty">Connect the matching wallet to inspect its access checks.</div>';
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
const readableQuantity = (qty) => formatQuantity(asBig(qty))
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const readablePrice = (price) => formatPrice(asBig(price))
    .replace(/(\.\d*?[1-9])0+$/, "$1")
    .replace(/\.0+$/, "");
const readableBps = (bps) => {
    const value = asBig(bps);
    const whole = value / 100n;
    const fraction = (value % 100n).toString().padStart(2, "0")
        .replace(/0+$/, "");
    return whole + (fraction ? "." + fraction : "") + "%";
};
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
        message = "This private access check belongs to another account. Connect its matching wallet.";
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
        releaseTx: t.releaseTx || undefined,
        path: t.path || "manual",
        automaticReveal: t.automaticReveal || undefined,
        walletOwner: t.walletOwner || undefined,
        envelopeDigest: t.envelopeDigest || undefined,
        releaseRound: t.releaseRound || undefined,
        releaseAt: t.releaseAt || undefined,
        generation: t.generation || undefined,
        feePolicyDigest: t.feePolicyDigest || undefined,
        timedTicketId: t.timedTicketId || undefined,
        timedTicketCapability: t.timedTicketCapability || undefined,
        automationState: t.automationState || undefined,
        serviceState: t.serviceState || undefined,
    };
}

function vaultName(account) {
    const short = (account || "").replace(/^0x/i, "").slice(0, 8).toLowerCase();
    return "seamme-orders-" + CLIENT.network.chainId + "-" + short + ".json";
}

function vaultFile(account, tickets) {
    return {
        v: VAULT_VER,
        kind: "vault",
        warning: "Without these reveal keys the orders cannot be revealed and the commit bonds are forfeit.",
        network: CLIENT.network.chainId,
        engine: CLIENT.addresses.MatchingEngine,
        account,
        savedAt: new Date().toISOString(),
        tickets: (tickets || []).map(ticketFile),
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
    const path = t.path == null ? "manual" : String(t.path);
    if (path !== "manual" && path !== "private") {
        throw new Error("The recovery file has an invalid execution path.");
    }
    const committer = String(t.committer || "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(committer) || addrEq(committer, ZERO)) {
        throw new Error("The recovery file has an invalid submitting wallet.");
    }
    const walletOwner = path === "private"
        ? String(t.walletOwner || "")
        : committer;
    if (!/^0x[0-9a-fA-F]{40}$/.test(walletOwner) || addrEq(walletOwner, ZERO)) {
        throw new Error("The recovery file has an invalid local owner.");
    }
    if (account && !addrEq(walletOwner, account)) {
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
    const privateHash = (value, label) => {
        const result = String(value || "").toLowerCase();
        if (!/^0x[0-9a-f]{64}$/.test(result)) {
            throw new Error("The recovery file has an invalid " + label + ".");
        }
        return result;
    };
    let privateFields = {};
    let expectedId;
    if (path === "private") {
        if (typeof PrivateTradingCrypto === "undefined") {
            throw new Error("Private order verification is unavailable.");
        }
        const releaseRound = optionalUint(
            t.releaseRound,
            "Quicknet release round",
            (1n << 64n) - 1n,
        );
        const releaseAt = optionalUint(
            t.releaseAt,
            "automatic release time",
            (1n << 64n) - 1n,
        );
        const generation = optionalUint(
            t.generation,
            "session generation",
            (1n << 64n) - 1n,
        );
        if (releaseRound === null || releaseAt === null || generation === null) {
            throw new Error("The private recovery record is incomplete.");
        }
        const envelopeDigest = privateHash(t.envelopeDigest, "envelope digest");
        const feePolicyDigest = privateHash(t.feePolicyDigest, "fee policy");
        const timedTicketId = String(t.timedTicketId || "").toLowerCase();
        const timedTicketCapability = String(t.timedTicketCapability || "").toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(timedTicketId)
            || !/^0x[0-9a-f]{64}$/.test(timedTicketCapability)) {
            throw new Error("The private timed ticket capability is invalid.");
        }
        expectedId = PrivateTradingCrypto.computeTimedTicketEngineCommitment({
            sessionAccount: committer,
            engine: CLIENT.addresses.MatchingEngine,
            side,
            price,
            quantity: qty,
            randomSalt: salt,
            envelopeDigest,
            targetRound: releaseRound,
            generation,
            feePolicyDigest,
        });
        privateFields = {
            walletOwner,
            envelopeDigest,
            releaseRound,
            releaseAt,
            generation,
            feePolicyDigest,
            timedTicketId,
            timedTicketCapability,
            automationState: String(t.automationState || "Stored"),
            serviceState: String(t.serviceState || "PREARMED"),
        };
    } else {
        expectedId = commitmentOf(committer, side, price, qty, salt);
    }
    if (expectedId.toLowerCase() !== id.toLowerCase()) {
        throw new Error("The recovery key and order details do not match this order id.");
    }
    return {
        v: t.v || TICKET_VER,
        path,
        automaticReveal: path === "private" && t.automaticReveal === true,
        committer,
        ...privateFields,
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
        releaseTx: optionalHash(t.releaseTx, "release receipt"),
    };
}

function canPickVaultFile() {
    return typeof window.showSaveFilePicker === "function";
}

function vaultHandleKey(account) {
    return String(CLIENT.network.chainId) + "." + account.toLowerCase();
}

function openVaultIdb() {
    return openTicketVaultDb();
}

async function getVaultHandle(account) {
    const db = await openVaultIdb();
    try {
        return await new Promise((resolve, reject) => {
            const r = db.transaction(TICKET_VAULT_HANDLE_STORE, "readonly")
                .objectStore(TICKET_VAULT_HANDLE_STORE).get(vaultHandleKey(account));
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
            const tx = db.transaction(TICKET_VAULT_HANDLE_STORE, "readwrite");
            tx.objectStore(TICKET_VAULT_HANDLE_STORE).put(handle, vaultHandleKey(account));
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
            const tx = db.transaction(TICKET_VAULT_HANDLE_STORE, "readwrite");
            tx.objectStore(TICKET_VAULT_HANDLE_STORE).delete(vaultHandleKey(account));
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
    revealPending: new Set(),
    watching: null,
    lastView: null,
    eth: null,
    _vaultHandles: {},
    _ticketVaults: {},
    _ticketVaultStatus: {},
    _ticketHydrating: {},
    _ticketChains: new Map(),
    _ticketOrderStates: new Map(),
    _exportedTickets: new Set(),
    editingDraftId: null,
    _eligibilityBusy: false,
    _eligibilityStage: null,
    orderStage: "details",
    trackTicketId: null,
    withdrawKind: "trading",
    positionState: null,
    couponState: null,
    portfolioFinancing: null,
    session: null,
    _privateSessionRecords: [],
    _privateSecretPayload: {v: 1, credential: null, notes: []},
    _privateScope: null,
};

function ticketVaultCacheKey(account) {
    return account ? account.toLowerCase() : "";
}

function mergeTicketRecords(first, second) {
    const merged = [];
    const positions = new Map();
    for (const ticket of [...first, ...second]) {
        const id = String(ticket?.id || "").toLowerCase();
        if (!id) continue;
        const at = positions.get(id);
        if (at === undefined) {
            positions.set(id, merged.length);
            merged.push(ticket);
        } else {
            merged[at] = {...merged[at], ...ticket};
        }
    }
    return merged;
}

Venue.ticketList = function (account) {
    const key = ticketVaultCacheKey(account);
    return key && Venue._ticketVaults[key]?.tickets
        ? Venue._ticketVaults[key].tickets
        : [];
};

Venue.ticketVaultReady = function (account) {
    const key = ticketVaultCacheKey(account);
    return !!(key && Venue._ticketVaultStatus[key]?.ready);
};

Venue.paintDeviceVaultState = function () {
    const out = $("device-vault-state");
    if (!out) return;
    const who = Venue.viewer();
    if (!who) {
        out.textContent = "Connect a wallet to prepare encrypted device storage.";
        out.className = "device-vault-state";
        return;
    }
    const state = Venue._ticketVaultStatus[ticketVaultCacheKey(who)];
    if (state?.ready) {
        out.textContent = state.persistent
            ? "Reveal keys are encrypted in persistent storage on this device."
            : "Reveal keys are encrypted on this device. An optional export protects against cleared site data.";
        out.className = "device-vault-state ok";
        return;
    }
    if (state?.error) {
        out.textContent = "Encrypted storage is unavailable. Export a recovery copy before submitting.";
        out.className = "device-vault-state bad";
        return;
    }
    out.textContent = "Preparing encrypted storage on this device.";
    out.className = "device-vault-state";
};

Venue.hydrateTicketVault = async function (account) {
    if (!account) return [];
    const owner = ethers.getAddress(account);
    const key = ticketVaultCacheKey(owner);
    if (Venue._ticketVaultStatus[key]?.ready && Venue._ticketVaults[key]) {
        return Venue._ticketVaults[key].tickets;
    }
    if (Venue._ticketHydrating[key]) return Venue._ticketHydrating[key];
    Venue._ticketVaultStatus[key] = {ready: false, pending: true};
    Venue.paintDeviceVaultState();
    Venue._ticketHydrating[key] = (async () => {
        const legacy = readList("tickets", owner);
        let fallback = [];
        try {
            const scope = ticketVaultScope(
                CLIENT.network.chainId,
                CLIENT.addresses.MatchingEngine,
                owner,
            );
            const loaded = await loadDeviceTicketVault(scope);
            const encrypted = loaded.tickets.map((ticket) => ticketRecord(ticket, owner));
            const old = legacy.map((ticket) => ticketRecord(ticket, owner));
            const tickets = legacy.length
                ? await migrateLegacyTicketVault(scope, loaded.key, encrypted, old, {
                    removeLegacy: async () =>
                        localStorage.removeItem(storeKey("tickets", owner)),
                })
                : encrypted;
            fallback = tickets.map((ticket) => ticketRecord(ticket, owner));
            Venue._ticketVaults[key] = {scope, key: loaded.key, tickets};
            Venue._ticketVaultStatus[key] = {ready: true, persistent: false};
            requestPersistentTicketStorage().then((persistent) => {
                const current = Venue._ticketVaultStatus[key];
                if (!current?.ready) return;
                Venue._ticketVaultStatus[key] = {...current, persistent};
                Venue.paintDeviceVaultState();
            });
            Venue.paintDeviceVaultState();
            return tickets;
        } catch (error) {
            if (!fallback.length && legacy.length) {
                try {
                    fallback = legacy.map((ticket) => ticketRecord(ticket, owner));
                } catch {
                    fallback = [];
                }
            }
            Venue._ticketVaults[key] = {scope: null, key: null, tickets: fallback};
            Venue._ticketVaultStatus[key] = {
                ready: false,
                error: error?.message || "Encrypted device storage failed.",
            };
            Venue.paintDeviceVaultState();
            return fallback;
        } finally {
            delete Venue._ticketHydrating[key];
        }
    })();
    return Venue._ticketHydrating[key];
};

Venue.persistTickets = async function (account, tickets) {
    if (!account) throw new Error("Connect a wallet first.");
    const owner = ethers.getAddress(account);
    const key = ticketVaultCacheKey(owner);
    await Venue.hydrateTicketVault(owner);
    const vault = Venue._ticketVaults[key];
    if (!vault?.key || !vault.scope || !Venue.ticketVaultReady(owner)) {
        throw new Error(
            Venue._ticketVaultStatus[key]?.error
            || "Encrypted device storage is unavailable.",
        );
    }
    const normalized = tickets.map((ticket) => ticketRecord(ticket, owner));
    await saveDeviceTicketVault(vault.scope, vault.key, normalized);
    vault.tickets = normalized;
    Venue._ticketSig = "";
    Venue.paintDeviceVaultState();
    return normalized;
};

Venue.upsertTicket = async function (account, item) {
    await Venue.hydrateTicketVault(account);
    const current = Venue.ticketList(account);
    const at = current.findIndex((ticket) =>
        String(ticket.id).toLowerCase() === String(item.id).toLowerCase());
    const next = current.slice();
    if (at === -1) next.unshift(item);
    else next[at] = {...next[at], ...item};
    await Venue.persistTickets(account, next);
    return Venue.ticketList(account);
};

Venue.removeTicket = async function (account, id) {
    const next = Venue.ticketList(account).filter((ticket) =>
        String(ticket.id).toLowerCase() !== String(id).toLowerCase());
    await Venue.persistTickets(account, next);
    return next;
};

Venue.cacheTicket = function (account, item) {
    const key = ticketVaultCacheKey(account);
    if (!key) return [];
    const vault = Venue._ticketVaults[key] || {scope: null, key: null, tickets: []};
    const at = vault.tickets.findIndex((ticket) =>
        String(ticket.id).toLowerCase() === String(item.id).toLowerCase());
    if (at === -1) vault.tickets.unshift(item);
    else vault.tickets[at] = {...vault.tickets[at], ...item};
    Venue._ticketVaults[key] = vault;
    Venue._ticketSig = "";
    return vault.tickets;
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
        oracleScheduler: typeof ORACLE_SCHEDULER !== "undefined" && ORACLE_SCHEDULER?.address
            ? new ethers.Contract(ORACLE_SCHEDULER.address, [
                "function oracle() view returns (address)",
                "function activeSchedule() view returns (address)",
                "function nextCheckAt() view returns (uint64)",
                "function trackedRound() view returns (uint64)",
                "function retryStreak() view returns (uint8)",
                "function checksThisRound() view returns (uint8)",
                "function MAX_RETRY_STREAK() view returns (uint8)",
                "function MAX_CHECKS_PER_ROUND() view returns (uint8)",
                "function MIN_BALANCE_TINYBAR() view returns (uint256)",
                "event CheckScheduled(address indexed scheduleAddress,uint64 indexed dueAt)",
                "event CheckUnscheduled(uint64 indexed dueAt,int64 reason)",
                "event QuorumObserved(uint64 indexed round,uint256 answers,uint8 quorum)",
                "event FinalizeAttempt(uint64 indexed round,bool success,bytes result)",
                "event OracleReadFailed(bytes4 indexed selector)",
                "event ArmRefused(uint64 indexed round,uint256 answers,bytes32 reason)",
                "event AutomationStopped(uint64 indexed round,bytes32 reason)",
            ], runner)
            : null,
        couponSchedule: A.CouponSchedule
            ? new ethers.Contract(A.CouponSchedule, ABI.CouponSchedule, runner)
            : null,
        couponDistributor: A.CouponDistributor
            ? new ethers.Contract(A.CouponDistributor, ABI.CouponDistributor, runner)
            : null,
    };
};

Venue.privateContracts = function (runner = Venue.reader) {
    const config = CLIENT.privateTrading;
    if (!config?.enabled) return null;
    return {
        factory: new ethers.Contract(
            config.addresses.SessionAccountFactory,
            PRIVATE_FACTORY_ABI,
            runner,
        ),
        gate: new ethers.Contract(
            config.addresses.DualRegistrationGate,
            PRIVATE_GATE_ABI,
            runner,
        ),
        session: (account) => new ethers.Contract(account, PRIVATE_SESSION_ABI, runner),
        router: (asset) => {
            const symbol = String(asset || "").toUpperCase();
            const address = symbol === "HBAR"
                ? config.addresses.HbarRouter
                : symbol === "LPRC"
                    ? config.addresses.LprcRouter
                    : null;
            if (!address) throw new Error("Private routing asset is unavailable.");
            return new ethers.Contract(address, PRIVATE_ROUTER_ABI, runner);
        },
    };
};

Venue.savePrivateSessionRecords = async function (records) {
    if (!Venue.account || !Venue._privateScope) {
        throw new Error("Connect the private session owner first.");
    }
    const owner = Venue.account;
    const scope = Venue._privateScope;
    const vault = Venue._ticketVaults[ticketVaultCacheKey(owner)];
    if (!vault?.key) throw new Error("Encrypted device storage is unavailable.");
    const payload = await savePrivateSessions({
        key: vault.key,
        scope,
        payload: {v: PRIVATE_SESSION_PAYLOAD_SCHEMA, sessions: records},
        read: readTicketVaultStore,
        write: writeTicketVaultStore,
        ethersImpl: ethers,
    });
    if (!addrEq(Venue.account, owner) || Venue._privateScope?.id !== scope.id) {
        throw new Error("The connected wallet changed while saving the private session.");
    }
    Venue._privateSessionRecords = payload.sessions;
    return payload.sessions;
};

Venue.savePrivateSecretPayload = async function (payload) {
    if (!Venue.account || !Venue._privateScope) {
        throw new Error("Connect the private session owner first.");
    }
    const owner = Venue.account;
    const scope = privateSecretScope(
        CLIENT.network.chainId,
        CLIENT.privateTrading.addresses.SessionAccountFactory,
        owner,
    );
    const vault = Venue._ticketVaults[ticketVaultCacheKey(owner)];
    if (!vault?.key) throw new Error("Encrypted device storage is unavailable.");
    const verified = await savePrivateSecrets({
        key: vault.key,
        scope,
        payload,
        read: readTicketVaultStore,
        write: writeTicketVaultStore,
    });
    if (!addrEq(Venue.account, owner) || Venue._privateScope?.id !== scope.id) {
        throw new Error("The connected wallet changed while saving private data.");
    }
    Venue._privateSecretPayload = verified;
    return verified;
};

Venue.verifyPrivateSessionRecord = async function (record) {
    const contracts = Venue.privateContracts();
    if (!contracts) throw new Error("Private trading is not released.");
    const publicRecord = publicPrivateSession(record, ethers);
    const code = await Venue.reader.getCode(publicRecord.account);
    if (code === "0x") throw new Error("The saved private session is not deployed.");
    const account = contracts.session(publicRecord.account);
    const [
        canonical,
        signer,
        recovery,
        engine,
        security,
        partition,
        router,
        chainHash,
        generation,
        feePolicy,
        kyc,
    ] = await Promise.all([
        contracts.factory.isSessionAccount(publicRecord.account),
        account.sessionSigner(),
        account.recoverySigner(),
        account.engine(),
        account.security(),
        account.partition(),
        account.router(),
        account.quicknetChainHash(),
        account.generation(),
        account.feePolicyDigest(),
        Venue.c.registry.getKycStatus(publicRecord.account),
    ]);
    const config = CLIENT.privateTrading;
    if (
        !canonical
        || !addrEq(signer, publicRecord.signer)
        || !addrEq(recovery, publicRecord.recovery)
        || !addrEq(engine, CLIENT.addresses.MatchingEngine)
        || !addrEq(security, CLIENT.addresses.token)
        || String(partition).toLowerCase() !== String(CLIENT.immutables.partition).toLowerCase()
        || !addrEq(router, config.addresses.SessionRecoveryRouter)
        || String(chainHash).toLowerCase()
            !== "0x" + PrivateTradingCrypto.QUICKNET_CHAIN_HASH
        || asBig(generation) !== BigInt(publicRecord.generation)
        || String(feePolicy).toLowerCase()
            !== String(config.session.feePolicyDigest).toLowerCase()
    ) {
        throw new Error("The saved private session does not match the released venue.");
    }
    return {
        ...publicRecord,
        account: ethers.getAddress(publicRecord.account),
        kycStatus: Number(kyc),
    };
};

Venue.hydratePrivateState = async function (account) {
    const generation = (Venue._privateHydrationGeneration || 0) + 1;
    Venue._privateHydrationGeneration = generation;
    const stillCurrent = () => (
        Venue._privateHydrationGeneration === generation
        && addrEq(Venue.account, account)
    );
    clearTimeout(Venue._privateFundingTimer);
    Venue._privateFundingTimer = null;
    Venue.session = null;
    Venue._privateSessionRecords = [];
    Venue._privateSecretPayload = {v: 1, credential: null, notes: []};
    Venue._privateScope = null;
    delete Venue.snap.sessionKyc;
    const config = CLIENT.privateTrading;
    if (!account || !config?.enabled) return null;
    await Venue.hydrateTicketVault(account);
    if (!stillCurrent()) return null;
    const vault = Venue._ticketVaults[ticketVaultCacheKey(account)];
    if (!vault?.key) return null;
    const scope = privateSessionScope(
        CLIENT.network.chainId,
        config.addresses.SessionAccountFactory,
        account,
    );
    Venue._privateScope = scope;
    try {
        const sessionEnvelope = await readTicketVaultStore(PRIVATE_SESSION_STORE, scope.id);
        if (sessionEnvelope) {
            const payload = await decryptPrivateSessions(
                vault.key,
                scope,
                sessionEnvelope,
                globalThis.crypto,
                ethers,
            );
            if (!stillCurrent()) return null;
            Venue._privateSessionRecords = payload.sessions;
            const active = payload.sessions.find((item) => item.state === "ACTIVE");
            if (active) {
                const verifiedSession = await Venue.verifyPrivateSessionRecord(active);
                if (!stillCurrent()) return null;
                Venue.session = verifiedSession;
                Venue.snap.sessionKyc = verifiedSession.kycStatus;
            }
        }
        const secretScope = privateSecretScope(
            CLIENT.network.chainId,
            config.addresses.SessionAccountFactory,
            account,
        );
        const secretEnvelope = await readTicketVaultStore(
            PRIVATE_SECRET_STORE,
            secretScope.id,
        );
        if (secretEnvelope) {
            const privateSecrets = await decryptPrivateSecrets(
                vault.key,
                secretScope,
                secretEnvelope,
            );
            if (!stillCurrent()) return null;
            Venue._privateSecretPayload = privateSecrets;
        }
    } catch (error) {
        if (!stillCurrent()) return null;
        Venue.session = null;
        Venue._privateSessionError = error?.message
            || "Encrypted private session storage could not be read.";
    }
    return Venue.session;
};

Venue.privatePost = async function (path, body) {
    const response = await fetch(path, {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(body),
    });
    const text = await response.text();
    if (text.length > 64 * 1024) throw new Error("Private service response is too large.");
    let value;
    try {
        value = JSON.parse(text);
    } catch {
        throw new Error("Private service returned an invalid response.");
    }
    if (!response.ok) {
        throw new Error(String(
            value?.error?.code
            || value?.error
            || "Private service refused the request.",
        ));
    }
    return value;
};

Venue.privateTicketRequest = async function ({
    method,
    path,
    capability,
    body,
    contentType,
    binary = false,
}) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(capability || ""))) {
        throw new Error("The private ticket capability is invalid.");
    }
    const headers = {
        authorization: "Bearer " + capability,
        accept: binary ? "application/octet-stream" : "application/json",
    };
    if (contentType) headers["content-type"] = contentType;
    const response = await fetch(path, {
        method,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers,
        body,
    });
    if (binary) {
        if (!response.ok) {
            throw new Error("Private ticket readback was refused.");
        }
        const declared = response.headers.get("content-length");
        if (
            declared !== null
            && Number(declared) !== PrivateTradingCrypto.TIMED_TICKET_SIZE
        ) {
            throw new Error("Private ticket readback has an invalid size.");
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length !== PrivateTradingCrypto.TIMED_TICKET_SIZE) {
            bytes.fill(0);
            throw new Error("Private ticket readback has an invalid size.");
        }
        return bytes;
    }
    const text = await response.text();
    if (text.length > 64 * 1024) {
        throw new Error("Private ticket service response is too large.");
    }
    let value;
    try {
        value = JSON.parse(text);
    } catch {
        throw new Error("Private ticket service returned an invalid response.");
    }
    if (!response.ok || value?.ok !== true || !value.result) {
        const code = String(
            value?.error?.code
            || value?.error
            || "PRIVATE_TICKET_REQUEST_REFUSED",
        );
        const error = new Error(code);
        error.code = code;
        error.status = response.status;
        throw error;
    }
    return value.result;
};

Venue.adoptPrivateCredential = async function (value, owner = Venue.account) {
    if (!owner) throw new Error("Connect the private session owner first.");
    const credential = validatePrivateCredential(value?.credential || value);
    const commitment =
        PrivateTradingCrypto.privateHolderCommitment(credential.holderSecret);
    if (commitment !== BigInt(credential.holderSecretCommitment)) {
        throw new Error("The holder credential secret does not match its commitment.");
    }
    const root = PrivateTradingCrypto.reconstructPrivateMerkleRoot(
        PrivateTradingCrypto.privateSessionLeaf(credential),
        credential.pathElements,
        credential.pathIndices,
    );
    if (root !== BigInt(credential.credentialRoot)) {
        throw new Error("The holder credential path does not match its root.");
    }
    if (!addrEq(Venue.account, owner)) {
        throw new Error("The connected wallet changed during credential import.");
    }
    await Venue.savePrivateSecretPayload({
        ...Venue._privateSecretPayload,
        credential,
    });
    return true;
};

Venue.ensurePrivateHolderCredential = async function () {
    if (Venue._privateSecretPayload?.credential) return true;
    const owner = Venue.account;
    if (!owner) return false;
    const bound = CLIENT.privateTrading?.holderCredentials?.[owner.toLowerCase()]
        || CLIENT.privateTrading?.holderCredentials?.[owner];
    if (bound) {
        await Venue.adoptPrivateCredential(bound, owner);
        return true;
    }
    try {
        const response = await fetch("/api/private/holder-credential", {
            method: "GET",
            credentials: "omit",
            cache: "no-store",
            redirect: "error",
            referrerPolicy: "no-referrer",
            headers: {
                accept: "application/json",
                "x-lattice-account": owner,
            },
        });
        const text = await response.text();
        if (!response.ok || text.length > 64 * 1024) return false;
        const value = JSON.parse(text);
        if (!addrEq(Venue.account, owner)) return false;
        await Venue.adoptPrivateCredential(value, owner);
        return true;
    } catch {
        return false;
    }
};

Venue.importPrivateCredential = async function (file) {
    await Venue.requireAccount();
    const owner = Venue.account;
    if (!file || Number(file.size || 0) > 2 * 1024 * 1024) {
        throw new Error("Choose a holder credential smaller than 2 MB.");
    }
    let value;
    try {
        value = JSON.parse(await file.text());
    } catch {
        throw new Error("The holder credential is not valid JSON.");
    }
    await Venue.adoptPrivateCredential(value, owner);
    Venue.status(
        "private-setup-status",
        "Holder credential encrypted on this device.",
        "ok",
    );
    Venue.paintPrivateSetup();
};

Venue.paintPrivateSetup = function () {
    const credential = Venue._privateSecretPayload?.credential;
    const pending = Venue._privateSessionRecords.find((item) => item.state === "PENDING");
    const session = Venue.session;
    if ($("private-step-credential")) {
        $("private-step-credential").textContent = credential
            ? "Encrypted on device"
            : "Import required";
    }
    if ($("private-step-session")) {
        $("private-step-session").textContent = session
            ? Venue.snap.sessionKyc === 1
                ? "Active · " + shortAddr(session.account)
                : "Eligibility renewal required"
            : pending
                ? "Registration pending"
                : "Not created";
    }
    const side = Number(Venue._privateSetupSide || $("side")?.value || 0);
    const needed = Venue.orderFunds(Venue.readOrder());
    const funded = session && (
        side === 1
            ? Venue.snap.sessionFree !== undefined
                && Venue.snap.sessionFree >= Venue.readOrder().qty
                && Venue.snap.sessionTinybar !== undefined
                && needed.privateRequired !== null
                && Venue.snap.sessionTinybar >= needed.privateRequired
            : Venue.snap.sessionTinybar !== undefined
                && needed.privateRequired !== null
                && Venue.snap.sessionTinybar >= needed.privateRequired
    );
    if ($("private-step-funding")) {
        $("private-step-funding").textContent = !session
            ? "Waiting for session"
            : funded
                ? "Ready for this order"
                : "Top-up required";
    }
    if ($("private-session-hbar")) {
        $("private-session-hbar").textContent = Venue.snap.sessionTinybar === undefined
            ? "Unavailable"
            : readableHbar(Venue.snap.sessionTinybar) + " HBAR";
    }
    if ($("private-session-lprc")) {
        $("private-session-lprc").textContent = Venue.snap.sessionFree === undefined
            ? "Unavailable"
            : formatQuantity(Venue.snap.sessionFree) + " LPRC";
    }
    if ($("private-credential-wrap")) {
        $("private-credential-wrap").hidden = !!credential;
    }
    const action = $("private-setup-action");
    if (!action) return;
    action.disabled = !CLIENT.privateTrading?.enabled;
    if ($("private-setup-copy") && !CLIENT.privateTrading?.enabled) {
        $("private-setup-copy").textContent = CLIENT.privateTrading?.reason
            || "Private trading is not bound on this deployment yet. Direct manual remains available.";
    }
    action.textContent = !credential
        ? "Choose holder credential"
        : !session
            ? pending
                ? "Resume private registration"
                : "Create private session"
            : Venue.snap.sessionKyc !== 1
                ? "Renew private eligibility"
                : funded
                    ? "Ready to trade"
                    : "Fund private session";
};

Venue.openPrivateSetup = async function (options = {}) {
    await Venue.requireAccount();
    const owner = Venue.account;
    Venue._privateSetupSide = Number(options.side ?? $("side")?.value ?? 0);
    await Venue.hydratePrivateState(owner);
    if (!addrEq(Venue.account, owner)) {
        throw new Error("The connected wallet changed while opening private setup.");
    }
    const modal = $("private-setup-modal");
    if (!modal) throw new Error("Private setup interface is unavailable.");
    modal.hidden = false;
    document.body.classList.add("modal-open");
    Venue.paintPrivateSetup();
    $("private-setup-action")?.focus();
    const pendingAsset = Venue.privateFundingAsset(Venue._privateSetupSide);
    const pendingNote = (Venue._privateSecretPayload?.notes || []).find((note) =>
        note.asset === pendingAsset && ["DEPOSITED", "RECOVERED"].includes(note.state));
    if (pendingNote) Venue.armPrivateFundingWatch(pendingNote, 1);
    Venue.refreshPrivateSessionRecovery().catch(() => {
        const action = $("private-session-rotate");
        if (action) {
            action.disabled = true;
            action.textContent = "Rotation check unavailable";
        }
    });
};

Venue.closePrivateSetup = function () {
    clearTimeout(Venue._privateFundingTimer);
    Venue._privateFundingTimer = null;
    const modal = $("private-setup-modal");
    if (modal) modal.hidden = true;
    if ($("withdraw-modal")?.hidden !== false) {
        document.body.classList.remove("modal-open");
    }
};

Venue.privateSessionConfig = function (record) {
    const config = CLIENT.privateTrading;
    return {
        sessionSigner: record.signer,
        recoverySigner: record.recovery,
        engine: CLIENT.addresses.MatchingEngine,
        security: CLIENT.addresses.token,
        partition: CLIENT.immutables.partition,
        router: config.addresses.SessionRecoveryRouter,
        quicknetChainHash: "0x" + PrivateTradingCrypto.QUICKNET_CHAIN_HASH,
        generation: record.generation,
        feePolicyDigest: config.session.feePolicyDigest,
    };
};

Venue.waitForPrivateSession = async function (account) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
        const [code, kyc] = await Promise.all([
            Venue.reader.getCode(account),
            Venue.c.registry.getKycStatus(account).catch(() => 0),
        ]);
        if (code !== "0x" && Number(kyc) === 1) return;
        await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error("Private session registration is still pending. You can resume safely.");
};

Venue.createOrRenewPrivateSession = async function (options = {}) {
    const owner = Venue.account;
    if (!owner) throw new Error("Connect the private session owner first.");
    const requireOwner = () => {
        if (!addrEq(Venue.account, owner)) {
            throw new Error("The connected wallet changed during private setup.");
        }
    };
    if (!Venue._privateSecretPayload?.credential) {
        await Venue.ensurePrivateHolderCredential();
    }
    const credential = Venue._privateSecretPayload?.credential;
    if (!credential) {
        $("private-credential-file")?.click();
        return null;
    }
    const contracts = Venue.privateContracts();
    if (!contracts) throw new Error("Private trading is not released.");
    const historical = options.recordAccount
        ? Venue._privateSessionRecords.find((item) =>
            item.state === "RETIRING" && addrEq(item.account, options.recordAccount))
        : null;
    if (options.recordAccount && !historical) {
        throw new Error("The retiring private session is unavailable.");
    }
    let record = historical || (Venue.session
        ? Venue._privateSessionRecords.find((item) =>
            addrEq(item.account, Venue.session.account))
        : Venue._privateSessionRecords.find((item) => item.state === "PENDING"));
    if (!record) {
        const keys = await generatePrivateSessionKeys(ethers, globalThis.crypto);
        const generation = Venue._privateSessionRecords.reduce(
            (highest, item) => Math.max(highest, Number(item.generation) || 0),
            0,
        ) + 1;
        const deploymentSalt = ethers.hexlify(
            globalThis.crypto.getRandomValues(new Uint8Array(32)),
        );
        const seed = {
            v: 1,
            generation,
            state: "PENDING",
            account: ZERO,
            signer: keys.signer,
            recovery: keys.recovery,
            sessionPrivateKey: keys.sessionPrivateKey,
            recoveryPrivateKey: keys.recoveryPrivateKey,
            deploymentSalt,
            createdAt: new Date().toISOString(),
            retiredAt: null,
        };
        const config = Venue.privateSessionConfig(seed);
        seed.account = String(
            await contracts.factory.accountAddress(config, deploymentSalt),
        ).toLowerCase();
        record = validatePrivateSession(seed, ethers);
        requireOwner();
        await Venue.savePrivateSessionRecords([
            record,
            ...Venue._privateSessionRecords.filter((item) =>
                item.state !== "PENDING" && item.state !== "ACTIVE"),
        ]);
    }

    const epoch = asBig(await Venue.c.registry.currentEpoch());
    const [root, viewEpoch, creationCodeHash, codeHashLow, codeHashHigh, minTier, mask] =
        await Promise.all([
            contracts.gate.sessionRootForEpoch(epoch),
            contracts.gate.viewKeyEpochForRotationEpoch(epoch),
            contracts.gate.sessionImplementationCodeHash(),
            contracts.gate.sessionImplementationCodeHashLow(),
            contracts.gate.sessionImplementationCodeHashHigh(),
            contracts.gate.minTier(),
            contracts.gate.jurisdictionMask(),
        ]);
    const viewKey = await contracts.gate.viewKeyForEpoch(viewEpoch);
    if (!viewKey.published || asBig(root) === 0n) {
        throw new Error("Private eligibility inputs are not published for this period.");
    }
    if (
        String(creationCodeHash).toLowerCase()
        !== String(CLIENT.privateTrading.session.creationCodeHash).toLowerCase()
    ) {
        throw new Error("Private session code does not match the released configuration.");
    }
    if (BigInt(credential.credentialRoot) !== asBig(root)) {
        throw new Error("The holder credential is not valid for this private period.");
    }

    Venue.status(
        "private-setup-status",
        "Generating two local proofs. The proving files are large and cached after first use.",
        "",
    );
    const release = CLIENT.privateTrading;
    const proofs = await PrivateTradingCrypto.createPrivateSessionProofs({
        credential,
        context: {
            credentialRoot: asBig(root).toString(),
            rotationEpoch: epoch.toString(),
            sessionAccount: BigInt(record.account).toString(),
            sessionSigner: BigInt(record.signer).toString(),
            factory: BigInt(release.addresses.SessionAccountFactory).toString(),
            implementationCodeHashLow: asBig(codeHashLow).toString(),
            implementationCodeHashHigh: asBig(codeHashHigh).toString(),
            minTier: asBig(minTier).toString(),
            jurisdictionMask: asBig(mask).toString(),
        },
        viewKey: {
            epoch: asBig(viewEpoch).toString(),
            x: asBig(viewKey.x).toString(),
            y: asBig(viewKey.y).toString(),
        },
        artifacts: {
            eligibility: release.artifacts.sessionEligibility,
            compliance: release.artifacts.sessionCompliance,
        },
        plonk: PrivateTradingCrypto.plonk,
    });
    requireOwner();
    const needsDeployment = await Venue.reader.getCode(record.account) === "0x";
    const serviceResult = await Venue.privatePost(release.services.sessions, {
        action: needsDeployment ? "deploy-and-register" : "register",
        chainId: String(CLIENT.network.chainId),
        factory: release.addresses.SessionAccountFactory,
        gate: release.addresses.DualRegistrationGate,
        registry: CLIENT.addresses.ZkKycRegistry,
        account: record.account,
        config: Venue.privateSessionConfig(record),
        deploymentSalt: record.deploymentSalt,
        ciphertext: proofs.ciphertext,
        eligibility: proofs.eligibility,
        compliance: proofs.compliance,
    });
    if (
        serviceResult.status !== "ALREADY_CONFIRMED"
        && !/^0x[0-9a-fA-F]{64}$/.test(String(serviceResult.txHash || ""))
    ) {
        throw new Error("Private registration returned no transaction receipt.");
    }
    if (serviceResult.status !== "ALREADY_CONFIRMED") {
        await Venue.waitForPrivateSession(record.account);
    }
    requireOwner();
    if (historical) {
        const renewed = {...record, state: "RETIRING"};
        await Venue.savePrivateSessionRecords(
            Venue._privateSessionRecords.map((item) =>
                addrEq(item.account, renewed.account) ? renewed : item),
        );
        await Venue.verifyPrivateSessionRecord(renewed);
        Venue.status(
            "private-setup-status",
            "Session eligibility renewed for the previous session.",
            "ok",
        );
        await Venue.refreshPrivateSessionRecovery();
        return renewed;
    }
    const active = {...record, state: "ACTIVE"};
    await Venue.savePrivateSessionRecords([
        active,
        ...Venue._privateSessionRecords.filter((item) =>
            !addrEq(item.account, active.account) && item.state !== "ACTIVE"),
    ]);
    Venue.session = await Venue.verifyPrivateSessionRecord(active);
    Venue.snap.sessionKyc = Venue.session.kycStatus;
    await Venue.refreshTrade();
    Venue.status("private-setup-status", "Private session is active.", "ok");
    Venue.paintPrivateSetup();
    await Venue.refreshPrivateSessionRecovery().catch(() => {});
    return Venue.session;
};

Venue.privateSessionOpenOrderCount = async function (record) {
    if (!record || !Venue.account) return 0;
    const tickets = Venue.ticketList(Venue.account).filter((ticket) =>
        ticket.path === "private"
        && addrEq(ticket.committer, record.account)
        && !ticket.cancelled);
    const open = await Promise.all(tickets.map(async (ticket) => {
        const commitment = await Venue.c.engine.commitments(ticket.id);
        if (
            commitment.cancelled
            || !commitment.committer
            || addrEq(commitment.committer, ZERO)
        ) {
            return false;
        }
        if (!addrEq(commitment.committer, record.account)) {
            throw new Error("A saved private order has an unexpected on-chain owner.");
        }
        if (!commitment.revealed) return true;
        const order = await Venue.c.engine.orders(ticket.id);
        return !order.retired;
    }));
    return open.filter(Boolean).length;
};

Venue.privateSessionRetirementState = async function (record) {
    const release = CLIENT.privateTrading;
    if (!record || !release) throw new Error("Private session recovery is unavailable.");
    const [lprc, native, credit, kyc, openOrders] = await Promise.all([
        Venue.c.token.balanceOfByPartition(CLIENT.immutables.partition, record.account),
        Venue.reader.getBalance(record.account),
        Venue.c.engine.credit(record.account),
        Venue.c.registry.getKycStatus(record.account),
        Venue.privateSessionOpenOrderCount(record),
    ]);
    const hbar = fromWeibar(asBig(native));
    const hbarDenomination = asBig(release.routing.HBAR.denomination);
    const lprcDenomination = asBig(release.routing.LPRC.denomination);
    return {
        account: record.account,
        hbar,
        lprc: asBig(lprc),
        credit: asBig(credit),
        kyc: Number(kyc),
        openOrders,
        hbarNotes: hbarDenomination === 0n ? 0n : hbar / hbarDenomination,
        lprcNotes: lprcDenomination === 0n ? 0n : asBig(lprc) / lprcDenomination,
    };
};

Venue.refreshPrivateSessionRecovery = async function () {
    const detail = $("private-session-management");
    const list = $("private-session-history");
    const rotate = $("private-session-rotate");
    if (!detail || !list || !rotate || !Venue.account) return;
    const activeRecord = Venue.session && Venue._privateSessionRecords.find((record) =>
        record.state === "ACTIVE" && addrEq(record.account, Venue.session.account));
    const retiring = Venue._privateSessionRecords.filter((record) =>
        record.state === "RETIRING");
    detail.hidden = !activeRecord && retiring.length === 0;
    rotate.hidden = !activeRecord;
    rotate.disabled = true;
    rotate.textContent = activeRecord ? "Checking rotation safety" : "Rotate session";

    let activeState = null;
    if (activeRecord) {
        activeState = await Venue.privateSessionRetirementState(activeRecord);
        const blocked = activeState.openOrders > 0 || activeState.credit > 0n;
        rotate.disabled = blocked;
        rotate.textContent = blocked
            ? activeState.openOrders > 0
                ? "Finish active orders before rotating"
                : "Release trading credit before rotating"
            : "Rotate session";
        rotate.title = blocked
            ? "Rotation cannot move an order that is still sealed, revealed, or holding engine credit."
            : "Creates a fresh unlinking session. Fixed balances remain recoverable through the privacy pool.";
    }

    const states = await Promise.all(retiring.map(async (record) => ({
        record,
        state: await Venue.privateSessionRetirementState(record),
    })));
    Venue._privateRetirementStates = new Map(states.map(({record, state}) => [
        record.account.toLowerCase(),
        state,
    ]));
    list.innerHTML = states.length === 0
        ? '<p class="private-session-empty">No previous session needs recovery.</p>'
        : states.map(({record, state}) => {
            const canRecoverAssets = state.openOrders === 0 && state.credit === 0n;
            const actions = [];
            if (canRecoverAssets && state.hbarNotes > 0n) {
                actions.push(
                    '<button type="button" data-private-recover="HBAR" data-session="' +
                    esc(record.account) + '">Recover one HBAR note</button>',
                );
            }
            if (canRecoverAssets && state.lprcNotes > 0n && state.kyc === 1) {
                actions.push(
                    '<button type="button" data-private-recover="LPRC" data-session="' +
                    esc(record.account) + '">Recover one LPRC note</button>',
                );
            }
            if (state.kyc !== 1) {
                actions.push(
                    '<button type="button" data-private-renew data-session="' +
                    esc(record.account) + '">Renew session eligibility</button>',
                );
            }
            const blocker = state.openOrders > 0
                ? state.openOrders + " active order" +
                    (state.openOrders === 1 ? "" : "s") + " must finish first."
                : state.credit > 0n
                    ? "Release this session's engine credit before asset recovery."
                    : state.lprcNotes > 0n && state.kyc !== 1
                        ? "Renew this session's eligibility before moving LPRC."
                    : state.kyc !== 1
                        ? "Renew eligibility for this previous session. It does not become the active trading session."
                    : actions.length === 0
                        ? state.hbar > 0n || state.lprc > 0n
                            ? "The remainder is below a fixed denomination and stays visible in this session."
                            : "All recoverable balances have moved."
                        : "Recovery is relayed. The connected wallet does not send the transaction.";
            return '<article class="private-session-history-row"><div><strong>Generation ' +
                esc(record.generation) + ' · ' + esc(shortAddr(record.account)) +
                '</strong><span>' + esc(readableHbar(state.hbar)) + ' HBAR · ' +
                esc(formatQuantity(state.lprc)) + ' LPRC</span><small>' +
                esc(blocker) + '</small></div><div class="private-session-history-actions">' +
                actions.join("") +
                "</div></article>";
        }).join("");
    if (activeState && $("private-session-management-copy")) {
        $("private-session-management-copy").textContent =
            "Rotation creates a fresh public session after this device's orders and engine credit " +
            "finish. Fixed-pool recovery avoids a wallet transaction, but timing and low traffic " +
            "can still correlate the old and new sessions.";
    }
};

Venue.rotatePrivateSession = async function () {
    await Venue.requireAccount();
    const action = $("private-session-rotate");
    const active = Venue.session && Venue._privateSessionRecords.find((record) =>
        record.state === "ACTIVE" && addrEq(record.account, Venue.session.account));
    if (!active) throw new Error("There is no active private session to rotate.");
    const state = await Venue.privateSessionRetirementState(active);
    if (state.openOrders > 0) {
        throw new Error("Finish or cancel every active order before rotating this session.");
    }
    if (state.credit > 0n) {
        throw new Error("Release all engine credit before rotating this session.");
    }
    if (action?.dataset.confirm !== "1") {
        if (action) {
            action.dataset.confirm = "1";
            action.textContent = "Confirm new session";
            clearTimeout(Venue._privateRotationConfirmTimer);
            Venue._privateRotationConfirmTimer = setTimeout(() => {
                delete action.dataset.confirm;
                Venue.refreshPrivateSessionRecovery().catch(() => {});
            }, 10_000);
        }
        Venue.status(
            "private-setup-status",
            "A fresh session improves unlinking. Existing fixed balances stay recoverable.",
            "",
        );
        return null;
    }
    clearTimeout(Venue._privateRotationConfirmTimer);
    delete action.dataset.confirm;
    const retiring = {
        ...active,
        state: "RETIRING",
        retiredAt: new Date().toISOString(),
    };
    const history = Venue._privateSessionRecords.filter((record) =>
        !addrEq(record.account, active.account) && record.state !== "PENDING");
    while (history.length > PRIVATE_SESSION_MAX_HISTORY - 2) {
        const oldestRecovered = history
            .map((record, index) => ({record, index}))
            .filter(({record}) => record.state === "RECOVERED")
            .sort((left, right) =>
                Date.parse(left.record.retiredAt || left.record.createdAt)
                - Date.parse(right.record.retiredAt || right.record.createdAt))[0];
        if (!oldestRecovered) {
            throw new Error(
                "Recover a previous session before creating more session history.",
            );
        }
        history.splice(oldestRecovered.index, 1);
    }
    await Venue.savePrivateSessionRecords([
        retiring,
        ...history,
    ]);
    Venue.session = null;
    delete Venue.snap.sessionKyc;
    delete Venue.snap.sessionFree;
    delete Venue.snap.sessionTinybar;
    Venue.paintPrivateSetup();
    const next = await Venue.createOrRenewPrivateSession();
    await Venue.refreshPrivateSessionRecovery();
    return next;
};

Venue.renewRetiringPrivateSession = async function (account) {
    await Venue.requireAccount();
    const record = Venue._privateSessionRecords.find((item) =>
        item.state === "RETIRING" && addrEq(item.account, account));
    if (!record) throw new Error("The retiring private session is unavailable.");
    Venue.status(
        "private-setup-status",
        "Generating current session eligibility locally.",
        "",
    );
    return Venue.createOrRenewPrivateSession({
        recordAccount: record.account,
    });
};

Venue.recoverRetiringSessionAsset = async function (account, asset) {
    if (Venue._privateRecoveryBusy) return null;
    await Venue.requireAccount();
    const record = Venue._privateSessionRecords.find((item) =>
        item.state === "RETIRING" && addrEq(item.account, account));
    if (!record) throw new Error("The retiring private session is unavailable.");
    if (!Venue.session || addrEq(Venue.session.account, record.account)) {
        throw new Error("Create the new private session before recovering the old one.");
    }
    const state = await Venue.privateSessionRetirementState(record);
    if (state.openOrders > 0 || state.credit > 0n) {
        throw new Error("Finish old orders and release engine credit before recovery.");
    }
    const context = await Venue.privateRoutingContext(asset);
    if (context.symbol === "LPRC" && state.kyc !== 1) {
        throw new Error("Renew this previous session before recovering LPRC.");
    }
    const available = context.symbol === "HBAR" ? state.hbar : state.lprc;
    if (available < context.denomination) {
        throw new Error("No full fixed-denomination " + context.symbol + " note is recoverable.");
    }
    Venue._privateRecoveryBusy = true;
    try {
        const note = await Venue.preparePrivateRoutingNote(context, {fresh: true});
        const session = Venue.privateContracts().session(record.account);
        const nonce = asBig(await session.recoveryNonce());
        const digest = await session.recoveryAuthorizationDigest(
            context.asset,
            context.denomination,
            note.commitment,
            nonce,
        );
        const recoveryWallet = new ethers.Wallet(record.recoveryPrivateKey);
        const signature = recoveryWallet.signingKey.sign(digest).serialized;
        if (!addrEq(ethers.recoverAddress(digest, signature), record.recovery)) {
            throw new Error("Private recovery authorization failed local verification.");
        }
        Venue.status(
            "private-setup-status",
            "Relaying one fixed " + context.symbol + " recovery note.",
            "",
        );
        const result = await Venue.privatePost(CLIENT.privateTrading.services.sessions, {
            action: "recover-to-router",
            chainId: String(CLIENT.network.chainId),
            account: record.account,
            asset: context.symbol,
            amount: context.denomination.toString(),
            noteCommitment: note.commitment,
            nonce: nonce.toString(),
            signature,
        });
        const transactionHash = String(result?.txHash || "");
        if (
            result?.status !== "CONFIRMED"
            || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)
        ) {
            throw new Error("Private session recovery returned no confirmed receipt.");
        }
        const receipt = await Venue.reader.waitForTransaction(
            transactionHash,
            1,
            120_000,
        );
        if (!receipt || Number(receipt.status) !== 1) {
            throw new Error("Private session recovery was not confirmed on Hedera.");
        }
        let deposited = null;
        for (const log of receipt.logs || []) {
            if (!addrEq(log.address, context.pool)) continue;
            try {
                const parsed = context.router.interface.parseLog(log);
                if (
                    parsed?.name === "Deposited"
                    && asBig(parsed.args.commitment) === BigInt(note.commitment)
                ) {
                    deposited = parsed.args;
                    break;
                }
            } catch { /* another pool event */ }
        }
        if (
            !deposited
            || !addrEq(deposited.depositor, record.account)
            || !addrEq(deposited.asset, context.asset)
            || asBig(deposited.denomination) !== context.denomination
        ) {
            throw new Error("Private recovery receipt does not match the expected note.");
        }
        const saved = {
            ...note,
            state: "RECOVERED",
            leafIndex: asBig(deposited.leafIndex).toString(),
            depositRoot: asBig(deposited.root).toString(),
            depositTx: transactionHash,
        };
        await Venue.savePrivateRoutingNote(saved);
        const remaining = await Venue.privateSessionRetirementState(record);
        if (
            remaining.openOrders === 0
            && remaining.credit === 0n
            && remaining.hbar === 0n
            && remaining.lprc === 0n
        ) {
            await Venue.savePrivateSessionRecords(
                Venue._privateSessionRecords.map((item) =>
                    addrEq(item.account, record.account)
                        ? {...item, state: "RECOVERED"}
                        : item),
            );
        }
        Venue.status(
            "private-setup-status",
            context.symbol + " is in the privacy pool and will route to the new session after its delay.",
            "ok",
        );
        Venue.armPrivateFundingWatch(saved, 1);
        await Venue.refreshPrivateSessionRecovery();
        return receipt;
    } finally {
        Venue._privateRecoveryBusy = false;
    }
};

Venue.privateFundingAsset = function (side = Venue._privateSetupSide) {
    if (!Venue.session) return null;
    const order = Venue.readOrder();
    const funds = Venue.orderFunds(order);
    if (
        Number(side) === 1
        && (
            Venue.snap.sessionFree === undefined
            || Venue.snap.sessionFree < order.qty
        )
    ) {
        return "LPRC";
    }
    if (
        Venue.snap.sessionTinybar === undefined
        || funds.privateRequired === null
        || Venue.snap.sessionTinybar < funds.privateRequired
    ) {
        return "HBAR";
    }
    return null;
};

Venue.savePrivateRoutingNote = async function (nextNote) {
    const notes = [
        nextNote,
        ...(Venue._privateSecretPayload?.notes || []).filter((note) =>
            String(note.commitment) !== String(nextNote.commitment)),
    ];
    return Venue.savePrivateSecretPayload({
        ...Venue._privateSecretPayload,
        notes,
    });
};

Venue.privateRoutingContext = async function (asset, runner = Venue.reader) {
    const release = CLIENT.privateTrading;
    const contracts = Venue.privateContracts(runner);
    if (!release || !contracts) throw new Error("Private routing is not released.");
    const symbol = String(asset || "").toUpperCase();
    const pool = symbol === "HBAR"
        ? release.addresses.HbarRouter
        : symbol === "LPRC"
            ? release.addresses.LprcRouter
            : null;
    if (!pool) throw new Error("Private routing asset is unavailable.");
    const router = contracts.router(symbol);
    const [onChainAsset, denomination, chainId] = await Promise.all([
        router.asset(),
        router.denomination(),
        router.deploymentChainId(),
    ]);
    const expectedAsset = symbol === "HBAR" ? ZERO : CLIENT.addresses.token;
    const releasedDenomination = asBig(release.routing?.[symbol]?.denomination);
    if (
        !addrEq(onChainAsset, expectedAsset)
        || asBig(denomination) !== releasedDenomination
        || asBig(chainId) !== BigInt(CLIENT.network.chainId)
    ) {
        throw new Error("Private routing does not match the released configuration.");
    }
    return {
        symbol,
        pool: ethers.getAddress(pool),
        asset: ethers.getAddress(expectedAsset),
        denomination: asBig(denomination),
        chainId: asBig(chainId),
        router,
    };
};

Venue.preparePrivateRoutingNote = async function (context, options = {}) {
    const reusableStates = options.fresh
        ? ["PREPARED"]
        : ["PREPARED", "DEPOSITED", "RECOVERED"];
    const existing = (Venue._privateSecretPayload?.notes || []).find((note) =>
        note.asset === context.symbol
        && addrEq(note.pool, context.pool)
        && reusableStates.includes(note.state));
    if (existing) return existing;
    const note = {
        v: 1,
        asset: context.symbol,
        state: "PREPARED",
        pool: context.pool,
        denomination: context.denomination.toString(),
        commitment: "0",
        noteSecret: PrivateTradingCrypto.randomPrivateField().toString(),
        noteNullifier: PrivateTradingCrypto.randomPrivateField().toString(),
        fundingTag: PrivateTradingCrypto.randomPrivateField().toString(),
        leafIndex: null,
        depositRoot: null,
        depositTx: null,
        createdAt: new Date().toISOString(),
        spentAt: null,
    };
    note.commitment = PrivateTradingCrypto.privateRouterNoteCommitment(note, {
        chainId: context.chainId.toString(),
        pool: BigInt(context.pool).toString(),
        asset: BigInt(context.asset).toString(),
        denomination: context.denomination.toString(),
    }).toString();
    await Venue.savePrivateRoutingNote(note);
    return note;
};

Venue.depositPrivateRoutingNote = async function (note, context) {
    if (note.state !== "PREPARED") return note;
    await Venue.requireAccount();
    let token = null;
    let approvalRequired = false;
    if (context.symbol === "LPRC") {
        if (Venue.snap.free === undefined) {
            throw new Error("The wallet LPRC balance is unavailable.");
        }
        if (Venue.snap.free < context.denomination) {
            throw new Error(
                "The wallet does not hold the fixed LPRC routing denomination.",
            );
        }
        token = new ethers.Contract(
            CLIENT.addresses.token,
            [
                "function allowance(address owner,address spender) view returns (uint256)",
                "function approve(address spender,uint256 amount) returns (bool)",
            ],
            Venue.signer,
        );
        const allowance = asBig(await token.allowance(Venue.account, context.pool));
        approvalRequired = allowance < context.denomination;
    }
    if (
        Venue.snap.walletTinybar === undefined
        || Venue.snap.gasPriceWei === undefined
    ) {
        throw new Error("The wallet HBAR balance and network fee quote are required.");
    }
    const gasUnits = context.symbol === "HBAR"
        ? PRIVATE_HBAR_DEPOSIT_GAS
        : PRIVATE_LPRC_DEPOSIT_GAS + (approvalRequired ? PRIVATE_LPRC_APPROVE_GAS : 0n);
    const networkFee = (
        gasUnits * asBig(Venue.snap.gasPriceWei) + 9_999_999_999n
    ) / 10_000_000_000n;
    const requiredHbar = networkFee
        + (context.symbol === "HBAR" ? context.denomination : 0n);
    if (Venue.snap.walletTinybar < requiredHbar) {
        throw new Error(
            "The wallet needs at least " + readableHbar(requiredHbar) +
            " HBAR for this fixed deposit and its network fee.",
        );
    }
    if (approvalRequired) {
        Venue.tradeTxStage("approval", "Approve private LPRC deposit");
        const approved = await Venue.send(
            () => token.approve(
                context.pool,
                context.denomination,
                {gasLimit: 250_000},
            ),
            "Approve private LPRC deposit",
        );
        if (!approved) return null;
    }

    const router = Venue.privateContracts(Venue.signer).router(context.symbol);
    const receipt = await Venue.send(
        () => context.symbol === "HBAR"
            ? router.deposit(note.commitment, {
                value: toWeibar(context.denomination),
                gasLimit: Number(PRIVATE_HBAR_DEPOSIT_GAS),
            })
            : router.deposit(note.commitment, {
                gasLimit: Number(PRIVATE_LPRC_DEPOSIT_GAS),
            }),
        "Add fixed private " + context.symbol + " deposit",
    );
    if (!receipt) return null;
    let deposited = null;
    for (const log of receipt.logs || []) {
        if (!addrEq(log.address, context.pool)) continue;
        try {
            const parsed = router.interface.parseLog(log);
            if (
                parsed?.name === "Deposited"
                && asBig(parsed.args.commitment) === BigInt(note.commitment)
            ) {
                deposited = parsed.args;
                break;
            }
        } catch { /* another pool event */ }
    }
    if (!deposited || !addrEq(deposited.depositor, Venue.account)) {
        throw new Error("The private deposit receipt could not be verified.");
    }
    const saved = {
        ...note,
        state: "DEPOSITED",
        leafIndex: asBig(deposited.leafIndex).toString(),
        depositRoot: asBig(deposited.root).toString(),
        depositTx: receipt.hash,
    };
    await Venue.savePrivateRoutingNote(saved);
    return saved;
};

Venue.privateRoutingLeaves = async function (router, leafIndex) {
    const total = Number(leafIndex) + 1;
    if (!Number.isSafeInteger(total) || total < 1 || total > 1 << 20) {
        throw new Error("Private routing leaf index is invalid.");
    }
    const leaves = [];
    for (let start = 0; start < total; start += 256) {
        const count = Math.min(256, total - start);
        const page = await router.commitmentRange(start, count);
        if (!Array.isArray(page) || page.length !== count) {
            throw new Error("Private routing history is incomplete.");
        }
        leaves.push(...page.map((value) => asBig(value)));
    }
    return leaves;
};

Venue.armPrivateFundingWatch = function (note, seconds = 15) {
    clearTimeout(Venue._privateFundingTimer);
    const owner = Venue.account;
    Venue._privateFundingTimer = setTimeout(async () => {
        if (
            $("private-setup-modal")?.hidden !== false
            || Venue._privateRouteBusy
            || !Venue.session
            || !addrEq(Venue.account, owner)
        ) {
            return;
        }
        try {
            const context = await Venue.privateRoutingContext(note.asset);
            await Venue.completePrivateRoutingNote(note, context);
        } catch {
            Venue.status(
                "private-setup-status",
                "The private top-up is safe. Resume when the route is available.",
                "",
            );
        }
    }, Math.max(1, Number(seconds)) * 1000);
};

Venue.selectPrivateRoutingRoot = async function (note, context) {
    const [totalRaw, minimumRaw, delayRaw] = await Promise.all([
        context.router.nextLeafIndex(),
        context.router.minimumRealNotes(),
        context.router.minimumWithdrawalDelay(),
    ]);
    const total = Number(asBig(totalRaw));
    const minimum = Number(asBig(minimumRaw));
    const first = Math.max(Number(note.leafIndex) + 1, minimum);
    if (
        !Number.isSafeInteger(total)
        || !Number.isSafeInteger(first)
        || first < 1
        || first > total
    ) {
        throw new Error("This deposit has not reached the released privacy set.");
    }
    const delay = asBig(delayRaw);
    const cutoff = nowSec() > delay ? nowSec() - delay : 0n;
    let low = first;
    let high = total;
    let selected = null;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const root = await context.router.rootAtNoteCount(middle);
        const metadata = await context.router.rootMetadata(root);
        if (metadata.known && asBig(metadata.acceptedAt) <= cutoff) {
            selected = {root: asBig(root), metadata};
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    if (!selected) {
        const firstRoot = await context.router.rootAtNoteCount(first);
        const firstMetadata = await context.router.rootMetadata(firstRoot);
        return {
            ready: false,
            availableAt: asBig(firstMetadata.acceptedAt) + delay,
        };
    }
    if (
        asBig(selected.metadata.realNotes) < BigInt(minimum)
        || asBig(selected.metadata.independentFunders) < BigInt(minimum)
    ) {
        throw new Error("This deposit has not reached the released privacy set.");
    }
    return {
        ready: true,
        root: selected.root,
        metadata: selected.metadata,
    };
};

Venue.completePrivateRoutingNote = async function (note, context) {
    if (!note || !["DEPOSITED", "RECOVERED"].includes(note.state)) return false;
    if (Venue._privateRouteBusy) return false;
    const owner = Venue.account;
    const recipient = Venue.session?.account;
    if (!owner || !recipient) throw new Error("The private session is unavailable.");
    Venue._privateRouteBusy = true;
    try {
        const selected = await Venue.selectPrivateRoutingRoot(note, context);
        if (!selected.ready) {
            const remaining = selected.availableAt > nowSec()
                ? selected.availableAt - nowSec()
                : 1n;
            Venue.status(
                "private-setup-status",
                "Deposit confirmed. Private routing unlocks in " + fmtRemain(remaining) + ".",
                "ok",
            );
            Venue.armPrivateFundingWatch(note, Math.min(30, Number(remaining + 1n)));
            return false;
        }

        Venue.status(
            "private-setup-status",
            "Generating the private routing proof on this device.",
            "",
        );
        if (!addrEq(Venue.account, owner) || !addrEq(Venue.session?.account, recipient)) {
            throw new Error("The active private session changed during routing.");
        }
        const leaves = await Venue.privateRoutingLeaves(
            context.router,
            Number(asBig(selected.metadata.realNotes)) - 1,
        );
        const path = PrivateTradingCrypto.buildPrivateMerklePath(
            leaves,
            Number(note.leafIndex),
            20,
        );
        if (path.root !== selected.root) {
            throw new Error("Private routing history does not match the deposit root.");
        }
        const [viewEpoch, viewX, viewY] = await Promise.all([
            context.router.activeViewKeyEpoch(),
            context.router.activeViewKeyX(),
            context.router.activeViewKeyY(),
        ]);
        const release = CLIENT.privateTrading;
        const proof = await PrivateTradingCrypto.createPrivateRoutingProofs({
            note,
            path,
            context: {
                root: selected.root.toString(),
                recipient: BigInt(recipient).toString(),
                pool: BigInt(context.pool).toString(),
                asset: BigInt(context.asset).toString(),
                denomination: context.denomination.toString(),
                chainId: context.chainId.toString(),
            },
            viewKey: {
                epoch: asBig(viewEpoch).toString(),
                x: asBig(viewX).toString(),
                y: asBig(viewY).toString(),
            },
            artifacts: {
                withdrawal: release.artifacts.routingWithdrawal,
                compliance: release.artifacts.routingCompliance,
            },
            plonk: PrivateTradingCrypto.plonk,
        });
        if (!addrEq(Venue.account, owner) || !addrEq(Venue.session?.account, recipient)) {
            throw new Error("The active private session changed during routing.");
        }
        const result = await Venue.privatePost(release.services.routing, {
            action: "route-withdrawal",
            chainId: String(CLIENT.network.chainId),
            pool: context.pool,
            recipient,
            asset: context.symbol,
            denomination: context.denomination.toString(),
            root: selected.root.toString(),
            ciphertext: proof.ciphertext,
            withdrawal: proof.withdrawal,
            compliance: proof.compliance,
        });
        const transactionHash = String(
            result?.txHash || result?.transactionHash || "",
        );
        if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
            throw new Error("Private routing returned no transaction receipt.");
        }
        const receipt = await Venue.reader.waitForTransaction(transactionHash, 1, 120_000);
        if (!receipt || Number(receipt.status) !== 1) {
            throw new Error("Private routing was not confirmed.");
        }
        if (!await context.router.nullifierSpent(toHexWord(proof.nullifier))) {
            throw new Error("Private routing confirmation did not spend the expected note.");
        }
        await Venue.savePrivateRoutingNote({
            ...note,
            state: "SPENT",
            spentAt: new Date().toISOString(),
        });
        await Venue.refreshTrade();
        Venue.status(
            "private-setup-status",
            context.symbol + " reached the private session.",
            "ok",
        );
        Venue.paintPrivateSetup();
        return true;
    } finally {
        Venue._privateRouteBusy = false;
    }
};

Venue.fundPrivateSession = async function (side) {
    await Venue.requireAccount();
    if (!Venue.session || Venue.snap.sessionKyc !== 1) {
        throw new Error("Create or renew the private session first.");
    }
    const asset = Venue.privateFundingAsset(side);
    if (!asset) {
        Venue.closePrivateSetup();
        Venue.paintTicket();
        return;
    }
    const context = await Venue.privateRoutingContext(asset);
    let note = await Venue.preparePrivateRoutingNote(context);
    if (note.state === "PREPARED") {
        Venue.status(
            "private-setup-status",
            "Confirm one fixed " + asset + " privacy-pool deposit.",
            "",
        );
        note = await Venue.depositPrivateRoutingNote(note, context);
        if (!note) return;
    }
    await Venue.completePrivateRoutingNote(note, context);
};

Venue.pendingPrivateTicket = function (order) {
    return Venue.ticketList(Venue.account).find((ticket) =>
        ticket.path === "private"
        && !ticket.committedAt
        && !["ABANDONED", "CANCELLED", "REVEALED"].includes(ticket.serviceState)
        && addrEq(ticket.committer, Venue.session?.account)
        && Number(ticket.side) === Number(order.side)
        && BigInt(ticket.price) === order.price
        && BigInt(ticket.qty) === order.qty
        && String(ticket.salt).toLowerCase() === String(order.salt).toLowerCase());
};

Venue.privateTicketUrl = function (ticketId, action = "") {
    const base = String(CLIENT.privateTrading?.services?.tickets || "")
        .replace(/\/+$/, "");
    if (!base.startsWith("/api/")) {
        throw new Error("Private ticket service is not configured.");
    }
    return base + (ticketId ? "/" + ticketId : "") + (action ? "/" + action : "");
};

Venue.privateOrderUrl = function (ticketId, action) {
    const base = String(CLIENT.privateTrading?.services?.orders || "")
        .replace(/\/+$/, "");
    if (!base.startsWith("/api/") || !ticketId || !action) {
        throw new Error("Private order relay is not configured.");
    }
    return base + "/" + ticketId + "/" + action;
};

Venue.readPrivateTicketSummary = function (ticket) {
    return Venue.privateTicketRequest({
        method: "GET",
        path: Venue.privateTicketUrl(ticket.timedTicketId),
        capability: ticket.timedTicketCapability,
    });
};

Venue.assertPrivateTicketSummary = function (ticket, summary) {
    if (
        String(summary?.ticketId || "") !== ticket.timedTicketId
        || String(summary?.engine || "").toLowerCase()
            !== String(CLIENT.addresses.MatchingEngine).toLowerCase()
        || String(summary?.sessionAccount || "").toLowerCase()
            !== String(ticket.committer).toLowerCase()
        || String(summary?.engineCommitment || "").toLowerCase()
            !== String(ticket.id).toLowerCase()
        || String(summary?.envelopeDigest || "").toLowerCase()
            !== String(ticket.envelopeDigest).toLowerCase()
        || String(summary?.targetRound || "") !== String(ticket.releaseRound)
    ) {
        throw new Error("Private ticket service context does not match this order.");
    }
    return summary;
};

Venue.stagePrivateTicket = async function (ticket, envelope) {
    if (!addrEq(Venue.account, ticket.walletOwner)) {
        throw new Error("The connected wallet changed during ticket custody.");
    }
    const staged = await Venue.privateTicketRequest({
        method: "POST",
        path: Venue.privateTicketUrl(),
        capability: ticket.timedTicketCapability,
        body: envelope,
        contentType: "application/octet-stream",
    });
    Venue.assertPrivateTicketSummary(ticket, staged);
    const readback = await Venue.privateTicketRequest({
        method: "GET",
        path: Venue.privateTicketUrl(ticket.timedTicketId, "envelope"),
        capability: ticket.timedTicketCapability,
        binary: true,
    });
    try {
        if (
            readback.length !== envelope.length
            || readback.some((value, index) => value !== envelope[index])
        ) {
            throw new Error("Private ticket bytes did not survive exact readback.");
        }
        await PrivateTradingCrypto.parseTimedTicketEnvelope(readback, {
            expected: {
                engine: CLIENT.addresses.MatchingEngine,
                sessionAccount: ticket.committer,
                envelopeId: "0x" + ticket.timedTicketId,
                engineCommitment: ticket.id,
                targetRound: BigInt(ticket.releaseRound),
            },
        });
    } finally {
        readback.fill(0);
    }
    const stored = {
        ...ticket,
        automationState: "Stored",
        serviceState: "PREARMED",
    };
    if (!addrEq(Venue.account, ticket.walletOwner)) {
        throw new Error("The connected wallet changed during ticket custody.");
    }
    await Venue.upsertTicket(Venue.account, stored);
    return stored;
};

Venue.createPrivateTicket = async function (order) {
    const owner = Venue.account;
    const sessionAccount = Venue.session?.account;
    if (!owner || !sessionAccount) {
        throw new Error("The active private session is unavailable.");
    }
    const latest = await Venue.reader.getBlock("latest");
    if (!latest || !Number.isSafeInteger(latest.timestamp)) {
        throw new Error("The Hedera network clock is unavailable.");
    }
    const selected = PrivateTradingCrypto.selectSafeTargetRound({
        commitTime: BigInt(latest.timestamp) + 30n,
        revealDelay: BigInt(CLIENT.immutables.revealDelay),
        revealWindow: BigInt(CLIENT.immutables.revealWindow),
    });
    const provider = new PrivateTradingCrypto.QuicknetLockedKeyProvider();
    Venue.status(
        "trade-status",
        "Encrypting a fixed private ticket and verifying the release network.",
        "",
    );
    const made = await PrivateTradingCrypto.createTimedTicketEnvelope({
        engine: CLIENT.addresses.MatchingEngine,
        sessionAccount,
        targetRound: selected.targetRound,
        secret: {
            side: order.side,
            price: order.price,
            quantity: order.qty,
            randomSalt: order.salt,
        },
        generation: BigInt(Venue.session.generation),
        feePolicyDigest: CLIENT.privateTrading.session.feePolicyDigest,
        lockedKeyProvider: provider,
    });
    const capability = PrivateTradingCrypto.generateTimedTicketCapability();
    try {
        if (!addrEq(Venue.account, owner) || !addrEq(Venue.session?.account, sessionAccount)) {
            throw new Error("The active private session changed during ticket creation.");
        }
        const ticket = ticketRecord({
            v: TICKET_VER,
            path: "private",
            automaticReveal: true,
            committer: sessionAccount,
            walletOwner: owner,
            side: order.side,
            price: order.price.toString(),
            qty: order.qty.toString(),
            salt: order.salt,
            id: made.engineCommitment,
            holdId: null,
            committedAt: null,
            commitTx: null,
            savedAt: new Date().toISOString(),
            envelopeDigest: made.envelopeDigest,
            releaseRound: made.targetRound.toString(),
            releaseAt: made.targetTime.toString(),
            generation: made.generation.toString(),
            feePolicyDigest: made.feePolicyDigest,
            timedTicketId: made.envelopeId.slice(2).toLowerCase(),
            timedTicketCapability: capability,
            automationState: "Stored locally",
            serviceState: "LOCAL",
        }, owner);
        await Venue.upsertTicket(owner, ticket);
        return await Venue.stagePrivateTicket(ticket, made.envelope);
    } finally {
        made.envelope.fill(0);
    }
};

Venue.privateSessionSigningRecord = function (account = Venue.session?.account) {
    const record = Venue._privateSessionRecords.find((item) =>
        ["ACTIVE", "RETIRING"].includes(item.state) && addrEq(item.account, account));
    if (
        !record
        || !/^0x[0-9a-fA-F]{64}$/.test(String(record.sessionPrivateKey || ""))
    ) {
        throw new Error("The encrypted private session signing key is unavailable.");
    }
    return record;
};

Venue.relayPrivatePlacement = async function (ticket) {
    if (
        !addrEq(Venue.account, ticket.walletOwner)
        || !addrEq(Venue.session?.account, ticket.committer)
    ) {
        throw new Error("The active private session changed before placement.");
    }
    Venue.assertPrivateTicketSummary(
        ticket,
        await Venue.readPrivateTicketSummary(ticket),
    );
    const signingRecord = Venue.privateSessionSigningRecord();
    const session = Venue.privateContracts().session(ticket.committer);
    const digest = await session.placeAuthorizationDigest(
        ticket.id,
        ticket.envelopeDigest,
        ticket.releaseRound,
    );
    const signingWallet = new ethers.Wallet(signingRecord.sessionPrivateKey);
    if (!addrEq(signingWallet.address, Venue.session.signer)) {
        throw new Error("The private session signing key does not match the session.");
    }
    const signature = signingWallet.signingKey.sign(digest).serialized;
    if (!addrEq(ethers.recoverAddress(digest, signature), Venue.session.signer)) {
        throw new Error("Private placement authorization failed local verification.");
    }
    const result = await Venue.privateTicketRequest({
        method: "POST",
        path: Venue.privateOrderUrl(ticket.timedTicketId, "place"),
        capability: ticket.timedTicketCapability,
        contentType: "application/json",
        body: JSON.stringify({
            commitment: ticket.id,
            envelopeDigest: ticket.envelopeDigest,
            feePolicyDigest: ticket.feePolicyDigest,
            generation: ticket.generation,
            quicknetRound: ticket.releaseRound,
            signature,
        }),
    });
    const transactionHash = String(result?.transactionHash || "");
    if (
        result?.status !== "CONFIRMED"
        || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)
    ) {
        throw new Error("Private placement did not return a confirmed receipt.");
    }
    const receipt = await Venue.reader.waitForTransaction(transactionHash, 1, 120_000);
    if (!receipt || Number(receipt.status) !== 1) {
        throw new Error("Private placement was not confirmed on Hedera.");
    }
    const [commitment, block] = await Promise.all([
        Venue.c.engine.commitments(ticket.id),
        Venue.reader.getBlock(receipt.blockNumber),
    ]);
    if (
        !addrEq(commitment.committer, ticket.committer)
        || asBig(commitment.committedAt) === 0n
        || !block
    ) {
        throw new Error("Private placement receipt does not match the sealed order.");
    }
    const committed = {
        ...ticket,
        committedAt: asBig(commitment.committedAt).toString(),
        commitTx: transactionHash,
        automationState: "Auto reveal scheduled",
        serviceState: "PLACED",
    };
    if (
        !addrEq(Venue.account, ticket.walletOwner)
        || !addrEq(Venue.session?.account, ticket.committer)
    ) {
        throw new Error("The active private session changed while placing.");
    }
    await Venue.upsertTicket(Venue.account, committed);
    return committed;
};

Venue.placePrivateOrder = async function (order = Venue.readOrder()) {
    await Venue.requireAccount();
    const owner = Venue.account;
    const sessionAccount = Venue.session?.account;
    if (!order.ok) throw new Error("Fix the order fields first.");
    const readiness = Venue.guidedOrderState(order, "private");
    if (readiness.mode !== "private-commit") {
        throw new Error(readiness.blocker || "Private order placement is not ready.");
    }
    Venue.busy = true;
    try {
        let ticket = Venue.pendingPrivateTicket(order);
        if (ticket) {
            try {
                Venue.assertPrivateTicketSummary(
                    ticket,
                    await Venue.readPrivateTicketSummary(ticket),
                );
                ticket = {
                    ...ticket,
                    automationState: "Stored",
                    serviceState: "PREARMED",
                };
                await Venue.upsertTicket(Venue.account, ticket);
            } catch (error) {
                if (!["CAPABILITY_REJECTED", "TICKET_MISSING"].includes(error?.code)) {
                    throw error;
                }
                const chain = await Venue.c.engine.commitments(ticket.id);
                if (chain?.committer && !addrEq(chain.committer, ZERO)) {
                    await Venue.upsertTicket(Venue.account, {
                        ...ticket,
                        committedAt: asBig(chain.committedAt).toString(),
                        automationState: "Recovery needed",
                        serviceState: "RECOVERY_REQUIRED",
                    });
                    throw new Error(
                        "The order exists on chain but its automatic ticket is unavailable. Open recovery details.",
                    );
                }
                await Venue.upsertTicket(Venue.account, {
                    ...ticket,
                    automationState: "Replaced before placement",
                    serviceState: "ABANDONED",
                });
                ticket = null;
            }
        }
        if (!ticket) ticket = await Venue.createPrivateTicket(order);
        if (!addrEq(Venue.account, owner) || !addrEq(Venue.session?.account, sessionAccount)) {
            throw new Error("The active private session changed during placement.");
        }
        Venue.status("trade-status", "Placing the sealed order through the private relay.", "");
        const committed = await Venue.relayPrivatePlacement(ticket);
        Venue.editingDraftId = null;
        Venue.trackTicketId = committed.id;
        Venue.showOrderStage("track");
        Venue.status(
            "trade-status",
            "Order sealed. Automatic reveal is scheduled.",
            "ok",
        );
        await Venue.refreshTrade();
        return committed;
    } finally {
        Venue.busy = false;
        Venue.paintTicket();
    }
};

Venue.cancelPrivateOrder = async function (ticket) {
    await Venue.requireAccount();
    const owner = Venue.account;
    if (
        !ticket
        || ticket.path !== "private"
        || !addrEq(ticket.walletOwner, Venue.account)
    ) {
        throw new Error("This private order is not managed by the connected wallet.");
    }
    const [chainBefore, untilRaw, creditBefore] = await Promise.all([
        Venue.c.engine.commitments(ticket.id),
        Venue.c.engine.cancellableUntil(ticket.id),
        Venue.c.engine.credit(ticket.committer),
    ]);
    if (chainBefore.cancelled && asBig(creditBefore) === 0n) {
        const reconciled = {
            ...ticket,
            cancelled: true,
            automationState: "Cancelled",
            serviceState: "CANCELLED",
        };
        await Venue.upsertTicket(owner, reconciled);
        await Venue.refreshTrade();
        return {hash: reconciled.cancelTx || null, status: 1};
    }
    const until = asBig(untilRaw);
    if (!chainBefore.cancelled && (until === 0n || nowSec() >= until)) {
        throw new Error("The cancellation window has closed.");
    }
    const signingRecord = Venue.privateSessionSigningRecord(ticket.committer);
    const session = Venue.privateContracts().session(ticket.committer);
    const digest = await session.cancelAuthorizationDigest(
        ticket.id,
        ticket.envelopeDigest,
        ticket.releaseRound,
    );
    const signingWallet = new ethers.Wallet(signingRecord.sessionPrivateKey);
    const signature = signingWallet.signingKey.sign(digest).serialized;
    if (!addrEq(ethers.recoverAddress(digest, signature), signingRecord.signer)) {
        throw new Error("Private cancellation failed local verification.");
    }
    Venue.tradeTxStage("pending", "Cancel private order");
    const result = await Venue.privateTicketRequest({
        method: "POST",
        path: Venue.privateOrderUrl(ticket.timedTicketId, "cancel"),
        capability: ticket.timedTicketCapability,
        contentType: "application/json",
        body: JSON.stringify({
            commitment: ticket.id,
            envelopeDigest: ticket.envelopeDigest,
            feePolicyDigest: ticket.feePolicyDigest,
            generation: ticket.generation,
            quicknetRound: ticket.releaseRound,
            signature,
        }),
    });
    const transactionHash = String(
        result?.transactionHash || result?.broadcast?.transactionHash || "",
    );
    if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
        throw new Error("Private cancellation returned no transaction receipt.");
    }
    const sweepTransactionHash = String(result?.sweepTransactionHash || "");
    const hashes = [
        transactionHash,
        ...(sweepTransactionHash ? [sweepTransactionHash] : []),
    ];
    const receipts = await Promise.all(hashes.map((hash) =>
        Venue.reader.waitForTransaction(hash, 1, 120_000)));
    if (receipts.some((receipt) => !receipt || Number(receipt.status) !== 1)) {
        throw new Error("Private cancellation was not confirmed on Hedera.");
    }
    const [chain, credit] = await Promise.all([
        Venue.c.engine.commitments(ticket.id),
        Venue.c.engine.credit(ticket.committer),
    ]);
    if (!chain.cancelled || asBig(credit) !== 0n) {
        throw new Error("Private cancellation did not finish returning engine credit.");
    }
    await Venue.upsertTicket(owner, {
        ...ticket,
        cancelled: true,
        cancelTx: transactionHash,
        automationState: "Cancelled",
        serviceState: "CANCELLED",
    });
    Venue.tradeTxStage("confirmed", "Cancel private order");
    await Venue.refreshTrade();
    return receipts.at(-1);
};

Venue.releasePrivateOrder = async function (ticket) {
    await Venue.requireAccount();
    const owner = Venue.account;
    if (
        !ticket
        || ticket.path !== "private"
        || !addrEq(ticket.walletOwner, Venue.account)
    ) {
        throw new Error("This private order is not managed by the connected wallet.");
    }
    const [existing, existingCredit] = await Promise.all([
        Venue.c.engine.orders(ticket.id),
        Venue.c.engine.credit(ticket.committer),
    ]);
    if (existing.retired && asBig(existingCredit) === 0n) {
        await Venue.refreshTrade();
        return {hash: ticket.releaseTx || null, status: 1};
    }
    Venue.tradeTxStage("pending", "Release private order funds");
    const result = await Venue.privateTicketRequest({
        method: "POST",
        path: Venue.privateOrderUrl(ticket.timedTicketId, "release"),
        capability: ticket.timedTicketCapability,
    });
    const hashes = [
        result?.transactionHash,
        result?.sweepTransactionHash,
    ].filter((hash) => /^0x[0-9a-fA-F]{64}$/.test(String(hash || "")));
    if (result?.status !== "CONFIRMED" || hashes.length === 0) {
        throw new Error("Private release did not return a confirmed receipt.");
    }
    const receipts = await Promise.all(hashes.map((hash) =>
        Venue.reader.waitForTransaction(hash, 1, 120_000)));
    if (receipts.some((receipt) => !receipt || Number(receipt.status) !== 1)) {
        throw new Error("Private release was not confirmed on Hedera.");
    }
    const [order, credit] = await Promise.all([
        Venue.c.engine.orders(ticket.id),
        Venue.c.engine.credit(ticket.committer),
    ]);
    if (!order.retired || asBig(credit) !== 0n) {
        throw new Error("Private release did not finish returning engine credit.");
    }
    const updated = {
        ...ticket,
        releaseTx: hashes.at(-1),
        automationState: "Order funds released",
        serviceState: "RELEASED",
    };
    await Venue.upsertTicket(owner, updated);
    Venue.tradeTxStage("confirmed", "Release private order funds");
    await Venue.refreshTrade();
    return receipts.at(-1);
};

Venue.emergencyPrivateReveal = async function () {
    await Venue.requireAccount();
    const owner = Venue.account;
    const ticket = Venue.ticketList(Venue.account).find((item) =>
        item.id === Venue.trackTicketId);
    if (
        !ticket
        || ticket.path !== "private"
        || !addrEq(ticket.walletOwner, Venue.account)
    ) {
        throw new Error("No recoverable private order is selected.");
    }
    const chain = await Venue.c.engine.commitments(ticket.id);
    const phase = Venue.ticketPhase(ticket, chain);
    if (nowSec() < asBig(ticket.releaseAt || 0) || phase.phase !== "reveal") {
        throw new Error("Emergency reveal is not available at this point in the protocol window.");
    }
    const action = $("private-recovery-action");
    if (action?.dataset.confirm !== "1") {
        if (action) {
            action.dataset.confirm = "1";
            Venue.paintPrivateRecovery(ticket, phase);
            clearTimeout(Venue._privateRecoveryConfirmTimer);
            Venue._privateRecoveryConfirmTimer = setTimeout(() => {
                delete action.dataset.confirm;
                Venue.paintPrivateRecovery(ticket, phase);
            }, 10_000);
        }
        Venue.status(
            "trade-status",
            "Emergency fallback reduces privacy. Click again to confirm the public wallet-to-session link.",
            "bad",
        );
        return null;
    }
    clearTimeout(Venue._privateRecoveryConfirmTimer);
    delete action.dataset.confirm;
    const gasLabel = Number(ticket.side) === 1 ? "sell" : "buy";
    const gasLimit = asBig(
        CLIENT.privateTrading?.gasCap?.[gasLabel]
        ?? (Number(ticket.side) === 1 ? 828_046n : 384_666n),
    );
    if (Venue.snap.gasPriceWei !== undefined && Venue.snap.walletTinybar !== undefined) {
        const fee = (gasLimit * asBig(Venue.snap.gasPriceWei) + 9_999_999_999n)
            / 10_000_000_000n;
        if (Venue.snap.walletTinybar < fee) {
            throw new Error("The wallet does not have the minimum HBAR for the recovery fee.");
        }
    }
    const session = Venue.privateContracts(Venue.signer).session(ticket.committer);
    Venue.tradeTxStage("approval", "Emergency wallet reveal");
    const receipt = await Venue.send(
        () => session.revealAuthorized(
            Number(ticket.side),
            ticket.price,
            ticket.qty,
            ticket.salt,
            ticket.envelopeDigest,
            ticket.releaseRound,
            {gasLimit},
        ),
        "Emergency wallet reveal",
    );
    if (!receipt) return null;
    const [revealed, revealBlock] = await Promise.all([
        Venue.c.engine.commitments(ticket.id),
        Venue.reader.getBlock(receipt.blockNumber),
    ]);
    if (!revealed.revealed) {
        throw new Error("The recovery receipt did not reveal the selected order.");
    }
    await Venue.upsertTicket(owner, {
        ...ticket,
        revealed: true,
        revealTx: receipt.hash,
        revealedAt: String(revealBlock?.timestamp || Math.floor(Date.now() / 1000)),
        automationState: "Revealed by wallet fallback",
        serviceState: "MANUAL_RECOVERY",
    });
    Venue.status(
        "trade-status",
        "Order revealed. This wallet is now publicly linkable to the private session.",
        "ok",
    );
    await Venue.refreshTrade();
    return receipt;
};

Venue.continuePrivateSetup = async function () {
    if (!Venue._privateSecretPayload?.credential) {
        const adopted = await Venue.ensurePrivateHolderCredential();
        if (!adopted) {
            $("private-credential-file")?.click();
            return;
        }
    }
    if (!Venue.session || Venue.snap.sessionKyc !== 1) {
        await Venue.createOrRenewPrivateSession();
        return;
    }
    const o = Venue.readOrder();
    const funds = Venue.orderFunds(o);
    const side = Number(Venue._privateSetupSide ?? o.side);
    const funded = side === 1
        ? Venue.snap.sessionFree >= o.qty
            && Venue.snap.sessionTinybar >= (funds.privateRequired || 0n)
        : Venue.snap.sessionTinybar >= (funds.privateRequired || 0n);
    if (funded) {
        Venue.closePrivateSetup();
        Venue.paintTicket();
        return;
    }
    await Venue.fundPrivateSession(side);
};

Venue.runPrivatePathClick = async function (order, mode) {
    await Venue.requireAccount();
    const owner = Venue.account;
    await Venue.hydratePrivateState(owner);
    if (!addrEq(Venue.account, owner)) {
        throw new Error("The connected wallet changed during private setup.");
    }
    const adopted = await Venue.ensurePrivateHolderCredential();
    if (!adopted && !Venue._privateSecretPayload?.credential) {
        await Venue.openPrivateSetup({side: order.side});
        return;
    }
    if (mode === "session-setup") {
        const created = await Venue.createOrRenewPrivateSession();
        if (!created) {
            await Venue.openPrivateSetup({side: order.side});
            return;
        }
    }
    if (!Venue.session || Venue.snap.sessionKyc !== 1) {
        await Venue.openPrivateSetup({side: order.side});
        return;
    }
    await Venue.fundPrivateSession(order.side);
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
    await Venue.loadPrivateCandidateStatus();
    await Venue.applyPrivateCandidateOverlay();
    const walletReady = (async () => {
        if (!injected) return;
        Venue.eth = injected;
        Venue.bindProviderEvents(injected);
        const accs = await injected.request({method: "eth_accounts"}).catch(() => []);
        if (accs?.[0]) await Venue.attachAccount(accs[0]);
    })();
    await Promise.all([
        Venue.probeFinancing(),
        walletReady,
    ]);
    if (!Venue.account) {
        let saved = null;
        try { saved = sessionStorage.getItem("seamme.watch"); } catch (e) { saved = null; }
        if (saved) {
            Venue.watching = saved;
            Venue.renderWallet();
        }
    }
    if (Venue.viewer()) await Venue.hydrateTicketVault(Venue.viewer());
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

Venue.loadPrivateCandidateStatus = async function () {
    try {
        const response = await fetch("/api/private/status", {
            method: "GET",
            credentials: "omit",
            redirect: "error",
            referrerPolicy: "no-referrer",
            cache: "no-store",
        });
        if (!response.ok) {
            Venue._privateStatus = {worker: {ok: false}};
            return Venue._privateStatus;
        }
        const body = await response.json();
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            Venue._privateStatus = {worker: {ok: false}};
            return Venue._privateStatus;
        }
        Venue._privateStatus = body;
        return body;
    } catch {
        Venue._privateStatus = null;
        return null;
    }
};

Venue.applyPrivateCandidateOverlay = async function () {
    if (CLIENT.privateTrading?.enabled && CLIENT.privateTrading.overlay !== true) {
        return CLIENT.privateTrading;
    }
    const overlay = Venue._privateStatus?.overlay;
    if (!overlay || overlay.overlay !== true || overlay.enabled !== true) {
        return CLIENT.privateTrading;
    }
    CLIENT.privateTrading = overlay;
    try {
        const factory = Venue.privateContracts()?.factory;
        if (factory) {
            const hash = String(await factory.creationCodeHash()).toLowerCase();
            CLIENT.privateTrading = {
                ...CLIENT.privateTrading,
                session: {
                    ...CLIENT.privateTrading.session,
                    creationCodeHash: hash,
                },
            };
        }
    } catch { /* keep the overlay; registration will refuse a missing hash */ }
    await Venue.observePrivateGate();
    return CLIENT.privateTrading;
};

Venue.observePrivateGate = async function () {
    const dual = CLIENT.privateTrading?.addresses?.DualRegistrationGate;
    const registry = Venue.c?.registry;
    if (!dual || !registry) return Venue._privateStatus;
    try {
        const [gate, epoch] = await Promise.all([
            registry.gate(),
            registry.currentEpoch(),
        ]);
        Venue._privateStatus = {
            ...(Venue._privateStatus || {}),
            currentEpoch: Number(asBig(epoch)),
            activeGate: String(gate),
            gateAdopted: addrEq(gate, dual),
        };
    } catch {
        Venue._privateStatus = {
            ...(Venue._privateStatus || {}),
            gateAdopted: false,
        };
    }
    return Venue._privateStatus;
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
    Venue.bindFinanceChrome?.();
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
    await Venue.hydrateTicketVault(addr);
    await Venue.refreshForViewer();
    if (Venue.page === "prove") await Venue.hydrateProof();
};

Venue.stopWatching = function () {
    Venue.watching = null;
    try {
        sessionStorage.removeItem("seamme.watch");
    } catch (e) { /* nothing to clean up */ }
    Venue.renderWallet();
    Venue.paintDeviceVaultState();
};

Venue.refreshForViewer = async function () {
    if (Venue.page === "prove") await Venue.refreshProve();
    if (Venue.page === "trade") await Venue.refreshTrade();
    if (Venue.page === "repo") await Venue.refreshFinanceWorkspace?.();
    if (Venue.page === "position") {
        await Promise.all([
            Venue.refreshPosition(),
            Venue.refreshInstrument?.().catch(() => {}),
            Venue.refreshIncome?.().catch(() => {}),
            Venue.refreshPortfolioFinancing?.().catch(() => {}),
        ]);
    }
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
        Venue.session = null;
        Venue._privateSessionRecords = [];
        Venue._privateSecretPayload = {v: 1, credential: null, notes: []};
        Venue._privateScope = null;
        Venue.renderWallet();
        // The masthead follows accountsChanged. Eligibility used not to: the
        // last grant and the use count sat there until a reload.
        Venue.clearProveGrant();
        Venue.paintDeviceVaultState();
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
    await Promise.all([
        Venue.hydrateVaultHandle(Venue.account),
        Venue.hydrateTicketVault(Venue.account),
        Venue.hydratePrivateState(Venue.account),
    ]);
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
    Venue.localTimer = setInterval(() => {
        Venue.paintClocks();
        Venue.paintOracleCountdown?.();
    }, 1000);
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
            if (Venue.pollOracle && now - (Venue._tradeOracleAt || 0) >= ORACLE_REFRESH_MS) {
                Venue._tradeOracleAt = now;
                work.push(Venue.pollOracle());
            }
        }
        if (Venue.page === "repo") {
            const now = Date.now();
            if (Venue.pollOracle && now - (Venue._repoOracleAt || 0) >= ORACLE_REFRESH_MS) {
                Venue._repoOracleAt = now;
                work.push(Venue.pollOracle());
            }
        }
        if (Venue.page === "position") {
            if (viewer) work.push(Venue.refreshPosition({quiet: true}));
            work.push(Venue.refreshInstrument());
            const now = Date.now();
            if (now - (Venue._positionIncomeAt || 0) > 30000) {
                Venue._positionIncomeAt = now;
                work.push(Venue.refreshIncome().catch(() => {}));
            }
            if (now - (Venue._positionFinancingAt || 0) > 30000) {
                Venue._positionFinancingAt = now;
                work.push(Venue.refreshPortfolioFinancing?.().catch(() => {}));
            }
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
        Venue.status("prove-status", "Private access is active for this period.", "ok");
        return;
    }
    if (!el.classList.contains("ok")) el.classList.add("ok");
    Venue.flashStatus(el);
};

Venue.setEligibilityStage = function (stage, message, kind) {
    Venue._eligibilityStage = stage || null;
    if (message !== undefined) Venue.status("prove-status", message, kind || "");
    Venue.paintEligibilityAction();
};

Venue.paintEligibilityAction = function () {
    const action = $("eligibility-action");
    const card = $("kyc-banner");
    if (!action || !card) return;

    action.disabled = false;
    action.setAttribute("aria-busy", "false");
    action.classList.add("primary");

    if (Venue._eligibilityBusy) {
        const labels = {
            checking: "Checking access",
            submitting: "Securing access",
            confirming: "Confirming access",
        };
        action.textContent = labels[Venue._eligibilityStage] || "Checking access";
        action.dataset.action = "busy";
        action.disabled = true;
        action.setAttribute("aria-busy", "true");
        card.dataset.state = "busy";
        return;
    }

    if (Venue.account && Venue.snap.kyc === 1) {
        action.textContent = "Open Markets";
        action.dataset.action = "trade";
        action.setAttribute("aria-label", "Private access confirmed. Open Markets.");
        card.dataset.state = "granted";
        return;
    }

    if (!Venue.account) {
        action.textContent = "Connect wallet";
        action.dataset.action = "connect";
        action.setAttribute("aria-label", "Connect a wallet");
        card.dataset.state = Venue._eligibilityStage === "error" ? "error" : "disconnected";
        return;
    }

    if (!Venue.proof) {
        action.textContent = "Restore access file";
        action.dataset.action = "recover";
        action.setAttribute("aria-label", "Choose an account-bound access file");
        card.dataset.state = Venue._eligibilityStage === "error" ? "error" : "ready";
        return;
    }

    action.textContent = Venue._eligibilityStage === "error"
        ? "Try private access again"
        : "Confirm private access";
    action.dataset.action = "confirm";
    action.setAttribute("aria-label", action.textContent);
    card.dataset.state = Venue._eligibilityStage === "error" ? "error" : "ready";
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
    const primaryAction = $("commit");
    const actions = [primaryAction, $("commit-auto"), $("commit-manual")].filter(Boolean);
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
    for (const action of actions) {
        const active = stage === "approval" || stage === "pending";
        action.setAttribute("aria-busy", active ? "true" : "false");
        if (active) {
            action.disabled = true;
            if (action === primaryAction) {
                action.textContent = stage === "approval" ? "Check wallet" : label + " pending";
            }
        }
    }
};

Venue.positionTxStage = function (stage, label, detail) {
    if (Venue.page !== "position") return;
    const active = stage === "approval" || stage === "pending";
    const messages = {
        approval: "Approve " + String(label).toLowerCase() + " in your wallet.",
        pending: label + " is pending on Hedera.",
        confirmed: label + " confirmed. Account figures are refreshing.",
        rejected: "Wallet request rejected. No Portfolio transaction was sent.",
        failed: detail
            ? String(detail).replace(/[.!?]\s*$/, "") + "."
            : label + " failed.",
    };
    Venue.status(
        "position-status",
        messages[stage] || "",
        stage === "confirmed" ? "ok" : stage === "failed" || stage === "rejected" ? "bad" : "",
    );
    document.querySelectorAll("[data-position-action]").forEach((action) => {
        if (active) {
            if (!Object.hasOwn(action.dataset, "positionWasDisabled")) {
                action.dataset.positionWasDisabled = action.disabled ? "1" : "0";
            }
            action.disabled = true;
            action.setAttribute("aria-busy", "true");
            return;
        }
        action.setAttribute("aria-busy", "false");
        if (action.dataset.positionWasDisabled === "0") action.disabled = false;
        delete action.dataset.positionWasDisabled;
    });
};

Venue.send = async function (txFactory, label) {
    if (Venue.busy) return null;
    Venue.busy = true;
    let submittedHash = "";
    try {
        if (typeof txFactory !== "function") {
            throw new TypeError("Transaction submission requires a factory.");
        }
        Venue.positionTxStage?.("approval", label);
        Venue.financeTxStage?.("approval", label);
        const tx = await txFactory();
        submittedHash = tx?.hash || "";
        if (Venue.page !== "repo") Venue.toast(label + " sent " + shortId(tx.hash));
        Venue.tradeTxStage("pending", label);
        Venue.positionTxStage?.("pending", label);
        Venue.financeTxStage?.("pending", label, {hash: submittedHash});
        const rec = await tx.wait();
        if (rec.status !== 1) throw new Error(label + " reverted");
        Venue.lastReceipt = rec;
        if (Venue.page !== "repo") Venue.toast(label + " confirmed");
        const confirmedHash = rec.hash || rec.transactionHash || submittedHash;
        Venue.tradeTxStage("confirmed", label);
        Venue.positionTxStage?.("confirmed", label);
        Venue.financeTxStage?.("confirmed", label, {hash: confirmedHash});
        return rec;
    } catch (e) {
        const rejected = e?.code === 4001 || e?.code === "ACTION_REJECTED"
            || /user rejected|request rejected|denied/i.test(String(e?.shortMessage || e?.message || ""));
        const d = rejected
            ? {message: "Wallet request rejected."}
            : Venue.fail(e);
        if (rejected) Venue.toast(d.message);
        Venue.tradeTxStage(rejected ? "rejected" : "failed", label, d.message);
        Venue.positionTxStage?.(rejected ? "rejected" : "failed", label, d.message);
        Venue.financeTxStage?.(rejected ? "rejected" : "failed", label, {
            message: d.message,
            hash: submittedHash,
        });
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
    $("proof-file")?.addEventListener("change", (e) => {
        Venue.onProofFile(e.target.files[0]).catch((err) => {
            const d = Venue.fail(err);
            Venue.setEligibilityStage("error", d.message, "bad");
        });
        e.target.value = "";
    });
    const drop = $("drop");
    drop?.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop?.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop?.addEventListener("drop", (e) => {
        e.preventDefault();
        drop.classList.remove("over");
        Venue.onProofFile(e.dataTransfer.files[0]).catch((err) => Venue.fail(err));
    });
    $("eligibility-action")?.addEventListener("click", () => {
        const mode = $("eligibility-action")?.dataset.action;
        if (mode === "trade") {
            location.href = "trade.html";
            return;
        }
        if (mode === "connect") {
            Venue.openSheet();
            return;
        }
        if (mode === "recover") {
            const lab = $("prove-lab");
            if (lab) lab.open = true;
            $("proof-file")?.click();
            return;
        }
        if (mode === "confirm") {
            Venue.ensureEligibility().catch((e) => {
                const d = Venue.fail(e);
                Venue.setEligibilityStage("error", d.message, "bad");
            });
        }
    });
    await Promise.all([
        Venue.refreshProve(),
        Venue.refreshGateGov().catch(() => {}),
    ]);
    await Venue.hydrateProof();
    Venue.paintEligibilityAction();
};

Venue.clearProveGrant = function () {
    if (Venue.page !== "prove") return;
    Venue.snap.kyc = 0;
    Venue._eligibilityBusy = false;
    Venue._eligibilityStage = null;
    Venue.status("prove-status", "", "");
    const uses = $("uses");
    if (uses) uses.textContent = "";
    const who = Venue.viewer();
    if (
        Venue.proof?.address
        && (!who || String(Venue.proof.address).toLowerCase() !== who.toLowerCase())
    ) {
        Venue.proof = null;
        const pins = $("pins");
        if (pins) {
            pins.className = "pins-slot";
            pins.innerHTML = EMPTY_SIGNALS;
        }
    }
    const copy = $("kyc-copy");
    if (copy) {
        copy.textContent = who
            ? "This wallet does not have private access for the current period yet."
            : "Confirm eligibility for this KYC period";
    }
    Venue.paintEligibilityAction();
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
    let status = "Confirm eligibility for this KYC period";
    if (who) {
        const kyc = Number(granted);
        Venue.snap.kyc = kyc;
        status = kyc === 1
            ? "Private access is confirmed for this period."
            : Venue.account
                ? "Confirm once. The venue checks and activates access automatically."
                : "This account does not have private access for the current period.";
    } else {
        Venue.snap.kyc = 0;
        Venue.clearProveGrant();
    }
    if (!Venue._eligibilityBusy) $("kyc-copy").textContent = status;
    if (Venue.proof) Venue.paintPins();
    Venue.paintEligibilityAction();
};

Venue.onProofFile = async function (file) {
    if (!file) return;
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); }
    catch {
        Venue.setEligibilityStage("error", "That access file is not valid JSON.", "bad");
        return;
    }
    const picked = Venue.pickProof(data);
    if (!picked) {
        Venue.setEligibilityStage("error", "That file is not an access file the venue recognises.", "bad");
        return;
    }
    Venue.proof = picked;
    const epoch = Venue.snap.kycEpoch;
    const who = picked.address || Venue.viewer();
    if (who && epoch != null) writePocketProof(who, picked, epoch);
    Venue.paintPins();
    Venue.paintEligibilityAction();
    if (Venue.account) {
        await Venue.ensureEligibility();
        return;
    }
    Venue.setEligibilityStage(null, "Access file restored. Connect its wallet to continue.", "ok");
};

// A proof source returns one normalized, account-bound package or null. The
// local worker prover can join this list later without changing the screen or
// the registration controller.
Venue.proofProviders = [
    {
        name: "bundled",
        read(who, epoch) {
            const set = typeof DEMO_PROOFS !== "undefined" && DEMO_PROOFS
                ? DEMO_PROOFS[String(epoch)]
                : null;
            return set ? Venue.pickProof(set[who.toLowerCase()]) : null;
        },
    },
    {
        name: "device",
        read(who, epoch) {
            const stored = readPocketProof(who);
            if (!stored || String(stored.epoch) !== String(epoch)) return null;
            return Venue.pickProof(stored);
        },
    },
];

Venue.proofFor = function (who, epoch) {
    if (!who) return null;
    for (const provider of Venue.proofProviders) {
        const proof = provider.read(who, epoch);
        if (proof) return {...proof, source: provider.name};
    }
    return null;
};

Venue.hydrateProof = async function () {
    if (Venue.page !== "prove") return;
    const who = Venue.viewer();
    if (!who) {
        Venue.paintEligibilityAction();
        return;
    }
    const epoch = Venue.snap.kycEpoch !== undefined && Venue.snap.kycEpoch !== null
        ? Venue.snap.kycEpoch
        : asBig(await Venue.c.registry.currentEpoch());
    const bound = Venue.proof?.address
        && String(Venue.proof.address).toLowerCase() === who.toLowerCase()
        && String(Venue.proof.pub?.[3]) === String(epoch);
    if (bound) {
        Venue.paintEligibilityAction();
        return;
    }
    const picked = Venue.proofFor(who, epoch);
    if (picked) {
        Venue.proof = picked;
        Venue.paintPins();
        if (Venue.account && Venue.snap.kyc !== 1 && !Venue._eligibilityBusy) {
            Venue.setEligibilityStage(
                null,
                "Your private access check is ready. Confirm once to activate it.",
                "",
            );
        } else {
            Venue.paintEligibilityAction();
        }
        return;
    }
    Venue.proof = null;
    const pins = $("pins");
    if (pins) {
        pins.className = "pins-slot";
        pins.innerHTML = EMPTY_SIGNALS;
    }
    const uses = $("uses");
    if (uses) uses.textContent = "";
    if (Venue.account && !Venue.proof && Venue.snap.kyc !== 1) {
        Venue.setEligibilityStage(
            null,
            "This wallet has no account-bound access file on this device.",
            "",
        );
    } else {
        Venue.paintEligibilityAction();
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
        return "This private access check belongs to another account.";
    }
    if (r.includes("wrong epoch")) return "This access file is for a different eligibility period.";
    if (r.includes("nullifier exhausted")) {
        return "This credential has already been used as many times as this period allows.";
    }
    if (r.includes("root not published")) return "The issuer has not published a root for this period yet.";
    if (r.includes("wrong credential root")) return "This access file does not match the issuer's current list.";
    if (r.includes("policy mismatch")) return "This access file was prepared for a different policy.";
    if (r.includes("policy not satisfied")) return "The issuer's current access requirements are not met.";
    return r || "The venue cannot confirm private access.";
};

Venue.preflightEligibility = async function (who, proof) {
    const pub = proof.pub.map((x) => asBig(x));
    let timeoutId;
    try {
        return await Promise.race([
            Venue.c.gate.wouldAccept(who, pub),
            new Promise((_, reject) => {
                timeoutId = setTimeout(
                    () => reject(new Error("The eligibility gate did not answer. Try again.")),
                    20000,
                );
            }),
        ]);
    } finally {
        clearTimeout(timeoutId);
    }
};

Venue.submitSponsoredEligibility = async function (who, proof) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 45000) : null;
    let response;
    try {
        response = await fetch(ELIGIBILITY_RELAY_PATH, {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({
                chainId: CLIENT.network.chainId,
                gate: CLIENT.addresses.RegistrationGate,
                registry: CLIENT.addresses.ZkKycRegistry,
                account: who,
                proof: proof.proof.map(String),
                pub: proof.pub.map(String),
            }),
            signal: controller?.signal,
        });
    } catch (error) {
        if (error?.name === "AbortError") {
            throw new Error("The sponsored access service took too long. No wallet transaction was sent.");
        }
        throw new Error("The sponsored access service is unavailable. No wallet transaction was sent.");
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(body.error || "The sponsored access service refused this request.");
    }
    if (!["submitted", "already_granted"].includes(body.status)) {
        throw new Error("The sponsored access service returned an unknown result.");
    }
    return body;
};

Venue.waitForEligibility = async function (who, txHash) {
    for (let attempt = 0; attempt < 40; attempt++) {
        if (!Venue.stillViewer(who) || !Venue.account) {
            throw new Error("The connected wallet changed while access was being confirmed.");
        }
        const status = Number(await Venue.c.registry.getKycStatus(who));
        if (status === 1) return true;
        await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    const suffix = txHash ? " Transaction " + shortId(txHash) + " is still pending." : "";
    throw new Error("Access confirmation is taking longer than expected." + suffix);
};

Venue.ensureEligibility = async function () {
    if (Venue._eligibilityBusy) return;
    await Venue.requireAccount();
    const who = Venue.account;

    if (Number(await Venue.c.registry.getKycStatus(who)) === 1) {
        Venue.snap.kyc = 1;
        $("kyc-copy").textContent = "Private access is confirmed for this period.";
        Venue.setEligibilityStage(null, "No further eligibility action is needed.", "ok");
        return;
    }

    Venue._eligibilityBusy = true;
    try {
        Venue.setEligibilityStage("checking", "Checking your account-bound access privately.", "");
        await Venue.hydrateProof();
        const proof = Venue.proof;
        if (!proof) {
            const details = $("prove-lab");
            if (details) details.open = true;
            throw new Error("This wallet needs an account-bound access file from the issuer.");
        }
        if (!proof.address || proof.address.toLowerCase() !== who.toLowerCase()) {
            throw new Error("This access file belongs to another wallet.");
        }

        const [ok, reason] = await Venue.preflightEligibility(who, proof);
        if (!Venue.stillViewer(who)) {
            throw new Error("The connected wallet changed while access was being checked.");
        }
        try { Venue.paintPins(); } catch { /* details cannot interrupt registration */ }
        if (!ok) throw new Error(Venue.explainGate(reason));

        Venue.setEligibilityStage(
            "submitting",
            "The venue is sponsoring your access confirmation. Your wallet will not be charged.",
            "",
        );
        const submitted = await Venue.submitSponsoredEligibility(who, proof);
        Venue.setEligibilityStage("confirming", "Confirming private access on Hedera.", "");
        await Venue.waitForEligibility(who, submitted.txHash);

        Venue.snap.kyc = 1;
        $("kyc-copy").textContent = "Private access is confirmed for this period.";
        Venue.status(
            "prove-status",
            submitted.status === "already_granted"
                ? "Your access was already active. No transaction was needed."
                : "Access confirmed. The venue paid the registration cost.",
            "ok",
        );
        Venue._eligibilityStage = null;
    } catch (error) {
        Venue._eligibilityStage = "error";
        throw error;
    } finally {
        Venue._eligibilityBusy = false;
        Venue.paintEligibilityAction();
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
        Venue.paintTicket();
    });
    $("save-ticket")?.addEventListener("click", () => Venue.saveTicketNow().catch((e) => Venue.fail(e)));
    $("save-vault")?.addEventListener("click", () => Venue.saveVaultNow().catch((e) => Venue.fail(e)));
    $("commit")?.addEventListener("click", () => Venue.doGuidedOrderAction().catch((e) => {
        Venue.tradeTxStage("failed", "Order action", Venue.fail(e).message);
        Venue.paintTicket();
    }));
    $("commit-auto")?.addEventListener("click", () => Venue.doOrderPath("private").catch((e) => {
        Venue.tradeTxStage("failed", "Private order", Venue.fail(e).message);
        Venue.paintTicket();
    }));
    $("commit-manual")?.addEventListener("click", () => Venue.doOrderPath("manual").catch((e) => {
        Venue.tradeTxStage("failed", "Direct order", Venue.fail(e).message);
        Venue.paintTicket();
    }));
    $("order-back")?.addEventListener("click", () => {
        Venue.showOrderStage("details");
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
    document.querySelectorAll("[data-private-close]").forEach((control) => {
        control.addEventListener("click", () => Venue.closePrivateSetup());
    });
    $("private-credential-file")?.addEventListener("change", (event) => {
        Venue.importPrivateCredential(event.target.files?.[0])
            .catch((error) => Venue.status(
                "private-setup-status",
                error?.message || "Credential import failed.",
                "bad",
            ));
        event.target.value = "";
    });
    $("private-setup-action")?.addEventListener("click", () => {
        Venue.continuePrivateSetup().catch((error) => Venue.status(
            "private-setup-status",
            error?.message || "Private setup failed safely.",
            "bad",
        ));
    });
    $("private-session-rotate")?.addEventListener("click", () => {
        Venue.rotatePrivateSession().catch((error) => Venue.status(
            "private-setup-status",
            error?.message || "Private session rotation failed safely.",
            "bad",
        ));
    });
    $("private-session-history")?.addEventListener("click", (event) => {
        const renewal = event.target.closest?.("button[data-private-renew]");
        if (renewal) {
            Venue.renewRetiringPrivateSession(renewal.dataset.session)
                .catch((error) => Venue.status(
                    "private-setup-status",
                    error?.message || "Recovery access renewal failed safely.",
                    "bad",
                ));
            return;
        }
        const action = event.target.closest?.("button[data-private-recover]");
        if (!action) return;
        Venue.recoverRetiringSessionAsset(
            action.dataset.session,
            action.dataset.privateRecover,
        ).catch((error) => Venue.status(
            "private-setup-status",
            error?.message || "Private session recovery failed safely.",
            "bad",
        ));
    });
    $("private-recovery-action")?.addEventListener("click", () => {
        Venue.emergencyPrivateReveal().catch((error) => {
            Venue.status(
                "trade-status",
                error?.message || "Emergency reveal failed safely.",
                "bad",
            );
        });
    });
    document.addEventListener("keydown", (event) => {
        const modal = $("withdraw-modal");
        if (event.key === "Escape" && !modal?.hidden) {
            Venue.closeWithdrawConfirm();
            return;
        }
        const privateModal = $("private-setup-modal");
        if (event.key === "Escape" && !privateModal?.hidden) {
            Venue.closePrivateSetup();
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
    $("feed-refresh")?.addEventListener("click", () => Venue.pollOracle());
    $("order-attention-go")?.addEventListener("click", () => {
        $("active-orders")?.scrollIntoView({behavior: "smooth", block: "start"});
    });
    if (!$("salt").value) Venue.reroll();
    else Venue.paintTicket();
    Venue.paintDeviceVaultState();
    if (Venue.account) await Venue.hydrateVaultHandle(Venue.account);
    await Promise.all([
        Venue.refreshTrade(),
        Venue.refreshInstrument?.().catch(() => {}),
        Venue.pollOracle?.(),
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
        status.textContent = "Connect to reserve inventory for this sell.";
        return;
    }
    if (chosen) {
        status.textContent = Venue.lockLabel(chosen) + ". Ready to use.";
        return;
    }
    if (live.length) {
        status.textContent = "The existing reservation does not cover this quantity.";
        return;
    }
    status.textContent = "Direct sell uses three wallet approvals: reserve, place, and reveal.";
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
    return Venue.ticketList(Venue.account).find((t) => t.id === o.id) || null;
};

Venue.orderFunds = function (o) {
    const bond = Venue.snap.commitBond ?? asBig(CLIENT.immutables.commitBond);
    const fee = Venue.snap.cancelFee ?? asBig(CLIENT.immutables.cancelFee);
    const limit = o.bad.price || o.bad.qty ? null : buyEscrow(o.price, o.qty);
    const reveal = o.side === 0 && limit !== null ? limit : 0n;
    const label = o.side === 1 ? "sell" : "buy";
    const privateConfig = CLIENT.privateTrading || {};
    const gasUnits = {
        manual: asBig(
            privateConfig.gasDirectObserved?.[label]
            ?? (o.side === 1 ? 720_040n : 334_492n),
        ),
        privateTarget: asBig(
            privateConfig.gasObserved?.[label]
            ?? privateConfig.gasTarget?.[label]
            ?? (o.side === 1 ? 792_044n : 367_941n),
        ),
        privateCap: asBig(
            privateConfig.gasCap?.[label]
            ?? (o.side === 1 ? 828_046n : 384_666n),
        ),
    };
    const gasPriceWei = Venue.snap.gasPriceWei == null ? null : asBig(Venue.snap.gasPriceWei);
    const gasFee = (units) => gasPriceWei == null || gasPriceWei <= 0n
        ? null
        : (units * gasPriceWei + 9_999_999_999n) / 10_000_000_000n;
    const network = {
        manual: gasFee(gasUnits.manual),
        privateTarget: gasFee(gasUnits.privateTarget),
        privateCap: gasFee(gasUnits.privateCap),
    };
    const totalCash = limit === null ? null : bond + reveal;
    return {
        bond,
        fee,
        limit,
        reveal,
        totalCash,
        gasUnits,
        network,
        manualRequired: totalCash === null || network.manual === null
            ? null
            : totalCash + network.manual,
        // Session holds bond and buy escrow. Relayer gas is not a session balance.
        privateRequired: totalCash,
        walletDepositGas: gasPriceWei == null || gasPriceWei <= 0n
            ? null
            : ((Number(o.side) === 1 ? 1_200_000n : 1_100_000n)
                * gasPriceWei + 9_999_999_999n) / 10_000_000_000n,
    };
};

Venue.privatePathReadiness = function (side) {
    const config = CLIENT.privateTrading || {};
    const label = Number(side) === 1 ? "sell" : "buy";
    const baseline = asBig(
        config.gasDirectObserved?.[label]
        ?? (Number(side) === 1 ? 720_040n : 334_492n),
    );
    const target = asBig(
        config.gasTarget?.[label]
        ?? (Number(side) === 1 ? 792_044n : 367_941n),
    );
    const cap = asBig(
        config.gasCap?.[label]
        ?? (Number(side) === 1 ? 828_046n : 384_666n),
    );
    const measuredRaw = config.gasObserved?.[label];
    const measured = measuredRaw == null ? null : asBig(measuredRaw);
    const noteCount = Number(config.routingNotes?.[label === "sell" ? "LPRC" : "HBAR"] || 0);
    let reason = "";
    if (config.overlay === true) {
        const status = Venue._privateStatus || {};
        const hbarNotes = Number(status.routingNotes?.HBAR || config.routingNotes?.HBAR || 0);
        if (label === "sell") {
            reason = "Private sell waits on LPRC ATS canary and eight LPRC notes.";
        } else if (status.worker?.ok !== true) {
            reason = "The private relayer is not reachable on this origin.";
        } else if (!config.artifacts?.sessionEligibility || !config.provingReady) {
            reason = "Private proving artifacts are not available on this origin.";
        } else if (hbarNotes < 8) {
            reason = "The HBAR route has fewer than 8 notes from distinct funding addresses.";
        } else if (status.gateAdopted !== true) {
            const epoch = status.activationEpoch || config.activationEpoch || 8;
            if (Number(status.currentEpoch) >= Number(epoch)) {
                reason = "Epoch " + epoch
                    + " has started. DualRegistrationGate is published and still needs adoptGate().";
            } else {
                reason = "DualRegistrationGate is pending for epoch " + epoch
                    + ". HBAR notes " + hbarNotes + ". The private relayer is up.";
            }
        }
    } else if (!config.enabled) {
        const status = Venue._privateStatus;
        if (config.reason) {
            reason = config.reason;
        } else if (status && (status.activationEpoch || status.candidateOnly)) {
            const parts = ["Private trading is not bound on this deployment yet."];
            if (status.activationEpoch) {
                parts.push(
                    "DualRegistrationGate is pending for epoch "
                        + status.activationEpoch + ".",
                );
            }
            const hbarNotes = Number(status.routingNotes?.HBAR || 0);
            const lprcNotes = Number(status.routingNotes?.LPRC || 0);
            if (hbarNotes || lprcNotes) {
                parts.push(
                    "HBAR notes " + hbarNotes + ", LPRC notes " + lprcNotes + ".",
                );
            }
            if (status.lprcCanaryActivated === false) {
                parts.push("LPRC ATS canary is inactive.");
            }
            if (status.worker && status.worker.ok === false) {
                parts.push("The private relayer is not reachable on this origin.");
            } else if (status.worker && status.worker.ok === true) {
                parts.push("The private relayer is up.");
            }
            reason = parts.join(" ");
        } else {
            reason = "Private trading is not bound on this deployment yet.";
        }
    } else if (config[label + "Enabled"] === false) {
        reason = config.reason || "Private trading is not released for this side.";
    } else if (measured === null) {
        reason = "Private recurring gas has not been measured against a same-period direct control.";
    } else if (measured > cap) {
        reason = "Private " + label + " gas exceeds the 15% hard release cap.";
    } else if (noteCount < 8) {
        reason = "The " + (label === "sell" ? "LPRC" : "HBAR") +
            " route has fewer than 8 notes from distinct funding addresses.";
    } else if (config.timedReleaseVerified !== true
        || config.privacyCanaryPassed !== true
        || config.rollbackCanaryPassed !== true) {
        reason = "Timed release, privacy, and rollback canaries have not all passed.";
    }
    return {
        ready: reason === "",
        reason,
        measured,
        baseline,
        target,
        cap,
        withinTarget: measured !== null && measured <= target,
        overheadBps: measured === null
            ? null
            : (measured - baseline) * 10_000n / baseline,
        noteCount,
    };
};

Venue.guidedOrderState = function (o, path = "manual") {
    const record = Venue.draftRecord(o);
    const saved = !!record;
    const submitted = !!record?.committedAt;
    const funds = Venue.orderFunds(o);
    const isPrivate = path === "private";
    const privateConfig = CLIENT.privateTrading || {};
    const privateReadiness = isPrivate ? Venue.privatePathReadiness(o.side) : null;
    const result = (value) => ({...value, saved, submitted, path});
    if (Venue.busy) {
        return result({mode: "busy", label: "Transaction in progress", disabled: true});
    }
    if (!Venue.account) {
        return result({mode: "connect", label: "Connect wallet", disabled: false});
    }
    if (o.bad.price || o.bad.qty) {
        return result({
            mode: "invalid",
            label: "Enter a valid price and quantity",
            disabled: true,
            blocker: "Use HBAR with no more than 8 decimal places and a whole-bond quantity.",
        });
    }
    if (o.bad.salt) {
        return result({
            mode: "invalid",
            label: "Draw a valid reveal key",
            disabled: true,
            blocker: "Draw a new reveal key or restore a saved ticket.",
        });
    }
    if (submitted) {
        return result({mode: "new", label: "Start another order", disabled: false});
    }
    if (isPrivate && !privateReadiness.ready) {
        return result({
            mode: "unavailable",
            label: "Private + automatic",
            disabled: false,
            blocker: privateReadiness.reason
                || privateConfig.reason
                || "Private trading stays disabled until all release checks pass.",
        });
    }
    if (isPrivate && !Venue.session?.account) {
        return result({
            mode: "session-setup",
            label: "Set up private trading",
            disabled: false,
            blocker: "One-time session registration and fixed-denomination routing are required before private orders.",
        });
    }
    if (isPrivate && Venue.snap.sessionKyc === undefined) {
        return result({mode: "loading", label: "Checking private session", disabled: true});
    }
    if (isPrivate && Venue.snap.sessionKyc !== 1) {
        return result({
            mode: "session-setup",
            label: "Renew private session",
            disabled: false,
            blocker: "The rotating session needs a current private eligibility proof.",
        });
    }
    if (!isPrivate && Venue.snap.kyc === undefined) {
        return result({mode: "loading", label: "Checking account", disabled: true});
    }
    if (!isPrivate && Venue.snap.kyc !== 1) {
        return result({
            mode: "eligibility",
            label: "Review eligibility",
            disabled: false,
            blocker: "This wallet needs a current eligibility grant before it can safely trade.",
        });
    }
    const attached = !isPrivate && Venue._liveHolds?.find((hold) =>
        String(hold.holdId) === String(record?.holdId || "")
        && asBig(hold.amount) >= o.qty
        && asBig(hold.expiry) > nowSec());
    const availableLprc = isPrivate ? Venue.snap.sessionFree : Venue.snap.free;
    const availableHbar = isPrivate ? Venue.snap.sessionTinybar : Venue.snap.walletTinybar;
    if (o.side === 1 && availableLprc === undefined) {
        return result({
            mode: "loading",
            label: "Checking available LPRC",
            disabled: true,
            blocker: "The available LPRC balance must be confirmed before placing.",
        });
    }
    if (o.side === 1 && !attached && availableLprc !== undefined && availableLprc < o.qty) {
        return result({
            mode: isPrivate ? "session-fund" : "balance",
            label: isPrivate ? "Fund private session" : "Not enough inventory",
            disabled: !isPrivate,
            blocker: "This sell needs " + formatQuantity(o.qty) + " LPRC. Shortfall: " +
                formatQuantity(o.qty - availableLprc) + " LPRC in the " +
                (isPrivate ? "private session." : "connected wallet."),
        });
    }
    const requiredHbar = isPrivate ? funds.privateRequired : funds.manualRequired;
    if (availableHbar === undefined || requiredHbar === null) {
        return result({
            mode: "loading",
            label: "Checking minimum HBAR",
            disabled: true,
            blocker: "The HBAR balance and current network fee quote must be confirmed first.",
        });
    }
    if (availableHbar !== undefined && requiredHbar !== null && availableHbar < requiredHbar) {
        return result({
            mode: isPrivate ? "session-fund" : "balance",
            label: isPrivate ? "Fund private session" : "Not enough HBAR",
            disabled: !isPrivate,
            blocker: "Minimum " + readableHbar(requiredHbar) + " HBAR. Shortfall: " +
                readableHbar(requiredHbar - availableHbar) + " HBAR in the " +
                (isPrivate ? "private session." : "connected wallet."),
        });
    }
    if (isPrivate) {
        return result({
            mode: "private-commit",
            label: "Place privately + auto reveal",
            disabled: false,
        });
    }
    const recoverable = saved && (
        Venue.ticketVaultReady(Venue.account)
        || Venue._exportedTickets.has(String(o.id).toLowerCase())
    );
    if (!saved) {
        return result({mode: "secure", label: "Save order changes", disabled: false});
    }
    if (!recoverable) {
        return result({
            mode: "backup",
            label: "Export recovery copy",
            disabled: false,
            blocker: "Encrypted device storage is unavailable. Export this order before submitting.",
        });
    }
    return result({
        mode: isPrivate ? "private-commit" : "commit",
        label: isPrivate
            ? "Place privately + auto reveal"
            : o.side === 1 && !attached
                ? "Reserve & place sell"
                : "Place sealed " + (o.side === 1 ? "sell" : "buy"),
        disabled: false,
    });
};

Venue.showOrderStage = function (stage) {
    const allowed = ["details", "review", "track"];
    const next = allowed.includes(stage) ? stage : "details";
    Venue.orderStage = next;
    const panel = $("order-panel");
    if (panel) panel.dataset.stage = next;
    document.querySelectorAll("[data-order-stage]").forEach((section) => {
        section.hidden = section.dataset.orderStage !== next;
    });
    const labels = {
        details: "Order details",
        review: "Review order",
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
        back.textContent = "Edit details";
    }
};

Venue.paintPrivateRecovery = function (ticket, phase) {
    const wrap = $("private-recovery-wrap");
    const copy = $("private-recovery-copy");
    const action = $("private-recovery-action");
    if (!wrap || !copy || !action) return;
    const privateOrder = ticket?.path === "private"
        && !ticket.cancelled
        && !ticket.revealed;
    wrap.hidden = !privateOrder;
    if (!privateOrder) {
        delete action.dataset.confirm;
        return;
    }
    const releaseAt = asBig(ticket.releaseAt || 0);
    const due = releaseAt > 0n && nowSec() >= releaseAt;
    const revealable = due && phase?.phase === "reveal";
    action.disabled = !revealable;
    action.textContent = revealable
        ? action.dataset.confirm === "1"
            ? "Confirm public link and reveal"
            : "Emergency wallet reveal"
        : phase?.phase === "lost"
            ? "Reveal window closed"
            : "Available after automatic release";
    copy.textContent = revealable
        ? "Use this only if automation is not advancing. The wallet paying this transaction becomes publicly linkable to the private session."
        : phase?.phase === "lost"
            ? "The protocol reveal window has closed, so neither automation nor wallet recovery can reveal this order."
            : "Automatic reveal needs no wallet action. The emergency fallback unlocks at the scheduled release time and reduces privacy.";
};

Venue.paintOrderTrack = function () {
    const who = Venue.viewer();
    const tickets = who ? Venue.ticketList(who) : [];
    const ticket = tickets.find((item) => item.id === Venue.trackTicketId)
        || tickets.find((item) => item.committedAt && !item.cancelled);
    const status = $("track-status-label");
    const title = $("track-status-title");
    const copy = $("track-status-copy");
    const deadline = $("track-deadline");
    const deadlineWrap = $("track-deadline-wrap");
    const deadlineLabel = $("track-deadline-label");
    const showDeadline = (label, value) => {
        if (deadlineLabel) deadlineLabel.textContent = label;
        if (deadline) deadline.textContent = value;
        if (deadlineWrap) deadlineWrap.hidden = !value;
    };
    if (deadlineWrap) deadlineWrap.hidden = true;
    if (!ticket) {
        Venue.paintPrivateRecovery(null, null);
        if (status) status.textContent = "No submitted order";
        if (title) title.textContent = "Start with new order details";
        if (copy) copy.textContent = "Your next order action will appear here.";
        return {mode: "new", label: "Start another order", disabled: false};
    }
    Venue.trackTicketId = ticket.id;
    const chain = Venue._ticketChains.get(String(ticket.id).toLowerCase()) || {
        committer: ticket.committer,
        committedAt: ticket.committedAt || 0,
        cancelled: !!ticket.cancelled,
        revealed: !!ticket.revealed,
    };
    const phase = Venue.ticketPhase(ticket, chain);
    Venue.paintPrivateRecovery(ticket, phase);
    const automated = ticket.path === "private" || ticket.automaticReveal === true;
    const closes = asBig(chain.committedAt || 0)
        + asBig(CLIENT.immutables.revealDelay)
        + asBig(CLIENT.immutables.revealWindow);
    if (phase.phase === "cancel") {
        if (status) status.textContent = "Sealed";
        if (title) {
            title.textContent = automated
                ? "Auto reveal scheduled"
                : "Reveal opens in " + fmtRemain(phase.until - nowSec());
        }
        if (copy) {
            copy.textContent = automated
                ? "The encrypted ticket is stored and will release inside the reveal window."
                : "Return before the deadline to reveal. You can replace or cancel before reveal opens.";
        }
        showDeadline(
            automated ? "Auto reveal scheduled" : "Reveal by",
            ticketDate(automated && ticket.releaseAt ? ticket.releaseAt : automated ? phase.until : closes),
        );
        return Venue.account
            ? {mode: "replace-track", label: "Replace order", disabled: false}
            : {mode: "connect", label: "Connect to manage order", disabled: false};
    } else if (phase.phase === "reveal") {
        if (status) status.textContent = automated ? "Auto reveal scheduled" : "Reveal required";
        if (title) {
            title.textContent = automated
                ? "Automatic reveal is processing"
                : "Reveal within " + fmtRemain(phase.until - nowSec());
        }
        if (copy) {
            copy.textContent = automated
                ? "No wallet action is expected. Open recovery details only if this status does not advance."
                : Number(ticket.side) === 1
                    ? "Reserve the required LPRC, then reveal in a wallet transaction."
                    : "Fund the full limit value, then reveal in a wallet transaction.";
        }
        showDeadline(automated ? "Auto reveal scheduled" : "Reveal by", ticketDate(phase.until));
        if (automated) return {mode: "waiting", label: "Auto reveal processing", disabled: true};
        if (!Venue.account) return {mode: "connect", label: "Connect to reveal", disabled: false};
        if (Venue.snap.kyc !== 1) {
            return {mode: "eligibility", label: "Renew eligibility", disabled: false};
        }
        const backing = Venue._liveHolds?.find((hold) =>
            String(hold.holdId) === String(ticket.holdId || "")
            && asBig(hold.amount) >= asBig(ticket.qty)
            && asBig(hold.expiry) > nowSec());
        return Number(ticket.side) === 1 && !backing
            ? {mode: "reserve-reveal", label: "Reserve & reveal sell", disabled: false}
            : {mode: "reveal-track", label: "Reveal order", disabled: false};
    } else if (phase.phase === "lost") {
        if (status) status.textContent = "Reveal missed";
        if (title) title.textContent = "The reveal window has closed";
        if (copy) copy.textContent = "The deposit can now be claimed by a permissionless sweeper.";
        return {mode: "lost", label: "Reveal window closed", disabled: true};
    } else if (phase.phase === "cancelled") {
        if (status) status.textContent = "Cancelled";
        if (title) title.textContent = "Refund moved to trading credit";
        if (copy) copy.textContent = "The cancellation fee was retained. Withdraw the remaining credit separately.";
        return {mode: "new", label: "Place another order", disabled: false};
    } else if (phase.phase === "done") {
        const orderState = Venue._ticketOrderStates.get(String(ticket.id).toLowerCase());
        const order = orderState?.order;
        const retired = !!order?.retired;
        const needsPrivateSweep = ticket.path === "private"
            && retired
            && asBig(orderState?.credit || 0) > 0n;
        const readyToRelease = !!order
            && (
                needsPrivateSweep
                || (
                    !retired
                    && Venue.snap.round !== undefined
                    && asBig(Venue.snap.round) > asBig(order.lastRound)
                )
            );
        if (readyToRelease) {
            if (status) status.textContent = "Ready to release";
            if (title) {
                title.textContent = needsPrivateSweep
                    ? "Move returned funds into the private session"
                    : "Unlock the remaining order funds";
            }
            if (copy) {
                copy.textContent = needsPrivateSweep
                    ? "The order is retired. Its engine credit still needs a relayed sweep."
                    : "The final auction round has passed. Release has no deadline.";
            }
            return Venue.account
                ? {mode: "release-track", label: "Release order", disabled: false}
                : {mode: "connect", label: "Connect to release", disabled: false};
        }
        if (retired) {
            if (status) status.textContent = "Complete";
            if (title) title.textContent = "Order funds released";
            if (copy) copy.textContent = "Inventory and trading credit reflect the final outcome.";
            return {mode: "new", label: "Place another order", disabled: false};
        }
        if (status) status.textContent = "Revealed";
        if (title) title.textContent = "Placed terms are immutable";
        if (copy) copy.textContent = "Await the auction or create a new order on the opposite side.";
        return {mode: "offset-track", label: "Place opposite order", disabled: false};
    }
    return {mode: "waiting", label: "Order tracked", disabled: true};
};

Venue.paintOrderPaths = function (o) {
    const funds = Venue.orderFunds(o);
    const privateState = Venue.guidedOrderState(o, "private");
    const privateReadiness = Venue.privatePathReadiness(o.side);
    const manualState = Venue.guidedOrderState(o, "manual");
    const privateAction = $("commit-auto");
    const manualAction = $("commit-manual");
    if (privateAction) {
        privateAction.dataset.action = privateState.mode;
        privateAction.disabled = !!privateState.disabled
            && privateState.mode !== "unavailable"
            && privateState.mode !== "connect"
            && privateState.mode !== "session-setup"
            && privateState.mode !== "session-fund";
        privateAction.classList.remove("is-blocked");
        privateAction.removeAttribute("title");
    }
    if (manualAction) {
        manualAction.dataset.action = manualState.mode;
        manualAction.disabled = !!manualState.disabled;
        manualAction.title = manualState.blocker || "";
    }
    if ($("manual-path-steps")) {
        $("manual-path-steps").textContent = "Uses this wallet · " +
            (o.side === 1 ? "3 wallet approvals" : "2 wallet approvals");
    }
    const manualAvailable = o.side === 1
        ? Venue.snap.free === undefined
            ? "Wallet balance unavailable"
            : formatQuantity(Venue.snap.free) + " LPRC in wallet"
        : Venue.snap.walletTinybar === undefined
            ? "Wallet balance unavailable"
            : readableHbar(Venue.snap.walletTinybar) + " HBAR in wallet";
    if ($("manual-path-balance")) $("manual-path-balance").textContent = manualAvailable;
    if ($("manual-path-fee")) {
        $("manual-path-fee").textContent = funds.network.manual === null
            ? "Network fee quote loading"
            : "Est. " + readableHbar(funds.network.manual) + " HBAR network fee";
    }
    if ($("path-privacy-copy")) {
        $("path-privacy-copy").textContent = (privateReadiness.reason || CLIENT.privateTrading?.reason || (
            "Private recurring gas must remain within 10% of direct gas, with a 15% hard stop. " +
            "Registration, routing, top-ups, and session rotation are quoted separately."
        ));
    }
    return {privateState, manualState};
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
            mode: incomplete ? "review" : Venue.account ? "review" : "connect",
            label: incomplete
                ? "Enter order details"
                : Venue.account
                    ? "Review order"
                    : "Connect wallet to review",
            disabled: incomplete,
        };
    } else if (stage === "review") {
        if (state.mode === "new") {
            Venue.trackTicketId = Venue.draftRecord(o)?.id || o.id;
            stage = "track";
            Venue.showOrderStage(stage);
            view = Venue.paintOrderTrack();
        } else {
            view = state;
        }
    } else {
        view = state.mode === "busy" ? state : Venue.paintOrderTrack();
    }

    Venue.showOrderStage(stage);
    Venue.paintOrderPaths(o);
    if (action) {
        action.dataset.action = view.mode;
        action.textContent = view.label;
        action.disabled = !!view.disabled;
        action.classList.toggle("is-danger", !!view.danger);
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
    Venue.editingDraftId = null;
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

Venue.startOffsettingOrder = function (id) {
    const ticket = Venue.ticketList(Venue.viewer()).find((item) => item.id === id);
    if (!ticket) throw new Error("The order is not available on this device.");
    Venue.setSide(Number(ticket.side) === 1 ? 0 : 1);
    $("price").value = formatHbar(asBig(ticket.price));
    $("qty").value = String(ticket.qty);
    $("price").dataset.touched = "1";
    $("qty").dataset.touched = "1";
    if ($("holdId")) $("holdId").value = "";
    Venue.trackTicketId = null;
    Venue.editingDraftId = null;
    Venue.reroll();
    Venue.showOrderStage("details");
    Venue.status(
        "trade-status",
        "Opposite-side order prefilled. Review its new price, quantity, and reveal key.",
        "ok",
    );
    Venue.paintTicket();
    $("price")?.focus();
    document.querySelector(".order-panel")?.scrollIntoView({behavior: "smooth", block: "start"});
};

Venue.doGuidedOrderAction = async function () {
    const mode = $("commit")?.dataset.action;
    if (mode === "review") {
        Venue.showOrderStage("review");
        Venue.paintTicket();
        return;
    }
    if (mode === "secure") {
        await Venue.secureDraft();
        Venue.paintTicket();
        Venue.paintTickets();
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
    if (mode === "cancel-track") {
        await Venue.doCancel(Venue.trackTicketId);
        return;
    }
    if (mode === "replace-track") {
        await Venue.replaceTicket(Venue.trackTicketId);
        return;
    }
    if (mode === "offset-track") {
        Venue.startOffsettingOrder(Venue.trackTicketId);
        return;
    }
    if (mode === "reveal-track") {
        await Venue.doReveal(Venue.trackTicketId);
        return;
    }
    if (mode === "reserve-reveal") {
        const holdId = await Venue.reserveForTicket(Venue.trackTicketId);
        if (holdId) await Venue.doReveal(Venue.trackTicketId, {afterReservation: true});
        return;
    }
    if (mode === "release-track") {
        await Venue.doExpire(Venue.trackTicketId);
        return;
    }
    if (mode === "new") Venue.startNewOrder();
};

Venue.doOrderPath = async function (path) {
    const o = Venue.readOrder();
    const state = Venue.guidedOrderState(o, path);
    if (state.mode === "unavailable") {
        const reason = state.blocker
            || "Private trading is not bound on this deployment yet.";
        const blocker = $("order-blocker");
        if (blocker) {
            blocker.hidden = false;
            blocker.textContent = reason;
            blocker.className = "order-blocker";
        }
        Venue.status("trade-status", reason, "bad");
        return;
    }
    if (state.disabled) throw new Error(state.blocker || state.label);
    if (state.mode === "connect") {
        Venue.openSheet();
        return;
    }
    if (state.mode === "eligibility") {
        window.location.href = "prove.html";
        return;
    }
    if (state.mode === "session-setup" || state.mode === "session-fund") {
        if (typeof Venue.runPrivatePathClick === "function") {
            await Venue.runPrivatePathClick(o, state.mode);
            return;
        }
        if (typeof Venue.openPrivateSetup === "function") {
            await Venue.openPrivateSetup({
                stage: state.mode === "session-fund" ? "fund" : undefined,
                side: o.side,
            });
            return;
        }
        throw new Error(state.blocker);
    }
    if (state.mode === "secure") {
        await Venue.secureDraft();
        return Venue.doOrderPath(path);
    }
    if (state.mode === "backup") {
        await Venue.saveTicketNow();
        return;
    }
    if (state.mode === "commit") {
        await Venue.doCommit();
        return;
    }
    if (state.mode === "private-commit") {
        if (typeof Venue.placePrivateOrder !== "function") {
            throw new Error("Private order submission is not enabled in this deployment.");
        }
        await Venue.placePrivateOrder(o);
        return;
    }
    if (state.mode === "new") Venue.startNewOrder();
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
        : "Encrypted on this device after review. Export is optional.";
    $("saltHint").classList.toggle("bad", !!o.bad.salt);
    if ($("qty-availability")) {
        $("qty-availability").textContent = o.side === 1
            ? (Venue.snap.free === undefined
                ? "Unavailable"
                : formatQuantity(Venue.snap.free) + " LPRC available")
            : "Whole bonds";
    }
    if ($("order-balance-label")) {
        $("order-balance-label").textContent = o.side === 1
            ? "LPRC available"
            : "HBAR available";
    }
    if ($("order-balance-value")) {
        $("order-balance-value").textContent = o.side === 1
            ? (Venue.snap.free === undefined
                ? "Unavailable"
                : formatQuantity(Venue.snap.free) + " LPRC")
            : (Venue.snap.walletTinybar === undefined
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
        $("summary-reveal-label").textContent = o.side === 1
            ? "Sell inventory"
            : "HBAR funded at reveal";
    }
    if ($("summary-reveal")) {
        $("summary-reveal").textContent = funds.limit === null
            ? "Enter order details"
            : o.side === 1
                ? formatQuantity(o.qty) + " LPRC"
                : readableHbar(funds.limit) + " HBAR";
    }
    if ($("summary-total-label")) {
        $("summary-total-label").textContent = "Direct minimum HBAR";
    }
    if ($("summary-total")) {
        $("summary-total").textContent = funds.limit === null
            ? "Enter order details"
            : readableHbar(funds.manualRequired) + " HBAR" +
                (funds.network.manual === null ? " + network quote" : "");
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
            "Automatic places the reveal inside the window. Direct requires you to return within " +
            CLIENT.immutables.revealWindow + " seconds after it opens.";
    }
    if ($("submit-order")) {
        $("submit-order").textContent = funds.limit === null
            ? "Complete the order first"
            : (o.side === 1 ? "Sell " : "Buy ") + formatQuantity(o.qty) +
                " LPRC at " + formatHbar(o.price) + " HBAR per bond";
    }
    if ($("submit-deposit")) {
        $("submit-deposit").textContent =
            funds.manualRequired === null
                ? "Complete the order to calculate the minimum balance"
                : readableHbar(funds.manualRequired) + " HBAR minimum for the direct path";
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
    if ($("save-ticket")) $("save-ticket").disabled = !o.ok;
    Venue.syncHoldField();
    const attached = Venue._liveHolds?.find((hold) =>
        String(hold.holdId) === String($("holdId")?.value || "")
        && !o.bad.qty
        && asBig(hold.amount) >= o.qty
        && asBig(hold.expiry) > nowSec());
    $("hold-field")?.classList.toggle("is-complete", !!attached);
    Venue.paintGuidedOrder(o);
};

Venue.draftTicket = function (o) {
    return {
        v: TICKET_VER,
        path: "manual",
        automaticReveal: false,
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

Venue.secureDraft = async function () {
    await Venue.requireAccount();
    const o = Venue.readOrder();
    if (!o.ok) throw new Error("Fix the order fields first.");
    const ticket = Venue.draftTicket(o);
    const previousId = Venue.editingDraftId;
    const current = Venue.ticketList(Venue.account);
    const next = current.filter((item) =>
        !(
            previousId
            && previousId !== ticket.id
            && item.id === previousId
            && !item.committedAt
        ));
    const at = next.findIndex((item) => item.id === ticket.id);
    if (at === -1) next.unshift(ticket);
    else next[at] = {...next[at], ...ticket};
    await Venue.persistTickets(Venue.account, next);
    Venue.editingDraftId = ticket.id;
    Venue.status("trade-status", "Reveal key encrypted on this device.", "ok");
    return ticket;
};

Venue.saveTicketNow = async function () {
    await Venue.requireAccount();
    const o = Venue.readOrder();
    if (!o.ok) throw new Error("Fix the order fields first.");
    const t = {...Venue.draftRecord(o), ...Venue.draftTicket(o)};
    if (Venue.ticketVaultReady(Venue.account)) {
        await Venue.upsertTicket(Venue.account, t);
    } else {
        Venue.cacheTicket(Venue.account, t);
    }
    downloadJson(ticketName(t), ticketFile(t));
    Venue._exportedTickets.add(String(t.id).toLowerCase());
    Venue.editingDraftId = t.id;
    Venue.status("trade-status", "Recovery copy exported. No wallet transaction was sent.", "ok");
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

Venue.reconcileTicketRecord = async function (record) {
    try {
        const chain = await Venue.c.engine.commitments(record.id);
        if (!chain?.committer || addrEq(chain.committer, ZERO)) return record;
        if (!addrEq(chain.committer, record.committer)) {
            throw new Error("The restored order belongs to another submitting wallet.");
        }
        return {
            ...record,
            committedAt: asBig(chain.committedAt).toString(),
            cancelled: !!chain.cancelled,
            revealed: !!chain.revealed,
        };
    } catch (error) {
        if (/another submitting wallet/.test(error?.message || "")) throw error;
        return record;
    }
};

Venue.ingestTickets = async function (list) {
    if (!Venue.account) return [];
    if (!Array.isArray(list)) throw new Error("The recovery file does not contain an order list.");
    if (list.length > 500) throw new Error("The recovery file contains too many orders.");
    const records = await Promise.all(list
        .map((ticket) => ticketRecord(ticket, Venue.account))
        .map((ticket) => Venue.reconcileTicketRecord(ticket)));
    try {
        await Venue.persistTickets(
            Venue.account,
            mergeTicketRecords(Venue.ticketList(Venue.account), records),
        );
    } catch {
        for (const record of records) {
            Venue.cacheTicket(Venue.account, record);
            Venue._exportedTickets.add(String(record.id).toLowerCase());
        }
    }
    return records;
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
    await Venue.requireAccount();
    const [record] = await Venue.ingestTickets([obj]);
    Venue.applyTicketToForm(record);
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
    await Venue.ingestTickets([obj]);
    Venue.status("trade-status", "One sealed order restored from the file.", "ok");
    await Venue.paintTickets();
};

Venue.importVaultBlob = async function (obj) {
    await Venue.requireAccount();
    if (obj.account && !addrEq(obj.account, Venue.account)) {
        throw new Error("That vault belongs to another account.");
    }
    const list = ticketsFromBlob(obj) || [];
    const n = (await Venue.ingestTickets(list)).length;
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
    const obj = vaultFile(who, Venue.ticketList(who));
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
    let ticket = Venue.draftRecord(o);
    if (!ticket) ticket = await Venue.secureDraft();
    const recoverable = Venue.ticketVaultReady(Venue.account)
        || Venue._exportedTickets.has(String(o.id).toLowerCase());
    if (!recoverable) {
        throw new Error("Export a recovery copy before reserving inventory.");
    }
    const existing = Venue._liveHolds?.find((candidate) =>
        String(candidate.holdId) === String($("holdId")?.value || "")
        && asBig(candidate.amount) >= o.qty
        && asBig(candidate.expiry) > nowSec());
    if (existing) {
        if (String(ticket.holdId || "") !== String(existing.holdId)) {
            const updated = {...ticket, holdId: String(existing.holdId)};
            if (Venue.ticketVaultReady(Venue.account)) {
                try {
                    await Venue.upsertTicket(Venue.account, updated);
                } catch {
                    Venue.cacheTicket(Venue.account, updated);
                }
            } else {
                Venue.cacheTicket(Venue.account, updated);
            }
        }
        return String(existing.holdId);
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
    const reserveLabel = "Reserve LPRC (1 of 3)";
    Venue.tradeTxStage("approval", reserveLabel);
    const rec = await Venue.send(
        () => Venue.w.holds.createHoldByPartition(
            CLIENT.immutables.partition,
            hold,
            {gasLimit: 1_000_000},
        ),
        reserveLabel
    );
    if (!rec) return;
    const holdId = asBig(predicted).toString();
    $("holdId").value = holdId;
    upsert("holds", Venue.account, {
        v: HOLD_VER, holdId, amount: o.qty.toString(), expiry: needed.toString(),
        tx: rec.hash, at: new Date().toISOString(),
    }, "holdId");
    if (ticket) {
        const updated = {...ticket, holdId};
        if (Venue.ticketVaultReady(Venue.account)) {
            try {
                await Venue.upsertTicket(Venue.account, updated);
            } catch {
                Venue.cacheTicket(Venue.account, updated);
            }
        } else {
            Venue.cacheTicket(Venue.account, updated);
        }
    }
    Venue.status("trade-status",
        formatQuantity(o.qty) + " LPRC reserved for this sell.",
        "ok");
    await Venue.refreshTrade();
    return holdId;
};

Venue.doCommit = async function () {
    await Venue.requireAccount();
    const o = Venue.readOrder();
    if (!o.ok) throw new Error("Fix the order fields first.");
    const state = Venue.guidedOrderState(o);
    if (state.mode !== "commit") {
        throw new Error(state.blocker || "Back up this order before submitting it.");
    }
    if (o.side === 1) {
        const attached = Venue._liveHolds?.find((hold) =>
            String(hold.holdId) === String($("holdId")?.value || "")
            && asBig(hold.amount) >= o.qty
            && asBig(hold.expiry) > nowSec());
        if (!attached) {
            Venue.status("trade-status", "Approval 1 of 3: reserve LPRC.", "");
            const holdId = await Venue.doHold();
            if (!holdId) return;
        }
    }
    const t = Venue.draftTicket(o);
    const saved = Venue.draftRecord(o);
    const prepared = {...saved, ...t, holdId: $("holdId")?.value || t.holdId || null};
    if (Venue.ticketVaultReady(Venue.account)) {
        try {
            await Venue.upsertTicket(Venue.account, prepared);
        } catch {
            Venue.cacheTicket(Venue.account, prepared);
        }
    } else {
        Venue.cacheTicket(Venue.account, prepared);
    }
    const bond = asBig(await Venue.c.engine.commitBond());
    const value = toWeibar(bond);
    const commitLabel = o.side === 1 ? "Place sell (2 of 3)" : "Place buy (1 of 2)";
    Venue.tradeTxStage("approval", commitLabel);
    const rec = await Venue.send(
        () => Venue.w.engine.commit(o.id, {value, gasLimit: 400_000}),
        commitLabel
    );
    if (!rec) return;
    const cmt = await Venue.c.engine.commitments(o.id);
    const committed = {
        ...t,
        committedAt: cmt.committedAt.toString(),
        commitTx: rec.hash,
        holdId: t.holdId || $("holdId")?.value || null,
    };
    try {
        if (Venue.ticketVaultReady(Venue.account)) {
            await Venue.upsertTicket(Venue.account, committed);
        } else {
            Venue.cacheTicket(Venue.account, committed);
        }
    } catch {
        Venue.cacheTicket(Venue.account, committed);
    }
    Venue.editingDraftId = null;
    Venue.trackTicketId = o.id;
    Venue.showOrderStage("track");
    Venue.status("trade-status",
        "Order placed. Reveal opens in " + CLIENT.immutables.revealDelay + " seconds.",
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
    const automated = card.dataset.path === "private";
    const releaseAt = card.dataset.releaseAt || null;
    const revealing = Venue.revealPending.has(id);
    const processing = revealing || Venue.busy;
    if (ph.phase === "cancel") {
        status.className = "order-status waiting";
        status.textContent = automated ? "Auto reveal scheduled" : "Sealed";
        title.textContent = automated
            ? "Encrypted ticket stored"
            : "Reveal opens in " + fmtRemain(ph.until - nowSec());
        copy.textContent = automated
            ? "No wallet action is expected."
            : "Return to reveal before the deadline.";
        if (deadline) {
            deadline.textContent = automated
                ? "Scheduled " + ticketDate(releaseAt || ph.until)
                : ticketDate(
                    asBig(card.dataset.t0 || 0) +
                    asBig(CLIENT.immutables.revealDelay) +
                    asBig(CLIENT.immutables.revealWindow)
                );
        }
        row.innerHTML = '<button type="button" class="primary" data-act="replace" data-id="' +
            esc(id) + '">Replace order</button><button type="button" class="danger" data-act="cancel" data-id="' +
            esc(id) + '">Cancel</button>';
        card.className = "order-card waiting";
    } else if (ph.phase === "reveal") {
        if (automated) {
            status.className = "order-status waiting";
            status.textContent = "Auto reveal scheduled";
            title.textContent = "Automatic reveal is processing";
            copy.textContent = "No wallet action is expected.";
            if (deadline) deadline.textContent = "Reveal by " + ticketDate(ph.until);
            row.innerHTML = "";
            card.className = "order-card waiting";
            return;
        }
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
            ? '<button type="button" class="primary' + (processing ? ' stale' : '') +
                '" data-act="reserve-reveal" data-id="' + esc(id) + '"' +
                (processing
                    ? ' disabled aria-busy="true">Reservation processing</button>'
                    : ' aria-busy="false">Reserve &amp; reveal</button>')
            : '<button type="button" class="primary' + (processing ? ' stale' : '') +
                '" data-act="reveal" data-id="' + esc(id) + '"' +
                (processing
                    ? ' disabled aria-busy="true">Reveal processing</button>'
                    : ' aria-busy="false">Reveal order</button>');
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
    if (Venue.orderStage === "track" && $("commit")) {
        Venue.paintGuidedOrder(Venue.readOrder());
    }
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
        if (act === "cancel") {
            const ticket = Venue.ticketList(Venue.viewer()).find((item) => item.id === id);
            const action = ticket?.path === "private"
                ? Venue.cancelPrivateOrder(ticket)
                : Venue.doCancel(id);
            action.catch((err) => Venue.fail(err));
        }
        if (act === "replace") Venue.replaceTicket(id).catch((err) => Venue.fail(err));
        if (act === "reveal") Venue.doReveal(id).catch((err) => Venue.fail(err));
        if (act === "reserve") Venue.reserveForTicket(id).catch((err) => Venue.fail(err));
        if (act === "reserve-reveal") {
            Venue.reserveForTicket(id)
                .then((holdId) => holdId ? Venue.doReveal(id, {afterReservation: true}) : null)
                .catch((err) => Venue.fail(err));
        }
        if (act === "load") Venue.continueTicket(id);
        if (act === "discard") Venue.discardDraft(id).catch((err) => Venue.fail(err));
        if (act === "offset") Venue.startOffsettingOrder(id);
        if (act === "new") {
            Venue.startNewOrder();
            document.querySelector(".order-panel")?.scrollIntoView({behavior: "smooth", block: "start"});
        }
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
    const t = Venue.ticketList(Venue.viewer()).find((item) => item.id === id);
    if (!t) return;
    Venue.applyTicketToForm(t);
    Venue.trackTicketId = t.committedAt ? t.id : null;
    Venue.editingDraftId = t.committedAt ? null : t.id;
    Venue.showOrderStage(t.committedAt ? "track" : "details");
    if (!t.committedAt) {
        Venue.status(
            "trade-status",
            t.holdId
                ? "Edit the order. Its reservation will be reused when it still covers the quantity."
                : "Edit the order, then review it again.",
            "ok",
        );
    }
    Venue.paintTicket();
    document.querySelector(".order-panel")?.scrollIntoView({behavior: "smooth", block: "start"});
};

Venue.discardDraft = async function (id) {
    if (!Venue.account) return;
    const tickets = Venue.ticketList(Venue.account);
    const target = tickets.find((t) => t.id === id);
    if (!target || target.committedAt) return;
    await Venue.removeTicket(Venue.account, id);
    if (Venue.editingDraftId === id) Venue.editingDraftId = null;
    Venue._ticketSig = "";
    Venue.status("trade-status", "Local draft removed. No on-chain order was changed.", "ok");
    Venue.paintTicket();
    Venue.paintTickets();
};

Venue.reserveForTicket = async function (id) {
    await Venue.requireAccount();
    if (Venue.snap.kyc !== 1) {
        throw new Error("Renew eligibility before reserving inventory for this order.");
    }
    const t = Venue.ticketList(Venue.account).find((item) => item.id === id);
    if (!t) throw new Error("Restore this order's recovery file before reserving inventory.");
    Venue.applyTicketToForm(t);
    Venue.trackTicketId = t.id;
    Venue.showOrderStage("track");
    Venue.paintTicket();
    await Venue.attachHold();
    const attached = ($("holdId")?.value || "").trim();
    if (attached) {
        if (Venue.ticketVaultReady(Venue.account)) {
            await Venue.upsertTicket(Venue.account, {...t, holdId: attached});
        } else {
            Venue.cacheTicket(Venue.account, {...t, holdId: attached});
        }
        Venue.status("trade-status", "Existing LPRC reservation attached.", "ok");
        Venue._ticketSig = "";
        await Venue.paintTickets();
        return attached;
    }
    const created = await Venue.doHold();
    if (created) {
        Venue._ticketSig = "";
        await Venue.attachHold();
        await Venue.paintTickets();
    }
    return created;
};

Venue.paintOrderAttention = function ({urgent = 0, release = 0, missed = 0} = {}) {
    const box = $("order-attention");
    if (!box) return;
    const title = $("order-attention-title");
    const copy = $("order-attention-copy");
    if (urgent) {
        box.hidden = false;
        box.dataset.tone = "warning";
        title.textContent = urgent + " order" + (urgent === 1 ? "" : "s") + " must be revealed now";
        copy.textContent = "Reveal before the deadline to protect the deposit and enter the auction.";
        return;
    }
    if (missed) {
        box.hidden = false;
        box.dataset.tone = "danger";
        title.textContent = missed + " reveal deadline" + (missed === 1 ? " was" : "s were") + " missed";
        copy.textContent = "The affected deposit is now exposed to permissionless forfeiture.";
        return;
    }
    if (release) {
        box.hidden = false;
        box.dataset.tone = "info";
        title.textContent = release + " order" + (release === 1 ? " has" : "s have") + " funds ready to unlock";
        copy.textContent = "Release the remaining reserve and move the deposit to withdrawable credit. There is no deadline.";
        return;
    }
    box.hidden = true;
    delete box.dataset.tone;
};

Venue.pollPrivateTicketStates = async function (tickets) {
    if (!Venue.account || !Array.isArray(tickets)) return tickets;
    const owner = Venue.account;
    const states = await Promise.all(tickets.map(async (ticket) => {
        if (
            ticket.path !== "private"
            || ticket.serviceState === "CANCELLED"
            || ticket.serviceState === "REVEALED"
        ) {
            return ticket;
        }
        try {
            const summary = Venue.assertPrivateTicketSummary(
                ticket,
                await Venue.readPrivateTicketSummary(ticket),
            );
            const labels = {
                PREARMED: "Stored",
                PLACED: "Auto reveal scheduled",
                WAITING_BEACON: "Auto reveal scheduled",
                DECRYPTING: "Auto reveal processing",
                REVEALING: "Auto reveal processing",
                BROADCAST_UNKNOWN: "Auto reveal processing",
                REVEALED: "Revealed",
                CANCELLED: "Cancelled",
                MISSED: "Recovery needed",
            };
            const next = {
                ...ticket,
                serviceState: String(summary.state),
                automationState: labels[summary.state] || ticket.automationState,
            };
            if (summary.state === "REVEALED") {
                next.revealed = true;
                next.revealTx = summary.broadcast?.transactionHash || ticket.revealTx;
                next.revealedAt = String(
                    Math.floor(Number(summary.updatedAtMs || Date.now()) / 1000),
                );
            } else if (summary.state === "CANCELLED") {
                next.cancelled = true;
                next.cancelTx = summary.broadcast?.transactionHash || ticket.cancelTx;
            }
            return next;
        } catch {
            return ticket;
        }
    }));
    if (!addrEq(Venue.account, owner)) return tickets;
    if (states.some((ticket, index) =>
        JSON.stringify(ticket) !== JSON.stringify(tickets[index]))) {
        await Venue.persistTickets(owner, states);
        return Venue.ticketList(owner);
    }
    return tickets;
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
    await Venue.hydrateTicketVault(who);
    let tickets = Venue.ticketList(who);
    if (Venue.account && addrEq(who, Venue.account)) {
        tickets = await Venue.pollPrivateTicketStates(tickets);
    }
    if (!tickets.length) {
        Venue._ticketSig = "empty:" + who.toLowerCase();
        box.classList.remove("boxed");
        heading?.classList.remove("live");
        box.innerHTML = '<div class="empty">No orders are encrypted on this device. Place an order or restore a backup.</div>';
        Venue.paintOrderAttention();
        return;
    }
    const chains = await Promise.all(tickets.map((t) =>
        Venue.c.engine.commitments(t.id).catch(() => null)
    ));
    if (!Venue.stillViewer(who)) return;
    Venue._ticketChains = new Map(tickets.map((ticket, index) => [
        String(ticket.id).toLowerCase(),
        chains[index],
    ]));
    const kinds = chains.map((c, i) => ticketChainKind(c, tickets[i]));
    const round = Venue.snap.round ?? asBig(await Venue.c.engine.currentRound());
    const states = await Promise.all(tickets.map(async (t, i) => {
        const chain = chains[i];
        if (!chain?.revealed || !chain.committer || addrEq(chain.committer, ZERO)) return null;
        try {
            const [order, live, credit] = await Promise.all([
                Venue.c.engine.orders(t.id),
                Venue.c.engine.isLive(t.id),
                t.path === "private"
                    ? Venue.c.engine.credit(t.committer)
                    : Promise.resolve(0n),
            ]);
            return {order, live, credit};
        } catch {
            return null;
        }
    }));
    if (!Venue.stillViewer(who)) return;
    Venue._ticketOrderStates = new Map(tickets.map((ticket, index) => [
        String(ticket.id).toLowerCase(),
        states[index],
    ]));
    const validHolds = new Map((Venue._liveHolds || []).map((h) => [String(h.holdId), h]));
    const sig = who.toLowerCase() + "|" + round + "|" + tickets.map((t, i) => {
        const o = states[i]?.order;
        return t.id + ":" + kinds[i] + ":" + (o ? o.filled + ":" + o.lastRound + ":" + o.retired : "") +
            ":" + (states[i]?.credit || 0) +
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
        let badge = "Stored";
        let badgeTone = "";
        let nextTitle = t.holdId ? "Stored with reservation" : "Order stored";
        let nextCopy = t.holdId
            ? "Review or edit before placing."
            : "Review, edit, or remove this draft.";
        let actions = '<button type="button" class="primary" data-act="load" data-id="' +
            esc(t.id) + '">Edit details</button><button type="button" data-act="discard" data-id="' +
            esc(t.id) + '">Remove draft</button>';
        let needs = "";
        let deadline = null;
        let deadlineLabel = null;
        if (ph.phase === "cancel" || ph.phase === "reveal" || ph.phase === "lost") {
            tone = ph.phase === "cancel" ? "waiting" : "urgent";
            badge = t.path === "private" && ph.phase !== "lost"
                ? "Auto reveal scheduled"
                : ph.phase === "cancel"
                    ? "Sealed"
                    : ph.phase === "reveal"
                        ? "Reveal now"
                        : "Reveal missed";
            badgeTone = ph.phase === "cancel" ? "waiting" : "urgent";
            nextTitle = ph.label;
            nextCopy = "";
            actions = "";
            if (ph.until) {
                deadlineLabel = t.path === "private" ? "Auto reveal scheduled" : "Reveal by";
                deadline = t.path === "private"
                    ? ticketDate(t.releaseAt || ph.until)
                    : ticketDate(asBig(t0) + asBig(CLIENT.immutables.revealDelay) +
                        asBig(CLIENT.immutables.revealWindow));
            }
        } else if (kind === "cancelled") {
            badge = "Cancelled";
            nextTitle = "Refund ready to withdraw";
            nextCopy = "The cancellation fee was retained. The remainder of the deposit is trading credit.";
            actions = "";
        } else if (kind === "revealed" && order) {
            const retired = !!order.retired;
            const pastLast = !retired && round > asBig(order.lastRound);
            const needsPrivateSweep = t.path === "private"
                && retired
                && asBig(state.credit || 0) > 0n;
            if (needsPrivateSweep) {
                tone = "waiting";
                badge = "Ready to release";
                badgeTone = "waiting";
                nextTitle = "Returned funds ready for the session";
                nextCopy = "A relayed sweep moves engine credit back into the private session.";
                actions = '<button type="button" class="primary" data-act="expire" data-id="' +
                    esc(t.id) + '">Release order</button><button type="button" data-act="offset" data-id="' +
                    esc(t.id) + '">Place opposite order</button>';
                needs = "release";
            } else if (retired) {
                badge = filled >= quantity ? "Filled" : filled > 0n ? "Partially filled" : "Closed unfilled";
                badgeTone = filled > 0n ? "live" : "";
                nextTitle = "Order complete";
                nextCopy = "Check inventory and trading credit for the settled outcome and released remainder.";
                actions = '<button type="button" class="primary" data-act="offset" data-id="' +
                    esc(t.id) + '">Place opposite order</button><button type="button" data-act="new">Start fresh</button>';
            } else if (pastLast) {
                tone = "waiting";
                badge = "Ready to release";
                badgeTone = "waiting";
                nextTitle = "Funds ready to unlock";
                nextCopy = "Its final auction round has passed. Release remains available without a deadline.";
                actions = '<button type="button" class="primary" data-act="expire" data-id="' +
                    esc(t.id) + '">Release order</button><button type="button" data-act="offset" data-id="' +
                    esc(t.id) + '">Place opposite order</button>';
                needs = "release";
            } else {
                tone = "live";
                badge = state.live ? "In auction" : "Revealed";
                badgeTone = "live";
                nextTitle = "Awaiting auction processing";
                nextCopy = "Placed terms are immutable. This order can trade through round " +
                    order.lastRound + ".";
                actions = '<button type="button" data-act="offset" data-id="' +
                    esc(t.id) + '">Place opposite order</button>';
            }
        } else if (kind !== "local") {
            badge = "Status unavailable";
            badgeTone = "urgent";
            nextTitle = "Chain status could not be read";
            nextCopy = "Keep this device data or an export, then refresh before acting.";
            actions = '<button type="button" data-act="load" data-id="' + esc(t.id) + '">Open saved ticket</button>';
        }
        const progress = kind === "committed" && t0
            ? '<div class="order-progress" style="--progress:0%"><i></i></div>'
            : "";
        const details =
            '<details class="order-details"><summary>Details &amp; receipts</summary>' +
            '<div class="order-detail-grid">' +
            '<div><span>Commitment</span><strong>' + esc(t.id) + "</strong></div>" +
            '<div><span>Reveal key</span><strong>Encrypted on this device; export optional</strong></div>' +
            '<div><span>Limit value</span><strong>' + esc(readableHbar(limit)) + " HBAR</strong></div>" +
            '<div><span>Inventory reservation</span><strong>' +
                esc(t.holdId
                    ? "Hold " + t.holdId
                    : t.path === "private" && side === 1
                        ? "Created atomically at reveal"
                        : side === 1
                            ? "Not attached"
                            : "Not required") +
                "</strong></div>" +
            (t.path === "private"
                ? '<div><span>Automatic reveal</span><strong>' +
                    esc(t.automationState || "Stored") + "</strong></div>"
                : "") +
            (t0 ? '<div><span>Submitted</span><strong>' + esc(ticketDate(t0)) + "</strong></div>" : "") +
            ticketReceipt("Commit receipt", t.commitTx) +
            ticketReceipt("Reveal receipt", t.revealTx) +
            ticketReceipt("Cancel receipt", t.cancelTx) +
            ticketReceipt("Settlement receipt", t.crossTx) +
            ticketReceipt("Release receipt", t.releaseTx) +
            "</div></details>";
        cards.push(
            '<article class="order-card ' + tone + '" data-id="' + esc(t.id) +
            '" data-chain="' + kind + '" data-t0="' + t0 + '" data-side="' + side +
            '" data-path="' + esc(t.path || "manual") +
            '" data-release-at="' + esc(t.releaseAt || "") +
            '" data-service-state="' + esc(t.serviceState || "") +
            '" data-hold-valid="' + holdValid + '" data-needs="' + needs + '">' +
            '<div class="order-card-head"><div class="order-card-title">' +
            '<span class="order-side' + (side === 1 ? " sell" : "") + '">' +
            (side === 1 ? "SELL" : "BUY") + "</span><strong>" + esc(shortId(t.id)) +
            '</strong></div><span class="order-status ' + badgeTone + '">' + esc(badge) + "</span></div>" +
            '<div class="order-facts">' +
            '<div><span>Limit price</span><strong class="num">' + esc(readableHbar(price)) +
                " HBAR</strong></div>" +
            '<div><span>Quantity</span><strong class="num">' + esc(formatQuantity(quantity)) + " LPRC</strong></div>" +
            '<div><span>Filled</span><strong class="num">' + esc(formatQuantity(filled)) + " LPRC</strong></div>" +
            (deadline
                ? '<div><span>' + esc(deadlineLabel) +
                    '</span><strong data-order-deadline>' + esc(deadline) + "</strong></div>"
                : "") +
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


Venue.paintRevealPending = function (id) {
    const pending = Venue.revealPending.has(id);
    const box = $("tickets");
    if (!box) return;
    for (const btn of box.querySelectorAll('button[data-act="reveal"]')) {
        if (btn.getAttribute("data-id") !== id) continue;
        btn.disabled = pending;
        btn.setAttribute("aria-busy", pending ? "true" : "false");
        btn.classList.toggle("stale", pending);
        btn.textContent = pending ? "Reveal processing" : "Reveal order";
    }
};

Venue.beginReveal = function (id) {
    if (Venue.revealPending.has(id)) return false;
    Venue.revealPending.add(id);
    Venue.paintRevealPending(id);
    return true;
};

Venue.finishReveal = function (id) {
    Venue.revealPending.delete(id);
    Venue.paintRevealPending(id);
};

Venue.replaceTicket = async function (id) {
    const ticket = Venue.ticketList(Venue.viewer()).find((item) => item.id === id);
    if (!ticket) throw new Error("The sealed order is not available on this device.");
    const receipt = ticket.path === "private" && typeof Venue.cancelPrivateOrder === "function"
        ? await Venue.cancelPrivateOrder(ticket)
        : await Venue.doCancel(id);
    if (!receipt) return null;
    Venue.applyTicketToForm(ticket);
    Venue.reroll();
    Venue.trackTicketId = null;
    Venue.editingDraftId = null;
    Venue.showOrderStage("details");
    let stored = true;
    if (ticket.path !== "private") {
        try {
            await Venue.secureDraft();
        } catch {
            stored = false;
        }
    }
    Venue.status(
        "trade-status",
        ticket.path === "private"
            ? "Old order cancelled. Edit the prefilled replacement and review its new reveal key."
            : stored
            ? "Old order cancelled. Edit the prefilled replacement and review its new reveal key."
            : "Old order cancelled. New terms are prefilled, but encrypted storage is unavailable.",
        ticket.path === "private" || stored ? "ok" : "bad",
    );
    Venue.paintTicket();
    Venue.paintTickets();
    $("price")?.focus();
    document.querySelector(".order-panel")?.scrollIntoView({behavior: "smooth", block: "start"});
    return receipt;
};

Venue.doCancel = async function (id) {
    await Venue.requireAccount();
    const until = asBig(await Venue.c.engine.cancellableUntil(id));
    if (until === 0n) {
        throw new Error("cancellableUntil is 0. The ticket is terminal or unknown.");
    }
    if (nowSec() >= until) throw new Error("Cancel window has shut. Reveal is the remaining move.");
    Venue.tradeTxStage("approval", "Cancel order");
    const rec = await Venue.send(
        () => Venue.w.engine.cancel(id, {gasLimit: 400_000}),
        "Cancel order",
    );
    if (rec) {
        const t = Venue.ticketList(Venue.account).find((x) => x.id === id);
        if (t) {
            const updated = {...t, cancelled: true, cancelTx: rec.hash};
            try {
                await Venue.upsertTicket(Venue.account, updated);
            } catch {
                Venue.cacheTicket(Venue.account, updated);
            }
        }
        Venue.status("trade-status",
            "Order cancelled. The deposit less the cancellation fee is ready to withdraw.",
            "ok");
        await Venue.refreshTrade();
        await Venue.noteReceipt(
            "cancel", rec, 15, G.PRED, T.IMM, "engine", "Cancelled"
        );
    }
    return rec;
};

Venue.doReveal = async function (id, opts = {}) {
    if (!Venue.beginReveal(id)) return null;
    try {
        await Venue.requireAccount();
        if (Venue.snap.kyc !== 1) {
            throw new Error("Renew eligibility before revealing. Settlement requires a current grant.");
        }
        const t = Venue.ticketList(Venue.account).find((x) => x.id === id);
        if (!t) throw new Error("No device-local ticket for that id. Restore a backup.");
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
        const revealLabel = side === 1 ? "Reveal sell (3 of 3)" : "Reveal buy (2 of 2)";
        Venue.tradeTxStage("approval", revealLabel);
        const rec = await Venue.send(
            () => Venue.w.engine.reveal(
                side,
                price,
                qty,
                t.salt,
                backing,
                {value, gasLimit: 800_000},
            ),
            revealLabel
        );
        if (rec) {
            const updated = {
                ...t,
                holdId: backing === 0n ? t.holdId : backing.toString(),
                revealed: true,
                revealTx: rec.hash,
                revealedAt: new Date().toISOString(),
            };
            try {
                await Venue.upsertTicket(Venue.account, updated);
            } catch {
                Venue.cacheTicket(Venue.account, updated);
            }
            Venue.status("trade-status",
                "Order revealed and now eligible for the call auction. Submission is not a fill.",
                "ok");
            await Venue.refreshTrade();
            await Venue.noteReceipt(
                "reveal", rec, 4, G.EXACT, T.IMM, "engine", "Revealed"
            );
        }
        return rec;
    } finally {
        Venue.finishReveal(id);
    }
};

Venue.doCross = async function () {
    await Venue.requireAccount();
    const r = Venue.snap.round === 0n ? 0n : Venue.snap.round - 1n;
    Venue.tradeTxStage("approval", "Process auction round");
    const rec = await Venue.send(
        () => Venue.w.engine.crossRound(r, {gasLimit: 1_500_000}),
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
            const tickets = Venue.ticketList(Venue.account);
            let changed = false;
            const updated = tickets.map((ticket) => {
                if (!settledIds.has(String(ticket.id).toLowerCase())) return ticket;
                changed = true;
                return {...ticket, crossTx: rec.hash};
            });
            if (changed) {
                try {
                    await Venue.persistTickets(Venue.account, updated);
                } catch {
                    for (const ticket of updated) Venue.cacheTicket(Venue.account, ticket);
                }
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

Venue.openWithdrawConfirm = function (kind = "trading") {
    const modal = $("withdraw-modal");
    const financing = kind === "financing";
    const credit = financing ? Venue.snap.vaultCredit : Venue.snap.credit;
    Venue.withdrawKind = financing ? "financing" : "trading";
    if (!modal || !Venue.account || credit == null || asBig(credit) === 0n || Venue.busy) return;
    if ($("withdraw-confirm-amount")) {
        $("withdraw-confirm-amount").textContent = readableHbar(asBig(credit)) + " HBAR";
    }
    if ($("withdraw-modal-kicker")) {
        $("withdraw-modal-kicker").textContent = financing ? "Financing cash" : "Trading proceeds";
    }
    if ($("withdraw-modal-copy")) {
        $("withdraw-modal-copy").textContent = financing
            ? "This sends financing cash credited by the vault back to the connected wallet."
            : "This sends your available trading proceeds back to the connected wallet.";
    }
    modal.hidden = false;
    setTimeout(() => $("withdraw-confirm")?.focus({preventScroll: true}), 20);
};

Venue.paintWithdraw = function (credit, known = true) {
    const action = $("withdraw");
    if (!action) return;
    const amount = known && credit != null ? asBig(credit) : 0n;
    const ready = known && amount > 0n && !!Venue.account;
    action.disabled = !ready;
    action.classList.toggle("is-ready", ready);
    action.setAttribute("aria-label", ready
        ? "Withdraw " + readableHbar(amount) + " HBAR trading credit"
        : !known
            ? "Trading credit is unavailable"
            : Venue.account
            ? "No trading credit ready to withdraw"
            : "Connect a wallet to view trading credit");
    const cue = action.querySelector(".withdraw-action");
    if (cue) {
        cue.textContent = ready
            ? Venue.page === "position"
                ? "Withdraw proceeds"
                : "Withdraw trading credit"
            : !known
                ? "Proceeds unavailable"
                : Venue.account
                ? "No credit available"
                : "Connect to withdraw";
    }
    if (!ready && Venue.withdrawKind === "trading" && !$("withdraw-modal")?.hidden) {
        Venue.closeWithdrawConfirm({restoreFocus: false});
    }
};

Venue.paintVaultWithdraw = function (credit, known = true) {
    const action = $("vault-withdraw");
    if (!action) return;
    const amount = known && credit != null ? asBig(credit) : 0n;
    const ready = known && amount > 0n && !!Venue.account && !!Venue.financing?.ready;
    action.disabled = !ready;
    action.setAttribute("aria-label", ready
        ? "Withdraw " + readableHbar(amount) + " HBAR financing cash"
        : !known
            ? "Financing cash is unavailable"
            : "No financing cash is ready to withdraw");
    if (!ready && Venue.withdrawKind === "financing" && !$("withdraw-modal")?.hidden) {
        Venue.closeWithdrawConfirm({restoreFocus: false});
    }
};

Venue.closeWithdrawConfirm = function ({restoreFocus = true} = {}) {
    const modal = $("withdraw-modal");
    if (modal) modal.hidden = true;
    if (restoreFocus) {
        $(Venue.withdrawKind === "financing" ? "vault-withdraw" : "withdraw")
            ?.focus({preventScroll: true});
    }
};

Venue.confirmWithdraw = async function () {
    if ($("withdraw-modal")?.hidden || Venue.busy) return;
    Venue.closeWithdrawConfirm({restoreFocus: false});
    if (Venue.withdrawKind === "financing") await Venue.doVaultWithdraw();
    else await Venue.doWithdraw();
};

Venue.noteSimpleReceipt = function (kind, rec, published, publicElsewhere) {
    if (!rec) return;
    Venue.lastView = {
        kind,
        tx: rec.hash,
        unmetered: true,
        published,
        publicElsewhere,
    };
    Venue.rememberReceipt();
    Venue.paintLastView();
};

Venue.doWithdraw = async function () {
    await Venue.requireAccount();
    Venue.tradeTxStage("approval", "Withdraw trading credit");
    const rec = await Venue.send(
        () => Venue.w.engine.withdraw({gasLimit: 250_000}),
        "Withdraw trading credit"
    );
    if (rec) {
        Venue.noteSimpleReceipt(
            "trading proceeds withdrawn",
            rec,
            "MatchingEngine records the withdrawal without a metered disclosure row.",
            "The native HBAR transfer, transaction input, and wallet activity remain public.",
        );
        await Venue.refreshTrade().catch(() => {});
        await Venue.refreshPosition().catch(() => {});
    }
};

Venue.doVaultWithdraw = async function () {
    if (!Venue.financing?.ready) {
        throw new Error(Venue.financing?.reason || "Financing writes are unavailable.");
    }
    await Venue.requireAccount();
    const rec = await Venue.send(
        () => Venue.w.vault.withdraw({gasLimit: 250_000}),
        "Withdraw financing cash",
    );
    if (rec) {
        Venue.noteSimpleReceipt(
            "financing cash withdrawn",
            rec,
            "RepoVault records the withdrawal without a metered position amount.",
            "The native HBAR transfer, transaction input, and wallet activity remain public.",
        );
        await Venue.refreshPosition().catch(() => {});
        await Venue.doRepo?.().catch(() => {});
        if (Venue.page === "repo") {
            Venue.recordFinanceActivity?.({
                category: "transaction",
                title: "Cash withdrawn",
                detail: "Financing credit was pulled to the connected wallet.",
                facilityId: Venue.financeUiState?.().selectedId || "",
                txHash: rec.hash || rec.transactionHash,
                explorer: typeof explorerTx === "function"
                    ? explorerTx(rec.hash || rec.transactionHash || "")
                    : "",
            });
        }
    }
};

// One wave. The venue's own four figures, the viewer's four, and the quote all
// go out together: `quote` is the only one that needed a round number first, and
// the clocks already read one this tick.
Venue.refreshTrade = async function () {
    if (CLIENT.privateTrading?.overlay === true) {
        await Venue.observePrivateGate();
    }
    const {engine, token, registry, holds, policy} = Venue.c;
    const acc = Venue.viewer();
    const round = Venue.snap.round ?? Venue.predictRound();
    const previous = round > 0n ? round - 1n : 0n;
    const discEpoch = Venue.snap.discEpoch;
    const sessionAccount = Venue.session?.account || null;
    const activity = discEpoch == null ? Promise.resolve(null) : Promise.all([
        policy.budgetFor(15),
        engine.spentBits(15, discEpoch),
        engine.wouldAfford(15, G.PRED),
    ]);
    const [
        bond, fee, chainRound, revealed, kyc, bal, held, credit, walletBalance,
        gasPriceWei, q, previousCrossed, publication,
        sessionKyc, sessionBalance, sessionWalletBalance,
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
        Venue.reader.send("eth_gasPrice", []).catch(() => null),
        engine.quote(round),
        round > 0n ? engine.crossed(previous).catch(() => false) : true,
        activity,
        sessionAccount ? registry.getKycStatus(sessionAccount) : null,
        sessionAccount
            ? token.balanceOfByPartition(CLIENT.immutables.partition, sessionAccount)
            : null,
        sessionAccount ? Venue.reader.getBalance(sessionAccount).catch(() => null) : null,
    ]);
    Venue.snap.commitBond = asBig(bond);
    Venue.snap.cancelFee = asBig(fee);
    if (gasPriceWei !== null) Venue.snap.gasPriceWei = asBig(gasPriceWei);
    else delete Venue.snap.gasPriceWei;
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
    if (sessionAccount) {
        Venue.snap.sessionKyc = Number(sessionKyc);
        Venue.snap.sessionFree = asBig(sessionBalance);
        if (sessionWalletBalance !== null) {
            try {
                Venue.snap.sessionTinybar = fromWeibar(asBig(sessionWalletBalance));
            } catch {
                delete Venue.snap.sessionTinybar;
            }
        } else {
            delete Venue.snap.sessionTinybar;
        }
    } else {
        delete Venue.snap.sessionKyc;
        delete Venue.snap.sessionFree;
        delete Venue.snap.sessionTinybar;
    }
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
    await Venue.attachHold();
    Venue.paintTicket();
    await Venue.paintTickets();
    if ($("private-setup-modal")?.hidden === false) {
        await Venue.refreshPrivateSessionRecovery().catch(() => {});
    }
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

Venue.runPositionAction = async function (action, label) {
    try {
        return await action();
    } catch (error) {
        const decoded = Venue.fail(error);
        Venue.status("position-status", decoded.message, "bad");
        return null;
    }
};

Venue.refreshPortfolio = async function () {
    Venue.status("position-status", "Refreshing account figures.", "");
    await Promise.all([
        Venue.refreshPosition(),
        Venue.refreshInstrument?.().catch(() => {}),
        Venue.refreshIncome().catch(() => {}),
        Venue.refreshPortfolioFinancing?.().catch(() => {}),
    ]);
    const partial = !!Venue.positionState?.partial ||
        Venue.couponState?.scheduleKnown === false ||
        !!Venue.portfolioFinancing?.mirrorError;
    Venue.status(
        "position-status",
        partial
            ? "Refresh complete. Some figures remain unavailable."
            : "Account figures refreshed.",
        partial ? "" : "ok",
    );
};

Venue.bindPositionWithdrawModal = function () {
    const modal = $("withdraw-modal");
    if (!modal || modal.dataset.bound === "1") return;
    modal.dataset.bound = "1";
    $("withdraw-confirm")?.addEventListener("click", () =>
        Venue.runPositionAction(() => Venue.confirmWithdraw(), "Withdrawal"));
    document.querySelectorAll("[data-withdraw-close]").forEach((control) => {
        control.addEventListener("click", () => Venue.closeWithdrawConfirm());
    });
    document.addEventListener("keydown", (event) => {
        if ($("withdraw-modal")?.hidden) return;
        if (event.key === "Escape") {
            Venue.closeWithdrawConfirm();
            return;
        }
        if (event.key !== "Tab") return;
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
    });
};

Venue.mountPosition = async function () {
    $("watch-go")?.addEventListener("click", () =>
        Venue.runPositionAction(() => Venue.doWatch(), "Agreement lookup"));
    $("withdraw")?.addEventListener("click", () => Venue.openWithdrawConfirm("trading"));
    $("vault-withdraw")?.addEventListener("click", () => Venue.openWithdrawConfirm("financing"));
    $("disclose")?.addEventListener("click", () =>
        Venue.runPositionAction(() => Venue.refreshPortfolio(), "Account refresh"));
    $("coupon-refresh")?.addEventListener("click", () =>
        Venue.runPositionAction(() => Venue.refreshIncome(), "Coupon refresh"));
    $("coupon-associate")?.addEventListener("click", () =>
        Venue.runPositionAction(() => Venue.doAssociateCash(), "LPCASH association"));
    $("income-summary-action")?.addEventListener("click", () =>
        Venue.runPositionAction(() => Venue.doIncomeSummaryAction(), "Coupon action"));
    $("coupon-proof")?.addEventListener("change", (event) => {
        Venue.runPositionAction(
            () => Venue.importCouponProof(event.target.files[0]),
            "Proof import",
        ).finally(() => { event.target.value = ""; });
    });
    Venue.bindPositionWithdrawModal();
    await Promise.all([
        Venue.refreshPosition(),
        Venue.refreshInstrument?.().catch(() => {}),
        Venue.refreshIncome().catch(() => {}),
        Venue.refreshPortfolioFinancing?.().catch(() => {}),
    ]);
    if (Venue.lastView) Venue.paintLastView();
};

Venue.readKnownPortfolioHolds = async function (who) {
    if (!who || !Venue.c.holds) return [];
    const ids = new Set();
    for (const record of readList("holds", who)) {
        if (/^\d+$/.test(String(record?.holdId ?? ""))) ids.add(String(record.holdId));
    }
    for (const ticket of Venue.ticketList(who)) {
        if (/^\d+$/.test(String(ticket?.holdId ?? ""))) ids.add(String(ticket.holdId));
    }
    const limited = [...ids].slice(0, 48);
    const rows = await Promise.all(limited.map(async (holdId) => {
        try {
            const hold = await Venue.c.holds.getHoldForByPartition({
                partition: CLIENT.immutables.partition,
                tokenHolder: who,
                holdId,
            });
            const amount = asBig(hold.amount_ ?? hold[0]);
            if (amount === 0n) return null;
            const escrow = String(hold.escrow_ ?? hold[2]);
            const destination = String(hold.destination_ ?? hold[3]);
            const expiry = asBig(hold.expirationTimestamp_ ?? hold[1]);
            const reason = addrEq(escrow, CLIENT.addresses.MatchingEngine)
                ? "Sell order reservation"
                : addrEq(escrow, CLIENT.addresses.RepoVault)
                    ? "Financing collateral"
                    : "Other known reservation";
            return {holdId, amount, escrow, destination, expiry, reason};
        } catch {
            return null;
        }
    }));
    return rows.filter(Boolean);
};

Venue.readPortfolioOrders = async function (who) {
    if (!who) return [];
    const raw = Venue.ticketList(who)
        .filter((ticket) =>
            /^0x[0-9a-fA-F]{64}$/.test(String(ticket?.id || "")) &&
            (Number(ticket?.side) === 0 || Number(ticket?.side) === 1) &&
            /^\d+$/.test(String(ticket?.qty ?? "")))
        .slice(-40);
    if (!raw.length) return [];
    const round = Venue.snap.round ??
        await Venue.c.engine.currentRound().catch(() => null);
    const chains = await Promise.all(raw.map((ticket) =>
        Venue.c.engine.commitments(ticket.id).catch(() => null)));
    const orders = await Promise.all(raw.map((ticket, index) => {
        const chain = chains[index];
        if (!chain?.revealed || !chain.committer || addrEq(chain.committer, ZERO)) return null;
        return Venue.c.engine.orders(ticket.id).catch(() => null);
    }));
    return raw.map((ticket, index) => {
        const chain = chains[index];
        const order = orders[index];
        const phase = Venue.ticketPhase(ticket, chain);
        const kind = ticketChainKind(chain, ticket);
        let outcome = "Saved draft";
        let tone = "neutral";
        if (phase.phase === "cancel") {
            outcome = "Submitted, cancellation window open";
            tone = "info";
        } else if (phase.phase === "reveal") {
            outcome = "Reveal required now";
            tone = "warning";
        } else if (phase.phase === "lost") {
            outcome = "Reveal deadline missed";
            tone = "danger";
        } else if (kind === "cancelled") {
            outcome = "Cancelled";
        } else if (kind === "revealed" && order) {
            const filled = asBig(order.filled ?? 0);
            const quantity = asBig(ticket.qty);
            if (order.retired) {
                outcome = filled >= quantity
                    ? "Filled"
                    : filled > 0n
                        ? "Partially filled"
                        : "Closed unfilled";
                tone = filled > 0n ? "positive" : "neutral";
            } else if (round != null && asBig(round) > asBig(order.lastRound)) {
                outcome = "Ready to release";
                tone = "info";
            } else {
                outcome = "In auction";
                tone = "info";
            }
        } else if (kind === "revealed") {
            outcome = "Revealed";
            tone = "info";
        } else if (kind === "committed") {
            outcome = "Submitted";
            tone = "info";
        } else if (chain === null && ticket.committedAt) {
            outcome = "Chain status unavailable";
            tone = "warning";
        }
        const sortAt = Number(chain?.committedAt || ticket.committedAt || 0) ||
            Date.parse(ticket.revealedAt || ticket.savedAt || "") / 1000 || 0;
        return {ticket, chain, order, phase, kind, outcome, tone, sortAt};
    }).sort((a, b) => b.sortAt - a.sortAt);
};

Venue.portfolioRecordTime = function (record) {
    const seconds = Number(record.chain?.committedAt || record.ticket.committedAt || 0);
    if (seconds > 0) return ticketDate(seconds);
    const parsed = Date.parse(record.ticket.revealedAt || record.ticket.savedAt || "");
    return Number.isFinite(parsed)
        ? new Date(parsed).toISOString().replace("T", " ").slice(0, 16) + "Z"
        : "Time not stored";
};

Venue.paintPortfolioOrders = function (who, records) {
    const out = $("portfolio-orders");
    const count = who ? Venue.ticketList(who).length : 0;
    if ($("pos-tickets")) {
        $("pos-tickets").textContent = !who
            ? "Unavailable"
            : count
                ? count + " saved order record" + (count === 1 ? "" : "s")
                : "No saved order records";
    }
    if ($("holding-related")) {
        $("holding-related").innerHTML = !who
            ? "Connect or watch an account to load related records."
            : count
                ? esc(count + " order record" + (count === 1 ? "" : "s")) +
                  ' saved here. <a href="trade.html#active-orders">Review in Markets</a>.'
                : 'No local order records. <a href="trade.html">Open Markets</a>.';
    }
    if (!out) return;
    if (!who) {
        out.innerHTML = '<div class="portfolio-empty compact">Connect or watch an account to read local records.</div>';
        return;
    }
    if (!records.length) {
        out.innerHTML = '<div class="portfolio-empty compact">No order records are saved in this browser.</div>';
        return;
    }
    out.innerHTML = '<div class="portfolio-record-list">' + records.slice(0, 4).map((record) => {
        const ticket = record.ticket;
        const side = Number(ticket.side) === 1 ? "Sell" : "Buy";
        const tx = ticket.cancelTx || ticket.crossTx || ticket.revealTx || ticket.commitTx;
        const receipt = /^0x[0-9a-fA-F]{64}$/.test(String(tx || ""))
            ? '<a href="' + esc(explorerTx(tx)) + '" target="_blank" rel="noopener">Receipt</a>'
            : "";
        return '<article class="portfolio-record ' + esc(record.tone) + '">' +
            '<div><strong>' + side + " " + esc(readableQuantity(asBig(ticket.qty))) +
            ' LPRC</strong><span>' + esc(Venue.portfolioRecordTime(record)) + "</span></div>" +
            '<div><span class="record-outcome">' + esc(record.outcome) + "</span>" +
            receipt + "</div></article>";
    }).join("") + "</div>";
};

Venue.paintPositionState = function () {
    const state = Venue.positionState;
    const who = state?.viewer || null;
    const put = (id, value) => { if ($(id)) $(id).textContent = value; };
    const quantity = (value, known) => known ? readableQuantity(value) : "Unavailable";

    if (!who) {
        for (const id of [
            "pos-total", "pos-available", "pos-reserved", "pos-credit",
            "holding-total", "holding-available", "holding-reserved",
        ]) put(id, "Unavailable");
        put("pos-available-label", "available");
        put("pos-reserved-label", "reserved");
        put("holding-available-label", "Available");
        put("holding-reserved-label", "Reserved");
        put("in-eligibility", "Connect or watch an account");
        put("holding-reserve-detail", "Unavailable");
        $("holding-card").hidden = true;
        $("holding-empty").hidden = true;
        $("holding-unavailable").hidden = false;
        $("finance-credit-summary").hidden = true;
        Venue.paintWithdraw(null, false);
        Venue.paintVaultWithdraw(null, false);
        Venue.paintPortfolioOrders(null, []);
        Venue.paintNeeds(null);
        return;
    }

    const totalKnown = state.total != null && state.totalReliable;
    put("pos-total", quantity(state.total, totalKnown));
    put("pos-available", quantity(state.free, state.freeKnown));
    put("pos-reserved", quantity(state.held, state.heldKnown));
    put("holding-total", quantity(state.total, totalKnown));
    put("holding-available", quantity(state.free, state.freeKnown));
    put("holding-reserved", quantity(state.held, state.heldKnown));
    put("pos-available-label", state.multi === true
        ? "available in trading partition"
        : "available");
    put("pos-reserved-label", state.multi === true
        ? "reserved in trading partition"
        : "reserved");
    put("holding-available-label", state.multi === true
        ? "Available in trading partition"
        : "Available");
    put("holding-reserved-label", state.multi === true
        ? "Reserved in trading partition"
        : "Reserved");
    put("pos-credit", state.creditKnown ? readableHbar(state.credit) : "Unavailable");
    put("in-eligibility", state.kycKnown
        ? state.kyc === 1
            ? "Current for this KYC period"
            : "Not current. Trading and some financing actions can be refused."
        : "Eligibility status unavailable");

    Venue.paintWithdraw(state.credit, state.creditKnown);
    const showVaultCredit = !!Venue.financing?.ready &&
        state.vaultCreditKnown && state.vaultCredit > 0n;
    $("finance-credit-summary").hidden = !showVaultCredit;
    put("pos-vault-credit", state.vaultCreditKnown
        ? readableHbar(state.vaultCredit)
        : "Unavailable");
    Venue.paintVaultWithdraw(state.vaultCredit, state.vaultCreditKnown);

    const confirmedEmpty = totalKnown && state.total === 0n;
    $("holding-card").hidden = confirmedEmpty;
    $("holding-empty").hidden = !confirmedEmpty;
    $("holding-unavailable").hidden = true;

    if ($("in-balance")) {
        if (!state.freeKnown || !state.heldKnown) {
            put("in-balance", "One or more position reads are unavailable");
        } else if (state.multi === true) {
            put("in-balance", state.wholeKnown
                ? readableQuantity(state.whole) + " available across all partitions; " +
                  readableQuantity(state.partitionTotal) + " in the trading partition (" +
                  readableQuantity(state.free) + " available + " +
                  readableQuantity(state.held) + " reserved). " +
                  "Reserved balances in other partitions are not enumerable here."
                : "Trading-partition balance is known, but aggregate availability is unavailable");
        } else if (!state.totalReliable) {
            put("in-balance", "The token’s free-balance reads disagree");
        } else {
            put("in-balance",
                readableQuantity(state.total) + " = " +
                readableQuantity(state.free) + " available + " +
                readableQuantity(state.held) + " reserved");
        }
    }

    const reserve = $("holding-reserve-detail");
    if (reserve) {
        if (!state.heldKnown) {
            reserve.textContent = "Reserved quantity unavailable";
        } else if (state.held === 0n) {
            reserve.textContent = "Nothing is reserved";
        } else {
            const known = state.knownHolds || [];
            const knownTotal = known.reduce((sum, hold) => sum + hold.amount, 0n);
            const rows = known.map((hold) =>
                '<span><b>' + esc(readableQuantity(hold.amount)) + " LPRC</b> " +
                esc(hold.reason) + " (hold " + esc(hold.holdId) + ")</span>");
            if (knownTotal < state.held) {
                rows.push(
                    '<span><b>' + esc(readableQuantity(state.held - knownTotal)) +
                    " LPRC</b> reserved for reasons unavailable to this browser</span>",
                );
            } else if (knownTotal > state.held) {
                rows.push("<span>Saved hold records are stale. The aggregate reserved balance is authoritative.</span>");
            }
            reserve.innerHTML = rows.join("");
        }
    }

    Venue.paintPortfolioOrders(who, state.orders || []);
    Venue.paintPortfolioReference?.(state);
    Venue.paintInstrumentTerms?.();
    Venue.paintNeeds(who);
};

Venue.refreshPosition = async function (opts = {}) {
    const who = Venue.viewer();
    const vaultReady = !!Venue.financing?.ready && !!Venue.c.vault;
    const part = CLIENT.immutables.partition;
    const now = Date.now();
    const refreshOrders = !opts.quiet || Venue._portfolioOrderViewer !== who ||
        now - (Venue._portfolioOrderAt || 0) > 15000;
    const refreshHolds = !opts.quiet || Venue._portfolioHoldViewer !== who ||
        now - (Venue._portfolioHoldAt || 0) > 30000;
    const refreshDisclosure = !opts.quiet || now - (Venue._portfolioDisclosureAt || 0) > 30000;

    const reads = await Promise.allSettled([
        who ? Venue.c.engine.credit(who) : Promise.resolve(null),
        who && vaultReady ? Venue.c.vault.credit(who) : Promise.resolve(null),
        who ? Venue.c.registry.getKycStatus(who) : Promise.resolve(null),
        who ? Venue.c.token.balanceOf(who) : Promise.resolve(null),
        who ? Venue.c.token.balanceOfByPartition(part, who) : Promise.resolve(null),
        who ? Venue.c.holds.getHeldAmountForByPartition(part, who) : Promise.resolve(null),
        Venue.c.token.isMultiPartition(),
        Venue.c.watch.feed().catch(() => null),
        refreshHolds ? Venue.readKnownPortfolioHolds(who) : Promise.resolve(Venue.positionState?.knownHolds || []),
        refreshOrders ? Venue.readPortfolioOrders(who) : Promise.resolve(Venue.positionState?.orders || []),
        refreshDisclosure ? Venue.refreshDisclosure() : Promise.resolve(null),
    ]);
    if (!Venue.stillViewer(who)) return;
    const value = (index) => reads[index].status === "fulfilled" ? reads[index].value : null;
    const known = (index) => !!who && reads[index].status === "fulfilled" && reads[index].value != null;
    const creditKnown = known(0);
    const vaultCreditKnown = vaultReady && known(1);
    const kycKnown = known(2);
    const wholeKnown = known(3);
    const freeKnown = known(4);
    const heldKnown = known(5);
    const multiKnown = reads[6].status === "fulfilled";
    const credit = creditKnown ? asBig(value(0)) : null;
    const vaultCredit = vaultCreditKnown ? asBig(value(1)) : null;
    const kyc = kycKnown ? Number(value(2)) : null;
    const whole = wholeKnown ? asBig(value(3)) : null;
    const free = freeKnown ? asBig(value(4)) : null;
    const held = heldKnown ? asBig(value(5)) : null;
    const multi = multiKnown ? !!value(6) : null;
    const partitionTotal = freeKnown && heldKnown ? free + held : null;
    const total = multi === false ? partitionTotal : null;
    const totalReliable = total != null &&
        (!wholeKnown || whole === free);

    if (creditKnown) Venue.snap.credit = credit;
    else delete Venue.snap.credit;
    if (vaultCreditKnown) Venue.snap.vaultCredit = vaultCredit;
    else delete Venue.snap.vaultCredit;
    if (kycKnown) Venue.snap.kyc = kyc;
    else delete Venue.snap.kyc;
    if (freeKnown) Venue.snap.free = free;
    else delete Venue.snap.free;
    if (heldKnown) Venue.snap.held = held;
    else delete Venue.snap.held;

    if (refreshOrders) {
        Venue._portfolioOrderAt = now;
        Venue._portfolioOrderViewer = who;
    }
    if (refreshHolds) {
        Venue._portfolioHoldAt = now;
        Venue._portfolioHoldViewer = who;
    }
    if (refreshDisclosure && reads[10].status === "fulfilled") {
        Venue._portfolioDisclosureAt = now;
    } else if (refreshDisclosure && reads[10].status === "rejected") {
        if ($("disc-epoch")) $("disc-epoch").textContent = "Unavailable";
        if ($("disc-rows")) {
            $("disc-rows").innerHTML =
                '<div class="portfolio-empty compact">Disclosure evidence is temporarily unavailable.</div>';
        }
    }

    Venue.positionState = {
        viewer: who,
        credit, creditKnown,
        vaultCredit, vaultCreditKnown,
        kyc, kycKnown,
        whole, wholeKnown,
        free, freeKnown,
        held, heldKnown,
        total, totalReliable,
        partitionTotal,
        multi, multiKnown,
        feed: value(7),
        knownHolds: value(8) || [],
        orders: value(9) || [],
        partial: !!who && (
            !creditKnown || !kycKnown || !wholeKnown || !freeKnown || !heldKnown ||
            !multiKnown || !totalReliable || (vaultReady && !vaultCreditKnown)
        ),
    };
    Venue.paintPositionState();
    if (Venue.lastView) Venue.paintLastView();
};

Venue.paintNeeds = function (who) {
    const box = $("needs-box");
    const out = $("needs-out");
    if (!box || !out) return;
    if (!who) {
        box.hidden = true;
        out.innerHTML = "";
        return;
    }
    const state = Venue.positionState;
    const items = [];
    const lost = (state?.orders || []).filter((record) => record.phase.phase === "lost").length;
    const reveal = (state?.orders || []).filter((record) => record.phase.phase === "reveal").length;
    if (lost) {
        items.push({
            tone: "danger",
            title: lost + " reveal deadline" + (lost === 1 ? " was" : "s were") + " missed",
            copy: "The affected order deposit is exposed to permissionless forfeiture.",
            href: "trade.html#active-orders",
            action: "Review orders",
        });
    }
    if (reveal) {
        items.push({
            tone: "warning",
            title: reveal + " order" + (reveal === 1 ? " requires" : "s require") + " a reveal now",
            copy: "Reveal before the deadline to protect the deposit and enter the auction.",
            href: "trade.html#active-orders",
            action: "Reveal in Markets",
        });
    }
    for (const position of Venue.portfolioFinancing?.positions || []) {
        if (position.alert?.called || position.alert?.defaultable) {
            const deadline = asBig(position.alert.cureDeadline || 0);
            items.push({
                tone: position.alert.defaultable ? "danger" : "warning",
                title: position.alert.defaultable
                    ? "A financing agreement is eligible for default"
                    : "A financing agreement is under a margin call",
                copy: deadline > 0n
                    ? "Cure deadline " + new Date(Number(deadline) * 1000)
                        .toISOString().replace("T", " ").slice(0, 16) + "Z."
                    : "Open the agreement to review the consequence and supported next action.",
                href: "repo.html",
                action: "Open Financing",
            });
            continue;
        }
        if (position.alert?.unmarkedFail) {
            items.push({
                tone: "warning",
                title: "A financing agreement has passed maturity",
                copy: "The agreement has not yet been moved into its failing state.",
                href: "repo.html",
                action: "Review agreement",
            });
            continue;
        }
        if (position.preview?.breach && !position.alert?.called) {
            items.push({
                tone: "warning",
                title: "A live financing read indicates a collateral shortfall",
                copy: "The agreement has not necessarily been marked on chain. Review it before acting.",
                href: "repo.html",
                action: "Review agreement",
            });
            continue;
        }
    }
    if ((Venue.portfolioFinancing?.positions || []).length &&
        Venue.portfolioFinancing?.feed?.dark) {
        items.push({
            tone: "warning",
            title: "Financing risk valuation is unavailable",
            copy: "One or both oracle legs are stale. The Portfolio will not infer a healthy position from a dark feed.",
            href: "repo.html",
            action: "Inspect feed status",
        });
    }
    if (state?.kycKnown && state.kyc !== 1) {
        items.push({
            tone: "warning",
            title: "Eligibility is not current",
            copy: "New trades and eligibility-gated financing actions can be refused. A request is not approval.",
            href: "prove.html",
            action: "Review eligibility",
        });
    } else if (state?.kycKnown && Venue.snap.kycEnd &&
        Venue.snap.kycEnd > nowSec() && Venue.snap.kycEnd - nowSec() < 86400n) {
        items.push({
            tone: "info",
            title: "Eligibility expires within 24 hours",
            copy: "Renewal uses a proof for the next KYC period when the issuer makes one available.",
            href: "prove.html",
            action: "Review renewal",
        });
    }
    if (!items.length) {
        box.hidden = true;
        out.innerHTML = "";
        return;
    }
    box.hidden = false;
    out.innerHTML = '<div class="attention-list">' + items.map((item) =>
        '<article class="attention-item ' + esc(item.tone) + '">' +
        '<div><strong>' + esc(item.title) + "</strong><p>" + esc(item.copy) + "</p></div>" +
        '<a href="' + esc(item.href) + '">' + esc(item.action) + "</a></article>"
    ).join("") + "</div>";
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
    let layers;
    let outcome;
    if (v.unmetered) {
        outcome = "Confirmed on Hedera. This action is not governed by the venue disclosure budget.";
        layers =
            '<div class="rcpt-layers">' +
            '<article><h3>Succeeded</h3><p>' + esc(v.kind) +
            " · tx <a href='" + esc(explorerTx(v.tx)) +
            "' target='_blank' rel='noopener'>" +
            esc(shortId(v.tx)) + "</a></p></article>" +
            '<article><h3>Venue published</h3><p>' +
            esc(v.published) + "</p></article>" +
            '<article><h3>Withheld</h3><p>Nothing by a disclosure budget. This action is not metered.</p></article>' +
            '<article><h3>Still public elsewhere</h3><p>' +
            esc(v.publicElsewhere) + "</p></article></div>";
    } else {
        const published = typeof v.audible === "boolean"
            ? v.audible
            : v.would && v.afford;
        const withheld = !published;
        outcome = published
            ? "Confirmed on Hedera. The governed venue event was published."
            : "Confirmed on Hedera. The governed venue event was withheld.";
        layers =
            '<div class="rcpt-layers">' +
            '<article><h3>Succeeded</h3><p>' + esc(v.kind) +
            " · tx <a href='" + esc(explorerTx(v.tx)) +
            "' target='_blank' rel='noopener'>" + esc(shortId(v.tx)) + "</a></p></article>" +
            '<article><h3>Venue published</h3><p>' +
            (published
                ? "row " + v.row + " " + esc(ROW_NAMES[v.row] || "") +
                  " · " + esc(G_NAME[v.g]) + " · " + esc(T_NAME[v.t])
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
            " · wouldDisclose=" + esc(v.would) +
            " · spentBits=" + esc(v.spent) +
            " · wouldAfford=" + esc(v.afford) +
            " · breakingSize=" + esc(v.breaking) +
            " · epoch " + esc(v.epoch) + "</p></article>" +
            "</div>";
    }
    if (Venue.page !== "position") {
        $("last-view").innerHTML = layers;
        return;
    }
    const names = {
        commit: "Order submitted",
        cancel: "Order cancelled",
        reveal: "Order revealed",
        cross: "Auction processed",
        "coupon claimed": "Coupon claimed",
        "offer funded": "Financing offer funded",
        "financing accepted": "Financing accepted",
    };
    const action = names[v.kind] || String(v.kind)
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
    $("last-view").innerHTML =
        '<article class="latest-action">' +
        '<span class="latest-action-mark" aria-hidden="true"></span>' +
        '<div><strong>' + esc(action) + "</strong><p>" + esc(outcome) + "</p></div>" +
        '<a href="' + esc(explorerTx(v.tx)) +
        '" target="_blank" rel="noopener">View receipt</a></article>' +
        '<details class="receipt-evidence"><summary>Inspect disclosure evidence</summary>' +
        layers + "</details>";
};

Venue.portfolioFreshness = function (publishedAt) {
    const at = asBig(publishedAt || 0);
    if (at === 0n) return "publication time unavailable";
    const age = nowSec() > at ? nowSec() - at : 0n;
    if (age < 60n) return "updated less than a minute ago";
    if (age < 3600n) return "updated " + (age / 60n) + "m ago";
    if (age < 86400n) return "updated " + (age / 3600n) + "h ago";
    return "updated " + (age / 86400n) + "d ago";
};

Venue.paintPortfolioReference = function (state) {
    const summary = $("pos-reference");
    const detail = $("holding-reference");
    if (!summary || !detail) return;
    const feed = state?.feed;
    if (!state?.viewer || !state.totalReliable || !feed) {
        summary.textContent = "Reference value unavailable.";
        detail.innerHTML =
            "<span>Reference value</span><strong>Unavailable</strong>" +
            "<small>Position or oracle data could not be established.</small>";
        return;
    }
    if (feed.dark) {
        const reasons = [];
        if (feed.ourLegDark) reasons.push("bond price leg");
        if (feed.cashLegDark) reasons.push("HBAR/USD leg");
        const reason = reasons.length ? reasons.join(" and ") + " stale" : "oracle stale";
        summary.textContent = "Reference value unavailable. " +
            reason.charAt(0).toUpperCase() + reason.slice(1) + ".";
        detail.innerHTML =
            "<span>Reference value</span><strong>Unavailable</strong>" +
            "<small>" + esc(reason.charAt(0).toUpperCase() + reason.slice(1)) +
            ". The Portfolio does not value through a stale feed.</small>";
        return;
    }
    const mark = asBig(feed.markPerUnitTinybar || 0);
    if (mark === 0n) {
        summary.textContent = "Reference value unavailable. Live composite mark was not returned.";
        detail.innerHTML =
            "<span>Reference value</span><strong>Unavailable</strong>" +
            "<small>The live feed returned no composite mark.</small>";
        return;
    }
    const value = state.total * mark;
    const freshness = Venue.portfolioFreshness(feed.publishedAt);
    const scope = state.multi === true
        ? " Available and reserved figures cover the trading partition."
        : "";
    summary.textContent = "Reference value " + readableHbar(value) +
        " HBAR · " + freshness + "." + scope;
    detail.innerHTML =
        "<span>Reference value</span><strong>" + esc(readableHbar(value)) +
        " HBAR</strong><small>" +
        esc(readableHbar(mark) + " HBAR per LPRC · clean price $" +
            readablePrice(feed.cleanPrice || 0) + " · HBAR/USD $" +
            readablePrice(feed.usdPerHbar || 0) + " · " + freshness + scope) +
        "</small>";
};

Venue.readRepoRows = async function (ids) {
    const watchResult = await Venue.c.watch.watch(ids).catch(() => null);
    const alerts = watchResult?.alerts || watchResult?.[0] || [];
    const stream = watchResult?.s || watchResult?.[1] || null;
    const feed = watchResult?.f || watchResult?.[2] || null;
    const rows = await Promise.all(ids.map(async (id, index) => {
        const [repoRead, offerRead, previewRead, repurchaseRead] =
            await Promise.allSettled([
                Venue.c.vault.repo(id),
                typeof Venue.c.vault.offers === "function"
                    ? Venue.c.vault.offers(id)
                    : Promise.resolve(null),
                typeof Venue.c.vault.previewMark === "function"
                    ? Venue.c.vault.previewMark(id)
                    : Promise.resolve(null),
                typeof Venue.c.vault.repurchasePriceNow === "function"
                    ? Venue.c.vault.repurchasePriceNow(id)
                    : Promise.resolve(null),
            ]);
        const repo = repoRead.status === "fulfilled" ? repoRead.value : null;
        const offer = offerRead.status === "fulfilled" ? offerRead.value : null;
        const preview = previewRead.status === "fulfilled" ? previewRead.value : null;
        const repurchase = repurchaseRead.status === "fulfilled"
            ? repurchaseRead.value
            : null;
        const stateNo = repo ? Number(repo.state ?? repo[0] ?? 0) : null;
        const repoKnown = stateNo != null && stateNo !== 0;
        const offerLender = offer ? String(offer.lender ?? offer[0] ?? ZERO) : ZERO;
        const offerKnown = offer && !addrEq(offerLender, ZERO);
        const borrower = repoKnown
            ? String(repo.borrower ?? repo[1])
            : offerKnown
                ? String(offer.borrower ?? offer[1])
                : null;
        const lender = repoKnown
            ? String(repo.lender ?? repo[2])
            : offerKnown
                ? offerLender
                : null;
        const terms = offerKnown ? offer.terms : null;
        return {
            id,
            repo,
            offer,
            known: repoKnown || !!offerKnown,
            offered: !repoKnown && !!offerKnown,
            readError: repoRead.status === "rejected",
            stateNo: repoKnown ? stateNo : offerKnown ? 1 : 0,
            state: repoKnown
                ? REPO_STATE[stateNo] || "State " + stateNo
                : offerKnown
                    ? "FUNDED OFFER"
                    : "NOT FOUND",
            borrower,
            lender,
            collateral: repoKnown
                ? asBig(repo.collateralAmount ?? repo[5] ?? 0)
                : asBig(terms?.collateralAmount ?? 0),
            principal: repoKnown
                ? asBig(repo.principal ?? repo[6] ?? 0)
                : asBig(offer?.principal ?? offer?.[3] ?? 0),
            repoRateBps: repoKnown
                ? asBig(repo.repoRateBps ?? repo[7] ?? 0)
                : asBig(terms?.repoRateBps ?? 0),
            maturity: repoKnown
                ? asBig(repo.maturity ?? repo[9] ?? 0)
                : asBig(offer?.expiresAt ?? offer?.[4] ?? 0),
            cureDeadline: repoKnown
                ? asBig(repo.cureDeadline ?? repo[10] ?? 0)
                : 0n,
            alert: alerts[index] || null,
            preview: preview
                ? {
                    mark: asBig(preview.mark ?? preview[0] ?? 0),
                    breach: !!(preview.breach ?? preview[1]),
                    dark: !!(preview.dark ?? preview[2]),
                }
                : null,
            repurchase: repurchase != null ? asBig(repurchase) : null,
        };
    }));
    return {rows, stream, feed, watchAvailable: !!watchResult};
};

Venue.portfolioDate = function (timestamp) {
    const value = asBig(timestamp || 0);
    if (value === 0n) return "Unavailable";
    return new Date(Number(value) * 1000)
        .toISOString().replace("T", " ").slice(0, 16) + "Z";
};

Venue.financingPositionHtml = function (position, manual = false) {
    const who = Venue.viewer();
    const isBorrower = who && position.borrower && addrEq(position.borrower, who);
    const isLender = who && position.lender && addrEq(position.lender, who);
    const role = isBorrower && isLender
        ? "Borrower and lender"
        : isBorrower
            ? "Borrower"
            : isLender
                ? "Lender"
                : manual
                    ? "Read-only lookup"
                    : "Party";
    const alert = position.alert;
    const urgent = position.known &&
        (alert?.defaultable || alert?.called || alert?.unmarkedFail);
    const deadline = asBig(alert?.called ? alert.cureDeadline : position.maturity || 0);
    let statusCopy = position.offered
        ? "The lender has funded this offer. The borrower may accept before expiry."
        : "No active margin condition was returned.";
    if (!position.known) {
        statusCopy = position.readError
            ? "Agreement data could not be read."
            : "No funded offer or agreement was found for this ID.";
    } else if (!position.offered) {
        if (alert?.defaultable) {
            statusCopy = "The agreement is currently eligible for default under its on-chain terms.";
        } else if (alert?.called) {
            statusCopy = alert.cureExpired
                ? "The margin-call cure period has expired."
                : "A margin call is active. Review the cure deadline.";
        } else if (alert?.unmarkedFail) {
            statusCopy = "Maturity has passed, but the agreement has not been moved into failing state.";
        } else if (position.preview?.dark) {
            statusCopy = "Live risk preview is unavailable because the price feed is stale.";
        } else if (position.preview?.breach) {
            statusCopy = "The live read indicates a maintenance shortfall that has not necessarily been marked on chain.";
        }
    }
    const tone = urgent || (!position.offered && position.preview?.breach) ? " warning" : "";
    return '<article class="financing-position' + tone + '">' +
        '<header><div><span>' + esc(role) + '</span><strong>' +
        esc(position.state.replaceAll("_", " ").toLowerCase()
            .replace(/\b\w/g, (letter) => letter.toUpperCase())) +
        '</strong></div><code>' + esc(shortId(position.id)) + "</code></header>" +
        '<div class="financing-position-values">' +
        '<div><span>Collateral</span><strong>' +
        (position.known ? esc(readableQuantity(position.collateral)) + " LPRC" : "Unavailable") +
        "</strong></div>" +
        '<div><span>' + (position.offered ? "Funded cash" : "Principal") +
        "</span><strong>" +
        (position.known ? esc(readableHbar(position.principal)) + " HBAR" : "Unavailable") +
        "</strong></div>" +
        '<div><span>' + (alert?.called ? "Cure deadline" : position.offered ? "Offer expiry" : "Maturity") +
        "</span><strong>" + (position.known ? esc(Venue.portfolioDate(deadline)) : "Unavailable") +
        "</strong></div></div>" +
        '<p class="financing-status-copy">' + esc(statusCopy) + "</p>" +
        '<footer><span>' +
        (position.known && !position.offered && position.repurchase != null
            ? "Repurchase now " + esc(readableHbar(position.repurchase)) + " HBAR"
            : position.known && position.repoRateBps > 0n
                ? "Repo rate " + esc(readableBps(position.repoRateBps))
                : position.known
                    ? "Exact economics available in agreement details"
                    : "No agreement economics available") +
        '</span><a href="repo.html">Open Financing</a></footer></article>';
};

Venue.portfolioFinancingContextHtml = function (data) {
    if (!data?.feed && !data?.stream) return "";
    const feed = data.feed;
    const stream = data.stream;
    const feedCopy = !feed
        ? "Oracle status unavailable"
        : feed.dark
            ? "Risk feed stale" +
              (feed.ourLegDark && feed.cashLegDark
                  ? " on both legs"
                  : feed.ourLegDark
                      ? " on the bond-price leg"
                      : feed.cashLegDark
                          ? " on the HBAR/USD leg"
                          : "")
            : "Risk feed live · " + Venue.portfolioFreshness(feed.publishedAt);
    const streamCopy = !stream
        ? "Margin event-stream status unavailable"
        : stream.audible
            ? "Margin events currently publish"
            : "Margin events may be withheld; current contract state is shown";
    return '<div class="financing-context"><span>' + esc(feedCopy) +
        "</span><span>" + esc(streamCopy) + "</span></div>";
};

Venue.paintPortfolioFinancing = function () {
    const out = $("portfolio-financing");
    const limitation = $("financing-limitation");
    if (!out || !limitation) return;
    const data = Venue.portfolioFinancing;
    const who = Venue.viewer();
    if (!who) {
        limitation.hidden = true;
        out.innerHTML = '<div class="portfolio-empty compact">Connect or watch an account to inspect known financing positions.</div>';
        return;
    }
    const limits = [
        "Automatic coverage checks up to 25 recent vault events.",
        "An empty result does not prove that the account has no financing obligations.",
    ];
    if (data?.mirrorError) {
        limits.unshift("Recent mirror-node discovery is unavailable right now.");
    }
    if (!Venue.financing?.ready) {
        limits.push(Venue.financing?.reason ||
            "The bound vault does not support this client’s financing write flow.");
    }
    limitation.hidden = false;
    limitation.innerHTML =
        "<strong>Discovery coverage</strong><span>" + esc(limits.join(" ")) +
        "</span><small>Use exact-ID lookup below for agreements outside this coverage.</small>";
    if (!data) {
        out.innerHTML = '<div class="portfolio-empty compact">Checking financing records.</div>';
        return;
    }
    const context = data.positions.length
        ? Venue.portfolioFinancingContextHtml(data)
        : "";
    if (!data.positions.length) {
        out.innerHTML = '<div class="portfolio-empty compact">No account-linked agreements were found within this coverage. Use exact-ID lookup if you expect one.</div>';
        return;
    }
    out.innerHTML = context + '<div class="financing-position-list">' +
        data.positions.map((position) => Venue.financingPositionHtml(position)).join("") +
        "</div>";
};

Venue.refreshPortfolioFinancing = async function () {
    if (!$("portfolio-financing")) return;
    if (Venue._portfolioFinancingRun) return Venue._portfolioFinancingRun;
    const run = (async () => {
        const who = Venue.viewer();
        if (!who) {
            Venue.portfolioFinancing = {viewer: null, positions: []};
            Venue.paintPortfolioFinancing();
            return;
        }
        let history = [];
        let mirrorError = "";
        try {
            history = typeof Venue.history === "function"
                ? await Venue.history("RepoVault", {limit: 25})
                : [];
        } catch (error) {
            mirrorError = error?.message || String(error);
        }
        if (!Venue.stillViewer(who)) return;
        const recent = history
            .map((entry) => entry.args?.id ?? entry.args?.[0])
            .filter((id) => /^0x[0-9a-fA-F]{64}$/.test(String(id || "")));
        const ids = [...new Set(recent)].slice(0, 25);
        const read = await Venue.readRepoRows(ids);
        if (!Venue.stillViewer(who)) return;
        const positions = read.rows.filter((position) =>
            position.known &&
            (addrEq(position.borrower, who) || addrEq(position.lender, who)));
        Venue.portfolioFinancing = {
            viewer: who,
            positions,
            stream: read.stream,
            feed: read.feed,
            watchAvailable: read.watchAvailable,
            mirrorError,
            recentIds: recent.length,
        };
        Venue.paintPortfolioFinancing();
        Venue.paintNeeds(who);
    })();
    Venue._portfolioFinancingRun = run;
    try {
        return await run;
    } finally {
        if (Venue._portfolioFinancingRun === run) Venue._portfolioFinancingRun = null;
    }
};

Venue.doWatch = async function () {
    const raw = $("repo-ids").value.trim();
    const ids = raw.split(/[\s,]+/).filter(Boolean);
    if (!ids.length) throw new Error("Paste one or more agreement IDs.");
    if (ids.length > 20) throw new Error("Look up at most 20 agreement IDs at once.");
    if (ids.some((id) => !/^0x[0-9a-fA-F]{64}$/.test(id))) {
        throw new Error("Each agreement ID must be a 32-byte 0x value.");
    }
    $("watch-out").innerHTML = '<div class="portfolio-empty compact">Reading agreement state.</div>';
    const data = await Venue.readRepoRows([...new Set(ids)]);
    const context = Venue.portfolioFinancingContextHtml(data);
    $("watch-out").innerHTML = context +
        '<div class="financing-position-list manual">' +
        data.rows.map((position) => Venue.financingPositionHtml(position, true)).join("") +
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
    return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + frac;
}

Venue.couponFeeQuote = function (amount) {
    const cfg = CLIENT.coupon?.cashToken?.fractionalFee;
    if (!cfg) return {known: false};
    const numerator = asBig(cfg.numerator ?? 0);
    const denominator = asBig(cfg.denominator ?? 0);
    if (denominator === 0n) return {known: false};
    const minimum = asBig(cfg?.minimum ?? 0);
    const maximum = asBig(cfg?.maximum ?? 0);
    let fee = asBig(amount) * numerator / denominator;
    if (fee < minimum) fee = minimum;
    if (maximum > 0n && fee > maximum) fee = maximum;
    const chargedOnTop = !!cfg?.netOfTransfers;
    const net = chargedOnTop
        ? asBig(amount)
        : asBig(amount) > fee
            ? asBig(amount) - fee
            : 0n;
    return {
        known: true,
        numerator,
        denominator,
        minimum,
        maximum,
        fee,
        net,
        chargedOnTop,
    };
};

Venue.verifyCouponProof = function (proof, declaration, domains) {
    if (!proof || !declaration || !domains?.leaf || !domains?.node) return false;
    let width = asBig(declaration.holders ?? declaration[3] ?? 0);
    let position = asBig(proof.position);
    if (width === 0n || position >= width) return false;
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const holderKey = ethers.zeroPadValue(proof.holder, 32);
    let hash = ethers.keccak256(coder.encode(
        ["bytes32", "uint256", "bytes32", "uint256"],
        [domains.leaf, proof.index, holderKey, proof.amount],
    ));
    let proofIndex = 0;
    while (width > 1n) {
        const promoted = width % 2n === 1n && position === width - 1n;
        if (!promoted) {
            if (proofIndex >= proof.proof.length) return false;
            const sibling = proof.proof[proofIndex++];
            const left = position % 2n === 0n ? hash : sibling;
            const right = position % 2n === 0n ? sibling : hash;
            hash = ethers.keccak256(coder.encode(
                ["bytes32", "bytes32", "bytes32"],
                [domains.node, left, right],
            ));
        }
        position >>= 1n;
        width = (width + 1n) >> 1n;
    }
    const root = String(declaration.root ?? declaration[0] ?? "");
    return proofIndex === proof.proof.length &&
        hash.toLowerCase() === root.toLowerCase();
};

Venue.couponRowStatus = function (row, state) {
    if (!row.dueKnown || !row.declarationKnown) {
        return {label: "Unavailable", copy: "Payment status could not be read.", tone: "unknown"};
    }
    const now = nowSec();
    if (!row.declared) {
        if (row.due > now) {
            return {
                label: "Scheduled",
                copy: "No claim action is available before issuer funding.",
                tone: "scheduled",
            };
        }
        return {
            label: "Awaiting issuer funding",
            copy: "No funded declaration is live for this due payment.",
            tone: "waiting",
        };
    }
    if (row.claimedKnown && row.claimed) {
        return {
            label: "Claimed",
            copy: "This account has already claimed this payment.",
            tone: "claimed",
        };
    }
    if (!row.closesKnown) {
        return {
            label: "Window unavailable",
            copy: "The claim deadline could not be read.",
            tone: "unknown",
        };
    }
    if (now >= row.closes) {
        return {
            label: "Claim window closed",
            copy: "The contract no longer accepts claims for this payment.",
            tone: "closed",
        };
    }
    const proof = state.proof;
    if (proof?.index === row.index) {
        if (proof.merkleValid == null) {
            return {
                label: "Validation unavailable",
                copy: "The live declaration or proof domains could not be read.",
                tone: "unknown",
            };
        }
        if (proof.merkleValid === false) {
            return {
                label: "Proof not accepted",
                copy: "The imported file does not match the live entitlement root.",
                tone: "waiting",
            };
        }
        if (!state.proofMatchesViewer) {
            return {
                label: "Proof for another holder",
                copy: "Connect or watch the holder named in the proof.",
                tone: "waiting",
            };
        }
        if (!proof.currentAccept) {
            return {
                label: "Claim unavailable",
                copy: "The proof is valid, but the live claim preflight does not currently accept it.",
                tone: "waiting",
            };
        }
        if (!Venue.account) {
            return {
                label: "Ready after connection",
                copy: "Connect the holder wallet to sign the claim.",
                tone: "ready",
            };
        }
        if (state.associated === false) {
            return {
                label: "Association required",
                copy: "Associate LPCASH before claiming.",
                tone: "waiting",
            };
        }
        if (state.associated !== true) {
            return {
                label: "Association unknown",
                copy: "The token association check is unavailable.",
                tone: "unknown",
            };
        }
        return {
            label: "Ready to claim",
            copy: "Proof and prerequisites are current.",
            tone: "ready",
        };
    }
    return {
        label: "Funded, proof needed",
        copy: "Import the issuer’s entitlement file to establish a personal amount.",
        tone: "funded",
    };
};

Venue.paintIncome = function () {
    const state = Venue.couponState;
    const el = $("coupon-claim");
    if (!el || !state) return;
    const put = (id, value) => { if ($(id)) $(id).textContent = value; };
    put("coupon-cash-balance", state.cashBalanceKnown
        ? formatCashAmount(state.cashBalance) + " LPCASH"
        : "Unavailable");
    put("coupon-next", state.nextDue != null
        ? new Date(Number(state.nextDue) * 1000).toISOString().slice(0, 10)
        : state.scheduleKnown
            ? "Schedule complete"
            : "Unavailable");

    const established = state.personalEstablished;
    const availableKnown = state.personalAvailableKnown;
    const expected = state.personalQuote?.known
        ? state.personalQuote.net
        : state.personalGrossAvailable;
    if (!established) {
        put("pos-income", state.scheduleKnown ? "Not established" : "Unavailable");
        put("coupon-personal", state.scheduleKnown ? "Not established" : "Unavailable");
        put("pos-income-note", !state.scheduleKnown
            ? "The coupon schedule is unavailable, so personal income cannot be checked."
            : state.proof && state.proof.merkleValid == null
                ? "The imported proof could not be checked against live data."
                : state.proof
                    ? "The imported proof does not establish income for this account."
                    : "A validated issuer proof establishes a personal amount.");
    } else if (!availableKnown) {
        put("pos-income", "Unavailable");
        put("coupon-personal", "Unavailable");
        put("pos-income-note", "Entitlement verified. Current claim status is unavailable.");
    } else {
        put("pos-income", formatCashAmount(expected));
        put("coupon-personal", formatCashAmount(expected) + " LPCASH");
        const quote = state.personalQuote;
        put("pos-income-note", state.personalGrossAvailable > 0n
            ? quote?.known
                ? formatCashAmount(state.personalGrossAvailable) +
                  " gross less " + formatCashAmount(quote.fee) + " expected HTS fee."
                : formatCashAmount(state.personalGrossAvailable) +
                  " gross. Expected fee unavailable."
            : state.personalRow?.claimed
                ? "Verified entitlement has already been claimed."
                : state.personalRow && state.personalRow.closesKnown &&
                  nowSec() >= state.personalRow.closes
                    ? "Verified entitlement’s claim window is closed."
                    : "No verified amount is currently ready to claim.");
    }

    const associate = $("coupon-associate");
    if (associate) {
        associate.hidden = !(Venue.account && state.associated === false);
        associate.disabled = !(Venue.account && state.associated === false);
        associate.textContent = "Associate LPCASH";
    }

    const renderCouponRow = (row) => {
        const status = Venue.couponRowStatus(row, state);
        const date = row.dueKnown
            ? new Date(Number(row.due) * 1000).toISOString().slice(0, 10)
            : "Date unavailable";
        const funding = !row.declarationKnown
            ? "Funding unavailable"
            : row.declared
                ? formatCashAmount(row.remaining) + " LPCASH pool remaining"
                : "Not declared";
        const window = row.declared && row.closesKnown
            ? "Claims close " + Venue.portfolioDate(row.closes)
            : "";
        return '<article class="coupon-row ' + esc(status.tone) + '">' +
            '<div class="coupon-row-date"><span>Coupon ' + row.index +
            "</span><strong>" + esc(date) + "</strong></div>" +
            '<div class="coupon-row-funding"><span>Issuer funding</span><strong>' +
            esc(funding) + "</strong>" + (window ? "<small>" + esc(window) + "</small>" : "") +
            '</div><div class="coupon-row-status"><strong>' + esc(status.label) +
            "</strong><span>" + esc(status.copy) + "</span></div></article>";
    };
    const priority = [];
    const addPriority = (row) => {
        if (row && !priority.some((candidate) => candidate.index === row.index)) {
            priority.push(row);
        }
    };
    addPriority(state.proofRow);
    addPriority(state.rows.find((row) =>
        row.declared && row.closesKnown && nowSec() < row.closes &&
        !(row.claimedKnown && row.claimed)));
    addPriority([...state.rows].reverse().find((row) =>
        row.dueKnown && row.due <= nowSec() && !row.declared));
    addPriority(state.rows.find((row) => row.dueKnown && row.due >= nowSec()));
    if (!priority.length) addPriority(state.rows[state.rows.length - 1]);
    const priorityRows = priority.slice(0, 3);
    const rowsHtml = priorityRows.map(renderCouponRow).join("");
    const fullSchedule = state.rows.length > priorityRows.length
        ? '<details class="coupon-all"><summary>View complete schedule (' +
          state.rows.length + ')</summary><div>' +
          state.rows.map(renderCouponRow).join("") + "</div></details>"
        : "";

    let proofHtml = "";
    if (state.proof) {
        const proof = state.proof;
        const quote = Venue.couponFeeQuote(proof.amount);
        const proofStatus = proof.merkleValid == null
            ? "Validation is unavailable because live declaration data could not be read."
            : proof.merkleValid === false
            ? "Proof does not match the live declaration."
            : !state.proofMatchesViewer
                ? "This proof names " + shortAddr(proof.holder) +
                  ", not the account being viewed."
                : state.proofRow?.claimedKnown && state.proofRow.claimed
                    ? "This account has already claimed this entitlement."
                    : state.proofRow?.closesKnown && nowSec() >= state.proofRow.closes
                        ? "This entitlement is verified, but its claim window has closed."
                : state.claimReady
                    ? "Proof, claim window, wallet, and token association are ready."
                    : state.associated === false
                        ? "Associate LPCASH before claiming."
                        : !Venue.account
                            ? "Connect the holder wallet to claim."
                            : !proof.currentAccept
                                ? "The live claim preflight does not currently accept this proof."
                                : "One or more claim prerequisites are unavailable.";
        proofHtml = '<section class="claim-review' +
            (proof.merkleValid === false ? " invalid" : "") + '">' +
            '<header><div><span>Validated entitlement</span><strong>Coupon ' +
            esc(String(proof.index)) + "</strong></div><small>Holder " +
            esc(shortAddr(proof.holder)) + "</small></header>" +
            '<div class="claim-review-values">' +
            '<div><span>Gross entitlement</span><strong>' +
            esc(formatCashAmount(proof.amount)) + " LPCASH</strong></div>" +
            '<div><span>Expected deduction</span><strong>' +
            (quote.known ? esc(formatCashAmount(quote.fee)) + " LPCASH" : "Unavailable") +
            "</strong></div>" +
            '<div><span>Expected received</span><strong>' +
            (quote.known ? esc(formatCashAmount(quote.net)) + " LPCASH" : "Unavailable") +
            "</strong></div></div>" +
            '<p class="claim-review-status">' + esc(proofStatus) + "</p>" +
            (quote.chargedOnTop
                ? '<p class="claim-review-warning">The live token fee is configured on top of the transfer. This distributor refuses that fee direction.</p>'
                : "") +
            '<button type="button" class="primary" id="coupon-claim-go" data-position-action' +
            (state.claimReady ? "" : " disabled") + ">" +
            (state.claimReady && quote.known
                ? "Claim " + esc(formatCashAmount(quote.net)) + " LPCASH"
                : "Claim income") + "</button></section>";
    }
    el.innerHTML =
        proofHtml +
        '<div class="coupon-schedule-head"><h3>Payment schedule</h3><span>' +
        state.rows.length + " payment" + (state.rows.length === 1 ? "" : "s") +
        "</span></div>" +
        (rowsHtml || '<div class="portfolio-empty compact">No scheduled payments were returned.</div>') +
        fullSchedule;
    $("coupon-claim-go")?.addEventListener("click", () =>
        Venue.runPositionAction(() => Venue.doClaimCoupon(), "Coupon claim"));

    const summaryAction = $("income-summary-action");
    if (summaryAction) {
        summaryAction.setAttribute("data-position-action", "");
        summaryAction.disabled = false;
        if (!state.scheduleKnown) {
            Venue._incomeSummaryAction = "refresh";
            summaryAction.textContent = "Retry schedule";
        } else if (!Venue.viewer()) {
            Venue._incomeSummaryAction = "connect";
            summaryAction.textContent = "Connect or watch";
        } else if (state.proof?.merkleValid == null) {
            Venue._incomeSummaryAction = "refresh";
            summaryAction.textContent = "Retry validation";
        } else if (!state.proof || state.proof.merkleValid === false ||
            !state.proofMatchesViewer) {
            Venue._incomeSummaryAction = "proof";
            summaryAction.textContent = state.proof ? "Replace proof" : "Check entitlement";
        } else if (!Venue.account) {
            Venue._incomeSummaryAction = "connect";
            summaryAction.textContent = "Connect to claim";
        } else if (state.associated === false) {
            Venue._incomeSummaryAction = "associate";
            summaryAction.textContent = "Associate LPCASH";
        } else if (state.claimReady) {
            Venue._incomeSummaryAction = "claim";
            summaryAction.textContent = "Claim income";
        } else {
            Venue._incomeSummaryAction = "schedule";
            summaryAction.textContent = "View schedule";
        }
    }
};

Venue.refreshIncome = async function () {
    const el = $("coupon-claim");
    if (!el) return;
    const dist = Venue.c.couponDistributor;
    const sched = Venue.c.couponSchedule;
    if (!dist || !sched) {
        Venue.couponState = {
            scheduleKnown: false,
            rows: [],
            personalEstablished: false,
            personalAvailableKnown: false,
            cashBalanceKnown: false,
        };
        el.innerHTML = '<div class="portfolio-empty compact">Coupon contracts are not configured in this address book.</div>';
        if ($("pos-income")) $("pos-income").textContent = "Unavailable";
        if ($("coupon-personal")) $("coupon-personal").textContent = "Unavailable";
        if ($("coupon-next")) $("coupon-next").textContent = "Unavailable";
        if ($("coupon-cash-balance")) $("coupon-cash-balance").textContent = "Unavailable";
        if ($("pos-income-note")) {
            $("pos-income-note").textContent =
                "Coupon income cannot be checked with this deployment.";
        }
        if ($("coupon-associate")) $("coupon-associate").hidden = true;
        if ($("income-summary-action")) {
            $("income-summary-action").textContent = "Unavailable";
            $("income-summary-action").disabled = true;
        }
        return;
    }
    const who = Venue.viewer();
    const cash = Venue.cashContract();
    const base = await Promise.allSettled([
        sched.count(),
        who && cash ? cash.balanceOf(who) : Promise.resolve(null),
        Venue.account && cash
            ? Venue.cashContract(Venue.signer || Venue.reader).isAssociated()
            : Promise.resolve(null),
        dist.DOMAIN_LEAF(),
        dist.DOMAIN_NODE(),
    ]);
    if (!Venue.stillViewer(who)) return;
    const countKnown = base[0].status === "fulfilled";
    const count = countKnown ? Number(base[0].value) : 0;
    const rowReads = await Promise.all([...Array(count)].map(async (_, index) => {
        const result = await Promise.allSettled([
            dist.declarationOf(index),
            dist.claimsCloseAt(index),
            sched.dateOf(index),
            who ? dist.claimed(index, who) : Promise.resolve(null),
        ]);
        const declarationKnown = result[0].status === "fulfilled";
        const declaration = declarationKnown ? result[0].value : null;
        const closesKnown = result[1].status === "fulfilled";
        const dueKnown = result[2].status === "fulfilled";
        const claimedKnown = !!who && result[3].status === "fulfilled";
        return {
            index,
            declaration,
            declarationKnown,
            declared: declarationKnown && asBig(declaration.declaredAt) > 0n,
            total: declarationKnown ? asBig(declaration.total) : null,
            remaining: declarationKnown ? asBig(declaration.remaining) : null,
            closes: closesKnown ? asBig(result[1].value) : null,
            closesKnown,
            due: dueKnown ? asBig(result[2].value) : null,
            dueKnown,
            claimed: claimedKnown ? !!result[3].value : null,
            claimedKnown,
        };
    }));
    if (!Venue.stillViewer(who)) return;

    const domains = {
        leaf: base[3].status === "fulfilled" ? base[3].value : null,
        node: base[4].status === "fulfilled" ? base[4].value : null,
    };
    const proof = Venue.couponProof || null;
    let proofRow = proof && proof.index >= 0 && proof.index < rowReads.length
        ? rowReads[proof.index]
        : null;
    if (proof) {
        const canValidate = !!proofRow?.declarationKnown &&
            !!domains.leaf && !!domains.node;
        proof.merkleValid = !canValidate
            ? null
            : !!proofRow.declared &&
              Venue.verifyCouponProof(proof, proofRow.declaration, domains);
        proof.currentAccept = proof.merkleValid === true
            ? await dist.wouldAccept(
                proof.index,
                proof.holder,
                proof.position,
                proof.amount,
                proof.proof,
            ).catch(() => null)
            : proof.merkleValid === false
                ? false
                : null;
    }
    if (!Venue.stillViewer(who)) return;
    const proofMatchesViewer = !!(proof && who && addrEq(proof.holder, who));
    const proofMatchesAccount = !!(proof && Venue.account && addrEq(proof.holder, Venue.account));
    const associatedKnown = !!Venue.account && base[2].status === "fulfilled" &&
        base[2].value != null;
    const associated = associatedKnown ? !!base[2].value : null;
    const personalEstablished = !!(proof?.merkleValid === true && proofMatchesViewer);
    const personalStatusKnown = !!(proofRow && proofRow.claimedKnown &&
        proofRow.closesKnown && proof.currentAccept != null);
    const personalOpen = !!(proofRow?.declared && proofRow.closesKnown &&
        nowSec() < proofRow.closes);
    const personalGrossAvailable = personalEstablished && personalStatusKnown &&
        !proofRow.claimed && personalOpen && proof.currentAccept
        ? proof.amount
        : 0n;
    const personalQuote = personalEstablished
        ? Venue.couponFeeQuote(personalGrossAvailable)
        : null;
    const claimReady = !!(
        proof?.merkleValid === true &&
        proofMatchesAccount &&
        proofRow?.claimedKnown &&
        !proofRow.claimed &&
        personalOpen &&
        proof.currentAccept === true &&
        associated === true &&
        !personalQuote?.chargedOnTop
    );
    const future = rowReads
        .filter((row) => row.dueKnown && row.due >= nowSec())
        .sort((a, b) => Number(a.due - b.due))[0];
    Venue.couponState = {
        viewer: who,
        scheduleKnown: countKnown,
        rows: rowReads,
        nextDue: future?.due ?? null,
        proof,
        proofRow,
        proofMatchesViewer,
        proofMatchesAccount,
        associated,
        associatedKnown,
        cashBalance: base[1].status === "fulfilled" && base[1].value != null
            ? asBig(base[1].value)
            : null,
        cashBalanceKnown: !!who && base[1].status === "fulfilled" && base[1].value != null,
        personalEstablished,
        personalAvailableKnown: personalEstablished && personalStatusKnown,
        personalGrossAvailable,
        personalQuote,
        personalRow: proofRow,
        claimReady,
    };
    Venue.paintIncome();
};

Venue.doIncomeSummaryAction = async function () {
    if (Venue._incomeSummaryAction === "connect") {
        Venue.openSheet();
        return;
    }
    if (Venue._incomeSummaryAction === "proof") {
        $("coupon-proof")?.click();
        return;
    }
    if (Venue._incomeSummaryAction === "refresh") {
        await Venue.refreshIncome();
        return;
    }
    if (Venue._incomeSummaryAction === "associate") {
        await Venue.doAssociateCash();
        return;
    }
    if (Venue._incomeSummaryAction === "claim") {
        await Venue.doClaimCoupon();
        return;
    }
    $("income")?.scrollIntoView({behavior: "smooth", block: "start"});
};

Venue.importCouponProof = async function (file) {
    if (!file) return;
    if (file.size > 1024 * 1024) throw new Error("Proof JSON must be smaller than 1 MB.");
    let obj;
    try {
        obj = JSON.parse(await file.text());
    } catch {
        throw new Error("The entitlement file is not valid JSON.");
    }
    let index;
    let position;
    let amount;
    try {
        index = Number(obj.index ?? obj.coupon);
        position = BigInt(obj.position);
        amount = BigInt(obj.amount);
    } catch {
        throw new Error("Proof position and amount must be whole numbers.");
    }
    const holder = obj.holder;
    const proof = obj.proof;
    if (!Number.isSafeInteger(index) || index < 0 || !holder || !Array.isArray(proof)) {
        throw new Error("Proof JSON needs index, holder, position, amount, and proof[].");
    }
    if (!ethers.isAddress(holder) || position < 0n || amount <= 0n) {
        throw new Error("Proof holder, position, or amount is invalid.");
    }
    if (proof.length > 64 ||
        proof.some((node) => !/^0x[0-9a-fA-F]{64}$/.test(String(node)))) {
        throw new Error("Each proof node must be a 32-byte 0x value.");
    }
    const count = Number(await Venue.c.couponSchedule.count());
    if (index >= count) throw new Error("That coupon index is outside the live schedule.");
    Venue.couponProof = {
        index,
        holder: ethers.getAddress(holder),
        position,
        amount,
        proof: proof.map(String),
        fileName: String(file.name || "entitlement.json").slice(0, 160),
    };
    await Venue.refreshIncome();
    if (Venue.couponProof.merkleValid == null) {
        Venue.status(
            "position-status",
            "Proof imported. Live declaration data is unavailable, so validation could not finish.",
            "",
        );
        return;
    }
    if (Venue.couponProof.merkleValid === false) {
        Venue.status(
            "position-status",
            "Proof imported, but it does not match the live funded declaration.",
            "bad",
        );
        return;
    }
    Venue.status(
        "position-status",
        "Entitlement proof validated against the live declaration.",
        "ok",
    );
};

Venue.doAssociateCash = async function () {
    await Venue.requireAccount();
    const cash = Venue.cashContract(Venue.signer);
    if (!cash) throw new Error("No coupon cash token is named in this address book.");
    const rec = await Venue.send(
        () => cash.associate({gasLimit: 250_000}),
        "Associate LPCASH",
    );
    if (rec) {
        Venue.noteSimpleReceipt(
            "LPCASH associated",
            rec,
            "The Hedera token association was recorded.",
            "Token relationships, transaction input, and wallet activity remain public.",
        );
        await Venue.refreshIncome();
    }
};

Venue.doClaimCoupon = async function () {
    await Venue.requireAccount();
    const p = Venue.couponProof;
    if (!p) throw new Error("Load an entitlement proof first.");
    if (!addrEq(Venue.account, p.holder)) {
        throw new Error("The connected wallet is not the holder named in this proof.");
    }
    await Venue.refreshIncome();
    const state = Venue.couponState;
    if (p.merkleValid == null) {
        throw new Error("The proof cannot be validated while declaration data is unavailable.");
    }
    if (p.merkleValid === false) {
        throw new Error("The proof does not match the live funded declaration.");
    }
    if (state.associated !== true) {
        throw new Error(state.associated === false
            ? "Associate LPCASH before claiming."
            : "LPCASH association could not be confirmed.");
    }
    if (!state.claimReady) {
        throw new Error("The coupon is not currently ready to claim.");
    }
    const dist = Venue.c.couponDistributor;
    const ok = await dist.wouldAccept(p.index, p.holder, p.position, p.amount, p.proof);
    if (!ok) throw new Error("The live claim preflight no longer accepts this proof.");
    const rec = await Venue.send(
        () => Venue.w.couponDistributor.claim(
            p.index,
            p.holder,
            p.position,
            p.amount,
            p.proof,
            {gasLimit: 400_000},
        ),
        "Claim coupon",
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
