#!/usr/bin/env bash
# Drives one repo trade end to end on Hedera testnet and prints what each seam
# did, so the claims in docs/CALLSTACK.md are checkable against a chain rather
# than against a suite.
#
# A shell script and not a forge script because three of the steps are waits.
# `reveal` opens `revealDelay` seconds after `commit` and `crossRound` refuses
# until the round is over. A broadcast cannot sleep, and a venue whose operator
# could skip those waits would not have them.
#
# Phases, runnable one at a time with PHASE=<name>:
#   issue    seam D refuses an unregistered holder, then admits a registered one
#   hold     the seller encumbers the lot with the engine as escrow
#   commit   both sides post sealed orders
#   reveal   both sides open them, the seller against the hold
#   cross    the round clears and the lot moves on the real ATS token
#   all      every phase in order, with the waits
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(cd .. && pwd)"
set -a; . "$ROOT/.env"; . "$ROOT/.env.venue-actors"; set +a

: "${ATS_TOKEN:?}" "${VENUE_ENGINE:?}" "${ZK_KYC_REGISTRY:?}" "${VENUE_JOURNAL:?}"
RPC="$HEDERA_TESTNET_RPC"
PARTITION=0x0000000000000000000000000000000000000000000000000000000000000001
PHASE="${PHASE:-all}"

# Matches DeployVenue. Kept here rather than read off chain because a mismatch
# should be loud: if these drift the reveal lands outside its window and the
# failure names the window rather than the drift.
DELAY=30
ROUND=300

# Two denominations, and conflating them is what broke the first venue.
# `msg.value` inside the Hedera EVM is TINYBARS: 1 HBAR is 1e8. The JSON-RPC
# `value` field, which is what `cast --value` sets, is WEIBARS: 1 HBAR is 1e18.
# The relay divides by 1e10 on the way in. So every amount the contracts reason
# about is tinybars and every amount handed to `cast` is that number times
# TINYBAR. Contract-side constants carry no suffix; anything passed to `cast`
# goes through `weibar()`.
TINYBAR=10000000000
weibar() { python3 -c "print($1 * $TINYBAR)"; }

BOND=1000000                  # 0.01 HBAR, and this is DeployVenue's BOND
QTY=1000
SELL_PRICE=95
BUY_PRICE=105
SALT_S=0x7300000000000000000000000000000000000000000000000000000000000000
SALT_B=0x6200000000000000000000000000000000000000000000000000000000000000

say() { printf '\n=== %s\n' "$*"; }
call() { cast call "$@" --rpc-url "$RPC"; }
send() { cast send "$@" --rpc-url "$RPC" --timeout 300 --json | python3 -c \
  'import sys,json;d=json.load(sys.stdin);print("  tx",d["transactionHash"],"gas",int(d["gasUsed"],16),"status",d["status"])'; }

phase_issue() {
    say "seam D, the refusal"
    # An address with no credential. The registry answers NOT_GRANTED by the
    # zero value rather than by a branch, and ATS turns that into a revert
    # before any balance is written.
    local stranger=0x000000000000000000000000000000000000dEaD
    echo "  getKycStatus(stranger) = $(call "$ZK_KYC_REGISTRY" 'getKycStatus(address)(uint8)' $stranger)"
    # `--from` matters. Without it `msg.sender` is the zero address, the role
    # check fires first and the call reverts `AccountHasNoRole` rather than on
    # eligibility. That is the wrong refusal to demonstrate: it says nothing
    # about the registry. Sending as the issuer puts the KYC check on the
    # critical path, where `InvalidKycStatus()` names the offending address.
    if call "$ATS_TOKEN" 'issue(address,uint256,bytes)' $stranger 1 0x \
        --from "$HEDERA_EVM_ADDRESS" 2>&1 | head -3; then
        echo "  UNEXPECTED: the issue simulated clean" >&2; exit 1
    fi
    echo "  0xfc855b1b is InvalidKycStatus(); the argument is the refused address"

    say "seam D, the admission"
    echo "  getKycStatus(seller)   = $(call "$ZK_KYC_REGISTRY" 'getKycStatus(address)(uint8)' "$SELLER_ADDRESS")"
    send "$ATS_TOKEN" 'issue(address,uint256,bytes)' "$SELLER_ADDRESS" $((QTY * 4)) 0x \
        --private-key "$HEDERA_PRIVATE_KEY"
    echo "  seller balance $(call "$ATS_TOKEN" 'balanceOf(address)(uint256)' "$SELLER_ADDRESS")"
    echo "  total supply   $(call "$ATS_TOKEN" 'totalSupply()(uint256)')"
}

