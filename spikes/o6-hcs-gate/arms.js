/**
 * O6, the two ways "forceable" could be the wrong word.
 *
 * The first run proved the gate: a topic whose submit key is a contract id
 * refuses our own key with INVALID_SIGNATURE, and the message lands the moment
 * the contract calls authorizeSchedule. That establishes the contract is a
 * NECESSARY signer. It does not establish the coupling the claim needs.
 *
 * The design is that the contract releases the disclosure secret in the same
 * call that authorises the record. Two failure modes break that:
 *
 *   ARM A  the call reverts after authorising. If the message still lands, the
 *          record and the release are not the same event, and records get
 *          written for disclosures that never happened. Not fatal, but the
 *          claim would have to be worded the other way round.
 *
 *   ARM B  the call succeeds, the secret is released, and the scheduled record
 *          then fails for its own reasons. This is the dangerous direction: a
 *          disclosure with no audit trail. It matters whether authorizeSchedule
 *          reports that failure, because if it cannot, the contract has no way
 *          to condition release on the record actually landing.
 *
 * Run:
 *   HEDERA_KEY="$(cat ~/.hedera-testnet-key)" node spikes/o6-hcs-gate/arms.js <probeEvm>
 */
const M = "/Users/awaansiddiqui/hedera2026/asset-tokenization-studio/node_modules/@hashgraph/sdk";
const { Client, PrivateKey, AccountId, ContractId, Hbar, TopicCreateTransaction,
        TopicMessageSubmitTransaction, TopicDeleteTransaction, ScheduleCreateTransaction,
        ContractExecuteTransaction, ContractFunctionParameters } = require(M);
const https = require("https");
const OPERATOR = "0.0.10298158";
const log = (s,o)=>console.log(JSON.stringify({step:s...o}));
const sleep = ms=>new Promise(r=>setTimeout(r,ms));
const get = p=>new Promise((res,rej)=>{https.get("https://testnet.mirrornode.hedera.com"+p,r=>{
  let b="";r.on("data",d=>b+=d);r.on("end",()=>{try{res(JSON.parse(b))}catch(e){rej(e)}});}).on("error",rej);});

async function main(){
  const probeEvm=process.argv[2];
  const raw=(process.env.HEDERA_KEY||"").trim();
  const key=raw.length===64||raw.startsWith("0x")?PrivateKey.fromStringECDSA(raw):PrivateKey.fromStringDer(raw);
  const client=Client.forTestnet().setOperator(AccountId.fromString(OPERATOR),key);
  const probeId=ContractId.fromEvmAddress(0,0,probeEvm);

  async function newTopic(memo){
    const r=await (await new TopicCreateTransaction().setTopicMemo(memo)
      .setAdminKey(key.publicKey).setSubmitKey(probeId)
      .setMaxTransactionFee(new Hbar(5)).execute(client)).getReceipt(client);
    return r.topicId;
  }
  async function schedule(topicId,msg){
    const r=await (await new ScheduleCreateTransaction()
      .setScheduledTransaction(new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(msg))
      .setPayerAccountId(AccountId.fromString(OPERATOR))
      .setMaxTransactionFee(new Hbar(10)).execute(client)).getReceipt(client);
    const id=r.scheduleId;
    return [id, "0x"+Number(id.num.toString()).toString(16).padStart(40,"0")];
  }
  async function callProbe(fn,schedEvm){
    try{
      const r=await (await new ContractExecuteTransaction().setContractId(probeId).setGas(1_000_000)
        .setFunction(fn,new ContractFunctionParameters().addAddress(schedEvm))
        .setMaxTransactionFee(new Hbar(10)).execute(client)).getReceipt(client);
      return r.status.toString();
    }catch(e){ return e.status?e.status.toString():(e.message||"").slice(0,70); }
  }
  async function count(t){ const j=await get(`/api/v1/topics/${t}/messages`); return (j.messages||[]).length; }

  // ---- C0. Repeat the known-good path on a fresh topic. If this does not land,
  // the arms below are measuring a broken rig rather than a coupling.
  const t0=await newTopic("O6 C0 control");
  const [,s0]=await schedule(t0,"control record");
  const st0=await callProbe("authorize",s0);
  await sleep(8000);
  log("C0_known_good",{topic:t0.toString(),call:st0,messages:await count(t0),
      pass:(await count(t0))===1,expected:"1 message"});

  // ---- ARM A. Authorise, then revert.
  const tA=await newTopic("O6 arm A");
  const [,sA]=await schedule(tA,"record from a call that reverted");
  const stA=await callProbe("authorizeThenRevert",sA);
  await sleep(8000);
  const nA=await count(tA);
  log("ARM_A_authorize_then_revert",{topic:tA.toString(),call:stA,messages:nA,
      verdict:nA===0?"COUPLED. The revert took the record with it."
                    :"NOT COUPLED. The record survived the revert."});

  // ---- ARM B. The record cannot succeed: delete the topic first.
  const tB=await newTopic("O6 arm B");
  const [,sB]=await schedule(tB,"record that cannot land");
  await (await new TopicDeleteTransaction().setTopicId(tB)
    .setMaxTransactionFee(new Hbar(5)).execute(client)).getReceipt(client);
  log("arm_B_topic_deleted",{topic:tB.toString()});
  const stB=await callProbe("authorizeAndReport",sB);
  await sleep(8000);
  log("ARM_B_record_cannot_land",{topic:tB.toString(),call:stB,
      verdict:stB==="SUCCESS"
        ? "BLIND. authorizeSchedule reported success for a record that cannot land."
        : "REPORTED. The contract can see the failure and refuse release."});
  client.close();
}
main().catch(e=>{console.error("FAILED",e.status?e.status.toString():(e.message||e));process.exit(1);});
