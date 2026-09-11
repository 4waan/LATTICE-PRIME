#!/usr/bin/env bash
# Guarded Hedera testnet deployment and evidence entrypoint for private trading.
# It stages candidate records only under out/private-trading. It never writes a
# production release or changes the generated client address book.
set -euo pipefail
umask 077

cd "$(dirname "$0")/../.."

MODE="${1:-plan}"
case "$MODE" in
    plan|deploy|activate-lprc|evidence|canary-plan|canary-run) ;;
    *)
        echo "usage: $0 [plan|deploy|activate-lprc|evidence|canary-plan|canary-run] [inputs]" >&2
        exit 2
        ;;
esac

EXPECTED_CHAIN_ID=296
QUICKNET_CHAIN_HASH=0x52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971
LPRC_ACTIVATION_GAS_LIMIT=300000
CLIENT=deployments/client.json
WORK=out/private-trading
CANDIDATE="$WORK/private-trading-candidate-deployment.json"
BROADCAST=broadcast/DeployPrivateTrading.s.sol/296/run-latest.json
FINAL_RELEASE=deployments/private-trading-release.json

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

if [ -n "${PRIVATE_TRADING_ENV_FILE:-}" ]; then
    require_private_file "$PRIVATE_TRADING_ENV_FILE"
    set -a
    # shellcheck disable=SC1090
    . "$PRIVATE_TRADING_ENV_FILE"
    set +a
fi

for command in cast forge git node python3; do
    command -v "$command" >/dev/null || {
        echo "missing command: $command" >&2
        exit 1
    }
done

lower() { tr '[:upper:]' '[:lower:]'; }
first() { awk 'NR == 1 { print $1 }'; }
nth() { awk -v line="$1" 'NR == line { print $1 }'; }
json_field() {
    python3 - "$1" "$2" <<'PY'
import json
import sys

value = json.load(open(sys.argv[1]))
for part in sys.argv[2].split("."):
    value = value[int(part)] if isinstance(value, list) else value[part]
if isinstance(value, bool):
    print(str(value).lower())
else:
    print(value)
PY
}
same_address() {
    [ "$(printf '%s' "$1" | lower)" = "$(printf '%s' "$2" | lower)" ]
}
assert_address() {
    local label="$1" actual="$2" expected="$3"
    same_address "$actual" "$expected" || {
        echo "$label mismatch: got $actual, expected $expected" >&2
        exit 1
    }
}
assert_value() {
    local label="$1" actual="$2" expected="$3"
    [ "$(printf '%s' "$actual" | first)" = "$expected" ] || {
        echo "$label mismatch: got $(printf '%s' "$actual" | first), expected $expected" >&2
        exit 1
    }
}
assert_code() {
    local label="$1" address="$2" code
    code="$(cast code "$address" --rpc-url "$RPC")"
    [ -n "$code" ] && [ "$code" != "0x" ] || {
        echo "$label has no runtime code at $address" >&2
        exit 1
    }
}
call() {
    cast call "$1" "$2" "${@:3}" --rpc-url "$RPC"
}
wallet_address() {
    cast wallet address --private-key "$1" | first
}
require_address() {
    python3 - "$1" "$2" <<'PY'
import re
import sys

if not re.fullmatch(r"0x[0-9a-fA-F]{40}", sys.argv[2]):
    raise SystemExit(f"{sys.argv[1]} is not an EVM address")
PY
}

if [ "$MODE" = "evidence" ]; then
    INPUT="${2:?usage: $0 evidence CANARY_INPUT [CANDIDATE_OUTPUT]}"
    OUTPUT="${3:-$WORK/private-trading-candidate-evidence.json}"
    [ "$OUTPUT" != "$FINAL_RELEASE" ] || {
        echo "refusing to write the final private trading release file" >&2
        exit 1
    }
    mkdir -p "$WORK"
    node tools/private-canary-evidence.mjs "$INPUT" \
        --out "$OUTPUT" --artifact-root out
    echo "candidate evidence $OUTPUT"
    exit 0
fi

if [ "$MODE" = "canary-plan" ] || [ "$MODE" = "canary-run" ]; then
    CONFIG="${2:?usage: $0 $MODE CANARY_CONFIG BASE_EVIDENCE [CANDIDATE]}"
    BASE="${3:?usage: $0 $MODE CANARY_CONFIG BASE_EVIDENCE [CANDIDATE]}"
    RUN_CANDIDATE="${4:-$CANDIDATE}"
    [ -s "$RUN_CANDIDATE" ] || {
        echo "candidate deployment record is missing: $RUN_CANDIDATE" >&2
        exit 1
    }
    if [ "$MODE" = "canary-plan" ]; then
        node tools/private-canary-runner.mjs plan \
            --config "$CONFIG" --candidate "$RUN_CANDIDATE" --base "$BASE"
        exit 0
    fi
    INPUT_OUTPUT="$WORK/private-trading-live-canary-input.json"
    EVIDENCE_OUTPUT="$WORK/private-trading-live-candidate-evidence.json"
    [ "$INPUT_OUTPUT" != "$FINAL_RELEASE" ] \
        && [ "$EVIDENCE_OUTPUT" != "$FINAL_RELEASE" ] || {
        echo "refusing to write the final private trading release file" >&2
        exit 1
    }
    EXTRA_ARGS=()
    if [ -n "${HEDERA_TESTNET_MIRROR_URL:-}" ]; then
        EXTRA_ARGS=(--mirror-url "$HEDERA_TESTNET_MIRROR_URL")
    fi
    node tools/private-canary-runner.mjs run \
        --config "$CONFIG" --candidate "$RUN_CANDIDATE" --base "$BASE" \
        --input-out "$INPUT_OUTPUT" --evidence-out "$EVIDENCE_OUTPUT" \
        --artifact-root out "${EXTRA_ARGS[@]}"
    exit 0
fi

: "${HEDERA_TESTNET_RPC:?set HEDERA_TESTNET_RPC}"
RPC="$HEDERA_TESTNET_RPC"
CHAIN_ID="$(cast chain-id --rpc-url "$RPC" | first)"
[ "$CHAIN_ID" = "$EXPECTED_CHAIN_ID" ] || {
    echo "refusing chain $CHAIN_ID; expected Hedera testnet $EXPECTED_CHAIN_ID" >&2
    exit 1
}

