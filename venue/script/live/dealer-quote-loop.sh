#!/usr/bin/env bash
# Re-sign the simulated testnet dealer quote on an interval so the publishers'
# file: dealer source never ages past dealers.maximumAgeSeconds. Testnet only:
# the runbook says the signer is not a production daemon, and this loop exists
# because the local seats read the quote from a file instead of a dealer HTTPS
# endpoint. Usage: dealer-quote-loop.sh [start|stop|status|once]
set -euo pipefail
cd "$(dirname "$0")/../.."
VENUE=$(pwd)

MODE="${1:-status}"
NODE22="${ORACLE_NODE:-$HOME/.nvm/versions/node/v22.21.1/bin/node}"
KEY_FILE="$VENUE/oracle/secrets/testnet-dealer.env"
PRICE_USD="${DEALER_QUOTE_PRICE_USD:-99.9998}"
INTERVAL="${DEALER_QUOTE_INTERVAL_SECONDS:-900}"
SOURCE="$VENUE/oracle/state/dealer/source-packet.json"
OUTPUT="$VENUE/oracle/state/dealer/quote.json"
LOG="$VENUE/oracle/state/dealer/signer.log"
PIDFILE="$VENUE/oracle/state/dealer/signer.pid"

sign_once() {
    local key
    key=$(grep -E '^DEALER_QUOTE_PRIVATE_KEY=' "$KEY_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'")
    [ -n "$key" ] || { echo "DEALER_QUOTE_PRIVATE_KEY is not set in $KEY_FILE" >&2; return 1; }
    env -i HOME="$HOME" PATH="$(dirname "$NODE22"):/usr/bin:/bin" \
        DEALER_QUOTE_PRIVATE_KEY="$key" \
        "$NODE22" oracle/sign-dealer-quote.mjs \
            --price-usd "$PRICE_USD" \
            --label simulated-testnet-dealer \
            --source "$SOURCE" \
            --output "$OUTPUT"
}

loop_pid() {
    [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null && cat "$PIDFILE" || true
}

case "$MODE" in
    once)
        sign_once
        ;;
    start)
        if [ -n "$(loop_pid)" ]; then
            echo "dealer loop already running (pid $(loop_pid))"
            exit 0
        fi
        sign_once
        nohup bash -c "
            cd '$VENUE'
            while sleep $INTERVAL; do
                bash script/live/dealer-quote-loop.sh once || echo \"\$(date -u +%FT%TZ) sign failed\"
            done" >>"$LOG" 2>&1 < /dev/null &
        echo $! >"$PIDFILE"
        echo "dealer loop started (pid $!, every ${INTERVAL}s, log $LOG)"
        ;;
    stop)
        pid=$(loop_pid)
        if [ -z "$pid" ]; then echo "dealer loop not running"; exit 0; fi
        pkill -TERM -P "$pid" 2>/dev/null || true
        kill -TERM "$pid" 2>/dev/null || true
        rm -f "$PIDFILE"
        echo "dealer loop stopped"
        ;;
    status)
        pid=$(loop_pid)
        echo "dealer loop pid: ${pid:-none}"
        python3 -c "
import json,time
q=json.load(open('$OUTPUT'))
now=int(time.time())
print('quote effectiveAt', q['effectiveAt'], 'age', now-q['effectiveAt'], 's, expires in', q['expiresAt']-now, 's')"
        ;;
    *)
        echo "usage: $0 [start|stop|status|once]" >&2
        exit 1
        ;;
esac
