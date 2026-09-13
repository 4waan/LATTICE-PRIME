"use strict";

// Keep PLONK witness generation off the Markets UI thread. ffjavascript would
// otherwise create another worker for every reported CPU from inside this one.
// Routing proves two large circuits, so that nested pool can exhaust memory and
// stall. One proving thread bounds memory while the page remains responsive.
try {
    Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        value: undefined,
        writable: true,
    });
} catch {
    globalThis.Worker = undefined;
}

// The bundled API validates every artifact digest and proof locally before
// returning a result.
importScripts("private-trading-crypto.bundle.mjs");

const METHODS = Object.freeze({
    routing: "createPrivateRoutingProofs",
    session: "createPrivateSessionProofs",
});

self.onmessage = async function (event) {
    const message = event?.data;
    const messageId = String(message?.id || "");
    const method = METHODS[message?.kind];
    if (!message || message.schemaVersion !== 1 || !messageId || !method) {
        self.postMessage({
            id: messageId,
            ok: false,
            error: {code: "PROOF_REQUEST_INVALID", message: "Private proof request is invalid."},
        });
        return;
    }
    try {
        const result = await globalThis.PrivateTradingCrypto[method]({
            ...message.request,
            plonk: globalThis.PrivateTradingCrypto.plonk,
        });
        self.postMessage({id: messageId, ok: true, result});
    } catch (error) {
        self.postMessage({
            id: messageId,
            ok: false,
            error: {
                code: String(error?.code || "PROOF_FAILED"),
                message: String(error?.message || "Private proof generation failed."),
            },
        });
    }
};
