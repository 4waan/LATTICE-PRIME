import {webcrypto} from "node:crypto";
import path from "node:path";
import {pathToFileURL} from "node:url";

import {JsonRpcProvider} from "ethers";

import {
    QUICKNET_CHAIN_HASH,
    TIMED_TICKET_CHAIN_ID,
} from "../../tools/timed-ticket.mjs";
import {PinnedQuicknetClient, QuicknetLockedKeyProvider} from "./drand-client.mjs";
import {PrivateRoutingController} from "./private-routing-controller.mjs";
import {
    EthersPrivateSessionRegistrationAdapter,
    PRIVATE_SESSION_REGISTRATION_DEFAULT_GAS_LIMITS,
} from "./private-session-registration-chain.mjs";
import {
    PrivateSessionRegistrationController,
} from "./private-session-registration-controller.mjs";
import {
    EthersPrivateSessionRecoveryAdapter,
    PRIVATE_SESSION_RECOVERY_GAS_LIMIT,
} from "./private-session-recovery-chain.mjs";
import {
    PrivateSessionRecoveryController,
} from "./private-session-recovery-controller.mjs";
import {PrivateSessionController} from "./private-session-controller.mjs";
import {PrivateTradingController} from "./private-trading-controller.mjs";
import {HederaTimedTicketChainAdapter} from "./private-trading-chain.mjs";
import {
    EthersPrivateTradingRelayer,
    PRIVATE_TRADING_DEFAULT_GAS_LIMITS,
    createPrivateTradingRelayerSigner,
} from "./private-trading-relayer.mjs";
import {DurablePrivateRelayStore} from "./private-relay-store.mjs";
import {TimedTicketCustodyService} from "./timed-ticket-service.mjs";
import {DurableTimedTicketStore} from "./timed-ticket-store.mjs";

const DEFAULT_INTERVAL_MILLISECONDS = 3_000;
const PUBLIC_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TICKET_ID = /^[0-9a-f]{64}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export class PrivateTradingWorkerError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "PrivateTradingWorkerError";
        this.code = code;
    }
}

function fail(code, message = "private trading worker configuration failed") {
    throw new PrivateTradingWorkerError(code, message);
}

function positiveInteger(value, fallback, code) {
    const selected = value === undefined || value === "" ? fallback : value;
    if (
        !(
            typeof selected === "number" && Number.isSafeInteger(selected)
            || typeof selected === "string" && /^[1-9][0-9]*$/.test(selected)
        )
    ) {
        fail(code);
    }
    const result = Number(selected);
    if (!Number.isSafeInteger(result) || result < 1) fail(code);
    return result;
}

function decimal(value, code) {
    if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) fail(code);
    return value;
}

function nonnegativeDecimal(value, code) {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) fail(code);
    return value;
}

function uint256Decimal(value, code) {
    const normalized = nonnegativeDecimal(value, code);
    if (BigInt(normalized) >= 1n << 256n) fail(code);
    return normalized;
}

function uint64(value, code) {
    const parsed = BigInt(nonnegativeDecimal(value, code));
    if (parsed >= 1n << 64n) fail(code);
    return parsed.toString();
}

function address(value, code) {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
        fail(code);
    }
    return value.toLowerCase();
}

function bytes32(value, code) {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
        fail(code);
    }
    return value.toLowerCase();
}

function servicePath(value, code) {
    if (
        typeof value !== "string"
        || !/^\/[A-Za-z0-9/_-]+$/.test(value)
        || value.includes("//")
        || value.endsWith("/")
    ) {
        fail(code);
    }
    return value;
}

function rpcEndpoint(value) {
    if (typeof value !== "string") fail("RPC_URL_REQUIRED");
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        fail("RPC_URL_REQUIRED");
    }
    if (
        parsed.protocol !== "https:"
        || parsed.username !== ""
        || parsed.password !== ""
        || parsed.hash !== ""
    ) {
        fail("RPC_URL_REQUIRED");
    }
    return parsed.href;
}

function publicCode(value, fallback) {
    return typeof value === "string" && PUBLIC_CODE.test(value) ? value : fallback;
}

