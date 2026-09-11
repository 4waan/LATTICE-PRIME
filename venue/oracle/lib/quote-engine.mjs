import {keccak256, toUtf8Bytes} from "ethers";
import {fetchQualifiedAuctionPrints} from "./auction-source.mjs";
import {fetchDealerQuotes} from "./dealer-source.mjs";
import {deviationBps, uint} from "./fixed.mjs";
import {readHbarMarketRate} from "./hbar-market-source.mjs";
import {fetchSofr} from "./sofr-source.mjs";
import {readInstrumentTerms} from "./terms-source.mjs";
import {aggregateHybrid, valueFloatingRateBond} from "./valuation.mjs";

export const HYBRID_QUOTE_ALGORITHM_VERSION = "hybrid-vwap-usd8-v1";
export const MAX_PROVENANCE_BYTES = 512;
export const QUOTE_QUALITY_FLAGS = Object.freeze({
    SOFR_QUALIFIED: 1,
    AUCTION_QUALIFIED: 2,
    DEALER_QUALIFIED: 4,
    HBAR_MARKET_QUALIFIED: 8,
    INDEPENDENT_CROSS_CHECK: 16,
    VALUATION_QUALIFIED: 32,
    SOURCE_REJECTIONS: 64,
    MARKET_VWAP: 128,
});

function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function sortedAddresses(values) {
    return [...new Set((values ?? []).map((value) => String(value).toLowerCase()))]
        .sort(compareText);
}

function integerText(value, name) {
    return uint(value, name).toString();
}

export function quoteConfigurationDigest(config, terms) {
    const effective = {
        sourceProfile: config.sourceProfile ?? "default",
        network: config.network ?? null,
        chainId: integerText(terms.chainId ?? config.chainId, "chainId"),
        rpcUrl: config.rpcUrl ?? terms.rpcUrl ?? null,
        mirrorUrl: config.mirrorUrl ?? terms.mirrorUrl ?? null,
        auction: {
            maximumAgeSeconds: integerText(
                config.auction?.maximumAgeSeconds ?? 1800,
                "auction.maximumAgeSeconds",
            ),
            minimumVolume: integerText(
                config.auction?.minimumVolume ?? 1,
                "auction.minimumVolume",
            ),
            minimumAggregateVolume: integerText(
                config.auction?.minimumAggregateVolume ?? 1,
                "auction.minimumAggregateVolume",
            ),
            maximumOutlierBps: integerText(
                config.auction?.maximumOutlierBps ?? 500,
                "auction.maximumOutlierBps",
            ),
            excludedAddresses: sortedAddresses(config.auction?.excludedAddresses),
        },
        sofr: {
            maximumCalendarDays: integerText(
                config.sofr?.maximumCalendarDays ?? 5,
                "sofr.maximumCalendarDays",
            ),
            maximumBusinessDays: integerText(
                config.sofr?.maximumBusinessDays ?? 2,
                "sofr.maximumBusinessDays",
            ),
        },
        dealers: {
            endpoints: (config.dealers?.endpoints ?? []).map(String),
            allowedAddresses: sortedAddresses(config.dealers?.allowedAddresses),
            timeoutMs: integerText(config.dealers?.timeoutMs ?? 10_000, "dealers.timeoutMs"),
            maximumAgeSeconds: integerText(
                config.dealers?.maximumAgeSeconds ?? 3600,
                "dealers.maximumAgeSeconds",
            ),
            maximumFutureSeconds: integerText(
                config.dealers?.maximumFutureSeconds ?? 30,
                "dealers.maximumFutureSeconds",
            ),
        },
        model: {
            requiredMarginBps: integerText(
                config.model?.requiredMarginBps ?? terms.spreadBps,
                "model.requiredMarginBps",
            ),
            minimumFallbackSources: integerText(
                config.model?.minimumFallbackSources ?? 2,
                "model.minimumFallbackSources",
            ),
            maximumCrossCheckBps: integerText(
                config.model?.maximumCrossCheckBps ?? 300,
                "model.maximumCrossCheckBps",
            ),
            requireCrossCheck: Boolean(config.model?.requireCrossCheck ?? true),
        },
        hbarMarket: {
            address: config.hbarMarket?.address
                ? String(config.hbarMarket.address).toLowerCase()
                : null,
            required: Boolean(config.hbarMarket?.required ?? false),
            maximumAgeSeconds: integerText(
                config.hbarMarket?.maximumAgeSeconds ?? 93_600,
                "hbarMarket.maximumAgeSeconds",
            ),
            maximumDivergenceBps: integerText(
                config.hbarMarket?.maximumDivergenceBps ?? 400,
                "hbarMarket.maximumDivergenceBps",
            ),
        },
    };
    return keccak256(toUtf8Bytes(JSON.stringify(effective)));
}

