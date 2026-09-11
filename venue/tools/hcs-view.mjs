// The consensus topic, as the Rulebook screen reads it.
//
// Inlined only into `app/venue.html`, and after `tools/hcs.mjs`, whose `decode`,
// `describe`, `auditRecord` and `SITES` this file is built on. Kept out of
// `tools/venue-obs.mjs` for that reason: `venue-obs` goes into five screens and
// four of them have no topic panel, so putting the schema next to it would carry
// fourteen kilobytes of parser into four documents that never call it.
//
// The disclosure record as an ordered public stream. No key, no SDK, no
// subscription: `Venue.mirror` is the same paged REST read the tape uses.
//
// HCS is an ordered record, not a database. It has no query and no "current
// value"; to know what the topic says, a reader replays it. Replaying it from
// sequence one on every page load is the pattern that works at a hundred
// messages and fails at fifty thousand, so this screen does not. It boots from
// `HCS_INDEX`, the committed projection `tools/hcs-index.mjs` built and
// `tools/hcs-verify.mjs` rebuilt and compared, and asks the mirror node only
// for the messages after the snapshot's `throughSequence`. Before it appends
// that tail it fetches the snapshot's last message back and compares the
// network's own `running_hash`: a snapshot the topic does not recognise is not
// extended, it is set aside, and the screen reads the topic directly and says
// so. A build with no snapshot reads the topic directly too, as it always did.
//
// Two properties this screen is careful about, because it renders bytes that
// arrived over a network into a page with no server in front of it.
//
// **Nothing is rendered that `decode` did not vouch for.** A message that fails
// the schema is counted and named as unreadable rather than shown "best effort",
// and every value that does reach the DOM goes through `esc`. Snapshot records
// were decoded when the index was built and go through `validate` again here,
// because the property is cheaper to keep uniform than to argue about.
//
// **The tick is the verifier's tick.** "Check every record against the chain"
// runs `auditRecord`, the same function `tools/hcs-verify.mjs` runs, over the
// same mirror node results. A green mark here means what a green row means
// there, because it is one implementation.

const HCS_PAGE_LIMIT = 100;
const HCS_MAX_PAGES = 10;
const HCS_ACTION_LIMIT = 44;
const HCS_LIVENESS_LIMIT = 16;

Venue.hcsRecords = null;

const hcsIsLiveness = (k) => LIVENESS_KINDS.includes(k);

/// The committed snapshot, if this build carries one for this topic.
Venue.hcsSnapshot = function () {
    if (typeof HCS_INDEX === "undefined" || !HCS_INDEX) return null;
    if (!HCS || HCS_INDEX.topicId !== HCS.topicId) return null;
    if (!Number.isInteger(HCS_INDEX.throughSequence) || HCS_INDEX.throughSequence < 1) return null;
    return HCS_INDEX;
};

/// One mirror node message to one row, or null when its bytes are not a record.
function hcsRow(m) {
    let text;
    try {
        text = new TextDecoder().decode(Uint8Array.from(atob(m.message), (ch) => ch.charCodeAt(0)));
    } catch (e) {
        return null;
    }
    try {
        return {seq: Number(m.sequence_number), at: m.consensus_timestamp, rec: decode(text), audit: null};
    } catch (e) {
        return null;
    }
}

/// Follow a listing from `first`, newest or oldest first as the caller asked,
/// for at most `HCS_MAX_PAGES` pages. Returns the rows, the unreadable count,
/// how many messages were scanned, and whether the listing was cut short.
async function hcsListing(first) {
    let next = first;
    const seen = new Set();
    const rows = [];
    let unreadable = 0;
    let scanned = 0;
    for (let page = 0; next && page < HCS_MAX_PAGES; page++) {
        if (!/^\/api\/v1\//.test(next) || seen.has(next)) {
            throw new Error("The mirror node returned an invalid topic cursor.");
        }
        seen.add(next);
        const j = await Venue.mirror(next);
        for (const m of j.messages || []) {
            scanned++;
            const row = hcsRow(m);
            if (row) rows.push(row);
            else unreadable++;
        }
        next = j.links && j.links.next ? j.links.next : null;
    }
    return {rows, unreadable, scanned, truncated: !!next};
}

