"""One line per transaction, from a `cast send --json` receipt.

Its own file rather than a `python3 -c` string inside the shell: the obvious
inline form needs an f-string containing escaped double quotes, which is a
syntax error before Python 3.12 and fails *after* the transaction has been
sent. A helper that cannot compile fails at import, which is free.
"""
import json
import sys

receipt, tag = sys.argv[1], sys.argv[2]
d = json.load(open(receipt))
tx = d["transactionHash"]
status = int(d["status"], 16)
gas = int(d["gasUsed"], 16)
logs = len(d["logs"])
print("  {:<10} {}  status {}  gas {}  logs {}".format(tag, tx, status, gas, logs))
if status != 1:
    sys.exit(1)
