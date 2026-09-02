# ADR-0025: Schedule Melt Recovery with Fenced Leases

**Status:** Accepted

**Date:** 2026-09-02

## Context

ADR-0024 defines an observation-only recovery coordinator, but deliberately leaves invocation timing
and multi-worker ownership undefined. Calling it from an unbounded timer would allow duplicate reads,
uncontrolled retry pressure, and process restarts that forget which payment was already being checked.
Scheduling must not weaken the stronger rule that a melt dispatch is never retried.

Recovery also needs an explicit escalation boundary. Temporary unavailable or nonterminal evidence can
justify another read, while an invalid response, invalid stored evidence, or exhausted attempts needs
operator attention. A worker that finishes after another worker has reclaimed its job must not be able
to overwrite the newer decision.

## Decision

Create one durable recovery job in the same PostgreSQL transaction that inserts each `melt` effect.
The first observation attempt becomes eligible 60 seconds after effect start, which is later than the
maximum 30-second timeout of the preceding dispatch call. Migration 13 backfills the same immutable job
identity for existing melt effects.

Represent execution as append-only leases and outcomes:

- a lease records payment, worker, opaque token, monotonic attempt number, claim time, and expiry;
- a lease lasts at most 300 seconds; the default worker lease is 90 seconds;
- due work is selected with `FOR UPDATE SKIP LOCKED`, then revalidated under the job lock before the
  lease is appended;
- an unfinished lease becomes reclaimable only at expiry;
- a retry outcome carries its exact next eligible time;
- only the latest lease token can append an outcome; and
- jobs, leases, and outcomes cannot be updated or deleted.

Lifecycle state remains the source of terminal truth. A consumed or released payment is never
claimable, even if its last lease was not acknowledged. Terminal outcomes must match the current
lifecycle. Repository reads use one repeatable-read snapshot and validate the complete lease sequence.
Database triggers repeat job/effect identity, eligibility, sequence, duration, fencing, terminal-state,
and append-only constraints for direct writers.

Add a one-shot internal worker. One `runOnce` call claims at most one due job and invokes only the
ADR-0024 recovery coordinator with a bounded abort signal. Defaults are:

- 65-second attempt timeout inside a 90-second lease;
- at most six operator observation attempts;
- 30-second exponential retry delay capped at 300 seconds; and
- opaque UUID lease tokens and a required stable worker identifier.

`pending`, unavailable storage, aborted observation, and unknown operator state are retried within
those bounds. An invalid operator response or invalid/configuration evidence stops immediately.
Nonterminal evidence on the sixth attempt records `retry_exhausted`. Both cases append
`attention_required`, after which no worker can claim the job automatically. If the sixth lease expires
without an outcome, one later bookkeeping lease records `retry_exhausted` without making another
operator request.

Do not start a timer in the API server or expose a recovery endpoint in this decision. A future
supervisor must supply configured authenticated clients, clock monitoring, shutdown handling, metrics,
and an operator-facing attention workflow. Scheduler clocks must be synchronized; terminal accounting
and release safety continue to depend on the independently validated evidence clocks and lifecycle
transactions rather than job timing.

## Consequences

- Every durable melt effect has a restart-safe path to observation without a second dispatch.
- Multiple worker processes can poll the same PostgreSQL queue without processing one payment under two
  current leases.
- A crashed worker does not need to release a lease; expiry makes the job reclaimable.
- A stale worker cannot acknowledge success, retry, or attention after a newer lease exists.
- Retry history is reviewable without making scheduler state part of merchant accounting evidence.
- Observation retries can still duplicate safe read requests around lease expiry. They cannot access
  custody or authorize a melt POST.
- Attention is deliberately sticky. There is no automatic or public requeue operation yet.
- This proves the worker boundary with local PostgreSQL and mocked clients, not production supervision,
  protected-mint authentication, alert delivery, or fleet clock health.

## Revisit When

Add a supervised worker process only after operator credentials and deployment ownership are defined.
Add a separately authorized, append-only attention-resolution action before allowing requeue. Revisit
the delay and attempt policy from measured operator behavior, without changing historical lease data or
granting dispatch retry permission.

## References

- [ADR-0016: Manage Cashu Proof-Reservation Lifecycle](0016-manage-cashu-proof-reservation-lifecycle.md)
- [ADR-0022: Coordinate One Fresh Stellar Melt Dispatch](0022-coordinate-fresh-stellar-melt-dispatch.md)
- [ADR-0024: Bind Stellar Destinations and Recover Melts Without Redispatch](0024-bind-stellar-destinations-and-recover-melts.md)
