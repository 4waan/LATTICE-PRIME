/**
 * O6: is the HCS disclosure record forceable, or merely customary.
 *
 * a design decision puts every supervisor disclosure on HCS. O6 is the objection that if the
 * discloser can act without writing the record, the audit trail is decoration.
 * The construction under test: make the topic's SUBMIT KEY a contract id, so
 * nothing reaches the topic unless the contract authorises it (HIP-755).
 *
 * Controls, and both are needed:
 *   C1  submit to the topic with our own key, unauthorised. MUST FAIL. If it
 *       succeeds the submit key is not gating anything and C2 proves nothing.
 *   C2  the same submit, scheduled, after the contract calls authorizeSchedule.
 *       MUST land on the topic.
 *
 * Run:
 *   HEDERA_KEY="$(cat ~/.hedera-testnet-key)" node spikes/o6-hcs-gate/gate.js <probeEvmAddress>
 */
const M = "/Users/awaansiddiqui/hedera2026/asset-tokenization-studio/node_modules/@hashgraph/sdk";
const { Client, PrivateKey, AccountId, ContractId, Hbar, TopicCreateTransaction,
        TopicMessageSubmitTransaction, ScheduleCreateTransaction,
        ContractExecuteTransaction, ContractFunctionParameters } = require(M);
const https = require("https");
const OPERATOR = "0.0.10298158";
const log = (s,o) => console.log(JSON.stringify({ step: s...o }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res,rej)=>{https.get("https://testnet.mirrornode.hedera.com"+p,r=>{
  let b="";r.on("data",d=>b+=d);r.on("end",()=>{try{res(JSON.parse(b))}catch(e){rej(e)}});}).on("error",rej);});

async function main() {
  const probeEvm = process.argv[2];
  if (!probeEvm) { console.error("pass the probe contract EVM address"); process.exit(1); }
  const raw = (process.env.HEDERA_KEY||"").trim();
  const key = raw.length===64||raw.startsWith("0x") ? PrivateKey.fromStringECDSA(raw) : PrivateKey.fromStringDer(raw);
  const client = Client.forTestnet().setOperator(AccountId.fromString(OPERATOR), key);
  const probeId = ContractId.fromEvmAddress(0, 0, probeEvm);
  log("probe", { evm: probeEvm, contractId: probeId.toString() });

  // Topic whose submit key IS the contract. Nothing else can publish to it.
  const t = await (await new TopicCreateTransaction()
    .setTopicMemo("O6 disclosure gate")
    .setAdminKey(key.publicKey)
    .setSubmitKey(probeId)
    .setMaxTransactionFee(new Hbar(5)).execute(client)).getReceipt(client);
  const topic = t.topicId.toString();
  log("topic_created", { topic, submitKey: "ContractId " + probeId.toString() });

  // ---- C1. Try to publish with our own key. This must be refused.
  let c1 = "SUCCEEDED";
  try {
    await (await new TopicMessageSubmitTransaction()
      .setTopicId(t.topicId).setMessage("unauthorised disclosure")
      .setMaxTransactionFee(new Hbar(5)).execute(client)).getReceipt(client);
  } catch (e) { c1 = (e.status ? e.status.toString() : (e.message||"").slice(0,60)); }
  log("C1_unauthorised_submit", { result: c1, pass: c1 !== "SUCCEEDED",
      expected: "refused, the contract is the only permitted submitter" });

  // ---- Schedule the same submit, then let the contract authorise it.
  const inner = new TopicMessageSubmitTransaction()
    .setTopicId(t.topicId).setMessage("disclosure record, contract authorised");
  const sc = await (await new ScheduleCreateTransaction()
    .setScheduledTransaction(inner)
    .setPayerAccountId(AccountId.fromString(OPERATOR))
    .setMaxTransactionFee(new Hbar(10)).execute(client)).getReceipt(client);
  const schedule = sc.scheduleId;
  const schedEvm = "0x" + Number(schedule.num.toString()).toString(16).padStart(40, "0");
  log("schedule_created", { schedule: schedule.toString(), evm: schedEvm });

  let before = await get(`/api/v1/topics/${topic}/messages`);
  log("topic_before_authorize", { messages: (before.messages||[]).length, expected: 0 });

  const rc = await (await new ContractExecuteTransaction()
    .setContractId(probeId).setGas(1_000_000)
    .setFunction("authorize", new ContractFunctionParameters().addAddress(schedEvm))
    .setMaxTransactionFee(new Hbar(10)).execute(client)).getReceipt(client);
  log("authorize_called", { status: rc.status.toString() });

  await sleep(8000);
  const after = await get(`/api/v1/topics/${topic}/messages`);
  const msgs = (after.messages||[]).map(m => Buffer.from(m.message,"base64").toString());
  log("topic_after_authorize", {
    messages: msgs.length, contents: msgs,
    verdict: msgs.length > 0
      ? "FORCEABLE. The contract is the gate on the audit record."
      : "not observed, the message did not land",
  });
  client.close();
}
main().catch(e => { console.error("FAILED", e.status ? e.status.toString() : (e.message||e)); process.exit(1); });
