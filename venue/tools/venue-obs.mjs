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
    "cureDeadline", "maintenanceBps", "markCommitment", "lastCouponCommitment",
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
    PrimeOracle: "PrimeOracle",
    CouponSchedule: "CouponSchedule",
    CouponDistributor: "CouponDistributor",
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
    if (value === null || value === undefined) return "Unavailable";
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
        const when = e.at ? new Date(e.at * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z" : "Unavailable";
        return '<div class="tline' + (e.fragment ? "" : " unknown") + '">' +
            '<span class="tsrc">' + esc(e.source) + "</span>" +
            '<span class="tname">' + esc(e.name) + "</span>" +
            '<span class="targs">' + args + "</span>" +
            "<span class='tat'>" + esc(when) + " · <a href='" + esc(explorerTx(e.tx)) +
            "' rel='noopener'>" + esc(shortId(e.tx)) + "</a></span></div>";
    }).join("") + (note ? '<p class="note">' + esc(note) + "</p>" : "");
};

// ---------- the venue screen ----------

Venue.mountVenue = async function () {
    $("tape-reload")?.addEventListener("click", () => Venue.refreshTape().catch((e) => Venue.fail(e)));
    $("param-row")?.addEventListener("change", () => Venue.refreshParamRow().catch((e) => Venue.fail(e)));
    $("journal-go")?.addEventListener("click", () => Venue.doExplain().catch((e) => Venue.fail(e)));
    $("disclose-go")?.addEventListener("click", () => Venue.doDisclose().catch((e) => Venue.fail(e)));
    await Promise.all([
        Venue.refreshVenue(),
        Venue.refreshInstrument(),
    ]);
    await Venue.refreshTape();
    // `tools/hcs-view.mjs` is inlined only into this screen, so a build without
    // it still mounts the rest of the Rulebook rather than throwing at boot.
    if (Venue.mountTopic) await Venue.mountTopic().catch((e) => Venue.fail(e));
};

Venue.refreshVenue = async function () {
    const {regime, cap, halt, policy, rulebook, journal, clock} = Venue.c;
    const epoch = Venue.snap.discEpoch ?? asBig(await policy.currentEpoch());

    // Fifty-seven reads. Grouped by the contract they ask, which is how they are
    // read, they were also *issued* by that grouping: seven waves, each one
    // waiting on the last for no reason, because nothing in the regime block is
    // an input to the cap block. They go out together now. ethers puts everything
    // dispatched in one tick into a single JSON-RPC request, so the screen costs
    // one round trip rather than seven, and the grouping survives in the
    // destructuring where it was doing the reader some good.
    //
    // Two reads genuinely take an input. `startOf` wants the clock's epoch, which
    // is the disclosure epoch the masthead already read this tick, so it is asked
    // speculatively and checked below. `permits` wants the regime's current
    // point, which this client has no way to know before it asks, so it is the
    // one thing left in a second wave.
    const [
        rCur, rFloor, rCeil, rIdeal, rMandate, rNarrowed, rClass,
        rPending, rPendingEpoch, rPendingClass, rRelaxTo, rRelaxEpoch, rLowerTo, rLowerEpoch,
        rSup, rOp,
        capBps, shareBps, suspended, susFloor, capVenue,
        hNow, hUntil, band, breaker, budgetS, remaining, granted, lastPx, maxHalt,
        root, pendingRoot, pendingEpoch, prevRoot, windowAt, grace, keyCount,
        edition, document_, pendEd, pendEdEpoch, rbWindow, chargeCount, take, rec,
        jRegistry, jToken, jAdmin, jRow, jSpent, jRecord, jCeiling,
        cLen, cZero, cNow, cStartGuess,
    ] = await Promise.all([
        regime.current(), regime.floor(), regime.ceiling(), regime.ideal(),
        regime.mandate(), regime.narrowed(), regime.liquidityClass(),
        regime.pending(), regime.pendingEpoch(), regime.pendingLiquidityClass(),
        regime.relaxTo(), regime.relaxEpoch(), regime.lowerTo(), regime.lowerEpoch(),
        regime.supervisor(), regime.operator(),

        cap.capBps(), cap.shareBps(), cap.suspendedNow(), cap.suspendedFloor(), cap.venue(),

        halt.haltedNow(), halt.haltedUntil(), halt.bandBps(), halt.breakerSeconds(),
        halt.budgetSeconds(), halt.remainingBudget(), halt.grantedIn(epoch),
        halt.lastPriceTwice(), halt.maxHaltSeconds(),

        policy.root(), policy.pendingRoot(), policy.pendingEpoch(),
        policy.previousRoot(), policy.windowClosesAt(), policy.GRACE(), policy.keyCount(),

        rulebook.edition(), rulebook.document(), rulebook.pendingEdition(),
        rulebook.pendingEpoch(), rulebook.windowClosesAt(), rulebook.chargeCount(),
        rulebook.netOperatorTake(), rulebook.reconcile(),

        journal.registry(), journal.token(), journal.admin(), journal.row(),
        journal.spentBits(epoch), journal.epochRecord(epoch), journal.ceiling(),

        clock.epochLength(), clock.epochZero(), clock.currentEpoch(),
        clock.startOf(epoch),
    ]);

    // The four panels below the fold need nothing from the two reads left in
    // this wave, so they are started here rather than after the rendering: their
    // first reads join the same request `permits` is in.
    const panels = Promise.all([
        Venue.refreshCharges(Number(chargeCount)),
        Venue.refreshParamRow(),
        Venue.refreshParamSet(),
        Venue.refreshImmutables(),
        Venue.refreshCoupon(),
        Venue.refreshInstrument().catch(() => {}),
    ]);
    const [rPermits, cStart] = await Promise.all([
        regime.permits(rCur),
        asBig(cNow) === asBig(epoch) ? cStartGuess : clock.startOf(cNow),
    ]);

    const bps = (v) => (Number(v) / 100).toFixed(2) + "%";
    const at = (ts) => asBig(ts) === 0n ? "Unavailable" : new Date(Number(ts) * 1000).toISOString().slice(0, 19).replace("T", " ") + "Z";
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
    put("th-until", hNow ? at(hUntil) : "Unavailable");
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
    put("pr-window", asBig(windowAt) === 0n ? "Unavailable" : at(windowAt));

    // Rulebook. `reconcile` is the getter that says whether the published fee
    // schedule still matches what the contracts charge.
    const noEdition = asBig(edition) === 0n;
    put("rb-edition", noEdition ? "none adopted" : shortId(edition), noEdition ? "v" : "v ok");
    put("rb-document", noEdition ? "Unavailable" : shortId(document_));
    put("rb-charges", noEdition && asBig(chargeCount) === 0n
        ? "no schedule published" : String(chargeCount));
    put("rb-take", (asBig(take) < 0n ? "-" : "") + formatHbar(asBig(take) < 0n ? -asBig(take) : asBig(take)) + " HBAR");
    put("rb-pending", asBig(pendEdEpoch) === 0n
        ? "no proposal"
        : shortId(pendEd) + " · adoptable in epoch " + pendEdEpoch);
    put("rb-window", asBig(rbWindow) === 0n ? "Unavailable" : at(rbWindow));
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

    await panels;
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

// The bond calendar and its payment rail. Contract terms are read live and the
// cash fee is read from the mirror node, where HTS keeps the authoritative fee
// schedule. The generated bundle carries the same values only as a consistency
// check performed at build time.
Venue.refreshCoupon = async function () {
    const el = $("coupon-out");
    if (!el) return;
    const {couponSchedule: schedule, couponDistributor: distributor, vault} = Venue.c;
    const bundled = CLIENT.coupon;
    if (!schedule || !distributor || !bundled) {
        el.innerHTML = '<div class="empty">No coupon payment rail is named in this address book.</div>';
        return;
    }

    const tokenId = bundled.cashToken.tokenId;
    const [issuedAt, count, spread, face, basis, root, dates, issuer, claimWindow,
        feeBps, committed, hss, scheduleGas, fundingPerCall, reserved, funded, token] =
        await Promise.all([
            schedule.issuedAt(), schedule.count(), schedule.spreadBps(),
            schedule.faceValue(), schedule.basis(), schedule.root(), schedule.dates(),
            distributor.issuer(), distributor.claimWindow(), distributor.payingAgentFeeBps(),
            distributor.committed(), vault.HSS(), vault.SCHEDULE_GAS_LIMIT(),
            vault.FUNDING_PER_CALL(), vault.reservedFunding(), vault.fundedFor(),
            Venue.mirror("/api/v1/tokens/" + encodeURIComponent(tokenId)),
        ]);

    const at = (ts) => new Date(Number(ts) * 1000).toISOString().slice(0, 10);
    const fee = token.custom_fees?.fractional_fees?.[0];
    const numerator = BigInt(fee?.amount?.numerator ?? 0);
    const denominator = BigInt(fee?.amount?.denominator ?? 1);
    const liveFeeBps = denominator ? numerator * 10_000n / denominator : 0n;
    const feeMatches = liveFeeBps === asBig(feeBps) && !fee?.net_of_transfers;
    const calendar = [...dates].map((dueAt, index) =>
        '<div class="rowline pset"><span>Coupon ' + index + "</span><span>" +
        esc(index === 0 ? at(issuedAt) : at(dates[index - 1])) + " to " +
        esc(at(dueAt)) + '</span><span class="mono">' + esc(String(dueAt)) +
        "</span></div>").join("");

    el.innerHTML = '<div class="cols"><section class="panel"><div class="top">' +
        '<h2>Fixed calendar</h2><span class="src">CouponSchedule</span></div><div class="body">' +
        '<ul class="readout">' +
        '<li><span class="k">address</span><span class="v"><a href="' +
        explorerAddr(CLIENT.addresses.CouponSchedule) + '" target="_blank" rel="noopener">' +
        esc(shortAddr(CLIENT.addresses.CouponSchedule)) + "</a></span></li>" +
        '<li><span class="k">root</span><span class="v">' + esc(shortId(root)) + "</span></li>" +
        '<li><span class="k">issuedAt</span><span class="v">' + esc(at(issuedAt)) + "</span></li>" +
        '<li><span class="k">coupons</span><span class="v">' + esc(String(count)) + "</span></li>" +
        '<li><span class="k">spread</span><span class="v">' + esc(String(spread)) + " bps</span></li>" +
        '<li><span class="k">faceValue</span><span class="v">' + esc(String(face)) +
        " cash units</span></li>" +
        '<li><span class="k">basis</span><span class="v">' +
        (Number(basis) === 1 ? "ACT/365" : esc(String(basis))) + "</span></li></ul>" +
        '<div class="rows">' + calendar + "</div></div></section>" +
        '<section class="panel"><div class="top"><h2>Payment rail</h2>' +
        '<span class="src">CouponDistributor and HTS</span></div><div class="body">' +
        '<ul class="readout">' +
        '<li><span class="k">distributor</span><span class="v"><a href="' +
        explorerAddr(CLIENT.addresses.CouponDistributor) + '" target="_blank" rel="noopener">' +
        esc(shortAddr(CLIENT.addresses.CouponDistributor)) + "</a></span></li>" +
        '<li><span class="k">issuer</span><span class="v">' + esc(shortAddr(issuer)) + "</span></li>" +
        '<li><span class="k">claimWindow</span><span class="v">' +
        esc(String(claimWindow)) + " s</span></li>" +
        '<li><span class="k">committed</span><span class="v">' +
        esc(String(committed)) + " smallest cash units</span></li>" +
        '<li><span class="k">cash</span><span class="v">' + esc(token.name) + " (" +
        esc(token.symbol) + ") · " + esc(token.token_id) + "</span></li>" +
        '<li><span class="k">decimals</span><span class="v">' + esc(String(token.decimals)) + "</span></li>" +
        '<li><span class="k">paying agent fee</span><span class="v ' +
        (feeMatches ? "ok" : "bad") + '">' + esc(String(liveFeeBps)) +
        " bps · inclusive · " + (feeMatches ? "matches tariff" : "MISMATCH") + "</span></li>" +
        '<li><span class="k">HSS</span><span class="v">' + esc(shortAddr(hss)) + "</span></li>" +
        '<li><span class="k">schedule gas</span><span class="v">' + esc(String(scheduleGas)) + "</span></li>" +
        '<li><span class="k">funding per call</span><span class="v">' +
        esc(formatHbar(asBig(fundingPerCall))) + " HBAR</span></li>" +
        '<li><span class="k">reserved</span><span class="v">' +
        esc(formatHbar(asBig(reserved))) + " HBAR</span></li>" +
        '<li><span class="k">additional calls funded</span><span class="v">' +
        esc(String(funded)) + "</span></li></ul></div></section></div>";
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
                "MatchingEngine", "SeamJournal", "RepoVault", "PrimeOracle",
                "ZkKycRegistry", "RegistrationGate", "CouponSchedule", "CouponDistributor"];
    Venue.paintTape("tape", await Venue.historyOf(names, {limit: 20}),
        "Read from the Hedera mirror node, not from eth_getLogs. Newest first.");
};

