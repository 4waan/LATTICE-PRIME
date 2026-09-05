# Reproducibility for the venue. Every number quoted in docs/ comes from one of
# these targets. `make all` from a clean checkout reproduces the lot.
#
# node must be 22.x. The PATH default on this machine is 16, which fails silently
# in ways that look like circom bugs, so every node target sets it explicitly.

TOOLCHAIN := /Users/awaansiddiqui/hedera2026/toolchain
SNARK     := $(TOOLCHAIN)/node_modules/.bin/snarkjs
PTAU      := $(TOOLCHAIN)/ptau/powersOfTau28_hez_final_15.ptau
NODE      := . $$HOME/.nvm/nvm.sh && nvm use 22.21.1 >/dev/null &&

.PHONY: all build test sizes circuit fixtures verifier clean report census rulebook preview

all: build census circuit verifier fixtures preview test report

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

# The callstack census over the ATS lifecycle surface. Reads the vendored clone
# at v8.0.0, writes the markdown a reviewer reads and the Solidity the test suite
# asserts against. Generated, never hand edited: `SeamMap.sol` is the census and
# nothing else, so a claim in `test/SeamCoverage.t.sol` cannot outlive the
# measurement that produced it.
census:
	$(NODE) node tools/keccak.test.mjs
	$(NODE) node tools/callstack.mjs --json docs/callstack.json --md docs/CALLSTACK.md
	$(NODE) node tools/gen-seammap.mjs docs/callstack.json src/observatory/SeamMap.sol

# The preview a trader sees before signing `commit(bytes32)`. Its id comes from
# `tools/commitment.mjs`, pinned to `OrderBook.commitmentOf` by
# `test/CommitmentVectors.t.sol`, so the vectors run before the page is built.
preview:
	$(NODE) node tools/commitment.test.mjs
	$(NODE) node tools/gen-preview.mjs

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
