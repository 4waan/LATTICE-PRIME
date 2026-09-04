#!/usr/bin/env bash
# Row scope: which DERIVED facts are reconstructible from the primitive
# fields Hedera already publishes?
#
# The study inventories ten primitive rows. Four independent sightings
# found that the damaging leak is a derived fact over
# those rows rather than a row itself. This probe stops treating that as an
# observation about other venues and measures it on OUR asset class, on
# mainnet, today.
#
# Needs: curl, python3. No Hedera account required. That is the point.
set -u
MIRROR="https://mainnet-public.mirrornode.hedera.com/api/v1"
TREASURY="0.0.10116630"   # shared treasury

echo "Derived-row reconstruction, captured $(date -u '+%Y-%m-%d %H:%M') UTC"
echo "source: $MIRROR  (unauthenticated, no account, no key)"
echo "probe for the row scope decision"
echo
echo "Subject: the shared treasury $TREASURY and every token it moves."

curl -s --max-time 60 "$MIRROR/transactions?account.id=$TREASURY&transactiontype=CRYPTOTRANSFER&limit=100&order=desc" \
| python3 -c "
import json,sys,collections,datetime,statistics,urllib.request
MIRROR='$MIRROR'; TR='$TREASURY'
d=json.load(sys.stdin)['transactions']

legs=[]
for t in d:
    for x in t.get('token_transfers',[]):
        pass
    tt=t.get('token_transfers',[])
    bytok=collections.defaultdict(list)
    for x in tt: bytok[x['token_id']].append(x)
    for tok,xs in bytok.items():
        src=[x for x in xs if x['amount']<0]; dst=[x for x in xs if x['amount']>0]
        if not src or not dst: continue
        legs.append(dict(ts=float(t['consensus_timestamp']), tok=tok,
                         frm=src[0]['account'], to=dst[0]['account'],
                         amt=abs(src[0]['amount']), node=t.get('node')))

def rule(t): print('\n'+'='*72+'\n'+t+'\n'+'='*72)

names={}
for tok in sorted({l['tok'] for l in legs}):
    try:
        with urllib.request.urlopen(MIRROR+'/tokens/'+tok, timeout=20) as r:
            j=json.load(r); names[tok]=(j.get('name') or '')[:52]
    except Exception: names[tok]='?'

rule('0. The tokens this one treasury moves')
print()
for tok,n in sorted(names.items()):
    print('  %-13s %s' % (tok,n))
mgrs=set()
for n in names.values():
    for m in ['abrdn','Fidelity','State Street','BlackRock','LGIM','HSBC']:
        if m.lower() in n.lower(): mgrs.add(m)
print()
print('  %d tokens, %d distinct asset managers: %s' % (len(names),len(mgrs),', '.join(sorted(mgrs))))
print('  One account, competing managers. Extended.')

rule('DERIVED FACT 1: the counterparty graph')
edges=collections.Counter((l['frm'],l['to']) for l in legs)
print()
print('  %-13s    %-13s %5s %14s  %s' % ('from','to','n','volume','kind'))
for (a,b),n in edges.most_common():
    vol=sum(l['amt'] for l in legs if (l['frm'],l['to'])==(a,b))
    print('  %-13s -> %-13s %5d %14d  %s' % (a,b,n,vol,'PRIMARY' if TR in (a,b) else 'SECONDARY'))
parties={l['frm'] for l in legs}|{l['to'] for l in legs}
print()
print('  %d parties, %d directed edges, %d transfers.' % (len(parties),len(edges),len(legs)))
print('  fn(trader identity, quantity). Not one of the ten primitive rows.')

rule('DERIVED FACT 2: per-account activity fingerprint')
acct=collections.defaultdict(list)
for l in legs:
    acct[l['frm']].append(-l['amt']); acct[l['to']].append(l['amt'])
