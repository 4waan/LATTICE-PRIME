#!/usr/bin/env bash
# Source-verifies the deployed venue on Sourcify, which is what HashScan reads.
# The v2 submission uses the full standard JSON input of the deployment script.
# This preserves every source file in the original compiler input and avoids
# Sourcify's extra-file metadata mismatch.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(cd .. && pwd)"
set -a; . "$ROOT/.env"; set +a

export SOURCIFY_URL="${SOURCIFY_URL:-https://sourcify.dev/server}"

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
VENUE_APPROVAL_WINDOW="${VENUE_APPROVAL_WINDOW:-$(record "['financing']['approvalWindow']['address']")}"

verify() { # <address> <src:Contract> [profile] [creation tx] [deployment input]
    local profile="${3:-default}"
    echo "--- $2 at $1"
    node tools/sourcify-standard-json.mjs "$1" "$2" "$profile" \
        "${4:-}" "${5:-$2}"
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
verify "$VENUE_ORACLE"   src/oracle/PrimeOracle.sol:PrimeOracle default \
    "$(record "['financing']['PrimeOracle']['deployTx']")" \
    script/DeployPrimeOracle.s.sol:DeployPrimeOracle
verify "$VENUE_RATE_FEED" src/oracle/HederaRateFeed.sol:HederaRateFeed
verify "$COUPON_SCHEDULE" src/coupon/CouponSchedule.sol:CouponSchedule
verify "$VENUE_VAULT"    src/repo/RepoVault.sol:RepoVault financing \
    "$(record "['financing']['RepoVault']['deployTx']")" \
    script/DeployFinancing.s.sol:DeployFinancing
verify "$VENUE_WATCH"    src/observatory/MarginWatch.sol:MarginWatch financing \
    "$(record "['financing']['MarginWatch']['deployTx']")" \
    script/DeployFinancing.s.sol:DeployFinancing
verify "$VENUE_APPROVAL_WINDOW" src/policy/ApprovalWindowCompliance.sol:ApprovalWindowCompliance financing \
    "$(record "['financing']['approvalWindow']['deployTx']")" \
    script/DeployApprovalWindow.s.sol:DeployApprovalWindow
verify "$COUPON_DISTRIBUTOR" src/coupon/CouponDistributor.sol:CouponDistributor
verify "$VENUE_RULEBOOK" src/observatory/Rulebook.sol:Rulebook

if [ -f deployments/financing-lifecycle.json ]; then
    demo() {
        python3 -c \
            "import json; d=json.load(open('deployments/financing-lifecycle.json')); print(d['deployment']['contracts']['$1']['address'])"
    }
    demo_tx() {
        python3 -c \
            "import json; d=json.load(open('deployments/financing-lifecycle.json')); print(d['deployment']['contracts']['$1']['tx'])"
    }
    verify "$(demo CouponSchedule)" src/coupon/CouponSchedule.sol:CouponSchedule financing \
        "$(demo_tx CouponSchedule)" script/DeployFinancingDemo.s.sol:DeployFinancingDemo
    verify "$(demo RepoVault)" src/repo/RepoVault.sol:RepoVault financing \
        "$(demo_tx RepoVault)" script/DeployFinancingDemo.s.sol:DeployFinancingDemo
    verify "$(demo MarginWatch)" src/observatory/MarginWatch.sol:MarginWatch financing \
        "$(demo_tx MarginWatch)" script/DeployFinancingDemo.s.sol:DeployFinancingDemo
    verify "$(demo ApprovalWindowCompliance)" src/policy/ApprovalWindowCompliance.sol:ApprovalWindowCompliance financing \
        "$(demo_tx ApprovalWindowCompliance)" script/DeployApprovalWindow.s.sol:DeployApprovalWindow
fi
