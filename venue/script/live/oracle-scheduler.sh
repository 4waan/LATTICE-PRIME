#!/usr/bin/env bash
# Deploy, fund, arm, decommission, or inspect the PrimeOracle HSS scheduler.
# DeployOracleScheduler reads its key from the protected root environment. All
# other write modes use a Foundry keystore or Foundry's interactive stdin prompt,
# so raw private keys never enter a process argument list.
set -euo pipefail
cd "$(dirname "$0")/../.."

MODE="${1:-status}"
FUND_HBAR="${2:-50}"
REQUESTED_ORACLE="${PRIME_ORACLE:-}"
REQUESTED_SCHEDULER="${ORACLE_SCHEDULER:-}"

case "$MODE" in
    status|deploy|fund|arm|tick|withdraw) ;;
    *)
        echo "usage: $0 [status|deploy|fund|arm|tick|withdraw] [fund-hbar]" >&2
        exit 1
        ;;
esac

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

clear_raw_signing_secrets() {
    unset HEDERA_PRIVATE_KEY HEDERA_MNEMONIC HEDERA_OPERATOR_KEY \
        ORACLE_PUBLISHER_PRIVATE_KEY SELLER_PRIVATE_KEY BUYER_PRIVATE_KEY \
        BOT_PRIVATE_KEY DEALER_QUOTE_PRIVATE_KEY || true
}

ROOT_ENV="../.env"
require_private_file "$ROOT_ENV"
set -a
. "$ROOT_ENV"
set +a
if [ "$MODE" != "deploy" ]; then
    clear_raw_signing_secrets
fi

RPC="${HEDERA_TESTNET_RPC:?set HEDERA_TESTNET_RPC}"
MIRROR="${HEDERA_MIRROR_URL:-https://testnet.mirrornode.hedera.com}"
EXPECTED_CHAIN_ID=296
CLIENT_ORACLE="$(python3 -c \
    "import json; print(json.load(open('deployments/client.json'))['addresses']['PrimeOracle'])")"
ORACLE="${REQUESTED_ORACLE:-$CLIENT_ORACLE}"
if [ "$(printf '%s' "$ORACLE" | tr '[:upper:]' '[:lower:]')" != \
    "$(printf '%s' "$CLIENT_ORACLE" | tr '[:upper:]' '[:lower:]')" ]; then
    echo "Refusing scheduler target $ORACLE; current PrimeOracle is $CLIENT_ORACLE." >&2
    exit 1
fi
RECORD="deployments/oracle-scheduler.json"
SCHEDULER="$REQUESTED_SCHEDULER"
if [ -z "$SCHEDULER" ] && [ -f "$RECORD" ]; then
    SCHEDULER="$(python3 -c "import json; print(json.load(open('$RECORD'))['address'])")"
fi

CHAIN_ID="$(cast chain-id --rpc-url "$RPC" | tr -d '[:space:]')"
if [ "$CHAIN_ID" != "$EXPECTED_CHAIN_ID" ]; then
    echo "Refusing chain $CHAIN_ID; expected Hedera testnet chain $EXPECTED_CHAIN_ID." >&2
    exit 1
fi

contract_id() {
    local address="$1" body id
    for _ in $(seq 1 30); do
        body="$(curl --silent --show-error --connect-timeout 15 \
            "$MIRROR/api/v1/contracts/$address" || true)"
        id="$(printf '%s' "$body" | python3 -c \
            'import json,sys
try: print(json.load(sys.stdin).get("contract_id", ""))
except Exception: print("")')"
        if [ -n "$id" ]; then
            printf '%s\n' "$id"
            return 0
        fi
        sleep 3
    done
    echo "mirror node did not index contract $address" >&2
    return 1
}

if [ "$MODE" = "deploy" ]; then
    : "${HEDERA_PRIVATE_KEY:?set HEDERA_PRIVATE_KEY in the protected root environment}"
    : "${HEDERA_EVM_ADDRESS:?set HEDERA_EVM_ADDRESS}"
    export PRIME_ORACLE="$ORACLE"
    forge script script/DeployOracleScheduler.s.sol:DeployOracleScheduler \
        --rpc-url "$RPC" --broadcast --legacy
    clear_raw_signing_secrets

    LATEST="broadcast/DeployOracleScheduler.s.sol/296/run-latest.json"
    DEPLOYMENT_ROW="$(python3 - "$LATEST" <<'PY'
import json
import sys

data = json.load(open(sys.argv[1]))
creates = [
    row for row in data["transactions"]
    if row.get("transactionType") == "CREATE"
]
if len(creates) != 1:
    raise SystemExit(f"expected one CREATE, found {len(creates)}")
