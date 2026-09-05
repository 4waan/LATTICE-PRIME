#!/usr/bin/env python3
"""Check the demo script's narration against its own labels and the 300 second cap.

Every beat labels itself `**Narration (N).**` and is followed by one blockquote.
This counts the blockquote and fails if the label lies, because the whole file is
a budget and a budget nobody checks is a wish.

    python3 scripts/wordcount.py [path]   # the demo script is untracked, so pass it
"""
import re
import sys

WPM = 150
CAP_SECONDS = 300

path = sys.argv[1] if len(sys.argv) > 1 else "DEMO-SCRIPT.md"
parts = re.split(r"\*\*Narration \((\d+)\)\.\*\*", open(path).read())

total, bad = 0, []
for i in range(1, len(parts), 2):
    claimed, lines = int(parts[i]), []
    for line in parts[i + 1].strip().split("\n"):
        if line.startswith(">"):
            lines.append(line[1:])
        elif lines:
            break
    actual = len(" ".join(lines).split())
    total += actual
    beat = (i + 1) // 2
    print(f"beat {beat}  labelled {claimed:4d}  counted {actual:4d}  {actual - claimed:+d}")
    if actual != claimed:
        bad.append(beat)

speech = total / WPM * 60
print(f"\ntotal {total} words, {speech:.0f}s of speech, "
      f"{CAP_SECONDS - speech:.0f}s of silence in a {CAP_SECONDS}s cap")

if bad:
    print(f"FAIL: labels wrong on beats {bad}")
    sys.exit(1)
if speech > CAP_SECONDS:
    print("FAIL: narration alone exceeds the cap")
    sys.exit(1)
print("OK")
