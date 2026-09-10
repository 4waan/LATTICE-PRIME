import {readFileSync, writeFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {Contract, JsonRpcProvider, getAddress} from "ethers";

import {buildEntitlements} from "./entitlements.mjs";

export const DEFAULT_PARTITION =
    "0x0000000000000000000000000000000000000000000000000000000000000001";
export const ACT_365_SECONDS = 365n * 24n * 60n * 60n;

const BOND_ABI = [
    "function isMultiPartition() view returns (bool)",
    "function totalSupply() view returns (uint256)",
    "function getTotalSecurityHolders() view returns (uint256)",
    "function getSecurityHolders(uint256,uint256) view returns (address[])",
    "function balanceOfByPartition(bytes32,address) view returns (uint256)",
    "function getHeldAmountForByPartition(bytes32,address) view returns (uint256)",
    "function getLockedAmountForByPartition(bytes32,address) view returns (uint256)",
    "function getClearedAmountForByPartition(bytes32,address) view returns (uint256)",
    "function getFrozenTokens(address) view returns (uint256)",
];

const SCHEDULE_ABI = [
    "function issuedAt() view returns (uint64)",
    "function dateOf(uint256) view returns (uint64)",
    "function accrualStart(uint256) view returns (uint64)",
    "function spreadBps() view returns (uint16)",
    "function faceValue() view returns (uint128)",
    "function amountFor(uint256,uint64,uint256) view returns (uint256)",
];

const ORACLE_ABI = [
    "function latest() view returns (uint128 cleanPrice8,uint64 refRateBps,uint64 publishedAt)",
];

const COUPON_COMPONENTS = [
    {name: "recordDate", type: "uint256"},
    {name: "executionDate", type: "uint256"},
    {name: "startDate", type: "uint256"},
    {name: "endDate", type: "uint256"},
    {name: "fixingDate", type: "uint256"},
    {name: "rate", type: "uint256"},
    {name: "rateDecimals", type: "uint8"},
    {name: "rateStatus", type: "uint8"},
];

const ATS_COUPON_ABI = [
    {
        type: "function",
        name: "getCoupon",
        stateMutability: "view",
        inputs: [{name: "_couponID", type: "uint256"}],
        outputs: [
            {
                name: "registeredCoupon_",
                type: "tuple",
                components: [
                    {name: "coupon", type: "tuple", components: COUPON_COMPONENTS},
                    {name: "snapshotId", type: "uint256"},
                ],
            },
            {name: "isDisabled_", type: "bool"},
        ],
    },
    {
        type: "function",
        name: "getCouponFor",
        stateMutability: "view",
        inputs: [
            {name: "_couponID", type: "uint256"},
            {name: "_account", type: "address"},
        ],
        outputs: [
            {
                name: "couponFor_",
                type: "tuple",
                components: [
                    {name: "tokenBalance", type: "uint256"},
                    {name: "decimals", type: "uint8"},
                    {name: "nominalValue", type: "uint256"},
                    {name: "nominalValueDecimals", type: "uint256"},
                    {name: "recordDateReached", type: "bool"},
                    {name: "coupon", type: "tuple", components: COUPON_COMPONENTS},
                    {
                        name: "couponAmount",
                        type: "tuple",
                        components: [
                            {name: "numerator", type: "uint256"},
                            {name: "denominator", type: "uint256"},
                            {name: "recordDateReached", type: "bool"},
                        ],
                    },
                    {name: "isDisabled", type: "bool"},
                ],
            },
        ],
    },
    "function getTotalCouponHolders(uint256) view returns (uint256)",
    "function getCouponHolders(uint256,uint256,uint256) view returns (address[])",
    "function totalSupply() view returns (uint256)",
];

function requireUint(value, name) {
    const result = BigInt(value);
    if (result < 0n) throw new RangeError(`${name} must not be negative`);
    return result;
}

export function couponCashAmount({lot, faceValue, rateBps, accrualStart, dueAt}) {
    const from = requireUint(accrualStart, "accrualStart");
    const to = requireUint(dueAt, "dueAt");
    if (to < from) throw new RangeError("dueAt must not precede accrualStart");
    return (
        requireUint(lot, "lot") *
        requireUint(faceValue, "faceValue") *
        requireUint(rateBps, "rateBps") *
        (to - from)
    ) / (10_000n * ACT_365_SECONDS);
}

export function cashAmountFromFraction(numerator, denominator, cashDecimals) {
    const n = requireUint(numerator, "numerator");
    const d = requireUint(denominator, "denominator");
    const decimals = Number(cashDecimals);
    if (d === 0n) throw new RangeError("denominator must be positive");
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
        throw new RangeError("cashDecimals must be an integer from 0 to 77");
    }
    return (n * 10n ** BigInt(decimals)) / d;
}