if [ "$MODE" = "activate-lprc" ]; then
    EVIDENCE="${2:?usage: $0 activate-lprc ATS_CANARY_EVIDENCE}"
    [ -s "$CANDIDATE" ] || {
        echo "candidate deployment record is missing: $CANDIDATE" >&2
        exit 1
    }
    : "${PRIVATE_TRADING_ADMIN_KEY:?set PRIVATE_TRADING_ADMIN_KEY}"
    ADMIN="$(wallet_address "$PRIVATE_TRADING_ADMIN_KEY")"
    RECORDED_ADMIN="$(json_field "$CANDIDATE" roles.admin)"
    assert_address "admin signer" "$ADMIN" "$RECORDED_ADMIN"
    LPRC_ROUTER="$(json_field "$CANDIDATE" addresses.LprcRouter)"
    assert_code "LPRC router" "$LPRC_ROUTER"
    assert_value "ATS canary chain" \
        "$(json_field "$EVIDENCE" chainId)" "$EXPECTED_CHAIN_ID"
    assert_address "ATS canary security" \
        "$(json_field "$EVIDENCE" security)" \
        "$(json_field "$CANDIDATE" context.security)"
    assert_address "ATS canary pool" \
        "$(json_field "$EVIDENCE" pool)" "$LPRC_ROUTER"
    assert_value "ATS canary partition" \
        "$(json_field "$EVIDENCE" partition)" \
        "$(json_field "$CANDIDATE" context.partition)"
    assert_value \
        "existing ATS canary hash" \
        "$(call "$LPRC_ROUTER" "atsCanaryEvidenceHash()(bytes32)")" \
        "0x0000000000000000000000000000000000000000000000000000000000000000"
    ATS_HASH="$(
        node tools/private-canary-evidence.mjs --ats-digest "$EVIDENCE"
    )"
    RECEIPT="$WORK/private-trading-candidate-lprc-activation.json"
    [ ! -e "$RECEIPT" ] || {
        echo "activation receipt already exists: $RECEIPT" >&2
        exit 1
    }
    TEMPORARY="$RECEIPT.tmp"
    trap 'rm -f "$TEMPORARY"' EXIT
    cast send "$LPRC_ROUTER" "activateAtsCanary(bytes32)" "$ATS_HASH" \
        --private-key "$PRIVATE_TRADING_ADMIN_KEY" \
        --rpc-url "$RPC" --legacy --gas-limit "$LPRC_ACTIVATION_GAS_LIMIT" \
        --json --timeout 300 >"$TEMPORARY"
    unset PRIVATE_TRADING_ADMIN_KEY
    STATUS="$(json_field "$TEMPORARY" status)"
    [ "$STATUS" = "0x1" ] || [ "$STATUS" = "1" ] || {
        echo "LPRC activation failed with status $STATUS" >&2
        exit 1
    }
    mv "$TEMPORARY" "$RECEIPT"
    trap - EXIT
    assert_value \
        "activated ATS canary hash" \
        "$(call "$LPRC_ROUTER" "atsCanaryEvidenceHash()(bytes32)")" \
        "$ATS_HASH"
    echo "candidate LPRC activation receipt $RECEIPT"
    exit 0
fi

required_environment=(
    PRIVATE_TRADING_DEPLOYER_ADDRESS
    PRIVATE_TRADING_ADMIN_ADDRESS
    PRIVATE_TRADING_ISSUER_ADDRESS
    PRIVATE_TRADING_RELAYER_ADDRESS
    PRIVATE_TRADING_CANARY_SESSION_SIGNER
    PRIVATE_TRADING_CANARY_RECOVERY_SIGNER
    VENUE_ENGINE
    ATS_TOKEN
    ZK_KYC_REGISTRY
    KYC_VERIFIER
    PRIVATE_TRADING_POSEIDON2
    PRIVATE_TRADING_POSEIDON2_CODE_HASH
    PRIVATE_TRADING_PARTITION
    PRIVATE_TRADING_FEE_POLICY_DIGEST
    PRIVATE_TRADING_CANARY_ACCOUNT_SALT
    PRIVATE_TRADING_GENERATION
    PRIVATE_TRADING_QUICKNET_CHAIN_HASH
    PRIVATE_TRADING_ACTIVATION_EPOCH
    PRIVATE_TRADING_MANUAL_ROOT
    PRIVATE_TRADING_SESSION_ROOT
    PRIVATE_TRADING_MIN_TIER
    PRIVATE_TRADING_JURISDICTION_MASK
    PRIVATE_TRADING_HBAR_DENOMINATION_TINYBAR
    PRIVATE_TRADING_LPRC_DENOMINATION
    PRIVATE_TRADING_MINIMUM_WITHDRAWAL_DELAY
    PRIVATE_TRADING_MAXIMUM_ROOT_AGE
    PRIVATE_TRADING_MINIMUM_REAL_NOTES
    PRIVATE_TRADING_VIEW_KEY_EPOCH
    PRIVATE_TRADING_VIEW_KEY_X
    PRIVATE_TRADING_VIEW_KEY_Y
    PRIVATE_TRADING_LPRC_HOLD_DURATION
)
for variable in "${required_environment[@]}"; do
    [ -n "${!variable:-}" ] || {
        echo "set $variable" >&2
        exit 1
    }
done

for variable in \
    PRIVATE_TRADING_DEPLOYER_ADDRESS \
    PRIVATE_TRADING_ADMIN_ADDRESS \
    PRIVATE_TRADING_ISSUER_ADDRESS \
    PRIVATE_TRADING_RELAYER_ADDRESS \
    PRIVATE_TRADING_CANARY_SESSION_SIGNER \
    PRIVATE_TRADING_CANARY_RECOVERY_SIGNER \
    VENUE_ENGINE ATS_TOKEN ZK_KYC_REGISTRY KYC_VERIFIER PRIVATE_TRADING_POSEIDON2; do
    require_address "$variable" "${!variable}"
done

ROLE_ADDRESSES="$(
    printf '%s\n' \
        "$PRIVATE_TRADING_DEPLOYER_ADDRESS" \
        "$PRIVATE_TRADING_ADMIN_ADDRESS" \
        "$PRIVATE_TRADING_ISSUER_ADDRESS" \
        "$PRIVATE_TRADING_RELAYER_ADDRESS" \
        "$PRIVATE_TRADING_CANARY_SESSION_SIGNER" \
        "$PRIVATE_TRADING_CANARY_RECOVERY_SIGNER" |
        lower
)"
[ "$(printf '%s\n' "$ROLE_ADDRESSES" | sort -u | wc -l | tr -d ' ')" = "6" ] || {
    echo "deploy, admin, issuer, relayer, session, and recovery roles must be distinct" >&2
    exit 1
}

