import {Contract, JsonRpcProvider, keccak256, toUtf8Bytes} from "ethers";
import {uint} from "./fixed.mjs";

const AGGREGATOR_ABI = [
    "function decimals() view returns (uint8)",
    "function description() view returns (string)",
    "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
];

export class HbarMarketSourceError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "HbarMarketSourceError";
        this.code = code;
    }
}

export async function readHbarMarketRate({
    address,
    rpcUrl,
    chainId = 296,
    provider = null,
    feedContract = null,
    now = Math.floor(Date.now() / 1000),
    maximumAgeSeconds = 93_600,
} = {}) {
    if (!address) throw new HbarMarketSourceError("NO_FEED", "market feed address is required");
    const reader = provider ?? new JsonRpcProvider(rpcUrl, chainId, {
        staticNetwork: true,
        batchMaxCount: 10,
    });
    const feed = feedContract ?? new Contract(address, AGGREGATOR_ABI, reader);
    let decimals;
    let description;
    let latest;
    try {
        [decimals, description, latest] = await Promise.all([
            feed.decimals(),
            feed.description().catch(() => "HBAR / USD"),
            feed.latestRoundData(),
        ]);
    } catch (error) {
        throw new HbarMarketSourceError("UNAVAILABLE", `market HBAR/USD feed failed: ${error.message}`);
    }
    if (Number(decimals) !== 8) {
        throw new HbarMarketSourceError("BAD_DECIMALS", `market feed has ${decimals} decimals`);
    }
    const roundId = uint(latest[0], "roundId");
    const answer = BigInt(latest[1]);
    const updatedAt = uint(latest[3], "updatedAt");
    const answeredInRound = uint(latest[4], "answeredInRound");
    if (answer <= 0n) throw new HbarMarketSourceError("NON_POSITIVE", "market rate is not positive");
    const at = uint(now, "now");
    if (updatedAt === 0n || updatedAt > at + 30n || answeredInRound < roundId) {
        throw new HbarMarketSourceError("BAD_ROUND", "market feed round is incomplete or future dated");
    }
    if (at - updatedAt > BigInt(maximumAgeSeconds)) {
        throw new HbarMarketSourceError("STALE", "market HBAR/USD feed is stale");
    }
    const canonical = JSON.stringify({
        address: String(address).toLowerCase(),
        roundId: roundId.toString(),
        answer: answer.toString(),
        updatedAt: updatedAt.toString(),
        answeredInRound: answeredInRound.toString(),
    });
    return {
        source: "external-hbar-usd",
        address,
        description,
        usdPerHbar8: answer,
        roundId,
        updatedAt: Number(updatedAt),
        sourceDigest: keccak256(toUtf8Bytes(canonical)),
    };
}
