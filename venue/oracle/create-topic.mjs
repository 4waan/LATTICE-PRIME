import {
    Hbar,
    PrivateKey,
    TopicCreateTransaction,
    TopicInfoQuery,
} from "@hiero-ledger/sdk";
import {existsSync, mkdirSync, writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {loadOracleConfig, loadPublisherIdentity} from "./lib/config.mjs";
import {hederaClient} from "./lib/evidence.mjs";

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
    const index = args.indexOf(flag);
    return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const config = loadOracleConfig(value("--config") ?? undefined, {allowExample: true});
const identity = loadPublisherIdentity(config, process.env, {requireTopic: false});
const output = resolve(value(
    "--output",
    `oracle/deployments/topics/${identity.profile}.json`,
));
if (existsSync(output)) {
    throw new Error(`${output} already exists; refusing to split this publisher across topics`);
}

const rawKey = identity.wallet.privateKey.replace(/^0x/, "");
const sdkKey = PrivateKey.fromStringECDSA(rawKey);
const memo = `${config.evidence?.topicMemo ?? "lattice-prime oracle evidence"} ${identity.profile}`;
if (Buffer.byteLength(memo, "utf8") > 100) throw new Error("topic memo exceeds 100 bytes");
const client = hederaClient({
    chainId: config.chainId,
    accountId: identity.accountId,
    privateKey: rawKey,
});

try {
    const transaction = await new TopicCreateTransaction()
        .setTopicMemo(memo)
        .setSubmitKey(sdkKey.publicKey)
        .setMaxTransactionFee(new Hbar(5))
        .execute(client);
    const receipt = await transaction.getReceipt(client);
    const topicId = receipt.topicId;
    if (!topicId) throw new Error("topic creation returned no topic ID");
    const info = await new TopicInfoQuery().setTopicId(topicId).execute(client);
    if (info.adminKey) throw new Error("created topic unexpectedly has an admin key");
    if (info.submitKey?.toString() !== sdkKey.publicKey.toString()) {
        throw new Error("created topic submit key does not match publisher key");
    }
    const record = {
        schema: "lattice.oracle.topic.v1",
        createdAt: new Date().toISOString(),
        network: config.network,
        chainId: config.chainId,
        topicId: topicId.toString(),
        memo,
        publisher: {
            profile: identity.profile,
            accountId: identity.accountId,
            evmAddress: identity.address,
            publicKey: sdkKey.publicKey.toString(),
        },
        keys: {
            adminKey: null,
            submitKey: sdkKey.publicKey.toString(),
        },
        transactionId: transaction.transactionId.toString(),
    };
    mkdirSync(dirname(output), {recursive: true});
    writeFileSync(output, JSON.stringify(record, null, 2) + "\n");
    console.log(JSON.stringify({
        created: true,
        topicId: record.topicId,
        publisher: identity.address,
        record: output,
    }));
} finally {
    client.close();
}
