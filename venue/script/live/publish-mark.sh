#!/usr/bin/env bash
# TEST/BREAK-GLASS ONLY. NOT A PRODUCTION PUBLISHER.
# This script bypasses HCS-first production ordering and sends answers directly.
# Use it only for controlled test evidence or an explicitly approved emergency.
#
# One oracle round, on chain: three seated publishers answer, anyone finalises.
#
# ## What this is evidence of
#
# `PrimeOracle` is a median over a panel and a composition with a feed this
# project did not build. Neither claim is worth anything from a unit test: the
# median is trivial to fake with one publisher, and the Chainlink leg only
# exists on a chain where Chainlink is actually running. This sends three
# answers from three keys and then reads back the number the contract decided,
# alongside the number Chainlink's aggregator is answering with in the same
# block.
#
# The three prices are deliberately not equal. A round where every publisher
# says the same thing proves the plumbing and nothing about the rule; three
# distinct answers make the median a choice the contract had to make, and the
# transcript prints all three next to the result.
#
# ## Who pays
#
# Each publisher signs its own `submit`, because a seat that somebody else can
# answer for is not a seat. `finalize` is permissionless and the deployer sends
# it, which is the point of it being permissionless: the panel decides the
# price and does not decide when the price lands.
#
# ## The bounds this run is inside
#
# `maxDeviationBps` binds the round against the last one the venue agreed on, so
# a second run at a wildly different price is refused rather than accepted. That
# is deliberate and is documented in `docs/RULEBOOK.md` section 4.1. Run
# `plan` first: it prints the open round, the last price, and the cap, so the
# refusal is visible before it costs a transaction.
#
# Usage: script/live/publish-mark.sh [plan|run] [priceDollars] [rateBps] [ack]
#        plan  reads the chain and says what a run would do. Sends nothing.
#        run   sends three submits and one finalize without HCS-first ordering.
#
#   script/live/publish-mark.sh plan
#   script/live/publish-mark.sh run 100.00 425 ACKNOWLEDGE_TEST_BREAK_GLASS_HCS_BYPASS
set -euo pipefail
cd "$(dirname "$0")/../.."

MODE="${1:-plan}"
DOLLARS="${2:-100.00}"
RATE_BPS="${3:-425}"
ACKNOWLEDGEMENT="${4:-}"
REQUIRED_ACKNOWLEDGEMENT="ACKNOWLEDGE_TEST_BREAK_GLASS_HCS_BYPASS"

case "$MODE" in
    plan|run) ;;
    *)
        echo "usage: $0 [plan|run] [priceDollars] [rateBps] [ack]" >&2
        exit 1
        ;;
esac

echo "*** TEST/BREAK-GLASS ONLY ***"
echo "This path bypasses HCS-first production ordering."
echo "It must not replace the isolated production publishers."

if [ "$MODE" = "run" ] && [ "$ACKNOWLEDGEMENT" != "$REQUIRED_ACKNOWLEDGEMENT" ]; then
    echo "Send mode requires acknowledgement: $REQUIRED_ACKNOWLEDGEMENT" >&2
    exit 1
fi

require_private_file() {
    python3 - "$1" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
try:
    mode = stat.S_IMODE(os.stat(path).st_mode)
except OSError as error:
    raise SystemExit(f"cannot inspect protected environment file {path}: {error}")
if mode & 0o077:
    raise SystemExit(
        f"protected environment file {path} must not be group or world readable "
        f"(mode {mode:03o})"
    )
PY
}

ROOT_ENV="../.env"
ACTOR_ENV="../.env.venue-actors"
require_private_file "$ROOT_ENV"
require_private_file "$ACTOR_ENV"
set -a
. "$ROOT_ENV"
. "$ACTOR_ENV"
set +a
unset HEDERA_PRIVATE_KEY HEDERA_MNEMONIC HEDERA_OPERATOR_KEY \
    ORACLE_PUBLISHER_PRIVATE_KEY SELLER_PRIVATE_KEY BUYER_PRIVATE_KEY \
    BOT_PRIVATE_KEY DEALER_QUOTE_PRIVATE_KEY || true

RPC="${HEDERA_TESTNET_RPC:?set HEDERA_TESTNET_RPC}"
ORACLE="${PRIME_ORACLE:-$(python3 -c "
import json; print(json.load(open('deployments/296-venue.json'))['venue']['PrimeOracle'])")}"