export function inclusiveFractionalFee(amount, numerator, denominator, minimum = 0n) {
    const gross = requireUint(amount, "amount");
    const n = requireUint(numerator, "fee numerator");
    const d = requireUint(denominator, "fee denominator");
    const min = requireUint(minimum, "fee minimum");
    if (d === 0n) throw new RangeError("fee denominator must be positive");
    if (gross === 0n) return 0n;
    const proportional = (gross * n) / d;
    return proportional < min ? min : proportional;
}

function jsonBig(value) {
    return typeof value === "bigint" ? value.toString() : value;
}

function proofRows(tree, details) {
    const byHolder = new Map(details.map((row) => [row.holder.toLowerCase(), row]));
    return tree.holders.map((entry, position) => ({
        ...byHolder.get(entry.holder),
        holder: getAddress(entry.holder),
        amount: entry.amount.toString(),
        position,
        proof: tree.proofFor(position),
    }));
}

async function mirrorGet(mirror, path) {
    let failure;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await fetch(mirror.replace(/\/$/, "") + path, {
            headers: {"user-agent": "lattice-bond-lifecycle/1"},
        });
        if (response.ok) return response.json();
        failure = new Error(`${response.status} ${response.statusText}: ${path}`);
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
    throw failure;
}

export async function findCouponCutoffBlock(mirror, dueAt) {
    const due = requireUint(dueAt, "dueAt");
    const result = await mirrorGet(
        mirror,
        `/api/v1/blocks?timestamp=lt:${due}&order=desc&limit=1`,
    );
    if (!Array.isArray(result.blocks) || result.blocks.length !== 1) {
        throw new Error(`no complete Hedera block precedes coupon due ${due}`);
    }
    const block = result.blocks[0];
    if (Number(block.timestamp.to) >= Number(due)) {
        throw new Error(`mirror cutoff block ${block.number} reaches or exceeds coupon due`);
    }
    return block;
}

function providerFor(rpc) {
    return new JsonRpcProvider(
        rpc,
        {chainId: 296, name: "hedera-testnet"},
        {staticNetwork: true},
    );
}

