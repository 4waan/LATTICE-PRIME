#!/usr/bin/env bash
# Resumable compressed-clock RepoVault v5 lifecycle demonstration.
#
# Usage:
#   script/live/financing-lifecycle.sh plan
#   script/live/financing-lifecycle.sh run
#
# The demo deployment is deliberately separate from deployments/client.json.
# Raw receipts and resumable state stay in an ignored work directory. The
# sanitized evidence bundle is deployments/financing-lifecycle.json.
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
    : "${HEDERA_PRIVATE_KEY:?set HEDERA_PRIVATE_KEY}"
    : "${SELLER_PRIVATE_KEY:?set SELLER_PRIVATE_KEY}"
    : "${BUYER_PRIVATE_KEY:?set BUYER_PRIVATE_KEY}"
fi

RPC="$HEDERA_TESTNET_RPC"
DEPLOYMENT="${DEMO_DEPLOYMENT_RECORD:-deployments/.financing-deploy/demo.json}"
WORK="deployments/.financing-lifecycle"
STATE_FILE="$WORK/state.env"
OUT="deployments/financing-lifecycle.json"
CLIENT="deployments/client.json"

[ -f "$DEPLOYMENT" ] || {
    echo "missing demo deployment record $DEPLOYMENT" >&2
    echo "run script/live/deploy-financing.sh demo first" >&2
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

VAULT=$(field "$DEPLOYMENT" contracts.RepoVault.address)
WATCH=$(field "$DEPLOYMENT" contracts.MarginWatch.address)
SCHEDULE=$(field "$DEPLOYMENT" contracts.CouponSchedule.address)
TOKEN=$(field "$CLIENT" addresses.token)
REGISTRY=$(field "$CLIENT" addresses.ZkKycRegistry)
ORACLE=$(call "$VAULT" "oracle()(address)" | n)
PARTITION=$(field "$CLIENT" immutables.partition)
BORROWER="$SELLER_ADDRESS"
LENDER="$BUYER_ADDRESS"

VERSION=$(call "$VAULT" "FINANCING_VERSION()(uint8)" | n)
FAIL_GRACE=$(call "$VAULT" "failGrace()(uint64)" | n)
CURE_WINDOW=$(call "$VAULT" "cureWindow()(uint64)" | n)
COUPON_DUE=$(call "$SCHEDULE" "dateOf(uint256)(uint64)" 0 | n)
COUPON_COUNT=$(call "$SCHEDULE" "count()(uint256)" | n)
VAULT_START_BALANCE=$(cast balance "$VAULT" --rpc-url "$RPC" | n)
KYC_B=$(call "$REGISTRY" "getKycStatus(address)(uint8)" "$BORROWER" | n)
KYC_L=$(call "$REGISTRY" "getKycStatus(address)(uint8)" "$LENDER" | n)

[ "$VERSION" = "5" ] || { echo "demo vault is not RepoVault v5" >&2; exit 1; }
[ "$FAIL_GRACE" = "120" ] || { echo "demo fail grace is not 120 seconds" >&2; exit 1; }
[ "$CURE_WINDOW" = "300" ] || { echo "demo cure window is not 300 seconds" >&2; exit 1; }
[ "$COUPON_COUNT" = "1" ] || { echo "demo schedule does not have one coupon" >&2; exit 1; }
[ "$KYC_B" = "1" ] && [ "$KYC_L" = "1" ] || {
    echo "both actors need current KYC grants" >&2
    exit 1
}

assert_address() {
    local label="$1" actual="$2" expected="$3"
    if [ "$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')" != \
        "$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')" ]; then
        echo "$label mismatch: got $actual, want $expected" >&2
        exit 1
    fi
}
assert_address "watch.vault" "$(call "$WATCH" "vault()(address)" | n)" "$VAULT"
assert_address "vault.schedule" "$(call "$VAULT" "schedule()(address)" | n)" "$SCHEDULE"
assert_address "vault.security" "$(call "$VAULT" "security()(address)" | n)" "$TOKEN"

if [ -f "$OUT" ] && [ "$(field "$OUT" status 2>/dev/null || true)" = "complete" ]; then
    echo "lifecycle already complete: $OUT"
    exit 0
fi

LOT1="${LOT1:-1}"
EXTRA1="${EXTRA1:-1}"
HAIRCUT1="${HAIRCUT1:-200}"
MAINT1="${MAINT1:-205}"
RATE1="${RATE1:-450}"
TERM1="${TERM1:-600}"
LOT2="${LOT2:-128}"
HAIRCUT2="${HAIRCUT2:-9990}"
MAINT2="${MAINT2:-0}"
RATE2="${RATE2:-450}"
SEND_GAS_LIMIT="${SEND_GAS_LIMIT:-4000000}"

mkdir -p "$WORK"
if [ ! -f "$STATE_FILE" ]; then
    NOW=$(chain_now)
    REMAINING=$((COUPON_DUE - NOW))
    if [ "$REMAINING" -lt 300 ]; then
        echo "less than five minutes remain before the demo coupon" >&2
        echo "deploy a fresh compressed demo vault" >&2
        exit 1
    fi
    TERM2=$((REMAINING + 120))
    ID1=$(cast keccak "lattice-prime demo margin $(date -u +%s) $RANDOM")
    ID2=$(cast keccak "lattice-prime demo default $(date -u +%s) $RANDOM")
    BASE_FREE_START=$(call "$TOKEN" \
        "balanceOfByPartition(bytes32,address)(uint256)" "$PARTITION" "$BORROWER" | n)
    BASE_HELD_START=$(call "$TOKEN" \
        "getHeldAmountForByPartition(bytes32,address)(uint256)" "$PARTITION" "$BORROWER" | n)
    BASE_LENDER_TOKEN_START=$(call "$TOKEN" \
        "balanceOfByPartition(bytes32,address)(uint256)" "$PARTITION" "$LENDER" | n)
    if [ "$VAULT_START_BALANCE" != "0" ]; then
        echo "fresh demo vault must start with zero HBAR" >&2
        exit 1
    fi
    cat > "$STATE_FILE" <<EOF
ID1=$ID1
ID2=$ID2
TERM2=$TERM2
BASELINE_AT=$NOW
BASE_FREE_START=$BASE_FREE_START
BASE_HELD_START=$BASE_HELD_START
BASE_LENDER_TOKEN_START=$BASE_LENDER_TOKEN_START
BASE_VAULT_BALANCE=$VAULT_START_BALANCE
EOF
fi
# shellcheck disable=SC1090
. "$STATE_FILE"

TERMS1="($PARTITION,$LOT1,$HAIRCUT1,$MAINT1,$RATE1,$TERM1)"
TERMS2="($PARTITION,$LOT2,$HAIRCUT2,$MAINT2,$RATE2,$TERM2)"
PRINCIPAL1=$(call "$VAULT" \
    "quotePrincipal((bytes32,uint256,uint16,uint16,uint256,uint64))(uint256)" \
    "$TERMS1" | n)
PRINCIPAL2=$(call "$VAULT" \
    "quotePrincipal((bytes32,uint256,uint16,uint16,uint256,uint64))(uint256)" \
    "$TERMS2" | n)
PRE_FUND_FIXING=$(call "$ORACLE" \
    "referenceRateBefore(uint64)(uint64,uint64,uint64)" "$COUPON_DUE")
PRE_FUND_RATE=$(printf '%s\n' "$PRE_FUND_FIXING" | awk 'NR == 1 {print $1}')
PRE_FUND_COUPON=$(call "$SCHEDULE" \
    "amountFor(uint256,uint64,uint256)(uint256)" 0 "$PRE_FUND_RATE" "$LOT2" | n)
less_than 0 "$PRE_FUND_COUPON" || {
    echo "demo coupon rounds to zero before funding; deploy a larger demo lot" >&2
    exit 1
}
VALUE1=$(to_weibar "$PRINCIPAL1")
VALUE2=$(to_weibar "$PRINCIPAL2")

FREE_START="$BASE_FREE_START"
HELD_START="$BASE_HELD_START"
LENDER_TOKEN_START="$BASE_LENDER_TOKEN_START"
LENDER_HBAR=$(cast balance "$LENDER" --rpc-url "$RPC" | n)

if less_than "$FREE_START" "$LOT2"; then
    echo "borrower has $FREE_START free LPRC, needs at least $LOT2" >&2
    exit 1
fi
echo "demo vault          $VAULT"
echo "demo MarginWatch    $WATCH"
echo "coupon due          $COUPON_DUE"
echo "position 1          $ID1, principal $PRINCIPAL1 tinybar"
echo "position 2          $ID2, principal $PRINCIPAL2 tinybar"
echo "coupon preflight    $PRE_FUND_COUPON units at $PRE_FUND_RATE bps reference"
echo "clocks              cure=$CURE_WINDOW failGrace=$FAIL_GRACE seconds"
echo "starting collateral free=$FREE_START held=$HELD_START"

PREVIEW1=$(call "$VAULT" \
    "previewMark(bytes32)(uint256,bool,bool)" "$ID1" 2>/dev/null || true)
if [ "$MODE" = "plan" ]; then
    echo "plan only. No transactions sent."
    echo "the run will wait through coupon, maturity, and fail-grace clocks"
    exit 0
fi

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

require_lender_capital() {
    local value="$1" balance required
    balance=$(cast balance "$LENDER" --rpc-url "$RPC" | n)
    required=$(python3 -c "print(int('$value') + 25 * 10**18)")
    if less_than "$balance" "$required"; then
        echo "lender lacks principal plus gas headroom" >&2
        echo "has $balance, needs $required weibar" >&2
        exit 1
    fi
}

ensure_allowance() {
    local tag="$1" amount="$2"
    local allowance
    allowance=$(call "$TOKEN" "allowance(address,address)(uint256)" "$BORROWER" "$VAULT" | n)
    if less_than "$allowance" "$amount"; then
        if [ "$(call "$REGISTRY" "getKycStatus(address)(uint8)" "$VAULT" | n)" != "1" ]; then
            echo "demo vault needs its bounded ATS approval window before the lifecycle run" >&2
            echo "use script/live/authorize-vault-collateral.sh, then resume" >&2
            exit 1
        fi
        send_once "$tag" "$SELLER_PRIVATE_KEY" "$TOKEN" \
            "approve(address,uint256)" "$VAULT" "$amount"
    fi
}

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

watch_checkpoint() {
    local tag="$1" id="$2" alert stream feed
    if [ -s "$WORK/watch-$tag.json" ]; then
        echo "checkpoint watch-$tag"
        return 0
    fi
    alert=$(call "$WATCH" \
        "alertOf(bytes32)(uint8,bool,uint64,uint64,bool,bool,bool)" "$id")
    stream=$(call "$WATCH" \
        "stream()(uint64,bool,uint32,uint32,bool,bool,uint256)")
    feed=$(call "$WATCH" \
        "feed()(address,bool,bool,bool,uint128,uint64,uint64,uint64,uint256,uint256,address)")
    ALERT="$alert" STREAM="$stream" FEED="$feed" python3 - "$WORK/watch-$tag.json" \
        "$tag" "$id" "$(chain_now)" <<'PY'
import json, os, pathlib, sys

def values(name):
    return [line.split()[0] for line in os.environ[name].splitlines()]

a = values("ALERT")
s = values("STREAM")
f = values("FEED")
record = {
    "tag": sys.argv[2],
    "repoId": sys.argv[3],
    "chainTimestamp": sys.argv[4],
    "alert": {
        "state": a[0],
        "called": a[1],
        "cureDeadline": a[2],
        "maturity": a[3],
        "cureExpired": a[4],
        "unmarkedFail": a[5],
        "defaultable": a[6],
    },
    "stream": {
        "epoch": s[0],
        "metered": s[1],
        "budgetBits": s[2],
        "spentBits": s[3],
        "permitted": s[4],
        "audible": s[5],
        "breakingSize": s[6],
    },
    "feed": {
        "oracle": f[0],
        "dark": f[1],
        "ourLegDark": f[2],
        "cashLegDark": f[3],
        "cleanPrice8": f[4],
        "refRateBps": f[5],
        "publishedAt": f[6],
        "round": f[7],
        "usdPerHbar8": f[8],
        "markPerUnitTinybar": f[9],
        "cashFeed": f[10],
    },
}
pathlib.Path(sys.argv[1]).write_text(json.dumps(record, indent=2) + "\n")
PY
}

watch_checkpoint position1-before "$ID1"

STATE1=$(state_of "$ID1")
if [ "$STATE1" = "0" ] && [ ! -s "$WORK/position1-fund.json" ]; then
    require_lender_capital "$VALUE1"
    EXPIRES=$(( $(chain_now) + 1800 ))
    send_once position1-fund "$BUYER_PRIVATE_KEY" "$VAULT" \
        "fundOffer(bytes32,address,(bytes32,uint256,uint16,uint16,uint256,uint64),uint64)" \
        "$ID1" "$BORROWER" "$TERMS1" "$EXPIRES" --value "$VALUE1"
fi
STATE1=$(state_of "$ID1")
if [ "$STATE1" = "0" ]; then
    LIVE1=$(call "$VAULT" \
        "quotePrincipal((bytes32,uint256,uint16,uint16,uint256,uint64))(uint256)" \
        "$TERMS1" | n)
    if [ "$LIVE1" != "$PRINCIPAL1" ]; then
        send_once position1-cancel-moved "$BUYER_PRIVATE_KEY" "$VAULT" \
            "cancelOffer(bytes32)" "$ID1"
        send_once position1-withdraw-recovery "$BUYER_PRIVATE_KEY" "$VAULT" "withdraw()"
        echo "position 1 mark moved before acceptance; lender funds recovered" >&2
        exit 1
    fi
    ensure_allowance position1-approve "$LOT1"
    send_once position1-accept "$SELLER_PRIVATE_KEY" "$VAULT" "accept(bytes32)" "$ID1"
fi

if [ "$(credit_of "$BORROWER")" != "0" ]; then
    send_once position1-withdraw-borrower "$SELLER_PRIVATE_KEY" "$VAULT" "withdraw()"
fi

STATE1=$(state_of "$ID1")
if [ "$STATE1" = "2" ] &&
    [ ! -s "$WORK/position1-cure.json" ] &&
    [ ! -s "$WORK/position1-close.json" ]; then
    PREVIEW1=$(call "$VAULT" "previewMark(bytes32)(uint256,bool,bool)" "$ID1")
    PREVIEW_BREACH=$(printf '%s\n' "$PREVIEW1" | awk 'NR == 2 {print $1}')
    PREVIEW_DARK=$(printf '%s\n' "$PREVIEW1" | awk 'NR == 3 {print $1}')
    [ "$PREVIEW_BREACH" = "true" ] && [ "$PREVIEW_DARK" = "false" ] || {
        echo "position 1 maintenance terms did not produce a live-feed breach" >&2
        exit 1
    }
    send_once position1-mark "$HEDERA_PRIVATE_KEY" "$VAULT" \
        "markToMarket(bytes32)" "$ID1"
fi

if [ "$(state_of "$ID1")" = "3" ]; then
    watch_checkpoint position1-called "$ID1"

    if [ "$(call "$VAULT" "extraHoldCount(bytes32)(uint256)" "$ID1" | n)" = "0" ]; then
        ensure_allowance position1-approve-extra "$EXTRA1"
        send_once position1-add-collateral "$SELLER_PRIVATE_KEY" "$VAULT" \
            "addCollateral(bytes32,uint256)" "$ID1" "$EXTRA1"
    fi

    CURED_PREVIEW=$(call "$VAULT" "previewMark(bytes32)(uint256,bool,bool)" "$ID1")
    CURED_BREACH=$(printf '%s\n' "$CURED_PREVIEW" | awk 'NR == 2 {print $1}')
    [ "$CURED_BREACH" = "false" ] || {
        echo "added collateral did not restore coverage" >&2
        exit 1
    }
    send_once position1-cure "$SELLER_PRIVATE_KEY" "$VAULT" "cure(bytes32)" "$ID1"
fi

if [ "$(state_of "$ID1")" = "2" ]; then
    watch_checkpoint position1-cured "$ID1"
    CLOSE1=$(call "$VAULT" "repurchasePriceNow(bytes32)(uint256)" "$ID1" | n)
    PENALTY1=$(call "$VAULT" "settlementPenaltyNow(bytes32)(uint256)" "$ID1" | n)
    DUE1=$((CLOSE1 + PENALTY1))
    send_once position1-close "$SELLER_PRIVATE_KEY" "$VAULT" \
        "close(bytes32)" "$ID1" --value "$(to_weibar "$DUE1")"
fi
if [ "$(credit_of "$LENDER")" != "0" ]; then
    send_once position1-withdraw-lender "$BUYER_PRIVATE_KEY" "$VAULT" "withdraw()"
fi
[ "$(state_of "$ID1")" = "7" ] || { echo "position 1 did not close" >&2; exit 1; }
watch_checkpoint position1-closed "$ID1"

NOW=$(chain_now)
if [ "$(state_of "$ID2")" = "0" ] && [ ! -s "$WORK/position2-fund.json" ]; then
    [ "$NOW" -lt "$COUPON_DUE" ] || {
        echo "position 2 cannot open after its only coupon date" >&2
        exit 1
    }
    require_lender_capital "$VALUE2"
    EXPIRES=$((NOW + 1800))
    send_once position2-fund "$BUYER_PRIVATE_KEY" "$VAULT" \
        "fundOffer(bytes32,address,(bytes32,uint256,uint16,uint16,uint256,uint64),uint64)" \
        "$ID2" "$BORROWER" "$TERMS2" "$EXPIRES" --value "$VALUE2"
fi
if [ "$(state_of "$ID2")" = "0" ]; then
    LIVE2=$(call "$VAULT" \
        "quotePrincipal((bytes32,uint256,uint16,uint16,uint256,uint64))(uint256)" \
        "$TERMS2" | n)
    if [ "$LIVE2" != "$PRINCIPAL2" ]; then
        send_once position2-cancel-moved "$BUYER_PRIVATE_KEY" "$VAULT" \
            "cancelOffer(bytes32)" "$ID2"
        send_once position2-withdraw-recovery "$BUYER_PRIVATE_KEY" "$VAULT" "withdraw()"
        echo "position 2 mark moved before acceptance; lender funds recovered" >&2
        exit 1
    fi
    ensure_allowance position2-approve "$LOT2"
    send_once position2-accept "$SELLER_PRIVATE_KEY" "$VAULT" "accept(bytes32)" "$ID2"
fi
if [ "$(credit_of "$BORROWER")" != "0" ]; then
    send_once position2-withdraw-borrower "$SELLER_PRIVATE_KEY" "$VAULT" "withdraw()"
fi
STATE2_NOW=$(state_of "$ID2")
case "$STATE2_NOW" in
    2)
        watch_checkpoint position2-open "$ID2"
        ;;
    5|6|7)
        [ -s "$WORK/watch-position2-open.json" ] || {
            echo "position 2 advanced without its OPEN checkpoint" >&2
            exit 1
        }
        ;;
    *)
        echo "position 2 did not open" >&2
        exit 1
        ;;
