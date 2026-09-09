#!/usr/bin/env bash
# The recovery for an eligibility grant that has expired, and the preparation
# that turns it from an outage into one command.
#
# ## The cliff this exists for
#
# `ZkKycRegistry` stores a grant stamped with the epoch it was made in and
# compares that stamp against the current epoch **at read time**, so at an epoch
# boundary every grant in the venue dies with no transaction from anyone. Nothing
# emits, nothing warns, and the failure is quiet in the worst way: rounds still
# cross, prints still go out, and `MatchingEngine` emits `SettlementRefused` per
# pair while nothing settles. `RegistrationGate.register` then refuses the
# recovery with `RootNotPublished(e)` unless the issuer has published that
# epoch's credential root, which is a second transaction from a third party.
#
# Epoch 7 of the deployed registry ends at unix 1789230792, which is
# 2026-09-12 16:33:12 UTC.
#
# ## The two halves, and why one of them is done in advance
#
# **Publish the root early.** `publishRoot` is write once per epoch and takes
# any epoch, including a future one, and the credential root does not depend on
# the epoch at all: a leaf is `Poseidon(credentialId, secret, jurisdiction, tier,
# validUntilEpoch)` and there is no epoch in it, so the tree published for epoch
# 7 is bit for bit the tree for epoch 8. `circuits/tree.mjs` says so and this
# script checks it against the chain rather than believing it. So the issuer can
# remove the `RootNotPublished` half of the cliff today, before anyone is
# standing at it.
#
# **Prove early, register late.** Public signal 3 is pinned to
# `registry.currentEpoch()`, so a proof is only good for one epoch and a proof
# for epoch 8 cannot be registered until epoch 8 arrives. It can be *generated*
# whenever, and it takes about twenty-three seconds an address, which is not
# something to start doing at the boundary. `register` refuses a proof for a
# future epoch by the same check that makes holding one safe.
#
#   ./renew-kyc.sh prepare 8      issuer publishes the root for epoch 8
#   make prove-live-epoch EPOCH=8 ADDRS="0x... 0x..."
#   ./renew-kyc.sh renew 8        after the boundary: register everyone
#   ./renew-kyc.sh status         where the clock is and who is still granted
#
# `renew` is permissionless in `msg.sender`: the gate checks the proof, and the
# proof pins the registrant in signal 4. Anybody can pay for anybody's recovery.
set -euo pipefail

cd "$(dirname "$0")/../.."          # venue/
ROOT="$(cd .. && pwd)"

set -a; . "$ROOT/.env"; set +a

_clientAddress() {
    python3 -c 'import json,sys; print(json.load(open("deployments/client.json"))["addresses"][sys.argv[1]])' "$1"
}
ZK_KYC_REGISTRY="${ZK_KYC_REGISTRY:-$(_clientAddress ZkKycRegistry)}"
: "${ZK_KYC_REGISTRY:?set ZK_KYC_REGISTRY}"
RPC="$HEDERA_TESTNET_RPC"

# The gate is whatever the registry says it is, not whatever client.json last
# recorded. After `proposeGate` and `adoptGate` (script/DeployGate.s.sol) the
# two differ until `make client` is rerun, and registering through the old gate
# is a spent transaction that grants nothing: `grant` checks `msg.sender == gate`.
REGISTRATION_GATE="${REGISTRATION_GATE:-$(cast call "$ZK_KYC_REGISTRY" "gate()(address)" --rpc-url "$HEDERA_TESTNET_RPC")}"
: "${REGISTRATION_GATE:?set REGISTRATION_GATE}"
if [ "$(echo "$REGISTRATION_GATE" | tr 'A-Z' 'a-z')" != "$(_clientAddress RegistrationGate | tr 'A-Z' 'a-z')" ]; then
    echo "note: live gate $REGISTRATION_GATE differs from client.json; regenerate with DEPLOY_BOUND=1 make client" >&2
fi