/// Liveness records make a stalled relay visible, but they must not push the
/// action receipts they vouch for out of the screen. Keep the newest action
/// records and a bounded recent liveness tail, then restore consensus order.
function hcsSelect(rows) {
    const newest = [...rows].sort((a, b) => b.seq - a.seq);
    const actions = newest.filter((row) => !hcsIsLiveness(row.rec.k)).slice(0, HCS_ACTION_LIMIT);
    const liveness = newest.filter((row) => hcsIsLiveness(row.rec.k)).slice(0, HCS_LIVENESS_LIMIT);
    return [...actions, ...liveness].sort((a, b) => b.seq - a.seq);
}

/// The topic read straight off the mirror node, newest first. What every build
/// did before the snapshot, and what a build still does when it has none or
/// when the snapshot turns out not to be the topic.
Venue.readTopicFull = async function (fallback) {
    const first = "/api/v1/topics/" + encodeURIComponent(HCS.topicId) +
        "/messages?order=desc&limit=" + HCS_PAGE_LIMIT;
    const got = await hcsListing(first);
    if (got.truncated) throw new Error("The topic exceeds the browser scan limit.");
    return {
        records: hcsSelect(got.rows),
        unreadable: got.unreadable,
        total: got.scanned,
        snapshot: null,
        live: got.scanned,
        truncated: false,
        fallback: fallback || null,
    };
};

/// The snapshot plus the live tail.
Venue.readTopicFrom = async function (snap) {
    const base = "/api/v1/topics/" + encodeURIComponent(HCS.topicId) + "/messages";
    // The network's running hash at the snapshot's head has to be the one the
    // snapshot recorded. This is the one check that does not trust the build.
    const head = await Venue.mirror(base + "/" + encodeURIComponent(String(snap.throughSequence)));
    if (!head || Number(head.sequence_number) !== snap.throughSequence) {
        throw new Error("the mirror node has no message at #" + snap.throughSequence);
    }
    if (snap.runningHash !== null && head.running_hash !== snap.runningHash) {
        throw new Error("the running hash at #" + snap.throughSequence + " is not the snapshot's");
    }

    let unreadable = 0;
    const rows = [];
    for (const row of [...(snap.actions || []), ...(snap.liveness || [])]) {
        try {
            rows.push({seq: Number(row.seq), at: row.at, rec: validate(row.rec), audit: null});
        } catch (e) {
            unreadable++;
        }
    }

    // `gte:` rather than `gt:` because the mirror node refuses `gt:0`, and the
    // two spell the same tail.
    const tail = await hcsListing(base + "?order=asc&limit=" + HCS_PAGE_LIMIT +
        "&sequencenumber=gte:" + encodeURIComponent(String(snap.throughSequence + 1)));
    rows.push(...tail.rows);
    return {
        records: hcsSelect(rows),
        unreadable: unreadable + tail.unreadable + (Number(snap.unreadable) || 0),
        total: snap.messages + tail.scanned,
        snapshot: {through: snap.throughSequence, builtAt: snap.builtAt || null, digest: snap.digest || null},
        live: tail.scanned,
        truncated: tail.truncated,
        fallback: null,
    };
};

