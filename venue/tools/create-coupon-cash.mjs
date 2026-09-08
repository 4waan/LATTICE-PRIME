// Creates the HTS cash token used by CouponDistributor. This is deliberately a
// native Hedera transaction: the fee schedule is ledger state, not EVM token
// bookkeeping. It prints a single JSON record suitable for deployments/.
//
// Required environment: HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY.
import {
    AccountId,
    Client,
    CustomFractionalFee,
    FeeAssessmentMethod,
    Hbar,
    PrivateKey,
    TokenCreateTransaction,
    TokenSupplyType,
    TokenType,
} from "@hiero-ledger/sdk";
import {env} from "./hcs-chain.mjs";

const local = env(["HEDERA_ACCOUNT_ID", "HEDERA_PRIVATE_KEY"]);

const required = (name) => {
    const value = (process.env[name] || local[name] || "").trim();
    if (!value) throw new Error(`set ${name}`);
    return value;
};

const parseKey = (raw) => {
    const bare = raw.startsWith("0x") ? raw.slice(2) : raw;
    return bare.length === 64
        ? PrivateKey.fromStringECDSA(raw)
        : PrivateKey.fromStringDer(raw);
};

const accountId = AccountId.fromString(required("HEDERA_ACCOUNT_ID"));
const key = parseKey(required("HEDERA_PRIVATE_KEY"));
const client = Client.forTestnet().setOperator(accountId, key);

try {
    const fee = new CustomFractionalFee()
        .setNumerator(25)
        .setDenominator(10_000)
        .setMin(1)
        .setMax(0)
        .setAssessmentMethod(FeeAssessmentMethod.Inclusive)
        .setFeeCollectorAccountId(accountId)
        .setAllCollectorsAreExempt(false);

    const response = await new TokenCreateTransaction()
        .setTokenName("Lattice Prime Coupon Cash")
        .setTokenSymbol("LPCASH")
        .setTokenMemo("USD demo cash for Lattice Prime coupons")
        .setTokenType(TokenType.FungibleCommon)
        .setDecimals(2)
        .setInitialSupply(100_000_000)
        .setTreasuryAccountId(accountId)
        .setSupplyType(TokenSupplyType.Infinite)
        .setSupplyKey(key.publicKey)
        .setAutoRenewAccountId(accountId)
        .setCustomFees([fee])
        .setMaxTransactionFee(new Hbar(40))
        .execute(client);

    const receipt = await response.getReceipt(client);
    const tokenId = receipt.tokenId;
    if (!tokenId) throw new Error("token creation succeeded without a token id");
    if (tokenId.shard.toString() !== "0" || tokenId.realm.toString() !== "0") {
        throw new Error(`cannot derive an EVM address for token ${tokenId}`);
    }
    const evmAddress = "0x" + BigInt(tokenId.num.toString()).toString(16).padStart(40, "0");

    console.log(JSON.stringify({
        status: receipt.status.toString(),
        tokenId: tokenId.toString(),
        evmAddress,
        transactionId: response.transactionId.toString(),
        transactionHash: `0x${Buffer.from(response.transactionHash).toString("hex")}`,
        name: "Lattice Prime Coupon Cash",
        symbol: "LPCASH",
        decimals: 2,
        initialSupply: "100000000",
        treasury: accountId.toString(),
        fee: {
            numerator: 25,
            denominator: 10_000,
            minimum: 1,
            maximum: 0,
            netOfTransfers: false,
            collector: accountId.toString(),
        },
    }));
} finally {
    client.close();
}
