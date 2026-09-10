import {readFileSync} from "node:fs";
import {keccak256} from "ethers";

const MIRROR = (process.env.HEDERA_MIRROR_URL ||
    "https://testnet.mirrornode.hedera.com").replace(/\/$/, "");
const production = JSON.parse(readFileSync("deployments/financing-beat.json"));
const lifecycle = JSON.parse(readFileSync("deployments/financing-lifecycle.json"));
const canary = JSON.parse(readFileSync("deployments/financing-hss-canary.json"));
const deployment = JSON.parse(readFileSync("deployments/296-venue.json"));
const current = deployment.financing;
const candidate = {
    kind: "timestamp-tolerant-candidate",
    contracts: {
        RepoVault: {
            ...current.RepoVault,
            tx: current.RepoVault.deployTx,
        },
        MarginWatch: {
            ...current.MarginWatch,
            tx: current.MarginWatch.deployTx,
        },
        ApprovalWindowCompliance: {
            ...current.approvalWindow,
            tx: current.approvalWindow.deployTx,
        },
    },
    runtime: {
        RepoVaultBytes: current.compiler.repoVaultRuntimeBytes,
        RepoVaultKeccak256: current.compiler.repoVaultRuntimeKeccak256,
    },
    operatingReserveTx: current.operatingReserve.tx,
    approvalWindow: current.approvalWindow,
};

let assertions = 0;
function check(ok, message) {
    assertions += 1;
    if (!ok) throw new Error(message);
}

