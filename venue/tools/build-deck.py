#!/usr/bin/env python3
"""Lattice Prime eight-slide deck. Slides are drawn as images, then saved as Keynote."""

import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
PAPER = (14, 19, 25)
SURFACE = (21, 28, 36)
SUNK = (17, 24, 32)
INK = (230, 234, 237)
INK2 = (189, 198, 206)
SLATE = (149, 161, 172)
RULE = (36, 46, 56)
INDIGO = (147, 164, 255)
WASH = (23, 31, 49)
CLARET = (232, 128, 156)
CLARET_WASH = (42, 22, 32)
HELD = (216, 200, 140)
AV = "/System/Library/Fonts/Supplemental/Avenir Next.ttc"
OUT = Path("/Users/awaansiddiqui/hedera2026/venue/docs/LatticePrime.key")


def font(size, kind="reg"):
    idx = {"bold": 0, "demi": 2, "med": 5, "reg": 7, "heavy": 8}[kind]
    return ImageFont.truetype(AV, size, index=idx)


def measure(draw, text, f):
    b = draw.textbbox((0, 0), text, font=f)
    return b[2] - b[0], b[3] - b[1]


def text(draw, xy, s, f, fill, anchor="lt"):
    draw.text(xy, s, font=f, fill=fill, anchor=anchor)


def wrap(draw, s, f, max_w):
    lines = []
    for para in s.split("\n"):
        words = para.split()
        if not words:
            lines.append("")
            continue
        cur = words[0]
        for w in words[1:]:
            trial = cur + " " + w
            if measure(draw, trial, f)[0] <= max_w:
                cur = trial
            else:
                lines.append(cur)
                cur = w
        lines.append(cur)
    return lines


def card(draw, box, fill, outline=None, r=18, sw=2):
    draw.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=sw if outline else 0)


def arrow(draw, x, y, color=INDIGO):
    draw.polygon([(x, y - 8), (x + 18, y), (x, y + 8)], fill=color)


def chrome(draw, kicker, title, n):
    draw.rectangle((0, 0, W, H), fill=PAPER)
    draw.rectangle((0, 0, W, 8), fill=INDIGO)
    text(draw, (72, 36), kicker, font(15, "demi"), INDIGO)
    text(draw, (72, 68), title, font(40, "bold"), INK)
    text(draw, (72, 1036), "Lattice Prime", font(15, "med"), SLATE)
    text(draw, (1848, 1036), f"{n:02d}  /  08", font(15, "med"), SLATE, anchor="rt")


def chip_row(draw, items, y=920, w=420, h=64):
    gap = 24
    total = len(items) * w + (len(items) - 1) * gap
    x = (W - total) // 2
    f = font(17, "med")
    for item in items:
        card(draw, (x, y, x + w, y + h), SURFACE, RULE, r=14)
        text(draw, (x + w / 2, y + h / 2), item, f, INK2, anchor="mm")
        x += w + gap


def new():
    im = Image.new("RGB", (W, H), PAPER)
    return im, ImageDraw.Draw(im)


