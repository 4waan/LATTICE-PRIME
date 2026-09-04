/**
 * a design decision sub-question 2 and O7, measured with three distinct parties.
 *
 * First attempt had two design faults and both are worth naming: the fee
 * collector was also the recipient, so the fee returned to the same balance and
 * netted to zero; and the sender was seeded with exactly the first transfer, so
 * every later arm failed on balance rather than on anything interesting. A
 * conserved total is not the same as an informative one.
 *
 * Parties here: SENDER B, RECIPIENT C, COLLECTOR = the treasury. Three
 * different accounts, so no balance change is ambiguous.
 *
 * Run:
 *   HEDERA_KEY="$(cat ~/.hedera-testnet-key)" node spikes/d02-atomicity/fractional-fee.js
 */
const M = "/Users/awaansiddiqui/hedera2026/asset-tokenization-studio/node_modules/@hashgraph/sdk";
const { Client, PrivateKey, AccountId, TokenId, Hbar,
        AccountCreateTransaction, TokenFeeScheduleUpdateTransaction,
        CustomFractionalFee, TransferTransaction } = require(M);
const https = require("https");

const OPERATOR = "0.0.10298158";
const TOKEN = "0.0.10321635";           // GBPY, 2 decimals, fee schedule key set
const NUM = 25, DEN = 10000;            // 25 basis points

const get = p => new Promise((res, rej) => {
  https.get("https://testnet.mirrornode.hedera.com" + p, r => {
    let b = ""; r.on("data", d => b += d);
    r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on("error", rej);
});
const log = (step, o) => console.log(JSON.stringify({ step...o }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function bal(id) {
  const j = await get(`/api/v1/accounts/${id}/tokens?token.id=${TOKEN}`);
  const t = (j.tokens || [])[0];
  return t ? Number(t.balance) : 0;
}

async function main() {
  const raw = (process.env.HEDERA_KEY || "").trim();
  const key = raw.length === 64 || raw.startsWith("0x")
    ? PrivateKey.fromStringECDSA(raw) : PrivateKey.fromStringDer(raw);
  const client = Client.forTestnet().setOperator(AccountId.fromString(OPERATOR), key);
  const tokenId = TokenId.fromString(TOKEN);

  async function newAccount() {
    const k = PrivateKey.generateECDSA();
    const rc = await (await new AccountCreateTransaction()
      .setKeyWithoutAlias(k.publicKey).setInitialBalance(new Hbar(2))
      .setMaxAutomaticTokenAssociations(-1).setMaxTransactionFee(new Hbar(5))
      .execute(client)).getReceipt(client);
    return [rc.accountId.toString(), k];
  }
  const [B, bKey] = await newAccount();
  const [C] = await newAccount();
  log("parties", { sender: B, recipient: C, collector: OPERATOR + " (treasury)" });

  // Seed B generously so no arm can fail on balance.
  await (await new TransferTransaction()
    .addTokenTransfer(tokenId, AccountId.fromString(OPERATOR), -500000)
    .addTokenTransfer(tokenId, AccountId.fromString(B), 500000)
    .setMaxTransactionFee(new Hbar(5)).execute(client)).getReceipt(client);
  await sleep(6000);

  // ---- C1. No fee attached yet. Same measurement, nothing to find.
  let a = { B: await bal(B), C: await bal(C), OP: await bal(OPERATOR) };
  const bClient = Client.forTestnet().setOperator(AccountId.fromString(B), bKey);
  async function send(amt, cl) {
    await (await new TransferTransaction()
      .addTokenTransfer(tokenId, AccountId.fromString(B), -amt)
      .addTokenTransfer(tokenId, AccountId.fromString(C), amt)
      .setMaxTransactionFee(new Hbar(5)).execute(cl)).getReceipt(cl);
    await sleep(6000);
  }
  await send(10000, bClient);
  let z = { B: await bal(B), C: await bal(C), OP: await bal(OPERATOR) };
  log("C1_before_any_fee", {
    sent: 10000, senderDebited: a.B - z.B, recipientCredited: z.C - a.C,
    collectorCredited: z.OP - a.OP,
    pass: (a.B - z.B) === 10000 && (z.C - a.C) === 10000 && (z.OP - a.OP) === 0,
    expected: "recipient gets all of it, collector gets nothing",
  });

  // ---- Attach the fee.
  await (await new TokenFeeScheduleUpdateTransaction().setTokenId(tokenId)
    .setCustomFees([new CustomFractionalFee()
      .setNumerator(NUM).setDenominator(DEN).setMin(0).setMax(0)
      .setFeeCollectorAccountId(AccountId.fromString(OPERATOR))])
    .setMaxTransactionFee(new Hbar(10)).execute(client)).getReceipt(client);
  await sleep(6000);
  const tok = await get("/api/v1/tokens/" + TOKEN);
  const ff = (tok.custom_fees || {}).fractional_fees || [];
  log("fee_attached", {
    bp: (NUM / DEN) * 10000,
    net_of_transfers: ff[0] && ff[0].net_of_transfers,
    all_collectors_are_exempt: ff[0] && ff[0].all_collectors_are_exempt,
    collector_visible_publicly: ff[0] && ff[0].collector_account_id,
  });

  // ---- Rounding. Amounts chosen so the exact fee is a whole number, just above
  // a whole number, just below one, and far below one.
  const rows = [];
  for (const amt of [400000, 10000, 4000, 401, 400, 399, 100, 40, 4, 1]) {
    a = { B: await bal(B), C: await bal(C), OP: await bal(OPERATOR) };
    try { await send(amt, bClient); }
    catch (e) { log("arm_failed", { amt, err: (e.message || "").slice(0, 70) }); continue; }
    z = { B: await bal(B), C: await bal(C), OP: await bal(OPERATOR) };
    const debited = a.B - z.B, credited = z.C - a.C, fee = z.OP - a.OP;
    const exact = (amt * NUM) / DEN;
    rows.push({ amt, exact, fee, credited });
    log("arm", {
      sent: amt, senderDebited: debited, recipientCredited: credited,
      collectorCredited: fee, exactFee: exact,
      rounding: fee === Math.floor(exact) ? "floor" : fee === Math.ceil(exact) ? "ceil" : "other",
      conserved: debited === credited + fee,
    });
  }

  console.log("\n  sent   exact fee   charged   recipient got   shortfall");
  for (const r of rows) {
    console.log("  %s %s %s %s %s",
      String(r.amt).padStart(6), String(r.exact).padStart(11),
      String(r.fee).padStart(9), String(r.credited).padStart(14),
      String(r.amt - r.credited).padStart(11));
  }
  client.close(); bClient.close();
}
main().catch(e => { console.error("FAILED", e.message || e); process.exit(1); });
