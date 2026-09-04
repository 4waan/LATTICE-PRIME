/**
 * Two follow-ups the rounding table demands.
 *
 * 1. My "C1_before_any_fee" arm was mislabelled: the fee had already been
 *    attached to this token by the previous run, so that row measured the
 *    post-fee state and its 9975/25 split is a confirmation, not a baseline.
 *    The real baseline has to come from a token that has no fee and cannot get
 *    one: GBPX 0.0.10321401, which was created without a fee schedule key.
 *
 * 2. Fee is floor(amount * 25/10000) with min 0, so 399 units moved for
 *    nothing. If that holds, the fee is avoidable by fragmenting a transfer and
 *    the mitigation is a nonzero minimum. Test whether setMin(1) closes it.
 */
const M = "/Users/awaansiddiqui/hedera2026/asset-tokenization-studio/node_modules/@hashgraph/sdk";
const { Client, PrivateKey, AccountId, TokenId, Hbar, AccountCreateTransaction,
        TokenFeeScheduleUpdateTransaction, CustomFractionalFee, TransferTransaction } = require(M);
const https = require("https");
const OPERATOR = "0.0.10298158";
const NOFEE = "0.0.10321401";   // GBPX, no fee schedule key, can never have fees
const FEED  = "0.0.10321635";   // GBPY, 25 bp attached
const get = p => new Promise((res, rej) => { https.get("https://testnet.mirrornode.hedera.com"+p, r => {
  let b=""; r.on("data",d=>b+=d); r.on("end",()=>{try{res(JSON.parse(b))}catch(e){rej(e)}}); }).on("error",rej); });
const log=(s,o)=>console.log(JSON.stringify({step:s...o}));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function bal(id,tok){const j=await get(`/api/v1/accounts/${id}/tokens?token.id=${tok}`);
  const t=(j.tokens||[])[0]; return t?Number(t.balance):0;}

async function main(){
  const raw=(process.env.HEDERA_KEY||"").trim();
  const key=raw.length===64||raw.startsWith("0x")?PrivateKey.fromStringECDSA(raw):PrivateKey.fromStringDer(raw);
  const client=Client.forTestnet().setOperator(AccountId.fromString(OPERATOR),key);

  const k=PrivateKey.generateECDSA();
  const rc=await (await new AccountCreateTransaction().setKeyWithoutAlias(k.publicKey)
    .setInitialBalance(new Hbar(3)).setMaxAutomaticTokenAssociations(-1)
    .setMaxTransactionFee(new Hbar(5)).execute(client)).getReceipt(client);
  const B=rc.accountId.toString();
  const k2=PrivateKey.generateECDSA();
  const rc2=await (await new AccountCreateTransaction().setKeyWithoutAlias(k2.publicKey)
    .setInitialBalance(new Hbar(1)).setMaxAutomaticTokenAssociations(-1)
    .setMaxTransactionFee(new Hbar(5)).execute(client)).getReceipt(client);
  const C=rc2.accountId.toString();
  const bClient=Client.forTestnet().setOperator(AccountId.fromString(B),k);
  log("parties",{sender:B,recipient:C});

  async function seed(tok,amt){
    await (await new TransferTransaction()
      .addTokenTransfer(TokenId.fromString(tok),AccountId.fromString(OPERATOR),-amt)
      .addTokenTransfer(TokenId.fromString(tok),AccountId.fromString(B),amt)
      .setMaxTransactionFee(new Hbar(5)).execute(client)).getReceipt(client);
    await sleep(6000);
  }
  async function arm(tok,amt,label){
    const a={B:await bal(B,tok),C:await bal(C,tok),OP:await bal(OPERATOR,tok)};
    try{
      await (await new TransferTransaction()
        .addTokenTransfer(TokenId.fromString(tok),AccountId.fromString(B),-amt)
        .addTokenTransfer(TokenId.fromString(tok),AccountId.fromString(C),amt)
        .setMaxTransactionFee(new Hbar(5)).execute(bClient)).getReceipt(bClient);
    }catch(e){log("arm_failed",{label,amt,err:(e.message||"").slice(0,70)});return;}
    await sleep(6000);
    const z={B:await bal(B,tok),C:await bal(C,tok),OP:await bal(OPERATOR,tok)};
    log("arm",{label,sent:amt,senderDebited:a.B-z.B,recipientCredited:z.C-a.C,
               collectorCredited:z.OP-a.OP,conserved:(a.B-z.B)===(z.C-a.C)+(z.OP-a.OP)});
  }

  // 1. True baseline: a token that has no fee and structurally cannot.
  await seed(NOFEE,5000);
  await arm(NOFEE,399,"BASELINE no-fee token, 399");
  await arm(NOFEE,4000,"BASELINE no-fee token, 4000");

  // 2. The gap, restated on the fee token for comparison.
  await seed(FEED,400000);
  await arm(FEED,399,"25bp min=0, 399 (below threshold)");
  await arm(FEED,400,"25bp min=0, 400 (at threshold)");

  // 3. Does a nonzero minimum close it?
  await (await new TokenFeeScheduleUpdateTransaction().setTokenId(TokenId.fromString(FEED))
    .setCustomFees([new CustomFractionalFee().setNumerator(25).setDenominator(10000)
      .setMin(1).setMax(0).setFeeCollectorAccountId(AccountId.fromString(OPERATOR))])
    .setMaxTransactionFee(new Hbar(10)).execute(client)).getReceipt(client);
  await sleep(6000);
  const t=await get("/api/v1/tokens/"+FEED);
  log("fee_min_set_to_1",{minimum:t.custom_fees.fractional_fees[0].minimum});
  await arm(FEED,399,"25bp min=1, 399");
  await arm(FEED,1,  "25bp min=1, 1 unit");
  await arm(FEED,4000,"25bp min=1, 4000 (min must not override)");
  client.close(); bClient.close();
}
main().catch(e=>{console.error("FAILED",e.message||e);process.exit(1);});
