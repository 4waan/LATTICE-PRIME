import {createHash, createHmac, randomBytes, timingSafeEqual} from "node:crypto";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {
    Contract,
    Interface,
    JsonRpcProvider,
    Transaction,
    getAddress,
    keccak256,
} from "ethers";

import {toWeibar} from "../../tools/units.mjs";
import {assertTransactionMatchesProjection} from "./transaction-projector.mjs";

const AGENT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_MANIFEST = path.join(AGENT_ROOT, "protocol/manifest.json");
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const HASH = /^(?:0x|sha256:)[0-9a-f]{64}$/;

export class HederaAdapterError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "HederaAdapterError";
        this.code = code;
    }
}

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function sha256(value, prefix = "sha256:") {
    return `${prefix}${createHash("sha256").update(value).digest("hex")}`;
}

function exactObject(value, keys, name) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new HederaAdapterError("REQUEST_INVALID", `${name} must be an object`);
    }
    const actual = Object.keys(value).sort().join(",");
    if (actual !== [...keys].sort().join(",")) {
        throw new HederaAdapterError("REQUEST_INVALID", `${name} has an unknown or missing field`);
    }
}

function decimal(value, name, {nonzero = false} = {}) {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new HederaAdapterError("DECIMAL_INVALID", `${name} must be a canonical decimal string`);
    }
    const parsed = BigInt(value);
    if (nonzero && parsed === 0n) {
        throw new HederaAdapterError("DECIMAL_INVALID", `${name} must be nonzero`);
    }
    return parsed;
}

function address(value, name) {
    try {
        return getAddress(value).toLowerCase();
    } catch {
        throw new HederaAdapterError("ADDRESS_INVALID", `${name} is not an EVM address`);
    }
}

function serialize(value) {
    if (typeof value === "bigint") return value.toString();
    if (Array.isArray(value)) return value.map(serialize);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialize(item)]));
    }
    return value;
}

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

function transactionStatus(receipt) {
    return receipt.status === 1 ? "confirmed" : "reverted";
}

function lifecycleOf({commitment, order, live, now, currentRound, opensAt, closesAt}) {
    if (commitment.committer === ZERO_ADDRESS) return "UNKNOWN";
    if (commitment.cancelled) return "CANCELLED";
    if (!commitment.revealed) {
        if (now < opensAt) return "SEALED";
        if (now <= closesAt) return "REVEALABLE";
        return "FORFEITABLE";
    }
    if (order.trader === ZERO_ADDRESS) return "FORFEITED";
    if (live) {
        return BigInt(currentRound) <= BigInt(order.lastRound) ? "IN_AUCTION" : "EXPIREABLE";
    }
    if (order.filled === order.qty && order.qty !== "0") return "FILLED";
    if (order.retired) return order.filled === "0" ? "RETIRED_NO_FILL" : "RETIRED_PARTIAL";
    return "REVEALED";
}

async function readJsonWithHash(file, expectedHash) {
    const bytes = await readFile(file);
    if (sha256(bytes) !== expectedHash) {
        throw new HederaAdapterError("ARTIFACT_HASH_MISMATCH", `${file} differs from its pinned hash`);
    }
    try {
        return {bytes, value: JSON.parse(bytes.toString("utf8"))};
    } catch {
        throw new HederaAdapterError("ARTIFACT_INVALID", `${file} is not valid JSON`);
    }
}

function requireManifest(value) {
    if (
        value?.schemaVersion !== "lattice.agent.protocol-binding.v1" ||
        value?.network?.chainId !== "296" ||
        value?.scope?.agentSide !== "BUY" ||
        !HASH.test(value?.deployment?.sha256 ?? "")
    ) {
        throw new HederaAdapterError("MANIFEST_INVALID", "protocol binding manifest is invalid");
    }
}

