#!/usr/bin/env bash
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
# Usage: script/live/publish-mark.sh [plan|run] [priceDollars] [rateBps]
#        plan  reads the chain and says what a run would do. Sends nothing.
#        run   sends three submits and one finalize.
#
#   script/live/publish-mark.sh plan
#   script/live/publish-mark.sh run 100.00 425
set -euo pipefail
cd "$(dirname "$0")/../.."

MODE="${1:-plan}"
DOLLARS="${2:-100.00}"
RATE_BPS="${3:-425}"

set -a
. ../.env
. ../.env.venue-actors
set +a

RPC="$HEDERA_TESTNET_RPC"
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
    echo "plan only. Nothing sent. Re-run with: $0 run $DOLLARS $RATE_BPS"
    exit 0
fi

send() { # <key> <price> <rate>
    cast send "$ORACLE" "submit(uint64,uint128,uint64)" "$ROUND" "$2" "$3" \
        --private-key "$1" --rpc-url "$RPC" --legacy --json |
        python3 -c "import json,sys; d=json.load(sys.stdin); print('  tx', d['transactionHash'], 'status', d['status'])"
}

echo
echo "submitting."
send "$HEDERA_PRIVATE_KEY" "$PRICE_LO" "$RATE_LO"
send "$SELLER_PRIVATE_KEY" "$PRICE_MID" "$RATE_BPS"
send "$BUYER_PRIVATE_KEY" "$PRICE_HI" "$RATE_HI"

echo
echo "finalising (permissionless; the deployer happens to be the one calling)."
cast send "$ORACLE" "finalize(uint64)" "$ROUND" \
    --private-key "$HEDERA_PRIVATE_KEY" --rpc-url "$RPC" --legacy --json |
    python3 -c "import json,sys; d=json.load(sys.stdin); print('  tx', d['transactionHash'], 'status', d['status'])"

echo
echo "read back:"
call "latest()(uint128,uint64,uint64,uint64)" | sed 's/^/  latest           /'
call "markPerUnitTinybar()(uint256)" | sed 's/^/  tinybar per unit /'
call "stale()(bool)" | sed 's/^/  stale            /'
call "latestRoundData()(uint80,int256,uint256,uint256,uint80)" |
    sed 's/^/  chainlink shape  /'
