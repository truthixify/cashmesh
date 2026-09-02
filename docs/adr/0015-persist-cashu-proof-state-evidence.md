# ADR-0015: Persist Payment-Scoped Cashu Proof-State Evidence

**Status:** Accepted

**Date:** 2026-09-02

## Context

The bounded NUT-07 observer returns an immutable state snapshot, but an in-memory response cannot
support crash recovery, concurrent workers, or a reviewable reservation lifecycle. A later payment
decision needs to know which exact locally reserved proofs were queried, which configured operator and
mint made the assertion, when the observation completed, and whether the same evidence survives a
restart.

Mint state is still an assertion, not an authenticated receipt. `UNSPENT` can become stale
immediately. `PENDING` means a proof is involved in an in-flight transaction and may later return to
`UNSPENT` or become `SPENT`. Once a mint reports `SPENT`, accepting a later non-spent report for the
same proof would erase material recovery evidence and could enable an unsafe release decision.
Persisting a witness or complete proof would add bearer-value or spending-condition custody that this
system has not designed.

## Decision

Add a `CashuProofStateRepository` port and PostgreSQL adapter in the acquirer. Scope every observation
to one payment ID, operator ID, normalized mint URL, and unit. Before writing, lock and re-read the
existing proof reservation. Require the snapshot to contain the reservation's complete, exact,
canonical `Y` set and require its completion time to be at or after the reservation time. A generic or
partial mint-state archive is outside this boundary.

Fingerprint the canonical scope, schema, completion time, and sorted states with SHA-256. Permit one
observation per payment and completion time. An exact retry returns the reconstructed stored snapshot;
different evidence at the same time is a conflict. Serialize concurrent writes for one payment through
the reservation row so exact attempts converge and conflicting attempts retain one winner.

Store an append-only header and ordered state entries. Composite foreign keys bind the header to the
exact reservation scope and every entry to one reserved `Y`. Deferred database constraints require a
non-empty, contiguous, complete proof set and repeat the observation-time boundary. Both repository
reads and replays reconstruct the version `1` snapshot, validate its reservation binding, and recompute
the fingerprint before returning it.

Treat `SPENT` as terminal for each proof across observation time. Permit transitions among `UNSPENT`
and `PENDING`, and permit either to become `SPENT`. Reject a later non-spent observation after `SPENT`
and reject backfilled `SPENT` evidence if an already stored later observation is non-spent. Enforce the
same rule with a deferred database constraint and fail closed if stored history violates it.

Expose only an inclusive caller-supplied freshness lookup. Do not assign a default freshness lifetime.
Do not invoke or schedule the observer, persist witnesses or bearer fields, change a reservation,
interpret mixed proof states as a payment result, perform an operator effect, transition an invoice,
write a journal, or enable HTTP success.

## Consequences

- State evidence now survives restart and has deterministic replay, conflict, concurrency, and
  corruption behavior.
- Every stored `Y`, state, scope, and timestamp is correlation-sensitive. These records must not enter
  logs, metrics, traces, support artifacts, or merchant-facing responses.
- `PENDING` to `UNSPENT` remains representable because an in-flight operation can fail before consuming
  a proof. `SPENT` cannot regress, even when observations are inserted out of timestamp order.
- A stored `UNSPENT`, `PENDING`, or `SPENT` value remains an unsigned mint assertion. Persistence does
  not prove mint honesty, solvency, redemption outcome, or merchant payment.
- The store is append-only and has no automatic observer schedule, retention policy, partitioning, or
  archival process. Deployment planning must bound observation frequency and metadata lifetime before
  continuous operation.
- Integration tests use an isolated PostgreSQL database and synthetic non-value proof references. They
  do not call a mint or exercise bearer-proof custody.

## Revisit When

Design the proof-reservation lifecycle and first operator effect. That decision must distinguish a
provable pre-dispatch failure, an in-flight or ambiguous effect, confirmed consumption, and evidence
sufficient for release. It must define how fresh state evidence combines with operator-effect identity
before atomically transitioning an invoice and writing the balanced merchant journal. Add retention,
partitioning, and encrypted bearer-proof custody as separate reviewed boundaries before a production
observer loop or redemption adapter is enabled.