if [ "$PRIVATE_TRADING_QUICKNET_CHAIN_HASH" != "$QUICKNET_CHAIN_HASH" ]; then
    echo "PRIVATE_TRADING_QUICKNET_CHAIN_HASH is not the pinned Quicknet chain" >&2
    exit 1
fi
case "$PRIVATE_TRADING_MINIMUM_REAL_NOTES" in
    ''|*[!0-9]*) echo "PRIVATE_TRADING_MINIMUM_REAL_NOTES must be an integer" >&2; exit 1 ;;
esac
[ "$PRIVATE_TRADING_MINIMUM_REAL_NOTES" -ge 8 ] || {
    echo "PRIVATE_TRADING_MINIMUM_REAL_NOTES must be at least 8" >&2
    exit 1
}

git ls-files --error-unmatch "$CLIENT" >/dev/null 2>&1 || {
    echo "$CLIENT is not tracked" >&2
    exit 1
}
git diff --quiet -- "$CLIENT" &&
git diff --cached --quiet -- "$CLIENT" || {
    echo "$CLIENT is dirty; refusing a chain binding from a moving generated file" >&2
    exit 1
}

client_address() {
    json_field "$CLIENT" "addresses.$1"
}
assert_value \
    "generated client chain" \
    "$(json_field "$CLIENT" network.chainId)" \
    "$EXPECTED_CHAIN_ID"
assert_address "VENUE_ENGINE" "$VENUE_ENGINE" "$(client_address MatchingEngine)"
assert_address "ATS_TOKEN" "$ATS_TOKEN" "$(client_address token)"
assert_address "ZK_KYC_REGISTRY" "$ZK_KYC_REGISTRY" "$(client_address ZkKycRegistry)"
assert_address "KYC_VERIFIER" "$KYC_VERIFIER" "$(client_address KycVerifier)"
assert_value \
    "PRIVATE_TRADING_PARTITION" \
    "$PRIVATE_TRADING_PARTITION" \
    "$(json_field "$CLIENT" immutables.partition)"

for pair in \
    "engine:$VENUE_ENGINE" \
    "security:$ATS_TOKEN" \
    "registry:$ZK_KYC_REGISTRY" \
    "manual verifier:$KYC_VERIFIER" \
    "Poseidon2:$PRIVATE_TRADING_POSEIDON2"; do
    assert_code "${pair%%:*}" "${pair#*:}"
done
assert_address \
    "engine security" \
    "$(call "$VENUE_ENGINE" "security()(address)" | first)" \
    "$ATS_TOKEN"
assert_value \
    "engine partition" \
    "$(call "$VENUE_ENGINE" "partition()(bytes32)" | first)" \
    "$PRIVATE_TRADING_PARTITION"
ENGINE_REVEAL_DELAY="$(
    call "$VENUE_ENGINE" "revealDelay()(uint64)" | first
)"
ENGINE_REVEAL_WINDOW="$(
    call "$VENUE_ENGINE" "revealWindow()(uint64)" | first
)"
assert_address \
    "registry admin" \
    "$(call "$ZK_KYC_REGISTRY" "admin()(address)" | first)" \
    "$PRIVATE_TRADING_ADMIN_ADDRESS"
PENDING_GATE="$(call "$ZK_KYC_REGISTRY" "pendingGate()(address)" | first)"
ZERO=0x0000000000000000000000000000000000000000
assert_address "registry pending gate" "$PENDING_GATE" "$ZERO"
CURRENT_EPOCH="$(call "$ZK_KYC_REGISTRY" "currentEpoch()(uint64)" | first)"
ACTIVE_GATE="$(call "$ZK_KYC_REGISTRY" "gate()(address)" | first)"
if same_address "$ACTIVE_GATE" "$ZERO"; then
    EXPECTED_ACTIVATION_EPOCH="$CURRENT_EPOCH"
else
    EXPECTED_ACTIVATION_EPOCH="$((CURRENT_EPOCH + 1))"
fi
assert_value \
    "PRIVATE_TRADING_ACTIVATION_EPOCH" \
    "$PRIVATE_TRADING_ACTIVATION_EPOCH" \
    "$EXPECTED_ACTIVATION_EPOCH"
EPOCH_ZERO="$(call "$ZK_KYC_REGISTRY" "epochZero()(uint64)" | first)"
EPOCH_LENGTH="$(call "$ZK_KYC_REGISTRY" "epochLength()(uint64)" | first)"
EPOCH_HEADROOM="${PRIVATE_TRADING_EPOCH_HEADROOM_SECONDS:-900}"
case "$EPOCH_HEADROOM" in
    ''|*[!0-9]*)
        echo "PRIVATE_TRADING_EPOCH_HEADROOM_SECONDS must be an integer" >&2
        exit 1
        ;;
esac
LATEST_BLOCK="$(
    cast block latest --rpc-url "$RPC" --json
)"
LATEST_TIMESTAMP="$(
    printf '%s' "$LATEST_BLOCK" | python3 -c '
import json
import sys
value = json.load(sys.stdin)["timestamp"]
print(int(value, 16) if isinstance(value, str) and value.startswith("0x") else int(value))
'
)"
python3 - \
    "$LATEST_TIMESTAMP" "$EPOCH_ZERO" "$EPOCH_LENGTH" "$EPOCH_HEADROOM" <<'PY'
import sys

now, epoch_zero, epoch_length, minimum = map(int, sys.argv[1:])
if epoch_length <= 0:
    raise SystemExit("registry epoch length is invalid")
if now < epoch_zero:
    remaining = epoch_zero - now
else:
    remaining = epoch_length - ((now - epoch_zero) % epoch_length)
if remaining < minimum:
    raise SystemExit(
        f"registry epoch has only {remaining}s remaining; require {minimum}s headroom"
    )
PY
POSEIDON_HASH="$(cast keccak "$(cast code "$PRIVATE_TRADING_POSEIDON2" --rpc-url "$RPC")")"
[ "$(printf '%s' "$POSEIDON_HASH" | lower)" = \
    "$(printf '%s' "$PRIVATE_TRADING_POSEIDON2_CODE_HASH" | lower)" ] || {
    echo "Poseidon2 runtime hash does not match PRIVATE_TRADING_POSEIDON2_CODE_HASH" >&2
    exit 1
}