function digestBundle({
    configurationDigest,
    terms,
    sofr,
    marketRate,
    prints,
    dealers,
}) {
    const canonical = JSON.stringify({
        algorithmVersion: HYBRID_QUOTE_ALGORITHM_VERSION,
        configurationDigest,
        terms: terms?.sourceDigest?.toLowerCase() ?? null,
        sofr: sofr?.sourceDigest?.toLowerCase() ?? null,
        hbarMarket: marketRate?.sourceDigest?.toLowerCase() ?? null,
        auction: (prints?.accepted ?? [])
            .map((row) => row.sourceDigest.toLowerCase())
            .sort(compareText),
        dealers: (dealers?.accepted ?? [])
            .map((row) => row.sourceDigest.toLowerCase())
            .sort(compareText),
    });
    return keccak256(toUtf8Bytes(canonical));
}

function descendingInteger(left, right) {
    const a = BigInt(left);
    const b = BigInt(right);
    return a > b ? -1 : a < b ? 1 : 0;
}

function latestPrint(rows) {
    const row = [...(rows ?? [])].sort((left, right) =>
        descendingInteger(left.observedAt, right.observedAt) ||
        descendingInteger(left.round, right.round) ||
        compareText(String(left.tx).toLowerCase(), String(right.tx).toLowerCase())
    )[0];
    return row
        ? {
            tx: String(row.tx).toLowerCase(),
            round: String(row.round),
            at: Number(row.observedAt),
        }
        : null;
}

function latestDealer(rows) {
    const row = [...(rows ?? [])].sort((left, right) =>
        descendingInteger(left.effectiveAt, right.effectiveAt) ||
        compareText(String(left.signer).toLowerCase(), String(right.signer).toLowerCase()) ||
        compareText(String(left.sourceDigest).toLowerCase(), String(right.sourceDigest).toLowerCase())
    )[0];
    return row
        ? {
            signer: String(row.signer).toLowerCase(),
            at: Number(row.effectiveAt),
        }
        : null;
}

function qualityFlags({sofr, marketRate, prints, dealers, aggregate}) {
    let flags = 0;
    if (sofr) flags |= QUOTE_QUALITY_FLAGS.SOFR_QUALIFIED;
    if ((prints?.accepted?.length ?? 0) > 0) flags |= QUOTE_QUALITY_FLAGS.AUCTION_QUALIFIED;
    if ((dealers?.accepted?.length ?? 0) > 0) flags |= QUOTE_QUALITY_FLAGS.DEALER_QUALIFIED;
    if (marketRate) flags |= QUOTE_QUALITY_FLAGS.HBAR_MARKET_QUALIFIED;
    if (aggregate?.ok && aggregate.mode === "qualified-market") {
        flags |= QUOTE_QUALITY_FLAGS.INDEPENDENT_CROSS_CHECK;
    }
    if (aggregate?.ok) flags |= QUOTE_QUALITY_FLAGS.VALUATION_QUALIFIED;
    if ((prints?.rejected?.length ?? 0) > 0 || (dealers?.rejected?.length ?? 0) > 0) {
        flags |= QUOTE_QUALITY_FLAGS.SOURCE_REJECTIONS;
    }
    if (aggregate?.ok &&
        (aggregate.mode === "qualified-market" || aggregate.mode === "market-only")) {
        flags |= QUOTE_QUALITY_FLAGS.MARKET_VWAP;
    }
    return flags;
}

