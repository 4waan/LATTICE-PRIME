set -e
cd "$(dirname "$0")"
RPC=${RPC:-https://testnet.hashio.io/api}
KEYFILE=${KEYFILE:-$HOME/.hedera-testnet-key}
K="$(cat $KEYFILE)"
ADDR=$(cast wallet address --private-key "$K")
S1="verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[1])"
S5="verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[5])"
SC="verify(uint256[2],uint256[2][2],uint256[2],uint256[1])"
eval "$(cat args.env)"
TV=${TV:?}; FV=${FV:?}; GV=${GV:?}

echo "Spike 1 stage 2 on Hedera testnet (296). Every gas number below is"
echo "consensus recorded: receipt.gasUsed from a transaction, not eth_call,"
echo "not gasleft(). Contracts:"
echo "  TrivialVerifier  $TV"
echo "  FiveVerifier     $FV"
echo "  GuardedVerifier  $GV"
echo
printf "  %-34s %-9s %-10s %s\n" "case" "gasUsed" "limit" "returns"

row() { # label to sig gaslimit args...
  local L="$1" TO="$2" SIG="$3" GL="$4"; shift 4
  local RET N R G ST D
  RET=$(cast call --rpc-url $RPC --gas-limit $GL "$TO" "$SIG" "$@" 2>&1 | tr -d '\n ')
  N=$(cast nonce --rpc-url $RPC $ADDR)
  R=$(cast send --rpc-url $RPC --private-key "$K" --gas-limit $GL --nonce $N --json "$TO" "$SIG" "$@" 2>/dev/null || echo '{}')
  G=$(echo "$R" | jq -r '.gasUsed // "0x0"'); ST=$(echo "$R" | jq -r '.status // "?"')
  case "$RET" in
    *00000001) D=true ;;
    *00000000) D=false ;;
    *) D="$(echo $RET | cut -c1-30)" ;;
  esac
  case "${#RET}" in 130)
    case "$RET" in
      *0000000000000000000000000000000000000000000000000000000000000001) D="ran=true  ok=true" ;;
      *) D="ran=$(echo $RET|cut -c3-66|grep -q '1$' && echo true || echo false)  ok=false" ;;
    esac ;;
  esac
  printf "  %-34s %-9s %-10s %s\n" "$L" "$((G))" "$GL" "$D"
  sleep 1
}

echo "-- generated verifier, unmodified --"
row "valid proof"           $TV "$S1" 300000  "${T_VALID[@]}"
row "A negated (on curve)"  $TV "$S1" 300000  "${T_NEGA[@]}"
row "wrong public signal"   $TV "$S1" 300000  "${T_WRONGSIG[@]}"
row "public signal == r"    $TV "$S1" 300000  "${T_SIGATR[@]}"
echo "-- 5 public signals --"
row "valid proof"           $FV "$S5" 320000  "${F_VALID[@]}"
echo "-- the malformed input burn, at Hedera's 15,000,000 ceiling --"
row "A off curve (1,1)"     $TV "$S1" 15000000 "${T_OFFCURVE[@]}"
echo "-- GuardedVerifier, on-curve check then capped call --"
row "valid proof"           $GV "$SC" 300000  "${T_VALID[@]}"
row "A negated"             $GV "$SC" 300000  "${T_NEGA[@]}"
row "A off curve (1,1)"     $GV "$SC" 15000000 "${T_OFFCURVE[@]}"
