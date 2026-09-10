#!/usr/bin/env bash
# Funded-offer financing beat: lender deposits principal, borrower accepts a
# hold, both withdraw. Cash and collateral actually move.
#
# This refuses to send against a historical vault. `FINANCING_VERSION()` must
# answer 5. Do not point it at the superseded address in client.json.
#
# Usage: script/live/financing-beat.sh [plan|run]
#        plan  reads version, quote, balances. Sends nothing.
#        run   fundOffer, accept, borrower withdraw, close, lender withdraw.
#              writes deployments/financing-beat.json
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(cd .. && pwd)"
MODE="${1:-plan}"
set -a; . "$ROOT/.env"; . "$ROOT/.env.venue-actors"; set +a
: "${HEDERA_TESTNET_RPC:?set HEDERA_TESTNET_RPC}"
: "${SELLER_ADDRESS:?}" "${BUYER_ADDRESS:?}"
if [ "$MODE" = "run" ]; then
    : "${SELLER_PRIVATE_KEY:?}" "${BUYER_PRIVATE_KEY:?}"
fi
RPC="$HEDERA_TESTNET_RPC"

VAULT=$(python3 -c "import json;print(json.load(open('deployments/client.json'))['addresses']['RepoVault'])")
TOKEN=$(python3 -c "import json;print(json.load(open('deployments/client.json'))['addresses']['token'])")
ORACLE=$(python3 -c "import json;print(json.load(open('deployments/client.json'))['addresses']['PrimeOracle'])")
PARTITION=$(python3 -c "import json;print(json.load(open('deployments/client.json'))['immutables']['partition'])")
REGISTRY=$(python3 -c "import json;print(json.load(open('deployments/client.json'))['addresses']['ZkKycRegistry'])")

n() { awk '{print $1}'; }
call() { cast call "$1" "$2" "${@:3}" --rpc-url "$RPC"; }

BORROWER="$SELLER_ADDRESS"
LENDER="$BUYER_ADDRESS"
BORROWER_KEY="${SELLER_PRIVATE_KEY:-}"
LENDER_KEY="${BUYER_PRIVATE_KEY:-}"

LOT="${LOT:-1}"
HAIRCUT="${HAIRCUT:-200}"
MAINT="${MAINT:-200}"
RATE="${RATE:-450}"
TERM_SECONDS="${TERM_SECONDS:-3600}"
EXPIRES_IN="${EXPIRES_IN:-7200}"
GAS_HEADROOM_HBAR="${GAS_HEADROOM_HBAR:-25}"
SEND_GAS_LIMIT="${SEND_GAS_LIMIT:-4000000}"

TERMS="($PARTITION,$LOT,$HAIRCUT,$MAINT,$RATE,$TERM_SECONDS)"

version_of() {
    call "$VAULT" "FINANCING_VERSION()(uint8)" 2>/dev/null | n || echo "0"
}

echo "vault     $VAULT"
echo "borrower  $BORROWER  (seller actor, holds LPRC)"
echo "lender    $LENDER    (buyer actor, funds HBAR)"

VERSION=$(version_of)
echo "FINANCING_VERSION  $VERSION"

if [ "$VERSION" != "5" ]; then
    echo
    echo "bound vault is historical. financing writes stay unavailable."
    echo "deploy script/DeployOracle.s.sol, publish a round, then make client and rerun."
    echo "do not send fundOffer at this address."
    if [ "$MODE" = "run" ]; then
        exit 1
    fi
    exit 0
fi

