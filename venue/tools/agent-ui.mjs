const agentUiState = {
    client: null,
    previewId: null,
    previewExecutable: false,
    mandateId: null,
    busy: false,
};

const agentElement = (id) => document.getElementById(id);

function agentStatus(message, tone = "") {
    const output = agentElement("agent-status");
    if (!output) return;
    output.textContent = message;
    output.className = `status${tone ? ` ${tone}` : ""}`;
}

function agentBusy(busy) {
    agentUiState.busy = busy;
    for (const id of [
        "agent-unlock",
        "agent-setup",
        "agent-preview",
        "agent-execute",
        "agent-run-recovery",
        "agent-pause",
        "agent-resume",
    ]) {
        const button = agentElement(id);
        if (button) button.disabled = busy;
    }
    if (!busy && agentElement("agent-execute")) {
        agentElement("agent-execute").disabled = !agentUiState.previewExecutable;
    }
}

function agentError(error) {
    const code = typeof error?.code === "string" ? error.code : "REQUEST_FAILED";
    const message = typeof error?.message === "string" ? error.message : "local agent request failed";
    agentStatus(`${code}: ${message}`, "bad");
}

export function agentOrderInput(venue) {
    const order = venue.readOrder();
    if (order.side !== 0) throw new Error("The first private-agent capability supports buy orders only.");
    if (order.bad.price || order.bad.qty) {
        throw new Error("Enter a valid buy price and whole-bond quantity before previewing the mandate.");
    }
    return {
        limitPrice: order.price.toString(),
        quantity: order.qty.toString(),
    };
}

function paintAgentPreview(preview) {
    agentUiState.previewId = preview.previewId;
    agentElement("agent-preview-account").textContent = preview.account;
    agentElement("agent-preview-order").textContent =
        `Buy ${preview.quantity} unit${preview.quantity === "1" ? "" : "s"} at no more than ${preview.limitPrice} tinybar`;
    agentElement("agent-preview-principal").textContent = `${preview.principalBudget} tinybar`;
    agentElement("agent-preview-bond").textContent =
        `${preview.bondBudget} bond, ${preview.cancellationBudget} cancel, ${preview.feeReserve} fee reserve`;
    const checks = preview.preflight;
    agentElement("agent-preview-preflight").textContent =
        checks.eligible && !checks.halted && checks.feeBalanceSufficient
            ? `Eligible and funded at block ${checks.checkedAtBlock}`
            : `Blocked: eligibility ${checks.eligible ? "passes" : "fails"}, venue ${checks.halted ? "halted" : "open"}, fees ${checks.feeBalanceSufficient ? "funded" : "unfunded"}`;
    agentUiState.previewExecutable =
        checks.eligible && !checks.halted && checks.feeBalanceSufficient;
    agentElement("agent-execute").disabled = !agentUiState.previewExecutable;
    agentElement("agent-preview-card").hidden = false;
}

async function unlockAgent(method) {
    if (agentUiState.client === null || agentUiState.busy) return;
    const field = agentElement("agent-passphrase");
    const passphrase = field.value;
    field.value = "";
    if (passphrase.length < 12) {
        agentStatus("Use a local signer passphrase of at least 12 characters.", "bad");
        return;
    }
    agentBusy(true);
    agentStatus(method === "setup" ? "Creating the encrypted local signer." : "Unlocking the encrypted local signer.");
    try {
        const result = method === "setup"
            ? await agentUiState.client.setup(passphrase)
            : await agentUiState.client.unlock(passphrase);
        agentElement("agent-controls").hidden = false;
        agentElement("agent-connection").textContent = "Local signer unlocked";
        agentStatus(`Dedicated signing account ${result.address} is unlocked on this device.`, "ok");
    } catch (error) {
        agentError(error);
    } finally {
        agentBusy(false);
    }
}

async function previewAgentOrder() {
    if (agentUiState.client === null || agentUiState.busy) return;
    agentBusy(true);
    agentStatus("Reading one block-pinned market snapshot and protocol preflight.");
    try {
        const order = agentOrderInput(Venue);
        const preview = await agentUiState.client.previewOrder(order.limitPrice, order.quantity);
        paintAgentPreview(preview);
        agentStatus("Review the exact one-decision mandate before confirming.", "ok");
    } catch (error) {
        agentError(error);
    } finally {
        agentBusy(false);
    }
}

