import {readFileSync, writeFileSync} from "node:fs";
import {Contract, JsonRpcProvider, getAddress, keccak256} from "ethers";

if (process.env.SUPERSEDE_FINANCING_ACK !== "1") {
    throw new Error("candidate promotion requires SUPERSEDE_FINANCING_ACK=1");
}

const rpc = process.env.HEDERA_TESTNET_RPC;
if (!rpc) throw new Error("set HEDERA_TESTNET_RPC");

const deploymentPath = "deployments/296-venue.json";
const candidatePath = "deployments/.financing-deploy/candidate.json";
const canaryPath = "deployments/financing-hss-canary.json";
const boundaryPath = "deployments/financing-beat.json";

const deployment = JSON.parse(readFileSync(deploymentPath));
const candidate = JSON.parse(readFileSync(candidatePath));
const canary = JSON.parse(readFileSync(canaryPath));
const boundary = JSON.parse(readFileSync(boundaryPath));
const provider = new JsonRpcProvider(rpc, 296, {staticNetwork: true});

const vaultAbi = [
    "function FINANCING_VERSION() view returns (uint8)",
    "function stateOf(bytes32) view returns (uint8)",
    "function failObligation(bytes32) view returns (bytes32)",
    "function obligation(bytes32) view returns (address,bytes32,uint64,uint256,uint8,uint8)",
    "function cashReserved() view returns (uint256)",
    "function reservedFunding() view returns (uint256)",
    "function credit(address) view returns (uint256)",
    "function fundedFor() view returns (uint256)",
];
const watchAbi = ["function vault() view returns (address)"];
const tokenAbi = ["function compliance() view returns (address)"];

const sameAddress = (a, b) => a.toLowerCase() === b.toLowerCase();
const check = (ok, message) => {
    if (!ok) throw new Error(message);
};

const oldFinancing = deployment.financing;
const oldVaultAddress = oldFinancing.RepoVault.address;
const oldWatchAddress = oldFinancing.MarginWatch.address;
const newVaultRecord = candidate.contracts.RepoVault;
const newWatchRecord = candidate.contracts.MarginWatch;
const approvalRecord = candidate.contracts.ApprovalWindowCompliance;

check(candidate.kind === "timestamp-tolerant-candidate", "wrong candidate kind");
check(candidate.bindingChanged === false, "candidate was not staged off binding");
check(canary.status === "verified", "automatic HSS canary is not verified");
check(
    sameAddress(candidate.outgoing.vault, oldVaultAddress),
    "candidate outgoing vault does not match the current deployment",
);
check(
    sameAddress(deployment.venue.RepoVault, oldVaultAddress) &&
    sameAddress(deployment.venue.MarginWatch, oldWatchAddress),
    "deployment changed before guarded promotion",
);
check(
    sameAddress(canary.vault.address, newVaultRecord.address) &&
    canary.vault.contractId === newVaultRecord.contractId,
    "canary does not belong to the candidate vault",
);
check(
    canary.automaticSettlement.result === "SUCCESS" &&
    canary.automaticSettlement.manualFallbackSent === false,
    "canary did not prove automatic HSS success",
);
check(
    canary.automaticSettlement.expirationTime.startsWith(
        String(canary.automaticSettlement.economicDueAt + 2),
    ),
    "canary schedule is not two seconds after economic due",
);
check(
    canary.automaticSettlement.evmBlockTimestamp >=
    canary.automaticSettlement.economicDueAt,
    "canary EVM clock was before economic due",
);

const oldVault = new Contract(oldVaultAddress, vaultAbi, provider);
const oldWatch = new Contract(oldWatchAddress, watchAbi, provider);
const newVault = new Contract(newVaultRecord.address, vaultAbi, provider);
const newWatch = new Contract(newWatchRecord.address, watchAbi, provider);
const token = new Contract(deployment.token.address, tokenAbi, provider);

