// The rest of the venue: the contracts the three trading screens do not call.
//
// Inlined after tools/venue-app.mjs, so `Venue`, `$`, `esc` and the rest of that
// file's helpers are already in scope and are not redeclared here.
//
// Two screens and one reader:
//
//   Venue.mountVenue   Regime, VolumeCap, TradingHalt, ParameterRoot, Rulebook,
//                      SeamJournal and EpochClock. Every governance window the
//                      venue has, and whether the venue is suspended right now.
//   Venue.mountRepo    RepoVault and the rest of MarginWatch. State, the price
//                      to repurchase now, the penalty now, and the alert.
//   Venue.history      Event history, from the mirror node, never eth_getLogs.
//
// docs/UI-PLAN.md forbids subscribing to logs: HashIO throttles eth_getLogs and
// the venue's Rule A withholds a print rather than leaking a size. Neither is a
// reason to have no history. The mirror node is a REST index Hedera runs for
// exactly this, it takes an EVM address as the path segment, and it is a read
// against a different host than the one serving eth_call, so a tape cannot cost
// the trading screens their poll budget.

const REPO_FIELDS = [
    "state", "borrower", "lender", "partition", "collateralHoldId",
    "collateralAmount", "principal", "repoRateBps", "openedAt", "maturity",
    "cureDeadline", "maintenanceBps", "markCommitment", "manufacturedCommitment",
];
const PAYER = ["none", "taker", "maker", "venue", "operator"];
// ISeamJournal.Reason. canTransfer is a bool, so this enum is the only channel a
// reason travels on and the only way a screen can say why rather than that.
const JOURNAL_REASON = [
    "the transfer is allowed",
    "the recipient holds no live grant",
    "the sender holds no live grant",
];

// Which ABI decodes an address's logs. The mirror node hands back the emitting
// address and nothing else, so the client has to know its own address book.
const LOG_ABI = {
    MatchingEngine: "MatchingEngine",
    SeamJournal: "SeamJournal",
    RepoVault: "RepoVault",
    TradingHalt: "TradingHalt",
    VolumeCap: "VolumeCap",
    Rulebook: "Rulebook",
    ParameterRoot: "ParameterRoot",
    Regime: "Regime",
    ZkKycRegistry: "ZkKycRegistry",
    RegistrationGate: "RegistrationGate",
};

Venue.iface = function (name) {
    Venue._ifaces = Venue._ifaces || {};
    if (!Venue._ifaces[name]) Venue._ifaces[name] = new ethers.Interface(ABI[name]);
    return Venue._ifaces[name];
};

// ---------- history, from the mirror node ----------

Venue.mirror = async function (path) {
    const url = CLIENT.network.mirror + path;
    const res = await fetch(url, {headers: {accept: "application/json"}});
    if (res.status === 429) {
        const e = new Error("The mirror node is rate limiting. Try again shortly.");
        e.code = 429;
        throw e;
    }
    if (!res.ok) throw new Error("Mirror node answered " + res.status + " for " + path);
    return res.json();
};

// One contract's log history, newest first, decoded against its own ABI.
//
// A log this client cannot name is kept rather than dropped: an undecodable
// entry means the deployed bytecode emitted something the bundled ABI does not
// carry, and silently hiding that is how a stale bundle goes unnoticed.
Venue.history = async function (which, {limit = 25} = {}) {
    const address = CLIENT.addresses[which];
    if (!address) throw new Error("No address for " + which);
    const abiName = LOG_ABI[which];
    const j = await Venue.mirror(
        "/api/v1/contracts/" + address + "/results/logs?order=desc&limit=" + limit);
    const iface = abiName ? Venue.iface(abiName) : null;
    return (j.logs || []).map((l) => {
        let parsed = null;
        if (iface) {
            try { parsed = iface.parseLog({topics: l.topics, data: l.data}); } catch (e) { parsed = null; }
        }
        return {
            source: which,
            name: parsed ? parsed.name : "unrecognised",
            args: parsed ? parsed.args : null,
            fragment: parsed ? parsed.fragment : null,
            topic0: l.topics && l.topics[0],
            tx: l.transaction_hash,
            block: l.block_number,
            at: l.timestamp ? Number(String(l.timestamp).split(".")[0]) : 0,
        };
    });
};

// Several contracts' history, merged onto one timeline. The venue does not do
// one thing at a time and a tape that pretends otherwise reads a crossing as
// unrelated to the halt that refused it.
Venue.historyOf = async function (names, {limit = 25} = {}) {
    const runs = await Promise.all(names.map((n) =>
        Venue.history(n, {limit}).catch((e) => {
            Venue._histErr = e.message || String(e);
            return [];
        })));
    return runs.flat().sort((a, b) => b.at - a.at).slice(0, limit * 2);
};

Venue.fmtLogArg = function (name, value) {
    if (value === null || value === undefined) return "—";
    if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return shortAddr(value);
    if (typeof value === "string" && value.length > 26) return shortId(value);
    if (typeof value === "bigint" || typeof value === "number") {
        if (/priceTwice/i.test(name)) return "twice " + value.toString();
        return value.toString();
    }
    if (typeof value === "boolean") return value ? "true" : "false";
    return String(value);
};