// ---------- the repo screen ----------

Venue.mountRepo = async function () {
    $("repo-go")?.addEventListener("click", () => Venue.doRepo().catch((e) => Venue.fail(e)));
    $("feed-refresh")?.addEventListener("click", () => Venue.refreshOracle().catch((e) => Venue.fail(e)));
    $("repo-id")?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") Venue.doRepo().catch((x) => Venue.fail(x));
    });
    $("repo-discover")?.addEventListener("click", () => Venue.discoverRepos().catch((e) => Venue.fail(e)));
    $("fin-id-new")?.addEventListener("click", () => {
        if ($("fin-id")) $("fin-id").value = ethers.hexlify(ethers.randomBytes(32));
        Venue.previewFinance().catch(() => {});
    });
    $("fin-id-copy")?.addEventListener("click", () => {
        Venue.copyFinanceId().catch((e) => Venue.fail(e));
    });
    for (const id of [
        "fin-id", "fin-borrower", "fin-lot", "fin-haircut", "fin-rate",
        "fin-maint", "fin-term", "fin-expiry",
    ]) {
        $(id)?.addEventListener("input", () => Venue.previewFinance().catch(() => {}));
    }
    $("fin-quote")?.addEventListener("click", () => Venue.previewFinance().catch((e) => Venue.fail(e)));
    $("fin-fund")?.addEventListener("click", () => Venue.doFundOffer().catch((e) => Venue.fail(e)));
    $("fin-accept")?.addEventListener("click", () => Venue.doAcceptOffer().catch((e) => Venue.fail(e)));
    $("fin-cancel")?.addEventListener("click", () => Venue.doCancelOffer().catch((e) => Venue.fail(e)));
    $("fin-withdraw")?.addEventListener("click", () => Venue.doVaultWithdraw().catch((e) => Venue.fail(e)));
    Venue.paintFinancingGate();
    await Venue.refreshVault();
    await Venue.refreshOracle().catch((e) => {
        const says = $("feed-says");
        if (says) {
            says.innerHTML = "This screen could not read the feed: " +
                esc(decodeRevert(e).message);
        }
    });
    await Venue.discoverRepos().catch(() => {});
};

Venue.copyFinanceId = async function () {
    const input = $("fin-id");
    const value = (input?.value || "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error("Create or enter a valid facility id before copying it.");
    }
    try {
        await navigator.clipboard.writeText(value);
    } catch {
        input.focus();
        input.select();
        if (!document.execCommand("copy")) {
            throw new Error("Could not copy the facility id.");
        }
    }
    const button = $("fin-id-copy");
    if (button) {
        button.textContent = "Copied";
        setTimeout(() => {
            if ($("fin-id-copy")) $("fin-id-copy").textContent = "Copy id";
        }, 1_200);
    }
};