esac

FAIL_OBLIGATION=$(call "$VAULT" "failObligation(bytes32)(bytes32)" "$ID2" | n)
COUPON_OBLIGATION=$(call "$VAULT" \
    "couponObligation(bytes32,uint256)(bytes32)" "$ID2" 0 | n)
FAIL_SCHEDULE=$(call "$VAULT" \
    "obligation(bytes32)(address,bytes32,uint64,uint256,uint8,uint8)" \
    "$FAIL_OBLIGATION" | awk 'NR == 1 {print $1}')
COUPON_SCHEDULE=$(call "$VAULT" \
    "obligation(bytes32)(address,bytes32,uint64,uint256,uint8,uint8)" \
    "$COUPON_OBLIGATION" | awk 'NR == 1 {print $1}')
ZERO_ADDRESS="0x0000000000000000000000000000000000000000"
assert_address "fail obligation fallback" "$FAIL_SCHEDULE" "$ZERO_ADDRESS"
assert_address "coupon obligation fallback" "$COUPON_SCHEDULE" "$ZERO_ADDRESS"
[ "$(call "$VAULT" "fundedFor()(uint256)" | n)" = "0" ] || {
    echo "demo vault unexpectedly has HSS call funding" >&2
    exit 1
}

UNSCHEDULED_TOPIC=$(cast keccak "Unscheduled(bytes32,int64)")
VAULT_EXPECTED="$VAULT" FAIL_EXPECTED="$FAIL_OBLIGATION" \
    COUPON_EXPECTED="$COUPON_OBLIGATION" TOPIC_EXPECTED="$UNSCHEDULED_TOPIC" \
    python3 - "$WORK/position2-accept.json" "$WORK/unscheduled.json" <<'PY'
