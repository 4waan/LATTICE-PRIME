#!/usr/bin/env bash
# Exports the ABIs a client needs into deployments/abi/, one file per contract.
#
# The UI reads addresses from deployments/296-venue.json and shapes from here.
# Both are generated, so a client that compiles against them cannot be looking
# at an interface the chain does not have: `forge build` wrote `out/`, this
# copies the `abi` field out of it, and the addresses in the sibling file came
# from the broadcast receipts of the same build.
#
# `AtsToken` is not one of ours. It is the subset of the ATS diamond a client
# calls, taken from `script/ats/IAtsFactory.sol`, and it is exported alongside
# the venue's own so a UI does not have to vendor the whole 108-facet surface to
# read a balance.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=deployments/abi
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
emit MarginWatch.sol      MarginWatch
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
