import {readFileSync} from "node:fs";
import {
    Contract,
    Interface,
    JsonRpcProvider,
    getAddress,
    keccak256,
    toUtf8Bytes,
} from "ethers";

import {
    buildAtsCoupon,
    buildCanonicalCoupon,
    inclusiveFractionalFee,
} from "./bond-coupon-entitlements.mjs";
import {buildEntitlements, leafOf, verify} from "./entitlements.mjs";

const MIRROR = (process.env.HEDERA_MIRROR_URL ||
    "https://testnet.mirrornode.hedera.com").replace(/\/$/, "");
const RPC = process.env.HEDERA_TESTNET_RPC || "https://testnet.hashio.io/api";
const provider = new JsonRpcProvider(
    RPC,
    {chainId: 296, name: "hedera-testnet"},
    {staticNetwork: true},
);

const canonical = JSON.parse(readFileSync("deployments/bond-coupon-zero.json"));
const lifecycle = JSON.parse(readFileSync("deployments/bond-lifecycle.json"));
const deployment = JSON.parse(readFileSync("deployments/296-venue.json"));
const clientText = readFileSync("deployments/client.json", "utf8");
const client = JSON.parse(clientText);

let assertions = 0;
function check(ok, message) {
    assertions += 1;
    if (!ok) throw new Error(message);
}

async function get(path) {
    let failure;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await fetch(MIRROR + path, {
            headers: {"user-agent": "lattice-bond-lifecycle-verifier/1"},
        });
        if (response.ok) return response.json();
        failure = new Error(`${response.status} ${response.statusText}: ${path}`);
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
    throw failure;
}

const sameAddress = (left, right) =>
    getAddress(left).toLowerCase() === getAddress(right).toLowerCase();
const eventTopic = (signature) => keccak256(toUtf8Bytes(signature)).toLowerCase();
const hasTopic = (result, address, topic) =>
    result.logs.some(
        (log) =>
            sameAddress(log.address, address) &&
            String(log.topics?.[0]).toLowerCase() === topic,
    );
function decodedEvents(result, address, iface, eventName) {
    return result.logs
        .filter((log) => sameAddress(log.address, address))
        .map((log) => {
            try {
                return iface.parseLog({topics: log.topics, data: log.data});
            } catch {
                return null;
            }
        })
        .filter((parsed) => parsed?.name === eventName);
}

const distributorEvents = new Interface([
    "event Declared(uint256 indexed index,uint64 recordDate,bytes32 root,uint32 holders,uint256 total)",
    "event Claimed(uint256 indexed index,address indexed holder)",
]);
const cashEvents = new Interface([
    "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const atsEvents = new Interface([
    "event Issued(address indexed operator,address indexed to,uint256 value,bytes data)",
    "event CouponSet(bytes32 indexed corporateActionId,uint256 indexed couponId,address indexed operator,(uint256 recordDate,uint256 executionDate,uint256 startDate,uint256 endDate,uint256 fixingDate,uint256 rate,uint8 rateDecimals,uint8 rateStatus) coupon)",
    "event SnapshotTriggered(uint256 snapshotId,bytes metadata)",
    "event RedeemedByPartition(bytes32 indexed partition,address indexed operator,address indexed from,uint256 value,bytes data,bytes operatorData)",
]);

const results = new Map();
async function verifyReceipt(scope, name, receipt) {
    const result = await get(`/api/v1/contracts/results/${receipt.tx}`);
    check(result.result === "SUCCESS", `${scope}.${name}: mirror result is ${result.result}`);
    check(result.status === "0x1", `${scope}.${name}: EVM status is ${result.status}`);
    check(result.hash.toLowerCase() === receipt.tx.toLowerCase(), `${scope}.${name}: hash mismatch`);
    check(result.block_number === receipt.block, `${scope}.${name}: block mismatch`);
    check(String(result.gas_used) === receipt.gasUsed, `${scope}.${name}: gas mismatch`);
    check(
        Math.abs(Math.trunc(Number(result.timestamp)) - receipt.blockTimestamp) <= 2,
        `${scope}.${name}: timestamp exceeds Hedera's two-second tolerance`,
    );
    check(
        receipt.hashscan === `https://hashscan.io/testnet/transaction/${receipt.tx}`,
        `${scope}.${name}: HashScan link mismatch`,
    );
    results.set(`${scope}.${name}`, result);
}

