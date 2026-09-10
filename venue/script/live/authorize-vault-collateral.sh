#!/usr/bin/env bash
# Give a newly deployed RepoVault an ATS allowance from the demo borrower.
#
# The live bond's compliance journal is address-bound and its current-epoch
# credential quota was already exhausted before RepoVault v5 was deployed. ATS
# checks the spender during approve, so a new vault cannot receive an allowance
# until the next credential epoch. This testnet-only recovery temporarily seats
# an immutable compliance contract that admits only `(owner, vault, 0)`, sends
# one approval, then restores the journal. Positive-value transfers remain
# refused throughout the window. The helper refuses unless the caller opts in.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(cd .. && pwd)"
set -a
. "$ROOT/.env"
. "$ROOT/.env.venue-actors"
set +a

: "${HEDERA_TESTNET_RPC:?set HEDERA_TESTNET_RPC}"
: "${HEDERA_PRIVATE_KEY:?set HEDERA_PRIVATE_KEY}"
: "${SELLER_PRIVATE_KEY:?set SELLER_PRIVATE_KEY}"
: "${SELLER_ADDRESS:?set SELLER_ADDRESS}"
: "${BUYER_ADDRESS:?set BUYER_ADDRESS}"

VAULT="${VAULT:-${1:-}}"
AMOUNT="${AMOUNT:-${2:-10}}"
OUT_DIR="${OUT_DIR:-deployments/.financing-beat}"
ALLOW_APPROVAL_WINDOW="${ALLOW_APPROVAL_WINDOW:-0}"
APPROVAL_WINDOW="${APPROVAL_WINDOW:-}"

[ -n "$VAULT" ] || {
    echo "usage: VAULT=0x... APPROVAL_WINDOW=0x... ALLOW_APPROVAL_WINDOW=1 $0 [vault] [amount]" >&2
    exit 1
}
[[ "$AMOUNT" =~ ^[1-9][0-9]*$ ]] || {
    echo "AMOUNT must be a positive integer" >&2
    exit 1
}

field() {
    local expression="$1"
    python3 -c \
        "import json; d=json.load(open('deployments/client.json')); print(d${expression})"
}

RPC="$HEDERA_TESTNET_RPC"
TOKEN=$(field "['addresses']['token']")
REGISTRY=$(field "['addresses']['ZkKycRegistry']")
DEPLOYER=$(cast wallet address --private-key "$HEDERA_PRIVATE_KEY")
mkdir -p "$OUT_DIR"

call() {
    cast call "$1" "$2" "${@:3}" --rpc-url "$RPC"
}

send_receipt() {
    local tag="$1" key="$2" target="$3" signature="$4"
    shift 4
    cast send "$target" "$signature" "$@" \
        --private-key "$key" --rpc-url "$RPC" \
        --gas-limit 500000 \
        --json --timeout 300 > "$OUT_DIR/$tag.json"
    python3 script/live/_txline.py "$OUT_DIR/$tag.json" "$tag"
}

listed=$(call "$TOKEN" "isExternalKycList(address)(bool)" "$REGISTRY")
[ "$listed" = "true" ] || {
    echo "the bound registry is not active on the ATS token; refusing" >&2
    exit 1
}

borrower_status=$(call "$REGISTRY" "getKycStatus(address)(uint8)" "$SELLER_ADDRESS" | awk '{print $1}')
lender_status=$(call "$REGISTRY" "getKycStatus(address)(uint8)" "$BUYER_ADDRESS" | awk '{print $1}')
[ "$borrower_status" = "1" ] && [ "$lender_status" = "1" ] || {
    echo "both counterparties must be granted before the temporary window" >&2
    exit 1
}

vault_status=$(call "$REGISTRY" "getKycStatus(address)(uint8)" "$VAULT" | awk '{print $1}')
if [ "$vault_status" = "1" ]; then
    send_receipt approveCollateral "$SELLER_PRIVATE_KEY" "$TOKEN" \
        "approve(address,uint256)" "$VAULT" "$AMOUNT"
