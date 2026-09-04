# What privacy costs

The economics of proving, and three corrections to the obvious analysis.

## The naive view

Zero knowledge proofs are expensive, therefore a private venue is expensive,
therefore participants will not use it. Each step of that is wrong here, and the
reasons are worth stating because they are what makes the design viable.

## The proof is not per trade

Eligibility is proved once and reused. A participant who trades frequently
amortises a single proof across every trade they make, so the marginal cost of
privacy per trade approaches zero for exactly the participants who matter most
to a venue.

## The trader does not pay

The party who benefits from a participant being eligible is the venue and the
issuer, not the participant. The fee structure follows that, so the cost does not
sit with the person being asked to adopt something unfamiliar.

## Privacy is not elective

Because the disclosure level is not chosen, there is no cheap public option to
defect to. This removes the failure mode where a privacy feature exists, costs
more, and is therefore used by almost nobody, which is the outcome that has
sunk most optional-privacy designs.

## The comparison that matters

The venue this imitates already pays substantially more for confidentiality than
this design does, through intermediaries, bilateral negotiation and settlement
delay. Measured against that baseline rather than against a public order book,
proving is cheap.