export class HederaProtocolAdapter {
    static async open({
        executionAccount,
        rpcUrl,
        manifestPath = DEFAULT_MANIFEST,
        confirmations = 1,
        transactionTimeoutMilliseconds = 120_000,
    }) {
        const manifestFile = path.resolve(manifestPath);
        const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
        requireManifest(manifest);
        if (rpcUrl !== manifest.network.rpc) {
            throw new HederaAdapterError("RPC_NOT_PINNED", "protocol adapter requires the pinned testnet RPC");
        }
        const base = path.dirname(manifestFile);
        const deploymentFile = path.resolve(base, manifest.deployment.file);
        const deploymentRecord = await readJsonWithHash(deploymentFile, manifest.deployment.sha256);
        const abis = {};
        for (const [name, record] of Object.entries(manifest.contracts)) {
            if (record.abi !== undefined) {
                const loaded = await readJsonWithHash(path.resolve(base, record.abi.file), record.abi.sha256);
                abis[name] = loaded.value;
            }
        }
        const provider = new JsonRpcProvider(
            rpcUrl,
            Number(manifest.network.chainId),
            {staticNetwork: true, batchMaxCount: 20}
        );
        const adapter = new HederaProtocolAdapter({
            executionAccount,
            manifest,
            manifestFile,
            deployment: deploymentRecord.value,
            deploymentBytes: deploymentRecord.bytes,
            abis,
            provider,
            confirmations,
            transactionTimeoutMilliseconds,
        });
        try {
            await adapter.verifyDeployment();
            return adapter;
        } catch (error) {
            provider.destroy();
            throw error;
        }
    }

    constructor({
        executionAccount,
        manifest,
        manifestFile,
        deployment,
        deploymentBytes,
        abis,
        provider,
        confirmations,
        transactionTimeoutMilliseconds,
    }) {
        this.executionAccount = address(executionAccount, "executionAccount");
        this.manifest = manifest;
        this.manifestFile = manifestFile;
        this.deployment = deployment;
        this.deploymentHash = sha256(deploymentBytes, "0x");
        this.provider = provider;
        this.confirmations = confirmations;
        this.transactionTimeoutMilliseconds = transactionTimeoutMilliseconds;
        this.engineAddress = address(manifest.contracts.MatchingEngine.address, "MatchingEngine");
        this.tokenAddress = address(manifest.contracts.token.address, "token");
        this.registryAddress = address(manifest.contracts.ZkKycRegistry.address, "ZkKycRegistry");
        this.journalAddress = address(manifest.contracts.SeamJournal.address, "SeamJournal");
        this.haltAddress = address(manifest.contracts.TradingHalt.address, "TradingHalt");
        this.parameterRootAddress = address(manifest.contracts.ParameterRoot.address, "ParameterRoot");
        this.engineInterface = new Interface(abis.MatchingEngine);
        this.engine = new Contract(this.engineAddress, abis.MatchingEngine, provider);
        this.token = new Contract(this.tokenAddress, abis.token, provider);
        this.registry = new Contract(this.registryAddress, abis.ZkKycRegistry, provider);
        this.journal = new Contract(this.journalAddress, abis.SeamJournal, provider);
        this.halt = new Contract(this.haltAddress, abis.TradingHalt, provider);
        this.parameterRoot = new Contract(this.parameterRootAddress, abis.ParameterRoot, provider);
        this.snapshotAuthenticationKey = randomBytes(32);
        this.lastDeploymentEvidence = null;
    }