PRINCIPAL=$(call "$VAULT" "quotePrincipal((bytes32,uint256,uint16,uint16,uint256,uint64))(uint256)" "$TERMS" | n)
MARK=$(call "$ORACLE" "markPerUnitTinybar()(uint256)" | n || echo "0")
STALE=$(call "$ORACLE" "stale()(bool)")
KYC_B=$(call "$REGISTRY" "getKycStatus(address)(uint8)" "$BORROWER" | n)
KYC_L=$(call "$REGISTRY" "getKycStatus(address)(uint8)" "$LENDER" | n)
FREE=$(call "$TOKEN" "balanceOfByPartition(bytes32,address)(uint256)" "$PARTITION" "$BORROWER" | n)
HELD=$(call "$TOKEN" "getHeldAmountForByPartition(bytes32,address)(uint256)" "$PARTITION" "$BORROWER" | n)
ALLOWANCE=$(call "$TOKEN" "allowance(address,address)(uint256)" "$BORROWER" "$VAULT" | n)
LENDER_BAL=$(cast balance "$LENDER" --rpc-url "$RPC" | n)
BORROWER_BAL=$(cast balance "$BORROWER" --rpc-url "$RPC" | n)
VAULT_BAL=$(cast balance "$VAULT" --rpc-url "$RPC" | n)
CASH_RESERVED=$(call "$VAULT" "cashReserved()(uint256)" | n)
CREDIT_B_BEFORE=$(call "$VAULT" "credit(address)(uint256)" "$BORROWER" | n)
CREDIT_L_BEFORE=$(call "$VAULT" "credit(address)(uint256)" "$LENDER" | n)

echo "stale     $STALE"
echo "mark/unit $MARK tinybar"
echo "principal $PRINCIPAL tinybar"
echo "borrower free LPRC $FREE  held $HELD  allowance $ALLOWANCE  kyc $KYC_B"
echo "lender   kyc $KYC_L  balance $LENDER_BAL weibar"
echo "borrower balance $BORROWER_BAL weibar"
echo "vault balance $VAULT_BAL weibar  cash reserved $CASH_RESERVED tinybar"

if [ "$CREDIT_B_BEFORE" != "0" ] || [ "$CREDIT_L_BEFORE" != "0" ]; then
    echo "withdraw existing vault credits before running an isolated beat" >&2
    [ "$MODE" = "run" ] && exit 1
    exit 0
fi

if [ "$STALE" = "true" ] || [ "$PRINCIPAL" = "0" ]; then
    echo "feed is dark or quote is zero. coverage cannot be evaluated."
    [ "$MODE" = "run" ] && exit 1
    exit 0
fi
if [ "$KYC_B" != "1" ]; then
    echo "borrower is not granted this KYC epoch. the vault will refuse funding."
    [ "$MODE" = "run" ] && exit 1
    exit 0
fi
if [ "$KYC_L" != "1" ]; then
    echo "lender is not granted this KYC epoch. the vault will refuse funding."
    [ "$MODE" = "run" ] && exit 1
    exit 0
fi
if python3 -c "import sys; sys.exit(0 if int('$FREE') < int('$LOT') else 1)"; then
    echo "borrower free lot $FREE < $LOT"
    [ "$MODE" = "run" ] && exit 1
    exit 0
fi
if python3 -c "import sys; sys.exit(0 if int('$ALLOWANCE') < int('$LOT') else 1)"; then
    echo "borrower must authorize $LOT LPRC to the vault before acceptance"
fi

VALUE=$(node -e "import('./tools/units.mjs').then(u=>console.log(u.toWeibar(${PRINCIPAL}n).toString()))")
LENDER_REQUIRED=$(python3 -c \
    "print(int('$VALUE') + int('$GAS_HEADROOM_HBAR') * 10**18)")
if python3 -c \
    "import sys; sys.exit(0 if int('$LENDER_BAL') < int('$LENDER_REQUIRED') else 1)"; then
    echo "lender capital is short: has $LENDER_BAL, needs $LENDER_REQUIRED weibar" >&2
    [ "$MODE" = "run" ] && exit 1
    exit 0
fi

if [ "$MODE" != "run" ]; then
    echo
    echo "window is open. script/live/financing-beat.sh run"
    exit 0
fi

ID=$(cast keccak "lattice-prime financing beat $(date -u +%s) $RANDOM")
EXPIRES=$(( $(date -u +%s) + EXPIRES_IN ))
WORK="deployments/.financing-beat"
mkdir -p "$WORK"
: > "$WORK/tags.txt"
OUT="deployments/financing-beat.json"