async function verifyContract(address, contractId, label) {
    const record = await get(`/api/v1/contracts/${address}`);
    check(record.contract_id === contractId, `${label}: entity id mismatch`);
    check(record.deleted === false, `${label}: contract is deleted`);
    check(record.runtime_bytecode !== "0x", `${label}: runtime bytecode is empty`);
}

check(canonical.schema === "lattice.bond.coupon-zero.v1", "canonical schema mismatch");
check(canonical.status === "complete", "canonical coupon record is incomplete");
check(canonical.canonical === true, "canonical coupon is not marked canonical");
check(lifecycle.schema === "lattice.bond.lifecycle.v1", "lifecycle schema mismatch");
check(lifecycle.status === "complete", "compressed lifecycle record is incomplete");
check(lifecycle.productionBinding === false, "compressed bond is marked as production");
check(
    sameAddress(lifecycle.canonicalBondUnchanged, deployment.token.address),
    "compressed evidence changed the canonical bond address",
);
check(
    sameAddress(client.addresses.token, deployment.token.address),
    "client token binding is not the canonical LPRC bond",
);
for (const {address} of Object.values(lifecycle.deployment.contracts)) {
    check(
        !clientText.toLowerCase().includes(address.toLowerCase()),
        `nonproduction lifecycle address leaked into client.json: ${address}`,
    );
}

for (const [name, receipt] of Object.entries(canonical.receipts)) {
    await verifyReceipt("canonical", name, receipt);
}
for (const [name, receipt] of Object.entries(lifecycle.receipts)) {
    await verifyReceipt("lifecycle", name, receipt);
}

await verifyContract(canonical.bond.address, canonical.bond.contractId, "canonical bond");
await verifyContract(
    canonical.coupon.schedule,
    canonical.coupon.scheduleContractId,
    "canonical schedule",
);
await verifyContract(
    canonical.coupon.distributor,
    canonical.coupon.distributorContractId,
    "canonical distributor",
);
await verifyContract(
    lifecycle.deployment.contracts.Bond.address,
    lifecycle.deployment.contracts.Bond.contractId,
    "compressed bond",
);
await verifyContract(
    lifecycle.deployment.contracts.CouponSchedule.address,
    lifecycle.deployment.contracts.CouponSchedule.contractId,
    "compressed schedule",
);
await verifyContract(
    lifecycle.deployment.contracts.CouponDistributor.address,
    lifecycle.deployment.contracts.CouponDistributor.contractId,
    "compressed distributor",
);

const cashRecord = await get(`/api/v1/tokens/${canonical.cash.tokenId}`);
const [, , cashNumber] = canonical.cash.tokenId.split(".");
const cashAddressFromId = "0x" + BigInt(cashNumber).toString(16).padStart(40, "0");
check(
    sameAddress(cashAddressFromId, canonical.cash.address),
    "LPCASH token id does not resolve to its EVM address",
);
check(Number(cashRecord.decimals) === canonical.cash.decimals, "LPCASH decimals mismatch");
const mirrorFees = cashRecord.custom_fees?.fractional_fees || [];
check(mirrorFees.length === 1, "LPCASH fractional fee count mismatch");
const mirrorFee = mirrorFees[0];
const recordedFee = canonical.cash.fractionalFee;
check(mirrorFee.amount.numerator === recordedFee.numerator, "LPCASH fee numerator mismatch");
check(
    mirrorFee.amount.denominator === recordedFee.denominator,
    "LPCASH fee denominator mismatch",
);
check(mirrorFee.minimum === recordedFee.minimum, "LPCASH fee minimum mismatch");
check(mirrorFee.maximum === recordedFee.maximum, "LPCASH fee maximum mismatch");
check(
    mirrorFee.net_of_transfers === recordedFee.netOfTransfers,
    "LPCASH net-of-transfers flag mismatch",
);
check(mirrorFee.collector_account_id === recordedFee.collector, "LPCASH fee collector mismatch");