    async verifyDeployment() {
        const network = await this.provider.getNetwork();
        if (network.chainId.toString() !== this.manifest.network.chainId) {
            throw new HederaAdapterError("CHAIN_MISMATCH", "RPC chain does not match the protocol binding");
        }
        const engineCode = await this.provider.getCode(this.engineAddress);
        const tokenCode = await this.provider.getCode(this.tokenAddress);
        if (engineCode === "0x" || tokenCode === "0x") {
            throw new HederaAdapterError("CODE_MISSING", "a pinned deployment address has no runtime code");
        }
        const engineHash = keccak256(engineCode).toLowerCase();
        const tokenHash = keccak256(tokenCode).toLowerCase();
        if (engineHash !== this.manifest.contracts.MatchingEngine.runtimeCodeKeccak256) {
            throw new HederaAdapterError("ENGINE_CODE_MISMATCH", "MatchingEngine runtime code is not pinned");
        }
        if (tokenHash !== this.manifest.contracts.token.runtimeCodeKeccak256) {
            throw new HederaAdapterError("TOKEN_CODE_MISMATCH", "ATS token runtime code is not pinned");
        }
        const selectorChecks = [];
        for (const signature of this.manifest.contracts.MatchingEngine.requiredFunctions) {
            let fragment;
            try {
                fragment = this.engineInterface.getFunction(signature);
            } catch {
                throw new HederaAdapterError("ABI_FUNCTION_MISSING", `MatchingEngine ABI lacks ${signature}`);
            }
            const selector = fragment.selector.toLowerCase();
            const present = engineCode.toLowerCase().includes(selector.slice(2));
            if (!present) {
                throw new HederaAdapterError("CODE_SELECTOR_MISSING", `MatchingEngine code lacks ${signature}`);
            }
            selectorChecks.push({signature, selector, present});
        }
        for (const signature of this.manifest.contracts.token.requiredFunctions) {
            try {
                this.token.interface.getFunction(signature);
            } catch {
                throw new HederaAdapterError("ABI_FUNCTION_MISSING", `token ABI lacks ${signature}`);
            }
        }

        const [
            security,
            compliance,
            policy,
            volumeCap,
            tradingHalt,
            tokenCompliance,
            registryInstalled,
            commitBond,
            cancelFee,
            revealDelay,
            revealWindow,
            roundLength,
            restRounds,
            partition,
        ] = await Promise.all([
            this.engine.security(),
            this.engine.compliance(),
            this.engine.policy(),
            this.engine.volumeCap(),
            this.engine.tradingHalt(),
            this.token.compliance(),
            this.token.isExternalKycList(this.registryAddress),
            this.engine.commitBond(),
            this.engine.cancelFee(),
            this.engine.revealDelay(),
            this.engine.revealWindow(),
            this.engine.roundLength(),
            this.engine.restRounds(),
            this.engine.partition(),
        ]);
        const expected = this.manifest.immutables;
        const wiring = {
            security: address(security, "engine.security") === this.tokenAddress,
            compliance: address(compliance, "engine.compliance") === this.journalAddress,
            policy: address(policy, "engine.policy") === this.parameterRootAddress,
            volumeCap:
                address(volumeCap, "engine.volumeCap") ===
                address(this.deployment.addresses.VolumeCap, "deployment.VolumeCap"),
            tradingHalt: address(tradingHalt, "engine.tradingHalt") === this.haltAddress,
            tokenCompliance: address(tokenCompliance, "token.compliance") === this.journalAddress,
            registryInstalled: registryInstalled === true,
        };
        const immutableChecks = {
            commitBondTinybar: commitBond.toString() === expected.commitBondTinybar,
            cancelFeeTinybar: cancelFee.toString() === expected.cancelFeeTinybar,
            revealDelaySeconds: revealDelay.toString() === expected.revealDelaySeconds,
            revealWindowSeconds: revealWindow.toString() === expected.revealWindowSeconds,
            roundLengthSeconds: roundLength.toString() === expected.roundLengthSeconds,
            restRounds: restRounds.toString() === expected.restRounds,
            partition: String(partition).toLowerCase() === expected.partition,
        };
        if (Object.values(wiring).some((value) => value !== true)) {
            throw new HederaAdapterError("WIRING_MISMATCH", "live contract wiring differs from the pinned deployment");
        }
        if (Object.values(immutableChecks).some((value) => value !== true)) {
            throw new HederaAdapterError("IMMUTABLE_MISMATCH", "live market immutables differ from the binding");
        }
        this.lastDeploymentEvidence = {
            schemaVersion: "lattice.agent.deployment-evidence.v1",
            checkedAt: new Date().toISOString(),
            chainId: network.chainId.toString(),
            deploymentHash: this.deploymentHash,
            engine: {
                address: this.engineAddress,
                runtimeCodeHash: engineHash,
                requiredSelectors: selectorChecks,
            },
            token: {
                address: this.tokenAddress,
                runtimeCodeHash: tokenHash,
                proxyInterfaceValidatedFromPinnedAbi: true,
            },
            wiring,
            immutables: immutableChecks,
        };
        return structuredClone(this.lastDeploymentEvidence);
    }