send() {
    local tag="$1"; shift
    local key="$1"; shift
    echo
    echo "send $tag"
    cast send "$@" \
        --private-key "$key" --rpc-url "$RPC" \
        --gas-limit "$SEND_GAS_LIMIT" \
        --json --timeout 300 > "$WORK/$tag.json"
    python3 script/live/_txline.py "$WORK/$tag.json" "$tag"
    echo "$tag $(python3 -c "import json;print(json.load(open('$WORK/$tag.json'))['transactionHash'])")" >> "$WORK/tags.txt"
}

recover_offer() {
    local reason="$1"
    echo "$reason. cancelling the funded offer before acceptance." >&2
    send cancelOffer "$LENDER_KEY" "$VAULT" "cancelOffer(bytes32)" "$ID"
    local recovered
    recovered=$(call "$VAULT" "credit(address)(uint256)" "$LENDER" | n)
    if [ "$recovered" != "0" ]; then
        send withdrawLenderRecovery "$LENDER_KEY" "$VAULT" "withdraw()"
    fi
    REASON="$reason" python3 - <<PY
import datetime, json, os, pathlib
txs = {}
for line in pathlib.Path("$WORK/tags.txt").read_text().splitlines():
    tag, _, tx = line.partition(" ")
    txs[tag] = tx.strip()
pathlib.Path("$OUT").write_text(json.dumps({
    "schema": "lattice.financing.beat.v1",
    "checkedAt": datetime.datetime.now(datetime.timezone.utc).replace(
        microsecond=0
    ).isoformat(),
    "status": "offer-recovered-before-acceptance",
    "reason": os.environ["REASON"],
    "vault": "$VAULT",
    "id": "$ID",
    "principalTinybar": "$PRINCIPAL",
    "lot": "$LOT",
    "txs": txs,
}, indent=2) + "\n")
PY
    echo "lender funds recovered; wrote $OUT" >&2
    exit 1
}

echo
echo "id $ID"
echo "fundOffer principal $PRINCIPAL tinybar  value $VALUE weibar"

send fundOffer "$LENDER_KEY" "$VAULT" \
    "fundOffer(bytes32,address,(bytes32,uint256,uint16,uint16,uint256,uint64),uint64)" \
    "$ID" "$BORROWER" "$TERMS" "$EXPIRES" --value "$VALUE"

STATE_AFTER_FUND=$(call "$VAULT" "stateOf(bytes32)(uint8)" "$ID" | n)
VAULT_AFTER_FUND=$(cast balance "$VAULT" --rpc-url "$RPC" | n)
CASH_AFTER_FUND=$(call "$VAULT" "cashReserved()(uint256)" | n)
QUOTE_AFTER_FUND=$(call "$VAULT" \
    "quotePrincipal((bytes32,uint256,uint16,uint16,uint256,uint64))(uint256)" \
    "$TERMS" 2>/dev/null | n || echo "unavailable")
if [ "$STATE_AFTER_FUND" != "0" ]; then
    recover_offer "repo state changed unexpectedly after fundOffer"
fi
if [ "$QUOTE_AFTER_FUND" != "$PRINCIPAL" ]; then
    recover_offer "oracle mark moved from funded principal $PRINCIPAL to $QUOTE_AFTER_FUND"
fi
python3 -c "
assert int('$VAULT_AFTER_FUND') == int('$VAULT_BAL') + int('$VALUE')
assert int('$CASH_AFTER_FUND') == int('$CASH_RESERVED') + int('$PRINCIPAL')
" || recover_offer "fundOffer cash accounting did not reconcile"

if python3 -c "import sys; sys.exit(0 if int('$ALLOWANCE') < int('$LOT') else 1)"; then
    send approveCollateral "$BORROWER_KEY" "$TOKEN" \
        "approve(address,uint256)" "$VAULT" "$LOT"
    ALLOWANCE=$(call "$TOKEN" "allowance(address,address)(uint256)" "$BORROWER" "$VAULT" | n)
    if python3 -c "import sys; sys.exit(0 if int('$ALLOWANCE') < int('$LOT') else 1)"; then
        echo "ATS recorded allowance $ALLOWANCE, below required lot $LOT" >&2
        exit 1
    fi
fi

QUOTE_BEFORE_ACCEPT=$(call "$VAULT" \
    "quotePrincipal((bytes32,uint256,uint16,uint16,uint256,uint64))(uint256)" \
    "$TERMS" 2>/dev/null | n || echo "unavailable")
