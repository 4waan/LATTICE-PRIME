import {access, chmod, mkdir, readFile, writeFile} from "node:fs/promises";
import {constants as fsConstants, existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {Wallet, keccak256, toUtf8Bytes} from "ethers";
import {buildBabyjub} from "../../toolchain/node_modules/circomlibjs/main.js";

import {
    buildPrivateCredentialTree,
    normalizePrivateCredentialStore,
    readPrivateCredentialStore,
    writePrivateCredentialStore,
} from "../agent/runtime/private-credential-store.mjs";
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
// Unbound leaves issued alongside the trader and canary. The worker binds one
// to each granted wallet at claim time (agent/runtime/private-credential-controller.mjs).
export const DEFAULT_CREDENTIAL_POOL = 16;
export const POOL_CREDENTIAL_ID_BASE = 100;
const CREDENTIALS_PATH = "/api/private/credentials";
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

// Upsert, not rewrite. The worker lines that out/private-trading/seed-hbar-notes.mjs
// adds after deployment must survive a second bootstrap run.
export function mergeEnvText(text, updates) {
    const seen = new Set();
    const lines = [];
    for (const line of String(text || "").split("\n")) {
        if (!line || line.startsWith("#") || !line.includes("=")) {
            lines.push(line);
            continue;
        }
        const eq = line.indexOf("=");
        const key = line.slice(0, eq);
        if (Object.hasOwn(updates, key)) {
            lines.push(`${key}=${updates[key]}`);
            seen.add(key);
        } else {
            lines.push(line);
        }
    }
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    for (const [key, value] of Object.entries(updates)) {
        if (!seen.has(key)) lines.push(`${key}=${value}`);
    }
    return lines.join("\n") + "\n";
}

export function credentialPoolSize(value, fallback = DEFAULT_CREDENTIAL_POOL) {
    if (value === undefined || value === "") return fallback;
    if (!/^(0|[1-9][0-9]*)$/.test(String(value)) || Number(value) > 4096) {
        throw new Error("PRIVATE_TRADING_CREDENTIAL_POOL must be a whole number up to 4096");
    }
    return Number(value);
}

// Pool secrets keep their identity across runs: leaf 100+i reuses the secret
// already issued under that id in any tree, so re-running the bootstrap with
// the same inputs reproduces the same root instead of minting a fresh tree.
export function poolHolderSecrets(store, count, random = () => randomPrivateField().toString()) {
    const known = new Map();
    for (const tree of Object.values(store?.trees ?? {})) {
        for (const entry of [...Object.values(tree.bound), ...tree.pool]) {
            known.set(entry.credential.credentialId, entry.credential.holderSecret);
        }
    }
    return Array.from({length: count}, (_, index) => {
        const credentialId = String(POOL_CREDENTIAL_ID_BASE + index);
        return {
            credentialId,
            holderSecret: known.get(credentialId) ?? random(),
        };
    });
}

// Issues the tree and adds it to the store unless that root is already there,
// in which case existing bindings stay exactly as they were.
export function planCredentialStore({store, trader, canary, pool}) {
    const existing = normalizePrivateCredentialStore(store ?? {v: 2, trees: {}});
    const tree = issuePrivateSessionCredentials([
        {
            wallet: trader.wallet,
            holderSecret: trader.holderSecret,
            credentialId: 73,
            jurisdiction: 3,
            tier: 4,
            validUntilEpoch: 50,
        },
        {
            wallet: canary.wallet,
            holderSecret: canary.holderSecret,
            credentialId: 74,
            jurisdiction: 3,
            tier: 4,
            validUntilEpoch: 50,
        },
        ...pool.map((holder) => ({
            holderSecret: holder.holderSecret,
            credentialId: holder.credentialId,
            jurisdiction: 3,
            tier: 4,
            validUntilEpoch: 50,
        })),
    ], 16);
    if (existing.trees[tree.root]) {
        return {store: existing, tree, added: false};
    }
    return {
        store: normalizePrivateCredentialStore({
            v: 2,
            trees: {...existing.trees, [tree.root]: buildPrivateCredentialTree(tree)},
        }),
        tree,
        added: true,
    };
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
    const poolSize = credentialPoolSize(
        process.env.PRIVATE_TRADING_CREDENTIAL_POOL ?? existing.PRIVATE_TRADING_CREDENTIAL_POOL,
    );
    const priorStore = existsSync(CREDS_FILE)
        ? await readPrivateCredentialStore(CREDS_FILE)
        : null;
    const planned = planCredentialStore({
        store: priorStore,
        trader: {wallet: TRADER, holderSecret: traderSecret},
        canary: {wallet: session.address, holderSecret: canarySecret},
        pool: poolHolderSecrets(priorStore, poolSize),
    });
    const tree = planned.tree;
    const feePolicyDigest = existing.PRIVATE_TRADING_FEE_POLICY_DIGEST
        || keccak256(toUtf8Bytes("lattice.private-trading.fee-policy.v1"));
    const accountSalt = existing.PRIVATE_TRADING_CANARY_ACCOUNT_SALT
        || keccak256(toUtf8Bytes(`lattice.private-trading.canary-salt.${Date.now()}`));
    const activationEpoch = existing.PRIVATE_TRADING_ACTIVATION_EPOCH || "8";
    const viewKeyEpoch = existing.PRIVATE_TRADING_VIEW_KEY_EPOCH || activationEpoch;

    // The activation-epoch root is pinned once the gate has it (the canary
    // asserts sessionRootForEpoch(activation) against it). A tree issued later
    // is the next rotation epoch's root and is published there by the operator.
    const liveRoot = existing.PRIVATE_TRADING_SESSION_ROOT || tree.root;
    const rootUpdates = liveRoot === tree.root
        ? {PRIVATE_TRADING_SESSION_ROOT: tree.root}
        : {
            PRIVATE_TRADING_SESSION_ROOT: liveRoot,
            PRIVATE_TRADING_SESSION_ROOT_NEXT: tree.root,
            PRIVATE_TRADING_NEXT_ROTATION_EPOCH: String(Number(activationEpoch) + 1),
        };

    const envUpdates = {
        HEDERA_TESTNET_RPC: repoEnv.HEDERA_TESTNET_RPC || client.network.rpc,
        PRIVATE_TRADING_ALLOWED_ORIGIN: "http://127.0.0.1:8765",
        PRIVATE_TRADING_HTTP_HOST: "127.0.0.1",
        PRIVATE_TRADING_HTTP_PORT: "8787",
        PRIVATE_TRADING_DEPLOY_KEY: deployer.key,
        PRIVATE_TRADING_ADMIN_KEY: adminWallet.privateKey,
        PRIVATE_TRADING_ISSUER_KEY: issuer.key,
        PRIVATE_TRADING_RELAYER_KEY: relayer.key,
        PRIVATE_CANARY_SESSION_KEY: session.key,
        PRIVATE_CANARY_RECOVERY_KEY: recovery.key,
        PRIVATE_CANARY_DIRECT_BUY_KEY: directBuy.key,
        PRIVATE_CANARY_DIRECT_SELL_KEY: directSell.key,
        PRIVATE_CANARY_SETTLER_KEY: settler.key,
        ...Object.fromEntries(funders.map((item, index) =>
            [`PRIVATE_TRADING_FUNDER_${index + 1}_KEY`, item.key])),
        PRIVATE_TRADING_DEPLOYER_ADDRESS: deployer.address,
        PRIVATE_TRADING_ADMIN_ADDRESS: adminWallet.address,
        PRIVATE_TRADING_ISSUER_ADDRESS: issuer.address,
        PRIVATE_TRADING_RELAYER_ADDRESS: relayer.address,
        PRIVATE_TRADING_CANARY_SESSION_SIGNER: session.address,
        PRIVATE_TRADING_CANARY_RECOVERY_SIGNER: recovery.address,
        VENUE_ENGINE: client.addresses.MatchingEngine,
        ATS_TOKEN: client.addresses.token,
        ZK_KYC_REGISTRY: client.addresses.ZkKycRegistry,
        KYC_VERIFIER: client.addresses.KycVerifier,
        PRIVATE_TRADING_PARTITION: client.immutables.partition,
        PRIVATE_TRADING_FEE_POLICY_DIGEST: feePolicyDigest,
        PRIVATE_TRADING_CANARY_ACCOUNT_SALT: accountSalt,
        PRIVATE_TRADING_GENERATION: existing.PRIVATE_TRADING_GENERATION || "1",
        PRIVATE_TRADING_QUICKNET_CHAIN_HASH: QUICKNET,
        PRIVATE_TRADING_ACTIVATION_EPOCH: activationEpoch,
        PRIVATE_TRADING_MANUAL_ROOT: existing.PRIVATE_TRADING_MANUAL_ROOT || WIDE_MANUAL_ROOT,
        ...rootUpdates,
        PRIVATE_TRADING_MIN_TIER: existing.PRIVATE_TRADING_MIN_TIER || "3",
        PRIVATE_TRADING_JURISDICTION_MASK: existing.PRIVATE_TRADING_JURISDICTION_MASK || "255",
        PRIVATE_TRADING_HBAR_DENOMINATION_TINYBAR:
            existing.PRIVATE_TRADING_HBAR_DENOMINATION_TINYBAR || "100000000",
        PRIVATE_TRADING_LPRC_DENOMINATION: existing.PRIVATE_TRADING_LPRC_DENOMINATION || "1",
        PRIVATE_TRADING_MINIMUM_WITHDRAWAL_DELAY:
            existing.PRIVATE_TRADING_MINIMUM_WITHDRAWAL_DELAY || "100",
        PRIVATE_TRADING_MAXIMUM_ROOT_AGE: existing.PRIVATE_TRADING_MAXIMUM_ROOT_AGE || "604800",
        PRIVATE_TRADING_MINIMUM_REAL_NOTES: existing.PRIVATE_TRADING_MINIMUM_REAL_NOTES || "8",
        PRIVATE_TRADING_VIEW_KEY_EPOCH: viewKeyEpoch,
        PRIVATE_TRADING_VIEW_SECRET: view.secret,
        PRIVATE_TRADING_VIEW_KEY_X: view.x,
        PRIVATE_TRADING_VIEW_KEY_Y: view.y,
        PRIVATE_TRADING_LPRC_HOLD_DURATION: existing.PRIVATE_TRADING_LPRC_HOLD_DURATION || "86400",
        PRIVATE_TRADING_TRADER_HOLDER_SECRET: traderSecret,
        PRIVATE_TRADING_CANARY_HOLDER_SECRET: canarySecret,
        PRIVATE_TRADING_POSEIDON2: existing.PRIVATE_TRADING_POSEIDON2 || "",
        PRIVATE_TRADING_POSEIDON2_CODE_HASH: existing.PRIVATE_TRADING_POSEIDON2_CODE_HASH || "",
        PRIVATE_HOLDER_CREDENTIALS_FILE: CREDS_FILE,
        PRIVATE_TRADING_CREDENTIALS_PATH: CREDENTIALS_PATH,
        PRIVATE_TRADING_CREDENTIAL_POOL: String(poolSize),
    };
    let priorEnvText = "";
    try {
        priorEnvText = await readFile(ENV_FILE, "utf8");
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    await writeFile(ENV_FILE, mergeEnvText(priorEnvText, envUpdates), {mode: 0o600});
    await chmod(ENV_FILE, 0o600);
    await chmod(SECRETS, 0o700);

    await writePrivateCredentialStore(CREDS_FILE, planned.store);

    const published = {
        origin: "http://127.0.0.1:8765",
        activationEpoch: Number(activationEpoch),
        manualRoot: envUpdates.PRIVATE_TRADING_MANUAL_ROOT,
        sessionRoot: envUpdates.PRIVATE_TRADING_SESSION_ROOT,
        sessionRootNext: envUpdates.PRIVATE_TRADING_SESSION_ROOT_NEXT ?? null,
        nextRotationEpoch: envUpdates.PRIVATE_TRADING_NEXT_ROTATION_EPOCH
            ? Number(envUpdates.PRIVATE_TRADING_NEXT_ROTATION_EPOCH)
            : null,
        sessionRoots: Object.keys(planned.store.trees),
        credentialPool: poolSize,
        feePolicyDigest,
        accountSalt,
        viewKeyEpoch: Number(viewKeyEpoch),
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
    if (published.sessionRootNext) {
        process.stdout.write(
            `sessionRootNext ${published.sessionRootNext} (rotation epoch ${published.nextRotationEpoch}, `
            + `${planned.added ? "new tree" : "already in store"})\n`,
        );
    }
    process.stdout.write(`credentialPool ${published.credentialPool}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