Venue.readTopic = async function () {
    if (!HCS || !HCS.topicId) return null;
    const snap = Venue.hcsSnapshot();
    if (snap) {
        try {
            return await Venue.readTopicFrom(snap);
        } catch (e) {
            // A snapshot the topic does not recognise is set aside, not
            // rendered. The reason goes on screen with the full read.
            return Venue.readTopicFull(e && e.message ? e.message : String(e));
        }
    }
    return Venue.readTopicFull(null);
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
        : String(row.at ?? "Unknown");
    let verdict = "";
    if (row.audit) {
        const failed = row.audit.filter((x) => !x.pass);
        verdict = '<span class="hverdict ' + (failed.length ? "no" : "ok") + '">' +
            (failed.length ? "does not match" : "matches the chain") + "</span>";
        if (failed.length) {
            verdict += '<span class="hwhy">' +
                failed.map((x) => esc(x.name) + (x.detail ? ": " + esc(x.detail) : "")).join("<br>") +
                "</span>";
        }
    }
    // `r.tx` survived `hexField(..., 32)` so it cannot carry a quote, but the
    // href is escaped anyway: the rule in this client is that nothing off the
    // network reaches the DOM unescaped, and an exception that happens to be
    // safe today is how the next one gets written.
    const tx = r.tx
        ? " · <a href='" + esc(explorerTx(r.tx)) + "' target='_blank' rel='noopener noreferrer'>" +
          esc(shortId(r.tx)) + "</a>"
        : "";
    const raw = esc(JSON.stringify(r));
    return '<details class="iss-tape-row hline k-' + esc(r.k) + '">' +
        "<summary><div class='iss-tape-main'>" +
        '<span class="hseq">#' + esc(String(row.seq)) + "</span>" +
        '<span class="hkind">' + esc(r.k) + "</span>" +
        '<span class="hsay">' + esc(describe(r)) + verdict + "</span></div>" +
        '<span class="hat">' + esc(when) + tx + "</span></summary>" +
        '<div class="iss-tape-args"><span class="targ"><i>record</i>' + raw + "</span></div></details>";
};