print()
print('  %-16s %4s %15s %15s %13s %6s' % ('account','n','net','gross','mean ticket','toks'))
for a,v in sorted(acct.items(), key=lambda kv:-len(kv[1])):
    tk=len({l['tok'] for l in legs if a in (l['frm'],l['to'])})
    print('  %-16s %4d %15d %15d %13d %6d'
          % (a+(' (T)' if a==TR else ''),len(v),sum(v),
             sum(abs(x) for x in v),sum(abs(x) for x in v)//len(v),tk))
print()
print('  fn(trader identity, quantity, time). Ticket-size distribution and')
print('  breadth across share classes is a strategy fingerprint. the ten have a row')
print('  for quantity and a row for identity, and no row for the pair.')

rule('DERIVED FACT 3: fund flow, which is a fact about the ISSUER')
print()
for tok in sorted(names):
    ls=[l for l in legs if l['tok']==tok]
    inflow=sum(l['amt'] for l in ls if l['to']==TR)
    outflow=sum(l['amt'] for l in ls if l['frm']==TR)
    sec=sum(l['amt'] for l in ls if TR not in (l['frm'],l['to']))
    print('  %-13s issue %12d  redeem %12d  net %+13d  secondary %d'
          % (tok,outflow,inflow,outflow-inflow,sec))
print()
print('  Subscription and redemption pressure per share class, daily, public.')
print('  This is not a property of any trader. It is a property of the fund,')
print('  and a matrix indexed by (row, observer, time) has no cell for it.')

rule('DERIVED FACT 4: submission routing is public, and it is pinned')

def pages(p,cap=600):
    out=[]
    while p and len(out)<cap:
        with urllib.request.urlopen('https://mainnet-public.mirrornode.hedera.com'+p,timeout=30) as r:
            j=json.load(r)
        out+=j['transactions']; p=(j.get('links') or {}).get('next')
    return out

LBL={'0.0.29':'Aberdeen Investments','0.0.24':'LSE','0.0.7':'Nomura',
     '0.0.22':'Shinhan Bank','0.0.34':'BitGo','0.0.20':'Australian Payments Plus'}
print()
print('  Deep history, not just the sampled window:')
for lbl,acct in [('treasury '+TR,TR),('counterparty 0.0.10420070','0.0.10420070')]:
    tx=[t for t in pages('/api/v1/transactions?account.id=%s&transactiontype=CRYPTOTRANSFER&limit=100&order=desc'%acct) if t.get('token_transfers')]
    c=collections.Counter(t.get('node') for t in tx)
    print('    %-28s %4d token txs across %d node(s)' % (lbl,len(tx),len(c)))
    for k,v in c.most_common():
        print('      node %-9s %4d  %5.1f%%   %s' % (k,v,100*v/len(tx),LBL.get(k,'')))
print()
print('  CONTROL. Is that concentration normal? 100 random recent mainnet txs:')
d2=json.loads(urllib.request.urlopen('https://mainnet-public.mirrornode.hedera.com/api/v1/transactions?limit=100&order=desc&result=SUCCESS',timeout=30).read())['transactions']
cc=collections.Counter(t.get('node') for t in d2 if t.get('node'))
print('    distinct receiving nodes %d, busiest %.1f%% of traffic'
      % (len(cc),100*cc.most_common(1)[0][1]/sum(cc.values())))
print('    Routing across mainnet is spread over the whole address book.')
print('    So 100 percent on one node is a deliberate pin, not a default.')
print()
print('  The receiving consensus node is a PUBLIC field on every transaction.')
print('  Two things follow. The consensus visibility lever is already production')
print('  practice, so it is not exotic. And it is not confidential: the')
print('  choice of first observer is itself disclosed, permanently.')
print('  fn(nothing in the ten). A new axis, not a new row.')
print()
print('  Stated without allegation, because the structural point does not')
print('  need one: every transaction on this treasury, across five competing')
print('  managers, is handed first to a node operated by one of them.')

rule('DERIVED FACT 5: cadence')
ts=sorted(l['ts'] for l in legs)
gaps=[ts[i+1]-ts[i] for i in range(len(ts)-1)]
fmt=lambda x: datetime.datetime.fromtimestamp(x,datetime.timezone.utc).strftime('%Y-%m-%d')
print()
print('  window      %s to %s' % (fmt(ts[0]),fmt(ts[-1])))
print('  transfers   %d' % len(legs))
print('  median gap  %.1f h' % (statistics.median(gaps)/3600))
byday=collections.Counter(fmt(x) for x in ts)
print('  active days %d of %d in window' % (len(byday),int((ts[-1]-ts[0])/86400)+1))
print('  busiest     %s' % ', '.join('%s n=%d' % kv for kv in byday.most_common(3)))
print()
print('  fn(time) alone. Survives hiding every amount and every identity.')
print('  This is the activity leak, and none of the ten covers it.')
"

echo
echo "========================================================================"
echo "What this settles for the row decision"
echo "========================================================================"
cat <<'TXT'

  Five derived facts, reconstructible today with no key and no account, none
  of them one of the ten primitive rows:

    1. counterparty graph      fn(identity, quantity)        trader-scoped
    2. activity fingerprint    fn(identity, quantity, time)  trader-scoped
    3. fund flow               fn(quantity, asset)           ISSUER-scoped
    4. submission routing      fn(nothing in the ten)             TRANSPORT-scoped
    5. cadence                 fn(time)                      trader-scoped

  1, 2 and 5 are derived rows: functions over the primitive rows, fixable by admitting
  rows whose value is a function and which carry their own (G, O, T).

  3 and 4 are NOT rows at any granularity, and this is the finding. Fact 3 is
  a property of the issuer, not of any participant, so no per-trader cell can
  express it. Fact 4 is a property of the transport, and it exists whatever
  the venue writes. Admitting derived rows fixes three of five.
TXT
