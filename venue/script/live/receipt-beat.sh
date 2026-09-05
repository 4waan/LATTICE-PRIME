#!/usr/bin/env bash
# The receipt beat, on chain: two sealed orders committed, both withdrawn, and
# the second withdrawal going through in silence.
#
# ## What this is evidence of
#
# `DisclosureMeter.spend` is Rule A: an exhausted budget withholds the event and
# lets the transaction complete. That is the one state an event stream cannot
# report, because a row silenced by its budget and a row nobody disclosed on are
# byte for byte identical in the log. The distinction lives in `spentBits`, which
# is a view, which is why `docs/disclosure-receipt.html` is a read of state and
# not a subscription.
#
# Row 15 is the activity fingerprint. `OrderBook.cancel` publishes it at
# `(pred, imm)` and the governed budget is `(2, 2, 2, 1)`, so a cancellation
# costs one bit against a bound of one and `breakingSize(15, G_PRED)` is 2. The
# first cancel emits `Cancelled` and `DisclosureCharged`. The second emits
# neither, refunds the same bond, and returns status 1.
#
# **Two, and derived rather than chosen.** Row 15's value domain is the three
# disjoint windows `OrderBook` partitions a commitment's life into: cancel,
# reveal, forfeit. Two bits. `DisclosureBudget.requireWellFormed` demands
# `budgetBits < domainBits`, so one bit is the largest bound the model admits.
# `PolicySets.budgetFor` carries the derivation; `test/PolicySets.t.sol` and
# `test/ReceiptVectors.t.sol` pin it.
#
# ## Why it has to be one epoch
#
# The meter is keyed `(row, epoch)` and the disclosure epoch is 300 seconds, so
# a boundary between the two cancels resets the row and both are charged. That
# is not a failure of the mechanism, it is the mechanism, but it is not the beat.
# So this refuses to start without headroom, and it records the epoch at every
# read: if the clock rolls mid-run the transcript says so rather than reporting
# a silence that did not happen.
#
# The cancel window is the other clock. `cancel` closes at `committedAt +
# revealDelay`, which is 30 seconds here, so both commits and both cancels have
# to land inside that. Four transactions at roughly five seconds each on the
# HashIO relay leaves room, and the script checks `cancellableUntil` before it
# sends rather than discovering `CancelWindowClosed` as a spent transaction.
#
# ## Cost
#
# Two bonds of 1,000,000 tinybars, posted and refunded less `cancelFee` each.
# The beat costs 2 x 100,000 tinybars = 0.002 HBAR in fees, plus gas. The refund
# is a credit rather than a transfer, following `expire`, so `withdraw` is a
# separate call this script does not make.
#
# Usage: script/live/receipt-beat.sh [plan|run|sweep [0xID...]]
#        plan  reads the chain and says whether the window is open. Sends nothing.
#        run   sends four transactions and writes deployments/receipt-beat.json
#        sweep forfeits a commitment whose cancel window shut, recovering the bond
set -euo pipefail

cd "$(dirname "$0")/../.."          # venue/
ROOT="$(cd .. && pwd)"
set -a; . "$ROOT/.env"; set +a
: "${HEDERA_TESTNET_RPC:?set HEDERA_TESTNET_RPC}"
: "${HEDERA_PRIVATE_KEY:?set HEDERA_PRIVATE_KEY}"

MODE="${1:-plan}"

ENGINE=$(python3 -c "import json;print(json.load(open('deployments/296-venue.json'))['venue']['MatchingEngine'])")
PARAMS=$(python3 -c "import json;print(json.load(open('deployments/296-venue.json'))['policy']['ParameterRoot'])")
EPOCH_ZERO=$(python3 -c "import json;print(json.load(open('deployments/296-venue.json'))['policy']['epochZero'])")
EPOCH_LEN=$(python3 -c "import json;print(json.load(open('deployments/296-venue.json'))['policy']['epochLength'])")

ROW=15          # the activity fingerprint
G_PRED=1        # DisclosureLattice.G_PRED
T_IMM=1         # DisclosureLattice.T_IMM

WORK="deployments/.receipt-beat"
mkdir -p "$WORK"

