import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

const source = readFileSync(new URL("./venue-obs.mjs", import.meta.url), "utf8");
const repoId = "0x" + "11".repeat(32);
const obligationId = "0x" + "22".repeat(32);

function harness() {
    const elements = new Map();
    const copied = [];
    const financingEvidence = {};
    const element = (id) => {
        if (!elements.has(id)) elements.set(id, {
            textContent: "", innerHTML: "", value: "", querySelectorAll: () => [],
            className: "", hidden: false, dataset: {},
            classList: {add: () => {}, remove: () => {}, toggle: () => {}},
            focus: () => {}, select: () => {},
        });
        return elements.get(id);
    };
    const Venue = {c: {watch: {calledAmong: async () => []}}};
    runInNewContext(source, {
        Venue, $: element, esc: String, shortId: String, shortAddr: String,
        asBig: BigInt, fmtRemain: String, addrEq: (a, b) => a === b,
        decodeRevert: (error) => ({message: error.message}),
        formatPrice: String, readableHbar: String, explorerAddr: String,
        WEIBAR_PER_TINYBAR: 10_000_000_000n,
        CLIENT: {
            addresses: {RepoVault: "vault", PrimeOracle: "oracle"},
            network: {chainId: 296, explorer: "https://example.test", mirror: "https://mirror.test"},
        },
        FINANCING_EVIDENCE: financingEvidence,
        ORACLE_TOPICS: [],
        ZERO: "zero", G: {EXACT: 4}, T: {IMM: 0},
        nowSec: () => 1_000n,
        navigator: {clipboard: {writeText: async (value) => copied.push(value)}},
        document: {
            execCommand: () => false,
            hidden: false,
            activeElement: null,
            documentElement: {classList: {add: () => {}, remove: () => {}}},
            addEventListener: () => {},
            querySelectorAll: () => [],
        },
        sessionStorage: {getItem: () => null, setItem: () => {}},
        localStorage: {getItem: () => null, setItem: () => {}},
        location: {search: "", origin: "https://example.test", pathname: "/repo.html"},
        URLSearchParams,
        URL,
        formatHbar: String,
        explorerTx: (hash) => "https://example.test/transaction/" + hash,
        setTimeout: () => {},
        Date,
        AbortController,
        fetch: async () => ({ok: true, json: async () => ({})}),
    });
    return {Venue, element, copied, financingEvidence};
}

test("order sides render as Buy or Sell instead of enum values", () => {
    const {Venue} = harness();
    assert.equal(Venue.fmtLogArg("side", 0n), "Buy");
    assert.equal(Venue.fmtLogArg("side", 1n), "Sell");
    assert.equal(Venue.fmtLogArg("side", 2n), "Unavailable");
});

test("dark oracle names the expired heartbeat and missing publisher", async () => {
    const {Venue, element} = harness();
    const publisherA = "0x" + "aa".repeat(20);
    const publisherB = "0x" + "bb".repeat(20);
    Venue.page = "repo";
    Venue.c.oracleScheduler = null;
    Venue.c.watch.feed = async () => ({
        dark: true,
        ourLegDark: true,
        cashLegDark: false,
        cleanPrice: 10_000_000_000n,
        refRateBps: 364n,
        publishedAt: 100n,
        usdPerHbar: 8_000_000n,
        markPerUnitTinybar: 0n,
        cashFeed: "cash",
    });
    Venue.c.oracle = {
        publishers: async () => [publisherA, publisherB],
        quorum: async () => 2n,
        heartbeat: async () => 100n,
        cashHeartbeat: async () => 200n,
        maxDeviationBps: async () => 500n,
        lastRound: async () => 2n,
        openRound: async () => 3n,
        cashLeg: async () => ({updatedAt: 1_000n}),
        panelOf: async () => [{by: publisherA}],
    };
    await Venue.refreshOracle();
    assert.equal(element("feed-open").innerHTML, "1 of 2 for round 3");
    assert.match(element("feed-failure").textContent, /panel heartbeat expired/i);
    assert.match(element("feed-failure").textContent, /missing 0xbb/);
    assert.match(element("feed-countdown").textContent, /Expired/);
    assert.equal(element("feed-scheduler").textContent, "Not deployed");

    Venue.c.watch.feed = async () => ({
        dark: false,
        ourLegDark: false,
        cashLegDark: false,
        cleanPrice: 10_000_000_000n,
        refRateBps: 364n,
        publishedAt: 950n,
        usdPerHbar: 8_000_000n,
        markPerUnitTinybar: 125_000_000n,
        cashFeed: "cash",
    });
    Venue.c.oracle.lastRound = async () => 3n;
    Venue.c.oracle.openRound = async () => 4n;
    Venue.c.oracle.panelOf = async () => [];
    await Venue.refreshOracle();
    assert.equal(element("feed-state").innerHTML, "live");
    assert.equal(element("feed-price").innerHTML, "10000000000 USD");
    assert.equal(element("feed-scheduler").textContent, "Not deployed");
    assert.equal(element("feed-failure").hidden, true);
    assert.doesNotMatch(element("feed-failure").textContent, /Scheduler not deployed/);

    Venue.c.watch.feed = async () => {
        throw new Error("testnet RPC timed out");
    };
    assert.equal(await Venue.pollOracle(), false);
    assert.equal(element("feed-state").textContent, "RPC unavailable");
    assert.equal(element("feed-price").textContent, "Unavailable");
    assert.match(element("feed-failure").textContent, /RPC refresh failed.*timed out/);
});

