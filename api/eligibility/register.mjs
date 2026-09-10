import {
    Contract,
    JsonRpcProvider,
    Network,
    Wallet,
    getAddress,
} from "ethers";
import {createEligibilityRelay} from "../_lib/eligibility-relay.mjs";

const GATE_ABI = [
    "function wouldAccept(address account,uint256[7] pub) view returns (bool ok,string reason)",
    "function register(address account,uint256[24] proof,uint256[7] pub)",
];
const REGISTRY_ABI = [
    "function getKycStatus(address account) view returns (uint8)",
];

let relay;

function required(name) {
    const value = String(process.env[name] || "").trim();
    if (!value) throw new Error(`${name} is required.`);
    return value;
}

function positiveInteger(name, fallback) {
    const raw = String(process.env[name] || fallback);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive.`);
    return value;
}

function buildRelay() {
    const chainId = positiveInteger("REGISTRATION_RELAY_CHAIN_ID", 296);
    const gateAddress = getAddress(required("REGISTRATION_GATE"));
    const registryAddress = getAddress(required("ZK_KYC_REGISTRY"));
    const rpc = required("HEDERA_TESTNET_RPC");
    const secret = required("REGISTRATION_RELAY_PRIVATE_KEY");
    const privateKey = secret.startsWith("0x") ? secret : `0x${secret}`;
    const origins = required("REGISTRATION_RELAY_ORIGINS")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    const gasLimit = BigInt(positiveInteger("REGISTRATION_RELAY_GAS_LIMIT", 1_500_000));
    const maximumGasPrice = BigInt(
        required("REGISTRATION_RELAY_MAX_GAS_PRICE_WEI"),
    );

    const network = new Network("hedera-sponsored-registration", chainId);
    const provider = new JsonRpcProvider(rpc, network, {staticNetwork: network});
    const wallet = new Wallet(privateKey, provider);
    const gate = new Contract(gateAddress, GATE_ABI, wallet);
    const registry = new Contract(registryAddress, REGISTRY_ABI, provider);

    const chain = {
        async status(account) {
            return registry.getKycStatus(account);
        },
        async wouldAccept(account, pub) {
            const result = await gate.wouldAccept(account, pub);
            return [Boolean(result.ok), String(result.reason || "")];
        },
        async simulate(account, proof, pub) {
            await gate.register.staticCall(account, proof, pub, {gasLimit});
        },
        async submit(account, proof, pub) {
            const fees = await provider.getFeeData();
            const gasPrice = fees.gasPrice;
            if (gasPrice === null || gasPrice <= 0n || gasPrice > maximumGasPrice) {
                throw new Error("Network gas price exceeds the sponsor ceiling.");
            }
            const tx = await gate.register(account, proof, pub, {gasLimit, gasPrice});
            return {txHash: tx.hash};
        },
    };

    return createEligibilityRelay({
        config: {
            chainId,
            gate: gateAddress.toLowerCase(),
            registry: registryAddress.toLowerCase(),
            allowedOrigins: origins,
            maximumBodyBytes: positiveInteger("REGISTRATION_RELAY_MAX_BODY_BYTES", 24 * 1024),
            accountRequestsPerWindow: positiveInteger(
                "REGISTRATION_RELAY_ACCOUNT_REQUESTS_PER_MINUTE",
                3,
            ),
            ipRequestsPerWindow: positiveInteger(
                "REGISTRATION_RELAY_IP_REQUESTS_PER_MINUTE",
                12,
            ),
            sponsoredSubmissionsPerWindow: positiveInteger(
                "REGISTRATION_RELAY_SUBMISSIONS_PER_HOUR",
                30,
            ),
        },
        chain,
    });
}

export default async function handler(request, response) {
    try {
        relay ||= buildRelay();
        await relay(request, response);
    } catch {
        response.statusCode = 503;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("cache-control", "no-store, max-age=0");
        response.setHeader("x-content-type-options", "nosniff");
        response.end(JSON.stringify({
            error: "Sponsored eligibility is not configured or is temporarily unavailable.",
        }));
    }
}
