import {test} from "node:test";
import assert from "node:assert/strict";
import {loadPublisherIdentity} from "../lib/config.mjs";

const testOnlyPublisherKey = "0x" + "31".repeat(32);
const config = {evidence: {topicId: "0.0.7001"}};

function publisherEnvironment(extra = {}) {
    return {
        ORACLE_PUBLISHER_ID: "publisher-a",
        ORACLE_PUBLISHER_ACCOUNT_ID: "0.0.5001",
        ORACLE_PUBLISHER_PRIVATE_KEY: testOnlyPublisherKey,
        ...extra,
    };
}

test("publisher accepts exactly its one designated private key", () => {
    const identity = loadPublisherIdentity(config, publisherEnvironment());
    assert.equal(identity.profile, "publisher-a");
});

test("publisher rejects inherited key, mnemonic, and secret aliases", async (context) => {
    const aliases = [
        "SELLER_PRIVATE_KEY",
        "BUYER_KEY",
        "BOT_7_PRIVATE_KEY",
        "DEALER_QUOTE_PRIVATE_KEY",
        "HEDERA_OPERATOR_KEY",
        "HEDERA_MNEMONIC",
        "SERVICE_SECRET",
        "SERVICE_API_KEY",
    ];
    for (const name of aliases) {
        await context.test(name, () => {
            const marker = `test-only-${name.toLowerCase()}`;
            assert.throws(
                () => loadPublisherIdentity(config, publisherEnvironment({[name]: marker})),
                (error) =>
                    error.code === "MULTI_KEY_ENV"
                    && error.message.includes(name)
                    && !error.message.includes(marker),
            );
        });
    }
});

test("invalid publisher key errors never repeat key material", () => {
    const invalid = "test-only-invalid-key-material";
    assert.throws(
        () => loadPublisherIdentity(
            config,
            publisherEnvironment({ORACLE_PUBLISHER_PRIVATE_KEY: invalid}),
        ),
        (error) => error.code === "BAD_PRIVATE_KEY" && !error.message.includes(invalid),
    );
});