generated_sources=(
    circuits/session/session_eligibility.circom
    circuits/session/session_compliance.circom
    circuits/router/fixed_withdrawal.circom
    circuits/router/fixed_withdrawal_compliance.circom
    src/session/SessionEligibilityVerifier.sol
    src/session/SessionComplianceVerifier.sol
    src/router/FixedWithdrawalVerifier.sol
    src/router/FixedWithdrawalComplianceVerifier.sol
)
for source in "${generated_sources[@]}"; do
    git ls-files --error-unmatch "$source" >/dev/null 2>&1 || {
        echo "generated source is not tracked: $source" >&2
        exit 1
    }
done
git diff --quiet -- "${generated_sources[@]}" &&
git diff --cached --quiet -- "${generated_sources[@]}" || {
    echo "private circuit or generated verifier sources are dirty" >&2
    exit 1
}

SNARKJS="${PRIVATE_TRADING_SNARKJS:-../toolchain/node_modules/.bin/snarkjs}"
PTAU="${PRIVATE_TRADING_PTAU:-../toolchain/ptau/powersOfTau28_hez_final_15.ptau}"
[ -x "$SNARKJS" ] || {
    echo "snarkjs is not executable at $SNARKJS" >&2
    exit 1
}
[ -s "$PTAU" ] || {
    echo "PLONK ceremony file is missing at $PTAU" >&2
    exit 1
}

verify_generated_verifier() {
    local directory="$1" stem="$2" contract="$3" source="$4"
    local r1cs="$directory/$stem.r1cs"
    local zkey="$directory/$stem.zkey"
    local vkey="$directory/${stem}_vkey.json"
    for artifact in "$r1cs" "$zkey" "$vkey"; do
        [ -s "$artifact" ] || {
            echo "generated proving artifact is missing: $artifact" >&2
            exit 1
        }
    done
    # `snarkjs zkey verify` is Groth16-only. These keys are PLONK, so match the
    # exported verification key and Solidity verifier against the committed copies.
    local temporary
    temporary="$(mktemp -d)"
    "$SNARKJS" zkey export verificationkey "$zkey" "$temporary/vkey.json" >/dev/null
    "$SNARKJS" zkey export solidityverifier "$zkey" "$temporary/verifier.sol" >/dev/null
    python3 - "$vkey" "$temporary/vkey.json" "$source" \
        "$temporary/verifier.sol" "$contract" <<'PY'
import json
import pathlib
import re
import sys

vkey, generated_vkey, source, generated_source, contract = sys.argv[1:]
committed = json.loads(pathlib.Path(vkey).read_text())
exported = json.loads(pathlib.Path(generated_vkey).read_text())
if committed.get("protocol") != "plonk" or exported.get("protocol") != "plonk":
    raise SystemExit(f"{vkey} is not a PLONK verification key")
if committed != exported:
    raise SystemExit(f"{vkey} does not match its zkey")

def normalized(path):
    text = pathlib.Path(path).read_text().replace("\r\n", "\n")
    text, count = re.subn(
        r"\bcontract\s+[A-Za-z_][A-Za-z0-9_]*\s*\{",
        f"contract {contract} {{",
        text,
        count=1,
    )
    if count != 1:
        raise SystemExit(f"no verifier contract declaration in {path}")
    return "\n".join(line.rstrip() for line in text.strip().splitlines())

if normalized(source) != normalized(generated_source):
    raise SystemExit(f"{source} does not match its zkey")
PY
    rm -rf "$temporary"
}

verify_generated_verifier \
    circuits/session session_eligibility SessionEligibilityVerifier \
    src/session/SessionEligibilityVerifier.sol
verify_generated_verifier \
    circuits/session session_compliance SessionComplianceVerifier \
    src/session/SessionComplianceVerifier.sol
verify_generated_verifier \
    circuits/router fixed_withdrawal FixedWithdrawalVerifier \
    src/router/FixedWithdrawalVerifier.sol
verify_generated_verifier \
    circuits/router fixed_withdrawal_compliance FixedWithdrawalComplianceVerifier \
    src/router/FixedWithdrawalComplianceVerifier.sol

if [ "$MODE" = "plan" ]; then
    echo "network                 Hedera testnet ($CHAIN_ID)"
    echo "deployer                $PRIVATE_TRADING_DEPLOYER_ADDRESS"
    echo "pool and registry admin $PRIVATE_TRADING_ADMIN_ADDRESS"
    echo "proof issuer             $PRIVATE_TRADING_ISSUER_ADDRESS"
    echo "private relayer          $PRIVATE_TRADING_RELAYER_ADDRESS"
    echo "engine                   $VENUE_ENGINE"
    echo "security                 $ATS_TOKEN"
    echo "registry                 $ZK_KYC_REGISTRY"
    echo "HBAR denomination        $PRIVATE_TRADING_HBAR_DENOMINATION_TINYBAR tinybar"
    echo "LPRC denomination        $PRIVATE_TRADING_LPRC_DENOMINATION token units"
    echo "generated artifacts      clean and zkey-matched"
    echo "plan only. No transactions sent."
    exit 0
fi

[ "${PRIVATE_TRADING_CANDIDATE_ACK:-0}" = "1" ] || {
    echo "candidate deployment requires PRIVATE_TRADING_CANDIDATE_ACK=1" >&2
    exit 1
}
for key in \
    PRIVATE_TRADING_DEPLOY_KEY \
    PRIVATE_TRADING_ADMIN_KEY \
    PRIVATE_TRADING_ISSUER_KEY \
    PRIVATE_TRADING_RELAYER_KEY; do
    [ -n "${!key:-}" ] || {
        echo "set $key for guarded role verification" >&2
        exit 1
    }
done

assert_address \
    "deploy key" \
    "$(wallet_address "$PRIVATE_TRADING_DEPLOY_KEY")" \
    "$PRIVATE_TRADING_DEPLOYER_ADDRESS"
assert_address \
    "admin key" \
    "$(wallet_address "$PRIVATE_TRADING_ADMIN_KEY")" \
    "$PRIVATE_TRADING_ADMIN_ADDRESS"
assert_address \
    "issuer key" \
    "$(wallet_address "$PRIVATE_TRADING_ISSUER_KEY")" \
    "$PRIVATE_TRADING_ISSUER_ADDRESS"