Venue.paintFinancingGate = function () {
    const gate = $("fin-gate");
    const copy = $("fin-gate-copy");
    const wizard = $("fin-wizard");
    const ready = !!Venue.financing?.ready;
    if (gate) gate.hidden = ready;
    if (copy && !ready) {
        copy.textContent = Venue.financing?.reason ||
            "This bound vault predates funded offers. Financing writes stay unavailable.";
    }
    if (wizard) wizard.hidden = !ready;
    for (const id of ["fin-fund", "fin-accept", "fin-cancel", "fin-withdraw", "fin-quote"]) {
        const el = $(id);
        if (el && id !== "fin-quote") el.disabled = !ready;
        if (el && id === "fin-quote") el.disabled = !ready;
    }
};

function financeUint(id, label, {zero = false, max = null} = {}) {
    const raw = ($(id)?.value || "").trim();
    if (!/^\d+$/.test(raw)) throw new Error(label + " must be a whole number.");
    const value = BigInt(raw);
    if (!zero && value === 0n) throw new Error(label + " must be greater than zero.");
    if (max !== null && value > max) throw new Error(label + " is over " + max + ".");
    return value;
}

function financeId() {
    const id = ($("fin-id")?.value || "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(id)) {
        throw new Error("Facility id must be thirty-two bytes. Use New id.");
    }
    return id;
}

function financeAddress(id, label) {
    const value = ($(id)?.value || "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(value) || addrEq(value, ZERO)) {
        throw new Error(label + " must be a non-zero wallet address.");
    }
    return value;
}

Venue.financeDraft = function () {
    const id = financeId();
    const borrower = financeAddress("fin-borrower", "Borrower");
    const lot = financeUint("fin-lot", "Lot");
    const haircut = financeUint("fin-haircut", "Haircut", {zero: true, max: 9_999n});
    const rate = financeUint("fin-rate", "Repo rate", {zero: true, max: 10_000n});
    const maintenance =
        financeUint("fin-maint", "Maintenance", {zero: true, max: 65_535n});
    const days = financeUint("fin-term", "Term");
    const hours = financeUint("fin-expiry", "Offer life");
    const term = days * 86_400n;
    const expiresAt = nowSec() + hours * 3_600n;
    if (term > (1n << 64n) - 1n || expiresAt > (1n << 64n) - 1n) {
        throw new Error("Term or offer expiry is outside uint64.");
    }
    return {
        id,
        borrower,
        terms: {
            partition: CLIENT.immutables.partition,
            collateralAmount: lot,
            haircutBps: haircut,
            maintenanceBps: maintenance,
            repoRateBps: rate,
            term,
        },
        expiresAt,
        days,
        hours,
    };
};

function maturityRepayment(principal, rate, term) {
    const numerator = principal * rate * term;
    const denominator = 10_000n * 365n * 86_400n;
    const interest = numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
    return principal + interest;
}

function financeAt(ts) {
    return new Date(Number(ts) * 1000).toISOString().slice(0, 19).replace("T", " ") + "Z";
}

Venue.previewFinance = async function () {
    if (!Venue.financing?.ready) {
        throw new Error(Venue.financing?.reason || "Financing writes are unavailable.");
    }
    const out = $("fin-preview");
    let id;
    try {
        id = financeId();
    } catch (e) {
        if (out) out.innerHTML = '<div class="empty">' + esc(e.message) + "</div>";
        for (const id of ["fin-fund", "fin-accept", "fin-cancel"]) {
            if ($(id)) $(id).disabled = true;
        }
        return null;
    }

    const {vault, oracle, token, registry} = Venue.c;
    const [offer, state] = await Promise.all([
        vault.offers(id),
        vault.stateOf(id),
    ]);
    const hasOffer = !addrEq(offer.lender, ZERO);
    if (hasOffer && $("fin-borrower")) $("fin-borrower").value = offer.borrower;
    let draft;
    try {
        draft = hasOffer
            ? {
                id,
                borrower: offer.borrower,
                terms: offer.terms,
                expiresAt: asBig(offer.expiresAt),
                days: asBig(offer.terms.term) / 86_400n,
                hours: 0n,
            }
            : Venue.financeDraft();
    } catch (e) {
        if (out) out.innerHTML = '<div class="empty">' + esc(e.message) + "</div>";
        for (const id of ["fin-fund", "fin-accept", "fin-cancel"]) {
            if ($(id)) $(id).disabled = true;
        }
        return null;
    }

    let livePrincipal = null;
    let quoteError = "";
    try {
        livePrincipal = asBig(await vault.quotePrincipal(draft.terms));
    } catch (e) {
        quoteError = decodeRevert(e).name === "FeedIsDark"
            ? "Coverage cannot be evaluated because the feed is dark."
            : decodeRevert(e).message;
    }
    const principal = hasOffer ? asBig(offer.principal) : livePrincipal;
    const who = Venue.viewer();
    const collateralOwner = hasOffer ? offer.borrower : draft.borrower;
    const account = Venue.account;
    const lender = hasOffer ? offer.lender : account;
    const [markPerUnit, free, credit, allowance, borrowerKyc, lenderKyc] = await Promise.all([
        oracle.markPerUnitTinybar().catch(() => null),
        token.balanceOfByPartition(draft.terms.partition, collateralOwner).catch(() => null),
        who ? vault.credit(who) : null,
        typeof token.allowance === "function"
            ? token.allowance(collateralOwner, CLIENT.addresses.RepoVault).catch(() => null)
            : null,
        registry?.getKycStatus
            ? registry.getKycStatus(collateralOwner).catch(() => null)
            : null,
        lender && registry?.getKycStatus
            ? registry.getKycStatus(lender).catch(() => null)
            : null,
    ]);
    const isLender = !!account && hasOffer && addrEq(account, offer.lender);
    const isBorrower = !!account && hasOffer && addrEq(account, offer.borrower);
    const borrowerEligible = borrowerKyc !== null && Number(borrowerKyc) === 1;
    const lenderEligible = lenderKyc !== null && Number(lenderKyc) === 1;
    const expired = hasOffer && asBig(offer.expiresAt) <= nowSec();
    const freeText = free === null ? "unavailable" : String(free) + " LPRC";
    const lot = asBig(draft.terms.collateralAmount);
    const enoughCollateral = free !== null && asBig(free) >= lot;
    const enoughAllowance = allowance !== null && asBig(allowance) >= lot;
    const repriced = hasOffer && livePrincipal !== null && livePrincipal !== principal;
    const repay = principal === null
        ? null
        : maturityRepayment(principal, asBig(draft.terms.repoRateBps), asBig(draft.terms.term));
    const projectedMaturity = nowSec() + draft.terms.term;

    if (out) {
        out.innerHTML =
            (quoteError
                ? '<div class="banner warn"><p>' + esc(quoteError) + "</p></div>"
                : "") +
            '<ul class="readout">' +
            '<li><span class="k">live mark per bond</span><span class="v">' +
            (markPerUnit === null ? "Unavailable" : esc(formatHbar(asBig(markPerUnit))) + " HBAR") +
            "</span></li>" +
            '<li><span class="k">collateral lot</span><span class="v">' +
            esc(String(lot)) + " LPRC</span></li>" +
            '<li><span class="k">borrower</span><span class="v">' +
            esc(shortAddr(collateralOwner)) + "</span></li>" +
            '<li><span class="k">borrower eligibility</span><span class="v">' +
            (borrowerKyc === null ? "unavailable" : borrowerEligible ? "granted" : "not granted") +
            "</span></li>" +
            '<li><span class="k">lender eligibility</span><span class="v">' +
            (lenderKyc === null ? "unavailable" : lenderEligible ? "granted" : "not granted") +
            "</span></li>" +
            '<li><span class="k">free balance</span><span class="v">' +
            esc(freeText) + "</span></li>" +
            '<li><span class="k">collateral authorization</span><span class="v">' +
            (allowance === null
                ? "unavailable"
                : esc(String(allowance)) + " LPRC" +
                  (enoughAllowance ? " · ready" : " · approval required before acceptance")) +
            "</span></li>" +
            '<li><span class="k">principal</span><span class="v">' +
            (principal === null ? "Unavailable" : esc(formatHbar(principal)) + " HBAR") +
            "</span></li>" +
            (hasOffer
                ? '<li><span class="k">current live quote</span><span class="v">' +
                  (livePrincipal === null
                      ? "Unavailable"
                      : esc(formatHbar(livePrincipal)) + " HBAR" +
                        (repriced ? " · moved since funding" : " · still matches")) +
                  "</span></li>"
                : "") +
            '<li><span class="k">repayment at maturity</span><span class="v">' +
            (repay === null ? "Unavailable" : esc(formatHbar(repay)) + " HBAR") +
            "</span></li>" +
            '<li><span class="k">projected maturity</span><span class="v">' +
            esc(financeAt(projectedMaturity)) + "</span></li>" +
            '<li><span class="k">haircut</span><span class="v">' +
            esc(String(draft.terms.haircutBps)) + " bps</span></li>" +
            '<li><span class="k">repo rate</span><span class="v">' +
            esc(String(draft.terms.repoRateBps)) + " bps</span></li>" +
            '<li><span class="k">maintenance</span><span class="v">' +
            esc(String(draft.terms.maintenanceBps)) + " bps</span></li>" +
            '<li><span class="k">offer</span><span class="v">' +
            (hasOffer
                ? esc(shortAddr(offer.lender)) + " funded " +
                  esc(formatHbar(asBig(offer.principal))) + " HBAR until " +
                  esc(financeAt(offer.expiresAt)) + (expired ? " (expired)" : "")
                : "not funded") +
            "</span></li></ul>" +
            "<p class='note'>Review: the lender deposits exact principal for the named borrower. " +
            "The borrower may need a separate wallet signature to authorize the collateral lot. " +
            "Acceptance locks that lot. Withdraw " +
            "is a separate pull. Title stays with the borrower until default.</p>";
    }

    if ($("fin-fund")) {
        $("fin-fund").disabled =
            !account || addrEq(account, draft.borrower) || hasOffer || Number(state) !== 0 ||
            principal === null || principal === 0n || !borrowerEligible || !lenderEligible;
    }
    if ($("fin-accept")) {
        $("fin-accept").disabled =
            !isBorrower || expired || Number(state) !== 0 ||
            !borrowerEligible || !lenderEligible || !enoughCollateral ||
            livePrincipal === null || repriced;
        $("fin-accept").textContent = enoughAllowance
            ? "Accept and lock collateral (borrower)"
            : "Approve collateral, then accept (borrower)";
    }
    if ($("fin-cancel")) {
        $("fin-cancel").disabled = !isLender;
    }
    if ($("fin-withdraw")) {
        $("fin-withdraw").disabled = !account || asBig(credit ?? 0n) === 0n;
    }
    Venue.financePreview = {
        ...draft,
        principal,
        livePrincipal,
        hasOffer,
        borrowerEligible,
        lenderEligible,
    };
    return Venue.financePreview;
};

