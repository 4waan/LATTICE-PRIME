# Lattice Prime: private agent implementation plan

Planning baseline: 9 September 2026. This document proposes an implementation; it does not report an implemented agent, a completed formal proof, or measured proving performance. The first release targets the user's two-day demo deadline. Later releases extend the same boundaries rather than replacing them with a more privileged agent.

Delivery structure: **Phase 1 builds the complete agent layer. Phase 2 wires it into the protocol. Phase 3 integrates it into the existing UI and product pitch.** Each phase hands a working artifact to the next. The phase definitions below govern the implementation order; the later technical sections provide the specification for those artifacts.

Builder handoff: [PRIVATE-AGENT-RESOURCES.md](PRIVATE-AGENT-RESOURCES.md) lists the phase-specific source files, official references, tools, skills, and suggested starting prompt for GPT-5.6 Sol.

Implementation record: [PRIVATE-AGENT-STATUS.md](PRIVATE-AGENT-STATUS.md) tracks
the Phase 1 evidence, measurements, current limitations, and next gate without
changing the release claims in this plan.

## 1. The product we will ship

A local execution agent watches one ATS bond market, decides when to submit one user-approved order, proves its decision computation, submits the sealed commitment, reveals it within the permitted window, follows the auction, and helps recover proceeds. The user sets the mandate once and can see what the agent is doing without operating a terminal or understanding proof files.

The first action is a fixed BUY order. Price, quantity, instrument, account, and maximum cost are chosen in the mandate. The model chooses WAIT or EXECUTE at a bounded number of evaluation slots. It cannot invent a destination, change the quantity, add calldata, or compose arbitrary transactions. SELL follows once ATS hold creation, release, and recovery have their own integration gate.

The user-facing promise is: **Your private inputs stay on your device. The agent acts only within your mandate. You can verify the decision and the transaction fields it released.**

The requested phrase "proves nothing was exposed" becomes three specific deliverables:

1. A mathematical information-flow result for a pinned, restricted decision graph: excluded inputs cannot influence its released decision. When private context is enabled, no dependence beyond the approved release function is permitted.
2. An EZKL inference proof binding that graph's result to the exact decision context.
3. A transaction inspection result showing that submitted bytes contain only the fields authorized for that stage of the order lifecycle.

These do not establish that no other process on the device transmitted data. A runtime record is not a cryptographic proof of the absence of all network activity. The product must keep these claims separate.

## Delivery phases

### Phase 1: build the complete agent layer

**Outcome:** a headless local agent that accepts a mandate, observes a typed snapshot, makes a restricted decision, proves it, checks authority, constructs a permitted action, persists its state, and produces an independently checkable decision receipt.

Build the full vertical path for the first supported action. "Complete layer" means the runtime, model, proving, policy enforcement, signing boundary, storage, recovery machinery, and verifier work together. It does not mean every future trading and financing action is implemented before integration starts.

Work packages:

1. Freeze the privacy specification, numerical domains, model identity, public-instance schema, typed action interface, receipt schema, and protocol-adapter interface.
2. Build and pin the small trained model, its ONNX graph, EZKL setup, local proving, and independent verification. Prove exact context binding before adding more capabilities.
3. Build the isolated worker, supervisor, local signer, encrypted journal, mandate counters, and typed transaction projector. The model cannot access external tools or submit arbitrary bytes.
4. Implement the graph restrictions and bounded information-flow checks. Optional private inputs remain disabled until the appropriate property passes.
5. Exercise restart, pause, revocation, replay, duplicate jobs, invalid proofs, and altered actions through a deterministic adapter harness. Use this harness to verify the layer, not as evidence of live protocol execution.
6. Package one local launcher and a machine-readable API that Phase 3 can consume. Add a small diagnostic runner for developers; product UI follows after protocol integration.

**Handoff:** a versioned agent bundle, stable adapter/API contract, model and proof manifest, formal-check artifacts with explicit scope, independent receipt verifier, and passing component/integration checks against the harness.

**Exit gate:** one headless request completes intent-to-proof-to-permitted-action-to-receipt; a modified model, proof, action, or mandate is refused; a restart preserves authority and pending state. No mock is presented as a real chain transaction.

### Phase 2: wire the agent into the protocol

**Outcome:** the same layer completes a real Hedera order using the protocol's existing identity, eligibility, order, auction, accounting, and disclosure rules.

Work packages:

1. Implement the protocol adapter against pinned deployment metadata and actual code/ABI checks. The adapter reads the existing market state and calls the existing order lifecycle. It does not create another book, settlement engine, eligibility registry, or oracle.
2. Wire account preparation and eligibility into the dedicated testnet signer. Reuse protocol checks and show their authoritative result. The user's mandate adds stricter spending/action limits; it never replaces contract authorization.
3. Bind each inference proof to the exact ticket and execution context. Reuse the existing commitment and unit helpers. Reconcile job state against chain state before retries.
4. Complete commit, reveal, auction outcome, partial/no fill, expiry, credit recovery, and pause/recovery behavior on testnet. Confirm actual balance changes and keep the commitment's timing obligations live across browser closure.
5. Extend the existing order record and disclosure receipt with an agent-decision section. Use the same order identifier and chain references. Keep inference evidence, venue disclosure evidence, and local runtime observations separately labeled inside that one receipt.
6. Add conditional post-reveal on-chain inference verification only after the local verified execution path passes. It remains an evidence sidecar unless the protocol actually requires its proof. No private witness, unrevealed ticket, or proof package enters HCS.