Venue.paintTape = function (id, entries, note) {
    const el = $(id);
    if (!el) return;
    if (!entries.length) {
        el.innerHTML = '<div class="empty">' +
            esc(Venue._histErr || "Nothing in this contract's history yet.") + "</div>";
        Venue._histErr = null;
        return;
    }
    el.innerHTML = entries.map((e) => {
        const args = e.fragment
            ? e.fragment.inputs.map((inp, i) =>
                '<span class="targ"><i>' + esc(inp.name) + "</i>" +
                esc(Venue.fmtLogArg(inp.name, e.args[i])) + "</span>").join("")
            : '<span class="targ"><i>topic0</i>' + esc(shortId(e.topic0 || "")) + "</span>";
        const when = e.at ? new Date(e.at * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z" : "—";
        return '<div class="tline' + (e.fragment ? "" : " unknown") + '">' +
            '<span class="tsrc">' + esc(e.source) + "</span>" +
            '<span class="tname">' + esc(e.name) + "</span>" +
            '<span class="targs">' + args + "</span>" +
            "<span class='tat'>" + esc(when) + " · <a href='" + explorerTx(e.tx) +
            "' rel='noopener'>" + esc(shortId(e.tx)) + "</a></span></div>";
    }).join("") + (note ? '<p class="note">' + esc(note) + "</p>" : "");
};

// ---------- the venue screen ----------

Venue.mountVenue = async function () {
    $("tape-reload")?.addEventListener("click", () => Venue.refreshTape().catch((e) => Venue.fail(e)));
    $("param-row")?.addEventListener("change", () => Venue.refreshParamRow().catch((e) => Venue.fail(e)));
    $("journal-go")?.addEventListener("click", () => Venue.doExplain().catch((e) => Venue.fail(e)));
    $("disclose-go")?.addEventListener("click", () => Venue.doDisclose().catch((e) => Venue.fail(e)));
    await Venue.refreshVenue();
    await Venue.refreshTape();
};

Venue.refreshVenue = async function () {
    const {regime, cap, halt, policy, rulebook, journal, clock} = Venue.c;
    const epoch = Venue.snap.discEpoch ?? asBig(await policy.currentEpoch());

    const [
        rCur, rFloor, rCeil, rIdeal, rMandate, rNarrowed, rClass, rPermits,
        rPending, rPendingEpoch, rPendingClass, rRelaxTo, rRelaxEpoch, rLowerTo, rLowerEpoch,
        rSup, rOp,
    ] = await Promise.all([
        regime.current(), regime.floor(), regime.ceiling(), regime.ideal(),
        regime.mandate(), regime.narrowed(), regime.liquidityClass(),
        regime.current().then((c) => regime.permits(c)),
        regime.pending(), regime.pendingEpoch(), regime.pendingLiquidityClass(),
        regime.relaxTo(), regime.relaxEpoch(), regime.lowerTo(), regime.lowerEpoch(),
        regime.supervisor(), regime.operator(),
    ]);

    const [capBps, shareBps, suspended, susFloor, capVenue] = await Promise.all([
        cap.capBps(), cap.shareBps(), cap.suspendedNow(), cap.suspendedFloor(), cap.venue(),
    ]);

    const [hNow, hUntil, band, breaker, budgetS, remaining, granted, lastPx, maxHalt] =
        await Promise.all([
            halt.haltedNow(), halt.haltedUntil(), halt.bandBps(), halt.breakerSeconds(),
            halt.budgetSeconds(), halt.remainingBudget(), halt.grantedIn(epoch),
            halt.lastPriceTwice(), halt.maxHaltSeconds(),
        ]);

    const [root, pendingRoot, pendingEpoch, prevRoot, windowAt, grace, keyCount] =
        await Promise.all([
            policy.root(), policy.pendingRoot(), policy.pendingEpoch(),
            policy.previousRoot(), policy.windowClosesAt(), policy.GRACE(), policy.keyCount(),
        ]);

    const [edition, document_, pendEd, pendEdEpoch, rbWindow, chargeCount, take, rec] =
        await Promise.all([
            rulebook.edition(), rulebook.document(), rulebook.pendingEdition(),
            rulebook.pendingEpoch(), rulebook.windowClosesAt(), rulebook.chargeCount(),
            rulebook.netOperatorTake(), rulebook.reconcile(),
        ]);

    const [jRegistry, jToken, jAdmin, jRow, jSpent, jRecord, jCeiling] = await Promise.all([
        journal.registry(), journal.token(), journal.admin(), journal.row(),
        journal.spentBits(epoch), journal.epochRecord(epoch), journal.ceiling(),
    ]);

    const [cLen, cZero, cNow] = await Promise.all([
        clock.epochLength(), clock.epochZero(), clock.currentEpoch(),
    ]);
    const cStart = await clock.startOf(cNow);

    const bps = (v) => (Number(v) / 100).toFixed(2) + "%";
    const at = (ts) => asBig(ts) === 0n ? "—" : new Date(Number(ts) * 1000).toISOString().slice(0, 19).replace("T", " ") + "Z";
    const put = (id, v, cls) => {
        const el = $(id);
        if (!el) return;
        el.textContent = v;
        if (cls !== undefined) el.className = "v " + cls;
    };

    // Regime. `current` is a lattice point, so it is read in hex beside the
    // floor and ceiling that bracket it, not as a decimal nobody can compare.
    put("rg-current", "0x" + Number(rCur).toString(16));
    put("rg-floor", "0x" + Number(rFloor).toString(16));
    put("rg-ceiling", "0x" + Number(rCeil).toString(16));
    put("rg-ideal", "0x" + Number(rIdeal).toString(16));
    put("rg-mandate", "0x" + Number(rMandate).toString(16));
    put("rg-narrowed", asBig(rNarrowed) === 0n ? "not narrowed" : "0x" + Number(rNarrowed).toString(16));
    put("rg-class", String(rClass));
    put("rg-permits", rPermits ? "current point permitted" : "current point refused",
        rPermits ? "v ok" : "v bad");
    put("rg-supervisor", addrEq(rSup, CLIENT.addresses.VolumeCap)
        ? "VolumeCap · " + shortAddr(rSup) : shortAddr(rSup),
        addrEq(rSup, CLIENT.addresses.VolumeCap) ? "v ok" : "v");
    put("rg-operator", shortAddr(rOp));
    const supNote = $("rg-supnote");
    if (supNote) {
        supNote.textContent = addrEq(rSup, CLIENT.addresses.VolumeCap)
            ? "The supervisor is a contract, not a person. Nobody holds a key that narrows this regime; the cap does it when traded share crosses the cap."
            : "The supervisor is an externally owned account, so narrowing this regime is somebody's decision rather than arithmetic.";
    }
    put("rg-pending", asBig(rPendingEpoch) === 0n
        ? "no proposal"
        : "0x" + Number(rPending).toString(16) + " · class " + rPendingClass + " · adoptable in epoch " + rPendingEpoch);
    put("rg-relax", asBig(rRelaxEpoch) === 0n
        ? "no relaxation pending"
        : "to 0x" + Number(rRelaxTo).toString(16) + " in epoch " + rRelaxEpoch);
    put("rg-lower", asBig(rLowerEpoch) === 0n
        ? "no floor cut pending"
        : "floor to 0x" + Number(rLowerTo).toString(16) + " in epoch " + rLowerEpoch);

    // VolumeCap. This is the one number on the screen that can stop the venue
    // without anybody deciding to, which is why it is stated as a sentence.
    put("vc-suspended", suspended ? "SUSPENDED" : "not suspended",
        suspended ? "v bad" : "v ok");
    put("vc-cap", bps(capBps));
    put("vc-share", bps(shareBps));
    put("vc-floor", "0x" + Number(susFloor).toString(16));
    put("vc-venue", addrEq(capVenue, CLIENT.addresses.MatchingEngine)
        ? "this engine" : shortAddr(capVenue));
    const capNote = $("vc-note");
    if (capNote) {
        capNote.textContent = suspended
            ? "The cap is holding the disclosure point at the suspended floor. Suspension here is arithmetic: no operator chose it and no operator can lift it before the share falls back under the cap."
            : "Traded share is under the cap. If it crosses, the cap clamps the regime to the suspended floor on its own.";
    }

    // TradingHalt. A halt has a budget per epoch, so how much is left is the
    // part a trader actually needs.
    put("th-now", hNow ? "HALTED" : "trading", hNow ? "v bad" : "v ok");
    put("th-until", hNow ? at(hUntil) : "—");
    put("th-band", bps(band));
    put("th-breaker", breaker + " s");
    put("th-budget", remaining + " / " + budgetS + " s left this epoch");
    put("th-granted", granted + " s granted in epoch " + epoch);
    put("th-max", maxHalt + " s per halt");
    put("th-last", asBig(lastPx) === 0n
        ? "no observation yet"
        : "twice " + lastPx + " (" + (asBig(lastPx) / 2n) + " per unit)");

    // ParameterRoot. The window is the whole point: a root is proposed, then it
    // sits, then it can be adopted. A client that shows the live root and not
    // the pending one hides the change that is already coming.
    put("pr-root", shortId(root));
    put("pr-prev", asBig(prevRoot) === 0n ? "none" : shortId(prevRoot));
    put("pr-keys", String(keyCount));
    put("pr-grace", grace + " s");
    put("pr-pending", asBig(pendingEpoch) === 0n
        ? "no proposal"
        : shortId(pendingRoot) + " · adoptable in epoch " + pendingEpoch);
    put("pr-window", asBig(windowAt) === 0n ? "—" : at(windowAt));

    // Rulebook. `reconcile` is the getter that says whether the published fee
    // schedule still matches what the contracts charge.
    const noEdition = asBig(edition) === 0n;
    put("rb-edition", noEdition ? "none adopted" : shortId(edition), noEdition ? "v" : "v ok");
    put("rb-document", noEdition ? "—" : shortId(document_));
    put("rb-charges", noEdition && asBig(chargeCount) === 0n
        ? "no schedule published" : String(chargeCount));
    put("rb-take", (asBig(take) < 0n ? "-" : "") + formatHbar(asBig(take) < 0n ? -asBig(take) : asBig(take)) + " HBAR");
    put("rb-pending", asBig(pendEdEpoch) === 0n
        ? "no proposal"
        : shortId(pendEd) + " · adoptable in epoch " + pendEdEpoch);
    put("rb-window", asBig(rbWindow) === 0n ? "—" : at(rbWindow));
    put("rb-reconcile", !rec[0]
        ? "MISMATCH on " + shortId(rec[1]) + ": published " + rec[2] + ", live " + rec[3]
        : noEdition
            ? "vacuously true: nothing is published to reconcile against"
            : "published schedule matches the live charges",
        !rec[0] ? "v bad" : noEdition ? "v" : "v ok");

    // SeamJournal. The contract that answers no, and the one the wiring check
    // asserts on at load without ever reading a figure out of.
    put("sj-registry", addrEq(jRegistry, CLIENT.addresses.ZkKycRegistry)
        ? "ZkKycRegistry" : shortAddr(jRegistry));
    put("sj-token", addrEq(jToken, CLIENT.addresses.token) ? "the bond" : shortAddr(jToken));
    put("sj-admin", shortAddr(jAdmin));
    put("sj-ceiling", "0x" + Number(jCeiling).toString(16));
    put("sj-row", "domain " + jRow[0] + " · agg " + jRow[1] + " · bucket " + jRow[2] + " · budget " + jRow[3]);
    put("sj-spent", jSpent + (Number(jRow[3]) ? " / " + jRow[3] + " bits" : " bits, unmetered"));
    // The supervisor channel. These are exact figures read from storage, never
    // from a log, which is why they are the one place the venue is allowed to
    // print a total.
    put("sj-record", jRecord.transfers + " transfers · " + jRecord.issues + " issues · " +
        jRecord.redemptions + " redemptions · " + jRecord.unverifiedArrivals + " unverified arrivals");
    put("sj-gross", "in " + jRecord.grossIn + " · out " + jRecord.grossOut + " units");

    put("ec-length", cLen + " s");
    put("ec-zero", at(cZero));
    put("ec-now", String(cNow));
    put("ec-start", at(cStart));
    const de = $("disc-epoch-in");
    if (de && !de.value) de.value = String(asBig(cNow) > 0n ? asBig(cNow) - 1n : 0n);

    await Venue.refreshCharges(Number(chargeCount));
    await Venue.refreshParamRow();
    await Venue.refreshParamSet();
    await Venue.refreshImmutables();
};

// The fee schedule, itemised. The trade screen charges a commit bond and a
// cancel fee; this is the document those are meant to reconcile to.
Venue.refreshCharges = async function (n) {
    const el = $("charges");
    if (!el) return;
    if (!n) {
        el.innerHTML = '<div class="empty">The rulebook publishes no charges.</div>';
        return;
    }
    const capN = Math.min(n, 24);
    const rows = await Promise.all(
        Array.from({length: capN}, (_, i) => Venue.c.rulebook.chargeAt(i)));
    const head = '<div class="rowline chg head"><span>Key</span><span>Source</span>' +
        "<span>Reader</span><span>Amount</span><span>Payer</span><span>Payee</span><span>Refund</span></div>";
    el.innerHTML = head + rows.map((c) =>
        '<div class="rowline chg"><span class="mono">' + esc(shortId(c.key)) + "</span>" +
        '<span class="mono">' + esc(addrEq(c.source, CLIENT.addresses.MatchingEngine)
            ? "engine" : shortAddr(c.source)) + "</span>" +
        '<span class="mono">' + esc(c.reader) + "</span>" +
        '<span class="mono">' + esc(formatHbar(asBig(c.amount))) + "</span>" +
        '<span class="mono">' + esc(PAYER[Number(c.payer)] ?? c.payer) + "</span>" +
        '<span class="mono">' + esc(PAYER[Number(c.payee)] ?? c.payee) + "</span>" +
        '<span class="mono">' + (c.refundable ? "yes" : "no") + "</span></div>").join("") +
        (n > capN ? '<p class="note">' + (n - capN) + " further charges not shown.</p>" : "");
};

// One row of the parameter set, read off ParameterRoot rather than off the
// bundle. client.json records what these were when it was generated; the point
// of a governance window is that they change without the bundle knowing.
Venue.refreshParamRow = async function () {
    const sel = $("param-row");
    const out = $("param-out");
    if (!sel || !out) return;
    const row = Number(sel.value);
    const {policy} = Venue.c;
    const [ceiling, budget, floor, waived, key, keyB, keyF] = await Promise.all([
        policy.ceilingFor(row), policy.budgetFor(row), policy.floorFor(row),
        policy.isWaived(row), policy.keyOfRow(row), policy.keyOfRowBudget(row),
        policy.keyOfRowFloor(row),
    ]);
    const local = CLIENT.disclosure["row" + row];
    const drift = local && String(local.ceiling) !== String(ceiling);
    out.innerHTML =
        '<ul class="readout">' +
        '<li><span class="k">ceilingFor</span><span class="v">0x' + Number(ceiling).toString(16) +
        (drift ? ' <b class="bad">drifted from the bundle (' + esc(local.ceiling) + ")</b>" : "") + "</span></li>" +
        '<li><span class="k">floorFor</span><span class="v">0x' + Number(floor).toString(16) + "</span></li>" +
        '<li><span class="k">budgetFor</span><span class="v">domain ' + budget[0] + " · agg " + budget[1] +
        " · bucket " + budget[2] + " · budget " + budget[3] +
        (Number(budget[3]) === 0 ? " (unmetered)" : " bits") + "</span></li>" +
        '<li><span class="k">isWaived</span><span class="v">' + (waived ? "waived" : "enforced") + "</span></li>" +
        '<li><span class="k">keyOfRow</span><span class="v">' + esc(shortId(key)) + "</span></li>" +
        '<li><span class="k">keyOfRowBudget</span><span class="v">' + esc(shortId(keyB)) + "</span></li>" +
        '<li><span class="k">keyOfRowFloor</span><span class="v">' + esc(shortId(keyF)) + "</span></li>" +
        "</ul>";
};

// SeamJournal.explain, which is the only pre-flight in the system that says
// *why* a transfer would be refused rather than reverting and leaving a
// selector behind. canTransfer answers the same question with one bit.
Venue.doExplain = async function () {
    const from = ($("ex-from").value || "").trim() || Venue.viewer() || ZERO;
    const to = ($("ex-to").value || "").trim() || ZERO;
    const amt = ($("ex-amt").value || "0").trim();
    const out = $("journal-out");
    if (!ethers.isAddress(from) || !ethers.isAddress(to)) {
        out.innerHTML = '<div class="empty">Both sides have to be addresses.</div>';
        return;
    }
    let qty;
    try { qty = BigInt(amt); } catch (e) { throw new Error("Quantity is a whole number of units."); }
    const [ok, reason] = await Venue.c.journal.explain(from, to, qty);
    const can = await Venue.c.journal.canTransfer(from, to, qty);
    const why = JOURNAL_REASON[Number(reason)] || ("reason code " + reason);
    out.innerHTML = '<div class="card ' + (ok ? "open" : "dead") + '">' +
        "<div class='meta'>explain(" + esc(shortAddr(from)) + " → " + esc(shortAddr(to)) +
        ", " + esc(String(qty)) + ")</div>" +
        "<div><b>" + (ok ? "would be allowed" : "would be refused") + "</b> · " + esc(why) + "</div>" +
        "<div class='meta'>canTransfer says " + (can ? "true" : "false") +
        (can === ok ? "" : ". The two getters disagree, which is worth reporting.") + "</div></div>";
};

Venue.refreshTape = async function () {
    const which = ($("tape-scope")?.value || "governance");
    const names = which === "governance"
        ? ["Regime", "ParameterRoot", "Rulebook", "TradingHalt", "VolumeCap"]
        : which === "market"
            ? ["MatchingEngine", "SeamJournal"]
            : ["Regime", "ParameterRoot", "Rulebook", "TradingHalt", "VolumeCap",
                "MatchingEngine", "SeamJournal", "RepoVault", "ZkKycRegistry", "RegistrationGate"];
    Venue.paintTape("tape", await Venue.historyOf(names, {limit: 20}),
        "Read from the Hedera mirror node, not from eth_getLogs. Newest first.");
};

// ---------- the repo screen ----------

Venue.mountRepo = async function () {
    $("repo-go")?.addEventListener("click", () => Venue.doRepo().catch((e) => Venue.fail(e)));
    $("repo-id")?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") Venue.doRepo().catch((x) => Venue.fail(x));
    });
    $("repo-discover")?.addEventListener("click", () => Venue.discoverRepos().catch((e) => Venue.fail(e)));
    await Venue.refreshVault();
    await Venue.discoverRepos().catch(() => {});
};

