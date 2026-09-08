// The consensus topic, as the Rulebook screen reads it.
//
// Inlined only into `app/venue.html`, and after `tools/hcs.mjs`, whose `decode`,
// `describe`, `auditRecord` and `SITES` this file is built on. Kept out of
// `tools/venue-obs.mjs` for that reason: `venue-obs` goes into five screens and
// four of them have no topic panel, so putting the schema next to it would carry
// fourteen kilobytes of parser into four documents that never call it.
//
// The disclosure record as an ordered public stream, read straight off the
// mirror node's topic index. No key, no SDK, no subscription: `Venue.mirror` is
// the same paged REST read the tape uses.
//
// Two properties this screen is careful about, because it renders bytes that
// arrived over a network into a page with no server in front of it.
//
// **Nothing is rendered that `decode` did not vouch for.** A message that fails
// the schema is counted and named as unreadable rather than shown "best effort",
// and every value that does reach the DOM goes through `esc`.
//
// **The tick is the verifier's tick.** "Check every record against the chain"
// runs `auditRecord`, the same function `tools/hcs-verify.mjs` runs, over the
// same mirror node results. A green mark here means what a green row means
// there, because it is one implementation.

const HCS_LIMIT = 60;

Venue.hcsRecords = null;

Venue.readTopic = async function () {
    if (!HCS || !HCS.topicId) return null;
    const j = await Venue.mirror(
        "/api/v1/topics/" + encodeURIComponent(HCS.topicId) +
        "/messages?order=desc&limit=" + HCS_LIMIT);
    const out = [];
    let unreadable = 0;
    for (const m of j.messages || []) {
        let text;
        try {
            text = new TextDecoder().decode(
                Uint8Array.from(atob(m.message), (ch) => ch.charCodeAt(0)));
        } catch (e) {
            unreadable++;
            continue;
        }
        try {
            out.push({
                seq: Number(m.sequence_number),
                at: m.consensus_timestamp,
                rec: decode(text),
                audit: null,
            });
        } catch (e) {
            unreadable++;
        }
    }
    return {records: out, unreadable, total: (j.messages || []).length};
};

/// One record's line. `describe` is `tools/hcs.mjs`'s, so this screen and the
/// verifier's table say the same sentence about the same record.
Venue.hcsLine = function (row) {
    const r = row.rec;
    // A consensus timestamp is `seconds.nanos`. If the index ever hands back
    // something else, print the raw value rather than letting `toISOString`
    // throw and take the whole panel down mid-demonstration.
    const seconds = Number(String(row.at ?? "").split(".")[0]);
    const when = Number.isFinite(seconds) && seconds > 0
        ? new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z"
        : String(row.at ?? "—");
    let verdict = "";
    if (row.audit) {
        const failed = row.audit.filter((x) => !x.pass);
        verdict = '<span class="hverdict ' + (failed.length ? "no" : "ok") + '">' +
            (failed.length ? "does not match" : "matches the chain") + "</span>";
        if (failed.length) {
            verdict += '<span class="hwhy">' +
                failed.map((x) => esc(x.name) + (x.detail ? " — " + esc(x.detail) : "")).join("<br>") +
                "</span>";
        }
    }
    // `r.tx` survived `hexField(..., 32)` so it cannot carry a quote, but the
    // href is escaped anyway: the rule in this client is that nothing off the
    // network reaches the DOM unescaped, and an exception that happens to be
    // safe today is how the next one gets written.
    const tx = r.tx
        ? " · <a href='" + esc(explorerTx(r.tx)) + "' rel='noopener'>" + esc(shortId(r.tx)) + "</a>"
        : "";
    return '<div class="hline k-' + esc(r.k) + '">' +
        '<span class="hseq">#' + esc(String(row.seq)) + "</span>" +
        '<span class="hkind">' + esc(r.k) + "</span>" +
        '<span class="hsay">' + esc(describe(r)) + verdict + "</span>" +
        '<span class="hat">' + esc(when) + tx + "</span></div>";
};

Venue.paintTopic = function (state) {
    const el = $("hcs");
    if (!el) return;
    if (!HCS || !HCS.topicId) {
        el.innerHTML = '<div class="empty">No topic is configured in this build. ' +
            "Run <code>make hcs-topic</code>, then <code>make hcs-relay</code>.</div>";
        return;
    }
    const scan = $("hcs-scan");
    if (scan) {
        scan.href = CLIENT.network.explorer + "/topic/" + HCS.topicId;
        scan.hidden = false;
    }
    if (!state || !state.records.length) {
        el.innerHTML = '<div class="empty">The topic <b>' + esc(HCS.topicId) +
            "</b> carries no readable record yet. " +
            "It fills as the venue acts and <code>tools/hcs-relay.mjs</code> runs.</div>";
        return;
    }
    const kinds = {};
    for (const row of state.records) kinds[row.rec.k] = (kinds[row.rec.k] || 0) + 1;
    const head = '<div class="hcs-head">' +
        '<span class="tid">' + esc(HCS.topicId) + "</span>" +
        '<span class="memo">' + esc(HCS.memo || "") + "</span>" +
        '<span class="count">' +
        esc(Object.keys(kinds).sort().map((k) => kinds[k] + " " + k).join(" · ")) +
        (state.unreadable ? " · " + state.unreadable + " unreadable" : "") +
        "</span></div>";
    el.innerHTML = head + state.records.map(Venue.hcsLine).join("") +
        '<p class="note">Newest first, at most ' + HCS_LIMIT +
        ". Sequence number and consensus timestamp come from the topic, not from this client.</p>";
};

