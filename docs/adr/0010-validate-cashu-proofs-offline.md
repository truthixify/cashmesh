# ADR-0010: Validate Cashu Proofs Against Explicit Keyset Snapshots

**Status:** Accepted

**Date:** 2026-09-01

## Context

NUT-02 assigns each proof to a mint keyset and defines the input fee as the sum of each input's
`input_fee_ppk`, rounded up once to the next integer unit. NUT-12 lets a receiver validate a mint
signature offline when a secp256k1 proof carries its DLEQ data. Neither check establishes that a bearer
proof is unspent: that requires mint-observed state or a mint operation.

CashMesh needs deterministic proof-integrity and fee evidence without letting a library-owned wallet,
an implicit network fetch, or a mutable global key cache decide merchant payment state. The evidence
must also preserve operator liability boundaries and must not leak proof secrets beyond the Cashu
adapter.

## Decision

Define a version `1` keyset snapshot containing one normalized HTTPS mint URL, observation time, and
one through 64 keysets. Each keyset records its ID, unit, active flag, input fee, optional final expiry,
and one through 256 public denomination keys. Canonicalize key order and public-key case, validate every
public point, reject duplicate IDs, and recompute each keyset ID through the pinned cashu-ts boundary.

Accept only standardized hex secp256k1 keyset IDs beginning with `00` or `01`. Reject deprecated base64
IDs and the release-candidate library's experimental `02` BLS keysets until the protocol, compatibility,
and independent review basis is explicit.

Validate the raw NUT-18 payload within the adapter so bearer fields never appear in the result. Require
the snapshot mint and every keyset unit to match the payload, reject a snapshot observed after the
validation time, and reject a keyset at or after its final expiry. Inactive keysets remain valid inputs
before final expiry, as required by NUT-02.

Reject duplicate proof secrets before summing value. Use cashu-ts `verifyProofsForReceive` with
`requireDleq=true`, an intentionally stricter receiver policy than NUT-12's verify-if-present baseline.
Compute the input fee only with integer arithmetic:

```text
input_fee = (sum(input_fee_ppk for each proof) + 999) // 1000
net_amount = gross_amount - input_fee
```

Return only the existing payment envelope plus input fee, net amount, used keyset IDs, snapshot
observation time, and validation time. Do not return or persist secrets, signatures, DLEQ values, or
witnesses. In particular, do not forward the NUT-12 blinding factor in a received proof back to its
mint; doing so would let the mint link the blinded signature to the spend.

Do not call a mint, infer snapshot freshness, check NUT-07 state, reserve a proof, change an invoice,
write a journal, or enable the HTTP success path in this capability.

## Consequences

- Mixed-keyset fees and proof integrity are reproducible from explicit public inputs.
- Missing DLEQ makes an otherwise protocol-valid legacy secp proof unacceptable to CashMesh. Operators
  and wallets must preserve DLEQ data for this profile.
- A version `00` keyset ID commits to its public keys but not its unit, fee, or final expiry. A durable
  operator adapter must preserve the exact observed metadata and detect conflicting observations.
- A version `01` keyset ID commits to keys, unit, nonzero fee, and nonzero final expiry, but the snapshot
  still does not authenticate the operator or prove current availability.
- The validation result proves signature integrity and fee arithmetic only. It is not evidence of
  unspentness, reservation, redemption, operator solvency, or merchant payment.
- A future reservation layer must keep bearer material encrypted and must strip DLEQ data before any
  proof is submitted to its mint.
- The public payment endpoint continues to return `503 proof_validation_unavailable` after envelope
  checks because no keyset provider or proof reservation is wired into it.

## Revisit When

Add a bounded operator keyset client and durable snapshot store with collision history, freshness
policy, and restart tests. Then combine NUT-07 observation, atomic local proof reservation, operator
swap or melt behavior, invoice transition, and balanced accounting before any successful payment
response. Review standardized BLS support independently before accepting another keyset version.
