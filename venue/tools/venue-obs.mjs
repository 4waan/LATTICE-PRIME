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
    if (String(name).toLowerCase() === "side") {
        if (asBig(value) === 0n) return "Buy";
        if (asBig(value) === 1n) return "Sell";
        return "Unavailable";
    }
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
        return '<details class="iss-tape-row' + (e.fragment ? "" : " unknown") + '">' +
            "<summary><div class='iss-tape-main'>" +
            '<span class="iss-tape-name">' + esc(e.name) + "</span>" +
            '<span class="iss-tape-src">' + esc(e.source) + "</span></div>" +
            "<div class='iss-tape-meta'>" + esc(when) + " · <a href='" + esc(explorerTx(e.tx)) +
            "' target='_blank' rel='noopener noreferrer'>" + esc(shortId(e.tx)) + "</a></div></summary>" +
            '<div class="iss-tape-args">' + args + "</div></details>";
    }).join("") + (note ? '<p class="note">' + esc(note) + "</p>" : "");
};

// ---------- the venue screen ----------

Venue.mountVenue = async function () {
    Venue.bindIssuerChrome?.();
    // Legacy listeners remain available when issuer chrome is absent.
    if (!Venue._issuerChromeBound) {
        $("tape-reload")?.addEventListener("click", () => Venue.refreshTape().catch((e) => Venue.fail(e)));
        $("param-row")?.addEventListener("change", () => Venue.refreshParamRow().catch((e) => Venue.fail(e)));
        $("journal-go")?.addEventListener("click", () => Venue.doExplain().catch((e) => Venue.fail(e)));
        $("disclose-go")?.addEventListener("click", () => Venue.doDisclose().catch((e) => Venue.fail(e)));
    }
    await Promise.all([
        Venue.refreshVenue(),
        Venue.refreshInstrument(),
    ]);
    // Mirror Node tape and HCS evidence load lazily from the Activity drawer.
    // `tools/hcs-view.mjs` is inlined only into this screen, so a build without
    // it still mounts the rest of the Rulebook rather than throwing at boot.
    if (Venue.mountTopic) await Venue.mountTopic({lazy: true}).catch((e) => Venue.fail(e));
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
    let readError = null;
    let batch;
    try {
        batch = await Promise.all([
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
    } catch (e) {
        readError = e?.message || String(e);
        Venue.setIssuerUi?.({errors: {...(Venue.issuerUiState?.().errors || {}), core: readError}});
        Venue.issuerCore = {
            ...(Venue.issuerCore || {}),
            readError,
        };
        Venue.renderIssuerOverview?.();
        throw e;
    }

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
    ] = batch;

    // Core status needs immutables and coupon readiness. Full parameter tables,
    // fee charge lists, and calendars stay lazy until a detail panel opens.
    const loaded = Venue.issuerUiState?.().loaded || {};
    const panels = Promise.all([
        Venue.refreshImmutables().catch((e) => {
            readError = readError || (e?.message || String(e));
        }),
        Venue.refreshCoupon().catch((e) => {
            readError = readError || (e?.message || String(e));
        }),
        Venue.refreshInstrument().catch(() => {}),
        loaded.fees ? Venue.refreshCharges(Number(chargeCount)) : Promise.resolve(),
        loaded["param-keys"] ? Venue.refreshParamSet() : Promise.resolve(),
        loaded["param-row"] ? Venue.refreshParamRow() : Promise.resolve(),
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

    const imm = Venue.issuerImmutables || {};
    const coupon = Venue.issuerCoupon || null;
    const latestClosed = asBig(cNow) > 0n ? asBig(cNow) - 1n : 0n;
    Venue.issuerCore = {
        readError,
        halted: !!hNow,
        haltUntilText: hNow ? at(hUntil) : "Unavailable",
        haltBudgetText: remaining + " / " + budgetS + " s",
        capSuspended: !!suspended,
        capText: bps(capBps),
        shareText: bps(shareBps),
        permits: !!rPermits,
        currentHex: "0x" + Number(rCur).toString(16),
        floorHex: "0x" + Number(rFloor).toString(16),
        ceilingHex: "0x" + Number(rCeil).toString(16),
        regimePending: asBig(rPendingEpoch) !== 0n || asBig(rRelaxEpoch) !== 0n || asBig(rLowerEpoch) !== 0n,
        paramPending: asBig(pendingEpoch) !== 0n,
        rulebookPending: asBig(pendEdEpoch) !== 0n,
        rootShort: shortId(root),
        prevRootShort: asBig(prevRoot) === 0n ? "none" : shortId(prevRoot),
        keyCount: Number(keyCount),
        paramPendingText: asBig(pendingEpoch) === 0n
            ? "no proposal"
            : shortId(pendingRoot) + " · adoptable in epoch " + pendingEpoch,
        windowText: asBig(windowAt) === 0n ? "Unavailable" : at(windowAt),
        grace: String(grace),
        feeChecked: true,
        noEdition,
        feeMismatch: !rec[0],
        reconcileText: !rec[0]
            ? "Mismatch"
            : noEdition ? "Not applicable" : "Reconciled",
        editionText: noEdition ? "none adopted" : shortId(edition),
        chargeCount: Number(chargeCount),
        chargeCountText: noEdition && asBig(chargeCount) === 0n
            ? "no schedule published" : String(chargeCount),
        immChecked: !!imm.checked,
        immDrift: Number(imm.drifted || 0),
        immTotal: Number(imm.total || 12),
        minFeeText: imm.minFeeText || "",
        coupon,
        epochNow: String(cNow),
        latestClosed: String(latestClosed),
        spentText: jSpent + (Number(jRow[3]) ? " / " + jRow[3] + " bits" : " bits"),
        epochActivity: jRecord.transfers + " transfers · " + jRecord.issues + " issues · " +
            jRecord.redemptions + " redemptions",
        registryText: addrEq(jRegistry, CLIENT.addresses.ZkKycRegistry)
            ? "ZkKycRegistry" : shortAddr(jRegistry),
        journalDisagree: !!(Venue.issuerCore && Venue.issuerCore.journalDisagree),
        tokenName: Venue.instrument?.name || null,
        tokenSymbol: Venue.instrument?.symbol || null,
    };
    Venue.setIssuerUi?.({
        lastRefreshAt: Date.now(),
        coreStale: false,
        loaded: {
            ...(Venue.issuerUiState?.().loaded || {}),
            immutables: true,
            coupon: true,
        },
    });
    Venue.renderIssuerOverview?.();
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
    const {couponSchedule: schedule, couponDistributor: distributor, vault} = Venue.c;
    const bundled = CLIENT.coupon;
    if (!schedule || !distributor || !bundled) {
        Venue.issuerCoupon = {missing: true};
        const el = $("coupon-out");
        if (el) el.innerHTML = '<div class="empty">No coupon payment rail is named in this address book.</div>';
        Venue.paintIssuerPaymentsSummary?.(Venue.issuerCoupon);
        return Venue.issuerCoupon;
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
    const now = Number(nowSec());
    const upcoming = [];
    const calendarRows = [];
    [...dates].forEach((dueAt, index) => {
        const due = Number(dueAt);
        const label = (index === 0 ? at(issuedAt) : at(dates[index - 1])) + " to " + at(dueAt);
        calendarRows.push({index, label, dueAt: String(dueAt)});
        if (due >= now) upcoming.push({index, label, dueAt: String(dueAt), due});
    });
    const next = upcoming[0] || null;
    const remainText = next
        ? fmtRemain(BigInt(Math.max(0, next.due - now)))
        : "No future coupon";
    const underfunded = asBig(funded) <= 0n || asBig(reserved) < asBig(fundingPerCall);
    const calendarHtml = calendarRows.map((row) =>
        '<div class="rowline pset"><span>Coupon ' + row.index + "</span><span>" +
        esc(row.label) + '</span><span class="mono">' + esc(row.dueAt) +
        "</span></div>").join("");

    Venue.issuerCoupon = {
        missing: false,
        issuedAt: at(issuedAt),
        count: Number(count),
        spread: String(spread),
        face: String(face),
        basisText: Number(basis) === 1 ? "ACT/365" : String(basis),
        root: shortId(root),
        nextDate: next ? at(next.dueAt) : (calendarRows.length ? at(dates[dates.length - 1]) : "Unavailable"),
        remainText,
        upcoming,
        calendarHtml,
        cashText: token.name + " (" + token.symbol + ") · " + token.token_id,
        liveFeeBps: String(liveFeeBps),
        feeMismatch: !feeMatches,
        reservedText: formatHbar(asBig(reserved)) + " HBAR",
        fundingText: formatHbar(asBig(fundingPerCall)) + " HBAR",
        funded: String(funded),
        underfunded,
        detail: {
            issuedAt, count, spread, face, basis, root, dates, issuer, claimWindow,
            feeBps, committed, hss, scheduleGas, fundingPerCall, reserved, funded, token,
            liveFeeBps, feeMatches,
        },
    };
    Venue.paintIssuerPaymentsSummary?.(Venue.issuerCoupon);
    Venue.paintCouponDetail(Venue.issuerCoupon);
    const cal = $("coupon-calendar");
    if (cal) cal.innerHTML = calendarHtml || '<div class="empty">No coupon periods.</div>';
    return Venue.issuerCoupon;
};

Venue.paintCouponDetail = function (coupon) {
    const el = $("coupon-out");
    if (!el) return;
    if (!coupon || coupon.missing) {
        el.innerHTML = '<div class="empty">No coupon payment rail is named in this address book.</div>';
        return;
    }
    const d = coupon.detail;
    const at = (ts) => new Date(Number(ts) * 1000).toISOString().slice(0, 10);
    const calendar = [...d.dates].map((dueAt, index) =>
        '<div class="rowline pset"><span>Coupon ' + index + "</span><span>" +
        esc(index === 0 ? at(d.issuedAt) : at(d.dates[index - 1])) + " to " +
        esc(at(dueAt)) + '</span><span class="mono">' + esc(String(dueAt)) +
        "</span></div>").join("");

    el.innerHTML = '<div class="cols"><section class="panel"><div class="top">' +
        '<h2>Fixed calendar</h2><span class="src">CouponSchedule</span></div><div class="body">' +
        '<ul class="readout">' +
        '<li><span class="k">address</span><span class="v"><a href="' +
        explorerAddr(CLIENT.addresses.CouponSchedule) + '" target="_blank" rel="noopener noreferrer">' +
        esc(shortAddr(CLIENT.addresses.CouponSchedule)) + "</a></span></li>" +
        '<li><span class="k">root</span><span class="v">' + esc(shortId(d.root)) + "</span></li>" +
        '<li><span class="k">issuedAt</span><span class="v">' + esc(at(d.issuedAt)) + "</span></li>" +
        '<li><span class="k">coupons</span><span class="v">' + esc(String(d.count)) + "</span></li>" +
        '<li><span class="k">spread</span><span class="v">' + esc(String(d.spread)) + " bps</span></li>" +
        '<li><span class="k">faceValue</span><span class="v">' + esc(String(d.face)) +
        " cash units</span></li>" +
        '<li><span class="k">basis</span><span class="v">' +
        (Number(d.basis) === 1 ? "ACT/365" : esc(String(d.basis))) + "</span></li></ul>" +
        '<div class="rows">' + calendar + "</div></div></section>" +
        '<section class="panel"><div class="top"><h2>Payment rail</h2>' +
        '<span class="src">CouponDistributor and HTS</span></div><div class="body">' +
        '<ul class="readout">' +
        '<li><span class="k">distributor</span><span class="v"><a href="' +
        explorerAddr(CLIENT.addresses.CouponDistributor) + '" target="_blank" rel="noopener noreferrer">' +
        esc(shortAddr(CLIENT.addresses.CouponDistributor)) + "</a></span></li>" +
        '<li><span class="k">issuer</span><span class="v">' + esc(shortAddr(d.issuer)) + "</span></li>" +
        '<li><span class="k">claimWindow</span><span class="v">' +
        esc(String(d.claimWindow)) + " s</span></li>" +
        '<li><span class="k">committed</span><span class="v">' +
        esc(String(d.committed)) + " smallest cash units</span></li>" +
        '<li><span class="k">cash</span><span class="v">' + esc(d.token.name) + " (" +
        esc(d.token.symbol) + ") · " + esc(d.token.token_id) + "</span></li>" +
        '<li><span class="k">decimals</span><span class="v">' + esc(String(d.token.decimals)) + "</span></li>" +
        '<li><span class="k">paying agent fee</span><span class="v ' +
        (d.feeMatches ? "ok" : "bad") + '">' + esc(String(d.liveFeeBps)) +
        " bps · inclusive · " + (d.feeMatches ? "matches tariff" : "MISMATCH") + "</span></li>" +
        '<li><span class="k">HSS</span><span class="v">' + esc(shortAddr(d.hss)) + "</span></li>" +
        '<li><span class="k">schedule gas</span><span class="v">' + esc(String(d.scheduleGas)) + "</span></li>" +
        '<li><span class="k">funding per call</span><span class="v">' +
        esc(formatHbar(asBig(d.fundingPerCall))) + " HBAR</span></li>" +
        '<li><span class="k">reserved</span><span class="v">' +
        esc(formatHbar(asBig(d.reserved))) + " HBAR</span></li>" +
        '<li><span class="k">additional calls funded</span><span class="v">' +
        esc(String(d.funded)) + "</span></li></ul></div></section></div>";
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
    Venue.setIssuerUi?.({rowDrift: drift ? 1 : 0});
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
    Venue.renderIssuerOverview?.();
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
    const disagree = can !== ok;
    if (Venue.issuerCore) Venue.issuerCore.journalDisagree = disagree;
    out.innerHTML = '<div class="card ' + (ok ? "open" : "dead") + '">' +
        "<div class='meta'>explain(" + esc(shortAddr(from)) + " → " + esc(shortAddr(to)) +
        ", " + esc(String(qty)) + ")</div>" +
        "<div><b>" + (ok ? "would be allowed" : "would be refused") + "</b> · " + esc(why) + "</div>" +
        "<div class='meta'>canTransfer says " + (can ? "true" : "false") +
        (disagree ? ". The two getters disagree, which is worth reporting." : "") + "</div></div>";
    Venue.recordIssuerActivity?.({
        title: "Transfer preflight",
        detail: (ok ? "allowed" : "refused") + " · " + why,
        source: "journal",
    });
    Venue.renderIssuerAttention?.();
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

const FINANCE_PRESET = Object.freeze({
    name: "Standard 30-day",
    haircut: "200",
    rate: "450",
    maint: "200",
    term: "30",
    expiry: "2",
});
const FINANCE_PREVIEW_MS = 400;
const FINANCE_ACTIVITY_LIMIT = 50;
const FINANCE_ACTIVITY_ALIASES = Object.freeze({
    lifecycle: "facility",
    oracle: "pricing",
    session: "system",
});
const FINANCE_VAULT_FIELDS = Object.freeze([
    "rv-grace", "rv-penalty", "rv-engine", "rv-watchvault",
    "rv-security", "rv-policy", "rv-stream",
]);
const FINANCE_CALL_NAMES = Object.freeze([
    "fundOffer", "cancelOffer", "accept", "addCollateral", "close",
    "markToMarket", "cure", "declareDefault", "settleDefault",
]);
const FINANCE_LIFECYCLE = Object.freeze({
    OfferFunded: "Offer funded",
    OfferCancelled: "Offer cancelled",
    Opened: "Offer accepted",
    CollateralAdded: "Collateral added",
    MarkPosted: "Margin checked",
    MarginCalled: "Margin call recorded",
    Cured: "Facility cured",
    CouponObserved: "Coupon observed",
    Failing: "Facility failing",
    Defaulted: "Default declared",
    Closed: "Repayment and release",
});

Venue.defaultFinanceUi = function () {
    return {
        view: "create",
        selectedId: "",
        role: "disconnected",
        reviewStage: "draft",
        acceptStage: "idle",
        preset: "standard-30",
        readiness: {},
        drawerTab: "activity",
        drawerOpen: false,
        booted: false,
        userView: false,
        unread: 0,
        lastOracleImpact: "",
        reviewedPrincipal: "",
        txStatus: null,
        flight: null,
    };
};

Venue.financeUiState = function () {
    if (!Venue.financeUi) Venue.financeUi = Venue.defaultFinanceUi();
    return Venue.financeUi;
};

Venue.setFinanceUi = function (patch) {
    const state = Venue.financeUiState();
    Object.assign(state, patch || {});
    return state;
};

Venue.financeIdValid = function (id) {
    return /^0x[0-9a-fA-F]{64}$/.test(String(id || ""));
};

Venue.financeAccountKey = function (kind, account) {
    const chain = CLIENT?.network?.chainId || "0";
    return "seamme.finance." + kind + "." + chain + "." + String(account || "").toLowerCase();
};

Venue.financeActivityStorageKey = function () {
    const chain = CLIENT?.network?.chainId || "0";
    const raw = Venue.financeViewerAccount();
    const who = Venue.normalizeEvmAddress(raw) || String(raw || "disconnected").toLowerCase();
    return "seamme.finance.activity." + chain + "." + who;
};

Venue.financeActivityCategory = function (value) {
    const raw = String(value || "system");
    return FINANCE_ACTIVITY_ALIASES[raw] || raw;
};

Venue.syncFinanceActivityScope = function () {
    const key = Venue.financeActivityStorageKey();
    if (Venue._financeActivityScope && Venue._financeActivityScope !== key) {
        Venue.financeActivity = [];
        Venue.setFinanceUi({unread: 0});
    }
    Venue._financeActivityScope = key;
};

Venue.financeStorageRead = function (store, key) {
    try {
        const raw = store?.getItem?.(key);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

Venue.financeStorageWrite = function (store, key, value) {
    try {
        store?.setItem?.(key, JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
};

Venue.financeViewerAccount = function () {
    if (typeof Venue.viewer === "function") return Venue.viewer();
    return Venue.account || Venue.watching || null;
};

Venue.normalizeEvmAddress = function (value) {
    const raw = String(value || "").toLowerCase();
    return /^0x[0-9a-f]{40}$/.test(raw) ? raw : "";
};

Venue.hederaLongZero = function (accountId) {
    const raw = String(accountId || "").trim();
    if (/^\d+\.\d+\.\d+$/.test(raw)) {
        return "0x" + BigInt(raw.split(".")[2]).toString(16).padStart(40, "0");
    }
    return Venue.normalizeEvmAddress(raw);
};

Venue.rememberAliasSet = function (accounts) {
    const incoming = new Set((accounts || []).map(Venue.normalizeEvmAddress).filter(Boolean));
    if (!incoming.size) return incoming;
    Venue._aliasSets = Venue._aliasSets || [];
    for (const existing of Venue._aliasSets) {
        for (const addr of incoming) {
            if (existing.has(addr)) {
                for (const extra of incoming) existing.add(extra);
                return existing;
            }
        }
    }
    Venue._aliasSets.push(incoming);
    return incoming;
};

Venue.aliasSetFromRecord = function (seed, record) {
    const values = [seed, record?.evm_address, record?.account, Venue.hederaLongZero(record?.account)];
    return [...new Set(values.map((value) => {
        if (/^\d+\.\d+\.\d+$/.test(String(value || ""))) return Venue.hederaLongZero(value);
        return Venue.normalizeEvmAddress(value);
    }).filter(Boolean))];
};

Venue.viewerAliasList = function () {
    const who = Venue.normalizeEvmAddress(Venue.financeViewerAccount())
        || String(Venue.financeViewerAccount() || "").toLowerCase();
    if (!who) return [];
    for (const set of (Venue._aliasSets || [])) {
        if (set.has(who)) return [...set];
    }
    return who ? [who] : [];
};

Venue.sameHederaAccount = function (left, right) {
    if (!left || !right) return false;
    if (addrEq(left, right)) return true;
    const a = String(left).toLowerCase();
    const b = String(right).toLowerCase();
    for (const set of (Venue._aliasSets || [])) {
        if (set.has(a) && set.has(b)) return true;
    }
    return false;
};

Venue.namesFinanceViewer = function (party) {
    if (!party) return false;
    return Venue.viewerAliasList().some((alias) => addrEq(alias, party));
};

Venue.resolveViewerAliases = async function () {
    const who = Venue.financeViewerAccount();
    if (!who) return [];
    const key = String(who).toLowerCase();
    if (Venue._aliasResolvedFor === key && Venue.viewerAliasList().length) {
        return Venue.viewerAliasList();
    }
    if (typeof Venue.mirror !== "function") {
        Venue.rememberAliasSet(Venue.aliasSetFromRecord(who));
        Venue._aliasResolvedFor = key;
        return Venue.viewerAliasList();
    }
    try {
        const record = await Venue.mirror("/api/v1/accounts/" + encodeURIComponent(who));
        Venue.rememberAliasSet(Venue.aliasSetFromRecord(who, record));
        if (record?.account) Venue._hederaAccountId = String(record.account);
    } catch {
        Venue.rememberAliasSet(Venue.aliasSetFromRecord(who));
    }
    Venue._aliasResolvedFor = key;
    return Venue.viewerAliasList();
};

Venue.financeViewerCredit = async function () {
    const vault = Venue.c?.vault;
    if (!vault?.credit) return 0n;
    const aliases = Venue.viewerAliasList().filter((value) => Venue.normalizeEvmAddress(value));
    if (!aliases.length) {
        const who = Venue.financeViewerAccount();
        return who ? asBig(await vault.credit(who).catch(() => 0n)) : 0n;
    }
    let best = 0n;
    for (const addr of aliases) {
        const value = asBig(await vault.credit(addr).catch(() => 0n));
        if (value > best) best = value;
    }
    return best;
};

Venue.normalizeKnownFacility = function (row) {
    const id = Venue.financeIdValid(row?.id) ? String(row.id) : "";
    if (!id) return null;
    return {
        id,
        role: String(row.role || ""),
        ts: Number(row.ts || Date.now()) || Date.now(),
    };
};

Venue.loadKnownFacilities = function (account) {
    if (!account) return [];
    return Venue.financeStorageRead(localStorage, Venue.financeAccountKey("known", account))
        .map(Venue.normalizeKnownFacility)
        .filter(Boolean);
};

Venue.saveKnownFacilities = function (account, rows) {
    if (!account) return;
    const next = (rows || []).map(Venue.normalizeKnownFacility).filter(Boolean).slice(0, 40);
    Venue.financeStorageWrite(localStorage, Venue.financeAccountKey("known", account), next);
};

Venue.rememberFinanceFacility = function (id, {accounts, role} = {}) {
    if (!Venue.financeIdValid(id)) return;
    const who = [...new Set((accounts || [])
        .filter(Boolean)
        .map((value) => String(value).toLowerCase()))];
    if (!who.length) return;
    for (const account of who) {
        const list = Venue.loadKnownFacilities(account);
        const existing = list.findIndex((row) => addrEq(row.id, id));
        const row = {id, role: role || "", ts: Date.now()};
        if (existing >= 0) list.splice(existing, 1);
        list.unshift(row);
        Venue.saveKnownFacilities(account, list);
    }
};

Venue.mergeFacilityIds = function (...groups) {
    const seen = new Map();
    for (const group of groups) {
        for (const value of group || []) {
            const id = typeof value === "string" ? value : value?.id;
            if (!Venue.financeIdValid(id)) continue;
            const key = id.toLowerCase();
            if (!seen.has(key)) seen.set(key, id);
        }
    }
    return [...seen.values()];
};

Venue.financeCallInfo = function (input) {
    const data = String(input || "");
    const hex = data.startsWith("0x") ? data : data ? "0x" + data : "";
    if (hex.length < 10 || typeof Venue.iface !== "function") return {id: "", name: ""};
    try {
        const parsed = Venue.iface("RepoVault").parseTransaction({data: hex});
        if (!FINANCE_CALL_NAMES.includes(parsed?.name)) return {id: "", name: ""};
        let id = parsed?.args?.[0];
        if (id && typeof id !== "string" && typeof ethers?.hexlify === "function") {
            try { id = ethers.hexlify(id); } catch { id = String(id || ""); }
        }
        return {
            id: Venue.financeIdValid(id) ? String(id) : "",
            name: parsed.name || "",
        };
    } catch {
        return {id: "", name: ""};
    }
};

Venue.financeCallId = function (input) {
    return Venue.financeCallInfo(input).id;
};

Venue.financeCallActivityTitle = function (name) {
    return ({
        fundOffer: "Offer funded",
        cancelOffer: "Offer cancelled",
        accept: "Offer accepted",
        addCollateral: "Collateral added",
        close: "Repayment and release",
        markToMarket: "Margin checked",
        cure: "Facility cured",
        declareDefault: "Default declared",
        settleDefault: "Collateral executed",
    })[name] || "";
};

Venue.mirrorNextPath = function (next) {
    const raw = String(next || "").trim();
    if (!raw) return "";
    if (raw.startsWith("/")) return raw;
    try {
        const parsed = new URL(raw, CLIENT?.network?.mirror || "https://example.test");
        return parsed.pathname + parsed.search;
    } catch {
        return "";
    }
};

Venue.listViewerVaultResults = async function () {
    const vault = CLIENT?.addresses?.RepoVault;
    if (!vault || typeof Venue.mirror !== "function") return [];
    const aliases = (await Venue.resolveViewerAliases().catch(() => Venue.viewerAliasList()))
        .filter((value) => Venue.normalizeEvmAddress(value));
    const who = Venue.normalizeEvmAddress(Venue.financeViewerAccount());
    const froms = [...(aliases.length ? aliases : (who ? [who] : []))];
    if (Venue._hederaAccountId && !froms.includes(Venue._hederaAccountId)) {
        froms.push(Venue._hederaAccountId);
    }
    const seen = new Set();
    const rows = [];
    for (const from of froms) {
        let path = "/api/v1/contracts/" + vault + "/results?from=" +
            encodeURIComponent(from) + "&order=desc&limit=25";
        for (let page = 0; page < 4 && path; page += 1) {
            const payload = await Venue.mirror(path);
            for (const row of payload?.results || []) {
                const key = String(row.hash || row.transaction_hash || row.timestamp || "")
                    + String(row.function_parameters || row.input || "");
                if (!key || seen.has(key)) continue;
                seen.add(key);
                rows.push(row);
            }
            path = Venue.mirrorNextPath(payload?.links?.next);
        }
    }
    return rows;
};

Venue.ingestViewerVaultResults = function (results) {
    const aliases = Venue.viewerAliasList();
    for (const row of results || []) {
        if (row?.error_message) continue;
        const info = Venue.financeCallInfo(row.function_parameters || row.input || "");
        if (!info.id) continue;
        const title = Venue.financeCallActivityTitle(info.name);
        if (!title) continue;
        const hash = /^0x[0-9a-fA-F]{64}$/.test(String(row.hash || ""))
            ? String(row.hash)
            : /^0x[0-9a-fA-F]{64}$/.test(String(row.transaction_hash || ""))
                ? String(row.transaction_hash)
                : "";
        const ts = row.timestamp
            ? Number(String(row.timestamp).split(".")[0]) * 1000
            : Date.now();
        const role = info.name === "fundOffer" || info.name === "cancelOffer"
            ? "lender"
            : info.name === "accept" ? "borrower" : "";
        Venue.rememberFinanceFacility(info.id, {accounts: aliases, role});
        Venue.recordFinanceActivity({
            ts: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
            category: "transaction",
            title,
            detail: "Recovered from this wallet's vault transactions.",
            facilityId: info.id,
            txHash: hash,
            explorer: hash ? explorerTx(hash) : "",
        }, {persist: true, notify: false});
    }
};

Venue.discoverViewerFacilityIds = async function () {
    const who = Venue.financeViewerAccount();
    const vault = CLIENT?.addresses?.RepoVault;
    if (!who || !vault || typeof Venue.mirror !== "function") return [];
    try {
        const results = await Venue.listViewerVaultResults();
        Venue.ingestViewerVaultResults(results);
        return Venue.mergeFacilityIds(
            results.map((row) => Venue.financeCallId(row.function_parameters || row.input || "")),
        );
    } catch (error) {
        Venue.recordFinanceActivity({
            category: "session",
            severity: "error",
            title: "Wallet history unavailable",
            detail: String(error?.message || error || "The mirror node did not return this wallet's vault calls."),
        }, {persist: false, notify: false});
        return [];
    }
};

Venue.recoverViewerFinanceHistory = async function () {
    if (Venue._financeRecoverInflight) return Venue._financeRecoverInflight;
    Venue._financeRecoverInflight = (async () => {
        const who = Venue.financeViewerAccount();
        if (!who) {
            Venue._financeRecovering = false;
            Venue.paintFinanceActivity();
            return [];
        }
        Venue._financeRecovering = true;
        Venue.paintFinanceActivity();
        try {
            await Venue.ingestSelectedFundedOffer().catch(() => null);
            const ids = await Venue.discoverViewerFacilityIds();
            if (ids.length && typeof Venue.paintRelatedWorkspace === "function") {
                await Venue.paintRelatedWorkspace(ids).catch(() => {});
            }
            return ids;
        } finally {
            Venue._financeRecovering = false;
            Venue.paintFinanceActivity();
        }
    })();
    try {
        return await Venue._financeRecoverInflight;
    } finally {
        Venue._financeRecoverInflight = null;
    }
};

Venue.bindFinanceChrome = function () {
    if (Venue._financeChromeBound) return;
    if (!$("fin-view-create") && !$("fin-open-activity") && !$("feed-refresh")) return;
    Venue._financeChromeBound = true;
    Venue.financeUiState();
    Venue.bindFinanceDrawer();
    $("repo-go")?.addEventListener("click", () => Venue.doRepo().catch((e) => Venue.fail(e)));
    $("feed-refresh")?.addEventListener("click", () => Venue.refreshFinanceFeed());
    $("repo-id")?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") Venue.doRepo().catch((x) => Venue.fail(x));
    });
    $("repo-discover")?.addEventListener("click", () => Venue.discoverRepos().catch((e) => Venue.fail(e)));
    $("fin-id-new")?.addEventListener("click", () => {
        Venue.ensureFinanceId(true);
        Venue.exitFinanceReview();
        Venue.scheduleFinancePreview();
    });
    $("fin-id-new-draft")?.addEventListener("click", () => {
        Venue.ensureFinanceId(true);
        Venue.exitFinanceReview();
        Venue.scheduleFinancePreview();
    });
    $("fin-id-copy")?.addEventListener("click", () => {
        Venue.copyFinanceId().catch((e) => Venue.fail(e));
    });
    $("fin-id-copy-draft")?.addEventListener("click", () => {
        Venue.copyKnownFinanceId(($("fin-id")?.value || "").trim(), $("fin-id-copy-draft"))
            .catch((e) => Venue.fail(e));
    });
    $("fin-id-share")?.addEventListener("click", () => {
        Venue.shareFinanceId().catch((e) => Venue.fail(e));
    });
    $("fin-preset-reset")?.addEventListener("click", () => {
        Venue.applyFinancePreset();
        Venue.exitFinanceReview();
        Venue.scheduleFinancePreview();
    });
    $("fin-advanced")?.addEventListener("toggle", () => {
        Venue.paintFinancePreset();
    });
    for (const id of [
        "fin-borrower", "fin-lot", "fin-haircut", "fin-rate",
        "fin-maint", "fin-term", "fin-expiry",
    ]) {
        $(id)?.addEventListener("input", () => {
            Venue.exitFinanceReview();
            Venue.paintFinancePreset();
            Venue.scheduleFinancePreview();
        });
    }
    $("fin-quote")?.addEventListener("click", () => Venue.previewFinance().catch((e) => Venue.fail(e)));
    $("fin-review")?.addEventListener("click", () => Venue.enterFinanceReview().catch((e) => Venue.fail(e)));
    $("fin-review-back")?.addEventListener("click", () => Venue.exitFinanceReview());
    $("fin-fund")?.addEventListener("click", () => Venue.doFundOffer().catch((e) => Venue.fail(e)));
    $("fin-accept")?.addEventListener("click", () => Venue.doAcceptOffer().catch((e) => Venue.fail(e)));
    $("fin-cancel")?.addEventListener("click", () => Venue.doCancelOffer().catch((e) => Venue.fail(e)));
    $("fin-withdraw")?.addEventListener("click", () => Venue.doVaultWithdraw().catch((e) => Venue.fail(e)));
    $("fin-view-create")?.addEventListener("click", () => Venue.setFinanceView("create", {user: true}));
    $("fin-view-manage")?.addEventListener("click", () => Venue.setFinanceView("manage", {user: true}));
    $("fin-view-toggle")?.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft"
            && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        const next = event.key === "Home" || event.key === "ArrowLeft" ? "create" : "manage";
        Venue.setFinanceView(next, {user: true});
        $(next === "create" ? "fin-view-create" : "fin-view-manage")?.focus?.();
    });
    $("fin-open-activity")?.addEventListener("click", () => Venue.openFinanceDrawer("activity"));
    $("fin-open-evidence")?.addEventListener("click", () => Venue.openFinanceDrawer("audit", {
        group: "fin-audit-evidence",
    }));
    $("fin-activity")?.addEventListener("click", (event) => {
        if (event.target?.closest?.("[data-finance-connect]")) {
            if (typeof Venue.connect === "function") Venue.connect();
            return;
        }
        const button = event.target?.closest?.("[data-copy-facility]");
        if (!button) return;
        Venue.copyKnownFinanceId(button.dataset.copyFacility, button)
            .catch((error) => Venue.fail(error));
    });
    $("fin-activity")?.addEventListener("submit", (event) => {
        const form = event.target?.closest?.("[data-finance-watch]");
        if (!form) return;
        event.preventDefault();
        const value = $("fin-activity-watch-input")?.value || "";
        if (typeof Venue.startWatching !== "function") return;
        Venue.startWatching(value).catch((error) => Venue.fail(error));
    });
};

Venue.refreshFinanceFeed = function () {
    const btn = $("feed-refresh");
    if (btn) {
        btn.setAttribute("aria-busy", "true");
        btn.textContent = "Refreshing";
    }
    const done = () => {
        if (!btn) return;
        btn.removeAttribute("aria-busy");
        btn.textContent = "Refresh";
    };
    const poll = Venue.pollOracle;
    if (typeof poll !== "function") {
        done();
        return Promise.resolve(false);
    }
    return poll.call(Venue).catch((error) => Venue.fail(error)).finally(done);
};

Venue.mountRepo = async function () {
    const prior = Venue.financeUi;
    Venue.financeUi = Venue.defaultFinanceUi();
    if (prior?.userView) {
        Venue.financeUi.view = prior.view === "manage" ? "manage" : "create";
        Venue.financeUi.userView = true;
        Venue.financeUi.selectedId = prior.selectedId || "";
        Venue.financeUi.drawerTab = prior.drawerTab || "activity";
        Venue.financeUi.drawerOpen = !!prior.drawerOpen;
        Venue.financeUi.unread = Number(prior.unread || 0);
        Venue.financeUi.reviewStage = prior.reviewStage || "draft";
    }
    Venue.financeActivity = Venue.loadFinanceActivity();
    Venue.bindFinanceChrome();
    Venue.ensureFinanceId(false);
    Venue.paintFinanceIdBrief();
    Venue.applyFinancePreset();
    const shared = Venue.financeSharedId();
    if (shared) {
        if ($("repo-id")) $("repo-id").value = shared;
        if ($("fin-id")) $("fin-id").value = shared;
        Venue.setFinanceUi({selectedId: shared, userView: true});
        Venue.setFinanceView("manage", {user: true});
    }
    Venue.paintFinanceChrome();
    Venue.paintFinancingGate();
    Venue.paintFinancingEvidence();
    Venue.paintFinanceActivity();
    Venue._prefetchHref = "venue.html";
    const vault = Venue.refreshVault().catch((error) => Venue.financeVaultReadFailed(error));
    const oracle = Venue.pollOracle();
    const history = Venue.recoverViewerFinanceHistory().catch(() => []);
    await Venue.whenOracleHeadline();
    Venue.discoverRepos().catch(() => {});
    await Promise.all([vault, oracle, history]);
    Venue.setFinanceUi({booted: true});
};

Venue.financeSharedId = function () {
    try {
        const search = typeof location !== "undefined" ? String(location.search || "") : "";
        const value = new URLSearchParams(search).get("facility") || "";
        return /^0x[0-9a-fA-F]{64}$/.test(value) ? value : "";
    } catch {
        return "";
    }
};

Venue.ensureFinanceId = function (force) {
    const input = $("fin-id");
    if (!input) return "";
    const current = (input.value || "").trim();
    if (!force && /^0x[0-9a-fA-F]{64}$/.test(current)) {
        Venue.paintFinanceIdBrief();
        return current;
    }
    if (typeof ethers === "undefined" || typeof ethers.randomBytes !== "function") {
        Venue.paintFinanceIdBrief();
        return current;
    }
    input.value = ethers.hexlify(ethers.randomBytes(32));
    Venue.paintFinanceIdBrief();
    return input.value;
};

Venue.paintFinanceIdBrief = function () {
    const value = ($("fin-id")?.value || "").trim();
    const short = $("fin-id-short");
    if (!short) return value;
    short.textContent = Venue.financeIdValid(value) ? shortId(value) : "Creating";
    return value;
};

Venue.applyFinancePreset = function () {
    if ($("fin-haircut")) $("fin-haircut").value = FINANCE_PRESET.haircut;
    if ($("fin-rate")) $("fin-rate").value = FINANCE_PRESET.rate;
    if ($("fin-maint")) $("fin-maint").value = FINANCE_PRESET.maint;
    if ($("fin-term")) $("fin-term").value = FINANCE_PRESET.term;
    if ($("fin-expiry")) $("fin-expiry").value = FINANCE_PRESET.expiry;
    Venue.paintFinancePreset();
};

Venue.financePresetDirty = function () {
    return ($("fin-haircut")?.value || "") !== FINANCE_PRESET.haircut
        || ($("fin-rate")?.value || "") !== FINANCE_PRESET.rate
        || ($("fin-maint")?.value || "") !== FINANCE_PRESET.maint
        || ($("fin-term")?.value || "") !== FINANCE_PRESET.term
        || ($("fin-expiry")?.value || "") !== FINANCE_PRESET.expiry;
};

Venue.paintFinancePreset = function () {
    const dirty = Venue.financePresetDirty();
    Venue.setFinanceUi({preset: dirty ? "custom" : "standard-30"});
    const label = $("fin-preset-label");
    if (label) {
        label.textContent = dirty ? "Custom" : FINANCE_PRESET.name;
        label.classList.toggle("is-custom", dirty);
    }
    const summary = $("fin-advanced-summary");
    if (summary) {
        summary.textContent = dirty
            ? "Custom · haircut " + ($("fin-haircut")?.value || "") +
              " · rate " + ($("fin-rate")?.value || "") +
              " · maintenance " + ($("fin-maint")?.value || "") +
              " · " + ($("fin-term")?.value || "") + " days · offer " +
              ($("fin-expiry")?.value || "") + " hours"
            : FINANCE_PRESET.name + " · haircut 200 · rate 450 · maintenance 200 · 30 days · offer 2 hours";
    }
};

Venue.scheduleFinancePreview = function () {
    clearTimeout(Venue._financePreviewTimer);
    Venue._financePreviewTimer = setTimeout(() => {
        Venue.previewFinance().catch(() => {});
    }, FINANCE_PREVIEW_MS);
};

Venue.setFinanceView = function (view, {user = false} = {}) {
    const next = view === "manage" ? "manage" : "create";
    const state = Venue.setFinanceUi({
        view: next,
        userView: user ? true : Venue.financeUiState().userView,
    });
    const create = $("fin-create");
    const manage = $("fin-manage");
    const createTab = $("fin-view-create");
    const manageTab = $("fin-view-manage");
    if (create) create.hidden = next !== "create";
    if (manage) manage.hidden = next !== "manage";
    if (createTab) {
        createTab.setAttribute("aria-selected", next === "create" ? "true" : "false");
        createTab.tabIndex = next === "create" ? 0 : -1;
    }
    if (manageTab) {
        manageTab.setAttribute("aria-selected", next === "manage" ? "true" : "false");
        manageTab.tabIndex = next === "manage" ? 0 : -1;
    }
    const toggle = $("fin-view-toggle");
    if (toggle) {
        toggle.dataset = toggle.dataset || {};
        toggle.dataset.view = next;
        if (typeof toggle.setAttribute === "function") toggle.setAttribute("data-view", next);
    }
    return state;
};

Venue.paintFinanceChrome = function () {
    const state = Venue.financeUiState();
    Venue.setFinanceView(state.view);
    Venue.paintFinancePreset();
    Venue.paintFinanceIdBrief();
    Venue.paintFinanceAlert();
    Venue.paintFinanceBadge();
};

Venue.financeRoleFor = function (lender, borrower) {
    const account = Venue.account;
    const viewer = Venue.viewer();
    if (!account && !viewer) return "disconnected";
    const isLender = Venue.namesFinanceViewer(lender);
    const isBorrower = Venue.namesFinanceViewer(borrower);
    if (!account && viewer) {
        if (isLender) return "lender";
        if (isBorrower) return "borrower";
        return "watch";
    }
    if (isLender) return "lender";
    if (isBorrower) return "borrower";
    return "unrelated";
};

Venue.financeCanSign = function () {
    return !!Venue.account && !!Venue.financing?.ready;
};

Venue.facilityUrgency = function (row, now) {
    const alert = row?.alert || {};
    const state = Number(row?.stateNo || 0);
    const expiry = Number(row?.maturity || 0);
    const remaining = expiry > 0 ? expiry - Number(now) : 0;
    if (state === 6) return {rank: 1, reason: "executable-default", at: 0};
    if (alert.defaultable) return {rank: 2, reason: "defaultable", at: 0};
    if (alert.cureExpired || (alert.called && remaining > 0 && remaining < 3600)) {
        return {rank: 3, reason: "expired-or-near-cure", at: 0};
    }
    if (alert.called || state === 3) return {rank: 4, reason: "margin-call", at: 0};
    if (state === 5 || alert.unmarkedFail) return {rank: 5, reason: "failing", at: 0};
    if (row?.offered) {
        const near = remaining > 0 && remaining < 3600;
        return {rank: near ? 7 : 6, reason: near ? "offer-nearing-expiry" : "funded-offer", at: expiry || 0};
    }
    if (state >= 7) return {rank: 10, reason: "closed", at: 0};
    if (expiry > 0) return {rank: 9, reason: "maturity", at: expiry};
    return {rank: 99, reason: "none", at: 0};
};

Venue.chooseFinanceStart = function (rows, credit) {
    const now = Number(nowSec());
    const ranked = (rows || []).map((row) => ({
        row,
        urgency: Venue.facilityUrgency(row, now),
    })).sort((left, right) => {
        if (left.urgency.rank !== right.urgency.rank) {
            return left.urgency.rank - right.urgency.rank;
        }
        if (left.urgency.at && right.urgency.at && left.urgency.at !== right.urgency.at) {
            return left.urgency.at - right.urgency.at;
        }
        return 0;
    });
    const urgent = ranked.find((item) => item.urgency.rank <= 7);
    const creditOpen = asBig(credit || 0n) > 0n;
    if (urgent) {
        return {view: "manage", selectedId: urgent.row.id, reason: urgent.urgency.reason};
    }
    if (creditOpen) {
        return {
            view: "manage",
            selectedId: ranked[0]?.row?.id || "",
            reason: "withdrawable-credit",
        };
    }
    if (ranked[0] && ranked[0].urgency.rank === 6) {
        return {view: "create", selectedId: ranked[0].row.id, reason: "nearest-maturity"};
    }
    return {view: "create", selectedId: "", reason: "draft"};
};

Venue.enterFinanceReview = async function () {
    Venue.ensureFinanceId(false);
    const draft = await Venue.previewFinance();
    if (!draft) throw new Error("A live quote is required before review.");
    if (draft.principal == null) throw new Error("The live vault did not return a principal.");
    Venue.setFinanceUi({reviewStage: "review", reviewedPrincipal: String(draft.principal)});
    Venue.paintFinanceReviewMode(true);
    Venue.paintFinanceReview(draft);
    if ($("fin-fund")) {
        $("fin-fund").disabled = !Venue.financeUiState().readiness?.fundReady;
        Venue.paintFundButton(draft.principal);
    }
    $("fin-review-body")?.focus?.();
    return draft;
};

Venue.exitFinanceReview = function () {
    const state = Venue.financeUiState();
    if (state.reviewStage !== "draft") Venue.setFinanceUi({reviewStage: "draft", reviewedPrincipal: ""});
    Venue.paintFinanceReviewMode(false);
    if ($("fin-fund")) {
        $("fin-fund").disabled = true;
        $("fin-fund").textContent = "Fund offer";
    }
};

Venue.paintFinanceReviewMode = function (on) {
    const wizard = $("fin-wizard");
    if (wizard?.classList) wizard.classList.toggle("is-reviewing", !!on);
    const panel = $("fin-review-panel");
    if (panel) panel.hidden = !on;
    for (const id of [
        "fin-borrower", "fin-lot", "fin-haircut", "fin-rate",
        "fin-maint", "fin-term", "fin-expiry",
    ]) {
        const el = $(id);
        if (el) el.readOnly = !!on;
    }
};

Venue.paintFundButton = function (principal) {
    const btn = $("fin-fund");
    if (!btn) return;
    btn.textContent = principal == null
        ? "Fund offer"
        : "Fund " + formatHbar(principal) + " HBAR";
};

function paintFinanceQuoteStatus(kind, label) {
    const status = $("fin-quote-status");
    if (!status) return;
    status.textContent = label;
    status.classList.toggle("is-ready", kind === "ready");
    status.classList.toggle("is-blocked", kind === "blocked");
    if (typeof status.setAttribute === "function") {
        status.setAttribute("aria-busy", kind === "checking" ? "true" : "false");
    }
}

Venue.paintFinanceQuote = function (model) {
    const out = $("fin-preview");
    const details = $("fin-quote-details");
    const detailsBody = $("fin-quote-details-body");
    if (!out) return;
    if (!model || model.incomplete) {
        paintFinanceQuoteStatus("incomplete", "Incomplete");
        out.innerHTML = '<div class="empty">Enter a borrower and lot to quote principal in HBAR. Nothing is signed yet.</div>';
        if (details) details.hidden = true;
        return;
    }
    if (model.checking) {
        paintFinanceQuoteStatus("checking", "Checking");
        out.innerHTML = '<div class="empty">Reading the live vault quote.</div>';
        return;
    }
    if (model.error) {
        paintFinanceQuoteStatus("blocked", "Blocked");
        out.innerHTML = '<div class="empty">' + esc(model.error) + "</div>";
        if (details) details.hidden = true;
        return;
    }
    const li = (label, value) =>
        "<li><span class='k'>" + esc(label) + "</span><span class='v'>" + value + "</span></li>";
    const quoteError = String(model.quoteError || "").trim();
    const statusKind = model.statusKind || (model.ready ? "ready" : "blocked");
    const statusLabel = model.statusLabel || (model.ready ? "Ready to review" : "Blocked");
    paintFinanceQuoteStatus(statusKind === "ready" ? "ready" : "blocked", statusLabel);
    out.innerHTML =
        (quoteError
            ? '<div class="banner warn"><p>' + esc(quoteError) + "</p></div>"
            : "") +
        '<ul class="fin-quote-list">' +
        li("Collateral", esc(String(model.lot)) + " LPRC") +
        li("Principal", model.principal == null ? "Unavailable" : esc(formatHbar(model.principal)) + " HBAR") +
        li("Repayment", model.repay == null ? "Unavailable" : esc(formatHbar(model.repay)) + " HBAR") +
        li("Maturity", esc(model.maturityText || "Unavailable")) +
        li("Rate", esc(String(model.rate)) + " bps") +
        li("Haircut", esc(String(model.haircut)) + " bps") +
        li("Maintenance", esc(String(model.maintenance)) + " bps") +
        li("Feed", esc(model.feedHealth || "Unavailable")) +
        li("Borrower eligibility", esc(model.borrowerEligibility || "unavailable")) +
        li("Lender eligibility", esc(model.lenderEligibility || "unavailable")) +
        "</ul>" +
        '<p class="fin-quote-ready' + (model.ready ? "" : " is-blocked") + '">' +
        esc(model.readyCopy || "Enter a borrower and lot to review an offer.") +
        "</p>";
    if (details) details.hidden = !model.details;
    if (detailsBody && model.details) {
        const extra = model.details;
        detailsBody.innerHTML = '<ul class="fin-quote-list">' +
            li("Facility id", '<span class="mono">' + esc(extra.id || "") + "</span>") +
            li("Borrower", '<span class="mono">' + esc(extra.borrower || "Unavailable") + "</span>") +
            li("Lender", '<span class="mono">' + esc(extra.lender || "Connect a wallet") + "</span>") +
            li("Available collateral", esc(extra.free || "Unavailable")) +
            li("Current allowance", esc(extra.allowance || "Unavailable")) +
            li("Current mark", extra.mark == null ? "Unavailable" : esc(formatHbar(extra.mark)) + " HBAR") +
            li("Offer expiry", esc(extra.expiry || "Unavailable")) +
            "</ul>";
    }
};

Venue.paintFinanceReview = function (draft) {
    const out = $("fin-review-body");
    if (!out || !draft) return;
    const li = (label, value, mono) =>
        "<li><span class='k'>" + esc(label) + "</span><span class='v" +
        (mono ? " mono" : "") + "'>" + value + "</span></li>";
    const lender = draft.hasOffer ? draft.lender : Venue.account;
    Venue.paintFundButton(draft.principal);
    out.innerHTML =
        '<ul class="fin-review-facts">' +
        li("Facility id", esc(draft.id), true) +
        li("Lender", esc(lender || "Connect a wallet to fund"), !!lender) +
        li("Borrower", esc(draft.borrower), true) +
        li("Collateral", esc(String(draft.terms.collateralAmount)) + " LPRC") +
        li("Principal", draft.principal == null ? "Unavailable" : esc(formatHbar(draft.principal)) + " HBAR") +
        li("Repayment at maturity", draft.repay == null ? "Unavailable" : esc(formatHbar(draft.repay)) + " HBAR") +
        li("Projected maturity", esc(financeAt(nowSec() + asBig(draft.terms.term)))) +
        li("Offer expiry", esc(financeAt(draft.expiresAt))) +
        li("Repo rate", esc(String(draft.terms.repoRateBps)) + " bps") +
        li("Haircut", esc(String(draft.terms.haircutBps)) + " bps") +
        li("Maintenance", esc(String(draft.terms.maintenanceBps)) + " bps") +
        "</ul>" +
        '<p class="fin-review-risks">The lender deposits the exact principal. ' +
        "Acceptance locks the borrower collateral lot. " +
        "Title remains with the borrower until default. " +
        "Cash withdrawal is a separate pull operation. " +
        "Nothing is sent until the Fund button is confirmed in the wallet.</p>";
};

Venue.refreshFinanceWorkspace = async function () {
    if (Venue.page !== "repo") return;
    Venue.financeActivity = Venue.mergeFinanceActivity(
        Venue.financeActivity || [],
        Venue.loadFinanceActivity(),
    );
    Venue.paintFinanceActivity();
    Venue.paintFinancingGate();
    Venue.paintFinanceChrome();
    if (!Venue.financeUiState().booted) {
        await Venue.recoverViewerFinanceHistory().catch(() => []);
        return;
    }
    if (Venue.financeUiState().view === "create") {
        await Venue.previewFinance().catch(() => {});
    }
    await Venue.recoverViewerFinanceHistory().catch(() => []);
    Venue.discoverRepos().catch(() => {});
};

Venue.paintRelatedFacilities = function (rows) {
    const out = $("fin-related");
    if (!out) return;
    const who = typeof Venue.viewer === "function" ? Venue.viewer() : null;
    if (!who) {
        out.innerHTML = '<div class="empty">Connect or watch a wallet to see facilities that name you.</div>';
        return;
    }
    if (!rows.length) {
        out.innerHTML = '<div class="empty">No facilities that name this wallet were found. Use the public lookup if you have a facility id.</div>';
        return;
    }
    const selected = Venue.financeUiState().selectedId;
    const now = Number(nowSec());
    out.innerHTML = rows.map((row) => {
        const role = Venue.financeRoleFor(row.lender, row.borrower);
        const current = selected && String(row.id).toLowerCase() === String(selected).toLowerCase();
        const state = String(row.state || "").replaceAll("_", " ");
        const idle = /expir|cancel|settled|closed/i.test(state);
        const alert = row.alert || {};
        const warn = !!(alert.defaultable || alert.called || alert.cureExpired || alert.unmarkedFail);
        const counterparty = role === "lender"
            ? row.borrower
            : role === "borrower" ? row.lender : (row.borrower || row.lender);
        const amount = row.offered || row.principal
            ? (row.principal != null ? formatHbar(asBig(row.principal)) + " HBAR" : "")
            : (row.collateral != null ? String(row.collateral) + " LPRC" : "");
        const when = row.maturity ? financeAt(row.maturity) : "";
        const urgency = Venue.facilityUrgency(row, now);
        return '<button type="button" class="fin-chip" data-id="' + esc(row.id) + '"' +
            (current ? ' aria-current="true"' : "") +
            (warn ? ' data-warn="1"' : "") + ">" +
            '<span class="fin-chip-dot' +
            (warn ? " is-bad" : idle ? " is-idle" : urgency.rank <= 7 ? " is-warn" : "") +
            '" aria-hidden="true"></span>' +
            '<span class="fin-chip-copy"><span class="id">' + esc(shortId(row.id)) + "</span>" +
            '<span class="meta">' + esc(state) + " · " + esc(role) +
            (counterparty ? " · " + esc(shortAddr(counterparty)) : "") +
            (amount ? " · " + esc(amount) : "") +
            (when ? " · " + esc(when) : "") +
            (warn ? " · action required" : "") +
            "</span></span></button>";
    }).join("");
    out.querySelectorAll(".fin-chip").forEach((button) => {
        button.addEventListener("click", () => {
            if ($("repo-id")) $("repo-id").value = button.dataset.id;
            if ($("fin-id")) $("fin-id").value = button.dataset.id;
            Venue.setFinanceUi({selectedId: button.dataset.id});
            Venue.setFinanceView("manage", {user: true});
            Venue.doRepo().catch((error) => Venue.fail(error));
        });
    });
};

function financeExplorerHref(url) {
    const allowed = CLIENT?.network?.explorer;
    if (!url || !allowed) return "";
    try {
        const parsed = new URL(String(url), allowed);
        const base = new URL(allowed);
        if (parsed.origin !== base.origin) return "";
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
        return parsed.href;
    } catch {
        return "";
    }
}

function financeExplorerLink(url, label) {
    const href = financeExplorerHref(url);
    if (!href) return "";
    return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' +
        esc(label || "HashScan") + "</a>";
}

Venue.financeRelativeTime = function (timestamp, now) {
    const then = Number(timestamp || 0);
    const current = Number(now || Date.now());
    if (!Number.isFinite(then) || then <= 0) return "Unknown time";
    const delta = Math.round((current - then) / 1000);
    if (Math.abs(delta) < 45) return "just now";
    const ago = delta >= 0;
    const seconds = Math.abs(delta);
    const value = seconds < 90
        ? "1 minute"
        : seconds < 3600
            ? Math.round(seconds / 60) + " minutes"
            : seconds < 5400
                ? "1 hour"
                : seconds < 86400
                    ? Math.round(seconds / 3600) + " hours"
                    : seconds < 172800
                        ? "1 day"
                        : Math.round(seconds / 86400) + " days";
    return ago ? value + " ago" : "in " + value;
};

Venue.financeActivityKey = function (entry) {
    if (entry.action) {
        return ["action", entry.facilityId || "", entry.action].join("|").toLowerCase();
    }
    return [
        entry.category || "",
        entry.facilityId || "",
        entry.txHash || "",
        entry.title || "",
    ].join("|").toLowerCase();
};

Venue.normalizeFinanceActivity = function (row) {
    if (!row || typeof row !== "object" || !row.title) return null;
    const category = Venue.financeActivityCategory(row.category);
    const action = String(row.action || "").slice(0, 80);
    return {
        id: String(row.id || [row.ts || "", row.title, row.facilityId || "", action].join(":")),
        ts: Number(row.ts || Date.now()) || Date.now(),
        category,
        severity: String(row.severity || "info"),
        title: String(row.title).slice(0, 160),
        detail: String(row.detail || "").slice(0, 400),
        facilityId: Venue.financeIdValid(row.facilityId) ? String(row.facilityId) : "",
        txHash: /^0x[0-9a-fA-F]{64}$/.test(String(row.txHash || ""))
            ? String(row.txHash)
            : "",
        explorer: financeExplorerHref(row.explorer || "") || "",
        status: String(row.status || ""),
        action,
    };
};

Venue.mergeFinanceActivity = function (...groups) {
    const seen = new Map();
    for (const group of groups) {
        for (const raw of group || []) {
            const row = Venue.normalizeFinanceActivity(raw);
            if (!row) continue;
            const key = Venue.financeActivityKey(row);
            if (!seen.has(key)) seen.set(key, row);
        }
    }
    return [...seen.values()].sort((left, right) => Number(right.ts) - Number(left.ts));
};

Venue.loadFinanceActivity = function () {
    Venue.syncFinanceActivityScope();
    const session = Venue.financeStorageRead(sessionStorage, Venue.financeActivityStorageKey())
        .map(Venue.normalizeFinanceActivity)
        .filter(Boolean);
    const accounts = Venue.viewerAliasList();
    const local = accounts.flatMap((account) =>
        Venue.financeStorageRead(localStorage, Venue.financeAccountKey("activity", account))
            .map(Venue.normalizeFinanceActivity)
            .filter(Boolean));
    return Venue.mergeFinanceActivity(session, local);
};

Venue.persistFinanceActivity = function () {
    const rows = (Venue.financeActivity || [])
        .filter((row) => {
            if (row.title === "Funded offer awaiting acceptance") return true;
            return row.category !== "facility" && row.category !== "pricing"
                && row.category !== "lifecycle" && row.category !== "oracle";
        })
        .slice(0, FINANCE_ACTIVITY_LIMIT)
        .map((row) => ({
            id: row.id || "",
            ts: row.ts,
            category: row.category,
            severity: row.severity,
            title: row.title,
            detail: row.detail,
            facilityId: row.facilityId || "",
            txHash: row.txHash || "",
            explorer: row.explorer || "",
            status: row.status || "",
            action: row.action || "",
        }));
    Venue.financeStorageWrite(sessionStorage, Venue.financeActivityStorageKey(), rows);
    for (const account of Venue.viewerAliasList()) {
        Venue.financeStorageWrite(
            localStorage,
            Venue.financeAccountKey("activity", account),
            rows,
        );
    }
};

Venue.recordFinanceActivity = function (entry, {persist = true, notify = true} = {}) {
    if (!entry?.title) return null;
    const next = Venue.normalizeFinanceActivity({
        ts: Number(entry.ts || Date.now()),
        category: entry.category || "system",
        severity: entry.severity || "info",
        title: String(entry.title).slice(0, 160),
        detail: String(entry.detail || "").slice(0, 400),
        facilityId: entry.facilityId,
        txHash: entry.txHash,
        explorer: entry.explorer,
        status: entry.status || "",
        action: entry.action || "",
    });
    if (!next) return null;
    const list = Venue.financeActivity || [];
    const key = Venue.financeActivityKey(next);
    const existing = list.findIndex((row) => Venue.financeActivityKey(row) === key);
    if (existing >= 0) {
        next.id = list[existing].id;
        next.ts = list[existing].ts;
        list.splice(existing, 1);
    }
    list.unshift(next);
    Venue.financeActivity = list.slice(0, FINANCE_ACTIVITY_LIMIT);
    if (persist && next.category !== "pricing") Venue.persistFinanceActivity();
    if (notify && !Venue.financeUiState().drawerOpen) {
        Venue.setFinanceUi({unread: Venue.financeUiState().unread + 1});
        if (next.severity === "warning" || next.severity === "error") {
            Venue.paintFinanceAlert(next.detail || next.title, next.category === "pricing" ? "audit" : "activity");
        }
    }
    Venue.paintFinanceActivity();
    Venue.paintFinanceBadge();
    return next;
};

Venue.ingestFacilityHistory = function (id, logs) {
    for (const entry of logs || []) {
        const title = FINANCE_LIFECYCLE[entry.name] || entry.name;
        if (!title || title === "unrecognised") continue;
        Venue.recordFinanceActivity({
            ts: entry.at ? entry.at * 1000 : Date.now(),
            category: "facility",
            severity: ["Failing", "Defaulted", "MarginCalled"].includes(entry.name) ? "warning" : "info",
            title,
            detail: "Confirmed vault event for this facility.",
            facilityId: id,
            txHash: entry.tx,
            explorer: entry.tx ? explorerTx(entry.tx) : "",
        }, {persist: false, notify: false});
    }
    Venue.paintFinanceActivity();
};

Venue.paintFinanceActivity = function () {
    const out = $("fin-activity");
    if (!out) return;
    const selected = Venue.financeUiState().selectedId;
    const rows = [...(Venue.financeActivity || [])]
        .filter((row) => {
            if (!selected) return true;
            if (Venue.financeIdValid(row.facilityId)) return addrEq(row.facilityId, selected);
            return row.category === "wallet" || row.category === "system" || row.category === "session";
        })
        .sort((left, right) => {
            if (selected) {
                const leftMatch = Venue.financeIdValid(left.facilityId) && addrEq(left.facilityId, selected);
                const rightMatch = Venue.financeIdValid(right.facilityId) && addrEq(right.facilityId, selected);
                if (leftMatch !== rightMatch) return leftMatch ? -1 : 1;
            }
            return Number(right.ts) - Number(left.ts);
        });
    if (!rows.length) {
        const who = Venue.financeViewerAccount();
        if (Venue._financeRecovering) {
            out.innerHTML = '<div class="empty">Looking up this wallet’s vault transactions…</div>';
            return;
        }
        if (who) {
            out.innerHTML = '<div class="empty">No vault transactions for this wallet were found yet. A funded offer keeps its facility id here after the mirror answers.</div>';
            return;
        }
        out.innerHTML = '<div class="empty fin-activity-empty">' +
            "<p>Activity is empty because no funding wallet is connected or watched. The facility id lives in that wallet’s vault call, not in this tab.</p>" +
            '<p class="fin-activity-actions">' +
            '<button type="button" class="primary" data-finance-connect>Connect wallet</button>' +
            "</p>" +
            '<form class="fin-activity-watch" data-finance-watch>' +
            '<label for="fin-activity-watch-input">Or watch the funding address</label>' +
            '<div class="fin-activity-watch-row">' +
            '<input id="fin-activity-watch-input" type="text" spellcheck="false" autocomplete="off" placeholder="0x… or 0.0.1234">' +
            '<button type="submit" class="dia">Look up</button>' +
            "</div></form></div>";
        return;
    }
    const list = '<div class="fin-activity-list">' + rows.map((row) => {
        const href = row.txHash ? financeExplorerLink(row.explorer || explorerTx(row.txHash), "Receipt") : "";
        return '<details class="fin-activity-item ' + esc(row.severity) + '">' +
            "<summary><strong>" + esc(row.title) + "</strong><time>" +
            esc(Venue.financeRelativeTime(row.ts)) + "</time></summary>" +
            (row.detail ? "<p>" + esc(row.detail) + "</p>" : "") +
            (row.facilityId
                ? '<p class="fin-activity-id"><code>' + esc(row.facilityId) +
                  '</code><button type="button" data-copy-facility="' +
                  esc(row.facilityId) + '">Copy id</button></p>'
                : "") +
            '<p class="utc">' + esc(new Date(row.ts).toISOString()) +
            (href ? " · " + href : "") + "</p></details>";
    }).join("") + "</div>";
    out.innerHTML = (Venue._financeRecovering
        ? '<p class="fin-activity-refresh">Refreshing wallet history.</p>'
        : "") + list;
};

Venue.paintFinanceBadge = function () {
    const badge = $("fin-activity-badge");
    const unread = Number(Venue.financeUiState().unread || 0);
    if (!badge) return;
    badge.hidden = unread <= 0;
    badge.textContent = unread > 9 ? "9+" : String(unread);
};

Venue.paintFinanceAlert = function (copy, tab) {
    const banner = $("fin-alert");
    const text = $("fin-alert-copy");
    const button = $("fin-alert-open");
    if (!banner) return;
    const message = copy || Venue.financeUiState().lastOracleImpact || "";
    banner.hidden = !message;
    if (text) text.textContent = message;
    if (button) {
        button.textContent = tab === "activity" ? "Open Activity" : "Open Audit";
        button.dataset = button.dataset || {};
        button.dataset.tab = tab || "audit";
    }
};

Venue.financeFlightOpen = function () {
    const flight = Venue.financeUiState().flight;
    return !!(flight && flight.action);
};

Venue.financeActionLabel = function (label) {
    const raw = String(label || "").toLowerCase();
    if (raw.includes("authorize") || raw.includes("collateral")) return "authorize collateral";
    if (raw.includes("accept")) return "accept financing";
    if (raw.includes("fund")) return "fund offer";
    if (raw.includes("cancel")) return "cancel offer";
    return raw || "transaction";
};

Venue.looksLikeRevertData = function (hex) {
    const raw = String(hex || "");
    if (!/^0x[0-9a-fA-F]+$/.test(raw)) return false;
    const n = raw.length - 2;
    if (n === 8) return true;
    if (n === 64) return false;
    return n > 8 && (n - 8) % 64 === 0;
};

Venue.financeRevertData = function (error) {
    const c = error?.info?.error?.data ?? error?.data ?? error?.error?.data ?? error?.receipt?.revertReason;
    const candidates = [];
    if (typeof c === "string") candidates.push(c);
    if (c && typeof c.data === "string") candidates.push(c.data);
    const msg = String(error?.shortMessage || error?.message || "");
    const matches = msg.match(/0x[0-9a-fA-F]{8,}/g) || [];
    for (const hex of [...candidates, ...matches]) {
        if (Venue.looksLikeRevertData(hex)) return hex.toLowerCase();
    }
    return "";
};

Venue.financeUnnamedApproveCopy =
    "Hedera rejected the collateral approval before a named error was returned.";
Venue.financeComplianceNotAllowedCopy =
    "ATS refused this approval. The vault is not admitted as a spender in the current KYC epoch.";

Venue.financeVaultApproveRefusedCopy = function (reason) {
    const why = JOURNAL_REASON[Number(reason)] || "";
    if (Number(reason) === 1 || /recipient/i.test(why)) {
        return Venue.financeComplianceNotAllowedCopy;
    }
    if (why) return "ATS refused this approval because " + why + ".";
    return Venue.financeComplianceNotAllowedCopy;
};

Venue.financeRevertIsNamed = function (decoded, error) {
    const parsed = decoded || {};
    const data = Venue.financeRevertData(error);
    const sel = String(parsed.selector || data.slice(0, 10) || "").toLowerCase();
    if (sel === "0xfc855b1b" || parsed.name === "InvalidKycStatus" || parsed.route) {
        return true;
    }
    if (sel === "0x66eb1b54" || parsed.name === "ComplianceNotAllowed") {
        return true;
    }
    const name = String(parsed.name || "");
    if (name && !/^0x[0-9a-fA-F]{8}$/.test(name)) return true;
    const message = String(parsed.message || error?.shortMessage || error?.message || "").trim();
    if (/missing revert data|CALL_EXCEPTION|without a reason|cannot estimate/i.test(message)) {
        return false;
    }
    if (/^0x[0-9a-fA-F]{8}$/.test(message) || /^0x[0-9a-fA-F]{8}$/.test(sel)) {
        return false;
    }
    return !!message && !/^0x[0-9a-fA-F]+$/.test(message);
};

Venue.financeReadableRevert = function (error, decoded) {
    const parsed = decoded || (typeof decodeRevert === "function"
        ? decodeRevert(error)
        : {message: String(error?.message || error || "")});
    const data = Venue.financeRevertData(error);
    const sel = String(parsed.selector || data.slice(0, 10) || "").toLowerCase();
    if (sel === "0xfc855b1b" || parsed.name === "InvalidKycStatus") {
        return "ATS refused this address. Prove eligibility first.";
    }
    if (sel === "0x66eb1b54" || parsed.name === "ComplianceNotAllowed") {
        return Venue.financeComplianceNotAllowedCopy;
    }
    const raw = String(parsed.message || error?.shortMessage || error?.message || "");
    if (/read only property/i.test(raw)) {
        return "The live quote could not be read. Refresh and try Accept again.";
    }
    if (/INSUFFICIENT_GAS|out of gas/i.test(raw) || parsed.name === "OutOfGas") {
        return "Accept ran out of gas creating the ATS hold. Refresh and try again.";
    }
    if (!Venue.financeRevertIsNamed(parsed, error)) {
        return Venue.financeUnnamedApproveCopy;
    }
    return String(parsed.message || error?.message || "Transaction failed.").slice(0, 400);
};

Venue.financeTxFailureDetail = function (extra) {
    const raw = extra && typeof extra === "object" ? (extra.message || extra.detail || "") : extra;
    const text = String(raw || "").trim();
    if (/^0x66eb1b54$/i.test(text) || /ComplianceNotAllowed/i.test(text)) {
        return Venue.financeComplianceNotAllowedCopy;
    }
    if (/^0x[0-9a-fA-F]{8}$/.test(text)) return Venue.financeUnnamedApproveCopy;
    return text.slice(0, 400);
};

Venue.financeTxAttemptDetail = function (action, stage, extra) {
    if (stage === "failed" || stage === "rejected") {
        const reason = Venue.financeTxFailureDetail(extra) || (
            stage === "rejected"
                ? "Wallet request rejected."
                : "Transaction failed."
        );
        if (action === "authorize collateral") {
            const lot = extra && typeof extra === "object" && extra.lot != null
                ? extra.lot
                : Venue.financePreview?.terms?.collateralAmount
                    ?? Venue.financePreview?.lot
                    ?? Venue.financePreview?.collateral;
            const attempt = lot != null && String(lot) !== ""
                ? "Authorize " + String(lot) + " LPRC to the vault."
                : "Authorize collateral to the vault.";
            return reason && reason !== attempt ? (attempt + " " + reason).slice(0, 400) : attempt;
        }
        return reason;
    }
    const lot = extra && typeof extra === "object" && extra.lot != null
        ? extra.lot
        : Venue.financePreview?.terms?.collateralAmount
            ?? Venue.financePreview?.lot
            ?? Venue.financePreview?.collateral;
    if (action === "authorize collateral") {
        return lot != null && String(lot) !== ""
            ? "Authorize " + String(lot) + " LPRC to the vault."
            : "Authorize collateral to the vault.";
    }
    if (action === "accept financing") {
        return "Accept this funded offer.";
    }
    return action + (stage === "approval"
        ? " needs a separate wallet confirmation."
        : stage === "pending"
            ? " is waiting on Hedera."
            : ".");
};

Venue.financeTxStageCopy = function (stage, action, extra) {
    if (stage === "approval") return "Waiting for wallet confirmation to " + action + ".";
    if (stage === "pending") return action + " submitted. Waiting for Hedera confirmation.";
    if (stage === "confirmed") return action + " confirmed.";
    if (stage === "rejected") return "Wallet request rejected for " + action + ".";
    const failure = Venue.financeTxFailureDetail(extra);
    return failure ? action + " failed. " + failure : action + " failed.";
};

Venue.paintFinanceTxStatus = function () {
    const state = Venue.financeUiState().txStatus || {};
    const copy = String(state.copy || "");
    const hash = /^0x[0-9a-fA-F]{64}$/.test(String(state.hash || "")) ? String(state.hash) : "";
    const live = $("fin-tx-live");
    if (live) live.textContent = copy;
    const status = $("fin-tx-status");
    if (!status) return;
    status.hidden = !copy;
    const href = hash ? financeExplorerLink(state.explorer || explorerTx(hash), "HashScan") : "";
    status.innerHTML = (copy ? esc(copy) : "") + (href ? " " + href : "");
};

Venue.recordFundedOfferAwaiting = function (id, offer) {
    if (!Venue.financeIdValid(id) || !offer || addrEq(offer.lender, ZERO)) return null;
    const lot = offer.terms?.collateralAmount ?? offer.collateralAmount ?? offer.collateral;
    const principal = offer.principal;
    Venue.rememberFinanceFacility(id, {
        accounts: [offer.lender, offer.borrower, Venue.financeViewerAccount()],
        role: Venue.financeRoleFor(offer.lender, offer.borrower),
    });
    return Venue.recordFinanceActivity({
        category: "facility",
        title: "Funded offer awaiting acceptance",
        detail: "Lender " + String(offer.lender || "") + " funded "
            + (lot != null && String(lot) !== "" ? String(lot) + " LPRC" : "the lot")
            + (principal != null ? " for " + formatHbar(asBig(principal)) + " HBAR" : "")
            + ". Borrower " + String(offer.borrower || "") + " can accept.",
        facilityId: id,
    }, {notify: false});
};

Venue.ingestSelectedFundedOffer = async function () {
    const id = Venue.financeUiState().selectedId;
    const vault = Venue.c?.vault;
    if (!Venue.financeIdValid(id) || typeof vault?.offers !== "function") return null;
    const offer = await vault.offers(id).catch(() => null);
    if (!offer || addrEq(offer.lender, ZERO)) return null;
    if (!Venue.namesFinanceViewer(offer.borrower) && !Venue.namesFinanceViewer(offer.lender)) {
        return null;
    }
    Venue.recordFundedOfferAwaiting(id, offer);
    return id;
};

Venue.financeTxStage = function (stage, label, extra) {
    if (Venue.page !== "repo") return;
    const detail = extra && typeof extra === "object" && !Array.isArray(extra)
        ? extra
        : {message: extra};
    const titles = {
        approval: "Wallet confirmation requested",
        pending: "Transaction submitted",
        confirmed: "Transaction confirmed",
        rejected: "Transaction rejected",
        failed: "Transaction failed",
    };
    const action = Venue.financeActionLabel(label || detail.label);
    const hash = /^0x[0-9a-fA-F]{64}$/.test(String(detail.hash || "")) ? String(detail.hash) : "";
    const facilityId = Venue.financeIdValid(detail.facilityId)
        ? String(detail.facilityId)
        : (Venue.financeUiState().selectedId || ($("fin-id")?.value || ""));
    const copy = Venue.financeTxStageCopy(stage, action, detail);
    const done = stage === "confirmed" || stage === "rejected" || stage === "failed";
    Venue.setFinanceUi({
        txStatus: {
            stage,
            label: action,
            action,
            copy,
            hash,
            facilityId,
            explorer: hash ? explorerTx(hash) : "",
        },
        flight: done ? null : {action, facilityId},
    });
    Venue.paintFinanceTxStatus();
    Venue.paintFinanceBusy(stage);
    Venue.recordFinanceActivity({
        action,
        category: stage === "approval" ? "wallet" : "transaction",
        severity: stage === "failed" ? "error" : stage === "rejected" ? "warning" : "info",
        title: titles[stage] || action,
        status: stage,
        detail: Venue.financeTxAttemptDetail(action, stage, detail),
        facilityId,
        txHash: hash,
        explorer: hash ? explorerTx(hash) : "",
    });
    if (typeof Venue.toast === "function"
        && (stage === "approval" || stage === "pending" || stage === "confirmed")) {
        Venue.toast(copy);
    }
};

Venue.paintFinanceBusy = function (stage) {
    const flight = Venue.financeUiState().flight;
    const active = stage === "approval" || stage === "pending"
        || ((stage == null || stage === undefined) && !!flight);
    const ids = ["fin-fund", "fin-review", "fin-accept", "fin-cancel", "fin-withdraw"];
    for (const id of ids) {
        const el = $(id);
        if (!el) continue;
        if (active) {
            if (el.dataset && el.dataset.finWasDisabled == null) {
                el.dataset.finWasDisabled = el.disabled ? "1" : "0";
            }
            el.disabled = true;
            if (typeof el.setAttribute === "function") el.setAttribute("aria-busy", "true");
        } else {
            if (typeof el.removeAttribute === "function") el.removeAttribute("aria-busy");
            if (el.dataset?.finWasDisabled === "0") el.disabled = false;
            if (el.dataset) delete el.dataset.finWasDisabled;
        }
    }
    const nodes = typeof document !== "undefined" && document.querySelectorAll
        ? document.querySelectorAll("[data-fin-action]")
        : [];
    nodes.forEach((action) => {
        if (active) {
            if (action.dataset && action.dataset.finWasDisabled == null) {
                action.dataset.finWasDisabled = action.disabled ? "1" : "0";
            }
            action.disabled = true;
            if (typeof action.setAttribute === "function") action.setAttribute("aria-busy", "true");
            return;
        }
        if (typeof action.removeAttribute === "function") action.removeAttribute("aria-busy");
        if (action.dataset?.finWasDisabled === "0") action.disabled = false;
        if (action.dataset) delete action.dataset.finWasDisabled;
    });
};

Venue.bindFinanceDrawer = function () {
    const drawer = $("fin-drawer");
    const backdrop = $("fin-drawer-backdrop");
    if (!drawer) return;
    $("fin-drawer-close")?.addEventListener("click", () => Venue.closeFinanceDrawer());
    backdrop?.addEventListener("click", () => Venue.closeFinanceDrawer());
    $("fin-tab-activity")?.addEventListener("click", () => Venue.setFinanceDrawerTab("activity"));
    $("fin-tab-audit")?.addEventListener("click", () => Venue.setFinanceDrawerTab("audit"));
    $("fin-alert-open")?.addEventListener("click", () => {
        Venue.openFinanceDrawer($("fin-alert-open")?.dataset?.tab || "audit");
    });
    document.addEventListener("keydown", (event) => {
        if (!Venue.financeUiState().drawerOpen) return;
        if (event.key === "Escape") {
            event.preventDefault();
            Venue.closeFinanceDrawer();
            return;
        }
        if (event.key !== "Tab") return;
        const nodes = Venue.financeDrawerFocusable();
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
    });
};

Venue.financeDrawerFocusable = function () {
    const drawer = $("fin-drawer");
    if (!drawer) return [];
    return [...drawer.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    )].filter((node) => !node.hidden && node.offsetParent !== null);
};

Venue.setFinanceDrawerTab = function (tab) {
    const next = tab === "audit" ? "audit" : "activity";
    Venue.setFinanceUi({drawerTab: next});
    const activity = $("fin-activity-panel");
    const audit = $("fin-audit");
    const activityTab = $("fin-tab-activity");
    const auditTab = $("fin-tab-audit");
    const title = $("fin-drawer-title");
    if (activity) activity.hidden = next !== "activity";
    if (audit) audit.hidden = next !== "audit";
    if (activityTab) activityTab.setAttribute("aria-selected", next === "activity" ? "true" : "false");
    if (auditTab) auditTab.setAttribute("aria-selected", next === "audit" ? "true" : "false");
    if (title) title.textContent = next === "audit" ? "Audit" : "Activity";
    const status = $("fin-drawer-status");
    if (status) {
        status.textContent = next === "audit"
            ? "Full oracle diagnostics, wiring, and verified receipts."
            : "Newest transaction stages and selected-facility events first.";
    }
    if (next === "activity") {
        Venue.recoverViewerFinanceHistory().catch(() => []);
    }
};

Venue.openFinanceDrawer = function (tab, opts) {
    const drawer = $("fin-drawer");
    const backdrop = $("fin-drawer-backdrop");
    if (!drawer) return;
    Venue._financeDrawerOpener = document.activeElement;
    Venue.setFinanceUi({drawerOpen: true, unread: 0});
    Venue.setFinanceDrawerTab(tab || Venue.financeUiState().drawerTab);
    drawer.hidden = false;
    if (backdrop) backdrop.hidden = false;
    document.documentElement.classList.add("fin-drawer-open");
    $("fin-open-activity")?.setAttribute("aria-expanded", "true");
    $("fin-open-evidence")?.setAttribute("aria-expanded", "true");
    Venue.paintFinanceBadge();
    const status = $("fin-drawer-status");
    if (status) status.textContent = "Drawer opened. Escape closes it.";
    const groupId = opts?.group;
    if (groupId && $(groupId)) {
        $(groupId).open = true;
        if (typeof $(groupId).scrollIntoView === "function") {
            $(groupId).scrollIntoView({block: "start"});
        }
    }
    (Venue.financeDrawerFocusable()[0] || $("fin-drawer-close"))?.focus();
    if ((tab || Venue.financeUiState().drawerTab) !== "audit") {
        return Venue.recoverViewerFinanceHistory().catch(() => []);
    }
};

Venue.closeFinanceDrawer = function () {
    const drawer = $("fin-drawer");
    const backdrop = $("fin-drawer-backdrop");
    if (!drawer) return;
    Venue.setFinanceUi({drawerOpen: false});
    drawer.hidden = true;
    if (backdrop) backdrop.hidden = true;
    document.documentElement.classList.remove("fin-drawer-open");
    $("fin-open-activity")?.setAttribute("aria-expanded", "false");
    $("fin-open-evidence")?.setAttribute("aria-expanded", "false");
    const opener = Venue._financeDrawerOpener;
    Venue._financeDrawerOpener = null;
    if (opener && typeof opener.focus === "function") opener.focus();
};

Venue.oracleImpactSummary = function (failureParts, extra) {
    const parts = failureParts || [];
    if (extra?.rpc) {
        return "Quotes and coverage checks are unavailable until the oracle can be read. Refresh the feed.";
    }
    if (parts.some((part) => /Panel stale/i.test(part))) {
        return "The bond-price panel is stale, so new quotes and margin marks are blocked. Refresh after a publisher answers.";
    }
    if (parts.some((part) => /HBAR rate stale/i.test(part))) {
        return "The HBAR conversion feed is stale, so collateral value cannot be quoted. Refresh after the cash adapter updates.";
    }
    if (parts.some((part) => /Open panel read failed/i.test(part))) {
        return "The open publisher panel could not be read, so quote readiness is unknown. Refresh the feed.";
    }
    if (parts.some((part) => /HCS evidence/i.test(part))) {
        return "Publisher evidence could not be verified. Pricing may still be live; open Audit for the full trail.";
    }
    if (parts.some((part) => /Scheduler RPC/i.test(part))) {
        return "Oracle automation status is unknown. Refresh the feed or open Audit for scheduler details.";
    }
    if (parts.some((part) => /Scheduler not deployed/i.test(part))) {
        return "Oracle automation is not deployed. Live marks still come from the panel; open Audit for details.";
    }
    if (parts.length) {
        return "The financing feed needs attention. Open Audit for the full diagnostic.";
    }
    return "";
};

Venue.paintOracleImpact = function (failureParts, extra) {
    const impact = Venue.oracleImpactSummary(failureParts, extra);
    const impactEl = $("feed-impact");
    if (impactEl) impactEl.textContent = impact;
    Venue.setFinanceUi({lastOracleImpact: impact});
    if (impact && Venue.page === "repo") {
        Venue.paintFinanceAlert(impact, "audit");
        if (!Venue.financeUiState().drawerOpen && impact !== Venue._financeImpactSeen) {
            Venue.setFinanceUi({unread: Venue.financeUiState().unread + 1});
            Venue._financeImpactSeen = impact;
            Venue.paintFinanceBadge();
        }
    } else if (Venue.page === "repo" && !impact) {
        const banner = $("fin-alert");
        if (banner && !$("fin-alert-copy")?.textContent) banner.hidden = true;
    }
};

Venue.shareFinanceId = async function () {
    const value = Venue.ensureFinanceId(false);
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error("Create or enter a valid facility id before sharing it.");
    }
    const url = (typeof location !== "undefined" ? location.origin + location.pathname : "") +
        "?facility=" + value;
    if (typeof navigator !== "undefined" && navigator.share) {
        try {
            await navigator.share({title: "Lattice financing facility", text: value, url});
            return;
        } catch (error) {
            if (error?.name === "AbortError") return;
        }
    }
    await navigator.clipboard.writeText(url || value);
    const button = $("fin-id-share");
    if (button) {
        button.textContent = "Shared";
        setTimeout(() => {
            if ($("fin-id-share")) $("fin-id-share").textContent = "Share";
        }, 1_200);
    }
};

Venue.paintFinancingEvidence = function () {
    const out = $("fin-evidence");
    if (!out) return;
    const evidence = typeof FINANCING_EVIDENCE === "undefined"
        ? {} : FINANCING_EVIDENCE;
    const automatic = evidence?.automatic;
    const production = evidence?.production;
    const lifecycle = evidence?.lifecycle;
    if (!automatic && !production && !lifecycle) {
        out.innerHTML = '<div class="empty">No verified financing run is bundled yet.</div>';
        return;
    }

    const txLinks = (receipts, labels) => labels
        .filter(([key]) => receipts?.[key]?.tx)
        .map(([key, label]) => {
            const row = receipts[key];
            const url = row.hashscan ||
                CLIENT.network.explorer + "/transaction/" + row.tx;
            return '<a class="chip" target="_blank" rel="noopener noreferrer" href="' +
                esc(url) + '">' + esc(label) + "</a>";
        }).join("");

    const cards = [];
    if (automatic) {
        const cash = automatic.cash || {};
        const settlement = automatic.automaticSettlement || {};
        const vault = automatic.vault || {};
        const vaultId = vault.contractId || vault.address || "";
        const vaultLink = vaultId
            ? '<a target="_blank" rel="noopener noreferrer" href="' +
            esc(CLIENT.network.explorer + "/contract/" + vaultId) + '">' +
            esc(vaultId) + "</a>"
            : "Unavailable";
        const hssLink = settlement.hashscan
            ? '<a class="chip" target="_blank" rel="noopener noreferrer" href="' +
            esc(settlement.hashscan) + '">automatic HSS success</a>'
            : "";
        cards.push(
            '<div class="wire" style="margin-bottom:1rem">' +
            '<div class="wcell"><span class="k">Current production vault</span>' +
            '<span class="v">' + vaultLink +
            '</span><span class="n">Live binding · automatic settlement</span></div>' +
            '<div class="wcell"><span class="k">Funded canary</span><span class="v">' +
            esc(shortId(automatic.id || "")) +
            '</span><span class="n">' +
            esc(readableHbar(asBig(cash.principalTinybar || 0))) +
            ' HBAR principal · hold released</span></div>' +
            '<div class="wcell"><span class="k">Automatic settlement</span>' +
            '<span class="v ok">' + esc(settlement.result || "Unavailable") +
            '</span><span class="n">HSS expiry = economic due + ' +
            esc(settlement.executionDelaySeconds || "0") +
            ' s · no fallback receipt</span></div>' +
            '<div class="wcell"><span class="k">Clock check</span><span class="v num">' +
            esc(settlement.evmBlockTimestamp || "") +
            '</span><span class="n">EVM timestamp at economic due · obligation SETTLED</span>' +
            "</div></div>" +
            '<div class="picks" style="margin-bottom:1.4rem">' +
            txLinks(automatic.receipts, [
                ["fundOffer", "Fund offer"],
                ["accept", "Accept and hold"],
                ["withdrawBorrower", "Borrower cash"],
                ["close", "Close and release"],
                ["withdrawLender", "Lender cash"],
            ]) + hssLink + "</div>"
        );
    }
    if (production) {
        const cash = production.cash || {};
        const boundary = production.hssBoundary || {};
        const scheduled = boundary.scheduledExecution || {};
        const boundaryCell = boundary.manualFallback
            ? '<div class="wcell"><span class="k">HSS maturity</span>' +
            '<span class="v">Fallback settled</span>' +
            '<span class="n">scheduled call met a 1 s EVM clock boundary</span></div>'
            : "";
        const scheduledLink = scheduled.hashscan
            ? '<a class="chip" target="_blank" rel="noopener noreferrer" href="' +
            esc(scheduled.hashscan) + '">HSS boundary receipt</a>'
            : "";
        cards.push(
            '<div class="wire" style="margin-bottom:1rem">' +
            '<div class="wcell"><span class="k">Historical facility</span><span class="v">' +
            esc(shortId(production.id || "")) +
            '</span><span class="n">superseded live binding · exact-due boundary</span></div>' +
            '<div class="wcell"><span class="k">Principal moved</span><span class="v num">' +
            esc(readableHbar(asBig(cash.principalTinybar || 0))) +
            ' HBAR</span><span class="n">lender deposit, borrower withdrawal</span></div>' +
            '<div class="wcell"><span class="k">Close paid</span><span class="v num">' +
            esc(readableHbar(asBig(cash.closePaidTinybar || 0))) +
            ' HBAR</span><span class="n">hold released, lender credited</span></div>' +
            '<div class="wcell"><span class="k">Assertions</span><span class="v">Passed</span>' +
            '<span class="n">cash round trip · hold created and released</span></div>' +
            boundaryCell + "</div>" +
            '<div class="picks" style="margin-bottom:1.4rem">' +
            txLinks(production.receipts, [
                ["fundOffer", "Fund offer"],
                ["approveCollateral", "Authorize collateral"],
                ["accept", "Accept and hold"],
                ["withdrawBorrower", "Borrower cash"],
                ["close", "Close and release"],
                ["withdrawLender", "Lender cash"],
                ["settleFailFallback", "Maturity fallback"],
            ]) + scheduledLink + "</div>"
        );
    }
    if (lifecycle) {
        const p1 = lifecycle.position1 || {};
        const p2 = lifecycle.position2 || {};
        const demo = lifecycle.deployment?.contracts || {};
        const executed = lifecycle.collateral?.executedToLender || "0";
        const fallback = lifecycle.hssFallback?.unscheduled || {};
        const fallbackCopy = [fallback.fail?.meaning, fallback.coupon?.meaning]
            .filter(Boolean).join(" + ") || "manual fallback";
        const contract = (name, label) => {
            const row = demo[name];
            if (!row) return esc(label) + " unavailable";
            const id = row.contractId || row.address;
            return '<a target="_blank" rel="noopener noreferrer" href="' +
                esc(CLIENT.network.explorer + "/contract/" + id) + '">' +
                esc(label) + "</a>";
        };
        cards.push(
            '<div class="wire" style="margin-bottom:1rem">' +
            '<div class="wcell"><span class="k">Compressed demo</span><span class="v">' +
            contract("RepoVault", "Demo vault") + " · " +
            contract("MarginWatch", "Demo watcher") +
            '</span><span class="n">separate from the production binding</span></div>' +
            '<div class="wcell"><span class="k">Margin route</span><span class="v">' +
            esc(shortId(p1.id || "")) +
            '</span><span class="n">call · add collateral · cure · close</span></div>' +
            '<div class="wcell"><span class="k">Fail route</span><span class="v">' +
            esc(shortId(p2.id || "")) +
            '</span><span class="n">coupon ' +
            esc(p2.couponOwedSmallestCashUnits || "0") + " · penalty " +
            esc(p2.penaltyTinybar || "0") + " tinybar · " +
            esc(executed) + " LPRC executed</span></div>" +
            '<div class="wcell"><span class="k">Compressed clocks</span><span class="v num">' +
            "5 min cure · 2 min fail grace" +
            '</span><span class="n">testnet only · HSS ' +
            esc(fallbackCopy) + "</span></div></div>" +
            '<div class="picks">' +
            txLinks(lifecycle.receipts, [
                ["position1-fund", "Margin offer"],
                ["position1-accept", "Margin accept"],
                ["position1-mark", "Mark posted"],
                ["position1-add-collateral", "Collateral added"],
                ["position1-cure", "Cure"],
                ["position1-close", "Cure route close"],
                ["position2-fund", "Default offer"],
                ["position2-accept", "Default accept"],
                ["position2-note-coupon", "Coupon noted"],
                ["position2-mark-failing", "Marked failing"],
                ["position2-declare-default", "Declare default"],
                ["position2-settle-default", "Settle default"],
            ]) + "</div>"
        );
    }
    out.innerHTML = cards.join("");
};

Venue.copyKnownFinanceId = async function (id, button) {
    const value = String(id || "").trim();
    if (!Venue.financeIdValid(value)) {
        throw new Error("Create or enter a valid facility id before copying it.");
    }
    try {
        await navigator.clipboard.writeText(value);
    } catch {
        const input = $("fin-id");
        if (input) {
            input.value = value;
            input.focus();
            input.select();
        }
        if (!document.execCommand("copy")) {
            throw new Error("Could not copy the facility id.");
        }
    }
    if (button) {
        const prior = button.textContent;
        button.textContent = "Copied";
        setTimeout(() => {
            if (button.textContent === "Copied") button.textContent = prior || "Copy id";
        }, 1_200);
    }
    return value;
};

Venue.copyFinanceId = async function () {
    const value = await Venue.copyKnownFinanceId(($("fin-id")?.value || "").trim(), $("fin-id-copy"));
    const button = $("fin-id-copy");
    if (button) button.textContent = "Copied";
    return value;
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
    if (wizard && !$("fin-create")) wizard.hidden = !ready;
    for (const id of ["fin-fund", "fin-accept", "fin-cancel", "fin-withdraw", "fin-quote", "fin-review"]) {
        const el = $(id);
        if (!el) continue;
        if (id === "fin-quote") el.disabled = !ready;
        else if (id === "fin-review") {
            el.disabled = !ready || !($("fin-borrower")?.value || "").trim()
                || !($("fin-lot")?.value || "").trim();
        } else if (!ready) el.disabled = true;
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

Venue.financeTermsForQuote = function (terms) {
    if (!terms) return terms;
    const word = (field, fallback = 0n) => {
        const raw = terms[field];
        return raw == null || raw === "" ? fallback : asBig(raw);
    };
    return {
        partition: String(terms.partition ?? ""),
        collateralAmount: word("collateralAmount"),
        haircutBps: Number(word("haircutBps")),
        maintenanceBps: Number(word("maintenanceBps")),
        repoRateBps: word("repoRateBps"),
        term: word("term"),
    };
};

Venue.financeQuoteMessage = function (error) {
    if (!error) return "";
    const decoded = decodeRevert(error);
    if (decoded.name === "FeedIsDark" || error.name === "FeedIsDark") {
        return "Coverage cannot be evaluated because the feed is dark.";
    }
    const message = String(decoded.message || error.message || "");
    if (!message || error.name === "TypeError" ||
        /read only property|is not a function/i.test(message)) {
        return "";
    }
    return message;
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
    const previewGen = (Venue._financePreviewToken = (Venue._financePreviewToken || 0) + 1);
    Venue.ensureFinanceId(false);
    const out = $("fin-preview");
    let id;
    try {
        id = financeId();
    } catch (e) {
        Venue.paintFinanceQuote({error: e.message});
        if (out && !$("fin-quote-heading")) {
            out.innerHTML = '<div class="empty">' + esc(e.message) + "</div>";
        }
        for (const id of ["fin-fund", "fin-accept", "fin-cancel"]) {
            if ($(id)) $(id).disabled = true;
        }
        return null;
    }
    const borrowerRaw = ($("fin-borrower")?.value || "").trim();
    const lotRaw = ($("fin-lot")?.value || "").trim();
    const incomplete = !borrowerRaw || !lotRaw;
    Venue.paintFinanceQuote({checking: true});

    const {vault, oracle, token, registry} = Venue.c;
    const [offer, state] = await Promise.all([
        vault.offers(id),
        vault.stateOf(id),
    ]);
    if (previewGen !== Venue._financePreviewToken) return Venue.financePreview || null;
    const hasOffer = !addrEq(offer.lender, ZERO);
    if (hasOffer && $("fin-borrower")) $("fin-borrower").value = offer.borrower;
    if (!hasOffer && incomplete) {
        Venue.paintFinanceQuote({incomplete: true});
        if ($("fin-review")) $("fin-review").disabled = true;
        if ($("fin-fund")) $("fin-fund").disabled = true;
        return null;
    }
    let draft;
    try {
        draft = hasOffer
            ? {
                id,
                borrower: offer.borrower,
                terms: Venue.financeTermsForQuote(offer.terms),
                expiresAt: asBig(offer.expiresAt),
                days: asBig(offer.terms.term) / 86_400n,
                hours: 0n,
            }
            : Venue.financeDraft();
    if (draft?.terms) draft.terms = Venue.financeTermsForQuote(draft.terms);
    } catch (e) {
        Venue.paintFinanceQuote({error: e.message});
        if (out && !$("fin-quote-heading")) {
            out.innerHTML = '<div class="empty">' + esc(e.message) + "</div>";
        }
        for (const id of ["fin-fund", "fin-accept", "fin-cancel"]) {
            if ($(id)) $(id).disabled = true;
        }
        return null;
    }

    let livePrincipal = null;
    let quoteError = "";
    try {
        livePrincipal = asBig(await vault.quotePrincipal(Venue.financeTermsForQuote(draft.terms)));
    } catch (e) {
        quoteError = Venue.financeQuoteMessage(e);
    }
    const principal = hasOffer ? asBig(offer.principal) : livePrincipal;
    const who = Venue.viewer();
    const collateralOwner = hasOffer ? offer.borrower : draft.borrower;
    const account = Venue.account;
    const lender = hasOffer ? offer.lender : account;
    const [markPerUnit, free, credit, allowance, borrowerKyc, lenderKyc] = await Promise.all([
        oracle.markPerUnitTinybar().catch(() => null),
        token.balanceOfByPartition(draft.terms.partition, collateralOwner).catch(() => null),
        who ? Venue.financeViewerCredit() : null,
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
    if (previewGen !== Venue._financePreviewToken) return Venue.financePreview || null;
    const isLender = !!account && hasOffer && Venue.sameHederaAccount(account, offer.lender);
    const isBorrower = !!account && hasOffer && Venue.sameHederaAccount(account, offer.borrower);
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
    const feedHealth = /feed is dark/i.test(quoteError)
        ? "blocked"
        : markPerUnit == null
            ? "unavailable"
            : "live";
    const borrowerEligibility = borrowerKyc === null ? "unavailable" : borrowerEligible ? "granted" : "not granted";
    const lenderEligibility = lenderKyc === null ? "unavailable" : lenderEligible ? "granted" : "not granted";
    const quoteReady = principal != null && principal !== 0n &&
        borrowerEligible && lenderEligible && feedHealth === "live" && !repriced;
    let statusKind = "blocked";
    let statusLabel = "Blocked";
    if (hasOffer && repriced) {
        statusKind = "blocked";
        statusLabel = "Quote moved since funding";
    } else if (hasOffer) {
        statusKind = quoteReady ? "ready" : "blocked";
        statusLabel = "Existing offer loaded";
    } else if (feedHealth === "blocked") {
        statusLabel = "Feed unavailable";
    } else if (feedHealth === "unavailable") {
        statusLabel = "RPC unavailable";
    } else if (quoteReady && !quoteError) {
        statusKind = "ready";
        statusLabel = "Ready to review";
    }
    Venue.paintFinanceQuote({
        lot,
        principal,
        repay,
        maturityText: financeAt(projectedMaturity),
        rate: draft.terms.repoRateBps,
        haircut: draft.terms.haircutBps,
        maintenance: draft.terms.maintenanceBps,
        feedHealth,
        borrowerEligibility,
        lenderEligibility,
        quoteError,
        ready: quoteReady && !quoteError,
        statusKind,
        statusLabel,
        details: {
            id,
            borrower: draft.borrower,
            lender: lender || "",
            free: freeText,
            allowance: allowance == null ? "Unavailable" : String(allowance) + " LPRC",
            mark: markPerUnit,
            expiry: financeAt(draft.expiresAt),
        },
        readyCopy: quoteError
            ? quoteError
            : repriced
                ? "The live quote moved since funding. The lender must cancel and reprice."
                : hasOffer
                    ? "This facility already has a funded offer."
                    : quoteReady
                        ? "Ready to review. All checks passed."
                        : !borrowerEligible || !lenderEligible
                            ? "Eligibility is still required before review."
                            : feedHealth !== "live"
                                ? "The feed must be live before a reviewable quote can settle."
                                : "Complete a valid borrower and lot to review.",
    });

    const reviewing = Venue.financeUiState().reviewStage === "review";
    if (reviewing) {
        Venue.paintFinanceReview({
            ...draft,
            principal,
            repay,
            hasOffer,
            lender,
        });
    }
    const fundReady = !!account && !addrEq(account, draft.borrower) && !hasOffer &&
        Number(state) === 0 && principal !== null && principal !== 0n &&
        borrowerEligible && lenderEligible;
    if ($("fin-fund")) {
        $("fin-fund").disabled = !reviewing || !fundReady;
    }
    if ($("fin-review")) {
        $("fin-review").disabled = !Venue.financing?.ready || !draft.borrower || lot === 0n;
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
        repay,
        hasOffer,
        lender,
        borrowerEligible,
        lenderEligible,
        enoughAllowance,
        enoughCollateral,
        expired,
        repriced,
        credit,
        freeText,
        markPerUnit,
    };
    Venue.setFinanceUi({
        readiness: {
            fundReady,
            reviewing,
            borrowerEligible,
            lenderEligible,
            enoughAllowance,
            enoughCollateral,
            expired,
            repriced,
        },
    });
    return Venue.financePreview;
};

Venue.doFundOffer = async function () {
    await Venue.requireAccount();
    if ($("fin-review-panel") && Venue.financeUiState().reviewStage !== "review") {
        throw new Error("Review the offer before funding.");
    }
    const reviewed = Venue.financeUiState().reviewedPrincipal;
    const draft = await Venue.previewFinance();
    if (!draft) throw new Error("A live quote is required before funding.");
    if (draft.hasOffer) throw new Error("This facility id already has a funded offer.");
    if (draft.principal === null) throw new Error("The live vault did not return a principal.");
    if (!draft.borrowerEligible || !draft.lenderEligible) {
        throw new Error("Both borrower and lender need current eligibility before funding.");
    }
    if (reviewed && String(draft.principal) !== String(reviewed)) {
        Venue.setFinanceUi({reviewStage: "review"});
        Venue.paintFinanceReviewMode(true);
        Venue.paintFinanceReview(draft);
        if ($("fin-fund")) $("fin-fund").disabled = true;
        throw new Error("The live quote moved since review. Edit the terms or review again.");
    }
    const value = toWeibar(draft.principal);
    const call = Venue.w.vault.fundOffer;
    await call.staticCall(draft.id, draft.borrower, draft.terms, draft.expiresAt, {value});
    const receipt = await Venue.send(
        () => call(
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
    if ($("fin-id")) $("fin-id").value = draft.id;
    Venue.setFinanceUi({selectedId: draft.id, reviewStage: "draft"});
    Venue.setFinanceView("manage");
    Venue.rememberFinanceFacility(draft.id, {
        accounts: [Venue.account, draft.borrower, ...Venue.viewerAliasList()],
        role: "lender",
    });
    await Venue.noteReceipt(
        "offer funded", receipt, 14, G.PRED, T.IMM, "vault", "OfferFunded"
    ).catch(() => {});
    Venue.recordFinanceActivity({
        category: "transaction",
        title: "Offer funded",
        detail: "Exact principal was deposited for the named borrower.",
        facilityId: draft.id,
        txHash: receipt.hash || receipt.transactionHash,
        explorer: explorerTx(receipt.hash || receipt.transactionHash || ""),
    });
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

    const journal = Venue.c?.journal;
    const seated = token && typeof token.compliance === "function"
        ? await token.compliance()
        : "";
    const journalAddr = CLIENT.addresses?.SeamJournal || "";
    const journalIsSeated = !seated || !journalAddr || addrEq(seated, journalAddr);
    if (journalIsSeated && journal && typeof journal.explain === "function") {
        const explained = await journal.explain(Venue.account, vaultAddress, 0n);
        const ok = explained && typeof explained === "object" && "0" in explained
            ? explained[0]
            : explained;
        const reason = explained && typeof explained === "object" && "1" in explained
            ? explained[1]
            : 0;
        if (!ok) {
            throw new Error(Venue.financeVaultApproveRefusedCopy(reason));
        }
    }

    const approve = writer.approve;
    try {
        await approve.staticCall(vaultAddress, required);
    } catch (error) {
        const decoded = typeof decodeRevert === "function" ? decodeRevert(error) : {message: String(error?.message || error || "")};
        if (Venue.financeRevertIsNamed(decoded, error)) {
            throw new Error(Venue.financeReadableRevert(error, decoded));
        }
    }
    const receipt = await Venue.send(
        () => approve(vaultAddress, required, {gasLimit: 350_000}),
        "authorize collateral",
    );
    if (!receipt) throw new Error("Collateral authorization was not confirmed.");

    const after = asBig(await token.allowance(Venue.account, vaultAddress));
    if (after < required) {
        throw new Error("ATS recorded less collateral authorization than this offer requires.");
    }
    Venue.recordFinanceActivity({
        category: "transaction",
        title: "Collateral approved",
        detail: "The borrower authorized the exact collateral lot. Acceptance still needs its own confirmation.",
        facilityId: Venue.financeUiState().selectedId || ($("fin-id")?.value || ""),
        txHash: receipt.hash || receipt.transactionHash,
        explorer: explorerTx(receipt.hash || receipt.transactionHash || ""),
    });
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
        const terms = Venue.financeTermsForQuote(offer.terms);
        const [borrowerKyc, lenderKyc, livePrincipal, freeCollateral] = await Promise.all([
            Venue.c.registry.getKycStatus(offer.borrower),
            Venue.c.registry.getKycStatus(offer.lender),
            Venue.c.vault.quotePrincipal(terms),
            Venue.c.token.balanceOfByPartition(terms.partition, Venue.account),
        ]);
        if (Number(borrowerKyc) !== 1 || Number(lenderKyc) !== 1) {
            throw new Error(
                "Both borrower and lender need current eligibility before acceptance.",
            );
        }
        if (asBig(livePrincipal) !== asBig(offer.principal)) {
            throw new Error(
                "The live quote is " + formatHbar(asBig(livePrincipal)) +
                " HBAR; funded principal is " + formatHbar(asBig(offer.principal)) +
                " HBAR. The lender must cancel and reprice.",
            );
        }
        if (asBig(freeCollateral) < asBig(terms.collateralAmount)) {
            throw new Error("The borrower does not have the required free collateral lot.");
        }
        const allowance = typeof Venue.c.token.allowance === "function"
            ? asBig(await Venue.c.token.allowance(Venue.account, CLIENT.addresses.RepoVault))
            : 0n;
        if (allowance < asBig(terms.collateralAmount)) {
            throw new Error("Authorize the collateral lot first. Acceptance is a separate wallet confirmation.");
        }

        const call = Venue.w.vault.accept;
        await call.staticCall(id);
        const receipt = await Venue.send(
            () => call(id, {gasLimit: 4_000_000}),
            "accept financing",
        );
        if (!receipt) return;
        if ($("repo-id")) $("repo-id").value = id;
        Venue.rememberFinanceFacility(id, {
            accounts: [offer.lender, offer.borrower, Venue.account, ...Venue.viewerAliasList()],
            role: "borrower",
        });
        Venue.recordFinanceActivity({
            category: "transaction",
            title: "Offer accepted",
            detail: "The borrower accepted the funded offer and locked the lot.",
            facilityId: id,
            txHash: receipt.hash || receipt.transactionHash,
            explorer: explorerTx(receipt.hash || receipt.transactionHash || ""),
        });
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
    const receipt = await Venue.send(
        () => call(id, {gasLimit: 350_000}),
        "cancel offer",
    );
    if (!receipt) return;
    await Venue.noteReceipt(
        "offer cancelled", receipt, 14, G.PRED, T.IMM, "vault", "OfferCancelled"
    ).catch(() => {});
    await Venue.previewFinance();
    if ($("fin-withdraw")) $("fin-withdraw").disabled = false;
};

Venue.financeActions = function (ctx) {
    const role = ctx.role || Venue.financeRoleFor(ctx.lender, ctx.borrower);
    const canSign = Venue.financeCanSign();
    const stateNo = Number(ctx.stateNo || 0);
    const alert = ctx.alert || {};
    const more = [];
    let primary = null;
    const acceptStage = Venue.financeUiState().acceptStage || "idle";
    if (ctx.kind === "offer") {
        if (canSign && role === "borrower" && !ctx.expired) {
            if (ctx.repriced) {
                primary = {id: "none", label: "Quote moved since funding", disabled: true};
            } else if (acceptStage === "idle") {
                primary = {id: "accept-review", label: "Review acceptance"};
            } else if (!ctx.enoughAllowance) {
                primary = {id: "approve", label: "Approve collateral"};
            } else {
                primary = {id: "accept", label: "Accept offer"};
            }
        } else if (canSign && role === "lender") {
            primary = {id: "cancel", label: ctx.expired ? "Cancel expired offer" : "Cancel unused offer"};
        }
        if (canSign && role === "borrower" && !ctx.expired && acceptStage !== "idle") {
            more.push({id: "accept-back", label: "Edit review"});
        }
        if (canSign && asBig(ctx.credit || 0n) > 0n) {
            more.push({id: "withdraw", label: "Withdraw financing cash"});
        }
        return {primary, more, role, canSign};
    }
    if (alert.defaultable && [3, 5].includes(stateNo) && canSign) {
        primary = {id: "declare", label: "Declare default"};
    } else if (stateNo === 6 && canSign) {
        primary = {
            id: "execute",
            label: ctx.lenderEligible ? "Execute collateral to lender" : "Lender must renew eligibility",
            disabled: !ctx.lenderEligible,
        };
    } else if (stateNo === 3 && !alert.cureExpired && ctx.mk && !ctx.mk.dark && !ctx.mk.breach && canSign) {
        primary = {id: "cure", label: "Cure (feed shows coverage)"};
    } else if (role === "borrower" && [2, 3].includes(stateNo) && alert.called && canSign) {
        primary = {
            id: "add",
            label: ctx.borrowerEligible ? "Add collateral" : "Renew eligibility to add collateral",
            disabled: !ctx.borrowerEligible,
        };
    } else if (role === "borrower" && [2, 3, 5].includes(stateNo) && ctx.price != null && canSign) {
        const due = asBig(ctx.price) + asBig(ctx.penalty ?? 0n);
        primary = {id: "close", label: "Repay " + formatHbar(due) + " HBAR and release"};
    } else if (canSign && asBig(ctx.credit || 0n) > 0n) {
        primary = {id: "withdraw", label: "Withdraw financing cash"};
    } else if (canSign && (ctx.schedules || []).some((entry) =>
        Number(entry.obligation?.status) === 1 && asBig(entry.obligation.dueAt) <= nowSec()
    )) {
        const due = (ctx.schedules || []).find((entry) =>
            Number(entry.obligation?.status) === 1 && asBig(entry.obligation.dueAt) <= nowSec());
        primary = {id: "settle", label: "Process settlement", reference: due.id};
    } else if ([2, 3].includes(stateNo) && ctx.mk && !ctx.mk.dark && canSign) {
        primary = {
            id: "mark",
            label: ctx.mk.breach ? "Record margin shortfall" : "Check margin on-chain",
        };
    }
    if (role === "borrower" && [2, 3, 5].includes(stateNo) && ctx.price != null && primary?.id !== "close") {
        const due = asBig(ctx.price) + asBig(ctx.penalty ?? 0n);
        more.push({id: "close", label: "Repay " + formatHbar(due) + " HBAR and release"});
    }
    if (role === "borrower" && [2, 3].includes(stateNo) && (stateNo !== 3 || !alert.cureExpired) && primary?.id !== "add") {
        more.push({
            id: "add",
            label: ctx.borrowerEligible ? "Add collateral" : "Renew eligibility to add collateral",
            disabled: !ctx.borrowerEligible,
        });
    }
    if (stateNo === 3 && !alert.cureExpired && ctx.mk && !ctx.mk.dark && !ctx.mk.breach && primary?.id !== "cure") {
        more.push({id: "cure", label: "Cure (feed shows coverage)"});
    }
    if ([2, 3].includes(stateNo) && ctx.mk && !ctx.mk.dark && primary?.id !== "mark") {
        more.push({
            id: "mark",
            label: ctx.mk.breach ? "Record margin shortfall" : "Check margin on-chain",
        });
    }
    if (alert.defaultable && [3, 5].includes(stateNo) && primary?.id !== "declare") {
        more.push({id: "declare", label: "Declare default"});
    }
    if (stateNo === 6 && primary?.id !== "execute") {
        more.push({
            id: "execute",
            label: ctx.lenderEligible ? "Execute collateral to lender" : "Lender must renew eligibility",
            disabled: !ctx.lenderEligible,
        });
    }
    for (const entry of ctx.schedules || []) {
        if (Number(entry.obligation.status) === 1 && asBig(entry.obligation.dueAt) <= nowSec()) {
            more.push({id: "settle", label: "Process " + entry.label, reference: entry.id});
        }
    }
    if (canSign && asBig(ctx.credit || 0n) > 0n && primary?.id !== "withdraw") {
        more.push({id: "withdraw", label: "Withdraw financing cash"});
    }
    if (!canSign && !primary) {
        primary = {
            id: "none",
            label: Venue.account
                ? "Writes unavailable"
                : Venue.watching
                    ? "Watching is read only"
                    : "Connect to act",
            disabled: true,
        };
    }
    return {primary, more, role, canSign};
};

Venue.runFinanceAction = async function (action, ctx) {
    const id = ctx.id;
    if ($("fin-id")) $("fin-id").value = id;
    if ($("repo-id")) $("repo-id").value = id;
    if (action.id === "accept-review") {
        Venue.setFinanceUi({acceptStage: "review"});
        Venue.paintSelectedFacility(ctx);
        return;
    }
    if (action.id === "accept-back") {
        Venue.setFinanceUi({acceptStage: "idle"});
        Venue.paintSelectedFacility(ctx);
        return;
    }
    if (action.id === "approve") {
        if (Venue.busy || Venue.financeFlightOpen()) {
            const facilityId = id || Venue.financeUiState().selectedId || "";
            const priorTx = Venue.financeUiState().txStatus || {};
            const existing = (Venue.financeActivity || []).find((row) =>
                row.action === "authorize collateral"
                && (!row.facilityId || addrEq(row.facilityId, facilityId)));
            Venue.setFinanceUi({
                txStatus: {
                    ...priorTx,
                    stage: priorTx.stage || "approval",
                    action: "authorize collateral",
                    copy: "Authorize collateral is already waiting on the wallet or Hedera.",
                    hash: priorTx.hash || existing?.txHash || "",
                    facilityId,
                    explorer: priorTx.explorer || existing?.explorer || "",
                },
            });
            Venue.paintFinanceTxStatus();
            Venue.recordFinanceActivity({
                action: "authorize collateral",
                category: existing?.category || "wallet",
                title: existing?.title || "Wallet confirmation requested",
                detail: "Authorize collateral is already waiting on the wallet or Hedera.",
                facilityId,
                status: existing?.status || priorTx.stage || "approval",
                txHash: priorTx.hash || existing?.txHash || "",
                explorer: priorTx.explorer || existing?.explorer || "",
            });
            return;
        }
        Venue.setFinanceUi({flight: {action: "authorize collateral", facilityId: id}});
        Venue.paintFinanceBusy("approval");
        try {
            const sent = await Venue.ensureVaultAllowance(ctx.offer?.terms?.collateralAmount || ctx.collateral);
            if (!sent) Venue.setFinanceUi({flight: null});
            Venue.setFinanceUi({acceptStage: "accept"});
            if (Venue.financePreview) Venue.financePreview.enoughAllowance = true;
            ctx.enoughAllowance = true;
            Venue.paintSelectedFacility(ctx);
        } catch (error) {
            Venue.setFinanceUi({flight: null});
            const already = Venue.financeUiState().txStatus;
            if (already?.stage === "failed" || already?.stage === "rejected") {
                Venue.paintFinanceBusy("failed");
                return;
            }
            const message = Venue.financeReadableRevert(error);
            Venue.financeTxStage("failed", "authorize collateral", {message});
            throw new Error(message);
        }
        return;
    }
    if (action.id === "accept") {
        try {
            await Venue.doAcceptOffer();
        } catch (error) {
            const message = Venue.financeReadableRevert(error);
            Venue.financeTxStage("failed", "accept financing", {message});
            throw new Error(message);
        }
        return;
    }
    if (action.id === "cancel") await Venue.doCancelOffer();
    if (action.id === "close") await Venue.closeFacility(id);
    if (action.id === "add") {
        const extra = $("fin-add-lot")?.value;
        await Venue.addFacilityCollateral(id, extra);
    }
    if (action.id === "cure") await Venue.cureFacility(id);
    if (action.id === "declare") await Venue.declareFacilityDefault(id);
    if (action.id === "execute") await Venue.settleFacilityDefault(id);
    if (action.id === "mark") {
        await Venue.doRepoAction("markToMarket", id, action.label);
    }
    if (action.id === "settle") {
        await Venue.doRepoAction("settle", action.reference, action.label);
    }
    if (action.id === "withdraw") await Venue.doVaultWithdraw();
};

Venue.paintFinanceNext = function (ctx, actions) {
    const next = $("fin-next");
    if (!next) return;
    const role = actions.role;
    const checks = [
        ["Your role", role === "watch" ? "Watch only"
            : role === "disconnected" ? "Connect a wallet"
                : role],
        ["Facility state", ctx.stateLabel || (ctx.kind === "offer" ? "Funded offer" : "Selected")],
        ctx.kind === "offer"
            ? ["Acceptance", ctx.expired ? "Expired" : "Awaiting borrower"]
            : ["Coverage", ctx.verdictTone === "ok" ? "Covered"
                : ctx.verdictTone === "bad" ? "Needs action"
                    : "See verdict"],
    ];
    const moreHtml = actions.more.length
        ? '<details class="fin-more"><summary>More actions</summary>' +
          '<div class="fin-more-actions" id="fin-more-actions">' +
          (actions.more.some((item) => item.id === "add")
              ? '<input id="fin-add-lot" inputmode="numeric" placeholder="extra LPRC">'
              : "") +
          actions.more.map((item, index) =>
              '<button type="button" data-fin-action="more" data-fin-index="' +
              index + '"' + (item.disabled ? " disabled" : "") + ">" +
              esc(item.label) + "</button>").join("") +
          "</div></details>"
        : "";
    next.innerHTML =
        '<h2 id="fin-next-heading">Next action</h2>' +
        '<p class="fin-next-copy">' +
        esc(role === "borrower"
            ? "Your wallet and the selected facility determine the next valid step."
            : role === "lender"
                ? "You funded this facility. Secondary actions stay under More actions."
                : "Connect or watch the named wallet to act on this facility.") +
        "</p>" +
        '<ul class="fin-next-checks">' +
        checks.map(([label, value]) =>
            "<li><span class='k'>" + esc(label) + "</span><span class='v" +
            (value === "Needs action" || value === "Expired" || value === "Connect a wallet"
                ? " is-blocked" : "") +
            "'>" + esc(value) + "</span></li>").join("") +
        "</ul>" +
        '<div class="fin-primary-row" id="fin-facility-actions">' +
        (actions.primary
            ? '<button type="button" class="primary" data-fin-action="primary"' +
              (actions.primary.disabled ? " disabled" : "") + ">" +
              esc(actions.primary.label) + "</button>"
            : "") +
        "</div>" + moreHtml +
        (function () {
            const txStatus = Venue.financeUiState().txStatus || {};
            const copy = String(txStatus.copy || "");
            const hash = /^0x[0-9a-fA-F]{64}$/.test(String(txStatus.hash || ""))
                ? String(txStatus.hash)
                : "";
            const href = hash
                ? financeExplorerLink(txStatus.explorer || explorerTx(hash), "HashScan")
                : "";
            return '<p class="fin-tx-status" id="fin-tx-status"' +
                (copy ? "" : " hidden") + ">" +
                (copy ? esc(copy) : "") +
                (href ? " " + href : "") +
                "</p>";
        })();
    Venue.paintFinanceTxStatus();
    Venue.paintFinanceBusy();
};

Venue.paintSelectedFacility = function (ctx) {
    const out = $("repo-out");
    if (!out) return;
    const role = ctx.role || Venue.financeRoleFor(ctx.lender, ctx.borrower);
    Venue.setFinanceUi({selectedId: ctx.id, role});
    if (role === "lender" || role === "borrower") {
        Venue.rememberFinanceFacility(ctx.id, {
            accounts: [ctx.lender, ctx.borrower, Venue.financeViewerAccount()],
            role,
        });
    }
    const actions = Venue.financeActions({...ctx, role});
    const acceptStage = Venue.financeUiState().acceptStage || "idle";
    const fact = (label, value, mono) =>
        "<div><span>" + esc(label) + "</span><strong" + (mono ? ' class="mono"' : "") +
        ">" + esc(value) + "</strong></div>";
    const group = (title, rows) =>
        '<section class="fin-group"><h3>' + esc(title) + '</h3><div class="fin-facts">' +
        rows.join("") + "</div></section>";
    const settlement = (ctx.schedules || []).length
        ? (ctx.schedules || []).map((entry) => {
            const due = entry.obligation?.dueAt != null ? financeAt(entry.obligation.dueAt) : "Unavailable";
            const status = Number(entry.obligation?.status) === 1 ? "Scheduled"
                : Number(entry.obligation?.status) === 2 ? "Settled"
                    : "Unavailable";
            return fact(entry.label || "Obligation", status + " · " + due);
        })
        : [fact("Native settlement", "No scheduled obligation in this state")];
    out.innerHTML =
        '<div class="fin-selected-head">' +
        '<div><div class="id-short">' + esc(shortId(ctx.id)) + "</div>" +
        "<div class='meta'>" + esc(ctx.stateLabel) + "</div>" +
        '<div class="id">' + esc(ctx.id) + "</div>" +
        '<div class="fin-id-actions">' +
        '<button type="button" data-copy-facility="' + esc(ctx.id) + '">Copy id</button>' +
        "</div></div>" +
        '<span class="fin-role">' + esc(role) + "</span></div>" +
        group("Facility status", [
            fact("State", ctx.stateLabel || (ctx.kind === "offer" ? "Funded offer" : "Selected")),
            fact("Connected role", role === "watch" ? "Watch only" : role),
            fact("Borrower", ctx.borrower || "Unavailable", true),
            fact("Lender", ctx.lender || "Unavailable", true),
        ]) +
        group("Economics", [
            fact("Collateral locked", ctx.collateral == null ? "Unavailable" : String(ctx.collateral) + " LPRC"),
            fact("Current collateral mark", ctx.mark == null
                ? (ctx.mk?.dark ? "Feed is dark" : "Unavailable")
                : formatHbar(asBig(ctx.mark)) + " HBAR"),
            fact("Principal", ctx.principal == null ? "Unavailable" : formatHbar(asBig(ctx.principal)) + " HBAR"),
            fact("Accrued exposure", ctx.exposure == null
                ? "Unavailable in this state"
                : formatHbar(asBig(ctx.exposure)) + " HBAR"),
            fact("Repayment required", ctx.repay == null ? "Unavailable" : formatHbar(asBig(ctx.repay)) + " HBAR"),
            fact("Settlement penalty", ctx.penalty == null ? "None in this state" : formatHbar(asBig(ctx.penalty)) + " HBAR"),
            fact("Repo rate", String(ctx.rate ?? "Unavailable") + (ctx.rate == null ? "" : " bps")),
            fact("Haircut", ctx.haircut == null
                ? "Not retained after acceptance"
                : String(ctx.haircut) + " bps"),
            fact("Maintenance", String(ctx.maintenance ?? "Unavailable") + (ctx.maintenance == null ? "" : " bps")),
        ]) +
        group("Risk and eligibility", [
            fact("Borrower eligibility", ctx.borrowerEligible === true
                ? "granted"
                : ctx.borrowerEligible === false ? "not granted" : "unavailable"),
            fact("Lender eligibility", ctx.lenderEligible === true
                ? "granted"
                : ctx.lenderEligible === false ? "not granted" : "unavailable"),
            fact("Covered or breach", ctx.verdict || "Unavailable"),
        ]) +
        group("Timing", [
            fact("Opened", ctx.openedAt ? financeAt(ctx.openedAt) : "Not opened"),
            fact(ctx.kind === "offer" ? "Offer expiry" : "Maturity", financeAt(ctx.maturity)),
            fact("Cure deadline", ctx.cureDeadline && asBig(ctx.cureDeadline) > 0n
                ? financeAt(ctx.cureDeadline)
                : "None"),
        ]) +
        group("Settlement", settlement) +
        '<p class="fin-verdict ' + esc(ctx.verdictTone || "") + '">' + esc(ctx.verdict) + "</p>" +
        (acceptStage !== "idle" && ctx.kind === "offer"
            ? '<div class="fin-review" id="fin-accept-review"><h3>Review acceptance</h3>' +
              "<p>The borrower named below must authorize the exact lot, then accept in a second wallet confirmation. " +
              "Each step waits for its own signature.</p>" +
              '<ul class="fin-review-facts">' +
              "<li><span class='k'>Lender</span><span class='v mono'>" + esc(ctx.lender) + "</span></li>" +
              "<li><span class='k'>Borrower</span><span class='v mono'>" + esc(ctx.borrower) + "</span></li>" +
              "<li><span class='k'>Lot</span><span class='v'>" + esc(String(ctx.collateral)) + " LPRC</span></li>" +
              "<li><span class='k'>Principal</span><span class='v'>" +
              esc(formatHbar(asBig(ctx.principal))) + " HBAR</span></li>" +
              "<li><span class='k'>Expires</span><span class='v'>" + esc(financeAt(ctx.maturity)) + "</span></li>" +
              "</ul></div>"
            : "");
    Venue.paintFinanceNext(ctx, actions);
    Venue.paintFinanceSettlement(ctx.schedules || []);
    out.querySelector("[data-copy-facility]")?.addEventListener("click", (event) => {
        Venue.copyKnownFinanceId(ctx.id, event.currentTarget).catch((error) => Venue.fail(error));
    });
    const next = $("fin-next");
    next?.querySelectorAll?.("[data-fin-action]")?.forEach((button) => {
        button.addEventListener("click", async () => {
            const item = button.dataset.finAction === "primary"
                ? actions.primary
                : actions.more[Number(button.dataset.finIndex)];
            if (!item) return;
            button.disabled = true;
            try { await Venue.runFinanceAction(item, ctx); }
            catch (error) { Venue.fail(error); }
            finally {
                if (Venue.financeFlightOpen()) {
                    button.disabled = true;
                    if (typeof button.setAttribute === "function") {
                        button.setAttribute("aria-busy", "true");
                    }
                } else {
                    button.disabled = !!item.disabled;
                }
            }
        });
    });
    Venue.paintFinanceBusy();
    Venue.paintRelatedFacilities(Venue.relatedFacilities || []);
};

Venue.paintOffer = function (id, offer) {
    Venue.setFinanceUi({selectedId: id, role: Venue.financeRoleFor(offer.lender, offer.borrower)});
    const preview = Venue.financePreview;
    const enoughAllowance = preview && preview.id === id ? !!preview.enoughAllowance : false;
    const expired = asBig(offer.expiresAt) <= nowSec();
    const repay = maturityRepayment(
        asBig(offer.principal),
        asBig(offer.terms.repoRateBps),
        asBig(offer.terms.term),
    );
    Venue.paintSelectedFacility({
        id,
        kind: "offer",
        stateLabel: expired ? "Expired offer" : "Funded offer",
        lender: offer.lender,
        borrower: offer.borrower,
        collateral: offer.terms.collateralAmount,
        principal: offer.principal,
        repay,
        maturity: offer.expiresAt,
        rate: offer.terms.repoRateBps,
        haircut: offer.terms.haircutBps,
        maintenance: offer.terms.maintenanceBps,
        mark: null,
        exposure: null,
        verdict: expired ? "This offer can no longer be accepted." : "Awaiting borrower acceptance.",
        verdictTone: expired ? "bad" : "",
        expired,
        enoughAllowance,
        offer,
        alert: {},
        mk: null,
        price: null,
        penalty: null,
        schedules: [],
        borrowerEligible: preview?.borrowerEligible !== false,
        lenderEligible: preview?.lenderEligible !== false,
    });
    if (!expired) Venue.recordFundedOfferAwaiting(id, offer);
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
const ORACLE_QUALIFIED_PRINT_MAX_AGE = 1800;
const ORACLE_MARKET_OBSERVATION_MAX_AGE = 93600;
const ORACLE_EVM_CLOCK_TOLERANCE = 2;

Venue.oracleStatusMessage = function (code) {
    return {
        SOURCE_QUORUM: "No qualified auction exists and the model has no signed dealer quote.",
        SOURCE_DIVERGENCE: "Qualified auction and independent valuation cross-check disagree.",
        CROSS_CHECK_MISSING: "A qualified auction exists but its independent cross-check is missing.",
        HBAR_MARKET_UNAVAILABLE: "The required market HBAR/USD cross-check could not be read.",
        HBAR_RATE_DIVERGENCE: "Hedera network conversion and market HBAR/USD exceed the safety cap.",
        ORACLE_DEVIATION_CAP: "The truthful valuation exceeds the oracle's round-to-round cap.",
        NOT_SEATED: "This publisher is not seated in the oracle panel.",
        ALREADY_ANSWERED: "This publisher already answered the open round.",
        NOT_DUE: "Sources are healthy, but no movement or keepalive threshold is due.",
        SOURCE_ERROR: "A required valuation source could not be read.",
    }[code] || String(code || "Publisher status unavailable").replaceAll("_", " ").toLowerCase();
};

Venue.oracleStatusLabel = function (code) {
    return {
        SOURCE_QUORUM: "Source quorum missing",
        HBAR_RATE_DIVERGENCE: "HBAR-rate divergence",
        HBAR_MARKET_UNAVAILABLE: "HBAR market evidence missing",
        SOURCE_DIVERGENCE: "Valuation source divergence",
        CROSS_CHECK_MISSING: "Valuation cross-check missing",
        ORACLE_DEVIATION_CAP: "Oracle deviation cap",
        SOURCE_ERROR: "Valuation source read failure",
    }[code] || "Publisher status";
};

Venue.oracleEvidenceObservedAt = function (row) {
    const value = Number(row?.record?.observedAt);
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
};

Venue.oracleEvidenceAge = function (row) {
    const observedAt = Venue.oracleEvidenceObservedAt(row);
    if (!observedAt) return null;
    const now = Number(nowSec());
    if (observedAt > now + 30) return null;
    return Math.max(0, now - observedAt);
};

Venue.oracleSourceObservation = function (row, key) {
    const tuple = row?.record?.ss?.[key];
    if (!Array.isArray(tuple) || tuple.length !== 2) return null;
    const observedAt = Number(tuple[0]);
    const identity = String(tuple[1] || "").toLowerCase();
    if (!Number.isSafeInteger(observedAt) || observedAt <= 0 ||
        !/^0x[0-9a-f]{16}$/.test(identity)) {
        return null;
    }
    return {observedAt, identity};
};

Venue.oracleSourceAge = function (row, key) {
    const source = Venue.oracleSourceObservation(row, key);
    if (!source) return null;
    const now = Number(nowSec());
    if (source.observedAt > now + 30) return null;
    return Math.max(0, now - source.observedAt);
};

Venue.oracleHasCompleteProvenance = function (row) {
    const record = row?.record;
    if (!record || record.k !== "oracle-answer" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(String(record.av || "")) ||
        !/^0x[0-9a-fA-F]{64}$/.test(String(record.cfg || "")) ||
        !Array.isArray(record.q) || record.q.length !== 6) {
        return false;
    }
    if (!["t", "r", "n", "m"].every((key) =>
        Venue.oracleSourceObservation(row, key))) {
        return false;
    }
    if (record.hbarMarket != null && !Venue.oracleSourceObservation(row, "h")) {
        return false;
    }
    if (Number(record.exactPrints) > 0 && !Venue.oracleSourceObservation(row, "a")) {
        return false;
    }
    if (Number(record.dealerQuotes) > 0 && !Venue.oracleSourceObservation(row, "d")) {
        return false;
    }
    return true;
};

Venue.oracleConsensusKey = function (timestamp) {
    const [seconds, fraction = ""] = String(timestamp || "0").split(".");
    try {
        return BigInt(seconds || "0") * 1_000_000_000n +
            BigInt(fraction.slice(0, 9).padEnd(9, "0") || "0");
    } catch {
        return 0n;
    }
};

Venue.sortOracleEvidence = function (rows) {
    return [...(rows || [])].sort((left, right) => {
        const consensus = Venue.oracleConsensusKey(right.consensus) -
            Venue.oracleConsensusKey(left.consensus);
        if (consensus !== 0n) return consensus > 0n ? 1 : -1;
        return Venue.oracleEvidenceObservedAt(right) -
            Venue.oracleEvidenceObservedAt(left);
    });
};

Venue.latestOraclePublisherRows = function (rows, kind, round) {
    const seen = new Set();
    return Venue.sortOracleEvidence(rows).filter((row) => {
        if (row?.record?.k !== kind || String(row.record.round) !== String(round)) {
            return false;
        }
        const publisher = String(row.record.publisher || "").toLowerCase();
        if (!publisher || seen.has(publisher)) return false;
        seen.add(publisher);
        return true;
    });
};

Venue.oracleEvidenceMatchesPanel = function (row, answers, publishedAt) {
    if (!row?.record || row.record.k !== "oracle-answer" || !Array.isArray(answers)) {
        return false;
    }
    const consensusAt = Number(String(row.consensus || "0").split(".")[0]);
    if (!Number.isSafeInteger(consensusAt) || consensusAt <= 0 ||
        !Number.isSafeInteger(Number(publishedAt)) || Number(publishedAt) <= 0 ||
        consensusAt > Number(publishedAt) + ORACLE_EVM_CLOCK_TOLERANCE) {
        return false;
    }
    return answers.some((answer) => {
        try {
            return addrEq(answer.by ?? answer[2], row.record.publisher) &&
                asBig(answer.price ?? answer[0]) === asBig(row.record.price) &&
                asBig(answer.rate ?? answer[1]) === asBig(row.record.rate);
        } catch {
            return false;
        }
    });
};

Venue.classifyOracleEvidence = function ({
    evidence,
    round,
    openRound,
    finalizedAnswers,
    publishedAt,
    heartbeat,
}) {
    const answerRows = Venue.latestOraclePublisherRows(
        evidence?.records,
        "oracle-answer",
        round,
    );
    const statusRows = Venue.latestOraclePublisherRows(
        evidence?.records,
        "oracle-status",
        openRound,
    );
    const maxAge = Math.max(1, Number(heartbeat || 0));
    const panelMatchedAnswers = answerRows.filter((row) =>
        Venue.oracleEvidenceMatchesPanel(row, finalizedAnswers, publishedAt));
    const verifiedAnswers = panelMatchedAnswers.filter((row) => {
        const age = Venue.oracleEvidenceAge(row);
        return age !== null && age <= maxAge;
    });
    const staleAnswers = panelMatchedAnswers.filter((row) =>
        !verifiedAnswers.includes(row));
    const freshStatuses = statusRows.filter((row) => {
        const age = Venue.oracleEvidenceAge(row);
        return age !== null && age <= maxAge;
    });
    return {
        answerRows,
        statusRows,
        panelMatchedAnswers,
        verifiedAnswers,
        staleAnswers,
        freshStatuses,
        staleStatuses: statusRows.filter((row) => !freshStatuses.includes(row)),
    };
};

Venue.validateOracleEvidenceRecord = function (record) {
    if (!Number.isSafeInteger(Number(record.observedAt)) || Number(record.observedAt) <= 0) {
        throw new Error("message has no valid observation time");
    }
    if (record.k === "oracle-answer") {
        if (!/^0x[0-9a-fA-F]{64}$/.test(String(record.tx || "")) ||
            !/^0x[0-9a-fA-F]{64}$/.test(String(record.source || "")) ||
            !/^\d+$/.test(String(record.price || "")) ||
            !/^\d+$/.test(String(record.rate || "")) ||
            !/^\d+$/.test(String(record.hbarNetwork || "")) ||
            (record.hbarMarket != null &&
                !/^\d+$/.test(String(record.hbarMarket))) ||
            !/^[a-z][a-z0-9-]{0,63}$/.test(String(record.mode || "")) ||
            (record.tr != null &&
                !/^[A-Z][A-Z0-9_]{0,31}$/.test(String(record.tr))) ||
            !Number.isSafeInteger(Number(record.exactPrints)) ||
            Number(record.exactPrints) < 0 ||
            !Number.isSafeInteger(Number(record.dealerQuotes)) ||
            Number(record.dealerQuotes) < 0 ||
            !Number.isSafeInteger(Number(record.expiresAt)) ||
            Number(record.expiresAt) <= Number(record.observedAt)) {
            throw new Error("answer evidence fields are invalid");
        }
        const expanded = record.av !== undefined || record.cfg !== undefined ||
            record.ss !== undefined || record.q !== undefined;
        if (expanded && !Venue.oracleHasCompleteProvenance({record})) {
            throw new Error("answer source provenance is incomplete or invalid");
        }
        if (expanded && (
            Number(record.q[1]) !== Number(record.exactPrints) ||
            Number(record.q[3]) !== Number(record.dealerQuotes)
        )) {
            throw new Error("answer quality counts disagree with provenance");
        }
    } else if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(String(record.code || ""))) {
        throw new Error("status evidence code is invalid");
    }
    if (record.q !== undefined && (
        !Array.isArray(record.q) ||
        record.q.length !== 6 ||
        record.q.some((value) =>
            !Number.isSafeInteger(Number(value)) ||
            Number(value) < 0 ||
            Number(value) > 65_535)
    )) {
        throw new Error("message quality flags are invalid");
    }
};

Venue.refreshOracleEvidence = async function () {
    const topics = typeof ORACLE_TOPICS === "undefined" ? [] : ORACLE_TOPICS;
    if (!topics.length) {
        Venue.oracleEvidence = {configured: false, records: [], errors: [], skipped: []};
        return Venue.oracleEvidence;
    }
    const topicRows = await Promise.all(topics.map(async (topic) => {
        try {
            const path = "/api/v1/topics/" + encodeURIComponent(topic.topicId) +
                "/messages?order=desc&limit=25";
            const result = await Venue.mirror(path);
            if (!result.messages?.length) return [{topic, empty: true}];
            return result.messages.map((message) => {
                try {
                    const binary = atob(message.message);
                    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
                    const record = JSON.parse(new TextDecoder().decode(bytes));
                    if (
                        record.v !== 1 ||
                        !["oracle-answer", "oracle-status"].includes(record.k) ||
                        Number(record.chain) !== Number(CLIENT.network.chainId) ||
                        !addrEq(record.oracle, CLIENT.addresses.PrimeOracle) ||
                        !addrEq(record.publisher, topic.publisher)
                    ) {
                        return {
                            topic,
                            sequence: String(message.sequence_number),
                            skipped: true,
                            skipReason: "message does not match this deployment and publisher",
                        };
                    }
                    Venue.validateOracleEvidenceRecord(record);
                    return {
                        topic,
                        record,
                        sequence: String(message.sequence_number),
                        consensus: String(message.consensus_timestamp),
                    };
                } catch (error) {
                    return {
                        topic,
                        sequence: String(message.sequence_number),
                        error: error.message,
                    };
                }
            });
        } catch (error) {
            return [{topic, error: error.message, fetchError: true}];
        }
    }));
    const rows = topicRows.flat();
    Venue.oracleEvidence = {
        configured: true,
        records: rows.filter((row) => row.record),
        errors: rows.filter((row) => row.error),
        empty: rows.filter((row) => row.empty),
        skipped: rows.filter((row) => row.skipped),
    };
    return Venue.oracleEvidence;
};

Venue.schedulerStopReason = function (value) {
    const raw = String(value || "").toLowerCase();
    for (const name of [
        "EMPTY_ROUND",
        "ROUND_ADVANCED",
        "FINALIZED",
        "RETRY_LIMIT",
        "CHECK_LIMIT",
        "NO_NEW_ANSWER",
        "STALE_SCHEDULE",
    ]) {
        if (ethers.id(name).toLowerCase() === raw) return "STOP_" + name;
    }
    return raw || "UNKNOWN_STOP_REASON";
};

Venue.schedulerEventReason = function (event) {
    if (!event) return "No scheduler event";
    if (event.name === "CheckUnscheduled") {
        const value = asBig(event.reason);
        const label = {
            "-1": "REASON_UNAVAILABLE",
            "-2": "REASON_NO_CAPACITY",
            "-3": "REASON_UNFUNDED",
            "-4": "REASON_BAD_RESPONSE",
        }[String(value)] || "HEDERA_RESPONSE_CODE";
        return "CheckUnscheduled: " + label + " (" + value + ")";
    }
    if (event.name === "ArmRefused" || event.name === "AutomationStopped") {
        return event.name + ": " + Venue.schedulerStopReason(event.reason);
    }
    if (event.name === "OracleReadFailed") {
        return "OracleReadFailed: selector " + String(event.selector || "unavailable");
    }
    if (event.name === "FinalizeAttempt" && !event.success) {
        return "FinalizeAttempt: failed";
    }
    return event.name;
};

Venue.readOracleSchedulerEvents = async function (scheduler) {
    const result = await Venue.mirror(
        "/api/v1/contracts/" + scheduler.target + "/results/logs?order=desc&limit=100",
    );
    const relevant = new Set([
        "CheckScheduled",
        "CheckUnscheduled",
        "QuorumObserved",
        "FinalizeAttempt",
        "OracleReadFailed",
        "ArmRefused",
        "AutomationStopped",
    ]);
    return (result.logs || []).flatMap((log) => {
        let parsed;
        try {
            parsed = scheduler.interface.parseLog({topics: log.topics, data: log.data});
        } catch {
            return [];
        }
        if (!parsed || !relevant.has(parsed.name)) return [];
        return [{
            name: parsed.name,
            reason: parsed.args.reason,
            selector: parsed.args.selector,
            success: parsed.args.success,
            dueAt: parsed.args.dueAt,
            round: parsed.args.round,
            scheduleAddress: parsed.args.scheduleAddress,
            at: log.timestamp ? Number(String(log.timestamp).split(".")[0]) : 0,
            consensus: String(log.timestamp || "0"),
            tx: log.transaction_hash,
        }];
    }).sort((left, right) => {
        const order = Venue.oracleConsensusKey(right.consensus) -
            Venue.oracleConsensusKey(left.consensus);
        return order > 0n ? 1 : order < 0n ? -1 : 0;
    });
};

Venue.readOracleScheduler = async function () {
    const scheduler = Venue.c.oracleScheduler;
    if (!scheduler) return {status: "not-deployed", events: []};
    if (typeof Venue.reader?.getCode === "function") {
        const code = await Venue.reader.getCode(scheduler.target);
        if (!code || code === "0x") {
            return {
                status: "deployment-missing",
                address: scheduler.target,
                events: [],
            };
        }
    }
    const eventRead = Venue.readOracleSchedulerEvents(scheduler)
        .then((events) => ({events, error: null}))
        .catch((error) => ({events: [], error: error.message || String(error)}));
    const [
        boundOracle,
        active,
        nextCheckAt,
        trackedRound,
        retryStreak,
        checks,
        maxRetry,
        maxChecks,
        minimum,
        balanceWeibar,
        eventState,
    ] =
        await Promise.all([
            scheduler.oracle(),
            scheduler.activeSchedule(),
            scheduler.nextCheckAt(),
            scheduler.trackedRound(),
            scheduler.retryStreak(),
            scheduler.checksThisRound(),
            scheduler.MAX_RETRY_STREAK(),
            scheduler.MAX_CHECKS_PER_ROUND(),
            scheduler.MIN_BALANCE_TINYBAR(),
            Venue.reader.getBalance(scheduler.target),
            eventRead,
        ]);
    const deployment = typeof ORACLE_SCHEDULER === "undefined" ? null : ORACLE_SCHEDULER;
    const bindingIssues = [];
    if (deployment?.oracle &&
        !addrEq(deployment.oracle, CLIENT.addresses.PrimeOracle)) {
        bindingIssues.push(
            "deployment record targets " + deployment.oracle +
            ", current PrimeOracle is " + CLIENT.addresses.PrimeOracle,
        );
    }
    if (deployment?.chainId != null &&
        Number(deployment.chainId) !== Number(CLIENT.network.chainId)) {
        bindingIssues.push(
            "deployment record chain " + deployment.chainId +
            ", current chain is " + CLIENT.network.chainId,
        );
    }
    if (!addrEq(boundOracle, CLIENT.addresses.PrimeOracle)) {
        bindingIssues.push(
            "on-chain oracle() is " + boundOracle +
            ", current PrimeOracle is " + CLIENT.addresses.PrimeOracle,
        );
    }
    const problemNames = new Set([
        "CheckUnscheduled",
        "ArmRefused",
        "AutomationStopped",
        "OracleReadFailed",
    ]);
    return {
        status: bindingIssues.length ? "binding-failed" : "ready",
        address: scheduler.target,
        boundOracle: String(boundOracle),
        bindingIssues,
        active: String(active),
        nextCheckAt: Number(nextCheckAt),
        trackedRound: Number(trackedRound),
        retryStreak: Number(retryStreak),
        checks: Number(checks),
        maxRetry: Number(maxRetry),
        maxChecks: Number(maxChecks),
        minimumTinybar: asBig(minimum),
        balanceTinybar: asBig(balanceWeibar) / WEIBAR_PER_TINYBAR,
        events: eventState.events,
        eventError: eventState.error,
        latestEvent: eventState.events[0] || null,
        latestProblem: eventState.events.find((event) =>
            problemNames.has(event.name) ||
            (event.name === "FinalizeAttempt" && !event.success)) || null,
    };
};

Venue.paintOracleCountdown = function () {
    const clock = Venue.oracleClock;
    const countdown = $("feed-countdown");
    if (clock && countdown) {
        if (!clock.publishedAt) {
            countdown.textContent = "No finalized round";
            countdown.className = "v bad";
        } else {
            const remaining = BigInt(clock.expiresAt) - nowSec();
            countdown.textContent = remaining > 0n
                ? fmtRemain(remaining) + " remaining"
                : "Expired " + fmtRemain(-remaining) + " ago";
            countdown.className = remaining > 0n ? "v ok" : "v bad";
        }
    }
    const scheduler = clock?.scheduler;
    const schedulerElement = $("feed-scheduler");
    if (!schedulerElement) return;
    if (!scheduler) {
        schedulerElement.textContent = "Scheduler status unavailable";
        schedulerElement.className = "v bad";
        return;
    }
    const reasonElement = $("feed-scheduler-reason");
    if (reasonElement) {
        let reasonText;
        let reasonBad = false;
        if (scheduler.eventError) {
            reasonText = "Scheduler event history failed: " + scheduler.eventError;
            reasonBad = true;
        } else if (scheduler.latestProblem) {
            const when = scheduler.latestProblem.at
                ? new Date(scheduler.latestProblem.at * 1000)
                    .toISOString().replace("T", " ").slice(0, 19) + "Z"
                : "time unavailable";
            reasonText = "Latest failure or stop: " +
                Venue.schedulerEventReason(scheduler.latestProblem) + " at " + when;
            reasonBad = !reasonText.includes("STOP_FINALIZED");
        } else if (scheduler.latestEvent) {
            reasonText = "Latest event: " +
                Venue.schedulerEventReason(scheduler.latestEvent);
        } else {
            reasonText = scheduler.status === "not-deployed"
                ? "No scheduler deployment is configured"
                : "No scheduler event evidence found";
            reasonBad = scheduler.status !== "not-deployed";
        }
        reasonElement.textContent = reasonText;
        reasonElement.className = "v " + (reasonBad ? "bad" : "ok");
    }
    if (scheduler.status === "not-deployed") {
        schedulerElement.textContent = "Not deployed";
        schedulerElement.className = "v bad";
        return;
    }
    if (scheduler.status === "deployment-missing") {
        schedulerElement.textContent =
            "Deployment missing at " + shortAddr(scheduler.address);
        schedulerElement.className = "v bad";
        return;
    }
    if (scheduler.status === "rpc-failed") {
        schedulerElement.textContent = "Scheduler RPC failed: " + scheduler.error;
        schedulerElement.className = "v bad";
        return;
    }
    if (scheduler.status === "binding-failed") {
        schedulerElement.textContent =
            "Scheduler binding failed: " + scheduler.bindingIssues.join("; ");
        schedulerElement.className = "v bad";
        return;
    }
    if (addrEq(scheduler.active, ZERO) || !scheduler.nextCheckAt) {
        const exactProblem = scheduler.latestProblem
            ? Venue.schedulerEventReason(scheduler.latestProblem)
            : null;
        if (exactProblem &&
            ["CheckUnscheduled", "ArmRefused", "AutomationStopped"]
                .includes(scheduler.latestProblem.name)) {
            schedulerElement.textContent = exactProblem + " · " +
                readableHbar(scheduler.balanceTinybar) + " HBAR";
            schedulerElement.className = exactProblem.includes("STOP_FINALIZED")
                ? "v ok"
                : "v bad";
        } else if (scheduler.balanceTinybar < scheduler.minimumTinybar) {
            schedulerElement.textContent = "Unfunded: " +
                readableHbar(scheduler.balanceTinybar) + " HBAR, minimum " +
                readableHbar(scheduler.minimumTinybar) + " HBAR";
            schedulerElement.className = "v bad";
        } else {
            schedulerElement.textContent = scheduler.checks >= scheduler.maxChecks ||
                scheduler.retryStreak >= scheduler.maxRetry
                ? "Stopped at bounded retry limit · " +
                    readableHbar(scheduler.balanceTinybar) + " HBAR"
                : "Idle until a publisher answers · " +
                    readableHbar(scheduler.balanceTinybar) + " HBAR";
            schedulerElement.className = "v";
        }
        return;
    }
    const until = BigInt(scheduler.nextCheckAt) - nowSec();
    schedulerElement.textContent = "Check " +
        (until > 0n ? "in " + fmtRemain(until) : "due now") +
        " · " + scheduler.checks + "/" + scheduler.maxChecks + " scheduled · " +
        readableHbar(scheduler.balanceTinybar) + " HBAR";
    schedulerElement.className = "v ok";
};

Venue.oracleReadFailed = function (error) {
    const message = decodeRevert(error).message;
    Venue.oracleClock = null;
    Venue.markOracleHeadline?.();
    const failure = $("feed-failure");
    if (failure) {
        failure.hidden = false;
        failure.className = "note bad";
        failure.textContent =
            "RPC refresh failed: " + message + ". Last confirmed values are not presented as current.";
    }
    const state = $("feed-state");
    if (state) {
        state.textContent = "RPC unavailable";
        state.className = "feed-state bad";
    }
    for (const id of ["feed-price", "feed-rate", "feed-mark"]) {
        if ($(id)) $(id).textContent = "Unavailable";
    }
    const unavailable = [
        "feed-round",
        "feed-open",
        "feed-age",
        "feed-countdown",
        "feed-ourleg",
        "feed-cashleg",
        "feed-hbar",
        "feed-hbar-market",
        "feed-market-age",
        "feed-source",
        "feed-print-age",
        "feed-evidence",
        "feed-quorum",
        "feed-heartbeat",
        "feed-deviation",
        "feed-cashaddr",
    ];
    for (const id of unavailable) {
        const element = $(id);
        if (!element) continue;
        element.textContent = "Unavailable due to RPC failure";
        element.className = "v bad";
    }
    const scheduler = $("feed-scheduler");
    if (scheduler) {
        scheduler.textContent = "Not refreshed because the oracle RPC read failed";
        scheduler.className = "v bad";
    }
    const schedulerReason = $("feed-scheduler-reason");
    if (schedulerReason) {
        schedulerReason.textContent = "Scheduler evidence was not refreshed";
        schedulerReason.className = "v bad";
    }
    const panel = $("feed-panel");
    if (panel) panel.innerHTML = '<span class="bad">Unavailable due to RPC failure</span>';
    const says = $("feed-says");
    if (says) {
        says.textContent =
            "Oracle-dependent valuation is unavailable because its RPC read failed.";
    }
    $("feed-box")?.classList.add("is-unavailable");
    Venue.paintOracleImpact([], {rpc: true});
};

Venue.markOracleHeadline = function () {
    Venue._oracleHeadlineAt = Date.now();
    const waiters = Venue._oracleHeadlineWaiters || [];
    Venue._oracleHeadlineWaiters = [];
    for (const resolve of waiters) resolve();
    Venue.scheduleDeferredPrefetch();
};

Venue.whenOracleHeadline = function () {
    if (Venue._oracleHeadlineAt) return Promise.resolve();
    return new Promise((resolve) => {
        (Venue._oracleHeadlineWaiters ||= []).push(resolve);
    });
};

Venue.scheduleDeferredPrefetch = function () {
    if (Venue._prefetchScheduled || !Venue._prefetchHref) return;
    Venue._prefetchScheduled = true;
    const href = Venue._prefetchHref;
    const start = () => {
        if (typeof document === "undefined" || !document.head) return;
        if (document.querySelector('link[data-oracle-prefetch="1"]')) return;
        const link = document.createElement("link");
        link.rel = "prefetch";
        link.href = href;
        link.setAttribute("data-oracle-prefetch", "1");
        document.head.appendChild(link);
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(start);
    else setTimeout(start, 1);
};

Venue.pollOracle = function () {
    if (Venue._oracleFlight) return Venue._oracleFlight;
    const flight = (async () => {
        try {
            await Venue.refreshOracle();
            return true;
        } catch (error) {
            Venue.oracleReadFailed(error);
            return false;
        } finally {
            const refreshedAt = Date.now();
            if (Venue.page === "trade") Venue._tradeOracleAt = refreshedAt;
            if (Venue.page === "repo") Venue._repoOracleAt = refreshedAt;
            if (Venue._oracleFlight === flight) Venue._oracleFlight = null;
        }
    })();
    Venue._oracleFlight = flight;
    return flight;
};

Venue.refreshOracle = async function () {
    const box = $("feed-box");
    if (!box) {
        Venue.markOracleHeadline();
        return;
    }
    const {oracle, watch} = Venue.c;
    if (!oracle) {
        Venue.oracleReadFailed(new Error(
            "PrimeOracle is not configured in the current address book",
        ));
        if ($("feed-state")) {
            $("feed-state").textContent = "PrimeOracle not configured";
            $("feed-state").className = "feed-state bad";
        }
        Venue.markOracleHeadline();
        return;
    }

    const schedulerRead = Venue.readOracleScheduler().catch((error) => ({
        status: "rpc-failed",
        address: Venue.c.oracleScheduler?.target,
        error: decodeRevert(error).message,
        events: [],
    }));
    const evidenceRead = Venue.refreshOracleEvidence().catch((error) => ({
        configured: true,
        records: [],
        errors: [{
            topic: {profile: "all topics"},
            error: error.message || String(error),
            fetchError: true,
        }],
        empty: [],
    }));
    const put = (id, v, cls) => {
        const el = $(id);
        if (!el) return;
        el.innerHTML = v;
        if (cls !== undefined) {
            el.className = id === "feed-state"
                ? "feed-state " + cls
                : "v " + cls;
        }
    };
    let f;
    try {
        f = await watch.feed();
    } catch (error) {
        Venue.markOracleHeadline();
        throw error;
    }

    const dark = !!f.dark;
    const publishedAt = Number(asBig(f.publishedAt));
    const age = publishedAt > 0
        ? Number(nowSec() > asBig(f.publishedAt)
            ? nowSec() - asBig(f.publishedAt)
            : 0n)
        : null;
    const published = publishedAt > 0
        ? new Date(publishedAt * 1000)
            .toISOString().replace("T", " ").slice(0, 19) + "Z"
        : null;
    const valuationUnavailable = dark || asBig(f.cleanPrice) === 0n;
    let stateLabel;
    if (f.ourLegDark && f.cashLegDark) {
        stateLabel = Venue.page === "trade"
            ? "Panel and HBAR rate stale"
            : "panel and HBAR rate stale";
    } else if (f.ourLegDark) {
        stateLabel = Venue.page === "trade" ? "Panel stale" : "panel stale";
    } else if (f.cashLegDark) {
        stateLabel = Venue.page === "trade" ? "HBAR rate stale" : "HBAR rate stale";
    } else {
        stateLabel = Venue.page === "trade" ? "Live" : "live";
    }
    put("feed-state", stateLabel, dark ? "bad" : "ok");
    put("feed-price", valuationUnavailable ? "Unavailable"
        : esc(formatPrice(asBig(f.cleanPrice))) +
            (Venue.page === "trade" ? "" : " USD"),
    valuationUnavailable ? "bad" : "ok");
    put("feed-rate", valuationUnavailable
        ? "Unavailable"
        : String(f.refRateBps) + (Venue.page === "trade" ? "" : " bps"),
    valuationUnavailable ? "bad" : "ok");
    put("feed-age", age === null
        ? "Last finalized time unavailable"
        : "Finalized " + published + " · " + fmtRemain(age) + " ago",
    age === null ? "bad" : dark ? "bad" : "ok");
    box.classList.toggle("is-unavailable", dark);
    box.hidden = false;
    Venue.markOracleHeadline();

    let panel;
    let quorum;
    let heartbeat;
    let cashHeartbeat;
    let dev;
    let round;
    let openRound;
    let cash;
    try {
        [
            panel,
            quorum,
            heartbeat,
            cashHeartbeat,
            dev,
            round,
            openRound,
            cash,
        ] = await Promise.all([
            oracle.publishers(),
            oracle.quorum(),
            oracle.heartbeat(),
            oracle.cashHeartbeat(),
            oracle.maxDeviationBps(),
            oracle.lastRound(),
            oracle.openRound(),
            oracle.cashLeg(),
        ]);
    } catch {
        put("feed-open", "Panel details unavailable", "bad");
        put("feed-quorum", "Panel details unavailable", "bad");
        put("feed-heartbeat", "Panel details unavailable", "bad");
        put("feed-evidence", "Evidence details unavailable", "bad");
        return;
    }
    const [finalizedPanelRead, openPanelRead] = await Promise.allSettled([
        oracle.panelOf(round),
        oracle.panelOf(openRound),
    ]);
    const finalizedAnswers = finalizedPanelRead.status === "fulfilled"
        ? finalizedPanelRead.value
        : null;
    const openAnswers = openPanelRead.status === "fulfilled"
        ? openPanelRead.value
        : null;
    const finalizedPanelError = finalizedPanelRead.status === "rejected"
        ? decodeRevert(finalizedPanelRead.reason).message
        : null;
    const openPanelError = openPanelRead.status === "rejected"
        ? decodeRevert(openPanelRead.reason).message
        : null;
    if (openPanelError) {
        stateLabel += Venue.page === "trade"
            ? ", panel read failed"
            : "; panel read failed";
    }
    const markUnavailable = dark || asBig(f.markPerUnitTinybar) === 0n;
    put("feed-state", stateLabel, dark || openPanelError ? "bad" : "ok");
    put("feed-price", valuationUnavailable ? "Unavailable"
        : esc(formatPrice(asBig(f.cleanPrice))) +
            (Venue.page === "trade" ? "" : " USD"),
    valuationUnavailable ? "bad" : "ok");
    put("feed-rate", valuationUnavailable
        ? "Unavailable"
        : String(f.refRateBps) + (Venue.page === "trade" ? "" : " bps"),
    valuationUnavailable ? "bad" : "ok");
    put("feed-round", String(round));
    put("feed-open", openPanelError
        ? "Panel read failed: " + esc(openPanelError)
        : openAnswers.length + " of " + quorum + " for round " + openRound,
    openPanelError || openAnswers.length < Number(quorum) ? "bad" : "ok");
    put("feed-age", age === null
        ? "Last finalized time unavailable"
        : "Finalized " + published + " · " + fmtRemain(age) + " ago",
    age === null ? "bad" : dark ? "bad" : "ok");
    put("feed-ourleg",
        Venue.page === "trade" ? (f.ourLegDark ? "stale" : "live") : (f.ourLegDark ? "dark" : "live"),
        f.ourLegDark ? "bad" : "ok");
    put("feed-cashleg",
        Venue.page === "trade" ? (f.cashLegDark ? "stale" : "live") : (f.cashLegDark ? "dark" : "live"),
        f.cashLegDark ? "bad" : "ok");
    put("feed-hbar", asBig(f.usdPerHbar) === 0n ? "Unavailable"
        : esc(formatPrice(asBig(f.usdPerHbar))) + " USD",
    asBig(f.usdPerHbar) === 0n ? "bad" : "ok");
    put("feed-mark", markUnavailable ? "Unavailable"
        : Venue.page === "repo"
            ? '<span class="fin-health-value">' +
              esc(readableHbar(asBig(f.markPerUnitTinybar))) +
              '</span><span class="fin-health-unit">HBAR</span>'
            : esc(readableHbar(asBig(f.markPerUnitTinybar))) +
                (Venue.page === "trade" ? "" : " HBAR"),
    markUnavailable ? "bad" : "ok");
    put("feed-heartbeat", heartbeat + " s panel · " + cashHeartbeat + " s cash adapter");
    put("feed-deviation", dev + " bps per round");
    put("feed-cashaddr", f.cashFeed && !addrEq(f.cashFeed, ZERO)
        ? '<a href="' + explorerAddr(f.cashFeed) + '" target="_blank" rel="noopener noreferrer">' +
            esc(shortAddr(f.cashFeed)) + "</a>"
        : "not seated");

    let evidence;
    let scheduler;
    try {
        [evidence, scheduler] = await Promise.all([evidenceRead, schedulerRead]);
    } catch (error) {
        evidence = {
            configured: true,
            records: [],
            errors: [{
                topic: {profile: "all topics"},
                error: error.message || String(error),
                fetchError: true,
            }],
            empty: [],
        };
        scheduler = {
            status: "rpc-failed",
            error: decodeRevert(error).message,
            events: [],
        };
        put("feed-evidence", "Evidence details unavailable", "bad");
    }

    const evidenceView = Venue.classifyOracleEvidence({
        evidence,
        round,
        openRound,
        finalizedAnswers,
        publishedAt,
        heartbeat,
    });
    const verifiedEvidenceQuorum =
        evidenceView.verifiedAnswers.length >= Number(quorum);
    const verifiedProvenanceAnswers = evidenceView.verifiedAnswers.filter((row) =>
        Venue.oracleHasCompleteProvenance(row));
    const verifiedProvenanceQuorum =
        verifiedProvenanceAnswers.length >= Number(quorum);
    const newestVerifiedAnswer =
        verifiedProvenanceAnswers[0] || evidenceView.verifiedAnswers[0] || null;
    const newestAnswerClaim = evidenceView.answerRows[0] || null;
    const sourceDescriptions = {
        "qualified-market": "Qualified Hedera auction plus fixed-point model",
        "model-dealer-fallback": "SOFR model plus signed dealer quote",
        "market-only": "Qualified Hedera auction",
    };
    const sourceRow = newestVerifiedAnswer || newestAnswerClaim;
    const sourceMode = sourceRow?.record?.mode;
    let sourceLabel;
    if (newestVerifiedAnswer && verifiedProvenanceQuorum) {
        sourceLabel = sourceMode + ": " +
            (sourceDescriptions[sourceMode] || "publisher source mode");
        if (sourceMode === "qualified-market" || sourceMode === "market-only") {
            sourceLabel += " · " + newestVerifiedAnswer.record.exactPrints +
                " qualified prints";
        } else if (sourceMode === "model-dealer-fallback") {
            sourceLabel += " · " + newestVerifiedAnswer.record.dealerQuotes +
                " dealer quotes";
        }
        const sofrAge = Venue.oracleSourceAge(newestVerifiedAnswer, "r");
        sourceLabel += " · " + newestVerifiedAnswer.record.av +
            " · config " + newestVerifiedAnswer.record.cfg.slice(0, 10);
        if (newestVerifiedAnswer.record.tr) {
            sourceLabel += " · trigger " + newestVerifiedAnswer.record.tr;
        }
        if (sofrAge !== null) sourceLabel += " · SOFR age " + fmtRemain(sofrAge);
    } else if (newestVerifiedAnswer && verifiedEvidenceQuorum) {
        sourceLabel = "EVM panel verified, but source timestamps and identities are unavailable";
    } else if (newestVerifiedAnswer) {
        sourceLabel = "Incomplete EVM-verified HCS provenance: " +
            sourceMode + " from " + evidenceView.verifiedAnswers.length +
            "/" + quorum + " required publishers";
    } else if (evidenceView.staleAnswers.length) {
        sourceLabel = "Stale HCS source claim rejected: " +
            evidenceView.staleAnswers[0].record.mode;
    } else if (newestAnswerClaim) {
        sourceLabel = "Unverified HCS source claim: " +
            (sourceMode || "mode unavailable");
    } else if (evidenceView.freshStatuses.length) {
        sourceLabel = "Publishers withheld: " +
            [...new Set(evidenceView.freshStatuses.map((row) => row.record.code))]
                .join(", ");
    } else if (evidenceView.staleStatuses.length) {
        sourceLabel = "No current source evidence; stale publisher status rejected";
    } else {
        sourceLabel = evidence.configured
            ? "No current publisher evidence"
            : "Evidence topics not configured";
    }
    put("feed-source", esc(sourceLabel),
        newestVerifiedAnswer && verifiedProvenanceQuorum ? "ok" : "bad");

    const qualifiedRow = evidenceView.verifiedAnswers.find((row) =>
        ["qualified-market", "market-only"].includes(row.record.mode)) ||
        evidenceView.staleAnswers.find((row) =>
            ["qualified-market", "market-only"].includes(row.record.mode)) ||
        evidenceView.answerRows.find((row) =>
            ["qualified-market", "market-only"].includes(row.record.mode));
    if (qualifiedRow) {
        const printSource = Venue.oracleSourceObservation(qualifiedRow, "a");
        const printAge = Venue.oracleSourceAge(qualifiedRow, "a");
        const printCurrent = verifiedProvenanceQuorum &&
            evidenceView.verifiedAnswers.includes(qualifiedRow) &&
            printAge !== null &&
            printAge <= ORACLE_QUALIFIED_PRINT_MAX_AGE;
        put("feed-print-age", printAge === null
            ? "Qualified-print source timestamp is unavailable"
            : fmtRemain(printAge) + " since qualified auction print · " +
                qualifiedRow.record.exactPrints + " qualified prints" +
                " · source " + printSource.identity +
                (printCurrent
                    ? " · EVM panel verified"
                    : " · stale or unverified provenance rejected"),
        printCurrent ? "ok" : "bad");
    } else if (newestVerifiedAnswer && verifiedProvenanceQuorum) {
        put("feed-print-age",
            "Not used by source mode " + esc(newestVerifiedAnswer.record.mode),
        "ok");
    } else {
        put("feed-print-age", "Qualified-print evidence unavailable", "bad");
    }

    const marketRows = [
        ...evidenceView.verifiedAnswers,
        ...evidenceView.staleAnswers,
        ...evidenceView.answerRows,
        ...evidenceView.freshStatuses,
        ...evidenceView.staleStatuses,
    ];
    const marketObservation = marketRows.find((row, index) =>
        row.record.hbarMarket != null &&
        marketRows.findIndex((candidate) => candidate === row) === index);
    const marketAge = marketObservation
        ? Venue.oracleSourceAge(marketObservation, "h")
        : null;
    const marketSource = marketObservation
        ? Venue.oracleSourceObservation(marketObservation, "h")
        : null;
    const marketMaxAge = Math.max(
        1,
        Math.min(Number(heartbeat), ORACLE_MARKET_OBSERVATION_MAX_AGE),
    );
    const marketVerified = !!marketObservation &&
        verifiedProvenanceQuorum &&
        evidenceView.verifiedAnswers.includes(marketObservation) &&
        marketAge !== null &&
        marketAge <= marketMaxAge;
    put("feed-hbar-market", marketVerified
        ? esc(formatPrice(asBig(marketObservation.record.hbarMarket))) + " USD"
        : "Unavailable",
    marketVerified ? "ok" : "bad");
    put("feed-market-age", !marketObservation
        ? "Market observation evidence unavailable"
        : marketAge === null
            ? "Underlying market observation timestamp is unavailable"
            : (marketVerified
                ? fmtRemain(marketAge) +
                    " since verified market observation · source " +
                    marketSource.identity
                : fmtRemain(marketAge) +
                    " since unverified or stale market observation; rejected"),
    marketVerified ? "ok" : "bad");

    let quorumLabel = quorum + " required of " + panel.length + " seated";
    if (finalizedPanelError) {
        quorumLabel += " · finalized panel read failed";
    } else if (asBig(round) > 0n) {
        quorumLabel += " · " + finalizedAnswers.length + " finalized";
    } else {
        quorumLabel += " · no finalized round";
    }
    quorumLabel += " · " + evidenceView.verifiedAnswers.length +
        " HCS messages EVM-verified";
    put("feed-quorum", esc(quorumLabel),
        finalizedPanelError ||
            (asBig(round) > 0n && !verifiedEvidenceQuorum) ? "bad" : "ok");

    const evidenceElement = $("feed-evidence");
    if (evidenceElement) {
        const topics = typeof ORACLE_TOPICS === "undefined" ? [] : ORACLE_TOPICS;
        const readableTopics = new Set([
            ...(evidence.records || []),
            ...(evidence.empty || []),
            ...(evidence.errors || []).filter((row) => !row.fetchError),
        ].map((row) => row.topic?.topicId).filter(Boolean));
        const parts = [];
        if (!evidence.configured) {
            parts.push("Not configured");
        } else {
            parts.push(readableTopics.size + "/" + topics.length +
                " topic tails readable");
            if (verifiedEvidenceQuorum) {
                parts.push("EVM panel verified HCS " +
                    evidenceView.verifiedAnswers.map((row) =>
                        row.topic.profile + " #" + row.sequence).join(", "));
                parts.push(verifiedProvenanceQuorum
                    ? "source timestamps and identities committed"
                    : "source timestamp schema unavailable");
            } else if (evidenceView.verifiedAnswers.length) {
                parts.push("Incomplete EVM panel verification: " +
                    evidenceView.verifiedAnswers.map((row) =>
                        row.topic.profile + " #" + row.sequence).join(", "));
            } else if (evidenceView.answerRows.length) {
                parts.push("Schema-valid but unverified HCS answers: " +
                    evidenceView.answerRows.map((row) =>
                        row.topic.profile + " #" + row.sequence).join(", "));
            } else if (evidenceView.statusRows.length) {
                parts.push("Unverified publisher status only: " +
                    evidenceView.statusRows.map((row) =>
                        row.topic.profile + " #" + row.sequence).join(", "));
            } else {
                parts.push("No current answer or status sequence");
            }
            if (evidence.errors.length) {
                if ((evidence.errors || []).some((row) => row.fetchError)) {
                    parts.unshift("Evidence details unavailable");
                }
                parts.push("Evidence failures: " + evidence.errors.map((row) =>
                    row.topic?.profile + (row.sequence ? " #" + row.sequence : "") +
                    ": " + row.error).join("; "));
            }
        }
        const links = topics.map((topic) =>
            '<a href="' + CLIENT.network.explorer + "/topic/" +
            encodeURIComponent(topic.topicId) +
            '" target="_blank" rel="noopener">' + esc(topic.profile) + "</a>"
        ).join(", ");
        evidenceElement.innerHTML = esc(parts.join(" · ")) +
            (links ? " · " + links : "");
        evidenceElement.className = "v " +
            (verifiedEvidenceQuorum &&
                verifiedProvenanceQuorum &&
                readableTopics.size === topics.length &&
                evidence.errors.length === 0 ? "ok" : "bad");
    }

    const answered = openAnswers
        ? new Set(openAnswers.map((answer) =>
            String(answer.by ?? answer[2]).toLowerCase()))
        : null;
    const missing = answered
        ? panel.filter((publisher) =>
            !answered.has(String(publisher).toLowerCase()))
        : [];
    const failureParts = [];
    const quoteUnreadable = !!(f.ourLegDark || f.cashLegDark ||
        openPanelError || finalizedPanelError);
    const healthyStatusCodes = new Set(["NOT_DUE", "ALREADY_ANSWERED"]);
    const blockingCodes = [...new Set(
        evidenceView.freshStatuses
            .map((row) => row.record.code)
            .filter((code) => !healthyStatusCodes.has(code)),
    )];
    const fetchErrors = (evidence.errors || []).filter((row) => row.fetchError);
    if (f.ourLegDark) {
        const expiredAt = asBig(f.publishedAt) > 0n
            ? new Date((Number(f.publishedAt) + Number(heartbeat)) * 1000).toISOString()
            : null;
        failureParts.push(
            expiredAt
                ? "Panel stale: the panel heartbeat expired at " + expiredAt + "."
                : "Panel stale: no round has ever finalized."
        );
        if (openAnswers) {
            failureParts.push(
                "Open round " + openRound + " has " + openAnswers.length +
                "/" + quorum + " answers" + (missing.length
                    ? "; missing " + missing.map(shortAddr).join(", ") + "."
                    : ".")
            );
        }
    }
    if (f.cashLegDark) {
        failureParts.push(
            asBig(cash.updatedAt ?? cash[2]) === 0n
                ? "HBAR rate stale: the network conversion adapter returned no rate."
                : "HBAR rate stale: the network conversion adapter failed its freshness checks."
        );
    }
    if (openPanelError) {
        failureParts.push("Open panel read failed: " + openPanelError +
            ". Answer count is unknown.");
    }
    if (finalizedPanelError) {
        failureParts.push("Finalized panel read failed: " + finalizedPanelError +
            ". HCS provenance cannot be verified.");
    }
    if (quoteUnreadable && blockingCodes.length) {
        failureParts.push("Publishers withheld: " + blockingCodes.join(", ") + ".");
    }
    if (quoteUnreadable && fetchErrors.length) {
        failureParts.push("HCS evidence missing or failed: " +
            fetchErrors.map((row) =>
                row.topic?.profile + ": " + row.error).join("; ") + ".");
    }
    if (quoteUnreadable && scheduler.status === "rpc-failed") {
        failureParts.push("Scheduler RPC failure: " + scheduler.error + ".");
    }
    const failure = $("feed-failure");
    if (failure) {
        failure.textContent = failureParts.join(" ");
        failure.hidden = failureParts.length === 0;
        failure.className = "note" + (failureParts.length ? " bad" : "");
    }
    Venue.paintOracleImpact(failureParts);

    Venue.oracleClock = {
        publishedAt,
        expiresAt: publishedAt + Number(heartbeat),
        scheduler,
    };
    Venue.paintOracleCountdown();
    const schedulerElement = $("feed-scheduler");
    if (schedulerElement && scheduler.status === "ready") {
        schedulerElement.title = readableHbar(scheduler.balanceTinybar) +
            " HBAR balance; minimum " + readableHbar(scheduler.minimumTinybar) +
            " HBAR before creating another check";
    }

    const seats = $("feed-panel");
    if (seats) {
        seats.innerHTML = panel.length
            ? panel.map((a) => '<a class="quiet" href="' + explorerAddr(a) +
                '" target="_blank" rel="noopener">' + esc(shortAddr(a)) + "</a>").join("")
            : '<div class="empty">No publisher is seated.</div>';
    }

    const says = $("feed-says");
    if (says) {
        if (Venue.page !== "trade") {
            says.textContent = dark
                ? "The feed is dark, so automatic margin marks are refused and a manual mark may be posted. " +
                  (f.ourLegDark ? "The venue's own panel has not published inside its heartbeat. " : "") +
                  (f.cashLegDark ? "The Hedera network conversion adapter is not answering. " : "")
                : "The feed is live, so every mark comes from this price. Anyone may record a mark on an open facility.";
        }
    }

    box.classList.toggle("is-unavailable", dark);
    box.hidden = false;
};

Venue.financeVaultReadFailed = function (error) {
    const message = decodeRevert(error).message || "Vault settings could not be read.";
    for (const id of FINANCE_VAULT_FIELDS) {
        const el = $(id);
        if (!el) continue;
        el.textContent = "Unavailable";
        el.className = id === "rv-grace" || id === "rv-penalty" ? "v num bad" : "v bad";
    }
    Venue.recordFinanceActivity({
        category: "session",
        severity: "warning",
        title: "Vault settings unavailable",
        detail: message,
    }, {persist: false, notify: false});
};

Venue.refreshVault = async function () {
    const {vault, watch} = Venue.c;
    if (!vault || !watch) {
        Venue.financeVaultReadFailed(new Error("Vault readers are not bound."));
        return;
    }
    let grace, penalty, engineAddr, security, pol, wVault, stream;
    try {
        [grace, penalty, engineAddr, security, pol, wVault, stream] = await Promise.all([
            vault.failGrace(), vault.penaltyRate(), vault.marginEngine(),
            vault.security(), vault.policy(), watch.vault(), watch.stream(),
        ]);
    } catch (error) {
        Venue.financeVaultReadFailed(error);
        throw error;
    }
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
    // The marker is who may post a mark and call the borrower. On this
    // deployment it is an externally owned account, which is a fact about the
    // deployment and not something a client should round off to a contract name.
    put("rv-engine", addrEq(engineAddr, CLIENT.addresses.MarginWatch)
        ? "this watcher" : shortAddr(engineAddr) + " · an account, not a contract");
    put("rv-security", addrEq(security, CLIENT.addresses.token) ? "the bond" : shortAddr(security));
    put("rv-policy", addrEq(pol, CLIENT.addresses.ParameterRoot)
        ? "venue parameters" : shortAddr(pol));
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
    if (el) el.innerHTML = '<div class="empty">Reading the vault history…</div>';
    const viewerIds = await Venue.recoverViewerFinanceHistory().catch(() => []);
    const logs = await Venue.history("RepoVault", {limit: 100}).catch(() => []);
    const seen = new Map();
    const repoEvents = new Set([
        "Opened", "OfferFunded", "OfferCancelled", "CollateralAdded",
        "MarkPosted", "MarginCalled", "Cured", "CouponObserved",
        "Failing", "Defaulted", "Closed",
    ]);
    for (const l of logs) {
        if (!repoEvents.has(l.name) || !l.args || !l.args.length) continue;
        const id = l.args[0];
        if (!Venue.financeIdValid(id)) continue;
        const key = String(id).toLowerCase();
        if (!seen.has(key)) seen.set(key, {id, last: l.name, at: l.at, n: 0});
        seen.get(key).n += 1;
    }
    for (const account of Venue.viewerAliasList()) {
        for (const row of Venue.loadKnownFacilities(account)) {
            const key = row.id.toLowerCase();
            if (!seen.has(key)) {
                seen.set(key, {id: row.id, last: "Remembered", at: Math.floor(row.ts / 1000), n: 1});
            }
        }
    }
    for (const id of viewerIds) {
        const key = id.toLowerCase();
        if (!seen.has(key)) seen.set(key, {id, last: "Wallet history", at: 0, n: 1});
    }
    Venue.knownRepos = [...seen.values()];
    if (!Venue.knownRepos.length) {
        if (el) {
            el.innerHTML = '<div class="empty">No repos found in the recent activity loaded. ' +
                "You can look up an older repo by its id below.</div>";
        }
        Venue.paintRelatedFacilities([]);
        return;
    }
    if (el) {
        el.innerHTML = Venue.knownRepos.map((r) =>
            '<button type="button" class="quiet repo-pick" data-id="' + esc(r.id) + '">' +
            esc(shortId(r.id)) + ' <span class="meta">' + esc(r.last) + " · " + r.n + " events</span></button>").join("");
        el.querySelectorAll(".repo-pick").forEach((b) => b.addEventListener("click", () => {
            $("repo-id").value = b.dataset.id;
            Venue.doRepo().catch((e) => Venue.fail(e));
        }));
    }
    // Whatever ids the vault knows about, the watcher can answer for in one
    // call. calledAmong is the cheap question: which of these are under a call.
    const ids = Venue.knownRepos.map((r) => r.id);
    if (ids.length && Venue.c?.watch?.calledAmong) {
        const called = await Venue.c.watch.calledAmong(ids).catch(() => []);
        const set = new Set([...called].map((x) => String(x).toLowerCase()));
        el?.querySelectorAll(".repo-pick").forEach((b) => {
            if (set.has(b.dataset.id.toLowerCase())) b.classList.add("called");
        });
        const n = $("repo-called");
        if (n) n.textContent = set.size
            ? set.size + " of " + ids.length + " are under a margin call"
            : "none of the " + ids.length + " known repos are under a call";
    }
    await Venue.paintRelatedWorkspace(ids);
};

Venue.paintRelatedWorkspace = async function (ids) {
    const who = typeof Venue.viewer === "function" ? Venue.viewer() : null;
    if (!ids?.length || typeof Venue.readRepoRows !== "function") {
        Venue.paintRelatedFacilities([]);
        return;
    }
    const read = await Venue.readRepoRows(ids).catch(() => ({rows: []}));
    const related = (read.rows || []).filter((row) =>
        row.known && who && (Venue.namesFinanceViewer(row.borrower) || Venue.namesFinanceViewer(row.lender)));
    Venue.relatedFacilities = related;
    for (const row of related) {
        if (row.offered) {
            Venue.recordFundedOfferAwaiting(row.id, {
                lender: row.lender,
                borrower: row.borrower,
                principal: row.principal,
                terms: {collateralAmount: row.collateral},
            });
        }
    }
    Venue.paintRelatedFacilities(related);
    const credit = who && Venue.c.vault?.credit
        ? await Venue.financeViewerCredit()
        : 0n;
    const start = Venue.chooseFinanceStart(related, credit);
    const state = Venue.financeUiState();
    const urgent = start.view === "manage" && start.reason !== "nearest-maturity" && start.reason !== "draft";
    if (urgent && (!state.userView || state.view === "create")) {
        Venue.setFinanceView("manage");
        if (start.selectedId) Venue.setFinanceUi({selectedId: start.selectedId, userView: false});
    } else if (!state.userView && !state.booted) {
        Venue.setFinanceView(start.view);
        if (start.selectedId) Venue.setFinanceUi({selectedId: start.selectedId});
    } else if (!state.userView && start.view === "manage" && start.reason !== "nearest-maturity") {
        Venue.setFinanceView("manage");
        if (start.selectedId && !state.selectedId) Venue.setFinanceUi({selectedId: start.selectedId});
    }
    const selected = Venue.financeUiState().selectedId || start.selectedId;
    if (selected && $("repo-id") && Venue.financeUiState().view === "manage") {
        $("repo-id").value = selected;
        if ($("fin-id")) $("fin-id").value = selected;
        await Venue.doRepo().catch(() => {});
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
                if ($("fin-id")) $("fin-id").value = id;
                const prior = Venue.financeUiState();
                const sameOffer = addrEq(prior.selectedId, id);
                Venue.setFinanceUi({
                    selectedId: id,
                    acceptStage: sameOffer ? (prior.acceptStage || "idle") : "idle",
                });
                await Venue.previewFinance().catch(() => {});
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
    const credit = Venue.account && Venue.c.vault?.credit
        ? await Venue.financeViewerCredit()
        : 0n;
    let verdict = "No coverage preview is available in this state.";
    let verdictTone = "";
    if (mk == null) {
        verdict = "Coverage cannot be evaluated in this state.";
    } else if (mk.dark) {
        verdict = "The feed is dark, so the contract will not mark this facility.";
        verdictTone = "bad";
    } else if (mk.breach) {
        verdict = "Breach: the live mark is short of the maintenance margin.";
        verdictTone = "bad";
    } else {
        verdict = "Covered: the live mark meets the maintenance margin.";
        verdictTone = "ok";
    }
    const flags = [
        alert.called ? "margin call" : "",
        alert.cureExpired ? "cure expired" : "",
        alert.unmarkedFail ? "unmarked fail" : "",
        alert.defaultable ? "defaultable" : "",
    ].filter(Boolean);
    Venue.paintSelectedFacility({
        id,
        kind: "facility",
        stateNo: Number(state),
        stateLabel: st.replaceAll("_", " ") + (flags.length ? " · " + flags.join(" · ") : ""),
        lender: r.lender,
        borrower: r.borrower,
        collateral: r.collateralAmount,
        principal: r.principal,
        repay: price,
        maturity: r.maturity,
        rate: r.repoRateBps,
        haircut: null,
        maintenance: r.maintenanceBps,
        mark: mk && !mk.dark ? mk.mark : null,
        exposure,
        verdict,
        verdictTone,
        alert,
        mk,
        price,
        penalty,
        schedules: schedules || [],
        borrowerEligible,
        lenderEligible,
        credit,
        openedAt: r.openedAt,
        cureDeadline: r.cureDeadline,
        substitute: sub,
    });

    const tape = (await Venue.history("RepoVault", {limit: 100}))
        .filter((l) => l.args && String(l.args[0]).toLowerCase() === id.toLowerCase());
    Venue.paintFinanceTape("repo-tape", tape, "Confirmed events for this facility, newest first.");
    Venue.ingestFacilityHistory(id, tape);
};

Venue.paintFinanceSettlement = function (schedules) {
    const out = $("fin-settlement");
    if (!out) return;
    if (!schedules?.length) {
        out.innerHTML = '<div class="empty">No native settlement obligations for this facility.</div>';
        return;
    }
    out.innerHTML = '<ul class="fin-quote-list">' + schedules.map((entry) => {
        const statusNo = Number(entry.obligation?.status || 0);
        const status = statusNo === 1 ? "Scheduled" : statusNo === 2 ? "Settled" : "Unavailable";
        const due = entry.obligation?.dueAt != null ? financeAt(entry.obligation.dueAt) : "Unavailable";
        const funded = entry.funded ? "funded" : "not funded";
        return "<li><span class='k'>" + esc(entry.label || "Obligation") +
            "</span><span class='v'>" + esc(status + " · " + due + " · " + funded) +
            "</span></li>";
    }).join("") + "</ul>";
};

Venue.paintFinanceTape = function (id, entries, note) {
    const el = $(id);
    if (!el) return;
    if (!entries.length) {
        el.innerHTML = '<div class="empty">' +
            esc(note || "No confirmed events for this facility yet.") + "</div>";
        return;
    }
    el.innerHTML = entries.map((entry) => {
        const title = FINANCE_LIFECYCLE[entry.name] || "Vault event";
        const when = entry.at
            ? new Date(entry.at * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z"
            : "Unavailable";
        const href = entry.tx
            ? financeExplorerLink(explorerTx(entry.tx), "Receipt")
            : "";
        return '<article class="fin-tape-item"><header><strong>' +
            esc(title) + "</strong><time>" + esc(when) +
            "</time></header>" + (href ? "<p>" + href + "</p>" : "") + "</article>";
    }).join("") + (note ? '<p class="note">' + esc(note) + "</p>" : "");
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
        el.innerHTML = '<div class="empty">The revealed book is empty. Sealed orders remain private and are not counted here.</div>';
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
    const head = '<div class="book-row head"><span>Side and order</span><span>Limit price</span>' +
        "<span>Remaining</span><span>Status</span></div>";
    el.innerHTML = '<div class="book-list">' + head + rows.map((r) => {
        const o = r.o;
        const isMine = String(o.trader).toLowerCase() === mine;
        const stale = !o.retired && round > asBig(o.lastRound);
        const remaining = asBig(o.qty) - asBig(o.filled);
        const state = o.retired ? "Closed" : stale ? "Release available"
            : r.eligible ? "Eligible now" : r.live ? "Resting" : "Not live";
        return '<div class="book-row ' + (Number(o.side) === 1 ? "sell " : "buy ") +
            (isMine ? "mine" : "") + '">' +
            '<span class="book-side">' + (Number(o.side) === 1 ? "Sell" : "Buy") +
            "<small>" + esc(shortId(r.id)) + (isMine ? " · yours" : "") + "</small></span>" +
            '<span class="num">' + esc(readableHbar(asBig(o.price))) + " HBAR<small>" +
            esc(String(o.price)) + " tinybar exact</small></span>" +
            '<span class="num">' + esc(formatQuantity(remaining)) + " LPRC<small>of " +
            esc(formatQuantity(asBig(o.qty))) + "</small></span>" +
            '<span class="book-state' + (r.eligible ? " live" : "") + '">' + esc(state) +
            (stale
                ? '<button type="button" class="quiet expire-go" data-id="' + esc(r.id) + '">Release</button>'
                : "") + "</span></div>";
    }).join("") + "</div>" +
        (n > capN ? '<p class="note">' + (n - capN) + " further live orders not shown.</p>" : "");
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
            ? "Last closed round " + prev + " has been processed."
            : willCross
                ? "Last closed round " + prev + " indicates " + volume + " LPRC at " +
                  displayPriceHbar(asBig(priceTwice)) + " HBAR per bond (" +
                  displayPrice(asBig(priceTwice)) + " tinybar midpoint)."
                : "Last closed round " + prev + " has no crossing quantity.";
    }
    const f = $("book-fees");
    if (f) f.textContent = readableHbar(asBig(fees)) + " HBAR";
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
    const part = CLIENT.immutables.partition;
    const schedule = Venue.c.couponSchedule;
    const reads = await Promise.allSettled([
        token.name(),
        token.symbol(),
        token.totalSupply(),
        token.isMultiPartition(),
        token.getExternalKycListsCount(),
        token.compliance(),
        schedule ? schedule.faceValue() : Promise.resolve(null),
        schedule ? schedule.spreadBps() : Promise.resolve(null),
        schedule ? schedule.basis() : Promise.resolve(null),
        schedule ? schedule.dates() : Promise.resolve([]),
    ]);
    const value = (index) => reads[index].status === "fulfilled" ? reads[index].value : null;
    const [name, symbol, supply, multi, lists, comp, face, spread, basis, dates] =
        [...Array(10)].map((_, index) => value(index));
    const put = (id, v, cls) => {
        const el = $(id);
        if (!el) return;
        el.textContent = v;
        if (cls !== undefined) el.className = "v " + cls;
    };
    Venue.instrument = {
        name,
        symbol,
        supply,
        multi,
        lists,
        comp,
        face,
        spread,
        basis,
        dates: dates || [],
        part,
    };
    Venue.paintInstrumentTerms = function () {
        const instrument = Venue.instrument;
        const feed = Venue.positionState?.feed;
        put("in-name", instrument.name == null
            ? "Instrument name unavailable"
            : String(instrument.name));
        put("market-symbol", instrument.symbol == null ? "LPRC" : String(instrument.symbol));
        put("pos-symbol", instrument.symbol == null ? "LPRC" : String(instrument.symbol));
        put("holding-unit", instrument.symbol == null ? "LPRC" : String(instrument.symbol));
        put("in-supply", instrument.supply == null
            ? "Unavailable"
            : readableQuantity(asBig(instrument.supply)) + " " +
              String(instrument.symbol || "units"));
        put("in-multi", instrument.multi == null
            ? "Unavailable"
            : instrument.multi
                ? "Multiple token partitions"
                : "Single trading partition " + shortId(instrument.part));
        put("in-lists", instrument.lists == null
            ? "Unavailable"
            : String(instrument.lists) + " external eligibility list" +
              (asBig(instrument.lists) === 1n ? "" : "s"));
        put("in-face", instrument.face == null
            ? "Unavailable"
            : formatCashAmount(instrument.face) + " LPCASH per bond");
        if (instrument.spread == null) {
            put("in-rate", "Unavailable");
        } else if (feed && !feed.dark) {
            const reference = asBig(feed.refRateBps || 0);
            put("in-rate",
                readableBps(reference + asBig(instrument.spread)) + " current (" +
                readableBps(reference) + " reference + " +
                readableBps(asBig(instrument.spread)) + " spread)");
        } else {
            put("in-rate", "Reference rate unavailable + " +
                readableBps(asBig(instrument.spread)) + " spread");
        }
        put("in-basis", instrument.basis == null
            ? "Unavailable"
            : Number(instrument.basis) === 1
                ? "Actual/365"
                : "Basis " + String(instrument.basis));
        put("in-maturity", instrument.dates.length
            ? new Date(Number(instrument.dates[instrument.dates.length - 1]) * 1000)
                .toISOString().slice(0, 10)
            : "Unavailable");
        const compliance = $("in-compliance");
        if (compliance) {
            compliance.innerHTML = instrument.comp == null
                ? "Unavailable"
                : '<a href="' + esc(explorerAddr(String(instrument.comp))) +
                  '" target="_blank" rel="noopener">' +
                  esc(addrEq(instrument.comp, CLIENT.addresses.SeamJournal)
                      ? "SeamJournal · " + shortAddr(String(instrument.comp))
                      : shortAddr(String(instrument.comp))) + "</a>";
        }
        const tokenAddress = $("in-token-address");
        if (tokenAddress) {
            tokenAddress.innerHTML =
                '<a href="' + esc(explorerAddr(CLIENT.addresses.token)) +
                '" target="_blank" rel="noopener">' +
                esc(shortAddr(CLIENT.addresses.token)) + "</a>";
        }
    };
    Venue.paintInstrumentTerms();

    put("iss-name", name == null ? "Unavailable" : String(name));
    put("iss-symbol", symbol == null ? "Unavailable" : String(symbol));
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
    const ticket = Venue.ticketList?.(Venue.account)?.find((item) => item.id === id);
    if (ticket?.path === "private" && typeof Venue.releasePrivateOrder === "function") {
        return Venue.releasePrivateOrder(ticket);
    }
    Venue.tradeTxStage?.("approval", "Release rested order");
    const rec = await Venue.send(
        () => Venue.w.engine.expire(id, {gasLimit: 400_000}),
        "Release rested order"
    );
    if (rec) {
        await Promise.all([
            Venue.refreshBook(),
            Venue.page === "trade" ? Venue.refreshTrade() : Promise.resolve(),
        ]);
    }
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
    const rec = await Venue.send(
        () => Venue.w.journal.disclose(e, {gasLimit: 300_000}),
        "disclose",
    );
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
    Venue.recordIssuerActivity?.({
        title: said ? "Epoch disclosed" : "Disclosure withheld",
        detail: said
            ? "Epoch " + said.args[0] + " · spent " + before + " → " + after
            : "Budget could not afford a reading · spent still " + after,
        tx: rec.hash || rec.transactionHash || null,
        source: "disclose",
    });
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
    const minFeeText = minFee + " tinybar minimum, engine charges " + fee;
    if (mf) mf.textContent = minFeeText;
    Venue.issuerImmutables = {
        checked: true,
        drifted,
        total: pairs.length,
        minFeeText,
    };
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
            const receipt = await Venue.send(() => call(...args, opts), label);
            if (receipt) await Venue.afterFinance(method);
        } else {
            await call.staticCall(...args);
            const receipt = await Venue.send(() => call(...args), label);
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
    const titles = {
        close: "Repayment and release",
        addCollateral: "Collateral added",
        cure: "Facility cured",
        declareDefault: "Default declared",
        settleDefault: "Collateral executed",
        markToMarket: "Margin checked",
        settle: "Native settlement processed",
    };
    if (titles[method]) {
        Venue.recordFinanceActivity({
            category: "facility",
            title: titles[method],
            detail: "Confirmed vault write for the selected facility.",
            facilityId: Venue.financeUiState().selectedId || ($("fin-id")?.value || ""),
            txHash: Venue.lastReceipt?.hash || Venue.lastReceipt?.transactionHash || "",
            explorer: explorerTx(Venue.lastReceipt?.hash || Venue.lastReceipt?.transactionHash || ""),
        });
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
        const receipt = await Venue.send(() => call(id), label);
        if (receipt) {
            Venue.recordFinanceActivity({
                category: "facility",
                title: method === "settle" ? "Native settlement processed" : "Margin checked",
                detail: "Confirmed permissionless vault write.",
                facilityId: method === "settle" ? Venue.financeUiState().selectedId || "" : id,
                txHash: receipt.hash || receipt.transactionHash,
                explorer: explorerTx(receipt.hash || receipt.transactionHash || ""),
            });
            await Venue.doRepo();
        }
    } finally {
        Venue.repoActionPending = false;
    }
};