Venue.refreshVault = async function () {
    const {vault, watch} = Venue.c;
    const [grace, penalty, engineAddr, security, pol, wVault, stream] = await Promise.all([
        vault.failGrace(), vault.penaltyRate(), vault.marginEngine(),
        vault.security(), vault.policy(), watch.vault(), watch.stream(),
    ]);
    const put = (id, v, cls) => {
        const el = $(id);
        if (!el) return;
        el.textContent = v;
        if (cls !== undefined) el.className = "v " + cls;
    };
    put("rv-grace", grace + " s");
    put("rv-penalty", penalty + " bps per second");
    // The margin engine is who may post a mark and call the borrower. On this
    // deployment it is an externally owned account, which is a fact about the
    // deployment and not something a client should round off to a contract name.
    put("rv-engine", addrEq(engineAddr, CLIENT.addresses.MarginWatch)
        ? "MarginWatch" : shortAddr(engineAddr) + " · an account, not a contract");
    put("rv-security", addrEq(security, CLIENT.addresses.token) ? "the bond" : shortAddr(security));
    put("rv-policy", addrEq(pol, CLIENT.addresses.ParameterRoot)
        ? "ParameterRoot" : shortAddr(pol));
    put("rv-watchvault", addrEq(wVault, CLIENT.addresses.RepoVault)
        ? "this vault" : shortAddr(wVault),
        addrEq(wVault, CLIENT.addresses.RepoVault) ? "v ok" : "v bad");
    put("rv-stream", "epoch " + stream.epoch + " · permitted " + stream.permitted +
        " · audible " + stream.audible + " · spent " + stream.spentBits + "/" + stream.budgetBits,
        stream.audible ? "v ok" : "v bad");
};