row = creates[0]
print(row["contractAddress"], row["hash"], sep="\t")
PY
)"
    IFS=$'\t' read -r DEPLOYED DEPLOY_TRANSACTION_HASH <<<"$DEPLOYMENT_ROW"

    RUNTIME_CODE=""
    for _ in $(seq 1 30); do
        RUNTIME_CODE="$(cast code "$DEPLOYED" --rpc-url "$RPC" 2>/dev/null || true)"
        if [ -n "$RUNTIME_CODE" ] && [ "$RUNTIME_CODE" != "0x" ]; then
            break
        fi
        sleep 2
    done
    if [ -z "$RUNTIME_CODE" ] || [ "$RUNTIME_CODE" = "0x" ]; then
        echo "deployed scheduler has no runtime code at $DEPLOYED" >&2
        exit 1
    fi

    CONTRACT_ID="$(contract_id "$DEPLOYED")"
    BOUND_ORACLE="$(cast call "$DEPLOYED" 'oracle()(address)' --rpc-url "$RPC")"
    BOUND_TREASURY="$(cast call "$DEPLOYED" 'treasury()(address)' --rpc-url "$RPC")"
    BOUND_DELAY="$(cast call "$DEPLOYED" 'initialDelay()(uint64)' --rpc-url "$RPC" |
        tr -d '[:space:]')"
    EXPECTED_DELAY="${ORACLE_SCHEDULER_INITIAL_DELAY:-90}"
    if [ "$(printf '%s' "$BOUND_ORACLE" | tr '[:upper:]' '[:lower:]')" != \
        "$(printf '%s' "$ORACLE" | tr '[:upper:]' '[:lower:]')" ]; then
        echo "deployed scheduler oracle binding does not match $ORACLE" >&2
        exit 1
    fi
    if [ "$(printf '%s' "$BOUND_TREASURY" | tr '[:upper:]' '[:lower:]')" != \
        "$(printf '%s' "$HEDERA_EVM_ADDRESS" | tr '[:upper:]' '[:lower:]')" ]; then
        echo "deployed scheduler treasury binding does not match HEDERA_EVM_ADDRESS" >&2
        exit 1
    fi
    if [ "$BOUND_DELAY" != "$EXPECTED_DELAY" ]; then
        echo "deployed scheduler delay $BOUND_DELAY does not match $EXPECTED_DELAY" >&2
        exit 1
    fi

    ARTIFACT="out/OracleScheduler.sol/OracleScheduler.json"
    MASKED_RUNTIME="$(python3 - "$ARTIFACT" "$RUNTIME_CODE" <<'PY'
import json
import sys

artifact_path, runtime_hex = sys.argv[1:]
artifact = json.load(open(artifact_path))
deployed = artifact["deployedBytecode"]
template_hex = deployed["object"]
references = deployed.get("immutableReferences", {})
if not references:
    raise SystemExit("scheduler artifact has no immutable references")
if not runtime_hex.startswith("0x") or not template_hex.startswith("0x"):
    raise SystemExit("runtime bytecode is not hex encoded")
runtime = bytearray.fromhex(runtime_hex[2:])
template = bytearray.fromhex(template_hex[2:])
if len(runtime) != len(template):
    raise SystemExit("deployed runtime length does not match the build artifact")
for locations in references.values():
    for location in locations:
        start = int(location["start"])
        length = int(location["length"])
        end = start + length
        if start < 0 or end > len(runtime):
            raise SystemExit("immutable reference lies outside runtime bytecode")
        runtime[start:end] = bytes(length)
        template[start:end] = bytes(length)
if runtime != template:
    raise SystemExit("deployed runtime differs from the artifact outside immutables")
print("0x" + runtime.hex())
PY
)"
    RUNTIME_HASH="$(cast keccak "$RUNTIME_CODE")"
    MASKED_RUNTIME_HASH="$(cast keccak "$MASKED_RUNTIME")"

    python3 - "$RECORD" "$DEPLOYED" "$CONTRACT_ID" "$ORACLE" "$BOUND_TREASURY" \
        "$DEPLOY_TRANSACTION_HASH" "$CHAIN_ID" "$BOUND_DELAY" "$RUNTIME_HASH" \
        "$MASKED_RUNTIME_HASH" "$ARTIFACT" <<'PY'
import datetime
import json
import os
import sys

