import {Contract, JsonRpcProvider, ZeroAddress, getAddress, isAddress, keccak256, toUtf8Bytes} from "ethers";
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

function requiredAddress(value, label) {
    if (!isAddress(value) || getAddress(value) === ZeroAddress) {
        throw new Error(`deployment is missing ${label}`);
    }
    return getAddress(value);
}

function requiredUint(value, label) {
    try {
        return BigInt(value);
    } catch {
        throw new Error(`${label} is malformed`);
    }
}

const ORACLE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const VENUE_ROOT = join(ORACLE_ROOT, "..");

export function readDeployment(root = VENUE_ROOT) {
    const client = JSON.parse(readFileSync(join(root, "deployments/client.json"), "utf8"));
    const scheduleAbi = JSON.parse(
        readFileSync(join(root, "deployments/abi/CouponSchedule.json"), "utf8"),
    );
    const oracleAbi = JSON.parse(
        readFileSync(join(root, "deployments/abi/PrimeOracle.json"), "utf8"),
    );
    return {client, scheduleAbi, oracleAbi};
}

export async function readInstrumentTerms({
    root = VENUE_ROOT,
    provider = null,
    rpcUrl = null,
    client: clientOverride = null,
    scheduleContract = null,
    oracleContract = null,
} = {}) {
    const {client: deployed, scheduleAbi, oracleAbi} = readDeployment(root);
    const client = clientOverride ?? deployed;
    const chainId = Number(client.network.chainId);
    const oracleAddress = requiredAddress(client.addresses.PrimeOracle, "PrimeOracle");
    const instrument = requiredAddress(client.addresses.token, "token");
    const scheduleAddress = requiredAddress(client.addresses.CouponSchedule, "CouponSchedule");
    const engine = requiredAddress(client.addresses.MatchingEngine, "MatchingEngine");
    const reader = provider ?? new JsonRpcProvider(
        rpcUrl ?? client.network.rpc,
        chainId,
        {staticNetwork: true, batchMaxCount: 20},
    );
    const schedule = scheduleContract ?? new Contract(scheduleAddress, scheduleAbi, reader);
    const oracle = oracleContract ?? new Contract(oracleAddress, oracleAbi, reader);
    const [issuedAt, dates, spreadBps, faceValue, basis, cash] = await Promise.all([
        schedule.issuedAt(),
        schedule.dates(),
        schedule.spreadBps(),
        schedule.faceValue(),
        schedule.basis(),
        oracle.cashLeg(),
    ]);
    if (Number(basis) !== 1) throw new Error(`unsupported coupon basis ${basis}`);
    const usdPerHbar8 = requiredUint(cash?.usdPerHbar, "usdPerHbar");
    if (!cash?.ok || usdPerHbar8 === 0n) {
        throw new Error("the seated HBAR/USD conversion is unavailable");
    }

    const terms = {
        chainId,
        oracle: oracleAddress,
        instrument,
        schedule: scheduleAddress,
        issuedAt: Number(requiredUint(issuedAt, "issuedAt")),
        dates: [...dates].map((value) => Number(requiredUint(value, "coupon date"))),
        spreadBps: requiredUint(spreadBps, "spreadBps"),
        faceValue: requiredUint(faceValue, "faceValue"),
        cashDecimals: Number(client.coupon?.cashToken?.decimals ?? 2),
        usdPerHbar8,
        hbarRateUpdatedAt: Number(cash.updatedAt),
        mirrorUrl: client.network.mirror,
        rpcUrl: rpcUrl ?? client.network.rpc,
        engine,
    };
    const canonical = JSON.stringify({
        chainId: terms.chainId,
        instrument: terms.instrument.toLowerCase(),
        schedule: terms.schedule.toLowerCase(),
        issuedAt: terms.issuedAt,
        dates: terms.dates,
        spreadBps: terms.spreadBps.toString(),
        faceValue: terms.faceValue.toString(),
        cashDecimals: terms.cashDecimals,
    });
    terms.sourceDigest = keccak256(toUtf8Bytes(canonical));
    return terms;
}
