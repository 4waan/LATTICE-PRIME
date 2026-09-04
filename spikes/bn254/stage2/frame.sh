set -e
D="$(cd "$(dirname "$0")" && pwd)"; cd "$D/fv"
RPC=http://127.0.0.1:8545
S1="verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[1])"
S5="verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[5])"
eval "$(cat "$D/args.env")"
TV=0x5fbdb2315678afecb367f032d93f642f64180aa3
FV=0xe7f1725e7734ce288f8367e1bb143e90bb3f0512
NOCODE=0x00000000000000000000000000000000cafe0001

ok() { # to sig want args...  -> 0 if the call returns `want`
  local TO=$1 SIG=$2 WANT=$3 GL=$4; shift 4
  local R
  R=$(cast call --rpc-url $RPC --gas-limit $GL "$TO" "$SIG" "$@" 2>/dev/null || echo FAIL)
  [ "$R" = "$WANT" ]
}
# least gas limit at which the call still returns WANT
step() {
  local TO=$1 SIG=$2 WANT=$3; shift 3
  local lo=21000 hi=3000000 mid
  if ok "$TO" "$SIG" "$WANT" $hi "$@"; then :; else echo "NONE"; return; fi
  while [ $((hi-lo)) -gt 1 ]; do
    mid=$(((lo+hi)/2))
    if ok "$TO" "$SIG" "$WANT" $mid "$@"; then hi=$mid; else lo=$mid; fi
  done
  echo $hi
}
ONE=0x0000000000000000000000000000000000000000000000000000000000000001
ZERO=0x0000000000000000000000000000000000000000000000000000000000000000
EMPTY=0x

A=$(step $TV "$S1" $ONE  "${T_VALID[@]}")
B=$(step $NOCODE "$S1" $EMPTY "${T_VALID[@]}")
echo "trivial valid : g*=$A  nocode=$B  frame=$((A-B))"
C=$(step $TV "$S1" $ZERO "${T_NEGA[@]}")
echo "trivial negA  : g*=$C  nocode=$B  frame=$((C-B))"
E=$(step $FV "$S5" $ONE  "${F_VALID[@]}")
F=$(step $NOCODE "$S5" $EMPTY "${F_VALID[@]}")
echo "five valid    : g*=$E  nocode=$F  frame=$((E-F))"
echo "per extra public signal: $(( ( (E-F) - (A-B) ) / 4 ))"