def slide_1():
    im, d = new()
    chrome(d, "THE PROBLEM", "Two accidents. One design space.", 1)

    # left
    card(d, (72, 170, 620, 780), CLARET_WASH, CLARET, r=22)
    text(d, (346, 230), "2011  to  2016", font(16, "demi"), CLARET, anchor="mm")
    text(d, (346, 360), "$84.3m", font(64, "bold"), CLARET, anchor="mm")
    for i, line in enumerate(["Operator held", "the cleartext"]):
        text(d, (346, 500 + i * 42), line, font(26, "med"), INK, anchor="mm")
    text(d, (346, 640), "Crossfinder", font(18, "reg"), SLATE, anchor="mm")

    # center
    card(d, (700, 250, 1220, 700), WASH, INDIGO, r=22)
    text(d, (960, 330), "THE LATTICE", font(16, "demi"), INDIGO, anchor="mm")
    text(d, (960, 430), "Metered", font(36, "bold"), INK, anchor="mm")
    text(d, (960, 480), "disclosure", font(36, "bold"), INK, anchor="mm")
    text(d, (960, 580), "Both reads on the record", font(18, "med"), INK2, anchor="mm")

    # right
    card(d, (1300, 170, 1848, 780), CLARET_WASH, CLARET, r=22)
    text(d, (1574, 230), "2021", font(16, "demi"), CLARET, anchor="mm")
    text(d, (1574, 360), "$5.5bn", font(64, "bold"), CLARET, anchor="mm")
    for i, line in enumerate(["Nobody held", "the sum"]):
        text(d, (1574, 500 + i * 42), line, font(26, "med"), INK, anchor="mm")
    text(d, (1574, 640), "Archegos", font(18, "reg"), SLATE, anchor="mm")

    d.line([(620, 475), (700, 475)], fill=RULE, width=2)
    d.line([(1220, 475), (1300, 475)], fill=RULE, width=2)

    chip_row(d, ["Five pools, $190m", "Privacy was a term", "A mixer is unbankable", "Quantity, with a bound"], y=830, w=430)
    return im


def slide_2():
    im, d = new()
    chrome(d, "THE PRODUCT", "Tokenised collateral for repo", 2)
    steps = [
        ("Prove", "PLONK grant"),
        ("Hold", "ATS escrow"),
        ("Commit", "32-byte id"),
        ("Reveal", "preimage"),
        ("Cross", "uniform p"),
        ("Receipt", "bits spent"),
    ]
    x = 72
    y, bw, bh, gap = 180, 250, 170, 28
    for i, (title, sub) in enumerate(steps):
        hot = i in (2, 5)
        card(d, (x, y, x + bw, y + bh), WASH if hot else SURFACE, INDIGO if hot else RULE, r=18)
        text(d, (x + bw / 2, y + 62), title, font(24, "bold"), INK, anchor="mm")
        text(d, (x + bw / 2, y + 112), sub, font(16, "reg"), SLATE, anchor="mm")
        if i < len(steps) - 1:
            arrow(d, x + bw + 5, y + bh / 2)
        x += bw + gap

    facts = [
        ("1", "order type", "sealed limit"),
        ("32 B", "on the wire", "no side, price, size"),
        ("0", "external data", "no tape, no feed"),
        ("zero", "venue.take", "published, not assumed"),
    ]
    x = 72
    fw, fh, fgap = 430, 280, 28
    for i, (num, a, b) in enumerate(facts):
        card(d, (x, 420, x + fw, 420 + fh), SURFACE, RULE, r=20)
        text(d, (x + fw / 2, 500), num, font(44, "bold"), INDIGO, anchor="mm")
        text(d, (x + fw / 2, 580), a, font(20, "med"), INK, anchor="mm")
        text(d, (x + fw / 2, 618), b, font(16, "reg"), SLATE, anchor="mm")
        x += fw + fgap
    return im


def slide_3():
    im, d = new()
    chrome(d, "ARCHITECTURE", "Six layers. One job each.", 3)
    layers = [
        ("6", "Observatory", "Rulebook hash. Receipt. Census from source."),
        ("5", "Policy", "Committed root. Halt as the ceiling's mirror."),
        ("4", "Repo", "Two legs or neither. Mark committed. Fail priced."),
        ("3", "Market", "Commit-reveal book. Uniform-price call."),
        ("2", "Lattice", "Ideals of G x T. Then bits, because ranks do not add."),
        ("1", "Instrument", "Unmodified ATS bond. Seams C and D. No fork."),
    ]
    y = 170
    for n, name, why in layers:
        hot = n == "2"
        card(d, (72, y, 1848, y + 112), WASH if hot else SURFACE, INDIGO if hot else RULE, r=16)
        text(d, (120, y + 56), n, font(26, "bold"), INDIGO if hot else SLATE, anchor="lm")
        text(d, (200, y + 56), name, font(26, "bold"), INK, anchor="lm")
        text(d, (560, y + 56), why, font(20, "reg"), INK2, anchor="lm")
        y += 128
    return im