# Eight decimals, which is Chainlink's scale and therefore this venue's. Done in
# python rather than bash arithmetic because bash has no fixed point and the one
# thing this repository has already lost a deployment to is a unit.
scale8() { python3 -c "
from decimal import Decimal
print(int(Decimal('$1') * Decimal(10) ** 8))"; }

PRICE_MID="$(scale8 "$DOLLARS")"
# A quarter of a dollar either side. Distinct, honest, and inside any sane
# deviation cap, so the median is doing work without the round being a stress
# test of the bound.
PRICE_LO="$(python3 -c "print($PRICE_MID - 25000000)")"
PRICE_HI="$(python3 -c "print($PRICE_MID + 25000000)")"
RATE_LO=$((RATE_BPS - 5))
RATE_HI=$((RATE_BPS + 5))

call() { cast call "$ORACLE" "$@" --rpc-url "$RPC"; }

ROUND="$(call "openRound()(uint64)")"
LAST="$(call "lastRound()(uint64)")"
QUORUM="$(call "quorum()(uint8)")"
CAP="$(call "maxDeviationBps()(uint16)")"
DARK="$(call "stale()(bool)")"
CASH_FEED="$(call "cashFeed()(address)")"

echo "oracle        $ORACLE"
echo "open round    $ROUND   (last finalised $LAST)"
echo "quorum        $QUORUM"
echo "deviation cap $CAP bps"
echo "feed now      $([ "$DARK" = "true" ] && echo dark || echo live)"
echo
echo "upstream      $CASH_FEED  (Chainlink, not ours)"
cast call "$CASH_FEED" "description()(string)" --rpc-url "$RPC" | sed 's/^/  description  /'
cast call "$CASH_FEED" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" \
    --rpc-url "$RPC" | sed 's/^/  /'
echo
echo "would submit, round $ROUND:"
echo "  $HEDERA_EVM_ADDRESS  price $PRICE_LO  rate $RATE_LO"
echo "  $SELLER_ADDRESS  price $PRICE_MID  rate $RATE_BPS"
echo "  $BUYER_ADDRESS  price $PRICE_HI  rate $RATE_HI"
echo "  median would be   price $PRICE_MID  rate $RATE_BPS"

if [ "$MODE" != "run" ]; then
    echo
    echo "plan only. Nothing sent."
    echo "Break-glass send command:"
    echo "  $0 run $DOLLARS $RATE_BPS $REQUIRED_ACKNOWLEDGEMENT"
    exit 0
fi

ACTOR_SIGNER_ARGS=()
prepare_actor_signer() {
    local actor="$1" expected_address="$2"
    local keystore="" account="" password_file=""
    case "$actor" in
        HEDERA)
            keystore="${HEDERA_KEYSTORE:-}"
            account="${HEDERA_KEYSTORE_ACCOUNT:-}"
            password_file="${HEDERA_KEYSTORE_PASSWORD_FILE:-}"
            ;;
        SELLER)
            keystore="${SELLER_KEYSTORE:-}"
            account="${SELLER_KEYSTORE_ACCOUNT:-}"
            password_file="${SELLER_KEYSTORE_PASSWORD_FILE:-}"
            ;;
        BUYER)
            keystore="${BUYER_KEYSTORE:-}"
            account="${BUYER_KEYSTORE_ACCOUNT:-}"
            password_file="${BUYER_KEYSTORE_PASSWORD_FILE:-}"
            ;;
        *)
            echo "unknown signer role $actor" >&2
            exit 1
            ;;
    esac

    ACTOR_SIGNER_ARGS=()
    if [ -n "$keystore" ]; then
        if [ ! -f "$keystore" ]; then
            echo "$actor keystore does not exist: $keystore" >&2
            exit 1
        fi
        ACTOR_SIGNER_ARGS=(--keystore "$keystore")
    elif [ -n "$account" ]; then
        ACTOR_SIGNER_ARGS=(--account "$account")
    else
        echo "Set ${actor}_KEYSTORE or ${actor}_KEYSTORE_ACCOUNT for send mode." >&2
        exit 1
    fi

    if [ -n "$password_file" ]; then
        require_private_file "$password_file"
        ACTOR_SIGNER_ARGS+=(--password-file "$password_file")
    elif [ ! -t 0 ]; then
        echo "Set ${actor}_KEYSTORE_PASSWORD_FILE for noninteractive send mode." >&2
        exit 1
    fi

    local signer_address
    signer_address="$(cast wallet address "${ACTOR_SIGNER_ARGS[@]}")"
    if [ "$(printf '%s' "$signer_address" | tr '[:upper:]' '[:lower:]')" != \
        "$(printf '%s' "$expected_address" | tr '[:upper:]' '[:lower:]')" ]; then
        echo "$actor keystore resolves to $signer_address, expected $expected_address." >&2
        exit 1
    fi
}

print_receipt() {
    python3 -c \
        "import json,sys; d=json.load(sys.stdin); print('  tx', d['transactionHash'], 'status', d['status'])"
}

send() { # <actor> <address> <price> <rate>
    prepare_actor_signer "$1" "$2"
    cast send "$ORACLE" "submit(uint64,uint128,uint64)" "$ROUND" "$3" "$4" \
        "${ACTOR_SIGNER_ARGS[@]}" --rpc-url "$RPC" --legacy --json |
        print_receipt
}

finalize() {
    prepare_actor_signer "HEDERA" "$HEDERA_EVM_ADDRESS"
    cast send "$ORACLE" "finalize(uint64)" "$ROUND" \
        "${ACTOR_SIGNER_ARGS[@]}" --rpc-url "$RPC" --legacy --json |
        print_receipt
}

echo
echo "submitting through the acknowledged TEST/BREAK-GLASS path."
echo "No HCS evidence is submitted before these EVM transactions."
send "HEDERA" "$HEDERA_EVM_ADDRESS" "$PRICE_LO" "$RATE_LO"
send "SELLER" "$SELLER_ADDRESS" "$PRICE_MID" "$RATE_BPS"
send "BUYER" "$BUYER_ADDRESS" "$PRICE_HI" "$RATE_HI"

echo
echo "finalising (permissionless; the deployer happens to be the one calling)."
finalize

echo
echo "read back:"
call "latest()(uint128,uint64,uint64,uint64)" | sed 's/^/  latest           /'
call "markPerUnitTinybar()(uint256)" | sed 's/^/  tinybar per unit /'
call "stale()(bool)" | sed 's/^/  stale            /'
call "latestRoundData()(uint80,int256,uint256,uint256,uint80)" |
    sed 's/^/  chainlink shape  /'