**Handoff:** a real end-to-end testnet trace, protocol adapter, integrated read model, combined receipt format, recovery evidence, and a capability manifest stating exactly which actions are available.

**Exit gate:** a valid agent order settles through the existing engine; a changed or unauthorized action is refused; both successful and no-fill paths recover correctly; the same position and receipt are visible to the ordinary application. A new model feature cannot bypass protocol eligibility, halt, backing, or accounting checks.

### Phase 3: integrate the UI and product story

**Outcome:** using the agent feels like a native way to operate Lattice Prime. The user enters through an existing market or portfolio task, grants a clear mandate, follows the same order lifecycle, and receives the same product receipt with additional decision evidence.

Work packages:

1. Add **Use your agent** to the existing market ticket. Reuse the ticket's asset, price, quantity, unit conversions, eligibility status, cost preview, and validation. Manual execution remains available through the same underlying action definitions.
2. Add a **Your agent** panel to Portfolio for active mandates, reserved funds, upcoming obligations, pause controls, and recovery. The panel consumes the Phase 2 read model instead of maintaining a second position ledger.
3. Put agent activity into the existing activity/receipt flow. A local execution-source label explains who submitted the order without creating unnecessary new on-chain metadata. Model proof details are expandable within the order receipt.
4. Keep account/network identity, privacy controls, terminology, notifications, and errors consistent with the rest of the app. Agent setup and runtime connection are contextual steps; they are not a separate primary product journey.
5. Amend the landing page, README descriptions, product outline, pitch deck, and demo script together using the copy package below. Descriptions of borrowing, lending, or autonomous financing remain limited to capabilities actually integrated and tested.
6. Test the combined journey with someone unfamiliar with the implementation. They should understand what they delegated, what remains local, what the chain reveals, and how to stop or recover an action.

**Handoff:** integrated UI, consistent copy across product surfaces, one complete demonstration, and evidence that the ordinary trading journey and agent journey share the same protocol behavior.

**Exit gate:** the user can start from Markets, activate a prepared mandate, follow it in Portfolio, and verify its receipt without switching to a different product or interpreting cryptographic file formats. Every pitch claim maps to a working feature and a specific evidence source.

### Shared ownership of existing capabilities

The agent is the user's execution layer over Lattice Prime. It reuses protocol capabilities and adds decision automation and evidence at their existing boundaries:

- **Eligibility:** the existing issuer and registration flow establish access. The agent checks freshness and guides renewal; it cannot issue credentials or create its own allowlist.
- **Market decisions:** the agent may choose WAIT or EXECUTE within a mandate. The existing auction determines matching and settlement. The agent cannot claim or guarantee a fill.
- **Permissions:** contracts enforce their existing permissions. The local signer enforces the user's narrower mandate. One review screen presents both without confusing their sources of authority.
- **Privacy:** the protocol's disclosure policy governs venue publication; the agent's input and action policy governs its added channels. The combined receipt displays both scopes without treating a venue budget as proof about model leakage.
- **Accounting:** positions, escrow, fees, and credits come from existing contracts. The agent stores reservations and job state, not a competing authoritative balance sheet.
- **Activity:** one order record joins mandate, decision proof, chain state, and disclosure receipt. Private linkage stays local unless its publication is explicitly authorized.
- **Recovery:** the agent schedules and assists existing cancel/reveal/expire/withdraw operations. It does not invent an alternative unwind or settlement rule.

### Product copy package for Phase 3

Recommended headline: **Trade tokenised bonds with your private agent.**

Supporting line: **Set the limits. Your agent handles the order flow. Verify its decisions and what the venue publishes.**

Product description: **Lattice Prime brings tokenised bond trading on Hedera together with a local execution agent. You authorize an order mandate; your agent manages execution within it; the protocol enforces eligibility and settlement; and one receipt explains the verified decision and the venue's disclosures.**

The existing phrase **Control what the venue publishes** remains the privacy explanation beside the disclosure receipt and in the technical pitch. It should be presented in the context of the venue's governed policy rather than suggesting users can hide arbitrary chain data.

CTA vocabulary: **Explore markets**, **Use your agent**, **Review mandate**, **Activate agent**, **Pause new orders**, and **View receipt**. Runtime connection is an onboarding step, not the landing page's primary promise. Avoid a competing AI brand, a second wallet connection flow, or a separate trading dashboard.

The story follows one causal chain: **you set a mandate → your local agent decides and proves → the protocol executes → you verify the result and disclosures**. In the demo, reveal the proof through the actual order receipt. Do not interrupt the trade journey to launch an unrelated AI demonstration.

Pitch amendments are applied when the corresponding capability passes its release gate. Until then, this copy is a prepared proposal. Do not advertise universal confidentiality, proven absence of all device traffic, profitable predictions, or autonomous actions that are still planned.

## 2. Existing integration points and constraints

The inspected repository already supplies the order lifecycle, ZK eligibility, integer monetary conversions, a generated static UI, and venue disclosure receipts. Reuse these components.

