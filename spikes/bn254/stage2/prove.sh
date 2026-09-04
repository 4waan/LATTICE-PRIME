set -e
cd "$(dirname "$0")"
snark() { node --max-old-space-size=4096 node_modules/.bin/snarkjs "$@"; }
for c in trivial five; do
  echo "======== $c ========"
  node build/${c}_js/generate_witness.js build/${c}_js/${c}.wasm build/${c}_input.json build/${c}.wtns
  snark groth16 prove build/${c}_final.zkey build/${c}.wtns build/${c}_proof.json build/${c}_public.json 2>&1 | tail -1
  echo "public signals: $(cat build/${c}_public.json | tr -d '\n ')"
  snark groth16 verify build/${c}_vkey.json build/${c}_public.json build/${c}_proof.json 2>&1 | tail -1
done
