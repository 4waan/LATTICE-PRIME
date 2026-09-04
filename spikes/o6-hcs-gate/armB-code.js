/**
 * Arm B gave the right outcome for a reason I had not measured. The call
 * reverted, but the revert came from my own `if (code != 22) revert` guard, and
 * an authorizeSchedule that reverted on its own would produce the same visible
 * result. The two need different contract code, so the distinction matters:
 *
 *   returns a code  -> the contract can catch it, decide, and refuse release
 *   reverts         -> fail closed only, no branch available
 *
 * Same setup, but calling `authorize`, which does NOT revert on a bad code, and
 * reading the int64 it actually returned out of the emitted event.
 */
const M = "/Users/awaansiddiqui/hedera2026/asset-tokenization-studio/node_modules/@hashgraph/sdk";
const { Client, PrivateKey, AccountId, ContractId, Hbar, TopicCreateTransaction,
        TopicMessageSubmitTransaction, TopicDeleteTransaction, ScheduleCreateTransaction,
        ContractExecuteTransaction, ContractFunctionParameters } = require(M);
const https=require("https");
const OPERATOR="0.0.10298158";
const log=(s,o)=>console.log(JSON.stringify({step:s...o}));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const get=p=>new Promise((res,rej)=>{https.get("https://testnet.mirrornode.hedera.com"+p,r=>{
  let b="";r.on("data",d=>b+=d);r.on("end",()=>{try{res(JSON.parse(b))}catch(e){rej(e)}});}).on("error",rej);});

async function main(){
  const probeEvm=process.argv[2];
  const raw=(process.env.HEDERA_KEY||"").trim();
  const key=raw.length===64||raw.startsWith("0x")?PrivateKey.fromStringECDSA(raw):PrivateKey.fromStringDer(raw);
  const client=Client.forTestnet().setOperator(AccountId.fromString(OPERATOR),key);
  const probeId=ContractId.fromEvmAddress(0,0,probeEvm);

  const t=await (await new TopicCreateTransaction().setTopicMemo("O6 armB code")
    .setAdminKey(key.publicKey).setSubmitKey(probeId)
    .setMaxTransactionFee(new Hbar(5)).execute(client)).getReceipt(client);
  const sc=await (await new ScheduleCreateTransaction()
    .setScheduledTransaction(new TopicMessageSubmitTransaction().setTopicId(t.topicId).setMessage("x"))
    .setPayerAccountId(AccountId.fromString(OPERATOR))
    .setMaxTransactionFee(new Hbar(10)).execute(client)).getReceipt(client);
  const schedEvm="0x"+Number(sc.scheduleId.num.toString()).toString(16).padStart(40,"0");
  await (await new TopicDeleteTransaction().setTopicId(t.topicId)
    .setMaxTransactionFee(new Hbar(5)).execute(client)).getReceipt(client);
  log("setup",{topic:t.topicId.toString(),schedule:sc.scheduleId.toString(),topicDeleted:true});

  let status,code=null,raw2=null;
  try{
    const tx=await new ContractExecuteTransaction().setContractId(probeId).setGas(1_000_000)
      .setFunction("authorize",new ContractFunctionParameters().addAddress(schedEvm))
      .setMaxTransactionFee(new Hbar(10)).execute(client);
    const rec=await tx.getReceipt(client); status=rec.status.toString();
    await sleep(7000);
    const r=await get("/api/v1/contracts/results/"+tx.transactionId.toString()
      .replace("@",".").replace(/\./g,"-").replace(/-(\d+)-(\d+)$/,"-$1-$2"));
    raw2=r && r.call_result;
  }catch(e){ status=e.status?e.status.toString():(e.message||"").slice(0,80); }

  await sleep(5000);
  const res=await get("/api/v1/contracts/"+probeEvm+"/results?limit=1&order=desc");
  const last=(res.results||[])[0];
  if(last){
    const d=await get("/api/v1/contracts/results/"+last.hash);
    raw2=d.call_result;
    if(raw2 && raw2!=="0x") code=BigInt.asIntN(64,BigInt("0x"+raw2.slice(2).slice(-16)));
    log("result",{status,call_result:raw2,errorMessage:d.error_message,
                  decodedInt64:code!==null?code.toString():null});
  } else log("result",{status,note:"no contract result found"});

  log("verdict",{
    interpretation: code===null
      ? "authorizeSchedule REVERTED. Fail closed, but no branch for the contract."
      : (code.toString()==="22"
         ? "returned SUCCESS for a record that cannot land. BLIND."
         : "returned code "+code+", a value the contract can branch on."),
  });
  client.close();
}
main().catch(e=>{console.error("FAILED",e.status?e.status.toString():(e.message||e));process.exit(1);});
