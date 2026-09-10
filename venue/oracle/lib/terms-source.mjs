import {Contract, JsonRpcProvider, keccak256, toUtf8Bytes} from "ethers";
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

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
} = {}) {
    const {client, scheduleAbi, oracleAbi} = readDeployment(root);
    const chainId = Number(client.network.chainId);
    const reader = provider ?? new JsonRpcProvider(
        rpcUrl ?? client.network.rpc,
        chainId,
        {staticNetwork: true, batchMaxCount: 20},
    );
    const schedule = new Contract(client.addresses.CouponSchedule, scheduleAbi, reader);
    const oracle = new Contract(client.addresses.PrimeOracle, oracleAbi, reader);
    const [issuedAt, dates, spreadBps, faceValue, basis, cash] = await Promise.all([
        schedule.issuedAt(),
        schedule.dates(),
        schedule.spreadBps(),
        schedule.faceValue(),
        schedule.basis(),
        oracle.cashLeg(),
    ]);
    if (Number(basis) !== 1) throw new Error(`unsupported coupon basis ${basis}`);
    if (!cash.ok || BigInt(cash.usdPerHbar) === 0n) {
        throw new Error("the seated HBAR/USD conversion is unavailable");
    }

    const terms = {
        chainId,
        oracle: client.addresses.PrimeOracle,
        instrument: client.addresses.token,
        schedule: client.addresses.CouponSchedule,
        issuedAt: Number(issuedAt),
        dates: [...dates].map(Number),
        spreadBps: BigInt(spreadBps),
        faceValue: BigInt(faceValue),
        cashDecimals: Number(client.coupon?.cashToken?.decimals ?? 2),
        usdPerHbar8: BigInt(cash.usdPerHbar),
        hbarRateUpdatedAt: Number(cash.updatedAt),
        mirrorUrl: client.network.mirror,
        rpcUrl: rpcUrl ?? client.network.rpc,
        engine: client.addresses.MatchingEngine,
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