check(
    sameAddress(await oldWatch.vault(), oldVaultAddress),
    "outgoing MarginWatch is not bound to the outgoing vault",
);
const knownRepoIds = [...new Set([
    boundary.id,
    oldFinancing.demonstration?.repoId,
].filter(Boolean))];
for (const id of knownRepoIds) {
    check(Number(await oldVault.stateOf(id)) === 7, `outgoing repo ${id} is not CLOSED`);
    const obligationId = await oldVault.failObligation(id);
    const obligation = await oldVault.obligation(obligationId);
    check(Number(obligation[5]) === 3, `outgoing repo ${id} obligation is not SETTLED`);
}

const borrower = canary.borrower;
const lender = canary.lender;
check((await oldVault.cashReserved()) === 0n, "outgoing vault has cash reserved");
check((await oldVault.reservedFunding()) === 0n, "outgoing vault has HSS funding reserved");
check((await oldVault.credit(borrower)) === 0n, "outgoing vault has borrower credit");
check((await oldVault.credit(lender)) === 0n, "outgoing vault has lender credit");
const oldBalance = await provider.getBalance(oldVaultAddress);
check(
    oldBalance.toString() === candidate.outgoing.balanceWeibar,
    "outgoing vault balance changed after candidate staging",
);

check((await newVault.FINANCING_VERSION()) === 5n, "candidate is not RepoVault v5");
check(
    sameAddress(await newWatch.vault(), newVaultRecord.address),
    "candidate MarginWatch is not bound to the candidate vault",
);
check(
    Number(await newVault.stateOf(canary.id)) === 7,
    "candidate canary repo is not CLOSED",
);
const canaryObligation = await newVault.obligation(
    canary.automaticSettlement.failObligation,
);
check(Number(canaryObligation[5]) === 3, "candidate obligation is not SETTLED");
check((await newVault.cashReserved()) === 0n, "candidate has cash reserved");
check((await newVault.reservedFunding()) === 0n, "candidate has HSS funding reserved");
check((await newVault.credit(borrower)) === 0n, "candidate has borrower credit");
check((await newVault.credit(lender)) === 0n, "candidate has lender credit");
check(
    (await newVault.fundedFor()).toString() ===
    canary.snapshots.additionalCallsFunded,
    "candidate funded call count changed",
);
check(
    (await provider.getBalance(newVaultRecord.address)).toString() ===
    canary.snapshots.finalVaultBalanceWeibar,
    "candidate balance changed after the canary",
);
const runtime = await provider.getCode(newVaultRecord.address);
check(
    keccak256(runtime) === candidate.runtime.RepoVaultKeccak256,
    "candidate runtime hash mismatch",
);
check(
    (runtime.length - 2) / 2 === candidate.runtime.RepoVaultBytes,
    "candidate runtime size mismatch",
);
check(
    sameAddress(await token.compliance(), deployment.venue.SeamJournal),
    "ATS compliance journal was not restored",
);

const promotedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
deployment.venue.RepoVault = getAddress(newVaultRecord.address);
deployment.venue.MarginWatch = getAddress(newWatchRecord.address);
deployment.venue.contractIds.RepoVault = newVaultRecord.contractId;
deployment.venue.contractIds.MarginWatch = newWatchRecord.contractId;
deployment.venue.feed.deployTx.RepoVault = newVaultRecord.tx;
deployment.venue.feed.deployTx.MarginWatch = newWatchRecord.tx;
deployment.venue.feed.deployTx.fundRepoVault = candidate.operatingReserveTx;

deployment.superseded.repoVaultBeforeHssTolerance = {
    why:
        "This RepoVault v5 scheduled at the exact economic due second. Hedera " +
        "consensus reached that second while the EVM block timestamp was one " +
        "second earlier, so HSS reverted and the permissionless fallback settled it.",
    supersededAt: promotedAt,
    stillCallable: true,
    migrated: false,
    RepoVault: oldFinancing.RepoVault,
    MarginWatch: oldFinancing.MarginWatch,
    knownRepoIds,
    knownState: {
        repos: "CLOSED",
        obligations: "SETTLED",
        cashReservedTinybar: "0",
        reservedFundingTinybar: "0",
        borrowerCreditTinybar: "0",
        lenderCreditTinybar: "0",
    },
    unreservedBalance: {
        weibar: oldBalance.toString(),
        hbar: "19.9696972",
        withdrawable: false,
        note:
            "The old contract has no owner reserve withdrawal path. The balance " +
            "was not migrated or deleted.",
    },
    successfulManualFallback: oldFinancing.demonstration.hssBoundary,
    approvalWindow: oldFinancing.approvalWindow,
    evidence: boundaryPath,
};