def slide_4():
    im, d = new()
    chrome(d, "ELIGIBILITY", "Prove membership. Never publish the register.", 4)
    nodes = [
        ("Issuer", "epoch root"),
        ("Circuit", "nullifier"),
        ("Gate", "pins 5 of 7"),
        ("Seam D", "grant bit"),
        ("ATS", "transfer"),
    ]
    x = 72
    bw, bh = 300, 180
    for i, (title, sub) in enumerate(nodes):
        hot = i in (1, 2)
        card(d, (x, 180, x + bw, 180 + bh), WASH if hot else SURFACE, INDIGO if hot else RULE, r=18)
        text(d, (x + bw / 2, 245), title, font(24, "bold"), INK, anchor="mm")
        text(d, (x + bw / 2, 295), sub, font(16, "reg"), SLATE, anchor="mm")
        if i < len(nodes) - 1:
            arrow(d, x + bw + 10, 270)
        x += 368

    facts = [
        ("Public today", "Mirror node returns\nevery holder and KYC bit"),
        ("Nullifier", "Poseidon(secret,\nDOMAIN, epoch)"),
        ("Not authority", "passes = 0 still verifies.\nThe gate checks the bit."),
        ("Seam D", "Never reverts.\nDeny by default."),
    ]
    x = 72
    for h, b in facts:
        card(d, (x, 430, x + 430, 900), SURFACE, RULE, r=20)
        text(d, (x + 215, 510), h, font(22, "bold"), INDIGO, anchor="mm")
        fy = font(17, "reg")
        lines = wrap(d, b, fy, 360)
        ty = 600
        for line in lines:
            text(d, (x + 215, ty), line, fy, INK2, anchor="mm")
            ty += 32
        x += 458
    return im


def slide_5():
    im, d = new()
    chrome(d, "DISCLOSURE", "A lattice, then a budget.", 5)
    g_labs = ["exact", "bucket", "agg", "pred", "none"]
    t_labs = ["pre", "imm", "+15m", "EOD", "epoch", "never"]
    ox, oy, cw, ch = 150, 200, 90, 72
    lf = font(13, "med")
    for ti, lab in enumerate(t_labs):
        text(d, (ox + ti * cw + cw / 2, oy - 18), lab, lf, SLATE, anchor="mm")
    for gi, lab in enumerate(g_labs):
        text(d, (ox - 12, oy + gi * ch + ch / 2), lab, lf, SLATE, anchor="rm")
        in_ideal_g = lab != "exact"
        for ti in range(6):
            hit = in_ideal_g and ti >= 3
            x0 = ox + ti * cw + 3
            y0 = oy + gi * ch + 3
            card(d, (x0, y0, x0 + cw - 8, y0 + ch - 8), WASH if hit else SUNK, INDIGO if hit else RULE, r=6, sw=1)
    text(d, (ox + 3 * cw, oy + 5 * ch + 28), "Ideal of (bucket, EOD). Join is union.", font(15, "reg"), INK2, anchor="lm")

    cards = [
        ("Join = OR", "Coalition knowledge is the\nunion of ideals. One OR.\n42 gas on the transfer path."),
        ("Lex join is wrong", "Greatest grain, earliest time\nof that grain. Misses an\naggregate known now."),
        ("Bits compose", "I(A v B)  <=  min(d,\nI(A) + I(B))\nRanks do not add."),
        ("Rule A", "Exhaustion withholds speech.\nThe trade still settles."),
    ]
    positions = [(780, 180), (1350, 180), (780, 530), (1350, 530)]
    for (h, b), (x, y) in zip(cards, positions):
        card(d, (x, y, x + 500, y + 310), SURFACE, RULE, r=18)
        text(d, (x + 28, y + 28), h, font(22, "bold"), INDIGO)
        fy = font(17, "reg")
        ty = y + 90
        for line in b.split("\n"):
            text(d, (x + 28, ty), line, fy, INK2)
            ty += 32
    return im


