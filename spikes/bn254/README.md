# bn254 on Hedera

Can a zero knowledge proof be verified on Hedera inside a normal transaction.

## Result

Yes. The elliptic curve precompiles Groth16 verification depends on are present
on Hedera and return correct results. They were tested against known good values
rather than assumed, on more than one network.

## Why this was tested first

A verifier contract is a large piece of work to write and a slow thing to debug.
If the underlying curve operations were missing or wrong, everything built on
top would fail in ways that look like bugs in the circuit. Testing the primitives
first turns a week of confusion into an afternoon.

There is a trap here worth stating. On some EVM implementations a call to an
address that does not exist succeeds and returns nothing. Code that checks only
whether the call reverted will conclude the precompile is present when it is
absent. A test that never sees a wrong answer cannot tell you the check works, so
every probe here asserts on returned values and includes cases that must fail.

## What Groth16 needs

Verification is a fixed sequence of curve additions and multiplications followed
by a pairing check. The cost is dominated by the pairing and by the number of
public inputs, and it does not depend on the size of the circuit. That is the
property the design relies on: proving is expensive and happens off-chain,
verification is cheap and bounded and happens on-chain.

## Files

    PrecompileProbe.sol   probes each curve operation against known values
    SafeBn254.sol         wrapper that fails closed on a missing precompile
    stage2/               a real proof, verified on-chain, plus a broken verifier
