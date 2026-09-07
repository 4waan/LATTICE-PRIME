# Reproducibility for the venue. Every number quoted in docs/ comes from one of
# these targets. `make all` from a clean checkout reproduces the lot.
#
# node must be 22.x. The PATH default on this machine is 16, which fails silently
# in ways that look like circom bugs, so every node target sets it explicitly.

TOOLCHAIN := /Users/awaansiddiqui/hedera2026/toolchain
SNARK     := $(TOOLCHAIN)/node_modules/.bin/snarkjs
PTAU      := $(TOOLCHAIN)/ptau/powersOfTau28_hez_final_15.ptau
NODE      := . $$HOME/.nvm/nvm.sh && nvm use 22.21.1 >/dev/null &&

.PHONY: all build test sizes circuit fixtures prove-live verifier clean report census rulebook vectors pages app client prove-live-epoch beat hcs-topic hcs-relay hcs-verify

all: build census circuit verifier fixtures pages app test report

build:
	forge build

test:
	forge test

sizes:
	forge build --sizes

# Compile the circuit and print the constraint count that decides the ptau power.
circuit:
	mkdir -p circuits/build
	$(NODE) circom circuits/kyc.circom --r1cs --wasm --sym -o circuits/build -l $(TOOLCHAIN)/node_modules

# PLONK setup. D-09: universal ceremony, no project trusted setup.
setup: circuit
	$(NODE) $(SNARK) plonk setup circuits/build/kyc.r1cs $(PTAU) circuits/build/kyc.zkey
	$(NODE) $(SNARK) zkey export verificationkey circuits/build/kyc.zkey circuits/build/vkey.json

verifier: setup
	$(NODE) $(SNARK) zkey export solidityverifier circuits/build/kyc.zkey /tmp/KycVerifier.raw.sol
	@echo "regenerated. re-apply the header in src/kyc/KycVerifier.sol by hand:"
	@echo "  the GPL notice, the rename to KycVerifier, and the warning about passes"

# One issuer tree, five proofs, all verified before they become fixtures.
fixtures:
	$(NODE) node circuits/gen-input.mjs
	$(NODE) node circuits/mk-fixtures.mjs

# Proofs for real addresses, against the root already published on chain for
# epoch 7. Not part of `all`: it needs addresses, and it writes evidence rather
# than fixtures. ADDRS is a space separated list.
#   make prove-live ADDRS="0xabc... 0xdef..."
prove-live:
	@test -n "$(ADDRS)" || { echo 'usage: make prove-live ADDRS="0x... 0x..."'; exit 1; }
	$(NODE) node circuits/prove-live.mjs $(ADDRS)

# The same proofs for a future KYC epoch, generated before it arrives.
#
# A grant dies at the epoch boundary with no transaction from anyone, and
# `RegistrationGate.register` pins public signal 3 to the registry's current
# epoch, so the recovery needs a fresh proof per actor and each one takes about
# twenty-three seconds. Generating them at the boundary is the outage; generating
# them now is a file. `register` refuses a proof for an epoch that has not
# arrived, which is what makes holding one safe.
#
#   make prove-live-epoch EPOCH=8 ADDRS="0x... 0x..."
#   script/live/renew-kyc.sh renew 8    # once the clock rolls
prove-live-epoch:
	@test -n "$(ADDRS)" || { echo 'usage: make prove-live-epoch EPOCH=8 ADDRS="0x... 0x..."'; exit 1; }
	@test -n "$(EPOCH)" || { echo 'usage: make prove-live-epoch EPOCH=8 ADDRS="0x... 0x..."'; exit 1; }
	$(NODE) node circuits/prove-live.mjs --epoch $(EPOCH) $(ADDRS)

# The callstack census over the ATS lifecycle surface. Reads the vendored clone
# at v8.0.0, writes the markdown a reviewer reads and the Solidity the test suite
# asserts against. Generated, never hand edited: `SeamMap.sol` is the census and
# nothing else, so a claim in `test/SeamCoverage.t.sol` cannot outlive the
# measurement that produced it.
census:
	$(NODE) node tools/keccak.test.mjs
	$(NODE) node tools/callstack.mjs --json docs/callstack.json --md docs/CALLSTACK.md
	$(NODE) node tools/gen-seammap.mjs docs/callstack.json src/observatory/SeamMap.sol

# Every client-side copy of arithmetic a contract also performs, checked before
# anything inlines it. Both `pages` and `app` are built out of these modules, so
# neither can be built without the copies still agreeing with the chain.
#
#   keccak.mjs     -> three published vectors, and the hash under every id
#   commitment.mjs -> OrderBook.commitmentOf     test/CommitmentVectors.t.sol
#   lattice.mjs    -> the five DisclosureView getters  test/ReceiptVectors.t.sol
#   units.mjs      -> CallAuction.notional and the market parameters
#                                                test/UnitVectors.t.sol
#   entitlements.mjs -> MerkleSet as CouponDistributor uses it: the tree is
#                      positional and promotes its odd node, so a sorted-pair
#                      library builds roots it will not recognise
#                                                test/UnitVectors.t.sol
#   hcs.mjs        -> the topic record schema, the silence table, and the audit
#                      that says a record matches the chain
#                                                 deployments/abi/*.json
vectors:
	$(NODE) node tools/keccak.test.mjs
	$(NODE) node tools/commitment.test.mjs
	$(NODE) node tools/lattice.test.mjs
	$(NODE) node tools/units.test.mjs
	$(NODE) node tools/entitlements.test.mjs
	$(NODE) node tools/hcs.test.mjs