import json
import os
import pathlib
import sys

receipt = json.load(open(sys.argv[1]))
vault = os.environ["VAULT_EXPECTED"].lower()
topic = os.environ["TOPIC_EXPECTED"].lower()
expected = {
    os.environ["FAIL_EXPECTED"].lower(): "fail",
    os.environ["COUPON_EXPECTED"].lower(): "coupon",
}
decoded = {}
for log in receipt.get("logs", []):
    topics = log.get("topics", [])
    if log.get("address", "").lower() != vault or not topics:
        continue
    if topics[0].lower() != topic:
        continue
    obligation = topics[1].lower()
    word = int(log["data"], 16)
    if word >= 1 << 255:
        word -= 1 << 256
    decoded[obligation] = word

assert set(decoded) == set(expected), (decoded, expected)
assert all(reason in (-2, -3) for reason in decoded.values()), decoded
record = {
    expected[obligation]: {
        "obligation": obligation,
        "reason": reason,
        "meaning": "NO_CAPACITY" if reason == -2 else "UNFUNDED",
    }
    for obligation, reason in decoded.items()
}
pathlib.Path(sys.argv[2]).write_text(json.dumps(record, indent=2) + "\n")
PY

wait_until "$COUPON_DUE" "coupon zero"
COUPON_PREVIEW=$(call "$VAULT" \
    "couponOwed(bytes32,uint256)(uint256,bool,bool)" "$ID2" 0)
