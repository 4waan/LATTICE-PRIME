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
    const element = (id) => {
        if (!elements.has(id)) elements.set(id, {
            textContent: "", innerHTML: "", value: "", querySelectorAll: () => [],
            focus: () => {}, select: () => {},
        });
        return elements.get(id);
    };
    const Venue = {c: {watch: {calledAmong: async () => []}}};
    runInNewContext(source, {
        Venue, $: element, esc: String, shortId: String, shortAddr: String,
        asBig: BigInt, fmtRemain: String, addrEq: (a, b) => a === b,
        CLIENT: {addresses: {RepoVault: "vault"}},
        ZERO: "zero", G: {EXACT: 4}, T: {IMM: 0},
        nowSec: () => 1_000n,
        navigator: {clipboard: {writeText: async (value) => copied.push(value)}},
        document: {execCommand: () => false},
        setTimeout: () => {},
    });
    return {Venue, element, copied};
}

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
    Venue.send = async (pending) => { await pending; return {status: 1}; };
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
    Venue.send = async (pending) => {
        await pending;
        return {status: 1};
    };
    Venue.doRepo = async () => { steps.push("refresh repo"); };
    Venue.discoverRepos = async () => { steps.push("refresh list"); };
    Venue.noteReceipt = async () => { steps.push("receipt"); };

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
