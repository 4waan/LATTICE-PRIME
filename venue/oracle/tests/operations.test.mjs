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

test("publisher packaging uses one HTTPS dealer endpoint and isolated keys", () => {
    const config = JSON.parse(text(join(oracleRoot, "config.example.json")));
    assert.deepEqual(config.dealers.endpoints, [
        "https://dealer.example/lattice-prime-quote",
    ]);
    assert.equal(config.pollSeconds, 300);
    assert.equal(config.keepaliveSeconds, 14400);

    const compose = text(join(oracleRoot, "packaging", "compose.example.yaml"));
    for (const profile of ["publisher-a", "publisher-b", "publisher-c"]) {
        assert.match(
            compose,
            new RegExp(`\\.\\./profiles/${profile}\\.json:/config/oracle\\.json:ro`),
        );
    }
    assert.equal((compose.match(/:\/config\/oracle\.json:ro/g) ?? []).length, 3);
    assert.doesNotMatch(compose, /:\/dealer:ro/);
    assert.doesNotMatch(compose, /quotes\//);

    const profiles = ["publisher-a", "publisher-b", "publisher-c"].map((name) => {
        const body = JSON.parse(text(join(oracleRoot, "profiles", `${name}.json`)));
        return {name, profile: body.sourceProfile, endpoints: body.dealers.endpoints};
    });
    assert.deepEqual(profiles.map((row) => row.profile), [
        "publisher-a-primary",
        "publisher-b-primary",
        "publisher-c-primary",
    ]);
    for (const row of profiles) {
        assert.deepEqual(row.endpoints, ["https://dealer.example/lattice-prime-quote"]);
    }

    const publisherEnvironment = text(
        join(oracleRoot, "packaging", "publisher.env.example"),
    );
    const secretNames = [...publisherEnvironment.matchAll(
        /^([A-Z0-9_]*(?:PRIVATE_KEY|MNEMONIC|SECRET))=/gm,
    )].map((match) => match[1]);
    assert.deepEqual(secretNames, ["ORACLE_PUBLISHER_PRIVATE_KEY"]);
    assert.match(publisherEnvironment, /ORACLE_DEALER_ENDPOINT=https:\/\/dealer\.example/);
    assert.doesNotMatch(publisherEnvironment, /ORACLE_PUBLISHER_2_PRIVATE_KEY/);

    assert.match(compose, /user: "node"/);
    assert.match(compose, /read_only: true/);

    const dockerfile = text(join(oracleRoot, "packaging", "Dockerfile.publisher"));
    assert.match(dockerfile, /^USER node$/m);
    assert.match(dockerfile, /ORACLE_STATE_ROOT=\/state/);
    assert.match(dockerfile, /\/healthz/);
    assert.match(dockerfile, /chown -R node:node \/state/);
    assert.match(dockerfile, /chmod -R a-w \/srv\/venue\/oracle/);

    const flyApps = [];
    const publisherIds = [];
    const sourceProfiles = [];
    for (const name of ["publisher-a", "publisher-b", "publisher-c"]) {
        const fly = text(join(oracleRoot, "packaging", `fly.${name}.toml`));
        assert.match(fly, new RegExp(`app = "lattice-oracle-${name}"`));
        assert.match(fly, new RegExp(`ORACLE_PUBLISHER_ID = "${name}"`));
        assert.match(fly, new RegExp(`ORACLE_SOURCE_PROFILE = "${name}-primary"`));
        assert.match(fly, /auto_stop_machines = "off"/);
        assert.match(fly, /auto_start_machines = true/);
        assert.match(fly, /min_machines_running = 1/);
        assert.match(fly, /memory = "512mb"/);
        assert.match(fly, /destination = "\/state"/);
        assert.match(fly, /initial_size = "1gb"/);
        assert.match(fly, /snapshot_retention = 14/);
        assert.match(fly, /path = "\/healthz"/);
        assert.match(fly, /policy = "always"/);
        assert.doesNotMatch(fly, /PRIVATE_KEY/);
        flyApps.push(fly);
        publisherIds.push(fly.match(/ORACLE_PUBLISHER_ID = "([^"]+)"/)[1]);
        sourceProfiles.push(fly.match(/ORACLE_SOURCE_PROFILE = "([^"]+)"/)[1]);
    }
    assert.equal(new Set(flyApps).size, 3);
    assert.deepEqual(publisherIds, ["publisher-a", "publisher-b", "publisher-c"]);
    assert.deepEqual(sourceProfiles, [
        "publisher-a-primary",
        "publisher-b-primary",
        "publisher-c-primary",
    ]);
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