function quoteMetadata({
    configurationDigest,
    terms,
    sofr,
    marketRate = null,
    prints = {accepted: [], rejected: []},
    dealers = {accepted: [], rejected: []},
    aggregate,
}) {
    const flags = qualityFlags({sofr, marketRate, prints, dealers, aggregate});
    const provenance = {
        algorithmVersion: HYBRID_QUOTE_ALGORITHM_VERSION,
        configurationDigest,
        latestPrint: latestPrint(prints.accepted),
        sofr: sofr
            ? {date: sofr.effectiveDate, at: Number(sofr.effectiveAt)}
            : null,
        dealer: latestDealer(dealers.accepted),
        hbarMarket: marketRate
            ? {round: String(marketRate.roundId), at: Number(marketRate.updatedAt)}
            : null,
        qualityFlags: flags,
    };
    const provenanceBytes = Buffer.byteLength(JSON.stringify(provenance), "utf8");
    if (provenanceBytes > MAX_PROVENANCE_BYTES) {
        throw new RangeError(
            `source provenance is ${provenanceBytes} bytes, maximum is ${MAX_PROVENANCE_BYTES}`,
        );
    }
    return {
        algorithmVersion: HYBRID_QUOTE_ALGORITHM_VERSION,
        configurationDigest,
        sourceDigest: digestBundle({
            configurationDigest,
            terms,
            sofr,
            marketRate,
            prints,
            dealers,
        }),
        provenance,
        quality: {
            exactPrints: prints.accepted.length,
            rejectedPrints: prints.rejected.length,
            dealerQuotes: dealers.accepted.length,
            rejectedDealerQuotes: dealers.rejected.length,
            hbarMarketCrossCheck: marketRate !== null,
            qualityFlags: flags,
        },
    };
}

