#!/usr/bin/env bash
# What one observer learns about one trader on the highest-revenue venue in crypto.
#
# No API key, no account, no signature. Every call below is a public read.
# Requires: curl, python3.
#
# Usage: ./hyperliquid-positions.sh

set -u
API="https://api.hyperliquid.xyz/info"
STATS="https://stats-data.hyperliquid.xyz/Mainnet/leaderboard"
LLAMA="https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyRevenue"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "=============================================================="
echo " 1. The trader register. Public, unauthenticated, whole-market."
echo "=============================================================="
curl -s --max-time 90 "$STATS" -o "$WORK/lb.json" \
  -w "   GET stats-data leaderboard  http=%{http_code}  bytes=%{size_download}\n"

python3 - "$WORK/lb.json" <<'PYEOF'
import json, sys
rows = json.load(open(sys.argv[1]))["leaderboardRows"]
rows.sort(key=lambda r: -float(r["accountValue"]))
print("   accounts listed: %s" % format(len(rows), ","))
print("   every row carries an address, an account value, and day/week/month/all-time PnL and volume.\n")
print("   %-44s %18s %18s" % ("address", "accountValue", "30d volume"))
for r in rows[:5]:
    vol = dict(r["windowPerformances"]).get("month", {}).get("vlm", "?")
    print("   %-44s %18s %18s" % (r["ethAddress"], r["accountValue"][:16], vol[:16]))
json.dump([r["ethAddress"] for r in rows[:40]], open(sys.argv[1] + ".addrs", "w"))
PYEOF

echo
echo "=============================================================="
echo " 2. Per-account position state, including the liquidation price."
echo "=============================================================="
python3 - "$WORK/lb.json.addrs" "$API" <<'PYEOF'
import json, sys, urllib.request, time
addrs = json.load(open(sys.argv[1]))
api = sys.argv[2]

def info(payload):
    req = urllib.request.Request(api, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=25))

shown = 0
for a in addrs:
    try:
        d = info({"type": "clearinghouseState", "user": a})
    except Exception as e:
        print("   error %s %s" % (a, e)); continue
    aps = d.get("assetPositions", [])
    if not aps:
        continue
    shown += 1
    print("\n   %s   accountValue=%s" % (a, d["marginSummary"]["accountValue"][:14]))
    for ap in aps[:4]:
        p = ap["position"]
        lev = p.get("leverage", {})
        print("      %-7s size=%-16s entry=%-12s LIQUIDATION=%-16s %sx %-6s uPnL=%s" % (
            p["coin"], p["szi"], str(p.get("entryPx"))[:11],
            str(p.get("liquidationPx"))[:15], lev.get("value"),
            str(lev.get("type"))[:6], str(p.get("unrealizedPnl"))[:14]))
    if shown >= 4:
        break
    time.sleep(0.15)
print("\n   accounts with open positions displayed: %d" % shown)
PYEOF

echo
echo "=============================================================="
echo " 3. The full order book, to the level, for anyone."
echo "=============================================================="
curl -s --max-time 25 -X POST "$API" -H "Content-Type: application/json" \
  -d '{"type":"l2Book","coin":"BTC"}' -o "$WORK/book.json" \
  -w "   POST l2Book BTC  http=%{http_code}  bytes=%{size_download}\n"
python3 - "$WORK/book.json" <<'PYEOF'
import json, sys
lv = json.load(open(sys.argv[1]))["levels"]
print("   bid levels=%d  ask levels=%d" % (len(lv[0]), len(lv[1])))
print("   best bid px=%s sz=%s n=%s   best ask px=%s sz=%s n=%s"
      % (lv[0][0]["px"], lv[0][0]["sz"], lv[0][0]["n"],
         lv[1][0]["px"], lv[1][0]["sz"], lv[1][0]["n"]))
PYEOF

echo
echo "=============================================================="
echo " 4. Where this venue sits commercially. Revenue retained, 30d."
echo "=============================================================="
curl -s --max-time 60 "$LLAMA" -o "$WORK/fees.json" \
  -w "   GET llama fees overview  http=%{http_code}  bytes=%{size_download}\n"
python3 - "$WORK/fees.json" <<'PYEOF'
import json, sys
ps = json.load(open(sys.argv[1]))["protocols"]
r = sorted([p for p in ps if p.get("total30d")], key=lambda p: -p["total30d"])
print("   protocols tracked: %s\n" % format(len(ps), ","))
print("   %-4s %-28s %16s  %s" % ("rank", "protocol", "30d revenue USD", "category"))
for i, p in enumerate(r[:10], 1):
    print("   %-4d %-28s %16s  %s" % (i, p["name"][:28],
          format(int(p["total30d"]), ","), (p.get("category") or "")[:20]))
hl = next((p for p in ps if p["name"] == "Hyperliquid Perps"), None)
if hl:
    print("\n   Hyperliquid Perps all-time revenue: %s USD" % format(int(hl["totalAllTime"]), ","))
PYEOF

cat <<'ENDNOTE'

NOTE
  Sections 1 to 3 are the activity leak, complete, with no waiver and no
  deferral: identity (pseudonymous but persistent and ranked), position size,
  entry price, leverage, unrealised PnL, and the price at which the account is
  forcibly closed. Section 4 is why that matters. This is not a fringe design.
  Excluding the two stablecoin issuers, which earn on reserves rather than on
  trading, Hyperliquid Perps is the highest-revenue protocol in crypto.

  So the honest position for our thesis is not that transparency is unworkable.
  It plainly works here. It is that transparency is affordable exactly where the
  leaked information is cheap, and the institutions we are building for do not
  trade where it is expensive. See marketplace/venues/04-perp-dexes.md.

  Addresses printed above are already published on Hyperliquid's own public
  leaderboard. No attempt is made here to attribute any of them to a person or
  a firm, and none should be.
ENDNOTE