def slide_6():
    im, d = new()
    chrome(d, "MATCHING", "What reaches the node set carries no price.", 6)

    card(d, (72, 170, 920, 980), SURFACE, RULE, r=22)
    text(d, (496, 210), "Uniform-price call auction", font(18, "demi"), INDIGO, anchor="mm")

    ax, ay, aw, ah = 140, 280, 720, 560
    d.line([(ax, ay), (ax, ay + ah)], fill=RULE, width=2)
    d.line([(ax, ay + ah), (ax + aw, ay + ah)], fill=RULE, width=2)

    def pt(fx, fy):
        return (int(ax + fx * aw), int(ay + fy * ah))

    d_pts = [pt(0.06, 0.10), pt(0.28, 0.28), pt(0.52, 0.50), pt(0.88, 0.84)]
    s_pts = [pt(0.06, 0.90), pt(0.30, 0.62), pt(0.52, 0.38), pt(0.88, 0.12)]
    d.line(d_pts, fill=INDIGO, width=5)
    d.line(s_pts, fill=CLARET, width=5)
    d.line([pt(0.52, 0.05), pt(0.52, 1.0)], fill=HELD, width=2)
    text(d, pt(0.56, 0.08), "p*", font(16, "demi"), HELD, anchor="lt")
    text(d, pt(0.90, 0.10), "S(p)", font(16, "demi"), CLARET, anchor="lt")
    text(d, pt(0.90, 0.86), "D(p)", font(16, "demi"), INDIGO, anchor="lt")
    text(d, (ax, ay + ah + 28), "price", font(14, "reg"), SLATE)
    text(d, (ax - 8, ay - 8), "qty", font(14, "reg"), SLATE, anchor="rb")

    formulas = [
        ("V(p) = min(D, S)", "max volume, then min imbalance"),
        ("priceTwice = lo + hi", "the price never exists rounded"),
        ("notional = (2p x q) / 2", "one division, after quantity"),
        ("f = ceil(B x D / (D+W))", "phantom priced per second"),
    ]
    y = 170
    for h, b in formulas:
        card(d, (980, y, 1848, y + 175), SURFACE, RULE, r=18)
        text(d, (1012, y + 42), h, font(24, "bold"), INK)
        text(d, (1012, y + 100), b, font(18, "reg"), INK2)
        y += 200
    return im


def slide_7():
    im, d = new()
    chrome(d, "REPO  AND  HALT", "Two legs, or neither. Halt the round, not the exit.", 7)

    def node(x, y, label, hot=False):
        card(d, (x, y, x + 240, y + 64), WASH if hot else SURFACE, INDIGO if hot else RULE, r=32)
        text(d, (x + 120, y + 32), label, font(15, "demi"), INK, anchor="mm")

    node(360, 180, "PROPOSED")
    node(360, 290, "OPEN", hot=True)
    node(120, 420, "MARGIN")
    node(600, 420, "MANUFACTURED")
    node(360, 550, "FAILING")
    node(120, 700, "DEFAULTED")
    node(600, 700, "CLOSED")

    def mid(x, y, w=240, h=64):
        return x + w / 2, y + h / 2

    links = [
        ((480, 244), (480, 290)),
        ((420, 354), (240, 420)),
        ((540, 354), (720, 420)),
        ((240, 484), (420, 550)),
        ((720, 484), (540, 550)),
        ((420, 614), (240, 700)),
        ((540, 614), (720, 700)),
    ]
    for (x1, y1), (x2, y2) in links:
        d.line([(x1, y1), (x2, y2)], fill=SLATE, width=2)

    cards = [
        ("Haircut is not margin", "purchase = mark x (1 - h)\nCalled on maintenance, separately."),
        ("Mark is a commitment", "Row 14 answers by not writing\nthe liquidation price."),
        ("Halt gates crossRound", "Commit, cancel, expire, withdraw\nstay open. Deadline, not a flag."),
        ("Article 5 raises the floor", "Dark share too high. Compels a print.\nDoes not stop trading."),
    ]
    y = 170
    for h, b in cards:
        card(d, (920, y, 1848, y + 185), SURFACE, RULE, r=18)
        text(d, (952, y + 28), h, font(22, "bold"), INDIGO)
        ty = y + 80
        for line in b.split("\n"):
            text(d, (952, ty), line, font(17, "reg"), INK2)
            ty += 30
        y += 205
    return im