assert_address \
    "relayer key" \
    "$(wallet_address "$PRIVATE_TRADING_RELAYER_KEY")" \
    "$PRIVATE_TRADING_RELAYER_ADDRESS"
if [ -n "${HEDERA_PRIVATE_KEY:-}" ]; then
    VENUE_KEY_ADDRESS="$(wallet_address "$HEDERA_PRIVATE_KEY")"
    if same_address "$VENUE_KEY_ADDRESS" "$PRIVATE_TRADING_RELAYER_ADDRESS"; then
        echo "the venue key must never be the private trading relayer key" >&2
        exit 1
    fi
fi

[ ! -e "$CANDIDATE" ] || {
    echo "candidate record already exists: $CANDIDATE" >&2
    exit 1
}
[ ! -e "$BROADCAST" ] || {
    echo "a prior private trading broadcast exists without a reviewed candidate record" >&2
    exit 1
}

mkdir -p "$WORK"
forge build --contracts script/DeployPrivateTrading.s.sol

# The relayer secret is used only to prove role separation. It is removed before
# Foundry starts, and the venue key is never selected as a fallback.
unset PRIVATE_TRADING_RELAYER_KEY HEDERA_PRIVATE_KEY HEDERA_MNEMONIC HEDERA_OPERATOR_KEY || true

LOG="$WORK/private-trading-candidate-forge.log"
forge script script/DeployPrivateTrading.s.sol:DeployPrivateTrading \
    --rpc-url "$RPC" --broadcast --slow --legacy 2>&1 | tee "$LOG"
unset PRIVATE_TRADING_DEPLOY_KEY PRIVATE_TRADING_ADMIN_KEY PRIVATE_TRADING_ISSUER_KEY || true

[ -s "$BROADCAST" ] || {
    echo "Foundry did not produce $BROADCAST" >&2
    exit 1
}

python3 - "$BROADCAST" "$CANDIDATE" \
    "$PRIVATE_TRADING_DEPLOYER_ADDRESS" "$PRIVATE_TRADING_ADMIN_ADDRESS" \
    "$PRIVATE_TRADING_ISSUER_ADDRESS" "$PRIVATE_TRADING_RELAYER_ADDRESS" \
    "$PRIVATE_TRADING_CANARY_SESSION_SIGNER" \
    "$PRIVATE_TRADING_CANARY_RECOVERY_SIGNER" \
    "$VENUE_ENGINE" "$ATS_TOKEN" "$ZK_KYC_REGISTRY" "$KYC_VERIFIER" \
    "$PRIVATE_TRADING_POSEIDON2" "$PRIVATE_TRADING_POSEIDON2_CODE_HASH" \
    "$PRIVATE_TRADING_PARTITION" "$PRIVATE_TRADING_FEE_POLICY_DIGEST" \
    "$PRIVATE_TRADING_QUICKNET_CHAIN_HASH" "$PRIVATE_TRADING_ACTIVATION_EPOCH" \
    "$PRIVATE_TRADING_MANUAL_ROOT" "$PRIVATE_TRADING_SESSION_ROOT" \
    "$PRIVATE_TRADING_MIN_TIER" "$PRIVATE_TRADING_JURISDICTION_MASK" \
    "$PRIVATE_TRADING_GENERATION" "$PRIVATE_TRADING_HBAR_DENOMINATION_TINYBAR" \
    "$PRIVATE_TRADING_LPRC_DENOMINATION" \
    "$PRIVATE_TRADING_MINIMUM_WITHDRAWAL_DELAY" \
    "$PRIVATE_TRADING_MAXIMUM_ROOT_AGE" "$PRIVATE_TRADING_MINIMUM_REAL_NOTES" \
    "$PRIVATE_TRADING_VIEW_KEY_EPOCH" "$PRIVATE_TRADING_VIEW_KEY_X" \
    "$PRIVATE_TRADING_VIEW_KEY_Y" "$PRIVATE_TRADING_LPRC_HOLD_DURATION" \
    "$ENGINE_REVEAL_DELAY" "$ENGINE_REVEAL_WINDOW" <<'PY'
import datetime as dt
import json
import pathlib
import sys

(
    source,
    output,
    deployer,
    admin,
    issuer,
    relayer,
    session_signer,
    recovery_signer,
    engine,
    security,
    registry,
    manual_verifier,
    poseidon,
    poseidon_hash,
    partition,
    fee_policy,
    quicknet,
    activation_epoch,
    manual_root,
    session_root,
    min_tier,
    jurisdiction_mask,
    generation,
    hbar_denomination,
    lprc_denomination,
    minimum_delay,
    maximum_age,
    minimum_notes,
    view_key_epoch,
    view_key_x,
    view_key_y,
    lprc_hold_duration,
    engine_reveal_delay,
    engine_reveal_window,
) = sys.argv[1:]
run = json.loads(pathlib.Path(source).read_text())
receipt_by_hash = {
    str(row.get("transactionHash", "")).lower(): row
    for row in run.get("receipts", [])
}
required = {
    "SessionEligibilityVerifier": "SessionEligibilityVerifier",
    "SessionComplianceVerifier": "SessionComplianceVerifier",
    "FixedWithdrawalVerifier": "FixedWithdrawalVerifier",
    "FixedWithdrawalComplianceVerifier": "FixedWithdrawalComplianceVerifier",
    "SessionAccountFactory": "SessionAccountFactory",
    "DualRegistrationGate": "DualRegistrationGate",
    "HbarFixedDenominationRouter": "HbarRouter",
    "LprcFixedDenominationRouter": "LprcRouter",
    "SessionRecoveryRouter": "SessionRecoveryRouter",
}
contracts = {}
transactions = {}
session_deployed_topic = (
    "0xe3cb94f0cfcce2e5ff04ffbc82033762b9f6db90bb8b93a9692ff46d1b33bfb0"
)

def receipt(tx):
    row = receipt_by_hash.get(str(tx.get("hash", "")).lower())
    if row is None:
        raise SystemExit(f"broadcast transaction has no receipt: {tx.get('hash')}")
    status = str(row.get("status", "")).lower()
    if status not in {"1", "0x1"}:
        raise SystemExit(f"broadcast transaction failed: {tx.get('hash')}")
    gas = row.get("gasUsed", "0x0")
    return {
        "transactionHash": tx["hash"],
        "status": row.get("status"),
        "gasUsed": str(int(gas, 16) if isinstance(gas, str) else int(gas)),
        "blockNumber": int(row.get("blockNumber", "0x0"), 16)
        if isinstance(row.get("blockNumber"), str)
        else int(row.get("blockNumber", 0)),
    }

