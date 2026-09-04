#!/usr/bin/env bash
# Verify the quotes V3 rests on, from the primary PDF, without trusting this repo.
#
# Downloads the Turquoise Plato Block Discovery service description from LSEG,
# extracts the text, and asserts each quoted phrase appears verbatim.
# Requires: curl, python3 with pypdf.
#
# Usage: ./turquoise-quotes.sh

set -u
URL="https://docs.londonstockexchange.com/sites/default/files/documents/turquoise-plato-block-discovery-trading-service-description-v2_28.1.pdf"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Fetching $URL"
curl -sSL -o "$WORK/bd.pdf" "$URL" || { echo "FETCH FAILED"; exit 1; }
echo "Got $(wc -c < "$WORK/bd.pdf") bytes"

python3 - "$WORK/bd.pdf" <<'PYEOF'
import re, sys
from pypdf import PdfReader

reader = PdfReader(sys.argv[1])
text = "\n".join((p.extract_text() or "") for p in reader.pages)
# Collapse all whitespace so line wrapping in the PDF cannot break a match.
flat = re.sub(r"\s+", " ", text)
print("Pages: %d   Characters: %d\n" % (len(reader.pages), len(text)))

CLAIMS = [
    ("one predicate, to the matched parties only",
     "The OSR contains no information about the size, MES or Price of the "
     "potential counterparty, but receipt of an OSR implies that a potential "
     "match is available for at least the Participant's own MES."),
    ("nothing reaches anyone else pre-match",
     "No information sent to any other Participant."),
    ("the match reveals no counterparty detail",
     "no details regarding nature of counterparty Order/BI"),
    ("the indication is non-actionable",
     "Is a non-actionable indication of interest submitted to Turquoise Plato "
     "Block Discovery"),
    ("dishonest firm-up scores zero",
     "Failure to send a valid QBO meeting the above criteria results in a "
     "zero-score."),
    ("honest firm-up scores 50 to 100",
     "the score will range from 50 to 100 depending on the size of the QBO "
     "relative to the original BI"),
    ("events combine by recency",
     "The most recent event has a weighting of 100, the next most recent 99, "
     "and so on."),
    ("the only enforcement is exclusion",
     "the user will be immediately excluded from further use of the service"),
    ("the score is a wire field",
     "Reputational Score(27012)"),
    ("a prior sighting  the eligibility floor scales with LIS",
     "equal to or greater than 25% of LIS"),
]

fails = 0
for label, quote in CLAIMS:
    needle = re.sub(r"\s+", " ", quote)
    # The PDF uses a typographic apostrophe in places; accept either.
    ok = needle in flat or needle.replace("'", "’") in flat
    print("%-4s %s" % ("OK" if ok else "FAIL", label))
    if not ok:
        fails += 1
        print("       missing: %s" % needle[:90])

print("\n%d of %d verbatim quotes confirmed." % (len(CLAIMS) - fails, len(CLAIMS)))
sys.exit(1 if fails else 0)
PYEOF
STATUS=$?

cat <<'ENDNOTE'

NOTE
  Every quote V3 relies on comes from this document, sections 5.2, 5.3.4 and
  5.3.5. The finding is that the disclosure it specifies (one predicate over
  hidden data, to a recipient set derived from that data) is achieved by an
  operator reading the cleartext, and that honest behaviour afterwards is
  enforced by a recency-weighted reputation score rather than by a proof.
  That is the fifth mechanism, and it is the one nearest our own design.
ENDNOTE
exit $STATUS