export function privateTradingRuntimeConfig(env) {
    const stateDirectory = env?.PRIVATE_TRADING_STATE_DIR;
    const rpcUrl = env?.PRIVATE_TRADING_RPC_URL;
    const engineAddress = env?.PRIVATE_TRADING_ENGINE_ADDRESS;
    if (
        typeof stateDirectory !== "string"
        || !path.isAbsolute(stateDirectory)
        || path.resolve(stateDirectory) !== stateDirectory
    ) {
        fail("STATE_DIRECTORY_REQUIRED");
    }
    const engine = address(engineAddress, "ENGINE_ADDRESS_REQUIRED");
    const factory = address(
        env.PRIVATE_TRADING_FACTORY_ADDRESS,
        "FACTORY_ADDRESS_REQUIRED",
    );
    const gate = address(
        env.PRIVATE_TRADING_GATE_ADDRESS,
        "GATE_ADDRESS_REQUIRED",
    );
    const registry = address(
        env.PRIVATE_TRADING_REGISTRY_ADDRESS,
        "REGISTRY_ADDRESS_REQUIRED",
    );
    const security = address(
        env.PRIVATE_TRADING_SECURITY_ADDRESS,
        "SECURITY_ADDRESS_REQUIRED",
    );
    const recoveryRouter = address(
        env.PRIVATE_TRADING_RECOVERY_ROUTER_ADDRESS,
        "RECOVERY_ROUTER_ADDRESS_REQUIRED",
    );
    const hbarPool = address(
        env.PRIVATE_TRADING_HBAR_POOL_ADDRESS,
        "HBAR_POOL_ADDRESS_REQUIRED",
    );
    const lprcPool = address(
        env.PRIVATE_TRADING_LPRC_POOL_ADDRESS,
        "LPRC_POOL_ADDRESS_REQUIRED",
    );
    const quicknetChainHash = bytes32(
        env.PRIVATE_TRADING_QUICKNET_CHAIN_HASH,
        "QUICKNET_CHAIN_HASH_REQUIRED",
    );
    if (quicknetChainHash !== `0x${QUICKNET_CHAIN_HASH}`) {
        fail("QUICKNET_CHAIN_HASH_REQUIRED");
    }
    const creationCodeHash = bytes32(
        env.PRIVATE_TRADING_SESSION_CREATION_CODE_HASH,
        "SESSION_CREATION_CODE_HASH_REQUIRED",
    );
    const routes = Object.freeze({
        tickets: servicePath(
            env.PRIVATE_TRADING_TICKETS_BASE,
            "TICKETS_BASE_REQUIRED",
        ),
        orders: servicePath(
            env.PRIVATE_TRADING_ORDERS_BASE,
            "ORDERS_BASE_REQUIRED",
        ),
        routing: servicePath(
            env.PRIVATE_TRADING_ROUTING_PATH,
            "ROUTING_PATH_REQUIRED",
        ),
        sessions: servicePath(
            env.PRIVATE_TRADING_SESSIONS_PATH,
            "SESSIONS_PATH_REQUIRED",
        ),
    });
    if (new Set(Object.values(routes)).size !== 4) fail("SERVICE_PATHS_CONFLICT");
    return Object.freeze({
        stateDirectory,
        rpcUrl: rpcEndpoint(rpcUrl),
        engineAddress: engine,
        releaseConfig: Object.freeze({
            factory,
            security,
            partition: bytes32(
                env.PRIVATE_TRADING_PARTITION,
                "PARTITION_REQUIRED",
            ),
            recoveryRouter,
            generation: uint64(
                env.PRIVATE_TRADING_GENERATION,
                "GENERATION_REQUIRED",
            ),
            feePolicyDigest: bytes32(
                env.PRIVATE_TRADING_FEE_POLICY_DIGEST,
                "FEE_POLICY_REQUIRED",
            ),
        }),
        registration: Object.freeze({
            allowlist: Object.freeze({
                creationCodeHash,
                factory,
                gate,
                registry,
                engine,
                security,
                partition: bytes32(
                    env.PRIVATE_TRADING_PARTITION,
                    "PARTITION_REQUIRED",
                ),
                router: recoveryRouter,
                quicknetChainHash,
                feePolicyDigest: bytes32(
                    env.PRIVATE_TRADING_FEE_POLICY_DIGEST,
                    "FEE_POLICY_REQUIRED",
                ),
            }),
            gasLimits: Object.freeze({
                deployAndRegister: decimal(
                    env.PRIVATE_TRADING_DEPLOY_AND_REGISTER_GAS_LIMIT
                        ?? PRIVATE_SESSION_REGISTRATION_DEFAULT_GAS_LIMITS
                            .deployAndRegister.toString(),
                    "REGISTRATION_GAS_LIMIT_INVALID",
                ),
                register: decimal(
                    env.PRIVATE_TRADING_REGISTER_GAS_LIMIT
                        ?? PRIVATE_SESSION_REGISTRATION_DEFAULT_GAS_LIMITS
                            .register.toString(),
                    "REGISTRATION_GAS_LIMIT_INVALID",
                ),
            }),
        }),
        recovery: Object.freeze({
            allowlist: Object.freeze({
                factory,
                generation: uint64(
                    env.PRIVATE_TRADING_GENERATION,
                    "GENERATION_REQUIRED",
                ),
                pools: Object.freeze({
                    HBAR: Object.freeze({
                        address: hbarPool,
                        asset: ZERO_ADDRESS,
                        denomination: decimal(
                            env.PRIVATE_TRADING_HBAR_DENOMINATION_TINYBAR,
                            "HBAR_DENOMINATION_REQUIRED",
                        ),
                    }),
                    LPRC: Object.freeze({
                        address: lprcPool,
                        asset: security,
                        denomination: decimal(
                            env.PRIVATE_TRADING_LPRC_DENOMINATION,
                            "LPRC_DENOMINATION_REQUIRED",
                        ),
                    }),
                }),
                router: recoveryRouter,
                security,
            }),
            gasLimit: decimal(
                env.PRIVATE_TRADING_RECOVERY_GAS_LIMIT
                    ?? PRIVATE_SESSION_RECOVERY_GAS_LIMIT.toString(),
                "RECOVERY_GAS_LIMIT_INVALID",
            ),
        }),
        pools: Object.freeze({
            HBAR: Object.freeze({
                address: hbarPool,
                asset: ZERO_ADDRESS,
                denomination: decimal(
                    env.PRIVATE_TRADING_HBAR_DENOMINATION_TINYBAR,
                    "HBAR_DENOMINATION_REQUIRED",
                ),
            }),
            LPRC: Object.freeze({
                address: lprcPool,
                asset: security,
                denomination: decimal(
                    env.PRIVATE_TRADING_LPRC_DENOMINATION,
                    "LPRC_DENOMINATION_REQUIRED",
                ),
            }),
        }),
        routes,
        maxGasPriceWei: decimal(
            env.PRIVATE_TRADING_MAX_GAS_PRICE_WEI,
            "MAX_GAS_PRICE_REQUIRED",
        ),
        relayerReserveWei: uint256Decimal(
            env.PRIVATE_TRADING_RELAYER_RESERVE_WEI,
            "RELAYER_RESERVE_REQUIRED",
        ),
        gasLimits: Object.freeze({
            place: decimal(
                env.PRIVATE_TRADING_PLACE_GAS_LIMIT
                    ?? PRIVATE_TRADING_DEFAULT_GAS_LIMITS.place.toString(),
                "GAS_LIMIT_INVALID",
            ),
            buy: decimal(
                env.PRIVATE_TRADING_BUY_GAS_LIMIT
                    ?? PRIVATE_TRADING_DEFAULT_GAS_LIMITS.buy.toString(),
                "GAS_LIMIT_INVALID",
            ),
            sell: decimal(
                env.PRIVATE_TRADING_SELL_GAS_LIMIT
                    ?? PRIVATE_TRADING_DEFAULT_GAS_LIMITS.sell.toString(),
                "GAS_LIMIT_INVALID",
            ),
            cancel: decimal(
                env.PRIVATE_TRADING_CANCEL_GAS_LIMIT
                    ?? PRIVATE_TRADING_DEFAULT_GAS_LIMITS.cancel.toString(),
                "GAS_LIMIT_INVALID",
            ),
            expire: decimal(
                env.PRIVATE_TRADING_EXPIRE_GAS_LIMIT
                    ?? PRIVATE_TRADING_DEFAULT_GAS_LIMITS.expire.toString(),
                "GAS_LIMIT_INVALID",
            ),
            sweep: decimal(
                env.PRIVATE_TRADING_SWEEP_GAS_LIMIT
                    ?? PRIVATE_TRADING_DEFAULT_GAS_LIMITS.sweep.toString(),
                "GAS_LIMIT_INVALID",
            ),
            route: decimal(
                env.PRIVATE_TRADING_ROUTING_GAS_LIMIT
                    ?? PRIVATE_TRADING_DEFAULT_GAS_LIMITS.route.toString(),
                "GAS_LIMIT_INVALID",
            ),
        }),
        intervalMilliseconds: positiveInteger(
            env.PRIVATE_TRADING_WORKER_INTERVAL_MS,
            DEFAULT_INTERVAL_MILLISECONDS,
            "WORKER_INTERVAL_INVALID",
        ),
        confirmations: positiveInteger(
            env.PRIVATE_TRADING_CONFIRMATIONS,
            1,
            "CONFIRMATIONS_INVALID",
        ),
        transactionTimeoutMilliseconds: positiveInteger(
            env.PRIVATE_TRADING_TRANSACTION_TIMEOUT_MS,
            120_000,
            "TRANSACTION_TIMEOUT_INVALID",
        ),
    });
}

