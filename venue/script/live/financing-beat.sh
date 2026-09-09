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

LOT="${LOT:-10}"
HAIRCUT="${HAIRCUT:-200}"
MAINT="${MAINT:-200}"
RATE="${RATE:-450}"
TERM="${TERM:-3600}"
EXPIRES_IN="${EXPIRES_IN:-7200}"

TERMS="($PARTITION,$LOT,$HAIRCUT,$MAINT,$RATE,$TERM)"

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
ALLOWANCE=$(call "$TOKEN" "allowance(address,address)(uint256)" "$BORROWER" "$VAULT" | n)
LENDER_BAL=$(cast balance "$LENDER" --rpc-url "$RPC" | n)
BORROWER_BAL=$(cast balance "$BORROWER" --rpc-url "$RPC" | n)

echo "stale     $STALE"
echo "mark/unit $MARK tinybar"
echo "principal $PRINCIPAL tinybar"
echo "borrower free LPRC $FREE  allowance $ALLOWANCE  kyc $KYC_B"
echo "lender   kyc $KYC_L  balance $LENDER_BAL weibar"
echo "borrower balance $BORROWER_BAL weibar"

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

if [ "$MODE" != "run" ]; then
    echo
    echo "window is open. script/live/financing-beat.sh run"
    exit 0
fi

VALUE=$(node -e "import('./tools/units.mjs').then(u=>console.log(u.toWeibar(${PRINCIPAL}n).toString()))")
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
        --json --timeout 300 > "$WORK/$tag.json"
    python3 script/live/_txline.py "$WORK/$tag.json" "$tag"
    echo "$tag $(python3 -c "import json;print(json.load(open('$WORK/$tag.json'))['transactionHash'])")" >> "$WORK/tags.txt"
}

echo
echo "id $ID"
echo "fundOffer principal $PRINCIPAL tinybar  value $VALUE weibar"

send fundOffer "$LENDER_KEY" "$VAULT" \
    "fundOffer(bytes32,address,(bytes32,uint256,uint16,uint16,uint256,uint64),uint64)" \
    "$ID" "$BORROWER" "$TERMS" "$EXPIRES" --value "$VALUE"

if python3 -c "import sys; sys.exit(0 if int('$ALLOWANCE') < int('$LOT') else 1)"; then
    send approveCollateral "$BORROWER_KEY" "$TOKEN" \
        "approve(address,uint256)" "$VAULT" "$LOT"
    ALLOWANCE=$(call "$TOKEN" "allowance(address,address)(uint256)" "$BORROWER" "$VAULT" | n)
    if python3 -c "import sys; sys.exit(0 if int('$ALLOWANCE') < int('$LOT') else 1)"; then
        echo "ATS recorded allowance $ALLOWANCE, below required lot $LOT" >&2
        exit 1
    fi
fi

send accept "$BORROWER_KEY" "$VAULT" "accept(bytes32)" "$ID"

CREDIT_B=$(call "$VAULT" "credit(address)(uint256)" "$BORROWER" | n)
echo "borrower vault credit $CREDIT_B tinybar"
if [ "$CREDIT_B" != "$PRINCIPAL" ]; then
    echo "accept did not credit principal. got $CREDIT_B want $PRINCIPAL" >&2
    exit 1
fi

send withdrawBorrower "$BORROWER_KEY" "$VAULT" "withdraw()"

REPAY=$(call "$VAULT" "repurchasePriceNow(bytes32)(uint256)" "$ID" | n)
PENALTY=$(call "$VAULT" "settlementPenaltyNow(bytes32)(uint256)" "$ID" | n || echo 0)
DUE=$(python3 -c "print(int('$REPAY') + int('$PENALTY'))")
REPAY_VALUE=$(node -e "import('./tools/units.mjs').then(u=>console.log(u.toWeibar(${DUE}n).toString()))")
echo "close due $DUE tinybar (repurchase $REPAY + penalty $PENALTY)"

send close "$BORROWER_KEY" "$VAULT" "close(bytes32)" "$ID" --value "$REPAY_VALUE"

CREDIT_L=$(call "$VAULT" "credit(address)(uint256)" "$LENDER" | n)
echo "lender vault credit $CREDIT_L tinybar"
if python3 -c "import sys; sys.exit(0 if int('$CREDIT_L') < int('$PRINCIPAL') else 1)"; then
    echo "close did not credit the lender at least principal" >&2
    exit 1
fi

send withdrawLender "$LENDER_KEY" "$VAULT" "withdraw()"

python3 - <<PY
import json, pathlib
txs = {}
for line in pathlib.Path("$WORK/tags.txt").read_text().splitlines():
    k, _, h = line.partition(" ")
    txs[k] = h.strip()
pathlib.Path("$OUT").write_text(json.dumps({
    "checkedAt": __import__("datetime").datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    "vault": "$VAULT",
    "id": "$ID",
    "principalTinybar": "$PRINCIPAL",
    "repayTinybar": "$DUE",
    "lot": "$LOT",
    "borrower": "$BORROWER",
    "lender": "$LENDER",
    "txs": txs,
    "note": "Funded offer, accept (hold to 0, credit borrower), both withdraws, close releases the hold. Historical vaults are not this beat.",
}, indent=2) + "\n")
print("wrote $OUT")
PY