for tx in run.get("transactions", []):
    tx_receipt = receipt(tx)
    name = tx.get("contractName")
    if tx.get("transactionType") in {"CREATE", "CREATE2"} and name in required:
        key = required[name]
        contracts[key] = {
            "address": tx["contractAddress"],
            **tx_receipt,
        }
    function = str(tx.get("function", ""))
    if function:
        transactions.setdefault(function.split("(")[0], []).append(tx_receipt)
    for additional in tx.get("additionalContracts", []) or []:
        if additional.get("contractName") == "SessionAccount":
            contracts["CanarySessionAccount"] = {
                "address": additional["address"],
                **tx_receipt,
            }
    factory = contracts.get("SessionAccountFactory")
    row = receipt_by_hash[str(tx.get("hash", "")).lower()]
    for event in row.get("logs", []) or []:
        topics = event.get("topics", []) or []
        if (
            factory is not None
            and str(event.get("address", "")).lower() == factory["address"].lower()
            and len(topics) == 3
            and str(topics[0]).lower() == session_deployed_topic
        ):
            account = "0x" + str(topics[1]).removeprefix("0x")[-40:]
            prior = contracts.get("CanarySessionAccount")
            if prior is not None and prior["address"].lower() != account.lower():
                raise SystemExit("session deployment event conflicts with CREATE2 trace")
            contracts["CanarySessionAccount"] = {
                "address": account,
                **tx_receipt,
            }

missing = [
    name for name in [*required.values(), "CanarySessionAccount"]
    if name not in contracts
]
if missing:
    raise SystemExit(f"broadcast is missing contracts: {', '.join(missing)}")
if len({row["address"].lower() for row in contracts.values()}) != len(contracts):
    raise SystemExit("broadcast reused a private contract address")

record = {
    "schemaVersion": "lattice.private-trading-candidate-deployment.v1",
    "candidateOnly": True,
    "createdAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
    "network": {"name": "hedera-testnet", "chainId": 296},
    "roles": {
        "deployer": deployer,
        "admin": admin,
        "issuer": issuer,
        "relayer": relayer,
        "sessionSigner": session_signer,
        "recoverySigner": recovery_signer,
    },
    "addresses": {
        name: row["address"] for name, row in contracts.items()
    },
    "contracts": contracts,
    "transactions": transactions,
    "context": {
        "engine": engine,
        "security": security,
        "registry": registry,
        "manualVerifier": manual_verifier,
        "poseidon2": poseidon,
        "poseidon2RuntimeCodeHash": poseidon_hash,
        "partition": partition,
        "feePolicyDigest": fee_policy,
        "quicknetChainHash": quicknet,
        "activationEpoch": int(activation_epoch),
        "manualRoot": manual_root,
        "sessionRoot": session_root,
        "minTier": min_tier,
        "jurisdictionMask": jurisdiction_mask,
        "generation": int(generation),
        "hbarDenominationTinybar": hbar_denomination,
        "lprcDenomination": lprc_denomination,
        "minimumWithdrawalDelay": int(minimum_delay),
        "maximumRootAge": int(maximum_age),
        "minimumRealNotes": int(minimum_notes),
        "viewKeyEpoch": int(view_key_epoch),
        "viewKeyX": view_key_x,
        "viewKeyY": view_key_y,
        "lprcHoldDuration": int(lprc_hold_duration),
        "engineRevealDelay": int(engine_reveal_delay),
        "engineRevealWindow": int(engine_reveal_window),
    },
    "runtimeCodeHashes": {},
}
temporary = pathlib.Path(str(output) + ".tmp")
temporary.write_text(json.dumps(record, indent=2) + "\n")
temporary.replace(output)
PY

for name in \
    CanarySessionAccount SessionAccountFactory DualRegistrationGate \
    SessionEligibilityVerifier SessionComplianceVerifier \
    FixedWithdrawalVerifier FixedWithdrawalComplianceVerifier \
    HbarRouter LprcRouter SessionRecoveryRouter; do
    ADDRESS="$(json_field "$CANDIDATE" "addresses.$name")"
    assert_code "$name" "$ADDRESS"
    CODE_HASH="$(cast keccak "$(cast code "$ADDRESS" --rpc-url "$RPC")")"
    NAME="$name" CODE_HASH="$CODE_HASH" python3 - "$CANDIDATE" <<'PY'
import json
import os
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
record = json.loads(path.read_text())
record["runtimeCodeHashes"][os.environ["NAME"]] = os.environ["CODE_HASH"]
temporary = pathlib.Path(str(path) + ".tmp")
temporary.write_text(json.dumps(record, indent=2) + "\n")
temporary.replace(path)
PY
done

FACTORY="$(json_field "$CANDIDATE" addresses.SessionAccountFactory)"
GATE="$(json_field "$CANDIDATE" addresses.DualRegistrationGate)"
HBAR_ROUTER="$(json_field "$CANDIDATE" addresses.HbarRouter)"
LPRC_ROUTER="$(json_field "$CANDIDATE" addresses.LprcRouter)"
RECOVERY_ROUTER="$(json_field "$CANDIDATE" addresses.SessionRecoveryRouter)"
CANARY_SESSION="$(json_field "$CANDIDATE" addresses.CanarySessionAccount)"
SESSION_ELIGIBILITY="$(json_field "$CANDIDATE" addresses.SessionEligibilityVerifier)"
SESSION_COMPLIANCE="$(json_field "$CANDIDATE" addresses.SessionComplianceVerifier)"
WITHDRAWAL="$(json_field "$CANDIDATE" addresses.FixedWithdrawalVerifier)"
WITHDRAWAL_COMPLIANCE="$(
    json_field "$CANDIDATE" addresses.FixedWithdrawalComplianceVerifier
)"

assert_address "factory admin" \
    "$(call "$FACTORY" "admin()(address)" | first)" \
    "$PRIVATE_TRADING_DEPLOYER_ADDRESS"
SESSION_CREATION_HASH="$(
    call "$FACTORY" "creationCodeHash()(bytes32)" | first
)"
EXPECTED_SESSION_CREATION_HASH="$(
    cast keccak "$(
        forge inspect src/session/SessionAccount.sol:SessionAccount bytecode | first
    )"
)"
assert_value \
    "factory session creation code" \
    "$SESSION_CREATION_HASH" \
    "$EXPECTED_SESSION_CREATION_HASH"