// Repo ids are not enumerable on chain. They are, however, the indexed topic of
// every event the vault emits, so the history the mirror node already indexes is
// the discovery mechanism. The Position screen asks a trader to paste an id and
// never says where one comes from; this is where one comes from.
Venue.discoverRepos = async function () {
    const el = $("repo-known");
    if (!el) return;
    el.innerHTML = '<div class="empty">Reading the vault history…</div>';
    const logs = await Venue.history("RepoVault", {limit: 100});
    const seen = new Map();
    for (const l of logs) {
        if (!l.args || !l.args.length) continue;
        const id = l.args[0];
        if (typeof id !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(id)) continue;
        if (!seen.has(id)) seen.set(id, {id, last: l.name, at: l.at, n: 0});
        seen.get(id).n += 1;
    }
    Venue.knownRepos = [...seen.values()];
    if (!Venue.knownRepos.length) {
        el.innerHTML = '<div class="empty">The vault has no history on this network yet. ' +
            "Paste an id above if you have one.</div>";
        return;
    }
    el.innerHTML = Venue.knownRepos.map((r) =>
        '<button type="button" class="quiet repo-pick" data-id="' + esc(r.id) + '">' +
        esc(shortId(r.id)) + ' <span class="meta">' + esc(r.last) + " · " + r.n + " events</span></button>").join("");
    el.querySelectorAll(".repo-pick").forEach((b) => b.addEventListener("click", () => {
        $("repo-id").value = b.dataset.id;
        Venue.doRepo().catch((e) => Venue.fail(e));
    }));
    // Whatever ids the vault knows about, the watcher can answer for in one
    // call. calledAmong is the cheap question: which of these are under a call.
    const ids = Venue.knownRepos.map((r) => r.id);
    if (ids.length) {
        const called = await Venue.c.watch.calledAmong(ids).catch(() => []);
        const set = new Set([...called].map((x) => String(x).toLowerCase()));
        el.querySelectorAll(".repo-pick").forEach((b) => {
            if (set.has(b.dataset.id.toLowerCase())) b.classList.add("called");
        });
        const n = $("repo-called");
        if (n) n.textContent = set.size
            ? set.size + " of " + ids.length + " are under a margin call"
            : "none of the " + ids.length + " known repos are under a call";
    }
};