cmd="${1:-status}"
epoch="${2:-}"

# `cast call` prints large integers as "1784392392 [1.784e9]", so every numeric
# read is trimmed to its first field before it reaches arithmetic. Without this
# the shell fails on the exponent in brackets and the message names the bracket
# rather than the cause.
_num() { awk '{print $1}'; }

_currentEpoch() {
    cast call "$ZK_KYC_REGISTRY" "currentEpoch()(uint64)" --rpc-url "$RPC" | _num
}

# Which issuer tree the live gate publishes: "wide" (one credential per
# synthetic participant, the second gate) or "narrow" (the four-leaf fixture
# tree, the first gate). Decided by comparing a root the gate has actually
# published, so the prover and the gate cannot disagree about which tree a
# proof must be made against.
_gateTree() {
    local now e r
    now=$(_currentEpoch)
    for e in "$now" $(( now + 1 )) $(( now - 1 )); do
        r=$(cast call "$REGISTRATION_GATE" "rootForEpoch(uint64)(uint256)" "$e" --rpc-url "$RPC" | _num)
        [ "$r" = "0" ] && continue
        [ "$r" = "$(_issuerRoot "$e" wide)" ] && { echo wide; return; }
        [ "$r" = "$(_issuerRoot "$e")" ] && { echo narrow; return; }
        echo "the gate's root for epoch $e matches neither issuer tree: $r" >&2
        exit 1
    done
    echo "the gate has published no root around epoch $now" >&2
    exit 1
}

_epochEnd() { # <epoch>
    local zero len
    zero=$(cast call "$ZK_KYC_REGISTRY" "epochZero()(uint64)" --rpc-url "$RPC" | _num)
    len=$(cast call "$ZK_KYC_REGISTRY" "epochLength()(uint64)" --rpc-url "$RPC" | _num)
    echo $(( zero + (($1 + 1) * len) ))
}

# The root the issuer's tree produces, computed here rather than copied, so this
# script and the prover cannot publish two different trees.
_issuerRoot() { # <epoch> [wide]
    . "$HOME/.nvm/nvm.sh" >/dev/null && nvm use 22.21.1 >/dev/null
    node -e '
      import("./circuits/tree.mjs").then(async (m) => {
        const t = await m.buildTree(process.argv[1], {wide: process.argv[2] === "wide"});
        console.log(t.root.toString());
      });
    ' "${1:-7}" "${2:-narrow}"
}

case "$cmd" in

