# Lattice

## Lattice Prime

A cryptographically robust protocol for tokenised repo and fair-order
settlement on Hedera. Secondary-market orders arrive as fixed-length
commitments, eligibility is proven in zero knowledge, and a disclosure lattice
meters what the venue may publish.

Trade tokenised bonds. Control what the venue publishes.

## Lattice Claw

A separate private execution agent for Lattice Prime. Its runtime can prove
bounded decisions and manage typed order obligations locally. The current
product surface is a coming-soon landing page with a disabled chat preview.

## Licence

Source-available under the [Business Source License 1.1](LICENSE), not open
source. Read it, audit it, run it, fork it, break it. Production and commercial
use need a grant from me. Evaluation, research, teaching, security review,
testnet deployment and hackathon judging are already granted in the licence, so
judges and reviewers need nothing further from me.

On 2030-09-13 it converts to Apache 2.0 automatically.

`venue/src/kyc/KycVerifier.sol` is snarkjs-generated and stays GPL-3.0. It is
not covered by the licence above. See [NOTICE](NOTICE) for that and for every
other third-party component.
