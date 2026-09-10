#!/usr/bin/env bash
# Deploy, fund, arm, decommission, or inspect the PrimeOracle HSS scheduler.
set -euo pipefail
cd "$(dirname "$0")/../.."

MODE="${1:-status}"
FUND_HBAR="${2:-50}"
set -a
. ../.env
set +a

RPC="$HEDERA_TESTNET_RPC"
ORACLE="${PRIME_ORACLE:-$(python3 -c \
    "import json; print(json.load(open('deployments/client.json'))['addresses']['PrimeOracle'])")}"
RECORD="deployments/oracle-scheduler.json"
SCHEDULER="${ORACLE_SCHEDULER:-}"
if [ -z "$SCHEDULER" ] && [ -f "$RECORD" ]; then
    SCHEDULER="$(python3 -c "import json; print(json.load(open('$RECORD'))['address'])")"
fi

if [ "$MODE" = "deploy" ]; then
    export PRIME_ORACLE="$ORACLE"
    forge script script/DeployOracleScheduler.s.sol:DeployOracleScheduler \
        --rpc-url "$RPC" --broadcast --legacy
    LATEST="broadcast/DeployOracleScheduler.s.sol/296/run-latest.json"
    python3 - "$LATEST" "$RECORD" "$ORACLE" <<'PY'
import datetime
import json
import os
import sys

latest, record, oracle = sys.argv[1:]
data = json.load(open(latest))
previous = json.load(open(record)) if os.path.exists(record) else None
creates = [row for row in data["transactions"] if row.get("transactionType") == "CREATE"]
if len(creates) != 1:
    raise SystemExit(f"expected one CREATE, found {len(creates)}")
row = creates[0]
out = {
    "schema": "lattice.oracle.scheduler.v1",
    "deployedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "address": row["contractAddress"],
    "oracle": oracle,
    "treasury": os.environ["HEDERA_EVM_ADDRESS"],
    "transactionHash": row["hash"],
    "chainId": 296,
    "configuration": {
        "initialDelaySeconds": int(os.environ.get("ORACLE_SCHEDULER_INITIAL_DELAY", "90")),
        "retrySeconds": [300, 900, 3600],
        "maximumUnchangedChecks": 4,
        "maximumChecksPerRound": 8,
        "executionClockToleranceSeconds": 2,
        "minimumBalanceTinybar": "500000000",
    },
}
if previous and previous.get("address", "").lower() != out["address"].lower():
    prior = {
        "address": previous["address"],
        "transactionHash": previous["transactionHash"],
    }
    history = previous.get("supersedes", [])
    if isinstance(history, dict):
        history = [history]
    out["supersedes"] = [prior, *history]
open(record, "w").write(json.dumps(out, indent=2) + "\n")
print(json.dumps(out))
PY
    exit 0
fi

if [ -z "$SCHEDULER" ]; then
    echo "No scheduler address. Run '$0 deploy' or set ORACLE_SCHEDULER." >&2
    exit 1
fi

call() {
    cast call "$SCHEDULER" "$@" --rpc-url "$RPC"
}

if [ "$MODE" = "fund" ]; then
    cast send "$SCHEDULER" --value "${FUND_HBAR}ether" \
        --private-key "$HEDERA_PRIVATE_KEY" --rpc-url "$RPC" --legacy
elif [ "$MODE" = "arm" ]; then
    cast send "$SCHEDULER" "arm()(bool)" \
        --private-key "$HEDERA_PRIVATE_KEY" --rpc-url "$RPC" --legacy
elif [ "$MODE" = "tick" ]; then
    cast send "$SCHEDULER" "tick()(bool,bool)" \
        --private-key "$HEDERA_PRIVATE_KEY" --rpc-url "$RPC" --legacy
elif [ "$MODE" = "withdraw" ]; then
    BALANCE_WEIBAR="$(cast balance "$SCHEDULER" --rpc-url "$RPC")"
    BALANCE_TINYBAR="$(python3 -c "print(int('$BALANCE_WEIBAR') // 10_000_000_000)")"
    cast send "$SCHEDULER" "withdraw(address,uint256)" \
        "$HEDERA_EVM_ADDRESS" "$BALANCE_TINYBAR" \
        --private-key "$HEDERA_PRIVATE_KEY" --rpc-url "$RPC" --legacy \
        --gas-limit 500000
elif [ "$MODE" != "status" ]; then
    echo "usage: $0 [status|deploy|fund|arm|tick|withdraw] [fund-hbar]" >&2
    exit 1
fi

echo "scheduler      $SCHEDULER"
echo "oracle         $(call 'oracle()(address)')"
echo "treasury       $(call 'treasury()(address)')"
echo "balance weibar $(cast balance "$SCHEDULER" --rpc-url "$RPC")"
echo "active         $(call 'activeSchedule()(address)')"
echo "next check     $(call 'nextCheckAt()(uint64)')"
echo "tracked round  $(call 'trackedRound()(uint64)')"
echo "checked round  $(call 'lastCheckedRound()(uint64)')"
echo "finalized      $(call 'lastFinalizedRound()(uint64)')"
echo "retry streak   $(call 'retryStreak()(uint8)') / $(call 'MAX_RETRY_STREAK()(uint8)')"
echo "round checks   $(call 'checksThisRound()(uint8)') / $(call 'MAX_CHECKS_PER_ROUND()(uint8)')"