status)
    now=$(_currentEpoch)
    ends=$(_epochEnd "$now")
    left=$(( ends - $(date -u +%s) ))
    echo "kyc epoch        $now"
    echo "ends at          $ends  ($(date -u -r "$ends" '+%Y-%m-%d %H:%M:%S UTC'))"
    printf 'time remaining   %dd %02dh %02dm\n' $((left/86400)) $((left%86400/3600)) $((left%3600/60))
    echo "gate             $REGISTRATION_GATE  ($(_gateTree) tree)"
    pending=$(cast call "$ZK_KYC_REGISTRY" "pendingGate()(address)" --rpc-url "$RPC")
    if [ "$pending" != "0x0000000000000000000000000000000000000000" ]; then
        echo "pending gate     $pending  adoptable from epoch $(cast call "$ZK_KYC_REGISTRY" "pendingGateEpoch()(uint64)" --rpc-url "$RPC" | _num)"
        echo "                 (the pending gate's own roots are what matter after adoption; check them there)"
    fi
    for e in "$now" $(( now + 1 )) $(( now + 2 )); do
        r=$(cast call "$REGISTRATION_GATE" "rootForEpoch(uint64)(uint256)" "$e" --rpc-url "$RPC" | _num)
        if [ "$r" = "0" ]; then
            echo "root epoch $e     NOT PUBLISHED  -> register reverts RootNotPublished($e)"
        else
            echo "root epoch $e     published"
        fi
    done
    for addr in $(python3 -c "
import json
d = json.load(open('deployments/296-venue.json'))
print(' '.join(d['actors']['registrations'].keys()))
"); do
        echo "  $addr  getKycStatus $(cast call "$ZK_KYC_REGISTRY" "getKycStatus(address)(uint8)" "$addr" --rpc-url "$RPC")"
    done
    ;;

prepare)
    : "${epoch:?usage: renew-kyc.sh prepare <epoch>}"
    existing=$(cast call "$REGISTRATION_GATE" "rootForEpoch(uint64)(uint256)" "$epoch" --rpc-url "$RPC" | _num)
    tree=$(_gateTree)
    root=$(_issuerRoot "$epoch" "$tree")
    echo "issuer root for epoch $epoch ($tree tree)  $root"
    if [ "$existing" != "0" ]; then
        # Write once per epoch, by design: a root that could be replaced mid
        # epoch would let the issuer revoke inside one, which contradicts the
        # stated revocation latency. So this is a check, never an overwrite.
        [ "$existing" = "$root" ] \
            && { echo "already published, and it matches. nothing to do"; exit 0; } \
            || { echo "PUBLISHED ROOT DIFFERS: on chain $existing" >&2; exit 1; }
    fi
    issuer=$(cast call "$REGISTRATION_GATE" "issuer()(address)" --rpc-url "$RPC" | tr 'A-Z' 'a-z')
    me=$(cast wallet address --private-key "$HEDERA_PRIVATE_KEY" | tr 'A-Z' 'a-z')
    [ "$issuer" = "$me" ] || { echo "publishRoot is the issuer's: $issuer" >&2; exit 1; }

    cast send "$REGISTRATION_GATE" "publishRoot(uint64,uint256)" "$epoch" "$root" \
        --private-key "$HEDERA_PRIVATE_KEY" --rpc-url "$RPC" --timeout 300
    echo "rootForEpoch($epoch) -> $(cast call "$REGISTRATION_GATE" "rootForEpoch(uint64)(uint256)" "$epoch" --rpc-url "$RPC" | _num)"
    ;;

renew)
    : "${epoch:?usage: renew-kyc.sh renew <epoch>}"
    now=$(_currentEpoch)
    [ "$now" = "$epoch" ] || {
        echo "the registry is in epoch $now, not $epoch. register pins signal 3 to the" >&2
        echo "current epoch, so a proof for $epoch is refused EpochMismatch until then." >&2
        exit 1
    }
    # A proof is bound to a root as well as an epoch, so the file must match
    # the tree the live gate published, not merely the epoch.
    tree=$(_gateTree)
    if [ "$tree" = "wide" ]; then
        PROOFS="deployments/proofs-live-epoch${epoch}-wide.json"
        [ -f "$PROOFS" ] || {
            echo "no wide-tree proofs for epoch $epoch. run:" >&2
            echo "  node circuits/prove-live.mjs --epoch $epoch --wide --cred valid 0x... 0x..." >&2
            exit 1
        }
    else
        PROOFS="deployments/proofs-live-epoch${epoch}.json"
        [ -f "$PROOFS" ] || PROOFS="deployments/proofs-live.json"
        [ -f "$PROOFS" ] || {
            echo "no proofs for epoch $epoch. run:" >&2
            echo "  make prove-live-epoch EPOCH=$epoch ADDRS=\"0x... 0x...\"" >&2
            exit 1
        }
    fi
    echo "proofs from $PROOFS  (gate $REGISTRATION_GATE, $tree tree)"
    PROOFS="$PROOFS" REGISTRATION_GATE="$REGISTRATION_GATE" ZK_KYC_REGISTRY="$ZK_KYC_REGISTRY" \
        exec bash script/live/register.sh
    ;;

*)
    echo "usage: renew-kyc.sh {status|prepare <epoch>|renew <epoch>}" >&2
    exit 1
    ;;
esac