Venue.doRepo = async function () {
    const id = ($("repo-id").value || "").trim();
    const out = $("repo-out");
    if (!/^0x[0-9a-fA-F]{64}$/.test(id)) {
        out.innerHTML = '<div class="empty">A repo id is thirty-two bytes.</div>';
        return;
    }
    const {vault, watch} = Venue.c;
    const [r, state, alert] = await Promise.all([
        vault.repo(id), vault.stateOf(id), watch.alertOf(id),
    ]);
    if (Number(state) === 0) {
        out.innerHTML = '<div class="empty">The vault has no repo under that id.</div>';
        return;
    }
    // repurchasePriceNow and settlementPenaltyNow are the two figures that move
    // with the clock, so they are read now rather than derived from openedAt.
    const [price, penalty, sub] = await Promise.all([
        vault.repurchasePriceNow(id).catch(() => null),
        vault.settlementPenaltyNow(id).catch(() => null),
        vault.substitute(id).catch(() => null),
    ]);
    const at = (ts) => asBig(ts) === 0n ? "—"
        : new Date(Number(ts) * 1000).toISOString().slice(0, 19).replace("T", " ") + "Z";
    const st = REPO_STATE[Number(state)] || String(state);
    const li = (k, v) => '<li><span class="k">' + esc(k) + '</span><span class="v">' + v + "</span></li>";
    out.innerHTML =
        '<div class="card ' + (Number(state) >= 5 ? "dead" : Number(state) === 3 ? "sealed" : "open") + '">' +
        '<div class="id">' + esc(id) + "</div>" +
        "<div class='meta'>state <b>" + esc(st) + "</b>" +
        (alert.called ? " · under a margin call" : "") +
        (alert.cureExpired ? " · cure window expired" : "") +
        (alert.unmarkedFail ? " · unmarked fail" : "") +
        (alert.defaultable ? " · defaultable" : "") + "</div></div>" +
        '<ul class="readout">' +
        li("borrower", esc(shortAddr(r.borrower))) +
        li("lender", esc(shortAddr(r.lender))) +
        li("partition", esc(shortId(r.partition))) +
        li("collateral", esc(String(r.collateralAmount)) + " units, hold " + esc(String(r.collateralHoldId))) +
        li("principal", esc(formatHbar(asBig(r.principal))) + " HBAR") +
        li("repo rate", esc(String(r.repoRateBps)) + " bps") +
        li("maintenance", esc(String(r.maintenanceBps)) + " bps") +
        li("opened", esc(at(r.openedAt))) +
        li("maturity", esc(at(r.maturity))) +
        li("cure deadline", esc(at(r.cureDeadline))) +
        li("repurchase now", price === null
            ? "<i>not answerable in this state</i>"
            : esc(formatHbar(asBig(price))) + " HBAR") +
        li("settlement penalty now", penalty === null
            ? "<i>not answerable in this state</i>"
            : esc(formatHbar(asBig(penalty))) + " HBAR") +
        li("mark commitment", asBig(r.markCommitment) === 0n ? "none posted" : esc(shortId(r.markCommitment))) +
        li("manufactured", asBig(r.manufacturedCommitment) === 0n
            ? "none observed" : esc(shortId(r.manufacturedCommitment))) +
        li("substitute", sub === null || addrEq(sub, ZERO)
            ? "none. RepoVault.substitute reverts SubstitutionRefused by design"
            : esc(String(sub))) +
        "</ul>";

    const tape = (await Venue.history("RepoVault", {limit: 100}))
        .filter((l) => l.args && String(l.args[0]).toLowerCase() === id.toLowerCase());
    Venue.paintTape("repo-tape", tape, "Every vault event carrying this id, newest first.");
};

