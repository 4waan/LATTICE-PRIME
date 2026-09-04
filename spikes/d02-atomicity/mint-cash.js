/**
 * a design decision step 2, part 1: mint the cash leg as an HTS fungible token.
 *
 * Separate from the atomicity test so the token survives a failed run and the
 * expensive half is not repeated. Prints the token id and its EVM address.
 *
 * Run:
 *   HEDERA_KEY="$(cat ~/.hedera-testnet-key)" node spikes/d02-atomicity/mint-cash.js
 */
const M = "/Users/awaansiddiqui/hedera2026/asset-tokenization-studio/node_modules/@hashgraph/sdk";
const { Client, PrivateKey, AccountId, TokenCreateTransaction, TokenType,
        TokenSupplyType, Hbar } = require(M);

const OPERATOR = "0.0.10298158";

async function main() {
  const raw = (process.env.HEDERA_KEY || "").trim();
  if (!raw) { console.error("set HEDERA_KEY"); process.exit(1); }
  const key = raw.length === 64 || raw.startsWith("0x")
    ? PrivateKey.fromStringECDSA(raw) : PrivateKey.fromStringDer(raw);

  const client = Client.forTestnet().setOperator(AccountId.fromString(OPERATOR), key);

  const tx = await new TokenCreateTransaction()
    .setTokenName("Repo Cash Leg")
    .setTokenSymbol("GBPY")
    .setTokenType(TokenType.FungibleCommon)
    .setDecimals(2)
    .setInitialSupply(1000000)          // 10,000.00
    .setTreasuryAccountId(AccountId.fromString(OPERATOR))
    .setSupplyType(TokenSupplyType.Infinite)
    .setSupplyKey(key.publicKey)
    .setAdminKey(key.publicKey)
    // Without this at CREATION, custom fees can never be attached:
    // TokenFeeScheduleUpdate returns TOKEN_HAS_NO_FEE_SCHEDULE_KEY and
    // there is no way to add the key later. Measured .
    .setFeeScheduleKey(key.publicKey)
    .setMaxTransactionFee(new Hbar(40))
    .execute(client);

  const rc = await tx.getReceipt(client);
  const id = rc.tokenId;
  const num = Number(id.num.toString());
  console.log(JSON.stringify({
    step: "token_created",
    status: rc.status.toString(),
    tokenId: id.toString(),
    evm: "0x" + num.toString(16).padStart(40, "0"),
  }));
  client.close();
}
main().catch((e) => { console.error("FAILED", e.message || e); process.exit(1); });
