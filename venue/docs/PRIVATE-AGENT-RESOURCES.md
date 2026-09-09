# Private agent: build resources for GPT-5.6 Sol

Prepared 9 September 2026 for the three-phase [implementation plan](PRIVATE-AGENT-PLAN.md). This is a reading and acquisition order, not a record of installed dependencies or completed integration. Load resources when their phase needs them. Pin the versions that pass the first proof spike rather than combining examples from unrelated releases.

GPT-5.6 Sol is the coding agent building this feature. It is separate from the small local model whose inference EZKL will prove. Do not put the coding model, a hosted LLM endpoint, or its conversation history into the product's private inference path. The official [model reference](https://developers.openai.com/api/docs/models/gpt-5.6-sol) is relevant for model capabilities, not a substitute for project-specific specifications.

## 1. Read these local sources first

1. [PRIVATE-AGENT-PLAN.md](PRIVATE-AGENT-PLAN.md): the agreed phases, privacy scope, action limits, evidence claims, and release gates. This is the primary implementation brief.
2. [venue README](../README.md): the actual product boundary and existing build commands. Then inspect the current source and deployment metadata; historical prose is not proof of deployed behavior.
3. [UI-INTEGRATION-MAP.md](UI-INTEGRATION-MAP.md): account context, unit conversions, wiring checks, clocks, and the existing UI-to-contract calls. Some descriptive passages may lag current source, so verify the relevant selectors.
4. [FINANCING-DECISIONS.md](FINANCING-DECISIONS.md): approved and rejected economic choices. Read this to avoid accidentally extending a rejected financing model; financing remains outside the first agent action.
5. [DEMO-4MIN.md](DEMO-4MIN.md): the current recording constraints. It records a lifecycle longer than the video window. Re-read deployed clock getters and plan an honestly edited or staged recording; do not imply a full settlement fits into four minutes without checking.

Follow the user's current instructions and applicable AGENTS.md files. Preserve unrelated working-tree changes. Treat files listed as planned under `venue/agent/` as proposals until created; that directory was absent when this pack was prepared.

## 2. Phase 1: model, proof, privacy and local runtime

### EZKL: the first external resource to acquire