// ---------- the live book, for the trade screen ----------
//
// revealedCount and liveAt enumerate what has actually been opened. Until this
// existed the trade screen could show you your own tickets and nothing about
// the round you were about to be crossed in.
Venue.refreshBook = async function () {
    const el = $("book");
    if (!el) return;
    const {engine} = Venue.c;
    const round = Venue.snap.round ?? asBig(await engine.currentRound());
    const n = Number(await engine.revealedCount());
    // The quote and the retained fees are facts about the round, not about the
    // book, so an empty book is no reason to stop saying them. An earlier cut
    // returned here and left both blank whenever nothing was resting.
    await Venue.paintQuote(round);
    if (!n) {
        el.innerHTML = '<div class="empty">Nothing revealed. A sealed commitment is not in the book ' +
            "until it is opened, which is the point.</div>";
        return;
    }
    const capN = Math.min(n, 40);
    const ids = await Promise.all(Array.from({length: capN}, (_, i) => engine.liveAt(i)));
    const rows = await Promise.all(ids.map(async (id) => {
        const [o, live, eligible, backing] = await Promise.all([
            engine.orders(id), engine.isLive(id), engine.eligibleIn(id, round),
            engine.backingOf(id).catch(() => null),
        ]);
        return {id, o, live, eligible, backing};
    }));
    const mine = (Venue.viewer() || "").toLowerCase();
    const head = '<div class="rowline book head"><span>Order</span><span>Side</span><span>Price</span>' +
        "<span>Qty</span><span>Filled</span><span>Rounds</span><span>State</span><span></span></div>";
    el.innerHTML = head + rows.map((r) => {
        const o = r.o;
        const isMine = String(o.trader).toLowerCase() === mine;
        const stale = !o.retired && round > asBig(o.lastRound);
        const state = o.retired ? "retired" : stale ? "past its last round"
            : r.eligible ? "eligible" : r.live ? "resting" : "not live";
        return '<div class="rowline book' + (isMine ? " mine" : "") + '">' +
            '<span class="mono">' + esc(shortId(r.id)) + (isMine ? " ·you" : "") + "</span>" +
            '<span class="mono">' + (Number(o.side) === 1 ? "SELL" : "BUY") + "</span>" +
            '<span class="mono">' + esc(String(o.price)) + "</span>" +
            '<span class="mono">' + esc(String(o.qty)) + "</span>" +
            '<span class="mono">' + esc(String(o.filled)) + "</span>" +
            '<span class="mono">' + esc(String(o.firstRound)) + "–" + esc(String(o.lastRound)) + "</span>" +
            '<span class="mono">' + esc(state) + "</span>" +
            "<span>" + (stale
                ? '<button type="button" class="quiet expire-go" data-id="' + esc(r.id) + '">Expire</button>'
                : "") + "</span></div>";
    }).join("") + (n > capN ? '<p class="note">' + (n - capN) + " further live orders not shown.</p>" : "");
    // expire is permissionless and retires an order the clock has passed. It is
    // not the committer's bond being touched, so offering it is not the thing
    // docs/UI-PLAN.md forbids: that is forfeit, which this client still refuses.
    el.querySelectorAll(".expire-go").forEach((b) =>
        b.addEventListener("click", () => Venue.doExpire(b.dataset.id).catch((e) => Venue.fail(e))));
};

// quote is a view over the round that has closed, so the screen can say what
// crossRound would do before anybody pays the gas to find out.
Venue.paintQuote = async function (round) {
    const {engine} = Venue.c;
    const prev = round > 0n ? round - 1n : 0n;
    const [[willCross, priceTwice, volume], already, fees] = await Promise.all([
        engine.quote(prev), engine.crossed(prev), engine.feesRetained(),
    ]);
    const q = $("book-quote");
    if (q) {
        q.textContent = already
            ? "Round " + prev + " is already crossed."
            : willCross
                ? "Round " + prev + " would cross " + volume + " units at " +
                  (asBig(priceTwice) / 2n) + " tinybar per unit (priceTwice " + priceTwice + ")."
                : "Round " + prev + " would not cross. Nothing eligible on both sides.";
    }
    const f = $("book-fees");
    if (f) f.textContent = formatHbar(asBig(fees)) + " HBAR";
};

Venue.refreshMarketTape = async function () {
    const el = $("market-tape");
    if (!el) return;
    Venue.paintTape("market-tape", await Venue.historyOf(["MatchingEngine"], {limit: 20}),
        "Crossings, prints, refusals and forfeits, from the mirror node.");
};