Venue.doFundOffer = async function () {
    await Venue.requireAccount();
    const draft = await Venue.previewFinance();
    if (!draft) throw new Error("A live quote is required before funding.");
    if (draft.hasOffer) throw new Error("This facility id already has a funded offer.");
    if (draft.principal === null) throw new Error("The live vault did not return a principal.");
    if (!draft.borrowerEligible || !draft.lenderEligible) {
        throw new Error("Both borrower and lender need current eligibility before funding.");
    }
    const value = toWeibar(draft.principal);
    const call = Venue.w.vault.fundOffer;
    await call.staticCall(draft.id, draft.borrower, draft.terms, draft.expiresAt, {value});
    const receipt = await Venue.send(
        call(
            draft.id,
            draft.borrower,
            draft.terms,
            draft.expiresAt,
            {value, gasLimit: 700_000},
        ),
        "fund offer",
    );
    if (!receipt) return;
    if ($("repo-id")) $("repo-id").value = draft.id;
    await Venue.noteReceipt(
        "offer funded", receipt, 14, G.PRED, T.IMM, "vault", "OfferFunded"
    ).catch(() => {});
    await Venue.previewFinance();
    await Venue.discoverRepos().catch(() => {});
};

Venue.ensureVaultAllowance = async function (amount) {
    await Venue.requireAccount();
    const token = Venue.c?.token;
    const writer = Venue.w?.token;
    const vaultAddress = CLIENT.addresses.RepoVault;
    if (
        !token || !writer || typeof token.allowance !== "function" ||
        typeof writer.approve !== "function"
    ) {
        throw new Error(
            "This client bundle cannot authorize ATS collateral. Regenerate the token ABI.",
        );
    }
    const required = asBig(amount);
    const current = asBig(await token.allowance(Venue.account, vaultAddress));
    if (current >= required) return false;

    const approve = writer.approve;
    await approve.staticCall(vaultAddress, required);
    const receipt = await Venue.send(
        approve(vaultAddress, required, {gasLimit: 350_000}),
        "authorize collateral",
    );
    if (!receipt) throw new Error("Collateral authorization was not confirmed.");

    const after = asBig(await token.allowance(Venue.account, vaultAddress));
    if (after < required) {
        throw new Error("ATS recorded less collateral authorization than this offer requires.");
    }
    return true;
};

Venue.doAcceptOffer = async function () {
    if (Venue.busy || Venue.repoActionPending) return;
    Venue.repoActionPending = true;
    try {
        await Venue.requireAccount();
        const id = financeId();
        const offer = await Venue.c.vault.offers(id);
        if (addrEq(offer.lender, ZERO)) throw new Error("This facility has no funded offer.");
        if (!addrEq(offer.borrower, Venue.account)) {
            throw new Error("Only the borrower named by the lender can accept this offer.");
        }
        if (asBig(offer.expiresAt) <= nowSec()) {
            throw new Error("This offer expired. The lender must cancel it and fund a new one.");
        }
        const [borrowerKyc, lenderKyc, livePrincipal, freeCollateral] = await Promise.all([
            Venue.c.registry.getKycStatus(offer.borrower),
            Venue.c.registry.getKycStatus(offer.lender),
            Venue.c.vault.quotePrincipal(offer.terms),
            Venue.c.token.balanceOfByPartition(offer.terms.partition, Venue.account),
        ]);
        if (Number(borrowerKyc) !== 1 || Number(lenderKyc) !== 1) {
            throw new Error(
                "Both borrower and lender need current eligibility before acceptance.",
            );
        }
        if (asBig(livePrincipal) !== asBig(offer.principal)) {
            throw new Error(
                "The live valuation moved since funding. The lender must cancel and reprice.",
            );
        }
        if (asBig(freeCollateral) < asBig(offer.terms.collateralAmount)) {
            throw new Error("The borrower does not have the required free collateral lot.");
        }
        await Venue.ensureVaultAllowance(offer.terms.collateralAmount);

        const call = Venue.w.vault.accept;
        await call.staticCall(id);
        const receipt = await Venue.send(
            call(id, {gasLimit: 1_500_000}),
            "accept financing",
        );
        if (!receipt) return;
        if ($("repo-id")) $("repo-id").value = id;
        await Venue.doRepo();
        await Venue.discoverRepos().catch(() => {});
        await Venue.noteReceipt(
            "financing accepted", receipt, 7, G.EXACT, T.IMM, "vault", "Opened"
        );
        if ($("fin-withdraw")) $("fin-withdraw").disabled = false;
    } finally {
        Venue.repoActionPending = false;
    }
};