COUPON_OWED=$(printf '%s\n' "$COUPON_PREVIEW" | awk 'NR == 1 {print $1}')
COUPON_DARK=$(printf '%s\n' "$COUPON_PREVIEW" | awk 'NR == 2 {print $1}')
less_than 0 "$COUPON_OWED" || {
    echo "coupon observation rounded to zero" >&2
    exit 1
}
[ "$COUPON_DARK" = "false" ] || {
    echo "historical fixing was dark at the coupon date" >&2
    exit 1
}
if [ "$(call "$VAULT" "notedCoupon(bytes32,uint256)(bool)" "$ID2" 0 | n)" = "false" ]; then
    send_once position2-note-coupon "$HEDERA_PRIVATE_KEY" "$VAULT" \
        "noteCoupon(bytes32,uint256)" "$ID2" 0
fi
send_once position2-settle-coupon-fallback "$HEDERA_PRIVATE_KEY" "$VAULT" \
    "settle(bytes32)" "$COUPON_OBLIGATION"
watch_checkpoint position2-coupon "$ID2"

MATURITY=$(call "$WATCH" \
    "alertOf(bytes32)(uint8,bool,uint64,uint64,bool,bool,bool)" "$ID2" |
    awk 'NR == 4 {print $1}')
wait_until "$MATURITY" "position 2 maturity"
watch_checkpoint position2-unmarked-fail "$ID2"
UNMARKED_FAIL=$(field "$WORK/watch-position2-unmarked-fail.json" alert.unmarkedFail)
[ "$UNMARKED_FAIL" = "True" ] || [ "$UNMARKED_FAIL" = "true" ] || {
    echo "MarginWatch did not flag the unmarked fail" >&2
    exit 1
}