const rebuiltCanonical = await buildCanonicalCoupon({
    rpc: RPC,
    mirror: MIRROR,
    deployment,
});
for (const key of [
    "bond",
    "schedule",
    "distributor",
    "recordDate",
    "dueAt",
    "accrualStart",
    "root",
    "width",
    "total",
    "supplyAtRecordDate",
    "totalLot",
]) {
    check(
        String(rebuiltCanonical[key]).toLowerCase() ===
            String(canonical.entitlement[key]).toLowerCase(),
        `canonical entitlement ${key} does not replay`,
    );
}
check(
    rebuiltCanonical.cutoffBlock.number === canonical.entitlement.cutoffBlock.number,
    "canonical cutoff block does not replay",
);
check(
    rebuiltCanonical.cutoffBlock.mirrorHash === canonical.entitlement.cutoffBlock.mirrorHash,
    "canonical cutoff block hash mismatch",
);
check(
    rebuiltCanonical.fixing.referenceRateBps ===
        canonical.entitlement.fixing.referenceRateBps,
    "canonical historical fixing mismatch",
);
check(
    BigInt(canonical.entitlement.fixing.publishedAt) < BigInt(canonical.coupon.dueAt),
    "canonical fixing was not published before due",
);

const canonicalEntries = canonical.entitlement.holders.map(({holder, amount}) => ({
    holder,
    amount: BigInt(amount),
}));
const canonicalTree = buildEntitlements(0, canonicalEntries);
check(canonicalTree.root === canonical.entitlement.root, "canonical root does not rebuild");
check(canonicalTree.total === BigInt(canonical.cash.gross), "canonical gross does not sum");
for (const row of canonical.entitlement.holders) {
    check(
        verify(
            canonicalTree.root,
            leafOf(0, row.holder, BigInt(row.amount)),
            row.position,
            canonicalTree.width,
            row.proof,
        ),
        `canonical proof fails for ${row.holder}`,
    );
}

const distributorAbi = [
    "function declarationOf(uint256) view returns ((bytes32 root,uint64 recordDate,uint64 declaredAt,uint32 holders,uint256 total,uint256 remaining,bool swept))",
    "function claimed(uint256,address) view returns (bool)",
    "function committed() view returns (uint256)",
    "function cash() view returns (address)",
    "function schedule() view returns (address)",
];
const cashAbi = ["function balanceOf(address) view returns (uint256)"];
const canonicalDistributor = new Contract(
    canonical.coupon.distributor,
    distributorAbi,
    provider,
);
const canonicalBond = new Contract(
    canonical.bond.address,
    ["function getMaturityDate() view returns (uint256)"],
    provider,
);
check(
    (await canonicalBond.getMaturityDate()) === BigInt(canonical.bond.maturity),
    "canonical LPRC maturity changed",
);
const canonicalDeclaration = await canonicalDistributor.declarationOf(0);
check(canonicalDeclaration.root === canonical.entitlement.root, "live canonical root mismatch");
check(
    canonicalDeclaration.recordDate === BigInt(canonical.coupon.recordDate),
    "live canonical record date mismatch",
);
check(
    canonicalDeclaration.declaredAt === BigInt(canonical.coupon.declaredAt),
    "live canonical declaration time mismatch",
);
check(canonicalDeclaration.total === BigInt(canonical.cash.gross), "live canonical total mismatch");
check(canonicalDeclaration.remaining === 0n, "canonical coupon still has remaining cash");
check((await canonicalDistributor.committed()) === 0n, "canonical committed balance is nonzero");
for (const row of canonical.entitlement.holders) {
    check(await canonicalDistributor.claimed(0, row.holder), `${row.holder} is not claimed`);
}