Venue.doCancelOffer = async function () {
    await Venue.requireAccount();
    const id = financeId();
    const call = Venue.w.vault.cancelOffer;
    await call.staticCall(id);
    const receipt = await Venue.send(call(id, {gasLimit: 350_000}), "cancel offer");
    if (!receipt) return;
    await Venue.noteReceipt(
        "offer cancelled", receipt, 14, G.PRED, T.IMM, "vault", "OfferCancelled"
    ).catch(() => {});
    await Venue.previewFinance();
    if ($("fin-withdraw")) $("fin-withdraw").disabled = false;
};

Venue.paintOffer = function (id, offer) {
    const out = $("repo-out");
    if (!out) return;
    const terms = offer.terms;
    out.innerHTML =
        '<article class="card sealed"><div class="id">' + esc(shortId(id)) + "</div>" +
        "<div class='meta'>funded offer, not yet accepted</div></article>" +
        '<ul class="readout">' +
        '<li><span class="k">lender</span><span class="v">' +
        esc(shortAddr(offer.lender)) + "</span></li>" +
        '<li><span class="k">borrower</span><span class="v">' +
        esc(shortAddr(offer.borrower)) + "</span></li>" +
        '<li><span class="k">lot</span><span class="v">' +
        esc(String(terms.collateralAmount)) + " LPRC</span></li>" +
        '<li><span class="k">principal</span><span class="v">' +
        esc(formatHbar(asBig(offer.principal))) + " HBAR</span></li>" +
        '<li><span class="k">haircut</span><span class="v">' +
        esc(String(terms.haircutBps)) + " bps</span></li>" +
        '<li><span class="k">repo rate</span><span class="v">' +
        esc(String(terms.repoRateBps)) + " bps</span></li>" +
        '<li><span class="k">maintenance</span><span class="v">' +
        esc(String(terms.maintenanceBps)) + " bps</span></li>" +
        '<li><span class="k">expires</span><span class="v">' +
        esc(financeAt(offer.expiresAt)) + "</span></li></ul>" +
        "<p class='note'>Accept is the borrower signature. It creates the hold and " +
        "credits HBAR in one reverting transaction.</p>";

    const actions = document.createElement("div");
    actions.className = "rowbtns";
    if (Venue.account && addrEq(Venue.account, offer.borrower)
        && asBig(offer.expiresAt) > nowSec()) {
        const accept = document.createElement("button");
        accept.type = "button";
        accept.className = "primary";
        accept.textContent = "Accept and lock collateral";
        accept.addEventListener("click", () => {
            if ($("fin-id")) $("fin-id").value = id;
            Venue.doAcceptOffer().catch((e) => Venue.fail(e));
        });
        actions.appendChild(accept);
    }
    if (Venue.account && addrEq(Venue.account, offer.lender)) {
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "Cancel and credit lender";
        cancel.addEventListener("click", () => {
            if ($("fin-id")) $("fin-id").value = id;
            Venue.doCancelOffer().catch((e) => Venue.fail(e));
        });
        actions.appendChild(cancel);
    }
    out.appendChild(actions);
};