async function get(path) {
    let last;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await fetch(MIRROR + path, {
            headers: {"user-agent": "lattice-financing-verifier/1"},
        });
        if (response.ok) return response.json();
        last = new Error(`${response.status} ${response.statusText}: ${path}`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
    throw last;
}

const words = (data) => {
    const raw = data.slice(2);
    check(raw.length % 64 === 0, "event data is not whole ABI words");
    return raw.match(/.{64}/g) || [];
};
const addressWord = (word) => "0x" + word.slice(24).toLowerCase();
const uintWord = (word) => BigInt("0x" + word);
const intWord = (word) => {
    const value = uintWord(word);
    return value >= 1n << 255n ? value - (1n << 256n) : value;
};
const topic = (log, expected) =>
    String(log.topics?.[0] || "").toLowerCase() === expected;

const results = new Map();
async function verifyReceipt(name, receipt) {
    const result = await get(`/api/v1/contracts/results/${receipt.tx}`);
    check(result.result === "SUCCESS", `${name}: mirror result is ${result.result}`);
    check(result.status === "0x1", `${name}: EVM status is ${result.status}`);
    check(result.hash.toLowerCase() === receipt.tx.toLowerCase(), `${name}: hash mismatch`);
    check(result.block_number === receipt.block, `${name}: block mismatch`);
    check(String(result.gas_used) === receipt.gasUsed, `${name}: gas mismatch`);
    // Hedera's consensus timestamp can lead the EVM block clock by one second.
    // The scheduler runbook measures and bounds the same network behavior.
    check(
        Math.abs(Math.trunc(Number(result.timestamp)) - receipt.blockTimestamp) <= 2,
        `${name}: timestamp exceeds the two-second network tolerance`,
    );
    check(
        receipt.hashscan === `https://hashscan.io/testnet/transaction/${receipt.tx}`,
        `${name}: HashScan link mismatch`,
    );
    results.set(name, result);
}

check(production.status === "verified", "production record is not verified");
check(lifecycle.status === "complete", "lifecycle record is not complete");
check(canary.status === "verified", "automatic HSS canary is not verified");
check(
    current.scheduling.revision === "hss-execution-delay" &&
    current.scheduling.executionDelaySeconds === 2,
    "current deployment has the wrong scheduling revision",
);

for (const [name, receipt] of Object.entries(production.receipts)) {
    await verifyReceipt(`production.${name}`, receipt);
}
for (const [name, receipt] of Object.entries(lifecycle.receipts)) {
    await verifyReceipt(`lifecycle.${name}`, receipt);
}
for (const [name, receipt] of Object.entries(canary.receipts)) {
    await verifyReceipt(`canary.${name}`, receipt);
}

const contracts = [
    [production.vault.address, production.vault.contractId],
    ...Object.values(lifecycle.deployment.contracts)
        .map((contract) => [contract.address, contract.contractId]),
    ...Object.values(candidate.contracts)
        .map((contract) => [contract.address, contract.contractId]),
];
const contractRecords = new Map();
for (const [address, id] of contracts) {
    const contract = await get(`/api/v1/contracts/${address}`);
    check(contract.contract_id === id, `${address}: entity id mismatch`);
    check(contract.deleted === false, `${address}: contract is deleted`);
    check(contract.runtime_bytecode !== "0x", `${address}: runtime bytecode is empty`);
    contractRecords.set(address.toLowerCase(), contract);
}

const HELD_FROM =
    "0x94c04848aef3d5b4fb6473bdb17ce2ff4b6374b909cc2009156f4eb0a1d880b9";
const RELEASED =
    "0x6c167944f4b372d42d168efc93004d7e517cb82a501d67490af33f95530ca50e";
const UNSCHEDULED =
    "0x64b2084741251eca0160fb42b5b8f67c08f5983be9a04c477ac28ede44eba751";
const COUPON =
    "0x6111db924c62d076736aea6087af6d3435cf606f3370dc065cd67cede0c2018f";
const EXECUTED =
    "0x4fb20409d1b2a56fa4c5b29c11d9b1e148649db67860c5648a8a86f35edf8582";

const held = results.get("production.accept").logs.find((log) => topic(log, HELD_FROM));
check(Boolean(held), "production accept has no ATS hold event");
const heldWords = words(held.data);
check(uintWord(heldWords[1]) === BigInt(production.collateral.holdId), "hold id mismatch");
check(uintWord(heldWords[4]) === BigInt(production.collateral.amount), "hold amount mismatch");
check(
    addressWord(heldWords[6]) === production.collateral.escrow.toLowerCase(),
    "hold escrow mismatch",
);

const released = results.get("production.close").logs.find((log) => topic(log, RELEASED));
check(Boolean(released), "production close has no ATS release event");
const releasedWords = words(released.data);
check(uintWord(releasedWords[0]) === BigInt(production.collateral.holdId), "release id mismatch");
check(uintWord(releasedWords[1]) === BigInt(production.collateral.amount), "release amount mismatch");

const fallback = results.get("lifecycle.position2-accept").logs
    .filter((log) => topic(log, UNSCHEDULED))
    .map((log) => ({
        obligation: log.topics[1].toLowerCase(),
        reason: Number(intWord(words(log.data)[0])),
    }));
const expectedFallback = Object.values(lifecycle.hssFallback.unscheduled)
    .map(({obligation, reason}) => ({obligation: obligation.toLowerCase(), reason}));
check(
    JSON.stringify(fallback.sort((a, b) => a.obligation.localeCompare(b.obligation))) ===
    JSON.stringify(expectedFallback.sort((a, b) => a.obligation.localeCompare(b.obligation))),
    "decoded Unscheduled receipts do not match the evidence",
);

const coupon = results.get("lifecycle.position2-note-coupon").logs
    .find((log) => topic(log, COUPON));
check(Boolean(coupon), "noteCoupon has no CouponObserved event");
check(
    coupon.topics[1].toLowerCase() === lifecycle.position2.id.toLowerCase(),
    "coupon repo id mismatch",
);
check(
    "0x" + words(coupon.data)[0] === lifecycle.position2.couponCommitment,
    "coupon commitment mismatch",
);

const executed = results.get("lifecycle.position2-settle-default").logs
    .find((log) => topic(log, EXECUTED));
check(Boolean(executed), "settleDefault has no ATS execution event");
const executedWords = words(executed.data);
check(
    uintWord(executedWords[0]) === BigInt(lifecycle.position2.collateralHoldId),
    "executed hold id mismatch",
);
check(
    uintWord(executedWords[1]) === BigInt(lifecycle.collateral.executedToLender),
    "executed collateral mismatch",
);
check(
    addressWord(executedWords[2]) === lifecycle.actors.lender.toLowerCase(),
    "executed collateral recipient mismatch",
);

const boundary = production.hssBoundary;
const scheduled = boundary.scheduledExecution;
const schedule = await get(`/api/v1/schedules/${boundary.scheduleId}`);
check(schedule.schedule_id === boundary.scheduleId, "production HSS schedule id mismatch");
check(schedule.deleted === false, "production HSS schedule was deleted");
check(
    schedule.executed_timestamp === scheduled.consensusTimestamp,
    "production HSS execution timestamp mismatch",
);
check(
    Math.trunc(Number(schedule.expiration_time)) === boundary.dueAt,
    "production HSS due time mismatch",
);

const scheduledTransactions = await get(
    `/api/v1/transactions?account.id=${production.vault.contractId}` +
    `&timestamp=gte:${boundary.dueAt}&timestamp=lte:${boundary.dueAt + 2}` +
    "&order=asc&limit=10",
);
const scheduledTransaction = scheduledTransactions.transactions.find(
    (tx) => tx.transaction_id === scheduled.transactionId && tx.scheduled === true,
);
check(Boolean(scheduledTransaction), "production scheduled execution is missing");
const transactionIdParts =
    /^(\d+\.\d+\.\d+)-(\d+)-(\d+)$/.exec(scheduled.transactionId);
check(Boolean(transactionIdParts), "production scheduled transaction id is malformed");
check(
    scheduled.hashscan ===
    `https://hashscan.io/testnet/transaction/${transactionIdParts[1]}` +
    `@${transactionIdParts[2]}.${transactionIdParts[3]}`,
    "production scheduled HashScan link mismatch",
);
check(
    scheduledTransaction.consensus_timestamp === scheduled.consensusTimestamp,
    "production scheduled transaction timestamp mismatch",
);
check(
    scheduledTransaction.result === scheduled.result,
    "production scheduled transaction result mismatch",
);
check(
    String(scheduledTransaction.charged_tx_fee) === scheduled.chargedFeeTinybar,
    "production scheduled transaction fee mismatch",
);
check(
    "0x" + Buffer.from(scheduledTransaction.transaction_hash, "base64").toString("hex") ===
    scheduled.transactionHashSha384,
    "production scheduled transaction hash mismatch",
);

const scheduledBlock = await get(`/api/v1/blocks/${scheduled.evmBlock}`);
check(
    Math.trunc(Number(scheduledBlock.timestamp.from)) === scheduled.evmBlockTimestamp,
    "production scheduled EVM block timestamp mismatch",
);
check(
    Number(scheduled.consensusTimestamp) >= Number(scheduledBlock.timestamp.from) &&
    Number(scheduled.consensusTimestamp) <= Number(scheduledBlock.timestamp.to),
    "production scheduled transaction is outside the recorded block",
);
check(
    scheduled.evmBlockTimestamp === boundary.dueAt - 1,
    "production HSS boundary is not the recorded one-second clock difference",
);

const manualFallback = results.get(`production.${boundary.manualFallback.receipt}`);
check(Boolean(manualFallback), "production manual fallback receipt is missing");
check(
    manualFallback.function_parameters.toLowerCase() ===
    "0x987757dd" + boundary.failObligation.slice(2).toLowerCase(),
    "production manual fallback calldata mismatch",
);
check(
    uintWord(words(manualFallback.call_result)[0]) === 1n,
    "production manual fallback did not settle the obligation",
);
check(
    boundary.manualFallback.result === "SETTLED" &&
    boundary.manualFallback.reservedFundingTinybar === "0",
    "production manual fallback final state is not recorded",
);

check(
    canary.vault.address.toLowerCase() ===
    candidate.contracts.RepoVault.address.toLowerCase(),
    "canary vault does not match the candidate",
);
check(
    canary.vault.contractId === candidate.contracts.RepoVault.contractId,
    "canary vault entity id does not match the candidate",
);
check(
    canary.vault.runtimeBytecodeHash === candidate.runtime.RepoVaultKeccak256,
    "canary runtime hash does not match the candidate",
);
const candidateVault = contractRecords.get(canary.vault.address.toLowerCase());
check(
    (candidateVault.runtime_bytecode.length - 2) / 2 ===
    candidate.runtime.RepoVaultBytes,
    "candidate RepoVault runtime size mismatch",
);
check(
    keccak256(candidateVault.runtime_bytecode) ===
    candidate.runtime.RepoVaultKeccak256,
    "candidate RepoVault runtime hash mismatch",
);
check(
    deployment.venue.RepoVault.toLowerCase() ===
    candidate.contracts.RepoVault.address.toLowerCase() &&
    deployment.venue.MarginWatch.toLowerCase() ===
    candidate.contracts.MarginWatch.address.toLowerCase(),
    "verified candidate is not the current deployment binding",
);
check(
    candidate.approvalWindow.restoredCompliance.toLowerCase() ===
    deployment.venue.SeamJournal.toLowerCase(),
    "ATS compliance restoration record is wrong",
);
for (const [name, contract] of Object.entries(candidate.contracts)) {
    const result = await get(`/api/v1/contracts/results/${contract.tx}`);
    check(result.result === "SUCCESS", `${name} deployment did not succeed`);
    check(result.status === "0x1", `${name} deployment EVM status is not success`);
    check(
        result.contract_id === contract.contractId,
        `${name} deployment entity id mismatch`,
    );
    check(
        String(result.gas_used) === contract.gasUsed,
        `${name} deployment gas mismatch`,
    );
}
const reserveResult = await get(
    `/api/v1/contracts/results/${candidate.operatingReserveTx}`,
);
check(reserveResult.result === "SUCCESS", "candidate reserve transaction failed");
check(reserveResult.status === "0x1", "candidate reserve EVM status failed");
check(
    reserveResult.contract_id === candidate.contracts.RepoVault.contractId,
    "candidate reserve went to another contract",
);
for (const [name, tx] of Object.entries({
    approvalSeat: candidate.approvalWindow.seatTx,
    approval: candidate.approvalWindow.approveTx,
    approvalRestore: candidate.approvalWindow.restoreTx,
})) {
    const result = await get(`/api/v1/contracts/results/${tx}`);
    check(result.result === "SUCCESS", `${name}: mirror result is ${result.result}`);
    check(result.status === "0x1", `${name}: EVM status is ${result.status}`);
}

const canaryHeld = results.get("canary.accept").logs
    .find((log) => topic(log, HELD_FROM));
check(Boolean(canaryHeld), "canary accept has no ATS hold event");
const canaryHeldWords = words(canaryHeld.data);
check(
    uintWord(canaryHeldWords[1]) === BigInt(canary.collateral.holdId),
    "canary hold id mismatch",
);
check(
    uintWord(canaryHeldWords[4]) === BigInt(canary.collateral.amount),
    "canary hold amount mismatch",
);
const canaryReleased = results.get("canary.close").logs
    .find((log) => topic(log, RELEASED));
check(Boolean(canaryReleased), "canary close has no ATS release event");
const canaryReleasedWords = words(canaryReleased.data);
check(
    uintWord(canaryReleasedWords[0]) === BigInt(canary.collateral.holdId),
    "canary release id mismatch",
);
check(
    uintWord(canaryReleasedWords[1]) === BigInt(canary.collateral.amount),
    "canary release amount mismatch",
);
check(
    canary.receipts.accept.blockTimestamp === canary.terms.openedAt,
    "canary opening timestamp mismatch",
);
check(
    canary.automaticSettlement.economicDueAt === canary.terms.maturity,
    "canary economic due time does not match maturity",
);
check(
    canary.receipts.close.blockTimestamp < canary.terms.maturity,
    "canary repo did not close before maturity",
);

const automatic = canary.automaticSettlement;
const automaticSchedule = await get(`/api/v1/schedules/${automatic.scheduleId}`);
check(
    automaticSchedule.schedule_id === automatic.scheduleId,
    "automatic HSS schedule id mismatch",
);
check(automaticSchedule.deleted === false, "automatic HSS schedule was deleted");
check(
    automaticSchedule.executed_timestamp === automatic.executedTimestamp,
    "automatic HSS execution timestamp mismatch",
);
check(
    automaticSchedule.expiration_time === automatic.expirationTime,
    "automatic HSS expiration mismatch",
);
check(
    Math.trunc(Number(automaticSchedule.expiration_time)) ===
    automatic.economicDueAt + automatic.executionDelaySeconds,
    "automatic HSS execution delay mismatch",
);
check(
    BigInt(automatic.scheduleAddress) ===
    BigInt(automatic.scheduleId.split(".")[2]),
    "automatic HSS schedule address mismatch",
);

const automaticTransactions = await get(
    `/api/v1/transactions?account.id=${canary.vault.contractId}` +
    `&timestamp=gte:${automatic.economicDueAt}` +
    `&timestamp=lte:${automatic.economicDueAt + 15}` +
    "&order=asc&limit=10",
);
const automaticTransaction = automaticTransactions.transactions.find(
    (tx) => tx.transaction_id === automatic.transactionId && tx.scheduled === true,
);
check(Boolean(automaticTransaction), "automatic scheduled execution is missing");
check(
    automaticTransaction.consensus_timestamp === automatic.executedTimestamp,
    "automatic scheduled consensus timestamp mismatch",
);
check(
    automaticTransaction.result === automatic.result &&
    automatic.result === "SUCCESS",
    "automatic scheduled transaction did not succeed",
);
check(
    String(automaticTransaction.charged_tx_fee) === automatic.chargedFeeTinybar,
    "automatic scheduled transaction fee mismatch",
);
check(
    "0x" + Buffer.from(
        automaticTransaction.transaction_hash,
        "base64",
    ).toString("hex") === automatic.transactionHashSha384,
    "automatic scheduled transaction hash mismatch",
);
const automaticIdParts =
    /^(\d+\.\d+\.\d+)-(\d+)-(\d+)$/.exec(automatic.transactionId);
check(Boolean(automaticIdParts), "automatic transaction id is malformed");
check(
    automatic.hashscan ===
    `https://hashscan.io/testnet/transaction/${automaticIdParts[1]}` +
    `@${automaticIdParts[2]}.${automaticIdParts[3]}`,
    "automatic HSS HashScan link mismatch",
);

const automaticResult = await get(
    `/api/v1/contracts/results/${automatic.transactionId}` +
    `?nonce=${automaticTransaction.nonce}`,
);
check(
    automaticResult.contract_id === canary.vault.contractId,
    "automatic contract result belongs to another vault",
);
check(
    automaticResult.function_parameters.toLowerCase() ===
    "0x987757dd" + automatic.failObligation.slice(2).toLowerCase(),
    "automatic settle calldata mismatch",
);
check(
    automaticResult.result === "SUCCESS" && automaticResult.status === "0x1",
    "automatic settle contract result did not succeed",
);
check(
    uintWord(words(automaticResult.call_result)[0]) === 1n,
    "automatic settle call did not return true",
);
check(
    automaticResult.hash.toLowerCase() === automatic.evmTransactionHash.toLowerCase(),
    "automatic EVM transaction hash mismatch",
);
check(
    automaticResult.block_number === automatic.evmBlock,
    "automatic EVM block mismatch",
);
check(
    String(automaticResult.gas_used) === automatic.gasUsed,
    "automatic settle gas mismatch",
);
check(
    automaticResult.timestamp === automatic.executedTimestamp,
    "automatic contract result timestamp mismatch",
);
const automaticBlock = await get(`/api/v1/blocks/${automatic.evmBlock}`);
check(
    Math.trunc(Number(automaticBlock.timestamp.from)) === automatic.evmBlockTimestamp,
    "automatic EVM block timestamp mismatch",
);
check(
    automatic.evmBlockTimestamp >= automatic.economicDueAt,
    "automatic EVM block clock was still before economic due time",
);
check(
    Number(automatic.executedTimestamp) >= Number(automaticBlock.timestamp.from) &&
    Number(automatic.executedTimestamp) <= Number(automaticBlock.timestamp.to),
    "automatic HSS transaction is outside its recorded EVM block",
);
check(
    automatic.manualFallbackSent === false,
    "automatic canary records a manual fallback",
);
check(
    !Object.keys(canary.receipts).some((name) => /settle/i.test(name)),
    "automatic canary includes a manual settlement receipt",
);
check(
    canary.collateral.freeFinal === canary.collateral.freeBefore &&
    canary.collateral.heldFinal === canary.collateral.heldBefore,
    "canary collateral did not return to baseline",
);
check(
    canary.snapshots.reservedBeforeExecutionTinybar === "500000000" &&
    canary.snapshots.reservedFundingTinybar === "0",
    "automatic schedule reservation did not clear",
);
check(
    canary.snapshots.cashReservedTinybar === "0" &&
    canary.snapshots.repoState === "CLOSED" &&
    canary.snapshots.obligationStatus === "SETTLED",
    "automatic canary final state is not clean",
);
check(
    Object.values(canary.assertions).every((value) => value === true),
    "automatic canary contains a failed assertion",
);

console.log(
    `financing evidence: ${assertions} Mirror Node assertions passed ` +
    `across ${results.size} receipts and ${contracts.length} contracts`,
);