VENUE_CONFIG="($VENUE_ENGINE,$ATS_TOKEN,$PRIVATE_TRADING_PARTITION,$RECOVERY_ROUTER,$PRIVATE_TRADING_QUICKNET_CHAIN_HASH,$PRIVATE_TRADING_FEE_POLICY_DIGEST)"
CONFIG_DIGEST="$(
    call "$FACTORY" \
        "venueConfigDigest((address,address,bytes32,address,bytes32,bytes32))(bytes32)" \
        "$VENUE_CONFIG" | first
)"
assert_value \
    "factory venue approval" \
    "$(call "$FACTORY" "approvedVenueConfig(bytes32)(bool)" "$CONFIG_DIGEST")" \
    "true"

assert_address "gate manual verifier" \
    "$(call "$GATE" "manualVerifier()(address)" | first)" "$KYC_VERIFIER"
assert_address "gate session eligibility verifier" \
    "$(call "$GATE" "sessionEligibilityVerifier()(address)" | first)" "$SESSION_ELIGIBILITY"
assert_address "gate session compliance verifier" \
    "$(call "$GATE" "sessionComplianceVerifier()(address)" | first)" "$SESSION_COMPLIANCE"
assert_address "gate registry" \
    "$(call "$GATE" "registry()(address)" | first)" "$ZK_KYC_REGISTRY"
assert_address "gate issuer" \
    "$(call "$GATE" "issuer()(address)" | first)" "$PRIVATE_TRADING_ISSUER_ADDRESS"
assert_address "gate factory" \
    "$(call "$GATE" "sessionFactory()(address)" | first)" "$FACTORY"
assert_value "gate session creation code" \
    "$(call "$GATE" "sessionImplementationCodeHash()(bytes32)")" \
    "$SESSION_CREATION_HASH"
assert_value "gate minimum tier" \
    "$(call "$GATE" "minTier()(uint256)")" "$PRIVATE_TRADING_MIN_TIER"
assert_value "gate jurisdiction mask" \
    "$(call "$GATE" "jurisdictionMask()(uint256)")" \
    "$PRIVATE_TRADING_JURISDICTION_MASK"
assert_value "gate manual root" \
    "$(call "$GATE" "rootForEpoch(uint64)(uint256)" "$PRIVATE_TRADING_ACTIVATION_EPOCH")" \
    "$PRIVATE_TRADING_MANUAL_ROOT"
assert_value "gate session root" \
    "$(call "$GATE" "sessionRootForEpoch(uint64)(uint256)" "$PRIVATE_TRADING_ACTIVATION_EPOCH")" \
    "$PRIVATE_TRADING_SESSION_ROOT"
assert_value "gate rotation view key epoch" \
    "$(call "$GATE" "viewKeyEpochForRotationEpoch(uint64)(uint64)" \
        "$PRIVATE_TRADING_ACTIVATION_EPOCH")" \
    "$PRIVATE_TRADING_VIEW_KEY_EPOCH"
VIEW_KEY="$(
    call "$GATE" "viewKeyForEpoch(uint64)(uint256,uint256,bool)" \
        "$PRIVATE_TRADING_VIEW_KEY_EPOCH"
)"
assert_value "gate view key X" \
    "$(printf '%s\n' "$VIEW_KEY" | nth 1)" "$PRIVATE_TRADING_VIEW_KEY_X"
assert_value "gate view key Y" \
    "$(printf '%s\n' "$VIEW_KEY" | nth 2)" "$PRIVATE_TRADING_VIEW_KEY_Y"
assert_value "gate view key published" \
    "$(printf '%s\n' "$VIEW_KEY" | nth 3)" true

verify_pool() {
    local label="$1" pool="$2" asset="$3" denomination="$4"
    assert_address "$label withdrawal verifier" \
        "$(call "$pool" "withdrawalVerifier()(address)" | first)" "$WITHDRAWAL"
    assert_address "$label compliance verifier" \
        "$(call "$pool" "complianceVerifier()(address)" | first)" \
        "$WITHDRAWAL_COMPLIANCE"
    assert_address "$label Poseidon2" \
        "$(call "$pool" "poseidon()(address)" | first)" "$PRIVATE_TRADING_POSEIDON2"
    assert_value "$label Poseidon2 runtime hash" \
        "$(call "$pool" "poseidonRuntimeCodeHash()(bytes32)")" \
        "$PRIVATE_TRADING_POSEIDON2_CODE_HASH"
    assert_address "$label registry" \
        "$(call "$pool" "registry()(address)" | first)" "$ZK_KYC_REGISTRY"
    assert_address "$label factory" \
        "$(call "$pool" "sessionFactory()(address)" | first)" "$FACTORY"
    assert_address "$label admin" \
        "$(call "$pool" "admin()(address)" | first)" "$PRIVATE_TRADING_ADMIN_ADDRESS"
    assert_address "$label asset" "$(call "$pool" "asset()(address)" | first)" "$asset"
    assert_value "$label denomination" \
        "$(call "$pool" "denomination()(uint256)")" "$denomination"
    assert_value "$label withdrawal delay" \
        "$(call "$pool" "minimumWithdrawalDelay()(uint64)")" \
        "$PRIVATE_TRADING_MINIMUM_WITHDRAWAL_DELAY"
    assert_value "$label root age" \
        "$(call "$pool" "maximumRootAge()(uint64)")" \
        "$PRIVATE_TRADING_MAXIMUM_ROOT_AGE"
    assert_value "$label minimum notes" \
        "$(call "$pool" "minimumRealNotes()(uint32)")" \
        "$PRIVATE_TRADING_MINIMUM_REAL_NOTES"
    assert_value "$label deployment chain" \
        "$(call "$pool" "deploymentChainId()(uint256)")" "$EXPECTED_CHAIN_ID"
    assert_value "$label view key epoch" \
        "$(call "$pool" "activeViewKeyEpoch()(uint64)")" \
        "$PRIVATE_TRADING_VIEW_KEY_EPOCH"
    assert_value "$label view key X" \
        "$(call "$pool" "activeViewKeyX()(uint256)")" \
        "$PRIVATE_TRADING_VIEW_KEY_X"
    assert_value "$label view key Y" \
        "$(call "$pool" "activeViewKeyY()(uint256)")" \
        "$PRIVATE_TRADING_VIEW_KEY_Y"
}
verify_pool HBAR "$HBAR_ROUTER" "$ZERO" "$PRIVATE_TRADING_HBAR_DENOMINATION_TINYBAR"
verify_pool LPRC "$LPRC_ROUTER" "$ATS_TOKEN" "$PRIVATE_TRADING_LPRC_DENOMINATION"
assert_address "LPRC security" \
    "$(call "$LPRC_ROUTER" "security()(address)" | first)" "$ATS_TOKEN"
