# How long the client takes, and why it took that long

**Note, 2026-09-07.** Two of the three loose ends in "What is still slow" have
closed. The WebGL layer is gone: `venue/glass/` and the megabyte of `glass.js`
built from it have been removed from the repository, so the landing page no
longer has a blocking script in front of its first contract read and the
deferral this document asked for is moot. Google Fonts is unchanged and is now
the only external dependency left on the critical path. The Rulebook screen
gained a consensus topic panel: one paged read against the mirror node, on a
different host from the one serving `eth_call`, so it costs the round trip
counts below nothing.

A four minute video spends its budget on whatever is on screen, including
spinners. This is what a screen cost before, what it costs now, and where the
time was actually going, because it was not where `DEMO-4MIN.md` says it is.

## The measurement

Everything below was measured against live HashIO on chain 296, from this
machine, in a single sitting, by running the client's own read paths under a
minimal DOM stub and counting JSON-RPC requests. Both the old and the new code
were run in the same minutes against the same relay, so the comparison is not
across two network conditions.

## The claim that was wrong

`DEMO-4MIN.md` says "a HashIO `eth_call` answers in about 3 seconds, and a
receipt read is six of them." That is off by an order of magnitude, and the
error was hiding the actual problem.

| | Measured |
|---|---|
| One `eth_call` against HashIO | 0.38s |
| Seven `eth_call`s sent one after another | 2.91s |
| The same seven in one JSON-RPC batch | 0.39s |
| Sixty in one batch | 0.83s |
| Mirror node `contracts/call` | 0.42s |

The relay is fast. Three seconds was never one read. It was the shape of seven
reads issued in a row, which is exactly what `assertWiring` does, and it is the
number that got written down as the cost of a read.

That distinction decides the whole optimisation. Batch size is nearly free:
sixty calls in one request cost about twice what one call costs. **The only thing
that costs time is the number of round trips**, and a round trip is created by a
value that has to arrive before the next call can be written.

ethers v6 already batches whatever is dispatched inside a single tick into one
JSON-RPC request, which was verified rather than assumed. So every
`Promise.all` in this client was already one round trip. The waste was that there
were so many `Promise.all`s in a row, each one waiting on the last for no reason.

## What each screen cost, and what it costs now

Cold open, meaning the network work between arriving on a screen and that screen
holding its figures: the boot chain plus the mount.

| Screen | Before | After | Round trips |
|---|---|---|---|
| Prove | 4.45s | **1.17s** | 9 → 2 |
| Trade | 6.27s | **1.33s** | 9 → 3 |
| Position | 6.63s | **2.71s** | 9 → 2 |
| Rulebook (the "Venue" screen) | 10.37s | **4.77s** | 21 → 5 |
| **Four screens, as a demo walks them** | **27.7s** | **10.0s** | 48 → 12 |

Seventeen seconds returned to a two hundred and forty second video, which is
seven percent of the runtime, recovered from waiting.

The wall clock figures move with the relay's mood. A later run of the same four
screens came back at 6.1s. The round trip counts do not move, which is why they
are in the table: they are a property of the code and the seconds are a property
of the afternoon. Read the right hand column as the claim and the left two as an
illustration of it.

Per refresh, which is what the five second poll pays on every tick:

| | Before | After |
|---|---|---|
| `refreshClocks`, on every screen, every 5s | 1.19s / 3 trips | 0.33s / 1 |
| `refreshProve` | 0.71s / 2 | 0.34s / 1 |
| `refreshGateGov` | 1.21s / 3 | 0.36s / 1 |
| `refreshTrade` | 1.40s / 3 | 0.46s / 1 |
| `refreshBook` | 0.80s / 2 | 0.37s / 1 |
| `refreshDisclosure` | 1.27s / 2 | 0.54s / 1 |
| `refreshInstrument` | 0.86s / 2 | 0.37s / 1 |
| `refreshVenue` | 6.55s / 17 | 1.71s / 4 |

The poll loop matters for a second reason. It was issuing something like ten
requests every five seconds per open tab. It now issues one or two. HashIO rate
limits, this client has a 429 backoff path written for exactly that, and a demo
that trips the limit on camera is a worse outcome than a slow one.

## The six things that were actually wrong

