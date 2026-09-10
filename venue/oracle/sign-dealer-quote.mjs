import {
    Wallet,
    getAddress,
    hexlify,
    keccak256,
    randomBytes,
} from "ethers";
import {readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {loadOracleConfig} from "./lib/config.mjs";
import {DEALER_QUOTE_TYPES, dealerDomain} from "./lib/dealer-source.mjs";
import {parseDecimal, uint} from "./lib/fixed.mjs";
import {readDeployment} from "./lib/terms-source.mjs";

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
    const index = args.indexOf(flag);
    return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
if (process.env.ORACLE_PUBLISHER_PRIVATE_KEY) {
    throw new Error("dealer quote process refuses ORACLE_PUBLISHER_PRIVATE_KEY");
}
const privateKey = process.env.DEALER_QUOTE_PRIVATE_KEY;
if (!privateKey) throw new Error("set DEALER_QUOTE_PRIVATE_KEY");
const wallet = new Wallet(privateKey);
const config = loadOracleConfig(value("--config") ?? undefined, {allowExample: true});
const deployment = readDeployment().client;
const sourcePath = value("--source");
const outputPath = value("--output");
if (!sourcePath || !outputPath) {
    throw new Error("usage: sign-dealer-quote.mjs --price-usd 100.00 --source packet.json --output quote.json");
}
const price = value("--price-usd8")
    ? uint(value("--price-usd8"), "price-usd8")
    : value("--price-usd")
        ? parseDecimal(value("--price-usd"), 8, "price-usd")
        : null;
if (price === null || price === 0n) throw new Error("set a positive --price-usd or --price-usd8");
const allowed = new Set((config.dealers?.allowedAddresses ?? []).map(getAddress));
if (!allowed.has(wallet.address)) {
    throw new Error(`dealer ${wallet.address} is not in config.dealers.allowedAddresses`);
}

const effectiveAt = Math.floor(Date.now() / 1000);
const lifetime = Number(value("--lifetime", config.dealers?.maximumAgeSeconds ?? 3600));
if (!Number.isSafeInteger(lifetime) || lifetime < 60 || lifetime > 86_400) {
    throw new Error("quote lifetime must be from 60 to 86400 seconds");
}
const sourceBytes = readFileSync(resolve(sourcePath));
const message = {
    instrument: deployment.addresses.token,
    cleanPriceUsd8: price,
    effectiveAt,
    expiresAt: effectiveAt + lifetime,
    nonce: hexlify(randomBytes(32)),
    sourceHash: keccak256(sourceBytes),
};
const signature = await wallet.signTypedData(
    dealerDomain({
        chainId: config.chainId,
        oracle: deployment.addresses.PrimeOracle,
    }),
    DEALER_QUOTE_TYPES,
    message,
);
const quote = {
    source: value("--label", "signed-dealer"),
    instrument: message.instrument,
    cleanPriceUsd8: message.cleanPriceUsd8.toString(),
    effectiveAt: message.effectiveAt,
    expiresAt: message.expiresAt,
    nonce: message.nonce,
    sourceHash: message.sourceHash,
    signature,
};
writeFileSync(resolve(outputPath), JSON.stringify(quote, null, 2) + "\n");
console.log(JSON.stringify({
    written: resolve(outputPath),
    dealer: wallet.address,
    cleanPriceUsd8: quote.cleanPriceUsd8,
    expiresAt: quote.expiresAt,
    sourceHash: quote.sourceHash,
}));