# cast prints large integers as `1788632088 [1.788e9]`. Every arithmetic use of a
# read has to go through this or the shell sees the exponent as a second word.
n() { awk '{print $1}'; }
call() { cast call "$1" "$2" "${@:3}" --rpc-url "$HEDERA_TESTNET_RPC"; }

SENDER=$(cast wallet address --private-key "$HEDERA_PRIVATE_KEY")

BOND=$(call "$ENGINE" 'commitBond()(uint256)' | n)
FEE=$(call "$ENGINE" 'cancelFee()(uint256)' | n)
DELAY=$(call "$ENGINE" 'revealDelay()(uint64)' | n)
WINDOW=$(call "$ENGINE" 'revealWindow()(uint64)' | n)

# The units seam, and the one that has already cost this venue a redeployment.
# `commitBond` is denominated in the unit `msg.value` carries **inside** the
# Hedera EVM, which is tinybars. The relay divides the `value` field by 1e10 on
# the way in, so what goes on the wire is `toWeibar(bond)`. `tools/units.mjs` is
# the only place that factor is written down; this asks it rather than repeating
# it, so a change there fails here instead of silently reverting `WrongBond`.
VALUE=$(node -e "import('./tools/units.mjs').then(u=>console.log(u.toWeibar(${BOND}n).toString()))")

epoch_now() { call "$PARAMS" 'currentEpoch()(uint64)' | n; }
spent()     { call "$ENGINE" 'spentBits(uint16,uint64)(uint32)' "$ROW" "$1" | n; }

# The three getters that move. `DisclosureView` exposes five and the receipt
# screen shows all five, but `ceilingFor` and `wouldDisclose` are pure functions
# of a root that cannot move inside one run, so they are read once in the header.
# Re-reading them here would only be more chances for a cancel window to close.
receipt() {
    # One read per getter, used for both the line on screen and the line in the
    # transcript. Reading twice would be two chances to straddle an epoch
    # boundary and disagree with itself about what the run showed.
    local when="$1" e sp aff brk cr
    e=$(epoch_now)
    sp=$(spent "$e")
    aff=$(call "$ENGINE" 'wouldAfford(uint16,uint8)(bool)' "$ROW" "$G_PRED")
    brk=$(call "$ENGINE" 'breakingSize(uint16,uint8)(uint256)' "$ROW" "$G_PRED" | n)
    cr=$(call "$ENGINE" 'credit(address)(uint256)' "$SENDER" | n)
    printf '  %-22s epoch %-4s spent %-2s afford %-5s breaking %s\n' \
        "$when" "$e" "$sp" "$aff" "$brk"
    printf '%s %s %s %s %s %s\n' "$when" "$e" "$sp" "$aff" "$brk" "$cr" >> "$WORK/receipts.txt"
}

send() {
    local tag="$1"; shift
    cast send "$ENGINE" "$@" \
        --private-key "$HEDERA_PRIVATE_KEY" --rpc-url "$HEDERA_TESTNET_RPC" \
        --json --timeout 300 > "$WORK/$tag.json"
    python3 script/live/_txline.py "$WORK/$tag.json" "$tag"
}

headroom() {
    local now e ends
    now=$(date -u +%s); e=$(epoch_now)
    ends=$(( EPOCH_ZERO + (e + 1) * EPOCH_LEN ))
    echo $(( ends - now ))
}

# Measured rather than guessed. On the HashIO relay a `cast send` round trip is
# roughly eight seconds and an `eth_call` roughly three, so a run is four sends,
# two commitment derivations, two window checks and three four-call reads: about
# eighty seconds. 150 is that with most of a minute spare, and still half an epoch.
NEED=150