const declaredTopic = eventTopic("Declared(uint256,uint64,bytes32,uint32,uint256)");
const claimedTopic = eventTopic("Claimed(uint256,address)");
const transferTopic = eventTopic("Transfer(address,address,uint256)");
check(
    hasTopic(
        results.get("canonical.declare"),
        canonical.coupon.distributor,
        declaredTopic,
    ),
    "canonical declaration receipt lacks Declared",
);
const canonicalDeclaredEvents = decodedEvents(
    results.get("canonical.declare"),
    canonical.coupon.distributor,
    distributorEvents,
    "Declared",
);
check(canonicalDeclaredEvents.length === 1, "canonical declaration event count mismatch");
check(canonicalDeclaredEvents[0].args.index === 0n, "canonical event index mismatch");
check(
    canonicalDeclaredEvents[0].args.recordDate === BigInt(canonical.coupon.recordDate),
    "canonical event record date mismatch",
);
check(
    canonicalDeclaredEvents[0].args.root === canonical.entitlement.root,
    "canonical event root mismatch",
);
check(
    canonicalDeclaredEvents[0].args.holders === BigInt(canonical.entitlement.width),
    "canonical event holder count mismatch",
);
check(
    canonicalDeclaredEvents[0].args.total === BigInt(canonical.cash.gross),
    "canonical event total mismatch",
);
for (const [name, row] of [
    ["claim-seller", canonical.entitlement.holders[0]],
    ["claim-buyer", canonical.entitlement.holders[1]],
]) {
    const result = results.get(`canonical.${name}`);
    check(
        hasTopic(result, canonical.coupon.distributor, claimedTopic),
        `canonical ${name} lacks Claimed`,
    );
    check(
        hasTopic(result, canonical.cash.address, transferTopic),
        `canonical ${name} lacks LPCASH Transfer`,
    );
    const claimed = decodedEvents(
        result,
        canonical.coupon.distributor,
        distributorEvents,
        "Claimed",
    );
    check(claimed.length === 1, `canonical ${name} Claimed count mismatch`);
    check(claimed[0].args.index === 0n, `canonical ${name} index mismatch`);
    check(sameAddress(claimed[0].args.holder, row.holder), `canonical ${name} holder mismatch`);
    const transfers = decodedEvents(result, canonical.cash.address, cashEvents, "Transfer");
    check(transfers.length === 1, `canonical ${name} LPCASH Transfer count mismatch`);
    check(
        sameAddress(transfers[0].args.from, canonical.coupon.distributor),
        `canonical ${name} cash sender mismatch`,
    );
    check(
        sameAddress(transfers[0].args.to, row.holder),
        `canonical ${name} cash recipient mismatch`,
    );
    check(
        transfers[0].args.value === BigInt(row.amount),
        `canonical ${name} gross cash amount mismatch`,
    );
}

const sellerAmount = BigInt(canonical.entitlement.holders[0].amount);
const buyerAmount = BigInt(canonical.entitlement.holders[1].amount);
const sellerFee = inclusiveFractionalFee(
    sellerAmount,
    BigInt(recordedFee.numerator),
    BigInt(recordedFee.denominator),
    BigInt(recordedFee.minimum),
);
const buyerFee = inclusiveFractionalFee(
    buyerAmount,
    BigInt(recordedFee.numerator),
    BigInt(recordedFee.denominator),
    BigInt(recordedFee.minimum),
);
check(sellerFee + buyerFee === BigInt(canonical.cash.feeSmallestUnits), "canonical fee mismatch");
check(
    sellerAmount + buyerAmount - sellerFee - buyerFee ===
        BigInt(canonical.cash.netToHolders),
    "canonical net cash mismatch",
);

const cash = new Contract(canonical.cash.address, cashAbi, provider);
async function cashBalancesAt(blockTag, addresses) {
    return Object.fromEntries(
        await Promise.all(
            Object.entries(addresses).map(async ([name, address]) => [
                name,
                await cash.balanceOf(address, {blockTag}),
            ]),
        ),
    );
}
function checkRecordedBalances(actual, recorded, label) {
    for (const [name, amount] of Object.entries(recorded)) {
        check(actual[name] === BigInt(amount), `${label} ${name} cash balance mismatch`);
    }
}

