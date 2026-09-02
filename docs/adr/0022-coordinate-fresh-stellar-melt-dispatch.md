# ADR-0022: Coordinate One Fresh Stellar Melt Dispatch

**Status:** Accepted

**Date:** 2026-09-02

## Context

CashMesh separately stores a validated proof reservation, encrypted bearer custody, historical keyset
evidence, an `UNPAID` Stellar melt quote, and a lifecycle capable of binding an outbound effect. The
bounded NUT-05 execution client also exposes the canonical request fingerprint before network access.
Without one application boundary connecting those records, callers could supply an unverified fee,
decrypt the wrong custody record, authorize a replay, or fail to preserve an ambiguous outcome.

Multiple Cashu operators are part of the product model. Proofs from those operators remain distinct
liabilities, so dispatch must follow the mint bound to the reservation rather than a caller-selected
endpoint. A returned `PAID` quote is still only an operator observation; proof consumption and merchant
accounting require separate evidence and an atomic persistence decision.

## Decision

Add an internal acquirer melt coordinator keyed by payment ID. Load the exact reservation and its
lifecycle first. Any existing effect or non-`reserved` state is recovery-only and cannot reach custody
or an executor. Load the payment's persisted quote and require matching invoice, operator, normalized
mint, request, amount, zero fee reserve, latest `UNPAID` observation, and unexpired terms.

Reload the exact historical keyset observation named by the reservation. Derive the NUT-02 input fee by
summing `input_fee_ppk` once per proof and rounding the total up once. Inactive historical keysets remain
spendable, but a keyset at or beyond `final_expiry`, a missing denomination, changed identity, wrong
unit, or a gross amount other than `quote amount + input fee` fails before decryption.

Select the executor by the reservation's normalized mint URL. Open bearer custody only through its
self-destroying callback and pass the derived fee and stored quote to the bounded client. Its
authorization callback validates the canonical dispatch metadata, rechecks fee expiry at the start
time, and writes the melt effect. Only a new `startEffect` result with `replayed: false` returns `true`.
A concurrent or restarted replay returns recovery and never grants another network attempt.

After authorization, treat missing or malformed results, clock disagreement, cancellation, expiry,
transport failure, invalid response, and persistence failure as recovery-sensitive. Attempt to persist
transport ambiguity, invalid operator response, or unknown state as `needs_attention` while retaining
custody and active proof claims. If lifecycle storage is unavailable, the already durable effect remains
recovery-only. Append every valid returned quote observation; additionally record lifecycle `pending`
for `PENDING`. Return `UNPAID` and `PAID` only as operator observations. Do not consume proofs, release a
reservation, mark an invoice paid, or write a merchant journal.

Use domain-separated deterministic effect and event identifiers derived from payment, mint, and quote
identity. Return only sanitized coordination state and lifecycle evidence. Keep this coordinator
internal; the public payment endpoint remains non-accepting.

## Consequences

- One fresh database effect is the only local authority for one bounded melt request.
- Multiple configured executors cannot change the operator liability selected by the reservation.
- A crash after effect persistence is recovery-only even if no HTTP response was observed.
- A clock or storage failure after authorization cannot silently become retry permission.
- Zero fee reserve remains mandatory until blinded change outputs and NUT-08 recovery data are durable.
- PostgreSQL integration tests prove restart, pending, ambiguity retention, and single-call behavior
  with local HTTP fixtures; they do not prove compatibility with a running mint or movement of value.
- The coordination result is internal and contains correlation-sensitive lifecycle identifiers that
  must not be returned directly to merchants or telemetry.

## Revisit When

Add a recovery worker that checks the bound NUT-05 quote and exact NUT-07 proof set without redispatch.
Connect confirmed `PAID` plus all-`SPENT` evidence to one atomic paid-invoice and balanced-journal
transaction. Add protected-mint authentication through a reviewed credential port. Accept nonzero fee
reserve only after persisting blinded outputs before authorization and recovering change after restart.

## References

- [ADR-0016: Manage Cashu Proof-Reservation Lifecycle](0016-manage-cashu-proof-reservation-lifecycle.md)
- [ADR-0017: Protect Cashu Bearer Proofs in Encrypted Custody](0017-protect-cashu-bearer-proof-custody.md)
- [ADR-0020: Require Quote Evidence for Melt Effects](0020-require-quote-evidence-for-melt-effects.md)
- [ADR-0021: Authorize Bounded Zero-Fee Stellar Melt Dispatch](0021-authorize-zero-fee-stellar-melt-dispatch.md)
- [Cashu NUT-02 keyset fees](https://github.com/cashubtc/nuts/blob/main/02.md)
- [Cashu NUT-05 melt quotes and execution](https://github.com/cashubtc/nuts/blob/main/05.md)