def slide_8():
    im, d = new()
    chrome(d, "THE WINDOW", "The next year is a compliance date.", 8)
    stations = [
        ("Now", "Book, lattice,\nATS bond, receipt", True),
        ("HCS", "Silence as a\ncitable record", False),
        ("Schedule", "Commit and reveal\nin one breath", False),
        ("CLPR", "32-byte payload\nis already safe", False),
        ("ZK settle", "Balances, then\ntransitions, then token", False),
    ]
    x = 72
    bw = 320
    for i, (title, sub, hot) in enumerate(stations):
        if hot:
            card(d, (x, 180, x + bw, 430), INDIGO, r=20)
            text(d, (x + bw / 2, 230), title, font(24, "bold"), PAPER, anchor="mm")
            ty = 290
            for line in sub.split("\n"):
                text(d, (x + bw / 2, ty), line, font(16, "reg"), WASH, anchor="mm")
                ty += 28
        else:
            card(d, (x, 180, x + bw, 430), SURFACE, RULE, r=20)
            text(d, (x + bw / 2, 230), title, font(24, "bold"), INDIGO, anchor="mm")
            ty = 290
            for line in sub.split("\n"):
                text(d, (x + bw / 2, ty), line, font(16, "reg"), INK2, anchor="mm")
                ty += 28
        if i < len(stations) - 1:
            arrow(d, x + bw + 8, 305)
        x += 368

    facts = [
        ("$351bn", "Broadridge DLR\ndaily, Aug 2026", HELD),
        ("31 Dec 2026", "Treasury cash\nclearing mandate", HELD),
        ("30 Jun 2027", "Treasury repo\nclearing mandate", HELD),
        ("The product", "A quantity the\noperator cannot fake", INDIGO),
    ]
    x = 72
    for h, b, c in facts:
        card(d, (x, 500, x + 430, 980), SURFACE, RULE, r=20)
        text(d, (x + 215, 600), h, font(28, "bold"), c, anchor="mm")
        ty = 700
        for line in b.split("\n"):
            text(d, (x + 215, ty), line, font(18, "reg"), INK2, anchor="mm")
            ty += 32
        x += 458
    return im


