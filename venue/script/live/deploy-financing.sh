#!/usr/bin/env bash
# Guarded deployment wrapper for production RepoVault v5 and the separate
# compressed-clock testnet demonstration vault.
#
# Usage:
#   script/live/deploy-financing.sh plan
#   script/live/deploy-financing.sh oracle
#   script/live/deploy-financing.sh production
#   CANDIDATE_DEPLOY_ACK=1 script/live/deploy-financing.sh candidate
#   script/live/deploy-financing.sh demo
#
# plan is read-only. production and demo broadcast only after the same live
# checks pass. Raw broadcast output stays under Foundry's ignored directory.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(cd .. && pwd)"
MODE="${1:-plan}"

case "$MODE" in
    plan|oracle|production|candidate|demo) ;;
    *)
        echo "usage: $0 [plan|oracle|production|candidate|demo]" >&2
        exit 2
        ;;
esac

set -a
. "$ROOT/.env"
. "$ROOT/.env.venue-actors"
set +a

: "${HEDERA_TESTNET_RPC:?set HEDERA_TESTNET_RPC}"
: "${HEDERA_PRIVATE_KEY:?set HEDERA_PRIVATE_KEY}"
: "${SELLER_ADDRESS:?set SELLER_ADDRESS}"
: "${BUYER_ADDRESS:?set BUYER_ADDRESS}"
if [ "$MODE" = "oracle" ]; then
    : "${SELLER_PRIVATE_KEY:?set SELLER_PRIVATE_KEY}"
    : "${BUYER_PRIVATE_KEY:?set BUYER_PRIVATE_KEY}"
fi
if [ "$MODE" = "candidate" ]; then
    : "${SELLER_PRIVATE_KEY:?set SELLER_PRIVATE_KEY}"
    [ "${CANDIDATE_DEPLOY_ACK:-0}" = "1" ] || {
        echo "candidate deployment requires CANDIDATE_DEPLOY_ACK=1" >&2
        exit 1
    }
fi

RPC="$HEDERA_TESTNET_RPC"
MIRROR="${HEDERA_MIRROR_URL:-https://testnet.mirrornode.hedera.com}"
CLIENT="deployments/client.json"
RECORD="deployments/296-venue.json"
CHAIN_ID_EXPECTED=296
PRODUCTION_LOT="${PRODUCTION_LOT:-1}"
PRODUCTION_HAIRCUT_BPS="${PRODUCTION_HAIRCUT_BPS:-200}"
DEMO_COUPON_LOT="${DEMO_COUPON_LOT:-128}"
GAS_HEADROOM_HBAR="${GAS_HEADROOM_HBAR:-25}"
OPERATING_RESERVE_HBAR="${OPERATING_RESERVE_HBAR:-20}"
CANARY_TERM_SECONDS="${CANARY_TERM_SECONDS:-300}"
CANARY_SCHEDULING_DELAY_SECONDS=2
CANARY_MIN_KYC_REMAINING_SECONDS="${CANARY_MIN_KYC_REMAINING_SECONDS:-1200}"
WORK="deployments/.financing-deploy"

n() { awk '{print $1}'; }
call() { cast call "$1" "$2" "${@:3}" --rpc-url "$RPC"; }
field() {
    python3 - "$1" "$2" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))
for part in sys.argv[2].split("."):
    value = value[part]
print(value)
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
assert_code() {
    local label="$1" address="$2" code
    code=$(cast code "$address" --rpc-url "$RPC")
    if [ "$code" = "0x" ]; then
        echo "$label has no EVM code at $address" >&2
        exit 1
    fi
}
mirror_get() {
    curl --fail --silent --show-error --retry 5 --retry-all-errors \
        --connect-timeout 15 "$MIRROR$1"
}
contract_id() {
    local address="$1" body id
    for _ in $(seq 1 20); do
        body=$(curl --silent --show-error --connect-timeout 15 \
            "$MIRROR/api/v1/contracts/$address" || true)
        id=$(printf '%s' "$body" | python3 -c \
            'import json,sys
try: print(json.load(sys.stdin).get("contract_id", ""))
except Exception: print("")')
        if [ -n "$id" ]; then
            printf '%s\n' "$id"
            return 0
        fi
        sleep 3
    done
    echo "mirror node did not index contract $address" >&2
    return 1
}
log_count() {
    local address="$1"
    mirror_get "/api/v1/contracts/$address/results/logs?limit=1&order=desc" |
        python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("logs", [])))'
}
version_of() {
    call "$1" "FINANCING_VERSION()(uint8)" 2>/dev/null | n || echo 0
}
bool_call() {
    call "$1" "$2" "${@:3}" | n
}
less_than() {
    python3 - "$1" "$2" <<'PY'
import sys
raise SystemExit(0 if int(sys.argv[1]) < int(sys.argv[2]) else 1)
PY
}

