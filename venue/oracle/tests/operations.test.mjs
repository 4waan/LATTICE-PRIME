import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const oracleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const venueRoot = resolve(oracleRoot, "..");

function text(path) {
    return readFileSync(path, "utf8");
}

test("publisher packaging supplies its configured portable dealer quote", () => {
    const config = JSON.parse(text(join(oracleRoot, "config.example.json")));
    assert.deepEqual(config.dealers.endpoints, ["file:///dealer/quote.json"]);

    const compose = text(join(oracleRoot, "packaging", "compose.example.yaml"));
    for (const profile of ["publisher-a", "publisher-b", "publisher-c"]) {
        assert.match(
            compose,
            new RegExp(`\\.\\./profiles/${profile}\\.json:/config/oracle\\.json:ro`),
        );
        assert.match(
            compose,
            new RegExp(`\\.\\./quotes/${profile}:/dealer:ro`),
        );
    }
    assert.equal((compose.match(/:\/config\/oracle\.json:ro/g) ?? []).length, 3);
    assert.equal((compose.match(/:\/dealer:ro/g) ?? []).length, 3);

    const publisherEnvironment = text(
        join(oracleRoot, "packaging", "publisher.env.example"),
    );
    const secretNames = [...publisherEnvironment.matchAll(
        /^([A-Z0-9_]*(?:PRIVATE_KEY|MNEMONIC|SECRET))=/gm,
    )].map((match) => match[1]);
    assert.deepEqual(secretNames, ["ORACLE_PUBLISHER_PRIVATE_KEY"]);
});

test("live scripts keep raw keys out of process arguments", () => {
    const scheduler = text(join(venueRoot, "script", "live", "oracle-scheduler.sh"));
    const breakGlass = text(join(venueRoot, "script", "live", "publish-mark.sh"));
    assert.doesNotMatch(scheduler, /--private-key/);
    assert.doesNotMatch(breakGlass, /--private-key/);
    assert.match(scheduler, /mode & 0o077/);
    assert.match(breakGlass, /mode & 0o077/);
});

test("break-glass send mode is labelled and acknowledged", () => {
    const script = text(join(venueRoot, "script", "live", "publish-mark.sh"));
    assert.match(script, /TEST\/BREAK-GLASS ONLY/);
    assert.match(script, /bypasses HCS-first production ordering/);
    assert.match(script, /ACKNOWLEDGE_TEST_BREAK_GLASS_HCS_BYPASS/);
});

test("scheduler deployment records reproducible chain bindings", () => {
    const script = text(join(venueRoot, "script", "live", "oracle-scheduler.sh"));
    for (const field of [
        "contractId",
        "runtimeBytecodeHash",
        "immutableMaskedRuntimeBytecodeHash",
        "fundingTransactionHash",
        "fundingTransactions",
        "bindings",
        "supersedes",
    ]) {
        assert.ok(script.includes(field), `missing ${field}`);
    }
    assert.match(script, /runtime != template/);
    assert.match(script, /deployed scheduler oracle binding does not match/);
});