test("scheduled obligation identifiers never become repo positions", async () => {
    const {Venue} = harness();
    Venue.history = async () => [
        {name: "Scheduled", args: [obligationId], at: 3},
        {name: "Unscheduled", args: [obligationId], at: 2},
        {name: "MarginCalled", args: [repoId], at: 2},
        {name: "Opened", args: [repoId], at: 1},
    ];
    await Venue.discoverRepos();
    assert.equal(Venue.knownRepos.length, 1);
    assert.equal(Venue.knownRepos[0].id, repoId);
    assert.equal(Venue.knownRepos[0].n, 2);
    assert.equal(Venue.knownRepos[0].last, "MarginCalled");
});

test("a page of scheduler events does not invent a repo", async () => {
    const {Venue} = harness();
    Venue.history = async () => [{name: "Scheduled", args: [obligationId], at: 1}];
    await Venue.discoverRepos();
    assert.equal(Venue.knownRepos.length, 0);
});

test("the lender can copy the agreement id for the named borrower", async () => {
    const {Venue, element, copied} = harness();
    element("fin-id").value = repoId;

    await Venue.copyFinanceId();

    assert.deepEqual(copied, [repoId]);
    assert.equal(element("fin-id-copy").textContent, "Copied");
});

test("verified financing receipts render automatic, historical, and lifecycle links", () => {
    const {Venue, element, financingEvidence} = harness();
    financingEvidence.automatic = {
        id: repoId,
        vault: {contractId: "0.0.3"},
        cash: {principalTinybar: "100"},
        receipts: {
            accept: {tx: "0xaccept", hashscan: "https://hashscan.test/accept"},
        },
        automaticSettlement: {
            result: "SUCCESS",
            executionDelaySeconds: 2,
            evmBlockTimestamp: 1_000,
            hashscan: "https://hashscan.test/automatic",
        },
    };
    financingEvidence.production = {
        id: repoId,
        cash: {principalTinybar: "100", closePaidTinybar: "101"},
        receipts: {
            fundOffer: {tx: "0xfund", hashscan: "https://hashscan.test/fund"},
            close: {tx: "0xclose", hashscan: "https://hashscan.test/close"},
            settleFailFallback: {
                tx: "0xfallback",
                hashscan: "https://hashscan.test/fallback",
            },
        },
        hssBoundary: {
            scheduledExecution: {hashscan: "https://hashscan.test/scheduled"},
            manualFallback: {result: "SETTLED"},
        },
    };
    financingEvidence.lifecycle = {
        position1: {id: repoId},
        position2: {id: obligationId},
        deployment: {
            contracts: {
                RepoVault: {contractId: "0.0.1"},
                MarginWatch: {contractId: "0.0.2"},
            },
        },
        receipts: {
            "position1-mark": {tx: "0xmark", hashscan: "https://hashscan.test/mark"},
            "position2-settle-default": {
                tx: "0xdefault",
                hashscan: "https://hashscan.test/default",
            },
        },
    };
    Venue.paintFinancingEvidence();
    assert.match(element("fin-evidence").innerHTML, /Fund offer/);
    assert.doesNotMatch(element("fin-evidence").innerHTML, /fundOffer|markToMarket|settleDefault|RepoVault|MarginWatch/);
    assert.match(element("fin-evidence").innerHTML, /automatic HSS success/);
    assert.match(element("fin-evidence").innerHTML, /0\.0\.3/);
    assert.match(element("fin-evidence").innerHTML, /hashscan\.test\/automatic/);
    assert.match(element("fin-evidence").innerHTML, /Mark posted/);
    assert.match(element("fin-evidence").innerHTML, /Settle default/);
    assert.match(element("fin-evidence").innerHTML, /Fallback settled/);
    assert.match(element("fin-evidence").innerHTML, /hashscan\.test\/scheduled/);
    assert.match(element("fin-evidence").innerHTML, /hashscan\.test\/fallback/);
    assert.match(element("fin-evidence").innerHTML, /0\.0\.1/);
    assert.match(element("fin-evidence").innerHTML, /hashscan\.test\/default/);
});