if [ "$QUOTE_BEFORE_ACCEPT" != "$PRINCIPAL" ]; then
    recover_offer "oracle mark moved before acceptance from $PRINCIPAL to $QUOTE_BEFORE_ACCEPT"
fi

send accept "$BORROWER_KEY" "$VAULT" "accept(bytes32)" "$ID"

CREDIT_B=$(call "$VAULT" "credit(address)(uint256)" "$BORROWER" | n)
STATE_OPEN=$(call "$VAULT" "stateOf(bytes32)(uint8)" "$ID" | n)
REPO_OPEN_JSON=$(cast call "$VAULT" \
    "repo(bytes32)((uint8,address,address,bytes32,uint256,uint256,uint256,uint256,uint64,uint64,uint64,uint16,bytes32,bytes32))" \
    "$ID" --rpc-url "$RPC" --json)
HOLD_ID=$(printf '%s' "$REPO_OPEN_JSON" | python3 -c \
    "import json,sys; print(json.load(sys.stdin)[0][4])")
HOLD_JSON=$(cast call "$TOKEN" \
    "getHoldForByPartition((bytes32,address,uint256))(uint256,uint256,address,address,bytes,bytes,uint8)" \
    "($PARTITION,$BORROWER,$HOLD_ID)" --rpc-url "$RPC" --json)
HOLD_AMOUNT=$(printf '%s' "$HOLD_JSON" | python3 -c \
    "import json,sys; print(json.load(sys.stdin)[0])")
HOLD_ESCROW=$(printf '%s' "$HOLD_JSON" | python3 -c \
    "import json,sys; print(json.load(sys.stdin)[2])")
FREE_OPEN=$(call "$TOKEN" "balanceOfByPartition(bytes32,address)(uint256)" "$PARTITION" "$BORROWER" | n)
HELD_OPEN=$(call "$TOKEN" "getHeldAmountForByPartition(bytes32,address)(uint256)" "$PARTITION" "$BORROWER" | n)
VAULT_OPEN=$(cast balance "$VAULT" --rpc-url "$RPC" | n)
CASH_OPEN=$(call "$VAULT" "cashReserved()(uint256)" | n)
echo "borrower vault credit $CREDIT_B tinybar"
if [ "$CREDIT_B" != "$PRINCIPAL" ]; then
    echo "accept did not credit principal. got $CREDIT_B want $PRINCIPAL" >&2
    exit 1
fi
python3 -c "
assert int('$STATE_OPEN') == 2
assert int('$HOLD_ID') > 0
assert int('$HOLD_AMOUNT') == int('$LOT')
assert '$HOLD_ESCROW'.lower() == '$VAULT'.lower()
assert int('$FREE_OPEN') == int('$FREE') - int('$LOT')
assert int('$HELD_OPEN') == int('$HELD') + int('$LOT')
assert int('$VAULT_OPEN') == int('$VAULT_AFTER_FUND')
assert int('$CASH_OPEN') == int('$CASH_AFTER_FUND')
" || {
    echo "open-state collateral or cash snapshot did not reconcile" >&2
    exit 1
}

send withdrawBorrower "$BORROWER_KEY" "$VAULT" "withdraw()"

CREDIT_B_WITHDRAWN=$(call "$VAULT" "credit(address)(uint256)" "$BORROWER" | n)
VAULT_AFTER_BORROWER_WITHDRAW=$(cast balance "$VAULT" --rpc-url "$RPC" | n)
CASH_AFTER_BORROWER_WITHDRAW=$(call "$VAULT" "cashReserved()(uint256)" | n)
python3 -c "
assert int('$CREDIT_B_WITHDRAWN') == 0
assert int('$VAULT_AFTER_BORROWER_WITHDRAW') == int('$VAULT_BAL')
assert int('$CASH_AFTER_BORROWER_WITHDRAW') == int('$CASH_RESERVED')
" || {
    echo "borrower withdrawal did not reconcile to the operating reserve" >&2
    exit 1
}