if [ "$(state_of "$ID2")" = "2" ]; then
    send_once position2-mark-failing "$HEDERA_PRIVATE_KEY" "$VAULT" \
        "markFailing(bytes32)" "$ID2"
fi
send_once position2-settle-fail-fallback "$HEDERA_PRIVATE_KEY" "$VAULT" \
    "settle(bytes32)" "$FAIL_OBLIGATION"

DEFAULT_AT=$((MATURITY + FAIL_GRACE))
STATE2_NOW=$(state_of "$ID2")
if [ "$STATE2_NOW" = "5" ]; then
    PENALTY2=$(call "$VAULT" "settlementPenaltyNow(bytes32)(uint256)" "$ID2" | n)
    less_than 0 "$PENALTY2" || {
        echo "CSDR Article 7 penalty did not accrue" >&2
        exit 1
    }
    printf '%s\n' "$PENALTY2" > "$WORK/penalty2.txt"
    watch_checkpoint position2-failing "$ID2"
    wait_until "$DEFAULT_AT" "fail grace"
    watch_checkpoint position2-defaultable "$ID2"
elif [ "$STATE2_NOW" = "6" ] || [ "$STATE2_NOW" = "7" ]; then
    [ -s "$WORK/penalty2.txt" ] &&
        [ -s "$WORK/watch-position2-defaultable.json" ] || {
        echo "position 2 advanced without its failing checkpoints" >&2
        exit 1
    }
    PENALTY2=$(awk '{print $1}' "$WORK/penalty2.txt")