- `src/market/OrderBook.sol`: `commit`, `reveal`, `cancel`, `expire`, and `withdraw`. The commitment is Keccak over the domain, committer, side, price, quantity, and salt. Commit and reveal bind the trader to `msg.sender`.
- `src/market/MatchingEngine.sol`: cash backing for BUY, ATS hold backing for SELL, auction crossing, retirement, and pull credits. Matching is an auction; submission is not a guaranteed fill.
- `tools/commitment.mjs`: the existing commitment encoding and vectors. Do not replace it with an EZKL hash.
- `tools/units.mjs`: use the existing bigint monetary operations. Hedera EVM values and Ethereum transaction values require the repository's tinybar/weibar conversion.
- `tools/lattice.mjs` and `src/lattice/DisclosureView.sol`: existing venue publication checks and receipts. They do not inspect arbitrary model outputs or hide transaction calldata.
- `tools/venue-app.mjs`, `tools/venue-obs.mjs`, `tools/gen-app.mjs`, and `app/*.template.html`: extend the generated static application. Do not migrate frameworks or hand-edit generated HTML and deployment bundles.
- `deployments/client.json` and `deployments/abi/`: deployment discovery inputs. Verify chain, code, ABI, and required selectors before enabling an agent.

The working tree contains substantial concurrent changes. Implementation begins by recording the relevant file hashes and deployment identity, then works in new agent modules. Recheck these seams before integration. This plan does not approve or alter the ongoing financing decisions in `FINANCING-DECISIONS.md`.

A new forwarding contract would become the trader under the current `msg.sender` rules. The first release therefore uses a dedicated testnet EOA owned by the local signer. An existing wallet signature over a mandate does not magically delegate that wallet's transaction authority. Contract accounts and protocol-enforced delegation belong to a later release with explicit ATS and custody checks.

## 3. Privacy policy: two explicit operating modes

**Default: excluded private context.** The model sees public market features and the user's explicit execution mandate. It never receives credential material, signing keys, reveal salts, off-platform holdings, or additional private preferences. Its decision cannot depend on fields it does not receive. Proving correct execution remains useful, although ZK is not necessary to hide model inputs that are already public.

**Optional: private preferences.** The user can let two local numeric preferences affect execution: a desired cash-buffer ratio and a time horizon. The graph first converts them through a fixed release function into coarse categories. The learned model receives only those categories and public market features. The exact values have no other path to a public decision.

Proposed initial domains, to be frozen and versioned before training:

- Buffer ratio: integer basis points from 0 through 10,000. Categories are below 2,000, from 2,000 through 4,999, and from 5,000 through 10,000.
- Horizon: integer hours from 0 through 168. Categories are below 24, from 24 through 71, and from 72 through 168.
- Values outside the domain are refused locally before starting an evaluation. No silent clipping of invalid private inputs.

These are preference controls, not authenticated statements about wealth or creditworthiness. The thresholds are initial product proposals, not protocol economics. The user authorizes the release function before activation. Changing its thresholds or the model requires a new mandate.

The optional mode's disclosure preview says: "Exact values stay local. Whether and when this order is submitted may reveal information about these categories." The categories need not be published directly, but behavior can disclose them. If that consequence is unacceptable, the user leaves private preferences disabled.

This is a deliberate response to the user's concern about hidden information. Do not secretly change a field from excluded to category-releasable just because the model performs better with it.

## 4. Threat model and exact proof boundary

Protected against, within the specified implementation: a model trying to emit a raw secret, an altered model artifact, an order changed after inference, replay of an old decision, a hostile webpage calling the local service, an invalid proof, and unintended data in the allowed transaction channel.

The model is treated as untrusted. The pinned compiler, proof system, verifier, local input handler, process isolation, signer, transaction projector, random-number generator, and host operating system are part of the trusted computing base. A hash identifies these artifacts; it does not remotely attest that a computer ran them.

Observers are considered separately:

- Ledger and consensus observers see submitted transactions, accounts, timing, fees, contract state, and token events.
- RPC and mirror providers also see requests and transport metadata. Public chain data does not make an account-specific query private.
- The authorized user can see their local inputs and private explanations.
- A counterparty learns the trade information the existing protocol reveals.

Host compromise, arbitrary browser extensions, physical side channels, malicious randomness in a substituted prover, and global traffic analysis are outside the first formal result. The model process is denied networking, but that restriction alone is not a proof about every process on the computer. A malicious prover can attempt to encode data in otherwise valid randomized artifacts; use the pinned honest prover and do not accept caller-provided proof randomness.

## 5. Process architecture

**Local UI.** Extend the existing Markets ticket, Portfolio, and receipt views with agent controls. The launcher serves the integrated application with bundled assets on loopback. Use local fonts and scripts in these views; the inspected market template currently references remote fonts. Private controls must not load analytics, remote explanation APIs, or session replay. No private values in URLs, console logs, telemetry, or browser localStorage. The ordinary public website can remain usable without the runtime; selecting agent execution opens the local integrated view through a paired connection without passing private data in its URL.

**Supervisor.** A small Node 22 process owns the durable state machine, process lifecycle, and restricted IPC. It does not expose a general shell or arbitrary URL tool. The browser talks only to this local service. Validate exact Host and Origin values, use a per-launch unguessable pairing capability and CSRF protection, reject wildcard CORS, and bind only to loopback. Pairing tokens never appear in query strings or share links.

