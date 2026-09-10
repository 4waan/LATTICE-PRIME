#!/usr/bin/env bash
# Resumable canonical coupon recovery and compressed ATS bond lifecycle.
#
# Usage:
#   script/live/bond-lifecycle.sh plan
#   script/live/bond-lifecycle.sh run
#
# The canonical path changes only CouponDistributor state. The compressed bond
# is evidence-only and never enters deployments/client.json.
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
if [ -s "$HOME/.nvm/nvm.sh" ]; then
    . "$HOME/.nvm/nvm.sh"
    nvm use 22.21.1 >/dev/null
fi

: "${HEDERA_TESTNET_RPC:?set HEDERA_TESTNET_RPC}"
: "${SELLER_ADDRESS:?set SELLER_ADDRESS}"
: "${BUYER_ADDRESS:?set BUYER_ADDRESS}"
if [ "$MODE" = "run" ]; then
    : "${HEDERA_PRIVATE_KEY:?set HEDERA_PRIVATE_KEY}"
    : "${SELLER_PRIVATE_KEY:?set SELLER_PRIVATE_KEY}"
    : "${BUYER_PRIVATE_KEY:?set BUYER_PRIVATE_KEY}"
fi

RPC="$HEDERA_TESTNET_RPC"
MIRROR="${HEDERA_MIRROR_URL:-https://testnet.mirrornode.hedera.com}"
CHAIN_ID_EXPECTED=296
DEPLOYMENT="deployments/296-venue.json"
WORK="deployments/.bond-lifecycle"
CANONICAL_ENTITLEMENTS="$WORK/canonical-entitlements.json"
CANONICAL_BASELINE="$WORK/canonical-baseline.json"
CANONICAL_FINAL="$WORK/canonical-final.json"
CANONICAL_OUT="deployments/bond-coupon-zero.json"
DEMO_DEPLOYMENT="$WORK/demo-deployment.json"
DEMO_BASELINE="$WORK/demo-baseline.json"
DEMO_ENTITLEMENTS="$WORK/demo-entitlements.json"
DEMO_FINAL="$WORK/demo-final.json"
DEMO_OUT="deployments/bond-lifecycle.json"

DEMO_LOT=10000
DEMO_REFERENCE_RATE_BPS=425
DEMO_SPREAD_BPS=75
DEMO_RATE_BPS=$((DEMO_REFERENCE_RATE_BPS + DEMO_SPREAD_BPS))
DEMO_RECORD_LEAD=300
SEND_GAS_LIMIT="${SEND_GAS_LIMIT:-4000000}"

n() { awk '{print $1}'; }
lower() { tr '[:upper:]' '[:lower:]'; }
call() { cast call "$1" "$2" "${@:3}" --rpc-url "$RPC"; }
field() {
    python3 - "$1" "$2" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))
for part in sys.argv[2].split("."):
    value = value[int(part)] if isinstance(value, list) else value[part]
if isinstance(value, bool):
    print(str(value).lower())
elif isinstance(value, list):
    print("[" + ",".join(str(item) for item in value) + "]")
else:
    print(value)