deployment.financing = {
    version: 5,
    deployedAt: candidate.checkedAt,
    promotedAt,
    note:
        "The production binding reuses the ATS bond, policy root, KYC registry, " +
        "fixed coupon schedule, PrimeOracle, and HBAR/USD adapter. It schedules " +
        "HSS two seconds after each unchanged economic due time.",
    compiler: {
        solc: "0.8.24",
        optimizer: true,
        optimizerRuns: 1,
        repoVaultRuntimeBytes: candidate.runtime.RepoVaultBytes,
        eip170MarginBytes: candidate.runtime.eip170HeadroomBytes,
        repoVaultRuntimeKeccak256: candidate.runtime.RepoVaultKeccak256,
    },
    scheduling: {
        revision: candidate.scheduling.revision,
        executionDelaySeconds: candidate.scheduling.executionDelaySeconds,
        economicDueTimeUnchanged: candidate.scheduling.economicDueTimeUnchanged,
        strictManualFallbackUnchanged: candidate.scheduling.manualFallbackUnchanged,
    },
    RepoVault: {
        address: getAddress(newVaultRecord.address),
        contractId: newVaultRecord.contractId,
        deployTx: newVaultRecord.tx,
        gasUsed: newVaultRecord.gasUsed,
    },
    MarginWatch: {
        address: getAddress(newWatchRecord.address),
        contractId: newWatchRecord.contractId,
        deployTx: newWatchRecord.tx,
        gasUsed: newWatchRecord.gasUsed,
    },
    PrimeOracle: oldFinancing.PrimeOracle,
    constructor: oldFinancing.constructor,
    operatingReserve: {
        initialHbar: candidate.operatingReserveHbar,
        tx: candidate.operatingReserveTx,
        postCanaryBalanceWeibar: canary.snapshots.finalVaultBalanceWeibar,
        additionalCallsFunded: canary.snapshots.additionalCallsFunded,
    },
    approvalWindow: {
        why:
            "The candidate address was not known when the current KYC epoch quota " +
            "was consumed. This immutable temporary seat granted exactly one ATS " +
            "allowance for the canary and restored SeamJournal immediately.",
        address: getAddress(approvalRecord.address),
        contractId: approvalRecord.contractId,
        deployTx: approvalRecord.tx,
        gasUsed: approvalRecord.gasUsed,
        seatTx: candidate.approvalWindow.seatTx,
        approveTx: candidate.approvalWindow.approveTx,
        restoreTx: candidate.approvalWindow.restoreTx,
        restoredCompliance: deployment.venue.SeamJournal,
    },
    demonstration: {
        label: "compressed automatic-settlement canary",
        record: canaryPath,
        repoId: canary.id,
        fundOfferTx: canary.receipts.fundOffer.tx,
        acceptTx: canary.receipts.accept.tx,
        closeTx: canary.receipts.close.tx,
        holdId: Number(canary.collateral.holdId),
        finalState: canary.snapshots.repoState,
        automaticSettlement: canary.automaticSettlement,
    },
    historicalBoundary: {
        record: boundaryPath,
        repoId: boundary.id,
        observation: oldFinancing.demonstration.hssBoundary,
        note:
            "Historical evidence for exact-due HSS reversion and successful " +
            "permissionless settlement. It belongs to the superseded vault.",
    },
    lenderTopUp: oldFinancing.lenderTopUp,
    compressedDemo: oldFinancing.compressedDemo,
};

writeFileSync(deploymentPath, JSON.stringify(deployment, null, 1) + "\n");
console.log(`promoted ${newVaultRecord.contractId} into ${deploymentPath}`);
console.log(`preserved ${oldFinancing.RepoVault.contractId} under superseded`);
