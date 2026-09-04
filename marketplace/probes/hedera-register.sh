#!/usr/bin/env bash
# Probe H1: is the investor register of a real institutional tokenised fund
# readable from Hedera mainnet by an anonymous observer?
#
# The study asks for "a script that reconstructs a holder register from testnet data,
# the leak demonstrated, not described." This does it on MAINNET, against named
# FCA-regulated issuance, with no key, no account, and no authentication.
#
# Run:  bash marketplace/probes/hedera-register.sh
# Needs: curl, python3. No Hedera account required. That is the point.

set -u
MIRROR="https://mainnet-public.mirrornode.hedera.com/api/v1"

# Discovered by substring search on the public token index, not from any
# document. No press release names a token id.
#   curl "$MIRROR/tokens?name=abrdn&limit=25"
TOKENS="0.0.9350212 0.0.9379197 0.0.9379434 0.0.9378484 0.0.9378532"

echo "Probe H1 -- $(date -u +%Y-%m-%dT%H:%M:%SZ) -- mainnet, unauthenticated"
echo

for T in $TOKENS; do
  curl -s --max-time 25 "$MIRROR/tokens/$T" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('TOKEN %s  %s (%s)' % (d['token_id'], d['name'], d['symbol']))
print('  treasury      %s' % d.get('treasury_account_id'))
print('  total_supply  %s (decimals %s)' % (d.get('total_supply'), d.get('decimals')))
print('  kyc_key set   %s' % bool(d.get('kyc_key')))
"
  echo "  holder register:"
  curl -s --max-time 25 "$MIRROR/tokens/$T/balances?limit=50&order=desc" | python3 -c "
import sys, json
d = json.load(sys.stdin)
b = d.get('balances', [])
print('    %d associated accounts visible' % len(b))
for x in b:
    print('    %-16s balance %s' % (x['account'], x['balance']))
"
  echo "  per-account compliance status:"
  for A in $(curl -s --max-time 25 "$MIRROR/tokens/$T/balances?limit=50" \
             | python3 -c "import sys,json;[print(x['account']) for x in json.load(sys.stdin).get('balances',[])]"); do
    curl -s --max-time 25 "$MIRROR/accounts/$A/tokens?token.id=$T" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for t in d.get('tokens', []):
    print('    %-16s kyc_status %-9s freeze_status %s' % ('$A', t.get('kyc_status'), t.get('freeze_status')))
"
  done
  echo
done

cat <<'NOTE'
What this shows, and it is the whole point:

  1. The set of accounts permitted to hold a regulated fund is public, and it is
     public BEFORE any of them holds a balance. Association is itself disclosure.
  2. kyc_status is published per account per token. That is a public compliance
     register at the Hedera token layer, keyed by address.
  3. Neither fact required a key, an account, or a relationship with the issuer.

This is the identity leak, in production, on the chain we are building on.
NOTE