// ---------- the instrument, for the position screen ----------
//
// The bond is the thing being traded and until now the client read exactly one
// figure off it, the caller's own partition balance. A trader deciding whether a
// venue is worth using wants to know what the paper is, how much of it exists,
// and that the compliance hook is the one the venue claims.
Venue.refreshInstrument = async function () {
    const {token} = Venue.c;
    const who = Venue.viewer();
    const part = CLIENT.immutables.partition;
    const [name, symbol, supply, multi, lists, comp] = await Promise.all([
        token.name(), token.symbol(), token.totalSupply(),
        token.isMultiPartition(), token.getExternalKycListsCount(), token.compliance(),
    ]);
    const [whole, inPart] = who
        ? await Promise.all([token.balanceOf(who), token.balanceOfByPartition(part, who)])
        : [null, null];
    const put = (id, v, cls) => {
        const el = $(id);
        if (!el) return;
        el.textContent = v;
        if (cls !== undefined) el.className = "v " + cls;
    };
    put("in-name", name + " · " + symbol);
    put("in-supply", supply + " units, no decimals");
    put("in-multi", multi ? "multi-partition" : "single partition " + shortId(part));
    put("in-lists", lists + " external KYC list" + (Number(lists) === 1 ? "" : "s"));
    put("in-compliance", addrEq(comp, CLIENT.addresses.SeamJournal)
        ? "SeamJournal · the venue's own hook" : shortAddr(comp),
        addrEq(comp, CLIENT.addresses.SeamJournal) ? "v ok" : "v bad");
    // balanceOf counts every partition and does not net out held units;
    // balanceOfByPartition excludes them. Two different questions, so both.
    put("in-balance", whole === null ? "connect or watch an address"
        : whole + " total · " + inPart + " free in this partition");
};

// ---------- the gate's own governance, for the prove screen ----------
//
// A grant dies at the KYC epoch boundary with nothing on chain warning anyone.
// The screen already counts that down. What it never showed is that the policy
// the gate enforces is itself under a proposal window, and that the registry can
// be pointed at a different gate entirely.
Venue.refreshGateGov = async function () {
    const {gate, registry} = Venue.c;
    const [issuer, verifier, pMinTier, pMask, pEpoch] = await Promise.all([
        gate.issuer(), gate.verifier(), gate.pendingMinTier(),
        gate.pendingJurisdictionMask(), gate.pendingPolicyEpoch(),
    ]);
    const [admin, pendingGate, pendingGateEpoch, epochLen, epochZero] = await Promise.all([
        registry.admin(), registry.pendingGate(), registry.pendingGateEpoch(),
        registry.epochLength(), registry.epochZero(),
    ]);
    const put = (id, v, cls) => {
        const el = $(id);
        if (!el) return;
        el.textContent = v;
        if (cls !== undefined) el.className = "v " + cls;
    };
    put("gv-issuer", shortAddr(issuer));
    put("gv-verifier", addrEq(verifier, CLIENT.addresses.KycVerifier)
        ? "KycVerifier · " + shortAddr(verifier) : shortAddr(verifier),
        addrEq(verifier, CLIENT.addresses.KycVerifier) ? "v ok" : "v bad");
    put("gv-pending", asBig(pEpoch) === 0n
        ? "no policy change proposed"
        : "tier " + pMinTier + " · mask " + pMask + " · adoptable in epoch " + pEpoch,
        asBig(pEpoch) === 0n ? "v" : "v bad");
    put("gv-admin", shortAddr(admin));
    put("gv-gate", addrEq(pendingGate, ZERO)
        ? "no gate change proposed"
        : shortAddr(pendingGate) + " · adoptable in epoch " + pendingGateEpoch,
        addrEq(pendingGate, ZERO) ? "v" : "v bad");
    put("gv-epoch", epochLen + " s from " +
        new Date(Number(epochZero) * 1000).toISOString().slice(0, 10));

    // Whether next epoch's root is up is the difference between a grant that can
    // be renewed the moment it dies and one that cannot be renewed at all.
    // rootForEpoch is declared uint256, not bytes32, so ethers hands back a
    // BigInt. It is a Merkle root and reads as one only in hex.
    const cur = Venue.snap.kycEpoch ?? asBig(await registry.currentEpoch());
    const next = asBig(await gate.rootForEpoch(cur + 1n).catch(() => 0n));
    put("gv-nextroot", next === 0n
        ? "NOT PUBLISHED. Every grant dies at the boundary and none can be renewed until it is."
        : shortId(toHexWord(next)) + " · published, so a grant can be renewed the moment this epoch ends",
        next === 0n ? "v bad" : "v ok");
};

// ---------- the two permissionless writes the client never offered ----------
//
// Both of these are `external` with no caller check, which is deliberate in the
// contracts: housekeeping that anyone may do is housekeeping that gets done.
// Neither is offered anywhere else in the client, so neither ever got done.

// Retire an order the round clock has passed. Refuses before `lastRound` with
// StillResting, so the button is only drawn where the call would succeed.
Venue.doExpire = async function (id) {
    await Venue.requireAccount();
    const rec = await Venue.send(Venue.w.engine.expire(id, {gasLimit: 400_000}), "expire");
    if (rec) await Venue.refreshBook();
};

// Publish a closed epoch's record from the journal. This is the only write in
// the system whose entire purpose is to disclose, and it spends budget to do it:
// the coarser reading is taken when the finer one is unaffordable, and nothing
// at all is emitted when neither fits. On an epoch that has not closed it is a
// silent no-op, which is why the screen refuses to send one.
Venue.doDisclose = async function () {
    const raw = ($("disc-epoch-in").value || "").trim();
    let e;
    try { e = BigInt(raw); } catch (x) { throw new Error("An epoch is a whole number."); }
    const now = Venue.snap.discEpoch ?? asBig(await Venue.c.policy.currentEpoch());
    if (e >= now) {
        Venue.status("disclose-status",
            "Epoch " + e + " has not closed. disclose() returns without doing anything, " +
            "so this would spend gas to change nothing. Epoch " + (now - 1n) + " is the latest closed one.", "bad");
        return;
    }
    const before = await Venue.c.journal.spentBits(e);
    await Venue.requireAccount();
    const rec = await Venue.send(Venue.w.journal.disclose(e, {gasLimit: 300_000}), "disclose");
    if (!rec) return;
    const after = await Venue.c.journal.spentBits(e);
    // Decode from this receipt, never from a log query: the epoch a receipt
    // speaks for is the one in its own block, and re-reading currentEpoch here
    // would name a different one.
    const iface = Venue.iface("SeamJournal");
    let said = null;
    for (const log of rec.logs) {
        try {
            const p = iface.parseLog({topics: log.topics, data: log.data});
            if (p.name === "EpochDisclosed") said = p;
        } catch (x) { /* a log from another contract in the same transaction */ }
    }
    Venue.status("disclose-status", said
        ? "Epoch " + said.args[0] + " disclosed at granularity " + G_NAME[Number(said.args[1])] +
          ", value " + said.args[2] + ". Budget spent went " + before + " → " + after + " bits."
        : "Nothing was emitted. The budget could not afford even the coarsest reading, " +
          "so the journal withheld rather than overspend. Spent is still " + after + " bits.",
        said ? "ok" : "bad");
    await Venue.refreshVenue();
};