test("penalty display preserves hundredths of a basis point per day", async () => {
    const {Venue, element} = harness();
    Venue.c.watch.vault = async () => "vault";
    Venue.c.watch.stream = async () => ({});
    for (const [rate, label] of [[0n, "0.00"], [1n, "0.01"], [10n, "0.10"], [125n, "1.25"]]) {
        Venue.c.vault = {
            failGrace: async () => 432000n, penaltyRate: async () => rate,
            marginEngine: async () => "engine", security: async () => "bond",
            policy: async () => "policy",
        };
        await Venue.refreshVault();
        assert.equal(element("rv-penalty").textContent, label + " bps per day");
    }
});

test("repo actions simulate before signing and refresh after confirmation", async () => {
    const {Venue} = harness();
    const steps = [];
    const call = async (id) => { steps.push("send:" + id); return {}; };
    call.staticCall = async (id) => { steps.push("check:" + id); };
    Venue.requireAccount = async () => { steps.push("wallet"); };
    Venue.w = {vault: {settle: call}};
    Venue.send = async (txFactory) => { await txFactory(); return {status: 1}; };
    Venue.doRepo = async () => { steps.push("refresh"); };
    await Venue.doRepoAction("settle", obligationId, "Process coupon");
    assert.deepEqual(steps, ["wallet", "check:" + obligationId, "send:" + obligationId, "refresh"]);
    assert.equal(Venue.repoActionPending, false);
});

test("repo actions reject unsupported writes and failed simulation", async () => {
    const {Venue} = harness();
    await assert.rejects(Venue.doRepoAction("close", repoId, "Close"), /Unsupported/);
    await assert.rejects(Venue.doRepoAction("settle", "bad", "Process"), /Invalid/);
    let sent = false;
    const call = async () => { sent = true; };
    call.staticCall = async () => { throw new Error("SettlementNotDue"); };
    Venue.requireAccount = async () => {};
    Venue.w = {vault: {settle: call}};
    await assert.rejects(Venue.doRepoAction("settle", obligationId, "Process"), /SettlementNotDue/);
    assert.equal(sent, false);
    assert.equal(Venue.repoActionPending, false);
});

test("ATS collateral approval is confirmed before acceptance", async () => {
    const {Venue, element} = harness();
    const steps = [];
    let allowance = 0n;
    const approve = async (_vault, amount) => {
        steps.push("send approval:" + amount);
        allowance = amount;
        return {};
    };
    approve.staticCall = async (_vault, amount) => {
        steps.push("check approval:" + amount);
    };
    const accept = async (id) => {
        steps.push("send accept:" + id);
        return {};
    };
    accept.staticCall = async (id) => {
        steps.push("check accept:" + id);
    };

    element("fin-id").value = repoId;
    Venue.account = "borrower";
    Venue.requireAccount = async () => {};
    Venue.c.token = {
        allowance: async () => allowance,
        balanceOfByPartition: async () => 10n,
    };
    Venue.c.vault = {
        offers: async () => ({
            lender: "lender",
            borrower: "borrower",
            principal: 10n,
            expiresAt: (1n << 64n) - 1n,
            terms: {partition: "series", collateralAmount: 10n},
        }),
        quotePrincipal: async () => 10n,
    };
    Venue.c.registry = {getKycStatus: async () => 1n};
    Venue.w = {token: {approve}, vault: {accept}};
    Venue.send = async (txFactory) => {
        await txFactory();
        return {status: 1};
    };
    Venue.doRepo = async () => { steps.push("refresh repo"); };
    Venue.discoverRepos = async () => { steps.push("refresh list"); };
    Venue.noteReceipt = async () => { steps.push("receipt"); };

    await assert.rejects(Venue.doAcceptOffer(), /Authorize the collateral lot first/);
    assert.deepEqual(steps, []);
    await Venue.ensureVaultAllowance(10n);
    await Venue.doAcceptOffer();
    assert.deepEqual(steps, [
        "check approval:10",
        "send approval:10",
        "check accept:" + repoId,
        "send accept:" + repoId,
        "refresh repo",
        "refresh list",
        "receipt",
    ]);
    assert.equal(Venue.repoActionPending, false);
});