(
    record,
    address,
    contract_id,
    oracle,
    treasury,
    transaction_hash,
    chain_id,
    initial_delay,
    runtime_hash,
    masked_runtime_hash,
    artifact,
) = sys.argv[1:]
previous = json.load(open(record)) if os.path.exists(record) else None
recorded_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
out = {
    "schema": "lattice.oracle.scheduler.v1",
    "deployedAt": recorded_at,
    "address": address,
    "contractId": contract_id,
    "oracle": oracle,
    "treasury": treasury,
    "transactionHash": transaction_hash,
    "runtimeBytecodeHash": runtime_hash,
    "immutableMaskedRuntimeBytecodeHash": masked_runtime_hash,
    "runtimeArtifact": artifact,
    "chainId": int(chain_id),
    "configuration": {
        "initialDelaySeconds": int(initial_delay),
        "retrySeconds": [300, 900, 3600],
        "maximumUnchangedChecks": 4,
        "maximumChecksPerRound": 8,
        "maximumSchedulingAttemptsPerRound": 8,
        "executionClockToleranceSeconds": 2,
        "minimumBalanceTinybar": "500000000",
    },
    "bindings": {
        "checkedAt": recorded_at,
        "oracle": oracle,
        "treasury": treasury,
        "initialDelaySeconds": int(initial_delay),
    },
}
if previous and previous.get("address", "").lower() != out["address"].lower():
    prior = {key: value for key, value in previous.items() if key != "supersedes"}
    history = previous.get("supersedes", [])
    if isinstance(history, dict):
        history = [history]
    if not isinstance(history, list):
        history = []
    out["supersedes"] = [prior, *history]
temporary = record + ".tmp"
with open(temporary, "w") as handle:
    handle.write(json.dumps(out, indent=2) + "\n")
os.replace(temporary, record)
PY
    echo "scheduler      $DEPLOYED"
    echo "contract ID   $CONTRACT_ID"
    echo "runtime hash  $RUNTIME_HASH"
    echo "masked hash   $MASKED_RUNTIME_HASH"
    echo "record         $RECORD"
    exit 0
fi

clear_raw_signing_secrets

if [ -z "$SCHEDULER" ]; then
    echo "No scheduler address. Run '$0 deploy' or set ORACLE_SCHEDULER." >&2
    exit 1
fi

SIGNER_ARGS=()
prepare_signer() {
    SIGNER_ARGS=()
    if [ -n "${HEDERA_KEYSTORE:-}" ]; then
        if [ ! -f "$HEDERA_KEYSTORE" ]; then
            echo "HEDERA_KEYSTORE does not exist: $HEDERA_KEYSTORE" >&2
            exit 1
        fi
        SIGNER_ARGS=(--keystore "$HEDERA_KEYSTORE")
    elif [ -n "${HEDERA_KEYSTORE_ACCOUNT:-}" ]; then
        SIGNER_ARGS=(--account "$HEDERA_KEYSTORE_ACCOUNT")
    elif [ -t 0 ]; then
        SIGNER_ARGS=(--interactive)
        return
    else
        echo "Set HEDERA_KEYSTORE or HEDERA_KEYSTORE_ACCOUNT for write mode." >&2
        exit 1
    fi

    if [ -n "${HEDERA_KEYSTORE_PASSWORD_FILE:-}" ]; then
        require_private_file "$HEDERA_KEYSTORE_PASSWORD_FILE"
        SIGNER_ARGS+=(--password-file "$HEDERA_KEYSTORE_PASSWORD_FILE")
    elif [ ! -t 0 ]; then
        echo "Set HEDERA_KEYSTORE_PASSWORD_FILE for noninteractive write mode." >&2
        exit 1
    fi
}

call() {
    cast call "$SCHEDULER" "$@" --rpc-url "$RPC"
}

BOUND_ORACLE="$(call 'oracle()(address)')"
if [ "$(printf '%s' "$BOUND_ORACLE" | tr '[:upper:]' '[:lower:]')" != \
    "$(printf '%s' "$CLIENT_ORACLE" | tr '[:upper:]' '[:lower:]')" ]; then
    echo "Scheduler $SCHEDULER is bound to $BOUND_ORACLE, not current PrimeOracle $CLIENT_ORACLE." >&2
    if [ "$MODE" != "withdraw" ]; then
        exit 1
    fi
fi

if [ "$MODE" = "fund" ]; then
    if [ ! -f "$RECORD" ]; then
        echo "Cannot record funding without $RECORD." >&2
        exit 1
    fi
    RECORDED_SCHEDULER="$(python3 -c \
        "import json; print(json.load(open('$RECORD'))['address'])")"
    if [ "$(printf '%s' "$RECORDED_SCHEDULER" | tr '[:upper:]' '[:lower:]')" != \
        "$(printf '%s' "$SCHEDULER" | tr '[:upper:]' '[:lower:]')" ]; then
        echo "Funding target $SCHEDULER does not match record $RECORDED_SCHEDULER." >&2
        exit 1
    fi
    FUND_HBAR="$(python3 - "$FUND_HBAR" <<'PY'