REPAY=$(call "$VAULT" "repurchasePriceNow(bytes32)(uint256)" "$ID" | n)
PENALTY=$(call "$VAULT" "settlementPenaltyNow(bytes32)(uint256)" "$ID" | n || echo 0)
DUE=$(python3 -c "print(int('$REPAY') + int('$PENALTY'))")
REPAY_VALUE=$(node -e "import('./tools/units.mjs').then(u=>console.log(u.toWeibar(${DUE}n).toString()))")
echo "close due $DUE tinybar (repurchase $REPAY + penalty $PENALTY)"

BORROWER_BEFORE_CLOSE=$(cast balance "$BORROWER" --rpc-url "$RPC" | n)
BORROWER_CLOSE_REQUIRED=$(python3 -c "print(int('$REPAY_VALUE') + 10 * 10**18)")
if python3 -c \
    "import sys; sys.exit(0 if int('$BORROWER_BEFORE_CLOSE') < int('$BORROWER_CLOSE_REQUIRED') else 1)"; then
    echo "borrower lacks close value plus gas headroom" >&2
    exit 1
fi

send close "$BORROWER_KEY" "$VAULT" "close(bytes32)" "$ID" --value "$REPAY_VALUE"

CREDIT_L=$(call "$VAULT" "credit(address)(uint256)" "$LENDER" | n)
STATE_CLOSED=$(call "$VAULT" "stateOf(bytes32)(uint8)" "$ID" | n)
FREE_CLOSED=$(call "$TOKEN" "balanceOfByPartition(bytes32,address)(uint256)" "$PARTITION" "$BORROWER" | n)
HELD_CLOSED=$(call "$TOKEN" "getHeldAmountForByPartition(bytes32,address)(uint256)" "$PARTITION" "$BORROWER" | n)
VAULT_CLOSED=$(cast balance "$VAULT" --rpc-url "$RPC" | n)
CASH_CLOSED=$(call "$VAULT" "cashReserved()(uint256)" | n)
echo "lender vault credit $CREDIT_L tinybar"
if [ "$CREDIT_L" != "$DUE" ]; then
    echo "close did not credit the lender the exact close amount" >&2
    exit 1
fi
python3 -c "
assert int('$STATE_CLOSED') == 7
assert int('$FREE_CLOSED') == int('$FREE')
assert int('$HELD_CLOSED') == int('$HELD')
assert int('$VAULT_CLOSED') == int('$VAULT_BAL') + int('$REPAY_VALUE')
assert int('$CASH_CLOSED') == int('$CASH_RESERVED') + int('$DUE')
" || {
    echo "close-state collateral or cash snapshot did not reconcile" >&2
    exit 1
}

send withdrawLender "$LENDER_KEY" "$VAULT" "withdraw()"

CREDIT_L_WITHDRAWN=$(call "$VAULT" "credit(address)(uint256)" "$LENDER" | n)
VAULT_FINAL=$(cast balance "$VAULT" --rpc-url "$RPC" | n)
CASH_FINAL=$(call "$VAULT" "cashReserved()(uint256)" | n)
BORROWER_FINAL=$(cast balance "$BORROWER" --rpc-url "$RPC" | n)
LENDER_FINAL=$(cast balance "$LENDER" --rpc-url "$RPC" | n)
python3 -c "
assert int('$CREDIT_L_WITHDRAWN') == 0
assert int('$VAULT_FINAL') == int('$VAULT_BAL')
assert int('$CASH_FINAL') == int('$CASH_RESERVED')
" || {
    echo "final cash ledger did not return to the operating reserve baseline" >&2
    exit 1
}

RPC_URL="$RPC" python3 - <<PY
import datetime
import json
import os
import pathlib
import urllib.request

work = pathlib.Path("$WORK")
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
        timestamp = int(result["timestamp"], 16)
        block_cache[number] = timestamp
    timestamp = block_cache[number]
    when = datetime.datetime.fromtimestamp(
        timestamp, datetime.timezone.utc
    ).replace(microsecond=0).isoformat()
    return number, timestamp, when

