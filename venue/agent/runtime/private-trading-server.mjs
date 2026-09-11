import {pathToFileURL} from "node:url";

import {
    createPrivateTradingHttpServer,
} from "./private-trading-http.mjs";
import {openPrivateTradingRuntime} from "./private-trading-worker.mjs";

const PUBLIC_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function publicCode(error) {
    return typeof error?.code === "string" && PUBLIC_CODE.test(error.code)
        ? error.code
        : "PRIVATE_TRADING_SERVER_FAILED";
}

export async function openPrivateTradingServer({
    env = process.env,
    runtimeOptions = {},
    runtimeFactory = openPrivateTradingRuntime,
    nowMs = () => Date.now(),
    eventSink = () => {},
} = {}) {
    if (typeof runtimeFactory !== "function") {
        throw Object.assign(
            new Error("private trading server configuration failed"),
            {code: "PRIVATE_TRADING_SERVER_CONFIG_INVALID"},
        );
    }
    const runtime = await runtimeFactory({
        ...runtimeOptions,
        env,
    });
    let server;
    try {
        server = createPrivateTradingHttpServer({
            runtime,
            env,
            nowMs,
            eventSink,
        });
    } catch (error) {
        await runtime.close();
        throw error;
    }
    let closed = false;
    return Object.freeze({
        runtime,
        server,
        async listen() {
            return server.listen();
        },
        async close() {
            if (closed) return;
            closed = true;
            try {
                await server.close();
            } finally {
                await runtime.close();
            }
        },
    });
}

export async function runPrivateTradingServer(options = {}) {
    const service = await openPrivateTradingServer(options);
    try {
        await service.listen();
        return service;
    } catch (error) {
        await service.close();
        throw error;
    }
}

async function main() {
    const service = await runPrivateTradingServer();
    await new Promise((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
    });
    await service.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        process.stderr.write(`${publicCode(error)}\n`);
        process.exitCode = 1;
    });
}