const canonicalCashAddresses = {
    issuer: deployment.deployer,
    seller: canonical.entitlement.holders[0].holder,
    buyer: canonical.entitlement.holders[1].holder,
    distributor: canonical.coupon.distributor,
};
const canonicalCashBefore = await cashBalancesAt(
    canonical.receipts.fund.block - 1,
    canonicalCashAddresses,
);
const canonicalCashAfter = await cashBalancesAt(
    Math.max(
        canonical.receipts["claim-seller"].block,
        canonical.receipts["claim-buyer"].block,
    ),
    canonicalCashAddresses,
);
checkRecordedBalances(canonicalCashBefore, canonical.cash.before, "canonical pre-funding");
checkRecordedBalances(canonicalCashAfter, canonical.cash.after, "canonical post-claim");

const demo = lifecycle.deployment;
const demoBond = demo.contracts.Bond.address;
const demoSchedule = demo.contracts.CouponSchedule.address;
const demoDistributorAddress = demo.contracts.CouponDistributor.address;
const rebuiltDemo = await buildAtsCoupon({
    rpc: RPC,
    token: demoBond,
    schedule: demoSchedule,
    distributor: demoDistributorAddress,
    referenceRateBps: lifecycle.coupon.referenceRateBps,
});
check(rebuiltDemo.root === lifecycle.coupon.root, "compressed coupon root does not replay");
check(
    rebuiltDemo.snapshotId === lifecycle.coupon.snapshotId,
    "compressed ATS snapshot id mismatch",
);
check(
    rebuiltDemo.total === lifecycle.coupon.grossSmallestCashUnits,
    "compressed coupon amount mismatch",
);
check(
    rebuiltDemo.holders[0].tokenBalance === lifecycle.issuance.amount,
    "compressed snapshot balance mismatch",
);

const demoBondAbi = [
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function getMaturityDate() view returns (uint256)",
    "function getCoupon(uint256) view returns (((uint256,uint256,uint256,uint256,uint256,uint256,uint8,uint8),uint256),bool)",
];
const bond = new Contract(demoBond, demoBondAbi, provider);
check((await bond.totalSupply()) === 0n, "compressed bond supply is not zero");
check(
    (await bond.balanceOf(lifecycle.actors.holder)) === 0n,
    "compressed holder balance is not zero",
);
check(
    (await bond.getMaturityDate()) === BigInt(lifecycle.redemption.maturity),
    "compressed maturity mismatch",
);
const couponState = await bond.getCoupon(1);
check(
    couponState[0][1] === BigInt(lifecycle.coupon.snapshotId),
    "compressed coupon is not bound to its snapshot",
);

const demoDistributor = new Contract(
    demoDistributorAddress,
    distributorAbi,
    provider,
);
const demoDeclaration = await demoDistributor.declarationOf(0);
check(demoDeclaration.root === lifecycle.coupon.root, "compressed live root mismatch");
check(demoDeclaration.remaining === 0n, "compressed coupon has remaining cash");
check((await demoDistributor.committed()) === 0n, "compressed committed balance is nonzero");
check(
    await demoDistributor.claimed(0, lifecycle.actors.holder),
    "compressed holder has not claimed",
);

check(
    (await cash.balanceOf(canonical.coupon.distributor)) ===
        BigInt(canonical.cash.after.distributor),
    "canonical distributor cash balance moved",
);
check(
    (await cash.balanceOf(demoDistributorAddress)) ===
        BigInt(lifecycle.cash.after.distributor),
    "compressed distributor cash balance moved",
);