NOTES = [
    "Open on the two accidents. Credit Suisse Crossfinder, 2016, $84.3m: the operator "
    "held subscriber orders in the clear. Archegos, 2021, $5.5bn at Credit Suisse: "
    "privacy hid the sum from every prime and from the supervisor. Most venues fix "
    "one by causing the other. Lattice Prime refuses the choice. Disclosure is metered. "
    "Both reads are on the record. The receipt is the thing a competitor cannot copy.",
    "One sentence: a secondary market in tokenised collateral for repo, on Hedera, "
    "through Hashgraph's Asset Tokenization Studio. One order type. No tape. "
    "Commitments are thirty-two bytes because gossip reaches twenty-nine operators "
    "before any contract runs. Venue take is published as zero. Live bond is LPRC "
    "from Hashgraph's own factory. One printed round at a uniform 100 against 95 and 105.",
    "Read from the instrument up. ATS is unmodified. We occupy seam D for eligibility "
    "and seam C for compliance. The lattice sits on the transfer path because a check "
    "is 42 gas. The book never puts a price on the wire. The vault never stores the "
    "mark in the clear. Policy is a committed root. The supervisor seat is held by "
    "VolumeCap. Three clocks, never derived from each other.",
    "Hedera already publishes the holder register of live tokenised funds. Concealing "
    "an order on top of that is theatre. The circuit proves membership, policy, and "
    "freshness. It reveals a nullifier and a passes bit. Five of seven public signals "
    "are attacker-chosen. The gate pins all five before it spends the pairing. "
    "getKycStatus never reverts because a revert on seam D bricks the token. "
    "A grant in epoch e grants nothing in e+1.",
    "Do not call this fuzzy algebra. Fuzzy membership invents a score in 0 to 1 with "
    "no operational meaning. The object is Birkhoff: order ideals of G times T-op. "
    "Five grains, six times, thirty cells, a uint32. Join is union. The lattice cannot "
    "see collusion because a union of subsets stays a subset. k predicates over 2^k "
    "determine the value exactly and still join to one predicate. Information in bits "
    "does compose. Metered rows are 13, 14, 15. Budget is domainBits minus one.",
    "Hedera has no public mempool. A submitted transaction is still gossiped in full "
    "to twenty-nine named operators before it is ordered. A plain limit order is already "
    "disclosed. Commitment is keccak of domain, committer, side, price, qty, salt. "
    "Cancel and reveal windows partition the lifetime and never overlap. Resting seven "
    "rounds roughly doubles crossings and spends one exact disclosure rather than one "
    "per round. Axe grid is 2048 cells, one bit per probe, not deployed.",
    "A repo is a sale and a repurchase. Title passes. Economically it is a secured loan. "
    "Haircut and maintenance are distinct. Accrual rounds up on ACT/365. FAILING is not "
    "default. CSDR Article 7 penalty accrues from maturity, payee the counterparty. "
    "Narrowing disclosure is immediate. Halting is the deprivation, so it is budgeted and "
    "self-expiring. In this deployment VolumeCap holds the supervisor seat. The breaker "
    "cannot stop the round that breached it.",
    "Broadridge already clears hundreds of billions a day on membership privacy. "
    "The SEC dates are 31 December 2026 and 30 June 2027. HCS cannot be called from "
    "a contract. HIP-478 specifies a relay. The novel record is silence: I acted, I "
    "told you nothing, here is the row and the budget. HIP-1535 stores payloads in "
    "plaintext and hands confidentiality to the application. Our commitment is that "
    "answer today. ZK settlement is a different circuit class and is not claimed. "
    "Close on the sentence: a venue whose operator reads the cleartext has no quantity to print.",
]


def _as_str(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def build_keynote(pngs, notes, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest_posix = str(dest)
    lines = [
        'tell application "Keynote"',
        '  if exists document "LatticePrime" then close document "LatticePrime" saving no',
        '  if exists document "LatticePrime.key" then close document "LatticePrime.key" saving no',
        '  set doc to make new document with properties {document theme:theme "Black", width:1920, height:1080}',
        "  tell doc",
        '    set base slide of slide 1 to slide layout "Blank"',
    ]
    for i, png in enumerate(pngs):
        n = i + 1
        if n > 1:
            lines.append('    make new slide at end of slides with properties {base slide:slide layout "Blank"}')
        lines.append(f"    tell slide {n}")
        lines.append(f"      set img to make new image with properties {{file:POSIX file {_as_str(str(png))}}}")
        lines.append("      set width of img to 1920")
        lines.append("      set height of img to 1080")
        lines.append("      set position of img to {0, 0}")
        lines.append(f"      set presenter notes to {_as_str(notes[i])}")
        lines.append("    end tell")
    lines += [
        "  end tell",
        f"  save doc in POSIX file {_as_str(dest_posix)}",
        "  close doc saving no",
        "end tell",
    ]
    script = "\n".join(lines) + "\n"
    r = subprocess.run(["osascript"], input=script, text=True, capture_output=True)
    if r.returncode != 0:
        raise SystemExit(r.stderr.strip() or "Keynote export failed")


def main():
    makers = [slide_1, slide_2, slide_3, slide_4, slide_5, slide_6, slide_7, slide_8]
    with tempfile.TemporaryDirectory() as tmp:
        pngs = []
        for i, maker in enumerate(makers):
            path = Path(tmp) / f"s{i + 1}.png"
            maker().save(path, "PNG", optimize=True)
            pngs.append(path)
        if OUT.exists():
            OUT.unlink()
        build_keynote(pngs, NOTES, OUT)
    print(OUT)


if __name__ == "__main__":
    main()
