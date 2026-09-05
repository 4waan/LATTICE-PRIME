#!/usr/bin/env bash
# Source-verifies the deployed venue on Sourcify, which is what HashScan reads.
#
# The trailing slash on the verifier URL is load bearing. Forge appends `v2` to
# whatever it is given, so `https://sourcify.dev/server` becomes
# `https://sourcify.dev/serverv2` and fails with a DNS error that says nothing
# about the cause. `server-verify.hashscan.io` answers 308 redirects rather than
# verifying; `sourcify.dev/server` lists chain 296 as supported and does the
# work.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(cd .. && pwd)"
set -a; . "$ROOT/.env"; set +a

VERIFIER_URL="https://sourcify.dev/server/"

verify() { # <address> <src:Contract>
    echo "--- $2 at $1"
    forge verify-contract "$1" "$2" \
        --chain-id 296 --verifier sourcify --verifier-url "$VERIFIER_URL" \
        --watch || echo "  FAILED (continuing)"
}

: "${VENUE_CLOCK:?}" "${VENUE_REGIME:?}" "${VENUE_PARAMS:?}" "${VENUE_JOURNAL:?}"
: "${VENUE_ENGINE:?}" "${VENUE_CAP:?}" "${VENUE_HALT:?}" "${VENUE_VAULT:?}"
: "${VENUE_WATCH:?}" "${VENUE_RULEBOOK:?}"

verify "$VENUE_CLOCK"    src/policy/EpochClock.sol:EpochClock
verify "$VENUE_REGIME"   src/policy/Regime.sol:Regime
verify "$VENUE_PARAMS"   src/policy/ParameterRoot.sol:ParameterRoot
verify "$VENUE_JOURNAL"  src/observatory/SeamJournal.sol:SeamJournal
verify "$VENUE_ENGINE"   src/market/MatchingEngine.sol:MatchingEngine
verify "$VENUE_CAP"      src/policy/VolumeCap.sol:VolumeCap
verify "$VENUE_HALT"     src/policy/TradingHalt.sol:TradingHalt
verify "$VENUE_VAULT"    src/repo/RepoVault.sol:RepoVault
verify "$VENUE_WATCH"    src/observatory/MarginWatch.sol:MarginWatch
verify "$VENUE_RULEBOOK" src/observatory/Rulebook.sol:Rulebook
