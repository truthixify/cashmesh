# ADR-0016: Manage Cashu Proof-Reservation Lifecycle

**Status:** Accepted

**Date:** 2026-09-02

## Context

A durable proof-reference reservation prevents two local payment attempts from claiming the same
Cashu proofs, but a permanent lock is not a recovery policy. Once an operator request may have left
the acquirer, a timeout or process crash cannot distinguish no effect from an in-flight or completed
effect. Releasing proofs on that ambiguity could permit a second spend attempt; retaining every
provably unused reservation forever would make recoverable failures operationally unusable.

Cashu exposes different recovery evidence for the two relevant operator operations. A NUT-03 swap has
no quote identifier or protocol idempotency key and no protocol-level pending state. A NUT-05 melt has
a quote identifier and `UNPAID`, `PENDING`, and `PAID` states. NUT-07 separately reports each input as
`UNSPENT`, `PENDING`, or `SPENT`. None of these mint responses is a signed receipt, and this repository
does not yet own the bearer proofs needed to perform either operation.

The lifecycle also needs to survive restart, serialize concurrent workers, preserve an audit trail,
and prevent an invoice or exact outbound operation from being attached to multiple active payments.

## Decision

Add a `CashuProofReservationLifecycleRepository` port and PostgreSQL adapter. Represent each payment
with an immutable effect record, an append-only event sequence, and small active-claim projections.
The public states are `reserved`, `dispatch_started`, `pending`, `needs_attention`, `consumed`, and
`released`.

Bind an effect before an operator dispatch can occur. Every effect contains a locally unique effect
identifier, effect kind, start time, and a SHA-256 dispatch fingerprint supplied by the future adapter
from the exact canonical outbound operation. A melt also contains its NUT-05 quote identifier and
quote expiry. The database permits one effect per payment, one active payment effect per invoice, one
binding for a dispatch fingerprint per mint and effect kind, and one binding for a melt quote.

Apply these transition rules:

- A reservation with no effect may be released without mint evidence.
- Only a melt may enter `pending`; NUT-03 swap ambiguity is not represented as protocol pending.
- Transport ambiguity, unknown operator state, or an invalid operator response enters
  `needs_attention` and retains every active claim.
- Matching `swap_succeeded` or `melt_paid` evidence may consume a reservation only when a later or
  simultaneous persisted NUT-07 snapshot covers the exact reserved proof set and every proof is
  `SPENT`.
- Matching `swap_rejected` evidence may release a reservation only with a later or simultaneous exact
  all-`UNSPENT` snapshot.
- A melt may be released only with `melt_unpaid_after_expiry` evidence at or after the bound quote
  expiry and a later or simultaneous exact all-`UNSPENT` snapshot.
- Mixed states, `PENDING`, stale ordering, a timeout, or any ambiguous outcome never authorizes
  release.

Lock the reservation row for every write. Exact event retries return the reconstructed lifecycle;
changed evidence under an event or effect identity conflicts. Released reservations remove their
active proof and invoice claims in the same transaction while retaining reservations, effects, state
snapshots, and events as immutable history. Consumed and ambiguous lifecycles retain their claims.
An exact reservation replay after release fails rather than silently recreating an active claim, while
a new payment may reserve the same proof references after release.

Repeat sequence, transition, effect-kind, time-ordering, exact proof-state, dispatch ownership, and
active-projection invariants with database constraints and deferred triggers. Reconstruct and
fingerprint every stored effect and event before return. Store no proof secret, signature, DLEQ value,
witness, token, or raw operator payload in this boundary.

Treat effect evidence as a sanitized input from a future bounded operator adapter. This repository
records and validates the evidence relationship; it does not authenticate a mint response, compute
the dispatch fingerprint, send a swap or melt, retain bearer value, mark an invoice paid, write a
journal, or enable an HTTP success response.

## Consequences

- Reservation ownership and recovery decisions now survive restart and concurrent workers.
- Exact terminal retries are idempotent, and append-only history remains available after proof claims
  are released for reuse.
- Swap ambiguity requires manual attention because NUT-03 supplies no remote idempotency identity or
  pending query. The dispatch fingerprint prevents local rebinding but cannot make a remote swap
  idempotent.
- A melt `UNPAID` response before quote expiry is insufficient for release. The quote could still be
  paid until its validity window closes.
- NUT-07 state and operator outcomes remain mint assertions. Combining them reduces unsafe local
  transitions but does not prove mint honesty, solvency, or redemption value.
- Effect IDs, dispatch fingerprints, quote IDs, proof references, timestamps, and state history are
  correlation-sensitive and must not enter telemetry or merchant-facing responses.
- Database triggers deliberately reject direct writes that leave effect history and active claims out
  of agreement.

## Revisit When

Introduce encrypted bearer-proof custody and a bounded NUT-03/NUT-05 adapter. That work must define
the canonical dispatch bytes, authenticate and normalize operator responses, prevent accidental DLEQ
or witness disclosure, and recover ambiguous network calls without inventing remote idempotency. A
separate decision must then atomically connect confirmed consumption to the paid invoice and balanced
merchant journal, including fee, receipt, and reconciliation identities.
