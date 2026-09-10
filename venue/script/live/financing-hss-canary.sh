#!/usr/bin/env bash
# Resumable funded RepoVault canary for automatic Hedera Schedule Service execution.
#
# Usage:
#   script/live/financing-hss-canary.sh plan
#   script/live/financing-hss-canary.sh run
#
# The candidate remains outside deployments/client.json until this script records
# a successful native schedule. It never calls the permissionless settle fallback.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(cd .. && pwd)"
MODE="${1:-plan}"
case "$MODE" in
    plan|run) ;;
    *)
        echo "usage: $0 [plan|run]" >&2
        exit 2
        ;;
esac

set -a
. "$ROOT/.env"
. "$ROOT/.env.venue-actors"
set +a

: "${HEDERA_TESTNET_RPC:?set HEDERA_TESTNET_RPC}"
: "${SELLER_ADDRESS:?set SELLER_ADDRESS}"
: "${BUYER_ADDRESS:?set BUYER_ADDRESS}"
if [ "$MODE" = "run" ]; then
    : "${SELLER_PRIVATE_KEY:?set SELLER_PRIVATE_KEY}"
    : "${BUYER_PRIVATE_KEY:?set BUYER_PRIVATE_KEY}"
fi

RPC="$HEDERA_TESTNET_RPC"
MIRROR="${HEDERA_MIRROR_URL:-https://testnet.mirrornode.hedera.com}"
DEPLOYMENT="${CANDIDATE_DEPLOYMENT_RECORD:-deployments/.financing-deploy/candidate.json}"
CLIENT="deployments/client.json"
WORK="${CANARY_WORK_DIR:-deployments/.financing-hss-canary}"
STATE_FILE="$WORK/state.env"
OPEN_FILE="$WORK/open.env"
CLOSE_FILE="$WORK/close.env"
SCHEDULE_FILE="$WORK/schedule.env"
OUT="${CANARY_EVIDENCE_OUT:-deployments/financing-hss-canary.json}"

TERM_SECONDS="${TERM_SECONDS:-300}"
LOT="${LOT:-1}"
HAIRCUT="${HAIRCUT:-200}"
MAINT="${MAINT:-200}"
RATE="${RATE:-450}"
EXPIRES_IN="${EXPIRES_IN:-1800}"
SCHEDULING_DELAY_SECONDS=2
SEND_GAS_LIMIT="${SEND_GAS_LIMIT:-4000000}"
ZERO_ADDRESS=0x0000000000000000000000000000000000000000

[ -f "$DEPLOYMENT" ] || {
    echo "missing candidate deployment record $DEPLOYMENT" >&2
    echo "run CANDIDATE_DEPLOY_ACK=1 script/live/deploy-financing.sh candidate" >&2
    exit 1
}

field() {
    python3 - "$1" "$2" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))
for part in sys.argv[2].split("."):
    value = value[part]
print(value)
PY
}
n() { awk '{print $1}'; }
call() { cast call "$1" "$2" "${@:3}" --rpc-url "$RPC"; }
state_of() { call "$VAULT" "stateOf(bytes32)(uint8)" "$1" | n; }
credit_of() { call "$VAULT" "credit(address)(uint256)" "$1" | n; }
chain_now() {
    cast block latest --json --rpc-url "$RPC" |
        python3 -c 'import json,sys
v=json.load(sys.stdin)["timestamp"]
print(int(v, 16) if isinstance(v, str) and v.startswith("0x") else int(v))'
}
to_weibar() { python3 -c "print(int('$1') * 10_000_000_000)"; }
less_than() {
    python3 - "$1" "$2" <<'PY'
import sys
raise SystemExit(0 if int(sys.argv[1]) < int(sys.argv[2]) else 1)
PY
}
lower() { tr '[:upper:]' '[:lower:]'; }
assert_address() {
    local label="$1" actual="$2" expected="$3"
    if [ "$(printf '%s' "$actual" | lower)" != "$(printf '%s' "$expected" | lower)" ]; then
        echo "$label mismatch: got $actual, want $expected" >&2
        exit 1
    fi
}
mirror_get() {
    curl --fail --silent --show-error --retry 5 --retry-all-errors \
        --connect-timeout 15 "$MIRROR$1"
}