const issuedTopic = eventTopic("Issued(address,address,uint256,bytes)");
const couponSetTopic = eventTopic(
    "CouponSet(bytes32,uint256,address,(uint256,uint256,uint256,uint256,uint256,uint256,uint8,uint8))",
);
const snapshotTopic = eventTopic("SnapshotTriggered(uint256,bytes)");
const redeemedTopic = eventTopic(
    "RedeemedByPartition(bytes32,address,address,uint256,bytes,bytes)",
);
check(hasTopic(results.get("lifecycle.issue"), demoBond, issuedTopic), "issue receipt lacks Issued");
check(
    hasTopic(results.get("lifecycle.set-coupon"), demoBond, couponSetTopic),
    "coupon registration receipt lacks CouponSet",
);
check(
    hasTopic(results.get("lifecycle.trigger-snapshot"), demoBond, snapshotTopic),
    "snapshot receipt lacks SnapshotTriggered",
);
check(
    hasTopic(results.get("lifecycle.declare"), demoDistributorAddress, declaredTopic),
    "compressed declaration receipt lacks Declared",
);
check(
    hasTopic(results.get("lifecycle.claim"), demoDistributorAddress, claimedTopic),
    "compressed claim receipt lacks Claimed",
);
check(
    hasTopic(results.get("lifecycle.claim"), canonical.cash.address, transferTopic),
    "compressed claim receipt lacks LPCASH Transfer",
);
check(
    hasTopic(results.get("lifecycle.redeem-at-maturity"), demoBond, redeemedTopic),
    "maturity receipt lacks RedeemedByPartition",
);

const issued = decodedEvents(results.get("lifecycle.issue"), demoBond, atsEvents, "Issued");
check(issued.length === 1, "compressed Issued event count mismatch");
check(sameAddress(issued[0].args.to, lifecycle.actors.holder), "compressed issue holder mismatch");
check(issued[0].args.value === BigInt(lifecycle.issuance.amount), "compressed issue amount mismatch");

const couponSet = decodedEvents(
    results.get("lifecycle.set-coupon"),
    demoBond,
    atsEvents,
    "CouponSet",
);
check(couponSet.length === 1, "compressed CouponSet event count mismatch");
check(couponSet[0].args.couponId === 1n, "compressed CouponSet id mismatch");
check(
    couponSet[0].args.coupon.recordDate === BigInt(demo.terms.recordDate),
    "compressed CouponSet record date mismatch",
);
check(
    couponSet[0].args.coupon.rate === BigInt(demo.terms.couponRateBps),
    "compressed CouponSet rate mismatch",
);

const snapshots = decodedEvents(
    results.get("lifecycle.trigger-snapshot"),
    demoBond,
    atsEvents,
    "SnapshotTriggered",
);
check(snapshots.length === 1, "compressed SnapshotTriggered event count mismatch");
check(
    snapshots[0].args.snapshotId === BigInt(lifecycle.coupon.snapshotId),
    "compressed SnapshotTriggered id mismatch",
);

const demoDeclared = decodedEvents(
    results.get("lifecycle.declare"),
    demoDistributorAddress,
    distributorEvents,
    "Declared",
);
check(demoDeclared.length === 1, "compressed Declared event count mismatch");
check(demoDeclared[0].args.root === lifecycle.coupon.root, "compressed event root mismatch");
check(
    demoDeclared[0].args.total === BigInt(lifecycle.coupon.grossSmallestCashUnits),
    "compressed event total mismatch",
);

const demoClaims = decodedEvents(
    results.get("lifecycle.claim"),
    demoDistributorAddress,
    distributorEvents,
    "Claimed",
);
check(demoClaims.length === 1, "compressed Claimed event count mismatch");
check(
    sameAddress(demoClaims[0].args.holder, lifecycle.actors.holder),
    "compressed Claimed holder mismatch",
);
const demoCashTransfers = decodedEvents(
    results.get("lifecycle.claim"),
    canonical.cash.address,
    cashEvents,
    "Transfer",
);
check(demoCashTransfers.length === 1, "compressed LPCASH Transfer count mismatch");
check(
    sameAddress(demoCashTransfers[0].args.from, demoDistributorAddress),
    "compressed cash sender mismatch",
);
check(
    sameAddress(demoCashTransfers[0].args.to, lifecycle.actors.holder),
    "compressed cash recipient mismatch",
);
check(
    demoCashTransfers[0].args.value === BigInt(lifecycle.coupon.grossSmallestCashUnits),
    "compressed gross cash amount mismatch",
);