    async preflight(request) {
        exactObject(
            request,
            [
                "chainId",
                "deploymentHash",
                "engine",
                "executionAccount",
                "feeReserveTinybar",
                "price",
                "quantity",
                "stage",
                "token",
            ],
            "preflight request"
        );
        const price = decimal(request.price, "price", {nonzero: true});
        const quantity = decimal(request.quantity, "quantity", {nonzero: true});
        const feeReserve = decimal(request.feeReserveTinybar, "feeReserveTinybar");
        if (!["commit", "reveal"].includes(request.stage)) {
            throw new HederaAdapterError("REQUEST_INVALID", "preflight stage is invalid");
        }
        const identityMatches =
            decimal(request.chainId, "chainId").toString() === this.manifest.network.chainId &&
            address(request.engine, "engine") === this.engineAddress &&
            address(request.executionAccount, "executionAccount") === this.executionAccount &&
            address(request.token, "token") === this.tokenAddress &&
            String(request.deploymentHash).toLowerCase() === this.deploymentHash;
        const latestBlock = await this.provider.getBlock("latest");
        if (latestBlock === null) {
            throw new HederaAdapterError("BLOCK_UNAVAILABLE", "latest block is unavailable");
        }
        const atBlock = {blockTag: latestBlock.number};
        const [kycStatus, halted, balance, policyEpoch, kycEpoch] = await Promise.all([
            this.registry.getKycStatus(this.executionAccount, atBlock),
            this.halt.haltedNow(atBlock),
            this.provider.getBalance(this.executionAccount, latestBlock.number),
            this.parameterRoot.currentEpoch(atBlock),
            this.registry.currentEpoch(atBlock),
        ]);
        const requiredTinybar =
            (request.stage === "commit"
                ? BigInt(this.manifest.immutables.commitBondTinybar)
                : 0n) +
            price * quantity +
            feeReserve;
        const requiredWeibar = toWeibar(requiredTinybar);
        return {
            schemaVersion: "lattice.agent.adapter-preflight.v2",
            adapter: "hedera-testnet",
            stage: request.stage,
            chainId: this.manifest.network.chainId,
            checkedAtBlock: latestBlock.number,
            checkedAtTimestamp: latestBlock.timestamp.toString(),
            identityMatches,
            eligible: kycStatus === 1n,
            kycStatus: kycStatus.toString(),
            kycEpoch: kycEpoch.toString(),
            policyEpoch: policyEpoch.toString(),
            halted,
            feeBalanceSufficient: balance >= requiredWeibar,
            balanceWeibar: balance.toString(),
            requiredWeibar: requiredWeibar.toString(),
            liveChainChecked: true,
            deploymentEvidence: structuredClone(this.lastDeploymentEvidence),
        };
    }