else
    echo "position 2 did not enter FAILING" >&2
    exit 1
fi

DEFAULTABLE=$(field "$WORK/watch-position2-defaultable.json" alert.defaultable)
[ "$DEFAULTABLE" = "True" ] || [ "$DEFAULTABLE" = "true" ] || {
    echo "MarginWatch did not flag the failing repo as defaultable" >&2
    exit 1
}

if [ "$(state_of "$ID2")" = "5" ]; then
    send_once position2-declare-default "$HEDERA_PRIVATE_KEY" "$VAULT" \
        "declareDefault(bytes32)" "$ID2"
fi
if [ "$(state_of "$ID2")" = "6" ]; then
    send_once position2-settle-default "$HEDERA_PRIVATE_KEY" "$VAULT" \
        "settleDefault(bytes32)" "$ID2"
fi
[ "$(state_of "$ID2")" = "7" ] || {
    echo "position 2 did not close through default settlement" >&2
    exit 1
}
watch_checkpoint position2-closed "$ID2"

FREE_FINAL=$(call "$TOKEN" \
    "balanceOfByPartition(bytes32,address)(uint256)" "$PARTITION" "$BORROWER" | n)
HELD_FINAL=$(call "$TOKEN" \
    "getHeldAmountForByPartition(bytes32,address)(uint256)" "$PARTITION" "$BORROWER" | n)