for command in cast forge curl python3 node; do
    command -v "$command" >/dev/null || {
        echo "missing command: $command" >&2
        exit 1
    }
done

CHAIN_ID=$(cast chain-id --rpc-url "$RPC" | n)
if [ "$CHAIN_ID" != "$CHAIN_ID_EXPECTED" ]; then
    echo "wrong chain: got $CHAIN_ID, want Hedera testnet $CHAIN_ID_EXPECTED" >&2
    exit 1
fi

DEPLOYER=$(cast wallet address --private-key "$HEDERA_PRIVATE_KEY")
TOKEN=$(field "$CLIENT" addresses.token)
POLICY=$(field "$CLIENT" addresses.ParameterRoot)
BOUND_ORACLE=$(field "$CLIENT" addresses.PrimeOracle)
ORACLE="$BOUND_ORACLE"
if [ "$MODE" != "oracle" ] && [ -f "$WORK/oracle.json" ]; then
    ORACLE=$(field "$WORK/oracle.json" contracts.PrimeOracle.address)
fi
SCHEDULE=$(field "$CLIENT" addresses.CouponSchedule)
REGISTRY=$(field "$CLIENT" addresses.ZkKycRegistry)
CURRENT_VAULT=$(field "$CLIENT" addresses.RepoVault)
PARTITION=$(field "$CLIENT" immutables.partition)
CASH_FEED=$(field "$CLIENT" feed.cashFeed.address)
MARGIN_ENGINE="${MARGIN_ENGINE:-$DEPLOYER}"

export ATS_TOKEN="$TOKEN"
export VENUE_PARAMS="$POLICY"
export PRIME_ORACLE="$ORACLE"
export COUPON_SCHEDULE="$SCHEDULE"
export ZK_KYC_REGISTRY="$REGISTRY"
export MARGIN_ENGINE
export CASH_FEED
export ORACLE_PUBLISHERS="$DEPLOYER,$SELLER_ADDRESS,$BUYER_ADDRESS"

echo "network              Hedera testnet ($CHAIN_ID)"
echo "deployer             $DEPLOYER"
echo "token                $TOKEN"
echo "policy               $POLICY"
echo "bound oracle         $BOUND_ORACLE"
echo "selected oracle      $ORACLE"
echo "cash feed            $CASH_FEED"
echo "production schedule  $SCHEDULE"
echo "current vault        $CURRENT_VAULT"
echo "borrower             $SELLER_ADDRESS"
echo "lender               $BUYER_ADDRESS"

for pair in \
    "token:$TOKEN" \
    "policy:$POLICY" \
    "oracle:$ORACLE" \
    "cashFeed:$CASH_FEED" \
    "schedule:$SCHEDULE" \
    "registry:$REGISTRY"; do
    assert_code "${pair%%:*}" "${pair#*:}"
done

STALE=$(bool_call "$ORACLE" "stale()(bool)")
if [ "$STALE" != "false" ]; then
    echo "oracle is stale. publish and finalize a real round before deployment." >&2
    exit 1
fi
LATEST=$(call "$ORACLE" "latest()(uint128,uint64,uint64,uint64)")
SOURCE_PRICE=$(printf '%s\n' "$LATEST" | awk 'NR == 1 {print $1}')
SOURCE_RATE=$(printf '%s\n' "$LATEST" | awk 'NR == 2 {print $1}')
PUBLISHED_AT=$(printf '%s\n' "$LATEST" | awk 'NR == 3 {print $1}')
HISTORICAL_OK=true
if ! call "$ORACLE" "referenceRateBefore(uint64)(uint64,uint64,uint64)" \
    "$((PUBLISHED_AT + 1))" >/dev/null 2>&1; then
    HISTORICAL_OK=false
fi
if [ "$HISTORICAL_OK" != "true" ] &&
    [ "$MODE" != "oracle" ] && [ "$MODE" != "plan" ]; then
    echo "selected oracle lacks a working historical fixing path" >&2
    echo "run $0 oracle first" >&2
    exit 1