// ---------- the feed ----------
//
// Two legs, shown as two legs. A screen that collapsed them into one "price"
// would be unable to say which half went dark, and which half went dark is the
// only thing a reader can act on: our own panel going quiet is the venue's
// problem, and the upstream rate going quiet is not.
//
// Every figure here is read from the chain in this call. Nothing is taken from
// `client.json`, which carries the same numbers as of the run that generated it
// and is exactly the sort of thing that goes stale without saying so.
Venue.refreshOracle = async function () {
    const box = $("feed-box");
    if (!box) return;
    const {oracle, watch} = Venue.c;
    if (!oracle) {
        box.innerHTML = '<div class="empty">This address book carries no PrimeOracle. ' +
            "The venue is running on <code>RepoVault.postMark</code>, which is the " +
            "documented degradation and not a broken screen.</div>";
        return;
    }

    // One call for the composite, because MarginWatch already exists to answer
    // "can the thing beside this be believed" and the feed is the third such
    // question. The panel and the immutables come alongside it.
    const [f, panel, quorum, heartbeat, cashHeartbeat, dev, round] = await Promise.all([
        watch.feed(),
        oracle.publishers(),
        oracle.quorum(),
        oracle.heartbeat(),
        oracle.cashHeartbeat(),
        oracle.maxDeviationBps(),
        oracle.lastRound(),
    ]);

    const dark = f.dark;
    const age = asBig(f.publishedAt) > 0n ? nowSec() - asBig(f.publishedAt) : null;
    const put = (id, v, cls) => {
        const el = $(id);
        if (!el) return;
        el.innerHTML = v;
        if (cls !== undefined) el.className = "v " + cls;
    };

    put("feed-state", dark ? "dark" : "live", dark ? "v bad" : "v ok");
    put("feed-price", asBig(f.cleanPrice) === 0n ? "Unavailable"
        : esc(formatPrice(asBig(f.cleanPrice))) + " USD");
    put("feed-rate", asBig(f.cleanPrice) === 0n ? "Unavailable" : String(f.refRateBps) + " bps");
    put("feed-round", "round " + String(round) +
        (age === null ? "" : " · " + fmtRemain(Number(age)) + " ago"));
    put("feed-ourleg", f.ourLegDark ? "dark" : "live", f.ourLegDark ? "v bad" : "v ok");
    put("feed-cashleg", f.cashLegDark ? "dark" : "live", f.cashLegDark ? "v bad" : "v ok");
    put("feed-hbar", asBig(f.usdPerHbar) === 0n ? "Unavailable"
        : esc(formatPrice(asBig(f.usdPerHbar))) + " USD");
    put("feed-mark", asBig(f.markPerUnitTinybar) === 0n ? "Unavailable"
        : esc(formatHbar(asBig(f.markPerUnitTinybar))) + " HBAR");
    put("feed-quorum", quorum + " of " + panel.length + " seated");
    put("feed-heartbeat", heartbeat + " s · upstream " + cashHeartbeat + " s");
    put("feed-deviation", dev + " bps per round");
    put("feed-cashaddr", f.cashFeed && !addrEq(f.cashFeed, ZERO)
        ? '<a href="' + explorerAddr(f.cashFeed) + '" target="_blank" rel="noopener">' +
            esc(shortAddr(f.cashFeed)) + "</a>"
        : "not seated");

    const seats = $("feed-panel");
    if (seats) {
        seats.innerHTML = panel.length
            ? panel.map((a) => '<a class="quiet" href="' + explorerAddr(a) +
                '" target="_blank" rel="noopener">' + esc(shortAddr(a)) + "</a>").join("")
            : '<div class="empty">No publisher is seated.</div>';
    }

    // The sentence a reader actually needs, rather than eight fields they have
    // to assemble it from.
    const says = $("feed-says");
    if (says) {
        says.innerHTML = dark
            ? "The feed is dark, so <code>RepoVault.markToMarket</code> refuses and the " +
              "margin engine's manual <code>postMark</code> is open. " +
              (f.ourLegDark ? "The venue's own panel has not published inside its heartbeat. " : "") +
              (f.cashLegDark ? "The seated HBAR/USD feed is not answering. " : "")
            : "The feed is live, so <code>postMark</code> refuses and every mark comes " +
              "from this price. Anyone may call <code>markToMarket</code> on any open repo.";
    }

    box.hidden = false;
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
    put("rv-grace", fmtRemain(asBig(grace)));
    // RepoMath stores hundredths of a basis point per started 24-hour day.
    const dailyPenalty = asBig(penalty);
    put("rv-penalty", (dailyPenalty / 100n) + "." +
        String(dailyPenalty % 100n).padStart(2, "0") + " bps per day");
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
// repo lifecycle events. Scheduling events index an obligation id instead, and
// must not become phantom positions. The Position screen asks a trader to paste an id and
// never says where one comes from; this is where one comes from.
Venue.discoverRepos = async function () {
    const el = $("repo-known");
    if (!el) return;
    el.innerHTML = '<div class="empty">Reading the vault history…</div>';
    const logs = await Venue.history("RepoVault", {limit: 100});
    const seen = new Map();
    const repoEvents = new Set([
        "Opened", "OfferFunded", "OfferCancelled", "CollateralAdded",
        "MarkPosted", "MarginCalled", "Cured", "CouponObserved",
        "Failing", "Defaulted", "Closed",
    ]);
    for (const l of logs) {
        if (!repoEvents.has(l.name) || !l.args || !l.args.length) continue;
        const id = l.args[0];
        if (typeof id !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(id)) continue;
        if (!seen.has(id)) seen.set(id, {id, last: l.name, at: l.at, n: 0});
        seen.get(id).n += 1;
    }
    Venue.knownRepos = [...seen.values()];
    if (!Venue.knownRepos.length) {
        el.innerHTML = '<div class="empty">No repos found in the recent activity loaded. ' +
            "You can look up an older repo by its id below.</div>";
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

// RepoVault owns the repo id and term, while CouponSchedule owns only the
// instrument calendar. Read both to reconstruct the exact obligations created
// by `open`. A deployment from before ScheduledSettlement has no selectors for
// these reads; the caller catches that and says so instead of hiding the rest of
// the repo.
Venue.repoSchedules = async function (vault, id, repo) {
    const failId = await vault.failObligation(id);
    const calendarAddress = await vault.schedule();
    const calendar = new ethers.Contract(calendarAddress, ABI.CouponSchedule, Venue.reader);
    const count = Number(await calendar.count());
    const dates = await Promise.all(
        Array.from({length: count}, (_, index) => calendar.dateOf(index)),
    );
    const openedAt = asBig(repo.openedAt);
    const maturity = asBig(repo.maturity);
    const inside = dates
        .map((dueAt, index) => ({dueAt: asBig(dueAt), index}))
        .filter(({dueAt}) => dueAt >= openedAt && dueAt <= maturity);
    const ids = [failId, ...await Promise.all(
        inside.map(({index}) => vault.couponObligation(id, index)),
    )];
    const obligations = await Promise.all(ids.map((obligationId) => vault.obligation(obligationId)));
    const funded = await Promise.all(obligations.map((o, index) =>
        Number(o.status) === 1 && !addrEq(o.scheduleAddress, ZERO)
            ? vault["fundedFor(bytes32)"](ids[index]).catch(() => false)
            : false,
    ));
    return obligations.map((obligation, index) => ({
        id: ids[index],
        label: index === 0 ? "maturity fail" : "coupon " + inside[index - 1].index,
        obligation,
        funded: Boolean(funded[index]),
    }));
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
        if (Venue.financing?.ready && typeof vault.offers === "function") {
            const offer = await vault.offers(id).catch(() => null);
            if (offer && !addrEq(offer.lender, ZERO)) {
                Venue.paintOffer(id, offer);
                return;
            }
        }
        out.innerHTML = '<div class="empty">The vault has no facility under that id.</div>';
        return;
    }
    let borrowerEligibility = null;
    let lenderEligibility = null;
    try {
        [borrowerEligibility, lenderEligibility] = await Promise.all([
            Venue.c.registry.getKycStatus(r.borrower),
            Venue.c.registry.getKycStatus(r.lender),
        ]);
    } catch (_) {
        // The contract treats an unreadable registry as ineligible. Keep the
        // position readable and render the same operational conclusion.
    }
    const borrowerEligible = Number(borrowerEligibility) === 1;
    const lenderEligible = Number(lenderEligibility) === 1;
    // repurchasePriceNow and settlementPenaltyNow are the two figures that move
    // with the clock, so they are read now rather than derived from openedAt.
    //
    // previewMark is the third and it is the one worth having: it says what
    // `markToMarket` would find without sending anything, so a borrower can see
    // a margin call coming rather than reading about it afterwards. It is a
    // view and it is total, so a dark feed renders as a dark feed instead of
    // taking this panel down.
    const [price, exposure, penalty, sub, mk, schedules] = await Promise.all([
        vault.repurchasePriceNow(id).catch(() => null),
        vault.exposureNow(id).catch(() => null),
        vault.settlementPenaltyNow(id).catch(() => null),
        vault.substitute(id).catch(() => null),
        vault.previewMark(id).catch(() => null),
        Venue.repoSchedules(vault, id, r).catch(() => null),
    ]);
    const at = (ts) => asBig(ts) === 0n ? "Unavailable"
        : new Date(Number(ts) * 1000).toISOString().slice(0, 19).replace("T", " ") + "Z";
    const st = REPO_STATE[Number(state)] || String(state);
    const li = (k, v) => '<li><span class="k">' + esc(k) + '</span><span class="v">' + v + "</span></li>";
    out.innerHTML =
        '<div class="card ' + (Number(state) >= 5 ? "dead" : Number(state) === 3 ? "sealed" : "open") + '">' +
        '<div class="id">' + esc(shortId(id)) + "</div>" +
        "<div class='meta'>state <b>" + esc(st) + "</b>" +
        (alert.called ? " · under a margin call" : "") +
        (alert.cureExpired ? " · cure window expired" : "") +
        (alert.unmarkedFail ? " · unmarked fail" : "") +
        (alert.defaultable ? " · defaultable" : "") + "</div></div>" +
        '<ul class="readout">' +
        li("borrower", esc(shortAddr(r.borrower))) +
        li("borrower eligibility", borrowerEligible
            ? '<b class="ok">current</b>'
            : '<b class="bad">renew before adding collateral</b>') +
        li("lender", esc(shortAddr(r.lender))) +
        li("lender eligibility", lenderEligible
            ? '<b class="ok">current</b>'
            : '<b class="bad">renew before default recovery</b>') +
        li("collateral", esc(String(r.collateralAmount)) + " LPRC locked") +
        li("principal", esc(formatHbar(asBig(r.principal))) + " HBAR") +
        li("repo rate", esc(String(r.repoRateBps)) + " bps") +
        li("maintenance", esc(String(r.maintenanceBps)) + " bps") +
        li("opened", esc(at(r.openedAt))) +
        li("maturity", esc(at(r.maturity))) +
        li("cure deadline", esc(at(r.cureDeadline))) +
        li("margin exposure now", exposure === null
            ? "<i>not answerable in this state</i>"
            : esc(formatHbar(asBig(exposure))) + " HBAR") +
        li("repayment due now", price === null
            ? "<i>not answerable in this state</i>"
            : esc(formatHbar(asBig(price))) + " HBAR") +
        li("settlement penalty now", penalty === null
            ? "<i>not answerable in this state</i>"
            : esc(formatHbar(asBig(penalty))) + " HBAR") +
        li("mark now", mk === null ? "<i>valuation unavailable in this state</i>"
            : mk.dark ? "<i>the feed is dark, so nothing is marked</i>"
                : esc(formatHbar(asBig(mk.mark))) + " HBAR" +
                  (mk.breach
                      ? ' <b class="v bad">short of the maintenance margin</b>'
                      : ' <b class="v ok">covered</b>')) +
        li("mark commitment", asBig(r.markCommitment) === 0n
            ? "No manual valuation posted"
            : esc(shortId(r.markCommitment)) + " · posted by hand while the feed was dark") +
        li("latest coupon observation", asBig(r.lastCouponCommitment) === 0n
            ? "none observed" : esc(shortId(r.lastCouponCommitment))) +
        li("substitute", sub === null || addrEq(sub, ZERO)
            ? "Collateral substitution is not supported"
            : esc(String(sub))) +
        "</ul>" +
        '<div class="shead" style="margin-top:1.35rem"><h3>Native settlements</h3>' +
        '<span class="src">HIP-1215 · 0x16b</span></div>' +
        (schedules === null
            ? '<p class="note">This deployed vault predates native settlement obligations.</p>'
            : '<ul class="readout">' + schedules.map(({id: obligationId, label, obligation, funded}) => {
                const status = ["unknown", "pending", "running", "settled"][Number(obligation.status)]
                    || String(obligation.status);
                const hasNative = !addrEq(obligation.scheduleAddress, ZERO);
                const route = status === "settled"
                    ? "settled"
                    : hasNative
                        ? (funded ? "scheduled and funded" : "scheduled, reserve is short")
                        : "manual fallback after due time";
                const scheduleLink = hasNative
                    ? ' · <a href="' + esc(explorerAddr(obligation.scheduleAddress)) +
                      '" target="_blank" rel="noopener">' + esc(shortAddr(obligation.scheduleAddress)) + "</a>"
                    : "";
                return li(
                    label,
                    esc(at(obligation.dueAt)) + " · " + esc(route) + scheduleLink +
                    ' <span class="meta">' + esc(shortId(obligationId)) + "</span>",
                );
            }).join("") + "</ul>");

    const actions = document.createElement("div");
    actions.className = "rowbtns";
    const addAction = (label, method, reference) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", async () => {
            button.disabled = true;
            try { await Venue.doRepoAction(method, reference, label); }
            catch (e) { Venue.fail(e); }
            finally { button.disabled = false; }
        });
        actions.appendChild(button);
    };
    if ([2, 3].includes(Number(state)) && mk && !mk.dark) {
        addAction(mk.breach ? "Record margin shortfall" : "Check margin on-chain", "markToMarket", id);
    }
    if (Venue.financing?.ready) {
        const who = (Venue.account || "").toLowerCase();
        const borrower = String(r.borrower).toLowerCase() === who;
        if (borrower && [2, 3, 5].includes(Number(state)) && price !== null) {
            const due = asBig(price) + asBig(penalty ?? 0n);
            const repay = document.createElement("button");
            repay.type = "button";
            repay.className = "primary";
            repay.textContent = "Repay " + formatHbar(due) + " HBAR and release";
            repay.addEventListener("click", async () => {
                repay.disabled = true;
                try { await Venue.closeFacility(id); }
                catch (e) { Venue.fail(e); }
                finally { repay.disabled = false; }
            });
            actions.appendChild(repay);
        }
        const cureOpen = Number(state) !== 3 || !alert.cureExpired;
        if (borrower && [2, 3].includes(Number(state)) && cureOpen) {
            const wrap = document.createElement("span");
            wrap.style.display = "inline-flex";
            wrap.style.gap = ".4rem";
            wrap.style.alignItems = "center";
            const extra = document.createElement("input");
            extra.id = "fin-add-lot";
            extra.inputMode = "numeric";
            extra.placeholder = "extra LPRC";
            extra.style.minWidth = "8rem";
            extra.style.minHeight = "44px";
            const add = document.createElement("button");
            add.type = "button";
            add.disabled = !borrowerEligible;
            add.textContent = borrowerEligible
                ? "Add collateral"
                : "Renew eligibility to add collateral";
            add.addEventListener("click", async () => {
                add.disabled = true;
                try { await Venue.addFacilityCollateral(id, extra.value); }
                catch (e) { Venue.fail(e); }
                finally { add.disabled = false; }
            });
            wrap.append(extra, add);
            actions.appendChild(wrap);
        }
        if (Number(state) === 3 && !alert.cureExpired && mk && !mk.dark && !mk.breach) {
            const cure = document.createElement("button");
            cure.type = "button";
            cure.textContent = "Cure (feed shows coverage)";
            cure.addEventListener("click", async () => {
                cure.disabled = true;
                try { await Venue.cureFacility(id); }
                catch (e) { Venue.fail(e); }
                finally { cure.disabled = false; }
            });
            actions.appendChild(cure);
        }
        if (alert.defaultable && [3, 5].includes(Number(state))) {
            const def = document.createElement("button");
            def.type = "button";
            def.textContent = "Declare default";
            def.addEventListener("click", async () => {
                def.disabled = true;
                try { await Venue.declareFacilityDefault(id); }
                catch (e) { Venue.fail(e); }
                finally { def.disabled = false; }
            });
            actions.appendChild(def);
        }
        if (Number(state) === 6) {
            const execute = document.createElement("button");
            execute.type = "button";
            execute.disabled = !lenderEligible;
            execute.textContent = lenderEligible
                ? "Execute collateral to lender"
                : "Lender must renew eligibility";
            execute.addEventListener("click", async () => {
                execute.disabled = true;
                try { await Venue.settleFacilityDefault(id); }
                catch (e) { Venue.fail(e); }
                finally { execute.disabled = false; }
            });
            actions.appendChild(execute);
        }
    }
    for (const entry of schedules || []) {
        if (Number(entry.obligation.status) === 1 && asBig(entry.obligation.dueAt) <= nowSec()) {
            addAction("Process " + entry.label, "settle", entry.id);
        }
    }
    out.appendChild(actions);

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
    // The quote and the retained fees are facts about the round, not about the
    // book, so an empty book is no reason to stop saying them. An earlier cut
    // returned here and left both blank whenever nothing was resting.
    //
    // How many orders are live is itself a read, and until it lands there is
    // nothing to ask `liveAt` for. So the count from the last tick is asked for
    // again alongside it: a book that has not changed since the previous refresh
    // costs one round trip instead of two, and a book that has grown pays for
    // the difference only.
    // A speculative index the book has since dropped reverts, which is an answer
    // and not a failure, so it is caught and read again below rather than taking
    // the refresh down with it.
    const guess = Math.min(Venue._revealed || 0, 40);
    const [count, , ...seen] = await Promise.all([
        engine.revealedCount(),
        Venue.paintQuote(round),
        ...Array.from({length: guess}, (_, i) => engine.liveAt(i).catch(() => null)),
    ]);
    const n = Number(count);
    Venue._revealed = n;
    if (!n) {
        el.innerHTML = '<div class="empty">Nothing revealed. A sealed commitment is not in the book ' +
            "until it is opened, which is the point.</div>";
        return;
    }
    const capN = Math.min(n, 40);
    const ids = seen.slice(0, capN);
    const gaps = [];
    for (let i = 0; i < capN; i++) if (ids[i] == null) gaps.push(i);
    if (gaps.length) {
        const again = await Promise.all(gaps.map((i) => engine.liveAt(i)));
        gaps.forEach((i, k) => { ids[i] = again[k]; });
    }
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
            '<span class="mono">' + esc(String(o.firstRound)) + " to " + esc(String(o.lastRound)) + "</span>" +
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
                ? "Round " + prev + " would cross " + volume + " bonds at " +
                  (asBig(priceTwice) / 2n) + " tinybar per bond (priceTwice " + priceTwice + ")."
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
    const [name, symbol, supply, multi, lists, comp, whole, inPart] = await Promise.all([
        token.name(), token.symbol(), token.totalSupply(),
        token.isMultiPartition(), token.getExternalKycListsCount(), token.compliance(),
        who ? token.balanceOf(who) : null,
        who ? token.balanceOfByPartition(part, who) : null,
    ]);
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
    put("iss-name", name);
    put("iss-symbol", symbol);
    const issAddr = $("iss-addr");
    if (issAddr) {
        issAddr.innerHTML = '<a href="' + esc(explorerAddr(CLIENT.addresses.token)) +
            '" target="_blank" rel="noopener">' + esc(shortAddr(CLIENT.addresses.token)) + "</a>";
    }
    put("iss-paused", "No issuer writes exposed. Venue halt and compliance reads follow below.");
};

