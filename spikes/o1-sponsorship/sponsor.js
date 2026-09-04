/**
 * O1 / an earlier measurement: can a nullifier be registered from an address that was never funded?
 *
 * an earlier measurement says the registration transaction binds the nullifier to an address with
 * a funding history, and calls that "possibly fatal to the privacy claim". That is
 * true on a chain where the signer must pay. HIP-410 says Hedera is not that chain:
 *
 *   "When the Hedera charged fees exceeds the sender authorized fees then the
 *    relay must make up the difference and will pay HBAR for the transaction."
 *
 * Sender authorized fees are gasLimit * gasPrice. Set gasPrice to 0 and they are
 * zero, so the relay must pay all of it. This script tests whether the network
 * actually behaves that way, because a spec sentence is not a measurement.
 *
 * Two arms, because the interesting failure is between them:
 *   A  virgin key, no Hedera account at all. HIP-410 line 405 says the sender is
 *      resolved to "the account whose alias has the same Ethereum address", so
 *      this should FAIL. If it succeeds, no account creation is needed at all and
 *      the privacy answer is even better than expected.
 *   B  same key after a hollow account is created for it by a dust transfer.
 *      Should SUCCEED with the signer debited exactly zero.
 *
 * The measurement in both arms is the mirror node transfer list, not the SDK
 * receipt, because only the transfer list says who actually paid.
 *
 * Controls:
 *   C1  a self-paid EthereumTransaction from the operator, gasPrice > 0. Known
 *       answer: the signer is debited. If arm B and C1 report the same thing the
 *       script is not measuring what it claims.
 *   C2  the virgin address is queried before use and must be absent. If the
 *       mirror node already knows it, the key is not virgin and arm A is void.
 *
 * Reads the operator key from $HEDERA_KEY. Never writes it anywhere.
 * Testnet only.
 */
const path = require("path");
const R = (m) => require(path.join(__dirname, "../../asset-tokenization-studio/node_modules", m));
const { Client, PrivateKey, AccountId, EthereumTransaction, TransferTransaction,
        Hbar, FileCreateTransaction, FileAppendTransaction } = R("@hashgraph/sdk");
const ethers = R("ethers");

const MIRROR = "https://testnet.mirrornode.hedera.com";
const CHAIN_ID = 296;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const https = require("https");
function mirror(p) {                       // node 16 has no global fetch
  return new Promise((resolve) => {
    https.get(MIRROR + p, { headers: { accept: "application/json" } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve({ __status: res.statusCode });
        try { resolve(JSON.parse(b)); } catch (e) { resolve({ __status: -1 }); }
      });
    }).on("error", () => resolve({ __status: -2 }));
  });
}

async function txRecord(txId, tries = 12) {
  // "0.0.X@sec.nanos" as the SDK renders it, "0.0.X-sec-nanos" as the REST API wants
  const norm = txId.toString().replace("@", "-").replace(/\.(\d+)$/, "-$1");
  for (let i = 0; i < tries; i++) {
    const j = await mirror(`/api/v1/transactions/${norm}`);
    if (j && j.transactions && j.transactions.length) return j.transactions;
    await sleep(2500);
  }
  return null;
}

function debitOf(tx, acct) {
  const t = (tx.transfers || []).find((x) => x.account === acct);
  return t ? -t.amount : 0;
}

function report(label, txs, relayId, signerId) {
  const tx = txs.find((t) => t.name === "ETHEREUMTRANSACTION") || txs[0];
  const relayPaid = debitOf(tx, relayId);
  const signerPaid = signerId ? debitOf(tx, signerId) : null;
  console.log(`    result            ${tx.result}`);
  console.log(`    charged_tx_fee    ${tx.charged_tx_fee} tinybar`);
  console.log(`    relay  ${relayId} debited ${relayPaid}`);
  console.log(`    signer ${signerId || "(no account)"} debited ${signerPaid}`);
  const sponsored = relayPaid > 0 && signerPaid === 0;
  console.log(`    => ${sponsored ? "SPONSORED, signer paid nothing" : "signer bore cost or relay paid nothing"}`);
  return { sponsored, relayPaid, signerPaid, result: tx.result };
}

