#!/usr/bin/env bash
# Start, stop, or inspect the three local PrimeOracle publisher seats.
# Each seat gets a minimal environment holding only its own key, read from the
# operator env files at launch and never printed. Node 22 comes from nvm because
# the default node on this machine is too old for the publisher's logger.
set -euo pipefail
cd "$(dirname "$0")/../.."
VENUE=$(pwd)

MODE="${1:-status}"
case "$MODE" in
    start|stop|status) ;;
    *)
        echo "usage: $0 [start|stop|status]" >&2
        exit 1
        ;;
esac

NODE22="${ORACLE_NODE:-$HOME/.nvm/versions/node/v22.21.1/bin/node}"
RPC="${HEDERA_TESTNET_RPC:-https://testnet.hashio.io/api}"
MIRROR="${HEDERA_MIRROR_URL:-https://testnet.mirrornode.hedera.com}"

# id  Hedera account  evidence topic  EVM address  source profile  health port  key file  key variable
SEATS=(
    "issuer 0.0.10301312 0.0.10450872 0xcfc5923def1f25db05fe50754ef0822175afd449 issuer-primary 8081 ../.env HEDERA_PRIVATE_KEY"
    "seller 0.0.10381635 0.0.10450875 0x21113454ae7A3c2Dec1cfAc29f4fD715E9FB3397 seller-primary 8082 ../.env.venue-actors SELLER_PRIVATE_KEY"
    "buyer 0.0.10381640 0.0.10450876 0xBF01061EC7F793b0D4e9D7EAE2b383e86cA13F2d buyer-primary 8083 ../.env.venue-actors BUYER_PRIVATE_KEY"
)

env_value() { # env_value <file> <NAME>: value of NAME= in an env file, quotes stripped
    grep -E "^$2=" "$1" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

seat_pids() { # seat_pids <id>: PIDs of running publishers for one seat
    for pid in $(pgrep -f "oracle/publisher.mjs" || true); do
        if ps eww -p "$pid" 2>/dev/null | tr ' ' '\n' | grep -qx "ORACLE_PUBLISHER_ID=$1"; then
            echo "$pid"
        fi
    done
}

start_seat() {
    local id=$1 account=$2 topic=$3 address=$4 profile=$5 port=$6 file=$7 variable=$8
    if [ -n "$(seat_pids "$id")" ]; then
        echo "$id already running (pid $(seat_pids "$id" | tr '\n' ' '))"
        return
    fi
    if [ ! -f "$file" ]; then
        echo "$id: missing key file $file" >&2
        return 1
    fi
    local key
    key=$(env_value "$file" "$variable")
    if [ -z "$key" ]; then
        echo "$id: $variable is not set in $file" >&2
        return 1
    fi
    local log="$VENUE/oracle/state/$id/publisher.log"
    mkdir -p "$VENUE/oracle/state/$id"
    nohup env -i \
        HOME="$HOME" \
        PATH="$(dirname "$NODE22"):/usr/bin:/bin" \
        ORACLE_PUBLISHER_ID="$id" \
        ORACLE_PUBLISHER_ACCOUNT_ID="$account" \
        ORACLE_EVIDENCE_TOPIC_ID="$topic" \
        ORACLE_PUBLISHER_ADDRESS="$address" \
        ORACLE_SOURCE_PROFILE="$profile" \
        ORACLE_HEALTH_PORT="$port" \
        ORACLE_PUBLISHER_PRIVATE_KEY="$key" \
        HEDERA_TESTNET_RPC="$RPC" \
        HEDERA_MIRROR_URL="$MIRROR" \
        "$NODE22" oracle/publisher.mjs --config oracle/config.json \
        >>"$log" 2>&1 < /dev/null &
    echo "$id started (pid $!, health http://127.0.0.1:$port/healthz, log $log)"
}

stop_seat() {
    local id=$1
    local pids
    pids=$(seat_pids "$id")
    if [ -z "$pids" ]; then
        echo "$id not running"
        return
    fi
    kill -TERM $pids
    for _ in $(seq 1 15); do
        [ -z "$(seat_pids "$id")" ] && break
        sleep 1
    done
    if [ -n "$(seat_pids "$id")" ]; then
        echo "$id did not exit on SIGTERM; sending SIGKILL (journal writes are atomic)"
        kill -KILL $(seat_pids "$id")
    fi
    echo "$id stopped"
}

status_seat() {
    local id=$1 port=$6
    local pids
    pids=$(seat_pids "$id" | tr '\n' ' ')
    printf "%-7s pid: %-12s health: " "$id" "${pids:-none}"
    curl -s -m 3 "http://127.0.0.1:$port/healthz" || printf "(no response on %s)" "$port"
    echo
}

for seat in "${SEATS[@]}"; do
    # shellcheck disable=SC2086
    case "$MODE" in
        start) start_seat $seat ;;
        stop) stop_seat $seat ;;
        status) status_seat $seat ;;
    esac
done
