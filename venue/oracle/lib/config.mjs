import {existsSync, readFileSync} from "node:fs";
import {resolve} from "node:path";
import {Wallet} from "ethers";

export class OracleConfigError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "OracleConfigError";
        this.code = code;
    }
}

const ALLOWED_PUBLISHER_SECRET = "ORACLE_PUBLISHER_PRIVATE_KEY";
const SECRET_ENV_NAME =
    /(?:^|_)(?:KEY|PRIVATEKEY|SECRETKEY|MNEMONIC|SECRET|SEED|SEED_PHRASE)(?:_|$)/i;

function inheritedSecretNames(env) {
    return Object.keys(env)
        .filter((name) =>
            name !== ALLOWED_PUBLISHER_SECRET
            && env[name] !== undefined
            && env[name] !== ""
            && SECRET_ENV_NAME.test(name),
        )
        .sort();
}

function rejectEmbeddedSecrets(value, path = "config") {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
        const here = `${path}.${key}`;
        if (/(private.?key|mnemonic|secret)/i.test(key)) {
            throw new OracleConfigError("SECRET_IN_CONFIG", `${here} must be supplied by environment`);
        }
        rejectEmbeddedSecrets(child, here);
    }
}

export function loadOracleConfig(path = process.env.ORACLE_CONFIG ?? "oracle/config.json", {
    allowExample = false,
} = {}) {
    let resolved = resolve(path);
    if (!existsSync(resolved) && allowExample) {
        resolved = resolve("oracle/config.example.json");
    }
    if (!existsSync(resolved)) {
        throw new OracleConfigError("NO_CONFIG", `oracle config does not exist at ${resolved}`);
    }
    let config;
    try {
        config = JSON.parse(readFileSync(resolved, "utf8"));
    } catch (error) {
        throw new OracleConfigError("BAD_CONFIG", `cannot parse ${resolved}: ${error.message}`);
    }
    rejectEmbeddedSecrets(config);
    config.path = resolved;
    config.rpcUrl = process.env.HEDERA_TESTNET_RPC || process.env.HEDERA_RPC_URL || config.rpcUrl;
    config.mirrorUrl = process.env.HEDERA_MIRROR_URL || config.mirrorUrl;
    config.sourceProfile = process.env.ORACLE_SOURCE_PROFILE ||
        config.sourceProfile ||
        "default";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(config.sourceProfile)) {
        throw new OracleConfigError(
            "BAD_SOURCE_PROFILE",
            "sourceProfile must be a safe nonempty identifier",
        );
    }
    config.dealers = config.dealers ?? {};
    if (process.env.ORACLE_DEALER_ENDPOINT) {
        config.dealers.endpoints = [process.env.ORACLE_DEALER_ENDPOINT];
    }
    if (process.env.ORACLE_DEALER_ADDRESSES) {
        config.dealers.allowedAddresses = process.env.ORACLE_DEALER_ADDRESSES
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
    }
    const production = process.env.NODE_ENV === "production" || config.dealers.production === true;
    if (production) {
        for (const endpoint of config.dealers.endpoints ?? []) {
            if (!String(endpoint).startsWith("https://")) {
                throw new OracleConfigError(
                    "INSECURE_DEALER_ENDPOINT",
                    "production dealer endpoints must use HTTPS",
                );
            }
        }
    }
    return config;
}

export function loadPublisherIdentity(config, env = process.env, {requireTopic = true} = {}) {
    const forbidden = inheritedSecretNames(env);
    if (forbidden.length > 0) {
        throw new OracleConfigError(
            "MULTI_KEY_ENV",
            `publisher process refuses inherited secret variables: ${forbidden.join(", ")}`,
        );
    }
    const privateKey = env.ORACLE_PUBLISHER_PRIVATE_KEY;
    if (!privateKey) {
        throw new OracleConfigError(
            "NO_PRIVATE_KEY",
            "set ORACLE_PUBLISHER_PRIVATE_KEY for this publisher process",
        );
    }
    let wallet;
    try {
        wallet = new Wallet(privateKey);
    } catch {
        throw new OracleConfigError("BAD_PRIVATE_KEY", "publisher key is invalid");
    }
    const expected = env.ORACLE_PUBLISHER_ADDRESS;
    if (expected && expected.toLowerCase() !== wallet.address.toLowerCase()) {
        throw new OracleConfigError(
            "ADDRESS_MISMATCH",
            `publisher key resolves to ${wallet.address}, expected ${expected}`,
        );
    }
    const profile = env.ORACLE_PUBLISHER_ID;
    if (!profile || !/^[a-zA-Z0-9_.-]{1,64}$/.test(profile)) {
        throw new OracleConfigError("BAD_PROFILE", "set a safe ORACLE_PUBLISHER_ID");
    }
    const accountId = env.ORACLE_PUBLISHER_ACCOUNT_ID;
    if (!accountId) {
        throw new OracleConfigError(
            "NO_ACCOUNT_ID",
            "set ORACLE_PUBLISHER_ACCOUNT_ID for HCS transaction fees",
        );
    }
    const topicId = env.ORACLE_EVIDENCE_TOPIC_ID ?? config.evidence?.topicId;
    if (requireTopic && !topicId) {
        throw new OracleConfigError(
            "NO_TOPIC",
            "set ORACLE_EVIDENCE_TOPIC_ID or create the publisher evidence topic",
        );
    }
    return {
        profile,
        accountId,
        topicId,
        wallet,
        address: wallet.address,
        stateRoot: resolve(env.ORACLE_STATE_ROOT ?? `oracle/state/${profile}`),
    };
}