assert_value "LPRC partition" \
    "$(call "$LPRC_ROUTER" "partition()(bytes32)" | first)" "$PRIVATE_TRADING_PARTITION"
assert_value "LPRC hold duration" \
    "$(call "$LPRC_ROUTER" "holdDuration()(uint64)")" \
    "$PRIVATE_TRADING_LPRC_HOLD_DURATION"
assert_value "LPRC ATS canary remains inactive" \
    "$(call "$LPRC_ROUTER" "atsCanaryEvidenceHash()(bytes32)")" \
    0x0000000000000000000000000000000000000000000000000000000000000000

assert_address "recovery factory" \
    "$(call "$RECOVERY_ROUTER" "factory()(address)" | first)" "$FACTORY"
assert_address "recovery security" \
    "$(call "$RECOVERY_ROUTER" "security()(address)" | first)" "$ATS_TOKEN"
assert_address "recovery HBAR pool" \
    "$(call "$RECOVERY_ROUTER" "hbarPool()(address)" | first)" "$HBAR_ROUTER"
assert_address "recovery LPRC pool" \
    "$(call "$RECOVERY_ROUTER" "lprcPool()(address)" | first)" "$LPRC_ROUTER"

assert_value "canary session is canonical" \
    "$(call "$FACTORY" "isSessionAccount(address)(bool)" "$CANARY_SESSION")" true
assert_address "canary session signer" \
    "$(call "$CANARY_SESSION" "sessionSigner()(address)" | first)" \
    "$PRIVATE_TRADING_CANARY_SESSION_SIGNER"
assert_address "canary recovery signer" \
    "$(call "$CANARY_SESSION" "recoverySigner()(address)" | first)" \
    "$PRIVATE_TRADING_CANARY_RECOVERY_SIGNER"
assert_address "canary session engine" \
    "$(call "$CANARY_SESSION" "engine()(address)" | first)" "$VENUE_ENGINE"
assert_address "canary session security" \
    "$(call "$CANARY_SESSION" "security()(address)" | first)" "$ATS_TOKEN"
assert_address "canary session recovery router" \
    "$(call "$CANARY_SESSION" "router()(address)" | first)" "$RECOVERY_ROUTER"
assert_value "canary session partition" \
    "$(call "$CANARY_SESSION" "partition()(bytes32)" | first)" "$PRIVATE_TRADING_PARTITION"
assert_value "canary session Quicknet chain" \
    "$(call "$CANARY_SESSION" "quicknetChainHash()(bytes32)" | first)" \
    "$PRIVATE_TRADING_QUICKNET_CHAIN_HASH"
assert_value "canary session fee policy" \
    "$(call "$CANARY_SESSION" "feePolicyDigest()(bytes32)" | first)" \
    "$PRIVATE_TRADING_FEE_POLICY_DIGEST"
assert_value "canary session generation" \
    "$(call "$CANARY_SESSION" "generation()(uint64)")" "$PRIVATE_TRADING_GENERATION"
for immutable in commitBond revealDelay revealWindow roundLength restRounds genesis; do
    case "$immutable" in
        commitBond) account_getter=engineCommitBond engine_type=uint256 ;;
        revealDelay) account_getter=engineRevealDelay engine_type=uint64 ;;
        revealWindow) account_getter=engineRevealWindow engine_type=uint64 ;;
        roundLength) account_getter=engineRoundLength engine_type=uint64 ;;
        restRounds) account_getter=engineRestRounds engine_type=uint64 ;;
        genesis) account_getter=engineGenesis engine_type=uint64 ;;
    esac
    assert_value "canary session engine $immutable snapshot" \
        "$(call "$CANARY_SESSION" "$account_getter()($engine_type)")" \
        "$(call "$VENUE_ENGINE" "$immutable()($engine_type)" | first)"
done

ACTIVE_GATE="$(call "$ZK_KYC_REGISTRY" "gate()(address)" | first)"
if same_address "$ACTIVE_GATE" "$GATE"; then
    assert_value \
        "active gate epoch" \
        "$(call "$ZK_KYC_REGISTRY" "currentEpoch()(uint64)")" \
        "$PRIVATE_TRADING_ACTIVATION_EPOCH"
else
    assert_address \
        "pending gate" \
        "$(call "$ZK_KYC_REGISTRY" "pendingGate()(address)" | first)" "$GATE"
    assert_value \
        "pending gate epoch" \
        "$(call "$ZK_KYC_REGISTRY" "pendingGateEpoch()(uint64)")" \
        "$PRIVATE_TRADING_ACTIVATION_EPOCH"
fi

CONFIG_DIGEST="$CONFIG_DIGEST" python3 - "$CANDIDATE" <<'PY'
import json
import os
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
record = json.loads(path.read_text())
record["context"]["venueConfigDigest"] = os.environ["CONFIG_DIGEST"]
record["verifiedAt"] = __import__("datetime").datetime.now(
    __import__("datetime").timezone.utc
).replace(microsecond=0).isoformat()
record["verification"] = {
    "runtimeCodePresent": True,
    "runtimeCodeHashesRecorded": True,
    "immutablesReadBack": True,
    "factoryVenueConfigApproved": True,
    "registryGateWired": True,
    "lprcCanaryActivated": False,
    "productionReleaseWritten": False,
}
temporary = pathlib.Path(str(path) + ".tmp")
temporary.write_text(json.dumps(record, indent=2) + "\n")
temporary.replace(path)
PY

echo "candidate deployment $CANDIDATE"
echo "factory              $FACTORY"
echo "dual gate            $GATE"
echo "HBAR router          $HBAR_ROUTER"
echo "LPRC router          $LPRC_ROUTER"
echo "recovery router      $RECOVERY_ROUTER"
echo "canary session       $CANARY_SESSION"
echo "next guarded step: create target ATS canary evidence, then activate-lprc"