echo "engine     $ENGINE"
echo "sender     $SENDER"
echo "row        $ROW at (pred, imm)"
echo "budget     $(call "$PARAMS" 'budgetFor(uint16)((uint16,uint16,uint16,uint16))' "$ROW" | tr -d '\n')"
echo "bond       $BOND tinybar, on the wire as $VALUE weibar"
echo "cancelFee  $FEE tinybar,  refund $(( BOND - FEE )) as credit"
echo "cancel by  committedAt + ${DELAY}s, then revealable for ${WINDOW}s more"
# The two getters the receipt shows that cannot move inside a run. Both are pure
# functions of the adopted root, so a change to either mid-run would mean
# governance adopted a new set while the beat was in flight.
echo "ceiling    $(call "$ENGINE" 'ceilingFor(uint16)(uint32)' "$ROW" | n)   (pred, imm) is 4030"
echo "disclose   $(call "$ENGINE" 'wouldDisclose(uint16,uint8,uint8)(bool)' "$ROW" "$G_PRED" "$T_IMM")"
E0=$(epoch_now)
echo "epoch      $E0, spent $(spent "$E0") of $(call "$PARAMS" 'budgetFor(uint16)((uint16,uint16,uint16,uint16))' "$ROW" | tr -d '\n' | sed 's/.*, //;s/)//') bits, $(headroom)s left"

# ------------------------------------------------------------------ sweep
#
# `forfeit` is permissionless and pays the bond to whoever calls it, so a
# commitment that missed its cancel window is not lost, only late. It is also the
# one terminal branch that does **not** touch row 15: it emits `BondForfeited`
# unconditionally, with no `_emitUnder`, so sweeping a stranded bond cannot
# spend the budget this beat is measuring. That is why the failed first attempt
# left the evidence intact rather than poisoning the next run.
#
# Takes ids on the command line, and with none falls back to the ids the last run
# recorded.
if [ "$MODE" = "sweep" ]; then
    shift || true
    ids="$*"
    [ -n "$ids" ] || ids="$(awk '{print $2}' "$WORK/ids.txt" 2>/dev/null || true)"
    [ -n "$ids" ] || { echo "usage: receipt-beat.sh sweep 0xID [0xID...]" >&2; exit 1; }
    for id in $ids; do
        read -r committer committedAt revealed cancelled bond <<<"$(
            call "$ENGINE" 'commitments(bytes32)(address,uint64,bool,bool,uint256)' "$id" \
            | n | tr '\n' ' ')"
        closesAt=$(( committedAt + DELAY + WINDOW ))
        now=$(date -u +%s)
        printf '%s\n' "$id"
        printf '  committer %s  committedAt %s  revealed %s  cancelled %s  bond %s\n' \
            "$committer" "$committedAt" "$revealed" "$cancelled" "$bond"
        if [ "$committer" = "0x0000000000000000000000000000000000000000" ]; then
            echo "  unknown commitment, nothing to sweep"; continue
        fi
        if [ "$revealed" = "true" ] || [ "$cancelled" = "true" ]; then
            echo "  already terminal, nothing to sweep"; continue
        fi
        if [ "$now" -le "$closesAt" ]; then
            echo "  still revealable until $closesAt, $(( closesAt - now ))s away"; continue
        fi
        send "sweep$(echo "$id" | cut -c3-10)" 'forfeit(bytes32)' "$id"
    done
    exit 0
fi

if [ "$(spent "$E0")" != "0" ]; then
    echo
    echo "row $ROW is already spent in epoch $E0. The first cancel would be withheld"
    echo "and the beat would show nothing. Wait for epoch $(( E0 + 1 ))."
    [ "$MODE" = "run" ] && exit 1
fi

if [ "$MODE" != "run" ]; then
    if [ "$(headroom)" -lt "$NEED" ]; then
        echo
        echo "only $(headroom)s left in epoch $E0; run at the boundary, $(( EPOCH_ZERO + (E0 + 1) * EPOCH_LEN ))"
    else
        echo
        echo "window is open. script/live/receipt-beat.sh run"
    fi
    exit 0
fi

# ---------------------------------------------------------------- run

# Wait for the boundary rather than starting a run that cannot finish inside one
# epoch. Sleeping here is the honest thing: the alternative is a transcript whose
# two cancels sit in different epochs and prove nothing.
if [ "$(headroom)" -lt "$NEED" ]; then
    left=$(headroom)
    echo
    echo "only ${left}s left in epoch $E0. waiting $(( left + 2 ))s for the boundary."
    sleep $(( left + 2 ))
    E0=$(epoch_now)
    echo "epoch      $E0, spent $(spent "$E0"), $(headroom)s left"
fi

