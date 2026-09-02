# Stellar Melt Recovery Operations

CashMesh has an internal, one-shot worker contract for durable Stellar melt recovery. It is not started
by the API server and has no public HTTP route. This document defines the operating boundary for a
future supervisor; it is not a deployment runbook for funded value.

## Durable Records

PostgreSQL creates one immutable job with every `melt` effect. The job becomes eligible 60 seconds
after effect start. Each claim appends a lease, and each finished lease appends at most one outcome.
The current state is reconstructed from that history and the payment lifecycle:

| State | Meaning | Automatic action |
|---|---|---|
| `scheduled` | First attempt or a bounded retry has a future eligibility time | Claim when due |
| `leased` | One worker owns the current attempt until its expiry | No other current claim |
| `attention_required` | Evidence is invalid or bounded retry is exhausted | Stop |
| `completed` | Lifecycle is `consumed` or `released` | Never claim again |

An unacknowledged lease can be reclaimed at its exact expiry. Its old token is permanently fenced once
the next lease is appended. Lease and outcome rows are audit metadata and contain no bearer proof,
signature, DLEQ value, witness, payment preimage, or custody plaintext.

## Default Policy

The one-shot worker claims at most one payment per invocation. Its defaults are a 65-second attempt
timeout, 90-second lease, six operator observation attempts, and exponential retry delays of 30, 60,
120, 240, then 300 seconds. The worker validates that its timeout is shorter than its lease.
Six is the bound on operator observation attempts. If the sixth lease expires without an outcome, a
later bookkeeping lease records `retry_exhausted` without contacting the operator again.

Only observation failures are retryable. The worker can recheck the existing NUT-05 quote and exact
NUT-07 proof references. It cannot decrypt custody, construct inputs, authorize an execution client, or
send another melt. Invalid responses and invalid/configuration evidence stop immediately. Unknown,
temporarily unavailable, aborted, or still nonterminal observations retry until the limit.

## Supervisor Requirements

A production supervisor still needs all of the following before this worker is started:

- a stable unique worker ID per process and cryptographically random lease tokens;
- authenticated, mint-scoped quote and proof-state clients;
- coordinated UTC clocks and alerts for clock drift;
- bounded polling cadence, process shutdown, and health reporting;
- metrics for due age, lease expiry, attempt count, outcome, and attention count;
- an authenticated operator view for attention records; and
- a separately reviewed resolution/requeue action with an append-only audit record.

Do not loop `runOnce` without a poll bound and shutdown signal. Do not requeue attention by changing
database rows; all three scheduling tables are append-only. Do not interpret a lease outcome as payment
truth. Only the proof-reservation lifecycle and atomic accounting transaction can mark a payment
consumed or released.

## Failure Handling

If a process stops during an attempt, allow the lease to expire. If outcome persistence is ambiguous,
read the job again: a terminal lifecycle wins, an exact stored outcome is an idempotent replay, and an
unfinished current lease remains fenced until expiry. A database outage must not cause dispatch,
custody access, proof release, or merchant credit.

`attention_required` is intentionally terminal for automatic scheduling. The current repository can
retrieve it by known payment ID, but no global attention queue or requeue API exists yet. Operators must
not edit the scheduling tables to work around that limitation.
