const agentReceiptState = {
    client: null,
    records: [],
    busy: false,
};

const receiptElement = (id) => document.getElementById(id);

function receiptStatus(message, tone = "") {
    const output = receiptElement("agent-receipts-status");
    if (!output) return;
    output.textContent = message;
    output.className = `status${tone ? ` ${tone}` : ""}`;
}

function receiptBusy(busy) {
    agentReceiptState.busy = busy;
    for (const id of [
        "agent-receipts-refresh",
        "agent-receipts-recover",
        "agent-receipts-download",
    ]) {
        const button = receiptElement(id);
        if (button) button.disabled = busy;
    }
}

function shortHash(value) {
    if (typeof value !== "string" || value.length < 18) return value ?? "Unavailable";
    return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function line(label, value) {
    const item = document.createElement("li");
    const key = document.createElement("span");
    key.className = "k";
    key.textContent = label;
    const shown = document.createElement("span");
    shown.className = "v";
    shown.textContent = value;
    item.append(key, shown);
    return item;
}

export function renderAgentReceipt(record) {
    const card = document.createElement("section");
    card.className = "panel";
    const top = document.createElement("div");
    top.className = "top";
    const title = document.createElement("h3");
    title.textContent =
        record.decision.decision === "UNAVAILABLE"
            ? "Recovered signer action"
            : `Verified decision: ${record.decision.decision}`;
    const source = document.createElement("span");
    source.className = "src";
    source.textContent = record.updatedAt;
    top.append(title, source);

    const body = document.createElement("div");
    body.className = "body";
    const rows = document.createElement("ul");
    rows.className = "readout";
    rows.append(
        line("Action", shortHash(record.actionId)),
        line("Mandate", shortHash(record.mandateId)),
        line("Commitment", shortHash(record.commitment)),
        line("Proof", shortHash(record.decision.inference?.proofHash)),
        line("Chain state", record.lifecycle.latestState?.lifecycle ?? "Not observed yet"),
        line("Confirmed lifecycle steps", String(record.lifecycle.steps.length))
    );
    if (record.lifecycle.lastError !== null) {
        rows.append(line("Last recovery error", `${record.lifecycle.lastError.code}: ${record.lifecycle.lastError.message}`));
    }
    body.append(rows);
    card.append(top, body);
    return card;
}

function paintAgentReceipts(records) {
    const list = receiptElement("agent-receipts-list");
    list.replaceChildren();
    if (records.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No private-agent decision has been recorded on this device.";
        list.append(empty);
        return;
    }
    for (const record of records) list.append(renderAgentReceipt(record));
}

async function refreshAgentReceipts() {
    if (agentReceiptState.client === null || agentReceiptState.busy) return;
    receiptBusy(true);
    receiptStatus("Reading the local sanitized receipt journal.");
    try {
        agentReceiptState.records = await agentReceiptState.client.receipts();
        paintAgentReceipts(agentReceiptState.records);
        receiptStatus(
            `Loaded ${agentReceiptState.records.length} durable receipt${agentReceiptState.records.length === 1 ? "" : "s"}.`,
            "ok"
        );
    } catch (error) {
        receiptStatus(`${error.code ?? "REQUEST_FAILED"}: ${error.message}`, "bad");
    } finally {
        receiptBusy(false);
    }
}

async function recoverAgentReceipts() {
    if (agentReceiptState.client === null || agentReceiptState.busy) return;
    receiptBusy(true);
    receiptStatus("Running one serialized recovery pass.");
    try {
        const result = await agentReceiptState.client.runScheduler();
        receiptStatus(
            result.skipped
                ? result.reason
                : `Checked ${result.actionsVisited} action${result.actionsVisited === 1 ? "" : "s"} and completed ${result.stepsCompleted} step${result.stepsCompleted === 1 ? "" : "s"}.`,
            result.failures?.length ? "bad" : "ok"
        );
    } catch (error) {
        receiptStatus(`${error.code ?? "REQUEST_FAILED"}: ${error.message}`, "bad");
    } finally {
        receiptBusy(false);
    }
    await refreshAgentReceipts();
}

function downloadAgentReceipts() {
    const blob = new Blob(
        [`${JSON.stringify({
            schemaVersion: "lattice.agent.sanitized-receipt-export.v1",
            exportedAt: new Date().toISOString(),
            receipts: agentReceiptState.records,
        }, null, 2)}\n`],
        {type: "application/json"}
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "lattice-agent-receipts.json";
    link.click();
    URL.revokeObjectURL(url);
}

export async function bootAgentReceipts(agentState = globalThis.LatticeAgent) {
    if (!receiptElement("agent-receipts")) return null;
    if (agentState?.ready === undefined) {
        receiptStatus("The local launcher is not connected. Public portfolio data remains available.");
        return null;
    }
    const client = await agentState.ready;
    if (client === null) {
        receiptStatus(`${agentState.error?.code ?? "PAIRING_FAILED"}: local pairing failed`, "bad");
        return null;
    }
    agentReceiptState.client = client;
    await refreshAgentReceipts();
    return client;
}

if (typeof globalThis.document === "object") {
    receiptElement("agent-receipts-refresh")?.addEventListener("click", refreshAgentReceipts);
    receiptElement("agent-receipts-recover")?.addEventListener("click", recoverAgentReceipts);
    receiptElement("agent-receipts-download")?.addEventListener("click", downloadAgentReceipts);
    bootAgentReceipts().catch((error) => {
        receiptStatus(`${error.code ?? "REQUEST_FAILED"}: ${error.message}`, "bad");
    });
}