export async function buildHybridQuote(config, dependencies = {}) {
    const now = Number(dependencies.now ?? Math.floor(Date.now() / 1000));
    const terms = await (dependencies.readTerms ?? readInstrumentTerms)({
        root: config.root,
        rpcUrl: config.rpcUrl,
        provider: dependencies.provider,
    });
    const configurationDigest = quoteConfigurationDigest(config, terms);
    const sofr = await (dependencies.fetchSofr ?? fetchSofr)({
        fetchImpl: dependencies.fetchImpl,
        now,
        maximumCalendarDays: config.sofr?.maximumCalendarDays ?? 5,
        maximumBusinessDays: config.sofr?.maximumBusinessDays ?? 2,
    });

    let marketRate = null;
    let marketRateError = null;
    if (config.hbarMarket?.address) {
        try {
            marketRate = await (dependencies.readHbarMarketRate ?? readHbarMarketRate)({
                address: config.hbarMarket.address,
                rpcUrl: config.rpcUrl ?? terms.rpcUrl,
                chainId: terms.chainId,
                provider: dependencies.provider,
                now,
                maximumAgeSeconds: config.hbarMarket.maximumAgeSeconds ?? 93_600,
            });
        } catch (error) {
            marketRateError = {code: error.code ?? "UNAVAILABLE", message: error.message};
        }
    }
    if (config.hbarMarket?.required && !marketRate) {
        const aggregate = {
            ok: false,
            code: "HBAR_MARKET_UNAVAILABLE",
            reason: marketRateError?.message ?? "required HBAR/USD market cross-check is missing",
        };
        return {
            ...aggregate,
            terms,
            sofr,
            marketRate,
            hbarDivergenceBps: null,
            ...quoteMetadata({
                configurationDigest,
                terms,
                sofr,
                marketRate,
                aggregate,
            }),
        };
    }
    let hbarDivergenceBps = null;
    if (marketRate) {
        hbarDivergenceBps = deviationBps(terms.usdPerHbar8, marketRate.usdPerHbar8);
        const cap = uint(config.hbarMarket?.maximumDivergenceBps ?? 400, "maximumDivergenceBps");
        if (hbarDivergenceBps > cap) {
            const aggregate = {
                ok: false,
                code: "HBAR_RATE_DIVERGENCE",
                reason: `Hedera 0x168 and market HBAR/USD differ by ${hbarDivergenceBps} bps`,
            };
            return {
                ...aggregate,
                terms,
                sofr,
                marketRate,
                hbarDivergenceBps,
                ...quoteMetadata({
                    configurationDigest,
                    terms,
                    sofr,
                    marketRate,
                    aggregate,
                }),
            };
        }
    }

    const prints = await (dependencies.fetchAuctionPrints ?? fetchQualifiedAuctionPrints)({
        root: config.root,
        rpcUrl: config.rpcUrl ?? terms.rpcUrl,
        mirrorUrl: config.mirrorUrl ?? terms.mirrorUrl,
        provider: dependencies.provider,
        now,
        maximumAgeSeconds: config.auction?.maximumAgeSeconds ?? 1800,
        minimumVolume: config.auction?.minimumVolume ?? 1,
        maximumOutlierBps: config.auction?.maximumOutlierBps ?? 500,
        excludedAddresses: config.auction?.excludedAddresses ?? [],
        usdPerHbar8: terms.usdPerHbar8,
    });
    const dealerResult = await (dependencies.fetchDealerQuotes ?? fetchDealerQuotes)(
        config.dealers?.endpoints ?? [],
        {
            fetchImpl: dependencies.fetchImpl,
            timeoutMs: config.dealers?.timeoutMs ?? 10_000,
            production: config.dealers?.production,
            allowFileEndpoints: config.dealers?.allowFileEndpoints === true,
            chainId: terms.chainId,
            oracle: terms.oracle,
            instrument: terms.instrument,
            allowedDealers: config.dealers?.allowedAddresses ?? [],
            now,
            maximumAgeSeconds: config.dealers?.maximumAgeSeconds ?? 3600,
            maximumFutureSeconds: config.dealers?.maximumFutureSeconds ?? 30,
        },
    );
    const model = valueFloatingRateBond({
        faceValue: terms.faceValue,
        cashDecimals: terms.cashDecimals,
        outputDecimals: 8,
        issuedAt: terms.issuedAt,
        dates: terms.dates,
        valuationAt: now,
        referenceRateBps: sofr.rateBps,
        couponSpreadBps: terms.spreadBps,
        requiredMarginBps: config.model?.requiredMarginBps ?? terms.spreadBps,
    });
    model.observedAt = now;

    const aggregate = aggregateHybrid({
        prints: prints.accepted,
        model,
        dealers: dealerResult.accepted,
        referenceRateBps: sofr.rateBps,
        minimumMarketVolume: config.auction?.minimumAggregateVolume ?? 1,
        minimumFallbackSources: config.model?.minimumFallbackSources ?? 2,
        maximumCrossCheckBps: config.model?.maximumCrossCheckBps ?? 300,
        requireCrossCheck: config.model?.requireCrossCheck ?? true,
    });
    const metadata = quoteMetadata({
        configurationDigest,
        terms,
        sofr,
        marketRate,
        prints,
        dealers: dealerResult,
        aggregate,
    });

    if (!aggregate.ok) {
        return {
            ...aggregate,
            terms,
            sofr,
            marketRate,
            hbarDivergenceBps,
            prints,
            dealers: dealerResult,
            model,
            ...metadata,
        };
    }
    return {
        ...aggregate,
        observedAt: now,
        terms,
        sofr,
        marketRate,
        hbarDivergenceBps,
        prints,
        dealers: dealerResult,
        model,
        ...metadata,
    };
}
