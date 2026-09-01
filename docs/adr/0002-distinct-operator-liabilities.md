# ADR-0002: Keep Operator Liabilities Distinct

**Status:** Accepted

**Date:** 2026-09-01

## Context

Two Cashu mints can issue proofs with the same `usdc` unit while holding different reserves, honoring
different redemption terms, operating in different jurisdictions, and presenting different failure
risk. Treating those proofs as universally fungible would hide material credit exposure from merchants.

## Decision

Every accepted payment and merchant ledger entry records its issuing operator and policy decision.
CashMesh supports three merchant policy outcomes:

- trusted operator: hold or immediately convert within a configured cap;
- convertible-only operator: accept only through immediate conversion; and
- unlisted operator: reject unless a named future guarantee explicitly assumes the exposure.

Balances, limits, incidents, and reconciliation remain attributable to the issuing operator even when
merchant settlement is batched.

## Consequences

- A `usdc` unit is a denomination, not a universal credit guarantee.
- Merchant UI and reports must expose operator and settlement mode.
- Operator concentration and unsettled exposure become first-class metrics.
- Cross-operator swaps do not erase the original credit and execution path.

## Revisit When

This decision should not be reversed. A future guaranteed instrument may abstract operator exposure for
the merchant, but the acquirer must still account for the underlying liabilities separately.
