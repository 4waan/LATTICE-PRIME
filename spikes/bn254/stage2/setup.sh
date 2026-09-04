set -e
cd "$(dirname "$0")"
snark() { node --max-old-space-size=4096 node_modules/.bin/snarkjs "$@"; }
for c in trivial five; do
  echo "======== $c ========"
  snark groth16 setup build/$c.r1cs powersOfTau28_hez_final_12.ptau build/${c}_0000.zkey 2>&1 | tail -2
  snark zkey contribute build/${c}_0000.zkey build/${c}_final.zkey \
     -n="hedera2026 spike1 stage2" -e="spike entropy $c $$ $(date +%s)" 2>&1 | tail -2
  snark zkey export verificationkey build/${c}_final.zkey build/${c}_vkey.json 2>&1 | tail -1
  case $c in trivial) N=Trivial;; five) N=Five;; esac
  snark zkey export solidityverifier build/${c}_final.zkey build/${N}Verifier.sol 2>&1 | tail -1
done
