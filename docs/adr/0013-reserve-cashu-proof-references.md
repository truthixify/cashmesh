# ADR-0013: Reserve Cashu Proof References Before Network Effects

**Status:** Accepted

**Date:** 2026-09-02

## Context

A valid Cashu signature and DLEQ proves that a mint signed a proof, but it does not prove that the
proof remains unspent or prevent two concurrent CashMesh requests from acting on the same bearer
value. NUT-07 identifies a proof to the mint by the curve point `Y = hash_to_curve(secret)` and reports
`UNSPENT`, `PENDING`, or `SPENT`. The remote state is useful evidence but cannot replace a durable
local lock: an `UNSPENT` observation can become stale immediately, while `PENDING` or an ambiguous
operator request must not cause CashMesh to release the proof optimistically.

Persisting the proof secret, signature, DLEQ blinding factor, witness, or complete payload would create
a bearer-value custody boundary. CashMesh does not yet have an encryption, key-management, recovery,
or access-audit design for that material. It still needs a non-spendable replay key before an operator
adapter or paid-invoice transaction can be introduced.

## Decision

After successful offline proof verification, derive one canonical secp256k1 NUT-07 `Y` for each proof.
Return only a deeply frozen reference containing `Y`, keyset ID, and positive integer amount. Sort the
references by `Y` and reject duplicate references. Do not return the proof secret, signature, DLEQ,
witness, memo, or raw payload.

Persist a version `1` local reservation keyed by a globally unique payment ID. Bind it to one invoice,
operator, normalized mint URL, unit, reservation time, gross amount, and ordered proof-reference set.
The invoice must be open at the reservation time, and the exact `(invoice, operator, mint)` tuple must
exist in the issued strict payment request. Bind the reservation to the keyset observation time used
for offline validation. Every referenced keyset must occur in that exact operator, mint, unit, and time
snapshot, and the observation cannot postdate the reservation. The caller must select that observation
through an explicit freshness interval before reservation; this repository records the selected evidence
but does not invent a freshness lifetime.

Enforce global uniqueness of `(mint URL, Y)` across reservations. An exact payment-ID retry is an
idempotent replay; changed terms under the same payment ID are a payment conflict; another payment
claiming an already reserved proof is a proof conflict. Insert the header and all proof references in
one PostgreSQL transaction. Deferred constraints require a non-empty contiguous set of at most 128
proofs whose exact integer sum equals the stored gross amount. Reservation rows are append-only.

This capability has no release or consumption transition. A reservation remains locked across restart
until a later state machine can use explicit operator evidence to move it safely. It does not call
NUT-07, send proofs to a mint, store bearer material, transition an invoice, write a journal, or enable
a successful payment response.

## Consequences

- Concurrent CashMesh workers cannot reserve the same proof from one mint for different payments.
- A payment retry can recover the exact reservation after restart without retaining bearer fields.
- `(mint URL, Y)` is non-spendable but correlation-sensitive. It must be excluded from logs, metrics,
  support artifacts, and merchant-facing responses and protected with the same metadata controls as
  invoice identifiers.
- Different mints have independent proof namespaces, and different operators remain distinct
  liability routes even when the unit matches.
- The intentionally sticky reservation can strand otherwise unspent value locally. This is safer than
  an unsupported release decision and is not a complete payment workflow.
- A local reservation does not prove that a mint reports `UNSPENT`, that the proof is authorized by a
  spending condition, or that an operator effect succeeded.
- Exact observation binding does not make stale key material fresh. Payment orchestration must use the
  keyset repository's bounded freshness lookup and preserve that policy in its acceptance evidence.

## Revisit When

Add the reservation lifecycle together with a bounded NUT-07 observer and the first real operator
effect. Define transitions for pre-dispatch cancellation, pending or ambiguous effects, confirmed
consumption, and evidence-backed release. Bearer-proof custody requires a separate encryption and key
management ADR. Only then may a transaction atomically consume the reservation, transition the invoice
to paid, and write the balanced merchant journal.