    async snapshot({limitPrice, quantity}) {
        const limit = decimal(limitPrice, "limitPrice", {nonzero: true});
        decimal(quantity, "quantity", {nonzero: true});
        const block = await this.provider.getBlock("latest");
        if (block === null) throw new HederaAdapterError("BLOCK_UNAVAILABLE", "latest block is unavailable");
        const atBlock = {blockTag: block.number};
        const [round, genesis, roundLength, liveCount, lastPriceTwice] = await Promise.all([
            this.engine.currentRound(atBlock),
            this.engine.genesis(atBlock),
            this.engine.roundLength(atBlock),
            this.engine.revealedCount(atBlock),
            this.halt.lastPriceTwice(atBlock),
        ]);
        if (liveCount > 128n) {
            throw new HederaAdapterError("BOOK_TOO_LARGE", "live order count exceeds the adapter scan limit");
        }
        const ids = await Promise.all(
            Array.from(
                {length: Number(liveCount)},
                (_, index) => this.engine.liveAt(index, atBlock)
            )
        );
        const rawOrders = await Promise.all(ids.map((id) => this.engine.orders(id, atBlock)));
        const orders = rawOrders.map((order, index) => ({
            id: String(ids[index]).toLowerCase(),
            trader: address(order.trader, "order.trader"),
            side: Number(order.side) === 0 ? "BUY" : "SELL",
            price: order.price.toString(),
            quantity: order.qty.toString(),
            filled: order.filled.toString(),
            firstRound: order.firstRound.toString(),
            lastRound: order.lastRound.toString(),
        }));
        const quote = await this.engine.quote(round, atBlock);
        const priorPrice = lastPriceTwice === 0n ? 0n : lastPriceTwice / 2n;
        const room =
            priorPrice === 0n || limit <= priorPrice
                ? priorPrice === 0n ? 1000 : 0
                : Number(((limit - priorPrice) * 10_000n) / limit);
        const blockTimestamp = BigInt(block.timestamp);
        const elapsed = blockTimestamp <= genesis ? 0n : (blockTimestamp - genesis) % roundLength;
        const freshness = clamp(
            Math.max(0, Math.floor(Date.now() / 1000) - Number(block.timestamp)),
            0,
            300
        );
        const features = {
            limitRoomBps: clamp(room, 0, 2000),
            recentMoveOffsetBps: 1000,
            roundProgressBps: Number((elapsed * 10_000n) / roundLength),
            freshnessSeconds: freshness,
            bufferCategory: 1,
            horizonCategory: 1,
        };
        const body = {
            schemaVersion: "lattice.agent.market-snapshot.v2",
            adapter: "hedera-testnet",
            chainId: this.manifest.network.chainId,
            blockNumber: block.number,
            blockHash: block.hash,
            publicSlot: block.timestamp.toString(),
            currentRound: round.toString(),
            limitPrice: limit.toString(),
            quantity: String(quantity),
            quote: {
                willCross: quote.willCross,
                priceTwice: quote.priceTwice.toString(),
                volume: quote.volume.toString(),
            },
            priorClearingPriceTwice: lastPriceTwice.toString(),
            liveOrders: orders,
            features,
            featureSources: {
                limitRoomBps:
                    priorPrice === 0n
                        ? "neutral value because no prior clearing price is available"
                        : "bounded distance between the ticket limit and the last public clearing price",
                recentMoveOffsetBps:
                    "neutral offset because the deployed contract exposes one prior clearing price, not a two-price movement",
                roundProgressBps: "latest block timestamp against MatchingEngine genesis and roundLength",
                freshnessSeconds: "local observation time minus latest public block timestamp",
                privateCategories: "neutral constants required by excluded-private-context mode",
            },
        };
        const snapshot = {
            ...body,
            snapshotId: sha256(Buffer.from(canonical(body)), "0x"),
            authenticatedAgainstChain: true,
        };
        snapshot.authenticationTag =
            `hmac-sha256:${createHmac("sha256", this.snapshotAuthenticationKey)
                .update(canonical(snapshot))
                .digest("hex")}`;
        return snapshot;
    }

    async authenticateSnapshot(snapshot) {
        if (
            snapshot === null ||
            typeof snapshot !== "object" ||
            Array.isArray(snapshot) ||
            snapshot.authenticatedAgainstChain !== true ||
            typeof snapshot.snapshotId !== "string" ||
            !/^0x[0-9a-f]{64}$/.test(snapshot.snapshotId) ||
            typeof snapshot.authenticationTag !== "string" ||
            !/^hmac-sha256:[0-9a-f]{64}$/.test(snapshot.authenticationTag)
        ) {
            throw new HederaAdapterError("SNAPSHOT_INVALID", "market snapshot schema is invalid");
        }
        const {
            snapshotId,
            authenticatedAgainstChain,
            authenticationTag,
            ...body
        } = snapshot;
        const expectedTag =
            `hmac-sha256:${createHmac("sha256", this.snapshotAuthenticationKey)
                .update(canonical({snapshotId, authenticatedAgainstChain, ...body}))
                .digest("hex")}`;
        if (
            !timingSafeEqual(
                Buffer.from(authenticationTag, "utf8"),
                Buffer.from(expectedTag, "utf8")
            )
        ) {
            throw new HederaAdapterError(
                "SNAPSHOT_AUTHENTICATION_FAILED",
                "market snapshot was not issued by this adapter process"
            );
        }
        if (sha256(Buffer.from(canonical(body)), "0x") !== snapshotId) {
            throw new HederaAdapterError("SNAPSHOT_HASH_MISMATCH", "market snapshot content differs from its id");
        }
        const block = await this.provider.getBlock(snapshot.blockNumber);
        if (
            block === null ||
            block.hash !== snapshot.blockHash ||
            block.timestamp.toString() !== snapshot.publicSlot
        ) {
            throw new HederaAdapterError("SNAPSHOT_BLOCK_MISMATCH", "market snapshot block is not canonical");
        }
        return {
            authenticated: true,
            snapshotId,
            blockNumber: block.number,
            blockHash: block.hash,
            publicSlot: block.timestamp.toString(),
            limitPrice: snapshot.limitPrice,
            quantity: snapshot.quantity,
            features: structuredClone(snapshot.features),
        };
    }