export class PrivateTradingWorkerRunner {
    constructor({
        service,
        intervalMilliseconds = DEFAULT_INTERVAL_MILLISECONDS,
        errorSink = () => {},
        unrefTimers = false,
    }) {
        if (
            service === null
            || typeof service !== "object"
            || typeof service.runPending !== "function"
            || typeof service.purgeExpired !== "function"
            || !Number.isSafeInteger(intervalMilliseconds)
            || intervalMilliseconds < 250
            || typeof errorSink !== "function"
            || typeof unrefTimers !== "boolean"
        ) {
            fail("WORKER_CONFIG_INVALID");
        }
        this.service = service;
        this.intervalMilliseconds = intervalMilliseconds;
        this.errorSink = errorSink;
        this.unrefTimers = unrefTimers;
        this.timer = null;
        this.inFlight = null;
        this.state = {
            schemaVersion: "hedera2026.private-worker-status.v1",
            running: false,
            active: false,
            lastRunAt: null,
            lastSuccessAt: null,
            lastErrorCode: null,
            ticketsVisited: 0,
            ticketFailures: 0,
        };
    }

    start() {
        if (this.state.running) return;
        this.state.running = true;
        this.#schedule(0);
    }

    async stop() {
        this.state.running = false;
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.inFlight !== null) await this.inFlight;
    }

    status() {
        return structuredClone({...this.state, active: this.inFlight !== null});
    }

    async runOnce() {
        if (this.inFlight !== null) {
            return Object.freeze({
                schemaVersion: "hedera2026.private-worker-run.v1",
                skipped: true,
            });
        }
        this.inFlight = this.#run();
        try {
            return await this.inFlight;
        } finally {
            this.inFlight = null;
        }
    }

    #schedule(delay) {
        if (!this.state.running) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.runOnce()
                .catch(() => {})
                .finally(() => this.#schedule(this.intervalMilliseconds));
        }, delay);
        if (this.unrefTimers) this.timer.unref();
    }

    async #run() {
        this.state.lastRunAt = new Date().toISOString();
        let results;
        let failures;
        try {
            results = await this.service.runPending();
            await this.service.purgeExpired();
            if (!Array.isArray(results)) fail("WORKER_RESULT_INVALID");
            failures = results
                .filter((result) => result?.status === "ERROR")
                .map((failure) => {
                    if (
                        failure === null
                        || typeof failure !== "object"
                        || !TICKET_ID.test(failure.ticketId ?? "")
                    ) {
                        fail("WORKER_RESULT_INVALID");
                    }
                    return Object.freeze({
                        ticketId: failure.ticketId,
                        code: publicCode(failure.code, "TICKET_FAILED"),
                    });
                });
        } catch (error) {
            const code = publicCode(error?.code, "WORKER_RUN_FAILED");
            this.state.lastErrorCode = code;
            try {
                await this.errorSink(Object.freeze({code}));
            } catch {
                // Logging failures cannot replace the public worker error.
            }
            throw new PrivateTradingWorkerError(code, "private trading worker pass failed");
        }
        this.state.ticketsVisited += results.length;
        this.state.ticketFailures += failures.length;
        this.state.lastSuccessAt = new Date().toISOString();
        this.state.lastErrorCode = failures.length === 0 ? null : "TICKET_FAILURES";
        return Object.freeze({
            schemaVersion: "hedera2026.private-worker-run.v1",
            skipped: false,
            ticketsVisited: results.length,
            failures: Object.freeze(failures),
        });
    }
}

