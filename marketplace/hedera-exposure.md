# What Hedera publishes today

The design constraint this project is built around, measured on mainnet against
live regulated issuance.

## The finding

With no key, no account and no relationship with any issuer, the public mirror
node returns the complete holder register of institutional tokenised funds. The
balances reconcile to total supply exactly, so no holder is hidden among them.

It also returns a per-account compliance status for each token, granted or
revoked. That makes credential history public, not merely credential state.

Account identifiers are issued in order and creation times are public, so the
onboarding cohort and its sequence are readable as well. Accounts appear in
tight clusters that correspond to an issuer bringing a group of investors on at
once.

None of this is a defect in the tokenisation framework. It is how the token
layer works, and it applies to anything issued on it.

## Why it matters here

The trading venue this project builds would be pointless on top of that. There
is no purpose in concealing an order if the register of everyone permitted to
hold the asset is already a public document, along with when each of them was
approved.

So the venue cannot simply be a market. It has to change what the ledger
discloses about participation in the first place, which is why eligibility is
proved rather than published.

## Reproducing it

    bash marketplace/probes/hedera-register.sh

Reads only. Nothing is written to any network, and no credential is required.