**Public data adapter.** Fetch only fixed, typed methods from the configured RPC and mirror endpoints. Poll public instrument and round data independently of private model values. Separate account-specific preflight reads and explain their visibility. No model-supplied endpoint, query, request header, contract address, or unbounded block range.

**Inference and proving worker.** A Python process with a pinned EZKL release and fixed ONNX graph. For the demo, run inside a local container with networking disabled, a read-only root, non-root user, bounded resources, and dedicated temporary storage. Do not mount a home directory, wallet store, Docker socket, or inherited application secrets. The supervisor exchanges narrowly typed files or messages. The container only receives the inputs necessary for its current job.

**Independent verifier and policy executor.** Verify against the pinned verification key and settings, decode every public instance, compare with the expected context, and enforce the mandate. Never let the producer choose its own verification key. A failed check means no new commitment. Error messages contain stable codes, not worker stdout or witness excerpts.

**Local signer and ticket store.** A separate process owns the dedicated testnet key, trusted salt generation, ticket persistence, and transaction construction. It accepts typed requests such as `commitApprovedOrder`, not arbitrary calldata or arbitrary signing requests. Encrypt persistent keys and tickets with an OS-backed secret or a user-unlocked encrypted store. File permissions are restrictive; passphrases and secrets are not CLI arguments. The signer is trusted software in release one, not an on-chain permission system.

**RPC broadcaster.** Receives only fully constructed, approved signed transactions. It cannot access the witness store. The signer decodes its own final transaction bytes and validates them before broadcast. The broadcaster's response is untrusted until confirmed by the chain.

Docker documents that the none network driver leaves only loopback inside the container. This supports the worker's network boundary, not the broader end-to-end theorem: [Docker network isolation](https://docs.docker.com/engine/network/drivers/none/).

## 6. What the user does

1. Select **Use your agent** from an existing market ticket. On first use, launch or connect the local runtime; its browser view opens the same Lattice Prime journey with the ticket context restored through authenticated pairing. Preflight shows supported network, verified deployment, proving readiness, and the active account. Dependency downloads happen before private input entry.
2. Prepare a dedicated testnet account. Generate its key locally, establish eligibility through the existing issuer/proof flow, and fund a clearly displayed maximum balance. Never request a primary wallet seed phrase. Label demo credentials and test funds honestly.
3. Choose an instrument and a BUY ticket. Show exact price limit, quantity, maximum escrow, commit bond, cancellation charge, fees, and the latest possible lifecycle completion time.
4. Choose privacy mode. Default excludes additional private context. Optional controls describe the precise inference allowed from private preference categories.
5. Review and activate one mandate. A plain-language summary precedes the local authorization. The demo allows one new order and at most three decision evaluations at public schedule slots. The mandate reserves enough time and funds for reveal and recovery after new entries expire.
6. Follow the order in the existing ticket and Portfolio activity: Watching, Checking locally, Decision verified, Order sealed, Ready to reveal, In auction, Filled or Expired, Proceeds available. A decision to wait is distinct from an error. A confirmed transaction is distinct from a fill. The **Your agent** panel manages mandates and lifecycle obligations without duplicating balances.
7. Open the ordinary order receipt with its added agent-decision section. It separates inference verification, exact transaction disclosure, approved behavioral disclosure, local runtime checks, and known public data. Export is sanitized by default.

No conversational interface is required for release one. Use templates for explanations of public actions. A private explanation can remain local, but arbitrary model text is never copied into transaction metadata, public receipts, or support exports. A later local language model may draft a mandate; it still cannot authorize one.

## 7. Mandate and accounting contract

Store a canonical versioned mandate with these fields:

- Identity: schema version, chain ID, execution account, deployment revision and code hashes, model bundle hash, policy hash, independent random mandate nonce.
- Ticket: exact engine, token, side, quantity, limit price, fixed recovery address, permitted lifecycle methods.
- Limits: one new order, cumulative principal/escrow budget, cumulative bond and cancellation budget, fee reserve, maximum pending orders, public decision schedule, maximum evaluations.
- Time: valid-from, last new-entry time, reveal/recovery authorization deadline, freshness threshold for market data.
- Privacy: excluded input names, approved release-function ID, receipt-export mode, allowed transaction fields for each stage, no external model endpoint.
- Control: activation authorization, revocation generation, pause state, and confirmation of post-commit obligations.

Use integers and decimal strings for monetary values. No JavaScript floating point for money. JSON serialization must reject unknown fields and preserve deterministic encoding. Mandate authorization is checked locally for the dedicated account; it does not authorize spending from another wallet.

Before signing, atomically reserve the action ID, budget, order slot, and account nonce. Persist the ticket before commit. A retry cannot increase the budget or create a second order. Replacement transactions use the same economic action and controlled nonce/fee rules. Cumulative spend does not reset when assets return as credit.

Revocation blocks new entries immediately. Already broadcast transactions cannot be recalled. The UI offers a separate lifecycle choice: stop new orders while completing existing obligations, or stop all future signatures and show the manual recovery consequences. Cancel is only available in the chain's cancel window and has a fee. Do not promise cancellation after reveal. Do not destroy keys or salts while an order or credit still needs recovery.

## 8. The model and its numerical specification

Initial model: a small feed-forward classifier with four bounded public market features, two optional category inputs, one hidden layer of eight ReLU units, and two decision classes. Exact feature definitions and ranges are part of the model manifest. In default mode, the two private-context inputs are fixed neutral constants.