const redemptions = decodedEvents(
    results.get("lifecycle.redeem-at-maturity"),
    demoBond,
    atsEvents,
    "RedeemedByPartition",
);
check(redemptions.length === 1, "compressed maturity redemption event count mismatch");
check(
    sameAddress(redemptions[0].args.from, lifecycle.actors.holder),
    "compressed redemption holder mismatch",
);
check(
    redemptions[0].args.value === BigInt(lifecycle.redemption.redeemed),
    "compressed redemption amount mismatch",
);

const demoCashAddresses = {
    issuer: lifecycle.actors.issuer,
    seller: canonical.entitlement.holders[0].holder,
    buyer: lifecycle.actors.holder,
    distributor: demoDistributorAddress,
};
const demoCashBefore = await cashBalancesAt(
    lifecycle.receipts.fund.block - 1,
    demoCashAddresses,
);
const demoCashAfter = await cashBalancesAt(
    lifecycle.receipts.claim.block,
    demoCashAddresses,
);
checkRecordedBalances(demoCashBefore, lifecycle.cash.before, "compressed pre-funding");
checkRecordedBalances(demoCashAfter, lifecycle.cash.after, "compressed post-claim");
check(
    demoCashAfter.seller === demoCashBefore.seller,
    "compressed lifecycle changed the canonical seller cash balance",
);

const supplyBeforeIssue = await bond.totalSupply({
    blockTag: lifecycle.receipts.issue.block - 1,
});
const holderBeforeIssue = await bond.balanceOf(lifecycle.actors.holder, {
    blockTag: lifecycle.receipts.issue.block - 1,
});
const supplyAfterIssue = await bond.totalSupply({
    blockTag: lifecycle.receipts.issue.block,
});
const holderAfterIssue = await bond.balanceOf(lifecycle.actors.holder, {
    blockTag: lifecycle.receipts.issue.block,
});
const supplyAfterRedemption = await bond.totalSupply({
    blockTag: lifecycle.receipts["redeem-at-maturity"].block,
});
const holderAfterRedemption = await bond.balanceOf(lifecycle.actors.holder, {
    blockTag: lifecycle.receipts["redeem-at-maturity"].block,
});
check(supplyBeforeIssue === BigInt(lifecycle.issuance.supplyBefore), "pre-issue supply mismatch");
check(
    holderBeforeIssue === BigInt(lifecycle.issuance.holderBefore),
    "pre-issue holder balance mismatch",
);
check(
    supplyAfterIssue === BigInt(lifecycle.issuance.supplyAfterIssue),
    "post-issue supply mismatch",
);
check(
    holderAfterIssue === BigInt(lifecycle.issuance.amount),
    "post-issue holder balance mismatch",
);
check(
    supplyAfterRedemption === BigInt(lifecycle.redemption.supplyAfter),
    "post-redemption supply mismatch",
);
check(
    holderAfterRedemption === BigInt(lifecycle.redemption.holderAfter),
    "post-redemption holder balance mismatch",
);
check(
    lifecycle.receipts["set-coupon"].blockTimestamp < Number(demo.terms.recordDate),
    "ATS coupon was not registered before record date",
);
check(
    lifecycle.receipts["trigger-snapshot"].blockTimestamp >= Number(demo.terms.recordDate),
    "ATS snapshot was triggered before record date",
);
check(
    lifecycle.receipts.declare.blockTimestamp >= Number(demo.terms.dueAt),
    "compressed coupon was declared before due",
);
check(
    lifecycle.receipts["redeem-at-maturity"].blockTimestamp >= Number(demo.terms.maturity),
    "compressed bond was redeemed before maturity",
);

console.log(`bond lifecycle evidence: ${assertions} assertions pass`);
