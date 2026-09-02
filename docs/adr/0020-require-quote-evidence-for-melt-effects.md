# ADR-0020: Require Quote Evidence for Melt Effects

**Status:** Accepted

**Date:** 2026-09-02

## Context

CashMesh persists one Stellar melt quote attempt before quote creation and separately persists the
proof-reservation lifecycle before an operator effect. Without an enforced relationship between those
records, a caller or direct database writer could start a melt with a missing quote, a quote owned by a
different payment or mint, changed expiry, or state that was no longer dispatchable.

The quote can move to `PENDING` or `PAID` after dispatch begins. Recovery reads and exact effect replay
must therefore prove what was known when dispatch started without requiring the quote to remain
`UNPAID` forever. A process crash after effect persistence also cannot prove whether bearer proofs
reached the mint, so replay must not become permission for a second remote call.

## Decision

Require every new melt effect to reference the quoted outcome for the same reserved payment. Before
inserting the effect, lock the reservation and quote attempt and require the reservation mint, UUIDv7
quote ID, and expiry to match exactly. The quote outcome must have been recorded no later than the
effect start, the latest stored observation must be `UNPAID` and no later than that start, and the
effect must start before quote expiry.

Repeat this rule in a PostgreSQL `BEFORE INSERT` trigger so a direct writer cannot bypass the
repository. Migration refuses existing melt effects unless an explicit legacy record proves matching
quote terms and an `UNPAID` observation at or before the stored effect start. It does not invent or
silently backfill quote evidence.

When reconstructing an existing lifecycle, validate the immutable quote terms and the latest quote
observation at or before the historical effect start. Do not require the current latest state to remain
`UNPAID`; later `PENDING` or terminal `PAID` observations are valid history. Exact start-event replay
returns the existing lifecycle and never inserts another effect.

A future dispatch coordinator may treat only a newly inserted effect result with `replayed: false` as
permission for its one outbound melt call. A replay is recovery-only. This decision does not decrypt
proofs, send a melt, authenticate a protected mint, accept a fee reserve, create NUT-08 change outputs,
consume a reservation, pay an invoice, or write accounting.

## Consequences

- A melt effect can no longer exist without durable, payment-scoped quote evidence that was
  dispatchable at its recorded start.
- Quote identity and expiry cannot be rebound between quote creation and lifecycle persistence.
- Later quote checks remain append-only and can advance without invalidating lifecycle recovery.
- Deployments with legacy unbound melt effects must perform a reviewed backfill or retire those local
  records before migration.
- Persistence establishes at-most-once local authorization, not remote execution certainty. A crash or
  timeout after effect insertion remains ambiguous and must retain active claims.
- Quote IDs, destinations, effect IDs, and timestamps remain correlation-sensitive and must stay out of
  telemetry and merchant-facing errors.

## Revisit When

Add the bounded melt execution coordinator. It must compute the canonical dispatch fingerprint, apply
fee and expiry policy, scope bearer decryption to the freshly inserted effect, preserve NUT-08 recovery
data, and turn every uncertain network outcome into durable attention or observation rather than a
retry. Revisit automatic retry only for an operator with a verified idempotency contract.

## References

- [ADR-0016: Manage Cashu Proof-Reservation Lifecycle](0016-manage-cashu-proof-reservation-lifecycle.md)
- [ADR-0018: Bind Stellar Melt Quote Terms Before Dispatch](0018-bound-stellar-melt-quotes.md)
- [ADR-0019: Persist Stellar Melt Quote Evidence Before Creation](0019-persist-stellar-melt-quote-evidence.md)
- [Cashu NUT-05 melt quotes and execution](https://github.com/cashubtc/nuts/blob/main/05.md)
