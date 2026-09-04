# Call graph census

Generated from source by `tools/callstack.mjs`. Do not edit by hand.

## What this is

A mechanical extraction of what each ATS lifecycle path can reach, and what it
cannot. It exists because the claim that a compliance check sits on every
transfer path is exactly the kind of claim that is true when written and false
six months later, and reading the source by hand does not scale to a framework
with over a hundred facets.

## Why it is generated

Three of the findings that shaped this design came from the census rather than
from reading. One attachment point is consulted twice per transfer with different
arguments. The transfer amount is absent on most paths. And a clearing operation
is a mode switch that also affects holds, which is not visible from the function
signature.

None of those are apparent from reading a single file, and all of them change
what a venue can safely enforce and where.

## Regenerating

    make census

This re-derives the table and regenerates the map contract from it, so the
on-chain view and the documentation cannot drift apart.
