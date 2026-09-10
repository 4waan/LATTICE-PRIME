import {existsSync, readFileSync} from "node:fs";
import {join, resolve} from "node:path";

const profile = process.env.ORACLE_PUBLISHER_ID;
const root = resolve(process.env.ORACLE_STATE_ROOT ?? `oracle/state/${profile ?? ""}`);
const path = join(root, "journal.json");
if (!profile || !existsSync(path)) {
    console.error("publisher journal is missing");
    process.exit(1);
}
let journal;
try {
    journal = JSON.parse(readFileSync(path, "utf8"));
} catch {
    console.error("publisher journal is unreadable");
    process.exit(1);
}
const updatedAt = Date.parse(journal.updatedAt);
const maximumAgeMs = Number(process.env.ORACLE_HEALTH_MAX_AGE_SECONDS ?? 120) * 1000;
if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > maximumAgeMs) {
    console.error("publisher journal has stopped advancing");
    process.exit(1);
}
if (journal.pending?.status === "FAILED") {
    console.error("publisher has a terminal transaction failure");
    process.exit(1);
}
console.log("publisher process is advancing");