export async function openPrivateTradingRuntime({
    env = process.env,
    provider: suppliedProvider = null,
    fetchImpl = globalThis.fetch,
    crypto = webcrypto,
    nowSeconds = () => BigInt(Math.floor(Date.now() / 1_000)),
    transitionHook = async () => {},
    errorSink = () => {},
} = {}) {
    const config = privateTradingRuntimeConfig(env);
    const ownsProvider = suppliedProvider === null;
    const provider = suppliedProvider ?? new JsonRpcProvider(
        config.rpcUrl,
        Number(TIMED_TICKET_CHAIN_ID),
        {staticNetwork: true, batchMaxCount: 20},
    );
    let signer;
    try {
        signer = createPrivateTradingRelayerSigner({env, provider});
    } catch (error) {
        if (ownsProvider && typeof provider.destroy === "function") provider.destroy();
        throw error;
    }
    const ticketStore = new DurableTimedTicketStore({
        directory: path.join(config.stateDirectory, "tickets"),
        crypto,
    });
    const transactionStore = new DurablePrivateRelayStore({
        directory: path.join(config.stateDirectory, "relay-transactions"),
    });
    const chainAdapter = new HederaTimedTicketChainAdapter({
        provider,
        engineAddress: config.engineAddress,
        releaseConfig: config.releaseConfig,
        pools: config.pools,
    });
    const lockedKeyProvider = new QuicknetLockedKeyProvider({
        client: new PinnedQuicknetClient({fetchImpl}),
        crypto,
        nowSeconds,
    });
    const relayer = new EthersPrivateTradingRelayer({
        provider,
        signer,
        transactionStore,
        chainAdapter,
        maxGasPriceWei: config.maxGasPriceWei,
        relayerReserveWei: config.relayerReserveWei,
        gasLimits: config.gasLimits,
        confirmations: config.confirmations,
        transactionTimeoutMilliseconds: config.transactionTimeoutMilliseconds,
    });
    const registrationAdapter = new EthersPrivateSessionRegistrationAdapter({
        provider,
        env,
        allowlist: config.registration.allowlist,
        transactionStore,
        maxGasPriceWei: config.maxGasPriceWei,
        relayerReserveWei: config.relayerReserveWei,
        gasLimits: config.registration.gasLimits,
        confirmations: config.confirmations,
        transactionTimeoutMilliseconds: config.transactionTimeoutMilliseconds,
    });
    const registrationController = new PrivateSessionRegistrationController({
        chainAdapter: registrationAdapter,
        allowlist: config.registration.allowlist,
    });
    const recoveryAdapter = new EthersPrivateSessionRecoveryAdapter({
        provider,
        env,
        allowlist: config.recovery.allowlist,
        transactionStore,
        maxGasPriceWei: config.maxGasPriceWei,
        relayerReserveWei: config.relayerReserveWei,
        gasLimit: config.recovery.gasLimit,
        confirmations: config.confirmations,
        transactionTimeoutMilliseconds: config.transactionTimeoutMilliseconds,
    });
    const recoveryController = new PrivateSessionRecoveryController({
        chainAdapter: recoveryAdapter,
    });
    const sessionController = new PrivateSessionController({
        registrationController,
        recoveryController,
    });
    const service = new TimedTicketCustodyService({
        store: ticketStore,
        lockedKeyProvider,
        chainAdapter,
        revealAdapter: relayer,
        nowSeconds,
        transitionHook,
        crypto,
    });
    const controller = new PrivateTradingController({
        service,
        placeRelayer: relayer,
        ticketsBase: config.routes.tickets,
        ordersBase: config.routes.orders,
    });
    const routingController = new PrivateRoutingController({
        relayer,
        path: config.routes.routing,
    });
    const worker = new PrivateTradingWorkerRunner({
        service,
        intervalMilliseconds: config.intervalMilliseconds,
        errorSink,
    });
    try {
        await Promise.all([
            ticketStore.initialize(),
            transactionStore.initialize(),
            chainAdapter.initialize(),
            relayer.initialize(),
            registrationAdapter.initialize(),
            recoveryAdapter.initialize(),
        ]);
    } catch (error) {
        chainAdapter.close();
        if (ownsProvider && typeof provider.destroy === "function") provider.destroy();
        throw error;
    }
    let closed = false;
    return Object.freeze({
        config,
        provider,
        chainAdapter,
        ticketStore,
        transactionStore,
        lockedKeyProvider,
        relayer,
        registrationAdapter,
        recoveryAdapter,
        service,
        controller,
        registrationController,
        recoveryController,
        sessionController,
        routingController,
        worker,
        async close() {
            if (closed) return;
            closed = true;
            await worker.stop();
            chainAdapter.close();
            if (ownsProvider && typeof provider.destroy === "function") provider.destroy();
        },
    });
}

export async function runPrivateTradingWorker(options = {}) {
    const runtime = await openPrivateTradingRuntime(options);
    runtime.worker.start();
    return runtime;
}

async function main() {
    const runtime = await runPrivateTradingWorker();
    await new Promise((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
    });
    await runtime.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        const code = publicCode(error?.code, "PRIVATE_TRADING_WORKER_FAILED");
        process.stderr.write(`${code}\n`);
        process.exitCode = 1;
    });
}
