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

record() { # <python expression below the deployment object>
    python3 -c "import json; d=json.load(open('deployments/296-venue.json')); print(d$1)"
}

# The deployment record is authoritative. Environment overrides remain useful
# while a new deployment is being assembled but are not required for an audit.
VENUE_CLOCK="${VENUE_CLOCK:-$(record "['policy']['EpochClock']")}"
VENUE_REGIME="${VENUE_REGIME:-$(record "['policy']['Regime']")}"
VENUE_PARAMS="${VENUE_PARAMS:-$(record "['policy']['ParameterRoot']")}"
VENUE_JOURNAL="${VENUE_JOURNAL:-$(record "['venue']['SeamJournal']")}"
VENUE_ENGINE="${VENUE_ENGINE:-$(record "['venue']['MatchingEngine']")}"
VENUE_CAP="${VENUE_CAP:-$(record "['venue']['VolumeCap']")}"
VENUE_HALT="${VENUE_HALT:-$(record "['venue']['TradingHalt']")}"
VENUE_VAULT="${VENUE_VAULT:-$(record "['venue']['RepoVault']")}"
VENUE_WATCH="${VENUE_WATCH:-$(record "['venue']['MarginWatch']")}"
VENUE_RULEBOOK="${VENUE_RULEBOOK:-$(record "['venue']['Rulebook']")}"
VENUE_ORACLE="${VENUE_ORACLE:-$(record "['venue']['PrimeOracle']")}"
VENUE_RATE_FEED="${VENUE_RATE_FEED:-$(record "['venue']['HederaRateFeed']")}"
COUPON_SCHEDULE="${COUPON_SCHEDULE:-$(record "['coupon']['CouponSchedule']")}"
COUPON_DISTRIBUTOR="${COUPON_DISTRIBUTOR:-$(record "['coupon']['CouponDistributor']")}"

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
verify "$VENUE_ORACLE"   src/oracle/PrimeOracle.sol:PrimeOracle
verify "$VENUE_RATE_FEED" src/oracle/HederaRateFeed.sol:HederaRateFeed
verify "$COUPON_SCHEDULE" src/coupon/CouponSchedule.sol:CouponSchedule
verify "$VENUE_VAULT"    src/repo/RepoVault.sol:RepoVault
verify "$VENUE_WATCH"    src/observatory/MarginWatch.sol:MarginWatch
verify "$COUPON_DISTRIBUTOR" src/coupon/CouponDistributor.sol:CouponDistributor
verify "$VENUE_RULEBOOK" src/observatory/Rulebook.sol:Rulebook