else
    [ "$ALLOW_APPROVAL_WINDOW" = "1" ] || {
        echo "vault has no current KYC grant and the gate quota is exhausted" >&2
        echo "set ALLOW_APPROVAL_WINDOW=1 with its immutable APPROVAL_WINDOW" >&2
        exit 1
    }
    [ -n "$APPROVAL_WINDOW" ] || {
        echo "APPROVAL_WINDOW is required" >&2
        exit 1
    }

    original_compliance=$(call "$TOKEN" "compliance()(address)")
    window_token=$(call "$APPROVAL_WINDOW" "token()(address)")
    window_owner=$(call "$APPROVAL_WINDOW" "owner()(address)")
    window_spender=$(call "$APPROVAL_WINDOW" "spender()(address)")
    admits_approval=$(call "$APPROVAL_WINDOW" \
        "canTransfer(address,address,uint256)(bool)" "$SELLER_ADDRESS" "$VAULT" 0)
    admits_transfer=$(call "$APPROVAL_WINDOW" \
        "canTransfer(address,address,uint256)(bool)" "$SELLER_ADDRESS" "$VAULT" 1)
    python3 - <<PY
assert "$window_token".lower() == "$TOKEN".lower()
assert "$window_owner".lower() == "$SELLER_ADDRESS".lower()
assert "$window_spender".lower() == "$VAULT".lower()
assert "$admits_approval" == "true"
assert "$admits_transfer" == "false"
PY

    # Prove both seat changes are authorized before changing live state.
    call "$TOKEN" "setCompliance(address)" "$APPROVAL_WINDOW" \
        --from "$DEPLOYER" >/dev/null

    seated=0
    restore_compliance() {
        if [ "$seated" = "1" ]; then
            echo "restoring the compliance journal after an interrupted approval" >&2
            cast send "$TOKEN" "setCompliance(address)" "$original_compliance" \
                --private-key "$HEDERA_PRIVATE_KEY" --rpc-url "$RPC" \
                --gas-limit 500000 \
                --json --timeout 300 > "$OUT_DIR/complianceRestore.json"
            seated=0
        fi
    }
    trap restore_compliance EXIT

    send_receipt complianceSeat "$HEDERA_PRIVATE_KEY" "$TOKEN" \
        "setCompliance(address)" "$APPROVAL_WINDOW"
    seated=1

    send_receipt approveCollateral "$SELLER_PRIVATE_KEY" "$TOKEN" \
        "approve(address,uint256)" "$VAULT" "$AMOUNT"

    send_receipt complianceRestore "$HEDERA_PRIVATE_KEY" "$TOKEN" \
        "setCompliance(address)" "$original_compliance"
    seated=0
    trap - EXIT
fi

listed=$(call "$TOKEN" "isExternalKycList(address)(bool)" "$REGISTRY")
compliance=$(call "$TOKEN" "compliance()(address)")
allowance=$(call "$TOKEN" "allowance(address,address)(uint256)" "$SELLER_ADDRESS" "$VAULT" | awk '{print $1}')
borrower_status=$(call "$REGISTRY" "getKycStatus(address)(uint8)" "$SELLER_ADDRESS" | awk '{print $1}')
lender_status=$(call "$REGISTRY" "getKycStatus(address)(uint8)" "$BUYER_ADDRESS" | awk '{print $1}')

[ "$listed" = "true" ] || { echo "external KYC list was not restored" >&2; exit 1; }
if [ -n "${original_compliance:-}" ]; then
    python3 -c "assert '$compliance'.lower() == '$original_compliance'.lower()" || {
        echo "the original compliance journal was not restored" >&2
        exit 1
    }
fi
[ "$borrower_status" = "1" ] && [ "$lender_status" = "1" ] || {
    echo "counterparty grants did not survive restoration" >&2
    exit 1
}
python3 -c "assert int('$allowance') >= int('$AMOUNT')" || {
    echo "ATS allowance $allowance is below requested amount $AMOUNT" >&2
    exit 1
}

echo "vault allowance $allowance; compliance journal and KYC list verified"
