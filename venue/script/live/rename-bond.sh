#!/usr/bin/env bash
# Rename the live ATS bond, in place, without redeploying the venue.
#
# ## Why this is a script and not a redeploy
#
# D-25 renamed the project from SeamMe to Lattice Prime. The instrument carried
# the old name in its ERC-20 metadata, and every HashScan link a reader follows
# during the Hedera beat resolves to that metadata, so leaving it would put the
# superseded name on the one surface whose whole job is that it can be checked.
#
# The obvious reading is that this costs a redeploy, and it does not. ATS puts
# `setName` and `setSymbol` on the Core facet, both gated on `ROLE_TREX_OWNER`,
# and `script/DeployAtsBond.s.sol` already grants that role to the deployer in
# `_rbacs`. Two transactions against the existing token, no new address, no
# rewiring.
#
# What a redeploy would have cost, for the record: `SeamJournal.token` is
# immutable and the journal is the token's only accepted compliance caller, so a
# new token forces a new journal, a new `MatchingEngine`, a new `VolumeCap`, and
# `Regime.bootstrapSupervisor` is single-use so it forces a new regime and a new
# parameter root beneath it. That is the tinybars cascade again, and it would
# invalidate every hash in `deployments/receipt-beat.json`.
#
# ## What this does not touch
#
# The ISIN. `XS0SEAMME017` still spells the old name and ATS exposes no setter
# for it, so on the live token it is immutable. That is also correct: an ISIN is
# assigned once by a numbering agency and survives an issuer renaming the
# instrument. Changing it would assert a different bond. See the constant's
# docstring in `script/DeployAtsBond.s.sol`.
#
# ## Usage
#
#   script/live/rename-bond.sh status    read metadata, role and pause state
#   script/live/rename-bond.sh apply     send the two transactions, then verify
#
# `status` sends nothing and is safe to run at any time. Run it first: `setName`
# carries `onlyOperational onlyActivated onlyUnpaused`, so a paused or
# deactivated token refuses both writes and the revert is not self-explanatory.

set -euo pipefail
cd "$(dirname "$0")/../.."          # venue/
ROOT="$(cd .. && pwd)"
set -a; . "$ROOT/.env"; set +a
: "${HEDERA_TESTNET_RPC:?set HEDERA_TESTNET_RPC}"
: "${HEDERA_PRIVATE_KEY:?set HEDERA_PRIVATE_KEY}"

# Read from the deployment record rather than pasted, so this script and
# 296-venue.json cannot disagree about which token is being renamed.
TOKEN=$(python3 -c "import json;print(json.load(open('deployments/296-venue.json'))['token']['address'])")
TOKEN_ID=$(python3 -c "import json;print(json.load(open('deployments/296-venue.json'))['token']['contractId'])")

# keccak256("TREX_OWNER_ROLE") as ATS pins it in constants/roles.sol. Copied from
# script/DeployAtsBond.s.sol rather than recomputed, so the two cannot drift.
ROLE_TREX_OWNER=0xd9e1264632ee9a37e8673a0c55a0a1d8b38c758e843084168ee08cd2d1f7e6f0

NEW_NAME="Lattice Prime Repo Collateral 2028"
NEW_SYMBOL="LPRC"

SENDER=$(cast wallet address --private-key "$HEDERA_PRIVATE_KEY")
call() { cast call "$TOKEN" "$1" "${@:2}" --rpc-url "$HEDERA_TESTNET_RPC"; }

read_state() {
    NAME_NOW=$(call 'name()(string)' | sed 's/^"//; s/"$//')
    SYM_NOW=$(call 'symbol()(string)' | sed 's/^"//; s/"$//')
    HAS_ROLE=$(call 'hasRole(bytes32,address)(bool)' "$ROLE_TREX_OWNER" "$SENDER")
    # `paused()` on the Pause facet. `isPaused()` is IExternalPause, a different
    # contract, and calling it here returns nothing.
    PAUSED=$(call 'paused()(bool)' 2>/dev/null || echo "unreadable")
}

echo "token      $TOKEN  ($TOKEN_ID)"
echo "sender     $SENDER"
read_state
echo "name       $NAME_NOW"
echo "symbol     $SYM_NOW"
echo "trexOwner  $HAS_ROLE"
echo "paused     $PAUSED"
echo

case "${1:-status}" in
status)
    if [ "$NAME_NOW" = "$NEW_NAME" ] && [ "$SYM_NOW" = "$NEW_SYMBOL" ]; then
        echo "already renamed. nothing to do."
        exit 0
    fi
    echo "would set name   -> $NEW_NAME"
    echo "would set symbol -> $NEW_SYMBOL"
    [ "$HAS_ROLE" = "true" ] || echo "BLOCKED: sender does not hold ROLE_TREX_OWNER"
    [ "$PAUSED" = "true" ] && echo "BLOCKED: token is paused, both writes carry onlyUnpaused"
    echo
    echo "run 'script/live/rename-bond.sh apply' to send."
    ;;
apply)
    [ "$HAS_ROLE" = "true" ] || { echo "refusing: sender does not hold ROLE_TREX_OWNER"; exit 1; }
    [ "$PAUSED" = "true" ] && { echo "refusing: token is paused"; exit 1; }

    OUT=deployments/.rename-bond
    mkdir -p "$OUT"

    echo "setName..."
    cast send "$TOKEN" 'setName(string)' "$NEW_NAME" \
        --private-key "$HEDERA_PRIVATE_KEY" --rpc-url "$HEDERA_TESTNET_RPC" \
        --json --timeout 300 > "$OUT/setName.json"
    python3 script/live/_txline.py "$OUT/setName.json" setName

    echo "setSymbol..."
    cast send "$TOKEN" 'setSymbol(string)' "$NEW_SYMBOL" \
        --private-key "$HEDERA_PRIVATE_KEY" --rpc-url "$HEDERA_TESTNET_RPC" \
        --json --timeout 300 > "$OUT/setSymbol.json"
    python3 script/live/_txline.py "$OUT/setSymbol.json" setSymbol

    # Read back from the chain rather than trusting the receipts. A status 1 on
    # a diamond means the facet did not revert, not that storage says what was
    # asked for.
    echo
    read_state
    echo "name       $NAME_NOW"
    echo "symbol     $SYM_NOW"
    [ "$NAME_NOW" = "$NEW_NAME" ] || { echo "MISMATCH: name did not take"; exit 1; }
    [ "$SYM_NOW" = "$NEW_SYMBOL" ] || { echo "MISMATCH: symbol did not take"; exit 1; }
    echo
    echo "renamed on chain. update deployments/296-venue.json token.name and token.symbol."
    ;;
*)
    echo "usage: rename-bond.sh [status|apply]" >&2
    exit 2
    ;;
esac
