#!/usr/bin/env bash
# Registers every address in deployments/proofs-live.json against the live
# RegistrationGate, one transaction each.
#
# This is a shell script and not a forge script on purpose. `register` takes
# `uint256[24]` and `uint256[7]`, and the proofs arrive as JSON written by
# snarkjs. Foundry's `parseJson` can be made to read fixed-size arrays of
# uint256 out of a file, but the failure mode when it cannot is a decoding
# error inside a broadcast, which is a spent transaction. `cast send` takes the
# arrays on the command line, so a malformed one fails before it costs
# anything.
#
# `register` is permissionless in `msg.sender`: the gate checks the proof, and
# the proof pins the registrant in public signal 4. The operator paying for
# somebody else's registration is the HIP-410 relay shape, and it is why every
# one of these is sent from the deployer.
set -euo pipefail

cd "$(dirname "$0")/../.."          # venue/
ROOT="$(cd .. && pwd)"

set -a; . "$ROOT/.env"; set +a
: "${REGISTRATION_GATE:?set REGISTRATION_GATE}"
: "${ZK_KYC_REGISTRY:?set ZK_KYC_REGISTRY}"

PROOFS=deployments/proofs-live.json
[ -f "$PROOFS" ] || { echo "no $PROOFS; run circuits/prove-live.mjs first" >&2; exit 1; }

for addr in $(python3 -c "import json;print(' '.join(json.load(open('$PROOFS'))))"); do
    status=$(cast call "$ZK_KYC_REGISTRY" "getKycStatus(address)(uint8)" "$addr" \
        --rpc-url "$HEDERA_TESTNET_RPC")
    if [ "$status" = "1" ]; then
        echo "$addr  already granted, skipping"
        continue
    fi

    proof=$(python3 -c "import json;print('['+','.join(json.load(open('$PROOFS'))['$addr']['proof'])+']')")
    pub=$(python3 -c "import json;print('['+','.join(json.load(open('$PROOFS'))['$addr']['pub'])+']')")

    # Ask the gate first. `wouldAccept` duplicates the gate's own checks
    # deliberately, so a disagreement between the two shows up here rather than
    # as a revert.
    verdict=$(cast call "$REGISTRATION_GATE" \
        "wouldAccept(address,uint256[7])(bool,string)" "$addr" "$pub" \
        --rpc-url "$HEDERA_TESTNET_RPC")
    echo "$addr  wouldAccept -> $(echo "$verdict" | tr '\n' ' ')"
    case "$verdict" in true*) ;; *) echo "  refused, not sending" >&2; continue;; esac

    tx=$(cast send "$REGISTRATION_GATE" \
        "register(address,uint256[24],uint256[7])" "$addr" "$proof" "$pub" \
        --private-key "$HEDERA_PRIVATE_KEY" --rpc-url "$HEDERA_TESTNET_RPC" \
        --json --timeout 300)
    echo "  tx     $(echo "$tx" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["transactionHash"], "gas", int(d["gasUsed"],16), "status", d["status"])')"
    echo "  status $(cast call "$ZK_KYC_REGISTRY" "getKycStatus(address)(uint8)" "$addr" --rpc-url "$HEDERA_TESTNET_RPC")"
done