Venue.refreshTopic = async function () {
    Venue.hcsRecords = await Venue.readTopic();
    Venue.paintTopic(Venue.hcsRecords);
};

/// The disclosure epoch from which the parameter set now in force has been in
/// force, off `ParameterRoot`'s own `Adopted` history.
///
/// `budgetFor(row)` reads current state, so a silence claimed before this
/// boundary was measured against a bound that was not in force when the
/// transaction ran. `tools/hcs-relay.mjs` refuses to publish one and
/// `tools/hcs-verify.mjs` refuses to accept one; without this read the tab would
/// call such a record a match while `make hcs-verify` failed it, and the two
/// have to agree or the tick means nothing.
Venue.policyFrom = async function () {
    const iface = Venue.iface("ParameterRoot");
    const adopted = iface.getEvent("Adopted").topicHash;
    const [j, root] = await Promise.all([
        Venue.mirror("/api/v1/contracts/" + CLIENT.addresses.ParameterRoot +
            "/results/logs?order=asc&limit=100"),
        Venue.c.policy.root(),
    ]);
    const want = String(root).toLowerCase();
    let fallback = 0;
    for (const l of j.logs || []) {
        if (String(l.topics[0]).toLowerCase() !== adopted.toLowerCase()) continue;
        const e = Number(BigInt("0x" + String(l.data).replace(/^0x/, "").slice(0, 64)));
        fallback = e;
        if (String(l.topics[1]).toLowerCase() === want) return e;
    }
    return fallback;
};

/// The verifier's own check, run in the tab.
///
/// Every record that names a transaction gets that transaction fetched back from
/// the mirror node and compared field for field by `auditRecord`. A charge that
/// does not match its log, or a silence whose transaction reverted or did charge
/// the row, is marked here in the same words `tools/hcs-verify.mjs` uses.
///
/// The per-epoch sum against `spentBits` is deliberately not run here. It is the
/// omission check, it needs a read per row per epoch, and a screen that fires
/// dozens of `eth_call`s off a button is a screen that trips HashIO's rate limit
/// during a demonstration. `make hcs-verify` is where that assertion lives.
Venue.auditTopic = async function () {
    if (!Venue.hcsRecords) await Venue.refreshTopic();
    const state = Venue.hcsRecords;
    if (!state || !state.records.length) return;

    const wanted = state.records.filter((row) => row.rec.k !== "checkpoint");
    const policyFrom = wanted.some((row) => row.rec.k === "silence")
        ? await Venue.policyFrom()
        : 0;
    const byTx = new Map();
    for (const row of wanted) {
        if (!byTx.has(row.rec.tx)) {
            byTx.set(row.rec.tx, Venue.mirror(
                "/api/v1/contracts/results/" + encodeURIComponent(row.rec.tx))
                .catch((e) => ({error: e.message})));
        }
    }
    const results = new Map();
    for (const [tx, p] of byTx) results.set(tx, await p);

    // One read per metered row, not one per record: the budget is a governed
    // parameter and does not move between two records of the same run.
    const budgets = new Map();
    for (const row of wanted) {
        if (row.rec.k !== "silence" || budgets.has(row.rec.r)) continue;
        budgets.set(row.rec.r, await Venue.c.policy.budgetFor(row.rec.r));
    }

    for (const row of wanted) {
        const res = results.get(row.rec.tx);
        const ctx = {
            address: row.rec.a || CLIENT.addresses[SOURCE_ADDRESS_KEY[row.rec.c]],
            epoch: res && res.timestamp
                ? Math.max(0, Math.floor(
                    (Number(String(res.timestamp).split(".")[0]) -
                        Number(CLIENT.clocks.disclosure.origin)) /
                    Number(CLIENT.clocks.disclosure.period)))
                : -1,
        };
        if (row.rec.k === "silence") {
            const b = budgets.get(row.rec.r);
            const shaped = {
                domainBits: Number(b.domainBits), aggBits: Number(b.aggBits),
                bucketBits: Number(b.bucketBits), budgetBits: Number(b.budgetBits),
            };
            ctx.budgetBits = shaped.budgetBits;
            ctx.cost = bits(shaped, SITES[row.rec.sel].rows.find((x) => x.row === row.rec.r).g);
        }
        row.audit = auditRecord(row.rec, res, ctx);
        if (row.rec.k === "silence") {
            row.audit.unshift({
                name: "is not before the parameter set took effect",
                pass: row.rec.e >= policyFrom,
                detail: "adopted at epoch " + policyFrom,
            });
        }
    }
    Venue.paintTopic(state);
    const failed = wanted.filter((row) => row.audit.some((x) => !x.pass)).length;
    Venue.toast(failed
        ? failed + " record" + (failed === 1 ? "" : "s") + " did not match the chain"
        : wanted.length + " record" + (wanted.length === 1 ? "" : "s") + " match the chain");
};

/// Wire the two buttons and take the first read. Called by `Venue.mountVenue`
/// through an existence check, so this file is optional to the screen booting.
Venue.mountTopic = async function () {
    $("hcs-reload")?.addEventListener("click", () => Venue.refreshTopic().catch((e) => Venue.fail(e)));
    $("hcs-audit")?.addEventListener("click", () => Venue.auditTopic().catch((e) => Venue.fail(e)));
    // One paged read against the mirror node, on a different host from the one
    // serving `eth_call`, so the topic costs the trading screens nothing.
    await Venue.refreshTopic();
};