Venue.paintTopic = function (state) {
    const el = $("hcs");
    if (!el) return;
    if (!HCS || !HCS.topicId) {
        el.innerHTML = '<div class="empty">No topic is configured in this build. ' +
            "Run <code>make hcs-topic</code>, then <code>make hcs-relay</code>.</div>";
        Venue.paintIssuerHcsHeader?.(null);
        return;
    }
    const scan = $("hcs-scan");
    if (scan) {
        scan.href = CLIENT.network.explorer + "/topic/" + encodeURIComponent(HCS.topicId);
        scan.hidden = false;
        scan.rel = "noopener noreferrer";
        scan.target = "_blank";
    }
    Venue.paintIssuerHcsHeader?.(state);
    if (!state || !state.records.length) {
        el.innerHTML = '<div class="empty">The topic <b>' + esc(HCS.topicId) +
            "</b> carries no readable record yet. " +
            "It fills as the venue acts and <code>tools/hcs-relay.mjs</code> runs.</div>";
        return;
    }
    const filter = ($("hcs-filter")?.value || "all");
    const filtered = state.records.filter((row) => {
        const kind = row.rec.k;
        if (filter === "all") return true;
        if (filter === "action") return !hcsIsLiveness(kind);
        if (filter === "liveness") return hcsIsLiveness(kind);
        return kind === filter;
    });
    const kinds = {};
    for (const row of state.records) kinds[row.rec.k] = (kinds[row.rec.k] || 0) + 1;
    const head = '<div class="hcs-head">' +
        '<span class="tid">' + esc(HCS.topicId) + "</span>" +
        '<span class="memo">' + esc(HCS.memo || "") + "</span>" +
        '<span class="count">' +
        esc(Object.keys(kinds).sort().map((k) => kinds[k] + " " + k).join(" · ")) +
        (state.unreadable ? " · " + state.unreadable + " unreadable" : "") +
        "</span></div>";
    let how;
    if (state.snapshot) {
        const built = state.snapshot.builtAt
            ? " built " + String(state.snapshot.builtAt).replace("T", " ").slice(0, 16) + "Z"
            : "";
        how = "Read from the committed snapshot through #" + esc(String(state.snapshot.through)) + esc(built) +
            ", plus " + esc(String(state.live)) + " live message" + (state.live === 1 ? "" : "s") +
            " after it from the mirror node." +
            (state.truncated
                ? " The snapshot is more than " + (HCS_PAGE_LIMIT * HCS_MAX_PAGES) +
                  " messages behind the topic and the tail was cut short; rebuild it with <code>make hcs-index</code>."
                : "");
    } else {
        how = "Read straight off the mirror node." +
            (state.fallback
                ? " The committed snapshot was set aside because " + esc(state.fallback) + "."
                : "");
    }
    how += " Checkpoints and anchors are not fully checked by the browser audit; " +
        "that verification belongs to the command-line verifier.";
    el.innerHTML = head + (filtered.length
        ? filtered.map(Venue.hcsLine).join("")
        : '<div class="empty">No records match this filter.</div>') +
        '<p class="note">' + how + " Newest action receipts plus recent checkpoints and anchors, selected from " +
        esc(String(state.total)) + " topic messages. Sequence number and consensus timestamp " +
        "come from the topic, not from this client. The topic is an ordered record, not a database: " +
        "the venue's state is on its contracts, and every record here points at the transaction that " +
        "can be checked against them.</p>";
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
/// does not match its log, a ceiling record that does not match the typed
/// revert, or a silence whose transaction reverted or did charge the row is
/// marked here in the same words `tools/hcs-verify.mjs` uses.
///
/// The per-epoch sum against `spentBits` is deliberately not run here. It is the
/// omission check, it needs a read per row per epoch, and a screen that fires
/// dozens of `eth_call`s off a button is a screen that trips HashIO's rate limit
/// during a demonstration. `make hcs-verify` is where that assertion lives.
Venue.auditTopic = async function () {
    await assertSiteDeployments(
        CLIENT.addresses,
        (address) => Venue.reader.getCode(address),
        ethers.keccak256,
    );
    if (!Venue.hcsRecords) await Venue.refreshTopic();
    const state = Venue.hcsRecords;
    if (!state || !state.records.length) return;

    // Checkpoints and anchors are checked against `spentBits`, which is one
    // `eth_call` per cell and belongs to `make hcs-verify`; the button audits
    // the records that name a transaction.
    const wanted = state.records.filter((row) => !hcsIsLiveness(row.rec.k));
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
    if (Venue.issuerUiState) {
        const hcs = {
            ...Venue.issuerUiState().hcs,
            checked: true,
            audited: true,
            auditFailed: failed > 0,
        };
        Venue.setIssuerUi({hcs});
        Venue.paintIssuerHcsHeader?.(state);
        Venue.renderIssuerOverview?.();
    }
    Venue.toast(failed
        ? failed + " record" + (failed === 1 ? "" : "s") + " did not match the chain"
        : wanted.length + " record" + (wanted.length === 1 ? "" : "s") + " match the chain");
    Venue.recordIssuerActivity?.({
        title: failed ? "HCS audit failed" : "HCS audit passed",
        detail: failed
            ? failed + " record(s) did not match the chain"
            : wanted.length + " record(s) matched the chain",
        source: "hcs-audit",
    });
};

/// Wire the two buttons. Called by `Venue.mountVenue` through an existence
/// check, so this file is optional to the screen booting. Topic history is
/// loaded lazily from the Activity & evidence drawer unless `{lazy:false}`.
Venue.mountTopic = async function (opts = {}) {
    $("hcs-reload")?.addEventListener("click", () => {
        const run = Venue.refreshIssuerEvidence
            ? Venue.refreshIssuerEvidence({force: true})
            : Venue.refreshTopic();
        run.catch((e) => Venue.fail(e));
    });
    $("hcs-audit")?.addEventListener("click", () => Venue.auditTopic().catch((e) => Venue.fail(e)));
    if (opts.lazy) return;
    // One paged read against the mirror node, on a different host from the one
    // serving `eth_call`, so the topic costs the trading screens nothing.
    await Venue.refreshTopic();
};