VAULT=$(field "$DEPLOYMENT" contracts.RepoVault.address)
VAULT_ID=$(field "$DEPLOYMENT" contracts.RepoVault.contractId)
WATCH=$(field "$DEPLOYMENT" contracts.MarginWatch.address)
TOKEN=$(field "$CLIENT" addresses.token)
REGISTRY=$(field "$CLIENT" addresses.ZkKycRegistry)
PARTITION=$(field "$CLIENT" immutables.partition)
ORACLE=$(call "$VAULT" "oracle()(address)" | n)
SCHEDULE=$(call "$VAULT" "schedule()(address)" | n)
BORROWER="$SELLER_ADDRESS"
LENDER="$BUYER_ADDRESS"

VERSION=$(call "$VAULT" "FINANCING_VERSION()(uint8)" | n)
RUNTIME_CODE=$(cast code "$VAULT" --rpc-url "$RPC")
RUNTIME_HASH=$(cast keccak "$RUNTIME_CODE")
EXPECTED_RUNTIME_HASH=$(field "$DEPLOYMENT" runtime.RepoVaultKeccak256)
KYC_B=$(call "$REGISTRY" "getKycStatus(address)(uint8)" "$BORROWER" | n)
KYC_L=$(call "$REGISTRY" "getKycStatus(address)(uint8)" "$LENDER" | n)
ORACLE_STALE=$(call "$ORACLE" "stale()(bool)" | n)
ALLOWANCE=$(call "$TOKEN" "allowance(address,address)(uint256)" "$BORROWER" "$VAULT" | n)
START_BALANCE=$(cast balance "$VAULT" --rpc-url "$RPC" | n)
NOW=$(chain_now)
HSS_CAPACITY=$(
    call 0x000000000000000000000000000000000000016b \
        "hasScheduleCapacity(uint256,uint256)(bool)" \
        "$((NOW + TERM_SECONDS + SCHEDULING_DELAY_SECONDS))" 750000 | n
)

[ "$VERSION" = "5" ] || { echo "candidate is not RepoVault v5" >&2; exit 1; }
[ "$RUNTIME_HASH" = "$EXPECTED_RUNTIME_HASH" ] || {
    echo "candidate runtime does not match its deployment record" >&2
    exit 1
}
[ "$KYC_B" = "1" ] && [ "$KYC_L" = "1" ] || {
    echo "both canary actors need current KYC grants" >&2
    exit 1
}
[ "$ORACLE_STALE" = "false" ] || { echo "candidate oracle is stale" >&2; exit 1; }
less_than "$ALLOWANCE" "$LOT" && {
    echo "candidate ATS allowance is $ALLOWANCE, below $LOT" >&2
    exit 1
}
assert_address "watch.vault" "$(call "$WATCH" "vault()(address)" | n)" "$VAULT"
assert_address "vault.security" "$(call "$VAULT" "security()(address)" | n)" "$TOKEN"
assert_address "vault.registry" "$(call "$VAULT" "registry()(address)" | n)" "$REGISTRY"

echo "candidate vault       $VAULT ($VAULT_ID)"
echo "candidate watch       $WATCH"
echo "runtime hash          $RUNTIME_HASH"
echo "term and HSS delay    $TERM_SECONDS + $SCHEDULING_DELAY_SECONDS seconds"
echo "HSS capacity          $HSS_CAPACITY"
echo "ATS allowance         $ALLOWANCE"

if [ -f "$OUT" ] && [ "$(field "$OUT" status 2>/dev/null || true)" = "verified" ]; then
    echo "automatic HSS canary already verified: $OUT"
    exit 0
fi
if [ "$MODE" = "plan" ]; then
    [ "$HSS_CAPACITY" = "true" ] || {
        echo "HSS has no capacity at the projected canary maturity" >&2
        exit 1
    }
    echo "plan only. No transactions sent."
    exit 0
fi