**Boot blocked the paint on the network.** `#app` stayed hidden until seven
wiring reads came back, so the theme, the nav and the wallet sheet, none of which
need the chain, waited on it. They are painted first now, and only figures wait
for reads.

**Boot then read the clocks in a second wave.** The wiring checks and the clocks
have nothing to do with each other. They go out together, so the boot chain is
one round trip instead of four.

**`refreshClocks` had two artificial dependencies.** `roundEnd(r)` needs `r` and
`rootForEpoch(e + 1)` needs `e`, so both waited a full round trip for a value the
client can work out from the same immutables the contracts use. Both getters are
still called, in the same wave, against a predicted round and epoch, and the
prediction is checked against what the chain answered. A miss costs one extra
read and can only happen within a second of a boundary or on a machine whose
clock is wrong. Three round trips became one, on every screen, every five
seconds.

**`refreshVenue` grouped its reads by contract and then issued them that way.**
Fifty-seven reads in seven waves, none of which was an input to any other. They
go out together now. Two reads genuinely take an input: `startOf` wants the
clock's epoch, which the masthead has already read, so it is asked speculatively
and checked; `permits` wants the regime's current point, which cannot be known
before asking, so it is the one thing left in a second wave, and the four panels
below the fold are started in that same wave rather than after it.

**`refreshImmutables` suspended its own batch.** It called
`minimumCancelFee(await engine.commitBond(), await engine.revealDelay(), await
engine.revealWindow())` inside an array literal. Those three awaits re-read three
values the same array was already reading, and suspended the array's own
construction, so twelve reads either side went out in five waves instead of one.
They are read once and the fee is derived from what came back.

**Counts blocked the reads that depend on them.** The book cannot ask `liveAt`
until `revealedCount` lands, and the parameter set cannot ask `keyAt` until
`keyCount` lands. Both now send last refresh's count alongside the new one, so a
book or a key set that has not changed costs one round trip fewer. An index that
no longer exists reverts, which is an answer and not a failure, so it is caught
and read again.

Everything above keeps the client's rule that a printed figure is a getter
somebody called. Nothing is derived from `client.json` and printed. Predictions
choose which question to ask; the chain still answers it, and the answer is
checked.

## Two changes outside the read path

**ethers is vendored.** Every screen fetched `ethers@6.13.5` from jsdelivr: 506KB
and 0.9s cold, on a network nobody controls, before the client could start. It is
now `app/vendor/ethers-6.13.5.umd.min.js`, MIT, sha256
`c8550f9644492f2d1278467b301c615c768a0d61d5c22d5bcd107ec7c9cbd329`, committed. It
is the same file that was being fetched, it is cached across all six screens
after the first, and a demo no longer depends on a CDN answering.

**The runtime is preloaded and the next screen is prefetched.** Each document is
about 280KB of inlined client, so the browser reached the closing script tag late
and only started fetching the runtime then. A `preload` in the head starts it
during parse. A `prefetch` of the next screen in the flow makes the navigation
that follows it close to instant, which is what a demo actually feels.

## What is still slow, and what it would take

**The rulebook screen, at 4.8 seconds.** Five round trips, three of them
unavoidable chains: `keyCount` then `keyAt` then `valueOf`, and `chargeCount`
then `chargeAt`. The count speculation removes one of them on the second refresh
but not the first. Removing the rest means a reader contract that returns the
whole parameter set in one call, which is a deployment, and this venue does not
redeploy casually. It is not on the demo's critical path.

**Google Fonts is still fetched live.** One stylesheet from
`fonts.googleapis.com` at about 0.5s, plus the font files from
`fonts.gstatic.com`. `display=swap` is set so text is never invisible, but this
is the last external dependency on the critical path. Subsetting Montserrat to
the four weights used and vendoring the woff2 next to ethers would remove it.


## Reproducing this

The harness that produced these numbers stubs a DOM, loads
`tools/venue-app.mjs` and `tools/venue-obs.mjs` the same way `gen-page.mjs`
inlines them, subclasses `ethers.JsonRpcProvider` to count `_send` calls, and
runs the real refresh functions against chain 296. It is not committed because it
is a measurement and not a test, and because the thing it measures, the number of
round trips, is now visible by reading the code.

`make vectors` and `forge test` both pass unchanged: 430 tests, 0 failures. None
of this touches Solidity, and the client-side arithmetic copies are still pinned
to the contracts by the vector suites that run before the pages build.