async function submit(client, relayId, signedRlp, allowanceHbar, label) {
  const bytes = ethers.getBytes(signedRlp);
  let tx = new EthereumTransaction().setEthereumData(bytes).setMaxTransactionFee(new Hbar(20));
  if (allowanceHbar > 0) tx = tx.setMaxGasAllowanceHbar(new Hbar(allowanceHbar));
  try {
    const resp = await tx.execute(client);
    try { await resp.getReceipt(client); } catch (e) { console.log(`    receipt: ${e.status || e.message}`); }
    return resp.transactionId;
  } catch (e) {
    console.log(`    SUBMIT REJECTED: ${e.status ? e.status.toString() : e.message}`);
    return null;
  }
}

(async () => {
  const raw = (process.env.HEDERA_KEY || "").trim();
  if (!raw) { console.error("set HEDERA_KEY"); process.exit(1); }
  const opKey = raw.startsWith("0x") || raw.length === 64
    ? PrivateKey.fromStringECDSA(raw) : PrivateKey.fromStringDer(raw);
  const opEvm = "0x" + opKey.publicKey.toEvmAddress();

  const acc = await mirror(`/api/v1/accounts/${opEvm}`);
  if (!acc || !acc.account) { console.error("operator account not found for " + opEvm); process.exit(1); }
  const relayId = acc.account;
  console.log("=".repeat(74));
  console.log("O1: can a never-funded address sign a Hedera transaction?");
  console.log("=".repeat(74));
  console.log(`\noperator/relay ${relayId}  ${opEvm}`);
  console.log(`balance        ${acc.balance.balance} tinybar`);

  const client = Client.forTestnet().setOperator(AccountId.fromString(relayId), opKey);

  // ---- the virgin key -------------------------------------------------------
  const vk = ethers.Wallet.createRandom();
  console.log(`\nvirgin signer  ${vk.address}   (generated now, never funded)`);

  console.log("\n[C2] control: is the virgin address really unknown to the network?");
  const pre = await mirror(`/api/v1/accounts/${vk.address}`);
  const unknown = !pre || !pre.account;
  console.log(`     mirror node: ${unknown ? "404, unknown. PASS, the key is virgin"
                                            : "KNOWN as " + pre.account + ". FAIL, arm A is void"}`);

  const mkTx = async (nonce, gasPrice) => {
    const t = { type: 0, chainId: CHAIN_ID, nonce, gasPrice, gasLimit: 100000n,
                to: opEvm, value: 0n, data: "0x" };
    return (await vk.signTransaction(t));
  };

  // ---- ARM A ----------------------------------------------------------------
  console.log("\n[A] virgin key with NO Hedera account, gasPrice = 0, relay allowance 2 HBAR");
  console.log("    HIP-410 line 405 predicts this fails: the sender must resolve to an account.");
  const aId = await submit(client, relayId, await mkTx(0, 0n), 2, "A");
  if (aId) {
    const txs = await txRecord(aId);
    if (txs) report("A", txs, relayId, null);
    else console.log("    no mirror record");
  }

  // ---- create the hollow account -------------------------------------------
  console.log("\n[*] creating a hollow account for the virgin address (1 tinybar transfer)");
  const xfer = await new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(relayId), Hbar.fromTinybars(-1))
    .addHbarTransfer(AccountId.fromEvmAddress(0, 0, vk.address), Hbar.fromTinybars(1))
    .setMaxTransactionFee(new Hbar(2))
    .execute(client);
  await xfer.getReceipt(client);
  await sleep(4000);
  const post = await mirror(`/api/v1/accounts/${vk.address}`);
  const signerId = post && post.account ? post.account : null;
  console.log(`    virgin address is now ${signerId || "STILL UNKNOWN"}, balance ${
      post && post.balance ? post.balance.balance : "?"} tinybar`);

  // ---- ARM B ----------------------------------------------------------------
  console.log("\n[B] same virgin key, now with an account, gasPrice = 0, relay allowance 2 HBAR");
  console.log("    HIP-410 predicts the relay must cover 100 percent.");
  const bId = await submit(client, relayId, await mkTx(0, 0n), 2, "B");
  let armB = null;
  if (bId) {
    const txs = await txRecord(bId);
    if (txs) armB = report("B", txs, relayId, signerId);
    else console.log("    no mirror record");
    const ts = (txs || []).find((t) => t.name === "ETHEREUMTRANSACTION");
    if (ts) {
      const cr = await mirror(`/api/v1/contracts/results?timestamp=${ts.consensus_timestamp}&limit=1`);
      const got = (((cr.results || [])[0] || {}).from || "(none)").toLowerCase();
      // The mirror node reports `from` as the long-zero ACCOUNT address, not the
      // ECDSA alias. Both are the same principal, so accept either, and note the
      // substitution because it is itself a disclosure: a long-zero address is a
      // monotonic account number, and the number dates the account.
      const lz = signerId
        ? "0x" + parseInt(signerId.split(".")[2], 10).toString(16).padStart(40, "0")
        : null;
      const ok = got === vk.address.toLowerCase() || got === lz;
      console.log(`    msg.sender recorded as ${got}`);
      console.log(`    alias ${vk.address.toLowerCase()}`);
      console.log(`    long-zero form of ${signerId} is ${lz}`);
      console.log(`    ${ok ? "MATCHES the virgin key. The sponsored call really came from it."
                            : "DOES NOT match the virgin key. Arm B is measuring something else."}`);
      if (ok && got === lz) {
        console.log("    NOTE: the public record carries the account NUMBER, not the alias.");
        console.log("    Hedera account numbers are monotonic, so the number dates the account.");
      }
    }
  }

  // ---- C1 -------------------------------------------------------------------
  console.log("\n[C1] control: operator signs and pays for itself, gasPrice > 0.");
  console.log("     Known answer: the signer IS debited. If this also reads 'sponsored',");
  console.log("     the classifier is broken and B means nothing.");
  const ow = new ethers.Wallet(opKey.toStringRaw().startsWith("0x")
      ? opKey.toStringRaw() : "0x" + opKey.toStringRaw());
  const info = await mirror(`/api/v1/accounts/${relayId}`);
  const nonce = info.ethereum_nonce || 0;
  // Price gas off the network rather than guessing, or the control fails to execute
  // and proves nothing. Mirror node quotes gas in tinybar; 1 tinybar = 1e10 weibar.
  const fees = await mirror("/api/v1/network/fees");
  const tinybarGas = ((fees.fees || []).find((f) => f.transaction_type === "EthereumTransaction")
                      || (fees.fees || [])[0] || { gas: 100 }).gas;
  const gasPrice = BigInt(tinybarGas) * 10000000000n * 2n;
  console.log(`     network gas price ${tinybarGas} tinybar, bidding 2x = ${gasPrice} weibar`);
  const selfRlp = await ow.signTransaction({ type: 0, chainId: CHAIN_ID, nonce,
      gasPrice, gasLimit: 100000n, to: opEvm, value: 0n, data: "0x" });
  const cId = await submit(client, relayId, selfRlp, 0, "C1");
  if (cId) {
    const txs = await txRecord(cId);
    if (txs) {
      const r = report("C1", txs, relayId, relayId);
      console.log(`     ${r.sponsored ? "FAIL, control reports sponsored" : "PASS, control shows the signer paying"}`);
    }
  }

  console.log("\n" + "=".repeat(74));
  if (armB && armB.sponsored) {
    console.log("ANSWER: a registration address needs NO funding of its own. The relay");
    console.log("pays 100 percent. The only on-chain link to it is the dust transfer that");
    console.log("created it, which comes from the relay, not from the trader.");
  } else {
    console.log("ANSWER: sponsorship did NOT occur as specified. an earlier measurement stands. See above.");
  }
  client.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