Public features can describe distance from the user-approved limit, recent public price movement, public round position, and data freshness. The data adapter names the exact source and snapshot for each. Do not imply access to hidden orders or guaranteed execution liquidity.

The only released model result is WAIT or EXECUTE. Keep scores, intermediate activations, private categories, and explanations private. Define ties as WAIT. Timing is chosen by the supervisor's public schedule, not by the model's runtime. Fixed gas policy, trusted salts, fixed recipients, and canonical ticket fields close easy encoding channels.

Train offline on clearly labeled synthetic scenarios for the demo. Save the seed, training recipe, held-out evaluation, and provenance. This demonstrates a real trained model and reproducible inference; it does not demonstrate profitable trading or validated financial risk prediction. Hard spending, eligibility, and price checks remain deterministic.

Freeze the deployment graph, integer scales, category comparisons, weight values, supported operations, rounding, tie rules, and overflow bounds. Compare the floating-point training model with the deployed quantized graph at boundary cases. The deployed quantized graph is the proof target. Do not certify the Python training graph while executing a different ONNX graph.

## 9. EZKL proof construction and action binding

Pin an exact EZKL version and artifact hashes. The official release page currently identifies v23.0.5; test that release on the demo platform before adopting it. The pipeline is model export, settings/calibration, compilation, setup, witness generation, proving, and verification. API names must be taken from the pinned installed release because examples across documentation pages differ. [Release](https://github.com/zkonduit/ezkl/releases/tag/v23.0.5), [workflow](https://docs.ezkl.xyz/getting-started/).

Configure private inputs and fixed parameters explicitly. A private parameter setting without an accepted commitment to the weights is not evidence that the approved model ran. Maintain an explicit public-instance manifest and mechanically reject unexpected public outputs. [EZKL visibility definitions](https://github.com/zkonduit/ezkl/blob/v23.0.5/src/graph/vars.rs).

Proposed proof relation:

```text
categories = approvedRelease(privatePreferences)
decision = pinnedQuantizedModel(categories, publicMarketFeatures)
publicInstances = (decision, boundContext)
```

For default mode, `categories` is a constant and excluded preferences are absent from the graph. The optional release function is inside the proved graph; computing categories outside it would only prove inference on caller-asserted categories.

`boundContext` includes protocol/schema domain, chain ID, engine, execution account, ticket side/price/quantity, market snapshot identity and public feature values, model/policy identity, mandate nonce, decision sequence, public slot, and expiry. Every field is constrained in the graph's input/output relation and compared with the verifier's expected value. Context placed only beside a proof in JSON is not binding.

Represent addresses, hashes, and large integers as explicitly ordered small integer limbs. Range-check limbs and require exact round trips; never pass a 256-bit value through a floating-point ONNX tensor. The first spike must demonstrate exact context binding after EZKL scaling. If it cannot, redesign the context representation before integration.

The signer receives a verified ticket tuple and constructs the existing Keccak commitment with a fresh salt. The model never receives that salt. This keeps a Keccak gadget out of the EZKL circuit for the first release. The local signer verifies the tuple-to-commitment mapping before submission. After reveal, an independent checker can use the on-chain tuple and salt to recompute the commitment and compare the proof's ticket fields.

This design provides local enforcement before commit and independently checkable correspondence after reveal. It is not a cryptographic on-chain gate at commit. A claim of contract-enforced execution would require a different integration.

Proof public inputs are public to whoever receives the proof, even when they are not yet on-chain. Keep the entire proof package local before reveal because its context contains order terms. Never attach it to HCS, an external prover, a public URL, or a pre-reveal receipt. A canceled unrevealed order's proof remains local unless the user explicitly elects to disclose its terms.

The proof establishes consistency with the supplied market context. The executor separately authenticates and checks freshness of that context against the configured chain. EZKL does not establish that an arbitrary input snapshot is authentic. A later trustless verifier needs accepted on-chain state or authenticated oracle data as part of verification.

The witness contains private inputs and intermediate computations. Use ephemeral worker storage, disable crash/diagnostic exports, and clean up after jobs. State deletion as best-effort local lifecycle management, not secure erasure of every SSD or swap copy. [EZKL witness contents](https://docs.ezkl.xyz/getting-started/prove/).

## 10. Formal information-flow work

Define `P` as approved public context, `S` as private preference values, `D` as the fixed release function, and `A` as the canonical released decision/action. The deterministic core target is:

```text
For all valid S1, S2, P:
    D(S1) = D(S2)  implies  A(S1, P) = A(S2, P).
```

Default mode uses a constant `D`, so the core decision is independent of excluded private context. Optional mode permits only the dependence represented by `D`. It does not promise that authorized categories remain unknowable. This distinction follows the information-flow literature on controlled disclosure: [robust declassification](https://www.cs.cornell.edu/andru/papers/robdecl-jcs/).

Implement a graph dependency checker that rejects any path from a raw private input to the model or public output that bypasses `D`. Restrict the operation set, forbid custom executable ONNX operators, and pin all weights. Analyze actual deployed graph nodes, not names or developer annotations.

For the bounded deterministic release and action projection, construct two symbolic copies of the integer computation. Ask an SMT solver for valid inputs with equal `D` but different public outputs. A counterexample blocks release; an unsatisfiable result establishes the property in that encoded model. Include range, overflow, comparison, and tie semantics. Save the formula, solver/version, output, and input artifact hashes. A certificate is a formal claim only after checking that the encoding matches the executable semantics; differential tests alone do not prove that correspondence.

The factorization through `D` can provide a simpler structural proof than verifying an unrestricted neural model. Changing a model artifact invalidates the certificate. Explicitly reject a model that routes an extra secret feature into its action or public instances.

The full external view includes commitments, signatures, randomized proofs, polling, success/failure, and timing. Byte equality is inappropriate for fresh cryptographic randomness. The broader target is computational indistinguishability conditioned on approved disclosures and public context, assuming correct hiding/ZK constructions and the trusted runtime. Do not publish a full-system theorem based only on the deterministic graph check.

Evaluate at fixed public slots, bound decision opportunities, suppress detailed public failure messages, and use fixed schemas. A missed deadline or stopped process can still reveal availability. Timing padding and a no-network worker reduce channels; they do not prove their absence across the operating system. The first certificate names graph outputs and transaction projection as its scope.

Repeated decisions accumulate disclosure. Count evaluations and externally distinguishable outcomes across restarts. An epoch change must not be advertised as restoring information already learned. Rate limits are operational controls, not a universal entropy or differential-privacy guarantee.

## 11. State machine and recovery

```text
SETUP -> READY -> MANDATE_ACTIVE -> WATCHING
WATCHING -> SNAPSHOT_READY -> PROVING -> VERIFIED
VERIFIED -> WAITING_FOR_NEXT_SLOT | TICKET_SAVED
TICKET_SAVED -> COMMIT_PENDING -> SEALED
SEALED -> CANCEL_PENDING -> CANCELED
SEALED -> REVEAL_PENDING -> IN_AUCTION
IN_AUCTION -> FILLED | PARTIALLY_FILLED | EXPIRED
FILLED / PARTIALLY_FILLED / EXPIRED -> CREDIT_AVAILABLE -> COMPLETE
```

`BLOCKED`, `PAUSED`, and `RECOVERY_REQUIRED` retain the underlying lifecycle state. A timeout during broadcast means unknown outcome, not failure. Reconcile the transaction hash, account nonce, and on-chain commitment before any retry. Persist signed transaction identity before broadcast; restart must not generate another ticket or salt.

Prove before starting the reveal clock. Read actual `revealDelay`, `revealWindow`, round length, and rest period from the selected deployment. Require enough remaining mandate lifetime and fee balance before committing. Schedule reveal early enough to permit a bounded retry. Keep the supervisor running when the browser closes. System sleep and worker shutdown are visible limitations of the local demo.

Before reveal, recheck account, chain, eligibility, pause/halt, backing amount, and timing. Use BUY escrow from `units.mjs`. If eligibility requires renewal, direct the user through the existing proof flow; never request issuer identity evidence in the model. During an auction, report partial fills and remaining backing correctly. A dedicated prepared counterparty supplies a real demo fill; a crossing transaction alone does not prove a fill.

Recover credits to the dedicated account and offer an explicit transfer to the fixed user recovery address. Surface transaction fees separately. No arbitrary auto-withdrawal destination supplied by the model. Expiry and recovery must be shown when the market does not fill.

## 12. Privacy receipt and independent verification

The receipt has distinct evidence states: `verified`, `checked locally`, `not checked`, `failed`, and `outside scope`. Avoid an overall green badge called "nothing leaked".

Show these statements only when their prerequisites hold:

- "Decision proof verified": proof checks under the pinned model/settings/key and expected public instances.
- "Submitted order matches the verified decision": local pre-commit mapping checks pass; after reveal the public checker can reproduce the ticket binding.
- "No additional fields in this transaction": independently decoded destination, selector, value, calldata length, and arguments equal the permitted projection. This describes this transaction, not all device traffic.
- "Private context excluded" or "Only approved preference categories may influence the decision": applicable graph certificate hash and policy version are present.
- "Worker networking disabled": supervisor inspection and sandbox checks passed. Mark this as local evidence, not remotely attested fact.
- "Public on Hedera": account, timing, gas/fees, commitment, and, after reveal, side/price/quantity and relevant token events. A venue event being withheld does not hide these.

Receipt schema includes artifact identities, policy/mode, context version, decision sequence, transaction references, verification results, evidence scope, and limitations. It excludes raw preferences, category values unless explicitly exported, witness paths/content, keys, unrevealed salts, and private explanations. Avoid deterministic public hashes of low-entropy private values; they can enable guessing. Do not introduce a stable public private-portfolio identifier.

Provide an offline verifier command and a UI import action. A post-reveal bundle contains the inference proof, pinned public verification material or manifest references, relevant public context, graph-check artifacts, and public transaction data. The checker reports inference validity, transaction correspondence, and separately the unverified runtime assertions. It must never turn a signed self-report into proof of no egress.

## 13. Planned code layout

New files and directories are proposals; none are implied to exist today.

- `venue/agent/manifest.json`: versioned capability, model, proof, and deployment identities.
- `venue/agent/runtime/supervisor.mjs`: launcher, paired local API, process lifecycle, scheduling, and durable state transitions.
- `venue/agent/runtime/market-reader.mjs`: bounded public snapshots and account preflight.
- `venue/agent/runtime/policy.mjs`: mandate validation, counters, replay protection, and reservations.
- `venue/agent/runtime/signer.mjs`: dedicated-account custody and typed signing operations.
- `venue/agent/runtime/transaction-projector.mjs`: canonical encode/decode and exact allowed-field checks.
- `venue/agent/runtime/store.mjs`: encrypted keys/tickets, atomic journal, recovery, and sanitized receipt storage.
- `venue/agent/model/train.py`, `export.py`, and `manifest.json`: synthetic training, fixed graph export, scales, feature policy, and provenance.
- `venue/agent/proof/setup.py`, `prove.py`, `verify.py`, and `instances.json`: pinned EZKL lifecycle and public-instance decoding.
- `venue/agent/formal/check_graph.py`, `check_release.py`, and `spec.json`: graph restrictions, symbolic two-run check, domains, and evidence hashes.
- `venue/agent/verify-receipt.mjs`: independent bundle inspection and proof-verifier invocation.
- `venue/agent/tests/`: meaningful boundary, recovery, proof, and privacy tests.
- `venue/agent/packaging/`: pinned local worker image, launcher, integrity manifest, and installation preflight.
- `venue/agent/runtime/protocol-adapter.mjs`: the typed Phase 2 connection to existing read models, order lifecycle, and receipt data. The Phase 1 harness implements the same interface.
- `venue/tools/venue-agent.mjs` and reusable agent partials under `venue/app/partials/`: local-runtime bridge and native controls included by the existing page generator in Markets, Portfolio, and receipts.
- Existing `venue/app/trade.template.html`, `position.template.html`, and receipt rendering: contextual mandate activation, agent status, and combined evidence. Update templates and shared sources rather than generated HTML.
- Existing `README.md`, `venue/README.md`, `venue/app/index.template.html`, `venue/docs/OUTLINE.md`, and `venue/docs/DEMO-4MIN.md`: coordinated Phase 3 copy amendments. Update the currently used deck's source after identifying it; do not create a second competing pitch.
- `venue/docs/PRIVATE-AGENT-PLAN.md`: this plan. Later add a concise user guide and generated evidence report after implementation.

Extract shared pure transaction-building functions only where necessary. Keep DOM-dependent `venue-app.mjs` behavior out of the headless executor. Extend the existing generator and Makefile with explicit agent build/test/demo commands after the modules work. Keep credentials, witness files, private tickets, and runtime state outside git and outside the public app directory.

## 14. Two-day schedule within the three phases

Elapsed hours are planning estimates from the start of implementation, not benchmark results. Work is ordered for one implementer with coding assistance; no parallel staffing is assumed. Reserve the final eight hours for failures and rehearsal.

**Phase 1, hours 0 to 4: proof-and-context gate.** Pin baseline and dependencies. Export the smallest model with private inputs, fixed weights, and exact context instances. Generate and independently verify a real proof. Alter the decision, context, and verification key and confirm refusal. Measure setup time, proving latency, peak memory, artifact sizes, and correctness near decision boundaries. Exit: a reproducible valid proof plus named negative cases. If this fails, reduce the model; do not build a fake proof badge.

**Phase 1, hours 4 to 10: privacy and authority foundation.** Implement mandate schema, graph restrictions, release specification, bounded symbolic check, transaction projector, and local isolated worker. Create the dedicated-account signer with one-order budget. Exit: a raw-secret model path and an out-of-mandate transaction are both refused. Optional private context stays disabled until its graph property and numerical mapping pass.

**Phase 1, hours 10 to 14: finish the layer.** Connect runtime, proof, signer policy, durable storage, and independent receipt verification through the deterministic protocol-adapter harness. Check restarts, local API authorization, worker isolation, and exact action projection. Exit: the complete headless layer and its interface contract are ready for live wiring.

**Phase 2, hours 14 to 24: real protocol lifecycle.** Wire deployment discovery, eligibility, the existing commitment and unit helpers, commit, timed reveal, auction outcome, and credit recovery. Reconcile nonces and uncertain broadcasts. Join the agent decision to the existing order and disclosure receipt. Exit: one real filled testnet BUY against a prepared seller, an unfilled recovery path, and a shared read model ready for the UI.

**Phase 2, hours 24 to 28: integration evidence and conditional chain verifier.** Verify the combined receipt against real transactions; repeat wrong-order, replay, budget, and disclosure cases at the adapter boundary. Only if those pass, generate and probe an EZKL verifier on Hedera testnet. Measure size, calldata, gas, and valid/invalid behavior. Exit: independently checkable protocol execution with explicit local-only or on-chain inference verification. This is a sidecar, not delegated trading enforcement. [EZKL verifier workflow](https://docs.ezkl.xyz/getting-started/verify/).

**Phase 3, hours 28 to 34: native product integration.** Add contextual mandate activation to Markets, **Your agent** to Portfolio, and decision evidence to the existing receipt. Reuse navigation, account context, validation, units, status, and recovery language. Bundle local assets and pair the runtime safely. Exit: a prepared user follows the whole journey without a separate AI dashboard or developer tooling.

**Phase 3, hours 34 to 38: pitch and copy amendments.** Apply the prepared headline, supporting copy, CTA vocabulary, README, outline, deck, and demo edits to the delivered feature set. Use the actual agent-managed order as the main demonstration. Exit: every product surface tells the same story and every evidence claim names a working capability.

**Phase 3, hours 38 to 40: freeze and rehearse.** Freeze manifests, run the relevant existing vectors and agent tests, capture public transaction references, prepare funded eligible actors, and rehearse restart and no-fill behavior. Record real proof latency and evidence scope. Exit: repeatable integrated journey and a prepared recorded backup labeled as such.

**Hours 40 to 48: contingency.** Fix discovered failures, reverify affected properties, and preserve the working demo. Do not spend this reserve on LLM chat, additional asset classes, financing migration, browser proving, or custom delegation contracts.

Phase boundaries are dependency gates, not permission to claim unfinished work as complete when an hour is reached. Design the integration seams in Phase 1, but finish live wiring in Phase 2 and public product claims in Phase 3. If a required gate slips, use contingency or narrow the explicitly supported release; do not skip the privacy or authority gate to make time for the pitch.

## 15. Release tests and acceptance gates

Proof: valid proof accepted; altered output/context/key rejected; fixed weights enforced; no unexpected public instances; exact integer limb round trips; expired snapshot and reused decision refused by the executor. The inference proof and input authenticity checks report separate results.

Information flow: graph bypass mutation rejected; equal-category private inputs give identical canonical decisions over the specified integer domain; default mode never reads excluded preferences; differing authorized categories may change the decision and are labeled accordingly. Test the generated executable's boundary semantics against the formal specification. Do not call fuzzing a universal proof.

Egress: worker cannot resolve DNS, reach the internet or local service, read wallet files, access host mounts, or select arbitrary output paths. A hostile model fixture trying to write a secret into an extra output is refused. No raw worker output reaches UI, logs, or public exports. Packet capture and process inspection are supplementary observations.

Authorization: wrong account, chain, deployment, recipient, method, quantity, price, value, nonce, expiry, and cumulative budget are refused. Two concurrent jobs cannot consume one reservation twice. Tampering with UI state does not change signer authority. Hostile origins and unauthenticated loopback requests fail.

Lifecycle: restart after signing, after broadcast, and before reveal; RPC throttling; wallet or network mismatch; stale eligibility; missed reveal; cancellation boundary; partial/no fill; expiry; credit withdrawal; insufficient gas reserve; pause with an outstanding commitment. Check actual balances and state, not only emitted events.

Usability targets, to be measured: a new user can explain the permitted action and disclosure after review; activate a prepared mandate from the existing ticket in at most three screens; find the same order and balances in Portfolio; identify whether the order is waiting, sealed, or filled; stop new entries without losing recovery information; and verify an exported post-reveal receipt without developer help. Switching between manual and agent execution must preserve the same protocol checks and economic calculations. These are acceptance criteria, not current results.

Mandatory release gate: one end-to-end real proof and testnet action, bounded signer authority, honest disclosure receipt, reliable reveal/recovery, and no known raw-private-data egress in the implemented channels. If formal verification remains incomplete, the corresponding receipt state is "not checked" and the formal privacy claim does not ship. The user can still evaluate the reduced demo, but it is not represented as satisfying the stronger claim.

## 16. Demo narrative

Open the existing Lattice Prime market ticket under the headline **Trade tokenised bonds with your private agent**. Show a prepared eligible account and the maximum funds available to the agent. Select **Use your agent** and activate one fixed BUY mandate. Explain the privacy mode in one sentence. Let the agent observe a public slot, generate a real local proof, submit the commitment, reveal, and complete a real auction fill. Follow the same order in Portfolio and open its combined receipt. The AI evidence belongs inside this protocol journey.

Then demonstrate two refusals: an altered model attempts to route an excluded value to the public output, and an altered action exceeds the approved quantity. The former fails the artifact/graph gate; the latter fails proof-context or signer checks. These are distinct defenses and should be labeled as such.

Open a receipt in the independent verifier. Show exactly which facts were public, which proof passed, and which runtime claims are only locally checked. If private preferences are enabled, demonstrate two exact inputs in the same approved category producing the same canonical decision. The formal artifact covers the declared domain; the two examples merely make the property understandable.

The demo ends with a usable account balance and a clear completed or recoverable order. It must not finish with a stranded commitment while discussing privacy.

## 17. Expansion after the demo

First add SELL with ATS hold recovery and independent economics checks. Then add read-only financing monitoring and user-reviewed actions against the finally approved financing implementation. Autonomous funding, repayment, margin cure, and manufactured payments require separate mandates and lifecycle tests.

Next harden installation and signing: signed application packages, reproducible manifests, secure auto-update, hardware-backed key options, supported operating systems, and an independently reviewed local bridge. Test background operation and recovery after sleep. Container installation may be acceptable for prepared hackathon machines but is not the final consumer onboarding experience.

Protocol-enforced delegation requires an account or adapter whose authorization and custody semantics are compatible with ATS and the current caller checks. Bind proof acceptance, replay prevention, action terms, and limits at that enforcement point. A verifier sidecar or HCS receipt does not provide this enforcement.

If the requirement becomes secrecy of actions and timing themselves, redesign execution around a confidential or shielded transaction layer with a separate threat model. The existing reveal-based public settlement cannot supply that guarantee through an AI wrapper.

The first implementation step is the four-hour proof-and-context spike. It settles the largest new dependency before changes to the live user flow.