export async function buildCanonicalCoupon({
    rpc,
    mirror,
    deployment,
    index = 0,
    partition = DEFAULT_PARTITION,
}) {
    const coupon = deployment.coupon;
    const oldOracle = deployment.superseded.repoVaultBeforeFinancingV5.PrimeOracle;
    const provider = providerFor(rpc);
    const bond = new Contract(deployment.token.address, BOND_ABI, provider);
    const schedule = new Contract(coupon.CouponSchedule, SCHEDULE_ABI, provider);
    const oracle = new Contract(oldOracle, ORACLE_ABI, provider);

    const dueAt = await schedule.dateOf(index);
    const recordDate = dueAt;
    const cutoff = await findCouponCutoffBlock(mirror, dueAt);
    const nextBlock = await mirrorGet(mirror, `/api/v1/blocks/${cutoff.number + 1}`);
    const blockTag = cutoff.number;
    const evmBlock = await provider.getBlock(blockTag);
    if (!evmBlock) throw new Error(`RPC did not return block ${blockTag}`);

    const [multi, supply, holderCount, accrualStart, spreadBps, faceValue, fixing] =
        await Promise.all([
            bond.isMultiPartition({blockTag}),
            bond.totalSupply({blockTag}),
            bond.getTotalSecurityHolders({blockTag}),
            schedule.accrualStart(index, {blockTag}),
            schedule.spreadBps({blockTag}),
            schedule.faceValue({blockTag}),
            oracle.latest({blockTag}),
        ]);
    if (multi) throw new Error("canonical entitlement builder requires a single-partition bond");
    if (fixing.publishedAt >= dueAt) {
        throw new Error("historical reference fixing was not published before coupon due");
    }

    const holders = await bond.getSecurityHolders(0, holderCount, {blockTag});
    const details = [];
    for (const rawHolder of holders) {
        const holder = getAddress(rawHolder);
        const [free, held, locked, cleared, frozen] = await Promise.all([
            bond.balanceOfByPartition(partition, holder, {blockTag}),
            bond.getHeldAmountForByPartition(partition, holder, {blockTag}),
            bond.getLockedAmountForByPartition(partition, holder, {blockTag}),
            bond.getClearedAmountForByPartition(partition, holder, {blockTag}),
            bond.getFrozenTokens(holder, {blockTag}),
        ]);
        const lot = free + held + locked + cleared + frozen;
        const localAmount = couponCashAmount({
            lot,
            faceValue,
            rateBps: fixing.refRateBps + spreadBps,
            accrualStart,
            dueAt,
        });
        const chainAmount = await schedule.amountFor(index, fixing.refRateBps, lot, {blockTag});
        if (localAmount !== chainAmount) {
            throw new Error(`schedule arithmetic mismatch for ${holder}`);
        }
        details.push({
            holder,
            free: free.toString(),
            held: held.toString(),
            locked: locked.toString(),
            cleared: cleared.toString(),
            frozen: frozen.toString(),
            lot: lot.toString(),
            amount: localAmount,
        });
    }

    const lotTotal = details.reduce((sum, row) => sum + BigInt(row.lot), 0n);
    if (lotTotal !== supply) {
        throw new Error(`record-date lots total ${lotTotal}, expected supply ${supply}`);
    }
    const payable = details.filter((row) => row.amount > 0n);
    const excluded = details.filter((row) => row.amount === 0n);
    const tree = buildEntitlements(
        index,
        payable.map(({holder, amount}) => ({holder, amount})),
    );

    return {
        schema: "lattice.bond.coupon-entitlements.v1",
        generatedAt: new Date().toISOString(),
        network: "hedera-testnet",
        chainId: 296,
        kind: "canonical-lprc-coupon-zero",
        index,
        bond: getAddress(deployment.token.address),
        schedule: getAddress(coupon.CouponSchedule),
        distributor: getAddress(coupon.CouponDistributor),
        cashToken: getAddress(coupon.cashToken.address),
        oracleAtRecordDate: getAddress(oldOracle),
        partition,
        recordDate: recordDate.toString(),
        dueAt: dueAt.toString(),
        accrualStart: accrualStart.toString(),
        cutoffBlock: {
            number: cutoff.number,
            mirrorHash: cutoff.hash,
            evmHash: evmBlock.hash,
            evmTimestamp: evmBlock.timestamp,
            consensusFrom: cutoff.timestamp.from,
            consensusTo: cutoff.timestamp.to,
            nextConsensusFrom: nextBlock.timestamp.from,
            nextConsensusTo: nextBlock.timestamp.to,
        },
        fixing: {
            cleanPrice8: fixing.cleanPrice8.toString(),
            referenceRateBps: fixing.refRateBps.toString(),
            spreadBps: spreadBps.toString(),
            couponRateBps: (fixing.refRateBps + spreadBps).toString(),
            publishedAt: fixing.publishedAt.toString(),
        },
        faceValueSmallestCashUnits: faceValue.toString(),
        supplyAtRecordDate: supply.toString(),
        totalLot: lotTotal.toString(),
        root: tree.root,
        width: tree.width,
        total: tree.total.toString(),
        holders: proofRows(tree, payable),
        excludedZeroAmountHolders: excluded.map((row) => ({
            ...row,
            amount: jsonBig(row.amount),
        })),
    };
}