// ---------- the gate's own governance, for the prove screen ----------
//
// A grant dies at the KYC epoch boundary with nothing on chain warning anyone.
// The screen already counts that down. What it never showed is that the policy
// the gate enforces is itself under a proposal window, and that the registry can
// be pointed at a different gate entirely.
Venue.refreshGateGov = async function () {
    const {gate, registry} = Venue.c;
    // The gate's five and the registry's five are two contracts, not two waves.
    const [issuer, verifier, pMinTier, pMask, pEpoch,
           admin, pendingGate, pendingGateEpoch, epochLen, epochZero] = await Promise.all([
        gate.issuer(), gate.verifier(), gate.pendingMinTier(),
        gate.pendingJurisdictionMask(), gate.pendingPolicyEpoch(),
        registry.admin(), registry.pendingGate(), registry.pendingGateEpoch(),
        registry.epochLength(), registry.epochZero(),
    ]);
    const put = (id, v, cls) => {
        const el = $(id);
        if (!el) return;
        el.textContent = v;
        if (cls !== undefined) el.className = "v " + cls;
    };
    put("gv-issuer", issuer);
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
    // The masthead read this in the same tick and it is the same getter, so
    // asking again would be a round trip spent on an answer already in hand.
    const cur = Venue.snap.kycEpoch ?? asBig(await registry.currentEpoch());
    const next = Venue.snap.kycEpoch !== undefined && Venue.snap.nextRoot !== undefined
        ? asBig(Venue.snap.nextRoot)
        : asBig(await gate.rootForEpoch(cur + 1n).catch(() => 0n));
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
    // How many keys there are is itself a read, and `keyAt` cannot be asked
    // until it lands. The count from the last refresh goes out alongside it, so
    // a set that has not been governed since costs one round trip fewer. An
    // index the set no longer has reverts, which is caught and read again.
    const guess = Math.min(Venue._keyCount || 0, 64);
    const [n, rowCard, waivedKey, ...seen] = await Promise.all([
        policy.keyCount(), policy.ROW_CARD(), policy.KEY_WAIVED_ROWS(),
        ...Array.from({length: guess}, (_, i) => policy.keyAt(i).catch(() => null)),
    ]);
    const count = Math.min(Number(n), 64);
    Venue._keyCount = Number(n);
    const keys = seen.slice(0, count);
    const gaps = [];
    for (let i = 0; i < count; i++) if (keys[i] == null) gaps.push(i);
    if (gaps.length) {
        const again = await Promise.all(gaps.map((i) => policy.keyAt(i)));
        gaps.forEach((i, k) => { keys[i] = again[k]; });
    }
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
        if (!Number.isSafeInteger(k)) return "Unavailable";
        if (k < card) return "row " + k + " ceiling" + (ROW_NAMES[k] ? " · " + ROW_NAMES[k] : "");
        if (k < 2 * card) return "row " + (k - card) + " floor";
        if (k < 3 * card) return "row " + (k - 2 * card) + " budget";
        return "Unavailable";
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
    // `minimumCancelFee` takes three of the immutables this panel is already
    // reading. Awaiting them inside the argument list read each one a second
    // time and, worse, suspended the array literal they sat in: the twelve
    // reads either side of it went out in five waves instead of one. They are
    // read once, and the fee is derived from what came back.
    const [bond, fee, delay, window_, len, rest, gen, part, dom, uses, tier, mask] =
        await Promise.all([
            engine.commitBond(), engine.cancelFee(), engine.revealDelay(),
            engine.revealWindow(), engine.roundLength(), engine.restRounds(),
            engine.genesis(), engine.partition(), engine.DOMAIN_ORDER(),
            registry.MAX_USES_PER_EPOCH(), gate.minTier(), gate.jurisdictionMask(),
        ]);
    const minFee = await engine.minimumCancelFee(bond, delay, window_);
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

Venue.doFinanceWrite = async function (method, args, label, valueTinybar) {
    if (!Venue.financing?.ready) {
        throw new Error(Venue.financing?.reason || "Financing writes are unavailable.");
    }
    const allowed =
        ["close", "addCollateral", "cure", "declareDefault", "settleDefault"];
    if (!allowed.includes(method)) throw new Error("Unsupported financing action.");
    if (Venue.busy || Venue.repoActionPending) return;
    Venue.repoActionPending = true;
    try {
        await Venue.requireAccount();
        const call = Venue.w.vault[method];
        if (typeof call !== "function") throw new Error("This ABI has no " + method + ".");
        const opts = valueTinybar != null ? {value: toWeibar(asBig(valueTinybar))} : undefined;
        if (opts) {
            await call.staticCall(...args, opts);
            const receipt = await Venue.send(call(...args, opts), label);
            if (receipt) await Venue.afterFinance(method);
        } else {
            await call.staticCall(...args);
            const receipt = await Venue.send(call(...args), label);
            if (receipt) await Venue.afterFinance(method);
        }
    } finally {
        Venue.repoActionPending = false;
    }
};

Venue.afterFinance = async function (method) {
    const eventName = {
        close: "Closed",
        addCollateral: "CollateralAdded",
        cure: "Cured",
        declareDefault: "Defaulted",
        settleDefault: "Closed",
    }[method];
    if (
        eventName
    ) {
        await Venue.noteReceipt(
            method, Venue.lastReceipt, 14, G.PRED, T.IMM, "vault", eventName
        ).catch(() => {});
    }
    await Venue.doRepo().catch(() => {});
    await Venue.discoverRepos().catch(() => {});
    await Venue.refreshPosition?.().catch(() => {});
};

Venue.closeFacility = async function (id) {
    const [repo, price, penalty] = await Promise.all([
        Venue.c.vault.repo(id),
        Venue.c.vault.repurchasePriceNow(id),
        Venue.c.vault.settlementPenaltyNow(id),
    ]);
    const horizon = 60n;
    const denominator = 10_000n * 365n * 86_400n;
    const numerator = asBig(repo.principal) * asBig(repo.repoRateBps) * horizon;
    const buffer = (numerator + denominator - 1n) / denominator + 1n;
    await Venue.doFinanceWrite(
        "close",
        [id],
        "Repay and release",
        asBig(price) + asBig(penalty) + buffer,
    );
};

Venue.addFacilityCollateral = async function (id, raw) {
    const amount = BigInt((raw || "").trim() || "0");
    if (amount <= 0n) throw new Error("Add a positive lot of LPRC.");
    await Venue.requireAccount();
    if (Number(await Venue.c.registry.getKycStatus(Venue.account)) !== 1) {
        throw new Error("Renew borrower eligibility before adding collateral.");
    }
    await Venue.ensureVaultAllowance(amount);
    await Venue.doFinanceWrite("addCollateral", [id, amount], "Add collateral");
};

Venue.cureFacility = async function (id) {
    await Venue.doFinanceWrite("cure", [id], "Cure");
};

Venue.declareFacilityDefault = async function (id) {
    await Venue.doFinanceWrite("declareDefault", [id], "Declare default");
};

Venue.settleFacilityDefault = async function (id) {
    const repo = await Venue.c.vault.repo(id);
    if (Number(await Venue.c.registry.getKycStatus(repo.lender)) !== 1) {
        throw new Error(
            "The lender must renew eligibility before ATS can deliver defaulted collateral.",
        );
    }
    await Venue.doFinanceWrite("settleDefault", [id], "Execute default to lender");
};

// Only supported permissionless lifecycle operations are exposed here.
Venue.doRepoAction = async function (method, id, label) {
    if (!["markToMarket", "settle"].includes(method)) throw new Error("Unsupported repo action.");
    if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new Error("Invalid repo reference.");
    if (Venue.busy || Venue.repoActionPending) return;
    Venue.repoActionPending = true;
    try {
        await Venue.requireAccount();
        const call = Venue.w.vault[method];
        await call.staticCall(id);
        const receipt = await Venue.send(call(id), label);
        if (receipt) await Venue.doRepo();
    } finally {
        Venue.repoActionPending = false;
    }
};