// ---------- the parameter set, enumerated ----------
//
// keyCount and keyAt walk everything governance actually published, and valueOf
// reads each one back. The disclosure table shows ten rows because those are the
// rows the client knows names for; this shows the set itself, including the
// entries that are not rows at all.
Venue.refreshParamSet = async function () {
    const el = $("param-set");
    if (!el) return;
    const {policy} = Venue.c;
    const [n, rowCard, waivedKey] = await Promise.all([
        policy.keyCount(), policy.ROW_CARD(), policy.KEY_WAIVED_ROWS(),
    ]);
    const count = Math.min(Number(n), 64);
    const keys = await Promise.all(Array.from({length: count}, (_, i) => policy.keyAt(i)));
    // `valueOf` is on Object.prototype, so `policy.valueOf(k)` reaches the
    // built-in and hands back the contract rather than sending a call. Ask for
    // the fragment by name instead. ParameterRoot.valueOf and IAtsToken.name are
    // the only two entries in any bundled ABI that collide this way.
    const readValue = policy.getFunction("valueOf");
    const values = await Promise.all(keys.map((k) => readValue(k)));
    const card = Number(rowCard);

    // A key is a small integer in one of three bands, so it can be named rather
    // than left as a word nobody can read. The bands come from keyOfRow,
    // keyOfRowFloor and keyOfRowBudget, which are `pure` and derive them.
    const nameOf = (key) => {
        if (String(key).toLowerCase() === String(waivedKey).toLowerCase()) return "waived-rows mask";
        const k = Number(asBig(key));
        if (!Number.isSafeInteger(k)) return "—";
        if (k < card) return "row " + k + " ceiling" + (ROW_NAMES[k] ? " · " + ROW_NAMES[k] : "");
        if (k < 2 * card) return "row " + (k - card) + " floor";
        if (k < 3 * card) return "row " + (k - 2 * card) + " budget";
        return "—";
    };
    const head = '<div class="rowline pset head"><span>Key</span><span>What it sets</span><span>Value</span></div>';
    el.innerHTML = head + keys.map((k, i) => {
        const v = asBig(values[i]);
        return '<div class="rowline pset"><span class="mono">' + esc(shortId(k)) + "</span>" +
            "<span>" + esc(nameOf(k)) + "</span>" +
            '<span class="mono">' + esc(v.toString()) + " · 0x" + v.toString(16) + "</span></div>";
    }).join("") + (Number(n) > count
        ? '<p class="note">' + (Number(n) - count) + " further keys not shown.</p>" : "");
};

// ---------- the immutables, read rather than trusted ----------
//
// client.json carries these so a screen need not fetch them to draw a form. That
// is a cache, and a cache that nobody ever compares against the source is just a
// hardcoded number with a better story. This compares.
Venue.refreshImmutables = async function () {
    const el = $("immutables");
    if (!el) return;
    const {engine, registry, gate} = Venue.c;
    const [bond, fee, delay, window_, len, rest, gen, part, dom, minFee, uses, tier, mask] =
        await Promise.all([
            engine.commitBond(), engine.cancelFee(), engine.revealDelay(),
            engine.revealWindow(), engine.roundLength(), engine.restRounds(),
            engine.genesis(), engine.partition(), engine.DOMAIN_ORDER(),
            engine.minimumCancelFee(await engine.commitBond(), await engine.revealDelay(),
                await engine.revealWindow()),
            registry.MAX_USES_PER_EPOCH(), gate.minTier(), gate.jurisdictionMask(),
        ]);
    const I = CLIENT.immutables;
    const pairs = [
        ["commitBond", bond, I.commitBond], ["cancelFee", fee, I.cancelFee],
        ["revealDelay", delay, I.revealDelay], ["revealWindow", window_, I.revealWindow],
        ["roundLength", len, I.roundLength], ["restRounds", rest, I.restRounds],
        ["genesis", gen, I.genesis], ["partition", part, I.partition],
        ["DOMAIN_ORDER", dom, I.DOMAIN_ORDER], ["MAX_USES_PER_EPOCH", uses, I.MAX_USES_PER_EPOCH],
        ["minTier", tier, I.minTier], ["jurisdictionMask", mask, I.jurisdictionMask],
    ];
    let drifted = 0;
    const head = '<div class="rowline pset head"><span>Immutable</span><span>On chain now</span><span>In this bundle</span></div>';
    el.innerHTML = head + pairs.map(([k, live, bundled]) => {
        const a = String(live).toLowerCase(), b = String(bundled ?? "").toLowerCase();
        const same = a === b || asBig(live ?? 0) === asBig(bundled ?? 0);
        if (!same) drifted++;
        return '<div class="rowline pset' + (same ? "" : " drift") + '"><span>' + esc(k) + "</span>" +
            '<span class="mono">' + esc(String(live).length > 26 ? shortId(String(live)) : String(live)) + "</span>" +
            '<span class="mono">' + (same ? "same"
                : "<b class='bad'>" + esc(String(bundled).length > 26
                    ? shortId(String(bundled)) : String(bundled)) + "</b>") + "</span></div>";
    }).join("");
    const note = $("imm-note");
    if (note) {
        note.textContent = drifted
            ? drifted + " value" + (drifted === 1 ? " has" : "s have") +
              " moved since this bundle was generated. Regenerate it with make client before " +
              "trusting any figure the client did not read live."
            : "Every immutable this bundle carries still matches the chain. The cancel fee is " +
              "also checked against minimumCancelFee, which is what the contract would reject below.";
    }
    const mf = $("imm-minfee");
    if (mf) mf.textContent = minFee + " tinybar minimum, engine charges " + fee;
};