for line in (work / "tags.txt").read_text().splitlines():
    tag, _, tx = line.partition(" ")
    raw = json.loads((work / f"{tag}.json").read_text())
    gas = raw.get("gasUsed", "0x0")
    block, timestamp, when = block_time(raw)
    receipts[tag] = {
        "tx": tx.strip(),
        "status": str(raw.get("status", "")),
        "gasUsed": str(int(gas, 16) if isinstance(gas, str) else gas),
        "block": block,
        "blockTimestamp": timestamp,
        "blockTime": when,
        "hashscan": f"https://hashscan.io/testnet/transaction/{tx.strip()}",
    }

record = {
    "schema": "lattice.financing.beat.v1",
    "checkedAt": datetime.datetime.now(datetime.timezone.utc).replace(
        microsecond=0
    ).isoformat(),
    "network": "hedera-testnet",
    "vault": "$VAULT",
    "token": "$TOKEN",
    "financingVersion": 5,
    "id": "$ID",
    "borrower": "$BORROWER",
    "lender": "$LENDER",
    "terms": {
        "partition": "$PARTITION",
        "collateralAmount": "$LOT",
        "haircutBps": "$HAIRCUT",
        "maintenanceBps": "$MAINT",
        "repoRateBps": "$RATE",
        "termSeconds": "$TERM_SECONDS",
    },
    "cash": {
        "principalTinybar": "$PRINCIPAL",
        "repurchaseTinybar": "$REPAY",
        "penaltyTinybar": "$PENALTY",
        "closePaidTinybar": "$DUE",
    },
    "collateral": {
        "holdId": "$HOLD_ID",
        "amount": "$HOLD_AMOUNT",
        "escrow": "$HOLD_ESCROW",
        "releasedAtClose": True,
    },
    "snapshots": {
        "before": {
            "state": "NONE",
            "borrowerFreeCollateral": "$FREE",
            "borrowerHeldCollateral": "$HELD",
            "vaultBalanceWeibar": "$VAULT_BAL",
            "cashReservedTinybar": "$CASH_RESERVED",
            "borrowerBalanceWeibar": "$BORROWER_BAL",
            "lenderBalanceWeibar": "$LENDER_BAL",
        },
        "funded": {
            "state": "NONE, funded offer exists",
            "vaultBalanceWeibar": "$VAULT_AFTER_FUND",
            "cashReservedTinybar": "$CASH_AFTER_FUND",
            "quotedPrincipalTinybar": "$QUOTE_AFTER_FUND",
        },
        "open": {
            "state": "OPEN",
            "borrowerFreeCollateral": "$FREE_OPEN",
            "borrowerHeldCollateral": "$HELD_OPEN",
            "borrowerCreditTinybar": "$CREDIT_B",
            "vaultBalanceWeibar": "$VAULT_OPEN",
            "cashReservedTinybar": "$CASH_OPEN",
        },
        "borrowerWithdrew": {
            "borrowerCreditTinybar": "$CREDIT_B_WITHDRAWN",
            "vaultBalanceWeibar": "$VAULT_AFTER_BORROWER_WITHDRAW",
            "cashReservedTinybar": "$CASH_AFTER_BORROWER_WITHDRAW",
        },
        "closed": {
            "state": "CLOSED",
            "borrowerFreeCollateral": "$FREE_CLOSED",
            "borrowerHeldCollateral": "$HELD_CLOSED",
            "lenderCreditTinybar": "$CREDIT_L",
            "vaultBalanceWeibar": "$VAULT_CLOSED",
            "cashReservedTinybar": "$CASH_CLOSED",
        },
        "final": {
            "lenderCreditTinybar": "$CREDIT_L_WITHDRAWN",
            "vaultBalanceWeibar": "$VAULT_FINAL",
            "cashReservedTinybar": "$CASH_FINAL",
            "borrowerBalanceWeibar": "$BORROWER_FINAL",
            "lenderBalanceWeibar": "$LENDER_FINAL",
        },
    },
    "receipts": receipts,
    "assertions": {
        "cashRoundTrip": True,
        "holdCreatedAndReleased": True,
        "principalWithdrawn": True,
        "closePaidExactly": True,
        "finalStateClosed": True,
    },
}
pathlib.Path("$OUT").write_text(json.dumps(record, indent=2) + "\n")
print("wrote $OUT")
PY