test("existing ATS allowance avoids a redundant wallet signature", async () => {
    const {Venue} = harness();
    Venue.account = "borrower";
    Venue.requireAccount = async () => {};
    Venue.c.token = {allowance: async () => 25n};
    Venue.w = {
        token: {
            approve: Object.assign(async () => {
                throw new Error("approval should not be sent");
            }, {staticCall: async () => {}}),
        },
    };
    assert.equal(await Venue.ensureVaultAllowance(10n), false);
});

test("an unnamed wallet is refused before any collateral approval", async () => {
    const {Venue, element} = harness();
    element("fin-id").value = repoId;
    Venue.account = "stranger";
    Venue.requireAccount = async () => {};
    Venue.c.vault = {
        offers: async () => ({
            lender: "lender",
            borrower: "borrower",
            principal: 10n,
            expiresAt: (1n << 64n) - 1n,
            terms: {partition: "series", collateralAmount: 10n},
        }),
        quotePrincipal: async () => 10n,
    };
    Venue.c.token = {balanceOfByPartition: async () => 10n};
    Venue.ensureVaultAllowance = async () => {
        throw new Error("approval must not be reached");
    };

    await assert.rejects(
        Venue.doAcceptOffer(),
        /Only the borrower named by the lender/,
    );
    assert.equal(Venue.repoActionPending, false);
});

test("an expired offer is refused before collateral approval", async () => {
    const {Venue, element} = harness();
    element("fin-id").value = repoId;
    Venue.account = "borrower";
    Venue.requireAccount = async () => {};
    Venue.c.vault = {
        offers: async () => ({
            lender: "lender",
            borrower: "borrower",
            principal: 10n,
            expiresAt: 1n,
            terms: {partition: "series", collateralAmount: 10n},
        }),
    };
    Venue.ensureVaultAllowance = async () => {
        throw new Error("approval must not be reached");
    };

    await assert.rejects(Venue.doAcceptOffer(), /offer expired/);
    assert.equal(Venue.repoActionPending, false);
});

test("a moved valuation is refused before collateral approval", async () => {
    const {Venue, element} = harness();
    element("fin-id").value = repoId;
    Venue.account = "borrower";
    Venue.requireAccount = async () => {};
    Venue.c.vault = {
        offers: async () => ({
            lender: "lender",
            borrower: "borrower",
            principal: 10n,
            expiresAt: (1n << 64n) - 1n,
            terms: {partition: "series", collateralAmount: 10n},
        }),
        quotePrincipal: async () => 11n,
    };
    Venue.c.registry = {getKycStatus: async () => 1n};
    Venue.c.token = {balanceOfByPartition: async () => 10n};
    Venue.ensureVaultAllowance = async () => {
        throw new Error("approval must not be reached");
    };

    await assert.rejects(Venue.doAcceptOffer(), /valuation moved/);
    assert.equal(Venue.repoActionPending, false);
});

test("expired lender eligibility blocks acceptance before approval", async () => {
    const {Venue, element} = harness();
    element("fin-id").value = repoId;
    Venue.account = "borrower";
    Venue.requireAccount = async () => {};
    Venue.c.vault = {
        offers: async () => ({
            lender: "lender",
            borrower: "borrower",
            principal: 10n,
            expiresAt: (1n << 64n) - 1n,
            terms: {partition: "series", collateralAmount: 10n},
        }),
        quotePrincipal: async () => 10n,
    };
    Venue.c.token = {balanceOfByPartition: async () => 10n};
    Venue.c.registry = {
        getKycStatus: async (who) => who === "borrower" ? 1n : 0n,
    };
    Venue.ensureVaultAllowance = async () => {
        throw new Error("approval must not be reached");
    };

    await assert.rejects(
        Venue.doAcceptOffer(),
        /Both borrower and lender need current eligibility/,
    );
    assert.equal(Venue.repoActionPending, false);
});

test("expired borrower eligibility blocks collateral approval", async () => {
    const {Venue} = harness();
    Venue.account = "borrower";
    Venue.requireAccount = async () => {};
    Venue.c.registry = {getKycStatus: async () => 0n};
    Venue.ensureVaultAllowance = async () => {
        throw new Error("approval must not be reached");
    };

    await assert.rejects(
        Venue.addFacilityCollateral(repoId, "10"),
        /Renew borrower eligibility/,
    );
});

test("default recovery explains that the lender must renew", async () => {
    const {Venue} = harness();
    Venue.c.vault = {repo: async () => ({lender: "lender"})};
    Venue.c.registry = {getKycStatus: async () => 0n};
    Venue.doFinanceWrite = async () => {
        throw new Error("settlement must not be reached");
    };

    await assert.rejects(
        Venue.settleFacilityDefault(repoId),
        /lender must renew eligibility/,
    );
});
