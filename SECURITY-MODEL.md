# Security model

What this system proves, what it assumes, and what breaks it.

## The statement

A participant proves they hold a valid eligibility credential issued by a
recognised authority, without revealing which credential, which authority, or
which participant. The proof is checked on-chain at the moment of transfer.

What is proved is membership in a set, plus freshness. What is not proved is
anything about the holder's identity, their other holdings, or their history.

## Trusted setup

The proving system requires a setup whose secret material must be destroyed. We
use a public multi-party ceremony rather than generating our own, so the
assumption is that at least one of many independent participants behaved
honestly. This is a weaker assumption than trusting ourselves and it is the
standard practice for good reason.

## The verifier

Three rules govern the on-chain verifier. It must fail closed on anything it does
not understand. Its verifying key must be fixed at deployment and not suppliable
by a caller. And every public input the design relies on must be genuinely
constrained as public in the compiled circuit, which is checked mechanically
rather than by reading the source.

Each rule exists because violating it produces a verifier that passes its own
tests while proving nothing.

## Nullifiers

Reuse is prevented by a nullifier derived so that the same credential cannot be
spent twice, while two uses of different credentials cannot be linked. Getting
this construction wrong is the most common way a system like this leaks, because
a nullifier that is a function of anything identifying reintroduces the linkage
the proof was meant to remove.

## The supervisor path

A supervisor can compel disclosure of a position. This is deliberate and it is
what makes the system deployable for regulated assets. The path is explicit,
logged, and narrower than the supervisor's authority would allow, and it does
not require cooperation from the participant.

## Threat model

The adversaries considered are a curious observer with full ledger access, a
participant trying to trade while ineligible, a participant trying to learn
another's position, an operator trying to exceed their stated authority, and a
consensus node acting on what it sees before ordering.

The system does not defend against a compromised credential issuer. If the
authority issues to someone who should not have one, the proof is valid and the
system will accept it. That is an accepted limit and it is the same limit every
credential system has.

## Post-quantum posture

The proving system is not post-quantum. Shor breaks discrete log in the bn254
pairing groups, so a quantum adversary can forge PLONK proofs. Nothing here
claims otherwise.

That is not the same as reading current witnesses out of current proofs. A
harvested proof carries no information about the witness at any computational
bound: Groth16's zero knowledge is perfect, and the PLONK that shipped blinds
the witness polynomials so a real proof is distributed as a simulation would be.
The hiding does not rest on discrete log remaining hard. A later quantum
adversary cannot recover present order sizes or credential ids from those
proofs.

What a quantum adversary can do is mint a false eligibility proof for a live
epoch. That is worth something only while this verifier still accepts bn254, and
a past epoch's grant is already dead. Settlement is not proved (see
`venue/docs/PLONKISH.md`), so there is no settled-trade proof to forge after the
fact. The forgery window is the current epoch, not the regulatory retention
window.

The confidentiality risk that does not expire is encryption to a viewing key, if
and when that channel exists. The designed linkage (`ct = cid + Poseidon(r · pk_D)`
over Baby Jubjub, D-16) is discrete-log encryption of a record MiFID II retains
under its retention rules. It is designed and not shipped: `venue/circuits/kyc.circom` never
emits `ct`. What HCS carries is policy metadata, not ciphertext. The fix for
that channel is ML-KEM (FIPS 203). It never touches a circuit and it does not
need a new curve on Hedera.

A hash-based proving system is not the escape on this chain. BLS12-381 is
absent, so there is no pairing curve to migrate to, and FRI proofs at typical
size consume most of the 128 KiB calldata cap or cannot be submitted at all
(AB-031). Wrapping a STARK in a bn254 SNARK, which is the production answer
elsewhere, puts the discrete-log assumption back.

Hedera account signatures remain ECDSA secp256k1. That is the network's scheme.
This protocol does not claim post-quantum authorization of transactions.

"Lattice" in this project is the disclosure algebra, not lattice cryptography.
