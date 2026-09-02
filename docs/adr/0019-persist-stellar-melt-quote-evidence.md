# ADR-0019: Persist Stellar Melt Quote Evidence Before Creation

**Status:** Accepted

**Date:** 2026-09-02

## Context

The bounded Stellar NUT-05 client validates quote creation and later checks, but quote creation is a
non-idempotent remote operation unless a selected mint explicitly provides compatible caching
semantics. A process can crash after sending the POST but before retaining the response. Repeating the
POST in that state can create a second remote quote, while retaining only an in-memory quote loses its
identity, expiry, fee, and state history on restart.

The quote belongs to one already reserved payment, operator, mint, invoice amount, and Stellar payout
request. It must be obtained before bearer dispatch, and an operator assertion such as `PAID` must not
replace exact proof-state evidence or merchant accounting. The full SEP-0007 request and quote ID are
also correlation-sensitive payment metadata.

## Decision

Add a versioned `CashuStellarMeltQuoteRepository` port and PostgreSQL adapter. Begin one immutable quote
attempt only for an open invoice with the exact integer amount, its active pre-dispatch proof
reservation, and existing encrypted bearer custody. Derive the operator and normalized mint from that
reservation. Permit one attempt per payment and fingerprint the attempt ID, payment scope, exact
SEP-0007 request, method, unit, amount, schema, and start time.

Only a newly inserted `begin` result with `replayed: false` authorizes the caller to make the single
creation POST. An exact replay reconstructs current state for recovery but never grants retry
permission. Changed attempt or payment bindings conflict. An attempt without an outcome remains
conservative after restart; callers must not infer whether the POST ran.

Record exactly one immutable outcome. A transport-ambiguous outcome contains no quote identity and
cannot be replaced automatically. A quoted outcome requires the complete validated `UNPAID` snapshot,
the exact persisted request and mint, an unexpired quote, and expiry no more than 900 seconds after the
attempt began. Bind one `(mint URL, quote ID)` to at most one payment.

Store later full quote observations as an append-only, strictly chronological sequence. Recompute and
verify the immutable request, amount, fee reserve, method, unit, mint, quote ID, and expiry on every
write and read. Permit `UNPAID` and `PENDING` to move between each other, permit either to become
`PAID`, and make `PAID` terminal. Exact observation replay converges; different evidence at one time
conflicts.

Use separate immutable attempt, outcome, and observation tables. Database constraints and triggers
repeat reservation, custody, invoice, cardinality, expiry, quote-identity, initial-`UNPAID`, ordering,
terminal-state, and append-only rules. Repository reads lock the attempt for a consistent reconstruction
and recompute every SHA-256 fingerprint before returning frozen records.

This repository does not call a mint, authenticate a protected mint, decrypt or dispatch proofs,
create NUT-08 change outputs, apply fee policy, transition the proof-reservation lifecycle, accept an
invoice payment, or write accounting. The current lifecycle repository can still be invoked separately;
a coordinator and database rule must next require every melt effect to reference the quoted outcome for
that same payment before bearer access.

## Consequences

- Quote creation intent, ambiguity, immutable terms, and state observations now survive crash and
  restart without making automatic POST retry safe.
- A crash before the POST and a crash after an unobserved POST are intentionally indistinguishable once
  an attempt exists. Manual recovery or a future mint-specific idempotency contract is required.
- An ambiguous attempt permanently owns the payment in the current schema. Abandonment or operator-led
  recovery needs a separate reviewed transition rather than deleting or replacing evidence.
- Full Stellar destinations, memos, quote IDs, amounts, timing, mint identity, and check history are
  retained. They must be excluded from logs, metrics, traces, merchant-facing errors, and support
  artifacts, and need a deployment retention policy.
- A stored `PAID` state remains a mint assertion. Consumption still requires the matching effect and a
  later exact all-`SPENT` NUT-07 observation; merchant credit still requires atomic invoice and journal
  persistence.
- The repository requires encrypted custody metadata but never reads ciphertext or plaintext. Production
  key management, access control, backup policy, and auditability remain unresolved.

## Revisit When

Add the melt coordinator and require its effect fingerprint, quote ID, expiry, payment, operator, and
mint to match this repository before scoped bearer decryption. Define operator fee caps, quote expiry
policy, protected-mint authentication, NUT-08 change recovery, and observation scheduling. Permit a
creation retry only for a mint with an explicitly verified idempotency or NUT-19 contract and a durable
request identity that makes the retry provably equivalent.

## References

- [Cashu NUT-05 melt quotes and execution](https://github.com/cashubtc/nuts/blob/main/05.md)
- [Cashu NUT-08 fee-return change](https://github.com/cashubtc/nuts/blob/main/08.md)
- [Cashu NUT-19 cached responses](https://github.com/cashubtc/nuts/blob/main/19.md)
- [SEP-0007 URI scheme](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md)