mkdir -p "$WORK"
for tmp in "$WORK"/*.tmp; do
    [ -s "$tmp" ] || continue
    if python3 - "$tmp" <<'PY'
import json, sys
try:
    value = json.load(open(sys.argv[1]))
    raise SystemExit(0 if value.get("status") in ("0x1", 1, "1") else 1)
except Exception:
    raise SystemExit(1)
PY
    then
        mv "$tmp" "${tmp%.tmp}.json"
    fi
done

if [ ! -f "$STATE_FILE" ]; then
    [ "$HSS_CAPACITY" = "true" ] || {
        echo "HSS has no capacity at the projected canary maturity" >&2
        exit 1
    }
    [ "$(call "$VAULT" "cashReserved()(uint256)" | n)" = "0" ] || {
        echo "fresh candidate has existing cash liabilities" >&2
        exit 1
    }
    [ "$(call "$VAULT" "reservedFunding()(uint256)" | n)" = "0" ] || {
        echo "fresh candidate has existing schedule reservations" >&2
        exit 1
    }
    FREE_START=$(call "$TOKEN" \
        "balanceOfByPartition(bytes32,address)(uint256)" "$PARTITION" "$BORROWER" | n)
    HELD_START=$(call "$TOKEN" \
        "getHeldAmountForByPartition(bytes32,address)(uint256)" "$PARTITION" "$BORROWER" | n)
    ID=$(cast keccak "lattice-prime automatic HSS canary $(date -u +%s) $RANDOM")
    TERMS="($PARTITION,$LOT,$HAIRCUT,$MAINT,$RATE,$TERM_SECONDS)"
    PRINCIPAL=$(call "$VAULT" \
        "quotePrincipal((bytes32,uint256,uint16,uint16,uint256,uint64))(uint256)" \
        "$TERMS" | n)
    cat > "$STATE_FILE" <<EOF
ID=$ID
BASELINE_AT=$NOW
FREE_START=$FREE_START
HELD_START=$HELD_START
VAULT_START_BALANCE=$START_BALANCE
PRINCIPAL=$PRINCIPAL
EOF
fi
# shellcheck disable=SC1090
. "$STATE_FILE"

TERMS="($PARTITION,$LOT,$HAIRCUT,$MAINT,$RATE,$TERM_SECONDS)"
VALUE=$(to_weibar "$PRINCIPAL")

send_once() {
    local tag="$1" key="$2"
    shift 2
    if [ -s "$WORK/$tag.json" ]; then
        echo "checkpoint $tag"
        return 0
    fi
    echo "send $tag"
    local sent=0 attempt
    for attempt in 1 2 3 4 5; do
        if cast send "$@" --private-key "$key" --rpc-url "$RPC" --legacy \
            --gas-limit "$SEND_GAS_LIMIT" \
            --json --timeout 300 > "$WORK/$tag.tmp"; then
            sent=1
            break
        fi
        echo "retry $tag after a transient send failure ($attempt/5)" >&2
        rm -f "$WORK/$tag.tmp"
        sleep 2
    done
    [ "$sent" = "1" ] || {
        echo "$tag could not be sent after five attempts" >&2
        exit 1
    }
    mv "$WORK/$tag.tmp" "$WORK/$tag.json"
    local status
    status=$(field "$WORK/$tag.json" status)
    if [ "$status" != "0x1" ] && [ "$status" != "1" ]; then
        echo "$tag returned status $status" >&2
        exit 1
    fi
    python3 script/live/_txline.py "$WORK/$tag.json" "$tag"
}

STATE=$(state_of "$ID")
if [ "$STATE" = "0" ] && [ ! -s "$WORK/fundOffer.json" ]; then
    LENDER_BALANCE=$(cast balance "$LENDER" --rpc-url "$RPC" | n)
    REQUIRED=$(python3 -c "print(int('$VALUE') + 25 * 10**18)")
    if less_than "$LENDER_BALANCE" "$REQUIRED"; then
        echo "lender lacks principal plus gas headroom" >&2
        exit 1
    fi
    EXPIRES=$(( $(chain_now) + EXPIRES_IN ))
    send_once fundOffer "$BUYER_PRIVATE_KEY" "$VAULT" \
        "fundOffer(bytes32,address,(bytes32,uint256,uint16,uint16,uint256,uint64),uint64)" \
        "$ID" "$BORROWER" "$TERMS" "$EXPIRES" --value "$VALUE"
fi

STATE=$(state_of "$ID")
if [ "$STATE" = "0" ]; then
    LIVE_PRINCIPAL=$(call "$VAULT" \
        "quotePrincipal((bytes32,uint256,uint16,uint16,uint256,uint64))(uint256)" \
        "$TERMS" | n)
    if [ "$LIVE_PRINCIPAL" != "$PRINCIPAL" ]; then
        send_once cancelMoved "$BUYER_PRIVATE_KEY" "$VAULT" "cancelOffer(bytes32)" "$ID"
        if [ "$(credit_of "$LENDER")" != "0" ]; then
            send_once withdrawRecovery "$BUYER_PRIVATE_KEY" "$VAULT" "withdraw()"
        fi
        echo "oracle mark moved before acceptance; lender funds recovered" >&2
        exit 1
    fi
    send_once accept "$SELLER_PRIVATE_KEY" "$VAULT" "accept(bytes32)" "$ID"
fi

STATE=$(state_of "$ID")
[ "$STATE" = "2" ] || [ "$STATE" = "7" ] || {
    echo "canary repo is in unexpected state $STATE" >&2
    exit 1
}

REPO_JSON=$(cast call "$VAULT" \
    "repo(bytes32)((uint8,address,address,bytes32,uint256,uint256,uint256,uint256,uint64,uint64,uint64,uint16,bytes32,bytes32))" \
    "$ID" --rpc-url "$RPC" --json)
REPO_JSON="$REPO_JSON" python3 - "$OPEN_FILE" <<'PY'
import json, os, pathlib, sys
repo = json.loads(os.environ["REPO_JSON"])[0]
pathlib.Path(sys.argv[1]).write_text(
    f"HOLD_ID={repo[4]}\nOPENED_AT={repo[8]}\nMATURITY={repo[9]}\n"
)
PY
# shellcheck disable=SC1090
. "$OPEN_FILE"

FAIL_OBLIGATION=$(call "$VAULT" "failObligation(bytes32)(bytes32)" "$ID" | n)
OBLIGATION=$(call "$VAULT" \
    "obligation(bytes32)(address,bytes32,uint64,uint256,uint8,uint8)" \
    "$FAIL_OBLIGATION")
SCHEDULE_ADDRESS=$(printf '%s\n' "$OBLIGATION" | awk 'NR == 1 {print $1}')
OBLIGATION_DUE=$(printf '%s\n' "$OBLIGATION" | awk 'NR == 3 {print $1}')
assert_address "obligation repo" \
    "$(printf '%s\n' "$OBLIGATION" | awk 'NR == 2 {print $1}')" "$ID"
[ "$OBLIGATION_DUE" = "$MATURITY" ] || {
    echo "economic obligation due $OBLIGATION_DUE does not match maturity $MATURITY" >&2
    exit 1
}
SCHEDULE_MISSING=0
if [ "$(printf '%s' "$SCHEDULE_ADDRESS" | lower)" = "$ZERO_ADDRESS" ]; then
    SCHEDULE_MISSING=1
fi
if [ ! -f "$SCHEDULE_FILE" ]; then
    RESERVED_OBSERVED=$(call "$VAULT" "reservedFunding()(uint256)" | n)
    cat > "$SCHEDULE_FILE" <<EOF
SCHEDULE_ADDRESS=$SCHEDULE_ADDRESS
SCHEDULE_MISSING=$SCHEDULE_MISSING
RESERVED_BEFORE=$RESERVED_OBSERVED
EOF
fi
# shellcheck disable=SC1090
. "$SCHEDULE_FILE"

if [ "$(credit_of "$BORROWER")" != "0" ]; then
    send_once withdrawBorrower "$SELLER_PRIVATE_KEY" "$VAULT" "withdraw()"
fi

STATE=$(state_of "$ID")
if [ "$STATE" = "2" ]; then
    REPAY=$(call "$VAULT" "repurchasePriceNow(bytes32)(uint256)" "$ID" | n)
    PENALTY=$(call "$VAULT" "settlementPenaltyNow(bytes32)(uint256)" "$ID" | n)
    DUE=$((REPAY + PENALTY))
    printf 'REPAY=%s\nPENALTY=%s\nDUE=%s\n' "$REPAY" "$PENALTY" "$DUE" > "$CLOSE_FILE"
    BORROWER_BALANCE=$(cast balance "$BORROWER" --rpc-url "$RPC" | n)
    CLOSE_REQUIRED=$(python3 -c "print(int('$(to_weibar "$DUE")') + 10 * 10**18)")
    if less_than "$BORROWER_BALANCE" "$CLOSE_REQUIRED"; then
        echo "borrower lacks close payment plus gas headroom" >&2
        exit 1
    fi
    send_once close "$SELLER_PRIVATE_KEY" "$VAULT" \
        "close(bytes32)" "$ID" --value "$(to_weibar "$DUE")"
fi
# shellcheck disable=SC1090
. "$CLOSE_FILE"

if [ "$(credit_of "$LENDER")" != "0" ]; then
    send_once withdrawLender "$BUYER_PRIVATE_KEY" "$VAULT" "withdraw()"
fi

[ "$(state_of "$ID")" = "7" ] || { echo "canary repo did not close" >&2; exit 1; }
[ "$(credit_of "$BORROWER")" = "0" ] || { echo "borrower credit remains" >&2; exit 1; }
[ "$(credit_of "$LENDER")" = "0" ] || { echo "lender credit remains" >&2; exit 1; }

if [ "$SCHEDULE_MISSING" = "1" ]; then
    echo "HSS did not create a schedule. Repo was closed and cash was drained." >&2
    echo "the current production binding remains authoritative; retry later" >&2
    exit 1
fi

if [ "$(chain_now)" -lt "$((MATURITY + SCHEDULING_DELAY_SECONDS))" ]; then
    [ "$RESERVED_BEFORE" = "500000000" ] || {
        echo "scheduled canary did not reserve five HBAR" >&2
        exit 1
    }
fi

wait_until() {
    local target="$1" label="$2" now delay
    now=$(chain_now)
    if [ "$now" -ge "$target" ]; then
        return 0
    fi
    echo "waiting $((target - now)) seconds for $label at $target"
    while [ "$now" -lt "$target" ]; do
        delay=$((target - now))
        [ "$delay" -gt 15 ] && delay=15
        sleep "$delay"
        now=$(chain_now)
    done
}

SCHEDULE_NUMBER=$(python3 -c "print(int('$SCHEDULE_ADDRESS', 16))")
SCHEDULE_ID="0.0.$SCHEDULE_NUMBER"
wait_until "$((MATURITY + SCHEDULING_DELAY_SECONDS))" "automatic HSS settlement"

EXECUTED=""
for _ in $(seq 1 60); do
    if mirror_get "/api/v1/schedules/$SCHEDULE_ID" > "$WORK/schedule.tmp"; then
        EXECUTED=$(field "$WORK/schedule.tmp" executed_timestamp 2>/dev/null || true)
        if [ -n "$EXECUTED" ] && [ "$EXECUTED" != "None" ]; then
            mv "$WORK/schedule.tmp" "$WORK/schedule.json"
            break
        fi
    fi
    sleep 3
done
[ -s "$WORK/schedule.json" ] || {
    echo "Mirror Node did not report HSS execution within three minutes" >&2
    exit 1
}

for _ in $(seq 1 40); do
    mirror_get \
        "/api/v1/transactions?account.id=$VAULT_ID&timestamp=gte:$MATURITY&timestamp=lte:$((MATURITY + 15))&order=asc&limit=25" \
        > "$WORK/scheduled-transactions.json"
    if EXECUTED="$EXECUTED" python3 - "$WORK/scheduled-transactions.json" \
        "$WORK/scheduled-transaction.json" <<'PY'
import json, os, pathlib, sys
rows = json.load(open(sys.argv[1])).get("transactions", [])
row = next((
    item for item in rows
    if item.get("scheduled") is True
    and item.get("consensus_timestamp") == os.environ["EXECUTED"]
), None)
if row is None:
    raise SystemExit(1)
pathlib.Path(sys.argv[2]).write_text(json.dumps(row, indent=2) + "\n")
PY
    then
        break
    fi
    sleep 3
done
[ -s "$WORK/scheduled-transaction.json" ] || {
    echo "Mirror Node did not index the scheduled native transaction" >&2
    exit 1
}

EXPECTED_CALLDATA="$(cast sig 'settle(bytes32)')${FAIL_OBLIGATION#0x}"
NATIVE_TRANSACTION_ID=$(field "$WORK/scheduled-transaction.json" transaction_id)
NATIVE_NONCE=$(field "$WORK/scheduled-transaction.json" nonce)
for _ in $(seq 1 40); do
    if mirror_get \
        "/api/v1/contracts/results/$NATIVE_TRANSACTION_ID?nonce=$NATIVE_NONCE" \
        > "$WORK/scheduled-result.tmp" &&
        EXPECTED_CALLDATA="$EXPECTED_CALLDATA" python3 - "$WORK/scheduled-result.tmp" \
            "$WORK/scheduled-result.json" <<'PY'
import json, os, pathlib, sys
row = json.load(open(sys.argv[1]))
if row.get("function_parameters", "").lower() != os.environ["EXPECTED_CALLDATA"].lower():
    raise SystemExit(1)
pathlib.Path(sys.argv[2]).write_text(json.dumps(row, indent=2) + "\n")
PY
    then
        rm -f "$WORK/scheduled-result.tmp"
        break
    fi
    sleep 3
done
[ -s "$WORK/scheduled-result.json" ] || {
    echo "Mirror Node did not index the automatic contract result" >&2
    exit 1
}

SCHEDULE_EXPIRY=$(field "$WORK/schedule.json" expiration_time)
SCHEDULE_RESULT=$(field "$WORK/scheduled-transaction.json" result)
SCHEDULED_BLOCK=$(field "$WORK/scheduled-result.json" block_number)
cast block "$SCHEDULED_BLOCK" --rpc-url "$RPC" --json > "$WORK/scheduled-block.json"
EVM_BLOCK_TIMESTAMP=$(python3 - "$WORK/scheduled-block.json" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))["timestamp"]
print(int(value, 16) if isinstance(value, str) and value.startswith("0x") else int(value))
PY
)

python3 - "$SCHEDULE_EXPIRY" "$MATURITY" "$SCHEDULING_DELAY_SECONDS" \
    "$SCHEDULE_RESULT" "$EVM_BLOCK_TIMESTAMP" <<'PY'
import sys
expiry, due, delay = int(float(sys.argv[1])), int(sys.argv[2]), int(sys.argv[3])
assert expiry == due + delay, (expiry, due, delay)
assert sys.argv[4] == "SUCCESS", sys.argv[4]
assert int(sys.argv[5]) >= due, (sys.argv[5], due)
PY

OBLIGATION_FINAL=$(call "$VAULT" \
    "obligation(bytes32)(address,bytes32,uint64,uint256,uint8,uint8)" \
    "$FAIL_OBLIGATION")
OBLIGATION_STATUS=$(printf '%s\n' "$OBLIGATION_FINAL" | awk 'NR == 6 {print $1}')
RESERVED_FINAL=$(call "$VAULT" "reservedFunding()(uint256)" | n)
CASH_FINAL=$(call "$VAULT" "cashReserved()(uint256)" | n)
FUNDED_FINAL=$(call "$VAULT" "fundedFor()(uint256)" | n)
VAULT_FINAL=$(cast balance "$VAULT" --rpc-url "$RPC" | n)
FREE_FINAL=$(call "$TOKEN" \
    "balanceOfByPartition(bytes32,address)(uint256)" "$PARTITION" "$BORROWER" | n)
HELD_FINAL=$(call "$TOKEN" \
    "getHeldAmountForByPartition(bytes32,address)(uint256)" "$PARTITION" "$BORROWER" | n)

[ "$OBLIGATION_STATUS" = "3" ] || {
    echo "automatic HSS obligation status is $OBLIGATION_STATUS, want SETTLED" >&2
    exit 1
}
[ "$RESERVED_FINAL" = "0" ] || { echo "HSS reservation remains" >&2; exit 1; }
[ "$CASH_FINAL" = "0" ] || { echo "repo cash liability remains" >&2; exit 1; }
[ "$FREE_FINAL" = "$FREE_START" ] || { echo "free collateral did not return" >&2; exit 1; }
[ "$HELD_FINAL" = "$HELD_START" ] || { echo "held collateral did not return" >&2; exit 1; }

for tag in fundOffer accept withdrawBorrower close withdrawLender; do
    BLOCK=$(field "$WORK/$tag.json" blockNumber)
    cast block "$BLOCK" --rpc-url "$RPC" --json > "$WORK/$tag-block.json"
done

VAULT="$VAULT" VAULT_ID="$VAULT_ID" WATCH="$WATCH" TOKEN="$TOKEN" \
    ORACLE="$ORACLE" SCHEDULE="$SCHEDULE" ID="$ID" BORROWER="$BORROWER" \
    LENDER="$LENDER" PARTITION="$PARTITION" LOT="$LOT" HAIRCUT="$HAIRCUT" \
    MAINT="$MAINT" RATE="$RATE" TERM_SECONDS="$TERM_SECONDS" \
    PRINCIPAL="$PRINCIPAL" REPAY="$REPAY" PENALTY="$PENALTY" DUE="$DUE" \
    HOLD_ID="$HOLD_ID" OPENED_AT="$OPENED_AT" MATURITY="$MATURITY" \
    FAIL_OBLIGATION="$FAIL_OBLIGATION" SCHEDULE_ADDRESS="$SCHEDULE_ADDRESS" \
    SCHEDULE_ID="$SCHEDULE_ID" SCHEDULING_DELAY_SECONDS="$SCHEDULING_DELAY_SECONDS" \
    EVM_BLOCK_TIMESTAMP="$EVM_BLOCK_TIMESTAMP" RESERVED_BEFORE="$RESERVED_BEFORE" \
    RESERVED_FINAL="$RESERVED_FINAL" CASH_FINAL="$CASH_FINAL" \
    FUNDED_FINAL="$FUNDED_FINAL" VAULT_START_BALANCE="$VAULT_START_BALANCE" \
    VAULT_FINAL="$VAULT_FINAL" FREE_START="$FREE_START" FREE_FINAL="$FREE_FINAL" \
    HELD_START="$HELD_START" HELD_FINAL="$HELD_FINAL" \
    RUNTIME_HASH="$RUNTIME_HASH" python3 - "$OUT" "$WORK" "$DEPLOYMENT" <<'PY'
import base64
import datetime as dt
import json
import os
import pathlib
import sys

out, work, deployment = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]

def env(name):
    return os.environ[name]

def integer(value):
    return int(value, 16) if isinstance(value, str) and value.startswith("0x") else int(value)

def receipt(tag):
    row = json.loads((work / f"{tag}.json").read_text())
    block = json.loads((work / f"{tag}-block.json").read_text())
    timestamp = integer(block["timestamp"])
    tx = row["transactionHash"]
    return {
        "tx": tx,
        "status": integer(row["status"]),
        "gasUsed": str(integer(row["gasUsed"])),
        "block": integer(row["blockNumber"]),
        "blockTimestamp": timestamp,
        "blockTime": dt.datetime.fromtimestamp(timestamp, dt.timezone.utc).isoformat(),
        "hashscan": f"https://hashscan.io/testnet/transaction/{tx}",
    }

schedule = json.loads((work / "schedule.json").read_text())
native = json.loads((work / "scheduled-transaction.json").read_text())
result = json.loads((work / "scheduled-result.json").read_text())
parts = native["transaction_id"].split("-")
hashscan_id = f"{parts[0]}@{parts[1]}.{parts[2]}"

record = {
    "schema": "lattice.financing.hss-canary.v1",
    "status": "verified",
    "checkedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
    "network": "hedera-testnet",
    "chainId": 296,
    "runKind": "compressed automatic-settlement canary",
    "deploymentRecord": deployment,
    "vault": {
        "address": env("VAULT"),
        "contractId": env("VAULT_ID"),
        "financingVersion": 5,
        "runtimeBytecodeHash": env("RUNTIME_HASH"),
    },
    "marginWatch": env("WATCH"),
    "token": env("TOKEN"),
    "oracle": env("ORACLE"),
    "couponSchedule": env("SCHEDULE"),
    "id": env("ID"),
    "borrower": env("BORROWER"),
    "lender": env("LENDER"),
    "terms": {
        "partition": env("PARTITION"),
        "collateralAmount": env("LOT"),
        "haircutBps": env("HAIRCUT"),
        "maintenanceBps": env("MAINT"),
        "repoRateBps": env("RATE"),
        "termSeconds": env("TERM_SECONDS"),
        "openedAt": int(env("OPENED_AT")),
        "maturity": int(env("MATURITY")),
    },
    "cash": {
        "principalTinybar": env("PRINCIPAL"),
        "repurchaseTinybar": env("REPAY"),
        "penaltyTinybar": env("PENALTY"),
        "closePaidTinybar": env("DUE"),
    },
    "collateral": {
        "holdId": env("HOLD_ID"),
        "amount": env("LOT"),
        "freeBefore": env("FREE_START"),
        "heldBefore": env("HELD_START"),
        "freeFinal": env("FREE_FINAL"),
        "heldFinal": env("HELD_FINAL"),
    },
    "receipts": {
        tag: receipt(tag)
        for tag in ("fundOffer", "accept", "withdrawBorrower", "close", "withdrawLender")
    },
    "automaticSettlement": {
        "failObligation": env("FAIL_OBLIGATION"),
        "economicDueAt": int(env("MATURITY")),
        "executionDelaySeconds": int(env("SCHEDULING_DELAY_SECONDS")),
        "scheduleAddress": env("SCHEDULE_ADDRESS"),
        "scheduleId": env("SCHEDULE_ID"),
        "expirationTime": schedule["expiration_time"],
        "executedTimestamp": schedule["executed_timestamp"],
        "transactionId": native["transaction_id"],
        "transactionHashSha384": "0x" + base64.b64decode(
            native["transaction_hash"]
        ).hex(),
        "result": native["result"],
        "chargedFeeTinybar": str(native["charged_tx_fee"]),
        "evmTransactionHash": result["hash"],
        "evmBlock": result["block_number"],
        "evmBlockTimestamp": int(env("EVM_BLOCK_TIMESTAMP")),
        "gasUsed": str(result["gas_used"]),
        "callResult": result["call_result"],
        "hashscan": f"https://hashscan.io/testnet/transaction/{hashscan_id}",
        "manualFallbackSent": False,
    },
    "snapshots": {
        "initialVaultBalanceWeibar": env("VAULT_START_BALANCE"),
        "reservedBeforeExecutionTinybar": env("RESERVED_BEFORE"),
        "finalVaultBalanceWeibar": env("VAULT_FINAL"),
        "reservedFundingTinybar": env("RESERVED_FINAL"),
        "cashReservedTinybar": env("CASH_FINAL"),
        "additionalCallsFunded": env("FUNDED_FINAL"),
        "repoState": "CLOSED",
        "obligationStatus": "SETTLED",
    },
    "assertions": {
        "fundedOfferAccepted": True,
        "atsHoldCreatedAndReleased": True,
        "cashRoundTrip": True,
        "strictEconomicDuePreserved": True,
        "hssExpiredTwoSecondsAfterDue": True,
        "scheduledTransactionSucceeded": True,
        "manualFallbackNotSent": True,
        "obligationSettledAutomatically": True,
        "scheduleReservationReleased": True,
        "finalLiabilitiesZero": True,
    },
}
out.write_text(json.dumps(record, indent=2) + "\n")
print(f"wrote {out}")
PY

echo "automatic HSS settlement verified"
echo "schedule  https://hashscan.io/testnet/transaction/$(python3 - "$WORK/scheduled-transaction.json" <<'PY'
import json, sys
parts = json.load(open(sys.argv[1]))["transaction_id"].split("-")
print(f"{parts[0]}@{parts[1]}.{parts[2]}")
PY
)"
echo "evidence  $OUT"
