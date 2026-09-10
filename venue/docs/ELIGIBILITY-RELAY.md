# Sponsored eligibility relay

The Eligibility screen calls the same-origin
`POST /api/eligibility/register` endpoint. The endpoint receives an
account-bound PLONK proof, verifies the complete call without changing state,
and only then pays to submit `RegistrationGate.register`.

The relay never receives credential attributes, a Merkle witness, or the
credential secret. Proof generation remains outside the relay.

## Deployment

1. Create a dedicated ECDSA sponsor account. Do not reuse an issuer, oracle, or
   deployment key.
2. Keep only the HBAR budget required for registrations in that account.
3. Add every variable from
   `api/eligibility/relay.env.example` to the Vercel project's encrypted
   environment settings.
4. Confirm that `REGISTRATION_GATE` and `ZK_KYC_REGISTRY` match
   `deployments/client.json` before each deployment.
5. Apply a Vercel Firewall rate limit to
   `POST /api/eligibility/register`. The function's own limits are
   process-local backstops and are not global across serverless instances.
6. Deploy from the repository root so Vercel can build both `api/` and the
   committed application under `venue/app/`.

The sponsor gas-price ceiling is mandatory. If the network quote exceeds it,
the endpoint refuses without sending a transaction.

Run the relay checks from the repository root:

```sh
npm ci
npm run test:relay
```

## Request handling

The function performs these checks in order:

1. Require a same-origin JSON POST with a small bounded body.
2. Pin chain id, gate, registry, account, array lengths, and every uint256.
3. Require public signal 4 to equal the requested account.
4. Return immediately if the account already has a current grant.
5. Call `wouldAccept` for the current root, epoch, policy, and nullifier limit.
6. Simulate the complete `register` call, including PLONK verification.
7. Check grant state again to close the ordinary concurrent-request race.
8. Enforce the sponsor budget and submit from the dedicated relay account.

The browser polls `ZkKycRegistry.getKycStatus` after submission. A delayed
receipt does not require the user to retry or approve a wallet transaction.

## Operational limits

The proof and its seven public signals are public once registration is
submitted, but the endpoint still avoids logging them. Logs should contain only
service health, response classes, and transaction hashes.

Serverless memory cannot provide globally durable idempotency. The on-chain
grant check, repeated pre-send check, process-local in-flight coalescing, Vercel
Firewall rule, and a low-balance dedicated sponsor account bound the risk. A
production service with higher volume should put idempotency and spend
accounting in a durable same-region store before increasing the sponsor budget.

## Browser proving boundary

The first release resolves account-bound proofs already bundled with the demo
or restored on the holder's device. The runtime exposes proof providers so a
local Web Worker can be added without changing the screen.

Do not make the committed demo credentials a general proving service. Their
secrets are public test data. Real browser proving requires an issuer-delivered,
encrypted holder credential and a current Merkle path. The worker should load
integrity-pinned WASM and zkey assets from the same origin and keep every
private circuit input on the holder's device.