fi
if [ "$HISTORICAL_OK" = "true" ]; then
    export FINANCING_PREFLIGHT_ACK=true
fi

SCHEDULE_COUNT=$(call "$SCHEDULE" "count()(uint256)" | n)
SCHEDULE_SPREAD=$(call "$SCHEDULE" "spreadBps()(uint16)" | n)
SCHEDULE_FACE=$(call "$SCHEDULE" "faceValue()(uint128)" | n)
if [ "$SCHEDULE_COUNT" -lt 1 ] ||
    [ "$SCHEDULE_SPREAD" != "75" ] ||
    [ "$SCHEDULE_FACE" != "10000" ]; then
    echo "production schedule terms do not match the live bond" >&2
    exit 1
fi

KYC_BORROWER=$(call "$REGISTRY" "getKycStatus(address)(uint8)" "$SELLER_ADDRESS" | n)
KYC_LENDER=$(call "$REGISTRY" "getKycStatus(address)(uint8)" "$BUYER_ADDRESS" | n)
if [ "$KYC_BORROWER" != "1" ] || [ "$KYC_LENDER" != "1" ]; then
    echo "both counterparties need current on-chain KYC grants" >&2
    exit 1
fi

NOW=$(date -u +%s)
KYC_END=$(field "$CLIENT" clocks.kyc.currentEpochEndsAt)
KYC_REMAINING=$((KYC_END - NOW))
HSS=0x000000000000000000000000000000000000016b
HSS_CANARY_AT=$((NOW + CANARY_TERM_SECONDS + CANARY_SCHEDULING_DELAY_SECONDS))
HSS_CAPACITY=$(
    call "$HSS" "hasScheduleCapacity(uint256,uint256)(bool)" \
        "$HSS_CANARY_AT" 750000 2>/dev/null | n || echo unavailable
)
if [ "$MODE" = "candidate" ]; then
    if [ "$KYC_REMAINING" -lt "$CANARY_MIN_KYC_REMAINING_SECONDS" ]; then
        echo "KYC epoch has only $KYC_REMAINING seconds left; renew before the canary" >&2
        exit 1
    fi
    if [ "$HSS_CAPACITY" != "true" ]; then
        echo "HSS has no capacity near the candidate canary maturity" >&2
        exit 1
    fi
fi

FREE_COLLATERAL=$(
    call "$TOKEN" "balanceOfByPartition(bytes32,address)(uint256)" \
        "$PARTITION" "$SELLER_ADDRESS" | n
)
REQUIRED_COLLATERAL="$PRODUCTION_LOT"
if [ "$DEMO_COUPON_LOT" -gt "$REQUIRED_COLLATERAL" ]; then
    REQUIRED_COLLATERAL="$DEMO_COUPON_LOT"
fi
if less_than "$FREE_COLLATERAL" "$REQUIRED_COLLATERAL"; then
    echo "borrower has $FREE_COLLATERAL free LPRC, needs $REQUIRED_COLLATERAL" >&2
    exit 1
fi