    async nextNonce() {
        return this.provider.getTransactionCount(this.executionAccount, "pending");
    }

    async accountNonces() {
        const [latest, pending] = await Promise.all([
            this.provider.getTransactionCount(this.executionAccount, "latest"),
            this.provider.getTransactionCount(this.executionAccount, "pending"),
        ]);
        return {latest, pending};
    }

    async broadcast(record) {
        if (record === null || typeof record !== "object" || Array.isArray(record)) {
            throw new HederaAdapterError("SIGNED_RECORD_INVALID", "signed transaction record is invalid");
        }
        let transaction;
        try {
            transaction = Transaction.from(record.signedTransaction);
            assertTransactionMatchesProjection(transaction, record.projection);
        } catch {
            throw new HederaAdapterError("SIGNED_TRANSACTION_REFUSED", "signed bytes differ from their projection");
        }
        if (
            transaction.hash !== record.transactionHash ||
            address(transaction.from, "transaction.from") !== this.executionAccount ||
            address(transaction.to, "transaction.to") !== this.engineAddress ||
            transaction.chainId.toString() !== this.manifest.network.chainId
        ) {
            throw new HederaAdapterError("SIGNED_TRANSACTION_REFUSED", "signed transaction identity is not pinned");
        }
        let response;
        try {
            response = await this.provider.broadcastTransaction(record.signedTransaction);
        } catch (error) {
            const known = await this.reconcile(record.transactionHash);
            if (known.known) return known;
            const code = String(error?.code ?? "");
            if (["NETWORK_ERROR", "SERVER_ERROR", "TIMEOUT", "UNKNOWN_ERROR"].includes(code)) {
                throw new HederaAdapterError("BROADCAST_UNKNOWN", "transaction broadcast outcome is unknown");
            }
            throw new HederaAdapterError("BROADCAST_REFUSED", "RPC refused the signed transaction");
        }
        let receipt;
        try {
            receipt = await response.wait(this.confirmations, this.transactionTimeoutMilliseconds);
        } catch {
            const known = await this.reconcile(record.transactionHash);
            if (known.known) return known;
            throw new HederaAdapterError("BROADCAST_UNKNOWN", "transaction confirmation outcome is unknown");
        }
        if (receipt === null) {
            throw new HederaAdapterError("BROADCAST_UNKNOWN", "transaction confirmation outcome is unknown");
        }
        return {
            known: true,
            status: transactionStatus(receipt),
            transactionHash: receipt.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
            logs: serialize(receipt.logs),
        };
    }

    async reconcile(transactionHash) {
        if (typeof transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
            throw new HederaAdapterError("TRANSACTION_HASH_INVALID", "transaction hash is invalid");
        }
        const receipt = await this.provider.getTransactionReceipt(transactionHash);
        if (receipt === null) return {known: false, status: "unknown", transactionHash};
        return {
            known: true,
            status: transactionStatus(receipt),
            transactionHash: receipt.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
            logs: serialize(receipt.logs),
        };
    }