from decimal import Decimal, InvalidOperation
import sys

try:
    amount = Decimal(sys.argv[1])
except InvalidOperation:
    raise SystemExit("fund-hbar must be a positive decimal")
if not amount.is_finite() or amount <= 0:
    raise SystemExit("fund-hbar must be a positive decimal")
canonical = format(amount, "f")
if "." in canonical:
    canonical = canonical.rstrip("0").rstrip(".")
print(canonical if canonical else "0")
PY
)"
    prepare_signer
    FUND_RECEIPT="$(mktemp)"
    trap 'rm -f "$FUND_RECEIPT"' EXIT
    cast send "$SCHEDULER" --value "${FUND_HBAR}ether" \
        "${SIGNER_ARGS[@]}" --rpc-url "$RPC" --legacy --json >"$FUND_RECEIPT"
    FUND_TRANSACTION_HASH="$(python3 - "$FUND_RECEIPT" "$RECORD" \
        "$SCHEDULER" "$FUND_HBAR" <<'PY'
import datetime
import json
import os
import sys

receipt_path, record_path, scheduler, funded_hbar = sys.argv[1:]
receipt = json.load(open(receipt_path))
status = str(receipt.get("status", "")).lower()
if status in {"0", "0x0", "failed"}:
    raise SystemExit("funding transaction failed")
transaction_hash = receipt.get("transactionHash") or receipt.get("transaction_hash")
if not transaction_hash:
    raise SystemExit("funding receipt has no transaction hash")
record = json.load(open(record_path))
if record.get("address", "").lower() != scheduler.lower():
    raise SystemExit("funding receipt target differs from deployment record")
history = record.get("fundingTransactions")
if not isinstance(history, list):
    history = []
prior_hash = record.get("fundingTransactionHash")
if prior_hash and not any(row.get("transactionHash") == prior_hash for row in history):
    history.append({
        "transactionHash": prior_hash,
        "fundedHbar": str(record.get("fundedHbar", "")),
    })
recorded_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
history.append({
    "transactionHash": transaction_hash,
    "fundedHbar": funded_hbar,
    "recordedAt": recorded_at,
})
record["fundingTransactionHash"] = transaction_hash
record["fundedHbar"] = funded_hbar
record["fundingTransactions"] = history
temporary = record_path + ".tmp"
with open(temporary, "w") as handle:
    handle.write(json.dumps(record, indent=2) + "\n")
os.replace(temporary, record_path)
print(transaction_hash)
PY
)"
    rm -f "$FUND_RECEIPT"
    trap - EXIT
    echo "funding transaction $FUND_TRANSACTION_HASH"
elif [ "$MODE" = "arm" ]; then
    prepare_signer
    cast send "$SCHEDULER" "arm()(bool)" \
        "${SIGNER_ARGS[@]}" --rpc-url "$RPC" --legacy
elif [ "$MODE" = "tick" ]; then
    prepare_signer
    cast send "$SCHEDULER" "tick()(bool,bool)" \
        "${SIGNER_ARGS[@]}" --rpc-url "$RPC" --legacy
elif [ "$MODE" = "withdraw" ]; then
    : "${HEDERA_EVM_ADDRESS:?set HEDERA_EVM_ADDRESS}"
    prepare_signer
    BALANCE_WEIBAR="$(cast balance "$SCHEDULER" --rpc-url "$RPC")"
    BALANCE_TINYBAR="$(python3 -c "print(int('$BALANCE_WEIBAR') // 10_000_000_000)")"
    cast send "$SCHEDULER" "withdraw(address,uint256)" \
        "$HEDERA_EVM_ADDRESS" "$BALANCE_TINYBAR" \
        "${SIGNER_ARGS[@]}" --rpc-url "$RPC" --legacy \
        --gas-limit 500000
fi

echo "scheduler      $SCHEDULER"
echo "oracle         $(call 'oracle()(address)')"
echo "treasury       $(call 'treasury()(address)')"
echo "balance weibar $(cast balance "$SCHEDULER" --rpc-url "$RPC")"
echo "active         $(call 'activeSchedule()(address)')"
echo "next check     $(call 'nextCheckAt()(uint64)')"
echo "tracked round  $(call 'trackedRound()(uint64)')"
echo "checked round  $(call 'lastCheckedRound()(uint64)')"
echo "finalized      $(call 'lastFinalizedRound()(uint64)')"
echo "retry streak   $(call 'retryStreak()(uint8)') / $(call 'MAX_RETRY_STREAK()(uint8)')"
echo "round attempts $(call 'checksThisRound()(uint8)') / $(call 'MAX_CHECKS_PER_ROUND()(uint8)')"
