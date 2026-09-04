#!/bin/bash
# a design decision: PLONK versus Groth16, same circuit, same machine, same day.
#
# a design decision's table has Groth16 verify gas as [MEASURED] 214,202 and PLONK as
# [INFERRED] ~290,000. The decision leans PLONK on the ceremony argument, so the
# number the decision turns against is the one nobody has measured. That is the
# same shape as spike 1's bn254 assumption: an inference from an absence,
# underneath the whole design.
#
# Both systems, one circuit, one ptau, so the comparison has nothing else in it.
set -e
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22.21.1 >/dev/null 2>&1
export PATH="$HOME/.cargo/bin:$PATH"
snark() { node --max-old-space-size=4096 node_modules/.bin/snarkjs "$@"; }
PTAU=powersOfTau28_hez_final_12.ptau
mkdir -p build

echo "=== compile ==="
circom trivial.circom --r1cs --wasm -o build/ | tail -4

echo "=== witness (a=3, b=11, so c=33) ==="
cat > build/input.json <<'J'
{"a": "3", "b": "11"}
J
node build/trivial_js/generate_witness.js build/trivial_js/trivial.wasm build/input.json build/witness.wtns

echo
echo "=== GROTH16, the control: it must reproduce the recorded 214,202 ==="
snark groth16 setup build/trivial.r1cs $PTAU build/g16_0000.zkey 2>&1 | tail -1
snark zkey contribute build/g16_0000.zkey build/g16_final.zkey \
  -n="d09 comparison" -e="d09 $$ $(date +%s)" 2>&1 | tail -1
snark zkey export verificationkey build/g16_final.zkey build/g16_vkey.json 2>&1 | tail -1
snark zkey export solidityverifier build/g16_final.zkey build/Groth16Verifier.sol 2>&1 | tail -1
snark groth16 prove build/g16_final.zkey build/witness.wtns build/g16_proof.json build/g16_public.json
snark groth16 verify build/g16_vkey.json build/g16_public.json build/g16_proof.json
snark zkey export soliditycalldata build/g16_public.json build/g16_proof.json > build/g16_calldata.txt

echo
echo "=== PLONK, no phase 2 at all: the universal ptau is the whole setup ==="
snark plonk setup build/trivial.r1cs $PTAU build/plonk_final.zkey 2>&1 | tail -1
snark zkey export verificationkey build/plonk_final.zkey build/plonk_vkey.json 2>&1 | tail -1
snark zkey export solidityverifier build/plonk_final.zkey build/PlonkVerifier.sol 2>&1 | tail -1
snark plonk prove build/plonk_final.zkey build/witness.wtns build/plonk_proof.json build/plonk_public.json
snark plonk verify build/plonk_vkey.json build/plonk_public.json build/plonk_proof.json
snark zkey export soliditycalldata build/plonk_public.json build/plonk_proof.json > build/plonk_calldata.txt

echo
echo "=== sizes ==="
printf "  groth16 proof   %6s bytes json\n" "$(wc -c < build/g16_proof.json)"
printf "  plonk   proof   %6s bytes json\n" "$(wc -c < build/plonk_proof.json)"
printf "  groth16 calldata %5s hex chars\n" "$(wc -c < build/g16_calldata.txt)"
printf "  plonk   calldata %5s hex chars\n" "$(wc -c < build/plonk_calldata.txt)"
printf "  groth16 verifier %5s bytes sol\n" "$(wc -c < build/Groth16Verifier.sol)"
printf "  plonk   verifier %5s bytes sol\n" "$(wc -c < build/PlonkVerifier.sol)"
