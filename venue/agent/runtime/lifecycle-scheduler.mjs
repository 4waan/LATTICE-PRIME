const ACTION_ID = /^sha256:[0-9a-f]{64}$/;

export class LifecycleSchedulerError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "LifecycleSchedulerError";
        this.code = code;
    }
}

export class LifecycleScheduler {
    constructor({
        signer,
        adapter,
        runtime,
        receiptStore,
        intervalMilliseconds = 15_000,
    }) {
        if (!Number.isSafeInteger(intervalMilliseconds) || intervalMilliseconds < 1_000) {
            throw new LifecycleSchedulerError("INTERVAL_INVALID", "scheduler interval is invalid");
        }
        this.signer = signer;
        this.adapter = adapter;
        this.runtime = runtime;
        this.receiptStore = receiptStore;
        this.intervalMilliseconds = intervalMilliseconds;
        this.timer = null;
        this.inFlight = null;
        this.state = {
            schemaVersion: "lattice.agent.lifecycle-scheduler-status.v1",
            running: false,
            active: false,
            lastRunAt: null,
            lastSuccessAt: null,
            lastError: null,
            actionsVisited: 0,
            stepsCompleted: 0,
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
            return {
                schemaVersion: "lattice.agent.lifecycle-scheduler-run.v1",
                skipped: true,
                reason: "a lifecycle pass is already active",
            };
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
        this.timer.unref();
    }

    async #run() {
        const startedAt = new Date().toISOString();
        this.state.lastRunAt = startedAt;
        let summary;
        try {
            summary = await this.signer.call("summary", {});
        } catch (error) {
            this.state.lastError = {
                code: typeof error?.code === "string" ? error.code : "SIGNER_UNAVAILABLE",
                message: typeof error?.message === "string" ? error.message : "signer is unavailable",
            };
            return {
                schemaVersion: "lattice.agent.lifecycle-scheduler-run.v1",
                skipped: true,
                reason: "signer is locked or unavailable",
            };
        }

        let actionsVisited = 0;
        let stepsCompleted = 0;
        const failures = [];
        for (const ticket of summary.tickets) {
            if (!ACTION_ID.test(ticket?.actionId ?? "")) continue;
            if (["ABANDONED_UNSIGNED", "WITHDRAWN"].includes(ticket.lifecycle)) continue;
            actionsVisited += 1;
            try {
                const action = await this.signer.call("action", {actionId: ticket.actionId});
                await this.#record("ensureAction", action);
                const nonces = await this.adapter.accountNonces();
                if (
                    !Number.isSafeInteger(nonces?.pending) ||
                    nonces.pending < 0
                ) {
                    throw new LifecycleSchedulerError(
                        "NONCE_STATE_INVALID",
                        "scheduler received an invalid pending account nonce"
                    );
                }
                const result = await this.runtime.recoverAction({
                    actionId: ticket.actionId,
                    nonce: nonces.pending,
                });
                if (result.schemaVersion === "lattice.agent.lifecycle-step.v1") {
                    stepsCompleted += 1;
                    if (this.runtime.receiptStore !== this.receiptStore) {
                        await this.#record("recordStep", result);
                    }
                } else if (result.state !== undefined && this.runtime.receiptStore !== this.receiptStore) {
                    await this.#record("recordObservation", ticket.actionId, result.state);
                }
            } catch (error) {
                failures.push({
                    actionId: ticket.actionId,
                    code: typeof error?.code === "string" ? error.code : "LIFECYCLE_FAILED",
                });
                await this.#record("recordError", ticket.actionId, error);
            }
        }

        this.state.actionsVisited += actionsVisited;
        this.state.stepsCompleted += stepsCompleted;
        this.state.lastSuccessAt = failures.length === 0 ? new Date().toISOString() : this.state.lastSuccessAt;
        this.state.lastError = failures.length === 0
            ? null
            : {
                code: "ACTION_FAILURES",
                message: `${failures.length} lifecycle action${failures.length === 1 ? "" : "s"} failed`,
            };
        return {
            schemaVersion: "lattice.agent.lifecycle-scheduler-run.v1",
            skipped: false,
            startedAt,
            actionsVisited,
            stepsCompleted,
            failures,
        };
    }

    async #record(method, ...args) {
        if (this.receiptStore === null || typeof this.receiptStore?.[method] !== "function") {
            return false;
        }
        try {
            await this.receiptStore[method](...args);
            return true;
        } catch {
            return false;
        }
    }
}