export async function buildAtsCoupon({
    rpc,
    token,
    schedule,
    distributor,
    couponId = 1,
    distributorIndex = 0,
    referenceRateBps,
    cashDecimals = 2,
}) {
    const provider = providerFor(rpc);
    const ats = new Contract(token, ATS_COUPON_ABI, provider);
    const scheduleContract = new Contract(schedule, SCHEDULE_ABI, provider);
    const registered = await ats.getCoupon(couponId);
    if (registered.isDisabled_) throw new Error(`ATS coupon ${couponId} is disabled`);
    if (registered.registeredCoupon_.snapshotId === 0n) {
        throw new Error(`ATS coupon ${couponId} has no record-date snapshot`);
    }

    const count = await ats.getTotalCouponHolders(couponId);
    if (count === 0n) throw new Error(`ATS coupon ${couponId} has no holders`);
    const holders = await ats.getCouponHolders(couponId, 0, count);
    const details = [];
    for (const rawHolder of holders) {
        const holder = getAddress(rawHolder);
        const view = await ats.getCouponFor(couponId, holder);
        if (!view.recordDateReached || !view.couponAmount.recordDateReached) {
            throw new Error(`ATS coupon record date is not reached for ${holder}`);
        }
        const amount = cashAmountFromFraction(
            view.couponAmount.numerator,
            view.couponAmount.denominator,
            cashDecimals,
        );
        const scheduled = await scheduleContract.amountFor(
            distributorIndex,
            referenceRateBps,
            view.tokenBalance,
        );
        if (amount !== scheduled) {
            throw new Error(`ATS and CouponSchedule amounts disagree for ${holder}`);
        }
        details.push({
            holder,
            tokenBalance: view.tokenBalance.toString(),
            numerator: view.couponAmount.numerator.toString(),
            denominator: view.couponAmount.denominator.toString(),
            amount,
        });
    }

    const tree = buildEntitlements(
        distributorIndex,
        details.filter((row) => row.amount > 0n).map(({holder, amount}) => ({holder, amount})),
    );
    return {
        schema: "lattice.bond.coupon-entitlements.v1",
        generatedAt: new Date().toISOString(),
        network: "hedera-testnet",
        chainId: 296,
        kind: "compressed-ats-bond",
        index: distributorIndex,
        atsCouponId: couponId,
        bond: getAddress(token),
        schedule: getAddress(schedule),
        distributor: getAddress(distributor),
        snapshotId: registered.registeredCoupon_.snapshotId.toString(),
        coupon: Object.fromEntries(
            COUPON_COMPONENTS.map(({name}) => [
                name,
                registered.registeredCoupon_.coupon[name].toString(),
            ]),
        ),
        referenceRateBps: BigInt(referenceRateBps).toString(),
        cashDecimals,
        supplyAtSnapshotRead: (await ats.totalSupply()).toString(),
        root: tree.root,
        width: tree.width,
        total: tree.total.toString(),
        holders: proofRows(tree, details),
    };
}

function requiredEnv(name) {
    const value = process.env[name];
    if (!value) throw new Error(`set ${name}`);
    return value;
}

async function main() {
    const [kind, output] = process.argv.slice(2);
    if (!kind || !output || !["canonical", "ats"].includes(kind)) {
        throw new Error(
            "usage: node tools/bond-coupon-entitlements.mjs {canonical|ats} OUTPUT",
        );
    }
    const rpc = requiredEnv("HEDERA_TESTNET_RPC");
    let result;
    if (kind === "canonical") {
        const deployment = JSON.parse(
            readFileSync(process.env.VENUE_DEPLOYMENT || "deployments/296-venue.json"),
        );
        result = await buildCanonicalCoupon({
            rpc,
            mirror:
                process.env.HEDERA_MIRROR_URL ||
                "https://testnet.mirrornode.hedera.com",
            deployment,
        });
    } else {
        result = await buildAtsCoupon({
            rpc,
            token: requiredEnv("DEMO_ATS_TOKEN"),
            schedule: requiredEnv("DEMO_COUPON_SCHEDULE"),
            distributor: requiredEnv("DEMO_COUPON_DISTRIBUTOR"),
            referenceRateBps: requiredEnv("DEMO_REFERENCE_RATE_BPS"),
            cashDecimals: Number(process.env.DEMO_CASH_DECIMALS || 2),
        });
    }
    writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
    console.log(`wrote ${output}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    await main();
}