MARK=$(call "$ORACLE" "markPerUnitTinybar()(uint256)" | n)
PRODUCTION_PRINCIPAL=$(python3 - "$MARK" "$PRODUCTION_LOT" \
    "$PRODUCTION_HAIRCUT_BPS" <<'PY'
import sys
mark, lot, haircut = map(int, sys.argv[1:])
print(mark * lot * (10_000 - haircut) // 10_000)
PY
)
PRODUCTION_VALUE_WEIBAR=$(python3 - "$PRODUCTION_PRINCIPAL" <<'PY'
import sys
print(int(sys.argv[1]) * 10_000_000_000)
PY
)
LENDER_BALANCE_WEIBAR=$(cast balance "$BUYER_ADDRESS" --rpc-url "$RPC" | n)
LENDER_REQUIRED_WEIBAR=$(python3 - "$PRODUCTION_VALUE_WEIBAR" \
    "$GAS_HEADROOM_HBAR" <<'PY'
import sys
print(int(sys.argv[1]) + int(sys.argv[2]) * 10**18)
PY
)
DEPLOYER_BALANCE_WEIBAR=$(cast balance "$DEPLOYER" --rpc-url "$RPC" | n)
OUTGOING_VERSION=$(version_of "$CURRENT_VAULT")
OUTGOING_LOGS=$(log_count "$CURRENT_VAULT")

echo "oracle stale          $STALE"
echo "historical fixing     $HISTORICAL_OK"
echo "oracle mark           $MARK tinybar per LPRC"
echo "schedule              $SCHEDULE_COUNT coupons, $SCHEDULE_SPREAD bps spread"
echo "KYC                   borrower=$KYC_BORROWER lender=$KYC_LENDER"
echo "KYC seconds remaining $KYC_REMAINING"
echo "HSS canary capacity   $HSS_CAPACITY at $HSS_CANARY_AT"
echo "free collateral       $FREE_COLLATERAL LPRC"
echo "production principal  $PRODUCTION_PRINCIPAL tinybar"
echo "lender balance        $LENDER_BALANCE_WEIBAR weibar"
echo "lender required       $LENDER_REQUIRED_WEIBAR weibar"
echo "deployer balance      $DEPLOYER_BALANCE_WEIBAR weibar"
echo "outgoing version      $OUTGOING_VERSION"
echo "outgoing log rows     $OUTGOING_LOGS"

if less_than "$LENDER_BALANCE_WEIBAR" "$LENDER_REQUIRED_WEIBAR"; then
    echo "lender needs a testnet faucet top-up before a production run" >&2
    [ "$MODE" = "demo" ] || [ "$MODE" = "oracle" ] || exit 1
fi

if [ "$MODE" = "plan" ]; then
    if [ "$HISTORICAL_OK" != "true" ]; then
        echo "bound oracle is not compatible with RepoVault v5 noteCoupon"
        echo "next guarded step: $0 oracle"
    fi
    if [ "$OUTGOING_LOGS" != "0" ]; then
        echo "warning: the outgoing vault has logs and cannot be replaced blindly"
    fi
    echo "preflight passed without sending transactions"
    exit 0
fi

mkdir -p "$WORK"

parse_broadcast() {
    local source="$1" kind="$2" output="$3"
    python3 - "$source" "$kind" "$output" <<'PY'
import datetime as dt
import json
import pathlib
import sys

source, kind, output = sys.argv[1:]
run = json.load(open(source))
receipt_by_hash = {
    r["transactionHash"].lower(): r
    for r in run.get("receipts", [])
}
contracts = {}
for tx in run.get("transactions", []):
    if tx.get("transactionType") != "CREATE":
        continue
    h = tx["hash"]
    receipt = receipt_by_hash.get(h.lower(), {})
    contracts[tx["contractName"]] = {
        "address": tx["contractAddress"],
        "tx": h,
        "gasUsed": str(int(receipt.get("gasUsed", "0x0"), 16)),
    }
record = {
    "schema": "lattice.financing.deployment.v1",
    "kind": kind,
    "checkedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
    "contracts": contracts,
}
pathlib.Path(output).write_text(json.dumps(record, indent=2) + "\n")
PY
}

add_entity_ids() {
    local output="$1"
    local updates=""
    while IFS=' ' read -r name address; do
        id=$(contract_id "$address")
        updates+="$name=$id"$'\n'
    done < <(python3 - "$output" <<'PY'
import json, sys
record = json.load(open(sys.argv[1]))
for name, value in record["contracts"].items():
    print(name, value["address"])
PY
)
    UPDATES="$updates" python3 - "$output" <<'PY'
import json, os, pathlib, sys
path = pathlib.Path(sys.argv[1])
record = json.loads(path.read_text())
for line in os.environ["UPDATES"].splitlines():
    name, entity = line.split("=", 1)
    record["contracts"][name]["contractId"] = entity
path.write_text(json.dumps(record, indent=2) + "\n")
PY
}

verify_vault() {
    local vault="$1" watch="$2" schedule="$3"
    [ "$(version_of "$vault")" = "5" ] || {
        echo "deployed vault does not answer FINANCING_VERSION 5" >&2
        exit 1
    }
    assert_address "vault.security" \
        "$(call "$vault" "security()(address)" | n)" "$TOKEN"
    assert_address "vault.oracle" \
        "$(call "$vault" "oracle()(address)" | n)" "$ORACLE"
    assert_address "vault.schedule" \
        "$(call "$vault" "schedule()(address)" | n)" "$schedule"
    assert_address "vault.registry" \
        "$(call "$vault" "registry()(address)" | n)" "$REGISTRY"
    assert_address "vault.policy" \
        "$(call "$vault" "policy()(address)" | n)" "$POLICY"
    assert_address "watch.vault" \
        "$(call "$watch" "vault()(address)" | n)" "$vault"
}

if [ "$MODE" = "oracle" ]; then
    forge script script/DeployPrimeOracle.s.sol:DeployPrimeOracle \
        --rpc-url "$RPC" --broadcast --slow --legacy
    SOURCE="broadcast/DeployPrimeOracle.s.sol/$CHAIN_ID/run-latest.json"
    OUTPUT="$WORK/oracle.json"
    parse_broadcast "$SOURCE" compatible-oracle "$OUTPUT"

    NEW_ORACLE=$(field "$OUTPUT" contracts.PrimeOracle.address)
    assert_address "oracle.policy" \
        "$(call "$NEW_ORACLE" "policy()(address)" | n)" "$POLICY"
    assert_address "oracle.cashFeed" \
        "$(call "$NEW_ORACLE" "cashFeed()(address)" | n)" "$CASH_FEED"
    [ "$(call "$NEW_ORACLE" "publisherCount()(uint256)" | n)" = "3" ] || {
        echo "new oracle does not have three publishers" >&2
        exit 1
    }
    [ "$(call "$NEW_ORACLE" "quorum()(uint8)" | n)" = "2" ] || {
        echo "new oracle quorum is not a strict majority" >&2
        exit 1
    }

    ROUND=$(call "$NEW_ORACLE" "openRound()(uint64)" | n)
    send_oracle() {
        local tag="$1" key="$2"
        cast send "$NEW_ORACLE" \
            "submit(uint64,uint128,uint64)" "$ROUND" "$SOURCE_PRICE" "$SOURCE_RATE" \
            --private-key "$key" --rpc-url "$RPC" --legacy \
            --json --timeout 300 > "$WORK/$tag.json"
    }
    send_oracle oracle-submit-deployer "$HEDERA_PRIVATE_KEY"
    send_oracle oracle-submit-seller "$SELLER_PRIVATE_KEY"
    send_oracle oracle-submit-buyer "$BUYER_PRIVATE_KEY"
    cast send "$NEW_ORACLE" "finalize(uint64)" "$ROUND" \
        --private-key "$HEDERA_PRIVATE_KEY" --rpc-url "$RPC" --legacy \
        --json --timeout 300 > "$WORK/oracle-finalize.json"

    NEW_LATEST=$(call "$NEW_ORACLE" "latest()(uint128,uint64,uint64,uint64)")
    NEW_PRICE=$(printf '%s\n' "$NEW_LATEST" | awk 'NR == 1 {print $1}')
    NEW_RATE=$(printf '%s\n' "$NEW_LATEST" | awk 'NR == 2 {print $1}')
    NEW_PUBLISHED_AT=$(printf '%s\n' "$NEW_LATEST" | awk 'NR == 3 {print $1}')
    [ "$NEW_PRICE" = "$SOURCE_PRICE" ] || {
        echo "new oracle did not finalize the sourced clean price" >&2
        exit 1
    }
    [ "$NEW_RATE" = "$SOURCE_RATE" ] || {
        echo "new oracle did not finalize the sourced reference rate" >&2
        exit 1
    }
    call "$NEW_ORACLE" "referenceRateBefore(uint64)(uint64,uint64,uint64)" \
        "$((NEW_PUBLISHED_AT + 1))" >/dev/null

    SUBMIT_DEPLOYER=$(field "$WORK/oracle-submit-deployer.json" transactionHash)
    SUBMIT_SELLER=$(field "$WORK/oracle-submit-seller.json" transactionHash)
    SUBMIT_BUYER=$(field "$WORK/oracle-submit-buyer.json" transactionHash)
    FINALIZE=$(field "$WORK/oracle-finalize.json" transactionHash)
    SOURCE_ORACLE="$ORACLE" SOURCE_PRICE="$SOURCE_PRICE" SOURCE_RATE="$SOURCE_RATE" \
        SUBMIT_DEPLOYER="$SUBMIT_DEPLOYER" SUBMIT_SELLER="$SUBMIT_SELLER" \
        SUBMIT_BUYER="$SUBMIT_BUYER" FINALIZE="$FINALIZE" \
        python3 - "$OUTPUT" <<'PY'
import json, os, pathlib, sys
path = pathlib.Path(sys.argv[1])
record = json.loads(path.read_text())
record["source"] = {
    "oracle": os.environ["SOURCE_ORACLE"],
    "cleanPrice8": os.environ["SOURCE_PRICE"],
    "refRateBps": os.environ["SOURCE_RATE"],
    "note": "First round copied the previous live finalized mark. No price was invented.",
}
record["round"] = {
    "submitDeployer": os.environ["SUBMIT_DEPLOYER"],
    "submitSeller": os.environ["SUBMIT_SELLER"],
    "submitBuyer": os.environ["SUBMIT_BUYER"],
    "finalize": os.environ["FINALIZE"],
}
path.write_text(json.dumps(record, indent=2) + "\n")
PY
    add_entity_ids "$OUTPUT"
    echo "compatible PrimeOracle $NEW_ORACLE"
    echo "sourced clean price    $SOURCE_PRICE"
    echo "sourced reference rate $SOURCE_RATE bps"
    echo "staged receipt record  $OUTPUT"
elif [ "$MODE" = "production" ] || [ "$MODE" = "candidate" ]; then
    if [ "$MODE" = "production" ] && [ "$OUTGOING_LOGS" != "0" ]; then
        echo "outgoing vault has event history. refusing an unreviewed replacement." >&2
        exit 1
    fi

    OUTPUT="$WORK/$MODE.json"
    if [ "$MODE" = "candidate" ] && [ -s "$OUTPUT" ]; then
        VAULT=$(field "$OUTPUT" contracts.RepoVault.address)
        WATCH=$(field "$OUTPUT" contracts.MarginWatch.address)
        [ "$(cast code "$VAULT" --rpc-url "$RPC")" != "0x" ] &&
            [ "$(cast code "$WATCH" --rpc-url "$RPC")" != "0x" ] || {
            echo "candidate checkpoint exists but its contracts have no runtime code" >&2
            exit 1
        }
        echo "checkpoint candidate contracts"
    else
        FOUNDRY_PROFILE=financing forge script script/DeployFinancing.s.sol:DeployFinancing \
            --rpc-url "$RPC" --broadcast --slow --legacy
        SOURCE="broadcast/DeployFinancing.s.sol/$CHAIN_ID/run-latest.json"
        if [ "$MODE" = "candidate" ]; then
            parse_broadcast "$SOURCE" timestamp-tolerant-candidate "$OUTPUT"
        else
            parse_broadcast "$SOURCE" production "$OUTPUT"
        fi
        VAULT=$(field "$OUTPUT" contracts.RepoVault.address)
        WATCH=$(field "$OUTPUT" contracts.MarginWatch.address)
    fi

    verify_vault "$VAULT" "$WATCH" "$SCHEDULE"

    VAULT_BALANCE=$(cast balance "$VAULT" --rpc-url "$RPC" | n)
    REQUIRED_RESERVE_WEIBAR=$(python3 -c "print(int('$OPERATING_RESERVE_HBAR') * 10**18)")
    if [ "$OPERATING_RESERVE_HBAR" -gt 0 ] && [ "$VAULT_BALANCE" = "0" ]; then
        cast send "$VAULT" \
            --value "${OPERATING_RESERVE_HBAR}ether" \
            --private-key "$HEDERA_PRIVATE_KEY" \
            --rpc-url "$RPC" --json --timeout 300 > "$WORK/$MODE-reserve.json"
        RESERVE_TX=$(field "$WORK/$MODE-reserve.json" transactionHash)
        RESERVE_TX="$RESERVE_TX" python3 - "$OUTPUT" "$OPERATING_RESERVE_HBAR" <<'PY'
import json, os, pathlib, sys
path = pathlib.Path(sys.argv[1])
record = json.loads(path.read_text())
record["operatingReserveHbar"] = int(sys.argv[2])
record["operatingReserveTx"] = os.environ["RESERVE_TX"]
path.write_text(json.dumps(record, indent=2) + "\n")
PY
    elif [ "$OPERATING_RESERVE_HBAR" -gt 0 ] &&
        less_than "$VAULT_BALANCE" "$REQUIRED_RESERVE_WEIBAR"; then
        echo "candidate reserve checkpoint is below $OPERATING_RESERVE_HBAR HBAR" >&2
        exit 1
    fi

    RUNTIME_CODE=$(cast code "$VAULT" --rpc-url "$RPC")
    RUNTIME_HASH=$(cast keccak "$RUNTIME_CODE")
    RUNTIME_BYTES=$(( (${#RUNTIME_CODE} - 2) / 2 ))
    if [ "$RUNTIME_BYTES" -gt 24576 ]; then
        echo "candidate runtime exceeds EIP-170: $RUNTIME_BYTES bytes" >&2
        exit 1
    fi

    if [ "$MODE" = "candidate" ]; then
        export COLLATERAL_OWNER="$SELLER_ADDRESS"
        export COLLATERAL_SPENDER="$VAULT"
        WINDOW_OUTPUT="$WORK/candidate-window.json"
        if [ -s "$WINDOW_OUTPUT" ]; then
            APPROVAL_WINDOW=$(field "$WINDOW_OUTPUT" contracts.ApprovalWindowCompliance.address)
            [ "$(cast code "$APPROVAL_WINDOW" --rpc-url "$RPC")" != "0x" ] || {
                echo "approval-window checkpoint has no runtime code" >&2
                exit 1
            }
            echo "checkpoint candidate approval window"
        else
            FOUNDRY_PROFILE=financing forge script \
                script/DeployApprovalWindow.s.sol:DeployApprovalWindow \
                --rpc-url "$RPC" --broadcast --slow --legacy
            WINDOW_SOURCE="broadcast/DeployApprovalWindow.s.sol/$CHAIN_ID/run-latest.json"
            parse_broadcast "$WINDOW_SOURCE" candidate-approval-window "$WINDOW_OUTPUT"
        fi
        APPROVAL_WINDOW=$(field "$WINDOW_OUTPUT" contracts.ApprovalWindowCompliance.address)

        CURRENT_ALLOWANCE=$(
            call "$TOKEN" "allowance(address,address)(uint256)" "$SELLER_ADDRESS" "$VAULT" | n
        )
        CURRENT_COMPLIANCE=$(call "$TOKEN" "compliance()(address)" | n)
        if [ "$CURRENT_ALLOWANCE" != "1" ] ||
            [ "$(lower "$CURRENT_COMPLIANCE")" != "$(lower "$COMPLIANCE")" ]; then
            ALLOW_APPROVAL_WINDOW=1 \
            VAULT="$VAULT" \
            APPROVAL_WINDOW="$APPROVAL_WINDOW" \
            AMOUNT=1 \
            OUT_DIR="$WORK/candidate-approval" \
                bash script/live/authorize-vault-collateral.sh
        else
            echo "checkpoint candidate ATS allowance"
        fi

        WINDOW_DEPLOY_TX=$(field "$WINDOW_OUTPUT" contracts.ApprovalWindowCompliance.tx)
        APPROVAL_TX=$(field "$WORK/candidate-approval/approveCollateral.json" transactionHash)
        SEAT_TX=$(field "$WORK/candidate-approval/complianceSeat.json" transactionHash)
        RESTORE_TX=$(field "$WORK/candidate-approval/complianceRestore.json" transactionHash)
        WINDOW_ADDRESS="$APPROVAL_WINDOW" WINDOW_DEPLOY_TX="$WINDOW_DEPLOY_TX" \
            APPROVAL_TX="$APPROVAL_TX" SEAT_TX="$SEAT_TX" RESTORE_TX="$RESTORE_TX" \
            python3 - "$OUTPUT" "$WINDOW_OUTPUT" <<'PY'
import json, os, pathlib, sys
path = pathlib.Path(sys.argv[1])
record = json.loads(path.read_text())
window = json.load(open(sys.argv[2]))["contracts"]["ApprovalWindowCompliance"]
record["contracts"]["ApprovalWindowCompliance"] = window
record["approvalWindow"] = {
    "address": os.environ["WINDOW_ADDRESS"],
    "deployTx": os.environ["WINDOW_DEPLOY_TX"],
    "seatTx": os.environ["SEAT_TX"],
    "approveTx": os.environ["APPROVAL_TX"],
    "restoreTx": os.environ["RESTORE_TX"],
    "restored": True,
}
path.write_text(json.dumps(record, indent=2) + "\n")
PY
    fi

    CURRENT_CASH_RESERVED=$(call "$CURRENT_VAULT" "cashReserved()(uint256)" | n)
    CURRENT_SCHEDULE_RESERVED=$(call "$CURRENT_VAULT" "reservedFunding()(uint256)" | n)
    CURRENT_BORROWER_CREDIT=$(
        call "$CURRENT_VAULT" "credit(address)(uint256)" "$SELLER_ADDRESS" | n
    )
    CURRENT_LENDER_CREDIT=$(
        call "$CURRENT_VAULT" "credit(address)(uint256)" "$BUYER_ADDRESS" | n
    )
    CURRENT_BALANCE=$(cast balance "$CURRENT_VAULT" --rpc-url "$RPC" | n)
    RUNTIME_HASH="$RUNTIME_HASH" RUNTIME_BYTES="$RUNTIME_BYTES" \
        CURRENT_VAULT="$CURRENT_VAULT" CURRENT_BALANCE="$CURRENT_BALANCE" \
        CURRENT_CASH_RESERVED="$CURRENT_CASH_RESERVED" \
        CURRENT_SCHEDULE_RESERVED="$CURRENT_SCHEDULE_RESERVED" \
        CURRENT_BORROWER_CREDIT="$CURRENT_BORROWER_CREDIT" \
        CURRENT_LENDER_CREDIT="$CURRENT_LENDER_CREDIT" \
        python3 - "$OUTPUT" "$CANARY_SCHEDULING_DELAY_SECONDS" <<'PY'
import json, os, pathlib, sys
path = pathlib.Path(sys.argv[1])
record = json.loads(path.read_text())
record["runtime"] = {
    "RepoVaultBytes": int(os.environ["RUNTIME_BYTES"]),
    "RepoVaultKeccak256": os.environ["RUNTIME_HASH"],
    "eip170HeadroomBytes": 24_576 - int(os.environ["RUNTIME_BYTES"]),
}
record["scheduling"] = {
    "revision": "hss-execution-delay",
    "executionDelaySeconds": int(sys.argv[2]),
    "economicDueTimeUnchanged": True,
    "manualFallbackUnchanged": True,
}
record["bindingChanged"] = False
record["outgoing"] = {
    "vault": os.environ["CURRENT_VAULT"],
    "balanceWeibar": os.environ["CURRENT_BALANCE"],
    "cashReservedTinybar": os.environ["CURRENT_CASH_RESERVED"],
    "reservedFundingTinybar": os.environ["CURRENT_SCHEDULE_RESERVED"],
    "borrowerCreditTinybar": os.environ["CURRENT_BORROWER_CREDIT"],
    "lenderCreditTinybar": os.environ["CURRENT_LENDER_CREDIT"],
}
path.write_text(json.dumps(record, indent=2) + "\n")
PY

    add_entity_ids "$OUTPUT"
    if [ "$MODE" = "candidate" ]; then
        WINDOW_ID=$(field "$OUTPUT" contracts.ApprovalWindowCompliance.contractId)
        python3 - "$OUTPUT" "$WINDOW_ID" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
record = json.loads(path.read_text())
record["approvalWindow"]["contractId"] = sys.argv[2]
path.write_text(json.dumps(record, indent=2) + "\n")
PY
    fi
    echo "$MODE RepoVault  $VAULT"
    echo "$MODE MarginWatch $WATCH"
    echo "runtime             $RUNTIME_BYTES bytes, $RUNTIME_HASH"
    echo "staged receipt record  $OUTPUT"
else
    FOUNDRY_PROFILE=financing forge script \
        script/DeployFinancingDemo.s.sol:DeployFinancingDemo \
        --rpc-url "$RPC" --broadcast --slow --legacy
    SOURCE="broadcast/DeployFinancingDemo.s.sol/$CHAIN_ID/run-latest.json"
    OUTPUT="$WORK/demo.json"
    parse_broadcast "$SOURCE" compressed-demo "$OUTPUT"

    SCHEDULE_DEMO=$(field "$OUTPUT" contracts.CouponSchedule.address)
    VAULT=$(field "$OUTPUT" contracts.RepoVault.address)
    WATCH=$(field "$OUTPUT" contracts.MarginWatch.address)
    verify_vault "$VAULT" "$WATCH" "$SCHEDULE_DEMO"
    BALANCE=$(cast balance "$VAULT" --rpc-url "$RPC" | n)
    if [ "$BALANCE" != "0" ]; then
        echo "demo vault must stay unfunded for deterministic HSS fallback" >&2
        exit 1
    fi
    add_entity_ids "$OUTPUT"
    echo "demo CouponSchedule $SCHEDULE_DEMO"
    echo "demo RepoVault       $VAULT"
    echo "demo MarginWatch     $WATCH"
    echo "staged receipt record $OUTPUT"
fi

python3 - "$OUTPUT" <<'PY'
import json, sys
record = json.load(open(sys.argv[1]))
for name, value in record["contracts"].items():
    print(f"{name:18} https://hashscan.io/testnet/contract/{value['contractId']}")
    print(f"{name + ' tx':18} https://hashscan.io/testnet/transaction/{value['tx']}")
PY