PY
}
less_than() {
    python3 - "$1" "$2" <<'PY'
import sys
raise SystemExit(0 if int(sys.argv[1]) < int(sys.argv[2]) else 1)
PY
}
chain_now() {
    cast block latest --json --rpc-url "$RPC" |
        python3 -c 'import json,sys
v=json.load(sys.stdin)["timestamp"]
print(int(v, 16) if isinstance(v, str) and v.startswith("0x") else int(v))'
}
assert_address() {
    local label="$1" actual="$2" expected="$3"
    if [ "$(printf '%s' "$actual" | lower)" != "$(printf '%s' "$expected" | lower)" ]; then
        echo "$label mismatch: got $actual, want $expected" >&2
        exit 1
    fi
}
assert_code() {
    local label="$1" address="$2"
    if [ "$(cast code "$address" --rpc-url "$RPC")" = "0x" ]; then
        echo "$label has no runtime code at $address" >&2
        exit 1
    fi
}
mirror_get() {
    curl --fail --silent --show-error --retry 5 --retry-all-errors \
        --connect-timeout 15 "$MIRROR$1"
}
contract_id() {
    local address="$1" body id
    for _ in $(seq 1 30); do
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
            --gas-limit "$SEND_GAS_LIMIT" --json --timeout 300 > "$WORK/$tag.tmp"; then
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
is_associated() {
    call "$CASH" "isAssociated()(bool)" --from "$1" 2>/dev/null | n || echo false
}
ensure_associated() {
    local tag="$1" holder="$2" key="$3"
    if [ "$(is_associated "$holder")" != "true" ]; then
        send_once "$tag" "$key" "$CASH" "associate()"
    fi
    [ "$(is_associated "$holder")" = "true" ] || {
        echo "$holder is not associated with LPCASH" >&2
        exit 1
    }
}
declaration_json() {
    cast call "$1" \
        "declarationOf(uint256)((bytes32,uint64,uint64,uint32,uint256,uint256,bool))" \
        0 --rpc-url "$RPC" --json
}
declaration_field() {
    declaration_json "$1" | python3 -c \
        "import json,sys; print(json.load(sys.stdin)[0][int('$2')])"
}
coupon_snapshot_id() {
    cast call "$1" \
        "getCoupon(uint256)(((uint256,uint256,uint256,uint256,uint256,uint256,uint8,uint8),uint256),bool)" \
        1 --rpc-url "$RPC" --json |
        python3 -c 'import json,sys; print(json.load(sys.stdin)[0][1])'
}
write_cash_baseline() {
    local output="$1" distributor="$2"
    ISSUER_BAL=$(call "$CASH" "balanceOf(address)(uint256)" "$ISSUER" | n) \
    SELLER_BAL=$(call "$CASH" "balanceOf(address)(uint256)" "$SELLER_ADDRESS" | n) \
    BUYER_BAL=$(call "$CASH" "balanceOf(address)(uint256)" "$BUYER_ADDRESS" | n) \
    DISTRIBUTOR_BAL=$(call "$CASH" "balanceOf(address)(uint256)" "$distributor" | n) \
    SELLER_ASSOC=$(is_associated "$SELLER_ADDRESS") \
    BUYER_ASSOC=$(is_associated "$BUYER_ADDRESS") \
        python3 - "$output" <<'PY'
import json, os, pathlib, sys
record = {
    "cash": {
        "issuer": os.environ["ISSUER_BAL"],
        "seller": os.environ["SELLER_BAL"],
        "buyer": os.environ["BUYER_BAL"],
        "distributor": os.environ["DISTRIBUTOR_BAL"],
    },
    "associated": {
        "seller": os.environ["SELLER_ASSOC"] == "true",
        "buyer": os.environ["BUYER_ASSOC"] == "true",
    },
}
pathlib.Path(sys.argv[1]).write_text(json.dumps(record, indent=2) + "\n")
PY
}
fund_to_total() {
    local tag="$1" distributor="$2" total="$3" held short
    held=$(call "$CASH" "balanceOf(address)(uint256)" "$distributor" | n)
    if less_than "$held" "$total"; then
        short=$((total - held))
        send_once "$tag" "$HEDERA_PRIVATE_KEY" "$CASH" \
            "transfer(address,uint256)" "$distributor" "$short"
    fi
    held=$(call "$CASH" "balanceOf(address)(uint256)" "$distributor" | n)
    if less_than "$held" "$total"; then
        echo "$distributor holds $held LPCASH, needs $total" >&2
        exit 1
    fi
}

for command in cast forge curl python3 node; do
    command -v "$command" >/dev/null || {
        echo "missing command: $command" >&2
        exit 1
    }
done

CHAIN_ID=$(cast chain-id --rpc-url "$RPC" | n)
[ "$CHAIN_ID" = "$CHAIN_ID_EXPECTED" ] || {
    echo "wrong chain: got $CHAIN_ID, want $CHAIN_ID_EXPECTED" >&2
    exit 1
}

mkdir -p "$WORK"
if [ "$MODE" = "run" ] &&
    [ -s "$CANONICAL_OUT" ] &&
    [ -s "$DEMO_OUT" ] &&
    [ "$(field "$CANONICAL_OUT" status)" = "complete" ] &&
    [ "$(field "$DEMO_OUT" status)" = "complete" ]; then
    echo "bond lifecycle already complete; run make bond-lifecycle-verify"
    exit 0
fi
BOND=$(field "$DEPLOYMENT" token.address)
MATURITY=$(call "$BOND" "getMaturityDate()(uint256)" | n)
SCHEDULE=$(field "$DEPLOYMENT" coupon.CouponSchedule)
DISTRIBUTOR=$(field "$DEPLOYMENT" coupon.CouponDistributor)
CASH=$(field "$DEPLOYMENT" coupon.cashToken.address)
ISSUER=$(call "$DISTRIBUTOR" "issuer()(address)" | n)
REGISTRY=$(field "$DEPLOYMENT" kyc.ZkKycRegistry)
POLICY=$(field "$DEPLOYMENT" policy.ParameterRoot)

for pair in \
    "bond:$BOND" \
    "schedule:$SCHEDULE" \
    "distributor:$DISTRIBUTOR" \
    "cash:$CASH" \
    "registry:$REGISTRY" \
    "policy:$POLICY"; do
    assert_code "${pair%%:*}" "${pair#*:}"
done

if [ "$MODE" = "run" ]; then
    DEPLOYER=$(cast wallet address --private-key "$HEDERA_PRIVATE_KEY")
    SELLER_FROM_KEY=$(cast wallet address --private-key "$SELLER_PRIVATE_KEY")
    BUYER_FROM_KEY=$(cast wallet address --private-key "$BUYER_PRIVATE_KEY")
    assert_address "issuer key" "$DEPLOYER" "$ISSUER"
    assert_address "seller key" "$SELLER_FROM_KEY" "$SELLER_ADDRESS"
    assert_address "buyer key" "$BUYER_FROM_KEY" "$BUYER_ADDRESS"
fi

node tools/bond-coupon-entitlements.mjs canonical "$CANONICAL_ENTITLEMENTS"
CANONICAL_ROOT=$(field "$CANONICAL_ENTITLEMENTS" root)
CANONICAL_TOTAL=$(field "$CANONICAL_ENTITLEMENTS" total)
CANONICAL_WIDTH=$(field "$CANONICAL_ENTITLEMENTS" width)
CANONICAL_RECORD=$(field "$CANONICAL_ENTITLEMENTS" recordDate)
CANONICAL_DUE=$(field "$CANONICAL_ENTITLEMENTS" dueAt)

[ "$(field "$CANONICAL_ENTITLEMENTS" cutoffBlock.number)" = "40259002" ] &&
[ "$(field "$CANONICAL_ENTITLEMENTS" fixing.referenceRateBps)" = "425" ] &&
[ "$(field "$CANONICAL_ENTITLEMENTS" totalLot)" = "4000" ] &&
[ "$CANONICAL_TOTAL" = "228" ] || {
    echo "canonical coupon reconstruction moved from its verified record-date facts" >&2
    exit 1
}
CANONICAL_DECLARED=$(declaration_field "$DISTRIBUTOR" 2)
if [ "$CANONICAL_DECLARED" = "0" ]; then
    [ "$(call "$DISTRIBUTOR" "wouldDisclose(uint16,uint8,uint8)(bool)" 7 4 1 | n)" = "true" ] &&
    [ "$(call "$DISTRIBUTOR" "wouldAfford(uint16,uint8)(bool)" 7 4 | n)" = "true" ] || {
        echo "canonical coupon declaration is blocked by disclosure policy" >&2
        exit 1
    }
fi

echo "canonical bond       $BOND"
echo "canonical maturity   $MATURITY"
echo "coupon zero due      $CANONICAL_DUE"
echo "record block         $(field "$CANONICAL_ENTITLEMENTS" cutoffBlock.number)"
echo "record-date lots     seller=$(field "$CANONICAL_ENTITLEMENTS" holders.0.lot) buyer=$(field "$CANONICAL_ENTITLEMENTS" holders.1.lot)"
echo "coupon fixing        $(field "$CANONICAL_ENTITLEMENTS" fixing.referenceRateBps) + $(field "$CANONICAL_ENTITLEMENTS" fixing.spreadBps) bps"
echo "gross LPCASH         $CANONICAL_TOTAL"
echo "entitlement root     $CANONICAL_ROOT"

if [ "$MODE" = "plan" ]; then
    echo "canonical declared   $CANONICAL_DECLARED"
    echo "demo lot             $DEMO_LOT"
    echo "demo coupon rate     $DEMO_RATE_BPS bps"
    echo "plan only. No transactions sent."
    exit 0
fi

if [ ! -s "$CANONICAL_BASELINE" ]; then
    write_cash_baseline "$CANONICAL_BASELINE" "$DISTRIBUTOR"
fi

ensure_associated canonical-associate-seller "$SELLER_ADDRESS" "$SELLER_PRIVATE_KEY"
ensure_associated canonical-associate-buyer "$BUYER_ADDRESS" "$BUYER_PRIVATE_KEY"

if [ "$CANONICAL_DECLARED" = "0" ]; then
    fund_to_total canonical-fund "$DISTRIBUTOR" "$CANONICAL_TOTAL"
    send_once canonical-declare "$HEDERA_PRIVATE_KEY" "$DISTRIBUTOR" \
        "declare(uint256,uint64,bytes32,uint32,uint256)" \
        0 "$CANONICAL_RECORD" "$CANONICAL_ROOT" "$CANONICAL_WIDTH" "$CANONICAL_TOTAL"
fi

assert_address "canonical declaration root" \
    "$(declaration_field "$DISTRIBUTOR" 0)" "$CANONICAL_ROOT"
[ "$(declaration_field "$DISTRIBUTOR" 1)" = "$CANONICAL_RECORD" ] &&
[ "$(declaration_field "$DISTRIBUTOR" 3)" = "$CANONICAL_WIDTH" ] &&
[ "$(declaration_field "$DISTRIBUTOR" 4)" = "$CANONICAL_TOTAL" ] || {
    echo "canonical declaration does not match the reconstructed entitlement" >&2
    exit 1
}

for row in 0 1; do
    HOLDER=$(field "$CANONICAL_ENTITLEMENTS" "holders.$row.holder")
    POSITION=$(field "$CANONICAL_ENTITLEMENTS" "holders.$row.position")
    AMOUNT=$(field "$CANONICAL_ENTITLEMENTS" "holders.$row.amount")
    PROOF=$(field "$CANONICAL_ENTITLEMENTS" "holders.$row.proof")
    [ "$(call "$DISTRIBUTOR" \
        "wouldAccept(uint256,address,uint256,uint256,bytes32[])(bool)" \
        0 "$HOLDER" "$POSITION" "$AMOUNT" "$PROOF" | n)" = "true" ] || {
        if [ "$(call "$DISTRIBUTOR" "claimed(uint256,address)(bool)" 0 "$HOLDER" | n)" != "true" ]; then
            echo "canonical proof is not accepted for $HOLDER" >&2
            exit 1
        fi
    }
done

if [ "$(call "$DISTRIBUTOR" "claimed(uint256,address)(bool)" 0 "$SELLER_ADDRESS" | n)" != "true" ]; then
    send_once canonical-claim-seller "$SELLER_PRIVATE_KEY" "$DISTRIBUTOR" \
        "claim(uint256,address,uint256,uint256,bytes32[])" \
        0 "$SELLER_ADDRESS" \
        "$(field "$CANONICAL_ENTITLEMENTS" holders.0.position)" \
        "$(field "$CANONICAL_ENTITLEMENTS" holders.0.amount)" \
        "$(field "$CANONICAL_ENTITLEMENTS" holders.0.proof)"
fi
if [ "$(call "$DISTRIBUTOR" "claimed(uint256,address)(bool)" 0 "$BUYER_ADDRESS" | n)" != "true" ]; then
    send_once canonical-claim-buyer "$BUYER_PRIVATE_KEY" "$DISTRIBUTOR" \
        "claim(uint256,address,uint256,uint256,bytes32[])" \
        0 "$BUYER_ADDRESS" \
        "$(field "$CANONICAL_ENTITLEMENTS" holders.1.position)" \
        "$(field "$CANONICAL_ENTITLEMENTS" holders.1.amount)" \
        "$(field "$CANONICAL_ENTITLEMENTS" holders.1.proof)"
fi

CANONICAL_REMAINING=$(call "$DISTRIBUTOR" "remainingOf(uint256)(uint256)" 0 | n)
CANONICAL_COMMITTED=$(call "$DISTRIBUTOR" "committed()(uint256)" | n)
CANONICAL_SELLER_CLAIMED=$(call "$DISTRIBUTOR" "claimed(uint256,address)(bool)" 0 "$SELLER_ADDRESS" | n)
CANONICAL_BUYER_CLAIMED=$(call "$DISTRIBUTOR" "claimed(uint256,address)(bool)" 0 "$BUYER_ADDRESS" | n)
CANONICAL_ISSUER_FINAL=$(call "$CASH" "balanceOf(address)(uint256)" "$ISSUER" | n)
CANONICAL_SELLER_FINAL=$(call "$CASH" "balanceOf(address)(uint256)" "$SELLER_ADDRESS" | n)
CANONICAL_BUYER_FINAL=$(call "$CASH" "balanceOf(address)(uint256)" "$BUYER_ADDRESS" | n)
CANONICAL_DISTRIBUTOR_FINAL=$(call "$CASH" "balanceOf(address)(uint256)" "$DISTRIBUTOR" | n)
CANONICAL_DECLARED_AT=$(declaration_field "$DISTRIBUTOR" 2)
CANONICAL_CLOSES_AT=$(call "$DISTRIBUTOR" "claimsCloseAt(uint256)(uint64)" 0 | n)

python3 - "$CANONICAL_BASELINE" <<PY
import json, sys
b = json.load(open(sys.argv[1]))["cash"]
seller_amount, buyer_amount = 171, 57
seller_fee = max(1, seller_amount * 25 // 10_000)
buyer_fee = max(1, buyer_amount * 25 // 10_000)
assert int("$CANONICAL_REMAINING") == 0
assert int("$CANONICAL_COMMITTED") == 0
assert "$CANONICAL_SELLER_CLAIMED" == "true"
assert "$CANONICAL_BUYER_CLAIMED" == "true"
assert int("$CANONICAL_SELLER_FINAL") == int(b["seller"]) + seller_amount - seller_fee
assert int("$CANONICAL_BUYER_FINAL") == int(b["buyer"]) + buyer_amount - buyer_fee
assert int("$CANONICAL_ISSUER_FINAL") == int(b["issuer"]) - 228 + seller_fee + buyer_fee
assert int("$CANONICAL_DISTRIBUTOR_FINAL") == int(b["distributor"])
PY

ISSUER_FINAL="$CANONICAL_ISSUER_FINAL" \
SELLER_FINAL="$CANONICAL_SELLER_FINAL" \
BUYER_FINAL="$CANONICAL_BUYER_FINAL" \
DISTRIBUTOR_FINAL="$CANONICAL_DISTRIBUTOR_FINAL" \
DECLARED_AT="$CANONICAL_DECLARED_AT" \
CLOSES_AT="$CANONICAL_CLOSES_AT" \
    python3 - "$CANONICAL_FINAL" <<'PY'
import json, os, pathlib, sys
record = {
    "cash": {
        "issuer": os.environ["ISSUER_FINAL"],
        "seller": os.environ["SELLER_FINAL"],
        "buyer": os.environ["BUYER_FINAL"],
        "distributor": os.environ["DISTRIBUTOR_FINAL"],
    },
    "declaration": {
        "declaredAt": os.environ["DECLARED_AT"],
        "claimsCloseAt": os.environ["CLOSES_AT"],
        "remaining": "0",
        "committed": "0",
        "sellerClaimed": True,
        "buyerClaimed": True,
    },
}
pathlib.Path(sys.argv[1]).write_text(json.dumps(record, indent=2) + "\n")
PY

RPC_URL="$RPC" python3 - "$WORK" "$CANONICAL_OUT" "$DEPLOYMENT" <<'PY'
import datetime
import json
import os
import pathlib
import sys
import urllib.request

work, output, deployment_path = map(pathlib.Path, sys.argv[1:])
deployment = json.loads(deployment_path.read_text())
entitlement = json.loads((work / "canonical-entitlements.json").read_text())
baseline = json.loads((work / "canonical-baseline.json").read_text())
final = json.loads((work / "canonical-final.json").read_text())
block_cache = {}

def block_time(raw):
    raw_number = raw["blockNumber"]
    number = int(raw_number, 16) if isinstance(raw_number, str) else int(raw_number)
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
            headers={"content-type": "application/json", "user-agent": "curl/8.7.1"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            block_cache[number] = int(json.load(response)["result"]["timestamp"], 16)
    timestamp = block_cache[number]
    when = datetime.datetime.fromtimestamp(
        timestamp, datetime.timezone.utc
    ).replace(microsecond=0).isoformat()
    return number, timestamp, when

receipts = {}
for path in sorted(work.glob("canonical-*.json")):
    raw = json.loads(path.read_text())
    if "transactionHash" not in raw:
        continue
    block, timestamp, when = block_time(raw)
    gas = raw.get("gasUsed", "0x0")
    tx = raw["transactionHash"]
    receipts[path.stem.removeprefix("canonical-")] = {
        "tx": tx,
        "status": str(raw.get("status", "")),
        "gasUsed": str(int(gas, 16) if isinstance(gas, str) else gas),
        "block": block,
        "blockTimestamp": timestamp,
        "blockTime": when,
        "hashscan": f"https://hashscan.io/testnet/transaction/{tx}",
    }

record = {
    "schema": "lattice.bond.coupon-zero.v1",
    "checkedAt": datetime.datetime.now(datetime.timezone.utc).replace(
        microsecond=0
    ).isoformat(),
    "status": "complete",
    "network": "hedera-testnet",
    "canonical": True,
    "bond": {
        "address": deployment["token"]["address"],
        "contractId": deployment["token"]["contractId"],
        "maturity": "1851703584",
    },
    "coupon": {
        "schedule": deployment["coupon"]["CouponSchedule"],
        "scheduleContractId": deployment["coupon"]["contractIds"]["CouponSchedule"],
        "distributor": deployment["coupon"]["CouponDistributor"],
        "distributorContractId": deployment["coupon"]["contractIds"]["CouponDistributor"],
        "index": 0,
        "dueAt": entitlement["dueAt"],
        "recordDate": entitlement["recordDate"],
        "declaredAt": final["declaration"]["declaredAt"],
        "lateBySeconds": str(
            int(final["declaration"]["declaredAt"]) - int(entitlement["dueAt"])
        ),
        "claimsCloseAt": final["declaration"]["claimsCloseAt"],
    },
    "entitlement": entitlement,
    "cash": {
        "address": deployment["coupon"]["cashToken"]["address"],
        "tokenId": deployment["coupon"]["cashToken"]["tokenId"],
        "decimals": deployment["coupon"]["cashToken"]["decimals"],
        "fractionalFee": deployment["coupon"]["cashToken"]["fee"],
        "gross": entitlement["total"],
        "feeSmallestUnits": "2",
        "netToHolders": "226",
        "before": baseline["cash"],
        "after": final["cash"],
    },
    "receipts": receipts,
    "assertions": {
        "canonicalBondUnchanged": True,
        "recordDateSupplyReconciled": True,
        "historicalFixingPrecedesDue": True,
        "heldUnitsIncluded": True,
        "declarationFullyFunded": True,
        "bothProofsAccepted": True,
        "bothHoldersClaimed": True,
        "inclusiveHtsFeesReconciled": True,
        "remainingAndCommittedZero": True,
    },
}
output.write_text(json.dumps(record, indent=2) + "\n")
print(f"wrote {output}")
PY

if [ -f "$DEMO_OUT" ] && [ "$(field "$DEMO_OUT" status 2>/dev/null || true)" = "complete" ]; then
    echo "compressed lifecycle already complete: $DEMO_OUT"
    exit 0
fi

export ZK_KYC_REGISTRY="$REGISTRY"
export VENUE_PARAMS="$POLICY"
export CASH_TOKEN="$CASH"

if [ ! -s "$DEMO_DEPLOYMENT" ]; then
    SOURCE="broadcast/DeployBondLifecycleDemo.s.sol/$CHAIN_ID/run-latest.json"
    BROADCAST_CHECKPOINT="$WORK/demo-broadcast.json"
    if [ ! -s "$BROADCAST_CHECKPOINT" ]; then
        forge script script/DeployBondLifecycleDemo.s.sol:DeployBondLifecycleDemo \
            --rpc-url "$RPC" --broadcast --slow --legacy
        python3 - "$SOURCE" "$BROADCAST_CHECKPOINT" <<'PY'
import json, pathlib, sys
source, output = map(pathlib.Path, sys.argv[1:])
run = json.loads(source.read_text())
transactions = run.get("transactions", [])
if len(transactions) != 3 or not all(item.get("hash") for item in transactions):
    raise SystemExit("Foundry output does not contain three live transaction hashes")
output.write_text(json.dumps(run, indent=2) + "\n")
PY
    fi
    python3 - "$BROADCAST_CHECKPOINT" "$DEMO_DEPLOYMENT" <<'PY'
import datetime
import json
import os
import pathlib
import sys
import urllib.request

source, output = map(pathlib.Path, sys.argv[1:])
run = json.loads(source.read_text())
receipt_by_hash = {
    item["transactionHash"].lower(): item
    for item in run.get("receipts", [])
}

def receipt_for(tx):
    raw = receipt_by_hash[tx["hash"].lower()]
    block = int(raw["blockNumber"], 16)
    raw_timestamp = raw.get("blockTimestamp")
    if raw_timestamp is None and raw.get("logs"):
        raw_timestamp = raw["logs"][0].get("blockTimestamp")
    if raw_timestamp is None:
        body = json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_getBlockByNumber",
            "params": [hex(block), False],
        }).encode()
        request = urllib.request.Request(
            os.environ["HEDERA_TESTNET_RPC"],
            data=body,
            headers={"content-type": "application/json", "user-agent": "curl/8.7.1"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            raw_timestamp = json.load(response)["result"]["timestamp"]
    timestamp = int(raw_timestamp, 16)
    gas = int(raw.get("gasUsed", "0x0"), 16)
    when = datetime.datetime.fromtimestamp(
        timestamp, datetime.timezone.utc
    ).replace(microsecond=0).isoformat()
    return {
        "tx": tx["hash"],
        "status": raw["status"],
        "gasUsed": str(gas),
        "block": block,
        "blockTimestamp": timestamp,
        "blockTime": when,
        "hashscan": f"https://hashscan.io/testnet/transaction/{tx['hash']}",
    }

factory_tx = next(
    tx for tx in run["transactions"]
    if str(tx.get("function", "")).startswith("deployBond(")
)
additional = factory_tx.get("additionalContracts", [])
if len(additional) != 1:
    raise SystemExit(f"factory receipt exposed {len(additional)} created contracts, want 1")
bond = additional[0]["address"]
creates = {
    tx["contractName"]: tx
    for tx in run["transactions"]
    if tx.get("transactionType") == "CREATE"
}
schedule = creates["CouponSchedule"]
distributor = creates["CouponDistributor"]
record = {
    "schema": "lattice.bond.lifecycle-deployment.v1",
    "checkedAt": datetime.datetime.now(datetime.timezone.utc).replace(
        microsecond=0
    ).isoformat(),
    "productionBinding": False,
    "contracts": {
        "Bond": {"address": bond},
        "CouponSchedule": {"address": schedule["contractAddress"]},
        "CouponDistributor": {"address": distributor["contractAddress"]},
    },
    "receipts": {
        "deployBond": receipt_for(factory_tx),
        "deployCouponSchedule": receipt_for(schedule),
        "deployCouponDistributor": receipt_for(distributor),
    },
}
output.write_text(json.dumps(record, indent=2) + "\n")
PY
fi

DEMO_BOND=$(field "$DEMO_DEPLOYMENT" contracts.Bond.address)
DEMO_SCHEDULE=$(field "$DEMO_DEPLOYMENT" contracts.CouponSchedule.address)
DEMO_DISTRIBUTOR=$(field "$DEMO_DEPLOYMENT" contracts.CouponDistributor.address)
assert_code "demo bond" "$DEMO_BOND"
assert_code "demo coupon schedule" "$DEMO_SCHEDULE"
assert_code "demo coupon distributor" "$DEMO_DISTRIBUTOR"

DEMO_BOND_ID=$(contract_id "$DEMO_BOND")
DEMO_SCHEDULE_ID=$(contract_id "$DEMO_SCHEDULE")
DEMO_DISTRIBUTOR_ID=$(contract_id "$DEMO_DISTRIBUTOR")
DEMO_ISSUED_AT=$(call "$DEMO_SCHEDULE" "issuedAt()(uint64)" | n)
DEMO_DUE=$(call "$DEMO_SCHEDULE" "dateOf(uint256)(uint64)" 0 | n)
DEMO_RECORD=$((DEMO_DUE - DEMO_RECORD_LEAD))
DEMO_MATURITY=$(call "$DEMO_BOND" "getMaturityDate()(uint256)" | n)

BOND_ID="$DEMO_BOND_ID" \
SCHEDULE_ID="$DEMO_SCHEDULE_ID" \
DISTRIBUTOR_ID="$DEMO_DISTRIBUTOR_ID" \
ISSUED_AT="$DEMO_ISSUED_AT" \
RECORD_DATE="$DEMO_RECORD" \
DUE_AT="$DEMO_DUE" \
MATURITY="$DEMO_MATURITY" \
    python3 - "$DEMO_DEPLOYMENT" <<'PY'
import json, os, pathlib, sys
path = pathlib.Path(sys.argv[1])
record = json.loads(path.read_text())
record["contracts"]["Bond"]["contractId"] = os.environ["BOND_ID"]
record["contracts"]["CouponSchedule"]["contractId"] = os.environ["SCHEDULE_ID"]
record["contracts"]["CouponDistributor"]["contractId"] = os.environ["DISTRIBUTOR_ID"]
record["terms"] = {
    "issuedAt": os.environ["ISSUED_AT"],
    "recordDate": os.environ["RECORD_DATE"],
    "dueAt": os.environ["DUE_AT"],
    "maturity": os.environ["MATURITY"],
    "couponRateBps": "500",
    "referenceRateBps": "425",
    "spreadBps": "75",
    "faceValueSmallestCashUnits": "10000",
    "claimWindowSeconds": "2592000",
}
path.write_text(json.dumps(record, indent=2) + "\n")
PY

CORPORATE_ROLE=0xa1acfc499025c99f55059195e6276f639d34a18aad7b8121b9192b7f438c55cd
MATURITY_ROLE=0x433f48f8aca23480f6ab07666cbc9131d32a0b4672033453f65e18f4dd390523
[ "$(call "$DEMO_BOND" "hasRole(bytes32,address)(bool)" "$CORPORATE_ROLE" "$ISSUER" | n)" = "true" ] &&
[ "$(call "$DEMO_BOND" "hasRole(bytes32,address)(bool)" "$MATURITY_ROLE" "$ISSUER" | n)" = "true" ] || {
    echo "demo issuer is missing an ATS lifecycle role" >&2
    exit 1
}
[ "$(call "$REGISTRY" "getKycStatus(address)(uint8)" "$BUYER_ADDRESS" | n)" = "1" ] || {
    echo "demo holder does not have current KYC" >&2
    exit 1
}
assert_address "demo distributor schedule" \
    "$(call "$DEMO_DISTRIBUTOR" "schedule()(address)" | n)" "$DEMO_SCHEDULE"
assert_address "demo distributor cash" \
    "$(call "$DEMO_DISTRIBUTOR" "cash()(address)" | n)" "$CASH"

if [ ! -s "$DEMO_BASELINE" ]; then
    write_cash_baseline "$DEMO_BASELINE" "$DEMO_DISTRIBUTOR"
    DEMO_SUPPLY_BEFORE=$(call "$DEMO_BOND" "totalSupply()(uint256)" | n)
    DEMO_HOLDER_BEFORE=$(call "$DEMO_BOND" "balanceOf(address)(uint256)" "$BUYER_ADDRESS" | n)
    python3 - "$DEMO_BASELINE" "$DEMO_SUPPLY_BEFORE" "$DEMO_HOLDER_BEFORE" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
record = json.loads(path.read_text())
record["bond"] = {"supply": sys.argv[2], "holder": sys.argv[3]}
path.write_text(json.dumps(record, indent=2) + "\n")
PY
fi

DEMO_SUPPLY=$(call "$DEMO_BOND" "totalSupply()(uint256)" | n)
if [ "$DEMO_SUPPLY" = "0" ]; then
    NOW=$(chain_now)
    if [ "$NOW" -ge "$DEMO_RECORD" ]; then
        echo "demo record date arrived before issuance; deploy a fresh demo" >&2
        exit 1
    fi
    send_once demo-issue "$HEDERA_PRIVATE_KEY" "$DEMO_BOND" \
        "issue(address,uint256,bytes)" "$BUYER_ADDRESS" "$DEMO_LOT" 0x
fi
[ "$(call "$DEMO_BOND" "totalSupply()(uint256)" | n)" = "$DEMO_LOT" ] &&
[ "$(call "$DEMO_BOND" "balanceOf(address)(uint256)" "$BUYER_ADDRESS" | n)" = "$DEMO_LOT" ] || {
    echo "demo issuance did not produce the expected supply" >&2
    exit 1
}

DEMO_COUPON_COUNT=$(call "$DEMO_BOND" "getCouponCount()(uint256)" | n)
if [ "$DEMO_COUPON_COUNT" = "0" ]; then
    NOW=$(chain_now)
    if [ "$NOW" -ge "$DEMO_RECORD" ]; then
        echo "demo record date arrived before coupon registration; deploy a fresh demo" >&2
        exit 1
    fi
    DEMO_COUPON="($DEMO_RECORD,$DEMO_DUE,$DEMO_ISSUED_AT,$DEMO_DUE,$DEMO_RECORD,$DEMO_RATE_BPS,4,1)"
    send_once demo-set-coupon "$HEDERA_PRIVATE_KEY" "$DEMO_BOND" \
        "setCoupon((uint256,uint256,uint256,uint256,uint256,uint256,uint8,uint8))" \
        "$DEMO_COUPON"
fi
[ "$(call "$DEMO_BOND" "getCouponCount()(uint256)" | n)" = "1" ] || {
    echo "demo ATS coupon was not registered" >&2
    exit 1
}

wait_until "$((DEMO_RECORD + 1))" "ATS coupon record date"
if [ "$(coupon_snapshot_id "$DEMO_BOND")" = "0" ]; then
    send_once demo-trigger-snapshot "$HEDERA_PRIVATE_KEY" "$DEMO_BOND" \
        "triggerScheduledCrossOrderedTasks(uint256)" 0
fi
DEMO_SNAPSHOT=$(coupon_snapshot_id "$DEMO_BOND")
[ "$DEMO_SNAPSHOT" != "0" ] || {
    echo "ATS coupon snapshot was not materialized" >&2
    exit 1
}

export DEMO_ATS_TOKEN="$DEMO_BOND"
export DEMO_COUPON_SCHEDULE="$DEMO_SCHEDULE"
export DEMO_COUPON_DISTRIBUTOR="$DEMO_DISTRIBUTOR"
export DEMO_REFERENCE_RATE_BPS
node tools/bond-coupon-entitlements.mjs ats "$DEMO_ENTITLEMENTS"

[ "$(field "$DEMO_ENTITLEMENTS" snapshotId)" = "$DEMO_SNAPSHOT" ] &&
[ "$(field "$DEMO_ENTITLEMENTS" width)" = "1" ] &&
[ "$(field "$DEMO_ENTITLEMENTS" holders.0.tokenBalance)" = "$DEMO_LOT" ] || {
    echo "demo ATS snapshot does not carry the issued holder balance" >&2
    exit 1
}

wait_until "$DEMO_DUE" "compressed coupon due"
ensure_associated demo-associate-buyer "$BUYER_ADDRESS" "$BUYER_PRIVATE_KEY"
DEMO_TOTAL=$(field "$DEMO_ENTITLEMENTS" total)
DEMO_ROOT=$(field "$DEMO_ENTITLEMENTS" root)
DEMO_WIDTH=$(field "$DEMO_ENTITLEMENTS" width)

DEMO_DECLARED=$(declaration_field "$DEMO_DISTRIBUTOR" 2)
if [ "$DEMO_DECLARED" = "0" ]; then
    [ "$(call "$DEMO_DISTRIBUTOR" "wouldDisclose(uint16,uint8,uint8)(bool)" 7 4 1 | n)" = "true" ] &&
    [ "$(call "$DEMO_DISTRIBUTOR" "wouldAfford(uint16,uint8)(bool)" 7 4 | n)" = "true" ] || {
        echo "demo coupon declaration is blocked by disclosure policy" >&2
        exit 1
    }
    fund_to_total demo-fund "$DEMO_DISTRIBUTOR" "$DEMO_TOTAL"
    send_once demo-declare "$HEDERA_PRIVATE_KEY" "$DEMO_DISTRIBUTOR" \
        "declare(uint256,uint64,bytes32,uint32,uint256)" \
        0 "$DEMO_RECORD" "$DEMO_ROOT" "$DEMO_WIDTH" "$DEMO_TOTAL"
fi
assert_address "demo declaration root" \
    "$(declaration_field "$DEMO_DISTRIBUTOR" 0)" "$DEMO_ROOT"

DEMO_PROOF=$(field "$DEMO_ENTITLEMENTS" holders.0.proof)
DEMO_POSITION=$(field "$DEMO_ENTITLEMENTS" holders.0.position)
DEMO_AMOUNT=$(field "$DEMO_ENTITLEMENTS" holders.0.amount)
if [ "$(call "$DEMO_DISTRIBUTOR" "claimed(uint256,address)(bool)" 0 "$BUYER_ADDRESS" | n)" != "true" ]; then
    [ "$(call "$DEMO_DISTRIBUTOR" \
        "wouldAccept(uint256,address,uint256,uint256,bytes32[])(bool)" \
        0 "$BUYER_ADDRESS" "$DEMO_POSITION" "$DEMO_AMOUNT" "$DEMO_PROOF" | n)" = "true" ] || {
        echo "demo coupon proof is not accepted" >&2
        exit 1
    }
    send_once demo-claim "$BUYER_PRIVATE_KEY" "$DEMO_DISTRIBUTOR" \
        "claim(uint256,address,uint256,uint256,bytes32[])" \
        0 "$BUYER_ADDRESS" "$DEMO_POSITION" "$DEMO_AMOUNT" "$DEMO_PROOF"
fi

[ "$(call "$DEMO_DISTRIBUTOR" "remainingOf(uint256)(uint256)" 0 | n)" = "0" ] &&
[ "$(call "$DEMO_DISTRIBUTOR" "committed()(uint256)" | n)" = "0" ] || {
    echo "demo coupon did not fully settle" >&2
    exit 1
}

wait_until "$DEMO_MATURITY" "compressed ATS bond maturity"
if [ "$(call "$DEMO_BOND" "totalSupply()(uint256)" | n)" != "0" ]; then
    [ "$(call "$REGISTRY" "getKycStatus(address)(uint8)" "$BUYER_ADDRESS" | n)" = "1" ] || {
        echo "demo holder KYC expired before maturity redemption" >&2
        exit 1
    }
    send_once demo-redeem-at-maturity "$HEDERA_PRIVATE_KEY" "$DEMO_BOND" \
        "fullRedeemAtMaturity(address)" "$BUYER_ADDRESS"
fi

DEMO_SUPPLY_FINAL=$(call "$DEMO_BOND" "totalSupply()(uint256)" | n)
DEMO_HOLDER_FINAL=$(call "$DEMO_BOND" "balanceOf(address)(uint256)" "$BUYER_ADDRESS" | n)
DEMO_ISSUER_CASH_FINAL=$(call "$CASH" "balanceOf(address)(uint256)" "$ISSUER" | n)
DEMO_BUYER_CASH_FINAL=$(call "$CASH" "balanceOf(address)(uint256)" "$BUYER_ADDRESS" | n)
DEMO_DISTRIBUTOR_CASH_FINAL=$(call "$CASH" "balanceOf(address)(uint256)" "$DEMO_DISTRIBUTOR" | n)
DEMO_DECLARED_AT=$(declaration_field "$DEMO_DISTRIBUTOR" 2)

python3 - "$DEMO_BASELINE" <<PY
import json, sys
b = json.load(open(sys.argv[1]))
amount = int("$DEMO_AMOUNT")
fee = max(1, amount * 25 // 10_000)
assert int(b["bond"]["supply"]) == 0
assert int(b["bond"]["holder"]) == 0
assert int("$DEMO_SUPPLY_FINAL") == 0
assert int("$DEMO_HOLDER_FINAL") == 0
assert int("$DEMO_BUYER_CASH_FINAL") == int(b["cash"]["buyer"]) + amount - fee
assert int("$DEMO_ISSUER_CASH_FINAL") == int(b["cash"]["issuer"]) - amount + fee
assert int("$DEMO_DISTRIBUTOR_CASH_FINAL") == int(b["cash"]["distributor"])
PY

ISSUER_FINAL="$DEMO_ISSUER_CASH_FINAL" \
BUYER_FINAL="$DEMO_BUYER_CASH_FINAL" \
DISTRIBUTOR_FINAL="$DEMO_DISTRIBUTOR_CASH_FINAL" \
SUPPLY_FINAL="$DEMO_SUPPLY_FINAL" \
HOLDER_FINAL="$DEMO_HOLDER_FINAL" \
DECLARED_AT="$DEMO_DECLARED_AT" \
    python3 - "$DEMO_FINAL" <<'PY'
import json, os, pathlib, sys
record = {
    "cash": {
        "issuer": os.environ["ISSUER_FINAL"],
        "buyer": os.environ["BUYER_FINAL"],
        "distributor": os.environ["DISTRIBUTOR_FINAL"],
    },
    "bond": {
        "supply": os.environ["SUPPLY_FINAL"],
        "holder": os.environ["HOLDER_FINAL"],
    },
    "declaredAt": os.environ["DECLARED_AT"],
}
pathlib.Path(sys.argv[1]).write_text(json.dumps(record, indent=2) + "\n")
PY

RPC_URL="$RPC" python3 - "$WORK" "$DEMO_OUT" "$DEPLOYMENT" <<'PY'
import datetime
import json
import os
import pathlib
import sys
import urllib.request

work, output, deployment_path = map(pathlib.Path, sys.argv[1:])
canonical = json.loads(deployment_path.read_text())
deployment = json.loads((work / "demo-deployment.json").read_text())
entitlement = json.loads((work / "demo-entitlements.json").read_text())
baseline = json.loads((work / "demo-baseline.json").read_text())
final = json.loads((work / "demo-final.json").read_text())
block_cache = {}

def block_time(raw):
    raw_number = raw["blockNumber"]
    number = int(raw_number, 16) if isinstance(raw_number, str) else int(raw_number)
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
            headers={"content-type": "application/json", "user-agent": "curl/8.7.1"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            block_cache[number] = int(json.load(response)["result"]["timestamp"], 16)
    timestamp = block_cache[number]
    when = datetime.datetime.fromtimestamp(
        timestamp, datetime.timezone.utc
    ).replace(microsecond=0).isoformat()
    return number, timestamp, when

receipts = dict(deployment["receipts"])
for path in sorted(work.glob("demo-*.json")):
    raw = json.loads(path.read_text())
    if "transactionHash" not in raw:
        continue
    block, timestamp, when = block_time(raw)
    gas = raw.get("gasUsed", "0x0")
    tx = raw["transactionHash"]
    receipts[path.stem.removeprefix("demo-")] = {
        "tx": tx,
        "status": str(raw.get("status", "")),
        "gasUsed": str(int(gas, 16) if isinstance(gas, str) else gas),
        "block": block,
        "blockTimestamp": timestamp,
        "blockTime": when,
        "hashscan": f"https://hashscan.io/testnet/transaction/{tx}",
    }

amount = int(entitlement["total"])
fee = max(1, amount * 25 // 10_000)
record = {
    "schema": "lattice.bond.lifecycle.v1",
    "checkedAt": datetime.datetime.now(datetime.timezone.utc).replace(
        microsecond=0
    ).isoformat(),
    "status": "complete",
    "network": "hedera-testnet",
    "productionBinding": False,
    "canonicalBondUnchanged": canonical["token"]["address"],
    "deployment": deployment,
    "actors": {
        "issuer": canonical["deployer"],
        "holder": entitlement["holders"][0]["holder"],
    },
    "issuance": {
        "amount": entitlement["holders"][0]["tokenBalance"],
        "supplyBefore": baseline["bond"]["supply"],
        "holderBefore": baseline["bond"]["holder"],
        "supplyAfterIssue": entitlement["supplyAtSnapshotRead"],
    },
    "coupon": {
        "atsCouponId": entitlement["atsCouponId"],
        "distributorIndex": entitlement["index"],
        "snapshotId": entitlement["snapshotId"],
        "terms": entitlement["coupon"],
        "referenceRateBps": entitlement["referenceRateBps"],
        "spreadBps": deployment["terms"]["spreadBps"],
        "root": entitlement["root"],
        "grossSmallestCashUnits": entitlement["total"],
        "feeSmallestCashUnits": str(fee),
        "netSmallestCashUnits": str(amount - fee),
        "declaredAt": final["declaredAt"],
        "entitlement": entitlement,
    },
    "cash": {
        "address": canonical["coupon"]["cashToken"]["address"],
        "tokenId": canonical["coupon"]["cashToken"]["tokenId"],
        "before": baseline["cash"],
        "after": final["cash"],
    },
    "redemption": {
        "maturity": deployment["terms"]["maturity"],
        "redeemed": entitlement["holders"][0]["tokenBalance"],
        "supplyAfter": final["bond"]["supply"],
        "holderAfter": final["bond"]["holder"],
    },
    "receipts": receipts,
    "assertions": {
        "publishedAtsFactoryUsed": True,
        "productionBindingUnchanged": True,
        "lifecycleRolesAssigned": True,
        "eligibleHolderIssued": True,
        "atsCouponRegisteredBeforeRecordDate": True,
        "recordDateSnapshotMaterialized": True,
        "atsAndScheduleAmountsAgree": True,
        "couponFullyFunded": True,
        "couponClaimedInLpcash": True,
        "maturityReachedBeforeRedemption": True,
        "fullSupplyRedeemed": True,
        "holderAndSupplyZero": True,
    },
}
output.write_text(json.dumps(record, indent=2) + "\n")
print(f"wrote {output}")
PY

echo "canonical coupon evidence  $CANONICAL_OUT"
echo "compressed bond evidence   $DEMO_OUT"
