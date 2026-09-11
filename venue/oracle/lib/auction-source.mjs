import {Contract, Interface, JsonRpcProvider, keccak256, toUtf8Bytes} from "ethers";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {paged} from "../../tools/hcs-chain.mjs";
import {deviationBps, median, printToUsd8, uint} from "./fixed.mjs";
import {readDeployment, VENUE_ROOT} from "./terms-source.mjs";

export class AuctionSourceError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "AuctionSourceError";
        this.code = code;
    }
}

function transactionHash(log) {
    return String(log.transaction_hash ?? log.transactionHash ?? "").toLowerCase();
}

function timestampSeconds(log) {
    const seconds = Number(String(log.timestamp ?? "0").split(".")[0]);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
        throw new AuctionSourceError("BAD_TIMESTAMP", "mirror log has no consensus timestamp");
    }
    return seconds;
}

export function decodeAuctionLogs(logs, abi) {
    const iface = abi instanceof Interface ? abi : new Interface(abi);
    const groups = new Map();
    const rejected = [];
    for (const log of logs ?? []) {
        let parsed;
        try {
            parsed = iface.parseLog({topics: log.topics, data: log.data});
        } catch {
            continue;
        }
        if (!parsed || ![
            "RoundCrossed",
            "Settled",
            "SettlementRefused",
            "PrintedCoarse",
            "PrintWithheld",
        ].includes(parsed.name)) {
            continue;
        }
        const tx = transactionHash(log);
        if (!/^0x[0-9a-f]{64}$/.test(tx)) {
            rejected.push({code: "BAD_TX", message: "mirror log has no transaction hash"});
            continue;
        }
        if (!groups.has(tx)) {
            groups.set(tx, {
                tx,
                exact: null,
                exacts: [],
                settlements: [],
                refusals: [],
                degraded: null,
                degradedOutputs: [],
            });
        }
        const group = groups.get(tx);
        if (parsed.name === "RoundCrossed") {
            const exact = {
                round: Number(parsed.args.round),
                priceTwice: BigInt(parsed.args.priceTwice),
                indicatedVolume: BigInt(parsed.args.volume),
                at: timestampSeconds(log),
            };
            group.exacts.push(exact);
            if (group.exact === null) group.exact = exact;
        } else if (parsed.name === "Settled") {
            group.settlements.push({
                sellId: String(parsed.args.sellId).toLowerCase(),
                buyId: String(parsed.args.buyId).toLowerCase(),
                amount: BigInt(parsed.args.amount),
                cost: BigInt(parsed.args.cost),
            });
        } else if (parsed.name === "SettlementRefused") {
            group.refusals.push({
                sellId: String(parsed.args.sellId).toLowerCase(),
                buyId: String(parsed.args.buyId).toLowerCase(),
            });
        } else {
            group.degraded = parsed.name;
            group.degradedOutputs.push(parsed.name);
        }
    }
    return {groups: [...groups.values()], rejected};
}

async function qualifyGroup(group, {
    orderLookup,
    excludedAddresses,
    now,
    maximumAgeSeconds,
    minimumVolume,
    usdPerHbar8,
}) {
    const degradedOutputs = Array.isArray(group.degradedOutputs) &&
        group.degradedOutputs.length > 0
        ? group.degradedOutputs
        : group.degraded
            ? [group.degraded]
            : [];
    if (degradedOutputs.length > 0) {
        return {accepted: false, code: "DEGRADED_PRINT", outputs: [...degradedOutputs].sort()};
    }
    const exacts = Array.isArray(group.exacts) && group.exacts.length > 0
        ? group.exacts
        : group.exact
            ? [group.exact]
            : [];
    if (exacts.length === 0) {
        return {accepted: false, code: "NO_EXACT_PRINT"};
    }
    if (exacts.length !== 1) {
        return {accepted: false, code: "AMBIGUOUS_PRINT", exactPrints: exacts.length};
    }
    const exact = exacts[0];
    const refusals = Array.isArray(group.refusals) ? group.refusals : [];
    if (refusals.length > 0) {
        return {accepted: false, code: "SETTLEMENT_REFUSED", refusals: refusals.length};
    }
    const age = now - exact.at;
    if (age < -30 || age > maximumAgeSeconds) {
        return {accepted: false, code: "STALE_PRINT", age};
    }
    if (group.settlements.length === 0) {
        return {accepted: false, code: "NO_SETTLEMENT"};
    }

    let indicatedVolume;
    let priceTwice;
    try {
        indicatedVolume = uint(exact.indicatedVolume, "indicatedVolume");
        priceTwice = uint(exact.priceTwice, "priceTwice");
    } catch {
        return {accepted: false, code: "AMBIGUOUS_PRINT"};
    }
    let volume = 0n;
    const counterparties = new Set();
    const settlementPairs = new Set();
    for (const settlement of group.settlements) {
        const sellId = String(settlement.sellId ?? "").toLowerCase();
        const buyId = String(settlement.buyId ?? "").toLowerCase();
        const pair = `${sellId}:${buyId}`;
        let amount;
        try {
            amount = uint(settlement.amount, "settlement.amount");
        } catch {
            return {accepted: false, code: "AMBIGUOUS_SETTLEMENT"};
        }
        if (!sellId || !buyId || amount === 0n || settlementPairs.has(pair)) {
            return {accepted: false, code: "AMBIGUOUS_SETTLEMENT"};
        }
        settlementPairs.add(pair);
        const [seller, buyer] = await Promise.all([
            orderLookup(sellId),
            orderLookup(buyId),
        ]);
        const sellAddress = String(seller?.trader ?? seller).toLowerCase();
        const buyAddress = String(buyer?.trader ?? buyer).toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(sellAddress) || !/^0x[0-9a-f]{40}$/.test(buyAddress)) {
            return {accepted: false, code: "UNKNOWN_COUNTERPARTY"};
        }
        if (sellAddress === buyAddress) return {accepted: false, code: "WASH_PRINT"};
        if (excludedAddresses.has(sellAddress) || excludedAddresses.has(buyAddress)) {
            return {accepted: false, code: "SYNTHETIC_PRINT"};
        }
        counterparties.add(sellAddress);
        counterparties.add(buyAddress);
        volume += amount;
    }
    if (volume < indicatedVolume) {
        return {
            accepted: false,
            code: "PARTIAL_SETTLEMENT",
            indicatedVolume,
            settledVolume: volume,
        };
    }
    if (volume > indicatedVolume) {
        return {
            accepted: false,
            code: "INDICATED_VOLUME_MISMATCH",
            indicatedVolume,
            settledVolume: volume,
        };
    }
    if (volume < minimumVolume) {
        return {accepted: false, code: "LOW_VOLUME", volume};
    }

    const priceUsd8 = printToUsd8(priceTwice, usdPerHbar8);
    if (priceUsd8 === 0n) return {accepted: false, code: "ZERO_PRICE"};
    const sortedCounterparties = [...counterparties].sort();
    const provenance = {
        transaction: String(group.tx).toLowerCase(),
        auctionRound: String(exact.round),
        timestamp: exact.at,
        indicatedVolume: indicatedVolume.toString(),
        settledVolume: volume.toString(),
        priceTwice: priceTwice.toString(),
        priceUsd8: priceUsd8.toString(),
        usdPerHbar8: usdPerHbar8.toString(),
        counterparties: sortedCounterparties,
    };
    return {
        accepted: true,
        observation: {
            source: "hedera-auction-print",
            tx: group.tx,
            round: exact.round,
            observedAt: exact.at,
            age,
            priceTwice,
            priceUsd8,
            volume,
            settledVolume: volume,
            indicatedVolume,
            counterparties: sortedCounterparties,
            provenance,
            sourceDigest: keccak256(toUtf8Bytes(JSON.stringify(provenance))),
        },
    };
}

