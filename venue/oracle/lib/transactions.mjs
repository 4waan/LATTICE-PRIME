import {keccak256} from "ethers";

export class PublisherTransactionError extends Error {
    constructor(code, message, fields = {}) {
        super(message);
        this.name = "PublisherTransactionError";
        this.code = code;
        Object.assign(this, fields);
    }
}

export function receiptSummary(receipt) {
    const gasPrice = receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n;
    return {
        hash: receipt.hash,
        status: Number(receipt.status),
        blockNumber: Number(receipt.blockNumber),
        gasUsed: BigInt(receipt.gasUsed).toString(),
        gasPrice: BigInt(gasPrice).toString(),
    };
}

export async function preflight(provider, from, request) {
    try {
        return await provider.call({
            from,
            to: request.to,
            data: request.data,
            value: request.value ?? 0n,
        });
    } catch (error) {
        throw new PublisherTransactionError(
            "PREFLIGHT_REVERT",
            `transaction preflight reverted: ${error.shortMessage ?? error.message}`,
            {cause: error},
        );
    }
}

export async function prepareTransaction({
    wallet,
    provider,
    chainId,
    to,
    data,
    purpose,
    gasLimit,
    value = 0n,
    feeMultiplier = 2n,
}) {
    const [nonce, fee] = await Promise.all([
        provider.getTransactionCount(wallet.address, "pending"),
        provider.getFeeData(),
    ]);
    const quoted = fee.gasPrice ?? fee.maxFeePerGas;
    if (!quoted) {
        throw new PublisherTransactionError("NO_FEE_DATA", "relay returned no gas price");
    }
    const request = {
        type: 2,
        chainId,
        to,
        data,
        value: BigInt(value),
        nonce,
        gasLimit: BigInt(gasLimit),
        maxFeePerGas: BigInt(quoted) * BigInt(feeMultiplier),
        maxPriorityFeePerGas: 0n,
    };
    const signedTransaction = await wallet.signTransaction(request);
    return {
        purpose,
        nonce,
        to,
        gasLimit: request.gasLimit.toString(),
        value: request.value.toString(),
        txHash: keccak256(signedTransaction),
        signedTransaction,
    };
}

export async function waitForReceipt(provider, txHash, {
    timeoutMs = 120_000,
    recoveryAttempts = 12,
    recoveryIntervalMs = 5_000,
} = {}) {
    let receipt = null;
    try {
        receipt = await provider.waitForTransaction(txHash, 1, timeoutMs);
    } catch {
        receipt = null;
    }
    for (let attempt = 0; receipt === null && attempt < recoveryAttempts; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, recoveryIntervalMs));
        receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
    }
    if (receipt === null) {
        throw new PublisherTransactionError(
            "UNKNOWN_RECEIPT",
            `no receipt found for ${txHash}`,
            {txHash},
        );
    }
    const summary = receiptSummary(receipt);
    if (summary.status !== 1) {
        throw new PublisherTransactionError(
            "REVERTED",
            `transaction ${txHash} reverted`,
            {txHash, receipt: summary},
        );
    }
    return summary;
}

export async function broadcastPrepared(provider, prepared, waitOptions = {}) {
    try {
        await provider.broadcastTransaction(prepared.signedTransaction);
    } catch {
        const known = await provider.getTransaction(prepared.txHash).catch(() => null);
        if (!known) {
            throw new PublisherTransactionError(
                "BROADCAST_FAILED",
                `relay did not accept ${prepared.txHash}`,
                {txHash: prepared.txHash},
            );
        }
    }
    return waitForReceipt(provider, prepared.txHash, waitOptions);
}

export async function recoverPrepared(provider, prepared, waitOptions = {}) {
    const receipt = await provider.getTransactionReceipt(prepared.txHash).catch(() => null);
    if (receipt) {
        const summary = receiptSummary(receipt);
        if (summary.status !== 1) {
            throw new PublisherTransactionError(
                "REVERTED",
                `transaction ${prepared.txHash} reverted`,
                {txHash: prepared.txHash, receipt: summary},
            );
        }
        return summary;
    }
    return broadcastPrepared(provider, prepared, waitOptions);
}