async function executeAgentPreview() {
    if (agentUiState.client === null || agentUiState.previewId === null || agentUiState.busy) return;
    const previewId = agentUiState.previewId;
    agentUiState.previewId = null;
    agentUiState.previewExecutable = false;
    agentElement("agent-preview-card").hidden = true;
    agentBusy(true);
    agentStatus("Generating and verifying the private decision proof locally.");
    try {
        const result = await agentUiState.client.executePreview(previewId);
        agentUiState.mandateId = result.mandateId;
        agentElement("agent-mandate-actions").hidden = false;
        const receipt = result.receipt;
        if (receipt.decision === "WAIT") {
            agentStatus("The verified decision was WAIT. No transaction was signed or broadcast.", "ok");
        } else {
            agentStatus(
                `The verified decision was EXECUTE. Commit ${receipt.transaction.status} with ${receipt.transaction.transactionHash}.`,
                receipt.transaction.confirmed ? "ok" : ""
            );
        }
    } catch (error) {
        agentError(error);
    } finally {
        agentBusy(false);
    }
}

async function pauseAgent(paused) {
    if (agentUiState.client === null || agentUiState.mandateId === null || agentUiState.busy) return;
    agentBusy(true);
    try {
        await agentUiState.client.pauseMandate(agentUiState.mandateId, paused);
        agentStatus(
            paused
                ? "New work is paused. The scheduler may still complete already committed obligations."
                : "The mandate is active again.",
            "ok"
        );
    } catch (error) {
        agentError(error);
    } finally {
        agentBusy(false);
    }
}

async function runAgentRecovery() {
    if (agentUiState.client === null || agentUiState.busy) return;
    agentBusy(true);
    agentStatus("Running one serialized lifecycle recovery pass.");
    try {
        const result = await agentUiState.client.runScheduler();
        agentStatus(
            result.skipped
                ? result.reason
                : `Recovery checked ${result.actionsVisited} action${result.actionsVisited === 1 ? "" : "s"} and completed ${result.stepsCompleted} step${result.stepsCompleted === 1 ? "" : "s"}.`,
            result.failures?.length ? "bad" : "ok"
        );
    } catch (error) {
        agentError(error);
    } finally {
        agentBusy(false);
    }
}

export async function bootAgentUi(agentState = globalThis.LatticeAgent) {
    if (!agentElement("agent-workspace")) return null;
    if (agentState?.ready === undefined) {
        agentElement("agent-connection").textContent = "Local launcher required";
        return null;
    }
    const client = await agentState.ready;
    if (client === null) {
        agentElement("agent-connection").textContent = "Local pairing failed";
        agentError(agentState.error);
        return null;
    }
    agentUiState.client = client;
    agentElement("agent-connection").textContent = "Local service paired";
    agentStatus("Pairing succeeded. Unlock or create the dedicated signer.");
    return client;
}

if (typeof globalThis.document === "object") {
    agentElement("agent-unlock")?.addEventListener("click", () => unlockAgent("unlock"));
    agentElement("agent-setup")?.addEventListener("click", () => unlockAgent("setup"));
    agentElement("agent-preview")?.addEventListener("click", previewAgentOrder);
    agentElement("agent-execute")?.addEventListener("click", executeAgentPreview);
    agentElement("agent-dismiss")?.addEventListener("click", () => {
        agentUiState.previewId = null;
        agentUiState.previewExecutable = false;
        agentElement("agent-preview-card").hidden = true;
        agentStatus("Preview dismissed. No mandate was activated and no transaction was sent.");
    });
    agentElement("agent-pause")?.addEventListener("click", () => pauseAgent(true));
    agentElement("agent-resume")?.addEventListener("click", () => pauseAgent(false));
    agentElement("agent-run-recovery")?.addEventListener("click", runAgentRecovery);
    bootAgentUi().catch(agentError);
}