export async function qualifyAuctionGroups(groups, {
    orderLookup,
    excludedAddresses = [],
    now = Math.floor(Date.now() / 1000),
    maximumAgeSeconds = 1800,
    minimumVolume = 1n,
    maximumOutlierBps = 500n,
    usdPerHbar8,
} = {}) {
    if (typeof orderLookup !== "function") {
        throw new AuctionSourceError("NO_ORDER_LOOKUP", "orderLookup is required");
    }
    const excluded = new Set(excludedAddresses.map((address) => String(address).toLowerCase()));
    const options = {
        orderLookup,
        excludedAddresses: excluded,
        now: Number(now),
        maximumAgeSeconds: Number(maximumAgeSeconds),
        minimumVolume: uint(minimumVolume, "minimumVolume"),
        usdPerHbar8: uint(usdPerHbar8, "usdPerHbar8"),
    };
    const accepted = [];
    const rejected = [];
    for (const group of groups ?? []) {
        const result = await qualifyGroup(group, options);
        if (result.accepted) accepted.push(result.observation);
        else rejected.push({tx: group.tx, ...result});
    }
    if (accepted.length < 2) return {accepted, rejected};

    const center = median(accepted.map((row) => row.priceUsd8));
    const cap = uint(maximumOutlierBps, "maximumOutlierBps");
    const kept = [];
    for (const row of accepted) {
        const moved = deviationBps(row.priceUsd8, center);
        if (moved > cap) rejected.push({tx: row.tx, code: "OUTLIER_PRINT", deviationBps: moved});
        else kept.push(row);
    }
    return {accepted: kept, rejected};
}

export async function fetchQualifiedAuctionPrints({
    root = VENUE_ROOT,
    rpcUrl = null,
    mirrorUrl = null,
    provider = null,
    now = Math.floor(Date.now() / 1000),
    maximumAgeSeconds = 1800,
    minimumVolume = 1n,
    maximumOutlierBps = 500n,
    excludedAddresses = [],
    usdPerHbar8,
} = {}) {
    const {client} = readDeployment(root);
    const abi = JSON.parse(
        readFileSync(join(root, "deployments/abi/MatchingEngine.json"), "utf8"),
    );
    const reader = provider ?? new JsonRpcProvider(
        rpcUrl ?? client.network.rpc,
        Number(client.network.chainId),
        {staticNetwork: true, batchMaxCount: 20},
    );
    const engine = new Contract(client.addresses.MatchingEngine, abi, reader);
    const cache = new Map();
    const orderLookup = async (id) => {
        if (!cache.has(id)) cache.set(id, engine.orders(id));
        return cache.get(id);
    };
    const after = Math.max(0, Number(now) - Number(maximumAgeSeconds));
    const path = `/api/v1/contracts/${client.addresses.MatchingEngine}/results/logs` +
        `?order=asc&limit=100&timestamp=gte:${after}.0`;
    const logs = await paged(mirrorUrl ?? client.network.mirror, path, "logs", {pages: 20});
    const decoded = decodeAuctionLogs(logs, abi);
    const qualified = await qualifyAuctionGroups(decoded.groups, {
        orderLookup,
        excludedAddresses,
        now,
        maximumAgeSeconds,
        minimumVolume,
        maximumOutlierBps,
        usdPerHbar8,
    });
    return {
        accepted: qualified.accepted,
        rejected: [...decoded.rejected, ...qualified.rejected],
        scannedLogs: logs.length,
    };
}