: > "$WORK/receipts.txt"
: > "$WORK/ids.txt"
START_EPOCH=$(epoch_now)

# One commitment, committed and withdrawn back to back.
#
# **Nothing may go between these two sends.** `cancel` closes at `committedAt +
# revealDelay`, thirty seconds here, and a receipt read is several sequential
# `eth_call`s against a relay answering in roughly three seconds each. The first
# attempt at this beat put a full read between them and the window shut mid-run:
# the `cancellableUntil` check below caught it and cost a call rather than a
# transaction, but the run was wasted and two bonds were stranded. So the reads
# sit outside the pairs, and the pairs are what has to be fast.
pair() {
    local tag="$1" side="$2" price="$3" qty="$4" id salt until_ts now
    salt=$(cast keccak "seamme receipt beat $tag $(date -u +%s) $RANDOM")
    # A real opening, not an opaque word. `commitmentOf` is public so the client
    # and the contract cannot disagree about the preimage, and the committer is
    # inside it, so a commitment lifted off the wire cannot be revealed by
    # whoever took it. Neither of these is ever revealed, but both are
    # revealable, and a beat that committed to junk would show a different thing.
    id=$(call "$ENGINE" 'commitmentOf(address,uint8,uint128,uint128,bytes32)(bytes32)' \
            "$SENDER" "$side" "$price" "$qty" "$salt")
    echo "  $tag  $id   ($([ "$side" = 0 ] && echo BUY || echo SELL) $price x $qty)"
    echo "$tag $id" >> "$WORK/ids.txt"

    send "commit$tag" 'commit(bytes32)' "$id" --value "$VALUE"

    # Ask before sending. `cancellableUntil` returns the first instant the window
    # is shut, exclusive, and zero when the id is already terminal. Discovering
    # `CancelWindowClosed` from a receipt costs a transaction; discovering it
    # here costs a call, and the bond is recoverable through `forfeit` either way.
    until_ts=$(call "$ENGINE" 'cancellableUntil(bytes32)(uint64)' "$id" | n)
    now=$(date -u +%s)
    if [ "$until_ts" -le "$now" ]; then
        echo "  $tag window shut $(( now - until_ts ))s ago; not sending a cancel that reverts." >&2
        echo "  the bond is recoverable: receipt-beat.sh sweep, after committedAt + $(( DELAY + WINDOW ))s" >&2
        exit 1
    fi
    send "cancel$tag" 'cancel(bytes32)' "$id"
}

echo
echo "each commitment is committed and withdrawn back to back, no read between"
receipt "before anything"

echo
echo "pair A     the first disclosure on row $ROW this epoch"
pair A 0 101 500
receipt "after cancel A"

echo
echo "pair B     the row is spent; Rule A withholds and the call still succeeds"
pair B 1 99 500
receipt "after cancel B"

END_EPOCH=$(epoch_now)
ID_A=$(awk '$1=="A"{print $2}' "$WORK/ids.txt")
ID_B=$(awk '$1=="B"{print $2}' "$WORK/ids.txt")

echo
python3 - "$WORK" "$START_EPOCH" "$END_EPOCH" "$ID_A" "$ID_B" "$ENGINE" "$SENDER" "$BOND" "$FEE" <<'PY'
import json,sys
work,e0,e1,ida,idb,engine,sender,bond,fee = sys.argv[1:10]

CANCELLED = "0xbaa1eb22f2a492ba1a5fea61b8df4d27c6c8b5f3971e63bb58fa14ff72eedb70"
COMMITTED = "0xfda886b5d38d5d61e432b3acc9f19640a2b8c83c87a9c584a780d3854b309b9c"
CHARGED   = "0xc2c92b58279430965bba4609e31c0ecd1ce733209db3c64f1a61e9b6dc9e0709"

def rec(tag):
    d = json.load(open(f"{work}/{tag}.json"))
    logs = [l for l in d["logs"] if l["address"].lower() == engine.lower()]
    return {
        "tx": d["transactionHash"],
        "status": int(d["status"], 16),
        "gasUsed": int(d["gasUsed"], 16),
        "topics": [l["topics"][0] for l in logs],
        "charged": [l for l in logs if l["topics"][0] == CHARGED],
    }

