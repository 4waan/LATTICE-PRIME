#!/usr/bin/env bash
# Exports one ABI per contract.
#
# `deployments/abi/` is chain-bound because the live client combines it with
# addresses from deployments/296-venue.json. Local source may advance before
# those addresses do, so overwriting that directory requires the explicit
# post-deployment acknowledgement used by `make client`.
#
# Export a source preview without touching deployment evidence:
#   ABI_OUT=out/client-abi bash script/live/export-abis.sh
#
# `AtsToken` is not one of ours. It is the subset of the ATS diamond a client
# calls, taken from `script/ats/IAtsFactory.sol`, and it is exported alongside
# the venue's own so a UI does not have to vendor the whole 108-facet surface to
# read a balance.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=${ABI_OUT:-deployments/abi}
if [ "$OUT" = "deployments/abi" ] && [ "${DEPLOY_BOUND:-0}" != "1" ]; then
    echo "refusing to overwrite chain-bound deployments/abi" >&2
    echo "after a coordinated deployment, run: DEPLOY_BOUND=1 make client" >&2
    echo "for source ABIs, set ABI_OUT=out/client-abi" >&2
    exit 1
fi
mkdir -p "$OUT"

emit() { # <artifact dir>/<file>.json <contract> -> $OUT/<contract>.json
    local path="out/$1/$2.json"
    [ -f "$path" ] || { echo "missing $path (run forge build)" >&2; return 1; }
    python3 -c "
import json,sys
a=json.load(open('$path'))
json.dump(a['abi'], open('$OUT/$2.json','w'), indent=1)
print('  $2', len(a['abi']), 'entries')
"
}

echo "venue"
emit MatchingEngine.sol   MatchingEngine
emit OrderBook.sol        OrderBook
emit RepoVault.sol        RepoVault
emit PrimeOracle.sol      PrimeOracle
emit MarginWatch.sol      MarginWatch
# The coupon leg. The schedule is instrument reference data a client reads to
# show a calendar; the distributor is the one contract a holder sends a
# transaction to, and its `claim` takes a positional merkle proof rather than a
# sorted-pair one, so a client that guesses the shape from a library builds
# proofs it refuses. Exporting the ABI is how the shape stops being a guess.
emit CouponSchedule.sol    CouponSchedule
emit CouponDistributor.sol CouponDistributor
emit SeamJournal.sol      SeamJournal
emit Rulebook.sol         Rulebook
emit VolumeCap.sol        VolumeCap
emit TradingHalt.sol      TradingHalt
emit Regime.sol           Regime
emit ParameterRoot.sol    ParameterRoot
emit EpochClock.sol       EpochClock
emit ZkKycRegistry.sol    ZkKycRegistry
emit RegistrationGate.sol RegistrationGate

echo "the ATS surface a client touches"
emit IAtsFactory.sol      IAtsToken
# The hold rail. A seller cannot reveal without `createHoldByPartition`, and the
# engine reads the hold back at reveal and again at every cross, so a client that
# cannot encode these cannot trade. Exported for the same reason as the token
# subset above: so the UI does not vendor 108 facets to create one hold.
emit IHoldByPartition.sol IHoldByPartition

echo "wrote $OUT"