LENDER_TOKEN_FINAL=$(call "$TOKEN" \
    "balanceOfByPartition(bytes32,address)(uint256)" "$PARTITION" "$LENDER" | n)
VAULT_FINAL_BALANCE=$(cast balance "$VAULT" --rpc-url "$RPC" | n)
FAIL_STATUS=$(call "$VAULT" \
    "obligation(bytes32)(address,bytes32,uint64,uint256,uint8,uint8)" \
    "$FAIL_OBLIGATION" | awk 'NR == 6 {print $1}')
COUPON_STATUS=$(call "$VAULT" \
    "obligation(bytes32)(address,bytes32,uint64,uint256,uint8,uint8)" \
    "$COUPON_OBLIGATION" | awk 'NR == 6 {print $1}')
REPO1_JSON=$(cast call "$VAULT" \
    "repo(bytes32)((uint8,address,address,bytes32,uint256,uint256,uint256,uint256,uint64,uint64,uint64,uint16,bytes32,bytes32))" \
    "$ID1" --rpc-url "$RPC" --json)
REPO2_JSON=$(cast call "$VAULT" \
    "repo(bytes32)((uint8,address,address,bytes32,uint256,uint256,uint256,uint256,uint64,uint64,uint64,uint16,bytes32,bytes32))" \
    "$ID2" --rpc-url "$RPC" --json)
REPO1_HOLD=$(printf '%s' "$REPO1_JSON" | python3 -c \
    "import json,sys; print(json.load(sys.stdin)[0][4])")
REPO1_OPENED=$(printf '%s' "$REPO1_JSON" | python3 -c \
    "import json,sys; print(json.load(sys.stdin)[0][8])")
REPO1_MATURITY=$(printf '%s' "$REPO1_JSON" | python3 -c \
    "import json,sys; print(json.load(sys.stdin)[0][9])")
REPO1_EXTRA_HOLD=$(call "$VAULT" "extraHoldAt(bytes32,uint256)(uint256)" "$ID1" 0 | n)
REPO2_HOLD=$(printf '%s' "$REPO2_JSON" | python3 -c \
    "import json,sys; print(json.load(sys.stdin)[0][4])")
REPO2_OPENED=$(printf '%s' "$REPO2_JSON" | python3 -c \
    "import json,sys; print(json.load(sys.stdin)[0][8])")
COUPON_COMMITMENT=$(call "$VAULT" \
    "commitmentOf(bytes32,uint256,uint256)(bytes32)" "$ID2" 0 "$COUPON_OWED" | n)

python3 -c "
assert int('$FREE_FINAL') == int('$FREE_START') - int('$LOT2')
assert int('$HELD_FINAL') == int('$HELD_START')
assert int('$LENDER_TOKEN_FINAL') == int('$LENDER_TOKEN_START') + int('$LOT2')
assert int('$VAULT_FINAL_BALANCE') == 0
assert int('$FAIL_STATUS') == 3
assert int('$COUPON_STATUS') == 3
" || {
    echo "final collateral, cash, or fallback obligation state did not reconcile" >&2
    exit 1
}

RPC_URL="$RPC" python3 - "$WORK" "$OUT" "$DEPLOYMENT" <<PY
import datetime
import json
import os
import pathlib
import sys
import urllib.request

work, output, deployment = map(pathlib.Path, sys.argv[1:])
receipts = {}
block_cache = {}

def block_time(raw):
    number_raw = raw["blockNumber"]
    number = int(number_raw, 16) if isinstance(number_raw, str) else int(number_raw)
    if number not in block_cache:
        body = json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_getBlockByNumber",
            "params": [hex(number), False],
        }).encode()
        request = urllib.request.Request(
            os.environ["RPC_URL"],
            data=body,
            headers={
                "content-type": "application/json",
                "user-agent": "curl/8.7.1",
            },
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)["result"]
        block_cache[number] = int(result["timestamp"], 16)
    timestamp = block_cache[number]
    when = datetime.datetime.fromtimestamp(
        timestamp, datetime.timezone.utc
    ).replace(microsecond=0).isoformat()
    return number, timestamp, when