- [Pinned EZKL source](https://github.com/zkonduit/ezkl/tree/v23.0.5) and its [example notebooks](https://github.com/zkonduit/ezkl/tree/v23.0.5/examples/notebooks). Start with the smallest inference example from the selected release and make it run locally before adapting it.
- [Setup](https://docs.ezkl.xyz/getting-started/setup/), [prove](https://docs.ezkl.xyz/getting-started/prove/), and [verify](https://docs.ezkl.xyz/getting-started/verify/): extract the lifecycle, required artifacts, and verifier generation steps. Resolve exact API signatures from the pinned installed package and source.
- [Visibility implementation](https://github.com/zkonduit/ezkl/blob/v23.0.5/src/graph/vars.rs): inspect private inputs, fixed weights, public instances, and hashed outputs. Do not assume default settings provide the required model binding.

Acquire the source at an exact tag/commit into a separate research checkout, not the application bundle. Download setup artifacts before supplying private data. Record model, settings, keys, SRS provenance and hashes. The existing snarkjs eligibility circuit and its verifier are useful integration examples, but their proofs and setup artifacts are not interchangeable with EZKL artifacts.

Required extraction: one runnable command sequence, installed versions, input/output schema, public-instance layout, and valid plus tampered proof results. Required measurement: setup and prove time, peak memory, proof size, and exact context round trips on the actual demo machine. Do not take a benchmark from another model as this model's latency.

### PyTorch and ONNX: the executable model definition

- [PyTorch ONNX export](https://docs.pytorch.org/docs/stable/onnx): determine exporter, fixed shapes, parameter handling, and an opset compatible with the selected EZKL version. Do not automatically select the newest opset.
- [ONNX checker](https://onnx.ai/onnx/api/checker.html) and [shape inference](https://onnx.ai/onnx/api/shape_inference.html): validate graph structure and inspect actual tensor shapes and graph outputs.

Required extraction: a frozen graph with a small supported operation set, explicit integer/scaling conventions, deterministic ties, and no unexpected outputs or custom executable operators. ONNX validity and inferred shapes do not establish confidentiality or compatibility with EZKL. Test each separately.

Use synthetic scenario data with a recorded seed and provenance. A small fixture corpus must include threshold boundaries, equal-category pairs, out-of-range inputs, altered context, and malformed arrays. The building agent should not receive real investor information, credentials, private order tickets, wallet keys, or production witnesses for debugging. Optional ONNX Runtime comparison can help isolate export mistakes; it does not establish the formal semantics of the ZK circuit.

### Formal privacy: the source for the actual claim

- [Information-flow and noninterference mechanics](https://www.cs.cornell.edu/courses/cs5430/2012sp/MCinfo01.iflow_lecture_1.html): identify explicit, implicit, timing, and termination channels.
- [Robust declassification](https://www.cs.cornell.edu/andru/papers/robdecl-jcs/): specify which release function is permitted and prevent the model from choosing its own disclosure policy.
- [Z3 guide](https://microsoft.github.io/z3guide/docs/logic/intro/) and [bitvectors](https://microsoft.github.io/z3guide/docs/theories/Bitvectors/): encode two executions of the restricted integer computation with correct bounds and overflow semantics.

Required extraction: the exact quantified claim, domains, permitted disclosure function, excluded outputs/channels, solver query, and correspondence argument to the deployed graph. Model signedness, scaling and rounding explicitly. An unsatisfiable formula about an inaccurate translation proves the wrong program. Tests can check examples and translation bugs; do not label them a proof of equivalence.

### Runtime isolation and authorization

- [Docker none networking](https://docs.docker.com/engine/network/drivers/none/): the worker's process/network boundary. Pair it with restricted mounts, resources, environment, and typed IPC.
- [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html): protect the local bridge against hostile webpages using explicit origin and request authorization checks.
- Local [VibeSec skill](/Users/awaansiddiqui/.agents/skills/vibesec-skill/SKILL.md): apply to the local API, browser UI, imports, signing requests, and private data handling. Its generic server-side-secrets guidance means the local signer owns secrets here, not that user data should move to a hosted backend.

Required extraction: a capability map naming which process may see each input, sign each action, or access each endpoint. Test the boundary with synthetic exfiltration attempts. A packet capture or signed runtime log is observation, not proof that all host processes were silent.

## 3. Phase 2: protocol integration and independent checks

Pull these local files together with their tests:

- [OrderBook.sol](../src/market/OrderBook.sol), [MatchingEngine.sol](../src/market/MatchingEngine.sol), [OrderBook tests](../test/OrderBook.t.sol), [MatchingEngine tests](../test/MatchingEngine.t.sol), and [cancel tests](../test/OrderCancel.t.sol). Extract caller binding, backing requirements, reveal/cancel boundaries, retirement, and credit recovery.
- [commitment.mjs](../tools/commitment.mjs), [commitment vectors](../test/CommitmentVectors.t.sol), [units.mjs](../tools/units.mjs), and [unit vectors](../test/UnitVectors.t.sol). Reuse the exact encoding and integer conversions. Independent mutation cases must catch a wrong account, quantity, value scale, or commitment preimage.
- [DisclosureView.sol](../src/lattice/DisclosureView.sol), [lattice.mjs](../tools/lattice.mjs), and [receipt vectors](../test/ReceiptVectors.t.sol). Add decision evidence to the existing receipt while keeping each guarantee's scope separate.
- [KYC registration tests](../test/KycRegistration.t.sol) and current registration/registry source. The agent cannot invent eligibility or ignore epoch renewal.
- [Verifier probe notes](../../spikes/bn254/stage2/README.md) and their tests: examples of real positive and negative verifier checks on the target environment. Use as test patterns; they are not evidence that an EZKL verifier already works on Hedera.

External references:

- [ethers v6](https://docs.ethers.org/v6/): transaction construction, ABI encoding/decoding and receipt handling using the repository's installed version.
- [Hedera Ethereum transactions](https://docs.hedera.com/native/smart-contracts/ethereum-transaction): transport behavior and target-chain limitations. Prefer measured repository conversions when building the actual adapter and verify them on the selected deployment.
- [Independent regression verification skill](/Users/awaansiddiqui/.agents/skills/independent-regression-verification/SKILL.md): especially useful for context encoding, monetary conversions, quantization, commitment correspondence and proof rejection checks. Use reference computations that do not share the production helper's assumptions.

Read deployment manifests locally, then verify code and relevant getters on-chain. Prepare a dedicated funded eligible buyer and a prepared eligible seller for the first real fill. Confirm key type, nonces, phase windows, and available fees. A mock counterparty or a successful cross call is insufficient evidence of a real fill.

The repository has a Hedera MCP server configured in `.codex/config.toml`. Configuration was observed; connectivity and current tool permissions were not tested. It can be assessed for public/testnet diagnostics when available. It is external, so do not send it private preferences, secrets, or proof witnesses. The product's critical executor should use the typed adapter rather than inherit a generic MCP tool catalog.

## 4. Phase 3: product integration, testing and pitch

Read [venue-app.mjs](../tools/venue-app.mjs), [venue-obs.mjs](../tools/venue-obs.mjs), [gen-app.mjs](../tools/gen-app.mjs), and the existing [market](../app/trade.template.html), [portfolio](../app/position.template.html), and [landing](../app/index.template.html) templates. Reuse the current styles and interaction patterns. Build from template/shared sources, not generated pages.

Use [Playwright's testing guidance](https://playwright.dev/docs/best-practices) for the visible journey: ticket to mandate, local pairing, pause, restart, wrong network, refusal and receipt verification. Use synthetic data and local traces. Test user-visible behavior and isolate sessions; do not upload private screenshots, storage states, or traces to a debugging service.

For pitch changes, load the copy package in the implementation plan, [DEMO-4MIN.md](DEMO-4MIN.md), [OUTLINE.md](OUTLINE.md), and both READMEs. The repository also contains [build-deck.py](../tools/build-deck.py), which writes a Keynote deck, and `venue/docs/LatticePrime.pptx`. Establish which file is the active deck source before editing or regenerating. Use the [presentations skill](/Users/awaansiddiqui/.codex/plugins/cache/openai-primary-runtime/presentations/26.905.11957/skills/presentations/SKILL.md) when working on the deck. Its path is session-specific and may need discovery in another environment.

Required extraction: a shared UI state map, combined receipt view, coordinated copy changes, and a recording plan that respects actual chain clocks. Apply the headline "Trade tokenised bonds with your private agent" only when the corresponding feature is delivered. Preserve the distinction between local inference verification and on-chain enforcement.

## 5. Minimal working toolchain

Keep the existing Node 22, ethers, Foundry and static page generator. Add an isolated Python environment with a compatible pinned set of EZKL, PyTorch, ONNX, NumPy and z3-solver packages. Record the exact versions that pass the spike, including any exporter dependencies. Do not upgrade the repository's unrelated packages to match a tutorial.

The machine also needs local process isolation, enough memory and disk for measured proving artifacts, browser testing, and access to Hedera testnet through the configured adapter. A GPU is not a prerequisite to assume for a tiny model; decide from measurements. The spike must confirm native platform support and wheel availability.

Use terminal/filesystem access to inspect and run code, web/GitHub access to read official source, Foundry for contract behavior, a browser for UI checks, and RPC for chain evidence. No new agent framework, vector database, hosted model service, or cloud prover is required by the first release. HCS and HTS skills become relevant only when an implementation actually touches those services.

## 6. Suggested handoff prompt

> Implement the three-phase plan in venue/docs/PRIVATE-AGENT-PLAN.md. Use venue/docs/PRIVATE-AGENT-RESOURCES.md as the resource index and load the references needed for the current phase. Start with the Phase 1 proof-and-context spike. Pin a working dependency set and produce a real proof plus tampered-output/context/key rejection evidence before connecting live actions. Keep the model separate from signing and networking. Reuse the existing commitment, unit, eligibility, market and disclosure code during Phase 2. Integrate the existing Markets, Portfolio and receipt journey during Phase 3. Preserve unrelated changes. Record source versions, executed checks, measured limits, remaining proof assumptions and the phase exit result. Never represent logs as a no-egress proof or a verifier sidecar as contract-enforced delegation.

At each phase boundary, produce a short evidence index with changed files, commands run, results, artifact hashes, and open limitations. This gives the building agent a concrete next step and makes review independent of its narrative.
