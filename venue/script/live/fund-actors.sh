#!/usr/bin/env bash
# Funds the two counterparty accounts so the venue has traders that are not the
# operator.
#
# Two addresses, generated locally, keys in `.env.venue-actors` which `.gitignore`
# excludes by `.env.*`. They exist because a market with one participant is not a
# market: the seller creates the hold, the buyer escrows cash, and the engine
# crosses them. The operator can be neither without the demonstration being
# circular.
#
# On Hedera a transfer to an EVM address that has no account creates a hollow
# account for it (HIP-583), so this is both the funding and the account
# creation. Amounts are small and come from the deployer's faucet balance.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(cd .. && pwd)"
set -a; . "$ROOT/.env"; . "$ROOT/.env.venue-actors"; set +a

AMOUNT="${AMOUNT:-60ether}"

for role in SELLER BUYER; do
    addr_var="${role}_ADDRESS"
    addr="${!addr_var}"
    bal=$(cast balance "$addr" --rpc-url "$HEDERA_TESTNET_RPC")
    if [ "$bal" != "0" ]; then
        echo "$role $addr already funded: $(cast to-unit "$bal" ether) HBAR"
        continue
    fi
    echo "$role $addr funding $AMOUNT"
    cast send "$addr" --value "$AMOUNT" \
        --private-key "$HEDERA_PRIVATE_KEY" --rpc-url "$HEDERA_TESTNET_RPC" \
        --timeout 300 >/dev/null
    echo "  balance $(cast to-unit "$(cast balance "$addr" --rpc-url "$HEDERA_TESTNET_RPC")" ether) HBAR"
done