for path in sorted(work.glob("*.json")):
    if path.name.startswith("watch-") or path.name == "unscheduled.json":
        continue
    raw = json.loads(path.read_text())
    if "transactionHash" not in raw:
        continue
    gas = raw.get("gasUsed", "0x0")
    tx = raw["transactionHash"]
    block, timestamp, when = block_time(raw)
    receipts[path.stem] = {
        "tx": tx,
        "status": str(raw.get("status", "")),
        "gasUsed": str(int(gas, 16) if isinstance(gas, str) else gas),
        "block": block,
        "blockTimestamp": timestamp,
        "blockTime": when,
        "hashscan": f"https://hashscan.io/testnet/transaction/{tx}",
    }

watches = sorted([
    json.loads(path.read_text())
    for path in sorted(work.glob("watch-*.json"))
], key=lambda item: int(item["chainTimestamp"]))
record = {
    "schema": "lattice.financing.lifecycle.v1",
    "checkedAt": datetime.datetime.now(datetime.timezone.utc).replace(
        microsecond=0
    ).isoformat(),
    "status": "complete",
    "network": "hedera-testnet",
    "deployment": json.loads(deployment.read_text()),
    "vault": "$VAULT",
    "marginWatch": "$WATCH",
    "couponSchedule": "$SCHEDULE",
    "oracle": "$ORACLE",
    "actors": {"borrower": "$BORROWER", "lender": "$LENDER"},
    "position1": {
        "id": "$ID1",
        "purpose": "live-feed margin call, added collateral, cure, and close",
        "terms": {
            "collateralAmount": "$LOT1",
            "haircutBps": "$HAIRCUT1",
            "maintenanceBps": "$MAINT1",
            "repoRateBps": "$RATE1",
            "termSeconds": "$TERM1",
        },
        "principalTinybar": "$PRINCIPAL1",
        "openedAt": "$REPO1_OPENED",
        "maturity": "$REPO1_MATURITY",
        "collateralHoldId": "$REPO1_HOLD",
        "extraHoldIds": ["$REPO1_EXTRA_HOLD"],
        "finalState": "CLOSED",
    },
    "position2": {
        "id": "$ID2",
        "purpose": "coupon observation, settlement fail, penalty, default, and collateral execution",
        "terms": {
            "collateralAmount": "$LOT2",
            "haircutBps": "$HAIRCUT2",
            "maintenanceBps": "$MAINT2",
            "repoRateBps": "$RATE2",
            "termSeconds": "$TERM2",
        },
        "principalTinybar": "$PRINCIPAL2",
        "openedAt": "$REPO2_OPENED",
        "collateralHoldId": "$REPO2_HOLD",
        "preFundingCouponSmallestCashUnits": "$PRE_FUND_COUPON",
        "preFundingReferenceRateBps": "$PRE_FUND_RATE",
        "couponDue": "$COUPON_DUE",
        "couponOwedSmallestCashUnits": "$COUPON_OWED",
        "couponCommitment": "$COUPON_COMMITMENT",
        "maturity": "$MATURITY",
        "penaltyTinybar": "$PENALTY2",
        "finalState": "CLOSED",
    },
    "hssFallback": {
        "vaultWasUnfunded": True,
        "failObligation": "$FAIL_OBLIGATION",
        "couponObligation": "$COUPON_OBLIGATION",
        "scheduleAddress": "$ZERO_ADDRESS",
        "finalStatus": "SETTLED",
        "unscheduled": json.loads((work / "unscheduled.json").read_text()),
    },
    "collateral": {
        "borrowerFreeBefore": "$FREE_START",
        "borrowerHeldBefore": "$HELD_START",
        "lenderFreeBefore": "$LENDER_TOKEN_START",
        "borrowerFreeAfter": "$FREE_FINAL",
        "borrowerHeldAfter": "$HELD_FINAL",
        "lenderFreeAfter": "$LENDER_TOKEN_FINAL",
        "executedToLender": "$LOT2",
    },
    "marginWatchCheckpoints": watches,
    "receipts": receipts,
    "assertions": {
        "marginCallFromLiveFeed": True,
        "collateralAdded": True,
        "curedBeforeDeadline": True,
        "couponDerivedFromHistoricalFixing": True,
        "unmarkedFailObserved": True,
        "article7PenaltyNonzero": True,
        "defaultAfterGrace": True,
        "collateralExecutedToLender": True,
        "manualFallbackSettledBothObligations": True,
    },
}
output.write_text(json.dumps(record, indent=2) + "\n")
print(f"wrote {output}")
PY
