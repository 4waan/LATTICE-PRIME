import {access, chmod, mkdir, readFile, writeFile} from "node:fs/promises";
import {constants as fsConstants} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {Wallet, keccak256, toUtf8Bytes} from "ethers";
import {buildBabyjub} from "../../toolchain/node_modules/circomlibjs/main.js";

import {
    issuePrivateSessionCredentials,
    randomPrivateField,
} from "./private-zk.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const VENUE = resolve(HERE, "..");
const REPO = resolve(VENUE, "..");
const SECRETS = join(VENUE, "agent/secrets");
const ENV_FILE = join(SECRETS, "private-trading.env");
const CREDS_FILE = join(SECRETS, "holder-credentials.json");
const PUBLIC_FILE = join(VENUE, "out/private-trading/bootstrap-public.json");
const CLIENT_FILE = join(VENUE, "deployments/client.json");

const TRADER = "0xCFc5923dEf1F25db05FE50754Ef0822175AFD449";
const WIDE_MANUAL_ROOT =
    "17351106410120225295902853388625488734211813428465793460035694687490561491484";
const QUICKNET =
    "0x52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";

function parseEnvFile(text) {
    const out = {};
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
        const eq = trimmed.indexOf("=");
        out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return out;
}

async function loadRepoEnv() {
    const merged = {};
    for (const name of [".env", ".env.bots"]) {
        try {
            Object.assign(merged, parseEnvFile(await readFile(join(REPO, name), "utf8")));
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }
    return merged;
}

function envLine(name, value) {
    return `${name}=${value}\n`;
}

async function generateViewKey(viewSecret) {
    const babyjub = await buildBabyjub();
    const point = babyjub.mulPointEscalar(babyjub.Base8, viewSecret);
    return {
        secret: viewSecret.toString(),
        x: babyjub.F.toObject(point[0]).toString(),
        y: babyjub.F.toObject(point[1]).toString(),
    };
}

async function main() {
    const repoEnv = await loadRepoEnv();
    const adminWallet = new Wallet(repoEnv.HEDERA_PRIVATE_KEY);
    if (adminWallet.address.toLowerCase() !== TRADER.toLowerCase()) {
        throw new Error("bootstrap admin key is not the connected trader / registry admin");
    }
    const client = JSON.parse(await readFile(CLIENT_FILE, "utf8"));
    await mkdir(SECRETS, {recursive: true, mode: 0o700});
    await mkdir(dirname(PUBLIC_FILE), {recursive: true});

    let existing = {};
    try {
        await access(ENV_FILE, fsConstants.F_OK);
        existing = parseEnvFile(await readFile(ENV_FILE, "utf8"));
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

    const role = async (envName, addressName) => {
        if (existing[envName]) {
            const wallet = new Wallet(existing[envName]);
            return {key: existing[envName], address: wallet.address};
        }
        const wallet = Wallet.createRandom();
        return {key: wallet.privateKey, address: wallet.address};
    };

    const deployer = await role("PRIVATE_TRADING_DEPLOY_KEY");
    const issuer = await role("PRIVATE_TRADING_ISSUER_KEY");
    const relayer = await role("PRIVATE_TRADING_RELAYER_KEY");
    const session = await role("PRIVATE_CANARY_SESSION_KEY");
    const recovery = await role("PRIVATE_CANARY_RECOVERY_KEY");
    const directBuy = await role("PRIVATE_CANARY_DIRECT_BUY_KEY");
    const directSell = await role("PRIVATE_CANARY_DIRECT_SELL_KEY");
    const settler = await role("PRIVATE_CANARY_SETTLER_KEY");
    const funders = [];
    for (let i = 1; i <= 8; i += 1) {
        funders.push(await role(`PRIVATE_TRADING_FUNDER_${i}_KEY`));
    }

    const addresses = [
        adminWallet.address,
        deployer.address,
        issuer.address,
        relayer.address,
        session.address,
        recovery.address,
        directBuy.address,
        directSell.address,
        settler.address,
        ...funders.map((item) => item.address),
    ].map((item) => item.toLowerCase());
    if (new Set(addresses).size !== addresses.length) {
        throw new Error("generated private-trading roles are not distinct");
    }

    const view = existing.PRIVATE_TRADING_VIEW_SECRET
        ? await generateViewKey(BigInt(existing.PRIVATE_TRADING_VIEW_SECRET))
        : await generateViewKey(randomPrivateField());
    const traderSecret = existing.PRIVATE_TRADING_TRADER_HOLDER_SECRET
        || randomPrivateField().toString();
    const canarySecret = existing.PRIVATE_TRADING_CANARY_HOLDER_SECRET
        || randomPrivateField().toString();
    const tree = issuePrivateSessionCredentials([
        {
            wallet: TRADER,
            holderSecret: traderSecret,
            credentialId: 73,
            jurisdiction: 3,
            tier: 4,
            validUntilEpoch: 50,
        },
        {
            wallet: session.address,
            holderSecret: canarySecret,
            credentialId: 74,
            jurisdiction: 3,
            tier: 4,
            validUntilEpoch: 50,
        },
    ], 16);
    const feePolicyDigest = existing.PRIVATE_TRADING_FEE_POLICY_DIGEST
        || keccak256(toUtf8Bytes("lattice.private-trading.fee-policy.v1"));
    const accountSalt = existing.PRIVATE_TRADING_CANARY_ACCOUNT_SALT
        || keccak256(toUtf8Bytes(`lattice.private-trading.canary-salt.${Date.now()}`));

    const envText = [
        envLine("HEDERA_TESTNET_RPC", repoEnv.HEDERA_TESTNET_RPC || client.network.rpc),
        envLine("PRIVATE_TRADING_ALLOWED_ORIGIN", "http://127.0.0.1:8765"),
        envLine("PRIVATE_TRADING_HTTP_HOST", "127.0.0.1"),
        envLine("PRIVATE_TRADING_HTTP_PORT", "8787"),
        envLine("PRIVATE_TRADING_DEPLOY_KEY", deployer.key),
        envLine("PRIVATE_TRADING_ADMIN_KEY", adminWallet.privateKey),
        envLine("PRIVATE_TRADING_ISSUER_KEY", issuer.key),
        envLine("PRIVATE_TRADING_RELAYER_KEY", relayer.key),
        envLine("PRIVATE_CANARY_SESSION_KEY", session.key),
        envLine("PRIVATE_CANARY_RECOVERY_KEY", recovery.key),
        envLine("PRIVATE_CANARY_DIRECT_BUY_KEY", directBuy.key),
        envLine("PRIVATE_CANARY_DIRECT_SELL_KEY", directSell.key),
        envLine("PRIVATE_CANARY_SETTLER_KEY", settler.key),
        ...funders.map((item, index) =>
            envLine(`PRIVATE_TRADING_FUNDER_${index + 1}_KEY`, item.key)),
        envLine("PRIVATE_TRADING_DEPLOYER_ADDRESS", deployer.address),
        envLine("PRIVATE_TRADING_ADMIN_ADDRESS", adminWallet.address),
        envLine("PRIVATE_TRADING_ISSUER_ADDRESS", issuer.address),
        envLine("PRIVATE_TRADING_RELAYER_ADDRESS", relayer.address),
        envLine("PRIVATE_TRADING_CANARY_SESSION_SIGNER", session.address),
        envLine("PRIVATE_TRADING_CANARY_RECOVERY_SIGNER", recovery.address),
        envLine("VENUE_ENGINE", client.addresses.MatchingEngine),
        envLine("ATS_TOKEN", client.addresses.token),
        envLine("ZK_KYC_REGISTRY", client.addresses.ZkKycRegistry),
        envLine("KYC_VERIFIER", client.addresses.KycVerifier),
        envLine("PRIVATE_TRADING_PARTITION", client.immutables.partition),
        envLine("PRIVATE_TRADING_FEE_POLICY_DIGEST", feePolicyDigest),
        envLine("PRIVATE_TRADING_CANARY_ACCOUNT_SALT", accountSalt),
        envLine("PRIVATE_TRADING_GENERATION", "1"),
        envLine("PRIVATE_TRADING_QUICKNET_CHAIN_HASH", QUICKNET),
        envLine("PRIVATE_TRADING_ACTIVATION_EPOCH", "8"),
        envLine("PRIVATE_TRADING_MANUAL_ROOT", WIDE_MANUAL_ROOT),
        envLine("PRIVATE_TRADING_SESSION_ROOT", tree.root),
        envLine("PRIVATE_TRADING_MIN_TIER", "3"),
        envLine("PRIVATE_TRADING_JURISDICTION_MASK", "255"),
        envLine("PRIVATE_TRADING_HBAR_DENOMINATION_TINYBAR", "100000000"),
        envLine("PRIVATE_TRADING_LPRC_DENOMINATION", "1"),
        envLine("PRIVATE_TRADING_MINIMUM_WITHDRAWAL_DELAY", "100"),
        envLine("PRIVATE_TRADING_MAXIMUM_ROOT_AGE", "604800"),
        envLine("PRIVATE_TRADING_MINIMUM_REAL_NOTES", "8"),
        envLine("PRIVATE_TRADING_VIEW_KEY_EPOCH", "8"),
        envLine("PRIVATE_TRADING_VIEW_SECRET", view.secret),
        envLine("PRIVATE_TRADING_VIEW_KEY_X", view.x),
        envLine("PRIVATE_TRADING_VIEW_KEY_Y", view.y),
        envLine("PRIVATE_TRADING_LPRC_HOLD_DURATION", "86400"),
        envLine("PRIVATE_TRADING_TRADER_HOLDER_SECRET", traderSecret),
        envLine("PRIVATE_TRADING_CANARY_HOLDER_SECRET", canarySecret),
        envLine("PRIVATE_TRADING_POSEIDON2", existing.PRIVATE_TRADING_POSEIDON2 || ""),
        envLine("PRIVATE_TRADING_POSEIDON2_CODE_HASH", existing.PRIVATE_TRADING_POSEIDON2_CODE_HASH || ""),
        envLine("PRIVATE_HOLDER_CREDENTIALS_FILE", CREDS_FILE),
    ].join("");

    await writeFile(ENV_FILE, envText, {mode: 0o600});
    await chmod(ENV_FILE, 0o600);
    await chmod(SECRETS, 0o700);

    const credStore = Object.fromEntries(tree.credentials
        .filter((item) => item.wallet)
        .map((item) => [item.wallet, {credential: item}]));
    await writeFile(CREDS_FILE, JSON.stringify(credStore, null, 2) + "\n", {mode: 0o600});
    await chmod(CREDS_FILE, 0o600);

    const published = {
        origin: "http://127.0.0.1:8765",
        activationEpoch: 8,
        manualRoot: WIDE_MANUAL_ROOT,
        sessionRoot: tree.root,
        feePolicyDigest,
        accountSalt,
        viewKeyEpoch: 8,
        viewKeyX: view.x,
        viewKeyY: view.y,
        roles: {
            admin: adminWallet.address,
            deployer: deployer.address,
            issuer: issuer.address,
            relayer: relayer.address,
            sessionSigner: session.address,
            recoverySigner: recovery.address,
            directBuy: directBuy.address,
            directSell: directSell.address,
            settler: settler.address,
            funders: funders.map((item) => item.address),
        },
        holderWallets: tree.credentials.map((item) => item.wallet).filter(Boolean),
        credentialsFile: CREDS_FILE,
        envFile: ENV_FILE,
    };
    await writeFile(PUBLIC_FILE, JSON.stringify(published, null, 2) + "\n");
    process.stdout.write(`wrote ${PUBLIC_FILE}\n`);
    process.stdout.write(`admin ${published.roles.admin}\n`);
    process.stdout.write(`deployer ${published.roles.deployer}\n`);
    process.stdout.write(`issuer ${published.roles.issuer}\n`);
    process.stdout.write(`relayer ${published.roles.relayer}\n`);
    process.stdout.write(`session ${published.roles.sessionSigner}\n`);
    process.stdout.write(`recovery ${published.roles.recoverySigner}\n`);
    process.stdout.write(`sessionRoot ${published.sessionRoot}\n`);
}

main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
});
