import {keccak256, toUtf8Bytes} from "ethers";
import {fetchQualifiedAuctionPrints} from "./auction-source.mjs";
import {fetchDealerQuotes} from "./dealer-source.mjs";
import {deviationBps, uint} from "./fixed.mjs";
import {readHbarMarketRate} from "./hbar-market-source.mjs";
import {fetchSofr} from "./sofr-source.mjs";
import {readInstrumentTerms} from "./terms-source.mjs";
import {aggregateHybrid, valueFloatingRateBond} from "./valuation.mjs";

function digestBundle(parts) {
    const canonical = JSON.stringify(
        parts.filter(Boolean).map((part) => String(part).toLowerCase()).sort(),
    );
    return keccak256(toUtf8Bytes(canonical));
}

export async function buildHybridQuote(config, dependencies = {}) {
    const now = Number(dependencies.now ?? Math.floor(Date.now() / 1000));
    const terms = await (dependencies.readTerms ?? readInstrumentTerms)({
        root: config.root,
        rpcUrl: config.rpcUrl,
        provider: dependencies.provider,
    });
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
        return {
            ok: false,
            code: "HBAR_MARKET_UNAVAILABLE",
            reason: marketRateError?.message ?? "required HBAR/USD market cross-check is missing",
            terms,
            sofr,
        };
    }
    let hbarDivergenceBps = null;
    if (marketRate) {
        hbarDivergenceBps = deviationBps(terms.usdPerHbar8, marketRate.usdPerHbar8);
        const cap = uint(config.hbarMarket?.maximumDivergenceBps ?? 400, "maximumDivergenceBps");
        if (hbarDivergenceBps > cap) {
            return {
                ok: false,
                code: "HBAR_RATE_DIVERGENCE",
                reason: `Hedera 0x168 and market HBAR/USD differ by ${hbarDivergenceBps} bps`,
                terms,
                sofr,
                marketRate,
                hbarDivergenceBps,
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
    const sourceDigest = digestBundle([
        terms.sourceDigest,
        sofr.sourceDigest,
        marketRate?.sourceDigest,
        ...prints.accepted.map((row) => row.sourceDigest),
        ...dealerResult.accepted.map((row) => row.sourceDigest),
    ]);

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
            sourceDigest,
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
        sourceDigest,
        quality: {
            exactPrints: prints.accepted.length,
            rejectedPrints: prints.rejected.length,
            dealerQuotes: dealerResult.accepted.length,
            rejectedDealerQuotes: dealerResult.rejected.length,
            hbarMarketCrossCheck: marketRate !== null,
        },
    };
}