# The two pages a trader reads: the commitment before signing `commit(bytes32)`,
# and the disclosure receipt after acting.
pages: vectors
	$(NODE) node tools/gen-preview.mjs
	$(NODE) node tools/gen-receipt.mjs

# The live client: a front door and the three screens behind it, written to
# app/. Templates in, one self-contained HTML file per screen out. No bundler
# and no backend, and nothing fetched at run time but ethers and the chain.
#
# Reads deployments/client.json and deployments/abi/*, both committed, so this
# builds offline. `make client` is what regenerates those off chain 296, and it
# is deliberately not a prerequisite: rebuilding the UI must never be able to
# move the address book underneath it.
app: vectors
	$(NODE) node tools/gen-app.mjs

# The receipt beat, on chain: two sealed orders committed and both withdrawn
# inside one disclosure epoch, with the second withdrawal going through in
# silence. Not part of `all`, and never will be: it sends four transactions and
# spends 0.002 HBAR in cancel fees.
#
# `plan` reads the chain and says whether the window is open; `run` sends.
# `sweep` forfeits a commitment whose thirty-second cancel window shut before the
# cancel landed, which recovers the bond and, deliberately, charges nothing
# against row 15. `test_aSweptBondDoesNotSpendTheActivityRow` is that claim.
#
#   make beat            # plan only, sends nothing
#   make beat MODE=run
beat:
	bash script/live/receipt-beat.sh $(or $(MODE),plan)

# What a frontend compiles against: the ABIs out of `out/`, the addresses out of
# the deployment records, and the immutables read back off chain 296. One file,
# generated, so a client cannot be holding an address book that drifted.
client:
	bash script/live/export-abis.sh
	$(NODE) node tools/gen-client.mjs

# The disclosure record on a Hedera Consensus Service topic. `docs/HCS-SCOPE.md`
# is the argument and `docs/HCS.md` is what was built.
#
# A contract in the Hedera EVM cannot create a topic, submit to one, or read one:
# `0x167` is the only system contract that answers, and HIP-478 specifies an
# oracle between the two services rather than a precompile. So the relay is the
# specified pattern, not a workaround, and the verifier is what stops it being
# taken on trust.
#
#   make hcs-topic          # once, ever. Costs about $0.01 and writes deployments/hcs.json
#   make hcs-relay          # poll and publish until interrupted
#   make hcs-relay MODE=dry # build every record, submit none
#   make hcs-verify         # read the topic back and check it against the chain
#
# `hcs-topic` is deliberately not a prerequisite of anything: creating a second
# topic would split the record in two and neither half would be the venue's.
hcs-topic:
	$(NODE) node tools/hcs-topic.mjs

hcs-relay:
	$(NODE) node tools/hcs-relay.mjs $(if $(filter dry,$(MODE)),--dry-run,$(if $(filter once,$(MODE)),--once,))

# Writes the machine readable result next to the receipt beat's, and exits
# non-zero on any mismatch, so this is safe to put in front of a release.
hcs-verify: vectors
	$(NODE) node tools/hcs-verify.mjs
	$(NODE) node tools/hcs-verify.mjs --json > deployments/hcs-verify.json

report:
	@echo
	@echo "== constraint budget =="
	@$(NODE) $(SNARK) r1cs info circuits/build/kyc.r1cs 2>/dev/null | grep -E "Constraints|Public|Private" || true
	@echo
	@echo "== deployed size vs EIP-170 =="
	@forge build --sizes 2>/dev/null | grep -E "Contract|KycVerifier|ZkKycRegistry|RegistrationGate|RepoVault|MarginWatch|OrderBook|AxeBoard|SeamJournal|Rulebook|TradingHalt"
	@echo
	@echo "== callstack census =="
	@$(NODE) node -e "const c=require('./docs/callstack.json'); \
	  const es=c.facets.flatMap(f=>f.entries||[]); \
	  const mv=es.filter(e=>e.writes.some(w=>['W:transfer','W:issue','W:redeem','W:holdMove'].includes(w))); \
	  console.log('  entry points measured:', es.length); \
	  console.log('  reach a seam:         ', es.filter(e=>e.seams.length).length); \
	  console.log('  move value:           ', mv.length); \
	  console.log('  move value, no seam D:', mv.filter(e=>!e.seams.includes('D')).length);"

# The published rulebook hash. `Rulebook.sol` commits to it and
# `test/Rulebook.t.sol` holds it as a constant, so editing the document without
# republishing fails the suite. This prints the value to paste back.
rulebook:
	@$(NODE) node -e "const {keccak_256}=require('js-sha3'); \
	  console.log('0x'+keccak_256(require('fs').readFileSync('docs/RULEBOOK.md')));"

clean:
	forge clean
	rm -rf circuits/build