steps = {t: rec(t) for t in ("commitA", "cancelA", "commitB", "cancelB")}

def decode_charged(l):
    d = l["data"][2:]
    return {"row": int(l["topics"][1], 16), "epoch": int(l["topics"][2], 16),
            "granularity": int(d[:64], 16), "cost": int(d[64:128], 16),
            "spentAfter": int(d[128:192], 16)}

charged = [decode_charged(l)
           for t in ("commitA", "cancelA", "commitB", "cancelB")
           for l in steps[t]["charged"]]

reads = []
for line in open(f"{work}/receipts.txt"):
    p = line.rsplit(None, 5)
    reads.append({"when": p[0].strip(), "epoch": int(p[1]), "spentBits": int(p[2]),
                  "wouldAfford": p[3] == "true", "breakingSize": int(p[4]),
                  "credit": int(p[5])})

a, b = steps["cancelA"], steps["cancelB"]
before, afterA, afterB = reads

# Every claim the beat makes, checked here rather than read off the screen by a
# person. The one that matters is the pair: `secondCancelEmittedNothing` and
# `secondCancelSucceeded` together are Rule A, and either alone is not.
ok = {
    "everyStepSucceeded": all(v["status"] == 1 for v in steps.values()),
    "oneEpochThroughout":
        int(e0) == int(e1) and {r["epoch"] for r in reads} == {int(e0)},
    "firstCancelEmittedCancelled": CANCELLED in a["topics"],
    "firstCancelWasCharged": CHARGED in a["topics"],
    "secondCancelEmittedNothing":
        CANCELLED not in b["topics"] and CHARGED not in b["topics"],
    "secondCancelSucceeded": b["status"] == 1,
    "bothCancelsRefundedTheSameBond":
        afterA["credit"] - before["credit"] == int(bond) - int(fee)
        and afterB["credit"] - afterA["credit"] == int(bond) - int(fee),
    "spentWentZeroOneAndStopped":
        [r["spentBits"] for r in reads] == [0, 1, 1],
    "affordWentTrueFalseFalse":
        [r["wouldAfford"] for r in reads] == [True, False, False],
    "breakingSizeNeverMoved": all(r["breakingSize"] == 2 for r in reads),
    "theChargeWasOneBitOnRowFifteen":
        [(c["row"], c["cost"], c["spentAfter"]) for c in charged] == [(15, 1, 1)],
}

out = {
 "what": "The receipt beat, run on chain 296. Two sealed orders committed and both "
         "withdrawn inside one disclosure epoch. The first withdrawal published "
         "Cancelled and was charged one bit against row 15's budget of one; the "
         "second published nothing, refunded the same bond and returned status 1.",
 "why": "DisclosureMeter.spend is Rule A: an exhausted budget withholds the event "
        "and never fails the action. A row silenced by its budget and a row nobody "
        "disclosed on are identical in the log, so the distinction has to be read "
        "from spentBits, which is a view. This is that read, taken three times.",
 "engine": engine, "sender": sender, "row": 15, "granularity": "pred", "time": "imm",
 "epoch": {"start": int(e0), "end": int(e1), "length": 300},
 "commitments": {"A": ida, "B": idb,
   "note": "commitmentOf(committer, side, price, qty, salt). Never revealed, but "
           "revealable: the openings were real orders, BUY 101 x 500 and SELL 99 x 500. "
           "Each was committed and cancelled back to back, because cancel closes 30 "
           "seconds after commit and a receipt read does not fit inside that."},
 "steps": {k: {kk: vv for kk, vv in v.items() if kk != "charged"} for k, v in steps.items()},
 "charged": charged,
 "receipts": reads,
 "assertions": ok,
}
json.dump(out, open("deployments/receipt-beat.json", "w"), indent=1)

width = max(len(k) for k in ok)
for k, v in ok.items():
    print(f"  {k:<{width}}  {'ok' if v else 'FAILED'}")
print()
print("wrote deployments/receipt-beat.json")
if not all(ok.values()):
    print()
    print("the run happened, the claim did not hold. deployments/receipt-beat.json")
    print("carries what actually came back; nothing above was written from a guess.")
sys.exit(0 if all(ok.values()) else 1)
PY
