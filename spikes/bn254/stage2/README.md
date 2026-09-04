# A real proof, and a verifier that fails open

Stage one showed the curve operations work. Stage two proves something with them
and checks that the verifier actually rejects what it should.

## What is here

A small circuit, a proving key produced against a public ceremony transcript, a
real proof, and a generated verifier contract deployed and called on-chain.

Alongside the working verifier there are deliberately broken ones. That is the
point of this directory. A verifier that accepts every valid proof is easy to
build and tells you nothing, because a contract that returns true unconditionally
passes the same test. The broken variants establish that the check is load
bearing: one drops the pairing check entirely, one accepts a caller-supplied
verifying key, and one caps its work in a way that silently changes what it
proves.

## The lesson carried into the main build

A proof system is only as strong as the statement it actually proves, and that
statement lives in the compiled circuit rather than in the source or the
comments. Inputs a developer believes are public can compile to private witness
without any error being raised. The circuit still proves something and the proof
still verifies, but nothing the verifier sees is bound to anything.

Every circuit in this project is therefore checked at the compiled level for
which values are genuinely public, and every verifier is tested against a
deliberately broken implementation as well as a correct one.