phase_hold() {
    say "the lot is encumbered, engine as escrow"
    local expiry=$(( $(date +%s) + 30 * 86400 ))
    # Read the id the token is about to assign, then take it. `createHoldByPartition`
    # returns it and a broadcast cannot see a return value.
    local predicted
    predicted=$(call "$ATS_TOKEN" \
        'createHoldByPartition(bytes32,(uint256,uint256,address,address,bytes))(bool,uint256)' \
        $PARTITION "($QTY,$expiry,$VENUE_ENGINE,0x0000000000000000000000000000000000000000,0x)" \
        --from "$SELLER_ADDRESS" | tail -1)
    echo "  hold id will be $predicted"
    send "$ATS_TOKEN" \
        'createHoldByPartition(bytes32,(uint256,uint256,address,address,bytes))' \
        $PARTITION "($QTY,$expiry,$VENUE_ENGINE,0x0000000000000000000000000000000000000000,0x)" \
        --private-key "$SELLER_PRIVATE_KEY"
    echo "$predicted" > /tmp/seamme-holdid
    echo "  hold now reads: $(call "$ATS_TOKEN" \
        'getHoldForByPartition((bytes32,address,uint256))(uint256,uint256,address,address,bytes,bytes,uint8)' \
        "($PARTITION,$SELLER_ADDRESS,$predicted)" | tr '\n' ' ')"
}

phase_commit() {
    say "two sealed orders"
    local ids sid bid
    sid=$(call "$VENUE_ENGINE" 'commitmentOf(address,uint8,uint128,uint128,bytes32)(bytes32)' \
        "$SELLER_ADDRESS" 1 $SELL_PRICE $QTY $SALT_S)
    bid=$(call "$VENUE_ENGINE" 'commitmentOf(address,uint8,uint128,uint128,bytes32)(bytes32)' \
        "$BUYER_ADDRESS" 0 $BUY_PRICE $QTY $SALT_B)
    echo "  sell commitment $sid"
    echo "  buy  commitment $bid"
    send "$VENUE_ENGINE" 'commit(bytes32)' "$sid" --value "$(weibar $BOND)" --private-key "$SELLER_PRIVATE_KEY"
    send "$VENUE_ENGINE" 'commit(bytes32)' "$bid" --value "$(weibar $BOND)" --private-key "$BUYER_PRIVATE_KEY"
    echo "  round $(call "$VENUE_ENGINE" 'currentRound()(uint64)')"
}

phase_reveal() {
    say "both sides open, the seller against the hold"
    local holdid; holdid=$(cat /tmp/seamme-holdid)
    send "$VENUE_ENGINE" 'reveal(uint8,uint128,uint128,bytes32,uint256)' \
        1 $SELL_PRICE $QTY $SALT_S "$holdid" --private-key "$SELLER_PRIVATE_KEY"
    send "$VENUE_ENGINE" 'reveal(uint8,uint128,uint128,bytes32,uint256)' \
        0 $BUY_PRICE $QTY $SALT_B 0 --value "$(weibar $((BUY_PRICE * QTY)))" --private-key "$BUYER_PRIVATE_KEY"
    echo "  revealed $(call "$VENUE_ENGINE" 'revealedCount()(uint256)')"
    call "$VENUE_ENGINE" 'currentRound()(uint64)' > /tmp/seamme-round
    echo "  round $(cat /tmp/seamme-round)"
    echo "  quote $(call "$VENUE_ENGINE" 'quote(uint64)(bool,uint256,uint256)' "$(cat /tmp/seamme-round)" | tr '\n' ' ')"
}

phase_cross() {
    say "the round clears"
    local r; r=$(cat /tmp/seamme-round)
    send "$VENUE_ENGINE" 'crossRound(uint64)' "$r" --private-key "$HEDERA_PRIVATE_KEY"
    echo "  seller bond balance $(call "$ATS_TOKEN" 'balanceOf(address)(uint256)' "$SELLER_ADDRESS")"
    echo "  buyer  bond balance $(call "$ATS_TOKEN" 'balanceOf(address)(uint256)' "$BUYER_ADDRESS")"
    echo "  seller credit       $(call "$VENUE_ENGINE" 'credit(address)(uint256)' "$SELLER_ADDRESS")"
    echo "  buyer  credit       $(call "$VENUE_ENGINE" 'credit(address)(uint256)' "$BUYER_ADDRESS")"
}

case "$PHASE" in
    issue)  phase_issue ;;
    hold)   phase_hold ;;
    commit) phase_commit ;;
    reveal) phase_reveal ;;
    cross)  phase_cross ;;
    all)
        phase_issue; phase_hold; phase_commit
        say "waiting ${DELAY}s for the reveal window"; sleep $((DELAY + 5))
        phase_reveal
        say "waiting ${ROUND}s for the round to end"; sleep $((ROUND + 5))
        phase_cross ;;
    *) echo "unknown PHASE $PHASE" >&2; exit 1 ;;
esac
