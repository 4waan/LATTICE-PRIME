# The mathematics

Formulas the contracts implement. Narrative lives in the headers that point here.

## Eligibility

Membership in a committed credential set, without revealing which credential.
Freshness is bound in so an old proof cannot outlive a revocation.

Public signals (`circuits/kyc.circom`, snarkjs order):

| # | signal | pinned by the gate to |
|---|---|---|
| 0 | `nullifier` | not pinned; bounded by `MAX_USES_PER_EPOCH` |
| 1 | `passes` | must equal 1 (`verifyProof` is not compliance) |
| 2 | `credentialRoot` | issuer root for this epoch |
| 3 | `epoch` | registry epoch |
| 4 | `registrant` | the granted account |
| 5 | `minTier` | gate policy |
| 6 | `jurisdictionMask` | gate policy |

`registrantBound` in the circuit is load-bearing: an unconstrained public input is optimized out.

Nullifier is a function of the credential, not of holder identity.

## Cancel fee

Two ways to buy phantom book: lapse (cost `B`, duration `D+W`) or cancel (cost `f`, duration ≤ `D`). Never cheaper per second to cancel:

```
f  ≥  ceil(B · D / (D + W))
```

Cancel is legal only for `t < D` (exclusive). Later, cancel would dominate lapse and the bond would stop pricing non-reveal.

## Disclosure lattice

Ideals of `G × T^op`, packed in `uint32`. `|G|=5`, `|T|=6`.

`(g, t) ≤ (g', t')` iff `g ≤ g'` and `t ≥ t'`. Join is union (OR). Lex join under-reports; do not gate on it.

## Coalition budget

Lattice join cannot detect k-bit collusion. Information does:

```
I(A ∨ B)  ≤  min(d, I(A) + I(B))
```

Require `budgetBits < domainBits`. Rule A: exhaustion withholds the event, never the action. Rule B: a ceiling that admits `(exact, imm)` carries no budget.

## Call auction

```
V(p) = min(D(p), S(p))
```

Maximise `V`; then minimise `|D−S|`; then midpoint. Price exists only as `priceTwice = lo + hi`. Notional is `floor(priceTwice * qty / 2)` — never round the price first.

Pro-rata residue at the marginal level is at most `k−1` units among `k` orders. Stated, not eliminated.

## Repo

Haircut ≠ initial margin. Interest ACT/365, rounds up. Fail penalty in hundredths of a bp/day (CSDR). Art. 7(2): payee is the counterparty, not the operator.

## Axe grid

8 × 16 × 16 = 2,048 cells, tree depth 11. A rectangle is 18 bits. `T(16)=136` intervals ⇒ `8 × 136 × 136 = 147,968` rectangles, and `2^17 < 147,968 ≤ 2^18`. Row-13 budget is set against that.

Bond, with one wei of slack, for `M` concurrent yes-answers:

```
B_a  >  M · (B_c − f)
```

When `f ≥ B_c` any positive bond will do.

## Corrections

Three original formulas were wrong and are now distinguished by tests, not restated here: cancel-fee rounding, lattice join (lex vs ideals), `priceTwice` vs round-then-multiply.
