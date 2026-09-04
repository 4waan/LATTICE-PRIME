# SeamMe

Tokenised collateral for repo, on Hedera, using the Asset Tokenization Studio.
Eligibility is decided by a zero knowledge proof instead of a public KYC
register, margin calls disclose a boolean instead of a price, and orders arrive
as fixed length commitments because on Hedera a plain limit order reaches twenty
nine node operators before any contract runs.

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