    async readRound(roundValue) {
        const round = decimal(roundValue, "round");
        const block = await this.provider.getBlock("latest");
        if (block === null) throw new HederaAdapterError("BLOCK_UNAVAILABLE", "latest block is unavailable");
        const atBlock = {blockTag: block.number};
        const [currentRound, end, crossed, quote] = await Promise.all([
            this.engine.currentRound(atBlock),
            this.engine.roundEnd(round, atBlock),
            this.engine.crossed(round, atBlock),
            this.engine.quote(round, atBlock),
        ]);
        return {
            schemaVersion: "lattice.agent.round-state.v1",
            observedAtBlock: block.number,
            observedAtTimestamp: block.timestamp.toString(),
            round: round.toString(),
            currentRound: currentRound.toString(),
            endsAt: end.toString(),
            crossed,
            quote: {
                willCross: quote.willCross,
                priceTwice: quote.priceTwice.toString(),
                volume: quote.volume.toString(),
            },
        };
    }

    async readAction({commitment: commitmentValue, account: accountValue}) {
        if (typeof commitmentValue !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(commitmentValue)) {
            throw new HederaAdapterError("COMMITMENT_INVALID", "commitment must be bytes32");
        }
        const commitmentId = commitmentValue.toLowerCase();
        const account = address(accountValue, "account");
        if (account !== this.executionAccount) {
            throw new HederaAdapterError("ACCOUNT_MISMATCH", "action account differs from the adapter account");
        }
        const block = await this.provider.getBlock("latest");
        if (block === null) throw new HederaAdapterError("BLOCK_UNAVAILABLE", "latest block is unavailable");
        const atBlock = {blockTag: block.number};
        const [commitment, order, backing, credit, currentRound, live] = await Promise.all([
            this.engine.commitments(commitmentId, atBlock),
            this.engine.orders(commitmentId, atBlock),
            this.engine.backingOf(commitmentId, atBlock),
            this.engine.credit(account, atBlock),
            this.engine.currentRound(atBlock),
            this.engine.isLive(commitmentId, atBlock),
        ]);
        const normalizedCommitment = {
            committer: address(commitment.committer, "commitment.committer"),
            committedAt: commitment.committedAt.toString(),
            revealed: commitment.revealed,
            cancelled: commitment.cancelled,
            bondTinybar: commitment.bond.toString(),
        };
        const normalizedOrder = {
            trader: address(order.trader, "order.trader"),
            side: Number(order.side) === 0 ? "BUY" : "SELL",
            price: order.price.toString(),
            qty: order.qty.toString(),
            filled: order.filled.toString(),
            revealedAt: order.revealedAt.toString(),
            firstRound: order.firstRound.toString(),
            lastRound: order.lastRound.toString(),
            retired: order.retired,
        };
        const opensAt = BigInt(normalizedCommitment.committedAt) +
            BigInt(this.manifest.immutables.revealDelaySeconds);
        const closesAt = opensAt + BigInt(this.manifest.immutables.revealWindowSeconds);
        let retireAfter = "0";
        if (normalizedOrder.trader !== ZERO_ADDRESS) {
            retireAfter = (
                await this.engine.roundEnd(normalizedOrder.lastRound, atBlock)
            ).toString();
        }
        return {
            schemaVersion: "lattice.agent.chain-action-state.v1",
            observedAtBlock: block.number,
            observedAtTimestamp: block.timestamp.toString(),
            commitment: commitmentId,
            commitmentState: normalizedCommitment,
            order: normalizedOrder,
            backing: {
                holdId: backing.holdId.toString(),
                snapshot: backing.snapshot.toString(),
                escrowTinybar: backing.escrow.toString(),
            },
            creditTinybar: credit.toString(),
            currentRound: currentRound.toString(),
            isLive: live,
            opensAt: opensAt.toString(),
            closesAt: closesAt.toString(),
            retireAfter,
            lifecycle: lifecycleOf({
                commitment: normalizedCommitment,
                order: normalizedOrder,
                live,
                now: BigInt(block.timestamp),
                currentRound: currentRound.toString(),
                opensAt,
                closesAt,
            }),
        };
    }

    close() {
        this.snapshotAuthenticationKey.fill(0);
        this.provider.destroy();
    }
}
